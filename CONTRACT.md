# BLACKSITE — Build Contract

Read this **before** touching any file. Multiple agents build this codebase in
parallel; the contract is what keeps that from turning into merge soup.

## The one rule

**You own exactly the files listed in your brief. You do not edit any other file.**

If you need something from another system, it must come through one of the three
sanctioned seams below. If the seam you need does not exist, add it *to your own
file* and note the requirement in your report — do not reach into someone else's
module.

## The three seams

### 1. The system registry
```js
const forge = ctx.require('forge');   // throws if missing
const level = ctx.get('level');       // undefined if missing
```
Registered names: `input`, `forge`, `sky`, `lighting`, `level`, `props`,
`particles`, `impacts`, `ballistics`, `player`, `camerarig`, `weapons`,
`viewmodel`, `ai`, `audio`, `hud`, `postfx`.

### 2. The event bus
```js
ctx.bus.on('weapon:fire', ({ origin, dir, weapon, seed }) => { ... });
ctx.bus.emit('hit:surface', { point, normal, surface, incoming });
```
Payload shapes are frozen — see `src/core/EventBus.js`. Adding a **new** event is
fine. Changing an existing payload is not.

### 3. `src/core/Constants.js`
All tuning values live here. You may **read** anything. You may **add** a new
block for your own system. Do not change values another system depends on
(`WORLD`, `PLAYER`, `CAMERA` are shared).

## The system interface

```js
export class MySystem {
  constructor() { this.name = 'mysystem'; }   // unique, matches registry name
  async init(ctx) {}                          // once, in registration order
  fixedUpdate(h, ctx) {}                      // 120Hz — gameplay/physics only
  update(dt, ctx) {}                          // per-frame — visuals/interp
  render(dt, ctx) { return false; }           // return true = you drew the frame
  resize(w, h, ctx) {}
  dispose() {}
}
```

`init` runs in registration order, so anything you `require()` is already
initialised. Registration order is fixed in `src/main.js`.

## Rendering topology

- `ctx.scene` / `ctx.camera` — the world. Far plane 900m.
- `ctx.viewScene` / `ctx.viewCamera` — first-person viewmodel only, near plane
  0.005m so the weapon never clips world geometry. `CameraRig` keeps the two
  cameras aligned.
- `PostFX` is registered last and owns the composite of both. If `PostFX.render`
  returns `true`, `Engine` does not draw anything itself.

## Hard constraints

| Constraint | Value |
|---|---|
| **Zero external assets** | No downloaded textures, models, audio or fonts. Everything procedural or hand-authored in code. This is non-negotiable — it is also why the project has no licensing risk. |
| Draw calls | ≤ 900 in the hero view |
| Triangles | ≤ 3.5M in the hero view |
| Frame budget | 60fps at 1920×1080 on a mid-range discrete GPU |
| Allocation | No `new` in `update`/`fixedUpdate` hot paths. Pool and reuse. |
| Page errors | Zero. `npm run shoot` fails the build on any console error. |
| Module size | Keep files under ~700 lines; split into a subfolder you own if larger. |

## Verifying your work

```bash
npm run dev          # http://127.0.0.1:5180
node tools/shoot.mjs --views hero-golden,material-closeup --tag mywork
```

Screenshots land in `tools/out/shots/<tag>/` plus a `report.json` with
FPS/drawcall/triangle counts and any page errors. **Look at your own
screenshots before reporting done.** A visual critic agent will grade them and
send them back if they are not AAA.

## URL parameters (the screenshot rig depends on these)

`?freeze=1` hold simulation · `?tod=golden` time of day · `?pos=x,y,z&yaw=&pitch=`
camera placement · `?hud=0` hide HUD · `?vm=0` hide viewmodel · `?ads=1` force
aim-down-sights · `?fire=1` force a firing pose · `?quality=cinematic|high|medium|low`

If your system has a state the rig should be able to force, wire a URL param for
it and add the view to `tools/shoot.mjs`'s `VIEWS` — that file is shared, so
append only, never reorder or rename existing entries.

## The bar

The target is *Call of Duty*. Not "good for a browser game" — the critic agents
are instructed to reject that framing. Concretely, every surface needs albedo
variation, normal detail and correct roughness; every light needs shadow and
falloff; every silhouette needs to read at 100m; nothing may look like an
untextured primitive; and the image must have atmospheric depth, not flat fog.
