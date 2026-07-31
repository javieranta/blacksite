# BLACKSITE — VR port plan

A concrete plan for taking BLACKSITE to WebXR (Quest 3 and desktop-tethered).
Written while the desktop build is fresh, so the reasoning behind each obstacle
is recorded rather than rediscovered.

Nothing here is implemented. `grep -rn "XR" src/core/Engine.js` returns nothing.

---

## Why this port is more tractable than it looks

| Already true | Why it helps |
|---|---|
| Three.js has WebXR built in | `renderer.xr.enabled = true` plus a session button is most of the bootstrap |
| Systems talk only through a registry and an event bus | A VR input system can replace `Input` without touching gameplay |
| **Zero external assets** | Nothing to download. A standalone headset gets the whole game in one JS bundle — this is a genuine advantage over an asset-heavy engine |
| `AdaptiveQuality` already exists | The governor that keeps framerate on integrated graphics is exactly what Quest needs; it needs a VR tier, not a rewrite |
| Fixed 120Hz `fixedUpdate` decoupled from render | Physics already runs independent of frame rate, which VR requires |
| Procedural geometry with LOD hooks | Triangle budgets can be re-tuned per platform without re-authoring art |

## The five real obstacles

### 1. The viewmodel dual-camera trick does not survive stereo — hardest problem

The desktop build renders the weapon into a **separate scene** (`ctx.viewScene`)
with a **separate camera** (`ctx.viewCamera`, near plane 0.005m), composited over
the world with a cleared depth buffer. That is the standard FPS trick and it is
why the weapon never clips into walls.

In VR it breaks completely. Two eyes with real stereo disparity mean a weapon
drawn in a separate pass with cleared depth has **the wrong convergence** — it
will read as floating at an indeterminate distance, and it will not occlude
correctly against world geometry. Worse, the viewmodel is authored in *camera
space* at a scale chosen to look right through a 80° flat FOV; at true 1:1 world
scale in a headset it will be visibly the wrong size.

**The fix is not a port, it is a redesign.** In VR the weapon must be:
- a real object in `ctx.scene` at true physical scale (a carbine is ~0.9m),
- positioned by tracked controllers rather than by a procedural sway rig,
- depth-tested against the world like anything else.

This affects `ViewModel.js`, `CameraRig.js`, `PostFX.js` (the `ViewModelPass`
disappears) and the ADS system (see §4). Budget this as the single largest task.

### 2. Camera ownership must invert

`CameraRig` currently **writes** `ctx.camera` position and quaternion every frame
from player yaw/pitch, then layers on head bob, weapon sway, recoil kick, trauma
shake, landing punch, lean roll and FOV blending.

In XR, `renderer.xr` owns the camera — the headset pose is the truth, and
anything the game writes is either ignored or fights it. So:

- The player capsule becomes a **rig parent**; the XR camera is a child of it.
  Locomotion moves the rig, the head moves freely inside it.
- **Every camera effect above must be disabled in VR.** Not toned down —
  disabled. Head bob, shake, recoil kick and FOV changes applied to a headset are
  the textbook causes of simulator sickness. `CameraRig` needs an XR branch that
  early-returns from all of it, and the recoil that currently moves the camera
  must move only the weapon.
- FOV comes from the headset. `CAMERA.fovBase/fovSprint/fovAds` become desktop-only.

### 3. Performance — the budget is roughly 6× harder

Measured desktop today: **7.9ms at cinematic, 1920×1080, on an RTX 5090 Laptop.**

| | Desktop today | Quest 3 target |
|---|---|---|
| Pixels | 2.07M | ~2 × 2064×2208 ≈ 9.1M |
| Frame budget | 16.7ms (60Hz) | 11.1ms (90Hz) |
| Hardware | RTX 5090 | Adreno 740, roughly a mid-range phone |

That is ~4.4× the pixels in 2/3 the time, on far weaker hardware. The current
post chain alone (GTAO, TAA, DoF, motion blur, bloom, grade, SMAA) would not fit.

Levers, in the order worth pulling:
1. **Drop most of the post chain** — see §5; several passes are actively harmful in VR anyway.
2. **WebXR fixed foveated rendering** — `session.renderState.fixedFoveation = 1`. Nearly free, large win.
3. **Single-pass stereo / multiview** — Three.js uses `OVR_multiview2` where available; verify it engages.
4. **A `vr` quality tier in `QUALITY`** — 1 or 2 shadow cascades, no volumetrics, half-res AO or none, aggressive LOD distances.
5. **Triangle budget.** Currently up to 4.4M in the heaviest view, already over the desktop 3.5M ceiling. Quest wants well under 1M.

`AdaptiveQuality` should gain a VR branch that opens at the `vr` tier and never
climbs above it on standalone hardware.

### 4. Interaction — the parts that become *better* in VR

Several systems map naturally onto tracked hands, and some become more fun:

- **Grenades.** Already a physical throw with arc and bounce (`Grenades.js`).
  In VR this is a real throw with controller velocity — a straight win.
- **Ladders.** Just implemented for desktop (`PlayerController._updateLadder`).
  The VR idiom is hand-over-hand climbing: grab a rung, pull down, repeat. The
  `level.ladders` volumes already registered are exactly the data that needs.
- **Mantling** becomes grabbing a ledge and pulling up.
- **Reload** becomes physical: grab a magazine, insert it. `WeaponData` already
  has `reloadTime`/`reloadEmptyTime` to pace it.
- **ADS disappears as a mechanic.** You do not press a button — you bring the
  weapon to your eye. The optic (`viewmodel/Weapon.js`) already renders a real
  1× red dot with a tinted objective, which is the correct thing for VR; the
  `adsProgress` state machine and FOV blend become desktop-only.

### 5. Post-processing must be re-profiled, not just reduced

Several effects in the current chain are **nausea triggers or artefacts** in VR,
independent of cost:

| Effect | VR verdict |
|---|---|
| Motion blur | **Remove.** Head-motion blur is actively sickening |
| Depth of field | **Remove.** The eye chooses focus; forcing it fights accommodation |
| Chromatic aberration | **Remove.** The headset already has lens CA to correct |
| Film grain | **Remove.** Reads as dirty optics and shimmers in stereo |
| Vignette | **Repurpose.** Not as a look — as a *comfort tunnel* during locomotion |
| TAA | **Risky.** Head motion breaks reprojection; prefer MSAA, which VR wants anyway |
| Bloom | Keep, subtle |
| GTAO | Keep if affordable — it is what grounds geometry, and that matters more in stereo |
| Tonemap + grade | Keep |

### 6. HUD must become diegetic

`HUD.js` is a **DOM overlay** — deliberately, so it stays at native resolution.
In VR there is no DOM overlay; a screen-locked HUD is unreadable and uncomfortable.

Move to world-space: ammo count on the weapon itself (a magazine window or a
receiver display), health as a wrist panel, compass on the wrist, kill feed
dropped or made ambient. The `PerfPanel` should become a debug panel pinned in
world space.

---

## Suggested phase order

Each phase ends somewhere testable, so the port never sits half-broken.

| Phase | Work | Done when |
|---|---|---|
| **0. Bootstrap** | `renderer.xr.enabled`, session button, rig parent, `?vr=1` | Stereo renders, head look works, desktop unaffected |
| **1. Camera ownership** | XR branch in `CameraRig`; disable bob/shake/recoil-on-camera/FOV | Head pose is stable and comfortable; no camera fighting |
| **2. Performance tier** | `vr` quality preset, foveation, multiview, post re-profile (§5) | Holds 72Hz in the courtyard on target hardware |
| **3. Locomotion + comfort** | Smooth + teleport, snap turn, comfort vignette, seated/standing | Can traverse the map without discomfort |
| **4. Weapon in world space** | The §1 redesign: real-scale weapon, two-handed hold, controller aim | Can shoot accurately; no stereo artefacts |
| **5. Physical interaction** | Grenade throw, hand-over-hand ladders, ledge grab, physical reload | Ladders and grenades work by hand |
| **6. Diegetic UI** | Weapon-mounted ammo, wrist panels | No screen-locked UI remains |

## Testing — do not skip this

Your Skärgård project already solved headless VR testing, and the same pattern
should be lifted here: **IWER** (Immersive Web Emulation Runtime) emulates a
Quest 3 in a normal browser, driven by Playwright, with no device attached.

See `Claude Code Projects/skargard/tools/test-vr-xr.mjs` — it drives an emulated
headset pose and controller, asserts the app responds, and checks that sessions
start and stop cleanly without breaking the desktop path. It is gated behind a
`?xremu=1` URL parameter, which is the same shape as this project's existing rig
parameters.

This matters more than usual here, because **this project's entire history is a
lesson in measurement blind spots**: eleven rounds of screenshot review missed
that the stairs were unclimbable, and the traversal suite built to catch that
missed ladders. A VR port has the same hazard in a worse form — you cannot see
stereo disparity, comfort or hand alignment in a mono screenshot. Build the
assertion first.

Minimum VR assertions worth having on day one:
- a session starts and ends cleanly, and desktop still works afterwards
- both eye views render with plausibly different matrices (catches mono fallback)
- the weapon is depth-tested against the world (catches the §1 failure directly)
- frame time under the target at the reference viewpoint
- no camera effect writes to the XR camera pose

## What to read first

- [Architecture.md](Architecture.md) — the seams a VR input/camera layer plugs into
- [Status.md](Status.md) — current state and open defects
- `src/core/Engine.js` — the dual-scene setup that §1 has to undo
- `src/player/CameraRig.js` — everything §2 has to disable
- `src/render/PostFX.js` — the chain §5 has to re-profile
