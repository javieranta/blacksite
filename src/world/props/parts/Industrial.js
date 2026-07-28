import * as THREE from 'three';
import {
  bevelBox, box, cyl, xf, mergeAll, boxUV, boxUV01, atlasRemap, warp, seat, seatGroup, tubeAlong,
} from '../GeoUtil.js';
import { SIGN } from '../Atlas.js';

/**
 * Industrial plant: HVAC, ducting, pipe runs, scaffolding, lighting, gensets.
 * OWNER: props agent.
 *
 * This is the family that makes a space read as *serviced* rather than
 * *modelled* — buildings have machinery bolted to them, and the eye knows it.
 */

/* ------------------------------------------------------------------- HVAC */

/** Rooftop / ground AC plant: ribbed shell, fan cowl, blades, louvres, feet. */
export function hvacUnit(rng) {
  const w = rng.range(1.25, 1.9);
  const d = w * rng.range(0.62, 0.85);
  const h = rng.range(0.75, 1.05);
  const steel = [];
  const dark = [];

  const shell = bevelBox(w, h, d, 0.03, 2);
  xf(shell, 0, h / 2 + 0.08, 0);
  boxUV(shell, 0.9);
  steel.push(shell);

  // vertical stiffening ribs
  const ribs = Math.max(3, Math.round(w / 0.3));
  for (let i = 0; i < ribs; i++) {
    const t = (i / (ribs - 1) - 0.5) * w * 0.92;
    for (const s of [-1, 1]) {
      const r = box(0.035, h * 0.86, 0.03);
      xf(r, t, h / 2 + 0.08, s * (d / 2 + 0.012));
      boxUV(r, 2);
      steel.push(r);
    }
  }
  // louvre bank on one end
  for (let i = 0; i < 7; i++) {
    const l = box(0.028, 0.045, d * 0.7);
    xf(l, w / 2 + 0.014, 0.22 + i * 0.085, 0, 0, 0, -0.5);
    boxUV(l, 2.4);
    dark.push(l);
  }
  // fan cowl + blades
  const cowlR = Math.min(w, d) * 0.3;
  const cowl = cyl(cowlR, cowlR * 1.08, 0.1, 16, true);
  xf(cowl, w * 0.16, h + 0.11, 0);
  boxUV(cowl, 1.6);
  steel.push(cowl);
  const guard = new THREE.TorusGeometry(cowlR * 0.98, 0.014, 5, 18);
  xf(guard, w * 0.16, h + 0.16, 0, Math.PI / 2, 0, 0);
  boxUV(guard, 2);
  dark.push(guard);
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + rng.range(0, 1);
    const blade = box(cowlR * 0.9, 0.012, cowlR * 0.34);
    xf(blade, w * 0.16 + Math.cos(a) * cowlR * 0.45, h + 0.09, Math.sin(a) * cowlR * 0.45, 0.22, a, 0);
    boxUV(blade, 2);
    dark.push(blade);
  }
  // access panel + feet
  const panel = box(w * 0.42, h * 0.5, 0.02);
  xf(panel, -w * 0.2, h * 0.5, d / 2 + 0.014);
  boxUV(panel, 1.4);
  steel.push(panel);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const foot = box(0.14, 0.09, 0.14);
      xf(foot, sx * w * 0.4, 0.045, sz * d * 0.36);
      boxUV(foot, 2.4);
      dark.push(foot);
    }
  }
  // refrigerant stubs
  for (const s of [-1, 1]) {
    const stub = cyl(0.028, 0.028, 0.22, 8);
    xf(stub, -w / 2 - 0.02, h * 0.35 + s * 0.1, d * 0.2, 0, 0, Math.PI / 2);
    boxUV(stub, 3);
    dark.push(stub);
  }

  const g = mergeAll(steel);
  warp(g, 0.005, 3, rng.int(1, 9999));
  return seatGroup({ steel: g, dark: mergeAll(dark) });
}

/** Wall louvre / extract vent. The face uses the signage atlas louvre cell. */
export function wallVent(rng) {
  const w = rng.range(0.5, 0.85);
  const h = w * rng.range(0.6, 0.9);
  const frame = [];
  const shell = bevelBox(w, h, 0.11, 0.012);
  xf(shell, 0, 0, -0.055);
  boxUV(shell, 1.6);
  frame.push(shell);
  const face = new THREE.PlaneGeometry(w * 0.86, h * 0.86);
  xf(face, 0, 0, 0.003);
  atlasRemap(boxUV01(face), SIGN.louvre[0], SIGN.louvre[1], 4, 4);
  return { frame: mergeAll(frame), face };
}

/** Rectangular duct run along a ceiling or wall, with flanged joints. */
export function ductRun(rng, len = 4, w = 0.42, h = 0.34) {
  const parts = [];
  const joints = Math.max(2, Math.round(len / 1.2));
  const body = box(len, h, w);
  boxUV(body, 1.1);
  parts.push(body);
  for (let i = 0; i <= joints; i++) {
    const t = (i / joints - 0.5) * len;
    const f = box(0.035, h * 1.11, w * 1.11);
    xf(f, t, 0, 0);
    boxUV(f, 2.2);
    parts.push(f);
  }
  const geo = mergeAll(parts);
  warp(geo, 0.004, 3, rng.int(1, 9999));
  return geo;
}

/* ------------------------------------------------------------------- pipe */

/** Pipe swept through a route, with flanges every few metres. */
export function pipeRoute(points, radius = 0.06, rng = null) {
  const parts = [tubeAlong(points, radius, 8)];
  for (let i = 1; i < points.length - 1; i++) {
    if (rng && !rng.bool(0.6)) continue;
    const f = cyl(radius * 1.55, radius * 1.55, radius * 0.9, 10);
    const a = points[i - 1], b = points[i + 1];
    const dir = new THREE.Vector3().subVectors(b, a).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    const m = new THREE.Matrix4().compose(points[i], q, new THREE.Vector3(1, 1, 1));
    f.applyMatrix4(m);
    parts.push(f);
  }
  const geo = mergeAll(parts);
  boxUV(geo, 1.6);
  return geo;
}

/** U-bracket that ties a pipe back to a wall. */
export function pipeBracket(radius = 0.06) {
  const parts = [];
  const back = box(0.03, radius * 3.4, radius * 3.4);
  xf(back, -0.015, 0, 0);
  parts.push(back);
  const strap = new THREE.TorusGeometry(radius * 1.25, 0.014, 5, 12, Math.PI * 1.4);
  xf(strap, radius * 0.9, 0, 0, 0, Math.PI / 2, Math.PI * 0.8);
  parts.push(strap);
  const geo = mergeAll(parts);
  boxUV(geo, 3);
  return geo;
}

/* ------------------------------------------------------------- scaffolding */

/** Unit scaffold tube of a fixed length — instanced by the hundred. */
export function scaffoldTube(len, radius = 0.024) {
  const geo = cyl(radius, radius, len, 7);
  boxUV(geo, 2.2);
  return geo;
}

/** Scaffold board: rough timber with steel end-caps. */
export function scaffoldPlank(rng, len = 2.4) {
  const parts = [];
  const b = box(len, 0.038, 0.23);
  boxUV(b, 1.6);
  parts.push(b);
  for (const s of [-1, 1]) {
    const cap = box(0.05, 0.05, 0.235);
    xf(cap, s * (len / 2 - 0.024), 0, 0);
    boxUV(cap, 3);
    parts.push(cap);
  }
  const geo = mergeAll(parts);
  warp(geo, 0.005, 4, rng.int(1, 9999));
  return geo;
}

/** Coupler blob where two tubes cross — small but sells the kit. */
export function scaffoldClamp() {
  const parts = [];
  const a = cyl(0.042, 0.042, 0.07, 8);
  parts.push(a);
  const b = cyl(0.042, 0.042, 0.07, 8);
  xf(b, 0, 0, 0.05, Math.PI / 2, 0, 0);
  parts.push(b);
  const geo = mergeAll(parts);
  boxUV(geo, 3);
  return geo;
}

/** Vertical access ladder with a cage-less simple rung set. */
export function ladder(rng, h = 3.0) {
  const parts = [];
  for (const s of [-1, 1]) {
    const rail = box(0.04, h, 0.06);
    xf(rail, s * 0.2, h / 2, 0);
    boxUV(rail, 2);
    parts.push(rail);
  }
  const n = Math.max(4, Math.round(h / 0.3));
  for (let i = 0; i < n; i++) {
    const r = cyl(0.016, 0.016, 0.4, 6);
    xf(r, 0, 0.18 + i * ((h - 0.3) / (n - 1)), 0, 0, 0, Math.PI / 2);
    boxUV(r, 3);
    parts.push(r);
  }
  const geo = mergeAll(parts);
  warp(geo, 0.004, 4, rng.int(1, 9999));
  return seat(geo);
}

/* ---------------------------------------------------------------- lighting */

/**
 * Wall-pack lamp. Returns the housing and the lens separately so the lens can
 * take the emissive material and drive bloom.
 */
export function wallLamp(rng) {
  const w = rng.range(0.24, 0.34);
  const housing = [];
  const back = bevelBox(w * 0.5, w * 0.7, 0.07, 0.012);
  xf(back, 0, 0, -0.035);
  boxUV(back, 2.2);
  housing.push(back);
  const hood = bevelBox(w, 0.055, w * 0.6, 0.014);
  xf(hood, 0, w * 0.3, w * 0.26);
  boxUV(hood, 2.2);
  housing.push(hood);
  for (const s of [-1, 1]) {
    const side = box(0.02, w * 0.52, w * 0.56);
    xf(side, s * w * 0.47, w * 0.02, w * 0.26, 0, 0, 0);
    boxUV(side, 2.4);
    housing.push(side);
  }
  const lens = new THREE.PlaneGeometry(w * 0.88, w * 0.46);
  xf(lens, 0, 0, w * 0.53, 0.35, 0, 0);
  boxUV01(lens);
  return { housing: mergeAll(housing), lens };
}

/** Floodlight head on a yoke — for masts, corners and tripods. */
export function floodHead(rng) {
  const r = rng.range(0.17, 0.24);
  const housing = [];
  const shell = cyl(r, r * 0.86, 0.16, 12, false);
  xf(shell, 0, 0, 0, Math.PI / 2, 0, 0);
  boxUV(shell, 1.8);
  housing.push(shell);
  const rim = new THREE.TorusGeometry(r * 1.02, 0.018, 5, 14);
  xf(rim, 0, 0, 0.082);
  boxUV(rim, 2.4);
  housing.push(rim);
  const yoke = new THREE.TorusGeometry(r * 1.2, 0.016, 5, 14, Math.PI);
  xf(yoke, 0, 0, -0.02, 0, Math.PI / 2, 0);
  boxUV(yoke, 2.4);
  housing.push(yoke);
  const lens = new THREE.CircleGeometry(r * 0.92, 14);
  xf(lens, 0, 0, 0.085);
  boxUV01(lens);
  return { housing: mergeAll(housing), lens };
}

/** Strip / fluorescent fixture for interiors and canopies. */
export function stripLight(rng, len = 1.2) {
  const housing = [];
  const body = bevelBox(len, 0.09, 0.12, 0.012);
  boxUV(body, 1.6);
  housing.push(body);
  for (const s of [-1, 1]) {
    const end = box(0.03, 0.1, 0.13);
    xf(end, s * len / 2, 0, 0);
    boxUV(end, 3);
    housing.push(end);
  }
  const lens = new THREE.PlaneGeometry(len * 0.94, 0.1);
  xf(lens, 0, -0.05, 0, Math.PI / 2, 0, 0);
  boxUV01(lens);
  void rng;
  return { housing: mergeAll(housing), lens };
}

/** Lamp mast: a leaning pole with a head bracket. */
export function lampMast(rng, h = 4.2) {
  const parts = [];
  const pole = cyl(0.055, 0.075, h, 10);
  xf(pole, 0, h / 2, 0);
  boxUV(pole, 1.2);
  parts.push(pole);
  const base = cyl(0.14, 0.17, 0.12, 10);
  xf(base, 0, 0.06, 0);
  boxUV(base, 2);
  parts.push(base);
  const arm = cyl(0.04, 0.04, 0.7, 8);
  xf(arm, 0.3, h - 0.1, 0, 0, 0, Math.PI / 2 + 0.18);
  boxUV(arm, 2);
  parts.push(arm);
  const geo = mergeAll(parts);
  warp(geo, 0.006, 2, rng.int(1, 9999));
  return seat(geo);
}

/* ------------------------------------------------------------ misc plant */

/** Wall-mounted junction box with conduit stubs. */
export function junctionBox(rng) {
  const w = rng.range(0.22, 0.36);
  const parts = [];
  const b = bevelBox(w, w * 1.25, 0.14, 0.012);
  boxUV(b, 2.2);
  parts.push(b);
  const lid = box(w * 0.86, w * 1.1, 0.02);
  xf(lid, 0, 0, 0.078);
  boxUV(lid, 2.4);
  parts.push(lid);
  for (const s of [-1, 1]) {
    const g = cyl(0.022, 0.022, 0.08, 7);
    xf(g, s * w * 0.28, -w * 0.66, 0);
    boxUV(g, 3);
    parts.push(g);
  }
  const geo = mergeAll(parts);
  warp(geo, 0.003, 6, rng.int(1, 9999));
  return geo;
}

/** Skid-mounted generator: frame, canopy, exhaust, control panel. */
export function generator(rng) {
  const w = rng.range(1.5, 2.0);
  const d = w * 0.5;
  const h = rng.range(0.9, 1.15);
  const steel = [];
  const dark = [];

  // skid frame
  for (const sz of [-1, 1]) {
    const rail = box(w * 1.06, 0.1, 0.1);
    xf(rail, 0, 0.05, sz * d / 2);
    boxUV(rail, 2);
    dark.push(rail);
  }
  const canopy = bevelBox(w, h * 0.78, d, 0.035, 2);
  xf(canopy, 0, 0.1 + h * 0.39, 0);
  boxUV(canopy, 1.0);
  steel.push(canopy);
  // roof slope
  const roof = bevelBox(w * 1.04, 0.07, d * 1.06, 0.02);
  xf(roof, 0, 0.1 + h * 0.78, 0, 0.03, 0, 0);
  boxUV(roof, 1.2);
  steel.push(roof);
  // louvres
  for (let i = 0; i < 5; i++) {
    const l = box(w * 0.36, 0.035, 0.02);
    xf(l, -w * 0.26, 0.32 + i * 0.09, d / 2 + 0.012, -0.4, 0, 0);
    boxUV(l, 2.6);
    dark.push(l);
  }
  // control panel
  const panel = box(w * 0.3, h * 0.36, 0.03);
  xf(panel, w * 0.26, 0.1 + h * 0.44, d / 2 + 0.018);
  boxUV(panel, 2);
  dark.push(panel);
  // exhaust
  const stack = cyl(0.055, 0.06, 0.55, 9);
  xf(stack, -w * 0.38, 0.1 + h * 0.78 + 0.28, -d * 0.3);
  boxUV(stack, 2);
  dark.push(stack);
  const elbow = cyl(0.055, 0.055, 0.2, 9);
  xf(elbow, -w * 0.38 + 0.09, 0.1 + h * 0.78 + 0.52, -d * 0.3, 0, 0, Math.PI / 2);
  boxUV(elbow, 2);
  dark.push(elbow);
  // lifting eye
  const eye = new THREE.TorusGeometry(0.06, 0.014, 5, 12);
  xf(eye, 0, 0.1 + h * 0.84, 0, 0, Math.PI / 2, 0);
  boxUV(eye, 3);
  dark.push(eye);

  const g = mergeAll(steel);
  warp(g, 0.005, 3, rng.int(1, 9999));
  return seatGroup({ steel: g, dark: mergeAll(dark) });
}

/** Gas cylinder rack — tall thin verticals, great silhouette breakers. */
export function gasBottle(rng) {
  const r = 0.115;
  const h = rng.range(1.05, 1.35);
  const parts = [];
  const body = cyl(r, r, h * 0.82, 14);
  xf(body, 0, h * 0.41, 0);
  boxUV(body, 1.4);
  parts.push(body);
  const dome = new THREE.SphereGeometry(r, 14, 7, 0, Math.PI * 2, 0, Math.PI / 2);
  xf(dome, 0, h * 0.82, 0);
  boxUV(dome, 1.4);
  parts.push(dome);
  const collar = cyl(r * 0.55, r * 0.62, h * 0.12, 12, true);
  xf(collar, 0, h * 0.92, 0);
  boxUV(collar, 2);
  parts.push(collar);
  const valve = cyl(0.028, 0.028, 0.09, 8);
  xf(valve, 0, h * 0.98, 0);
  boxUV(valve, 3);
  parts.push(valve);
  const geo = mergeAll(parts);
  warp(geo, 0.003, 5, rng.int(1, 9999));
  return seat(geo);
}
