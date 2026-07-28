import * as THREE from 'three';
import { wrap, clamp01 } from './Noise.js';
import { buildChains } from './MipChain.js';
import * as CONCRETE from './painters/Concrete.js';
import * as DETAIL from './painters/Detail.js';

/**
 * OWNER: material-forge agent (src/render/MaterialForge.js + this folder).
 *
 * The texture foundry. Purely arithmetic — no canvas, no images, no downloads —
 * so it satisfies the zero-external-assets constraint and runs identically
 * headless in the screenshot rig.
 *
 * Every map is baked on a wrapped lattice, so every family tiles seamlessly.
 * Each family declares how many *metres* its tile spans (TILE_M); MaterialForge
 * turns that into `texture.repeat` against the level's world-projected UVs, so
 * feature sizes are authored once in millimetres and stay physically correct on
 * a 1.5 m kerb and a 40 m cooling tower alike.
 *
 * Output per family:
 *   map        albedo, sRGB colour space (three linearises on sample)
 *   normalMap  tangent-space normal, linear, sobelled from the height field
 *   orm        R=AO, G=roughness, B=metalness — linear
 *
 * `orm` is the glTF packing convention and three reads exactly those channels
 * for aoMap/roughnessMap/metalnessMap, so one upload feeds three slots.
 *
 * Colour-space discipline matters more here than anywhere else in the renderer:
 * an albedo tagged linear renders washed-out and plastic, and a roughness map
 * tagged sRGB skews every gloss value. Only `map` is ever sRGB.
 */

export const PAINTERS = {
  precast: CONCRETE.precast,
  poured: CONCRETE.poured,
  unit: CONCRETE.unit,
  interior: CONCRETE.interior,
  asphalt: CONCRETE.asphalt,
  dirt: CONCRETE.dirt,
  sand: CONCRETE.sand,
  metal_painted: DETAIL.metal_painted,
  metal_bare: DETAIL.metal_bare,
  metal_rusted: DETAIL.metal_rusted,
  wood_plank: DETAIL.wood_plank,
  glass: DETAIL.glass,
  fabric: DETAIL.fabric,
  hessian: DETAIL.hessian,
  detail: DETAIL.detail,
};

/** Metres spanned by one baked tile, merged from both painter modules. */
export const TILE_M = { ...CONCRETE.TILE_M, ...DETAIL.TILE_M };

/**
 * Bake resolution per family. Chosen from texel density, not vanity: the number
 * that matters is px/m (size / TILE_M), and every family here lands between
 * 190 and 2050 px/m. The 0.25 m `detail` tile is the high-frequency end at
 * ~2050 px/m — half a millimetre per texel — which is why close-range surfaces
 * keep micro-relief instead of going smooth.
 */
export const SIZES = {
  precast: 1024,       // 256 px/m over a 4.0 m tile (4 panels)
  poured: 768,         // 219 px/m
  unit: 512,           // 256 px/m
  interior: 512,       // 205 px/m
  asphalt: 768,        // 274 px/m
  dirt: 640,           // 213 px/m
  sand: 512,           // 171 px/m
  metal_painted: 512,  // 256 px/m
  metal_bare: 512,     // 427 px/m
  metal_rusted: 640,   // 400 px/m
  wood_plank: 512,     // 213 px/m
  glass: 256,          // 107 px/m — glass carries no fine structure
  fabric: 512,         // 256 px/m
  hessian: 512,        // 1969 px/m over a 0.26 m tile — 5 px per hessian thread
  detail: 512,         // 2048 px/m over a 0.25 m tile
};

/** Sobel gain per family — how hard the height field pushes the normal. */
const NORMAL_GAIN = {
  precast: 2.4, poured: 2.6, unit: 2.2, interior: 2.0, asphalt: 3.0,
  dirt: 3.0, sand: 2.6, metal_painted: 2.0, metal_bare: 1.7,
  metal_rusted: 2.6, wood_plank: 2.4, glass: 1.2, fabric: 2.6,
  hessian: 3.2, detail: 3.6,
};

/**
 * Hard roughness floor per family, applied at every mip level.
 *
 * Nothing that carries half-millimetre relief is physically a mirror. The bare
 * and painted metal painters both authored minima in the 0.12-0.22 band, which
 * is a *polished* surface — and a polished surface under a high-frequency normal
 * map is a sparkle generator no amount of filtering can rescue. 0.22 is the
 * floor for anything with real micro-relief; glass is the sole exception,
 * because a clean pane genuinely is that smooth and its normal map is flat.
 */
const ROUGH_FLOOR = {
  precast: 0.30, poured: 0.30, unit: 0.30, interior: 0.28, asphalt: 0.28,
  dirt: 0.42, sand: 0.42, metal_painted: 0.24, metal_bare: 0.22,
  metal_rusted: 0.24, wood_plank: 0.32, glass: 0.045, fabric: 0.55,
  hessian: 0.72, detail: 0.22,
};

/**
 * How hard each family pays normal variance back into roughness down the chain.
 * Metals get the full treatment because they are the families whose specular
 * lobe is narrow enough to alias; the loose-ground families are already at
 * roughness 0.9 where the widening is a no-op, so the strength there is nominal.
 */
const TOKSVIG = {
  precast: 0.7, poured: 0.7, unit: 0.7, interior: 0.6, asphalt: 0.8,
  dirt: 0.6, sand: 0.6, metal_painted: 1.0, metal_bare: 1.15,
  metal_rusted: 1.0, wood_plank: 0.8, glass: 0.9, fabric: 0.6,
  hessian: 0.5, detail: 0.8,
};

/** Ceiling on the widened result — a distant handrail must not go lambertian. */
const ROUGH_CAP = 0.88;

/* ------------------------------------------------------------------- bake --- */

/**
 * Sobel the height field into unit tangent-space normals (wrapped), kept as
 * floats. Bytes come later, per mip level — the chain needs the vectors, not
 * their 8-bit encoding, because the whole point is to measure how much of the
 * vector survives averaging.
 */
function normalsFromHeight(height, size, strength, out) {
  const at = (x, y) => height[wrap(y, size) * size + wrap(x, size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const tl = at(x - 1, y - 1), t = at(x, y - 1), tr = at(x + 1, y - 1);
      const l = at(x - 1, y), r = at(x + 1, y);
      const bl = at(x - 1, y + 1), b = at(x, y + 1), br = at(x + 1, y + 1);
      const dx = (tr + 2 * r + br) - (tl + 2 * l + bl);
      const dy = (bl + 2 * b + br) - (tl + 2 * t + tr);
      let nx = -dx * strength, ny = -dy * strength, nz = 1;
      const inv = 1 / Math.hypot(nx, ny, nz);
      const i = (y * size + x) * 3;
      out[i] = nx * inv; out[i + 1] = ny * inv; out[i + 2] = nz * inv;
    }
  }
}

/**
 * Wrap a pre-built mip chain in a DataTexture. `mipmaps[0]` is the base level,
 * so three uploads every level explicitly and never calls `gl.generateMipmap` —
 * which is the entire point, since the driver's box filter is what discarded the
 * normal variance in the first place.
 *
 * Trilinear on the minification side (`LinearMipmapLinearFilter`) and anisotropy
 * of at least 4: a grazing catwalk deck sampled with 1 tap picks a mip from the
 * *long* axis of its footprint and either shimmers or smears, and both failures
 * read as the same speckle.
 */
function makeTexture(mips, size, srgb, aniso) {
  const t = new THREE.DataTexture(
    mips[0].data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType,
  );
  t.mipmaps = mips;
  t.generateMipmaps = false;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.anisotropy = Math.max(4, aniso | 0);
  // Albedo is authored as sRGB-encoded values; normal/ORM are raw data. Getting
  // this backwards is the classic reason procedural PBR looks like plastic.
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

const SCRATCH = { r: 0, g: 0, b: 0, h: 0.5, rough: 0.9, metal: 0, ao: 1 };

/**
 * Bake one surface family.
 * @param {string} family key in PAINTERS
 * @param {number} [size] texture edge in px; defaults to SIZES[family]
 * @param {number} [aniso] anisotropic filter taps
 * @returns {{ map, normalMap, orm, tile:number, size:number }}
 */
export function bakeFamily(family, size = SIZES[family] ?? 512, aniso = 8) {
  const painter = PAINTERS[family] ?? PAINTERS.precast;
  const gain = NORMAL_GAIN[family] ?? 2.2;
  const n = size * size;
  const albedo = new Uint8Array(n * 4);
  const orm = new Float32Array(n * 3);
  const normal = new Float32Array(n * 3);
  const height = new Float32Array(n);
  const o = SCRATCH;
  const inv = 1 / size;

  for (let y = 0; y < size; y++) {
    const v = y * inv;
    for (let x = 0; x < size; x++) {
      painter(x * inv, v, o);
      const i = y * size + x;
      const j = i * 4, k = i * 3;
      albedo[j] = clamp01(o.r) * 255;
      albedo[j + 1] = clamp01(o.g) * 255;
      albedo[j + 2] = clamp01(o.b) * 255;
      albedo[j + 3] = 255;
      orm[k] = clamp01(o.ao);
      orm[k + 1] = clamp01(o.rough);
      orm[k + 2] = clamp01(o.metal);
      height[i] = clamp01(o.h);
    }
  }
  normalsFromHeight(height, size, gain, normal);

  const chains = buildChains({
    size, albedo, normal, orm,
    roughFloor: ROUGH_FLOOR[family] ?? 0.22,
    toksvig: TOKSVIG[family] ?? 0.8,
    roughCap: family === 'glass' ? 0.55 : ROUGH_CAP,
  });

  return {
    map: makeTexture(chains.albedoMips, size, true, aniso),
    normalMap: makeTexture(chains.normalMips, size, false, aniso),
    orm: makeTexture(chains.ormMips, size, false, aniso),
    tile: TILE_M[family] ?? 2.0,
    size,
    // |mean normal| at the deepest useful level — 1.0 means the family has no
    // high-frequency normal content at all, which for a PBR surface is a bug.
    normalLen: chains.avgLen[Math.min(4, chains.avgLen.length - 1)],
  };
}

/**
 * Bake the shared close-range detail field. Height only — the albedo and ORM
 * halves of a normal-only family would be three quarters of the memory for
 * nothing.
 */
export function bakeDetailNormal(size = SIZES.detail, aniso = 8) {
  const painter = PAINTERS.detail;
  const n = size * size;
  const height = new Float32Array(n);
  const normal = new Float32Array(n * 3);
  const o = SCRATCH;
  const inv = 1 / size;
  for (let y = 0; y < size; y++) {
    const v = y * inv;
    for (let x = 0; x < size; x++) {
      painter(x * inv, v, o);
      height[y * size + x] = clamp01(o.h);
    }
  }
  normalsFromHeight(height, size, NORMAL_GAIN.detail, normal);
  // The detail field is normal-only, but it still needs a real chain: it is
  // sampled in world space at 0.25 m, so a fragment 12 m away is minifying it by
  // ~50x and a missing chain there is a guaranteed shimmer.
  const chains = buildChains({ size, albedo: null, normal, orm: null });
  const t = makeTexture(chains.normalMips, size, false, aniso);
  return { normalMap: t, tile: TILE_M.detail, size, mips: chains.normalMips.length };
}

export const FAMILIES = Object.keys(PAINTERS);
