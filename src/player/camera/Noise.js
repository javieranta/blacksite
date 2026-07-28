/**
 * OWNER: camera-feel agent.
 *
 * Gradient (Perlin-style) 1-D noise for camera trauma. Per-frame `Math.random()`
 * is the wrong tool: consecutive frames are uncorrelated, so the eye reads it as
 * a rendering fault rather than force. Gradient noise is C¹-continuous, so the
 * camera *travels* — it accelerates, overshoots and settles.
 *
 * Three decorrelated lanes are enough for pitch/yaw/roll plus two translation
 * channels; they are just large offsets into the same 1-D field.
 *
 * Deterministic, table-driven, allocation-free.
 */

const SIZE = 1024;
const GRAD = new Float32Array(SIZE);

{
  // xorshift-ish integer hash — stable across runs, no Math.random anywhere.
  let a = 0x1f83d9ab >>> 0;
  for (let i = 0; i < SIZE; i++) {
    a = (a + 0x9e3779b9) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 16), 0x21f0aaad) >>> 0;
    t = Math.imul(t ^ (t >>> 15), 0x735a2d97) >>> 0;
    t = (t ^ (t >>> 15)) >>> 0;
    GRAD[i] = (t / 4294967296) * 2 - 1;
  }
}

const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);

/** Classic 1-D Perlin in roughly [-1, 1]. */
export function perlin1(x) {
  const i0 = Math.floor(x);
  const t = x - i0;
  const g0 = GRAD[i0 & (SIZE - 1)];
  const g1 = GRAD[(i0 + 1) & (SIZE - 1)];
  const n0 = g0 * t;
  const n1 = g1 * (t - 1);
  const f = fade(t);
  return (n0 + (n1 - n0) * f) * 2.0;
}

/** Two octaves: a body frequency plus a rattle, which is what an impact is. */
export function fbm1(x) {
  return perlin1(x) * 0.70 + perlin1(x * 2.31 + 57.3) * 0.30;
}
