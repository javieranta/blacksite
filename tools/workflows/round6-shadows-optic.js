export const meta = {
  name: 'blacksite-round6',
  description: 'Fix ADS optic regression, missing cast shadows, residual specular aliasing and the combat perf regression',
  phases: [
    { title: 'Fix', detail: '5 targeted agents on the four blocking defects' },
    { title: 'Integrate', detail: 'clean build, 12 views, 55fps+ everywhere' },
    { title: 'Critique', detail: 'hostile AAA grade with resolution audit' },
  ],
}

const ROOT = 'C:/Users/javie/Claude Code Projects/blacksite'

const PREAMBLE = `You are building BLACKSITE, a first-person shooter in Three.js targeting modern
Call of Duty visual quality. Project root: ${ROOT}.

FIRST ACTIONS, MANDATORY:
1. Read ${ROOT}/CONTRACT.md in full. It is binding.
2. Read the CURRENT content of every file you own before changing it. This is a
   mature codebase -- 138 modules built over five prior rounds. You are making a
   TARGETED FIX to working code. Do not rewrite a system wholesale. Find the
   actual root cause and fix that.
3. Look at ${ROOT}/tools/out/shots/round5/ with the Read tool -- that is exactly
   what the game looks like right now. Your defect is visible in those images.

THE ONE RULE: edit ONLY the files listed in YOUR OWNED FILES. Other agents work
in this repo simultaneously. If you need a seam that does not exist, build it on
your own side and report it.

Available: three@0.180, postprocessing@6.36, n8ao@1.9, three-mesh-bvh@0.9.
CONSTRAINTS: zero external assets (all procedural); no allocation in
update()/fixedUpdate(); zero console errors; files under ~700 lines.

MEASURED STATE (1920x1080, cinematic). Page errors: ZERO -- keep it that way.
  11 of 12 views  59-60fps  556-791 draws  2.84-3.36M tris
  combat          28fps     825 draws      3.47M tris   <-- REGRESSION
Ceiling: 900 draws, 3.5M tris, 55fps minimum. Triangles are close to the ceiling,
so prefer fixes that do not add geometry.

HOW TO VERIFY (a Vite dev server with hot reload is ALREADY RUNNING on
http://127.0.0.1:5180 -- do NOT start another, do NOT run 'npm run dev'):
  cd "${ROOT}"
  node --check <each file you wrote>
  node tools/shoot.mjs --views <your views> --tag <your-tag>
Then READ the PNGs and judge them with your own eyes. Never report done on output
you have not looked at. Check stderr for page errors; introducing one breaks the
build.

Others edit concurrently: a failure may come from a file you do not own. Note it,
do not fix it, judge only your own work.

No placeholders. No "// TODO".`

const REPORT = `Report: the ROOT CAUSE you found (not the symptom), what you changed,
measured numbers before and after, which screenshots you examined and your honest
opinion of them, and anything you could not fix.`

const AGENTS = [
  {
    key: 'viewmodel',
    label: 'viewmodel-ads-fix',
    files: 'src/weapons/ViewModel.js and src/weapons/viewmodel/**',
    views: 'viewmodel-ads,viewmodel-hip,combat',
    brief: `DEFECT 1 (CRITICAL, A REGRESSION -- this is your top priority).
Open ${ROOT}/tools/out/shots/round5/viewmodel-ads.png. The aim-down-sights view is
badly broken. The optic renders as an ENORMOUS dark square box floating in the
centre of the frame -- roughly 250x250 pixels of housing -- containing a small
inset window that shows a separate, differently-lit view of the scene with a red
dot in it. It reads as a television set bolted to the gun. Compare with
${ROOT}/tools/out/shots/round3/viewmodel-ads.png, where ADS was correctly
aligned: the sight sat on the view axis at a believable scale.

What ADS must look like: the shooter's eye is directly behind the optic, so the
optic HOUSING is largely out of frame or reduced to a thin surround near the
frame edges, and the player looks THROUGH the glass at the world -- the same
world, continuous with the surrounding image, at the same exposure -- with a
crisp glowing red dot floating on it. The dot stays on the view axis. The world
seen through the tube must not be a differently-lit or differently-scaled
render.

Diagnose which of these is happening and fix it:
  a) The optic geometry is simply scaled far too large, or the ADS pose parks the
     weapon much too far from the camera so the optic subtends a huge angle.
     Check ADS_EYE_RELIEF and the sight-anchor maths -- the previous rounds
     computed adsPos from the sight anchor, which was correct; verify that is
     still what runs.
  b) A picture-in-picture scope render-target is being used with a wrong FOV,
     wrong scale or wrong quad size. For a RED DOT sight (which this is -- a
     1x non-magnifying optic) a render-target scope is the WRONG technique
     entirely: at 1x the correct implementation is a transparent glass plane with
     a slight tint plus an additive reticle billboard. There is no magnification,
     so there is nothing to re-render. If a PiP path exists, remove it for this
     optic and use transparent glass + additive dot.
Whichever it is, the fix must produce: continuous world through the glass, a
small bright dot, and the housing reduced to a subtle surround.

DEFECT 2 (CRITICAL) -- residual specular aliasing. In round5/combat.png the dark
receiver and magazine at bottom-right still carry a dense sparkling
salt-and-pepper speckle of coloured pixels. It was reduced but NOT eliminated.
Finish it: raise the roughness floor on the metal zones to at least 0.32; apply
Toksvig/LEAN roughness regularisation when building the normal-map mip chain
(measure average normal length per mip and raise that mip's roughness); confirm
every weapon texture has a full mip chain with trilinear filtering and anisotropy
>= 4; and reduce the amplitude of the highest-frequency normal detail. The
speckle must be GONE, not reduced. Verify by reading viewmodel-hip and combat.

DEFECT 3 (major) -- hipfire silhouette. The hipfire pose in combat.png is much
improved. Finish it: the large flat dark slab facing camera at bottom-right still
reads as an untextured plane. Give it panel breaks, a sling mount, a QD socket, a
serial-number plate or geometry relief so no large surface reads as blank.`,
  },
  {
    key: 'lighting',
    label: 'lighting-shadows',
    files: 'src/render/Lighting.js and src/render/lighting/**',
    views: 'hero-golden,hero-midday,combat,interior,night',
    brief: `DEFECT 1 (CRITICAL -- this is now the single largest thing separating this game
from a AAA frame).
THERE ARE ALMOST NO CAST SHADOWS. Open ${ROOT}/tools/out/shots/round5/combat.png
and hero-golden.png. The sun is low and golden. In a real golden-hour scene the
ground would be covered in long dramatic shadows from the gantries, columns,
stairs, cooling towers, barriers and crates -- shadows would be the dominant
compositional element. Instead the ground is a broad, evenly-lit pale slab with
barely a shadow on it, which is why the image still reads as a rendering rather
than a photograph.

Investigate in this order and report what you actually find:
  a) Are shadows being RENDERED at all? Check that castShadow is set on the level
     and prop meshes (they may be merged/instanced meshes whose castShadow flag
     was lost during a merge -- a very common cause), and that receiveShadow is
     set on the ground.
  b) Is the cascade FIT covering the visible ground? If the cascade frustum is
     fitted too tightly around the camera or clipped too near, distant casters
     drop out and only a small area near the player gets shadowed. Splits should
     reach ~200m.
  c) Is the shadow-map far plane / caster bounds clipping tall casters (towers,
     gantries) out of the depth render? Tall thin casters need the light frustum
     extended along the light direction, not just around the view frustum.
  d) Is shadow intensity being washed out by an over-bright ambient/IBL term? If
     ambient is so strong that shadowed regions are nearly as bright as lit ones,
     shadows exist but are invisible. Check the ratio: a sunlit surface should be
     roughly 4-8x brighter than the same surface in shadow at golden hour.
  e) Is the PCSS penumbra so wide that shadows dissolve into the background?
Use the existing debug hooks: ?csmdebug=1 (cascade coverage), =2 (single
unfiltered tap), =9 (stock three PCF). If =9 shows crisp shadows and your filter
does not, it is a filter problem; if neither shows shadows, it is a fit or flag
problem.

SUCCESS CRITERION, verify it visually: in hero-golden the gantry and column
shadows must fall across the courtyard floor as long, clearly recognisable
shapes, and in hero-midday the overhead pipework must cast a pipe-shaped shadow
you can identify as pipework. Read the PNGs and confirm before reporting done.

DEFECT 2 (major) -- shadow-side falloff. Once shadows exist, confirm the shadowed
faces are lit by cool sky fill rather than collapsing to flat black or staying
suspiciously bright. Target 4-8x lit:shadow ratio at golden hour, with the shadow
side tinted toward the sky colour.

DEFECT 3 (major) -- interior. Shoot interior and confirm visible light shafts
through the openings and a mullion pattern cast on the floor. If not present,
find out why the volumetrics are not landing indoors.

DEFECT 4 (major) -- combat costs 28fps vs 60fps elsewhere. Muzzle flashes must not
cast shadows (a shadow-casting point light per shot forces 6 extra cube-face
renders). Check FlashPool and the AI muzzle flashes, disable shadow casting on
them, and report the fps delta.`,
  },
  {
    key: 'stabilize',
    label: 'perf-combat',
    files: 'You may edit ANY file, but ONLY to fix the combat performance regression. Make the minimum change. No aesthetic changes, no refactoring.',
    views: 'combat,hero-golden',
    brief: `SINGLE DEFECT (CRITICAL) -- the 'combat' view runs at 28fps while all 11 other
views hold 59-60fps. Same level, same materials, similar draw calls (825 vs ~770)
and triangles (3.47M vs ~3.15M). Those deltas cannot explain a 2x frame-time
increase, so the cost is in what combat uniquely enables: ?fire=1 forces a firing
pose, so the weapon fires continuously and the AI is in active combat.

Find the cost EMPIRICALLY, do not guess. Bisect by disabling one suspect at a
time and re-shooting the combat view, recording fps each time. Suspects, roughly
in order of likelihood:
  - Shadow-casting lights spawned per muzzle flash (player and/or every AI
    shooter). Each one can force six cube-face shadow renders per frame. With
    several AI firing simultaneously this alone could account for the whole delta.
  - Additive particle overdraw: many large overlapping quads at high screen
    coverage is a fill-rate sink, especially with soft-particle depth fetches per
    fragment.
  - Full-resolution particle or post passes that should be half-res.
  - Per-frame BVH rebuilds in ballistics or AI navigation.
  - Per-frame geometry rebuilds for tracers or decals.
  - Decal accumulation without an LRU cap, growing unboundedly during sustained
    fire.

Report the measured fps for each suspect you disabled, so the actual culprit is
identified rather than inferred. Then fix the STRUCTURAL cost: shadow flags,
pass resolution, rebuild frequency, pooling, budget caps. Do NOT fix it by making
effects smaller or less pretty -- the fx and viewmodel agents own appearance.

TARGET: combat >= 55fps with no visible reduction in effect quality, page errors
still zero, draws <= 900, tris <= 3.5M.`,
  },
  {
    key: 'postfx',
    label: 'postfx',
    files: 'src/render/PostFX.js and src/render/post/**',
    views: 'combat,viewmodel-hip,hero-golden,material-closeup,vertical',
    brief: `DEFECT 1 (CRITICAL) -- residual specular aliasing / fireflies. The dark weapon
receiver in round5/combat.png still shows dense sparkling coloured pixels. The
viewmodel and material agents are fixing the source (roughness regularisation);
you own the second half of the fix.
  a) Verify TAA is genuinely accumulating: jitter applied to the projection
     matrix with a Halton(2,3) sequence, history reprojected using motion
     vectors, and a variance/neighbourhood clip on the history sample. If history
     is being rejected every frame the temporal pass does nothing, which would
     explain why the speckle survives. Instrument it if necessary.
  b) Add a firefly clamp before bloom: limit any single pixel's luminance to a
     multiple (about 4x) of its 3x3 neighbourhood maximum. This removes isolated
     hot pixels without dimming genuine highlights, and it is the standard fix
     for exactly this artefact.
  c) Confirm mip bias is set to about -0.5 so TAA does not soften textures.
Verify by reading combat.png and viewmodel-hip.png after the change. The speckle
must be gone.

DEFECT 2 (CRITICAL) -- ambient occlusion has been raised in two prior reviews and
has never been confirmed as landing. Settle it definitively: add a debug flag
that outputs the AO buffer alone (e.g. ?aodebug=1), shoot material-closeup with
it, and READ that image. If the buffer is empty or near-white, your AO is not
producing occlusion and the inputs (depth, normals, projection) are wrong. If it
is correct but invisible in the final frame, the composite is wrong -- AO must
multiply the DIFFUSE AMBIENT/IBL term only, never direct sun. Then shoot
material-closeup normally and confirm crates, barriers and column bases show
clear contact darkening where they meet the ground.

DEFECT 3 (major) -- verify DoF is fully OFF at hipfire and engages only in ADS as
a mild near-field effect. In round5/hero-golden check no near foreground is
blurred while the midground is sharp.

DEFECT 4 (major) -- combat runs at 28fps. Measure your chain's contribution:
disable each pass in turn, shoot combat, record fps, and report the table. Move
anything that can be half-res to half-res, and skip passes that should not run
(motion blur on a static camera, DoF at hipfire).

DEFECT 5 (major) -- edge AA on thin geometry. Check the catwalk lattice and
handrails in vertical.png and combat.png for stair-stepping and sub-pixel
dropout.`,
  },
  {
    key: 'props',
    label: 'props-contact',
    files: 'src/world/Props.js and src/world/props/**',
    views: 'combat,hero-golden,material-closeup,interior',
    brief: `DEFECT 1 (major) -- FLOATING PROPS PERSIST. This was raised last round and did not
land. In ${ROOT}/tools/out/shots/round5/combat.png there is a rust-coloured metal
plate hanging in mid-air in the upper-right quadrant with no support, no contact
and no shadow, plus further angled plates near the right-hand structures that
appear unsupported.
Implement a SYSTEMATIC guarantee rather than another spot fix:
  - After all placement completes, iterate every loose prop you own. Raycast
    downward from the prop's bounding-box centre against ctx.require('level').
  - If a hit is found within a sane distance, reseat the prop so its lowest point
    sits 1-2cm below the hit point.
  - If NO hit is found, or the hit is further than ~3m below, the prop is
    floating: either delete it or attach it to the wall/structure it was meant to
    hang on.
  - console.info a summary: how many props were checked, how many reseated, how
    many deleted. That count is your proof the pass ran.
Then shoot combat and hero-golden and confirm with your own eyes that nothing
floats. If a floating plate turns out to belong to fx impact debris rather than
Props, say so explicitly in your report and leave it alone.

DEFECT 2 (major) -- sandbag colour and material. The rebuilt sandbag walls in
combat.png read much better in FORM -- individual bags, visible stacking. But
they are a uniform pale olive/tan with almost no value variation between bags, so
the wall reads as one moulded object. Give each bag a per-instance albedo
variation (hue and value jitter of about +/-8%), dust accumulation on upward
faces, darker staining at the bottom of the stack where damp collects, and a few
bags with a distinctly different fill colour. Request the hessian material from
ctx.require('forge') by name if it exists.

DEFECT 3 (major) -- ground incident. Large expanses of the courtyard floor in
combat.png are still a pale, uniform, near-featureless slab, which is where the
eye notices flatness most. Within your own files add ground-level dressing:
gravel drifts collecting against kerbs and wall bases, wind-blown papers, dried
puddle stains, tyre marks, small concrete rubble, cable runs crossing the floor,
oil stains near machinery. Use instancing -- you have roughly 75 draw calls of
headroom and triangles are near the ceiling, so favour flat decal-like geometry
over volume.`,
  },
]

const CRITIQUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['overallScore', 'verdict', 'headline', 'perShot', 'findings', 'resolutionAudit', 'strongestAspect', 'singleBiggestGap'],
  properties: {
    overallScore: { type: 'number' },
    verdict: { enum: ['AAA', 'CLOSE', 'NOT_AAA'] },
    headline: { type: 'string' },
    strongestAspect: { type: 'string', description: 'The one thing that genuinely does hold up against AAA.' },
    singleBiggestGap: { type: 'string', description: 'If only one more thing could be fixed, what would move the score most?' },
    resolutionAudit: { type: 'string', description: 'Per previously-raised defect: did it visibly land? Be blunt about ones that did not.' },
    perShot: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['view', 'score', 'worstProblem'],
        properties: { view: { type: 'string' }, score: { type: 'number' }, worstProblem: { type: 'string' } },
      },
    },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['system', 'severity', 'problem', 'fix'],
        properties: {
          system: { enum: ['forge', 'sky', 'lighting', 'postfx', 'level', 'props', 'viewmodel', 'player', 'combat', 'fx', 'ai', 'ux', 'stabilize'] },
          severity: { enum: ['critical', 'major', 'minor'] },
          problem: { type: 'string' },
          fix: { type: 'string' },
        },
      },
    },
  },
}

// ---------------------------------------------------------------------------
phase('Fix')
log(`Round 6: ${AGENTS.length} targeted agents — ADS optic regression, cast shadows, specular aliasing, combat perf, floating props`)

await parallel(
  AGENTS.map((a) => () =>
    agent(`${PREAMBLE}

YOUR OWNED FILES: ${a.files}
YOUR SCREENSHOT TAG: ${a.key}6
MOST RELEVANT VIEWS: ${a.views}

=== YOUR TASK ===
${a.brief}

${REPORT}`, { label: a.label, phase: 'Fix' })
  )
)

// ---------------------------------------------------------------------------
phase('Integrate')

const integration = await agent(`You are the integration engineer for BLACKSITE at ${ROOT}. Five agents just made
targeted fixes in parallel. Make the build clean and photograph it.

Read ${ROOT}/CONTRACT.md first. A Vite dev server with hot reload is already
running on http://127.0.0.1:5180 -- do not start another.

You may edit any file to fix integration breakage, but make the SMALLEST change
that achieves a clean, good-looking build. Do not rewrite another agent's system.

Steps:
1. cd "${ROOT}" && node --check every file under src/. Fix syntax errors.
2. node tools/shoot.mjs --tag round6
   Read tools/out/shots/round6/report.json. HARD REQUIREMENTS:
     - errors array EMPTY
     - all 12 views produced a PNG
     - fps >= 55 on EVERY view INCLUDING combat
     - draw calls <= 900 and triangles <= 3.5M on every view
   Diagnose and fix any failure, then re-shoot until all four hold.
3. Read every PNG. Fix what is BROKEN rather than imperfect: black frames,
   missing geometry, inverted normals, z-fighting, systems that failed to init,
   effects or enemies that vanished.
4. Verify these seams specifically:
   - ADS (?ads=1) now shows a continuous world through the optic with a small
     bright dot -- NOT a giant box with an inset window. This was the round's
     top-priority regression; confirm it visually in round6/viewmodel-ads.png.
   - Cast shadows are visible on the courtyard floor in hero-golden.
   - level.raycast + addCollider still work (player, ballistics, AI, prop
     grounding all depend on them).
   - ?hud=0, ?vm=0, ?ads=1, ?fire=1, ?tod= all still work.
   - 'player:teleport' still honoured.
5. Final: node tools/shoot.mjs --tag round6, confirm clean, and report the
   per-view fps/draws/tris table.

Report what was broken, each root cause, final numbers, and your honest view.`, { label: 'integrate:round6', phase: 'Integrate' })

// ---------------------------------------------------------------------------
phase('Critique')

const critique = await agent(`You are a principal rendering artist doing a hostile visual review. You have
shipped AAA first-person shooters. You are reviewing a Three.js FPS whose stated
target is modern Call of Duty visual quality.

Read every PNG in ${ROOT}/tools/out/shots/round6/ with the Read tool -- actually
look at each image -- and read ${ROOT}/tools/out/shots/round6/report.json.
The previous state is in ${ROOT}/tools/out/shots/round5/ for comparison.

Review history: 9/100, then 32/100. Since then the whole gameplay layer was built
and three rounds of visual fixes were applied.

YOUR STANCE: default to rejection. You are explicitly FORBIDDEN from grading on a
curve for "it's impressive for a browser" -- that framing is banned. The only
question is whether the image would survive being placed next to a screenshot
from a current Call of Duty campaign level. If a reviewer would spot the
browser-game one in under a second, that is NOT_AAA.

Anchors: 40 = obvious hobby project. 60 = competent indie. 75 = strong stylised
game, still clearly not AAA. 85 = genuinely mistakable for a AAA frame at a
glance. 95 = indistinguishable.

Audit each of these explicitly in resolutionAudit. Award NO credit for code
changes that did not visibly land in the image:
- ADS optic rendering as a giant floating box with an inset picture-in-picture
  window (a severe regression introduced last round)
- near-total absence of cast shadows on the ground at golden hour
- residual specular aliasing: sparkling coloured speckle on the dark weapon
  receiver and magazine
- combat view at 28fps while all other views hold 60fps
- floating props: a rust-coloured plate suspended in mid-air upper-right
- ambient occlusion, raised in two prior reviews and never confirmed as landing
- sandbag walls reading as one uniform moulded mass rather than individual bags
- large uniform featureless expanses of courtyard floor

Also assess, looking closely: do the enemy combatants read as believable humans
(proportions, weapon grip, kit intersection, foot contact, any T-pose or default
rotation)? Does the HUD look designed or like debug output? Say plainly if a view
does not let you judge something.

Then identify whatever is NOW the weakest thing in the frame, and in
singleBiggestGap name the one fix that would move the score most.

Route every finding to its owning system: forge, sky, lighting, postfx, level,
props, viewmodel, player, combat, fx, ai, ux, stabilize. The 'fix' field must be
a concrete technical instruction, not "make it better". Any page error is a
critical finding.`, {
  label: 'critic:round6',
  phase: 'Critique',
  schema: CRITIQUE_SCHEMA,
})

log(`Round 6: score ${critique?.overallScore ?? '?'} / ${critique?.verdict ?? '?'} -- ${critique?.headline ?? ''}`)

return {
  score: critique?.overallScore,
  verdict: critique?.verdict,
  headline: critique?.headline,
  strongestAspect: critique?.strongestAspect,
  singleBiggestGap: critique?.singleBiggestGap,
  resolutionAudit: critique?.resolutionAudit,
  perShot: critique?.perShot,
  findings: critique?.findings,
  integration,
}
