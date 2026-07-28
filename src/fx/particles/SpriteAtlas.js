import * as THREE from 'three';
import { AtlasCanvas, fbm2, ridge2, radius, angleOf, clamp01, smoothstep, mix, mulberry32 } from '../proc/Draw.js';

/**
 * OWNER: fx agent.
 *
 * The particle sprite sheet — 4×4 tiles at 256px, generated from noise fields.
 * RGB carries baked luminance/structure (so a chunk of debris has a lit face and
 * a shadowed one even though it is a billboard) and A carries coverage. The
 * per-particle colour ramp multiplies RGB, so every tile is authored neutral.
 */

export const SPRITE = {
  SMOKE: 0,    // billowy soft puff — the workhorse for smoke/dust plumes
  DUST: 1,     // grittier, higher contrast, sharper edge
  GLOW: 2,     // round HDR glow — flash cores, impact pops
  STREAK: 3,   // tapering line, hot head at +u — motion-stretched sparks
  DROPLET: 4,  // dense round blob — blood, water
  CHUNK: 5,    // irregular solid silhouette with baked facets — debris
  SHARD: 6,    // angular sliver with a bright edge — glass
  CASING: 7,   // brass case with a specular band
  STAR: 8,     // spiked starburst — muzzle/explosion cores
  RING: 9,     // thin annulus — shockwave, dust ring
  CROWN: 10,   // droplet crown — water splash
  EMBER: 11,   // pinpoint core + halo
  WISP: 12,    // elongated torn smoke wisp
  MIST: 13,    // very soft low-alpha veil — blood mist, haze
  GRIT: 14,    // cluster of tiny grains — sand, concrete powder
  FLARE: 15,   // 4-point lens flare cross — glints
};

export const ATLAS_COLS = 4;
export const ATLAS_ROWS = 4;

export function buildSpriteAtlas(size = 1024) {
  const A = new AtlasCanvas(size, ATLAS_COLS, ATLAS_ROWS);
  const rnd = mulberry32(0x51f7a3);

  // ── SMOKE ─────────────────────────────────────────────────────────────────
  // Billows: low-frequency fbm warped by a second field, masked to a disc whose
  // edge is itself eroded by the noise so the silhouette is never a circle.
  A.paint(SPRITE.SMOKE, (u, v, o) => {
    const r = radius(u, v);
    const wx = fbm2(u * 2.1 + 11.3, v * 2.1, 3, 17) - 0.5;
    const n = fbm2(u * 3.4 + wx * 1.1, v * 3.4 + wx * 0.9, 5, 91);
    const edge = 0.86 + n * 0.34;
    let a = smoothstep(edge, edge * 0.22, r);
    a *= 0.45 + n * 0.75;
    const lum = 0.72 + n * 0.34;
    o[0] = o[1] = o[2] = Math.min(1, lum);
    o[3] = clamp01(a);
  });

  // ── DUST ──────────────────────────────────────────────────────────────────
  A.paint(SPRITE.DUST, (u, v, o) => {
    const r = radius(u, v);
    const n = fbm2(u * 5.6, v * 5.6, 5, 223, 2.17, 0.56);
    const clump = fbm2(u * 1.9 - 4.0, v * 1.9 + 2.0, 2, 51);
    const edge = 0.78 + n * 0.46;
    let a = smoothstep(edge, edge * 0.1, r);
    a *= 0.22 + clump * 0.5 + n * 0.62;
    o[0] = o[1] = o[2] = Math.min(1, 0.66 + n * 0.42);
    o[3] = clamp01(a * 0.95);
  });

  // ── GLOW ──────────────────────────────────────────────────────────────────
  A.paint(SPRITE.GLOW, (u, v, o) => {
    const r = radius(u, v);
    const core = Math.exp(-r * r * 26);
    const halo = Math.exp(-r * r * 4.6) * 0.42;
    const a = clamp01(core + halo) * smoothstep(1.02, 0.72, r);
    o[0] = 1; o[1] = 1; o[2] = 1;
    o[3] = a;
  });

  // ── STREAK ────────────────────────────────────────────────────────────────
  // Head at u=1 so the vertex shader can anchor it to the particle position and
  // trail the tail along -velocity.
  A.paint(SPRITE.STREAK, (u, v, o) => {
    const w = 0.028 + 0.10 * u * u;
    const dy = (v - 0.5) / w;
    const line = Math.exp(-dy * dy);
    const along = Math.pow(clamp01(u), 1.35);
    const head = Math.exp(-((1 - u) * 7.5) * ((1 - u) * 7.5)) * Math.exp(-dy * dy * 0.4);
    const flick = 0.72 + 0.28 * fbm2(u * 9.0, v * 3.0, 2, 733);
    const a = clamp01((line * along * flick + head * 0.9) * smoothstep(0.0, 0.06, u));
    o[0] = 1; o[1] = 1; o[2] = 1;
    o[3] = a;
  });

  // ── DROPLET ───────────────────────────────────────────────────────────────
  A.paint(SPRITE.DROPLET, (u, v, o) => {
    const r = radius(u, v);
    const n = fbm2(u * 6.0, v * 6.0, 3, 401);
    const edge = 0.76 + n * 0.16;
    const a = smoothstep(edge, edge - 0.16, r);
    // Slightly brighter at the top-left: a wet blob catches the key light.
    const lit = 0.68 + 0.5 * clamp01(1 - radius(u + 0.13, v - 0.13));
    o[0] = o[1] = o[2] = Math.min(1, lit);
    o[3] = clamp01(a);
  });

  // ── CHUNK ─────────────────────────────────────────────────────────────────
  A.paint(SPRITE.CHUNK, (u, v, o) => {
    const r = radius(u, v);
    const ang = angleOf(u, v);
    // Irregular outline: radius modulated by angular noise (wrapped).
    const shape = 0.62 + 0.3 * noiseAngle(ang, 5, 71) + 0.1 * noiseAngle(ang, 11, 12);
    const a = r < shape ? 1 : 0;
    const facet = 0.34 + 0.66 * clamp01(0.5 + 0.9 * (0.5 - v) + 0.35 * (u - 0.5));
    const grain = 0.86 + 0.28 * fbm2(u * 7.0, v * 7.0, 3, 8891);
    o[0] = o[1] = o[2] = Math.min(1, facet * grain);
    o[3] = a * smoothstep(shape + 0.02, shape - 0.04, r);
  });

  // ── SHARD ─────────────────────────────────────────────────────────────────
  A.paint(SPRITE.SHARD, (u, v, o) => {
    // A sliver: wide at the bottom, tapering to a point at the top, sheared.
    const t = clamp01(v);
    const cx = 0.5 + (t - 0.5) * 0.22;
    const half = 0.30 * (1 - t) * (0.55 + 0.45 * (1 - t));
    const d = Math.abs(u - cx);
    const inside = d < half ? 1 : 0;
    const edgeLight = smoothstep(half, half * 0.45, d);
    const a = inside * smoothstep(half + 0.012, half - 0.01, d);
    const lit = 0.42 + 0.85 * (1 - edgeLight) + 0.3 * t;
    o[0] = Math.min(1, lit * 0.94); o[1] = Math.min(1, lit); o[2] = 1;
    o[3] = a;
  });

  // ── CASING ────────────────────────────────────────────────────────────────
  A.paint(SPRITE.CASING, (u, v, o) => {
    const x = (u - 0.5) / 0.16;
    const y = (v - 0.5) / 0.40;
    const rr = Math.max(Math.abs(x), Math.abs(y) * 0.96);
    const a = smoothstep(1.0, 0.9, rr);
    // Specular band down the side of the cylinder + a darker rim.
    const spec = Math.exp(-Math.pow((u - 0.44) / 0.045, 2)) * 0.9;
    const body = 0.42 + 0.34 * (1 - Math.abs(x));
    const rim = v > 0.42 && v < 0.5 ? 0.22 : 0;
    const lum = clamp01(body + spec - rim);
    o[0] = Math.min(1, lum * 1.12);
    o[1] = Math.min(1, lum * 0.92);
    o[2] = Math.min(1, lum * 0.50);
    o[3] = a;
  });

  // ── STAR ──────────────────────────────────────────────────────────────────
  A.paint(SPRITE.STAR, (u, v, o) => {
    const r = radius(u, v);
    const ang = angleOf(u, v);
    let spikes = 0;
    for (let k = 0; k < 6; k++) {
      const a0 = (k / 6) * Math.PI * 2 + 0.31;
      const len = 0.55 + 0.45 * hashf(k, 3);
      const d = Math.cos(ang - a0);
      spikes += Math.pow(Math.max(0, d), 26) * Math.exp(-r * r * (3.0 / len));
    }
    const core = Math.exp(-r * r * 34);
    const halo = Math.exp(-r * r * 5.0) * 0.3;
    const a = clamp01(core + halo + spikes * 0.9) * smoothstep(1.05, 0.7, r);
    o[0] = 1; o[1] = 1; o[2] = 1;
    o[3] = a;
  });

  // ── RING ──────────────────────────────────────────────────────────────────
  A.paint(SPRITE.RING, (u, v, o) => {
    const r = radius(u, v);
    const ang = angleOf(u, v);
    const wob = 0.03 * (noiseAngle(ang, 7, 331) - 0.5);
    const d = (r - (0.78 + wob)) / 0.13;
    const a = Math.exp(-d * d) * (0.55 + 0.6 * noiseAngle(ang, 13, 77));
    o[0] = 1; o[1] = 1; o[2] = 1;
    o[3] = clamp01(a) * smoothstep(1.03, 0.94, r);
  });

  // ── CROWN ─────────────────────────────────────────────────────────────────
  A.paint(SPRITE.CROWN, (u, v, o) => {
    let a = 0;
    // Central column
    const cw = 0.075 + 0.05 * (1 - v);
    a += Math.exp(-Math.pow((u - 0.5) / cw, 2)) * smoothstep(0.0, 0.22, v) * (1 - v * 0.55);
    // Droplets thrown out along a parabola
    for (let k = 0; k < 9; k++) {
      const s = (hashf(k, 11) - 0.5) * 1.7;
      const px = 0.5 + s * 0.27;
      const py = 0.16 + (1 - Math.abs(s)) * 0.62 + hashf(k, 23) * 0.1;
      const rad = 0.028 + hashf(k, 31) * 0.035;
      const dx = (u - px) / rad;
      const dy = (v - py) / rad;
      a += Math.exp(-(dx * dx + dy * dy));
    }
    o[0] = 0.92; o[1] = 0.97; o[2] = 1;
    o[3] = clamp01(a);
  });

  // ── EMBER ─────────────────────────────────────────────────────────────────
  A.paint(SPRITE.EMBER, (u, v, o) => {
    const r = radius(u, v);
    const a = clamp01(Math.exp(-r * r * 120) + Math.exp(-r * r * 13) * 0.30);
    o[0] = 1; o[1] = 1; o[2] = 1;
    o[3] = a * smoothstep(1.0, 0.6, r);
  });

  // ── WISP ──────────────────────────────────────────────────────────────────
  A.paint(SPRITE.WISP, (u, v, o) => {
    const n = fbm2(u * 3.2, v * 6.4, 5, 1301);
    const dx = (u - 0.5) * 2.0;
    const dy = (v - 0.5) * 3.1;
    const r = Math.sqrt(dx * dx + dy * dy);
    const edge = 0.85 + n * 0.5;
    let a = smoothstep(edge, edge * 0.15, r) * (0.3 + n * 0.85);
    a *= 0.55 + 0.45 * ridge2(u * 4.0, v * 8.0, 2, 55);
    o[0] = o[1] = o[2] = Math.min(1, 0.7 + n * 0.35);
    o[3] = clamp01(a);
  });

  // ── MIST ──────────────────────────────────────────────────────────────────
  A.paint(SPRITE.MIST, (u, v, o) => {
    const r = radius(u, v);
    const n = fbm2(u * 2.4, v * 2.4, 4, 1777);
    const a = smoothstep(1.0, 0.05, r) * (0.16 + n * 0.4);
    o[0] = o[1] = o[2] = Math.min(1, 0.8 + n * 0.25);
    o[3] = clamp01(a);
  });

  // ── GRIT ──────────────────────────────────────────────────────────────────
  A.paint(SPRITE.GRIT, (u, v, o) => {
    let a = 0;
    let lum = 0;
    for (let k = 0; k < 22; k++) {
      const px = hashf(k, 5);
      const py = hashf(k, 9);
      const rad = 0.012 + hashf(k, 13) * 0.032;
      const dx = (u - px) / rad;
      const dy = (v - py) / rad;
      const g = Math.exp(-(dx * dx + dy * dy) * 1.6);
      a += g;
      lum += g * (0.45 + hashf(k, 17) * 0.55);
    }
    const mask = smoothstep(1.05, 0.25, radius(u, v));
    o[3] = clamp01(a) * mask;
    o[0] = o[1] = o[2] = a > 0 ? Math.min(1, lum / Math.max(a, 1e-4)) : 0;
  });

  // ── FLARE ─────────────────────────────────────────────────────────────────
  A.paint(SPRITE.FLARE, (u, v, o) => {
    const dx = Math.abs(u - 0.5) * 2;
    const dy = Math.abs(v - 0.5) * 2;
    const h = Math.exp(-dy * dy * 320) * Math.exp(-dx * dx * 2.2);
    const w = Math.exp(-dx * dx * 320) * Math.exp(-dy * dy * 2.2);
    const core = Math.exp(-(dx * dx + dy * dy) * 46);
    const a = clamp01(h * 0.8 + w * 0.6 + core);
    o[0] = 1; o[1] = 1; o[2] = 1;
    o[3] = a;
  });

  void rnd;
  return A.toTexture(THREE, { colorSpace: THREE.SRGBColorSpace, aniso: 4 });
}

/** Angular noise that wraps cleanly around the circle. */
function noiseAngle(ang, freq, seed) {
  const x = Math.cos(ang) * freq;
  const y = Math.sin(ang) * freq;
  return fbm2(x + 32.0, y + 17.0, 2, seed);
}

function hashf(i, salt) {
  const t = Math.sin(i * 12.9898 + salt * 78.233) * 43758.5453;
  return t - Math.floor(t);
}

export { mix };
