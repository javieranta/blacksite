# Resuming work on BLACKSITE

Everything needed to pick this up cold is in the repo. This file is the entry
point.

## 1. Get it running

```bash
npm install
npm run dev          # http://127.0.0.1:5180
```

Confirm it still works before changing anything:

```bash
node tools/playtest.mjs      # 17 interactive checks — must be 17/17
node tools/shoot.mjs         # 13 canonical views + report.json
```

`tools/out/` is gitignored (it reached 838MB of per-agent working shots), so the
screenshots are **not** in the repo — `node tools/shoot.mjs` regenerates them in
a few minutes. A curated progression set is committed at `docs/screenshots/`.

## 2. Read these, in order

| File | Why |
|---|---|
| [Status.md](Status.md) | Where it stands, every open defect, what the reviewer said |
| [../CONTRACT.md](../CONTRACT.md) | The binding rules — one owner per file, registry + event bus only |
| [Architecture.md](Architecture.md) | Runtime topology, systems, seams |

## 3. Pick up where it stopped

The last independent review scored **54/100 (NOT_AAA)**. The reviewer's
highest-value next step, verbatim:

> Fix the sun shadow cascade so shadows survive low sun elevations. The shadow
> pipeline demonstrably works — `hero-midday`, `interior` and `vertical` all
> render correct directional shadows — so this is not a feature to build, it is
> a shadow camera whose ortho extents and far plane are sized for a high sun and
> clip everything away as the sun drops. Fit the shadow camera's light-space
> AABB to the view frustum each frame, with extents scaled by
> `1/tan(sunElevation)`.

That single change puts shadows into 7 of 12 frames. Then, in order: ambient
occlusion (raised in three consecutive reviews, still not landing), hands on the
weapon, floating props. Full list in [Status.md](Status.md).

Relevant files: `src/render/lighting/CascadedShadowMap.js`,
`src/render/lighting/ShadowShaderPatch.js`, `src/render/post/GTAOPass.js`,
`src/render/post/AOApplyEffect.js`, `src/weapons/viewmodel/Hands.js`,
`src/world/props/Float.js`.

Debug hooks that already exist: `?csmdebug=1` cascade coverage, `=2` single
unfiltered tap, `=9` stock three.js PCF (use it to tell a cascade-fitting problem
apart from a filter problem), `?lightdebug`, `?postfx=0`.

## 4. The development loop

This codebase was built by AI agents in parallel under a screenshot-driven
critique loop:

```
build (N parallel agents, disjoint file ownership)
  → integrate (one agent, smallest changes to make it run clean)
  → capture (tools/shoot.mjs, real GPU via ANGLE/D3D11)
  → hostile visual review (agent that sees only PNGs)
  → route each defect to the file's owner
  → repeat
```

The four workflow scripts that ran are committed at `tools/workflows/`. They
contain the full agent briefs, the critic prompt and the defect-routing logic —
re-run or adapt them rather than rewriting from scratch.

Two rules made the loop work, both learned the hard way:

**Code existing is not the same as an effect landing.** Several rounds produced
modules containing a shadow system, an AO pass and a TAA resolve while the
rendered frame showed none of them. Only the screenshot distinguishes those two
states. The critic prompt therefore requires a *resolution audit*: for each
previously-raised defect, did it visibly land in the image? No credit for changed
code that didn't change the render.

**The measurement rig is part of the system under test.** Two false findings came
from blind spots in the tooling, not the game:
- The critic reported "there is no HUD in any capture" — because `shoot.mjs`
  passed `hud=0` on every view. The HUD existed and was well built. Fixed by
  adding a dedicated `hud` view.
- `playtest.mjs` initially reported five firing failures — because the trigger is
  correctly gated on pointer lock, which headless Chromium may refuse. Fixed by
  requesting lock and falling back to the `weapon:force` path.

Verify the rig before believing a finding that says a whole feature is missing.

**Re-shoot before trusting any agent report.** Agents have died on API errors
*after* writing their files, so reported failures do not mean the work is absent
— and reported successes have described a state the renderer didn't show.

## 5. Cost

Roughly 11M subagent tokens across six rounds, 2–4M per round. Enough to hit both
a weekly and a monthly cap. Scope rounds accordingly: the tightest round (round 6,
5 focused agents with defects quoted verbatim from the review) had the best
outcome-per-token of any of them.
