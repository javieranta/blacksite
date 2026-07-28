export const meta = {
  name: 'blacksite-round4',
  description: 'Fix every routed visual defect and build the full gameplay layer, then re-grade',
  phases: [
    { title: 'Build', detail: '12 agents: viewmodel art, materials, lighting, sky, postfx, level, props, player, combat, fx, ai, audio+hud' },
    { title: 'Integrate', detail: 'boot clean, verify seams, capture all views' },
    { title: 'Critique', detail: 'hostile AAA re-grade with resolution audit' },
  ],
}

const ROOT = 'C:/Users/javie/Claude Code Projects/blacksite'

const PREAMBLE = `You are building BLACKSITE, a first-person shooter in Three.js whose explicit
target is the visual and mechanical quality of a modern Call of Duty title. The
project is at ${ROOT}.

FIRST ACTIONS, MANDATORY:
1. Read ${ROOT}/CONTRACT.md in full. It is binding.
2. Read ${ROOT}/src/core/Constants.js and ${ROOT}/src/core/Engine.js.
3. Read the CURRENT state of every file you own before changing it. The codebase
   is already substantially built (64 modules) -- you are improving real code,
   not starting from scratch. Do not rewrite working systems wholesale.
4. Look at the current renders in ${ROOT}/tools/out/shots/round3/ with the Read
   tool. That is what the game looks like right now.

THE ONE RULE: you edit ONLY the files listed in YOUR OWNED FILES. You may create
new files in a subfolder you own. Other agents are working in this repo
simultaneously. If you need a seam that does not exist, build it on your own side
and report it.

Available in node_modules: three@0.180, postprocessing@6.36 (pmndrs), n8ao@1.9,
three-mesh-bvh@0.9.

HARD CONSTRAINTS:
- ZERO external assets. Every texture, mesh and sound generated in code.
- No allocation in update()/fixedUpdate() hot paths.
- Zero console errors.
- Keep any single file under ~700 lines.

PERFORMANCE HEADROOM -- READ THIS: the game currently renders in 1.8-2.9ms of a
16.6ms frame budget at 1080p (60fps, ~600 draw calls, ~2.8M tris). You have
roughly 13ms of unused GPU time. Do NOT make quality compromises "for
performance". Spend the budget. The ceiling is 900 draw calls and 3.5M triangles
and 60fps -- work up to it, not far below it.

HOW TO VERIFY (a Vite dev server with hot reload is ALREADY RUNNING on
http://127.0.0.1:5180 -- do NOT start another and do NOT run 'npm run dev'):
  cd "${ROOT}"
  node --check <each file you wrote>
  node tools/shoot.mjs --views <relevant views> --tag <your-tag>
Then READ the PNGs in tools/out/shots/<your-tag>/ and judge them with your own
eyes. Iterate until your contribution is genuinely good. Never report done on
output you have not looked at.

Because others are editing concurrently, a failure may come from a file you do
not own. Note it, do not fix it, judge only your own work. If a shoot fails,
wait 30s and retry once, then fall back to node --check.

No placeholders. No "// TODO". If you leave a stub you have failed.`

const REPORT = `Report: what you changed, the techniques used, measured numbers
(fps/draws/tris), which screenshots you examined and your honest opinion of them,
and -- defect by defect -- what you did about each routed finding.`

const AGENTS = [
  {
    key: 'viewmodel',
    label: 'viewmodel-art',
    files: 'src/weapons/ViewModel.js and src/weapons/viewmodel/** (create as many files here as you need)',
    views: 'viewmodel-hip,viewmodel-ads,combat',
    brief: `YOU ARE THE HIGHEST PRIORITY AGENT IN THIS ROUND. The first-person weapon is
20-25% of every gameplay pixel and the one asset a player stares at for an entire
session. Two review passes have both scored it as the worst thing in the game
(20/100 hipfire, 16/100 ADS). Look at
${ROOT}/tools/out/shots/round3/viewmodel-ads.png right now: the weapon is flat
untextured grey boxes, the top rail is a literal ladder of extruded cuboids, the
optic is a stack of plain cylinders, the reticle is a hard flat red disc, and the
"hands" are pale untextured blocks.

REVIEWER FINDING (critical, unresolved across two passes):
"The first-person weapon is still a raw greybox -- a flat matte grey/blue box
assembly with zero albedo, roughness, metalness or normal maps, no hands, no
arms, no gloves, no sling, no bevels, and no material breakup between polymer,
steel and optic housing. While it is untextured, no amount of environment work
can move the score above the 30s."
PRESCRIBED FIX: "Author the weapon as a proper PBR asset with distinct material
IDs for polymer lower (roughness 0.55-0.7, non-metal), phosphate steel upper
(metalness 1.0, roughness 0.35 with anisotropic-leaning highlight), anodised
optic body, and rubber eyecup. Add chamfers of 1-2mm on every hard edge and bake
edge-wear into the roughness/albedo via curvature. Model and skin first-person
arms with gloves. Replace the flat red disc reticle with an additive reticle quad
on a separate layer at ~2.0 intensity with a parallax-offset dot and a subtle
lens-tint mask on the objective."

Deliver, all generated procedurally in code:
- A believable modern carbine. Real mechanical parts with correct proportions:
  polymer lower receiver with magwell and trigger guard, phosphate-finish upper
  with ejection port and forward assist, free-float handguard with M-LOK slots
  (actual recessed slots, not painted-on), a proper Picatinny rail with correctly
  proportioned recoil grooves (NOT a stack of separate cuboids -- build one rail
  mesh with real cross-section geometry), adjustable stock with cheek weld,
  pistol grip with texture panels, 30-round polymer magazine with witness slots
  and floorplate, charging handle, sling mount, muzzle device.
- Chamfer EVERY hard edge 1-2mm. Unbevelled edges are the loudest greybox tell:
  a chamfer catches a specular highlight and instantly reads as manufactured.
- A full procedural PBR texture set per material zone: albedo with wear, normal
  from a height field, roughness that varies (polished where hands and slings rub,
  matte on polymer, rougher on worn edges), metalness masks, and AO. Drive
  edge-wear from a curvature proxy so wear appears where it physically would.
- A red-dot optic that actually works: tinted objective lens with a subtle blue
  anti-reflective coating gradient, a housing with knurled adjustment turrets,
  rubber eyecup, and an ADDITIVE emissive reticle rendered bright enough to
  survive tonemapping (PostFX composites in HDR -- an intensity capped at 1.0
  will be dimmer than the sunlit scene and vanish; you need well above 1.0).
  Give the dot a soft glow falloff and slight parallax offset, not a hard disc.
- Gloved first-person hands and forearms with actual finger geometry wrapping the
  grip and handguard. Tactical glove material: knuckle panels, stitching in the
  normal map, fabric roughness. Sleeve cuffs. They must not be blocks.
- Keep and improve the existing procedural animation (the ADS-alignment maths in
  the current file is correct -- the sight anchor drives the pose -- preserve
  that approach). Add: idle breathing sway, walk cycle, sprint low-carry, recoil
  kick with muzzle rise and settle, bolt cycling visible through the ejection
  port, magazine swap on reload, shell ejection.
- A muzzle flash that reads as the brightest thing in the frame: multiple
  additive cards at high linear intensity, randomised roll per shot, 2-3 frame
  life. Also call ctx.get('lighting')?.flash(...) so the weapon and nearby
  geometry are actually lit by the discharge.

Verify obsessively with viewmodel-hip and viewmodel-ads. Read those PNGs after
every significant change. The bar: it must look like a weapon from a AAA shooter,
not a blockout.`,
  },
  {
    key: 'forge',
    label: 'materials',
    files: 'src/render/MaterialForge.js and src/render/material/**',
    views: 'material-closeup,hero-overcast,hero-midday',
    brief: `Rebuild the material library. The reviewer's verdict is that one low-frequency
fBm is doing duty as every concrete surface in the game, and the ground is
polka dots.

ROUTED FINDINGS (all critical/major):
1. "Every concrete surface -- outer walls, cooling tower, chimney, columns,
   Jersey barriers, interior walls, ceiling slab -- shares one low-frequency
   cloudy fBm/Worley noise as its only detail, at roughly the same world scale on
   all of them, so the cooling tower is covered in blotches identical to the sky
   clouds behind it and the interior walls look like mould. No panel joints, no
   form-tie holes, no cold-joint seams, no aggregate at close range, no rebar
   staining, no water streaking driven by ledges."
   FIX: "Build a proper trim/tileable set: one 2048 precast-panel tileable
   (albedo + normal with 3-5mm chamfered panel joints + roughness with mineral
   variation), one poured-in-place tileable with form-tie recesses, and a
   separate high-frequency detail-normal blended at ~0.25 world-space tiling for
   close-range aggregate. Drive a grime layer by a top-down mask so horizontal
   ledges get dark streaks running down the wall beneath them. Vary UV scale per
   asset class so a 6m barrier and a 40m tower do not sample the same frequency."
2. "The ground material is a regularly-spaced orange polka-dot speckle over a
   dark base, with a visible square tile repeat every 2-3m, and a hard texel-
   density break between the dotted asphalt and the adjacent pale-blue mottled
   concrete apron with no transition -- adjacent floor surfaces look like two
   different games."
   FIX: "Delete the speckle. Build asphalt from a 2048 tileable with real
   aggregate at ~1m tiling, a normal map with pothole and crack relief, and
   roughness variation for wet/dry patches. Break the tile with a second UV set
   at a 7.3x prime-ratio scale multiplied at 0.3, plus a low-frequency macro
   variation mask at 30m scale. Normalise texel density across all floors."
3. "Metal has no directionality or believable specular response. The rusted pipe
   shows an obviously mirrored/repeated rust pattern with a broad uniform
   highlight; handrails are flat mid-grey with no gradient."
   FIX: "metalness 1.0 with roughness in the 0.25-0.45 band and anisotropy
   aligned to the tangent of the extrusion. Author rust as a mask-driven layer
   where roughness rises to 0.8 and metalness drops to 0.2, mask driven by an
   up-facing and crevice term."
4. "Window glass is a flat pale blue-white fill with a black mullion grid --
   no reflection, no transmission gradient, no dirt, no variation between panes,
   reading as a solid emissive plane."
   FIX: "Transmissive material, roughness 0.05-0.15, IOR 1.5, box-projected
   cubemap contribution, grime/limescale mask in both albedo-tint and roughness.
   Randomise a per-pane state mask: clean, filthy, cracked, missing."

The frozen material name set must keep working (concrete, concrete_wet,
metal_painted, metal_rusted, wood_plank, dirt, sand, glass, fabric, plaster,
asphalt) but you should ADD variants so different asset classes get different
concrete. Expose per-material UV scale so consumers can keep texel density
consistent, and make sure sRGB vs linear is correct per map type (albedo sRGB;
normal/roughness/AO/metalness linear) -- getting that wrong is the classic reason
procedural PBR looks like plastic.

Judge yourself on material-closeup (the showcase shot, currently 22/100) and
hero-overcast, where flat light hides nothing.`,
  },
  {
    key: 'lighting',
    label: 'lighting',
    files: 'src/render/Lighting.js and src/render/lighting/**',
    views: 'hero-midday,hero-dusk,interior,night',
    brief: `The shadow and indirect-light system is not delivering what its code claims.
The module already contains a CascadedShadowMap, a PCSS shader patch, an
EnvironmentBuilder and a VolumetricLight -- read them, find out why the RESULT in
the round3 screenshots does not match, and fix the actual behaviour. Debug before
you rewrite.

ROUTED FINDINGS:
1. CRITICAL "Sun shadows are extremely low-resolution and read as soft grey
   clouds rather than cast shadows. In hero-midday and hero-overcast the shadow
   of the overhead pipework and cooling tower lands as amorphous fuzzy blobs with
   no recognisable relationship to the caster silhouette."
   FIX: "4-cascade CSM at 2048 per cascade with splits at 8/25/70/200m, PCF 3x3
   with a 1.5-texel filter radius on the FIRST cascade only (tighten the filter
   per cascade so near shadows are crisp), normal-offset bias of 1.2 texels to
   kill acne without peter-panning, and stabilise cascade origins to texel
   increments."
   Note especially: an over-wide PCSS kernel on the near cascade is exactly what
   turns a crisp silhouette into a grey cloud. Verify a recognisable pipe shadow
   lands on the ground in hero-midday. Use ?csmdebug=1 / =2 / =9 (already wired)
   to separate a cascade-fitting problem from a filter problem.
2. CRITICAL "night.png has no functioning local lighting. The wall lamp emits a
   glow sprite but throws no light onto the column it is mounted to and no pool
   on the ground. The red sign stays fully saturated and legible at midnight."
   FIX: "Replace glow sprites with actual punctual lights: 2700K point lights,
   inverse-square falloff, radius ~8m, intensity tuned so the mounting surface
   reads 3-4x brighter than the far ground, each with a shadow-casting cubemap at
   512. Move the sign onto standard PBR so it goes dark."
3. MAJOR "There is no bounce or indirect light anywhere. Surfaces facing away
   from the sun fall to a single flat ambient value with no directionality and no
   colour transfer -- the underside of the elevated beam, the shaded faces of the
   barriers, and the whole interior receive one constant fill."
   FIX: "Bake irradiance volumes (0.5m probe spacing indoors, 4m outdoors) with
   2-bounce GI and sample per-object, or add SSGI at half res with a 3m trace
   radius. At minimum replace the constant ambient with SH-projected sky
   irradiance plus a ground-bounce term tinted by the ground albedo."
4. MAJOR "hero-dusk applies a uniform salmon tint to every vertical surface
   regardless of orientation -- left building faces, cooling tower, chimney and
   right-hand columns are all the same pink value even though they face different
   directions relative to the low sun. Stars are visible in a sky still bright
   enough to light the scene."
   FIX: "Drive dusk from the actual sun transform: elevation ~4 deg, colour
   ~2200K, intensity down ~85% from midday, with sky/IBL supplying cool blue fill
   from the anti-sun hemisphere -- that alone gives warm sunward faces and cold
   shadow-side faces. Gate star visibility on sun elevation."
5. The interior shot has "three walls of bright window and zero bounce: no light
   shafts, no mullion pattern on the floor, no indirect on the opposite wall."
   Make the volumetrics and the window-shaft pattern actually land indoors.

You have ~13ms of spare frame budget. Spend it on shadow resolution and indirect.`,
  },
  {
    key: 'sky',
    label: 'sky-atmosphere',
    files: 'src/render/Sky.js and src/render/sky/**',
    views: 'hero-golden,hero-dusk,silhouette-dusk,vertical,hero-overcast',
    brief: `The sky is currently a bare vertical gradient and there is no aerial perspective.
These are two of the loudest "this is not AAA" signals in the whole review.

ROUTED FINDINGS:
1. CRITICAL "The sky is a bare vertical gradient in every frame except overcast.
   hero-golden, hero-midday, hero-dusk and combat have no cloud layer, no sun
   disc, no forward-scattering brightening near the sun, and no horizon haze
   band. Where clouds do exist (overcast) they are the same low-frequency blotch
   noise used on the concrete."
   FIX: "Replace the gradient with a physical sky: Hosek-Wilkie or Preetham
   analytic sky driven by the sun vector, plus a raymarched or 2-layer scrolling
   cloud system (cumulus base at 1500m with 4-octave curl-advected noise, cirrus
   at 6000m) with a noise basis DISTINCT from any surface material. Render an
   actual sun disc with limb darkening."
2. CRITICAL "There is no aerial perspective. Distant geometry does not desaturate
   or lose contrast with range: in silhouette-dusk the far cooling towers are
   flat pure-white cardboard cutouts BRIGHTER than the sky behind them with no
   shading at all; in vertical and hero-overcast the background dissolves into
   flat featureless white."
   FIX: "Add height-fog plus exponential aerial perspective evaluated against the
   sky luminance IN THE VIEW DIRECTION, not a constant colour: extinction
   ~0.004/m, height falloff 0.0008, inscatter colour sampled from the sky LUT so
   fog and sky can never disagree. Add a Mie forward-scatter term so distances
   toward the sun glow."

The 'far cooling towers brighter than the sky' problem is worth special
attention -- that is a backdrop geometry/material issue interacting with your
atmosphere. Coordinate through your own side: if the backdrop needs fog applied,
make sure your aerial-perspective term reaches it (check whether those meshes are
in the fog path at all; a custom ShaderMaterial that does not include fog chunks
is a common cause).

You must keep publishing sunDirection, sunColour and a PMREM environment map --
Lighting depends on all three. All seven time-of-day presets must be distinct and
art-directed.`,
  },
  {
    key: 'postfx',
    label: 'postfx',
    files: 'src/render/PostFX.js and src/render/post/**',
    views: 'hero-golden,material-closeup,interior,vertical',
    brief: `The post chain contains an AOEffect, a TAAPass, a MotionBlurEffect and a
FinishEffect with a LUT grade -- but the reviewer says there is effectively no AO
in the image, the AA is failing on thin geometry, the DoF is actively wrong, and
the grade is a flat global tint. Read your existing code, find out why the result
does not match the intent, and fix the behaviour.

ROUTED FINDINGS:
1. CRITICAL "There is effectively no ambient occlusion. Nothing is bound to what
   it is touching: the yellow crates have no darkening at their base, the
   concrete barriers meet the ground with a clean bright seam, column-to-ground
   junctions show no contact darkening."
   FIX: "GTAO or half-res HBAO with world radius ~0.6m, intensity 0.9, and
   bent-normal output applied to the DIFFUSE AMBIENT TERM ONLY -- never to direct
   sun. Additionally consider projected contact-shadow AO under every crate,
   barrel, barrier and footing."
   Debug hint: an AO pass that writes into the lit colour after direct lighting,
   or one whose depth/normal inputs are wrong, produces exactly this 'no visible
   AO' result even when the pass is enabled. Verify with an AO-only debug view.
2. CRITICAL "Depth of field is on, heavy, and wrong for an FPS. In hero-golden
   the near concrete beam is blurred while the mid-ground is sharp and the far
   structures are blurred again; in material-closeup the nearest ground is
   blurred."
   FIX: "Disable gameplay DoF entirely for hip-fire. Restrict to ADS only, and
   then only as a mild near-field effect: focal distance locked to reticle depth,
   f-stop ~5.6, far-blur clamped to max CoC of 2px, weapon layer excluded."
3. MAJOR "Geometry edges are not properly anti-aliased. Thin metal is the
   giveaway: the catwalk lattice, handrail stanchions and rooftop pipe runs all
   show stair-stepping and sub-pixel dropout; the fine grating will shimmer in
   motion."
   FIX: "TAA with 8-sample Halton jitter, velocity-buffer reprojection, and
   neighbourhood-clamp history rejection, fed by a proper motion-vector pass. Set
   mip bias to -0.5 to recover texture sharpness under TAA."
4. MAJOR "The colour grade is a flat global tint per time-of-day rather than a
   tonemapped grade. hero-golden is a uniform orange multiply applied equally to
   sunlit AND shadowed pixels; night is a uniform blue. No shadow/midtone/
   highlight separation, no crosstalk."
   FIX: "Physical auto-exposure metering on log-average luminance with EV
   compensation per time-of-day, then ACES or AgX tonemapping, then a LUT grade
   with independent lift/gamma/gain -- cool shadows, neutral mids, warm
   highlights for golden. The tint must not touch shadows uniformly."

You own the frame composite. Keep the viewmodel pass compositing correctly over
the world with cleared depth. You have ~13ms spare -- spend it.`,
  },
  {
    key: 'level',
    label: 'level',
    files: 'src/world/Level.js and src/world/level/**',
    views: 'hero-golden,hero-midday,interior,vertical',
    brief: `The architecture reads as a kit of unbevelled axis-aligned boxes, and the hero
composition is flat and unlayered.

ROUTED FINDINGS:
1. MAJOR "The architecture is a kit of unbevelled axis-aligned boxes and
   untapered cylinders. Buildings are cuboids with one window strip cut in,
   columns are square prisms with no capital or base detail, the cooling tower is
   a lofted cylinder, Jersey barriers are extruded L-profiles with razor-sharp
   top edges."
   FIX: "Chamfer every exterior edge at 15-30mm and support the chamfer in the
   normal map so it catches a highlight -- this alone is the single largest
   readability win for concrete. Add structural logic: corbels and haunches where
   beams meet columns, a plinth at every column base, a drip edge on every
   parapet."
2. MAJOR "Composition is flat and unlayered. The four hero shots are near-
   identical wide views of a plaza with an enormous unbroken ground plane
   occupying the lower 45% of frame carrying almost no incident, no midground
   silhouette to lead the eye, and no strong foreground occluder."
   FIX: "Rework the blockout for three-layer depth: a hard foreground occluder in
   the near 2m at frame edge (broken barrier, hanging cable, pipe run) to bracket
   the shot, a readable midground silhouette at 15-25m that reads black against
   sky, and a background landmark. Break up the ground plane."

The hero-golden camera is at 6,1.7,14 looking yaw 200 -- make THAT specific shot
compose beautifully, and make sure the ground plane in the lower half of frame
has incident: kerbs, drainage channels, level changes, a ramp, rail tracks,
painted markings, a puddle.

Keep honouring the collision contract: every solid mesh through
this.addCollider(mesh), BVH-accelerated this.raycast(), accurate spawnPoints /
enemySpawns / bounds. The AI and player agents depend on all of it this round, so
do not break it. You have draw-call room: currently ~600 of 900.`,
  },
  {
    key: 'props',
    label: 'props',
    files: 'src/world/Props.js and src/world/props/**',
    views: 'hero-golden,interior,material-closeup,combat',
    brief: `Set dressing is repetitive, the sandbags are placeholder-grade, and things float.

ROUTED FINDINGS:
1. CRITICAL "The sandbag props are placeholder-grade and appear in three mutually
   inconsistent forms. In the hero shots they are three smooth dark ovoids that
   read as potatoes or river stones with a single specular highlight and no
   fabric weave. In material-closeup and combat they are white folded shapes that
   read as paper."
   FIX: "Rebuild sandbags as a single kit: 3 unique bag meshes (~600 tris each)
   with a hessian-weave normal map, cloth roughness 0.85, dusty albedo, and
   flattened contact faces so stacked bags interpenetrate believably. Assemble
   2-3 pre-built wall modules rather than instancing loose bags, and vary
   rotation/scale per bag."
2. MAJOR "combat.png has a car tyre suspended in mid-air ~1.5m off the ground
   with no support, no rope, no shadow and no contact. In vertical.png the rusted
   floor grate floats above the catwalk deck rather than seated in a recess."
   FIX: "Run a downward-raycast snap pass over every loose prop and reseat to the
   hit point with a 1-2cm sink. For the tyre, either delete it or lean it against
   the barrier with its contact edge intersecting geometry. Recess the grate 4cm
   into the deck."
   Make this a systematic guarantee, not a one-off fix: no prop may float, ever.
3. MAJOR "Set dressing is sparse and repetitive with no small-scale clutter.
   Identical Jersey barriers, identical yellow crates and identical concrete
   footings are instanced with zero variation in rotation, scale or wear. In
   interior a single plastic water bottle stands alone in the middle of a vast
   empty factory floor."
   FIX: "Build a tertiary clutter kit (gravel piles, broken concrete chunks,
   crushed cans, cable coils, papers, pallet fragments) and scatter 40-80
   instances per 100 sq m in gameplay-safe zones with randomised yaw and +/-10%
   scale. Add 3 albedo variants and a per-instance hue/roughness offset to the
   barrier and crate instancing."

Anything appearing more than 8 times must be an InstancedMesh. Solid props go
through ctx.require('level').addCollider(mesh). You have ~300 draw calls of
headroom -- use instancing and spend it.`,
  },
  {
    key: 'player',
    label: 'player-movement',
    files: 'src/player/PlayerController.js, src/player/CameraRig.js, and src/player/** subfolders you create',
    views: 'hero-golden,viewmodel-hip',
    brief: `Both of your files are still the original STUBS -- kinematic slide-on-a-plane
movement with a rigid camera. Build the real thing. This is the entire tactile
feel of the game, and it is currently absent.

PlayerController -- deliver:
- Real capsule-vs-world collision against ctx.require('level'). Use
  three-mesh-bvh against level.colliders: sweep the capsule, collect contacts,
  depenetrate along contact normals, iterate 3-4 times. It must never tunnel
  through geometry and never jitter against a wall or in a corner.
- Source-style acceleration: separate ground and air accel, ground friction with
  a stop-speed threshold, air control. The constants are already in
  Constants.PLAYER -- use them and tune them.
- Grounding via a proper ground check (short capsule cast, slope normal test
  against PLAYER.maxSlope), with coyote time and jump buffering.
- Step-up over obstacles below PLAYER.stepHeight without launching the camera.
- Slope handling: walk up walkable slopes, slide down steep ones, no bouncing.
- Crouch with a smooth height blend that refuses to stand up under a low ceiling.
- Slide: sprint+crouch gives a directional impulse with its own friction curve
  and a duration, transitioning cleanly back to crouch or stand.
- Mantle: detect a ledge below PLAYER.mantleMaxHeight ahead of the player and
  play a parabolic climb over PLAYER.mantleDuration with control locked out.
- Lean left/right with a collision check so you cannot lean through a wall.
- Health with regeneration after a delay; honour 'player:damage'.
- Keep the 'player:teleport' contract exactly as-is -- the entire screenshot rig
  depends on it.
- Footstep events on foot-plant (emit 'player:footstep' with the surface under
  the foot from a downward raycast) so audio can hook them.

CameraRig -- deliver a procedural camera that feels expensive:
- Head bob synced to the footstep cycle (position + subtle roll), amplitude by
  gait, driven off distance travelled not raw time so it stops when you stop.
- Weapon/camera sway: mouse-delta lag with a spring, so fast turns lead and
  settle rather than snapping.
- ADS FOV blend; sprint FOV widen; both eased, not linear.
- Recoil: keep addRecoil(pitch,yaw,roll) -- weapons call it -- with a fast kick
  and a slower spring-damped recovery that returns to the pre-fire aim point.
- Landing punch scaled by impact velocity; step shake.
- Trauma shake via addTrauma(a): Perlin/simplex noise sampled at a decaying
  frequency and amplitude. Random per-frame jitter reads as a bug -- do not.
- Lean roll. Slide camera drop and tilt.
- Keep ctx.viewCamera aligned with ctx.camera (the viewmodel depends on it) and
  keep the FOV relationship correct so the weapon does not swim.

None of it may be nauseating: bob and shake must be small, damped and purposeful.
Since the shoot rig runs with ?freeze=1, make sure a frozen frame still shows a
sane resting pose.`,
  },
  {
    key: 'combat',
    label: 'combat-ballistics',
    files: 'src/weapons/Ballistics.js, src/weapons/WeaponSystem.js, src/weapons/WeaponData.js',
    views: 'combat',
    brief: `Ballistics is a stub that fires one hitscan ray and emits a surface event.
WeaponSystem works but is shallow. Build real gunplay.

Ballistics -- deliver:
- BVH-accelerated raycasts against ctx.require('level'). Do not use the naive
  Raycaster path in the stub.
- Hitscan for fast rounds, but simulate travel time for slower ones (the SMG's
  400m/s muzzle velocity should be perceptibly slower than the rifle's 880) by
  stepping the projectile over frames with gravity drop and drag.
- Material penetration: on hit, consume energy according to
  Constants.SURFACES[surface].penetration and the weapon's penetration value; if
  energy remains, continue the ray from the exit point with reduced damage and
  emit a second impact on the far side. Wood and sand should be shootable
  through; metal and concrete mostly not.
- Ricochet at grazing angles on hard surfaces, with a deflected ray and a
  distinctive event so FX/audio can respond.
- Damage: apply the falloff curve (the static falloff() helper exists -- use it),
  headshot multipliers, and per-hitbox multipliers from registered actors.
- Register/query actors properly so ctx.require('ai') enemies can be hit; emit
  'hit:actor' with damage, headshot flag and the hitbox name, and drive kills.
- Tracers: emit an event with the full ray so FX can draw one, but only on a
  fraction of shots (every 3rd round, like real tracer loading).
- Suppression: emit a 'whizby' event when a round passes close to an actor.

WeaponSystem -- deliver:
- Fire modes that actually work: auto, 3-round burst with correct inter-burst
  timing, semi. Cycle with a key.
- A spread state machine: first-shot accuracy, bloom that grows per shot and
  decays, movement and airborne penalties, crouch bonus, hipfire vs ADS.
- Recoil driven by the learnable pattern in WeaponData (already generated
  deterministically -- keep that) with visual recovery to the original aim point.
- Weapon switching between the three defined weapons with timing, and reload
  that can be interrupted by switching or firing.
- Honour the 'weapon:force' event (the rig's ?ads=1 / ?fire=1) so screenshots can
  capture ADS and firing poses deterministically even under ?freeze=1.
- Emit 'shell:eject' with a real ejection velocity so FX can throw a casing.

Fire rate must be frame-rate independent (accumulate time, do not gate on a
per-frame boolean). Keep all existing emitted event shapes -- five other systems
listen to them.`,
  },
  {
    key: 'fx',
    label: 'fx-particles-impacts',
    files: 'src/fx/Particles.js, src/fx/Impacts.js, and src/fx/** subfolders you create',
    views: 'combat,material-closeup',
    brief: `Both files are STUBS -- Particles.spawn() is an empty function and Impacts does
nothing. Every combat visual in the game is missing. Build it.

Particles -- deliver a real GPU-instanced pooled particle system:
- Zero per-frame allocation. Pre-allocate instanced buffers, maintain a free
  list, recycle. Budget 20k live particles at 60fps.
- Per-particle: position, velocity, age, lifetime, size curve, colour-over-life
  ramp, rotation, drag, gravity scale, turbulence.
- Soft particles: fade against the depth buffer so smoke does not show a hard
  intersection line where it meets geometry. This one detail separates AAA smoke
  from billboard smoke.
- Motion-stretched sprites for sparks and debris (stretch the quad along
  velocity).
- Both additive (flash, sparks, embers) and alpha-blended (smoke, dust) paths.
- All sprite textures generated procedurally in code.
- These named effects must all exist and look good: 'muzzle', 'smoke_puff',
  'sparks', 'dust', 'debris', 'blood', 'shell', 'tracer', 'explosion', 'glass',
  'water_splash', 'ember'.

Impacts -- deliver:
- Listen to 'hit:surface', 'hit:actor', 'explosion' and translate each into the
  correct combination of decal + particles + light + audio cue, keyed off
  Constants.SURFACES.
- Projected decals that CONFORM to geometry -- build a decal mesh by clipping the
  target geometry against a projector box (three's DecalGeometry approach or your
  own), not a floating quad that visibly hovers and clips on curved surfaces.
- A decal budget with LRU fade-out so long firefights do not leak memory.
- Per-surface responses: bright sparks + metallic ping on metal; dust plume +
  pale crater on concrete; splinters + dark hole on wood; a dirt puff and deeper
  crater on sand/dirt; spiderweb crack decals and a shatter event on glass;
  blood mist and a wet decal on flesh.
- Explosion response: scorch decal, debris throw, dust ring, light flash.
- Call ctx.get('lighting')?.flash() for sparks and explosions so impacts light
  their surroundings.

ROUTED FINDING (major): "The muzzle flash in combat.png is a small dull yellow
blob that contributes no light to the weapon, the ground, or any nearby surface,
accompanied by no smoke, no shell ejection, no heat shimmer and no barrel bloom.
In a dusk-lit scene a rifle discharge should be the brightest thing in frame."
FIX: "Build the muzzle event as coupled elements: an additive flash card set (3
random variants, 2-frame life, intensity ~40 in LINEAR space so it survives
tonemapping), a transient point light at the muzzle (5500K, spiked for 30ms,
radius 6m) so the weapon and ground receive it, plus smoke, and an ejected
casing." Note the viewmodel agent owns the flash cards on the weapon itself --
you own the smoke, the casing, the sparks and the world-side response. Do not
edit their files.

Remember PostFX composites in HDR: a particle material capped at 1.0 will be
DIMMER than the sunlit scene and disappear after tonemapping. Bright emissive FX
need intensities well above 1.`,
  },
  {
    key: 'ai',
    label: 'enemy-ai',
    files: 'src/ai/EnemyAI.js and src/ai/** subfolders you create',
    views: 'combat,hero-golden',
    brief: `EnemyAI is a STUB -- there are no combatants in the game at all. The 'combat'
screenshot has no enemies in it. Build real opponents.

Deliver:
- Procedurally modelled humanoid combatants: a proper skeleton hierarchy with
  head, torso, pelvis, upper/lower arms, hands, thighs, calves, feet, plus
  tactical kit (helmet, plate carrier, pouches, boots, a carried rifle). Real
  human proportions, ~1.8m. Materials from ctx.require('forge') or your own
  procedural set. They must NOT be capsules or T-posing blocks -- a placeholder
  humanoid will be graded as harshly as the greybox weapon was.
- Procedural animation: an idle with weight shift and breathing, a walk and a run
  cycle with correct foot placement and no sliding, a crouch, a weapon-raise
  aim pose that actually points the rifle at the target, a reload, hit reactions
  that flinch the affected body part, and a death that collapses believably
  (a simple verlet ragdoll or a keyframed collapse blended per hit direction).
- Navigation over the level: build a navigation representation from
  ctx.require('level') (a walkable grid sampled by downward raycasts is fine)
  with A* pathing, string-pulling for smooth paths, and local avoidance so squad
  members do not stack.
- Combat behaviour worth the name: a perception model with FOV, line of sight and
  a reaction delay; cover selection scored by protection from the player's
  current position; peek-shoot-return cycles; suppression that pins them; squad
  coordination so one flanks while another suppresses; grenade use when the
  player is static behind cover; and audible barks via ctx.get('audio').
- They must shoot back: fire at the player through ctx.get('ballistics') or by
  emitting 'player:damage' with a direction, with muzzle flashes via
  ctx.get('lighting')?.flash() and tracers via ctx.get('particles').
- Register every combatant with ctx.require('ballistics').registerActor(mesh,
  { hitboxes, onDamage }) using real hitboxes (head 2.1x, torso 1.0x, limbs
  0.75x) so the player can kill them. Emit 'actor:death' on death.
- Spawn at ctx.require('level').enemySpawns. Expose this.enemies for the HUD.

Under ?freeze=1 (the screenshot rig) they must still render in a sane pose --
ideally an active combat pose, since the 'combat' view is meant to capture a
firefight.`,
  },
  {
    key: 'ux',
    label: 'audio-hud',
    files: 'src/audio/AudioEngine.js, src/ui/HUD.js, and src/audio/** + src/ui/** subfolders you create',
    views: 'combat',
    brief: `Both files are STUBS. AudioEngine.play() is empty; the HUD is a 3px white dot.

AudioEngine -- deliver a fully procedural WebAudio engine (no samples, all
synthesis):
- Layered gunshots. A convincing shot is 4 coupled layers: a transient crack
  (very short filtered noise burst with a fast exponential decay), a body
  (band-passed noise with a pitched component), a mechanical layer (the action
  cycling -- short metallic clicks), and a tail (a longer reverberant decay whose
  length depends on the environment). Per-weapon variation from WeaponData.
- Distance modelling: low-pass that opens/closes with distance, a delay
  proportional to distance/343, and a separate distant-report layer so far shots
  sound like cracks with a rolling tail rather than a quiet near shot.
- Convolution reverb with procedurally generated impulse responses, switched by
  zone (outdoor courtyard vs enclosed interior). Detect the zone from the
  player's surroundings or accept a zone event.
- HRTF/panner spatialisation for world sounds; a master limiter so a full-auto
  burst plus explosions never clips.
- All the named cues the rest of the build calls: 'fire_ar', 'fire_smg',
  'fire_dmr', 'reload_start', 'reload_end', 'impact_<surface>' for every surface
  in Constants.SURFACES, 'shell_drop', 'footstep_<surface>', 'hitmarker',
  'explosion', 'whizby', 'ads_in', 'ads_out', 'empty_click'.
- Subscribe to the combat events yourself ('weapon:fire', 'hit:surface',
  'hit:actor', 'weapon:reload', 'shell:eject', 'player:footstep',
  'explosion', 'actor:death') so no other system needs to know audio exists.
- Must not create the AudioContext before a user gesture (the existing
  'input:lock' arm hook is correct -- keep it) and must not throw under the
  headless screenshot rig where no gesture ever happens.

HUD -- deliver a designed interface, not debug text:
- A dynamic reticle that responds to the real spread value from
  ctx.get('weapons'): gaps widen with bloom, tighten crouched, bloom on each
  shot, collapse and fade in ADS-with-optic (the optic reticle takes over).
- Hitmarkers with a distinct headshot and kill variant.
- Directional damage indicators driven by 'player:damage'.
- Ammo readout with real typographic hierarchy (mag count large, reserve small,
  weapon name, fire mode), a low-ammo state, and a reload prompt.
- Health/armour state communicated primarily through screen effects rather than a
  bar where possible, plus a subtle numeric.
- A kill feed from 'actor:death'.
- A pause/settings menu with quality presets (emit 'render:quality'), sensitivity
  and volume.
- Honour 'hud:visible' -- the screenshot rig hides the HUD with ?hud=0 and every
  captured view depends on that working.

Style it to match the game: military-industrial, restrained, high contrast, thin
strokes, generous letter-spacing. No default browser fonts at default weights,
no bright primary colours, no rounded cartoon shapes.`,
  },
]

const CRITIQUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['overallScore', 'verdict', 'headline', 'perShot', 'findings', 'resolutionAudit'],
  properties: {
    overallScore: { type: 'number' },
    verdict: { enum: ['AAA', 'CLOSE', 'NOT_AAA'] },
    headline: { type: 'string' },
    resolutionAudit: {
      type: 'string',
      description: 'For each previously-raised finding, whether it actually landed in the image. Be blunt about ones that did not.',
    },
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
          system: { enum: ['forge', 'sky', 'lighting', 'postfx', 'level', 'props', 'viewmodel', 'player', 'combat', 'fx', 'ai', 'ux'] },
          severity: { enum: ['critical', 'major', 'minor'] },
          problem: { type: 'string' },
          fix: { type: 'string' },
        },
      },
    },
  },
}

// ---------------------------------------------------------------------------
phase('Build')
log(`Fanning out ${AGENTS.length} agents: 7 visual fixes + 5 gameplay systems`)

await parallel(
  AGENTS.map((a) => () =>
    agent(`${PREAMBLE}

YOUR OWNED FILES: ${a.files}
YOUR SCREENSHOT TAG: ${a.key}4
MOST RELEVANT VIEWS FOR YOU: ${a.views}

=== YOUR TASK ===
${a.brief}

${REPORT}`, { label: a.label, phase: 'Build' })
  )
)

// ---------------------------------------------------------------------------
phase('Integrate')

const integration = await agent(`You are the integration engineer for BLACKSITE at ${ROOT}. Twelve agents just
worked in parallel: seven fixing renderer/world defects and five building the
previously-stubbed gameplay layer (player movement, ballistics, particles/impacts,
enemy AI, audio/HUD). Make the whole thing run cleanly, then photograph it.

Read ${ROOT}/CONTRACT.md first.

You may edit ANY file to fix integration breakage, but make the SMALLEST changes
that achieve a clean, good-looking build. Do not rewrite another agent's system
because you would have designed it differently.

A Vite dev server with hot reload is already running on http://127.0.0.1:5180.
Do not start another.

Steps:
1. cd "${ROOT}" && node --check every file under src/. Fix syntax errors.
2. node tools/shoot.mjs --tag round4
   Read tools/out/shots/round4/report.json. Require: errors array EMPTY, all 12
   views produced a PNG, fps >= 55, draw calls <= 900, triangles <= 3.5M.
   Diagnose and fix anything that fails, then re-shoot. Repeat until clean.
3. Read every PNG. Fix things that are BROKEN as opposed to merely imperfect:
   black frames, missing geometry, inverted normals, NaN transforms, z-fighting,
   systems that silently failed to initialise, effects that are clearly
   misconfigured, particles or enemies that do not appear at all.
4. Verify the seams specifically, because this round wires many new ones:
   - Does the player actually collide with level geometry? (Test movement.)
   - Do enemies spawn, render in a sane pose, and are they registered with
     Ballistics so they can be shot?
   - Do particles appear on impact? Does the muzzle flash light the scene?
   - Does the HUD hide under ?hud=0 and the viewmodel under ?vm=0?
   - Do ?ads=1 and ?fire=1 produce a genuinely different captured pose?
   - Does the AudioEngine avoid throwing with no user gesture (headless)?
   - Is 'player:teleport' still honoured? The entire rig depends on it.
5. Final: node tools/shoot.mjs --tag round4 and confirm clean.

Report what was broken, how you fixed it, final numbers, and your honest view of
the frames.`, { label: 'integrate:round4', phase: 'Integrate' })

// ---------------------------------------------------------------------------
phase('Critique')

const critique = await agent(`You are a principal rendering artist doing a hostile visual review. You have
shipped AAA first-person shooters. You are reviewing a Three.js FPS whose stated
target is modern Call of Duty visual quality.

Read every PNG in ${ROOT}/tools/out/shots/round4/ with the Read tool -- actually
look at each image -- and read ${ROOT}/tools/out/shots/round4/report.json.

For comparison, the previous pass is in ${ROOT}/tools/out/shots/round3/. Two
earlier reviews scored this project 9/100 and then 32/100.

YOUR STANCE: default to rejection. You are explicitly forbidden from grading on a
curve for "it's impressive for a browser" -- that framing is banned. The only
question is whether the image would survive being placed next to a screenshot
from a current Call of Duty campaign level. If a reviewer would spot the
browser-game one in under a second, that is NOT_AAA.

Anchors: 40 = obvious hobby project. 60 = competent indie. 75 = strong stylised
game, still clearly not AAA. 85 = genuinely mistakable for a AAA frame at a
glance. 95 = indistinguishable.

The defects raised last pass, which were supposed to be fixed this round:
- viewmodel: untextured greybox weapon, ladder-of-cuboids rail, block hands,
  flat disc reticle
- forge: one fBm noise serving as all concrete; polka-dot ground with visible
  2-3m tile repeat; metals with no anisotropy or believable spec; flat glass
- lighting: shadows as amorphous grey clouds not cast silhouettes; night lamps
  that light nothing; no bounce/indirect anywhere; dusk as a uniform salmon tint
- sky: bare gradient with no clouds/sun disc/haze; no aerial perspective, distant
  towers brighter than the sky
- postfx: effectively no ambient occlusion, nothing grounded; heavy wrong DoF at
  hipfire; aliasing on thin metal; grade as a flat global tint
- level: unbevelled axis-aligned boxes; flat unlayered composition
- props: potato sandbags; a floating car tyre; sparse repetitive dressing
- fx: muzzle flash a dull blob lighting nothing, no smoke/casings

In resolutionAudit, go through each of those and say plainly whether it actually
landed in the image. Do not award credit for code that did not change the render.

Also newly assess, since these systems were built this round: whether the enemy
combatants read as believable humans or as placeholder shapes, and whether the
HUD looks designed or looks like debug output.

Then look for whatever is now the weakest thing in the frame -- untextured or
tiling surfaces, wrong texel density, missing AO, shadow artefacts, aliasing,
fog/sky disagreement, washed bloom, primitive-looking geometry, uncomposed
framing, floating props, anything placeholder.

Route every finding to the owning system: forge, sky, lighting, postfx, level,
props, viewmodel, player, combat, fx, ai, ux. The 'fix' field must be a concrete
technical instruction, not "make it better". Flag any page error as critical.`, {
  label: 'critic:round4',
  phase: 'Critique',
  schema: CRITIQUE_SCHEMA,
})

log(`Round 4: score ${critique?.overallScore ?? '?'} / ${critique?.verdict ?? '?'} -- ${critique?.headline ?? ''}`)

return {
  score: critique?.overallScore,
  verdict: critique?.verdict,
  headline: critique?.headline,
  resolutionAudit: critique?.resolutionAudit,
  perShot: critique?.perShot,
  findings: critique?.findings,
  integration,
}
