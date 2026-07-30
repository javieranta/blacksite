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
 * Tactical glove back: a twill-woven synthetic in coyote brown, with two
 * crossing runs of stitching. The weave carries the normal map; the stitching is
 * a periodic run of raised beads. Kept coarse on purpose — a weave finer than the
 * mip footprint aliases into a shimmering hatch instead of reading as fabric.
 *
 * ─── THE VALUE IS THE WHOLE POINT ─────────────────────────────────────────
 *
 * This zone has now been lifted twice, and the first lift is worth recording
 * because it was a correct diagnosis with an insufficient dose. It went from
 * 0.0135-0.0195 linear (sRGB 36, DARKER than the polymer lower it grips) to
 * 0.052-0.072 linear (sRGB ~78), which is 2x the polymer's albedo and was
 * believed to be the fix.
 *
 * tools/handlegibility.mjs measured what that 2x albedo ratio actually became on
 * screen: 1.145. Not 2x. Not even 1.3x. The hand pixels came out at displayed
 * luminance 32.1 against the weapon's 28.0 — a 15% step, which is roughly the
 * difference between two facets of the same object and nowhere near enough to
 * declare a different one. Two things eat it:
 *
 *   1. THE TONE CURVE. Both values sit in the compressed shadow toe, where AgX
 *      spends very little output range on a large input range. An albedo ratio
 *      arrives on screen raised to something like the power 0.45.
 *   2. THE LIGHTING IS NOT SHARED. The weapon's visible surfaces are its top and
 *      its left flank, which take the key. The hands are on the underside and the
 *      far flank, lit mainly by the blue fill and rim. So the hand's albedo is
 *      multiplied by a *smaller* number than the weapon's — measured at 0.84 of
 *      it — and it was arriving cooler than the gun as well (warmth -0.053 vs
 *      -0.037), because the fill is 0x9fb4cc.
 *
 * A 2x albedo step therefore cannot survive. This is 0.235/0.170/0.088 linear —
 * sRGB about (135, 116, 86), a mid coyote-brown glove, 5x the polymer's
 * luminance and with an r:b ratio of 2.7 against the polymer's 1.1. Five times
 * the albedo survives the toe as roughly 1.7-1.9x on screen, and a 2.7:1 red-blue
 * ratio in the ALBEDO is warmth no cool fill light can cancel — which is the
 * property that matters, because the fill is the light the hands actually get.
 */
/**
 * Tactical glove back: a 2/1 TWILL synthetic in coyote brown, seamed and soiled.
 *
 * ─── WHY THIS WAS REBUILT: THE DETAIL WAS IN THE WRONG CHANNEL ────────────
 *
 * Round 10's tile was not featureless. Measured offline it carried 8.1 degrees of
 * RMS weave tilt in its normal map, and the review at 6x still read the fingers as
 * "bare wax". tools/handcheck.mjs then measured why, and it is the kind of answer
 * no amount of looking at the tile could have given:
 *
 *   nrmShare = -0.02.  Forcing normalScale to ZERO on every hand material changed
 *   the hands' on-screen local contrast by less than the frame noise. The normal
 *   map was contributing nothing at all.
 *
 * tools/_nrmab.mjs took that apart clamp by clamp. Disabling the LOD fade, the
 * tilt ceiling and the terminator guard together — every shader limiter stacked on
 * the map — recovered 14.7 -> 17.2, and doubling normalScale on top of that got
 * 18.4. So the clamps were real and they were also not the main story: even
 * completely unclamped and at 2x, a normal map is worth about a sixth of this
 * surface's contrast. The reason is the lighting. The hands sit on the weapon's
 * underside and far flank; their illumination is an environment probe plus a
 * hemisphere wrap plus a weak fill, and ALL THREE vary smoothly with the normal.
 * There is no sharp light for a perturbed normal to catch. On a surface lit that
 * way a normal map cannot produce micro-contrast no matter how steep it is.
 *
 * What CAN, on the same measurement: the AO channel. `aoMap` multiplies indirect
 * light, indirect is very nearly all the light these hands get, and pushing the
 * baked AO through a gamma took the same number 14.7 -> 21.2 at aoDetail 3 and
 * 27.1 at 6 — twice the authority of the normal map, from the same tile.
 *
 * So the weave, the seam channels and the fibre interstices are authored here
 * primarily as OCCLUSION and as ALBEDO, with height as the third channel rather
 * than the first. That is an unusual weighting for a PBR bake and it is the
 * correct one for this specific surface under this specific rig — which is a
 * thing that had to be measured, because it is the opposite of the default
 * instinct and the default instinct is what shipped twice.
 */
function gloveFabric(size = 512) {
  /**
   * Diagonal ribs per tile. 20 over a 30 mm tile is a 1.5 mm twill line.
   *
   * Coarser than the 30 it was, and coarser than a real glove's face fabric,
   * which is a deliberate trade made at the magnification the surface is
   * actually seen at. A finger is 1.35 tiles round; at 30 ribs that is 40 ribs
   * round a digit ~55 px wide, i.e. under three pixels a rib, which the mip
   * chain and the tone curve between them reduce to a flat grey. Detail below
   * what a pixel can hold is not detail — the same argument the phosphate tooth
   * is authored on, one file up.
   */
  const RIBS = 20;
  return bake(size, {
    slope: 0.30, slopeMax: 0.55, roughFloor: 0.45, toks: 0.80,
    fill: (u, v, o, C) => {
      /**
       * A REAL TWILL, not a symmetric diamond.
       *
       * The previous weave was sin((u+v)) plus sin((u-v)) at equal frequency,
       * which is a square lattice rotated 45 degrees. Two things follow and both
       * were visible at 6x: it has no direction, so it reads as printed mesh
       * rather than as cloth; and its two families cancel at the nodes, so its
       * contrast collapses exactly where a weave should be busiest. A twill has
       * ONE dominant rib family running at a consistent angle, interrupted by the
       * perpendicular yarn crossing under it. That asymmetry is the entire visual
       * difference between fabric and netting.
       *
       * Frequencies are integers per tile in both u and v, so the tile still
       * wraps. The steepest family is 67 cycles across 512 texels — 7.6 texels a
       * cycle, comfortably above the six-texel floor the bake enforces on lattice
       * noise, so this is representable rather than aliased into hash.
       */
      const d = (u * 2 + v) * RIBS;
      const dz = d - Math.floor(d);
      // Rounded float on top, sharp valley between: a yarn lying over its
      // neighbour, not a sine.
      const rib = Math.pow(Math.sin(Math.PI * dz), 0.55);
      const w = (u - v * 2) * RIBS * 0.9;
      const wz = w - Math.floor(w);
      const pick = 0.5 + 0.5 * Math.cos(2 * Math.PI * wz);
      // Where a pick crosses over, the rib dips under it. That interruption is
      // what stops 30 parallel ribs reading as corduroy.
      const weave = rib * (0.62 + 0.38 * pick);
      // The interstice — the hole between four yarns — is the deepest occlusion
      // on the surface and the single feature that most says "woven".
      const gap = Math.pow(Math.max(0, 1 - weave / 0.34), 2);
      const fibre = vn(u, v, C(110), 5);
      const dirt = fbm(u, v, 3, 83, C, 4);

      /**
       * NO SEAMS IN THIS TILE. This is the one change here that was made by
       * looking rather than by reasoning, and it reversed a decision taken two
       * paragraphs of comment ago.
       *
       * Crossing stitch runs were authored at 3 and 2 per tile, which is about
       * one per phalanx at the density a FINGER's UVs have. The palm's UVs are
       * nothing like a finger's: its section is 152 mm round against a finger's
       * 40 mm, so the same tile repeats 5.1 times across it and the same two
       * seam families arrived as ten stitch lines and six cross lines — a
       * machine-regular lattice over the back of the hand. At 6x it read as
       * quilting, or as a wireframe, and it was the loudest thing on the surface.
       *
       * A tiled texture fundamentally cannot place a seam, because a seam is a
       * feature of the GARMENT and the tile does not know where on the garment it
       * has landed. Only the geometry knows. So the seams moved to Hands.js —
       * `lateralSeam` puts a bound panel edge down each digit's flank, the thumb
       * crotch gets a real binding, the knuckle pads and the cuff carry their own
       * rims — and this tile is left to do the one job a tile is actually good
       * at, which is the weave.
       */
      // Grime settles into the weave; it is the only thing keeping a light glove
      // from reading as a clean studio prop.
      const grime = sstep(0.42, 0.88, dirt);
      // Worn, burnished patches where the glove rubs the weapon. Low frequency
      // and irregular, so it can never organise itself into a grid.
      const rub = sstep(0.52, 0.90, fbm(u, v, 2, 419, C, 3));

      /**
       * VALUE HELD, CONTRAST TRIPLED.
       *
       * The base linear value is up 8% only, and only to pay for the AO gamma
       * that Materials.js now applies — the measured cost of aoDetail 2.6 is
       * about 8% of mean displayed luminance, and the hand-to-weapon value
       * separation that landed in round 9 is a fix that must not be spent twice.
       * Everything else here is contrast around that value, not more of it:
       *
       *   the weave modulates albedo by 0.55 where it modulated by 0.30
       *   the interstices take albedo DOWN, which the old tile never did
       *   the seam channel is a hard dark line, the beads a hard light one
       *
       * r:b stays at 2.08. That ratio is a defence against exactly one thing: a
       * cool fill multiplying the albedo down to neutral. A previous round found
       * 2.7 photographed as bare peach SKIN and cut it to 1.92; 2.08 with the
       * fill desaturated is warmth the hand keeps without becoming flesh, and it
       * is not the lever being pulled here.
       */
      const base = (0.2150 + 0.0700 * dirt) * (1 - 0.46 * grime);
      const lit = 0.70 * weave + 0.06 * rub;
      /**
       * The interstice darkens PER CHANNEL, not uniformly.
       *
       * Same physics as the cavity term in Materials.js: light that goes into
       * the hole between four yarns bounces off the yarns two or three times
       * before it comes out, so it is multiplied by the fabric's albedo two or
       * three times over. The hole is therefore a more saturated brown than the
       * float beside it. Darkening all three channels equally instead makes the
       * hole a grey, and a grey pixel dark enough to be lit only by a blue sky
       * probe is exactly the pixel that fails the cyan assertion.
       */
      o.r = base * (0.780 + lit) * (1 - 0.30 * gap);
      o.g = base * (0.608 + lit) * (1 - 0.42 * gap);
      o.b = base * (0.375 + lit) * (1 - 0.56 * gap);
      /**
       * ROUGHNESS 0.46-0.70, and STRUCTURED.
       *
       * The brief band, and more usefully a band with the weave in it: a yarn
       * float is burnished by wear and a bit smoother, the interstice between
       * yarns is raw fibre and rougher, a stitch bead is polished thread. That
       * spread is what gives the broad soft sheen a worn glove has somewhere to
       * vary, which is the only specular cue available on a surface lit almost
       * entirely by a smooth environment.
       */
      o.rough = 0.585 - 0.105 * weave + 0.115 * gap + 0.040 * (fibre - 0.5)
        - 0.110 * rub + 0.050 * grime;
      o.metal = 0.0;
      /**
       * THE PRIMARY DETAIL CHANNEL — see the header. Mean is held near 0.90 and
       * the swing is put into narrow deep valleys (interstices, seam channels)
       * rather than into a broad wash, because a broad wash is just a darker
       * glove and costs the value separation for nothing.
       */
      o.ao = clamp01(1 - 0.52 * gap - 0.18 * (1 - weave) - 0.08 * grime);
      // Height is the third channel now, but it is not zero: the rib floats still
      // want a grazing-key wobble, and the bake's auto-gain normalises whatever
      // mix is authored here to the target RMS slope.
      o.h = weave * 0.72 - gap * 0.34 + fibre * 0.04;
    },
  });
}

/**
 * Glove palm and finger-pad leather: pebble-grained goat hide, warmer and a shade
 * deeper than the fabric back, and markedly SMOOTHER — a worn palm has a sheen
 * the woven back never gets.
 *
 * It exists for one reason: the palm band is the largest single camera-facing
 * surface on either hand, and rendering it in the same material as the fingers
 * that lie across it means the biggest shape on the hand has no internal
 * boundary. Two materials meeting along the metacarpal line gives the eye a
 * seam to read the palm's curvature against, and the roughness split does it
 * without any value trickery: the leather picks up a broad soft highlight where
 * the fabric stays matte.
 */
function gloveLeather(size = 256) {
  return bake(size, {
    slope: 0.22, slopeMax: 0.40, roughFloor: 0.40, toks: 0.85,
    fill: (u, v, o, C) => {
      // Pebble grain: two decorrelated cell noises, the finer one ridged so the
      // grain has creases between the pebbles rather than only bumps.
      const cell = vn(u, v, C(30), 211);
      const fine = 1 - Math.abs(vn(u, v, C(58), 37) * 2 - 1);
      const pebble = cell * 0.66 + fine * 0.34;
      // The valley BETWEEN pebbles, as its own term. A pebble grain read only as
      // bumps is a bumpy sheet; read as bumps with dark gaps it is hide. Same
      // argument as the fabric's interstice, and the same channel does the work.
      const gap = Math.pow(Math.max(0, 1 - pebble / 0.40), 2);
      // Burnish: the pad of the palm and the finger pads polish smooth first.
      const rub = sstep(0.48, 0.84, fbm(u, v, 3, 167, C, 3));
      const crease = Math.pow(Math.max(0, 1 - Math.abs(((v * 4 + 0.2) % 1) - 0.5) * 2 / 0.09), 2);
      // No tiled binding here either, and for the same measured reason as the
      // fabric: the palm carries five repeats of this tile across its section, so
      // any per-tile seam arrives as five parallel lines round the hand. The
      // palm panel's real boundary is the arc where this material meets the
      // fabric, which the geometry already draws.
      // A shade deeper and a touch redder than the fabric back, which is how a
      // hide palm panel actually reads — but held to the same desaturation the
      // fabric got, or the palm becomes the peach brick the fabric stopped being.
      const base = 0.1580 + 0.0480 * pebble;
      o.r = base * (1.000 + 0.24 * pebble) * (1 - 0.22 * gap) + rub * 0.026;
      o.g = base * (0.720 + 0.24 * pebble) * (1 - 0.34 * gap) + rub * 0.021;
      o.b = base * (0.455 + 0.24 * pebble) * (1 - 0.48 * gap) + rub * 0.013;
      /**
       * The material split lives HERE, and it widened. 0.40-0.60 against the
       * fabric's 0.46-0.70 was too close to part them: the review could see the
       * palm panel's outline (the geometry gives it one) and not that it was a
       * different substance. Hide is genuinely glossier than a woven back, and
       * on a surface whose only light is a smooth environment the specular lobe
       * is most of what a material has left to say.
       */
      o.rough = 0.545 - 0.145 * rub + 0.08 * (pebble - 0.5) + 0.07 * crease
        + 0.10 * gap;
      o.metal = 0.0;
      o.ao = clamp01(1 - 0.44 * gap - 0.12 * (1 - pebble) - 0.26 * crease);
      o.h = pebble * 0.74 - gap * 0.32 - crease * 0.85;
    },
  });
}

/**
 * WRIST CUFF: a neoprene gauntlet with a hook-and-loop closure.
 *
 * It exists because the review found "no wrist cuff; a hard diagonal colour
 * break butts hand to sleeve". That break is real and it is a MATERIAL problem
 * before it is a geometry one: two tubes meeting end to end, one glove-coloured
 * and one sleeve-coloured, produce a line across the arm with nothing on it. A
 * real glove solves this by overlapping — the cuff is a third piece that laps
 * over the sleeve and is bound to the glove, so the transition is 40 mm of a
 * different substance rather than a join.
 *
 * Its value sits deliberately BETWEEN the two it separates: lighter than the
 * ripstop so the eye does not stop at it, darker than the glove so the hand
 * stays the brightest thing on the rig. The nap is fine and dense, which under a
 * smooth environment reads as a matte velvet band — the opposite of both
 * neighbours and therefore legible against both.
 */
function gloveCuff(size = 256) {
  return bake(size, {
    slope: 0.24, slopeMax: 0.42, roughFloor: 0.66, toks: 0.80,
    fill: (u, v, o, C) => {
      /**
       * Loop nap: dense, near-isotropic, FINE, and low contrast.
       *
       * The first pass authored this at the glove's contrast and it photographed
       * as a black basket-weave band — a tyre, or a rubber grip sleeve, and much
       * darker than the ripstop it is supposed to sit between. A velvet loop face
       * is the least contrasty surface on the whole rig: it is what it is because
       * light goes into it and does not come back, so its detail is a fine even
       * tooth, not a lattice.
       */
      const nap = vn(u, v, C(74), 401) * 0.55 + vn(u, v, C(40), 17) * 0.45;
      const napGap = Math.pow(Math.max(0, 1 - nap / 0.38), 2);
      // The elastic gathers, running around the cuff: shallow parallel folds.
      const gather = 0.5 + 0.5 * Math.cos((u * 7) * Math.PI * 2);
      const fold = Math.pow(gather, 1.8);
      const dirt = fbm(u, v, 3, 313, C, 3);
      const grime = sstep(0.40, 0.86, dirt);
      /**
       * VALUE BETWEEN ITS TWO NEIGHBOURS, WHICH IS THE WHOLE JOB.
       *
       * 0.128 linear against the glove's 0.190 and the ripstop's 0.058. That
       * ordering is the entire reason this piece exists: the eye has to be able
       * to follow hand -> cuff -> sleeve as a limb going out of frame, and a cuff
       * darker than the sleeve inverts that and turns the wrist into the darkest
       * point on the arm, which is where a coupling would be.
       */
      const base = (0.1420 + 0.0330 * dirt) * (1 - 0.26 * grime);
      o.r = base * (0.940 + 0.16 * nap + 0.09 * fold) * (1 - 0.16 * napGap);
      o.g = base * (0.762 + 0.16 * nap + 0.09 * fold) * (1 - 0.24 * napGap);
      o.b = base * (0.520 + 0.16 * nap + 0.09 * fold) * (1 - 0.36 * napGap);
      // Velvet: high and nearly flat. The mattest zone on the rig by design.
      o.rough = 0.865 - 0.045 * nap + 0.040 * napGap + 0.030 * grime;
      o.metal = 0.0;
      o.ao = clamp01(1 - 0.30 * napGap - 0.14 * (1 - gather));
      o.h = nap * 0.34 + fold * 0.62;
    },
  });
}

/**
 * Knuckle-armour and finger-pad rubber. A separate zone from the weapon's
 * `rubber`, which is deliberately near-black for the buttpad and the eyecup.
 *
 * At the glove's new albedo a near-black pad is a 13:1 step and the knuckle row
 * turns into four holes punched in the hand. Four times the glove is the ratio
 * that separates four knuckles into four knuckles: dark enough to be armour,
 * light enough to still be part of the same object.
 */
function padRubber(size = 256) {
  return bake(size, {
    slope: 0.150, slopeMax: 0.30, roughFloor: 0.62, toks: 0.80,
    fill: (u, v, o, C) => {
      const cell = vn(u, v, C(36), 3);
      const fine = vn(u, v, C(58), 71);
      const dust = fbm(u, v, 3, 29, C, 3);
      // Moulded hex dimple pattern, coarse enough to survive minification.
      const a = (u + v) * 16, b = (u - v) * 16;
      const fa = Math.abs(a - Math.floor(a) - 0.5) * 2;
      const fb = Math.abs(b - Math.floor(b) - 0.5) * 2;
      const dimple = Math.max(0, 1 - (fa + fb) * 0.80);
      // The moulding line between dimples, as its own occlusion term — same
      // argument as the fabric's interstice. On a pad that is only ever seen at
      // foreground magnification, the gap between features is what carries the
      // read, not the features.
      const web = Math.pow(Math.max(0, 1 - dimple / 0.34), 2);
      /**
       * LIGHTER, AND MUCH LESS OCCLUDED. The first pass at this drove the base
       * down with `web` and pushed AO to 0.46 on top of an aoDetail gamma of 2.2,
       * and the knuckle armour photographed as a black triangular HOLE punched in
       * the back of the hand — the exact failure this zone was split off the
       * weapon's near-black `rubber` to avoid, arrived at from the other
       * direction. 0.076 against the glove's 0.190 is a 2.5:1 step: dark enough
       * to be a different substance, light enough to still be part of the hand.
       */
      const base = 0.0760 + 0.0180 * dust;
      o.r = base * (0.99 + 0.16 * cell + 0.22 * dimple);
      o.g = base * (0.95 + 0.16 * cell + 0.22 * dimple);
      o.b = base * (0.88 + 0.16 * cell + 0.22 * dimple);
      o.rough = 0.700 - 0.14 * dimple - 0.05 * cell + 0.09 * web + 0.04 * (fine - 0.5);
      o.metal = 0.0;
      o.ao = clamp01(1 - 0.14 * (1 - cell) - 0.24 * web);
      o.h = cell * 0.55 + dimple * 0.95 - web * 0.35 + fine * 0.05;
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
      /**
       * A CLEAR STEP BELOW THE GLOVE, and that ordering is deliberate.
       *
       * Coyote, not olive: a green sleeve is the odd note in a scene lit by a low
       * sun through dust, so the one cool object reads as belonging to neither
       * the weapon nor the shooter. But it must also stay DARKER than the glove.
       * The forearm is the largest single piece of the hand rig on screen (~450 px
       * crossing to the bottom-left corner) and when it was the brightest thing
       * in the lower half of the frame it read as a pipe lying in the level. A
       * dark sleeve ending in a light hand is a limb; a light sleeve ending in a
       * dark hand is plumbing.
       *
       * Lifting this in step with the glove was tried and reverted the same
       * round: at 0.088 the forearm became the brightest tube in the lower half
       * of the frame and read, exactly as it had two rounds earlier, as a length
       * of pipe with a coupling on it. The glove's job is to be the lightest
       * thing on the rig, and the sleeve's job is to be dark enough that the eye
       * follows it out of frame rather than stopping on it. 0.058 is a third of
       * the glove.
       */
      const base = 0.0580 + 0.0215 * dirt;
      o.r = base * (0.98 + 0.20 * weave) * 1.10;
      o.g = base * (0.94 + 0.20 * weave) * 0.84;
      o.b = base * (0.86 + 0.20 * weave) * 0.52;
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
    leather: gloveLeather(s(256)),
    cuff: gloveCuff(s(256)),
    padrubber: padRubber(s(256)),
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
