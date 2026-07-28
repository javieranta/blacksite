# BLACKSITE — Status

Last assessed after round 6.

## Score trajectory

| Round | Score | Verdict | State |
|---:|---:|---|---|
| Baseline | 9 | NOT_AAA | 24 unbevelled boxes, flat-fill sky |
| 2 | 32 | NOT_AAA | Textured industrial compound, greybox weapon |
| 6 | **54** | **NOT_AAA** | Full gameplay layer, materials competent, lighting broken |

Scoring anchors used by the reviewer: 40 = obvious hobby project · 60 = competent
indie · 75 = strong stylised game, still clearly not AAA · 85 = genuinely
mistakable for a AAA frame at a glance · 95 = indistinguishable.

> **On the grading method.** The reviewer is an agent that sees only rendered
> PNGs and grades against an explicit checklist of AAA failure modes. It was
> *not* able to perform a literal blind A/B against real Call of Duty
> screenshots — no such reference was available to it. Treat 54/100 as a strict
> proxy measurement, not a measured comparison against the actual target.

## Reviewer's summary

> "The prop dressing and rust/metal materials have reached competent-indie level,
> but the lighting fundamentals are broken: seven of twelve frames are golden
> hour or dusk with literally zero cast shadows on the ground, and no frame
> anywhere shows ambient occlusion. A reviewer spots this in well under a second."

**Strongest aspect:** PBR authoring on rusted metal and industrial deck plate.
The pitted rust on the horizontal pipe in `material-closeup` holds a warm rim
light from the low sun with correct roughness variation between corroded and
intact areas — that specific surface pairing would not immediately give itself
away next to a AAA frame. Prop density and silhouette layering in the courtyard
views is the runner-up.

## The single highest-value fix

Per the reviewer, do this before anything else:

> Fix the sun shadow cascade so shadows survive low sun elevations. The shadow
> pipeline demonstrably works — `hero-midday`, `interior` and `vertical` all render
> correct directional shadows — so this is not a feature to build, it is a shadow
> camera whose ortho extents and far plane are sized for a high sun and clip
> everything away as the sun drops. Fit the shadow camera's light-space AABB to
> the view frustum each frame, with extents scaled by `1/tan(sunElevation)`.

That one change puts real shadows into 7 of 12 frames, including every hero,
viewmodel and combat shot. Nothing else on the list touches as many frames.

## Open defects

### Critical

| System | Defect | Fix |
|---|---|---|
| lighting | Zero cast shadows in all low-sun views (`hero-golden`, `hero-dusk`, `silhouette-dusk`, `viewmodel-hip`, `viewmodel-ads`, `material-closeup`, `combat`) | Refit shadow camera light-space AABB per frame, extents scaled by `1/tan(sunElevation)` |
| lighting | No ambient occlusion in any frame — third review running. `hero-overcast` is the proof: under pure ambient, nothing has crevice darkening; barrels, blocks and column footings meet the floor with a crisp bright seam | Verify the AO buffer in isolation, then composite against the **diffuse ambient term only** |
| viewmodel | No hands or arms — the rifle floats detached in the lower-right corner with nothing gripping it | Model and skin gloved hands to the grip and handguard |
| viewmodel | ADS optic is a hollow rectangle with sharp corners, no lens glass, no coating tint, no tube vignette, no turrets or mount | Rebuild as a real 1× red dot: tinted objective, AR coating gradient, knurled turrets, rubber eyecup |

### Major

| System | Defect |
|---|---|
| props | Floating rust-coloured plate present in every hero view, plus 3 more above the gantry in `material-closeup` and 4+ in `combat`. Raised twice, zero progress |
| props | Sandbag walls read as one uniform moulded beige mass with three vague lumps — no bag boundaries, seams, weave or sag |
| lighting | Environment metal specular clipping to pure 255 white over large continuous areas (pipe tops, railing edges in `interior` and `vertical`) — destroys form more severely than the original sparkle |
| lighting | Night practicals emit glow and bloom but cast no light pools on the ground or their own mounting surfaces |
| fx | Muzzle flash is a single flat six-pointed billboard contributing zero light to the weapon, ground or adjacent geometry |
| fx | Shell casings eject into open sky far from the ejection port and are roughly as wide as the magazine |
| ai | Combatants stand in byte-identical poses — straight unbent legs, no stance width, no foot contact, no shadow, arms terminating at the weapon with no hands. Two agents co-located and intersecting in `viewmodel-ads` |
| ai | Night combatant lit as though in full daylight while every surface around it sits in deep night blue |
| level | Cooling towers — the largest structures in five frames — are completely untextured smooth grey hyperboloids |
| level | Large uniform featureless expanses persist; `silhouette-dusk` gives ~40% of frame to a blank panel-grid wall |

### Minor

- **postfx** — no depth of field in ADS; the background renders as sharply as the optic 20cm from the eye.
- **sky** — clouds in `hero-midday` are hard-edged solid white shapes with no internal density variation.

## Resolved this round

- **ADS picture-in-picture regression** — the optic previously rendered as an opaque
  box containing a separate zoomed render. Now genuinely see-through with the dot
  composited in world space. (A red dot is a 1× optic, so a render-target scope
  was the wrong technique entirely.)
- **Combat performance** — 28fps → 59fps. All 12 views now 59–60fps.
- **NaN geometry errors** — were 3 per frame, now zero.
- **Specular sparkle on the weapon** — substantially resolved via roughness
  regularisation; the receiver is now stable dark blue-grey.

## A correction to the review

The reviewer reported "no HUD in any of the twelve captures" and raised it as a
major finding. **This is a rig artifact, not a missing feature.** `shoot.mjs`
passed `hud=0` on every view, so the HUD was never photographed. It exists and is
implemented — compass ribbon, vitals block, ammo readout with fire mode and
weapon identity (see `docs/screenshots/05-round6-hud.png`).

A dedicated `hud` view has been added to the rig so this cannot recur. It is
worth noting as a general lesson: **the measurement apparatus is part of the
system under test**, and a blind spot in the rig becomes a false finding in the
review.

## Performance (round 6, 1920×1080, cinematic preset)

All views 59–60fps, zero page errors.

| View | FPS | Draws | Triangles |
|---|---:|---:|---:|
| hero-golden | 59 | 535 | 2.27M |
| hero-midday | 59 | 530 | 2.24M |
| hero-dusk | 59 | 534 | 2.25M |
| hero-overcast | 60 | 530 | 2.22M |
| interior | 60 | 556 | 2.92M |
| material-closeup | 59 | 526 | 2.33M |
| viewmodel-hip | 60 | 544 | 2.29M |
| viewmodel-ads | 60 | 753 | 3.14M |
| silhouette-dusk | 60 | 669 | 2.86M |
| vertical | 60 | 619 | 3.01M |
| night | 60 | 518 | 2.27M |
| combat | 59 | 830 | 3.50M |

Headroom exists — frame time is well inside the 16.6ms budget — so the remaining
defects are correctness and art problems, not performance trade-offs.
