# BLACKSITE

A first-person shooter built in Three.js / WebGL2, with **zero external assets** —
every texture, mesh, animation and sound is generated procedurally in code at
load time. No downloaded models, no sample libraries, no licensing surface.

![Combat](docs/screenshots/05-round6-hud.png)

---

## Status: honest version

The stated goal was "Call of Duty quality". **It is not there.** The most recent
independent visual review scored it **54/100 — NOT_AAA**, up from 9/100 at the
first blockout and 32/100 mid-way.

What that score means in practice: the environment art, material authoring and
prop dressing hold up respectably, but the **lighting fundamentals are broken** —
seven of twelve captured frames are golden hour or dusk with *zero cast shadows
on the ground*, and ambient occlusion has never landed. Those two things read as
wrong instantly, and no amount of texture work compensates.

See [docs/Status.md](docs/Status.md) for the full review, every open defect, and
the prioritised fix list.

### What genuinely works

| | |
|---|---|
| **Performance** | 59–60fps at 1920×1080 across all 12 canonical views, 518–830 draw calls, ≤3.5M triangles, zero page errors |
| **Materials** | Procedural PBR with panel joints, form-tie recesses, rust masks driven by crevice/up-facing terms, Toksvig roughness regularisation |
| **Ballistics** | Energy-based penetration with back-face thickness probing — 5.56 defeats a 50mm plank and a 300mm sandbag, stops on 50mm concrete |
| **Gunplay** | Frame-rate-independent fire accumulator, learnable deterministic recoil patterns, spread state machine with first-shot accuracy |
| **Atmosphere** | Rayleigh/Mie scattering, cloud layers, seven art-directed time-of-day presets, aerial perspective |
| **Audio** | Fully synthesised WebAudio — layered gunshots (transient/body/mechanical/tail), distance low-pass and delay, convolution reverb |
| **HUD** | Compass ribbon, vitals, ammo block with fire mode and weapon identity |

### What is broken

- **No cast shadows at low sun elevation** — the shadow camera's ortho extents are
  sized for a high sun and clip long shadows away entirely. Affects 7 of 12 views.
- **No ambient occlusion in any frame** — raised in three consecutive reviews.
- **No hands on the weapon** — the rifle floats detached in the lower right.
- **Floating props** — a rust-coloured plate is suspended in mid-air in most views.
- **Untextured cooling towers** — the largest structures in five frames are smooth
  grey hyperboloids.

---

## Quick start

```bash
npm install
npm run dev
```

Then open <http://127.0.0.1:5180>. Click to capture the pointer.

**Controls** — WASD move · Shift sprint · Ctrl/C crouch · Space jump · Left click
fire · Right click ADS · R reload · B fire mode · 1/2/3 weapon · Q/E lean · Esc pause.

## The screenshot rig

```bash
node tools/shoot.mjs                    # all 13 canonical views
node tools/shoot.mjs --views hero-golden,combat --tag mywork
node tools/shoot.mjs --list
```

`tools/shoot.mjs` drives the running dev server headlessly through Playwright
with **real GPU rasterisation** (`--use-angle=d3d11`). It writes PNGs plus a
`report.json` containing per-view FPS, draw calls, triangle counts and any page
errors — and exits non-zero if the build logged an error, so a broken build
cannot report itself clean.

This works because the app exposes deterministic URL parameters:

| Parameter | Effect |
|---|---|
| `?freeze=1` | hold simulation time |
| `?tod=golden` | time of day (`dawn morning midday golden dusk night overcast`) |
| `?pos=x,y,z&yaw=&pitch=` | place the camera |
| `?hud=0` / `?vm=0` | hide HUD / viewmodel |
| `?ads=1` / `?fire=1` | force weapon poses |
| `?quality=cinematic\|high\|medium\|low` | quality preset |

## How this was built

The codebase was written by AI agents working in parallel — typically 5–12 at a
time, each owning a disjoint set of files — under a critique loop:

```
build → integrate → screenshot → hostile visual review → route defects to owners → repeat
```

The reviewer is a separate agent that only sees rendered PNGs, is explicitly
forbidden from grading on a "good for a browser" curve, and must audit each
previously-raised defect for whether it *visibly landed in the image*. That
constraint mattered: several rounds produced modules containing a shadow system,
an AO pass and a TAA resolve while the rendered frame showed none of them. Code
existing is not the same as an effect landing, and only the screenshot can tell
you which one you have.

[CONTRACT.md](CONTRACT.md) is what made parallel authorship survivable: one
owner per file, no system importing another, all communication through a system
registry and a frozen event bus.

## Documentation

- **[CONTRACT.md](CONTRACT.md)** — the binding rules for working in this codebase
- **[docs/Architecture.md](docs/Architecture.md)** — runtime topology, systems, seams
- **[docs/Status.md](docs/Status.md)** — full review, open defects, fix priority

## Constraints

| | |
|---|---|
| Draw calls | ≤ 900 |
| Triangles | ≤ 3.5M |
| Frame rate | 60fps @ 1080p |
| External assets | none — everything procedural |
| Allocation | none in `update()` / `fixedUpdate()` hot paths |

## Licence

MIT. All content is original and generated in code; there are no third-party
assets to attribute.
