# Resuming work on BLACKSITE

Everything needed to pick this up cold is in the repo. Start here.

---

## 1. Get it running and prove nothing rotted

```bash
npm install
npm run dev          # http://127.0.0.1:5180
```

Then, in order — these take a while but they are the difference between knowing
the state and guessing it:

```bash
node tools/playtest.mjs      # 17 interactive checks. MUST be 17/17
node tools/traversal.mjs     # 20 vertical routes. 17 pass, 3 known failures
node tools/handcheck.mjs     # hand pixels. Hipfire passes, ADS teal known-red
node tools/gpuprobe.mjs      # real GPU ms. cinematic must stay <= 16.7ms
node tools/shoot.mjs         # 13 canonical views + report.json
```

`tools/out/` is gitignored (it reached 838MB of per-agent working shots), so
screenshots regenerate rather than ship. A curated progression set is committed
at `docs/screenshots/`.

**Play it:** <https://javieranta.github.io/blacksite/> — auto-deploys from `main`
via GitHub Actions. First load takes 30–60s: ~175 shader programs compile and
every texture is generated, not downloaded.

**Controls:** WASD · Shift sprint · Ctrl/C crouch · Space jump · LMB fire ·
RMB ADS · R reload · **1/2/3 weapons** · **G grenade** · Q/E lean · **F3 perf
readout** · Esc pause. Ladders: walk into one facing it and hold W.

---

## 2. Read these, in order

| File | Why |
|---|---|
| [Status.md](Status.md) | Where it stands, every open defect, and **the measurement problem** — read that section before trusting any number |
| [../CONTRACT.md](../CONTRACT.md) | Binding rules: one owner per file, registry + event bus only |
| [Architecture.md](Architecture.md) | Runtime topology, systems, seams |
| [VR.md](VR.md) | The WebXR port plan, if that is the direction |
| [../tools/workflows/](../tools/workflows/) | The agent briefs and critic prompts that built it |

---

## 3. Pick up where it stopped

Highest value first. Each is scoped and has its evidence in `Status.md`.

1. **Night preset** (`src/render/Lighting.js`, `src/render/sky/SkyPresets.js`).
   Scores 44, the worst frame by 8 points, and it is *wrong* rather than merely
   weak: `TIME_OF_DAY.night` has `elevation: -12` — the sun is below the horizon —
   yet a warm directional still casts hard parallel shadows. Rebuild as moonlight
   plus practicals with real falloff. Same class of error in `hero-overcast`.
2. **Floating props** (`src/world/props/**`). Eight rounds unresolved. Every
   previous attempt wrote another reseat pass; **do not**. Write a *detector*
   first: walk the whole scene graph, find every mesh touching nothing, print its
   name, parent chain and **the source file that created it**. If it reports
   nothing, the detector is the bug. That step is what eight rounds skipped.
3. **Surface story** (`src/world/props/**`, decals). The reviewer's
   `singleBiggestGap`: dirt gradient at wall bases, 15–25 authored decals per
   100m², triplanar cracking, near-field scatter. Touches all 13 shots.
4. **Three stairs still unclimbable** — plant deck switchback, west hall
   mezzanine, admin block stair tower. All three gain zero height, so they are
   blocked, not merely awkward; the same class as the original reported bug.
   Run `node tools/traversal.mjs --only "mezzanine"` to iterate on one.
5. **Props vs `level.keepClear`.** The suite's keep-clear audit reports a Props
   cinder block on the crate-climb ramp. That route still passes, but Props must
   subtract `ctx.get('level').keepClear` before scattering — the volumes exist.
6. **Shell casings** (`src/fx/particles/Effects.js`). **Diagnose before fixing.**
   The effect sets `E.size(0.051)`, correct for a 5.56 case, so the reviewer's
   "25× oversize at 25–40m downrange" may be a depth misattribution. Read live
   particle positions and sizes out of `ParticleBatch` and settle which it is.
7. **Worst-frame spikes.** 35–50ms against a 16.7ms mean in every view, never
   diagnosed. `F3` surfaces it as `WORST`. Warm-up was a separate, fixed problem.
8. **AI figures** (`src/ai/**`). Two poses across ~10 combatants, no hands,
   inconsistent contact shadows.

**Debug hooks that already exist:** `?csmdebug=1|2|9` (cascade coverage /
unfiltered tap / stock PCF), `?aodebug=1..5`, `?lightdebug`, `?postfx=0`,
`?ai=0`, `?aicount=N`, `?aistage=<m>`, `?perf=1`, `?adaptive=0`, `?gpuwarn=0`.

---

## 4. How to work on this

The loop that produced it: **build (N parallel agents, disjoint file ownership)
→ integrate → capture → hostile visual review → route each defect to the file's
owner → repeat.** The four workflow scripts are in `tools/workflows/`.

Three rules, all learned expensively:

**Code existing is not the same as an effect landing.** Rounds shipped modules
containing a shadow system, an AO pass and a TAA resolve while the render showed
none of them. Only the screenshot distinguishes those states. The critic prompt
therefore requires a *resolution audit*: for each previously-raised defect, did
it visibly land? No credit for changed code that did not change the image.

**The measurement rig is part of the system under test.** Two confident findings
were rig artefacts: "there is no HUD" (the shoot rig passed `hud=0` on every
view) and "no hands" (present, but the same value as the weapon). And
`traversal.mjs` reported traversal fixed while ladders were unclimbable, because
it had no ladder route. Before believing a finding that says a whole feature is
missing, check the instrument.

**Re-shoot before trusting any agent report.** Agents have died on API errors and
quota caps *after* writing their files, so a reported failure does not mean the
work is absent — and reported successes have described a state the renderer did
not show.

When adding an assertion, **prove it fails on the current build first.** An
assertion that cannot detect the defect is worse than none, because it
manufactures confidence. Two defects shipped in round 9 despite assertions being
mandated, for exactly this reason.

---

## 5. Cost

Roughly 13M subagent tokens across eleven rounds, 2–4M per round. Enough to hit a
weekly, a monthly and a session cap. The tightest rounds — few agents, defects
quoted verbatim from the review, one clear owner each — had by far the best
outcome per token. Broad rounds with many agents mostly produced work that later
rounds had to re-verify.
