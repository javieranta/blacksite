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
  // A real 5.56x45 profile rather than a capsule: extractor rim, groove, a body
  // with the true slight taper, a shoulder, a neck and an open mouth. The case
  // is 44.7mm long and 9.6mm across the base — an aspect of 0.21, not the 0.4 a
  // rounded box gives you, which is most of why brass used to read fat.
  //
  // Shading is a turned cylinder: sqrt(1 - x^2) across the barrel with one
  // narrow specular line, so the billboard still reads as a machined metal
  // object while it tumbles. Authored near-neutral — `C.brass` supplies the hue.
  const CASE_LEN = 0.88;                 // fraction of the tile the case spans
  const CASE_R = 0.107 * CASE_LEN;       // half-width: 4.8mm on a 44.7mm case
  A.paint(SPRITE.CASING, (u, v, o) => {
    const t = (v - (1 - CASE_LEN) * 0.5) / CASE_LEN;   // 0 = base, 1 = mouth
    if (t < 0 || t > 1) return;
    let hw;
    if (t < 0.030) hw = CASE_R;                                            // rim
    else if (t < 0.075) hw = CASE_R * 0.845;                               // groove
    else if (t < 0.780) hw = CASE_R * mix(1.0, 0.952, (t - 0.075) / 0.705);
    else if (t < 0.880) hw = CASE_R * mix(0.952, 0.665, (t - 0.780) / 0.100);
    else hw = CASE_R * 0.665;                                              // neck

    const x = (u - 0.5) / hw;
    const ax = Math.abs(x);
    if (ax > 1.1) return;
    const a = smoothstep(1.04, 0.82, ax);
    if (a <= 0) return;

    // Cylindrical facing term + a key from the upper left.
    const n = Math.sqrt(Math.max(0, 1 - Math.min(1, ax * ax)));
    let lum = 0.20 + 0.46 * n * (0.62 + 0.38 * (0.5 - x * 0.5));
    lum += Math.exp(-(((x + 0.44) / 0.19) ** 2)) * 0.52 * n;  // specular line
    lum += Math.exp(-(((x - 0.72) / 0.26) ** 2)) * 0.11 * n;  // dim bounce edge

    if (t < 0.030) lum *= 0.88;                              // rim face
    else if (t < 0.075) lum *= 0.55;                         // extractor groove
    if (t > 0.760 && t < 0.900) lum *= 1.08;                 // shoulder catches
    if (t > 0.955) {
      // Open mouth: the bore goes dark, the lip itself catches a hard line.
      const k = (t - 0.955) / 0.045;
      lum = mix(lum, 0.05, smoothstep(0.10, 0.55, k));
      lum = mix(lum, 0.92, smoothstep(0.86, 0.97, k) * n);
    }
    // Faint turning marks so the flank is not a clean gradient.
    lum *= 0.94 + 0.12 * fbm2(u * 26, v * 6.5, 2, 733);

    lum = clamp01(lum);
    o[0] = Math.min(1, lum * 1.05);
    o[1] = Math.min(1, lum * 0.99);
    o[2] = Math.min(1, lum * 0.88);
    o[3] = a;
  });

  // ── STAR — the flash bloom ────────────────────────────────────────────────
  // This was six `pow(cos(theta - k), 26)` needles on a regular 60-degree pitch:
  // a symmetric asterisk, the shape a lens flare makes and the shape burning
  // propellant never makes. Three reviews called it a placeholder and they were
  // right — evenly spaced radial needles are the signature of a UI glyph.
  //
  // A real discharge at 1/1000 s is a LOBED, filled, asymmetric bloom: gas leaves
  // the crown through whatever path it finds, so a few tongues run long and the
  // rest are stubs, and the whole thing is streaked along the radius by unburnt
  // grains rather than smooth. So the silhouette here is an angular envelope built
  // from three low-frequency angular noise fields at incommensurate frequencies —
  // which has no axis of symmetry anywhere, and cannot acquire one — filled to a
  // soft edge, multiplied by radial striation, over an incandescent core. The
  // per-shot `E.P.rot` roll then lands the asymmetry somewhere new every round.
  A.paint(SPRITE.STAR, (u, v, o) => {
    const r = radius(u, v);
    const ang = angleOf(u, v);

    // How far the flame reaches at this angle. Sums to ~0.5 at the mean with
    // excursions to roughly 0.25..0.95, i.e. long tongues and short stubs.
    const lobe = 0.16
      + 0.42 * noiseAngle(ang + 0.7, 3, 641)
      + 0.26 * noiseAngle(ang + 2.1, 6, 907)
      + 0.13 * noiseAngle(ang - 1.3, 11, 313);

    // Filled to a soft inner shoulder rather than outlined: at this exposure a
    // flash is opaque gas, not a wireframe.
    const flame = smoothstep(lobe, lobe * 0.30, r);

    // Radial streaking from grains burning outward. Sampled on the circle so it
    // wraps, and stretched along r so the streaks run outward, not in rings.
    const stria = 0.52 + 0.48 * fbm2(
      Math.cos(ang) * 6.5 + r * 1.4, Math.sin(ang) * 6.5 + r * 1.4, 3, 2207,
    );

    const core = Math.exp(-r * r * 28);
    const halo = Math.exp(-r * r * 4.4) * 0.24;
    const a = clamp01(core + halo + flame * stria * 0.92) * smoothstep(1.04, 0.60, r);

    // The core is white-hot and the tongues are cooler flame even before the
    // per-particle ramp multiplies in — a flat white tile makes the whole bloom
    // one temperature, which is the other half of why it read as a decal.
    const heat = clamp01(core * 1.5 + 0.34);
    o[0] = 1;
    o[1] = Math.min(1, 0.80 + heat * 0.20);
    o[2] = Math.min(1, 0.56 + heat * 0.44);
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
