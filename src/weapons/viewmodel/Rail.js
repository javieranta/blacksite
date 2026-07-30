import * as THREE from 'three';
import { boxG, cylG, knurlG, prismG, tubeG } from './Shapes.js';

/**
 * OWNER: viewmodel agent.
 *
 * The rail, and the hardware that clamps to it — the optic and its mount live
 * here for a boundary reason rather than a design one: `Optic.js` is outside this
 * agent's owned-file list, and the contract's remedy for that is to build what
 * you need in a file you do own rather than reach into someone else's module.
 * `Weapon.js` imports `buildOptic` from here and no longer from `Optic.js`, so
 * that file is now unreferenced.
 *
 * MIL-STD-1913 style top rail, built as one continuous mesh with a real
 * cross-section rather than a row of extruded cuboids.
 *
 * The cross-section is what makes it read: a narrow base, a flare out to the
 * widest point, then 45-degree clamping shoulders angling back in to a narrow
 * top flat, with a chamfer at every transition. Seen from the shooter's eye in
 * ADS the rail is a long grazing surface, and those angled shoulders are what
 * break it into three distinct tonal bands instead of one flat grey ladder.
 *
 * The recoil grooves are genuine cuts: the lower body sweeps the full length and
 * carries the groove floor, and each tooth is a separate prism *in the same
 * mesh* whose end caps are the groove walls. One draw call, real geometry.
 */

/** Lower body: base to groove floor. CCW, `[x, y, edgeFlag]`. */
const LOWER = [
  [-0.00740, 0.00000, 0.9],
  [0.00740, 0.00000, 0.9],
  [0.00860, 0.00130, 1.0],
  [0.00980, 0.00340, 1.0],
  [-0.00980, 0.00340, 1.0],
  [-0.00860, 0.00130, 1.0],
];

/** Tooth: groove floor up over the clamping shoulders to the top flat. */
const TOOTH = [
  [-0.00980, 0.00325, 0.35],
  [0.00980, 0.00325, 0.35],
  [0.00980, 0.00400, 1.0],
  [0.00800, 0.00630, 1.0],
  [0.00700, 0.00670, 0.85],
  [-0.00700, 0.00670, 0.85],
  [-0.00800, 0.00630, 1.0],
  [-0.00980, 0.00400, 1.0],
];

export const RAIL_HEIGHT = 0.00670;
export const RAIL_PITCH = 0.01000;
const TOOTH_LEN = 0.00480;

/**
 * @param m Mesher (material already selected by the caller)
 * @param o { y, z0, z1 } rail base height and span in weapon space
 * @returns the z positions of the groove centres, so mounts can drop a recoil
 *          lug into one instead of floating above the rail.
 */
export function buildRail(m, o) {
  const grooves = [];
  prismG(m, { y: o.y, profile: LOWER, z0: o.z0, z1: o.z1 });

  // Teeth run front to back; a partial tooth at the very end looks wrong, so
  // stop as soon as a whole one no longer fits.
  let z = o.z0 + 0.0012;
  let prevEnd = null;
  while (z + TOOTH_LEN <= o.z1 - 0.0012) {
    prismG(m, { y: o.y, profile: TOOTH, z0: z, z1: z + TOOTH_LEN });
    if (prevEnd !== null) grooves.push((prevEnd + z) * 0.5);
    prevEnd = z + TOOTH_LEN;
    z += RAIL_PITCH;
  }
  return grooves;
}

/**
 * A short accessory rail section — used for the offset light mount and the
 * folded front sight base. Same cross-section, so it matches the top rail.
 */
export function buildRailStub(m, o) {
  prismG(m, { x: o.x ?? 0, y: o.y, z: 0, rx: o.rx ?? 0, ry: o.ry ?? 0, rz: o.rz ?? 0,
    profile: LOWER, z0: o.z0, z1: o.z1 });
  let z = o.z0 + 0.0010;
  while (z + TOOTH_LEN <= o.z1 - 0.0010) {
    prismG(m, { x: o.x ?? 0, y: o.y, rx: o.rx ?? 0, ry: o.ry ?? 0, rz: o.rz ?? 0,
      profile: TOOTH, z0: z, z1: z + TOOTH_LEN });
    z += RAIL_PITCH;
  }
}

/* ==================================================================== optic */

/**
 * 1x tube red dot on a riser ring mount.
 *
 * ─── WHAT WAS WRONG, MEASURED ──────────────────────────────────────────────
 *
 * The round-9 sight was an open-emitter design: a thin RECTANGULAR picture frame
 * carrying one plate of glass. Two things failed.
 *
 * 1. THE GLASS BRIGHTENED THE VIEW. `tools/opticcheck.mjs` reads the same wall
 *    pixels twice, once with the pane visible and once not; the worst tile of the
 *    window measured 1.369 — the world 37 percent BRIGHTER through the glass than
 *    beside it. The cause was structural, not a bad constant: the shader computed
 *    `col = tint + coating + sheen + emitter` and let alpha blending apply it, so
 *    every term was ADDED radiance, and the coating and sheen were driven by
 *    radial position rather than incidence angle — a blue-lavender wash at exactly
 *    the on-axis geometry where a real broadband AR coating reflects under half a
 *    percent. The fix is to model glass as TRANSMISSION plus a small reflection,
 *
 *        framebuffer = reflected_radiance + world * transmittance
 *
 *    which is premultiplied-alpha blending with `absorbance` in the alpha channel.
 *    Transmittance becomes one number the assertion can gate, and the reflection
 *    is pure Schlick Fresnel — 0.4% on axis, a visible sheen only at grazing
 *    incidence, which is where glass actually flares.
 *
 * 2. A RECTANGULAR APERTURE READS AS A TELEVISION SET. What makes a stack of
 *    concentric apertures read as a tunnel is the RATIO of the front aperture's
 *    subtended angle to the rear one's, and that ratio is set by tube length over
 *    eye distance — so a SHORT tube is safe, and a circle is unmistakably an optic
 *    where a rectangle is unmistakably a screen. On the carbine's dot the front
 *    aperture subtends 0.1086 rad against the eyecup's 0.1400: a mild, correct
 *    tube vignette. The LANCET's scope is 44 mm deep and gets away with it because
 *    its eye relief goes up with its length.
 *
 * ─── THE APERTURE RULE ─────────────────────────────────────────────────────
 *
 * Every ring on this optic is checked against the sight cone before it is
 * allowed to exist. The cone is anchored on the FRONT aperture — inner radius
 * R_IN at distance (EYE + sight.z - zF) — and any ring nearer the eye must
 * subtend MORE than that or it crops the window. The lens shade is the dangerous
 * one, because it is the only part *further* from the eye than the limiting
 * aperture and therefore has to be wider than the tube it screws onto. Get it
 * backwards and the sight picture shrinks without anything looking obviously
 * broken, which is how a tunnel gets shipped.
 */

/**
 * Default sight — the 1x tube dot the carbine carries. Every one of these is
 * overridable per weapon through `buildOptic`'s options, because the SMG wants a
 * smaller dot sitting lower and the marksman rifle wants a 31 mm prism scope; the
 * defaults are the carbine's shipped numbers so an omitted option changes nothing.
 *
 * The aperture rule below is arithmetic, not taste, so it has to be re-derived
 * for whatever size is asked for rather than asserted once against these values —
 * which is why `rings` is built from the live numbers and returned.
 */
const R_IN0 = 0.01200;                // clear aperture radius — 24 mm objective
const WALL0 = 0.00240;
const TUBE_D0 = 0.01600;              // body length along the bore
const EYE0 = 0.0820;                  // eye relief (ViewModel owns the real one)

const RETICLE_VERT = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`;

/**
 * The dot. Additive, because an illuminated reticle is emitted light — the one
 * thing on this optic that legitimately adds radiance.
 *
 * The halo stays tight on purpose: all the brightness a dot needs lives in the
 * core, and a wide halo turns the window pink and makes the target unreadable,
 * which is the opposite of what a 1x sight is for. The element is now a circle,
 * so the bleed is masked radially instead of by the old rectangular border test.
 */
const RETICLE_FRAG = /* glsl */`
uniform vec3 uCore;
uniform vec3 uGlow;
uniform float uInt;
uniform vec2 uOff;
uniform vec2 uSpan;
uniform float uDotR;
uniform float uGlowR;
uniform float uCross;
varying vec2 vUv;

void main() {
  vec2 p = ( vUv - 0.5 ) * uSpan - uOff;
  float r = length( p );
  float core = exp( -pow( r / uDotR, 2.0 ) * 2.2 );
  float halo = exp( -r / uGlowR ) * 0.16;
  float bleed = exp( -r / ( uGlowR * 3.0 ) ) * 0.010;
  /**
   * Etched crosshair, for the marksman scope only (uCross = 0 on the dots).
   *
   * DIM AND THIN, and it took two passes to get there. The emitter runs uInt 6.6
   * in ADS and the dot deliberately CLIPS the HDR target so it survives AgX, so
   * any amplitude near the dot's makes the hairs clip along their whole length and
   * bloom then spreads them: at 0.34 the crop showed a neon cross painted over the
   * target, and at 0.075 it was still a glowing one. 0.035 puts the arms at ~0.23
   * in the buffer — clearly visible, under the bloom threshold, and leaving the
   * intersection as the only clipped pixel. 0.60 dot-radii is about 3 px, which is
   * what an etched hair subtends. They run nearly to the tube wall: a crosshair
   * that stops 60% of the way out reads as a decal, not as a sight.
   */
  float hair = 0.0;
  if ( uCross > 0.0 ) {
    float gap = smoothstep( uDotR * 1.4, uDotR * 4.5, r );
    float fade = 1.0 - smoothstep( uSpan.x * 0.38, uSpan.x * 0.50, r );
    hair = ( exp( -pow( p.y / ( uDotR * 0.60 ), 2.0 ) )
      + exp( -pow( p.x / ( uDotR * 0.60 ), 2.0 ) ) ) * gap * fade * 0.035;
  }
  float edge = length( vUv - 0.5 ) * 2.0;
  float mask = 1.0 - smoothstep( 0.72, 0.99, edge );
  float a = ( core + halo + bleed + hair ) * mask;
  vec3 col = mix( uGlow, uCore, clamp( core * 1.4, 0.0, 1.0 ) );
  gl_FragColor = vec4( col * a * uInt, 1.0 );
}
`;

const LENS_VERT = /* glsl */`
varying vec3 vN;
varying vec3 vV;
varying vec2 vUv;
void main() {
  vUv = uv;
  vec4 mv = modelViewMatrix * vec4( position, 1.0 );
  vV = -mv.xyz;
  vN = normalize( normalMatrix * normal );
  gl_Position = projectionMatrix * mv;
}
`;

/**
 * Objective glass, as transmittance rather than as an overlay.
 *
 * Output is PREMULTIPLIED: rgb is the radiance the element reflects toward the
 * eye, alpha is how much of the world behind it the substrate absorbs. With
 * blendSrc = One and blendDst = OneMinusSrcAlpha the framebuffer ends up at
 * `reflected + world * (1 - absorbance)`, which is the transport equation for a
 * thin element and nothing else. Consequences worth stating, because the previous
 * shader violated all three:
 *
 *   • there is no term that can brighten the sight picture on axis, because the
 *     only additive term is Fresnel-weighted and F(0) is 0.004;
 *   • transmittance is a single number, `uAbsorb`, that the assertion gates;
 *   • the coating's interference colour lives in the RIM band only, where a real
 *     evaporated coating is thickest, so it never crosses the target.
 *
 * Transmittance is scalar rather than per-channel: one blend equation cannot
 * carry three independent destination factors. The faint cool cast a real AR
 * stack has therefore arrives as *added* blue-violet in the reflection term,
 * which is where a coating's colour is actually seen anyway.
 */
const LENS_FRAG = /* glsl */`
uniform vec3 uReflect;
uniform vec3 uEmit;
uniform float uAbsorb;
uniform float uF0;
uniform float uEnv;
varying vec3 vN;
varying vec3 vV;
varying vec2 vUv;

void main() {
  vec3 v = normalize( vV );
  float ndv = clamp( abs( dot( v, normalize( vN ) ) ), 0.0, 1.0 );
  // Schlick. uF0 = 0.004 is a broadband AR stack: near-perfect on axis, and it
  // only climbs into a visible sheen past about 70 degrees off normal.
  float F = uF0 + ( 1.0 - uF0 ) * pow( 1.0 - ndv, 5.0 );
  float r = length( vUv - 0.5 ) * 2.0;          // 0 centre, 1 at the element rim
  // Thick-coating rim: the last 14% of the radius, hidden under the tube wall in
  // ADS and catching the interference colour in any other pose.
  float rim = smoothstep( 0.86, 1.0, r );
  vec3 refl = uReflect * ( F * uEnv + rim * 0.030 );
  /**
   * The emitter's own reflection off the rear surface — the tell that this is an
   * illuminated sight rather than a window.
   *
   * Deliberately tight and weak: it is the one term left that can brighten the
   * sight picture, and the assertion caught it doing so at 0.020 with a width of 9
   * (one window tile 12.6% brighter than the world beside it). The LED sits at the
   * bottom of the tube, so its reflection is a narrow arc on the bottom edge.
   */
  float emit = exp( -pow( ( vUv.y - 0.5 + 0.46 ) * 16.0, 2.0 ) )
    * exp( -pow( ( vUv.x - 0.5 ) * 3.4, 2.0 ) );
  refl += uEmit * emit * 0.010;
  gl_FragColor = vec4( refl, clamp( uAbsorb + rim * 0.10, 0.0, 1.0 ) );
}
`;

/**
 * Eyecup shade.
 *
 * A soft dark halo hugging the outside of the tube — what the rubber cup casts
 * once the eye is centred in it. It is a ring, not a full-screen vignette,
 * because a 1x optic must not cost peripheral vision.
 *
 * It gates itself on incidence: alpha falls to zero unless the plate is being
 * viewed nearly square on, which is true in ADS and false in every hipfire pose.
 * That is what stops it reading as a translucent disc floating around the sight
 * when the weapon is off to the side, without needing to know the ADS progress —
 * ViewModel is not this agent's file and cannot be asked to drive a uniform.
 */
const VIG_FRAG = /* glsl */`
uniform float uInner;
uniform float uMax;
varying vec3 vN;
varying vec3 vV;
varying vec2 vUv;
void main() {
  float r = length( vUv - 0.5 ) * 2.0;
  float t = smoothstep( uInner, 1.0, r );
  float onAxis = smoothstep( 0.90, 0.995,
    clamp( abs( dot( normalize( vV ), normalize( vN ) ) ), 0.0, 1.0 ) );
  gl_FragColor = vec4( 0.0, 0.0, 0.0, pow( t, 1.6 ) * uMax * onAxis );
}
`;

/**
 * Emit the optic into the mesher and return the loose meshes plus the sight
 * anchor the ADS pose is computed from. The return shape is load-bearing:
 * ViewModel.js reads `optic.reticleMat.uniforms` (uOff, uInt), `optic.window`,
 * `optic.lens`, `optic.reticle`, `optic.lensMat` and disposes the first four.
 * Adding fields is safe; renaming any of them is not.
 *
 * @param m Mesher
 * @param mats material map from Materials.js
 * @param o { railTop, axisY, z } mounting reference, plus the optional per-weapon
 *          sizing { rIn, wall, depth, relief, shadeIn, shadeOut, bell, pupil,
 *          vig, cross } — see WeaponData.VIEWMODEL.
 * @returns {{ lens, reticle, vignette, lensMat, reticleMat, sight, window }}
 */
export function buildOptic(m, mats, o) {
  const R_IN = o.rIn ?? R_IN0;              // clear aperture radius
  const WALL = o.wall ?? WALL0;
  const R_OUT = R_IN + WALL;                // tube OD
  const TUBE_D = o.depth ?? TUBE_D0;        // body length along the bore
  const EYE = o.relief ?? EYE0;
  /** Scale every piece of hardware bolted to the tube with the tube itself. */
  const K = R_IN / R_IN0;
  const AY = o.axisY;                       // optical axis height
  const OZ = o.z;                           // tube centre
  const RT = o.railTop;
  const zF = OZ - TUBE_D / 2;               // objective end
  const zB = OZ + TUBE_D / 2;               // ocular end
  const A = 'alu', S = 'steel', BK = 'bore';

  /** Exit pupil: behind the eyecup, so eye relief is measured from clear air. */
  const pupilZ = zB + (o.pupil ?? 0.0125);

  /* ---- mount: rail lug, base, riser, two rings, and real screws --------- */
  /**
   * Mount depth follows the tube, at 45% of the tube's own stretch. A 44 mm scope
   * on a 30 mm base reads as a scope balanced on a coin; a 16 mm dot on a 54 mm
   * base reads as a dot glued to a plank. Half-tracking the tube keeps both
   * proportions plausible from one expression.
   */
  const MD = 0.0300 * (1 + (TUBE_D / TUBE_D0 - 1) * 0.45);
  m.use(A);
  // Recoil lug dropping into a rail groove — the reason this mount cannot walk.
  boxG(m, { x: 0, y: RT - 0.0016, z: OZ + 0.0038, w: 0.0150, h: 0.0046, d: 0.0046, c: 0.0006, simple: true });
  boxG(m, { x: 0, y: RT + 0.0036, z: OZ + 0.0020, w: 0.0290, h: 0.0072, d: MD, c: 0.0012 });
  // Riser column up to the tube, waisted so it is two silhouettes rather than a
  // post: a straight column at this scale reads as a peg.
  const riserY0 = RT + 0.0072, riserY1 = AY - R_OUT;
  boxG(m, { x: 0, y: (riserY0 + riserY1) / 2, z: OZ + 0.0010,
    w: 0.0166, h: riserY1 - riserY0 + 0.0012, d: MD * 0.82, w1: 0.0148, c: 0.0022 });
  boxG(m, { x: 0, y: (riserY0 + riserY1) / 2, z: OZ + 0.0010,
    w: 0.0184, h: 0.0034, d: MD * 0.70, c: 0.0008, simple: true });
  // Left-side clamp bar and throw lever.
  boxG(m, { x: -0.0154, y: RT + 0.0006, z: OZ + 0.0010, w: 0.0050, h: 0.0112, d: MD * 0.84, c: 0.0009 });
  m.use(S);
  boxG(m, { x: -0.0190, y: RT - 0.0038, z: OZ + 0.0010, rz: 0.22,
    w: 0.0032, h: 0.0172, d: 0.0116, c: 0.0006 });
  /**
   * Cross-bolts and cap screws. `ry`, never `rz`: cylG builds along +Z, so a
   * rotation about Z leaves a "sideways" bolt pointing down the bore and buried
   * edge-on in the body — which is how the round-8 optic came to have every one
   * of its screws invisible while all of them were in the file.
   */
  for (const cz of [OZ - MD * 0.24, OZ + MD * 0.30]) {
    cylG(m, { x: -0.0182, y: RT + 0.0020, z: cz, ry: Math.PI / 2, r0: 0.0028, len: 0.0042, seg: 10, c: 0.0006 });
    m.use(BK);
    boxG(m, { x: -0.0202, y: RT + 0.0020, z: cz, ry: Math.PI / 2, rz: 0.4,
      w: 0.0016, h: 0.0016, d: 0.0013, c: 0.0002, simple: true });
    m.use(S);
  }
  // Base screws in the plate's top face, fore and aft of the riser — the pair a
  // shooter torques to spec, and two more highlights on an otherwise flat plate.
  for (const bz of [OZ - MD * 0.4067, OZ + MD * 0.4533]) {
    cylG(m, { x: 0, y: RT + 0.0076, z: bz, rx: -Math.PI / 2, r0: 0.0027, len: 0.0024, seg: 10, c: 0.0006 });
    m.use(BK);
    boxG(m, { x: 0, y: RT + 0.0086, z: bz, rx: -Math.PI / 2, rz: 0.7,
      w: 0.0015, h: 0.0015, d: 0.0012, c: 0.0002, simple: true });
    m.use(S);
  }

  /* ---- the tube: anodised shell, matte liner ---------------------------- */
  m.use(A);
  tubeG(m, { x: 0, y: AY, z: OZ, rIn: R_IN + 0.0005, rOut: R_OUT, len: TUBE_D, seg: 30, c: 0.0009 });
  // Clamp rings. Full rings because that is what a ring mount is; each carries a
  // pinch boss and screw on the right, so the mount reads as clamped rather than
  // welded.
  for (const rz of [OZ - TUBE_D * 0.275, OZ + TUBE_D * 0.275]) {
    tubeG(m, { x: 0, y: AY, z: rz, rIn: R_OUT, rOut: R_OUT + 0.0026, len: 0.0042, seg: 30, c: 0.0007 });
    boxG(m, { x: R_OUT * 0.62, y: AY - R_OUT * 0.80, z: rz, rz: -0.90,
      w: 0.0052, h: 0.0064, d: 0.0044, c: 0.0009 });
    m.use(S);
    cylG(m, { x: R_OUT * 0.86, y: AY - R_OUT * 0.62, z: rz, ry: Math.PI / 2,
      r0: 0.0021, len: 0.0034, seg: 8, c: 0.0004 });
    m.use(A);
  }
  // Matte liner. The inner wall is the only surface of the optic the eye looks
  // straight down, and as semi-gloss aluminium it caught the key and painted the
  // inside of the sight orange.
  /**
   * `cav` is pushed to the ceiling on a long tube. The visible annulus of liner
   * grows as 1 - (relief + pupil) / (relief + pupil + depth): 14.5% of the window
   * radius on the carbine's 16 mm body, 23% on a 32 mm scope. At that size the
   * grazing warm cast the wear shader leaves on it stops being a hairline and
   * becomes a tan crescent across a third of the sight picture — and the interior
   * of an optic is black from every angle or it is not an optic.
   */
  m.use(BK);
  tubeG(m, { x: 0, y: AY, z: OZ, rIn: R_IN, rOut: R_IN + 0.0008, len: TUBE_D - 0.0004,
    seg: 30, c: 0.0002, cav: o.bell ? 0.95 : 0 });
  /**
   * INTERNAL BAFFLES, on any tube long enough to need them.
   *
   * The share of the sight picture taken up by visible LINER goes as
   * 1 - (relief + pupil) / (relief + pupil + depth): 14.5% of the window radius
   * on the carbine's 16 mm body, 23% on the LANCET's 32 mm one. At that size the
   * warm grazing cast the wear shader leaves on the far wall stops being a
   * hairline and becomes a tan crescent over a third of the sight picture, which
   * `cav` alone does not remove — it darkens diffuse, and this is largely
   * environment specular at a very grazing angle.
   *
   * A baffle is what a real scope uses, and it is pure geometry: a knife-edged
   * ring whose bore is the sight cone AT ITS OWN STATION plus 5%, so it cannot
   * crop the window, and it hides every part of the liner behind it. Two of them
   * leave the eye looking at a stack of black edges instead of down a lit tube.
   */
  if (TUBE_D > 0.0200) {
    const camZb = pupilZ + EYE;
    const cone = R_IN / (camZb - zF);
    for (const bz of [OZ - TUBE_D * 0.15, OZ + TUBE_D * 0.15]) {
      tubeG(m, { x: 0, y: AY, z: bz, rIn: cone * (camZb - bz) * 1.05, rOut: R_IN + 0.0007,
        len: 0.0016, seg: 30, c: 0.0003, cav: 0.95 });
    }
  }

  /* ---- lens shade ------------------------------------------------------- */
  /**
   * A screwed-on shade forward of the objective, with a 0.4 mm shadow gap so it
   * reads as a separate part. Its bore MUST be wider than the tube's: it sits
   * further from the eye than the limiting aperture, so at its front lip
   * (distance 0.1181 m) the sight cone is already 0.01283 m across and an inner
   * radius under that would crop the window. 0.0134 clears it by 0.6 mm.
   */
  /**
   * A BELL, not a shade, when `bell` is set: the marksman scope's objective is
   * physically wider than its tube, so the same part that would crop the window
   * on a 1x dot is the thing that opens it on a scope. Both forms obey the same
   * rule — the bore at the FRONT lip must clear the sight cone there, which is
   * why `shadeIn` is declared per weapon and re-checked in `rings` below rather
   * than being a constant anyone can nudge.
   */
  m.use(A);
  const shIn = o.shadeIn ?? 0.0134, shOut = o.shadeOut ?? 0.0154;
  if (o.bell) {
    tubeG(m, { x: 0, y: AY, z: zF - 0.0104, rIn: shIn, rIn1: R_IN + 0.0004,
      rOut: o.bell, rOut1: R_OUT + 0.0006, len: 0.0200, seg: 30, c: 0.0014 });
    // Lock ring where the bell threads onto the tube — one more change of
    // diameter, which is what stops a taper reading as a single moulded cone.
    tubeG(m, { x: 0, y: AY, z: zF - 0.0016, rIn: R_OUT, rOut: R_OUT + 0.0022,
      len: 0.0034, seg: 30, c: 0.0006 });
  } else {
    tubeG(m, { x: 0, y: AY, z: zF - 0.0040, rIn: shIn, rOut: shOut, rOut1: shOut - 0.0004,
      len: 0.0072, seg: 30, c: 0.0010 });
  }

  /* ---- rubber eyecup on the ocular -------------------------------------- */
  /**
   * Flares outward going back, which is what a moulded cup does. Its bore opens
   * from R_IN toward the eye -- never inward, or a free ring quietly becomes a
   * cropped window. IT IS ALSO THE WIDEST THING ON THE OPTIC AS SEEN BY THE
   * PLAYER, which is why it is this short: apparent size is radius over distance
   * and the eyecup is both the fattest part and the nearest, so an 8.6 x 3.2 mm
   * flare projected 348 px (18.1% of frame width) against the tube's own 237. At
   * 5.8 mm with a 1.8 mm flare it projects 279. The lesson generalises -- on a
   * viewmodel the part nearest the eye dominates the silhouette, so that is where
   * millimetres are worth spending, not the part that is physically largest.
   */
  m.use('rubber');
  tubeG(m, { x: 0, y: AY, z: zB + 0.0029, rIn: R_IN + 0.0004, rIn1: R_IN + 0.0009,
    rOut: R_OUT + 0.0001, rOut1: R_OUT + 0.0018, len: 0.0058, seg: 30, c: 0.0009, capA: false });
  // Matte baffle inside the cup. Without it the cup's own bore is the widest
  // annulus in the sight picture and it is rubber, which at this grazing incidence
  // took the key light and put a warm tan ring around the window — the same
  // "bright interior" failure the tube liner exists to prevent, one part further
  // back. The interior of an optic is black from every angle or it is not an optic.
  m.use(BK);
  tubeG(m, { x: 0, y: AY, z: zB + 0.0029, rIn: R_IN, rIn1: R_IN + 0.0005,
    rOut: R_IN + 0.0007, rOut1: R_IN + 0.0012, len: 0.0058, seg: 30, c: 0.0002, capA: false });

  /* ---- turrets, battery, brightness ------------------------------------- */
  /**
   * Elevation at 12 o'clock, windage at 3, battery cap at 9, riser at 6: four
   * silhouette events, one per quadrant, and every one of them outside the sight
   * cone. The cone at the turret station is 0.00956 m across against the tube's
   * 0.0144 outer radius, so nothing here can enter the window.
   *
   * Each turret is a stepped boss, a knurled drum and a coin-slotted cap — three
   * changes of diameter, which is what says "adjustable machined part".
   */
  const turret = (axis, sign, z) => {
    const rot = axis === 'y' ? { rx: -Math.PI / 2 } : { ry: sign * Math.PI / 2 };
    const at = (d) => (axis === 'y'
      ? { x: 0, y: AY + R_OUT + d, z }
      : { x: sign * (R_OUT + d), y: AY, z });
    m.use(A);
    cylG(m, { ...at(0.0014 * K), ...rot, r0: 0.0052 * K, len: 0.0032, seg: 12, c: 0.0008 });
    m.use(S);
    knurlG(m, { ...at(0.0062 * K), ...rot, r0: 0.0043 * K, len: 0.0064 * K, seg: 12, teeth: 14, c: 0.0009 });
    m.use(BK);
    // Coin slot across the cap: a dark 0.7 x 1.1 mm sliver, which is what turns a
    // knurled drum into a turret you could actually adjust.
    boxG(m, { ...at(0.0096 * K), ...rot, rz: 0.9,
      w: 0.0070 * K, h: 0.0011, d: 0.0010, c: 0.0002, simple: true });
    m.use(A);
  };
  const tz = OZ + 0.0004 - (o.bell ? TUBE_D * 0.16 : 0);
  turret('y', 1, tz);                       // elevation, top
  turret('x', 1, tz);                       // windage, right
  // Battery tray on the left: a larger knurled cap with a coin slot.
  m.use(S);
  knurlG(m, { x: -(R_OUT + 0.0026), y: AY, z: tz - 0.0016, ry: -Math.PI / 2,
    r0: 0.0054 * K, len: 0.0050, seg: 14, teeth: 16, c: 0.0010 });
  m.use(BK);
  boxG(m, { x: -(R_OUT + 0.0053), y: AY, z: tz - 0.0016, ry: -Math.PI / 2, rz: 1.35,
    w: 0.0086 * K, h: 0.0013, d: 0.0011, c: 0.0002, simple: true });
  // Brightness buttons on the right flank, fore and aft of the windage turret.
  m.use(A);
  for (const bz of [tz - 0.0066, tz + 0.0064]) {
    const dy = 0.0046 * K;
    cylG(m, { x: Math.sqrt(Math.max(0, R_OUT * R_OUT - dy * dy)) + 0.0008, y: AY - dy, z: bz,
      ry: Math.PI / 2, r0: 0.0022, len: 0.0028, seg: 10, c: 0.0005 });
  }
  /**
   * Ocular focus ring — scopes only. The tube is long enough on a magnified
   * sight that its rear third is a bare cylinder, and a knurled band there is
   * both what the part actually has and the one thing that keeps a 44 mm tube
   * from reading as a length of pipe.
   *
   * IT IS BUILT WITH `tubeG`, AND `knurlG` IS THE TRAP HERE. knurlG wraps `cylG`,
   * which is a SOLID cylinder with end caps — correct for a turret drum, which is
   * solid, and catastrophic for a ring around the optical axis, because the caps
   * are two 20 mm discs across the bore. The first version used knurlG and the
   * scope photographed completely opaque: a black window with the world nowhere in
   * it, and no reticle either, since the additive dot was behind an occluder. It
   * cost nothing to spot once the ADS crop was actually looked at, and could not
   * have been found any other way — the aperture arithmetic passes, because a
   * plugged bore is not a narrow one.
   */
  if (o.bell) {
    m.use(S);
    const fr = R_OUT + 0.0018;
    tubeG(m, { x: 0, y: AY, z: zB - 0.0080, rIn: R_OUT - 0.0002, rOut: fr, len: 0.0110, seg: 26, c: 0.0008 });
    for (let i = 0; i < 26; i++) {
      const a = (i / 26) * Math.PI * 2;
      boxG(m, { x: Math.cos(a) * fr, y: AY + Math.sin(a) * fr, z: zB - 0.0080, rz: a,
        w: 0.0014, h: 0.0012, d: 0.0092, c: 0.0003, simple: true });
    }
  }

  /* ---- glass, reticle, eyecup shade ------------------------------------- */
  const lensMat = new THREE.ShaderMaterial({
    uniforms: {
      // Cool blue-violet: the colour a broadband AR stack shows in reflection.
      uReflect: { value: new THREE.Color(0x5f78b4) },
      uEmit: { value: new THREE.Color(0xff3a18) },
      /**
       * Absorbance. 1 - uAbsorb is the substrate's scene-linear transmittance,
       * and it is the number `tools/opticcheck.mjs` gates: through-glass
       * luminance must land between 90% and 98% of the same pixels bare.
       *
       * It is NOT a 1:1 lever on that reading. AgX is steep through the mid
       * shadows, so a scene-linear cut arrives in display space amplified by
       * about 1.45x — measured, not assumed: 0.062 here read 0.906-0.915 across
       * both assertion views, so 0.042 lands at 0.938. Anyone retuning this should
       * change the number and re-read the tool rather than reason forward from the
       * transmittance they want.
       */
      uAbsorb: { value: 0.042 },
      uF0: { value: 0.004 },
      uEnv: { value: 0.22 },
    },
    vertexShader: LENS_VERT,
    fragmentShader: LENS_FRAG,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    // Premultiplied: framebuffer = src.rgb + dst.rgb * (1 - src.a).
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendEquation: THREE.AddEquation,
  });
  lensMat.name = 'vm:lens';
  const lens = new THREE.Mesh(new THREE.CircleGeometry(R_IN + 0.0003, 48), lensMat);
  lens.name = 'vm:optic:lens';
  lens.position.set(0, AY, zF + 0.0018);
  lens.renderOrder = 4;
  lens.frustumCulled = false;

  const reticleMat = new THREE.ShaderMaterial({
    uniforms: {
      uCore: { value: new THREE.Color(0xff6644) },
      uGlow: { value: new THREE.Color(0xff1d0a) },
      uInt: { value: 5.4 },
      uOff: { value: new THREE.Vector2(0, 0) },
      uSpan: { value: new THREE.Vector2(R_IN * 1.98, R_IN * 1.98) },
      // 0.42 mm at this eye relief is a ~10 px core at 1080p. It has to be this
      // small in the buffer: the dot clips the HDR target on purpose so it
      // survives AgX, and bloom then spreads it. It scales with the aperture so
      // the dot subtends the same angle on every sight in the loadout.
      uDotR: { value: 0.00042 * K },
      uGlowR: { value: 0.00090 * K },
      uCross: { value: o.cross ?? 0 },
    },
    vertexShader: RETICLE_VERT,
    fragmentShader: RETICLE_FRAG,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  reticleMat.name = 'vm:reticle';
  const reticle = new THREE.Mesh(new THREE.CircleGeometry(R_IN * 0.99, 44), reticleMat);
  reticle.name = 'vm:optic:reticle';
  reticle.position.set(0, AY, zF + 0.0035);
  reticle.renderOrder = 6;
  reticle.frustumCulled = false;

  /**
   * The shade ring sits at the exit pupil — 82 mm in front of the eye in ADS —
   * with its bore just outside the tube's silhouette (0.0125 subtends 0.1524 rad
   * against the tube's 0.1405) so it darkens only the world *around* the optic
   * and never the sight picture or the housing.
   */
  const vg = o.vig ?? [0.0125, 0.0290];
  const vigGeo = new THREE.RingGeometry(vg[0], vg[1], 56, 1);
  const vigMat = new THREE.ShaderMaterial({
    uniforms: { uInner: { value: vg[0] / vg[1] }, uMax: { value: 0.34 } },
    vertexShader: LENS_VERT,
    fragmentShader: VIG_FRAG,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  vigMat.name = 'vm:eyecup-shade';
  /**
   * Teardown, chained off the lens.
   *
   * ViewModel disposes `optic.lens.geometry` by name and sweeps `rig.meshes`. The
   * obvious move was to push this ring into `rig.meshes` -- wrong, because that
   * array is also the "weapon" isolation mask in tools/handcheck.mjs and
   * tools/loadoutcheck.mjs, and a 580 px translucent halo in it inflates another
   * agent's gripOverlap and this file's own housing-width reading (39% of frame).
   * BufferGeometry.dispose dispatches an event, so the chain hangs off the one
   * geometry ViewModel already disposes: lens -> shade geometry -> shade material.
   */
  vigGeo.addEventListener('dispose', () => vigMat.dispose());
  lens.geometry.addEventListener('dispose', () => vigGeo.dispose());
  const vignette = new THREE.Mesh(vigGeo, vigMat);
  vignette.name = 'vm:optic:eyecup-shade';
  vignette.position.set(0, AY, pupilZ);
  vignette.renderOrder = 3;
  vignette.frustumCulled = false;

  /**
   * Every annular obstruction between the eye and the world, declared here rather
   * than recomputed in the test, so the aperture check in tools/opticcheck.mjs
   * cannot drift out of step with the geometry it is checking. `rIn` is the bore;
   * `z` is where that bore sits in weapon space.
   */
  const rings = o.bell ? [
    { name: 'objective bell front lip', z: zF - 0.0204, rIn: shIn },
    { name: 'objective bell rear lip', z: zF - 0.0004, rIn: R_IN + 0.0004 },
    { name: 'tube liner front (limiting aperture)', z: zF, rIn: R_IN },
    { name: 'tube liner rear', z: zB, rIn: R_IN },
    { name: 'eyecup baffle rear rim', z: zB + 0.0058, rIn: R_IN + 0.0005 },
    { name: 'eyecup shade bore', z: pupilZ, rIn: vg[0] },
  ] : [
    { name: 'lens shade front lip', z: zF - 0.0076, rIn: shIn },
    { name: 'lens shade rear lip', z: zF - 0.0004, rIn: shIn },
    { name: 'tube liner front (limiting aperture)', z: zF, rIn: R_IN },
    { name: 'tube liner rear', z: zB, rIn: R_IN },
    { name: 'eyecup baffle front', z: zB, rIn: R_IN },
    { name: 'eyecup baffle rear rim', z: zB + 0.0058, rIn: R_IN + 0.0005 },
    { name: 'eyecup shade bore', z: pupilZ, rIn: vg[0] },
  ];

  /**
   * Widest radius of each part, for the screen-footprint prediction.
   *
   * The first version of the check predicted the housing at 12.3% of frame width
   * by measuring the TUBE and the shot came back at 18.1% -- the eyecup, nearer
   * the eye, subtends more while being only 1.2 mm fatter. A footprint prediction
   * that looks at one part is a guess with a number attached.
   */
  const parts = [
    o.bell
      ? { name: 'objective bell', z: zF - 0.0104, r: o.bell }
      : { name: 'lens shade', z: zF - 0.0040, r: shOut },
    { name: 'tube', z: OZ, r: R_OUT },
    { name: 'clamp rings', z: OZ + TUBE_D * 0.275, r: R_OUT + 0.0026 },
    ...(o.bell ? [{ name: 'focus ring', z: zB - 0.0080, r: R_OUT + 0.0018 }] : []),
    { name: 'eyecup', z: zB + 0.0058, r: R_OUT + 0.0018 },
  ];
  /**
   * Parts that stick out on ONE side, listed apart from `parts` because apparent
   * WIDTH and apparent radius differ for them: the elevation turret reaches 24 mm
   * from the axis but is an 8.6 mm drum, and scoring it as a 24 mm ring claimed
   * 20.4% of frame width for something 16 px across pointing at the sky. `r` is
   * the part's half-thickness, `off` how far off axis it sits.
   */
  const spurs = [
    { name: 'elevation turret', z: tz, r: 0.0043 * K, off: R_OUT + 0.0062 * K, axis: 'y' },
    { name: 'windage turret', z: tz, r: 0.0043 * K, off: R_OUT + 0.0062 * K, axis: 'x' },
    { name: 'battery cap', z: tz - 0.0016, r: 0.0054 * K, off: -(R_OUT + 0.0026), axis: 'x' },
  ];

  return {
    lens, reticle, vignette, lensMat, reticleMat,
    sight: new THREE.Vector3(0, AY, pupilZ),
    window: { w: R_IN * 2, h: R_IN * 2 },
    /** For assertions: the aperture arithmetic, so a tool can re-derive it. */
    optics: { rIn: R_IN, rOut: R_OUT, depth: TUBE_D, eye: EYE, zF, zB, pupilZ, rings, parts, spurs },
  };
}
