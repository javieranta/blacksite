import * as THREE from 'three';
import {
  bevelBox, box, cyl, xf, mergeAll, boxUV, cylUV, atlasUVByAxis, atlasRemap,
  warp, dent, seat, boxUV01,
} from '../GeoUtil.js';
import { CRATE, DRUM } from '../Atlas.js';

/**
 * Containers: crates, cases, drums, pallets, spools, cans, bundles.
 * OWNER: props agent.
 *
 * Every builder takes a Rand and returns a geometry seated on y=0 and centred in
 * XZ, so the Placer can drop it on any surface without knowing what it is.
 * Dimensions, panel counts, lid offsets and damage are all seeded — no two
 * crates in the level are the same mesh.
 */

const A = (geo, side, top) => atlasUVByAxis(geo, { z: side, x: side, y: top }, 4, 4);

/* ------------------------------------------------------------------ crates */

/**
 * Timber shipping crate: planked body, steel corner battens, a lid lip that is
 * never quite square, and a chance of a slightly sprung lid.
 */
export function timberCrate(rng, size = null) {
  const w = size?.w ?? rng.range(0.62, 1.15);
  const d = size?.d ?? w * rng.range(0.68, 1.0);
  const h = size?.h ?? w * rng.range(0.55, 0.85);
  const parts = [];

  const bodyH = h * 0.9;
  const body = bevelBox(w, bodyH, d, 0.016);
  xf(body, 0, bodyH / 2, 0);
  A(body, rng.bool(0.5) ? CRATE.woodA : CRATE.woodB, CRATE.woodLid);
  parts.push(body);

  // lid: slightly oversized, slightly askew
  const lidH = h * 0.12;
  const lid = bevelBox(w * 1.035, lidH, d * 1.035, 0.014);
  xf(lid, rng.jit(0.012), bodyH + lidH * 0.42, rng.jit(0.012), 0, rng.jit(0.035), rng.jit(0.02));
  A(lid, CRATE.woodB, CRATE.woodLid);
  parts.push(lid);

  // corner battens — the thing that stops it reading as a box
  const bw = Math.min(0.055, w * 0.08);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const b = bevelBox(bw, bodyH * 1.02, bw, 0.006);
      xf(b, sx * (w / 2 - bw * 0.42), bodyH / 2, sz * (d / 2 - bw * 0.42));
      A(b, CRATE.steelPainted, CRATE.steelPainted);
      parts.push(b);
    }
  }
  // banding strap
  if (rng.bool(0.55)) {
    const strap = box(w * 1.02, 0.028, d * 1.02);
    xf(strap, 0, bodyH * rng.range(0.4, 0.7), 0);
    atlasUVByAxis(strap, { z: CRATE.steelRust, x: CRATE.steelRust, y: CRATE.steelRust }, 4, 4);
    parts.push(strap);
  }

  const geo = mergeAll(parts);
  warp(geo, 0.005, 4, rng.int(1, 9999));
  return seat(geo);
}

/** Hard transit case: ribbed shell, latches, corner bumpers, carry handle. */
export function transitCase(rng) {
  const w = rng.range(0.72, 1.05);
  const d = rng.range(0.42, 0.58);
  const h = rng.range(0.3, 0.44);
  const parts = [];

  const shell = bevelBox(w, h, d, 0.032, 2);
  xf(shell, 0, h / 2, 0);
  A(shell, rng.bool(0.5) ? CRATE.caseA : CRATE.caseB, CRATE.caseLid);
  parts.push(shell);

  // parting line
  const line = box(w * 1.006, 0.016, d * 1.006);
  xf(line, 0, h * 0.62, 0);
  atlasUVByAxis(line, { z: CRATE.steelPainted, x: CRATE.steelPainted, y: CRATE.steelPainted }, 4, 4);
  parts.push(line);

  // latches
  const nl = rng.int(2, 3);
  for (let i = 0; i < nl; i++) {
    const t = (i + 1) / (nl + 1);
    const l = bevelBox(0.075, 0.055, 0.03, 0.008);
    xf(l, (t - 0.5) * w * 0.86, h * 0.62, d / 2 + 0.012);
    atlasUVByAxis(l, { z: CRATE.steelPainted, x: CRATE.steelPainted, y: CRATE.steelPainted }, 4, 4);
    parts.push(l);
  }
  // corner bumpers
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const c = bevelBox(0.075, 0.075, 0.075, 0.022, 2);
      xf(c, sx * (w / 2 - 0.03), h - 0.03, sz * (d / 2 - 0.03));
      atlasUVByAxis(c, { z: CRATE.steelRust, x: CRATE.steelRust, y: CRATE.steelRust }, 4, 4);
      parts.push(c);
      const c2 = bevelBox(0.075, 0.075, 0.075, 0.022, 2);
      xf(c2, sx * (w / 2 - 0.03), 0.03, sz * (d / 2 - 0.03));
      atlasUVByAxis(c2, { z: CRATE.steelRust, x: CRATE.steelRust, y: CRATE.steelRust }, 4, 4);
      parts.push(c2);
    }
  }
  // handle
  const hbar = cyl(0.014, 0.014, w * 0.3, 6);
  xf(hbar, 0, h * 0.62, -d / 2 - 0.05, 0, 0, Math.PI / 2);
  atlasUVByAxis(hbar, { z: CRATE.steelPainted, x: CRATE.steelPainted, y: CRATE.steelPainted }, 4, 4);
  parts.push(hbar);
  for (const s of [-1, 1]) {
    const arm = box(0.02, 0.02, 0.06);
    xf(arm, s * w * 0.15, h * 0.62, -d / 2 - 0.025);
    atlasUVByAxis(arm, { z: CRATE.steelPainted, x: CRATE.steelPainted, y: CRATE.steelPainted }, 4, 4);
    parts.push(arm);
  }

  const geo = mergeAll(parts);
  warp(geo, 0.003, 5, rng.int(1, 9999));
  return seat(geo);
}

/** Steel ammunition box: welded seams, lid clamp, stencilled side. */
export function ammoBox(rng) {
  const w = rng.range(0.44, 0.56);
  const d = rng.range(0.19, 0.25);
  const h = rng.range(0.22, 0.3);
  const parts = [];
  const body = bevelBox(w, h, d, 0.014);
  xf(body, 0, h / 2, 0);
  A(body, CRATE.ammoSide, CRATE.ammoLid);
  parts.push(body);

  const lid = bevelBox(w * 1.02, 0.035, d * 1.02, 0.01);
  xf(lid, 0, h + 0.012, 0);
  A(lid, CRATE.ammoLid, CRATE.ammoLid);
  parts.push(lid);

  const clamp = bevelBox(0.09, 0.05, 0.05, 0.012);
  xf(clamp, w * 0.3, h + 0.03, d * 0.4, rng.jit(0.4), 0, 0);
  atlasUVByAxis(clamp, { z: CRATE.steelPainted, x: CRATE.steelPainted, y: CRATE.steelPainted }, 4, 4);
  parts.push(clamp);

  const handle = cyl(0.012, 0.012, w * 0.34, 6);
  xf(handle, -w * 0.18, h + 0.05, 0, 0, 0, Math.PI / 2);
  atlasUVByAxis(handle, { z: CRATE.steelPainted, x: CRATE.steelPainted, y: CRATE.steelPainted }, 4, 4);
  parts.push(handle);

  const geo = mergeAll(parts);
  warp(geo, 0.003, 6, rng.int(1, 9999));
  return seat(geo);
}

/** Stackable vented plastic crate. */
export function plasticCrate(rng) {
  const w = rng.range(0.48, 0.62);
  const d = w * rng.range(0.62, 0.78);
  const h = rng.range(0.26, 0.36);
  const parts = [];
  const body = bevelBox(w, h, d, 0.02, 2);
  xf(body, 0, h / 2, 0);
  A(body, CRATE.plasticSide, CRATE.plasticLid);
  parts.push(body);
  const rim = bevelBox(w * 1.04, 0.03, d * 1.04, 0.01);
  xf(rim, 0, h - 0.012, 0);
  A(rim, CRATE.plasticLid, CRATE.plasticLid);
  parts.push(rim);
  const foot = bevelBox(w * 0.9, 0.03, d * 0.9, 0.008);
  xf(foot, 0, 0.014, 0);
  A(foot, CRATE.plasticLid, CRATE.plasticLid);
  parts.push(foot);
  const geo = mergeAll(parts);
  warp(geo, 0.004, 5, rng.int(1, 9999));
  return seat(geo);
}

/** Sagging cardboard box, often damp at the base. */
export function cardboardBox(rng) {
  const w = rng.range(0.34, 0.58);
  const d = w * rng.range(0.7, 1.0);
  const h = rng.range(0.28, 0.46);
  const g = bevelBox(w, h, d, 0.012);
  xf(g, 0, h / 2, 0);
  A(g, CRATE.cardboard, CRATE.cardboard);
  // flaps
  const parts = [g];
  for (const s of [-1, 1]) {
    const f = box(w * 0.48, 0.008, d * 0.94);
    xf(f, s * w * 0.24, h + 0.004, 0, 0, 0, s * rng.range(0.05, 0.5));
    A(f, CRATE.cardboard, CRATE.cardboard);
    parts.push(f);
  }
  const geo = mergeAll(parts);
  warp(geo, 0.012, 3.5, rng.int(1, 9999));
  return seat(geo);
}

/* ------------------------------------------------------------------- drums */

/**
 * 205 l drum. Rolling hoops give the silhouette, the lathe body takes the
 * cylindrical label wrap, and dents are punched per-seed so no two match.
 */
export function oilDrum(rng, { dented = null, cell = null } = {}) {
  const r = rng.range(0.28, 0.3);
  const h = rng.range(0.85, 0.93);
  const parts = [];
  const c = cell ?? rng.pick([DRUM.diesel, DRUM.waste, DRUM.jp8, DRUM.flam]);

  const body = cyl(r, r * 0.995, h, 20, true);
  xf(body, 0, h / 2, 0);
  cylUV(body, 1, 1);
  atlasRemap(body, c[0], c[1], 2, 2);
  parts.push(body);

  for (const t of [0.3, 0.62]) {
    const hoop = cyl(r * 1.05, r * 1.05, h * 0.055, 20, true);
    xf(hoop, 0, h * t + h * 0.0275, 0);
    cylUV(hoop, 1, 0.06);
    atlasRemap(hoop, c[0], c[1], 2, 2);
    parts.push(hoop);
  }

  for (const y of [0.015, h - 0.015]) {
    const cap = cyl(r * 1.02, r * 1.02, 0.03, 20);
    xf(cap, 0, y, 0);
    cylUV(cap, 1, 0.04);
    atlasRemap(cap, c[0], c[1], 2, 2);
    parts.push(cap);
  }
  // bung
  const bung = cyl(0.035, 0.035, 0.016, 8);
  xf(bung, r * 0.5, h + 0.002, 0);
  boxUV01(bung);
  atlasRemap(bung, DRUM.waste[0], DRUM.waste[1], 2, 2);
  parts.push(bung);

  const geo = mergeAll(parts);
  const nd = dented ?? rng.int(0, 3);
  for (let i = 0; i < nd; i++) {
    const a = rng.range(0, Math.PI * 2);
    const y = rng.range(h * 0.15, h * 0.85);
    dent(geo, Math.cos(a) * r, y, Math.sin(a) * r, rng.range(0.13, 0.24), rng.range(0.02, 0.07), false);
  }
  warp(geo, 0.004, 6, rng.int(1, 9999));
  return seat(geo);
}

/** Jerry can — small, instantly readable silhouette, good foreground filler. */
export function jerryCan(rng) {
  const w = 0.17, h = 0.46, d = 0.34;
  const parts = [];
  const body = bevelBox(w, h, d, 0.03, 2);
  xf(body, 0, h / 2, 0);
  A(body, CRATE.caseB, CRATE.caseLid);
  parts.push(body);
  // X swage
  for (const s of [-1, 1]) {
    const bar = box(0.012, h * 0.72, 0.02);
    xf(bar, 0, h * 0.5, d / 2 - 0.005, 0, 0, s * 0.62);
    A(bar, CRATE.steelPainted, CRATE.steelPainted);
    parts.push(bar);
  }
  // triple handle
  for (let i = -1; i <= 1; i++) {
    const hb = cyl(0.014, 0.014, 0.1, 6);
    xf(hb, 0, h + 0.03, i * 0.075, Math.PI / 2, 0, 0);
    A(hb, CRATE.steelPainted, CRATE.steelPainted);
    parts.push(hb);
  }
  const spout = cyl(0.03, 0.034, 0.06, 8);
  xf(spout, 0, h + 0.02, -d * 0.3);
  A(spout, CRATE.steelRust, CRATE.steelRust);
  parts.push(spout);
  const geo = mergeAll(parts);
  warp(geo, 0.003, 7, rng.int(1, 9999));
  return seat(geo);
}

/* ------------------------------------------------------- pallets & spools */

/** Euro-ish pallet. Boards are individually offset and warped. */
export function pallet(rng) {
  const w = rng.range(1.1, 1.22);
  const d = rng.range(0.78, 0.86);
  const th = 0.022;
  const parts = [];
  const cell = CRATE.pallet;

  const deckN = 6;
  for (let i = 0; i < deckN; i++) {
    const t = i / (deckN - 1);
    const b = box(w, th, d / deckN * 0.72);
    xf(b, rng.jit(0.008), 0.144, (t - 0.5) * d * 0.94, rng.jit(0.01), rng.jit(0.01), 0);
    A(b, cell, cell);
    parts.push(b);
  }
  for (const sx of [-1, 0, 1]) {
    const s = box(0.09, 0.1, d);
    xf(s, sx * w * 0.44, 0.083, 0);
    A(s, cell, cell);
    parts.push(s);
    const bot = box(w, th, d / 5);
    xf(bot, 0, 0.022, sx * d * 0.4);
    A(bot, cell, cell);
    parts.push(bot);
  }
  const geo = mergeAll(parts);
  warp(geo, 0.006, 4, rng.int(1, 9999));
  return seat(geo);
}

/** Wooden cable drum — big round silhouette, reads from across the map. */
export function cableSpool(rng) {
  const R = rng.range(0.55, 0.78);
  const width = R * rng.range(0.7, 0.95);
  const parts = [];
  for (const s of [-1, 1]) {
    const disc = cyl(R, R, 0.05, 20);
    xf(disc, 0, R, s * width / 2, Math.PI / 2, 0, 0);
    boxUV01(disc);
    atlasRemap(disc, ...CRATE.plywood, 4, 4);
    parts.push(disc);
    // radial ribs
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const rib = box(0.07, R * 1.9, 0.03);
      xf(rib, Math.cos(a) * 0, R + 0, s * (width / 2 + 0.035), 0, 0, a);
      boxUV01(rib);
      atlasRemap(rib, ...CRATE.pallet, 4, 4);
      parts.push(rib);
    }
  }
  const hub = cyl(R * 0.42, R * 0.42, width, 16, true);
  xf(hub, 0, R, 0, Math.PI / 2, 0, 0);
  cylUV(hub, 2, 1);
  atlasRemap(hub, ...CRATE.steelRust, 4, 4);
  parts.push(hub);
  // wound cable
  const turns = rng.int(5, 8);
  for (let i = 0; i < turns; i++) {
    const t = (i + 0.5) / turns;
    const ring = new THREE.TorusGeometry(R * 0.55, 0.035, 5, 20);
    xf(ring, 0, R, (t - 0.5) * width * 0.82);
    boxUV01(ring);
    atlasRemap(ring, ...CRATE.steelRust, 4, 4);
    parts.push(ring);
  }
  const geo = mergeAll(parts);
  warp(geo, 0.004, 4, rng.int(1, 9999));
  return seat(geo);
}

/* ------------------------------------------------------------- soft goods */

/**
 * A tarpaulin thrown over a stack. Built as a displaced grid so the folds are
 * real geometry — a flat quad with a fabric texture never reads as cloth.
 */
export function tarpDrape(rng, { w = 1.6, d = 1.3, h = 0.95 } = {}) {
  const segs = 16;
  const geo = new THREE.PlaneGeometry(w, d, segs, segs);
  geo.rotateX(-Math.PI / 2);
  const p = geo.attributes.position;
  const seed = rng.int(1, 9999);
  // Real drape folds RADIALLY: cloth pulled over a box gathers into creases that
  // run from the crown down to the hem. The old version used a product of two
  // sines in x and z, which is a bumpy quilt — and a smooth pale quilt is
  // exactly what reads as a folded sheet of paper. Radial creases plus a corner
  // lifted off the ground make it read as sheeting over a stack.
  const creases = rng.int(6, 10);
  const creasePhase = rng.range(0, Math.PI * 2);
  const liftAngle = rng.range(0, Math.PI * 2);
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), z = p.getZ(i);
    const u = Math.abs(x) / (w / 2), v = Math.abs(z) / (d / 2);
    const edge = Math.min(1, Math.max(u, v));
    const ang = Math.atan2(z, x);
    // dome over the hidden stack, falling to the ground at the hem
    let y = h * Math.cos(edge * Math.PI * 0.5) ** 0.7;
    // radial creases, deepest halfway down the fall and vanishing at the crown
    const fall = Math.sin(edge * Math.PI);
    y -= Math.abs(Math.sin(ang * creases * 0.5 + creasePhase)) * 0.055 * fall;
    // slack pooling where the hem meets the ground
    y += Math.max(0, edge - 0.8) * 5 * Math.sin(ang * creases + creasePhase) * 0.02;
    // one corner of the hem flicked up, and the whole sheet slightly off-square
    const lift = Math.max(0, Math.cos(ang - liftAngle)) ** 3 * Math.max(0, edge - 0.72) * 3.2;
    y += lift * rng.range(0.05, 0.14);
    y += Math.sin(x * 21 + z * 15 + seed) * 0.007;
    if (edge > 0.96) y *= 0.3;
    p.setY(i, Math.max(0.004, y));
    // creases pull the cloth inward as well as down — without this the folds
    // read as embossing rather than as gathered fabric
    const pull = 1 - Math.abs(Math.sin(ang * creases * 0.5 + creasePhase)) * 0.035 * fall;
    p.setXYZ(i, x * pull, p.getY(i), z * pull);
  }
  p.needsUpdate = true;
  geo.computeVertexNormals();
  boxUV(geo, 1.4);
  warp(geo, 0.008, 3, seed);
  return seat(geo);
}

/** Rolled-up tarp / kit bag lying against something. */
export function bundle(rng) {
  const len = rng.range(0.7, 1.3);
  const r = rng.range(0.14, 0.22);
  const geo = cyl(r, r * rng.range(0.8, 1), len, 10, false);
  xf(geo, 0, r, 0, 0, 0, Math.PI / 2);
  boxUV(geo, 1.6);
  warp(geo, 0.028, 4.5, rng.int(1, 9999));
  geo.computeVertexNormals();
  return seat(geo);
}
