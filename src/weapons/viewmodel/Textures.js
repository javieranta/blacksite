import * as THREE from 'three';

/**
 * OWNER: viewmodel agent.
 *
 * Procedural PBR texture bakery for the first-person weapon. Zero external
 * assets: every map here is synthesised from tileable value noise at load time.
 *
 * Each material zone gets three textures:
 *   map        sRGB albedo — base colour, mottling, scratch tracks, weave
 *   normalMap  derived from a band-limited height field, with a hand-built mip
 *              chain that carries its own normal-variance statistics
 *   orm        R = ambient occlusion, G = roughness, B = metalness, with the
 *              roughness raised per mip from that variance (Toksvig)
 *
 * The ORM packing is the three.js convention (aoMap reads .r, roughnessMap .g,
 * metalnessMap .b), so one texture drives three material slots and the weapon
 * costs six textures in total rather than twenty.
 *
 * ─── WHY THIS FILE WAS REWRITTEN: SPECULAR ALIASING ───────────────────────
 *
 * The previous revision authored noise in "frequency multiplier × period" units
 * and happily asked for detail far above the texture's own Nyquist limit — the
 * phosphate micro-grain ran at 1200 lattice cells across a 512-texel tile, i.e.
 * 2.3 cells per texel. A height field sampled that far below Nyquist is not
 * detail, it is white noise; Sobel it and every texel gets a random normal
 * direction. A random normal field under a sharp specular lobe is a sparkle
 * generator: at magnification it reads as coral, at minification as a dense
 * salt-and-pepper of blown-out pixels. That was the loudest artefact in the
 * frame, and no amount of roughness tweaking fixes it because the *input* is
 * broken.
 *
 * Three things now guarantee it cannot come back:
 *
 *   1. Frequencies are authored in *lattice cells per tile* and every one of
 *      them goes through `C()`, which clamps to size/4 — a hard four-texels-per-
 *      cell floor. Detail finer than that is not representable, so it is not
 *      requested.
 *   2. The height field gets a wrapped 1-2-1 separable blur before the Sobel,
 *      which removes whatever texel-scale energy survived, and the Sobel is
 *      *auto-scaled* so the RMS surface tilt lands on a per-zone target angle
 *      instead of on a hand-guessed `normalStrength` that was 2.6 and produced
 *      70-degree facets.
 *   3. The normal and ORM mip chains are built by hand, together. Averaging
 *      normals shortens the result; the deficit 1-|N| measures exactly how much
 *      specular-spreading variance the footprint hides, and that variance is
 *      folded back into the roughness of the same mip (Toksvig / LEAN). This is
 *      what shipped engines do and it is the only fix that removes sparkle
 *      rather than trading it for blur.
 *
 * Roughness is authored per zone rather than borrowed, and every zone has a
 * floor: below roughness ~0.32 a detailed normal map will always crawl at
 * 1080p. Phosphate steel is 0.42-0.55, hard-anodised aluminium 0.46-0.60,
 * injection-moulded polymer 0.58-0.85, fabric 0.76+, fired brass 0.34+.
 *
 * ─── AND WHY IT WAS TUNED AGAIN: IT IS NOT THE SPECULAR LOBE ──────────────
 *
 * The three guarantees above removed most of the sparkle and left a dense warm
 * stipple on the receiver, the rail cover and the stock flank in low sun. An
 * A/B settled what it was in two shots: forcing roughness to 1.0 everywhere
 * changed the stipple *not at all*, and forcing `normalScale` to 0 removed it
 * completely. It was never specular aliasing, so no roughness treatment — not
 * the floors, not Toksvig, not the Kaplanyan lobe widening in Materials.js —
 * could ever have touched it.
 *
 * It is the *diffuse* term at the shadow terminator. A face lying nearly edge-on
 * to a low sun has N·L within a hair of zero; a few degrees of normal
 * perturbation is then the whole difference between a texel being lit by direct
 * sunlight and not lit at all, and the result is a binary, maximum-contrast
 * checker of sun-coloured and black pixels. Mip filtering fights it (disabling
 * mips makes it catastrophically worse) but cannot win, because anisotropic
 * filtering runs out of taps exactly on the surfaces that are most raked, which
 * are the same surfaces that sit on the terminator.
 *
 * The only cure is to stop asking for the perturbation. So: every zone's target
 * RMS tilt is down by 35-45%, every per-texel facet clamp is down by more than
 * half, the lattice-cell floor went from four texels to six, the pre-Sobel blur
 * runs twice, and the highest-frequency term in each zone has been moved out of
 * the height field into the albedo and roughness — where a texel of disagreement
 * costs a texel of contrast instead of a blown-out pixel. Materials.js then puts
 * a hard ceiling on how far the sampled normal may ever tilt from the geometric
 * one, so nothing downstream can undo it.
 */

/* ------------------------------------------------------------------- noise */

function hash(ix, iy, px, py, seed) {
  const x = ((ix % px) + px) % px;
  const y = ((iy % py) + py) % py;
  let h = (x | 0) * 374761393 + (y | 0) * 668265263 + (seed | 0) * 1274126177;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Smooth value noise on a lattice that wraps at (px, py) cells. */
function vn2(x, y, px, py, seed) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = hash(ix, iy, px, py, seed), b = hash(ix + 1, iy, px, py, seed);
  const c = hash(ix, iy + 1, px, py, seed), d = hash(ix + 1, iy + 1, px, py, seed);
  const t = a + (b - a) * sx;
  return t + ((c + (d - c) * sx) - t) * sy;
}

/** Isotropic value noise. `cells` = lattice cells across the whole tile. */
const vn = (u, v, cells, seed) => vn2(u * cells, v * cells, cells, cells, seed);

/** Fractal sum. Each octave doubles the cell count; `C` keeps it legal. */
function fbm(u, v, cells, seed, C, oct = 4, gain = 0.5) {
  let amp = 1, sum = 0, tot = 0, c = cells;
  for (let i = 0; i < oct; i++) {
    sum += amp * vn(u, v, C(c), seed + i * 17);
    tot += amp; amp *= gain; c *= 2;
  }
  return sum / tot;
}

/**
 * Anisotropic streaks — long along one axis, tight across it. `axis` 0 runs the
 * streaks along U (few cells in U, many in V), 1 runs them along V.
 */
function streak(u, v, cAlong, cAcross, axis, seed) {
  return axis === 0
    ? vn2(u * cAlong, v * cAcross, cAlong, cAcross, seed)
    : vn2(u * cAcross, v * cAlong, cAcross, cAlong, seed);
}

/**
 * Sparse thin scratch tracks: bright, smoother than the coating, directional.
 * The threshold has to stay high — at 0.80 over four layers the "scratches"
 * covered better than half the surface and read as a cast, porous mottle rather
 * than as damage.
 */
function scratchField(u, v, C, seed) {
  let s = 0;
  for (let i = 0; i < 3; i++) {
    const axis = i < 2 ? 0 : 1;
    const n = streak(u, v, C(3 + i * 2), C(60 + i * 18), axis, seed + i * 131);
    s = Math.max(s, Math.pow(Math.max(0, n - 0.885) / 0.115, 1.5));
  }
  return Math.min(1, s);
}

const sstep = (e0, e1, x) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0 || 1e-6)));
  return t * t * (3 - 2 * t);
};

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

/* --------------------------------------------------------- height filtering */

/**
 * Wrapped separable 1-2-1 blur. Removes texel-scale energy before the Sobel.
 *
 * Run twice (see `bake`). Once is not enough: a 1-2-1 kernel has response
 * cos²(pi f), which still passes 0.5 at a four-texel period, and the Sobel that
 * follows peaks at exactly that frequency — so the gradient field ends up
 * *dominated* by whatever sits closest to Nyquist. Two passes take that to 0.25
 * and, more importantly, guarantee the normal field varies smoothly across at
 * least five texels, which is what stops a single texel disagreeing with its
 * neighbours badly enough to cross the light terminator on its own.
 */
function blurWrap(h, size, tmp) {
  for (let y = 0; y < size; y++) {
    const row = y * size;
    for (let x = 0; x < size; x++) {
      const a = h[row + ((x - 1 + size) % size)];
      const b = h[row + x];
      const c = h[row + ((x + 1) % size)];
      tmp[row + x] = (a + 2 * b + c) * 0.25;
    }
  }
  for (let y = 0; y < size; y++) {
    const rm = ((y - 1 + size) % size) * size;
    const r0 = y * size;
    const rp = ((y + 1) % size) * size;
    for (let x = 0; x < size; x++) {
      h[r0 + x] = (tmp[rm + x] + 2 * tmp[r0 + x] + tmp[rp + x]) * 0.25;
    }
  }
}

/* ------------------------------------------------------------ mip machinery */

/**
 * Fold hidden normal variance into roughness.
 *
 * `t` is |average of the unit normals inside this texel's footprint|. A flat
 * footprint gives t = 1 and changes nothing; a footprint full of disagreeing
 * normals gives t → 0 and drives roughness to 1. The variance proxy is the
 * standard σ² = (1 - t)/t, combined in GGX α² space so it composes correctly
 * with the authored roughness.
 */
function toksvig(rough8, t, k) {
  const r = rough8 / 255;
  const tt = t < 1e-3 ? 1e-3 : t > 1 ? 1 : t;
  const varN = (1 - tt) / tt;
  const a2 = Math.min(1, r * r + k * varN);
  return Math.round(255 * Math.sqrt(a2));
}

/**
 * Build the full normal + ORM mip chains down to 1x1.
 *
 * `acc` tracks the *unnormalised* average of the level-0 normals covering each
 * texel, so its length at level N is the true coherency over the whole 2^N
 * footprint rather than a recursive approximation of it.
 */
function buildMips(nrm, orm, size, k) {
  let w = size, h = size;
  let acc = new Float32Array(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    acc[i * 3] = (nrm[i * 4] / 255) * 2 - 1;
    acc[i * 3 + 1] = (nrm[i * 4 + 1] / 255) * 2 - 1;
    acc[i * 3 + 2] = (nrm[i * 4 + 2] / 255) * 2 - 1;
  }
  let ormLvl = orm;
  const nMips = [{ data: nrm, width: w, height: h }];
  const oMips = [{ data: orm, width: w, height: h }];

  while (w > 1 || h > 1) {
    const nw = Math.max(1, w >> 1), nh = Math.max(1, h >> 1);
    const nAcc = new Float32Array(nw * nh * 3);
    const nData = new Uint8Array(nw * nh * 4);
    const oData = new Uint8Array(nw * nh * 4);
    for (let y = 0; y < nh; y++) {
      for (let x = 0; x < nw; x++) {
        const x0 = Math.min(w - 1, x * 2), x1 = Math.min(w - 1, x * 2 + 1);
        const y0 = Math.min(h - 1, y * 2), y1 = Math.min(h - 1, y * 2 + 1);
        let ax = 0, ay = 0, az = 0, ao = 0, rg = 0, mt = 0;
        for (let sy = 0; sy < 2; sy++) {
          const yy = sy === 0 ? y0 : y1;
          for (let sx = 0; sx < 2; sx++) {
            const i = yy * w + (sx === 0 ? x0 : x1);
            ax += acc[i * 3]; ay += acc[i * 3 + 1]; az += acc[i * 3 + 2];
            ao += ormLvl[i * 4]; rg += ormLvl[i * 4 + 1]; mt += ormLvl[i * 4 + 2];
          }
        }
        ax *= 0.25; ay *= 0.25; az *= 0.25;
        const j = y * nw + x;
        nAcc[j * 3] = ax; nAcc[j * 3 + 1] = ay; nAcc[j * 3 + 2] = az;
        const len = Math.hypot(ax, ay, az) || 1e-6;
        nData[j * 4] = Math.round(clamp01((ax / len) * 0.5 + 0.5) * 255);
        nData[j * 4 + 1] = Math.round(clamp01((ay / len) * 0.5 + 0.5) * 255);
        nData[j * 4 + 2] = Math.round(clamp01((az / len) * 0.5 + 0.5) * 255);
        nData[j * 4 + 3] = 255;
        oData[j * 4] = Math.round(ao * 0.25);
        oData[j * 4 + 1] = toksvig(rg * 0.25, len, k);
        oData[j * 4 + 2] = Math.round(mt * 0.25);
        oData[j * 4 + 3] = 255;
      }
    }
    nMips.push({ data: nData, width: nw, height: nh });
    oMips.push({ data: oData, width: nw, height: nh });
    acc = nAcc; ormLvl = oData; w = nw; h = nh;
  }
  return { nMips, oMips };
}

/* -------------------------------------------------------------- bake plumbing */

/**
 * Run `o.fill(u, v, out, C)` over a size×size tile. `u`/`v` span 0..1 across the
 * tile; `C(cells)` clamps a requested lattice-cell count to what the tile can
 * actually carry. `out` receives linear albedo (r/g/b), rough, metal, ao and h.
 *
 * @param o.slope      target RMS surface tilt (a tangent) for the normal map
 * @param o.roughFloor hard lower bound on authored roughness
 * @param o.toks       Toksvig strength for the mip roughness floor
 */
function bake(size, o) {
  // Six texels per lattice cell, not four. Four was chosen as "the Nyquist limit
  // plus a safety factor", but Nyquist is the wrong bar for a height field that
  // is about to be differentiated: the Sobel's gain rises with frequency, so a
  // legal-but-marginal cell produces the *steepest* facets in the map.
  const capV = Math.max(2, Math.floor(size / 6));
  const C = (cells) => {
    const c = Math.round(cells);
    return c < 1 ? 1 : c > capV ? capV : c;
  };
  const floor = o.roughFloor ?? 0.30;
  const n = size * size;
  const alb = new Uint8Array(n * 4);
  const orm = new Uint8Array(n * 4);
  const hf = new Float32Array(n);
  const out = { r: 0, g: 0, b: 0, rough: 0.5, metal: 0, ao: 1, h: 0 };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      out.r = 0; out.g = 0; out.b = 0;
      out.rough = 0.5; out.metal = 0; out.ao = 1; out.h = 0;
      o.fill(x / size, y / size, out, C);
      const i = y * size + x, j = i * 4;
      // Albedo is authored linear; encode to sRGB for an sRGB-tagged texture.
      alb[j] = Math.round(255 * Math.pow(clamp01(out.r), 1 / 2.2));
      alb[j + 1] = Math.round(255 * Math.pow(clamp01(out.g), 1 / 2.2));
      alb[j + 2] = Math.round(255 * Math.pow(clamp01(out.b), 1 / 2.2));
      alb[j + 3] = 255;
      orm[j] = Math.round(255 * clamp01(out.ao));
      orm[j + 1] = Math.round(255 * clamp01(Math.max(floor, out.rough)));
      orm[j + 2] = Math.round(255 * clamp01(out.metal));
      orm[j + 3] = 255;
      hf[i] = out.h;
    }
  }

  // Band-limit the height field, then Sobel it with an auto-calibrated gain.
  const tmp = new Float32Array(n);
  blurWrap(hf, size, tmp);
  blurWrap(hf, size, tmp);
  const gx = new Float32Array(n), gy = new Float32Array(n);
  const at = (x, y) => hf[((y + size) % size) * size + ((x + size) % size)];
  let sq = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1))
               - (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1));
      const dy = (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1))
               - (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1));
      const i = y * size + x;
      gx[i] = dx; gy[i] = dy;
      sq += dx * dx + dy * dy;
    }
  }
  // RMS of the gradient magnitude over the tile. Scaling by target/RMS makes the
  // *statistics* of the surface the authored quantity, so a zone's relief reads
  // the same whether its height field came out of a pyramid or a fractal.
  const rms = Math.sqrt(sq / n) || 1e-6;
  const gain = (o.slope ?? 0.18) / rms;
  const nrm = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    let nx = -gx[i] * gain, ny = -gy[i] * gain;
    // Clamp individual facets so one steep texel cannot spike the specular.
    const m = Math.hypot(nx, ny);
    const lim = (o.slopeMax ?? 0.62);
    if (m > lim) { nx = (nx / m) * lim; ny = (ny / m) * lim; }
    const l = Math.hypot(nx, ny, 1);
    const j = i * 4;
    nrm[j] = Math.round(clamp01((nx / l) * 0.5 + 0.5) * 255);
    nrm[j + 1] = Math.round(clamp01((ny / l) * 0.5 + 0.5) * 255);
    nrm[j + 2] = Math.round(clamp01((1 / l) * 0.5 + 0.5) * 255);
    nrm[j + 3] = 255;
  }

  const { nMips, oMips } = buildMips(nrm, orm, size, o.toks ?? 0.85);

  const tex = (data, srgb, mips) => {
    const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    if (mips) {
      // Hand-built chain: trilinear between levels that already know how much
      // normal variance they threw away. generateMipmaps must be off or the GPU
      // box-filter would overwrite level 1+ and take the roughness floor with it.
      t.mipmaps = mips;
      t.generateMipmaps = false;
    } else {
      t.generateMipmaps = true;
    }
    t.anisotropy = 16;
    t.needsUpdate = true;
    return t;
  };

  return {
    map: tex(alb, true, null),
    normalMap: tex(nrm, false, nMips),
    orm: tex(orm, false, oMips),
  };
}

/* ------------------------------------------------------------------- zones */

/**
 * Phosphate-finished steel: upper receiver, barrel, bolt, small controls.
 * Manganese phosphate is a dark, slightly warm conversion coating with visible
 * tooth. Wear polishes it to bare steel, so scratches are brighter *and*
 * smoother — that correlation is what makes metal read as metal. The tooth is
 * deliberately coarse (≈0.35 mm on the surface): finer than that and it is below
 * what a 1080p pixel can resolve on a first-person weapon, so it contributes
 * nothing but noise.
 */
function phosphate(size = 512) {
  return bake(size, {
    slope: 0.090, slopeMax: 0.20, roughFloor: 0.42, toks: 1.0,
    fill: (u, v, o, C) => {
      const blotch = fbm(u, v, 3, 11, C, 4);
      const tooth = vn(u, v, C(88), 23);
      const grain = vn(u, v, C(124), 41);
      const sc = scratchField(u, v, C, 77);
      // Cool near-black: the steel has to sit visibly apart from the warmer
      // polymer lower, or the whole weapon reads as one moulded grey object.
      const base = 0.0360 + 0.0230 * blotch;
      // Bare steel showing through: neutral and much brighter.
      const bare = 0.24 + 0.07 * grain;
      o.r = base * (0.90 + 0.16 * tooth + 0.07 * grain) + sc * bare * 0.97;
      o.g = base * (0.95 + 0.16 * tooth + 0.07 * grain) + sc * bare;
      o.b = base * (1.06 + 0.16 * tooth + 0.07 * grain) + sc * bare * 1.05;
      o.rough = 0.52 + 0.11 * (tooth - 0.5) + 0.09 * (blotch - 0.5) - 0.13 * sc;
      o.metal = 0.88 + 0.10 * sc + 0.03 * (tooth - 0.5);
      o.ao = 1 - 0.10 * (1 - tooth);
      // HEIGHT IS NOT ALBEDO. The tooth and the scratches belong in the colour
      // and the roughness, where a texel of disagreement costs a texel of
      // contrast. In the *height* field they cost a facet, and a facet on a
      // surface lying along the sun's terminator is a blown-out pixel next to a
      // black one. Only the low-frequency blotch — real waviness in the
      // conversion coating — is allowed to carry relief.
      o.h = blotch * 0.80 + tooth * 0.10 - sc * 0.12;
    },
  });
}

/**
 * Injection-moulded polymer: lower receiver, stock, magazine. The tell is an
 * orange-peel mould texture plus patches burnished smooth where hands, slings
 * and gear rub. Metalness stays at zero — a polymer lower with any metalness is
 * the single most common reason a game weapon looks like grey plastic.
 */
function polymer(size = 512) {
  return bake(size, {
    slope: 0.115, slopeMax: 0.24, roughFloor: 0.58, toks: 0.90,
    fill: (u, v, o, C) => {
      const peel = vn(u, v, C(58), 7) * 0.64 + vn(u, v, C(112), 19) * 0.36;
      const mottle = fbm(u, v, 3, 31, C, 4);
      // A separate, coarser copy of the orange peel drives the relief. The fine
      // component stays in the albedo and the roughness where it is free.
      const relief = vn(u, v, C(34), 7);
      const rub = sstep(0.55, 0.86, fbm(u, v, 4, 53, C, 3));
      const scuff = Math.pow(scratchField(u, v, C, 97), 1.4);
      // Warm-neutral, and a touch lighter than the steel: a black polymer lower
      // photographs browner than a phosphate upper, and that split is most of
      // what makes a weapon read as assembled from different materials.
      const base = 0.0250 + 0.0135 * mottle;
      o.r = base * (1.02 + 0.24 * peel) + scuff * 0.044 + rub * 0.004;
      o.g = base * (0.98 + 0.24 * peel) + scuff * 0.044 + rub * 0.004;
      o.b = base * (0.92 + 0.24 * peel) + scuff * 0.046 + rub * 0.005;
      o.rough = 0.78 + 0.10 * (peel - 0.5) - 0.16 * rub - 0.10 * scuff;
      o.metal = 0.02;
      o.ao = 1 - 0.14 * (1 - peel);
      o.h = relief * 0.52 + mottle * 0.40;
    },
  });
}

/**
 * Stippled polymer grip panel: the moulded diamond checkering on a pistol grip
 * and the flats of a magazine. Real relief in the normal map, and the peaks are
 * burnished shiny where the palm sits. 22 diamonds per tile is ≈1.4 mm
 * checkering — coarse enough to survive mip selection, which a finer lattice
 * does not.
 */
function stipple(size = 256) {
  return bake(size, {
    slope: 0.26, slopeMax: 0.44, roughFloor: 0.52, toks: 0.85,
    fill: (u, v, o, C) => {
      // Diamond lattice: rotate 45 degrees, then a pyramid inside each cell.
      const a = (u + v) * 22, b = (u - v) * 22;
      const fa = Math.abs(a - Math.floor(a) - 0.5) * 2;
      const fb = Math.abs(b - Math.floor(b) - 0.5) * 2;
      const pyr = Math.max(0, 1 - (fa + fb) * 0.72);
      const peel = vn(u, v, C(48), 7);
      const mottle = fbm(u, v, 3, 31, C, 3);
      const base = 0.0235 + 0.0120 * mottle;
      o.r = base * (1.00 + 0.34 * pyr);
      o.g = base * (0.97 + 0.34 * pyr);
      o.b = base * (0.91 + 0.34 * pyr);
      o.rough = 0.82 - 0.24 * Math.pow(pyr, 1.6) + 0.06 * (peel - 0.5);
      o.metal = 0.02;
      o.ao = 1 - 0.30 * (1 - pyr);
      // Only the checkering. The peel noise on top of it added nothing a pixel
      // could resolve and everything a terminator could catch.
      o.h = pyr * 1.6;
    },
  });
}

/**
 * Hard-anodised aluminium: rail, handguard, optic housing. Type III anodising
 * over an extrusion keeps the brushing direction, so roughness streaks along U.
 * That directional streak is a cheap stand-in for a real anisotropic BRDF and it
 * is what stops the rail looking like painted plastic. Semi-matte, never a
 * mirror: a glossy rail turns into a strobing comb the moment ADS looks along it.
 */
function anodised(size = 512) {
  return bake(size, {
    slope: 0.055, slopeMax: 0.15, roughFloor: 0.46, toks: 1.0,
    fill: (u, v, o, C) => {
      const br = streak(u, v, C(4), C(108), 0, 13);
      const br2 = streak(u, v, C(7), C(52), 0, 29);
      // Coarse grinding waviness — the only brushing component wide enough to
      // survive into the normal map without becoming a corduroy of facets.
      const grind = streak(u, v, C(4), C(38), 0, 13);
      const blotch = fbm(u, v, 3, 61, C, 3);
      const sc = scratchField(u, v, C, 151);
      const base = 0.0300 + 0.0105 * blotch;
      const bare = 0.17;
      o.r = base * (0.94 + 0.14 * br) + sc * bare * 0.98;
      o.g = base * (0.96 + 0.14 * br) + sc * bare;
      o.b = base * (1.03 + 0.14 * br) + sc * bare * 1.05;
      o.rough = 0.56 + 0.10 * (br - 0.5) + 0.05 * (br2 - 0.5) - 0.09 * sc;
      o.metal = 0.66 + 0.18 * sc;
      o.ao = 1;
      // An extrusion is *flat*. Nearly all the relief is the brushing direction;
      // the blotch is a tone variation, not a topography, and letting it into the
      // height field is what made the optic housing read as porous cast rock.
      o.h = grind * 0.34 + blotch * 0.14 - sc * 0.10;
    },
  });
}

/**
 * Tactical glove: a twill-woven synthetic with visible stitch rows. The weave
 * carries the normal map; the stitching is a periodic run of raised beads. Kept
 * coarse on purpose — a weave finer than the mip footprint aliases into a
 * shimmering hatch instead of reading as fabric.
 */
function gloveFabric(size = 512) {
  return bake(size, {
    slope: 0.19, slopeMax: 0.34, roughFloor: 0.76, toks: 0.80,
    fill: (u, v, o, C) => {
      const d1 = Math.sin((u + v) * 52 * Math.PI);
      const d2 = Math.sin((u - v) * 52 * Math.PI + 1.1);
      const weave = 0.5 + 0.24 * d1 + 0.13 * d2;
      const fibre = vn(u, v, C(120), 5);
      const dirt = fbm(u, v, 3, 83, C, 4);
      // Stitch rows every third of a tile, beads along the row.
      const rowV = Math.abs(((v * 3) % 1) - 0.5) * 2;
      const bead = 0.5 + 0.5 * Math.sin(u * 48 * Math.PI);
      const stitch = Math.pow(Math.max(0, 1 - rowV / 0.07), 2) * (0.45 + 0.55 * bead);
      /**
       * VALUE, NOT JUST TEXTURE. This was 0.0135-0.0195 linear — sRGB 36, which
       * is *darker* than the weapon's polymer lower (0.025-0.039, sRGB 48) and
       * darker than its phosphate steel. A hand darker than the gun it is holding
       * cannot be seen holding it: for four rounds the only hand geometry that
       * reached the screen was read as part of the weapon, or as scenery. A dark
       * coyote glove is sRGB 78 or so, which is 0.075 linear — 2.6x the polymer.
       * That gap is what makes a finger legible against a receiver flank, and it
       * is the difference between hands and another dark bracket.
       */
      const base = 0.0520 + 0.0200 * dirt;
      o.r = base * (1.00 + 0.26 * weave) + stitch * 0.026;
      o.g = base * (0.92 + 0.26 * weave) + stitch * 0.023;
      o.b = base * (0.74 + 0.26 * weave) + stitch * 0.018;
      o.rough = 0.92 - 0.08 * weave + 0.05 * (fibre - 0.5) - 0.07 * stitch;
      o.metal = 0.0;
      o.ao = 1 - 0.22 * (1 - weave);
      o.h = weave * 0.55 + fibre * 0.04 + stitch * 1.0;
    },
  });
}

/** Moulded rubber: eyecup, buttpad, grip overmould. Dimpled, matte, near-black. */
function rubber(size = 256) {
  return bake(size, {
    slope: 0.155, slopeMax: 0.30, roughFloor: 0.72, toks: 0.80,
    fill: (u, v, o, C) => {
      const cell = vn(u, v, C(40), 3);
      const fine = vn(u, v, C(60), 71);
      const dust = fbm(u, v, 3, 29, C, 3);
      // Deliberately left near-black while the glove was lifted to 0.075: the
      // knuckle armour, the palm reinforcement and the finger pads are all this
      // zone, and a 4:1 value step between pad and glove is what separates four
      // knuckles into four knuckles instead of one dark mass.
      const base = 0.0140 + 0.0060 * dust;
      o.r = base * (0.94 + 0.16 * cell);
      o.g = base * (0.95 + 0.16 * cell);
      o.b = base * (0.99 + 0.16 * cell);
      o.rough = 0.93 - 0.06 * cell + 0.04 * (fine - 0.5);
      o.metal = 0.0;
      o.ao = 1 - 0.16 * (1 - cell);
      o.h = cell * 0.78 + fine * 0.05;
    },
  });
}

/** Ripstop uniform sleeve: coarse weave plus the reinforcement grid. */
function ripstop(size = 256) {
  return bake(size, {
    slope: 0.19, slopeMax: 0.34, roughFloor: 0.78, toks: 0.80,
    fill: (u, v, o, C) => {
      const wu = 0.5 + 0.5 * Math.sin(u * 40 * Math.PI);
      const wv = 0.5 + 0.5 * Math.sin(v * 40 * Math.PI);
      const weave = wu * 0.5 + wv * 0.5;
      const gu = Math.pow(Math.max(0, 1 - Math.abs(((u * 7) % 1) - 0.5) * 2 / 0.10), 2);
      const gv = Math.pow(Math.max(0, 1 - Math.abs(((v * 7) % 1) - 0.5) * 2 / 0.10), 2);
      const grid = Math.max(gu, gv);
      const dirt = fbm(u, v, 3, 199, C, 4);
      // Lifted with the glove, and a step lighter again: the support forearm is
      // the largest single piece of the hand rig on screen (~450 px crossing the
      // frame to the bottom-left corner) and it has to separate from the
      // receiver flank it crosses in front of. Faded olive-drab ripstop.
      // Held level with the glove rather than a step above it. A sleeve lighter
      // than the glove made the forearm the brightest object in the lower half of
      // the frame, which is how a 450 px tube ends up reading as scenery instead
      // of as the darker thing at the end of the lighter thing that holds a gun.
      // Coyote, not olive. A green sleeve is the odd note in a scene lit by a low
      // sun through dust: everything else in frame is warm, so the one cool
      // object reads as not belonging to the weapon or the shooter.
      const base = 0.0520 + 0.0205 * dirt;
      o.r = base * (0.98 + 0.20 * weave) * 1.10;
      o.g = base * (0.94 + 0.20 * weave) * 0.93;
      o.b = base * (0.86 + 0.20 * weave) * 0.60;
      o.rough = 0.93 - 0.06 * weave - 0.05 * grid;
      o.metal = 0.0;
      o.ao = 1 - 0.18 * (1 - weave);
      o.h = weave * 0.35 + grid * 0.9 + dirt * 0.12;
    },
  });
}

/** Fired brass: warm, drawn along the case axis, sooted at the neck. */
function brassCase(size = 128) {
  return bake(size, {
    slope: 0.070, slopeMax: 0.17, roughFloor: 0.34, toks: 1.0,
    fill: (u, v, o, C) => {
      const draw = streak(u, v, C(3), C(28), 1, 17);
      const soot = fbm(u, v, 3, 47, C, 3);
      o.r = 0.44 * (0.85 + 0.25 * draw) * (1 - 0.35 * soot);
      o.g = 0.30 * (0.85 + 0.25 * draw) * (1 - 0.40 * soot);
      o.b = 0.10 * (0.85 + 0.25 * draw) * (1 - 0.50 * soot);
      o.rough = 0.34 + 0.14 * soot + 0.05 * (draw - 0.5);
      o.metal = 0.96;
      o.ao = 1;
      o.h = draw * 0.25 + soot * 0.15;
    },
  });
}

/* ------------------------------------------------------------------ export */

/**
 * Bake every zone once. Roughly 1.3 M texels of synthesis plus a third again for
 * the hand-built mip chains; it runs inside the existing load screen and costs
 * nothing afterwards.
 */
export function bakeWeaponTextures(scale = 1) {
  const s = (n) => Math.max(64, Math.round(n * scale));
  return {
    steel: phosphate(s(512)),
    polymer: polymer(s(512)),
    stipple: stipple(s(256)),
    alu: anodised(s(512)),
    glove: gloveFabric(s(512)),
    rubber: rubber(s(256)),
    sleeve: ripstop(s(256)),
    brass: brassCase(s(128)),
  };
}

export function disposeWeaponTextures(sets) {
  for (const set of Object.values(sets)) {
    set.map.dispose(); set.normalMap.dispose(); set.orm.dispose();
  }
}
