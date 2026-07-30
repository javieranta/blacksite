import * as THREE from 'three';

/**
 * OWNER: viewmodel agent.
 *
 * Skinned-surface kit for the first-person hands: a bone rig builder and a
 * lofted-tube mesher that emits ONE continuous surface per limb.
 *
 * ─── WHY THIS FILE WAS REPLACED ───────────────────────────────────────────
 *
 * The previous revision solved the *contact* problem and nothing else, and the
 * review that followed named exactly what was left:
 *
 *   "the hand is a stack of unskinned PVC capsules … four detached capsules with
 *    visible gaps beside the grip — there is no palm … every joint capped by a
 *    teal ring."
 *
 * All three are consequences of one decision: the hand was a *pile of solids*.
 * Forty chamfered boxes and cylinders, each closed, each with its own silhouette.
 *
 *   GAPS. Two solids that meet at an angle either interpenetrate or leave air.
 *   Placing them by trigonometry gets the joint centres right and says nothing
 *   about the surface between them, so the fingers had visible daylight between
 *   phalanges. tools/handcheck.mjs now counts connected components of the hand
 *   mask for this reason; the old build measured 12-16, a hand is 1.
 *
 *   TEAL RINGS. Found by A/B, not guessed: zeroing the viewmodel's cool fill and
 *   rim lights takes the cyan pixel share from 1.62% to 0.12%. It is Fresnel
 *   rim-specular of a #93a5c6 fill on the grazing band of every capsule. A
 *   dielectric's specular is not tinted by albedo and its Fresnel term goes to 1
 *   at grazing incidence, so every silhouette edge paints itself pure light
 *   colour — a cool ring on a tan glove. ONE surface has ONE silhouette and one
 *   thin correct rim; forty nested capsules put forty of them mid-hand, where
 *   they read as pipe couplings. No material tweak fixes that, because the rings
 *   are real geometry.
 *
 *   NO PALM. A palm is the thing that makes finger roots a single mass. Bands of
 *   slabs stacked up the grip's flank cannot be one, and the previous file's own
 *   comments record three failed attempts to make them look like one.
 *
 * So the primitive here is not a solid, it is a SURFACE: a superelliptic section
 * swept along a curve, closed only where the real limb closes (a fingertip), and
 * left open where another surface continues it. A finger is one tube through all
 * three phalanges — the curl is in the loft, so the joints cannot gap. A palm is
 * one tube from wrist to knuckle line whose distal cap the fingers grow out of.
 *
 * ─── BIND POSE IS THE FINAL POSE ──────────────────────────────────────────
 *
 * The bones are built with the hand already wrapped, not straight. That is
 * deliberate. Authoring a straight hand and posing it into contact would put the
 * one property the last four rounds fought for — fingers actually touching the
 * weapon — at the mercy of the skinning, which is the wrong thing to gamble.
 * Instead `offsetPath`/`wrapDigit` (kept intact from the previous revision, they
 * were the part that worked) solve the joint chain against the weapon's real
 * section, the loft follows that solution, and the skeleton is bound to it. The
 * bones then exist for what only bones can do: deform the surface at runtime —
 * the trigger squeeze, the reload relax — with no seam to come apart.
 */

/* ------------------------------------------------------------------ frames */

export const IDENT = new THREE.Matrix4();

const _t1 = new THREE.Vector3();
const _t2 = new THREE.Vector3();
const _t3 = new THREE.Vector3();
const _tq = new THREE.Quaternion();
const _te = new THREE.Euler(0, 0, 0, 'YXZ');
const _tv = new THREE.Vector3();
const _one = new THREE.Vector3(1, 1, 1);

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
/** Metres of surface per texture tile — must match Shapes.TEX_M. */
const TEX_M = 0.030;

/** Child frame from a translation plus an intrinsic YXZ rotation. */
export function child(parent, x, y, z, rx = 0, ry = 0, rz = 0) {
  _tv.set(x, y, z);
  _te.set(rx, ry, rz, 'YXZ');
  _tq.setFromEuler(_te);
  const local = new THREE.Matrix4().compose(_tv, _tq, _one);
  return new THREE.Matrix4().multiplyMatrices(parent, local);
}

/**
 * Orthonormal child frame aimed along `dir`, with `back` naming the dorsal
 * (back-of-hand) side. Both vectors are in the *parent's* coordinates. +Z is the
 * limb axis, +Y the dorsal normal, +X the joint hinge — so a positive rotation
 * about +X curls the limb toward the palm for every digit on both hands.
 *
 * X = Y x Z guarantees right-handedness, which is what keeps triangle winding,
 * and therefore the lighting, correct.
 */
export function frameAt(parent, px, py, pz, dir, back) {
  const Z = _t1.set(dir[0], dir[1], dir[2]).normalize();
  const Y = _t2.set(back[0], back[1], back[2]);
  Y.addScaledVector(Z, -Y.dot(Z)).normalize();
  const X = _t3.crossVectors(Y, Z);
  const local = new THREE.Matrix4().makeBasis(X, Y, Z);
  local.setPosition(px, py, pz);
  return new THREE.Matrix4().multiplyMatrices(parent, local);
}

/* -------------------------------------------------------------- wrap paths */

/**
 * The Minkowski offset of a convex polyline, walkable by arc length.
 *
 * `pts` is a list of [x, y] in the section plane, ordered in the wrap direction
 * and turning consistently (the outline must be convex — bridge any notch with a
 * vertex rather than following it in). `t` is the offset distance; for a digit
 * that is its half-thickness.
 *
 * Which side is "outward" is *derived*, not passed: a convex path turns toward
 * its own interior, so the sign of the first turn fixes the outward normal for
 * the whole run. Passing it by hand is how a previous revision ended up with a
 * hand offset into the receiver on one section and out into air on the other.
 *
 * `at(s, out)` fills `out` with [x, y, tanX, tanY, nrmX, nrmY] and returns it.
 */
export function offsetPath(pts, t) {
  const n = pts.length;
  const u = [], L = [];
  for (let i = 0; i < n - 1; i++) {
    const dx = pts[i + 1][0] - pts[i][0], dy = pts[i + 1][1] - pts[i][1];
    const len = Math.hypot(dx, dy);
    u.push([dx / len, dy / len]);
    L.push(len);
  }
  let sign = 1;
  for (let i = 0; i + 1 < u.length; i++) {
    const cr = u[i][0] * u[i + 1][1] - u[i][1] * u[i + 1][0];
    if (Math.abs(cr) > 1e-7) { sign = cr < 0 ? 1 : -1; break; }
  }
  const nrm = u.map(([ux, uy]) => [sign * -uy, sign * ux]);
  const rot = -sign;

  const segs = [];
  let total = 0;
  for (let i = 0; i < u.length; i++) {
    segs.push({ arc: false, i, s0: total, len: L[i] });
    total += L[i];
    if (i + 1 < u.length) {
      const turn = Math.acos(clamp(u[i][0] * u[i + 1][0] + u[i][1] * u[i + 1][1], -1, 1));
      const al = t * turn;
      segs.push({ arc: true, i, s0: total, len: al, turn, a0: Math.atan2(nrm[i][1], nrm[i][0]) });
      total += al;
    }
  }

  return {
    len: total,
    at(s, out) {
      const q = clamp(s, 0, total);
      let seg = segs[segs.length - 1];
      for (const g of segs) { if (q <= g.s0 + g.len) { seg = g; break; } }
      if (!seg.arc) {
        const k = q - seg.s0, i = seg.i;
        out[0] = pts[i][0] + nrm[i][0] * t + u[i][0] * k;
        out[1] = pts[i][1] + nrm[i][1] * t + u[i][1] * k;
        out[2] = u[i][0]; out[3] = u[i][1];
        out[4] = nrm[i][0]; out[5] = nrm[i][1];
        return out;
      }
      const f = seg.len > 1e-9 ? (q - seg.s0) / seg.len : 0;
      const a = seg.a0 + rot * seg.turn * f;
      const nx = Math.cos(a), ny = Math.sin(a);
      const v = pts[seg.i + 1];
      out[0] = v[0] + nx * t; out[1] = v[1] + ny * t;
      out[2] = sign * ny; out[3] = sign * -nx;
      out[4] = nx; out[5] = ny;
      return out;
    },
  };
}

const _wa = [0, 0, 0, 0, 0, 0];
const _wb = [0, 0, 0, 0, 0, 0];

/**
 * Solve a three-phalanx digit onto a wrap path.
 *
 * Walks the path by *chord* length: for each phalanx it bisects the arc-length
 * step whose straight-line span equals the bone's real length. Sampling by arc
 * length instead — the obvious thing to do, and what every revision before this
 * machinery effectively did — makes every bone shorter than itself and
 * accumulates the error into the fingertip, which is the place the pose is
 * judged.
 *
 * @returns { p:[x,y], dir:[x,y], back:[x,y], curls:[a,b,c], joints:[[x,y]...] }
 */
export function wrapDigit(path, s0, lens) {
  const P = [];
  const seed = path.at(s0, [0, 0, 0, 0, 0, 0]);
  P.push([seed[0], seed[1]]);
  let s = s0;
  for (const want of lens) {
    let lo = want, hi = want * 2.2;
    const last = P[P.length - 1];
    for (let k = 0; k < 28; k++) {
      const mid = (lo + hi) * 0.5;
      path.at(s + mid, _wa);
      const d = Math.hypot(_wa[0] - last[0], _wa[1] - last[1]);
      if (d < want) lo = mid; else hi = mid;
    }
    s += (lo + hi) * 0.5;
    path.at(s, _wb);
    P.push([_wb[0], _wb[1]]);
  }
  const dirs = [];
  for (let i = 0; i < lens.length; i++) {
    const dx = P[i + 1][0] - P[i][0], dy = P[i + 1][1] - P[i][1];
    const l = Math.hypot(dx, dy) || 1;
    dirs.push([dx / l, dy / l]);
  }
  const ang = (a, b) => Math.acos(clamp(a[0] * b[0] + a[1] * b[1], -1, 1));
  const curls = [ang([seed[2], seed[3]], dirs[0])];
  for (let i = 1; i < dirs.length; i++) curls.push(ang(dirs[i - 1], dirs[i]));
  return {
    p: [seed[0], seed[1]],
    dir: [seed[2], seed[3]],
    back: [seed[4], seed[5]],
    curls, joints: P, tip: P[P.length - 1], sEnd: s,
  };
}

/** Phalanx length ratios, proximal -> distal, and the matching thickness taper. */
export const SEG_LEN = [1.00, 0.82, 0.66];
export const SEG_TH = [1.00, 0.93, 0.85, 0.76];

/** Phalanx chord lengths for a digit of overall length `len`. */
export function phalanges(len) {
  return [len * SEG_LEN[0], len * SEG_LEN[1], len * SEG_LEN[2]];
}

/* -------------------------------------------------------------- bone rig */

/**
 * Build a bone hierarchy from joints given in *world* (weapon) space with a
 * world bind orientation each.
 *
 * The bind orientation matters and is the reason this is not the soldier rig's
 * three-number form. A hand is bound already curled, so a bone's hinge is not a
 * world axis: the middle phalanx of a fisted finger points back toward the
 * wrist. Giving each bone the frame the loft used at that joint makes local +X
 * the hinge for every digit on both hands, so `bone.rotation.x += k` is "curl"
 * everywhere and there is no per-site sign hunting.
 *
 * @param joints [{ name, parent, p:[x,y,z], m: Matrix4 (orientation source) }]
 * @returns { bones, root, world:[Vector3], quat:[Quaternion] }
 */
export function buildRig(joints) {
  const bones = [], world = [], quat = [];
  const wp = new THREE.Vector3(), wq = new THREE.Quaternion();
  const inv = new THREE.Quaternion(), sc = new THREE.Vector3();
  for (const j of joints) {
    const b = new THREE.Bone();
    b.name = j.name;
    wp.set(j.p[0], j.p[1], j.p[2]);
    if (j.m) j.m.decompose(new THREE.Vector3(), wq, sc);
    else wq.identity();
    const par = j.parent;
    if (par < 0) {
      b.position.copy(wp);
      b.quaternion.copy(wq);
    } else {
      inv.copy(quat[par]).invert();
      b.position.copy(wp).sub(world[par]).applyQuaternion(inv);
      b.quaternion.copy(inv).multiply(wq);
      bones[par].add(b);
    }
    world.push(wp.clone());
    quat.push(wq.clone());
    bones.push(b);
  }
  return { bones, root: bones[0], world, quat };
}

/* ------------------------------------------------------------------- skin */

/**
 * Superelliptic section sample. `n` = 2 is an ellipse, 3-4 a rounded slab.
 *
 * A circular finger reads as a peg and a rectangular palm reads as a plate; a
 * superellipse is the one-parameter family that spans both, so the palm and the
 * fingers can be the same code path with different exponents rather than
 * different primitives with a seam between them.
 */
function sect(t, a, b, n, out) {
  const th = t * Math.PI * 2;
  const c = Math.cos(th), s = Math.sin(th);
  const e = 2 / n;
  out[0] = (c < 0 ? -1 : 1) * a * Math.pow(Math.abs(c), e);
  out[1] = (s < 0 ? -1 : 1) * b * Math.pow(Math.abs(s), e);
}

const _s0 = [0, 0], _s1 = [0, 0], _s2 = [0, 0];
const _p = new THREE.Vector3();
const _pa = new THREE.Vector3();
const _pb = new THREE.Vector3();
const _n = new THREE.Vector3();
const _du = new THREE.Vector3();
const _dv = new THREE.Vector3();

/**
 * Accumulates skinned surfaces into per-material buckets. Build-time only, so
 * ordinary allocation is fine.
 */
export class Skin {
  constructor() {
    this.zones = new Map();
    this._key = 'glove';
    this.tris = 0;
  }

  use(key) { this._key = key; return this; }

  _zone() {
    let z = this.zones.get(this._key);
    if (!z) {
      z = { pos: [], nrm: [], uv: [], si: [], sw: [], cav: [], idx: [], verts: 0 };
      this.zones.set(this._key, z);
    }
    return z;
  }

  /**
   * Loft a closed or partial tube through a run of stations.
   *
   * A station is `{ m, a, b, n, bone, parent, wp }`: a frame whose +Z is the
   * local axis, the section's half-width and half-depth, its exponent, and the
   * skinning. `wp` is how much of the vertex weight goes to `parent` — non-zero
   * only within a short window either side of a joint, which is what makes the
   * surface bend rather than crease when a bone rotates.
   *
   * @param o.seg      radial samples. 14 is already past visible faceting at
   *                   foreground scale once normals are analytic in t.
   * @param o.arc      [t0, t1] in turns. Two arcs sharing a boundary give one
   *                   watertight surface split across two materials, which is
   *                   how the leather palm meets the woven back without a gap.
   * @param o.capEnd   rings of rounded closure past the last station, then an
   *                   apex. This is the ONLY place a tube closes, and it closes
   *                   with the section's own topology — never a disc, which is
   *                   what made every fingertip read as a bolt head.
   * @param o.disp     (t, gf, station) -> extra outward displacement, in metres,
   *                   along the section's own 2D normal. Wrinkles, knuckle bulges
   *                   and pad blisters are all this and nothing else, so none of
   *                   them adds a silhouette of its own.
   *
   *                   `gf` is the station's fraction along its ORIGINAL run, not
   *                   its row index in this call. That distinction is what lets a
   *                   pad be emitted over a SLICE of a finger's stations while
   *                   still evaluating the finger's own knuckle bulges at the
   *                   same place — otherwise a pad covering one phalanx would sit
   *                   on a differently-bulged surface and either sink into it or
   *                   float off it.
   */
  tube(st, o = {}) {
    const seg = o.seg ?? 14;
    const arc = o.arc ?? null;
    const t0 = arc ? arc[0] : 0, t1 = arc ? arc[1] : 1;
    const cols = seg + 1;
    const z = this._zone();
    const base = z.verts;
    const disp = o.disp ?? null;

    // ---- rows: the stations, plus synthesised cap rings ---------------------
    const rows = st.slice();
    const capEnd = o.capEnd ?? 0;
    if (capEnd > 0) {
      const last = st[st.length - 1];
      // How far past the last station the closure reaches. Defaulting it to the
      // section's mean half-extent is right for a fingertip and wrong for a palm:
      // the palm's mean is 21 mm, so an unscaled cap put a 21 mm bulbous nose past
      // the knuckle line. A hand's knuckle end rounds over about 9 mm.
      const r = (last.a + last.b) * 0.5 * (o.capScale ?? 1);
      for (let j = 1; j <= capEnd; j++) {
        const ang = (j / (capEnd + 0.55)) * (Math.PI / 2);
        rows.push({
          m: child(last.m, 0, 0, r * Math.sin(ang)),
          a: last.a * Math.cos(ang), b: last.b * Math.cos(ang), n: last.n,
          bone: last.bone, parent: last.parent, wp: last.wp, gf: last.gf, cap: true,
        });
      }
    }

    // ---- nominal circumference: one value per tube keeps stitch lines straight
    let aMax = 0, bMax = 0;
    for (const s of st) { if (s.a > aMax) aMax = s.a; if (s.b > bMax) bMax = s.b; }
    const circ = Math.PI * (1.5 * (aMax + bMax) - Math.sqrt(aMax * bMax));

    // ---- vertex grid --------------------------------------------------------
    const P = [];                     // rows x cols of Vector3
    const vRun = [0];
    for (let r = 0; r < rows.length; r++) {
      const row = [];
      const S = rows[r];
      for (let c = 0; c < cols; c++) {
        const t = lerp(t0, t1, c / seg);
        row.push(this._point(S, t, S.gf ?? (r / (rows.length - 1)), disp, new THREE.Vector3()));
      }
      P.push(row);
      if (r > 0) {
        _pa.setFromMatrixPosition(rows[r].m);
        _pb.setFromMatrixPosition(rows[r - 1].m);
        vRun.push(vRun[r - 1] + _pa.distanceTo(_pb));
      }
    }
    // Apex: one vertex closing the cap, fanned from the last ring.
    let apex = null;
    if (capEnd > 0) {
      const last = st[st.length - 1];
      const r = (last.a + last.b) * 0.5 * (o.capScale ?? 1);   // same reach as the rings
      apex = new THREE.Vector3(0, 0, r * 1.02).applyMatrix4(last.m);
    }

    // ---- emit --------------------------------------------------------------
    const closed = !arc;
    for (let r = 0; r < rows.length; r++) {
      const S = rows[r];
      const rf = S.gf ?? (r / (rows.length - 1));
      for (let c = 0; c < cols; c++) {
        const t = lerp(t0, t1, c / seg);
        // Tangent around the section, analytic in t so the two arcs of a split
        // surface get identical normals on their shared boundary.
        const dt = 0.004;
        this._point(S, t + dt, rf, disp, _pa);
        this._point(S, t - dt, rf, disp, _pb);
        _du.subVectors(_pa, _pb);
        // Tangent along the run, central where possible.
        const rA = Math.min(rows.length - 1, r + 1), rB = Math.max(0, r - 1);
        _dv.subVectors(P[rA][c], P[rB][c]);
        if (_dv.lengthSq() < 1e-12) _dv.set(0, 0, 1).applyMatrix4(S.m).sub(_p.setFromMatrixPosition(S.m));
        _n.crossVectors(_dv, _du).normalize();
        // Outward check: the section normal must point away from the axis.
        _p.setFromMatrixPosition(S.m);
        if (_n.dot(_pa.copy(P[r][c]).sub(_p)) < 0) _n.negate();
        const v = P[r][c];
        z.pos.push(v.x, v.y, v.z);
        z.nrm.push(_n.x, _n.y, _n.z);
        z.uv.push((t * circ) / TEX_M, vRun[r] / TEX_M);
        const wp = S.wp ?? 0;
        z.si.push(S.bone, S.parent ?? S.bone, 0, 0);
        z.sw.push(1 - wp, wp, 0, 0);
        z.cav.push(o.cav ? Math.max(0, Math.min(1, o.cav(t, rf))) : 0);
      }
    }
    /**
     * WINDING. Rows advance along the station's +Z and columns counter-clockwise
     * in its XY plane, so cross(rowStep, colStep) points at the AXIS, not away
     * from it. The order below is therefore reversed from the obvious one. Worth
     * stating because the normals here are explicit and outward, so getting this
     * wrong does not produce black shading that would give it away — it produces
     * a surface that is simply culled, which looks exactly like geometry that
     * failed to build.
     */
    for (let r = 0; r + 1 < rows.length; r++) {
      const a0 = base + r * cols, b0 = base + (r + 1) * cols;
      for (let c = 0; c < seg; c++) {
        const c1 = c + 1;
        z.idx.push(a0 + c, b0 + c1, b0 + c, a0 + c, a0 + c1, b0 + c1);
        this.tris += 2;
      }
    }
    z.verts += rows.length * cols;

    if (apex) {
      const ai = z.verts;
      const lastRow = rows.length - 1;
      _p.setFromMatrixPosition(rows[lastRow].m);
      _n.copy(apex).sub(_p).normalize();
      z.pos.push(apex.x, apex.y, apex.z);
      z.nrm.push(_n.x, _n.y, _n.z);
      z.uv.push((0.5 * circ) / TEX_M, (vRun[lastRow] + 0.004) / TEX_M);
      const S = rows[lastRow];
      z.si.push(S.bone, S.parent ?? S.bone, 0, 0);
      z.sw.push(1 - (S.wp ?? 0), S.wp ?? 0, 0, 0);
      z.cav.push(0);
      z.verts += 1;
      const r0 = base + lastRow * cols;
      for (let c = 0; c < seg; c++) { z.idx.push(r0 + c, r0 + c + 1, ai); this.tris += 1; }
    }
    return this;
  }

  /** Section point for station `S` at ring parameter `t`, in weapon space. */
  _point(S, t, rowFrac, disp, out) {
    sect(t, S.a, S.b, S.n ?? 2.4, _s0);
    let x = _s0[0], y = _s0[1];
    if (disp) {
      // Displace along the section's own outward 2D normal, derived from the
      // section tangent so it is correct for any exponent.
      sect(t + 0.004, S.a, S.b, S.n ?? 2.4, _s1);
      sect(t - 0.004, S.a, S.b, S.n ?? 2.4, _s2);
      const tx = _s1[0] - _s2[0], ty = _s1[1] - _s2[1];
      const l = Math.hypot(tx, ty) || 1;
      const d = disp(t, rowFrac, S);
      x += (ty / l) * d;
      y += (-tx / l) * d;
    }
    return out.set(x + (S.ox ?? 0), y + (S.oy ?? 0), 0).applyMatrix4(S.m);
  }

  /** @returns {Map<string, THREE.BufferGeometry>} */
  geometries() {
    const out = new Map();
    for (const [key, z] of this.zones) {
      if (!z.pos.length) continue;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(z.pos, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(z.nrm, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(z.uv, 2));
      /**
       * The wear shader in Materials.js reads both of these on every zone.
       *
       * aEdge stays 0: it is the metal-wear curvature proxy, and a glove has no
       * machined chamfer to rub through. Letting it act on fabric is how the last
       * version got a warm bare-metal wear line along every capsule rim.
       *
       * aCav is genuinely useful here, and it is the answer to "crease darkening
       * in the finger folds". It drives an albedo darkening and a roughness rise
       * in the same shader the weapon's M-LOK slots use, and only the geometry
       * knows where the creases are — the texture is tiled and cannot.
       */
      const n = z.pos.length / 3;
      g.setAttribute('aEdge', new THREE.Float32BufferAttribute(new Float32Array(n), 1));
      g.setAttribute('aCav', new THREE.Float32BufferAttribute(z.cav, 1));
      g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(z.si, 4));
      g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(z.sw, 4));
      g.setIndex(z.idx);
      // A generous fixed sphere: the hands are never frustum-culled anyway
      // (frustumCulled is off) but a valid one keeps raycasts and helpers sane.
      g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0.05), 0.55);
      out.set(key, g);
    }
    return out;
  }
}

/* -------------------------------------------------------- station helpers */

/**
 * Stations along a polyline of joints, with parallel-transported frames.
 *
 * PARALLEL TRANSPORT, NOT A FIXED DORSAL REFERENCE. Building each frame from
 * "tangent plus a constant back vector" is simpler and breaks on exactly the
 * pose that matters: a fisted finger turns through 150 degrees, so by the distal
 * phalanx the constant reference is nearly parallel to the tangent and the frame
 * flips. Transporting the previous frame by the minimal rotation from the
 * previous tangent to this one has no such degenerate case and introduces no
 * twist, which is also what keeps the stitch lines running straight down the
 * finger.
 *
 * @param joints  [Vector3] joint chain, at least two entries
 * @param nSub    stations emitted per segment
 * @param prof    (segIndex, u, globalU) -> { a, b, n, wp }
 * @param first   Matrix4 seed frame at joints[0]. Only its +Y (the dorsal side)
 *                is used as given; +Z is re-aimed at joints[1] by the transport,
 *                so callers never have to pre-align it.
 * @param bones   [[bone, parentBone], ...] per segment. The parent is explicit
 *                rather than "the previous segment's bone" because a digit's
 *                first segment lives inside the palm and must blend to the PALM,
 *                not to itself — which is the difference between a knuckle that
 *                deforms and one that shears.
 * @returns stations, with `frames[i]` carrying the bind frame of segment i's
 *          start joint so the bone rig can be built from the same solve.
 */
export function loft(joints, nSub, prof, first, bones) {
  const out = [];
  out.frames = [];
  const segs = joints.length - 1;
  const q = new THREE.Quaternion();
  const cur = first.clone();
  const zAx = new THREE.Vector3();
  const want = new THREE.Vector3();
  const pos = new THREE.Vector3();
  let len = 0;
  for (let s = 0; s < segs; s++) {
    want.copy(joints[s + 1]).sub(joints[s]).normalize();
    zAx.set(0, 0, 1).applyMatrix4(cur).sub(pos.setFromMatrixPosition(cur)).normalize();
    q.setFromUnitVectors(zAx, want);
    const rot = new THREE.Matrix4().makeRotationFromQuaternion(q);
    // Rotate the frame about the world origin, then re-seat it on the joint. The
    // rotation is orientation-only, so the order is safe and no scale creeps in.
    cur.premultiply(rot);
    cur.setPosition(joints[s]);
    out.frames.push(cur.clone());
    const [bone, parent] = bones[s];
    len = joints[s].distanceTo(joints[s + 1]);
    for (let k = 0; k < nSub; k++) {
      const u = k / nSub;
      const p = prof(s, u, (s + u) / segs);
      out.push({
        m: child(cur, 0, 0, u * len),
        a: p.a, b: p.b, n: p.n, ox: p.ox, oy: p.oy,
        bone, parent, wp: p.wp ?? 0, gf: (s + u) / segs,
      });
    }
  }
  // Closing station at the last joint.
  const p = prof(segs - 1, 1, 1);
  const [bone, parent] = bones[segs - 1];
  out.push({
    m: child(cur, 0, 0, len),
    a: p.a, b: p.b, n: p.n, ox: p.ox, oy: p.oy,
    bone, parent, wp: 0, gf: 1,
  });
  return out;
}

/**
 * Weight on the parent bone for a station at fraction `u` into its segment.
 *
 * Non-zero only over the first `win` of the segment. A wider window smooths the
 * bend and starts to drag the neighbouring phalanx with it; 0.30 is the largest
 * value at which a full trigger squeeze leaves the middle phalanx where it was.
 */
export function jointBlend(u, win = 0.30, peak = 0.46) {
  if (u >= win) return 0;
  const k = 1 - u / win;
  return peak * k * k;
}

/** A raised blister: 1 at the centre of the [c0,c1]x[r0,r1] window, 0 at its rim. */
export function blister(c0, c1, r0, r1, h) {
  return (t, rf) => {
    if (t < c0 || t > c1 || rf < r0 || rf > r1) return 0;
    const a = (t - c0) / (c1 - c0), b = (rf - r0) / (r1 - r0);
    const fa = Math.sin(Math.PI * a), fb = Math.sin(Math.PI * b);
    return h * Math.pow(fa, 0.7) * Math.pow(fb, 0.7);
  };
}
