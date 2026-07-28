/**
 * OWNER: material-forge agent.
 *
 * Wrapped procedural noise primitives for the texture bake. Every function is
 * periodic on the unit tile (integer cell counts, `wrap`ped lattice lookups) so
 * every map that comes out of the foundry tiles seamlessly.
 *
 * Pure arithmetic — no canvas, no images, no downloads. Nothing here imports
 * three, which also makes the whole layer testable in bare node.
 */

/* ------------------------------------------------------------------ scalar --- */

export const wrap = (a, b) => ((a % b) + b) % b;
export const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const lerp = (a, b, t) => a + (b - a) * t;
const fade = (t) => t * t * (3 - 2 * t);

export function smoothstep(e0, e1, x) {
  const t = clamp01((x - e0) / (e1 - e0 || 1e-6));
  return t * t * (3 - 2 * t);
}

/** 32-bit integer hash -> [0,1). The backbone of every field below. */
export function hash2(ix, iy, seed) {
  let h = Math.imul(ix | 0, 374761393) ^ Math.imul(iy | 0, 668265263) ^ Math.imul(seed | 0, 362437);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** One-dimensional convenience hash — per-row, per-panel, per-plank seeds. */
export function hash1(i, seed) {
  return hash2(i, 0x5bf0, seed);
}

/* ------------------------------------------------------------------- noise --- */

/**
 * Value noise on a lattice wrapping at (fx, fy) cells across the unit tile.
 * Independent frequencies per axis let a pattern be stretched — grain, board
 * marks, run-off streaks — without breaking the wrap.
 */
export function vnoise(u, v, fx, fy, seed) {
  const x = u * fx, y = v * fy;
  const ix = Math.floor(x), iy = Math.floor(y);
  const sx = fade(x - ix), sy = fade(y - iy);
  const x0 = wrap(ix, fx), x1 = wrap(ix + 1, fx);
  const y0 = wrap(iy, fy), y1 = wrap(iy + 1, fy);
  const n00 = hash2(x0, y0, seed), n10 = hash2(x1, y0, seed);
  const n01 = hash2(x0, y1, seed), n11 = hash2(x1, y1, seed);
  return lerp(lerp(n00, n10, sx), lerp(n01, n11, sx), sy);
}

/** Fractal sum. Frequencies stay integral so every octave still wraps. */
export function fbm(u, v, fx, fy, oct, seed, gain = 0.5) {
  let amp = 1, sum = 0, norm = 0, ax = fx, ay = fy;
  for (let i = 0; i < oct; i++) {
    sum += amp * vnoise(u, v, ax, ay, seed + i * 1013);
    norm += amp;
    amp *= gain;
    ax = Math.max(1, Math.round(ax * 2));
    ay = Math.max(1, Math.round(ay * 2));
  }
  return sum / norm;
}

/** Ridged fractal — cracks, rust fronts, spall edges. */
export function ridged(u, v, fx, fy, oct, seed) {
  let amp = 1, sum = 0, norm = 0, ax = fx, ay = fy;
  for (let i = 0; i < oct; i++) {
    const n = 1 - Math.abs(vnoise(u, v, ax, ay, seed + i * 733) * 2 - 1);
    sum += amp * n * n;
    norm += amp;
    amp *= 0.5;
    ax = Math.max(1, Math.round(ax * 2));
    ay = Math.max(1, Math.round(ay * 2));
  }
  return sum / norm;
}

/**
 * Scattered discs — sparse features on a matrix: bug holes, pits, spilled
 * gravel. Returns peak 1 at a disc centre, 0 outside every disc.
 */
export function grains(u, v, cells, seed, radius = 0.42) {
  const x = u * cells, y = v * cells;
  const ix = Math.floor(x), iy = Math.floor(y);
  let best = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cx = wrap(ix + dx, cells), cy = wrap(iy + dy, cells);
      const r = radius * (0.45 + 0.55 * hash2(cx, cy, seed + 13));
      const px = ix + dx + hash2(cx, cy, seed), py = iy + dy + hash2(cx, cy, seed + 7);
      const ex = x - px, ey = y - py;
      const d2 = ex * ex + ey * ey;
      if (d2 < r * r) {
        const t = 1 - Math.sqrt(d2) / r;
        if (t > best) best = t;
      }
    }
  }
  return best;
}

/* ------------------------------------------------------------------ stones --- */

const ST = { id: 0, edge: 0, dome: 0, f1: 0 };

/**
 * A partitioning stone field — the honest way to build aggregate. Unlike
 * `grains`, every texel belongs to *some* stone, so the surface reads as packed
 * crushed rock in a thin binder rather than confetti on a slab. `angular`
 * blends each cell between a euclidean (rounded gravel) and a chebyshev
 * (fractured, faceted) metric.
 *
 * Returns a shared scratch record — read the fields before the next call.
 *   id    per-stone random, for value/hue jitter
 *   edge  F2-F1: 0 exactly on a stone boundary, ~0.5 mid-stone
 *   dome  1 at the stone's centre falling to 0 at its rim, for height
 */
export function stones(u, v, cells, seed, angular = 0.5) {
  const x = u * cells, y = v * cells;
  const ix = Math.floor(x), iy = Math.floor(y);
  let f1 = 1e9, f2 = 1e9, id = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cx = wrap(ix + dx, cells), cy = wrap(iy + dy, cells);
      const ex = x - (ix + dx + hash2(cx, cy, seed));
      const ey = y - (iy + dy + hash2(cx, cy, seed + 71));
      const eu = Math.sqrt(ex * ex + ey * ey);
      const ax = ex < 0 ? -ex : ex, ay = ey < 0 ? -ey : ey;
      const ch = (ax > ay ? ax : ay) * 1.16;
      const d = eu + (ch - eu) * (angular * hash2(cx, cy, seed + 211));
      if (d < f1) { f2 = f1; f1 = d; id = hash2(cx, cy, seed + 137); }
      else if (d < f2) f2 = d;
    }
  }
  ST.id = id;
  ST.edge = f2 - f1;
  ST.f1 = f1;
  ST.dome = clamp01(1 - (2 * f1) / (f1 + f2 + 1e-4));
  return ST;
}

/* ----------------------------------------------------------------- profile --- */

/**
 * A recessed joint / groove profile across a distance-to-line coordinate.
 *   d     distance from the line centre, same units as `gap`/`cham`
 *   gap   half-width of the flat bottom of the recess
 *   cham  half-width where the chamfer meets the face
 * Returns 1 in the bottom of the recess falling smoothly to 0 on the face — so
 * it drives depth, darkening and occlusion from one term.
 */
export function groove(d, gap, cham) {
  if (d >= cham) return 0;
  if (d <= gap) return 1;
  return 1 - smoothstep(gap, cham, d);
}

/** Distance from x to the nearest integer multiple of 1 (period-1 line grid). */
export function toLine(x) {
  const f = x - Math.floor(x);
  return f < 0.5 ? f : 1 - f;
}
