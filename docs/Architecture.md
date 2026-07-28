# BLACKSITE — Architecture

A first-person shooter built in Three.js / WebGL2, targeting AAA visual quality
with **zero external assets** — every texture, mesh and sound is generated in
code at load time.

## Why the codebase is shaped like this

The project was built by a large number of AI agents working in parallel. That
constraint drove the architecture: systems had to be independently buildable,
independently verifiable, and impossible to accidentally couple. The result is a
design that would be reasonable for a human team too — the seams are just
enforced more strictly than usual.

Three rules do the work:

1. **No system imports another system.** Everything goes through a registry
   (`ctx.require('name')`) or the event bus.
2. **One owner per file.** Ownership is recorded in the header comment of every
   module.
3. **The renderer is the test.** Correctness is judged from screenshots taken by
   a headless GPU rig, not from reading the code. See [Verification](#verification).

## Runtime topology

```
Engine
├── fixed 120Hz  fixedUpdate()   physics, ballistics, movement
├── variable     update()        visuals, interpolation, animation
└── composite    render()        PostFX owns the frame
```

`Engine` (`src/core/Engine.js`) owns the renderer, the clock and an ordered
system registry. Registration order in `src/main.js` **is** execution order, so
producers are registered before consumers and `init()` can safely resolve
dependencies.

A system is any object with a unique `name` and any of `init / fixedUpdate /
update / render / resize / dispose`. If a system's `render()` returns `true`, the
Engine does not draw anything itself — this is how `PostFX` takes ownership of
the frame.

### Two scenes, two cameras

`ctx.scene` + `ctx.camera` render the world (far plane 900m). `ctx.viewScene` +
`ctx.viewCamera` render **only** the first-person weapon, with a near plane of
0.005m, composited over the world with a cleared depth buffer. This is the
standard FPS trick: it is what stops the weapon from intersecting walls when the
player backs into cover.

### The event bus

`src/core/EventBus.js`. Payload shapes are frozen — adding a new event is fine,
changing an existing payload is not, because several systems listen to each one.

The combat chain is entirely event-driven, which is why the systems can be built
by separate agents that never read each other's code:

```
WeaponSystem  --'weapon:fire'-->  Ballistics
Ballistics    --'hit:surface'-->  Impacts --> Particles, Lighting, Audio
              --'hit:actor'  -->  EnemyAI, HUD
              --'tracer'     -->  Particles
              --'actor:death'-->  HUD, EnemyAI
```

## Systems

| Domain | Modules | Responsibility |
|---|---|---|
| **Core** | `core/` | Engine, EventBus, Input, Constants |
| **Render** | `render/` | MaterialForge (procedural PBR), Sky (scattering + clouds), Lighting (CSM, IBL, volumetrics), PostFX (AO, TAA, bloom, DoF, grade) |
| **World** | `world/` | Level (architecture, collision, BVH), Props (procedural set dressing) |
| **Player** | `player/` | PlayerController (capsule physics), CameraRig (bob, sway, recoil, trauma) |
| **Weapons** | `weapons/` | WeaponSystem (fire control), Ballistics (penetration model), ViewModel (first-person rig), WeaponData |
| **FX** | `fx/` | Particles (GPU-instanced pools), Impacts (decals, per-surface response) |
| **AI** | `ai/` | EnemyAI — navigation, cover, squad behaviour, procedural humanoids |
| **Audio** | `audio/` | AudioEngine — fully synthesised WebAudio, no samples |
| **UI** | `ui/` | HUD — reticle, ammo, hitmarkers, kill feed, menu |

### Collision is single-sourced

`Level.colliders` is the one collision authority. Props register their solid
meshes into it via `level.addCollider(mesh)`. Player movement, ballistics, AI
navigation and prop grounding all query the same BVH through `level.raycast()`.
Nothing maintains a second copy of the world.

### Ballistics

Not a hitscan raycast. A round is a state record (position, velocity, energy)
marched in segments:

- Fast rounds (≥620 m/s) resolve within the firing frame but still integrate
  gravity between 48m segments — a 5.56 drops ~120mm at 140m.
- Slow rounds (the 400 m/s SMG) are marched in `fixedUpdate` and visibly lag.
- Impacts consume **energy**. Wall thickness is found with a back-face probe
  cast, so penetration cost is proportional to actual material thickness. If
  energy survives, the round exits the far side with reduced damage.

The tuning is in `WeaponData.BALLISTICS` with worked examples: 5.56 defeats a
50mm plank and a 300mm sandbag, but is stopped by 50mm concrete. This is what
makes cover meaningful rather than decorative.

## Tuning

`src/core/Constants.js` is the single tuning surface — movement feel, camera
feel, render intensities, surface properties, and the seven time-of-day presets.
Anything that affects how the game *looks* or *feels* lives there so it can be
swept without hunting through systems.

## Verification

```bash
npm run dev                                  # http://127.0.0.1:5180
node tools/shoot.mjs                         # all 12 canonical views
node tools/shoot.mjs --views hero-golden --tag mywork
```

`tools/shoot.mjs` drives the running app headlessly through Playwright with
**real GPU rasterisation** (`--use-angle=d3d11`; SwiftShader would soften the
image and make visual critique meaningless). It captures 12 fixed compositions,
each chosen to stress a different part of the renderer, and writes a
`report.json` with per-view FPS, draw calls, triangle counts and any page errors.

The rig is deterministic because the app exposes URL parameters: `?freeze=1`
holds simulation time, `?tod=golden` sets the time of day, `?pos=x,y,z&yaw=&pitch=`
places the camera, `?hud=0` / `?vm=0` hide overlays, `?ads=1` / `?fire=1` force
weapon poses. Without those, no two screenshots would be comparable and the
critique loop could not work.

## Performance budget

| Metric | Ceiling |
|---|---|
| Draw calls | 900 |
| Triangles | 3.5M |
| Frame rate | 60fps @ 1080p |

Anything appearing more than 8 times must be an `InstancedMesh`. No allocation is
permitted in `update()` / `fixedUpdate()` hot paths — systems pre-allocate pools
and scratch vectors in their constructors.

## Extending it

Adding a system means: create the module with a unique `name`, register it in
`src/main.js` at the right point in the order, and talk to everything else
through the registry and the bus. See [CONTRACT.md](../CONTRACT.md) for the
binding rules.
