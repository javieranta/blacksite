import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * OWNER: level agent.
 * Low-level procedural geometry kit. Everything the level is built from lives
 * here: chamfered boxes, extruded profiles, corrugated cladding, bar grating,
 * tubes, lathes — plus the Builder that bakes thousands of these into a handful
 * of merged, BVH-ready draw calls.
 *
 * Design rules enforced by this file:
 *   - NOTHING is an un-chamfered box. `chamferBox` is the workhorse and every
 *     silhouette edge gets a 2-4cm chamfer so it catches a specular highlight.
 *   - UVs are world-projected at bake time, so texel density is identical on
 *     every surface in the level regardless of module size or orientation.
 *   - Geometry is merged per (zone, material, shadow flags) so the whole map
 *     costs tens of draw calls, not thousands.
 */

const _n = new THREE.Vector3();
const _e1 = new THREE.Vector3();
const _e2 = new THREE.Vector3();

function faceNormal(a, b, c) {
  _e1.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  _e2.set(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
  return _n.copy(_e1).cross(_e2).normalize();
}

/** Push a triangle, auto-correcting winding so it faces `n`. */
export function pushTri(pos, nor, a, b, c, n = null) {
  faceNormal(a, b, c);
  let nx = _n.x, ny = _n.y, nz = _n.z;
  if (n) {
    const d = _n.x * n[0] + _n.y * n[1] + _n.z * n[2];
    nx = n[0]; ny = n[1]; nz = n[2];
    if (d < 0) { const t = b; b = c; c = t; }
  }
  pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
  nor.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
}

export function pushQuad(pos, nor, a, b, c, d, n = null) {
  pushTri(pos, nor, a, b, c, n);
  pushTri(pos, nor, a, c, d, n);
}

export function geoFrom(pos, nor) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  return g;
}

/* ------------------------------------------------------------------ noise --- */

function hash3(x, y, z) {
  let h = x * 374761393 + y * 668265263 + z * 2147483647;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
const smooth = (t) => t * t * (3 - 2 * t);

/** Deterministic 3D value noise in [0,1]. */
export function vnoise(x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = smooth(x - xi), yf = smooth(y - yi), zf = smooth(z - zi);
  let acc = 0;
  for (let i = 0; i < 8; i++) {
    const dx = i & 1, dy = (i >> 1) & 1, dz = (i >> 2) & 1;
    const w = (dx ? xf : 1 - xf) * (dy ? yf : 1 - yf) * (dz ? zf : 1 - zf);
    acc += w * hash3(xi + dx, yi + dy, zi + dz);
  }
  return acc;
}

export function fbm(x, y, z, octaves = 4, lac = 2.03, gain = 0.5) {
  let a = 0.5, f = 1, s = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    s += a * vnoise(x * f, y * f, z * f);
    norm += a; a *= gain; f *= lac;
  }
  return s / norm;
}

/** Small seeded PRNG so the level is byte-identical every load. */
export function rng(seed = 1337) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Displace vertices along their normals — surface wear on flat faces. */
export function jitter(geo, amp = 0.02, freq = 0.7) {
  const p = geo.attributes.position, n = geo.attributes.normal;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const d = (fbm(x * freq, y * freq, z * freq, 3) - 0.5) * 2 * amp;
    p.setXYZ(i, x + n.getX(i) * d, y + n.getY(i) * d, z + n.getZ(i) * d);
  }
  p.needsUpdate = true;
  return geo;
}

/* --------------------------------------------------------------- primitives - */

/**
 * A box with all twelve edges chamfered. 6 face quads (optionally subdivided
 * `seg`x`seg`), 12 edge quads at 45 degrees, 8 corner triangles.
 */
export function chamferBox(w, h, d, bevel = 0.03, seg = 1) {
  const ext = [w / 2, h / 2, d / 2];
  const b = Math.min(bevel, Math.min(ext[0], ext[1], ext[2]) * 0.4);
  const pos = [], nor = [];

  for (let axis = 0; axis < 3; axis++) {
    const u = (axis + 1) % 3, v = (axis + 2) % 3;
    const eu = ext[u] - b, ev = ext[v] - b;
    for (const s of [1, -1]) {
      const n = [0, 0, 0]; n[axis] = s;
      const mk = (uu, vv) => { const p = [0, 0, 0]; p[axis] = s * ext[axis]; p[u] = uu; p[v] = vv; return p; };
      for (let i = 0; i < seg; i++) {
        for (let j = 0; j < seg; j++) {
          const u0 = -eu + 2 * eu * i / seg, u1 = -eu + 2 * eu * (i + 1) / seg;
          const v0 = -ev + 2 * ev * j / seg, v1 = -ev + 2 * ev * (j + 1) / seg;
          pushQuad(pos, nor, mk(u0, v0), mk(u1, v0), mk(u1, v1), mk(u0, v1), n);
        }
      }
    }
  }

  // twelve chamfer strips
  for (let a1 = 0; a1 < 3; a1++) {
    for (let a2 = a1 + 1; a2 < 3; a2++) {
      const a3 = 3 - a1 - a2;
      for (const s1 of [1, -1]) {
        for (const s2 of [1, -1]) {
          const n = [0, 0, 0];
          n[a1] = s1 * Math.SQRT1_2; n[a2] = s2 * Math.SQRT1_2;
          const mk = (o1, o2, o3) => {
            const p = [0, 0, 0];
            p[a1] = s1 * (ext[a1] - o1); p[a2] = s2 * (ext[a2] - o2); p[a3] = o3;
            return p;
          };
          const t = ext[a3] - b;
          pushQuad(pos, nor, mk(0, b, -t), mk(b, 0, -t), mk(b, 0, t), mk(0, b, t), n);
        }
      }
    }
  }

  // eight corner triangles
  for (const sx of [1, -1]) for (const sy of [1, -1]) for (const sz of [1, -1]) {
    const n = [sx / Math.sqrt(3), sy / Math.sqrt(3), sz / Math.sqrt(3)];
    pushTri(pos, nor,
      [sx * ext[0], sy * (ext[1] - b), sz * (ext[2] - b)],
      [sx * (ext[0] - b), sy * ext[1], sz * (ext[2] - b)],
      [sx * (ext[0] - b), sy * (ext[1] - b), sz * ext[2]], n);
  }

  return geoFrom(pos, nor);
}

/** Extrude a closed 2D profile (array of [x,y]) along +Z with a bevel. */
export function profileExtrude(points, depth, o = {}) {
  const shape = new THREE.Shape();
  shape.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i++) shape.lineTo(points[i][0], points[i][1]);
  shape.closePath();
  return shapeExtrude(shape, depth, o);
}

export function shapeExtrude(shape, depth, o = {}) {
  const bevel = o.bevel ?? 0.025;
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: Math.max(0.01, depth - bevel * 2),
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelOffset: 0,
    bevelSegments: o.bevelSegments ?? 1,
    curveSegments: o.curveSegments ?? 4,
    steps: o.steps ?? 1,
  });
  geo.translate(0, 0, -depth / 2 + bevel);
  return geo;
}

/**
 * A wall panel of `w` x `h` and thickness `t` with rectangular openings cut
 * through it. The extrude bevel produces a real chamfered reveal around every
 * jamb, head and sill — this is why openings read as architecture and not as
 * a hole in a plane.
 * openings: [{ x, y, w, h }] in panel space (origin bottom-left).
 */
export function wallPanel(w, h, t, openings = [], o = {}) {
  const shape = new THREE.Shape();
  shape.moveTo(0, 0); shape.lineTo(w, 0); shape.lineTo(w, h); shape.lineTo(0, h);
  shape.closePath();
  for (const op of openings) {
    const p = new THREE.Path();
    p.moveTo(op.x, op.y);
    p.lineTo(op.x, op.y + op.h);
    p.lineTo(op.x + op.w, op.y + op.h);
    p.lineTo(op.x + op.w, op.y);
    p.closePath();
    shape.holes.push(p);
  }
  const geo = shapeExtrude(shape, t, { bevel: o.bevel ?? 0.028, bevelSegments: o.bevelSegments ?? 1 });
  geo.translate(-w / 2, -h / 2, 0);
  return geo;
}

/**
 * Corrugated steel cladding — real sinusoidal geometry, not a normal map. It is
 * the single best triangle-for-triangle investment in the kit: profiled sheet
 * catches a moving specular band and instantly reads as industrial.
 */
export function corrugated(w, h, o = {}) {
  const pitch = o.pitch ?? 0.078;
  const amp = o.amp ?? 0.011;
  const cols = Math.max(6, Math.round(w / pitch) * 3);
  const rows = Math.max(1, Math.round(h / (o.rowLen ?? 0.6)));
  const t = o.thickness ?? 0.022;
  const pos = [], nor = [];
  const zAt = (i) => amp * Math.sin((i / cols) * (w / pitch) * Math.PI * 2);
  const dAt = (i) => {
    const k = (w / pitch) * Math.PI * 2 / cols;
    return amp * Math.cos((i / cols) * (w / pitch) * Math.PI * 2) * k;
  };
  for (let i = 0; i < cols; i++) {
    const x0 = -w / 2 + w * i / cols, x1 = -w / 2 + w * (i + 1) / cols;
    const z0 = zAt(i), z1 = zAt(i + 1);
    const n0 = _tmpNorm(dAt(i)), n1 = _tmpNorm(dAt(i + 1));
    for (let j = 0; j < rows; j++) {
      const y0 = -h / 2 + h * j / rows, y1 = -h / 2 + h * (j + 1) / rows;
      pushTri(pos, nor, [x0, y0, z0], [x1, y0, z1], [x1, y1, z1], n1);
      pushTri(pos, nor, [x0, y0, z0], [x1, y1, z1], [x0, y1, z0], n0);
      if (o.backFace !== false) {
        pushTri(pos, nor, [x0, y0, z0 - t], [x1, y1, z1 - t], [x1, y0, z1 - t], [-n1[0], 0, -n1[2]]);
        pushTri(pos, nor, [x0, y0, z0 - t], [x0, y1, z0 - t], [x1, y1, z1 - t], [-n0[0], 0, -n0[2]]);
      }
    }
  }
  // capped edges so the sheet has thickness in silhouette
  for (const y of [-h / 2, h / 2]) {
    const s = y > 0 ? 1 : -1;
    for (let i = 0; i < cols; i++) {
      const x0 = -w / 2 + w * i / cols, x1 = -w / 2 + w * (i + 1) / cols;
      pushQuad(pos, nor, [x0, y, zAt(i)], [x1, y, zAt(i + 1)],
        [x1, y, zAt(i + 1) - t], [x0, y, zAt(i) - t], [0, s, 0]);
    }
  }
  return geoFrom(pos, nor);
}
function _tmpNorm(dz) {
  const l = Math.hypot(1, dz);
  return [-dz / l, 0, 1 / l];
}

/** Bar grating for catwalks and floor pits — real slats, real gaps. */
export function gratingPanel(w, d, o = {}) {
  const pitch = o.pitch ?? 0.1;
  const bw = o.barW ?? 0.028;
  const bh = o.barH ?? 0.045;
  const n = Math.max(2, Math.floor(w / pitch));
  const parts = [];
  for (let i = 0; i < n; i++) {
    const x = -w / 2 + (i + 0.5) * (w / n);
    const g = chamferBox(bw, bh, d, 0.006);
    g.translate(x, 0, 0);
    parts.push(g);
  }
  // cross bars keep it from reading as venetian blinds at grazing angles
  const cross = Math.max(2, Math.round(d / 0.55));
  for (let j = 0; j < cross; j++) {
    const z = -d / 2 + (j + 0.5) * (d / cross);
    const g = chamferBox(w, 0.016, 0.016, 0.004);
    g.translate(0, bh * 0.28, z);
    parts.push(g);
  }
  const frame = [
    [w + 0.06, bh + 0.02, 0.03, 0, (d / 2)], [w + 0.06, bh + 0.02, 0.03, 0, -(d / 2)],
  ];
  for (const [fw, fh, fd, fx, fz] of frame) {
    const g = chamferBox(fw, fh, fd, 0.008); g.translate(fx, 0, fz); parts.push(g);
  }
  for (const sx of [-1, 1]) {
    const g = chamferBox(0.03, bh + 0.02, d, 0.008);
    g.translate(sx * (w / 2 + 0.015), 0, 0); parts.push(g);
  }
  return mergeGeometries(parts);
}

/** Round tube along a polyline — pipes, conduit, railings, truss members. */
export function tube(points, radius, radialSeg = 10, o = {}) {
  const pts = points.map((p) => (p.isVector3 ? p : new THREE.Vector3(p[0], p[1], p[2])));
  const curve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', o.tension ?? 0.02);
  const len = curve.getLength();
  const seg = Math.max(1, Math.min(o.maxSeg ?? 160, Math.round(len / (o.segLen ?? 1.4))));
  const g = new THREE.TubeGeometry(curve, seg, radius, radialSeg, false);
  if (o.caps !== false) {
    const parts = [g];
    for (const i of [0, 1]) {
      const c = new THREE.CircleGeometry(radius, radialSeg);
      const p = curve.getPointAt(i), t = curve.getTangentAt(i);
      const dir = t.clone().multiplyScalar(i ? 1 : -1);
      const up = Math.abs(dir.y) > 0.94 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
      const m = new THREE.Matrix4().lookAt(new THREE.Vector3(), dir, up);
      c.applyMatrix4(m); c.translate(p.x, p.y, p.z);
      parts.push(c);
    }
    return mergeGeometries(parts.map((x) => x.index ? x.toNonIndexed() : x));
  }
  return g;
}

/**
 * Concertina razor coil running along +X. A real helix with a triangular
 * cross-section, generated directly rather than through TubeGeometry, because a
 * CatmullRom resample of a tight helix either loses the coil or costs ten times
 * the triangles. 6 triangles per station, so a 7m bay of wire is ~900 tris and
 * it reads as wire in silhouette at forty metres — which is the whole job.
 */
export function razorCoil(len, o = {}) {
  const R = o.radius ?? 0.3;
  const turnLen = o.turnLen ?? 0.55;
  const perTurn = o.perTurn ?? 7;
  const wire = o.wire ?? 0.016;
  const turns = Math.max(1, Math.round(len / turnLen));
  const n = Math.max(3, turns * perTurn);
  const pos = [], nor = [];
  const TAU = Math.PI * 2;
  // cross-section offsets in the (N,B) frame
  const sec = [0, TAU / 3, (2 * TAU) / 3].map((a) => [Math.cos(a) * wire, Math.sin(a) * wire]);
  const ring = new Array(n + 1);
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const a = t * turns * TAU;
    const cx = -len / 2 + len * t, sa = Math.sin(a), ca = Math.cos(a);
    // tangent of the helix
    const k = R * turns * TAU;
    let tx = len, ty = k * ca, tz = -k * sa;
    const tl = Math.hypot(tx, ty, tz) || 1;
    tx /= tl; ty /= tl; tz /= tl;
    // radial normal, orthogonalised against the tangent
    let nx = 0, ny = sa, nz = ca;
    const dp = nx * tx + ny * ty + nz * tz;
    nx -= tx * dp; ny -= ty * dp; nz -= tz * dp;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl; ny /= nl; nz /= nl;
    // binormal
    const bx = ty * nz - tz * ny, by = tz * nx - tx * nz, bz = tx * ny - ty * nx;
    const c = [cx, sa * R, ca * R];
    ring[i] = sec.map(([u, v]) => [
      c[0] + nx * u + bx * v, c[1] + ny * u + by * v, c[2] + nz * u + bz * v,
    ]);
  }
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 3; k++) {
      const k2 = (k + 1) % 3;
      const a = ring[i][k], bb = ring[i][k2], cc = ring[i + 1][k2], d = ring[i + 1][k];
      pushQuad(pos, nor, a, bb, cc, d);
    }
  }
  return geoFrom(pos, nor);
}

export function cyl(rTop, rBot, h, seg = 16, o = {}) {
  const g = new THREE.CylinderGeometry(rTop, rBot, h, seg, o.heightSeg ?? 1, o.open ?? false);
  return g;
}

export function lathe(profile, seg = 24) {
  const pts = profile.map((p) => new THREE.Vector2(p[0], p[1]));
  return new THREE.LatheGeometry(pts, seg);
}

/* ------------------------------------------------------------------- UVs ---- */

/**
 * World-space triplanar UV projection. Applied after the world matrix, so two
 * adjacent modules share a continuous texel grid and nothing ever looks
 * stretched or seamed. `tile` = metres per texture repeat.
 */
export function projectUV(geo, tile = 2.0) {
  const p = geo.attributes.position, n = geo.attributes.normal;
  const uv = new Float32Array(p.count * 2);
  const inv = 1 / tile;
  for (let i = 0; i < p.count; i++) {
    const ax = Math.abs(n.getX(i)), ay = Math.abs(n.getY(i)), az = Math.abs(n.getZ(i));
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    let u, v;
    if (ay >= ax && ay >= az) { u = x; v = z; }
    else if (ax >= az) { u = z; v = y; }
    else { u = x; v = y; }
    uv[i * 2] = u * inv; uv[i * 2 + 1] = v * inv;
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setAttribute('uv1', new THREE.BufferAttribute(uv.slice(), 2));
  return geo;
}

/**
 * Cylindrical UV projection about a vertical axis through (cx, cz): angle -> u,
 * world height -> v.
 *
 * `projectUV` picks a projection axis per vertex from the dominant normal
 * component, which is correct for architecture but wrong for a surface of
 * revolution: the choice flips every 45 degrees, so the texture MIRRORS eight
 * times around a cylinder and compresses toward each flip. Vertical features —
 * form-panel seams, staining, flutes — cannot survive that. Here the angle is
 * unwrapped per triangle across the +/-pi seam, so the wrap is continuous the
 * whole way round and the repeat count is an integer (no seam at the join).
 *
 * `radius` is the reference radius used to turn an angle into an arc length, so
 * texel density matches the rest of the level at that radius. Requires a
 * non-indexed geometry, which is what `Builder.geo` always hands over.
 */
export function projectUVCylindrical(geo, o = {}) {
  const cx = o.cx ?? 0, cz = o.cz ?? 0;
  const tile = o.tile ?? 2.0;
  const rRef = Math.max(0.25, o.radius ?? 1);
  const turns = Math.max(1, Math.round((2 * Math.PI * rRef) / tile));
  const p = geo.attributes.position;
  const uv = new Float32Array(p.count * 2);
  const TAU = Math.PI * 2;
  const a = [0, 0, 0];
  const inv = 1 / tile;
  for (let i = 0; i + 2 < p.count; i += 3) {
    for (let k = 0; k < 3; k++) {
      a[k] = Math.atan2(p.getZ(i + k) - cz, p.getX(i + k) - cx) / TAU;
    }
    for (let k = 1; k < 3; k++) {
      while (a[k] - a[0] > 0.5) a[k] -= 1;
      while (a[k] - a[0] < -0.5) a[k] += 1;
    }
    for (let k = 0; k < 3; k++) {
      uv[(i + k) * 2] = a[k] * turns;
      uv[(i + k) * 2 + 1] = p.getY(i + k) * inv;
    }
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setAttribute('uv1', new THREE.BufferAttribute(uv.slice(), 2));
  return geo;
}

/* ---------------------------------------------------------------- Builder --- */

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();
const _t = new THREE.Vector3();

/**
 * Accumulates geometry into (zone, material, flags) buckets, then bakes each
 * bucket into one merged mesh with a BVH. This is what keeps a 1M-triangle
 * level inside a few dozen draw calls.
 */
/** True when every position component is finite. */
function isFinitePositions(g) {
  const a = g.attributes.position.array;
  for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) return false;
  return true;
}

export class Builder {
  constructor() {
    this.buckets = new Map();
    this.rejected = new Map();
    this.triangles = 0;
    /**
     * Level-local materials. The forge owns the shared library; the level
     * occasionally needs a variant that only it uses (road paint, standing
     * water) and which would be dead weight in the forge's bake. Register it
     * here and `bake` prefers it over `forge.get(name)`.
     */
    this.materials = new Map();
  }

  /** Register a level-local material under a name usable as a bucket key. */
  material(name, mat) {
    this.materials.set(name, mat);
    return this;
  }

  /**
   * Place a raw geometry with an explicit transform.
   *
   * Everything is screened for non-finite positions on the way in. One NaN
   * vertex anywhere in a bucket makes the merged bounding sphere NaN, which
   * three reports once per bucket and — far worse — makes `computeBoundsTree`
   * pathological: the median split cannot separate NaN from anything, so it
   * recurses to maxDepth on every node and the level bake never finishes. A
   * bad part is dropped and named, rather than being allowed to take the
   * whole map down with it.
   */
  geo(mat, geometry, matrix, o = {}) {
    const g = geometry.index ? geometry.toNonIndexed() : geometry.clone();
    if (matrix) g.applyMatrix4(matrix);
    if (!g.attributes.normal) g.computeVertexNormals();
    // `uvCyl: [cx, cz, refRadius]` swaps the triplanar projection for a
    // cylindrical one. Shells of revolution need it; see projectUVCylindrical.
    if (o.uvCyl) {
      projectUVCylindrical(g, {
        cx: o.uvCyl[0], cz: o.uvCyl[1], radius: o.uvCyl[2], tile: o.tile ?? 2.0,
      });
    } else {
      projectUV(g, o.tile ?? 2.0);
    }
    if (!isFinitePositions(g)) {
      const key = `${o.zone ?? 'core'}|${mat}`;
      this.rejected.set(key, (this.rejected.get(key) ?? 0) + 1);
      g.dispose();
      return this;
    }
    const cast = o.cast !== false, recv = o.recv !== false, solid = o.solid !== false;
    const key = `${o.zone ?? 'core'}|${mat}|${cast ? 1 : 0}${recv ? 1 : 0}${solid ? 1 : 0}`;
    let b = this.buckets.get(key);
    if (!b) {
      b = { mat, zone: o.zone ?? 'core', cast, recv, solid, parts: [] };
      this.buckets.set(key, b);
    }
    b.parts.push(g);
    const tris = g.attributes.position.count / 3;
    this.triangles += tris;
    b.tris = (b.tris ?? 0) + tris;
    return this;
  }

  /** Triangles per zone, descending — the only way to budget a level this size. */
  zoneStats() {
    const per = new Map();
    for (const b of this.buckets.values()) per.set(b.zone, (per.get(b.zone) ?? 0) + (b.tris ?? 0));
    return [...per].sort((a, c) => c[1] - a[1]);
  }

  /** Chamfered box at a position, with optional euler rotation and face subdivision. */
  box(mat, x, y, z, w, h, d, o = {}) {
    const g = chamferBox(w, h, d, o.bevel ?? 0.03, o.seg ?? 1);
    if (o.jitter) jitter(g, o.jitter, o.jitterFreq ?? 0.6);
    return this.geo(mat, g, this.xform(x, y, z, o), o);
  }

  xform(x, y, z, o = {}) {
    _e.set(o.rx ?? 0, o.ry ?? 0, o.rz ?? 0, 'YXZ');
    _q.setFromEuler(_e);
    _s.set(o.sx ?? 1, o.sy ?? 1, o.sz ?? 1);
    _t.set(x, y, z);
    return _m.compose(_t, _q, _s).clone();
  }

  /** Bake every bucket. Returns { solid: Mesh[], loose: Mesh[] }. */
  bake(forge, onMesh) {
    const out = { solid: [], loose: [] };
    for (const [key, b] of this.buckets) {
      if (!b.parts.length) continue;
      let merged;
      try {
        merged = b.parts.length === 1 ? b.parts[0] : mergeGeometries(b.parts, false);
      } catch (err) {
        console.warn('[level] merge failed for', key, err);
        continue;
      }
      if (!merged) continue;
      merged.computeBoundingSphere();
      merged.computeBoundingBox();
      const mesh = new THREE.Mesh(merged, this.materials.get(b.mat) ?? forge.get(b.mat));
      mesh.name = key;
      mesh.castShadow = b.cast;
      mesh.receiveShadow = b.recv;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      onMesh?.(mesh, b);
      (b.solid ? out.solid : out.loose).push(mesh);
      b.parts.length = 0;
    }
    return out;
  }
}
