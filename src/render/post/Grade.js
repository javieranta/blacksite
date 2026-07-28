import * as THREE from 'three';

/**
 * OWNER: postfx agent.
 *
 * Procedural colour-grade LUTs. Zero external assets: every look is evaluated
 * on the CPU into a 32³ cube, packed as a 1024×32 slice-strip RGBA8 texture and
 * sampled with manual trilinear interpolation in the shader (WebGL2 running
 * GLSL ES 1.00 through postprocessing's EffectMaterial has no sampler3D, so a
 * strip is the correct encoding, not a compromise).
 *
 * The LUT operates in display-referred sRGB space — i.e. *after* ACES. That is
 * where 8 bits per channel is perceptually adequate and where every real
 * grading tool works.
 *
 * The grade itself is an ASC-style lift / gamma / gain rig. That choice is the
 * fix for the "flat global tint" defect: a single per-channel multiply applied
 * to the whole signal warms a shadow by exactly the same ratio as it warms the
 * sun, which is what makes a frame read as an orange sheet of acetate. Lift and
 * gain are anchored at opposite ends of the curve, so
 *
 *     c → (gain − lift)·c + lift
 *
 * maps black to `lift` and white to `gain` and *cannot* apply the same tint to
 * both. Gamma then trims the midtones without moving either endpoint.
 */

export const LUT_SIZE = 32;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Rec.709 luma — the weighting a colourist expects. */
const luma = (r, g, b) => r * 0.2126 + g * 0.7152 + b * 0.0722;

const smoothstep = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

/**
 * Evaluates one grade sample. `out` is a 3-element array, mutated in place.
 * Input and output are display-referred sRGB in [0,1].
 */
function gradeSample(out, r, g, b, p) {
  // 1. Lift / gain — the tonal separation. Black lands on `lift`, white on
  //    `gain`, and every value between is interpolated, so a warm gain leaves
  //    the shadows alone and a cool lift leaves the highlights alone.
  let c0 = (p.gain[0] - p.lift[0]) * r + p.lift[0];
  let c1 = (p.gain[1] - p.lift[1]) * g + p.lift[1];
  let c2 = (p.gain[2] - p.lift[2]) * b + p.lift[2];

  // 2. Gamma — midtone balance only; endpoints are fixed points of a power.
  c0 = Math.pow(Math.max(c0, 0), 1 / p.gamma[0]);
  c1 = Math.pow(Math.max(c1, 0), 1 / p.gamma[1]);
  c2 = Math.pow(Math.max(c2, 0), 1 / p.gamma[2]);

  // 3. Contrast about a pivot.
  c0 = Math.max((c0 - p.pivot) * p.contrast + p.pivot, 0);
  c1 = Math.max((c1 - p.pivot) * p.contrast + p.pivot, 0);
  c2 = Math.max((c2 - p.pivot) * p.contrast + p.pivot, 0);

  // 4. A soft toe so contrast cannot flatten the low end into a hard step.
  if (p.toe > 0) {
    const toe = p.toe;
    if (c0 < toe) c0 = toe * Math.pow(c0 / toe, 0.72);
    if (c1 < toe) c1 = toe * Math.pow(c1 / toe, 0.72);
    if (c2 < toe) c2 = toe * Math.pow(c2 / toe, 0.72);
  }

  // 5. Split tone — a second, *banded* colour move on top of lift/gain. Where
  //    lift/gain shape the ends of the curve, this reaches the midtones from
  //    both sides, which is what gives a grade its "authored" feel.
  const l = luma(c0, c1, c2);
  const sw = (1 - smoothstep(0.0, 0.46, l)) * p.shadowAmt;
  const hw = smoothstep(0.48, 1.0, l) * p.highAmt;
  c0 = Math.max(c0 + p.shadowTint[0] * sw + p.highTint[0] * hw, 0);
  c1 = Math.max(c1 + p.shadowTint[1] * sw + p.highTint[1] * hw, 0);
  c2 = Math.max(c2 + p.shadowTint[2] * sw + p.highTint[2] * hw, 0);

  // 6. Saturation, banded by luminance. Real film loses chroma at both ends:
  //    shadows go toward neutral, highlights bleach toward the light source.
  const l2 = luma(c0, c1, c2);
  const band = smoothstep(0.0, 0.42, l2);
  const bandHi = smoothstep(0.55, 1.0, l2);
  const sat = p.satShadow + (p.satMid - p.satShadow) * band + (p.satHigh - p.satMid) * bandHi;
  c0 = Math.max(l2 + (c0 - l2) * sat, 0);
  c1 = Math.max(l2 + (c1 - l2) * sat, 0);
  c2 = Math.max(l2 + (c2 - l2) * sat, 0);

  // 7. Highlight crosstalk — a path to white. Without it a saturated warm
  //    highlight clips one channel at a time and turns into a hard orange
  //    plateau; with it, energy leaks between channels as it approaches the
  //    top of the range, exactly like a film emulsion.
  if (p.crosstalk > 0) {
    const t = smoothstep(0.62, 1.0, luma(c0, c1, c2)) * p.crosstalk;
    const mx = Math.max(c0, Math.max(c1, c2));
    c0 += (mx - c0) * t;
    c1 += (mx - c1) * t;
    c2 += (mx - c2) * t;
  }

  // 8. The black point comes LAST, deliberately.
  //
  //    Applying it early lets a later subtractive shadow tint or a contrast
  //    stretch drive channels straight back through zero, which is precisely
  //    how a frame ends up with large regions of literal #000. As the final
  //    operation, `bp + c*(1-bp)` is a hard guarantee: nothing in the image can
  //    be darker than the black point, and white stays white. It is kept small
  //    (~0.010–0.016) so shadows stay deep rather than washing out.
  const bp = p.blackPoint;
  c0 = bp + c0 * (1 - bp);
  c1 = bp + c1 * (1 - bp);
  c2 = bp + c2 * (1 - bp);

  out[0] = clamp01(c0);
  out[1] = clamp01(c1);
  out[2] = clamp01(c2);
}

/**
 * Bakes a grade into a slice-strip DataTexture.
 * Layout: width = SIZE*SIZE, height = SIZE. Slice k (blue) occupies columns
 * [k*SIZE, (k+1)*SIZE); red runs along x within a slice, green along y.
 *
 * @param {object} params grade parameters (see PostConstants LOOKS[*].grade)
 * @returns {THREE.DataTexture}
 */
export function buildGradeLUT(params) {
  const N = LUT_SIZE;
  const w = N * N;
  const h = N;
  const data = new Uint8Array(w * h * 4);
  const out = [0, 0, 0];
  const inv = 1 / (N - 1);

  for (let bi = 0; bi < N; bi++) {
    const b = bi * inv;
    const colBase = bi * N;
    for (let gi = 0; gi < N; gi++) {
      const g = gi * inv;
      const rowBase = gi * w;
      for (let ri = 0; ri < N; ri++) {
        gradeSample(out, ri * inv, g, b, params);
        const o = (rowBase + colBase + ri) * 4;
        data[o] = (out[0] * 255 + 0.5) | 0;
        data[o + 1] = (out[1] * 255 + 0.5) | 0;
        data[o + 2] = (out[2] * 255 + 0.5) | 0;
        data[o + 3] = 255;
      }
    }
  }

  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.NoColorSpace;
  tex.flipY = false;
  tex.needsUpdate = true;
  tex.name = 'PostFX.GradeLUT';
  return tex;
}

/** GLSL for sampling the strip. Uses only GLSL ES 1.00 features. */
export const LUT_GLSL = /* glsl */ `
vec3 sampleStripLUT(const in sampler2D lut, const in vec3 c, const in float N) {
  vec3 q = clamp(c, 0.0, 1.0);
  float inv = 1.0 / N;
  float maxIdx = N - 1.0;
  float zs = q.b * maxIdx;
  float z0 = floor(zs);
  float z1 = min(z0 + 1.0, maxIdx);
  float zf = zs - z0;
  float xin = (0.5 + q.r * maxIdx) * inv;
  float v   = (0.5 + q.g * maxIdx) * inv;
  vec3 s0 = texture2D(lut, vec2((z0 + xin) * inv, v)).rgb;
  vec3 s1 = texture2D(lut, vec2((z1 + xin) * inv, v)).rgb;
  return mix(s0, s1, zf);
}
`;
