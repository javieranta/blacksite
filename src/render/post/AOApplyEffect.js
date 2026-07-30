import * as THREE from 'three';
import { Effect, EffectAttribute, BlendFunction } from 'postprocessing';
import { GTAO } from './PostConstants.js';

/**
 * OWNER: postfx agent.
 *
 * Applies the half-resolution GTAO buffer to the lit HDR frame.
 *
 * Three things happen here, and the order is what makes the result read as
 * grounding rather than as grey paint:
 *
 * 1. **Depth-aware upsample.** Four half-res taps, bilinear weights multiplied
 *    by a depth similarity term. A plain bilinear upsample leaks occlusion
 *    across silhouettes, which is the classic "dark halo around every object"
 *    tell.
 *
 * 2. **The ambient/direct split.** Ambient occlusion multiplies *indirect*
 *    light. A forward renderer has no separate indirect buffer and PostFX does
 *    not own the material system, so there is no seam to read one from — but
 *    the split can be estimated geometrically instead of by luminance (which is
 *    what round 3 did, and which fails the moment the exposure changes):
 *
 *        directMask   = saturate(N·L) · contactShadow
 *        ambientShare = 1 − directProtect · directMask
 *
 *    A face square to the sun and not contact-shadowed keeps 45% of its AO; a
 *    face turned away, or one whose contact ray is blocked, takes all of it.
 *    Nothing that is genuinely sun-lit gets its direct energy multiplied away.
 *
 * 3. **Multi-bounce.** GTAO's albedo-aware remap (Jimenez 2016 §4.3). Raw AO
 *    assumes light that leaves a crevice never comes back, which is only true
 *    for a black surface; on bright concrete it makes the frame look dirty. The
 *    cubic is fitted so a white surface keeps most of its energy while a dark
 *    one goes properly dark. It is evaluated per channel using the pixel's own
 *    chroma, so occlusion on a rusted red drum stays red instead of turning
 *    into soot.
 *
 * The contact shadow is applied separately and *is* allowed to attenuate direct
 * light — that is the whole point of it.
 *
 * ── ROUND 5 FIX ─────────────────────────────────────────────────────────────
 * `uPower` and `uMultiBounce` were declared at the top of this shader, were
 * documented in PostConstants as the two terms that shape the raw integral into
 * something readable, and were **neither bound as uniforms nor referenced in
 * the shader body**. GLSL discards unused uniform declarations without a
 * diagnostic, so the omission was invisible: the pass computed the unshaped
 * `1 − (1 − vis)·intensity` and then ran it through a *full-strength*
 * multi-bounce remap, which hands most of the occlusion straight back. An
 * AO-only capture (`?aodebug=1`) of material-closeup showed the visibility term
 * confined to roughly 0.88–1.0 across the frame, with thin hairlines at
 * silhouettes and no contact band under the column bases or stanchion feet at
 * all — a near-white field, exactly the "nothing is bound to what it is
 * touching" the reviewer described. Both terms are wired below.
 */
const fragmentShader = /* glsl */ `
uniform sampler2D uAO;
uniform mat4 uInvProjection;
uniform vec2 uAOTexel;
uniform vec3 uSunView;
uniform float uIntensity;
uniform float uPower;
uniform float uMultiBounce;
uniform float uProtect;
uniform float uDirectShare;
uniform float uOpenLevel;
uniform float uTolerance;
uniform vec3 uOccludedTint;
uniform float uSkyBias;
uniform float uDebug;

vec3 viewFromDepthLocal(const in vec2 uv, const in float d, const in mat4 invProj) {
  vec4 ndc = vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  vec4 v = invProj * ndc;
  return v.xyz / v.w;
}

float linearZ(const in float d) {
  return -(cameraNear * cameraFar) / ((cameraFar - cameraNear) * d - cameraFar);
}

vec3 reconstructNormal(const in vec2 uv, const in vec3 p) {
  vec2 tx = vec2(texelSize.x, 0.0);
  vec2 ty = vec2(0.0, texelSize.y);
  vec3 l = viewFromDepthLocal(uv - tx, readDepth(uv - tx), uInvProjection);
  vec3 r = viewFromDepthLocal(uv + tx, readDepth(uv + tx), uInvProjection);
  vec3 d = viewFromDepthLocal(uv - ty, readDepth(uv - ty), uInvProjection);
  vec3 u = viewFromDepthLocal(uv + ty, readDepth(uv + ty), uInvProjection);
  vec3 dx = abs(l.z - p.z) < abs(r.z - p.z) ? (p - l) : (r - p);
  vec3 dy = abs(d.z - p.z) < abs(u.z - p.z) ? (p - d) : (u - p);
  vec3 n = cross(dx, dy);
  float len = length(n);
  return len > 1e-9 ? n / len : vec3(0.0, 0.0, 1.0);
}

/** GTAO multi-bounce: keeps bright albedos from turning to soot. */
vec3 multiBounce(const in float ao, const in vec3 albedo) {
  vec3 a = 2.0404 * albedo - 0.3324;
  vec3 b = -4.7951 * albedo + 0.6417;
  vec3 c = 2.7552 * albedo + 0.6903;
  return clamp(max(vec3(ao), ((ao * a + b) * ao + c) * ao), 0.0, 1.0);
}

void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor) {
  if (depth >= 0.999999) {
    outputColor = inputColor;
    return;
  }

  float zc = linearZ(depth);

  // --- depth-aware 2× upsample -------------------------------------------
  vec2 f = uv / uAOTexel - 0.5;
  vec2 base = floor(f);
  vec2 frac = f - base;
  vec4 acc = vec4(0.0);
  float wsum = 0.0;
  for (int j = 0; j < 2; j++) {
    for (int i = 0; i < 2; i++) {
      vec2 corner = vec2(float(i), float(j));
      vec2 tuv = (base + corner + 0.5) * uAOTexel;
      float bw = (i == 0 ? 1.0 - frac.x : frac.x) * (j == 0 ? 1.0 - frac.y : frac.y);
      float zs = linearZ(readDepth(tuv));
      float w = bw / (1.0 + abs(zs - zc) / (zc * uTolerance + 0.02));
      acc += texture2D(uAO, tuv) * w;
      wsum += w;
    }
  }
  vec4 ao4 = wsum > 1e-5 ? acc / wsum : texture2D(uAO, uv);

  float vis = clamp(ao4.r, 0.0, 1.0);
  float contact = clamp(ao4.g, 0.0, 1.0);
  float skyShare = clamp(ao4.b, 0.0, 1.0);

  // --- normalise the estimator's unoccluded plateau to exactly 1 ----------
  // This is the round-7 fix and it is load bearing. The horizon search returns
  // ~0.965, not 1.0, on flat open ground (finite steps + the minimum tap
  // distance grazing the surface itself). Left in, that bias becomes a uniform
  // multiply over the *whole frame*, and AutoExposurePass — nine passes
  // downstream — meters the darkened result and gives every bit of it straight
  // back as exposure. Measured: with AO enabled, 62% of hero-overcast got
  // BRIGHTER. Dividing the plateau out costs nothing in the crevices and makes
  // the term purely local, which is the only form of it the meter cannot undo.
  float visN = clamp(vis / max(uOpenLevel, 1e-3), 0.0, 1.0);

  vec3 p = viewFromDepthLocal(uv, depth, uInvProjection);
  vec3 n = reconstructNormal(uv, p);
  float ndl = clamp(dot(n, uSunView), 0.0, 1.0);

  if (uDebug > 0.5 && uDebug < 4.5) {
    if (uDebug < 1.5) { outputColor = vec4(vec3(vis), 1.0); return; }
    if (uDebug < 2.5) { outputColor = vec4(vec3(contact), 1.0); return; }
    if (uDebug < 3.5) { outputColor = vec4(vec3(skyShare), 1.0); return; }
    outputColor = vec4(n * 0.5 + 0.5, 1.0);
    return;
  }
  if (uDebug > 5.5 && uDebug < 6.5) { outputColor = vec4(vec3(visN), 1.0); return; }
  if (uDebug > 6.5) { outputColor = vec4(vec3(uDirectShare), 1.0); return; }

  // --- shaping + bent-normal weighting ------------------------------------
  // The power shapes the normalised term: open ground is pinned at 1 by the
  // division above, so this only redistributes contrast inside the occluded
  // range (0.75^2 = 0.56, 0.55^2 = 0.30) instead of dimming the whole image.
  float shaped = pow(visN, uPower);

  // The sky is the dominant ambient source, so a pixel whose average unoccluded
  // direction has swung *downward* has lost more irradiance than the scalar
  // visibility alone implies. This is where the bent normal earns its keep.
  float occAmount = (1.0 - shaped) * uIntensity * mix(1.0 + uSkyBias, 1.0, skyShare);
  float ao = clamp(1.0 - occAmount, 0.0, 1.0);

  // --- multi-bounce, hue preserving --------------------------------------
  // Applied at uMultiBounce strength, not fully: the remap is physically right
  // for a diffuse interreflection estimate and visually far too generous here,
  // because it is fitted for a term that reaches genuine zero in a corner and
  // ours bottoms out around 0.2.
  float lum = max(dot(inputColor.rgb, vec3(0.2126, 0.7152, 0.0722)), 1e-4);
  vec3 albedo = clamp(inputColor.rgb / lum * 0.42, vec3(0.02), vec3(1.0));
  vec3 aoRGB = mix(vec3(ao), multiBounce(ao, albedo), uMultiBounce);

  // A floor on the occluded colour: crevices lose the sky, they do not become
  // holes punched in the frame.
  aoRGB = mix(uOccludedTint, vec3(1.0), aoRGB);

  // --- ambient share ------------------------------------------------------
  // directMask is pure geometry: it knows the angle to the sun, not whether
  // the sun is delivering anything. Scaling by the frame's measured direct
  // share is what makes this correct under overcast and at night, where the
  // key light contributes essentially nothing and *all* of the illumination is
  // ambient — so all of it must take the occlusion. Without the scale this term
  // stripped 70% of the AO out of the one preset that is pure sky ambient.
  float directMask = ndl * contact * uDirectShare;
  float ambientShare = clamp(1.0 - uProtect * directMask, 0.0, 1.0);
  vec3 occlusion = mix(vec3(1.0), aoRGB, ambientShare);

  // --- contact shadow attenuates DIRECT light ----------------------------
  // Gated by the same share: with no sun there is no direct light for a contact
  // shadow to remove, and applying it anyway would darken pure ambient — which
  // is the "AO as dirt" failure this whole split exists to avoid.
  float direct = mix(1.0, contact, clamp(ndl * 1.35, 0.0, 1.0) * uDirectShare);

  // Mode 5 is the multiplier that actually reaches the image — the one number
  // worth grading, because a healthy visibility integral says nothing about
  // what survives the shaping, the multi-bounce remap and the ambient split.
  if (uDebug > 4.5) {
    outputColor = vec4(occlusion * direct, 1.0);
    return;
  }

  outputColor = vec4(inputColor.rgb * occlusion * direct, inputColor.a);
}
`;

export class AOApplyEffect extends Effect {
  /**
   * @param {THREE.Camera} camera the world camera
   * @param {import('./GTAOPass.js').GTAOPass} pass the occlusion producer
   */
  constructor(camera, pass) {
    super('AOApplyEffect', fragmentShader, {
      blendFunction: BlendFunction.SRC,
      attributes: EffectAttribute.DEPTH,
      uniforms: new Map([
        ['uAO', new THREE.Uniform(null)],
        ['uAOTexel', new THREE.Uniform(new THREE.Vector2(1, 1))],
        ['uInvProjection', new THREE.Uniform(new THREE.Matrix4())],
        ['uSunView', new THREE.Uniform(new THREE.Vector3(0.3, 0.9, 0.3))],
        ['uIntensity', new THREE.Uniform(GTAO.intensity)],
        ['uPower', new THREE.Uniform(GTAO.power)],
        ['uMultiBounce', new THREE.Uniform(GTAO.multiBounce)],
        ['uProtect', new THREE.Uniform(GTAO.directProtect)],
        ['uDirectShare', new THREE.Uniform(1)],
        ['uOpenLevel', new THREE.Uniform(GTAO.openLevel)],
        ['uTolerance', new THREE.Uniform(GTAO.upsampleTolerance)],
        ['uOccludedTint', new THREE.Uniform(new THREE.Vector3(...GTAO.occludedTint))],
        ['uSkyBias', new THREE.Uniform(GTAO.skyBias)],
        ['uDebug', new THREE.Uniform(0)],
      ]),
    });

    this.camera = camera;
    this.aoPass = pass;
  }

  set mainCamera(value) {
    this.camera = value;
  }

  /** Called by EffectPass once per frame, after GTAOPass has produced this frame. */
  update() {
    const u = this.uniforms;
    u.get('uInvProjection').value.copy(this.camera.projectionMatrixInverse);
    // The occlusion buffer ping-pongs, so the binding has to be refreshed.
    u.get('uAO').value = this.aoPass.texture;
    u.get('uAOTexel').value.set(1 / this.aoPass.halfWidth, 1 / this.aoPass.halfHeight);
  }

  set sunView(v) {
    this.uniforms.get('uSunView').value.copy(v);
  }

  /**
   * Fraction of this frame's illumination arriving as direct sun, 0..1.
   * Derived by PostFX from the live light rig — see `PostFX._updateSun`.
   * Drives both the ambient/direct split and the contact shadow's authority.
   */
  set directShare(v) {
    this.uniforms.get('uDirectShare').value = v;
  }

  set debug(mode) {
    this.uniforms.get('uDebug').value = mode;
  }
}
