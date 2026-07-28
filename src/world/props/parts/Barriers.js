import * as THREE from 'three';
import {
  bevelBox, box, cyl, xf, mergeAll, boxUV, boxUV01, atlasRemap, warp, seat, sagPanel,
} from '../GeoUtil.js';
import { CRATE, SIGN } from '../Atlas.js';

/**
 * Barriers, revetments and fencing. OWNER: props agent.
 *
 * These are the props that draw the *lines* of a space — where you may walk,
 * where the level wants you to fight from. They matter more than clutter for
 * composition, so each one is built to read in silhouette at 30 m.
 */

/* --------------------------------------------------------- jersey barrier */

const JERSEY_PROFILE = [
  [-0.31, 0.0], [0.31, 0.0], [0.245, 0.075], [0.125, 0.4],
  [0.105, 0.55], [0.105, 0.86], [-0.105, 0.86], [-0.105, 0.55],
  [-0.125, 0.4], [-0.245, 0.075],
];

/** Concrete jersey barrier, extruded from a real profile with chipped edges. */
export function jerseyBarrier(rng, { length = null } = {}) {
  const len = length ?? rng.range(1.9, 2.4);
  const shape = new THREE.Shape();
  JERSEY_PROFILE.forEach(([x, y], i) => {
    const jx = x * (1 + rng.jit(0.02));
    if (i === 0) shape.moveTo(jx, y); else shape.lineTo(jx, y);
  });
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: len, bevelEnabled: true, bevelThickness: 0.022, bevelSize: 0.022, bevelSegments: 2, steps: 2,
  });
  xf(geo, 0, 0, -len / 2);
  boxUV(geo, 1.35);
  warp(geo, 0.012, 2.6, rng.int(1, 9999));

  const parts = [geo];
  // lifting eyes
  for (const s of [-1, 1]) {
    const eye = new THREE.TorusGeometry(0.045, 0.012, 5, 10);
    xf(eye, 0, 0.87, s * len * 0.25, 0, Math.PI / 2, 0);
    boxUV01(eye);
    atlasRemap(eye, CRATE.steelRust[0], CRATE.steelRust[1], 4, 4);
    parts.push(eye);
  }
  return seat(mergeAll(parts));
}

/**
 * Reflective chevron panels for a jersey barrier. The barrier profile is drawn in
 * XY and extruded along Z, so its broad faces are ±X — a panel on ±Z would sit on
 * the 60 cm end cap, which is why this builds one quad per long face.
 */
export function barrierChevron(rng, len = 2.0) {
  const parts = [];
  for (const s of [-1, 1]) {
    const geo = new THREE.PlaneGeometry(len * 0.8, 0.3);
    atlasRemap(boxUV01(geo), SIGN.chevron[0], SIGN.chevron[1], 4, 4);
    // 0.128 clears the 0.105 half-width plus the warp jitter, so it cannot
    // z-fight with the concrete it is bolted to.
    xf(geo, s * 0.128, 0.58, 0, 0, s * Math.PI / 2, 0);
    parts.push(geo);
  }
  void rng;
  return mergeAll(parts);
}

/* --------------------------------------------------------------- gabions */
/* Sandbags moved to parts/Sandbags.js — they needed a pillow cross-section, a
 * hessian weave and pre-authored wall modules, which is more than belongs in a
 * shared barriers file. */

/** Gabion / hesco cell: wire cage packed with rubble. Big, blocky, believable. */
export function hesco(rng) {
  const w = rng.range(0.9, 1.15);
  const h = rng.range(0.85, 1.05);
  const parts = [];
  const fill = bevelBox(w * 0.97, h, w * 0.97, 0.03, 2);
  xf(fill, 0, h / 2, 0);
  boxUV(fill, 1.5);
  warp(fill, 0.02, 5, rng.int(1, 9999));
  parts.push(fill);
  return { fill: seat(mergeAll(parts)), size: { w, h } };
}

/** The wire cage that wraps a hesco — separate material, so separate geometry. */
export function hescoCage(w, h) {
  const parts = [];
  const bar = 0.014;
  for (const y of [0.06, h * 0.5, h - 0.06]) {
    for (const [ax, az] of [[1, 0], [0, 1]]) {
      for (const s of [-1, 1]) {
        const b = box(ax ? w : bar, bar, az ? w : bar);
        xf(b, az ? s * w / 2 : 0, y, ax ? s * w / 2 : 0);
        boxUV(b, 3);
        parts.push(b);
      }
    }
  }
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const v = box(bar, h, bar);
      xf(v, sx * w / 2, h / 2, sz * w / 2);
      boxUV(v, 3);
      parts.push(v);
    }
  }
  return seat(mergeAll(parts));
}

/* ------------------------------------------------------------- chain-link */

/** Fence post with a footplate and a slight lean baked into the caller. */
export function fencePost(rng, h = 2.1) {
  const parts = [];
  const post = cyl(0.032, 0.036, h, 8);
  xf(post, 0, h / 2, 0);
  boxUV(post, 1.4);
  parts.push(post);
  const cap = cyl(0.04, 0.04, 0.03, 8);
  xf(cap, 0, h, 0);
  boxUV(cap, 1.4);
  parts.push(cap);
  const plate = cyl(0.075, 0.085, 0.05, 8);
  xf(plate, 0, 0.025, 0);
  boxUV(plate, 1.4);
  parts.push(plate);
  void rng;
  return seat(mergeAll(parts));
}

/** Horizontal top rail — instanced along a run. */
export function fenceRail(len = 2.4) {
  const geo = cyl(0.022, 0.022, len, 6);
  xf(geo, 0, 0, 0, Math.PI / 2, 0, 0);
  boxUV(geo, 1.4);
  return geo;
}

/**
 * Chain-link panel with real sag. Alpha-tested cut-out, double sided; the sag
 * is geometric so the diamond pattern distorts the way real mesh does.
 */
export function chainPanel(rng, w = 2.4, h = 2.0) {
  const geo = new THREE.PlaneGeometry(w, h, 6, 4);
  xf(geo, 0, h / 2, 0);
  sagPanel(geo, rng.range(0.03, 0.11), 'x');
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * w / 0.42, uv.getY(i) * h / 0.42);
  uv.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

/* -------------------------------------------------------- misc hard cover */

/** Cinder / breeze block. The universal filler of every industrial yard. */
export function cinderBlock(rng) {
  const w = 0.44, h = 0.21, d = 0.21;
  const parts = [];
  const body = bevelBox(w, h, d, 0.008);
  xf(body, 0, h / 2, 0);
  boxUV(body, 2.2);
  parts.push(body);
  const geo = mergeAll(parts);
  warp(geo, 0.006, 6, rng.int(1, 9999));
  return seat(geo);
}

/** Stack of loose bricks with individually rotated courses. */
export function brickStack(rng) {
  const parts = [];
  const courses = rng.int(3, 6);
  for (let c = 0; c < courses; c++) {
    const n = rng.int(3, 5);
    for (let i = 0; i < n; i++) {
      const b = bevelBox(0.22, 0.065, 0.105, 0.005);
      const a = (c % 2) * Math.PI / 2 + rng.jit(0.12);
      xf(b,
        rng.jit(0.06) + Math.cos(a) * (i - (n - 1) / 2) * 0.115,
        0.033 + c * 0.068,
        rng.jit(0.06) + Math.sin(a) * (i - (n - 1) / 2) * 0.115,
        rng.jit(0.03), a, rng.jit(0.03));
      boxUV(b, 3.4);
      parts.push(b);
    }
  }
  const geo = mergeAll(parts);
  warp(geo, 0.004, 8, rng.int(1, 9999));
  return seat(geo);
}

/** Steel guard-rail section: post + corrugated beam. */
export function guardRail(rng, len = 3.2) {
  const parts = [];
  const beam = box(len, 0.31, 0.06);
  xf(beam, 0, 0.62, 0);
  boxUV(beam, 1.2);
  parts.push(beam);
  for (const y of [0.72, 0.52]) {
    const rib = box(len, 0.05, 0.09);
    xf(rib, 0, y, 0.02);
    boxUV(rib, 1.2);
    parts.push(rib);
  }
  const n = 3;
  for (let i = 0; i < n; i++) {
    const t = (i / (n - 1) - 0.5) * len * 0.86;
    const post = box(0.1, 0.72, 0.1);
    xf(post, t, 0.36, -0.08, 0, rng.jit(0.03), rng.jit(0.02));
    boxUV(post, 1.6);
    parts.push(post);
  }
  const geo = mergeAll(parts);
  warp(geo, 0.008, 3, rng.int(1, 9999));
  return seat(geo);
}
