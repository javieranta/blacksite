import * as THREE from 'three';
import { Effect, EffectAttribute, BlendFunction } from 'postprocessing';
import { FIREFLY } from './PostConstants.js';

/**
 * OWNER: postfx agent.
 *
 * Neighbourhood luminance clamp — the spatial half of specular antialiasing.
 *
 * ── The problem this solves ─────────────────────────────────────────────────
 * A specular lobe narrower than a pixel produces texels one to three orders of
 * magnitude above the surface they sit on. Two mechanisms in this chain that
 * look like they should catch it do not:
 *
 *   • **TAA's variance clip cannot.** The clip box is built from the 3×3
 *     neighbourhood of the *current* frame, which contains the firefly, so the
 *     firefly widens its own box. TAA clips history against the current frame,
 *     never the current frame against anything.
 *
 *   • **The weapon is not temporally filtered at all.** ViewModelPass composites
 *     the viewmodel *after* the TAA resolve, because the weapon moves with the
 *     camera and camera motion vectors would ghost it across the screen. That is
 *     the right call, and it is why the densest speckle in the combat capture is
 *     on the gun rather than on the world behind it.
 *
 * ── ROUND 6 ROOT CAUSE: why the round-5 version removed nothing ─────────────
 * Two independent reasons, both fatal on their own.
 *
 *   1. **The floor was above the signal.** `FIREFLY.floor` was 1.6 in
 *      scene-referred linear, i.e. roughly eight times middle grey, on the
 *      reasoning that anything dimmer "is a light source, not a firefly". A
 *      `?fireflydebug=1` capture of the combat frame measures the speckle on the
 *      receiver in the **0.15–0.4** band against a 0.055 base — it is a *dark*
 *      surface catching an 11°-elevation sun, so the aliased texels are bright
 *      *relative to their neighbours* and nowhere near bright in absolute terms.
 *      For scale, sunlit concrete in the same frame measures 0.125. Every
 *      speckle pixel took the `l <= uFloor` early-out: the pass ran, and did
 *      nothing.
 *
 *   2. **The estimator assumed isolated pixels.** The ceiling was
 *      `neighbourMax · ratio`. Aliased speculars on a normal-mapped surface do
 *      not arrive one pixel at a time; they arrive as a *dither field* of
 *      touching one- and two-pixel clusters. A firefly whose neighbour is
 *      another firefly raises its own ceiling — max over the neighbourhood is
 *      the one statistic guaranteed to be contaminated by the outlier being
 *      tested for.
 *
 * ── The estimator ───────────────────────────────────────────────────────────
 * A real specular highlight is *continuous*: the BRDF lobe spans several pixels,
 * so a genuinely bright pixel is bright along at least one direction through
 * itself. An aliased one is not. So the support for a pixel is
 *
 *     support = max over the 4 axes d of
 *                 min( luma(p±1·d), luma(p±2·d) )        — all four taps
 *
 * — a morphological opening with five-pixel line structuring elements, and the
 * classic despeckle that keeps thin features. A one-pixel-wide *line* — a rail
 * highlight, the rim on a barrel, a tracer — runs unbroken through all four taps
 * on its own axis, so its support is high and it survives untouched. So does any
 * highlight five pixels or more across, in every direction.
 *
 * The ±2 taps are what make this work on the actual defect. At radius 1 alone,
 * two touching fireflies support each other: measured on the combat frame, a
 * radius-1 opening fired on 0.9% of the receiver while 13% of it was speckle,
 * because aliased speculars on a normal-mapped surface arrive as a dither field
 * of one- and two-pixel *clusters*, not as isolated texels. Requiring continuity
 * over five pixels is what separates a cluster from a feature.
 *
 * `keep` blends a little of the plain neighbourhood max back in as headroom. It
 * has to stay small: in a dither field the max is another firefly.
 *
 *     ceiling = max(floor, mix(support, neighbourMax, keep) · ratio)
 *     if (luma > ceiling) rgb *= ceiling / luma
 *
 * The scale is applied to all three channels, so hue and saturation survive and
 * only magnitude is capped. Because the ceiling tracks the neighbourhood rather
 * than being absolute, a real blown highlight — sun disc, muzzle flash core,
 * lamp filament — is untouched: all of its neighbours are blown too.
 *
 * ── Placement ───────────────────────────────────────────────────────────────
 * After ViewModelPass, before AutoExposurePass and bloom. That single position
 * covers all three requirements at the cost of one pass: the weapon is in the
 * buffer by then, the world's residual post-TAA fireflies are too, and bloom
 * downstream can no longer be handed a lone 400-radiance texel to smear across
 * six mip levels.
 */
const fragmentShader = /* glsl */ `
uniform float uRatio;
uniform float uFloor;
uniform float uKeep;
uniform float uDebug;
uniform float uDebugScale;

float lum(const in vec3 c) { return dot(max(c, vec3(0.0)), vec3(0.2126, 0.7152, 0.0722)); }

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 c = max(inputColor.rgb, vec3(0.0));
  float l = lum(c);

  // Below the floor the ceiling cannot be lower than the sample, so the result
  // is the input by construction. Skips most of the frame.
  if (l <= uFloor && uDebug < 0.5) {
    outputColor = inputColor;
    return;
  }

  vec2 tx = vec2(texelSize.x, 0.0);
  vec2 ty = vec2(0.0, texelSize.y);

  float support = 0.0;
  float nmax = 0.0;
  // The four axes: horizontal, vertical and the two diagonals, each sampled at
  // ±1 and ±2 texels. d is the axis step.
  for (int a = 0; a < 4; a++) {
    vec2 d = a == 0 ? tx : (a == 1 ? ty : (a == 2 ? tx + ty : tx - ty));
    float p1 = lum(texture2D(inputBuffer, uv + d).rgb);
    float m1 = lum(texture2D(inputBuffer, uv - d).rgb);
    float p2 = lum(texture2D(inputBuffer, uv + d * 2.0).rgb);
    float m2 = lum(texture2D(inputBuffer, uv - d * 2.0).rgb);
    support = max(support, min(min(p1, m1), min(p2, m2)));
    nmax = max(nmax, max(p1, m1));
  }

  float ceiling = max(uFloor, mix(support, nmax, uKeep) * uRatio);
  float scale = l > ceiling ? ceiling / max(l, 1e-5) : 1.0;

  if (uDebug > 0.5) {
    if (uDebug < 1.5) { outputColor = vec4(vec3(l / uDebugScale), 1.0); return; }
    // 2 — what the clamp removed. Red is the fraction of luminance taken out,
    // green is the ceiling, so a dead pass reads as flat black.
    if (uDebug < 2.5) { outputColor = vec4(1.0 - scale, ceiling / uDebugScale, 0.0, 1.0); return; }
    outputColor = vec4(vec3(support / uDebugScale), 1.0);
    return;
  }

  outputColor = vec4(c * scale, inputColor.a);
}
`;

export class FireflyClampEffect extends Effect {
  constructor() {
    super('FireflyClampEffect', fragmentShader, {
      blendFunction: BlendFunction.SRC,
      // CONVOLUTION forces postprocessing to give this effect its own pass with
      // an untouched inputBuffer — the neighbourhood taps have to read the same
      // buffer the centre sample came from.
      attributes: EffectAttribute.CONVOLUTION,
      uniforms: new Map([
        ['uRatio', new THREE.Uniform(FIREFLY.ratio)],
        ['uFloor', new THREE.Uniform(FIREFLY.floor)],
        ['uKeep', new THREE.Uniform(FIREFLY.keep)],
        ['uDebug', new THREE.Uniform(0)],
        ['uDebugScale', new THREE.Uniform(FIREFLY.debugScale)],
      ]),
    });
  }

  /** @param {number} v ceiling as a multiple of the supported neighbourhood. */
  set ratio(v) {
    this.uniforms.get('uRatio').value = v;
  }

  /** @param {number} v scene-linear luminance below which the clamp never acts. */
  set floor(v) {
    this.uniforms.get('uFloor').value = v;
  }

  /**
   * @param {0|1|2|3} mode 0 off · 1 scene luminance / debugScale ·
   *   2 removed fraction (red) + ceiling (green) · 3 the line support
   */
  set debug(mode) {
    this.uniforms.get('uDebug').value = mode;
  }
}
