/**
 * OWNER: material-forge agent.
 *
 * The cementitious + ground families. Every painter is authored against a known
 * *physical* tile size (see TILE_M below) so feature sizes can be written in
 * millimetres and stay believable: a 16 mm sealant joint is 16 mm whether the
 * bake is 512² or 1024².
 *
 * A painter fills the scratch record `o` for one texel, u,v ∈ [0,1):
 *   o.r,o.g,o.b  albedo, sRGB-encoded 0..1
 *   o.h          height 0..1 (sobelled into the normal map)
 *   o.rough      roughness 0..1     o.metal  metalness 0..1
 *   o.ao         ambient occlusion 0..1
 */

import {
  hash2, vnoise, fbm, ridged, grains, stones, groove, toLine,
  smoothstep, clamp01, lerp,
} from '../Noise.js';

/** Metres across one baked tile, per family. Consumers get this via uvScale. */
export const TILE_M = {
  precast: 4.0,
  poured: 3.5,
  unit: 2.0,
  interior: 2.5,
  asphalt: 2.8,
  dirt: 3.0,
  sand: 3.0,
};

/* ------------------------------------------------------------- precast wall - */

const P_PANEL = 2;                 // panels per tile axis -> 2.0 m panels
const P_MM = 1 / 2000;             // millimetres -> panel units
const P_GAP = 8 * P_MM;            // half-width of the sealant gap (16 mm)
const P_CHAM = 26 * P_MM;          // chamfer meets the face at 26 mm

/**
 * Architectural precast cladding: a 2 m panel grid with chamfered, mastic-filled
 * joints, cast-in anchor patches, exposed fine aggregate and per-panel tonal
 * variation. Four independently seeded panels per tile, so the repeat period is
 * 4 m and the joint grid is world-locked — a 6 m barrier and a 40 m tower get
 * the same *physical* joint size instead of the same texture frequency.
 */
export function precast(u, v, o) {
  const pu = u * P_PANEL, pv = v * P_PANEL;
  const ci = Math.floor(pu), cj = Math.floor(pv);
  const fu = pu - ci, fv = pv - cj;
  const seed = 401 + ci * 3037 + cj * 9091;
  const tone = hash2(ci, cj, 613);

  // ---- joint geometry
  const du = Math.min(fu, 1 - fu), dv = Math.min(fv, 1 - fv);
  const jd = Math.min(du, dv);
  const joint = groove(jd, P_GAP, P_CHAM);
  const mastic = 1 - smoothstep(P_GAP * 0.7, P_GAP * 1.25, jd);

  // ---- panel face
  const soil = fbm(fu, fv, 3, 3, 3, seed);            // rain-washed soiling
  const s = stones(fu, fv, 166, seed + 5, 0.55);      // 12 mm exposed aggregate
  const aggV = s.id, aggDome = s.dome, aggEdge = s.edge;
  const sand = fbm(fu, fv, 130, 130, 2, seed + 9);    // 15 mm paste grain
  // A popped-out piece of aggregate leaves a socket — cheaper and more honest
  // than scattering a second disc field over the top of the stone field.
  const voids = smoothstep(0.988, 1.0, aggV) * aggDome * aggDome;
  // Shrinkage crazing is real but almost invisible on a weathered face. Any
  // threshold high enough to draw it draws disconnected arcs that read as hairs,
  // so it stays a whisper in the relief and the occlusion and barely touches the
  // albedo at all.
  const craze = smoothstep(0.70, 0.92, ridged(fu, fv, 26, 26, 2, seed + 17));

  // ---- cast-in anchor patches: grout-filled, slightly off-tone
  const a1u = 0.30 + (hash2(ci, cj, 701) - 0.5) * 0.12;
  const a1v = 0.76 + (hash2(ci, cj, 709) - 0.5) * 0.10;
  const a2u = 0.71 + (hash2(ci, cj, 719) - 0.5) * 0.12;
  const a2v = 0.27 + (hash2(ci, cj, 727) - 0.5) * 0.10;
  const d1 = Math.hypot(fu - a1u, fv - a1v), d2 = Math.hypot(fu - a2u, fv - a2v);
  const tieD = Math.min(d1, d2);
  const tie = groove(tieD, 22 * P_MM, 34 * P_MM);

  // ---- run-off staining hanging from the joint above, per vertical column.
  // Held deliberately narrow and weak: the bake cannot know whether this panel
  // ended up on a wall or a paving slab, so the strong orientation-aware
  // streaking is the shader patch's job. This is just the part that has to line
  // up with the joint, which only the bake knows where to find.
  const col = vnoise(fu, 0.5, 20, 1, seed + 21);
  const colW = vnoise(fu, 0.5, 8, 1, seed + 23);
  const streak = smoothstep(0.48, 0.94, col * 0.66 + colW * 0.44)
    * smoothstep(0.10, 0.96, fv) * (0.55 + 0.45 * soil);

  // ---- rebar / anchor bleed: only some panels, hanging below the anchor
  const rustGate = smoothstep(0.62, 0.80, hash2(ci, cj, 733));
  const below = clamp01((a2v - fv) * 3.4);
  const bleed = rustGate * below * smoothstep(0.16, 0.02, Math.abs(fu - a2u) * (1.4 - below * 0.6))
    * (0.4 + 0.6 * vnoise(fu, fv, 30, 4, seed + 29));

  // ---- assemble
  let l = 0.442 * (0.945 + 0.11 * tone);
  l += (soil - 0.5) * 0.038 + (sand - 0.5) * 0.030;
  l += (aggV - 0.5) * 0.026 - smoothstep(0.09, 0.0, aggEdge) * 0.018;
  l *= 1 - streak * 0.13 - craze * 0.012 - voids * 0.26 - clamp01(1 - soil * 1.6) * 0.05;

  let r = l * 1.000, g = l * 0.988, b = l * 0.948;
  // mastic joint: near-black rubber, faintly warm
  r = lerp(r, 0.118, mastic); g = lerp(g, 0.112, mastic); b = lerp(b, 0.108, mastic);
  // grout anchor patch reads a touch paler and greyer than the panel face
  const tp = tie * (1 - mastic);
  r = lerp(r, l * 1.13, tp * 0.8); g = lerp(g, l * 1.14, tp * 0.8); b = lerp(b, l * 1.16, tp * 0.8);
  // iron bleed
  const bl = clamp01(bleed * 0.85);
  r = lerp(r, 0.300, bl); g = lerp(g, 0.176, bl); b = lerp(b, 0.112, bl);

  o.r = r; o.g = g; o.b = b;
  o.h = 0.58 + aggDome * 0.055 + (sand - 0.5) * 0.055 - voids * 0.34
    - craze * 0.040 - joint * 0.52 - tie * 0.24;
  o.rough = clamp01(0.826 + (sand - 0.5) * 0.07 + streak * 0.075 + craze * 0.035
    - aggDome * 0.045 - mastic * 0.24 + tp * 0.05);
  o.metal = 0;
  o.ao = clamp01(1 - joint * 0.62 - voids * 0.40 - craze * 0.07 - tie * 0.22
    - streak * 0.07 - smoothstep(0.08, 0.0, aggEdge) * 0.10);
}

/* -------------------------------------------------------- poured-in-place --- */

const D_MM = 1 / 3500;             // millimetres -> tile units (3.5 m tile)
const D_LIFTS = 2;                 // 1.75 m pours
const D_FORMS = 3;                 // 1.17 m plywood form panels

/**
 * Board-formed poured concrete: horizontal cold joints between lifts, vertical
 * plywood form seams with grout fins, a 583 mm form-tie grid with grout-plugged
 * recesses, efflorescence under the lift lines and the plywood's own grain
 * pressed into the face.
 */
export function poured(u, v, o) {
  const lv = v * D_LIFTS, li = Math.floor(lv), flv = lv - li;
  const su = u * D_FORMS, si = Math.floor(su), fsu = su - si;
  const seed = 1201 + li * 5011;

  // ---- cold joint at the bottom of each lift + a small grout weep below it
  const lift = groove(Math.min(flv, 1 - flv) / D_LIFTS, 3 * D_MM, 9 * D_MM);
  const weep = smoothstep(24 * D_MM, 2 * D_MM, flv / D_LIFTS) * (1 - lift);
  // ---- vertical form seam: a proud grout fin where two sheets met
  const seam = smoothstep(7 * D_MM, 1 * D_MM, Math.min(fsu, 1 - fsu) / D_FORMS);

  // ---- 583 mm form-tie grid, grout-plugged
  const tu = u * 6, tv = v * 6;
  const tdu = toLine(tu) / 6, tdv = toLine(tv) / 6;
  const tieD = Math.hypot(tdu, tdv);
  const tie = groove(tieD, 13 * D_MM, 23 * D_MM);
  const tieI = Math.floor(tu) * 31 + Math.floor(tv) * 17;
  const tieRust = smoothstep(0.66, 0.86, hash2(tieI, 0, 811));

  // ---- face
  const paste = fbm(u, v, 4, 4, 3, seed + 3);
  const board = fbm(u, v, 4, 170, 2, seed + 7);       // 20 mm horizontal grain
  const fine = fbm(u, v, 150, 150, 2, seed + 11);
  const voids = grains(u, v, 58, seed + 13, 0.155);   // dense small bug holes
  const craze = smoothstep(0.76, 0.94, ridged(u, v, 30, 30, 2, seed + 19));
  const eff = smoothstep(0.42, 0.95, fbm(u, v, 5, 14, 3, seed + 23))
    * smoothstep(0.42, 0.02, flv) * 0.9;              // lime bloom under the joint

  const col = vnoise(u, 0.5, 26, 1, 947);
  const streak = smoothstep(0.46, 0.94, col * 0.7 + vnoise(u, 0.5, 7, 1, 953) * 0.4)
    * smoothstep(0.06, 0.85, flv);
  const rustRun = tieRust * smoothstep(0.10, 0.0, tdu) * clamp01(-tdv * 6.0)
    * (0.35 + 0.65 * fine);

  let l = 0.428 + (paste - 0.5) * 0.055 + (board - 0.5) * 0.026 + (fine - 0.5) * 0.026;
  l += (hash2(li, 0, 877) - 0.5) * 0.030;             // each lift pours a shade off
  l *= 1 - streak * 0.17 - craze * 0.020 - voids * 0.13 - lift * 0.24 - weep * 0.06;
  l += eff * 0.085 + seam * 0.030;

  let r = l * 1.006, g = l * 0.990, b = l * 0.944;
  const tp = tie * 0.9;
  r = lerp(r, l * 1.10, tp); g = lerp(g, l * 1.11, tp); b = lerp(b, l * 1.14, tp);
  const rr = clamp01(rustRun * 0.9);
  r = lerp(r, 0.285, rr); g = lerp(g, 0.168, rr); b = lerp(b, 0.108, rr);

  o.r = r; o.g = g; o.b = b;
  o.h = 0.60 + (board - 0.5) * 0.075 + (fine - 0.5) * 0.045 - voids * 0.24
    - craze * 0.05 - lift * 0.40 + weep * 0.10 + seam * 0.16 - tie * 0.34;
  o.rough = clamp01(0.812 + (fine - 0.5) * 0.06 + streak * 0.07 + craze * 0.05
    + eff * 0.09 + tie * 0.05 - (board - 0.5) * 0.04);
  o.metal = 0;
  o.ao = clamp01(1 - lift * 0.46 - voids * 0.26 - craze * 0.06 - tie * 0.30 - streak * 0.06);
}

/* ------------------------------------------------------------- precast unit - */

const U_MM = 1 / 2000;

/**
 * Float-finished precast units — barriers, kerbs, copings, paving pads. No panel
 * grid (each casting *is* one unit), so this is the variant that keeps a 6 m
 * Jersey barrier from wearing a wall's joint pattern.
 */
export function unit(u, v, o) {
  const sweep = fbm(u, v, 3, 60, 2, 1409);            // float-trowel sweep
  const broad = fbm(u, v, 5, 5, 3, 1417);
  const sand = fbm(u, v, 140, 140, 2, 1423);
  const s = stones(u, v, 190, 1429, 0.4);             // 10 mm near-surface aggregate
  const voids = smoothstep(0.958, 1.0, s.id) * (0.35 + 0.65 * s.dome);
  const craze = smoothstep(0.76, 0.94, ridged(u, v, 34, 34, 2, 1439));
  // Higher frequency than a 6-cell fBm: broad soft blobs on a slab read as mould.
  const grime = smoothstep(0.56, 0.92, fbm(u, v, 13, 13, 3, 1447));
  const chip = smoothstep(0.90, 0.99, grains(u, v, 11, 1451, 0.20));

  let l = 0.470 + (broad - 0.5) * 0.042 + (sand - 0.5) * 0.030 + (sweep - 0.5) * 0.024;
  l += (s.id - 0.5) * 0.016 - smoothstep(0.10, 0.0, s.edge) * 0.012;
  l *= 1 - grime * 0.16 - craze * 0.020 - voids * 0.20;
  l += chip * 0.035;                                  // fresh fracture is paler

  o.r = l * 1.004; o.g = l * 0.992; o.b = l * 0.952;
  o.h = 0.5 + (sand - 0.5) * 0.05 + s.dome * 0.035 + (sweep - 0.5) * 0.05
    - voids * 0.30 - craze * 0.045 - chip * 0.34;
  o.rough = clamp01(0.796 + (sand - 0.5) * 0.07 + grime * 0.10 + craze * 0.03 + chip * 0.08);
  o.metal = 0;
  o.ao = clamp01(1 - voids * 0.36 - craze * 0.06 - grime * 0.10 - chip * 0.20);
}

/* ---------------------------------------------------------------- interior -- */

/**
 * Painted render over blockwork — the interior wall/soffit finish. Roller
 * stipple, feathered patch repairs on a coarse grid, crazing, damp bloom and
 * scuffing. Deliberately much brighter and lower-contrast than the exterior
 * families so an interior reads as painted, not as raw cast concrete.
 */
export function interior(u, v, o) {
  const roller = fbm(u, v, 60, 60, 2, 1811);
  const sweep = fbm(u, v, 4, 7, 3, 1817);
  // patch repairs on a 0.5 m grid, feathered so they read as skim, not tiles
  const gu = u * 5, gv = v * 4;
  const pi = Math.floor(gu), pj = Math.floor(gv);
  const pf = smoothstep(0.70, 0.86, hash2(pi, pj, 1823));
  const pe = smoothstep(0.0, 0.14, Math.min(toLine(gu) * 2, toLine(gv) * 2));
  const patch = pf * pe;
  const craze = smoothstep(0.86, 0.97, ridged(u, v, 16, 16, 3, 1831));
  const damp = smoothstep(0.58, 0.94, fbm(u, v, 3, 9, 3, 1847));
  const scuff = smoothstep(0.60, 0.92, fbm(u, v, 30, 7, 3, 1861));
  const flake = smoothstep(0.90, 0.99, grains(u, v, 26, 1867, 0.22));

  let l = 0.660 + (sweep - 0.5) * 0.070 + (roller - 0.5) * 0.040;
  l = lerp(l, l * 0.935 + 0.020, patch);
  l *= 1 - craze * 0.22 - damp * 0.20 - scuff * 0.07;
  l = lerp(l, 0.415, flake * 0.7);                    // paint off, render showing

  o.r = l * 0.994; o.g = l * 1.000; o.b = l * 0.962;
  // damp bloom skews warm-brown where water has tracked down
  o.r = lerp(o.r, o.r * 1.06, damp * 0.6);
  o.b = lerp(o.b, o.b * 0.86, damp * 0.6);
  o.h = 0.5 + (roller - 0.5) * 0.10 + (sweep - 0.5) * 0.05 - craze * 0.34
    - patch * 0.05 - flake * 0.26;
  o.rough = clamp01(0.740 + (roller - 0.5) * 0.09 + craze * 0.07 + damp * 0.06
    + flake * 0.14 - scuff * 0.05 - patch * 0.03);
  o.metal = 0;
  o.ao = clamp01(1 - craze * 0.34 - flake * 0.24 - damp * 0.08 - patch * 0.05);
}

/* ---------------------------------------------------------------- asphalt --- */

const A_MM = 1 / 2800;

/**
 * Bituminous surfacing. Built from a *partitioning* stone field: every texel
 * belongs to a chipping, with the binder only in the interstices. That is what
 * separates asphalt from the classic mistake of scattering bright discs on a
 * dark plane. Adds tyre-polished wheel paths, tar-sealed crack bands, potholes
 * with coarse exposed aggregate, and roughness variation for damp patches.
 */
export function asphalt(u, v, o) {
  const s = stones(u, v, 254, 3307, 0.75);            // 11 mm coated chippings
  const grit = fbm(u, v, 170, 170, 2, 3313);
  const broad = fbm(u, v, 4, 4, 3, 3317);
  const polish = smoothstep(0.34, 0.78, fbm(u, v, 3, 6, 3, 3323));
  const damp = smoothstep(0.40, 0.86, fbm(u, v, 5, 5, 3, 3329));

  // open crack network + the tar band that was squeegeed over part of it
  const net = ridged(u, v, 5, 5, 3, 3331);
  const crack = smoothstep(0.795, 0.925, net);
  const seal = smoothstep(0.72, 0.84, net) * smoothstep(0.30, 0.70, broad);

  // Potholes: rare, and *warped* by the crack field before thresholding. A raw
  // disc field gives evenly spaced circles, which is the same polka-dot failure
  // the aggregate had, just three times larger.
  const potR = grains(u, v, 4, 3341, 0.34) * (0.55 + 0.75 * net);
  const pot = smoothstep(0.46, 0.86, potR);
  const potRim = smoothstep(0.34, 0.48, potR) * (1 - smoothstep(0.48, 0.62, potR));

  const inter = smoothstep(0.11, 0.0, s.edge);        // binder between chippings
  // Real bituminous surfacing sits around 0.05-0.10 linear reflectance. Encoded
  // to sRGB that is 0.25-0.35, not the near-black 0.12 it is tempting to write.
  const stoneV = lerp(0.236, 0.338, polish) * (0.90 + 0.22 * s.id);
  const binder = 0.162 + (grit - 0.5) * 0.030 + (broad - 0.5) * 0.026;

  let l = lerp(stoneV, binder, inter);
  l = lerp(l, l * 1.30 + 0.030, pot * 0.8);          // bare aggregate in the hole
  l *= 1 - crack * 0.34 - potRim * 0.09;
  l = lerp(l, 0.176, seal * 0.8);                     // fresh tar is much darker
  l -= damp * 0.014;

  o.r = l * 1.016; o.g = l * 1.000; o.b = l * 1.026;
  o.h = 0.54 + s.dome * 0.11 + (grit - 0.5) * 0.06
    - inter * 0.11 - crack * 0.44 - pot * 0.30 + potRim * 0.06 + seal * 0.05;
  o.rough = clamp01(0.930 - polish * 0.20 - damp * 0.30 - s.dome * 0.03
    + (grit - 0.5) * 0.05 + pot * 0.05 - seal * 0.42);
  o.metal = 0;
  o.ao = clamp01(1 - inter * 0.22 - crack * 0.44 - pot * 0.26 - (1 - s.dome) * 0.10);
}

/* ------------------------------------------------------------------- dirt --- */

/** Dry compacted earth: shrinkage polygons, embedded stones, wind-blown fines. */
export function dirt(u, v, o) {
  const broad = fbm(u, v, 3, 3, 4, 4191);
  const clump = fbm(u, v, 12, 12, 4, 4197);
  const grit = fbm(u, v, 130, 130, 2, 4211);
  const s = grains(u, v, 34, 4199, 0.26);             // 90 mm pebbles, sparse
  const bed = smoothstep(0.55, 0.05, s) * smoothstep(0.02, 0.30, s);
  const dry = smoothstep(0.80, 0.94, ridged(u, v, 7, 7, 4, 4217));  // shrinkage cracks
  const fines = smoothstep(0.50, 0.90, fbm(u, v, 6, 6, 3, 4223));

  // 0.30 sRGB ~= 0.075 linear, which is where dry compacted earth actually sits.
  let l = 0.300 + (broad - 0.5) * 0.085 + (clump - 0.5) * 0.078 + (grit - 0.5) * 0.040;
  l = lerp(l, l * 1.16 + 0.020, s * 0.85);            // stones only slightly paler
  l *= 1 - dry * 0.26 - bed * 0.14;
  l += fines * 0.030;

  o.r = l * 1.215; o.g = l * 1.055; o.b = l * 0.830;
  o.h = 0.5 + s * 0.30 + (clump - 0.5) * 0.18 + (grit - 0.5) * 0.08 - dry * 0.34 - bed * 0.10;
  o.rough = clamp01(0.960 - s * 0.10 + (grit - 0.5) * 0.05 - fines * 0.03);
  o.metal = 0;
  o.ao = clamp01(1 - dry * 0.34 - bed * 0.22 - (1 - clump) * 0.16 - (1 - broad) * 0.08);
}

/* ------------------------------------------------------------------- sand --- */

/** Wind-rippled sand: soft dune ripples, shell grit, a little dark mineral. */
export function sand(u, v, o) {
  const dune = fbm(u, v, 3, 3, 3, 5223);
  const warp = fbm(u, v, 5, 5, 3, 5227);
  const ripple = 0.5 + 0.5 * Math.sin((v * 17 + warp * 8.5 + dune * 3.4) * Math.PI * 2);
  const grit = fbm(u, v, 165, 165, 2, 5229);
  const shell = grains(u, v, 46, 5233, 0.14);
  const dark = smoothstep(0.58, 0.90, fbm(u, v, 40, 40, 2, 5237));

  // Dry sand is a genuinely bright dielectric — ~0.22 linear, i.e. 0.51 sRGB.
  let l = 0.540 + (dune - 0.5) * 0.090 + (ripple - 0.5) * 0.055 + (grit - 0.5) * 0.058;
  l += shell * 0.09 - dark * 0.05;

  o.r = l * 1.150; o.g = l * 1.020; o.b = l * 0.775;
  o.h = 0.5 + (ripple - 0.5) * 0.15 + (dune - 0.5) * 0.12 + (grit - 0.5) * 0.10 + shell * 0.09;
  o.rough = clamp01(0.945 + (grit - 0.5) * 0.06 - shell * 0.05);
  o.metal = 0;
  o.ao = clamp01(1 - (1 - ripple) * 0.12 - (1 - dune) * 0.06);
}
