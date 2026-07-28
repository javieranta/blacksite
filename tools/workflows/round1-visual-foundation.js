export const meta = {
  name: 'blacksite-visual-foundation',
  description: 'Build BLACKSITE renderer + world to AAA quality, then refine under a harsh visual critic loop',
  phases: [
    { title: 'Foundation', detail: 'six parallel agents: materials, sky, lighting, postfx, level, props' },
    { title: 'Integrate', detail: 'boot the app, kill every error, capture all canonical views' },
    { title: 'Critique', detail: 'harsh AAA critic grades every screenshot and routes fixes' },
    { title: 'Refine', detail: 'owners apply critic findings to their own files' },
    { title: 'Re-verify', detail: 're-shoot and re-grade' },
  ],
}

const ROOT = 'C:/Users/javie/Claude Code Projects/blacksite'

const PREAMBLE = `You are building BLACKSITE, a first-person shooter in Three.js whose explicit
target is the visual quality of a modern Call of Duty title. The project lives at
${ROOT}.

FIRST ACTION, MANDATORY: read ${ROOT}/CONTRACT.md in full, then read
${ROOT}/src/core/Constants.js and ${ROOT}/src/core/Engine.js. The contract is
binding. Several agents are working in this repo simultaneously.

THE ONE RULE: you edit ONLY the files listed in YOUR OWNED FILES below. You may
create new files inside a subfolder you own. You must not edit any other file --
not main.js, not Engine.js, not another system's module. If you need a seam that
does not exist, build it on your own side and say so in your report.

Installed and available (already in node_modules, import them freely):
  three@0.180, postprocessing@6.36 (pmndrs), n8ao@1.9, three-mesh-bvh@0.9

HARD CONSTRAINTS:
- ZERO external assets. No downloaded textures, models, fonts or audio. Every
  texture must be generated in code (canvas 2D, procedural noise, or a
  render-to-target shader bake). This is non-negotiable.
- No allocation in update()/fixedUpdate() hot paths. Pool and reuse.
- Budget for the hero view: <=900 draw calls, <=3.5M triangles, 60fps at 1080p.
- Zero console errors.
- Keep any single file under ~700 lines; split into a subfolder you own.

HOW TO VERIFY (a dev server with hot reload is ALREADY RUNNING on
http://127.0.0.1:5180 -- do NOT start another one, and do NOT run 'npm run dev'):
  cd "${ROOT}"
  node --check <each file you wrote>          # syntax
  node tools/shoot.mjs --views hero-golden,material-closeup --tag <your-tag> 
Then READ the resulting PNGs in tools/out/shots/<your-tag>/ with the Read tool
and look at them with your own eyes. Iterate until your contribution genuinely
looks good. Do not report done on unexamined output.

IMPORTANT: because other agents are editing this repo at the same time, a
screenshot may fail or look wrong because of a file YOU DO NOT OWN. If you see an
error from someone else's module, do not fix it -- note it in your report and
judge only your own contribution. If the shoot fails entirely, wait ~30s and
retry once; if it still fails, fall back to node --check and report the blocker.

Write real, complete, production-grade code. No placeholder comments like
"// TODO: implement lighting". If you leave a stub, you have failed the task.`

const REPORT = `Return a compact report: what you built, the key techniques used, the
numbers you measured (fps / draw calls / triangles), which screenshots you looked
at and what you thought of them honestly, anything you could not do, and any
seam you need from another system.`

const BUILDERS = [
  {
    key: 'forge',
    label: 'materials',
    files: 'src/render/MaterialForge.js and any new files under src/render/textures/',
    brief: `Build the procedural PBR material library. This is the single biggest lever on
whether the game reads as AAA, because every surface in frame comes from you.

The frozen material name set that other agents already call -- you MUST keep all
of these working, and may add more:
  concrete, concrete_wet, metal_painted, metal_rusted, wood_plank, dirt, sand,
  glass, fabric, plaster, asphalt

For each material generate a full texture set at 1024 or 2048: albedo with real
tonal variation and stains, a proper tangent-space normal map derived from a
height field (compute it via Sobel on the height, do not fake it), roughness that
varies spatially (wear on edges, polish where hands touch, damp patches), AO, and
a height map for parallax where it earns it.

Techniques that matter here: layered value/fBm/ridged noise; Worley noise for
aggregate and cracking; directed streaking for water staining and rust runoff;
edge-wear masks driven by a curvature proxy; and correct sRGB vs linear colour
space handling (albedo is sRGB, normal/roughness/AO are linear -- getting this
wrong is the most common reason procedural PBR looks like plastic).

Also give surfaces proper texel density: expose a repeat/scale per material so a
concrete wall does not look like it is wearing a bedsheet. Use triplanar mapping
or a shader-injected detail layer if it prevents visible tiling.

Add a small API for consumers: forge.get(name), forge.get(name, {repeat}),
forge.surfaceOf(material). Keep materials shared/cached so draw calls stay low.

Judge yourself with the 'material-closeup' and 'hero-overcast' views -- overcast
flat light is where weak albedo and missing AO are impossible to hide.`,
  },
  {
    key: 'sky',
    label: 'sky-atmosphere',
    files: 'src/render/Sky.js and any new files under src/render/sky/',
    brief: `Build the sky and atmosphere. You own the single largest object in every frame.

Deliver: physically-motivated atmospheric scattering (Rayleigh + Mie) on a sky
dome or fullscreen pass, driven by the sun elevation/azimuth/turbidity already in
Constants.TIME_OF_DAY; a sun disc with limb darkening and correct angular size;
believable horizon haze that thickens with distance; a volumetric-looking cloud
layer (raymarched or well-crafted procedural noise on a dome -- your call, but it
must have depth and silhouette, not look like a painted texture); a star field
plus moon for the night preset; and aerial perspective so distant geometry
desaturates and shifts toward the sky colour.

Critically: you must export sunDirection, sunColour and an environment map
(ambientSH -- a PMREM-processed render of your own sky) because Lighting reads
those for IBL. Regenerate the env map when the time of day changes, but do it
cheaply -- do not rebuild PMREM every frame.

Replace the FogExp2 placeholder with something better: height-based fog whose
colour is sampled from your sky in the view direction, so fog and sky always
agree. Mismatched fog and sky colour is the number one thing that makes a WebGL
scene look amateur.

All seven presets (dawn, morning, midday, golden, dusk, night, overcast) must
look deliberately art-directed and clearly distinct. Verify with hero-golden,
hero-midday, hero-dusk, hero-overcast and night.`,
  },
  {
    key: 'lighting',
    label: 'lighting',
    files: 'src/render/Lighting.js and any new files under src/render/lighting/',
    brief: `Build the lighting rig. Shadow quality is where browser 3D usually betrays
itself, so this is where you earn the AAA claim.

Deliver: cascaded shadow maps -- 4 cascades over Constants.RENDER.shadowDistance,
each fitted stably to the view frustum. Stabilise the cascade texel snapping
(round the light-space origin to texel increments) or you will get shimmering
shadow edges as the camera moves, which instantly reads as cheap. Tune bias and
normalBias per cascade; peter-panning and acne are both unacceptable.

Soften the shadows: implement a PCSS-style or Poisson-disc filtered lookup with a
penumbra that widens with distance from the occluder. Hard-edged shadows at
midday and unfiltered noise at dusk are both failures.

Deliver IBL: take the environment map from ctx.require('sky').ambientSH and drive
scene.environment from it so metals and roughness actually respond to the sky.
Replace the flat HemisphereLight with something that respects sky vs ground
radiance.

Deliver volumetric light: raymarched god rays / light shafts in the sun
direction, with shadow-map sampling so the shafts are actually occluded by
geometry, plus a blue-noise dither and temporal jitter to hide banding. Sample
count from Constants.RENDER.volumetricSteps so quality presets can scale it.

Keep the existing flash(position, colour, intensity, decay) API working -- weapons
and explosions call it -- and make it good: pooled lights, no per-call allocation,
correct inverse-square falloff.

Verify with hero-midday (harsh shadows), interior (light shafts through
openings), silhouette-dusk (rim light) and night.`,
  },
  {
    key: 'postfx',
    label: 'postfx',
    files: 'src/render/PostFX.js and any new files under src/render/post/',
    brief: `Build the post-processing stack. You own the frame: your render() must return
true and you are responsible for compositing the world scene AND the viewmodel
scene (ctx.viewScene with ctx.viewCamera, which must be drawn over the world with
a cleared depth buffer so the weapon never intersects walls).

Use the pmndrs 'postprocessing' package for the composer and n8ao for ambient
occlusion. Deliver, in a sane order:
  - GTAO via n8ao, using Constants.RENDER.aoIntensity/aoRadius. AO is the single
    highest-value effect for grounding geometry -- tune it until contact shadows
    read clearly without haloing.
  - Bloom with threshold + smoothing from Constants (do NOT let it wash the frame;
    modern AAA bloom is subtle and mostly visible on speculars and the sun).
  - Depth of field that engages on ADS (read ctx.get('weapons')?.state.adsProgress
    if present, guard for undefined) -- shallow focus on the weapon, background
    softened. Off or near-off when hipfiring.
  - Motion blur (camera velocity based is acceptable; per-object velocity buffer
    if you can manage it).
  - SMAA, plus temporal antialiasing if you can make it stable. Aliasing on
    hard geometry edges is one of the loudest amateur tells -- fix it properly.
  - Film grain, subtle chromatic aberration at the frame edges only, vignette,
    lens dirt on bright speculars, and a filmic colour grade (LUT or a tonemap
    curve) that gives the image a deliberate look rather than a neutral one.

Implement shake(amount, duration) with Perlin-based, frequency-decaying trauma
(not random jitter -- random reads as a bug) and hurt(intensity) as a red-edge
pulse. Wire the 'render:quality' event so presets scale your stack.

Every effect must be individually toggleable and each must have a defensible
intensity. Over-graded is as bad as ungraded. Verify on hero-golden,
hero-overcast (grading must not turn flat light muddy) and night (grain and noise
floor).`,
  },
  {
    key: 'level',
    label: 'level',
    files: 'src/world/Level.js and any new files under src/world/level/',
    brief: `Build the actual playable arena. Right now it is 24 boxes in a circle. Replace it
with a real, art-directed FPS map.

Design brief: a compact multi-storey blacksite compound -- think a decommissioned
industrial research facility. Roughly 90x90 metres. It needs a strong readable
layout: a central contested courtyard with hard cover, two flanking interior
routes, one elevated position reachable by stairs or catwalk, and at least one
enclosed interior space with window and door openings that let light shafts in
(the lighting agent needs those openings to show off volumetrics -- give them
generous, deliberate ones).

Build it from a modular kit you author procedurally: wall segments with correct
thickness and trim, floor slabs, pillars, stairs with real risers, catwalks with
railings, door frames, window frames, roof sections, kerbs and ramps. Use real
architectural proportions -- 3m floor heights, 2.1m door openings, 1.1m railings.
Nothing in frame may read as a stretched cube: every surface needs a bevel, a
trim, a panel break or a material change.

Composition matters as much as layout. Give the player framed sightlines and a
focal silhouette to look at from the spawn (the hero-golden view is shot from
6,1.7,14 looking at yaw 200 -- make THAT shot beautiful, with foreground,
midground and background layers and something interesting on the skyline).

Materials come from ctx.require('forge') -- use the frozen name list in
CONTRACT.md. Pass sensible UV scales so texel density is consistent.

CONTRACT you must honour: every solid mesh goes through this.addCollider(mesh);
keep this.colliders as the single collision source; accelerate
this.raycast(origin, dir, maxDist) with three-mesh-bvh (build BVHs on your
geometry and use acceleratedRaycast) because Ballistics calls it on every shot;
populate this.spawnPoints and this.enemySpawns sensibly; keep this.bounds
accurate. Merge static geometry aggressively to stay inside the 900 draw call
budget.

Verify with hero-golden, hero-midday, interior and vertical.`,
  },
  {
    key: 'props',
    label: 'props',
    files: 'src/world/Props.js and any new files under src/world/props/',
    brief: `Build the set dressing. An empty architectural shell reads as a greybox no matter
how good the lighting is; you are what makes it look inhabited and expensive.

Author procedural prop generators -- each should take a seed and produce
believable variation, not clones. Deliver at minimum: shipping crates and cases
with latches and stencilled markings, oil drums (some dented, some rusted),
sandbag walls, concrete jersey barriers, chain-link fence sections with sag,
scaffolding, pipe runs with flanges and brackets along walls and ceilings,
hanging cables and conduit, HVAC units, pallets, tarpaulins, floor debris and
rubble, warning signage and stencilled wall text, wall-mounted lamps and
floodlights, and a couple of derelict vehicles.

Rules that separate AAA dressing from asset-store clutter:
- Asymmetry and wear. Nothing perfectly aligned, nothing pristine. Rotate things
  a few degrees, dent them, scatter them off-grid.
- Contact. Props must sit ON surfaces with no floating and no intersection.
  Raycast down against ctx.require('level') to place them.
- Purposeful clustering. Real spaces have dense zones and empty zones; uniform
  scatter looks procedural in the bad way.
- Silhouette. Every prop needs to read as itself from 30m.
- Anything appearing more than 8 times MUST be an InstancedMesh -- register it in
  this.instanced. Draw call budget is 900 for the whole frame and Level already
  spends some.

Solid props go through ctx.require('level').addCollider(mesh) so the player and
bullets collide with them. Purely decorative dressing (cables, signage, small
debris) can go straight on ctx.scene.

Materials from ctx.require('forge'). Verify with hero-golden, interior and
material-closeup, and specifically check that nothing floats or interpenetrates.`,
  },
]

const CRITIQUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['overallScore', 'verdict', 'headline', 'perShot', 'findings'],
  properties: {
    overallScore: { type: 'number', description: '0-100 where 85+ means it genuinely stands next to a modern AAA FPS screenshot' },
    verdict: { enum: ['AAA', 'CLOSE', 'NOT_AAA'] },
    headline: { type: 'string', description: 'One brutally honest sentence on where this actually stands.' },
    perShot: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['view', 'score', 'worstProblem'],
        properties: {
          view: { type: 'string' },
          score: { type: 'number' },
          worstProblem: { type: 'string' },
        },
      },
    },
    findings: {
      type: 'array',
      description: 'Specific, actionable defects routed to the owning system.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['system', 'severity', 'problem', 'fix'],
        properties: {
          system: { enum: ['forge', 'sky', 'lighting', 'postfx', 'level', 'props'] },
          severity: { enum: ['critical', 'major', 'minor'] },
          problem: { type: 'string' },
          fix: { type: 'string', description: 'Concrete technical instruction the owning agent can act on.' },
        },
      },
    },
  },
}

const CRITIC_PROMPT = (tag) => `You are a principal rendering artist doing a hostile visual review. You have
shipped AAA first-person shooters. You are reviewing screenshots from a Three.js
FPS whose stated target is modern Call of Duty visual quality.

Read every PNG in ${ROOT}/tools/out/shots/${tag}/ with the Read tool -- actually
look at each image -- and read ${ROOT}/tools/out/shots/${tag}/report.json for
performance numbers and page errors.

YOUR STANCE: default to rejection. You are explicitly forbidden from grading on a
curve for "it's impressive for a browser" -- that framing is banned. The only
question is whether the image would survive being placed next to a screenshot
from a current Call of Duty campaign level. If a reviewer would spot the
browser-game one in under a second, that is NOT_AAA.

Score honestly and harshly. Anchors: 40 = obvious hobby project. 60 = competent
indie. 75 = strong stylised game, still clearly not AAA. 85 = genuinely
mistakable for a AAA frame at a glance. 95 = indistinguishable.

Look specifically for the tells that give away non-AAA real-time rendering:
- Untextured or flatly-textured surfaces; visible texture tiling; wrong texel
  density (texture scale inconsistent between adjacent surfaces).
- Missing or wrong ambient occlusion -- objects that do not feel like they are
  touching the ground.
- Shadow problems: hard unfiltered edges, acne, peter-panning, shimmer, or
  cascade seams. Shadowless objects.
- Flat ambient light with no directionality; no bounce; black crushed shadows
  with no fill.
- Aliasing on geometry edges. Specular aliasing / fireflies.
- Fog colour that disagrees with the sky. No aerial perspective, so everything
  sits at the same apparent depth.
- Bloom that washes the frame, or grading that is either absent or overcooked.
- Geometry that reads as primitives: unbevelled boxes, stretched cubes,
  perfectly repeated props, everything axis-aligned.
- Empty, uncomposed framing with no foreground/midground/background layering.
- Floating or interpenetrating props.
- Anything that looks like a placeholder.

For every defect, write a finding routed to the system that owns it:
  forge = materials/textures, sky = sky/atmosphere/fog, lighting = sun/shadows/
  IBL/volumetrics, postfx = AO/AA/bloom/DoF/grade, level = architecture/layout/
  composition, props = set dressing.
The 'fix' field must be a concrete technical instruction, not "make it better".

Also flag any page errors in report.json as critical findings against the owning
system.`

// ---------------------------------------------------------------------------
phase('Foundation')
log(`Fanning out ${BUILDERS.length} builders across the renderer and world`)

const built = await parallel(
  BUILDERS.map((b) => () =>
    agent(`${PREAMBLE}

YOUR OWNED FILES: ${b.files}
YOUR SCREENSHOT TAG: ${b.key}

=== YOUR TASK ===
${b.brief}

${REPORT}`, { label: b.label, phase: 'Foundation' })
  )
)

log('Builders done; integrating')

// ---------------------------------------------------------------------------
phase('Integrate')

const INTEGRATE = `You are the integration engineer for BLACKSITE at ${ROOT}. Six agents just
rebuilt the renderer and world in parallel against the contract in
${ROOT}/CONTRACT.md. Your job is to make the whole thing actually run, cleanly,
and then photograph it.

You OWN every file in the repo for the purpose of fixing integration breakage,
but you must make the SMALLEST changes that achieve a clean, good-looking build.
Do not rewrite another agent's system because you would have done it differently
-- only fix what is broken, mis-wired, or violating the contract.

A dev server with hot reload is already running on http://127.0.0.1:5180. Do not
start another.

Do this:
1. cd "${ROOT}" && node --check on every file under src/. Fix syntax errors.
2. Run: node tools/shoot.mjs --tag round1
   Read tools/out/shots/round1/report.json. If there are page errors, or views
   failed, or fps is under 45, or draw calls exceed 900 -- diagnose and fix, then
   re-shoot. Repeat until report.json has an empty errors array and every one of
   the 12 views produced a PNG.
3. Look at each PNG with the Read tool. Fix anything that is obviously broken as
   opposed to merely imperfect: black frames, missing geometry, inverted normals,
   NaN transforms, z-fighting, a sky that does not match the fog, an effect that
   is clearly misconfigured, or systems that silently did not initialise.
4. Check the integration seams specifically: does Lighting actually receive
   sky.ambientSH? Does PostFX composite ctx.viewScene over the world? Do Props
   actually register colliders with Level? Does Level.raycast still work (fire a
   test ray via the browser console or a node harness)? Is the camera still
   placeable via URL params -- the whole screenshot rig depends on it.
5. Final: node tools/shoot.mjs --tag round1 and confirm clean.

Report: what was broken and how you fixed it, the final performance numbers, and
your own honest assessment of how the frames look.`

const integration1 = await agent(INTEGRATE, { label: 'integrate:round1', phase: 'Integrate' })

// ---------------------------------------------------------------------------
phase('Critique')

let critique = await agent(CRITIC_PROMPT('round1'), {
  label: 'critic:round1',
  phase: 'Critique',
  schema: CRITIQUE_SCHEMA,
})

log(`Round 1: score ${critique?.overallScore ?? '?'} / verdict ${critique?.verdict ?? '?'} -- ${critique?.headline ?? ''}`)

// ---------------------------------------------------------------------------
// Refinement round: route findings back to whoever owns the file.
const rounds = []
rounds.push({ round: 1, score: critique?.overallScore, verdict: critique?.verdict, headline: critique?.headline })

if (critique && critique.verdict !== 'AAA') {
  phase('Refine')

  const bySystem = new Map()
  for (const f of critique.findings ?? []) {
    if (!bySystem.has(f.system)) bySystem.set(f.system, [])
    bySystem.get(f.system).push(f)
  }
  // Prioritise the systems carrying the most severe defects.
  const weight = { critical: 100, major: 10, minor: 1 }
  const ranked = [...bySystem.entries()]
    .map(([system, fs]) => ({ system, fs, w: fs.reduce((a, f) => a + (weight[f.severity] ?? 1), 0) }))
    .sort((a, b) => b.w - a.w)
    .slice(0, 4)

  log(`Routing fixes to: ${ranked.map((r) => `${r.system}(${r.fs.length})`).join(', ')}`)

  const byKey = Object.fromEntries(BUILDERS.map((b) => [b.key, b]))

  await parallel(
    ranked.map((r) => () => {
      const b = byKey[r.system]
      const list = r.fs
        .map((f, i) => `${i + 1}. [${f.severity.toUpperCase()}] ${f.problem}\n   FIX: ${f.fix}`)
        .join('\n')
      return agent(`${PREAMBLE}

YOUR OWNED FILES: ${b.files}
YOUR SCREENSHOT TAG: ${b.key}-fix

=== CONTEXT ===
You already built this system once. A hostile principal-artist review of the
rendered frames scored the result ${critique.overallScore}/100 (verdict:
${critique.verdict}) and said: "${critique.headline}"

The reviewer's screenshots are in ${ROOT}/tools/out/shots/round1/ -- READ THEM
FIRST so you can see the defects with your own eyes before changing anything.

=== DEFECTS ROUTED TO YOU ===
${list}

=== YOUR TASK ===
Fix every one of these defects properly -- root cause, not symptom suppression.
Where a fix trades against performance, keep 60fps at 1080p and say what you
traded. You may also fix anything else in your own files that you can now see is
weak; the goal is that the next review cannot make the same criticisms.

Original brief, still binding:
${b.brief}

${REPORT} Explicitly state, defect by defect, what you changed.`, { label: `fix:${r.system}`, phase: 'Refine' })
    })
  )

  // -------------------------------------------------------------------------
  phase('Re-verify')

  await agent(INTEGRATE.replace(/round1/g, 'round2'), { label: 'integrate:round2', phase: 'Re-verify' })

  const critique2 = await agent(`${CRITIC_PROMPT('round2')}

This is the SECOND review pass. The previous pass scored ${critique.overallScore}/100
and said: "${critique.headline}". Its findings were supposed to be fixed.

Additionally: for each finding you raised before, state whether it is actually
resolved. Do not award credit for changes that did not land in the image. If the
score has not moved, say so bluntly.`, {
    label: 'critic:round2',
    phase: 'Re-verify',
    schema: CRITIQUE_SCHEMA,
  })

  if (critique2) {
    critique = critique2
    rounds.push({ round: 2, score: critique2.overallScore, verdict: critique2.verdict, headline: critique2.headline })
    log(`Round 2: score ${critique2.overallScore} / verdict ${critique2.verdict} -- ${critique2.headline}`)
  }
}

return {
  rounds,
  finalScore: critique?.overallScore,
  finalVerdict: critique?.verdict,
  headline: critique?.headline,
  perShot: critique?.perShot,
  openFindings: critique?.findings,
  shots: `${ROOT}/tools/out/shots/`,
}
