export const meta = {
  name: 'blacksite-round5',
  description: 'Stabilise (NaN + perf regression) and fix the remaining visual defects, then re-grade',
  phases: [
    { title: 'Fix', detail: 'stabilise correctness + 8 targeted visual fixes' },
    { title: 'Integrate', detail: 'clean build, all 12 views, perf inside budget' },
    { title: 'Critique', detail: 'hostile AAA re-grade with resolution audit' },
  ],
}

const ROOT = 'C:/Users/javie/Claude Code Projects/blacksite'

const PREAMBLE = `You are building BLACKSITE, a first-person shooter in Three.js targeting the
visual quality of a modern Call of Duty title. Project root: ${ROOT}.

FIRST ACTIONS, MANDATORY:
1. Read ${ROOT}/CONTRACT.md in full. It is binding.
2. Read the CURRENT content of every file you own before changing it. This
   codebase is mature -- 131 modules, all previously built by other agents. You
   are making targeted fixes to real working code, NOT starting over. Do not
   rewrite a system wholesale; find the actual cause and fix that.
3. Look at ${ROOT}/tools/out/shots/r5probe/ (hero-golden, viewmodel-ads, combat)
   with the Read tool. That is exactly what the game looks like right now.

THE ONE RULE: edit ONLY the files listed in YOUR OWNED FILES. Other agents work
in this repo simultaneously. If you need a seam that does not exist, build it on
your side and report it.

Available: three@0.180, postprocessing@6.36, n8ao@1.9, three-mesh-bvh@0.9.

CONSTRAINTS: zero external assets (everything procedural in code); no allocation
in update()/fixedUpdate(); zero console errors; files under ~700 lines.

CURRENT MEASURED STATE (1920x1080, cinematic preset):
  hero-golden    60fps  750 draws  2.86M tris
  viewmodel-ads  59fps  723 draws  2.79M tris
  combat         24fps  801 draws  3.15M tris   <-- REGRESSION
  9 page errors, all "computeBoundingSphere(): Computed radius is NaN"
Budget ceiling: 900 draws, 3.5M tris, 60fps. The combat view is the problem case.

HOW TO VERIFY (a Vite dev server with hot reload is ALREADY RUNNING on
http://127.0.0.1:5180 -- do NOT start another, do NOT run 'npm run dev'):
  cd "${ROOT}"
  node --check <each file you wrote>
  node tools/shoot.mjs --views <your views> --tag <your-tag>
Then READ the PNGs in tools/out/shots/<your-tag>/ and judge with your own eyes.
Never report done on output you have not looked at. Check the shoot's stderr for
page errors -- if you introduce one, you have broken the build.

Others are editing concurrently: a failure may come from a file you do not own.
Note it, do not fix it, judge only your own work.

No placeholders. No "// TODO".`

const REPORT = `Report: what you changed and why, the root cause you found (not just the
symptom), measured numbers before and after, which screenshots you examined and
your honest opinion, and defect-by-defect what you did.`

const AGENTS = [
  {
    key: 'stabilize',
    label: 'stabilise',
    files: 'You may edit ANY file, but ONLY to fix the two correctness defects below. Make the minimum change. Do not make aesthetic changes and do not refactor.',
    views: 'combat,hero-golden,viewmodel-ads',
    brief: `You are the correctness agent. Two hard defects, both of which every other agent
is currently working around. Fix them and nothing else.

DEFECT 1 (critical) -- NaN geometry. Every captured frame logs three instances of:
  "THREE.BufferGeometry.computeBoundingSphere(): Computed radius is NaN.
   The position attribute is likely to have NaN values."
Three geometries per frame are being fed NaN vertex positions. Because it recurs
every frame it is almost certainly a per-frame-rebuilt geometry: a particle
system writing a position buffer, a tracer/beam mesh built from a zero-length
direction, a decal projector on a degenerate surface, a ragdoll/verlet solver
diverging, or a normalise() on a zero vector. Prime suspects are the systems
built most recently: src/fx/Particles.js, src/fx/Impacts.js, src/ai/** and
src/weapons/ballistics/**.
Find the ACTUAL source. Instrument if you need to: patch
computeBoundingSphere temporarily, or scan suspect position buffers for NaN and
log which geometry name is dirty. Then fix the root cause -- guard the divide,
clamp the normalise, skip degenerate geometry -- and verify the errors are gone
from the shoot output. Do not silence the warning; fix the data.

DEFECT 2 (critical) -- performance regression. The 'combat' view runs at 24fps
while every other view holds 59-60fps. Same level, same materials; the delta is
that combat forces a firing pose, so it is the FX/AI/combat path that costs
~25ms. Draw calls are only 801 and triangles 3.15M, both inside budget, so this
is not a submission-count problem -- it is likely fill rate or shader cost:
  - a huge overdrawing additive particle (the muzzle flash in the screenshot is an
    enormous blown-out ball covering a large fraction of the frame -- overlapping
    additive quads at full screen coverage are a classic fill-rate sink),
  - soft-particle depth fetches per fragment,
  - a full-resolution particle pass that should be half-res,
  - a shadow-casting light added per muzzle flash forcing extra shadow renders,
  - or a per-frame BVH rebuild on the AI/ballistics side.
Profile it: bisect by disabling suspects one at a time and re-shooting the combat
view. Report which system owned the cost. Fix it so combat holds >=55fps. If the
right fix is aesthetic (a smaller flash), do NOT make that change yourself --
report it and let the fx/viewmodel agents own it; instead fix the structural cost
(resolution, blend path, shadow flag, rebuild frequency).`,
  },
  {
    key: 'viewmodel',
    label: 'viewmodel-art',
    files: 'src/weapons/ViewModel.js and src/weapons/viewmodel/**',
    views: 'viewmodel-hip,viewmodel-ads,combat',
    brief: `The weapon is now genuinely textured and modelled -- a real improvement over the
greybox. Three defects remain, and the first is the single most visible artefact
in the entire game right now.

DEFECT 1 (critical) -- SPECULAR ALIASING. Look at
${ROOT}/tools/out/shots/r5probe/combat.png. The receiver, handguard and the flat
panel at bottom-right of the weapon are covered in a dense sparkling
salt-and-pepper speckle of bright pixels. It reads as digital noise / broken
material, and it is the loudest amateur tell in the frame -- worse than the old
greybox, because it looks like a bug rather than an unfinished asset.
Cause: high-frequency normal-map detail combined with low roughness. Each pixel
covers many normal-map texels with wildly varying directions, so the specular
lobe aliases. Fixes, apply together:
  - Roughness regularisation / specular antialiasing: derive a per-mip roughness
    floor from the normal-map variance (Toksvig or LEAN-style). Concretely: when
    generating the weapon's normal-map mip chain, measure the average normal
    length per mip and raise the roughness map in that mip proportionally. This
    is THE correct fix and it is what shipped engines do.
  - Raise the base roughness floor on the metal zones. Roughness below ~0.25 on a
    detailed normal map will always sparkle at 1080p. Phosphate steel should be
    0.35-0.5, not near-mirror.
  - Reduce the amplitude of the high-frequency normal detail, or move it to a
    lower mip so it fades with distance.
  - Ensure the normal map has proper mipmaps with trilinear filtering and
    anisotropy set; an unmipped or nearest-filtered normal map guarantees this.
Verify by reading viewmodel-hip and viewmodel-ads after each change. The speckle
must be completely gone -- not reduced, gone.

DEFECT 2 (major) -- screen footprint and silhouette. The weapon occupies far too
much of the frame: in combat.png the receiver spans roughly the lower-right
quadrant and the flat rear panel is a large featureless slab. In a AAA shooter the
hipfire weapon reads as a diagonal in the lower-right ~25% of frame, foreshortened,
with the stock mostly out of view. Pull the weapon back and down, reduce its
apparent scale, and make sure the large flat surfaces facing the camera get panel
breaks, a sling mount, or geometry relief so nothing reads as an untextured slab.
Keep the computed ADS-alignment approach (it works -- the reticle is on-axis).

DEFECT 3 (major) -- muzzle flash scale. Your flash cards are producing an enormous
blown-out white sphere that occludes a large part of the scene and washes out the
frame. A rifle flash should be a compact, brief, star-shaped bloom roughly the
size of a fist at the muzzle, bright enough to clip in HDR but SMALL. Reduce the
card size substantially, shorten the life to 2 frames, and keep the high linear
intensity so it still blooms. The fx agent owns the smoke and casings; you own
the flash cards on the weapon. Coordinate by staying on your own side.`,
  },
  {
    key: 'fx',
    label: 'fx-particles-impacts',
    files: 'src/fx/Particles.js, src/fx/Impacts.js, src/fx/**',
    views: 'combat,material-closeup',
    brief: `The FX system is working -- casings eject, sparks appear, impacts register. Fix
what is wrong with it.

DEFECT 1 (critical, shared with the stabilise agent) -- fill rate. The combat view
runs at 24fps. Large overlapping additive particles at high screen coverage are
the most likely cause. Actions:
  - Render the particle pass at half resolution and upsample, if it is currently
    full-res. Smoke and dust do not need full res.
  - Cap the maximum screen-space size of any single additive particle.
  - Make sure soft-particle depth sampling reads a downsampled depth buffer, not
    full-res per fragment.
  - Ensure additive particles do not write depth and are properly sorted/batched
    into a single draw call per effect type.
Measure combat fps before and after and report the numbers.

DEFECT 2 (major) -- muzzle event composition. The discharge currently reads as one
huge white ball. A convincing rifle discharge is layered and mostly SMALL:
  - a compact bright core (owned by the viewmodel agent),
  - a brief expanding smoke puff, warm-lit near the muzzle then cooling to grey,
    drifting up and back over ~0.6s,
  - 2-4 unburnt-powder sparks thrown forward with motion stretch,
  - the ejected casing tumbling with a spin (already working -- keep it),
  - a faint heat-shimmer distortion for ~0.1s if you can do it cheaply.
Build the smoke, sparks and shimmer. Do NOT make the flash bigger.

DEFECT 3 (major) -- floating debris. In combat.png a rusted metal plate hangs in
mid-air right of centre with no support or contact, and a dark plate sits at an
impossible angle near the flash. If those are yours (impact debris or spawned
particles that came to rest), give them a proper settle: raycast to the ground,
rest them on the surface, and fade them out after a lifetime rather than freezing
them mid-flight. If they belong to Props, note it and do not touch it.

DEFECT 4 (major) -- impact decals. Verify with material-closeup that decals
actually conform to the surface they hit and do not hover or z-fight. Confirm the
per-surface responses are visibly different (sparks on metal, dust on concrete,
splinters on wood, cracks on glass) by shooting each and looking.`,
  },
  {
    key: 'forge',
    label: 'materials',
    files: 'src/render/MaterialForge.js and src/render/material/**',
    views: 'material-closeup,hero-overcast,hero-golden',
    brief: `The material library is dramatically better -- concrete now has panel joints,
crates have stencilled markings, texel density reads consistently. Refine it.

DEFECT 1 (critical) -- specular aliasing is not only on the weapon. Check the
metal handrails, the catwalk lattice and the pipework in hero-golden and
combat.png for the same sparkling speckle. Apply roughness regularisation
globally in your texture bake: when you generate a normal map's mip chain,
measure per-mip average normal length and raise that mip's roughness accordingly
(Toksvig / LEAN mapping). Set a hard roughness floor of ~0.22 on any material
carrying high-frequency normal detail. Ensure every generated texture has a
proper mip chain, trilinear filtering, and anisotropy >= 4 -- a missing mip chain
on a normal or roughness map causes exactly this artefact.

DEFECT 2 (major) -- fabric. The sandbags in combat.png read as smooth yellow
segmented sausages with a plastic sheen. A hessian sandbag is matte
(roughness ~0.88), has a visible coarse woven weave in the normal map at roughly
2-3mm thread pitch, dusty desaturated albedo with blotchy staining, and no
specular highlight to speak of. Build a proper hessian material with a real woven
normal (two perpendicular sine/square thread bands with over-under alternation,
not noise) and dust accumulation on upward faces. The props agent owns the bag
MESHES; you own the material.

DEFECT 3 (major) -- verify glass. In combat.png the right-hand building windows
read as a flat pale blue sheet. Give glass real behaviour: transmission with
roughness 0.05-0.15, IOR 1.5, a box-projected environment reflection so it
reflects the sky and nearby geometry, a grime/limescale mask affecting both
albedo tint and roughness, and per-pane state variation (clean / filthy /
cracked / missing) so the grid is not uniform.

DEFECT 4 (minor) -- distant surfaces. Check hero-overcast: confirm concrete at
40m+ still has readable detail rather than going flat grey, and that the UV scale
per asset class is genuinely different so a tower and a barrier do not sample the
same frequency.`,
  },
  {
    key: 'props',
    label: 'props',
    files: 'src/world/Props.js and src/world/props/**',
    views: 'combat,hero-golden,interior,material-closeup',
    brief: `Set dressing is now good -- stencilled crates, cable runs, barrels, debris,
signage all read well. Fix what remains.

DEFECT 1 (major) -- sandbag meshes. In combat.png the sandbag wall at lower-left
reads as a row of smooth uniform yellow sausages: each bag is an identical
capsule, evenly spaced, same orientation, no sag, no compression where they
stack. Rebuild: 3 distinct bag meshes with flattened contact faces so stacked bags
visibly compress into each other, per-bag random yaw and +/-8% scale, slight
sag deformation on bags at the top of a stack, and assemble them into 2-3
prebuilt wall modules rather than a uniform row. The forge agent is building a
hessian material for you -- request it by name and use it.

DEFECT 2 (major) -- floating props. Audit EVERY loose prop for ground contact.
In combat.png there is a rusted plate hanging in mid-air right of centre and a
dark angled plate near the muzzle flash. Implement this as a systematic guarantee,
not a spot fix: after placement, raycast down from each prop's origin against
ctx.require('level'), reseat to the hit point with a 1-2cm sink, and assert. Any
prop whose downward ray misses entirely must be removed or reparented to the
surface it is meant to hang on. Log a count of reseated props so the fix is
verifiable. (If either plate belongs to fx impact debris rather than you, note it
and leave it.)

DEFECT 3 (major) -- the background. The far right of combat.png shows a flat white
perimeter fence and a featureless horizon that kills the sense of place. Add
mid-distance and far silhouette interest: transmission pylons, distant tank farms,
a water tower, chimneys with haze, a treeline -- as cheap instanced or billboard
silhouettes that read against the sky. This is the difference between a map and a
place. Coordinate with the level agent by staying in your own files.

DEFECT 4 (minor) -- clutter density. The large open ground in the mid-frame of
combat.png is still fairly bare. Add tertiary clutter in gameplay-safe zones:
gravel drifts against kerbs, wind-blown papers, cable coils, small concrete
chunks, tyre marks. Use instancing; you have ~100 draw calls of headroom at most,
so batch aggressively.`,
  },
  {
    key: 'lighting',
    label: 'lighting',
    files: 'src/render/Lighting.js and src/render/lighting/**',
    views: 'hero-midday,hero-dusk,interior,night,combat',
    brief: `Lighting has improved substantially -- the sun reads directionally, the muzzle
flash lights the scene, practicals are visible. Verify and finish the items the
last review raised, because they were never re-graded.

TASK 1 (critical) -- shadow crispness. The previous review said sun shadows read
as "amorphous grey clouds with no recognisable relationship to the caster
silhouette". Shoot hero-midday and look: does the overhead pipework cast a
RECOGNISABLE pipe-shaped shadow on the ground? If not, the near-cascade PCSS
kernel is too wide or the cascade fit is too loose. Use the existing debug hooks
(?csmdebug=1 cascade coverage, =2 single unfiltered tap, =9 stock PCF) to separate
a fitting problem from a filter problem. Target: cascade 0 filter radius ~1.5
texels so near shadows are crisp, widening per cascade; splits around 8/25/70/200m;
normal-offset bias ~1.2 texels; texel-snapped cascade origins so edges do not
shimmer when the camera moves.

TASK 2 (critical) -- night practicals. Shoot night and verify each lamp throws an
actual pool of light on the ground and brightens its own mounting surface. Real
punctual lights at 2700K with inverse-square falloff, radius ~8m, intensity tuned
so the mount reads 3-4x the far ground. Confirm no material stays fully saturated
and legible at midnight because it is emissive when it should not be.

TASK 3 (major) -- indirect. Shoot interior and verify: are there visible light
shafts through the window openings, a mullion pattern cast on the floor, and
bounce onto the wall opposite the windows? Surfaces facing away from the sun must
not collapse to one flat ambient value. If your irradiance/SH path is not
delivering, debug why. This is what makes the interior read as lit rather than
tinted.

TASK 4 (major) -- flash cost. The combat view runs at 24fps and one suspect is a
shadow-casting light spawned per muzzle flash forcing extra shadow-map renders
every shot. Check FlashPool: muzzle flashes should NOT cast shadows (or at most
one should, at low resolution). Fix if so and report the fps delta.

TASK 5 (major) -- dusk directionality. Shoot hero-dusk and confirm sunward faces
are warm while shadow-side faces are cool blue from sky fill, rather than every
vertical surface receiving the same salmon tint. Gate star visibility on sun
elevation so stars do not appear in a sky still bright enough to light the scene.`,
  },
  {
    key: 'postfx',
    label: 'postfx',
    files: 'src/render/PostFX.js and src/render/post/**',
    views: 'hero-golden,material-closeup,combat,vertical,interior',
    brief: `The post chain is producing a good image -- the sky, grade and bloom read well.
Finish the items that were raised but never re-graded, and fix the new ones.

TASK 1 (critical) -- specular antialiasing. The weapon and the metal railings show
dense sparkling speckle (see combat.png). The material agents are fixing the
source via roughness regularisation, but your temporal pass is the second half of
the fix: a correctly configured TAA with neighbourhood clamping removes residual
specular fireflies. Verify TAA is actually accumulating (jitter applied to the
projection matrix, history reprojected by motion vectors, variance clip on the
history sample). Also add a firefly clamp: limit any single pixel's luminance to
a multiple of its neighbourhood max before bloom, which kills isolated hot pixels
without dimming genuine speculars.

TASK 2 (critical) -- ambient occlusion. The previous review said "there is
effectively no ambient occlusion; nothing is bound to what it is touching".
Verify with a debug AO-only output. Requirements: world radius ~0.6m, intensity
~0.9, applied to the DIFFUSE AMBIENT term only and never to direct sun. Then look
at material-closeup and confirm crates, barriers and column bases show clear
contact darkening. If your AO pass is compositing after direct lighting or
receiving wrong depth/normal inputs, that produces exactly the "no visible AO"
result even when enabled.

TASK 3 (critical) -- bloom is blowing out. In combat.png the muzzle flash bloom
washes a large region of the frame to flat white and destroys all detail behind
it. Modern AAA bloom is tight and energy-conserving. Tighten the threshold, reduce
the intensity, and clamp the maximum bloom contribution so a very bright emitter
produces a compact glow with visible falloff rather than a white disc. The
viewmodel/fx agents are shrinking the flash itself; you must make bloom
well-behaved for ANY bright emitter.

TASK 4 (major) -- depth of field. Confirm DoF is fully OFF at hipfire and only
engages in ADS as a mild near-field effect (f/5.6 equivalent, far-blur CoC clamped
to ~2px, weapon layer excluded). In r5probe/hero-golden check that no near
foreground geometry is blurred while the midground is sharp.

TASK 5 (major) -- edge AA on thin geometry. Check the catwalk lattice and handrail
stanchions in vertical and combat for stair-stepping and sub-pixel dropout. Set
mip bias to -0.5 to recover sharpness under TAA.

TASK 6 (major) -- fill rate. Combat runs at 24fps. Confirm your chain is not the
cost: check whether DoF, motion blur and AO are running at full resolution when
they should be half, and whether any pass runs when it should be skipped (motion
blur on a static camera, DoF at hipfire). Report the fps delta of each pass you
disable.`,
  },
  {
    key: 'level',
    label: 'level',
    files: 'src/world/Level.js and src/world/level/**',
    views: 'hero-golden,hero-midday,interior,vertical,combat',
    brief: `The architecture is transformed -- chamfered concrete, real stairs, catwalks,
cooling towers, panel joints. Two composition problems remain.

DEFECT 1 (major) -- the horizon and perimeter. In combat.png the right side of
frame ends in a flat white perimeter wall and a featureless horizon; in
hero-overcast and vertical the background dissolves into flat white. The compound
needs to feel embedded in a larger world. Within your own files: raise and vary
the perimeter (concrete panels with pilasters, razor wire, guard towers, gaps that
show through to distance), and add far-field backdrop structures with real
silhouette -- gantries, flare stacks, tank farms, cranes -- placed to read against
the sky. Keep them cheap: low-poly, instanced, no shadow casting.

DEFECT 2 (major) -- ground-plane incident. Large areas of the courtyard floor are
uninterrupted flat slab. Break it up with things that also serve gameplay: a
drainage channel with a grated trench, a loading dock with a level change, rail
tracks embedded in the slab, kerbs and bollards defining routes, a shallow ramp,
painted hazard markings and lane lines, expansion joints, a puddle with a
distinct wet material. This gives the lower half of every frame something to look
at and gives the player readable navigation.

DEFECT 3 (major) -- three-layer depth on the hero framing. hero-golden shoots
from 6,1.7,14 at yaw 200. Compose THAT shot deliberately: a hard foreground
occluder in the near 2m at a frame edge to bracket the view (a broken barrier, a
hanging cable, a pipe run passing close to camera), a readable midground
silhouette at 15-25m that reads dark against the sky, and a background landmark.
Verify by shooting it and looking.

DEFECT 4 (major) -- interior. Shoot interior. The lighting agent needs generous
window and roof openings to produce visible light shafts and a mullion pattern on
the floor -- make sure they exist and are large enough. Add interior structure
worth lighting: mezzanine, gantry crane rail, machine foundations, pipework,
roof trusses.

Keep honouring the collision contract exactly: every solid mesh through
this.addCollider(mesh), BVH-accelerated this.raycast(), accurate spawnPoints /
enemySpawns / bounds. The player, AI and ballistics systems all depend on it now.
Draw-call budget: the frame is at 750-800 of 900, so keep your additions
instanced or merged and report your delta.`,
  },
  {
    key: 'ai',
    label: 'enemy-ai',
    files: 'src/ai/EnemyAI.js and src/ai/**',
    views: 'combat,hero-golden',
    brief: `Combatants now exist and appear in the combat screenshot -- a real milestone. But
they are small, distant and hard to assess, and they have never been reviewed.

TASK 1 (critical) -- prove they hold up close. Add a temporary view to your own
shoot invocation by placing the camera near a combatant (use ?pos=/?yaw= to frame
one at 3-5m) and READ that PNG. Judge honestly: do the proportions read as human?
Are the hands actually gripping the rifle, or floating near it? Is the helmet
seated on the head? Does the plate carrier intersect the torso? Are the feet flat
on the ground in the idle pose, or clipping/floating? Is there any T-pose or
default-rotation limb? Fix everything you find. A placeholder humanoid will be
graded as harshly as the greybox weapon was.

TASK 2 (critical) -- NaN. Three geometries per frame are receiving NaN vertex
positions and your ragdoll/verlet or procedural-animation path is a prime
suspect. Audit every normalise(), divide and sqrt in your animation and physics
code for a zero-length or negative input, and guard them. The stabilise agent is
hunting this too -- if you find it in your own files, fix it and say so.

TASK 3 (major) -- combat readability. In combat.png the enemies do not read as
threats: no visible muzzle flash from their weapons, no clear aiming pose, no
silhouette separation from the background. Give them: a rim/edge treatment or
value separation so they read against concrete, an unmistakable aiming stance
with the rifle shouldered and pointed at the player, and their own muzzle flashes
via ctx.get('lighting')?.flash() plus tracers via ctx.get('particles').

TASK 4 (major) -- behaviour verification. Confirm by testing, not by reading your
own code: do they path without stacking? Do they take cover and peek? Do they
actually damage the player? Are they registered with
ctx.require('ballistics').registerActor so the player can kill them, with head
2.1x / torso 1.0x / limb 0.75x multipliers, and do they emit 'actor:death'?

TASK 5 (major) -- cost. The combat view runs at 24fps and per-frame skinning,
per-frame BVH rebuilds for navigation, or per-enemy shadow-casting lights would
all contribute. Profile your system's cost and reduce it: cache navigation,
update animation at a fixed lower rate for distant enemies, and never rebuild a
BVH per frame. Report your measured cost in ms.

TASK 6 (minor) -- under ?freeze=1 they must render in an active combat pose, since
the combat view is meant to capture a firefight.`,
  },
]

const CRITIQUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['overallScore', 'verdict', 'headline', 'perShot', 'findings', 'resolutionAudit', 'strongestAspect'],
  properties: {
    overallScore: { type: 'number' },
    verdict: { enum: ['AAA', 'CLOSE', 'NOT_AAA'] },
    headline: { type: 'string' },
    strongestAspect: { type: 'string', description: 'The one thing that genuinely does hold up against AAA.' },
    resolutionAudit: { type: 'string', description: 'Per previously-raised defect: did it actually land in the image? Be blunt about ones that did not.' },
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
log(`Round 5: ${AGENTS.length} agents — 1 stabilisation + 8 targeted visual fixes`)

await parallel(
  AGENTS.map((a) => () =>
    agent(`${PREAMBLE}

YOUR OWNED FILES: ${a.files}
YOUR SCREENSHOT TAG: ${a.key}5
MOST RELEVANT VIEWS: ${a.views}

=== YOUR TASK ===
${a.brief}

${REPORT}`, { label: a.label, phase: 'Fix' })
  )
)

// ---------------------------------------------------------------------------
phase('Integrate')

const integration = await agent(`You are the integration engineer for BLACKSITE at ${ROOT}. Nine agents just made
targeted fixes in parallel. Make the build clean and photograph it.

Read ${ROOT}/CONTRACT.md first. A Vite dev server with hot reload is already
running on http://127.0.0.1:5180 -- do not start another.

You may edit any file to fix integration breakage, but make the SMALLEST changes
that achieve a clean, good-looking build. Do not rewrite another agent's system.

Steps:
1. cd "${ROOT}" && node --check every file under src/. Fix syntax errors.
2. node tools/shoot.mjs --tag round5
   Read tools/out/shots/round5/report.json. HARD REQUIREMENTS:
     - errors array EMPTY (the NaN geometry warnings must be gone)
     - all 12 views produced a PNG
     - fps >= 55 on EVERY view including combat
     - draw calls <= 900, triangles <= 3.5M on every view
   Diagnose and fix any failure, then re-shoot. Repeat until all four hold.
3. Read every PNG. Fix things that are BROKEN rather than merely imperfect:
   black frames, missing geometry, inverted normals, z-fighting, systems that
   silently failed to init, effects that vanished, enemies or particles absent.
4. Verify these seams, which multiple agents touched this round:
   - level.raycast + addCollider still work (player collision, ballistics, prop
     grounding and AI navigation all depend on them)
   - the viewmodel still composites over the world with cleared depth
   - ?hud=0, ?vm=0, ?ads=1, ?fire=1 and ?tod= all still work -- the whole rig
     depends on them
   - 'player:teleport' is still honoured
   - no system throws with no user gesture (headless audio)
5. Final: node tools/shoot.mjs --tag round5, confirm clean, and report the
   per-view fps/draws/tris table.

Report what was broken, the root cause of each fix, the final numbers, and your
honest assessment of the frames.`, { label: 'integrate:round5', phase: 'Integrate' })

// ---------------------------------------------------------------------------
phase('Critique')

const critique = await agent(`You are a principal rendering artist doing a hostile visual review. You have
shipped AAA first-person shooters. You are reviewing a Three.js FPS whose stated
target is modern Call of Duty visual quality.

Read every PNG in ${ROOT}/tools/out/shots/round5/ with the Read tool -- actually
look at each image -- and read ${ROOT}/tools/out/shots/round5/report.json.
The previous state is in ${ROOT}/tools/out/shots/r5probe/ for comparison.

Review history: this project scored 9/100, then 32/100. It has since had the
entire gameplay layer built and a round of targeted visual fixes.

YOUR STANCE: default to rejection. You are explicitly FORBIDDEN from grading on a
curve for "it's impressive for a browser" -- that framing is banned. The only
question is whether the image would survive being placed next to a screenshot
from a current Call of Duty campaign level. If a reviewer would spot the
browser-game one in under a second, that is NOT_AAA.

Anchors: 40 = obvious hobby project. 60 = competent indie. 75 = strong stylised
game, still clearly not AAA. 85 = genuinely mistakable for a AAA frame at a
glance. 95 = indistinguishable.

Defects raised previously that were supposed to be fixed this round -- audit each
one explicitly in resolutionAudit and do NOT award credit for code changes that
did not visibly land:
- specular aliasing: dense sparkling speckle on the weapon receiver/handguard and
  on metal railings
- muzzle flash: an enormous blown-out white ball that washed the frame and cost
  ~25ms of frame time
- weapon screen footprint: too large, with a big featureless slab facing camera
- ambient occlusion: nothing appeared bound to what it was touching
- shadows: amorphous grey blobs instead of recognisable caster silhouettes
- night: lamps that lit nothing; emissive materials legible at midnight
- indirect: no bounce, no light shafts or mullion pattern in the interior
- dusk: uniform salmon tint on every vertical face regardless of orientation
- sandbags: smooth uniform yellow sausages with a plastic sheen
- floating props: a rusted plate hanging in mid-air, a dark plate at an
  impossible angle
- background: flat white perimeter and featureless horizon
- ground plane: large uninterrupted flat slab with no incident
- performance: combat view at 24fps
- NaN geometry: 3 page errors per frame

Newly assess, since these have never been reviewed: whether the enemy combatants
read as believable humans or as placeholder shapes (look closely -- judge
proportions, grip, kit intersection, foot contact, any T-pose), and whether the
HUD looks designed or looks like debug output. Shoot or request nothing -- judge
from the provided PNGs, and say plainly if a view does not let you assess
something.

Then identify whatever is NOW the weakest thing in the frame. Route every finding
to its owning system: forge, sky, lighting, postfx, level, props, viewmodel,
player, combat, fx, ai, ux, stabilize. The 'fix' field must be a concrete
technical instruction, not "make it better". Any page error is a critical finding.`, {
  label: 'critic:round5',
  phase: 'Critique',
  schema: CRITIQUE_SCHEMA,
})

log(`Round 5: score ${critique?.overallScore ?? '?'} / ${critique?.verdict ?? '?'} -- ${critique?.headline ?? ''}`)

return {
  score: critique?.overallScore,
  verdict: critique?.verdict,
  headline: critique?.headline,
  strongestAspect: critique?.strongestAspect,
  resolutionAudit: critique?.resolutionAudit,
  perShot: critique?.perShot,
  findings: critique?.findings,
  integration,
}
