/**
 * OWNER: material-forge agent.
 *
 * Mip-chain construction with roughness regularisation.
 *
 * ## Why this file exists
 *
 * `gl.generateMipmap` is a box filter that knows nothing about what it is
 * filtering. On a normal map that is actively wrong: averaging four unit normals
 * gives a vector *shorter* than one, the driver stores the shortened result
 * (renormalised on sample, so the shortening is silently discarded) and the
 * variance those four normals carried is thrown away. The surface keeps its
 * mip-0 roughness while its normal distribution gets wider and wider with
 * distance, and a wide normal distribution under a narrow specular lobe is
 * exactly the definition of specular aliasing — the sparkling speckle on
 * handrails, catwalk lattice and pipework.
 *
 * So the chain is built here, on the CPU, and the lost variance is *paid back
 * into roughness*:
 *
 *   1. The normal chain is accumulated as an **unnormalised running mean** of
 *      the original unit normals. Mean-of-means equals mean over a uniform 2×2
 *      footprint, so `|acc|` at level k is the true average normal length over
 *      that level's footprint — variance accumulates instead of being reset at
 *      every level.
 *   2. `|acc|` is converted to a von Mises-Fisher concentration (Banerjee's
 *      estimator) and folded into the GGX width: `α'² = α² + 2/κ`. At `|acc|=1`
 *      this is a no-op, so mip 0 keeps every bit of its crispness; the widening
 *      only appears where the detail has genuinely been averaged away.
 *   3. A hard per-family roughness floor is applied at every level, because no
 *      surface carrying half-millimetre relief is physically a 0.12-roughness
 *      mirror.
 *
 * Albedo is averaged in **linear light** (decode → mean → encode). Box-filtering
 * sRGB-encoded bytes biases every mip dark, which is a second, quieter reason
 * distant surfaces lose contrast and go muddy.
 */

/* ------------------------------------------------------------ colour LUTs --- */

/** sRGB byte -> linear. Exact: the input domain is only 256 values wide. */
const DEC = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  DEC[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/**
 * linear -> sRGB byte. 8192 bins: the coarsest step this introduces is 0.8/255
 * in the near-black region where sRGB's slope is steepest, i.e. below the
 * quantisation of the 8-bit target it is writing into. A table because the
 * alternative is ~16M `Math.pow` calls per forge init.
 */
const ENC_BINS = 8192;
const ENC = new Uint8Array(ENC_BINS + 1);
for (let i = 0; i <= ENC_BINS; i++) {
  const l = i / ENC_BINS;
  const s = l <= 0.0031308 ? l * 12.92 : 1.055 * Math.pow(l, 1 / 2.4) - 0.055;
  ENC[i] = Math.round(Math.min(1, Math.max(0, s)) * 255);
}

/* ---------------------------------------------------------------- resample --- */

/** Level dimensions, GL's convention: `max(1, floor(base / 2^k))`. */
export function mipDims(size) {
  const dims = [];
  let w = size, h = size;
  for (;;) {
    dims.push([w, h]);
    if (w === 1 && h === 1) break;
    w = w > 1 ? w >> 1 : 1;
    h = h > 1 ? h >> 1 : 1;
  }
  return dims;
}

/** 2×2 box mean of an interleaved float buffer. Odd edges clamp, they do not wrap. */
function halveFloat(src, comps, sw, sh, dst, dw, dh) {
  for (let y = 0; y < dh; y++) {
    const y0 = Math.min(sh - 1, y * 2), y1 = Math.min(sh - 1, y * 2 + 1);
    for (let x = 0; x < dw; x++) {
      const x0 = Math.min(sw - 1, x * 2), x1 = Math.min(sw - 1, x * 2 + 1);
      const a = (y0 * sw + x0) * comps, b = (y0 * sw + x1) * comps;
      const c = (y1 * sw + x0) * comps, d = (y1 * sw + x1) * comps;
      const o = (y * dw + x) * comps;
      for (let k = 0; k < comps; k++) {
        dst[o + k] = (src[a + k] + src[b + k] + src[c + k] + src[d + k]) * 0.25;
      }
    }
  }
}

/** 2×2 box mean of an RGBA byte albedo, performed in linear light. */
function halveAlbedo(src, sw, sh, dst, dw, dh) {
  for (let y = 0; y < dh; y++) {
    const y0 = Math.min(sh - 1, y * 2), y1 = Math.min(sh - 1, y * 2 + 1);
    for (let x = 0; x < dw; x++) {
      const x0 = Math.min(sw - 1, x * 2), x1 = Math.min(sw - 1, x * 2 + 1);
      const a = (y0 * sw + x0) * 4, b = (y0 * sw + x1) * 4;
      const c = (y1 * sw + x0) * 4, d = (y1 * sw + x1) * 4;
      const o = (y * dw + x) * 4;
      for (let k = 0; k < 3; k++) {
        const lin = (DEC[src[a + k]] + DEC[src[b + k]] + DEC[src[c + k]] + DEC[src[d + k]]) * 0.25;
        dst[o + k] = ENC[(lin * ENC_BINS) | 0];
      }
      dst[o + 3] = 255;
    }
  }
}

/* ---------------------------------------------------------------- toksvig --- */

/**
 * Widen a GGX lobe by the normal variance implied by an average normal length.
 *
 *   κ = |N|(3 - |N|²) / (1 - |N|²)     vMF concentration, Banerjee 2005
 *   α'² = α² + 2s/κ                    variance addition, α = roughness²
 *
 * @param {number} rough    base roughness at this level
 * @param {number} len      |mean normal| over this level's footprint, 0..1
 * @param {number} strength scales how hard the variance is paid back
 * @param {number} cap      ceiling, so a noisy metal never goes fully lambertian
 */
export function widenRoughness(rough, len, strength, cap) {
  if (len >= 0.99995) return rough;
  const l2 = len * len;
  const kappa = (len * (3 - l2)) / Math.max(1e-4, 1 - l2);
  const a = rough * rough;
  const a2 = Math.sqrt(a * a + (2 * strength) / kappa);
  const r = Math.sqrt(a2);
  return r > cap ? cap : r;
}

/* ------------------------------------------------------------------ build --- */

/**
 * Build the three mip chains for one baked family.
 *
 * @param {object} p
 * @param {number} p.size        square edge of level 0
 * @param {Uint8Array|null} p.albedo  RGBA bytes, sRGB-encoded, level 0
 * @param {Float32Array} p.normal  interleaved unit normals (x,y,z), level 0
 * @param {Float32Array|null} p.orm  interleaved (ao, roughness, metalness), lvl 0
 * @param {number} [p.roughFloor] hard minimum roughness at every level
 * @param {number} [p.toksvig]  variance pay-back strength
 * @param {number} [p.roughCap] roughness ceiling for the widened result
 * @returns {{albedoMips:Array, normalMips:Array, ormMips:Array, avgLen:Float32Array}}
 */
export function buildChains({
  size, albedo, normal, orm,
  roughFloor = 0.0, toksvig = 1.0, roughCap = 0.96,
}) {
  const dims = mipDims(size);
  const albedoMips = [];
  const normalMips = [];
  const ormMips = [];
  const avgLen = new Float32Array(dims.length);

  let srcA = albedo, srcN = normal, srcO = orm;
  let sw = size, sh = size;

  for (let level = 0; level < dims.length; level++) {
    const [w, h] = dims[level];
    if (level > 0) {
      const nextN = new Float32Array(w * h * 3);
      halveFloat(srcN, 3, sw, sh, nextN, w, h);
      srcN = nextN;
      if (srcA) {
        const nextA = new Uint8Array(w * h * 4);
        halveAlbedo(srcA, sw, sh, nextA, w, h);
        srcA = nextA;
      }
      if (srcO) {
        const nextO = new Float32Array(w * h * 3);
        halveFloat(srcO, 3, sw, sh, nextO, w, h);
        srcO = nextO;
      }
      sw = w; sh = h;
    }

    // Encode this level. The normal is renormalised for storage, but its
    // pre-normalisation length is what drives the roughness of the same texel.
    const n = w * h;
    const nBytes = new Uint8Array(n * 4);
    const oBytes = srcO ? new Uint8Array(n * 4) : null;
    let lenSum = 0;
    for (let i = 0; i < n; i++) {
      const j = i * 3, k = i * 4;
      const nx = srcN[j], ny = srcN[j + 1], nz = srcN[j + 2];
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      lenSum += len;
      const inv = len > 1e-6 ? 1 / len : 0;
      nBytes[k] = (nx * inv * 0.5 + 0.5) * 255;
      nBytes[k + 1] = (ny * inv * 0.5 + 0.5) * 255;
      nBytes[k + 2] = len > 1e-6 ? (nz * inv * 0.5 + 0.5) * 255 : 255;
      nBytes[k + 3] = 255;

      if (!oBytes) continue;
      let r = srcO[j + 1];
      if (level > 0) r = widenRoughness(r, len > 1 ? 1 : len, toksvig, roughCap);
      if (r < roughFloor) r = roughFloor;
      oBytes[k] = srcO[j] * 255;
      oBytes[k + 1] = (r > 1 ? 1 : r) * 255;
      oBytes[k + 2] = srcO[j + 2] * 255;
      oBytes[k + 3] = 255;
    }
    avgLen[level] = lenSum / n;

    normalMips.push({ data: nBytes, width: w, height: h });
    if (srcA) albedoMips.push({ data: srcA, width: w, height: h });
    if (oBytes) ormMips.push({ data: oBytes, width: w, height: h });
  }

  return { albedoMips, normalMips, ormMips, avgLen };
}
