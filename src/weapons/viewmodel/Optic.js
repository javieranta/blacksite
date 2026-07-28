import * as THREE from 'three';
import { boxG, cylG, knurlG } from './Shapes.js';

/**
 * OWNER: viewmodel agent.
 *
 * Open-emitter 1x reflex sight. A thin rectangular hood carrying one piece of
 * tinted glass, with the emitter, battery and adjustment hardware in a body that
 * sits entirely *below* the optical axis.
 *
 * ─── WHY IT IS BUILT THIS WAY: THE "TELEVISION SET" REGRESSION ─────────────
 *
 * The previous revision was an *enclosed* sight: a 52 mm-deep aluminium box with
 * 5 mm walls, a matte-black interior liner, a machined front bezel and a rubber
 * eyecup on the rear aperture. Every one of those is a concentric rectangle of
 * dark material between the eye and the world, and looking down the axis they
 * stack: the rear aperture subtends one angle, the front aperture — 52 mm
 * further away — subtends a *smaller* one, and everything between them is
 * unlit liner. The result reads as a picture frame with a small television
 * inside it, and no amount of eye-relief tuning fixes it, because the ratio of
 * the two apertures is set by housing length over eye distance, not by scale.
 *
 * At 1x there is nothing to enclose. A red dot is a collimated LED reflected off
 * one coated plate; the shooter looks *through* it at the same world, at the
 * same exposure. So the housing here is a 5.8 mm-deep picture frame with a
 * 2.4 mm section — front and rear apertures 6 mm apart instead of 52, which
 * collapses the tunnel to a couple of pixels — and the world behind the glass is
 * the composited world with a 6% tint on it, not a re-render.
 *
 * Nothing may sit above `AY - yIn - FRAME` behind the frame, or it walks back
 * into the sight picture. The body, the turrets, the battery and the emitter are
 * all under that line, which is why they cost nothing in ADS and still give the
 * sight a real silhouette in hipfire.
 */

const RETICLE_VERT = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`;

const RETICLE_FRAG = /* glsl */`
uniform vec3 uCore;
uniform vec3 uGlow;
uniform float uInt;
uniform vec2 uOff;
uniform vec2 uSpan;
uniform float uDotR;
uniform float uGlowR;
varying vec2 vUv;

void main() {
  // Window-space position in metres, with the parallax offset applied.
  vec2 p = ( vUv - 0.5 ) * uSpan - uOff;
  float r = length( p );
  // Hard-ish core with a gaussian shoulder: a real dot is an out-of-focus
  // point source, not a disc with an edge.
  float core = exp( -pow( r / uDotR, 2.0 ) * 2.2 );
  // The halo has to stay *tight*. All the brightness a dot needs lives in the
  // core; a wide halo turns the whole window pink and the world behind the glass
  // stops being readable, which is the opposite of what a 1x optic is for.
  float halo = exp( -r / uGlowR ) * 0.16;
  float bleed = exp( -r / ( uGlowR * 3.0 ) ) * 0.010;
  // The quad is the whole window, so the wide bleed has to be masked out at its
  // border — otherwise additive blending paints a visible rectangle of haze
  // across the optic instead of a floating dot.
  vec2 e = abs( vUv - 0.5 ) * 2.0;
  float mask = ( 1.0 - smoothstep( 0.55, 0.97, e.x ) ) * ( 1.0 - smoothstep( 0.55, 0.97, e.y ) );
  float a = ( core + halo + bleed ) * mask;
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
 * Objective glass. A broadband anti-reflective coating reads as a cool
 * blue-magenta bloom that strengthens toward grazing angles, over a faintly
 * smoked substrate.
 *
 * The alpha budget is the whole design here. On axis — which is exactly where
 * the eye is in ADS — the glass must be very close to invisible, or the window
 * darkens relative to its surroundings and the sight reads as a separate,
 * differently-exposed image bolted to the gun. 6% at normal incidence is enough
 * to say "there is glass here" and little enough that the world stays
 * continuous across the frame edge. The coating only earns its keep off axis,
 * where Fresnel takes over and the element picks up its blue sheen.
 */
const LENS_FRAG = /* glsl */`
uniform vec3 uTint;
uniform vec3 uCoat;
uniform float uOpacity;
varying vec3 vN;
varying vec3 vV;
varying vec2 vUv;

void main() {
  vec3 v = normalize( vV );
  float f = pow( 1.0 - abs( dot( v, normalize( vN ) ) ), 2.8 );
  // Radial vignette: the coating is thicker toward the edge of the element.
  vec2 c = vUv - 0.5;
  float rad = smoothstep( 0.30, 0.56, length( c * vec2( 1.0, 1.20 ) ) );
  vec3 coat = uCoat * ( f * 1.15 + rad * 0.16 );
  // A soft diagonal sheen sells it as a polished coated surface — but the eye
  // has to read *through* this element, so it stays a hint, not a highlight.
  float sheen = exp( -pow( ( c.x * 1.7 + c.y * 2.4 + 0.30 ) * 5.6, 2.0 ) ) * 0.26;
  vec3 col = uTint + coat + vec3( 0.42, 0.52, 0.68 ) * sheen * 0.40;
  float a = clamp( uOpacity + f * 0.42 + rad * 0.07 + sheen * 0.14, 0.0, 0.62 );
  gl_FragColor = vec4( col, a );
}
`;

/**
 * Emit the optic into the mesher and return the loose meshes (glass, reticle)
 * plus the sight anchor the ADS pose is computed from.
 *
 * @param m Mesher
 * @param mats material map from Materials.js
 * @param o { railTop, axisY, z }  mounting reference in weapon space
 */
export function buildOptic(m, mats, o) {
  const AY = o.axisY;                 // optical axis height
  const OZ = o.z;                     // frame centre
  const RT = o.railTop;

  const WIN_W = 0.0268, WIN_H = 0.0232;
  const FRAME = 0.0024;               // hood section
  const FRAME_D = 0.0058;             // hood depth along the bore — deliberately
                                      // tiny; this is the number that killed the
                                      // tunnel.
  const xIn = WIN_W / 2, yIn = WIN_H / 2;
  const xO = xIn + FRAME, yO = yIn + FRAME;
  const zF = OZ - FRAME_D / 2, zB = OZ + FRAME_D / 2;

  /** Everything structural must stay at or below this to clear the sight line. */
  const bodyTop = AY - yIn - FRAME;
  const A = 'alu', S = 'steel', BK = 'bore';

  /* ---- QD mount -------------------------------------------------------- */
  m.use(A);
  // recoil lug dropping into a rail slot
  boxG(m, { x: 0, y: RT - 0.0018, z: OZ + 0.0040, w: 0.0150, h: 0.0050, d: 0.0046, c: 0.0006, simple: true });
  // Base plate over the rail. Everything on the mount is kept forward of
  // OZ + 0.030: in ADS the eye sits only ~68 mm behind the frame, so a fitting
  // 20 mm further back is 20 mm nearer the lens and projects nearly twice the
  // size — the battery cap ended up reading as a claw hanging off the frame.
  boxG(m, { x: 0, y: RT + 0.0034, z: OZ + 0.0090, w: 0.0300, h: 0.0068, d: 0.0430, c: 0.0011 });
  // clamp bar and throw lever on the left
  boxG(m, { x: -0.0158, y: RT + 0.0002, z: OZ + 0.0060, w: 0.0052, h: 0.0110, d: 0.0290, c: 0.0009 });
  m.use(S);
  boxG(m, { x: -0.0196, y: RT - 0.0040, z: OZ + 0.0060, rz: 0.22,
    w: 0.0034, h: 0.0180, d: 0.0120, c: 0.0006 });
  for (const cz of [OZ - 0.0030, OZ + 0.0160]) {
    cylG(m, { x: -0.0182, y: RT + 0.0018, z: cz, rz: Math.PI / 2, r0: 0.0026, len: 0.0034, seg: 10 });
  }

  /* ---- body: emitter, battery and electronics, all below the sight line -- */
  m.use(A);
  const bodyH = bodyTop - (RT + 0.0068);
  const bodyY = RT + 0.0068 + bodyH / 2;
  boxG(m, { x: 0, y: bodyY, z: OZ + 0.0090, w: 0.0252, h: bodyH, d: 0.0410, c: 0.0016 });
  // A shoulder each side, stepped in — it breaks the body's flank into two tonal
  // bands instead of one 41 mm slab.
  for (const s of [1, -1]) {
    boxG(m, { x: s * 0.0122, y: bodyY - 0.0018, z: OZ + 0.0110, rz: s * 0.16,
      w: 0.0026, h: 0.0044, d: 0.0340, c: 0.0006, simple: true });
  }
  // Front wedge under the window: the emitter shroud, raked so the LED throws up
  // and back onto the glass the way an open emitter actually works.
  boxG(m, { x: 0, y: bodyTop - 0.0028, z: OZ - 0.0092, rx: -0.34,
    w: 0.0186, h: 0.0062, d: 0.0130, c: 0.0012 });
  m.use(BK);
  boxG(m, { x: 0, y: bodyTop - 0.0016, z: OZ - 0.0086, rx: -0.34,
    w: 0.0062, h: 0.0022, d: 0.0044, c: 0.0004, simple: true });

  /* ---- hood: a thin picture frame, not a tube --------------------------- */
  m.use(A);
  boxG(m, { x: -(xIn + FRAME / 2), y: AY, z: OZ, w: FRAME, h: WIN_H + FRAME * 2, d: FRAME_D, c: 0.0007 });
  boxG(m, { x: xIn + FRAME / 2, y: AY, z: OZ, w: FRAME, h: WIN_H + FRAME * 2, d: FRAME_D, c: 0.0007 });
  // Top bar carries a 2.6 mm forward lip — the sunshade — which is the only part
  // of the hood allowed any depth at all.
  boxG(m, { x: 0, y: AY + yIn + FRAME / 2, z: OZ - 0.0013,
    w: WIN_W + FRAME * 2, h: FRAME, d: FRAME_D + 0.0026, c: 0.0007 });
  boxG(m, { x: 0, y: AY - yIn - FRAME / 2, z: OZ, w: WIN_W + FRAME * 2, h: FRAME, d: FRAME_D, c: 0.0007 });
  // Corner gussets tying the hood into the body, outside the window cone.
  for (const s of [1, -1]) {
    boxG(m, { x: s * (xIn + FRAME / 2), y: AY - yIn - 0.0052, z: OZ + 0.0034, rz: s * 0.30,
      w: 0.0030, h: 0.0120, d: 0.0090, c: 0.0007 });
  }

  /* ---- adjustment turrets, battery, buttons: all flanking the body ------ */
  m.use(S);
  // Elevation left, windage right — side-mounted, as on every modern micro dot,
  // which is what keeps them out of the sight picture.
  const turretY = bodyTop - 0.0034;
  knurlG(m, { x: -0.0148, y: turretY, z: OZ - 0.0022,
    rz: Math.PI / 2, r0: 0.0042, len: 0.0062, seg: 12, teeth: 12 });
  knurlG(m, { x: 0.0148, y: turretY, z: OZ - 0.0022,
    rz: Math.PI / 2, r0: 0.0042, len: 0.0062, seg: 12, teeth: 12 });
  // Battery tray cap, left rear.
  // Kept small and kept forward: at a 62 mm eye relief a 5 mm cap sitting 50 mm
  // from the lens projects an 85 px knurled lump into the lower corner of the
  // sight picture, which reads as a claw bolted to the frame rather than as a
  // battery tray.
  knurlG(m, { x: -0.0132, y: bodyY, z: OZ + 0.0040,
    rz: Math.PI / 2, r0: 0.0040, len: 0.0040, seg: 12, teeth: 12 });
  // Brightness buttons on the right.
  m.use(A);
  for (const bz of [OZ + 0.0020, OZ + 0.0092]) {
    cylG(m, { x: 0.0128, y: bodyY + 0.0012, z: bz,
      rz: Math.PI / 2, r0: 0.0022, len: 0.0024, seg: 10 });
  }

  /* ---- glass + reticle ------------------------------------------------- */
  const lensMat = new THREE.ShaderMaterial({
    uniforms: {
      uTint: { value: new THREE.Color(0x070c11) },
      uCoat: { value: new THREE.Color(0x2a4a86) },
      uOpacity: { value: 0.060 },
    },
    vertexShader: LENS_VERT,
    fragmentShader: LENS_FRAG,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  lensMat.name = 'vm:lens';
  const lens = new THREE.Mesh(new THREE.PlaneGeometry(WIN_W + 0.0004, WIN_H + 0.0004), lensMat);
  lens.name = 'vm:optic:lens';
  lens.position.set(0, AY, zF + 0.0013);
  // Reflex glass leans so the emitter below the window reflects back to the eye.
  lens.rotation.x = -0.10;
  lens.renderOrder = 4;
  lens.frustumCulled = false;

  const reticleMat = new THREE.ShaderMaterial({
    uniforms: {
      uCore: { value: new THREE.Color(0xff6644) },
      uGlow: { value: new THREE.Color(0xff1d0a) },
      uInt: { value: 5.4 },
      uOff: { value: new THREE.Vector2(0, 0) },
      uSpan: { value: new THREE.Vector2(WIN_W, WIN_H) },
      // 0.42 mm at a 62 mm eye relief is a ~10 px core at 1080p. It has to be
      // this small in the *buffer*: the dot clips the HDR target on purpose so
      // it survives AgX, which means bloom then spreads it — a core sized to
      // look right before bloom lands as a 60 px pink blob after it.
      uDotR: { value: 0.00042 },
      uGlowR: { value: 0.00090 },
    },
    vertexShader: RETICLE_VERT,
    fragmentShader: RETICLE_FRAG,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  reticleMat.name = 'vm:reticle';
  const reticle = new THREE.Mesh(new THREE.PlaneGeometry(WIN_W, WIN_H), reticleMat);
  reticle.name = 'vm:optic:reticle';
  // Just behind the glass, square to the bore so the dot never smears.
  reticle.position.set(0, AY, zF + 0.0026);
  reticle.renderOrder = 6;
  reticle.frustumCulled = false;

  return {
    lens,
    reticle,
    lensMat,
    reticleMat,
    /** Exit pupil: the point the ADS blend puts on the view axis. */
    sight: new THREE.Vector3(0, AY, zB + 0.0035),
    window: { w: WIN_W, h: WIN_H },
  };
}
