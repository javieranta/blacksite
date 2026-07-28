import * as THREE from 'three';

/**
 * OWNER: viewmodel agent.
 *
 * Geometry kit for the first-person weapon. Everything here exists to solve one
 * problem: an unbevelled primitive reads as a greybox no matter how good the
 * texture is, because a hard 90-degree edge cannot catch a specular highlight.
 * Every shape below is chamfered, and every chamfer strip is tagged with an
 * `aEdge` vertex attribute so the material can put edge wear exactly where a
 * real machined part rubs — a curvature proxy, baked at build time for free.
 *
 * Conventions
 *   - Metres. Bore along -Z (the axis the camera looks down).
 *   - UVs are baked in *tile* units: 1.0 = TEX_M metres of surface, so texture
 *     density is uniform across the whole weapon regardless of part size.
 *   - Normals come from triangle winding for faceted shapes (which is what makes
 *     a chamfer read) and analytically for swept round shapes.
 *   - `aCav` marks geometry that sits inside a recess so the material can darken
 *     it — a cheap stand-in for baked AO in cavities the screen-space AO pass
 *     never sees (the viewmodel is composited after AO).
 */

/** Metres of surface covered by one tile of a weapon texture. */
export const TEX_M = 0.030;

/* ------------------------------------------------------------- vec helpers */

function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function norm(a) {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}

/** Box projection onto the dominant axis of the normal, in tile units. */
function uvBox(p, n) {
  const ax = Math.abs(n[0]), ay = Math.abs(n[1]), az = Math.abs(n[2]);
  if (ax >= ay && ax >= az) return [p[2] / TEX_M, p[1] / TEX_M];
  if (ay >= az) return [p[0] / TEX_M, p[2] / TEX_M];
  return [p[0] / TEX_M, p[1] / TEX_M];
}

/* ----------------------------------------------------------------- Mesher */

/**
 * Accumulates triangles into per-material buckets, applying the current part
 * transform as it goes. Build-time only, so ordinary allocation is fine here.
 */
export class Mesher {
  constructor() {
    this.buckets = new Map();
    this._m = new THREE.Matrix4();
    this._nm = new THREE.Matrix3().identity();
    this._key = 'steel';
    this._v = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._e = new THREE.Euler(0, 0, 0, 'YXZ');
    this._s = new THREE.Vector3(1, 1, 1);
    this._t = new THREE.Vector3();
  }

  use(key) { this._key = key; return this; }

  /**
   * Set the transform applied to every subsequent emit. `o.mat4` takes a full
   * matrix, which is how Hands.js builds a nested skeleton (knuckle inside
   * finger inside palm inside grip) without flattening every joint by hand.
   */
  at(o = {}) {
    if (o.mat4) {
      this._m.copy(o.mat4);
      this._nm.getNormalMatrix(this._m);
      return this;
    }
    this._t.set(o.x ?? 0, o.y ?? 0, o.z ?? 0);
    this._e.set(o.rx ?? 0, o.ry ?? 0, o.rz ?? 0, 'YXZ');
    this._q.setFromEuler(this._e);
    this._m.compose(this._t, this._q, this._s);
    this._nm.getNormalMatrix(this._m);
    return this;
  }

  _bucket() {
    let b = this.buckets.get(this._key);
    if (!b) {
      b = { pos: [], nrm: [], uv: [], edge: [], cav: [] };
      this.buckets.set(this._key, b);
    }
    return b;
  }

  _vert(b, p, n, uv, e, cav) {
    this._v.set(p[0], p[1], p[2]).applyMatrix4(this._m);
    b.pos.push(this._v.x, this._v.y, this._v.z);
    this._v.set(n[0], n[1], n[2]).applyMatrix3(this._nm).normalize();
    b.nrm.push(this._v.x, this._v.y, this._v.z);
    b.uv.push(uv[0], uv[1]);
    b.edge.push(e);
    b.cav.push(cav);
  }

  /**
   * One triangle. `out` is the intended outward direction (local space); the
   * winding is corrected against it so callers never have to think about order.
   * `ns` supplies analytic normals; omit it for a faceted surface.
   */
  tri(ps, uvs, es, cav, out, ns) {
    let g = norm(cross(sub(ps[1], ps[0]), sub(ps[2], ps[0])));
    let i0 = 0, i1 = 1, i2 = 2;
    if (out && dot(g, out) < 0) { i1 = 2; i2 = 1; g = [-g[0], -g[1], -g[2]]; }
    const b = this._bucket();
    const idx = [i0, i1, i2];
    for (const i of idx) {
      this._vert(b, ps[i], ns ? ns[i] : g, uvs ? uvs[i] : uvBox(ps[i], g), es ? es[i] : 0, cav);
    }
  }

  /** Planar quad p0..p3. Split into two triangles sharing the winding fix. */
  quad(ps, uvs, es, cav, out, ns) {
    this.tri([ps[0], ps[1], ps[2]],
      uvs && [uvs[0], uvs[1], uvs[2]],
      es && [es[0], es[1], es[2]], cav, out, ns && [ns[0], ns[1], ns[2]]);
    this.tri([ps[0], ps[2], ps[3]],
      uvs && [uvs[0], uvs[2], uvs[3]],
      es && [es[0], es[2], es[3]], cav, out, ns && [ns[0], ns[2], ns[3]]);
  }

  /** @returns {Map<string, THREE.BufferGeometry>} */
  geometries() {
    const out = new Map();
    for (const [key, b] of this.buckets) {
      if (!b.pos.length) continue;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(b.nrm, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
      g.setAttribute('aEdge', new THREE.Float32BufferAttribute(b.edge, 1));
      g.setAttribute('aCav', new THREE.Float32BufferAttribute(b.cav, 1));
      g.computeBoundingSphere();
      out.set(key, g);
    }
    return out;
  }

  triangleCount() {
    let n = 0;
    for (const b of this.buckets.values()) n += b.pos.length / 9;
    return n;
  }
}

/* -------------------------------------------------------------------- box */

/**
 * Chamfered box, optionally tapered along Z (w1/h1 give the +Z end section).
 *
 * Each of the six faces is emitted as a 3x3 grid whose border ring carries a
 * partial `aEdge` value, so the wear band feathers off the bevel into the face
 * instead of stopping dead at it. 140 triangles; `simple` drops it to 44 for
 * parts that are small or mostly hidden.
 */
export function boxG(m, o) {
  const w = o.w, h = o.h, d = o.d;
  const w1 = o.w1 ?? w, h1 = o.h1 ?? h;
  const hx = w / 2, hy = h / 2, hz = d / 2;
  const c = Math.min(o.c ?? 0.0016, hx * 0.45, hy * 0.45, hz * 0.45);
  const H = [hx, hy, hz];
  const I = [hx - c, hy - c, hz - c];
  const cav = o.cav ?? 0;
  const ring = Math.max(0.0008, o.ring ?? 0.0026);
  const eF = o.faceEdge ?? 0.62;
  // The feathered wear ring costs 96 extra triangles a box and only pays for
  // itself on surfaces big enough to see the falloff across. Small hardware gets
  // the cheap version automatically — the chamfer strips still carry full wear.
  const simple = o.simple ?? (Math.max(w, h, d) < 0.0135);

  // Taper: x/y scale as a function of z (constant on the +/-Z faces).
  const kx1 = w1 / (w || 1), ky1 = h1 / (h || 1);
  const warp = (p) => {
    if (kx1 === 1 && ky1 === 1) return p;
    const t = (p[2] + hz) / (2 * hz || 1);
    return [p[0] * (1 + (kx1 - 1) * t), p[1] * (1 + (ky1 - 1) * t), p[2]];
  };

  m.at(o);

  // ---- six faces ---------------------------------------------------------
  for (let a = 0; a < 3; a++) {
    const b = (a + 1) % 3, cc = (a + 2) % 3;
    for (const sgn of [-1, 1]) {
      const uAx = sgn > 0 ? b : cc, vAx = sgn > 0 ? cc : b;
      const iu = I[uAx], iv = I[vAx];
      const outv = [0, 0, 0]; outv[a] = sgn;
      if (simple) {
        const P = (su, sv) => {
          const p = [0, 0, 0];
          p[a] = sgn * H[a]; p[uAx] = su * iu; p[vAx] = sv * iv;
          return warp(p);
        };
        const ps = [P(-1, -1), P(1, -1), P(1, 1), P(-1, 1)];
        m.quad(ps, ps.map((p) => uvBox(p, outv)), [eF, eF, eF, eF], cav, outv);
        continue;
      }
      const wu = Math.min(ring, iu * 0.45), wv = Math.min(ring, iv * 0.45);
      const us = [-iu, -iu + wu, iu - wu, iu];
      const vs = [-iv, -iv + wv, iv - wv, iv];
      const ev = (k) => (k === 0 || k === 3 ? eF : 0);
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
          const P = (ui, vi) => {
            const p = [0, 0, 0];
            p[a] = sgn * H[a]; p[uAx] = us[ui]; p[vAx] = vs[vi];
            return warp(p);
          };
          const ps = [P(i, j), P(i + 1, j), P(i + 1, j + 1), P(i, j + 1)];
          const es = [
            Math.max(ev(i), ev(j)), Math.max(ev(i + 1), ev(j)),
            Math.max(ev(i + 1), ev(j + 1)), Math.max(ev(i), ev(j + 1)),
          ];
          m.quad(ps, ps.map((p) => uvBox(p, outv)), es, cav, outv);
        }
      }
    }
  }

  // ---- twelve chamfer strips --------------------------------------------
  const E1 = [1, 1, 1, 1];
  for (let a = 0; a < 3; a++) {
    const b = (a + 1) % 3, cc = (a + 2) % 3;
    for (const sb of [-1, 1]) {
      for (const sc of [-1, 1]) {
        const outv = [0, 0, 0];
        outv[b] = sb; outv[cc] = sc;
        const nOut = norm(outv);
        const mk = (za, onB) => {
          const p = [0, 0, 0];
          p[a] = za;
          p[b] = sb * (onB ? H[b] : I[b]);
          p[cc] = sc * (onB ? I[cc] : H[cc]);
          return warp(p);
        };
        const ps = [mk(-I[a], true), mk(-I[a], false), mk(I[a], false), mk(I[a], true)];
        m.quad(ps, ps.map((p) => uvBox(p, nOut)), E1, cav, nOut);
      }
    }
  }

  // ---- eight corner triangles -------------------------------------------
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const nOut = norm([sx, sy, sz]);
        const ps = [
          warp([sx * H[0], sy * I[1], sz * I[2]]),
          warp([sx * I[0], sy * H[1], sz * I[2]]),
          warp([sx * I[0], sy * I[1], sz * H[2]]),
        ];
        m.tri(ps, ps.map((p) => uvBox(p, nOut)), [1, 1, 1], cav, nOut);
      }
    }
  }
}

/* ---------------------------------------------------------------- cylinder */

/**
 * Chamfered cylinder / cone along Z. `r0` is the radius at -Z, `r1` at +Z.
 * The rim chamfers are what stop a barrel or a turret reading as a plain tube.
 */
export function cylG(m, o) {
  const seg = o.seg ?? 16;
  const len = o.len, r0 = o.r0, r1 = o.r1 ?? o.r0;
  const c = Math.min(o.c ?? 0.0007, len * 0.3, Math.min(r0, r1) * 0.4);
  const hz = len / 2;
  const cav = o.cav ?? 0;
  const capA = o.capA !== false, capB = o.capB !== false;
  const zA = -hz + c, zB = hz - c;
  const slope = (r1 - r0) / Math.max(1e-5, len);
  m.at(o);

  const ring = (z, r) => {
    const pts = [], ns = [];
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      pts.push([ca * r, sa * r, z]);
      ns.push(norm([ca, sa, -slope]));
    }
    return { pts, ns };
  };

  const A = ring(zA, r0), B = ring(zB, r1);
  const rAvg = (r0 + r1) * 0.5;
  const uOf = (i) => (i / seg) * (Math.PI * 2 * rAvg) / TEX_M;

  // side
  for (let i = 0; i < seg; i++) {
    m.quad(
      [A.pts[i], A.pts[i + 1], B.pts[i + 1], B.pts[i]],
      [[uOf(i), zA / TEX_M], [uOf(i + 1), zA / TEX_M], [uOf(i + 1), zB / TEX_M], [uOf(i), zB / TEX_M]],
      [0, 0, 0, 0], cav, [A.ns[i][0], A.ns[i][1], A.ns[i][2]],
      [A.ns[i], A.ns[i + 1], B.ns[i + 1], B.ns[i]],
    );
  }

  // rim chamfers + caps
  const rim = (zOuter, zInner, r, sign, cap) => {
    const rc = Math.max(0.0002, r - c);
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
      const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
      const pi0 = [c0 * r, s0 * r, zInner], pi1 = [c1 * r, s1 * r, zInner];
      const po0 = [c0 * rc, s0 * rc, zOuter], po1 = [c1 * rc, s1 * rc, zOuter];
      const n0 = norm([c0 * 0.7, s0 * 0.7, sign * 0.7]);
      const n1 = norm([c1 * 0.7, s1 * 0.7, sign * 0.7]);
      m.quad([pi0, pi1, po1, po0], null, [1, 1, 1, 1], cav, n0, [n0, n1, n1, n0]);
      if (!cap) continue;
      const nz = [0, 0, sign];
      m.tri([[0, 0, zOuter], po0, po1], null, [0, 0.6, 0.6], cav, nz, [nz, nz, nz]);
    }
  };
  rim(-hz, zA, r0, -1, capA);
  rim(hz, zB, r1, 1, capB);
}

/* ------------------------------------------------------------------- prism */

/**
 * Swept 2D profile along Z — the workhorse for receivers, handguards and rails.
 *
 * `profile` is a convex CCW polygon of `[x, y, edgeFlag]`. A side face may be
 * given a list of Z spans in `slots`, which cuts *genuine* recessed pockets
 * (floor plus four slanted walls) into that face: this is how the M-LOK slots
 * and the ejection port are real geometry rather than a painted-on texture.
 */
export function prismG(m, o) {
  const prof = o.profile;
  const n = prof.length;
  const z0 = o.z0, z1 = o.z1;
  const cav = o.cav ?? 0;
  const slots = o.slots ?? null;          // { [edgeIndex]: {spans, halfW, depth} }
  m.at(o);

  for (let i = 0; i < n; i++) {
    const a = prof[i], b = prof[(i + 1) % n];
    const spec = slots ? slots[i] : null;
    _sideFace(m, a, b, z0, z1, spec, cav);
  }

  // end caps, fanned from profile[0]
  for (const [z, sign, want] of [[z0, -1, o.capA !== false], [z1, 1, o.capB !== false]]) {
    if (!want) continue;
    const nz = [0, 0, sign];
    for (let i = 1; i < n - 1; i++) {
      const ps = [
        [prof[0][0], prof[0][1], z],
        [prof[i][0], prof[i][1], z],
        [prof[i + 1][0], prof[i + 1][1], z],
      ];
      const es = [prof[0][2] ?? 0, prof[i][2] ?? 0, prof[i + 1][2] ?? 0];
      m.tri(ps, ps.map((p) => uvBox(p, nz)), es, cav, nz, [nz, nz, nz]);
    }
  }
}

/** One side face of a prism, with optional recessed pockets. */
function _sideFace(m, a, b, z0, z1, spec, cav) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const wlen = Math.hypot(dx, dy) || 1e-6;
  const ux = dx / wlen, uy = dy / wlen;
  const outv = norm([uy, -ux, 0]);
  const ea = a[2] ?? 0, eb = b[2] ?? 0;
  // Position at (u along the face, z, inset inward from the surface).
  const P = (u, z, inset = 0) => [
    a[0] + ux * u - outv[0] * inset,
    a[1] + uy * u - outv[1] * inset,
    z,
  ];
  const U = (u, z) => [u / TEX_M, z / TEX_M];
  const eAt = (u) => ea + (eb - ea) * (u / wlen);

  if (!spec || !spec.spans.length) {
    m.quad([P(0, z0), P(wlen, z0), P(wlen, z1), P(0, z1)],
      [U(0, z0), U(wlen, z0), U(wlen, z1), U(0, z1)],
      [ea, eb, eb, ea], cav, outv, [outv, outv, outv, outv]);
    return;
  }

  const hw = Math.min(spec.halfW, wlen * 0.42);
  const uc = wlen * 0.5, u0 = uc - hw, u1 = uc + hw;
  const dep = spec.depth;
  const wall = Math.min(0.0007, dep * 0.7);

  // flanking bands, full length
  m.quad([P(0, z0), P(u0, z0), P(u0, z1), P(0, z1)],
    [U(0, z0), U(u0, z0), U(u0, z1), U(0, z1)],
    [ea, eAt(u0), eAt(u0), ea], cav, outv, [outv, outv, outv, outv]);
  m.quad([P(u1, z0), P(wlen, z0), P(wlen, z1), P(u1, z1)],
    [U(u1, z0), U(wlen, z0), U(wlen, z1), U(u1, z1)],
    [eAt(u1), eb, eb, eAt(u1)], cav, outv, [outv, outv, outv, outv]);

  // ribs between the slots
  const spans = spec.spans;
  let zPrev = z0;
  for (let i = 0; i <= spans.length; i++) {
    const zNext = i < spans.length ? spans[i].a : z1;
    if (zNext - zPrev > 1e-5) {
      m.quad([P(u0, zPrev), P(u1, zPrev), P(u1, zNext), P(u0, zNext)],
        [U(u0, zPrev), U(u1, zPrev), U(u1, zNext), U(u0, zNext)],
        [0.5, 0.5, 0.5, 0.5], cav, outv, [outv, outv, outv, outv]);
    }
    if (i < spans.length) zPrev = spans[i].b;
  }

  // the pockets themselves
  for (const s of spans) {
    const f0 = u0 + wall, f1 = u1 - wall;
    const g0 = s.a + wall, g1 = s.b - wall;
    // floor — omitted for a true through-hole such as the ejection port, where
    // whatever sits behind it (the bolt carrier, the dark receiver interior) is
    // meant to be visible.
    if (!spec.noFloor) {
      m.quad([P(f0, g0, dep), P(f1, g0, dep), P(f1, g1, dep), P(f0, g1, dep)],
        [U(f0, g0), U(f1, g0), U(f1, g1), U(f0, g1)],
        [0, 0, 0, 0], 0.9, outv, [outv, outv, outv, outv]);
    }
    // four slanted walls — outward is the face normal tilted toward the lip
    const k = 0.45;
    const wallQuad = (pa, pb, pc, pd, nrmv) => m.quad([pa, pb, pc, pd],
      [uvBox(pa, nrmv), uvBox(pb, nrmv), uvBox(pc, nrmv), uvBox(pd, nrmv)],
      [0.85, 0.85, 0.15, 0.15], 0.55, nrmv);
    wallQuad(P(u0, s.a), P(u1, s.a), P(f1, g0, dep), P(f0, g0, dep),
      norm([outv[0] * k, outv[1] * k, -1]));
    wallQuad(P(u1, s.b), P(u0, s.b), P(f0, g1, dep), P(f1, g1, dep),
      norm([outv[0] * k, outv[1] * k, 1]));
    wallQuad(P(u0, s.b), P(u0, s.a), P(f0, g0, dep), P(f0, g1, dep),
      norm([outv[0] * k - ux, outv[1] * k - uy, 0]));
    wallQuad(P(u1, s.a), P(u1, s.b), P(f1, g1, dep), P(f1, g0, dep),
      norm([outv[0] * k + ux, outv[1] * k + uy, 0]));
  }
}

/* --------------------------------------------------------------- profiles */

/** Rounded (chamfered) rectangle profile, CCW, with corner points flagged. */
export function rectProfile(w, h, c = 0.0022, edge = 1.0) {
  const x = w / 2, y = h / 2;
  const k = Math.min(c, x * 0.45, y * 0.45);
  return [
    [-x + k, -y, edge], [x - k, -y, edge], [x, -y + k, edge], [x, y - k, edge],
    [x - k, y, edge], [-x + k, y, edge], [-x, y - k, edge], [-x, -y + k, edge],
  ];
}

/** Octagonal profile used by the free-float handguard. */
export function octProfile(w, h, flat = 0.42, edge = 1.0) {
  const x = w / 2, y = h / 2;
  const fx = x * flat, fy = y * flat;
  return [
    [-fx, -y, edge], [fx, -y, edge], [x, -fy, edge], [x, fy, edge],
    [fx, y, edge], [-fx, y, edge], [-x, fy, edge], [-x, -fy, edge],
  ];
}

const _kv = new THREE.Vector3();
const _kq = new THREE.Quaternion();
const _ke = new THREE.Euler(0, 0, 0, 'YXZ');

/**
 * A knurled ring: a chamfered cylinder plus radial ridges, correctly oriented
 * for any axis. Used on the optic's windage/elevation turrets and the
 * suppressor collar — knurling is the detail that says "adjustable machined
 * part" faster than any texture can.
 */
export function knurlG(m, o) {
  cylG(m, { ...o, seg: o.seg ?? 16 });
  const teeth = o.teeth ?? 16;
  const r = o.r0;
  _ke.set(o.rx ?? 0, o.ry ?? 0, o.rz ?? 0, 'YXZ');
  _kq.setFromEuler(_ke);
  for (let i = 0; i < teeth; i++) {
    const a = (i / teeth) * Math.PI * 2;
    _kv.set(Math.cos(a) * r * 0.985, Math.sin(a) * r * 0.985, 0).applyQuaternion(_kq);
    boxG(m, {
      x: (o.x ?? 0) + _kv.x, y: (o.y ?? 0) + _kv.y, z: (o.z ?? 0) + _kv.z,
      rx: o.rx ?? 0, ry: o.ry ?? 0, rz: o.rz ?? 0,
      w: 0.0012, h: 0.0010, d: o.len * 0.84, c: 0.0003, simple: true,
    });
  }
}
