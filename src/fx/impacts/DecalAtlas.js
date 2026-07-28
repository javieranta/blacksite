import * as THREE from 'three';
import { AtlasCanvas, fbm2, ridge2, radius, angleOf, clamp01, smoothstep } from '../proc/Draw.js';

/**
 * OWNER: impacts agent.
 *
 * The decal sheet — 4×4 tiles at 256px. Two families share it:
 *
 *  · MULTIPLY tiles author RGB as the *darkening tint* and A as coverage. The
 *    field's blend resolves to `dst * mix(1, tint, a)`, so a bullet hole darkens
 *    the surface it lands on and keeps that surface's own lighting, shadowing
 *    and normal detail. A lit quad pasted on top would flatten all of it.
 *  · ADDITIVE tiles author RGB as emitted light — the pale rim of a concrete
 *    crater, the white web of cracked glass, the wet sheen on blood. Multiply
 *    can only ever darken, and half of what an impact does is brighten.
 */

export const DECAL = {
  HOLE_CONCRETE: 0,
  HOLE_METAL: 1,
  HOLE_WOOD: 2,
  CRATER_SOFT: 3,
  GLASS_WEB: 4,      // additive
  BLOOD: 5,
  SCORCH: 6,
  SCUFF: 7,
  RING_PALE: 8,      // additive
  BURN_GLOW: 9,      // additive
  SHEEN: 10,         // additive
  DUST_SMUDGE: 11,   // additive
  GLASS_CRUSH: 12,
  HOLE_SMALL: 13,
  SPLINTER_PALE: 14, // additive
  CRATER_RIM: 15,    // additive
};

export const DECAL_COLS = 4;
export const DECAL_ROWS = 4;

/** Distance from (u,v) to a set of radial cracks. Returns 0..1 intensity. */
function cracks(u, v, count, seed, len, width, taper) {
  const r = radius(u, v);
  if (r > len) return 0;
  const ang = angleOf(u, v);
  let acc = 0;
  for (let k = 0; k < count; k++) {
    const base = (k / count) * Math.PI * 2 + hash(k + seed) * 1.4;
    // Wobble the crack so it is not a perfect ray.
    const wob = (fbm2(r * 5.5 + k * 3.1, k * 7.7 + seed, 3, seed) - 0.5) * 0.45;
    let da = ang - (base + wob * r);
    while (da > Math.PI) da -= Math.PI * 2;
    while (da < -Math.PI) da += Math.PI * 2;
    const reach = len * (0.45 + hash(k * 3 + seed) * 0.75);
    if (r > reach) continue;
    const w = width * (1 + taper * (1 - r / Math.max(reach, 1e-3)));
    const d = Math.abs(da) * Math.max(r, 0.02) / w;
    acc += Math.exp(-d * d) * (1 - r / reach);
  }
  return clamp01(acc);
}

function hash(i) {
  const t = Math.sin(i * 91.7 + 12.3) * 43758.5453;
  return t - Math.floor(t);
}

export function buildDecalAtlas(size = 1024) {
  const A = new AtlasCanvas(size, DECAL_COLS, DECAL_ROWS);

  // ── concrete: pale crater, dark punch-through, hairline cracks ─────────────
  A.paint(DECAL.HOLE_CONCRETE, (u, v, o) => {
    const r = radius(u, v);
    const n = fbm2(u * 6.5, v * 6.5, 4, 31);
    const hole = smoothstep(0.30 + n * 0.10, 0.10, r);
    const spall = smoothstep(0.86 + n * 0.28, 0.30, r) * (0.30 + n * 0.55);
    const cr = cracks(u, v, 9, 3, 0.92, 0.055, 1.6) * 0.55;
    const a = clamp01(hole + spall * 0.55 + cr);
    const dark = 1 - clamp01(hole * 0.92 + cr * 0.55 + spall * 0.30);
    o[0] = 0.10 + dark * 0.62;
    o[1] = 0.10 + dark * 0.60;
    o[2] = 0.10 + dark * 0.57;
    o[3] = a;
  });

  // ── metal: clean punch, torn petals, a bruised dent ring ───────────────────
  A.paint(DECAL.HOLE_METAL, (u, v, o) => {
    const r = radius(u, v);
    const ang = angleOf(u, v);
    const petal = 1 + 0.16 * Math.sin(ang * 5 + 1.2);
    const n = fbm2(u * 9.0, v * 9.0, 3, 77);
    const hole = smoothstep(0.26 * petal + n * 0.05, 0.09, r);
    const dent = Math.exp(-Math.pow((r - 0.40) / 0.16, 2)) * (0.42 + n * 0.3);
    const scrape = cracks(u, v, 6, 12, 0.75, 0.035, 0.6) * 0.35;
    const a = clamp01(hole + dent * 0.62 + scrape);
    const dark = 1 - clamp01(hole + scrape * 0.6);
    o[0] = 0.07 + dark * 0.66;
    o[1] = 0.07 + dark * 0.68;
    o[2] = 0.08 + dark * 0.72;
    o[3] = a;
  });

  // ── wood: ragged hole with splinters lifting out of it ─────────────────────
  A.paint(DECAL.HOLE_WOOD, (u, v, o) => {
    const r = radius(u, v);
    const ang = angleOf(u, v);
    const n = fbm2(u * 7.0, v * 3.0, 4, 401);
    const grain = fbm2(u * 2.0, v * 26.0, 3, 907);
    const hole = smoothstep(0.30 + n * 0.14, 0.08, r);
    const splinter = Math.pow(Math.max(0, Math.cos(ang * 2.0)), 3)
      * smoothstep(0.95, 0.18, r) * (0.35 + grain * 0.65);
    const a = clamp01(hole + splinter * 0.62);
    const dark = 1 - clamp01(hole * 0.95 + splinter * 0.45);
    o[0] = 0.05 + dark * 0.55;
    o[1] = 0.04 + dark * 0.42;
    o[2] = 0.03 + dark * 0.32;
    o[3] = a;
  });

  // ── soft crater: dirt, sand, anything that absorbs rather than chips ───────
  A.paint(DECAL.CRATER_SOFT, (u, v, o) => {
    const r = radius(u, v);
    const n = fbm2(u * 4.2, v * 4.2, 5, 555);
    const bowl = smoothstep(0.62 + n * 0.32, 0.0, r);
    const throwOut = smoothstep(1.0, 0.55, r) * (0.12 + n * 0.4);
    const a = clamp01(bowl * 0.95 + throwOut * 0.5);
    // Deeper in the middle: a crater is a shadow, not a stain.
    const dark = 1 - clamp01(bowl * 0.85);
    o[0] = 0.16 + dark * 0.52;
    o[1] = 0.14 + dark * 0.48;
    o[2] = 0.11 + dark * 0.42;
    o[3] = a;
  });

  // ── glass: the spiderweb (additive — cracks scatter light) ────────────────
  A.paint(DECAL.GLASS_WEB, (u, v, o) => {
    const r = radius(u, v);
    const web = cracks(u, v, 13, 21, 0.95, 0.028, 0.9);
    let rings = 0;
    for (let k = 1; k <= 3; k++) {
      const rr = 0.22 * k + 0.05 * fbm2(u * 3.0 + k, v * 3.0, 2, 88 + k);
      rings += Math.exp(-Math.pow((r - rr) / 0.022, 2)) * (0.55 - k * 0.1);
    }
    const core = Math.exp(-r * r * 26) * 0.7;
    const a = clamp01((web + rings * 0.8 + core) * smoothstep(1.02, 0.88, r));
    o[0] = 0.86; o[1] = 0.94; o[2] = 1.0;
    o[3] = a;
  });

  // ── blood: a splat with satellites, wet in the middle ─────────────────────
  A.paint(DECAL.BLOOD, (u, v, o) => {
    const r = radius(u, v);
    const ang = angleOf(u, v);
    const lobe = 0.52 + 0.26 * fbm2(Math.cos(ang) * 3 + 9, Math.sin(ang) * 3, 3, 1234);
    let a = smoothstep(lobe + 0.06, lobe - 0.10, r);
    for (let k = 0; k < 10; k++) {
      const aa = hash(k * 5 + 3) * Math.PI * 2;
      const rr = 0.55 + hash(k * 7 + 1) * 0.42;
      const px = 0.5 + Math.cos(aa) * rr * 0.5;
      const py = 0.5 + Math.sin(aa) * rr * 0.5;
      const rad = 0.02 + hash(k * 11 + 5) * 0.055;
      const d = Math.hypot(u - px, v - py) / rad;
      a += Math.exp(-d * d * 1.4) * 0.9;
    }
    a = clamp01(a) * smoothstep(1.04, 0.96, r);
    const core = smoothstep(lobe * 0.9, 0.05, r);
    o[0] = 0.34 - core * 0.20;
    o[1] = 0.055;
    o[2] = 0.045;
    o[3] = a;
  });

  // ── scorch: the explosion's signature ────────────────────────────────────
  A.paint(DECAL.SCORCH, (u, v, o) => {
    const r = radius(u, v);
    const ang = angleOf(u, v);
    const streak = Math.pow(Math.max(0, Math.cos(ang * 7 + fbm2(r * 4, 1, 2, 66) * 6)), 2);
    const n = fbm2(u * 3.4, v * 3.4, 5, 909);
    const edge = 0.70 + n * 0.34 + streak * 0.22;
    let a = smoothstep(edge, edge * 0.05, r);
    a *= 0.55 + n * 0.7;
    const dark = 1 - clamp01(smoothstep(0.6, 0.0, r) * 0.9 + n * 0.1);
    o[0] = 0.04 + dark * 0.34;
    o[1] = 0.035 + dark * 0.30;
    o[2] = 0.03 + dark * 0.28;
    o[3] = clamp01(a);
  });

  // ── scuff: fabric, tarpaulin, anything that frays instead of cratering ────
  A.paint(DECAL.SCUFF, (u, v, o) => {
    const r = radius(u, v);
    const streaks = ridge2(u * 3.0, v * 15.0, 3, 71);
    const n = fbm2(u * 5.0, v * 5.0, 3, 17);
    const a = smoothstep(0.9 + n * 0.2, 0.05, r) * (0.15 + streaks * 0.85) * 0.8;
    o[0] = 0.28; o[1] = 0.25; o[2] = 0.22;
    o[3] = clamp01(a);
  });

  // ── pale ring: the powder rim thrown out of concrete ─────────────────────
  A.paint(DECAL.RING_PALE, (u, v, o) => {
    const r = radius(u, v);
    const ang = angleOf(u, v);
    const wob = 0.05 * (fbm2(Math.cos(ang) * 4 + 3, Math.sin(ang) * 4, 3, 45) - 0.5);
    const d = (r - (0.46 + wob)) / 0.20;
    const n = fbm2(u * 8.0, v * 8.0, 3, 313);
    const a = Math.exp(-d * d) * (0.35 + n * 0.75);
    o[0] = 0.95; o[1] = 0.93; o[2] = 0.88;
    o[3] = clamp01(a * 0.85) * smoothstep(1.02, 0.9, r);
  });

  // ── burn glow: the heat still in a fresh metal strike ────────────────────
  A.paint(DECAL.BURN_GLOW, (u, v, o) => {
    const r = radius(u, v);
    const core = Math.exp(-r * r * 40);
    const halo = Math.exp(-r * r * 7) * 0.35;
    o[0] = 1.0; o[1] = 0.52; o[2] = 0.18;
    o[3] = clamp01(core + halo);
  });

  // ── sheen: wet highlight ─────────────────────────────────────────────────
  A.paint(DECAL.SHEEN, (u, v, o) => {
    const r = radius(u, v);
    const n = fbm2(u * 4.0, v * 4.0, 3, 611);
    const a = smoothstep(0.75 + n * 0.25, 0.1, r) * (0.25 + n * 0.5);
    o[0] = 0.95; o[1] = 0.85; o[2] = 0.82;
    o[3] = clamp01(a * 0.6);
  });

  // ── dust smudge: pale powder patch ───────────────────────────────────────
  A.paint(DECAL.DUST_SMUDGE, (u, v, o) => {
    const r = radius(u, v);
    const n = fbm2(u * 3.2, v * 3.2, 4, 2001);
    const a = smoothstep(0.85 + n * 0.3, 0.02, r) * (0.2 + n * 0.6);
    o[0] = 0.92; o[1] = 0.90; o[2] = 0.86;
    o[3] = clamp01(a * 0.7);
  });

  // ── glass crush: the dark bruise under the web ───────────────────────────
  A.paint(DECAL.GLASS_CRUSH, (u, v, o) => {
    const r = radius(u, v);
    const n = fbm2(u * 9.0, v * 9.0, 3, 4321);
    const a = smoothstep(0.34 + n * 0.16, 0.02, r) * (0.5 + n * 0.5);
    o[0] = 0.28; o[1] = 0.34; o[2] = 0.38;
    o[3] = clamp01(a);
  });

  // ── small generic hole ───────────────────────────────────────────────────
  A.paint(DECAL.HOLE_SMALL, (u, v, o) => {
    const r = radius(u, v);
    const n = fbm2(u * 11.0, v * 11.0, 3, 5150);
    const a = smoothstep(0.34 + n * 0.14, 0.06, r);
    o[0] = 0.09; o[1] = 0.085; o[2] = 0.08;
    o[3] = clamp01(a);
  });

  // ── pale splinters lifting off wood (additive) ───────────────────────────
  A.paint(DECAL.SPLINTER_PALE, (u, v, o) => {
    const ang = angleOf(u, v);
    const r = radius(u, v);
    const fan = Math.pow(Math.max(0, Math.cos(ang * 2.0)), 4);
    const g = ridge2(u * 4.0, v * 22.0, 3, 133);
    const a = fan * smoothstep(0.95, 0.15, r) * g * 0.55;
    o[0] = 0.85; o[1] = 0.70; o[2] = 0.50;
    o[3] = clamp01(a);
  });

  // ── crater rim (additive): bright lip catching the sun ───────────────────
  A.paint(DECAL.CRATER_RIM, (u, v, o) => {
    const r = radius(u, v);
    const ang = angleOf(u, v);
    const n = fbm2(Math.cos(ang) * 5 + 2, Math.sin(ang) * 5, 3, 707);
    const d = (r - (0.60 + (n - 0.5) * 0.14)) / 0.15;
    const a = Math.exp(-d * d) * (0.3 + n * 0.6);
    o[0] = 0.90; o[1] = 0.86; o[2] = 0.78;
    o[3] = clamp01(a * 0.7) * smoothstep(1.02, 0.9, r);
  });

  return A.toTexture(THREE, { colorSpace: THREE.SRGBColorSpace, aniso: 8 });
}
