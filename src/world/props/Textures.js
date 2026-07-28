import * as THREE from 'three';
import { fbmField, cellField, clamp } from './Rand.js';

/**
 * Canvas / typed-array texture foundry for the prop library.
 * OWNER: props agent.
 *
 * ZERO external assets: every byte of every map here is computed at runtime from
 * noise fields and 2D canvas drawing. Albedo, height, normal and roughness are
 * always derived from the SAME height field so the shading agrees with the paint
 * — that agreement is most of what separates a believable surface from a tinted
 * primitive.
 */

export class Textures {
  constructor(renderer) {
    this.aniso = Math.min(8, renderer?.capabilities?.getMaxAnisotropy?.() ?? 4);
    this._grain = new Map();
    this._owned = [];
  }

  /* ---------------------------------------------------------------- canvases */

  canvas(size) {
    return this.canvasWH(size, size);
  }

  canvasWH(w, h) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.ceil(w));
    c.height = Math.max(1, Math.ceil(h));
    const g = c.getContext('2d', { willReadFrequently: true });
    g.imageSmoothingEnabled = true;
    return { c, g, size: c.width };
  }

  /** Grayscale fBm tile, cached by key — used as a grain/dirt overlay brush. */
  grain(size, seed, { octaves = 5, baseFreq = 6, contrast = 1, ridged = false } = {}) {
    const key = `${size}|${seed}|${octaves}|${baseFreq}|${contrast}|${ridged}`;
    if (this._grain.has(key)) return this._grain.get(key);
    const f = fbmField(size, { octaves, baseFreq, seed, ridged });
    const { c, g } = this.canvas(size);
    const img = g.createImageData(size, size);
    for (let i = 0; i < f.length; i++) {
      const v = clamp(((f[i] - 0.5) * contrast + 0.5) * 255, 0, 255) | 0;
      img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
      img.data[i * 4 + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    this._grain.set(key, c);
    return c;
  }

  /** Cellular tile (aggregate, gravel, rust bloom, cracked paint). */
  cells(size, seed, { cells = 10, invert = false } = {}) {
    const key = `cell|${size}|${seed}|${cells}|${invert}`;
    if (this._grain.has(key)) return this._grain.get(key);
    const f = cellField(size, { cells, seed, invert });
    const { c, g } = this.canvas(size);
    const img = g.createImageData(size, size);
    for (let i = 0; i < f.length; i++) {
      const v = (f[i] * 255) | 0;
      img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
      img.data[i * 4 + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    this._grain.set(key, c);
    return c;
  }

  /** Overlay a grain tile across a whole canvas at a given blend/alpha. */
  overlay(g, size, tile, alpha = 0.3, mode = 'overlay', scale = 1) {
    g.save();
    g.globalAlpha = alpha;
    g.globalCompositeOperation = mode;
    const step = tile.width * scale;
    for (let y = 0; y < size; y += step) {
      for (let x = 0; x < size; x += step) g.drawImage(tile, x, y, step, step);
    }
    g.restore();
  }

  /* ------------------------------------------------------- map construction */

  /** sRGB colour texture from a canvas. */
  colorTex(canvas, repeat = 1) {
    const t = new THREE.CanvasTexture(canvas);
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeat, repeat);
    t.anisotropy = this.aniso;
    t.needsUpdate = true;
    this._owned.push(t);
    return t;
  }

  /** Non-colour data texture from a canvas (roughness, metalness, alpha, ao). */
  dataTex(canvas, repeat = 1) {
    const t = new THREE.CanvasTexture(canvas);
    t.colorSpace = THREE.NoColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeat, repeat);
    t.anisotropy = this.aniso;
    t.needsUpdate = true;
    this._owned.push(t);
    return t;
  }

  /** Read a canvas back as a Float32 luminance field in [0,1]. */
  readHeight(canvas) {
    const size = canvas.width;
    const g = canvas.getContext('2d', { willReadFrequently: true });
    const d = g.getImageData(0, 0, size, size).data;
    const out = new Float32Array(size * size);
    for (let i = 0; i < out.length; i++) {
      out[i] = (d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114) / 255;
    }
    return out;
  }

  /**
   * Sobel height -> tangent-space normal map. `strength` is in height units per
   * texel; bump it for coarse surfaces (concrete) and drop it for smooth ones.
   */
  normalFromHeight(field, size, strength = 2.0) {
    const data = new Uint8Array(size * size * 4);
    const at = (x, y) => field[((y + size) % size) * size + ((x + size) % size)];
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const l = at(x - 1, y), r = at(x + 1, y);
        const d = at(x, y + 1), u = at(x, y - 1);
        const dx = (l - r) * strength;
        const dy = (d - u) * strength;
        let nx = dx, ny = dy, nz = 1;
        const len = Math.hypot(nx, ny, nz) || 1;
        nx /= len; ny /= len; nz /= len;
        const i = (y * size + x) * 4;
        data[i] = ((nx * 0.5 + 0.5) * 255) | 0;
        data[i + 1] = ((ny * 0.5 + 0.5) * 255) | 0;
        data[i + 2] = ((nz * 0.5 + 0.5) * 255) | 0;
        data[i + 3] = 255;
      }
    }
    const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
    t.colorSpace = THREE.NoColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = this.aniso;
    t.needsUpdate = true;
    this._owned.push(t);
    return t;
  }

  /**
   * Roughness (and optionally metalness in B) from a height field. Cavities read
   * rougher and slightly less metallic — grime collects in them.
   */
  roughFromHeight(field, size, { base = 0.75, range = 0.25, invert = false, metal = null, extra = null } = {}) {
    const data = new Uint8Array(size * size * 4);
    for (let i = 0; i < field.length; i++) {
      let h = field[i];
      if (invert) h = 1 - h;
      let r = clamp(base + (h - 0.5) * range * 2, 0.03, 1);
      if (extra) r = clamp(r * extra[i], 0.03, 1);
      const m = metal == null ? 0 : clamp(metal * (0.65 + h * 0.5), 0, 1);
      const j = i * 4;
      data[j] = (clamp(1 - h, 0, 1) * 255) | 0;      // AO-ish in R (unused by std)
      data[j + 1] = (r * 255) | 0;                    // roughness reads G
      data[j + 2] = (m * 255) | 0;                    // metalness reads B
      data[j + 3] = 255;
    }
    const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
    t.colorSpace = THREE.NoColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = this.aniso;
    t.needsUpdate = true;
    this._owned.push(t);
    return t;
  }

  /* -------------------------------------------------- painter helper library */

  /** Flat fill with a subtle two-tone vertical ramp (ambient gradient). */
  fillRamp(g, x, y, w, h, top, bottom) {
    const grd = g.createLinearGradient(x, y, x, y + h);
    grd.addColorStop(0, top);
    grd.addColorStop(1, bottom);
    g.fillStyle = grd;
    g.fillRect(x, y, w, h);
  }

  /** Plank run with dark gaps + per-plank tone variation. */
  planks(g, hg, x, y, w, h, {
    count = 5, vertical = false, colour = '#8a6a44', gap = 0.06, rng, hi = '#ffffff', lo = '#000000',
  }) {
    const n = count;
    const span = (vertical ? w : h) / n;
    for (let i = 0; i < n; i++) {
      const t = rng.range(-0.06, 0.06);
      const c = shade(colour, t);
      const px = vertical ? x + i * span : x;
      const py = vertical ? y : y + i * span;
      const pw = vertical ? span : w;
      const ph = vertical ? h : span;
      g.fillStyle = c;
      g.fillRect(px, py, pw, ph);
      // gap shadow between planks
      g.fillStyle = 'rgba(0,0,0,0.42)';
      if (vertical) g.fillRect(px, py, Math.max(1, span * gap), ph);
      else g.fillRect(px, py, pw, Math.max(1, span * gap));
      if (hg) {
        hg.fillStyle = `rgb(${(150 + t * 400) | 0},${(150 + t * 400) | 0},${(150 + t * 400) | 0})`;
        hg.fillRect(px, py, pw, ph);
        hg.fillStyle = lo;
        if (vertical) hg.fillRect(px, py, Math.max(1, span * gap), ph);
        else hg.fillRect(px, py, pw, Math.max(1, span * gap));
      }
    }
    void hi;
  }

  /**
   * Worn stencil text. Drawn to a scratch layer, eroded with random bites, then
   * composited — so it reads as sprayed-through-a-plate paint rather than a font.
   */
  stencil(g, x, y, w, h, text, {
    colour = '#e8e2d2', size = 34, rng, align = 'center', wear = 0.45, font = 'monospace', spacing = 2,
  }) {
    const scratch = this.canvasWH(w, h);
    const tmp = scratch.g;
    tmp.clearRect(0, 0, w, h);
    tmp.fillStyle = colour;
    tmp.font = `bold ${size}px ${font}`;
    tmp.textAlign = align;
    tmp.textBaseline = 'middle';
    const cx = align === 'center' ? w / 2 : 2;
    // letter-spaced draw for a stencil-plate look
    if (spacing > 0) {
      const chars = [...text];
      let total = 0;
      for (const ch of chars) total += tmp.measureText(ch).width + spacing;
      let px = align === 'center' ? (w - total) / 2 : 2;
      for (const ch of chars) {
        tmp.textAlign = 'left';
        tmp.fillText(ch, px, h / 2);
        px += tmp.measureText(ch).width + spacing;
      }
    } else {
      tmp.fillText(text, cx, h / 2);
    }
    // erode
    tmp.globalCompositeOperation = 'destination-out';
    const bites = Math.round(w * h * 0.0018 * wear * 12);
    for (let i = 0; i < bites; i++) {
      const bx = rng.range(0, w), by = rng.range(0, h);
      const br = rng.range(0.6, 3.2);
      tmp.beginPath();
      tmp.arc(bx, by, br, 0, Math.PI * 2);
      tmp.fill();
    }
    tmp.globalCompositeOperation = 'source-over';
    g.save();
    g.globalAlpha = 0.92;
    g.drawImage(tmp.canvas, x, y);
    g.restore();
  }

  /** Vertical rust / grime runs weeping from a point. */
  streaks(g, x, y, w, h, { rng, count = 10, colour = '30,18,10', alpha = 0.22, len = 0.7 }) {
    for (let i = 0; i < count; i++) {
      const sx = x + rng.range(0, w);
      const sy = y + rng.range(0, h * 0.5);
      const sw = rng.range(1.2, 5.5);
      const sh = rng.range(h * 0.15, h * len);
      const grd = g.createLinearGradient(sx, sy, sx, sy + sh);
      grd.addColorStop(0, `rgba(${colour},${alpha * 1.4})`);
      grd.addColorStop(0.35, `rgba(${colour},${alpha})`);
      grd.addColorStop(1, `rgba(${colour},0)`);
      g.fillStyle = grd;
      g.fillRect(sx, sy, sw, sh);
    }
  }

  /** Rust blooms: irregular patches of oxide eating through paint. */
  rust(g, hg, x, y, w, h, { rng, count = 7, colour = '#7a4a2a', dark = '#3c2414' }) {
    for (let i = 0; i < count; i++) {
      const cx = x + rng.range(0, w), cy = y + rng.range(0, h);
      const r = rng.range(w * 0.02, w * 0.11);
      g.save();
      g.globalAlpha = rng.range(0.35, 0.85);
      const grd = g.createRadialGradient(cx, cy, 0, cx, cy, r);
      grd.addColorStop(0, dark);
      grd.addColorStop(0.55, colour);
      grd.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grd;
      g.beginPath();
      // lumpy blob
      const lobes = 9;
      for (let k = 0; k <= lobes; k++) {
        const a = (k / lobes) * Math.PI * 2;
        const rr = r * (0.55 + 0.55 * ((k * 37 % 11) / 11));
        const px = cx + Math.cos(a) * rr, py = cy + Math.sin(a) * rr;
        if (k === 0) g.moveTo(px, py); else g.lineTo(px, py);
      }
      g.closePath();
      g.fill();
      g.restore();
      if (hg) {
        hg.save();
        hg.globalAlpha = 0.5;
        hg.fillStyle = '#404040';
        hg.beginPath();
        hg.arc(cx, cy, r * 0.7, 0, Math.PI * 2);
        hg.fill();
        hg.restore();
      }
    }
  }

  /** Rivet / bolt row. Writes highlights to albedo and bumps to height. */
  rivets(g, hg, x0, y0, x1, y1, { count = 8, r = 2.6, colour = '#b9bcc0' }) {
    for (let i = 0; i < count; i++) {
      const t = count === 1 ? 0.5 : i / (count - 1);
      const px = x0 + (x1 - x0) * t, py = y0 + (y1 - y0) * t;
      const grd = g.createRadialGradient(px - r * 0.3, py - r * 0.3, 0, px, py, r);
      grd.addColorStop(0, colour);
      grd.addColorStop(1, 'rgba(0,0,0,0.55)');
      g.fillStyle = grd;
      g.beginPath(); g.arc(px, py, r, 0, Math.PI * 2); g.fill();
      if (hg) {
        hg.fillStyle = '#f0f0f0';
        hg.beginPath(); hg.arc(px, py, r * 0.85, 0, Math.PI * 2); hg.fill();
      }
    }
  }

  /** Diagonal hazard stripes clipped to a rect. */
  stripes(g, x, y, w, h, { a = '#d8b219', b = '#1b1b1d', width = 14, angle = -0.7 }) {
    g.save();
    g.beginPath(); g.rect(x, y, w, h); g.clip();
    g.fillStyle = a; g.fillRect(x, y, w, h);
    g.fillStyle = b;
    g.translate(x, y);
    g.rotate(angle);
    const span = (w + h) * 1.6;
    for (let i = -span; i < span; i += width * 2) g.fillRect(i, -span, width, span * 2);
    g.restore();
  }

  /** Scratches and scuffs — thin bright/dark lines following no grid. */
  scuffs(g, x, y, w, h, { rng, count = 26, light = 'rgba(255,255,255,0.16)', dark = 'rgba(0,0,0,0.3)' }) {
    for (let i = 0; i < count; i++) {
      const sx = x + rng.range(0, w), sy = y + rng.range(0, h);
      const a = rng.range(0, Math.PI * 2);
      const l = rng.range(w * 0.02, w * 0.22);
      g.strokeStyle = rng.bool(0.5) ? light : dark;
      g.lineWidth = rng.range(0.5, 1.6);
      g.beginPath();
      g.moveTo(sx, sy);
      g.lineTo(sx + Math.cos(a) * l, sy + Math.sin(a) * l);
      g.stroke();
    }
  }

  /** Dirt accumulation in the lower part of a panel. */
  groundGrime(g, x, y, w, h, amount = 0.5) {
    const grd = g.createLinearGradient(x, y + h, x, y + h * (1 - amount));
    grd.addColorStop(0, 'rgba(28,22,16,0.62)');
    grd.addColorStop(1, 'rgba(28,22,16,0)');
    g.fillStyle = grd;
    g.fillRect(x, y, w, h);
  }

  dispose() {
    for (const t of this._owned) t.dispose();
    this._owned.length = 0;
    this._grain.clear();
  }
}

/** Shift a hex colour by a signed amount in linear-ish space. */
export function shade(hex, amt) {
  const c = new THREE.Color(hex);
  const f = 1 + amt;
  return `rgb(${clamp(c.r * 255 * f, 0, 255) | 0},${clamp(c.g * 255 * f, 0, 255) | 0},${clamp(c.b * 255 * f, 0, 255) | 0})`;
}

export function rgba(hex, a) {
  const c = new THREE.Color(hex);
  return `rgba(${(c.r * 255) | 0},${(c.g * 255) | 0},${(c.b * 255) | 0},${a})`;
}
