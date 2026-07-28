/**
 * Deterministic randomness + value noise for the prop generators.
 * OWNER: props agent.
 *
 * Everything the prop library produces is a pure function of a seed, so a given
 * castle of clutter is reproducible frame to frame and shot to shot. No use of
 * Math.random anywhere in the prop pipeline.
 */

const U32 = 4294967296;

export class Rand {
  constructor(seed = 0x9e3779b9) {
    this.s = (seed | 0) || 0x6d2b79f5;
  }

  /** xorshift32 — fast, good enough for art placement, fully deterministic. */
  next() {
    let x = this.s;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.s = x | 0;
    return (x >>> 0) / U32;
  }

  range(a, b) { return a + (b - a) * this.next(); }
  int(a, b) { return a + Math.floor(this.next() * (b - a + 1)); }
  bool(p = 0.5) { return this.next() < p; }
  sign() { return this.next() < 0.5 ? -1 : 1; }
  pick(arr) { return arr[Math.min(arr.length - 1, (this.next() * arr.length) | 0)]; }

  /** Sum-of-uniforms approximation of a normal distribution, mean 0, sd ~1. */
  gauss() {
    return (this.next() + this.next() + this.next() + this.next() - 2) * 1.1547;
  }

  /** Signed jitter in [-a, a]. */
  jit(a) { return (this.next() * 2 - 1) * a; }

  /** Deterministic child stream so sub-generators do not consume parent entropy. */
  fork(salt = 0) {
    return new Rand((this.s ^ Math.imul(salt + 1, 0x9e3779b1)) | 0);
  }

  /** Shuffle in place (Fisher-Yates). */
  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = (this.next() * (i + 1)) | 0;
      const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }
}

/* ---------------------------------------------------------------------------
 * Hash + value noise. Used for texture height fields and for dents/warping on
 * geometry. Tileable so textures wrap without a seam.
 * ------------------------------------------------------------------------- */

export function hash2(x, y, seed) {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x85ebca6b) ^ Math.imul(seed | 0, 0xc2b2ae35);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12; h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / U32;
}

export function hash3(x, y, z, seed) {
  return hash2(Math.imul(x | 0, 73856093) ^ Math.imul(z | 0, 19349663), y | 0, seed);
}

const smooth = (t) => t * t * (3 - 2 * t);

/** Tileable value noise on an integer lattice of `period` cells. */
export function vnoise(x, y, period, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const wrap = (v) => ((v % period) + period) % period;
  const x0 = wrap(xi), y0 = wrap(yi), x1 = wrap(xi + 1), y1 = wrap(yi + 1);
  const a = hash2(x0, y0, seed), b = hash2(x1, y0, seed);
  const c = hash2(x0, y1, seed), d = hash2(x1, y1, seed);
  const u = smooth(xf), v = smooth(yf);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

/**
 * Tileable fBm height field.
 * @returns {Float32Array} size*size values, normalised to [0,1].
 */
export function fbmField(size, {
  octaves = 5, baseFreq = 4, gain = 0.5, lacunarity = 2, seed = 1, ridged = false,
} = {}) {
  const out = new Float32Array(size * size);
  let lo = Infinity, hi = -Infinity;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let amp = 1, freq = baseFreq, sum = 0, norm = 0;
      for (let o = 0; o < octaves; o++) {
        let n = vnoise((x / size) * freq, (y / size) * freq, freq, seed + o * 977);
        if (ridged) n = 1 - Math.abs(n * 2 - 1);
        sum += n * amp;
        norm += amp;
        amp *= gain;
        freq *= lacunarity;
      }
      const v = sum / norm;
      out[y * size + x] = v;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  const inv = hi > lo ? 1 / (hi - lo) : 1;
  for (let i = 0; i < out.length; i++) out[i] = (out[i] - lo) * inv;
  return out;
}

/** Cellular / worley-ish field — good for gravel, chipped concrete, rust blooms. */
export function cellField(size, { cells = 8, seed = 3, invert = false } = {}) {
  const pts = new Float32Array(cells * cells * 2);
  for (let cy = 0; cy < cells; cy++) {
    for (let cx = 0; cx < cells; cx++) {
      const i = (cy * cells + cx) * 2;
      pts[i] = (cx + hash2(cx, cy, seed)) / cells;
      pts[i + 1] = (cy + hash2(cx, cy, seed + 51)) / cells;
    }
  }
  const out = new Float32Array(size * size);
  const step = 1 / cells;
  let hi = 0;
  for (let y = 0; y < size; y++) {
    const py = y / size;
    for (let x = 0; x < size; x++) {
      const px = x / size;
      const cx = Math.floor(px / step), cy = Math.floor(py / step);
      let best = 4;
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const gx = ((cx + ox) % cells + cells) % cells;
          const gy = ((cy + oy) % cells + cells) % cells;
          const i = (gy * cells + gx) * 2;
          let dx = pts[i] + ox * (cx + ox < 0 ? 0 : 0) - px;
          let dy = pts[i + 1] - py;
          // wrap deltas for tileability
          if (dx > 0.5) dx -= 1; else if (dx < -0.5) dx += 1;
          if (dy > 0.5) dy -= 1; else if (dy < -0.5) dy += 1;
          const d = dx * dx + dy * dy;
          if (d < best) best = d;
        }
      }
      const v = Math.sqrt(best) * cells;
      out[y * size + x] = v;
      if (v > hi) hi = v;
    }
  }
  const inv = hi > 0 ? 1 / hi : 1;
  for (let i = 0; i < out.length; i++) {
    const v = Math.min(1, out[i] * inv);
    out[i] = invert ? 1 - v : v;
  }
  return out;
}

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
