import * as THREE from 'three';
import {
  box, cyl, xf, mergeAll, boxUV, boxUV01, atlasRemap, warp, seat, bevelBox,
} from '../GeoUtil.js';
import { CRATE, FOLIAGE } from '../Atlas.js';

/**
 * Ground litter: rubble, gravel, shards, weeds, tyres, small trash.
 * OWNER: props agent.
 *
 * Cheap by design — these exist in the hundreds, so every builder here stays
 * under ~120 triangles and every one of them is instanced.
 */

/** Broken concrete chunk. Irregular, flat-shaded, reads as masonry not a rock. */
export function rubbleChunk(rng, scale = 1) {
  const geo = new THREE.IcosahedronGeometry(0.5 * scale, 0);
  const p = geo.attributes.position;
  const sx = rng.range(0.6, 1.5), sy = rng.range(0.35, 0.8), sz = rng.range(0.6, 1.4);
  for (let i = 0; i < p.count; i++) {
    p.setXYZ(i, p.getX(i) * sx, p.getY(i) * sy, p.getZ(i) * sz);
  }
  p.needsUpdate = true;
  warp(geo, 0.06 * scale, 4.5, rng.int(1, 9999));
  geo.computeVertexNormals();
  boxUV(geo, 2.4);
  return seat(geo);
}

/** Low mound of gravel / spoil. A flattened, noisy dome. */
export function gravelPile(rng) {
  const r = rng.range(0.45, 1.05);
  const geo = new THREE.SphereGeometry(r, 10, 4, 0, Math.PI * 2, 0, Math.PI * 0.5);
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    p.setY(i, p.getY(i) * rng.range(0.26, 0.34));
  }
  p.needsUpdate = true;
  warp(geo, r * 0.09, 5, rng.int(1, 9999));
  geo.computeVertexNormals();
  boxUV(geo, 1.8);
  return seat(geo);
}

/** Snapped timber offcut. */
export function plankShard(rng) {
  const len = rng.range(0.4, 1.4);
  const geo = box(len, rng.range(0.025, 0.05), rng.range(0.09, 0.18));
  boxUV01(geo);
  atlasRemap(geo, CRATE.pallet[0], CRATE.pallet[1], 4, 4);
  warp(geo, 0.012, 3, rng.int(1, 9999));
  return seat(geo);
}

/**
 * Bent sheet-metal offcut. Built as a thin slab rather than a single quad — a
 * one-sided plane vanishes when seen from below and leaves a razor sliver in the
 * frame, which is worse than the triangles it saves.
 *
 * The previous version lifted both ends by |x|, which made a symmetric tent —
 * and a symmetric tent of pale material reads as a folded sheet of paper, not a
 * discarded panel. This one is corrugated across its width and curls at ONE
 * corner only, which is how sheet steel actually fails: the ribs give it a
 * repeating specular highlight no piece of paper could have, and the asymmetry
 * stops it reading as origami.
 */
export function metalScrap(rng) {
  const w = rng.range(0.34, 0.85), d = rng.range(0.24, 0.62);
  const geo = new THREE.BoxGeometry(w, 0.014, d, 5, 1, 4);
  const p = geo.attributes.position;
  const ribs = rng.range(9, 16);                 // corrugation frequency
  const ribAmp = rng.range(0.008, 0.018);
  const curlX = rng.sign(), curlZ = rng.sign();
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), z = p.getZ(i), y = p.getY(i);
    const u = x / (w * 0.5), v = z / (d * 0.5);
    // corrugation runs along X, so the ribs cross the panel
    let dy = Math.sin(z * ribs) * ribAmp;
    // one corner lifted and rolled
    const corner = Math.max(0, u * curlX) * Math.max(0, v * curlZ);
    dy += corner * corner * rng.range(0.10, 0.26);
    // the whole panel is slightly dished from being walked on
    dy -= (1 - u * u) * (1 - v * v) * rng.range(0.004, 0.014);
    p.setXYZ(i, x + rng.jit(0.004), y + dy, z + rng.jit(0.004));
  }
  p.needsUpdate = true;
  geo.computeVertexNormals();
  boxUV(geo, 1.9);
  return seat(geo);
}

/** Discarded tyre. */
export function tyre(rng) {
  const R = rng.range(0.3, 0.4);
  const geo = new THREE.TorusGeometry(R, R * 0.33, 7, 14);
  xf(geo, 0, 0, 0, Math.PI / 2, 0, 0);
  warp(geo, 0.012, 4, rng.int(1, 9999));
  geo.computeVertexNormals();
  boxUV(geo, 2.2);
  return seat(geo);
}

/** Steel bucket / pail, sometimes on its side (caller rotates). */
export function bucket(rng) {
  const parts = [];
  const r = rng.range(0.13, 0.17);
  const h = rng.range(0.24, 0.32);
  const body = cyl(r, r * 0.82, h, 12, true);
  xf(body, 0, h / 2, 0);
  boxUV(body, 2.2);
  parts.push(body);
  const base = cyl(r * 0.82, r * 0.82, 0.02, 12);
  xf(base, 0, 0.01, 0);
  boxUV(base, 2.2);
  parts.push(base);
  const rim = new THREE.TorusGeometry(r, 0.012, 3, 10);
  xf(rim, 0, h, 0, Math.PI / 2, 0, 0);
  boxUV(rim, 3);
  parts.push(rim);
  const geo = mergeAll(parts);
  warp(geo, 0.008, 6, rng.int(1, 9999));
  return seat(geo);
}

/** Pipe offcut lying on the ground. */
export function pipeOffcut(rng) {
  const len = rng.range(0.6, 2.2);
  const r = rng.range(0.04, 0.11);
  const geo = cyl(r, r, len, 9, true);
  xf(geo, 0, r, 0, 0, 0, Math.PI / 2);
  boxUV(geo, 2);
  warp(geo, 0.004, 4, rng.int(1, 9999));
  return seat(geo);
}

/** Coil of loose cable dumped on the floor. */
export function wireCoil(rng) {
  const parts = [];
  const R = rng.range(0.2, 0.34);
  const turns = rng.int(3, 5);
  for (let i = 0; i < turns; i++) {
    const t = new THREE.TorusGeometry(R * (0.75 + i * 0.07), 0.018, 3, 11);
    xf(t, rng.jit(0.03), 0.02 + i * 0.028, rng.jit(0.03), Math.PI / 2 + rng.jit(0.08), 0, rng.jit(0.08));
    parts.push(t);
  }
  const geo = mergeAll(parts);
  boxUV(geo, 3);
  return seat(geo);
}

/** Weed tuft — two crossed alpha billboards from the foliage atlas. */
export function weedTuft(rng) {
  const h = rng.range(0.22, 0.5);
  const w = h * rng.range(0.8, 1.3);
  const cell = rng.pick(FOLIAGE);
  const parts = [];
  for (let i = 0; i < 2; i++) {
    const q = new THREE.PlaneGeometry(w, h);
    xf(q, 0, h / 2, 0, 0, (i * Math.PI) / 2 + rng.jit(0.3), 0);
    atlasRemap(boxUV01(q), cell[0], cell[1], 2, 2);
    parts.push(q);
  }
  return seat(mergeAll(parts));
}

/** Flat paper / card scrap, nearly co-planar with the ground. */
export function paperScrap(rng) {
  const w = rng.range(0.12, 0.3);
  const geo = new THREE.PlaneGeometry(w, w * rng.range(0.6, 1.2), 2, 2);
  geo.rotateX(-Math.PI / 2);
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) p.setY(i, Math.abs(rng.jit(0.02)));
  p.needsUpdate = true;
  geo.computeVertexNormals();
  atlasRemap(boxUV01(geo), CRATE.cardboard[0], CRATE.cardboard[1], 4, 4);
  return seat(geo);
}

/** Rubbish sack — lumpy, tied at the neck. */
export function trashBag(rng) {
  const geo = new THREE.SphereGeometry(0.28, 10, 8);
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i);
    const squash = y > 0.15 ? 0.5 : 1;
    p.setXYZ(i, p.getX(i) * rng.range(0.9, 1.1) * squash, y * 1.15 + 0.28, p.getZ(i) * squash);
  }
  p.needsUpdate = true;
  warp(geo, 0.03, 4, rng.int(1, 9999));
  geo.computeVertexNormals();
  boxUV(geo, 1.6);
  return seat(geo);
}

/* Bagged goods live in parts/Sandbags.js now (sandbagHeap) — the old sphere
 * stack shared the sandbag's ovoid problem and had to go with it. */

/** A single scaffold-board offcut leaning; used as a foreground occluder. */
export function leaningBoard(rng) {
  const len = rng.range(1.4, 2.2);
  const geo = bevelBox(0.26, len, 0.035, 0.006);
  xf(geo, 0, len / 2, 0);
  boxUV01(geo);
  atlasRemap(geo, CRATE.plywood[0], CRATE.plywood[1], 4, 4);
  warp(geo, 0.008, 3, rng.int(1, 9999));
  return seat(geo);
}
