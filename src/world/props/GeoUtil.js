import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { hash3, smoothstep } from './Rand.js';

/**
 * Geometry plumbing for the prop library.
 * OWNER: props agent.
 *
 * The two things that stop procedural props reading as primitives are (a) a
 * chamfered silhouette — a hard 90° edge never survives a specular highlight —
 * and (b) UVs that actually correspond to the object's real-world size. Both
 * live here.
 */

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();

/** Chamfered box. Bevel is capped so thin panels still work. */
export function bevelBox(w, h, d, bevel = 0.02, seg = 1) {
  const b = Math.max(0.002, Math.min(bevel, Math.min(w, h, d) * 0.32));
  return new RoundedBoxGeometry(w, h, d, seg, b);
}

/** Plain box, for interior/hidden bulk where the silhouette never shows. */
export function box(w, h, d) {
  return new THREE.BoxGeometry(w, h, d);
}

export function cyl(rTop, rBot, h, radial = 12, open = false, heightSeg = 1) {
  return new THREE.CylinderGeometry(rTop, rBot, h, radial, heightSeg, open);
}

/** Transform a geometry in place. Angles in radians. */
export function xf(geo, px = 0, py = 0, pz = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx) {
  _e.set(rx, ry, rz);
  _q.setFromEuler(_e);
  _v.set(px, py, pz);
  _s.set(sx, sy, sz);
  _m.compose(_v, _q, _s);
  geo.applyMatrix4(_m);
  return geo;
}

/** Ensure position/normal/uv all exist so merges never fail. */
export function ensureAttrs(geo) {
  if (!geo.attributes.normal) geo.computeVertexNormals();
  if (!geo.attributes.uv) {
    const n = geo.attributes.position.count;
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  }
  return geo;
}

/**
 * Merge a list of geometries into one buffer. Disposes the inputs.
 *
 * three's primitives are inconsistent about indexing — BoxGeometry is indexed,
 * ExtrudeGeometry and the polyhedra are not — and mergeGeometries refuses a mixed
 * list. Everything is normalised to non-indexed and stripped to
 * position/normal/uv so any combination of parts can be welded together.
 */
export function mergeAll(list) {
  const src = list.filter((g) => g && g.attributes?.position?.count);
  if (src.length === 0) return new THREE.BufferGeometry();
  const clean = [];
  for (const g of src) {
    ensureAttrs(g);
    let out = g.index ? g.toNonIndexed() : g;
    if (out !== g) g.dispose();
    // drop anything mergeGeometries would trip over (tangents, colours, groups)
    for (const name of Object.keys(out.attributes)) {
      if (name !== 'position' && name !== 'normal' && name !== 'uv') out.deleteAttribute(name);
    }
    out.clearGroups();
    if (!out.attributes.uv) {
      const n = out.attributes.position.count;
      out.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
    }
    clean.push(out);
  }
  if (clean.length === 1) {
    clean[0].computeBoundingBox();
    clean[0].computeBoundingSphere();
    return clean[0];
  }
  const merged = mergeGeometries(clean, false);
  if (!merged) {
    console.warn('[props] geometry merge failed; returning first part only');
    return clean[0];
  }
  for (const g of clean) g.dispose();
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  return merged;
}

function dominantAxis(nx, ny, nz) {
  const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
  if (ay >= ax && ay >= az) return ny >= 0 ? 1 : -1;
  if (ax >= az) return nx >= 0 ? 0 : -3;
  return nz >= 0 ? 2 : -2;
}

/**
 * Project a point onto a face's texture plane with the correct handedness.
 * Getting the sign wrong is why box-projected lettering comes out mirrored on
 * the faces pointing away from +X/+Z — the classic triplanar tell.
 */
function projectUV(axis, x, y, z) {
  switch (axis) {
    case 0: return [-z, y];     // +X : screen-right is -Z
    case -3: return [z, y];     // -X
    case 2: return [x, y];      // +Z
    case -2: return [-x, y];    // -Z
    case 1: return [x, -z];     // +Y : looking down, screen-up is -Z
    default: return [x, z];     // -Y
  }
}

/**
 * Box/triplanar UV projection at a real-world texel scale — `scale` is UV units
 * per metre, so a 0.5 m/tile texture wants scale = 2.
 */
export function boxUV(geo, scale = 1, offU = 0, offV = 0) {
  ensureAttrs(geo);
  const p = geo.attributes.position, n = geo.attributes.normal;
  const uv = geo.attributes.uv;
  for (let i = 0; i < p.count; i++) {
    const a = dominantAxis(n.getX(i), n.getY(i), n.getZ(i));
    const [u, v] = projectUV(a, p.getX(i), p.getY(i), p.getZ(i));
    uv.setXY(i, u * scale + offU, v * scale + offV);
  }
  uv.needsUpdate = true;
  return geo;
}

/** Per-face UVs normalised to the geometry bounds, i.e. every face gets 0..1. */
export function boxUV01(geo) {
  ensureAttrs(geo);
  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  const ex = Math.max(1e-4, bb.max.x - bb.min.x);
  const ey = Math.max(1e-4, bb.max.y - bb.min.y);
  const ez = Math.max(1e-4, bb.max.z - bb.min.z);
  const p = geo.attributes.position, n = geo.attributes.normal, uv = geo.attributes.uv;
  for (let i = 0; i < p.count; i++) {
    const x = (p.getX(i) - bb.min.x) / ex;
    const y = (p.getY(i) - bb.min.y) / ey;
    const z = (p.getZ(i) - bb.min.z) / ez;
    const a = dominantAxis(n.getX(i), n.getY(i), n.getZ(i));
    let [u, v] = projectUV(a, x, y, z);
    if (u < 0) u += 1;
    if (v < 0) v += 1;
    uv.setXY(i, u, v);
  }
  uv.needsUpdate = true;
  return geo;
}

/** Squeeze existing 0..1 UVs into one cell of a cols×rows atlas. */
export function atlasRemap(geo, col, row, cols = 4, rows = 4, inset = 0.004) {
  const uv = geo.attributes.uv;
  const cw = 1 / cols, ch = 1 / rows;
  for (let i = 0; i < uv.count; i++) {
    const u = Math.min(1, Math.max(0, uv.getX(i)));
    const v = Math.min(1, Math.max(0, uv.getY(i)));
    uv.setXY(i, (col + inset + u * (1 - inset * 2)) * cw, (row + inset + v * (1 - inset * 2)) * ch);
  }
  uv.needsUpdate = true;
  return geo;
}

/**
 * boxUV01 + per-axis atlas cell assignment. `map` is { x:[c,r], y:[c,r], z:[c,r] }
 * so a crate can carry a stencil on its sides and bare planking on its lid.
 */
export function atlasUVByAxis(geo, map, cols = 4, rows = 4, inset = 0.004) {
  boxUV01(geo);
  const p = geo.attributes.position, n = geo.attributes.normal, uv = geo.attributes.uv;
  const cw = 1 / cols, ch = 1 / rows;
  for (let i = 0; i < p.count; i++) {
    const a = dominantAxis(n.getX(i), n.getY(i), n.getZ(i));
    const cell = (a === 1 || a === -1) ? (map.y || map.z)
      : (a === 0 || a === -3) ? (map.x || map.z) : map.z;
    const u = Math.min(1, Math.max(0, uv.getX(i)));
    const v = Math.min(1, Math.max(0, uv.getY(i)));
    uv.setXY(i, (cell[0] + inset + u * (1 - inset * 2)) * cw, (cell[1] + inset + v * (1 - inset * 2)) * ch);
  }
  uv.needsUpdate = true;
  return geo;
}

/** Cylindrical UVs: u wraps around Y, v runs up. For drums, pipes, tanks. */
export function cylUV(geo, uRepeat = 1, vScale = 1) {
  ensureAttrs(geo);
  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  const ey = Math.max(1e-4, bb.max.y - bb.min.y);
  const p = geo.attributes.position, uv = geo.attributes.uv;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    // -atan2 so the wrap runs the same way the eye reads it from outside;
    // the positive direction mirrors every label on the barrel.
    const ang = -Math.atan2(z, x) / (Math.PI * 2) + 0.5;
    uv.setXY(i, ang * uRepeat, ((y - bb.min.y) / ey) * vScale);
  }
  uv.needsUpdate = true;
  return geo;
}

function noise3(x, y, z, seed) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = smoothstep(0, 1, x - xi), yf = smoothstep(0, 1, y - yi), zf = smoothstep(0, 1, z - zi);
  let acc = 0;
  for (let dz = 0; dz < 2; dz++) {
    for (let dy = 0; dy < 2; dy++) {
      for (let dx = 0; dx < 2; dx++) {
        const w = (dx ? xf : 1 - xf) * (dy ? yf : 1 - yf) * (dz ? zf : 1 - zf);
        acc += hash3(xi + dx, yi + dy, zi + dz, seed) * w;
      }
    }
  }
  return acc * 2 - 1;
}

/**
 * Warp vertices with 3D noise WITHOUT recomputing normals — a box stays
 * flat-shaded and crisp but is no longer machine-perfect. This is the single
 * cheapest trick for killing the "untextured primitive" read.
 */
export function warp(geo, amp = 0.01, freq = 3, seed = 1) {
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    p.setXYZ(i,
      x + noise3(x * freq, y * freq, z * freq, seed) * amp,
      y + noise3(x * freq + 11, y * freq + 7, z * freq + 3, seed + 91) * amp,
      z + noise3(x * freq - 5, y * freq + 13, z * freq - 9, seed + 173) * amp);
  }
  p.needsUpdate = true;
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

/** Push a localised dent into a surface, along the surface normal. Smooth shading. */
export function dent(geo, cx, cy, cz, radius, depth, smoothNormals = true) {
  const p = geo.attributes.position;
  const r2 = radius * radius;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const dx = x - cx, dy = y - cy, dz = z - cz;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 > r2) continue;
    const f = 1 - Math.sqrt(d2) / radius;
    const k = f * f * (3 - 2 * f) * depth;
    const len = Math.hypot(x, z) || 1;
    p.setXYZ(i, x - (x / len) * k, y, z - (z / len) * k);
  }
  p.needsUpdate = true;
  if (smoothNormals) geo.computeVertexNormals();
  return geo;
}

/** Sag a flat panel into a catenary along X — chain-link fence, tarpaulin, banner. */
export function sagPanel(geo, sag = 0.12, axis = 'x') {
  const p = geo.attributes.position;
  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  const min = axis === 'x' ? bb.min.x : bb.min.z;
  const max = axis === 'x' ? bb.max.x : bb.max.z;
  const ex = Math.max(1e-4, max - min);
  for (let i = 0; i < p.count; i++) {
    const a = axis === 'x' ? p.getX(i) : p.getZ(i);
    const t = ((a - min) / ex) * 2 - 1;         // -1..1
    p.setY(i, p.getY(i) - (1 - t * t) * sag);
  }
  p.needsUpdate = true;
  geo.computeBoundingBox();
  return geo;
}

/** Tube swept along a polyline. Used for cables, conduit, hoses, pipe runs. */
export function tubeAlong(points, radius = 0.03, radial = 6, segments = null, closed = false) {
  const curve = new THREE.CatmullRomCurve3(points, closed, 'catmullrom', 0.4);
  const segs = segments ?? Math.max(6, Math.min(96, Math.round(curve.getLength() * 2.2)));
  return new THREE.TubeGeometry(curve, segs, radius, radial, closed);
}

/**
 * Catenary between two points. `slackFactor` is extra length as a fraction of
 * the span, which is what makes hanging cable read as cable and not as wire.
 */
export function catenary(a, b, slackFactor = 0.14, steps = 10, out = []) {
  out.length = 0;
  const span = a.distanceTo(b);
  const sag = span * slackFactor;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const p = new THREE.Vector3().lerpVectors(a, b, t);
    p.y -= Math.sin(Math.PI * t) * sag;
    out.push(p);
  }
  return out;
}

/** Lowest Y of a geometry — used to seat props exactly on their contact plane. */
export function baseY(geo) {
  geo.computeBoundingBox();
  return geo.boundingBox.min.y;
}

/** Shift a geometry so its lowest point sits at y = 0. */
export function seat(geo) {
  const y = baseY(geo);
  if (Math.abs(y) > 1e-6) xf(geo, 0, -y, 0);
  return geo;
}

/**
 * Seat a *set* of geometries that share one object space (e.g. a vehicle's body,
 * chrome, glass and rubber) by the same amount, so their relative alignment
 * survives. Seating them individually is a classic way to make wheels float.
 */
export function seatGroup(map) {
  let min = Infinity;
  for (const g of Object.values(map)) {
    if (!g || !g.attributes?.position?.count) continue;
    g.computeBoundingBox();
    if (g.boundingBox.min.y < min) min = g.boundingBox.min.y;
  }
  if (!Number.isFinite(min) || Math.abs(min) < 1e-6) return map;
  for (const g of Object.values(map)) {
    if (!g || !g.attributes?.position?.count) continue;
    xf(g, 0, -min, 0);
  }
  return map;
}

/** Half-extent radius in XZ — the footprint used for overlap rejection. */
export function footprint(geo) {
  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  return Math.max(Math.hypot(bb.max.x, bb.max.z), Math.hypot(bb.min.x, bb.min.z));
}

export function triCount(geo) {
  return (geo.index ? geo.index.count : geo.attributes.position.count) / 3;
}
