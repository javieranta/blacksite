# BLACKSITE — Status

State at parking. Every number here was measured, not estimated; where something
is unverified it says so.

---

## Score history

| Round | Score | What changed |
|---:|---:|---|
| baseline | 9 | 24 unbevelled boxes, flat-fill sky |
| 2 | 32 | Textured industrial compound, greybox weapon |
| 6 | 54 | ADS regression fixed, combat perf 28→59fps, NaN errors gone |
| 8 | 58 | **Cast shadows and ambient occlusion finally landed** |
| 9 | 59 | Hand legibility, optic glass, world-space muzzle light |
| 10 | **61** | Optic rebuilt (circular tube, turrets, 97% transmission) |
| 11 | not graded | Traversal, per-weapon viewmodels, grenades — the critic agent died on a session limit |

Anchors used by the reviewer: 40 = obvious hobby project · 60 = competent indie ·
75 = strong stylised game, still clearly not AAA · 85 = mistakable for AAA at a
glance · 95 = indistinguishable.

> **On the grading.** The reviewer is an agent that sees only rendered PNGs and
> grades against an explicit checklist of AAA failure modes. It never performed a
> literal blind A/B against real Call of Duty screenshots — no such reference was
> available to it. Treat 61/100 as a strict proxy, not a measured comparison
> against the stated target. Rounds 10 and 11 were not graded on the same basis:
> 11 has no score at all.

The reviewer's own per-shot split explains where the remaining points are:

```
environment-only shots   60-68     (silhouette-dusk 68, material-closeup 66)
first-person weapon      42-54     (viewmodel-hip 52, combat 46, night 44)
```

The environment reached competent-indie. The viewmodel and the night preset are
the floor, and hero assets are where a procedural-only approach hits its ceiling.

---

## What works, verified

| Area | Evidence |
|---|---|
| **Performance** | 7.9ms at cinematic 1920×1080 on an RTX 5090 (≈127fps). 58–62fps across all 13 canonical views |
| **Shadows** | Cast shadows resolve at every sun angle including grazing low sun; pipework reads *as pipework*, catwalk grating casts a true per-bar lattice |
| **Ambient occlusion** | Present and correctly scoped — ambient term only, so sunlit corners are not smeared |
| **Warm-up** | Peak first-minute CPU hitch 742.6ms → **32.5ms**; 175 shader programs pre-linked before ready |
| **Gunplay** | Frame-rate-independent fire control, learnable recoil patterns, spread state machine with first-shot accuracy |
| **Ballistics** | Energy-based penetration with back-face thickness probing — 5.56 defeats a 50mm plank and a 300mm sandbag, stops on 50mm concrete |
| **Weapons** | Three distinct rigs swapped on 1/2/3 — WRAITH-9 SMG (20,178 tris), VK-7 rifle (21,672), LANCET marksman (26,192) |
| **Grenades** | Cook, arc, bounce, LOS-checked blast. Verified: count 3→2, one explosion at 6.2m radius, 128 damage |
| **Traversal** | 17 of 20 asserted routes. Main stair tower climbs 4.69m and descends 5.06m; ladders climb (perimeter +6.58m, silo +22.13m); dock fire stair, crate-climb mantle route and catwalk ring all pass |
| **Audio** | Fully synthesised WebAudio — layered gunshots, distance low-pass and delay, convolution reverb per zone |
| **Playability** | `playtest.mjs` 17/17 — movement, jump, gravity, firing, impacts, reload, weapon switch, no page errors |

**Scale:** 164 modules, 59,389 lines, 25 verification tools, zero external assets.

---

## Open defects

### Blocking a higher score

| System | Defect | Note |
|---|---|---|
| **lighting** | The **night preset is sunset lighting with a night sky swapped in** — a warm directional casts hard parallel shadows under a starfield, materials render at daytime albedo. Scores 44, the worst frame by 8 points | Never fixed; the agent assigned to it died on a session limit |
| **lighting** | `hero-overcast` models overcast as "sun turned down" rather than sky-dome-dominant, so a directional key still casts shadows under a flat grey sky | |
| **props** | **Floating rusted plates — eight rounds unresolved.** Present in most views. Now more visible, because the new shadow pass casts a shadow from a plate that is attached to nothing | The repeated failures suggest the approach is wrong; a *detector* was specified but never delivered |
| **level/props** | Large featureless floor and wall expanses. The reviewer's `singleBiggestGap` at round 10: a surface-story pass (dirt gradient at wall bases, 15–25 decals per 100m², cracking, near-field scatter) — it touches all 13 shots | |
| **fx** | Shell casings ~25× true scale, spawning 25–40m downrange. **Diagnosis unresolved:** the effect sets `E.size(0.051)` which is *correct* for a 5.56 case, so this may be a depth misattribution by the reviewer rather than a scale bug. Settle it by reading live particle positions from `ParticleBatch` before changing anything | |
| **ai** | Combatants: only two poses across ~10 figures, no hands (arms terminate at the weapon), inconsistent contact shadows | |
| **viewmodel** | Glove reads as smooth/waxy in places; the ADS optic still lacks eyecup and lens hood | |

### Known-failing assertions — deliberately left red

These fail on purpose. **Do not relax a threshold to make one pass** — gaming an
assertion is the exact failure mode this project spent eleven rounds fighting.

| Assertion | State |
|---|---|
| `handcheck.mjs` — NO TEAL RINGS | Hipfire **passes** (peak saturation 0.284 vs 0.34). **ADS fails** at 0.353 on 0.144% of hand pixels. The cyan comes from the darkest pixels lit only by the blue sky probe; directional desaturation cannot reach them |
| `traversal.mjs` | **17 of 20 routes pass.** Failing: plant deck switchback stair, west hall mezzanine stair, admin block stair tower — all three are stairs that never gain height, so they are blocked rather than merely awkward. Separately, the suite's keep-clear audit reports the crate-climb ramp **blocked by a Props cinder block**: that route still passes, but Props is scattering into `level.keepClear` and must subtract it |

### Performance caveats

- **Worst-frame time 35–50ms against a 16.7ms mean, in every view.** A persistent ~2× spike that reads as micro-stutter in motion. Not warm-up — that was fixed separately. Never diagnosed. The new FPS counter (F3) surfaces it as `WORST`.
- **Triangles now exceed the 3.5M budget**, peaking at 4.46M in `combat`. Framerate holds on an RTX 5090; it would not on weaker hardware.

---

## The measurement problem — read before trusting any number

Three times in this project a confident conclusion was wrong because the
*instrument* was wrong, not the code. This is the single most important thing to
carry forward.

1. **"60fps" during 167ms frames.** The FPS counter derived from a simulation
   `dt` clamped to `0.1s`, so it structurally could not read below 10fps. And
   `stats.ms` timed only JavaScript — GPU work is asynchronous, so it read ~2ms
   while the GPU took 167ms. That second number is what justified telling twelve
   agents they had "13ms of headroom to spend".
2. **"No hands" for three rounds.** They were present, rendering, and 28%
   occluded — but the same dark value as the weapon, so they read as gun parts.
   The fix was contrast, not geometry. Three rounds solved the wrong problem.
3. **"No ambient occlusion" across three reviews** while an AO pass existed. It
   only landed when an agent rendered the AO buffer *in isolation* and looked at it.

And two blind spots in the test rigs themselves:

4. **The critic reported "there is no HUD"** — because `shoot.mjs` passed `hud=0`
   on every view. The HUD existed and was well built.
5. **`traversal.mjs` reported traversal fixed while ladders were unclimbable** —
   it had 18 routes covering stairs, ramps and mantles, and not one ladder. The
   suite built to catch "I can't get off the ground floor" had the same blind
   spot as the level.

**Headless Chromium has no swap chain**, so `requestAnimationFrame` runs on a
virtual 60Hz clock and reports a flat 16.7ms regardless of GPU load. Use
`tools/gpuprobe.mjs`, which forces a pipeline flush, for anything performance
related. Never `stats().fps`, never rAF intervals.

---

## Where the ceiling is

Reaching ~75 looks achievable with the open defects above — night lighting,
surface story, floating props, AI figures. Past that, two constraints bind:

1. **Hero assets.** The reviewer's prescription for the hand was *"weights on a
   standard 15-bone hand rig, a glove material with stitched seams, knuckle
   pads"* — that describes an authored asset. Procedural generation does concrete
   and rust extremely well and hero objects poorly, and the weapon is 20–25% of
   every gameplay pixel. Dropping the zero-external-assets rule *for the weapon
   and hands specifically* is the highest-leverage change available.
2. **WebGL2.** No compute shaders, no mesh shaders, no hardware ray tracing. No
   Lumen or Nanite equivalent exists to reach for. WebGPU would unlock real GI,
   clustered lighting and GPU culling, at the cost of re-architecting the render
   layer — gameplay, ballistics, AI and level systems would carry over unchanged.

85+ ("mistakable for AAA at a glance") is not reachable under the current
constraints, and no amount of further iteration changes that.
