import * as THREE from 'three';
import {
  box, cyl, xf, mergeAll, boxUV, boxUV01, atlasRemap, warp, seat,
} from '../GeoUtil.js';
import { CRATE, SIGN } from '../Atlas.js';

/**
 * The tertiary clutter kit. OWNER: props agent.
 *
 * The level had primary structure (buildings), secondary dressing (crates,
 * drums, barriers) and then nothing. Real industrial ground has a *third* tier
 * an order of magnitude smaller and an order of magnitude more numerous: swept
 * grit, crushed cans, torn card, snapped batten ends, offcut wire, bolt spill.
 * Its absence is why a floor reads as a floor plane rather than a floor.
 *
 * BUDGET RULES for everything in this file — these are load-bearing, not style:
 *   - under 60 triangles per item, most under 30;
 *   - `castShadow: false` at the proto (a 4 cm can's shadow map footprint is
 *     sub-texel, so it costs four cascade draws and returns nothing visible);
 *   - `receiveShadow: true`, because clutter sitting in a prop's shadow is
 *     exactly what grounds it;
 *   - no new material: every builder maps into an atlas or a tiling set that
 *     already exists.
 */

/* ------------------------------------------------------------- fines/grit */

/**
 * Scatter of loose stone. Six octahedra (8 tris each) at wildly different
 * scales — the size range is what reads as "swept up", not the count.
 */
export function pebbleScatter(rng) {
  const parts = [];
  const n = rng.int(5, 7);
  for (let i = 0; i < n; i++) {
    const r = rng.range(0.016, 0.055);
    const g = new THREE.OctahedronGeometry(r, 0);
    const a = rng.range(0, Math.PI * 2);
    const d = rng.range(0.02, 0.24);
    xf(g, Math.cos(a) * d, r * rng.range(0.3, 0.55), Math.sin(a) * d,
      rng.range(0, 3), rng.range(0, 3), rng.range(0, 3),
      rng.range(0.7, 1.3), rng.range(0.4, 0.7), rng.range(0.7, 1.3));
    parts.push(g);
  }
  const geo = mergeAll(parts);
  boxUV(geo, 6);
  return seat(geo);
}

/**
 * Low drift ridge of fines, the kind that collects against a kerb or a wall
 * base. Half a squashed dome, 24 triangles, deliberately elongated so it can be
 * laid along an edge.
 */
export function fineDrift(rng) {
  const len = rng.range(0.5, 1.4);
  const geo = new THREE.SphereGeometry(0.5, 9, 2, 0, Math.PI * 2, 0, Math.PI * 0.5);
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    p.setXYZ(i, p.getX(i) * len, p.getY(i) * rng.range(0.09, 0.17), p.getZ(i) * rng.range(0.22, 0.38));
  }
  p.needsUpdate = true;
  warp(geo, 0.014, 6, rng.int(1, 9999));
  geo.computeVertexNormals();
  boxUV(geo, 3.2);
  return seat(geo);
}

/** Fist-sized broken concrete. One warped octahedron: 8 triangles. */
export function concreteChip(rng) {
  const r = rng.range(0.05, 0.13);
  const geo = new THREE.OctahedronGeometry(r, 0);
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    p.setXYZ(i, p.getX(i) * rng.range(0.8, 1.5), p.getY(i) * rng.range(0.4, 0.8),
      p.getZ(i) * rng.range(0.8, 1.4));
  }
  p.needsUpdate = true;
  warp(geo, r * 0.22, 7, rng.int(1, 9999));
  geo.computeVertexNormals();
  boxUV(geo, 5);
  return seat(geo);
}

/** Half a broken brick — reads red against grey grit, which is why it earns a slot. */
export function brickFragment(rng) {
  const geo = box(rng.range(0.09, 0.15), 0.063, 0.105);
  boxUV(geo, 5.5);
  warp(geo, 0.007, 9, rng.int(1, 9999));
  return seat(geo);
}

/* ------------------------------------------------------------------ metal */

/**
 * Crushed drink can. Stepped cylinder with the waist stamped in and the whole
 * thing tipped over — 40 triangles and instantly readable at 2 m.
 */
export function crushedCan(rng) {
  const parts = [];
  const r = 0.033;
  const h = rng.range(0.075, 0.115);
  const body = cyl(r * rng.range(0.55, 0.8), r, h, 7, true);
  const p = body.attributes.position;
  for (let i = 0; i < p.count; i++) {
    // crush the waist asymmetrically; a symmetric squash reads as a tin, not litter
    const y = p.getY(i);
    const k = 1 - 0.42 * Math.max(0, 1 - Math.abs(y / (h * 0.34)));
    p.setXYZ(i, p.getX(i) * k, y * rng.range(0.97, 1.03), p.getZ(i) * (k * 0.72 + 0.28));
  }
  p.needsUpdate = true;
  body.computeVertexNormals();
  xf(body, 0, h / 2, 0);
  boxUV(body, 9);
  parts.push(body);
  const lid = cyl(r * 0.62, r * 0.62, 0.006, 7);
  xf(lid, 0, h, 0);
  boxUV(lid, 9);
  parts.push(lid);
  const geo = mergeAll(parts);
  // lie it down
  xf(geo, 0, 0, 0, Math.PI / 2 + rng.jit(0.25), rng.range(0, 3), rng.jit(0.2));
  return seat(geo);
}

/** Spill of bolts and washers around a dropped fitting. 36 triangles. */
export function boltSpill(rng) {
  const parts = [];
  const n = rng.int(4, 6);
  for (let i = 0; i < n; i++) {
    const g = cyl(0.011, 0.011, rng.range(0.03, 0.06), 6, false);
    const a = rng.range(0, Math.PI * 2);
    const d = rng.range(0.02, 0.16);
    xf(g, Math.cos(a) * d, 0.011, Math.sin(a) * d, Math.PI / 2, rng.range(0, 3), 0);
    parts.push(g);
  }
  const geo = mergeAll(parts);
  boxUV(geo, 8);
  return seat(geo);
}

/**
 * Loop of snapped steel banding, still holding its coil. One flattened torus —
 * strapping is everywhere on a real yard floor and nowhere in games.
 */
export function strapLoop(rng) {
  const R = rng.range(0.11, 0.2);
  const geo = new THREE.TorusGeometry(R, 0.006, 3, 12);
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    p.setXYZ(i, p.getX(i) * rng.range(0.85, 1.15), p.getY(i) * rng.range(0.6, 1.1), p.getZ(i));
  }
  p.needsUpdate = true;
  xf(geo, 0, 0, 0, Math.PI / 2 + rng.jit(0.22), rng.range(0, 3), rng.jit(0.18));
  geo.computeVertexNormals();
  boxUV(geo, 7);
  return seat(geo);
}

/** Short offcut of stiff cable, kinked. 30 triangles. */
export function wireOffcut(rng) {
  const parts = [];
  const segs = rng.int(2, 3);
  let a = rng.range(0, Math.PI * 2);
  let px = 0, pz = 0;
  for (let i = 0; i < segs; i++) {
    const len = rng.range(0.12, 0.3);
    const g = cyl(0.008, 0.008, len, 5, false);
    xf(g, px + Math.cos(a) * len * 0.5, 0.008, pz + Math.sin(a) * len * 0.5,
      0, -a, Math.PI / 2);
    parts.push(g);
    px += Math.cos(a) * len;
    pz += Math.sin(a) * len;
    a += rng.jit(1.5);
  }
  const geo = mergeAll(parts);
  boxUV(geo, 8);
  return seat(geo);
}

/* -------------------------------------------------------- card and timber */

/**
 * Snapped batten end. Two pieces still hinged at the break, which is what a
 * broken piece of wood actually looks like on the floor. 24 triangles.
 */
export function battenBreak(rng) {
  const parts = [];
  const w = rng.range(0.055, 0.085);
  for (let i = 0; i < 2; i++) {
    const len = rng.range(0.16, 0.42);
    const g = box(len, 0.022, w);
    boxUV01(g);
    atlasRemap(g, CRATE.pallet[0], CRATE.pallet[1], 4, 4);
    const a = (i === 0 ? 0 : rng.range(0.4, 1.5));
    xf(g, Math.cos(a) * len * 0.5, 0.011 + i * 0.021, Math.sin(a) * len * 0.5,
      rng.jit(0.06), -a, rng.jit(0.05));
    parts.push(g);
  }
  const geo = mergeAll(parts);
  warp(geo, 0.006, 8, rng.int(1, 9999));
  return seat(geo);
}

/**
 * Collapsed cardboard — a flattened box, creased along its folds and warped by
 * damp. Two overlapping panels, 16 triangles, reads unmistakably as card.
 */
export function flatCard(rng) {
  const parts = [];
  const w = rng.range(0.24, 0.46);
  for (let i = 0; i < 2; i++) {
    const g = new THREE.PlaneGeometry(w * rng.range(0.7, 1.05), w * rng.range(0.55, 0.9), 2, 2);
    g.rotateX(-Math.PI / 2);
    const p = g.attributes.position;
    // damp card curls at the corners and buckles across the middle
    for (let k = 0; k < p.count; k++) {
      const cx = Math.abs(p.getX(k)), cz = Math.abs(p.getZ(k));
      p.setY(k, p.getY(k) + (cx + cz) * rng.range(0.05, 0.16) + rng.jit(0.006));
    }
    p.needsUpdate = true;
    g.computeVertexNormals();
    atlasRemap(boxUV01(g), CRATE.cardboard[0], CRATE.cardboard[1], 4, 4);
    xf(g, rng.jit(0.1), 0.004 + i * 0.008, rng.jit(0.1), 0, rng.range(0, 3), 0);
    parts.push(g);
  }
  return seat(mergeAll(parts));
}

/**
 * Drift of loose paper, several sheets, nearly co-planar with the floor. The
 * cheapest clutter there is: 12 triangles for something that visibly moves the
 * eye across a bare floor.
 */
export function paperDrift(rng) {
  const parts = [];
  const n = rng.int(3, 5);
  for (let i = 0; i < n; i++) {
    const w = rng.range(0.1, 0.2);
    const g = new THREE.PlaneGeometry(w, w * rng.range(1.1, 1.5));
    g.rotateX(-Math.PI / 2);
    const p = g.attributes.position;
    for (let k = 0; k < p.count; k++) p.setY(k, Math.abs(rng.jit(0.014)));
    p.needsUpdate = true;
    g.computeVertexNormals();
    atlasRemap(boxUV01(g), CRATE.whitePlastic[0], CRATE.whitePlastic[1], 4, 4);
    const a = rng.range(0, Math.PI * 2);
    const d = rng.range(0, 0.22);
    xf(g, Math.cos(a) * d, 0.003 + i * 0.0035, Math.sin(a) * d, 0, rng.range(0, 3), 0);
    parts.push(g);
  }
  return seat(mergeAll(parts));
}

/** Torn rag / offcut of sheeting, sagged. Double-sided tarp material, 8 tris. */
export function ragCloth(rng) {
  const w = rng.range(0.18, 0.4);
  const geo = new THREE.PlaneGeometry(w, w * rng.range(0.6, 1.0), 2, 2);
  geo.rotateX(-Math.PI / 2);
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const cx = Math.abs(p.getX(i)) / (w * 0.5);
    p.setY(i, 0.004 + (1 - cx) * rng.range(0.02, 0.06) + rng.jit(0.008));
  }
  p.needsUpdate = true;
  geo.computeVertexNormals();
  boxUV(geo, 2.6);
  return seat(geo);
}

/* ---------------------------------------------------------------- markers */

/**
 * A crushed plastic bottle. Kept because a single translucent-looking white
 * object in a grey scene is a strong local accent — but it is now one member of
 * a drift, never the lone occupant of a floor.
 */
export function bottleLitter(rng) {
  const parts = [];
  const h = rng.range(0.16, 0.24);
  const r = rng.range(0.032, 0.042);
  const body = cyl(r * 0.72, r, h * 0.78, 8, true);
  const p = body.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i);
    const k = 1 - 0.3 * Math.max(0, Math.cos(y * 34));
    p.setXYZ(i, p.getX(i) * k, y, p.getZ(i) * k * rng.range(0.9, 1));
  }
  p.needsUpdate = true;
  body.computeVertexNormals();
  xf(body, 0, h * 0.39, 0);
  atlasRemap(boxUV01(body), CRATE.whitePlastic[0], CRATE.whitePlastic[1], 4, 4);
  parts.push(body);
  const neck = cyl(r * 0.34, r * 0.62, h * 0.22, 8, true);
  xf(neck, 0, h * 0.89, 0);
  atlasRemap(boxUV01(neck), CRATE.whitePlastic[0], CRATE.whitePlastic[1], 4, 4);
  parts.push(neck);
  const geo = mergeAll(parts);
  xf(geo, 0, 0, 0, Math.PI / 2 + rng.jit(0.3), rng.range(0, 3), rng.jit(0.25));
  return seat(geo);
}

/**
 * A flattened traffic cone / marker sleeve — hi-vis, so it does a lot of work
 * for the eye at almost no cost. Uses the signage atlas hazard band.
 */
export function markerSleeve(rng) {
  const h = rng.range(0.2, 0.3);
  const geo = cyl(0.045, 0.105, h, 8, true);
  xf(geo, 0, h / 2, 0);
  boxUV01(geo);
  atlasRemap(geo, SIGN.hazardBand[0], SIGN.hazardBand[1], 4, 4);
  xf(geo, 0, 0, 0, Math.PI / 2 + rng.jit(0.2), rng.range(0, 3), rng.jit(0.2));
  warp(geo, 0.008, 7, rng.int(1, 9999));
  return seat(geo);
}
