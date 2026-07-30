/**
 * OWNER: fx agent.
 *
 * Tiny procedural raster kit shared by the particle sprite atlas and the decal
 * atlas. Everything the FX systems draw is arithmetic — there is not one
 * downloaded pixel anywhere in this folder.
 *
 * All generators write into a single ImageData for the whole atlas so a tile is
 * addressed by (column, row) with row 0 at the BOTTOM, matching the way UVs are
 * derived on the GPU (`tile = vec2(mod(i, cols), floor(i / cols))`).
 */

/** Deterministic 32-bit PRNG — same seed, same atlas, every run. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rnd() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function clamp01(x) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

export function smoothstep(e0, e1, x) {
  const t = clamp01((x - e0) / (e1 - e0 || 1e-6));
  return t * t * (3 - 2 * t);
}

export function mix(a, b, t) {
  return a + (b - a) * t;
}

/** Integer hash → [0,1). */
function hash2(ix, iy, seed) {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(seed, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Bicubic-ish value noise. Continuous, cheap, tiles on `period` when given. */
export function noise2(x, y, seed = 0, period = 0) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const w = (i) => (period > 0 ? ((i % period) + period) % period : i);
  const x0 = w(xi);
  const x1 = w(xi + 1);
  const y0 = w(yi);
  const y1 = w(yi + 1);
  const a = hash2(x0, y0, seed);
  const b = hash2(x1, y0, seed);
  const c = hash2(x0, y1, seed);
  const d = hash2(x1, y1, seed);
  return mix(mix(a, b, u), mix(c, d, u), v);
}

/** Fractal sum of value noise. Returns roughly [0,1]. */
export function fbm2(x, y, octaves = 4, seed = 0, lac = 2.03, gain = 0.5) {
  let f = 1;
  let amp = 1;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += noise2(x * f, y * f, seed + o * 977) * amp;
    norm += amp;
    f *= lac;
    amp *= gain;
  }
  return sum / norm;
}

/** Ridged variant — good for cracks, splinters and torn edges. */
export function ridge2(x, y, octaves = 3, seed = 0) {
  let f = 1;
  let amp = 1;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    const n = Math.abs(noise2(x * f, y * f, seed + o * 613) * 2 - 1);
    sum += (1 - n) * amp;
    norm += amp;
    f *= 2.11;
    amp *= 0.52;
  }
  return sum / norm;
}

/**
 * An atlas being painted: a flat RGBA byte buffer plus tile addressing.
 * `paint(index, fn)` walks a tile's pixels and calls
 * `fn(u, v, out)` with u,v in [0,1] — `out` is a reused 4-float scratch array
 * [r,g,b,a] in 0..1, so the callback allocates nothing.
 *
 * ── ORIENTATION, AND THE BUG THAT LIVED HERE ─────────────────────────────────
 * The buffer is handed to a `DataTexture`, whose `flipY` is false, so byte row 0
 * of the array is uploaded as texture coordinate t = 0 and t rises with the row
 * index. Both consumers (ParticleBatch and DecalField) derive a tile's UVs as
 * `(row + uv) / rows` straight from `floor(index / cols)`, so tile row r MUST
 * occupy byte rows [r*tileH, (r+1)*tileH) and painter-v must rise with the byte
 * row.
 *
 * This class used to do the opposite of both: it placed tile row r at byte row
 * (rows-1-r)*tileH and ran v downward, on the reasoning that "row 0 is the
 * bottom of the texture; ImageData row 0 is the top" — true of a 2D canvas, not
 * of a DataTexture. The result was that EVERY tile was fetched from the mirrored
 * row: with a 4-row sheet, row 0 <-> row 3 and row 1 <-> row 2. Spent casings
 * (sprite 7) were drawn with the EMBER tile and rendered as soft round dots;
 * embers (sprite 11) were drawn with the CASING tile and rendered as tumbling
 * brass, which is why a round-8 reviewer measured "casings twenty metres
 * downrange at head height, rising, with no impacts and no shadows" — those were
 * embers wearing the wrong sprite, and the real brass was invisible dots. Bullet
 * holes were fetching smudges for the same reason.
 */
export class AtlasCanvas {
  constructor(size, cols, rows) {
    this.size = size;
    this.cols = cols;
    this.rows = rows;
    this.tile = size / cols;
    this.tileH = size / rows;
    this.data = new Uint8ClampedArray(size * size * 4);
    this._out = new Float64Array(4);
  }

  paint(index, fn) {
    const { cols, rows, size, data } = this;
    const T = this.tile;
    const TH = this.tileH;
    const col = index % cols;
    const row = Math.floor(index / cols);
    if (row >= rows) return;
    const ox = col * T;
    // Byte row (row * tileH) is texture t = row / rows — the same tile the
    // consumers' `(row + uv) / rows` asks for. See the note on the class.
    const oy = row * TH;
    const out = this._out;
    for (let py = 0; py < TH; py++) {
      const v = (py + 0.5) / TH;
      const rowBase = ((oy + py) * size + ox) * 4;
      for (let px = 0; px < T; px++) {
        const u = (px + 0.5) / T;
        out[0] = 0; out[1] = 0; out[2] = 0; out[3] = 0;
        fn(u, v, out);
        const o = rowBase + px * 4;
        data[o] = out[0] * 255;
        data[o + 1] = out[1] * 255;
        data[o + 2] = out[2] * 255;
        data[o + 3] = out[3] * 255;
      }
    }
  }

  /** Hands the buffer to three as a DataTexture with mips and sRGB decode. */
  toTexture(THREE, { colorSpace = THREE.SRGBColorSpace, aniso = 4 } = {}) {
    const tex = new THREE.DataTexture(this.data, this.size, this.size, THREE.RGBAFormat);
    tex.colorSpace = colorSpace;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.anisotropy = aniso;
    tex.premultiplyAlpha = false;
    tex.needsUpdate = true;
    return tex;
  }
}

/** Radial coordinates helper: returns distance from centre in units of 0.5. */
export function radius(u, v) {
  const dx = u - 0.5;
  const dy = v - 0.5;
  return Math.sqrt(dx * dx + dy * dy) * 2;
}

export function angleOf(u, v) {
  return Math.atan2(v - 0.5, u - 0.5);
}
