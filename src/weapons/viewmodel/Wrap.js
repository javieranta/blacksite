import * as THREE from 'three';
import { boxG, cylG } from './Shapes.js';

/**
 * OWNER: viewmodel agent.
 *
 * Skeleton and contact kit for the first-person hands.
 *
 * ─── WHY THIS FILE EXISTS ─────────────────────────────────────────────────
 *
 * Four revisions of Hands.js placed digits by solving trigonometry against a
 * *circle* inscribed on a section that is not circular. A 24.8 mm circle about
 * the pistol grip's centre is 3 mm proud of the front strap and 8.7 mm clear of
 * the flanks, so the same wrap that touched the front of the grip floated in
 * mid-air at its sides — and the fingertips, which is where a wrap is read,
 * landed wherever the leftover length put them.
 *
 * The fix is to stop solving and start *walking*. `offsetPath` builds the exact
 * Minkowski offset of a convex section outline: straight runs parallel to each
 * facet, arcs of the offset radius about each vertex. That curve is, by
 * definition, the locus of points one finger half-thickness off the surface —
 * so a digit whose joints sit on it touches the weapon along its whole length,
 * on any section, faceted or not. `wrapDigit` then walks that curve by
 * *chord* length, solving each phalanx's arc-length step so the bone is its real
 * length and its ends are on the surface. The joint angles come out of the
 * walk; nobody guesses them.
 *
 * Two consequences worth stating, because both were previously fought by hand:
 *   - Where the outline is concave (the notch between the handguard's shoulder
 *     and the rail's flank) you list a vertex that *bridges* it. A finger does
 *     the same thing: it spans the notch and touches at both ends.
 *   - A section can be the silhouette of several parts. The support hand wraps
 *     handguard + rail as one outline, which is the only way a C-clamp grip can
 *     be authored without the fingers ending up inside the rail cover.
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
 * digit axis, +Y the dorsal normal, +X the joint hinge — so a positive curl
 * about +X rotates the digit toward the palm for every digit on both hands, with
 * no per-site sign hunting.
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

/**
 * A metacarpal ridge: a tapered bead running from the wrist point `a` to the
 * knuckle point `b`, both in the parent frame, standing `h` proud along `back`.
 *
 * Four ridges *parallel* across the back of a hand read as corrugation; four
 * ridges converging from one wrist onto four separated knuckle heads read as a
 * hand, and it is the cheapest such signal there is.
 */
export function ridge(m, parent, a, b, w, h, back) {
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-5) return;
  const f = frameAt(parent, a[0] + dx / 2, a[1] + dy / 2, a[2] + dz / 2,
    [dx, dy, dz], back);
  boxG(m, { mat4: f, w, h, d: len, w1: w * 1.35, h1: h * 1.30, c: 0.0009, simple: true });
}

/* -------------------------------------------------------------- wrap paths */

/**
 * The Minkowski offset of a convex polyline, walkable by arc length.
 *
 * `pts` is a list of [x, y] in the section plane, ordered in the wrap direction
 * and turning consistently (the outline must be convex — bridge any notch with
 * a vertex rather than following it in). `t` is the offset distance; for a digit
 * that is its half-thickness, for a palm half its thickness.
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
  // Outward normal, and the direction the frame rotates through each corner.
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
      // Tangent is the normal turned back a quarter turn the way the path runs.
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
 * length instead — which is the obvious thing to do and what every earlier
 * revision effectively did — makes every bone shorter than its own length and
 * accumulates the error into the fingertip, which is exactly the place the whole
 * pose is judged.
 *
 * @returns { p:[x,y], dir:[x,y], back:[x,y], curls:[a,b,c], tip:[x,y], sEnd }
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
    curls, tip: P[P.length - 1], sEnd: s,
  };
}

/**
 * A soft mass hugging a wrap path — the palm's metacarpal block, the thenar, a
 * hypothenar heel. Emitted as a short run of tapered slabs between path samples
 * so it follows the section's facets; a single slab across an octagon stands off
 * it at both ends, which is what made the previous support hand look bolted on.
 *
 * `w` runs across the section plane (i.e. along the bore for the support hand,
 * down the grip for the firing hand), `h` is the mass thickness, and the run
 * spans path arc length s0..s1.
 */
export function bandOnPath(m, path, o) {
  const N = o.steps ?? 5;
  const A = [0, 0, 0, 0, 0, 0], B = [0, 0, 0, 0, 0, 0];
  for (let i = 0; i < N; i++) {
    const ka = i / N, kb = (i + 1) / N;
    path.at(lerp(o.s0, o.s1, ka), A);
    path.at(lerp(o.s0, o.s1, kb), B);
    const h = lerp(o.h0, o.h1, (ka + kb) * 0.5);
    const nx = (A[4] + B[4]) * 0.5, ny = (A[5] + B[5]) * 0.5;
    const nl = Math.hypot(nx, ny) || 1;
    const dx = B[0] - A[0], dy = B[1] - A[1];
    const d = Math.hypot(dx, dy);
    if (d < 1e-6) continue;
    // Centre the slab across its own thickness so its inner face lands on the
    // section rather than half inside it.
    const f = frameAt(o.parent ?? IDENT,
      (A[0] + B[0]) * 0.5 + (nx / nl) * h * 0.5,
      (A[1] + B[1]) * 0.5 + (ny / nl) * h * 0.5,
      o.z ?? 0, [dx, dy, 0], [nx, ny, 0]);
    boxG(m, {
      mat4: f,
      w: lerp(o.w0, o.w1, ka), h, d: d + (o.overlap ?? 0.0022),
      w1: lerp(o.w0, o.w1, kb), h1: lerp(o.h0, o.h1, kb),
      c: Math.min(0.0030, h * 0.40),
    });
  }
}

/* ------------------------------------------------------------------ digits */

/** Phalanx length and thickness ratios, proximal -> distal. */
export const SEG_LEN = [1.00, 0.82, 0.66];
const SEG_TH = [1.00, 0.93, 0.85, 0.76];

/** Phalanx chord lengths for a digit of overall length `len`. */
export function phalanges(len) {
  return [len * SEG_LEN[0], len * SEG_LEN[1], len * SEG_LEN[2]];
}

/**
 * One digit: three tapering phalanges on nested hinge frames.
 *
 * The cross-section is 1.16:1 wide-to-deep — a square-section finger reads as a
 * peg and four pegs read as a rake. Each joint carries a crease bead exactly
 * where a knuckle creases, and the distal phalanx is capped round: a flat distal
 * quad is the loudest tell that a hand was assembled from boxes.
 *
 * @param o { len, thick, curls[3], pad, tipPad, nail }
 */
export function digit(m, frame, o) {
  let joint = frame;
  const L = o.len, T = o.thick;
  for (let s = 0; s < 3; s++) {
    joint = child(joint, 0, 0, 0, o.curls[s] ?? 0);
    const len = L * SEG_LEN[s];
    const th = T * SEG_TH[s];
    const th2 = T * SEG_TH[s + 1];

    m.use('glove');
    boxG(m, {
      mat4: child(joint, 0, 0, len * 0.5),
      w: th * 1.16, h: th, d: len,
      w1: th2 * 1.16, h1: th2,
      c: Math.min(th * 0.30, 0.0016), simple: true,
    });

    if (s < 2) {
      /**
       * Knuckle crease bead. Kept at 0.54 of the segment thickness, not 0.62: a
       * bead standing proud of a short visible run of finger, with a rounded cap
       * beyond it, photographs as a nut on a bolt. It has to separate one phalanx
       * from the next without becoming the loudest thing on the digit.
       */
      cylG(m, {
        mat4: child(joint, 0, th * 0.04, len - 0.0006, 0, Math.PI / 2),
        r0: th * 0.54, r1: th2 * 0.54, len: th * 0.94, seg: 8, c: th * 0.24,
      });
    } else {
      cylG(m, {
        mat4: child(joint, 0, 0, len + th2 * 0.18),
        r0: th2 * 0.56, r1: th2 * 0.30, len: th2 * 0.44,
        seg: 8, c: th2 * 0.26,
      });
    }

    if (s === 0 && o.pad) {
      m.use('pad');
      boxG(m, {
        mat4: child(joint, 0, th * 0.56, len * 0.44),
        w: th * 1.08, h: th * 0.34, d: len * 0.76,
        c: 0.0008, simple: true,
      });
    }
    // A pad on the middle phalanx as well as the proximal was tried and pulled:
    // four fingers each carrying two pads, seen nearly end-on, merge into a
    // corrugated block. Fingers read from the GAPS between them, so every extra
    // transverse ridge costs more legibility than it buys.
    if (s === 2 && o.tipPad) {
      m.use('pad');
      boxG(m, {
        mat4: child(joint, 0, th * 0.46, len * 0.45),
        w: th * 0.90, h: th * 0.26, d: len * 0.66,
        c: 0.0006, simple: true,
      });
    }
    joint = child(joint, 0, 0, len);
  }
}

/* ------------------------------------------------------------------ sleeve */

/**
 * Glove cuff, closure strap and uniform sleeve running away from a wrist frame
 * along its +Z.
 *
 * TWO RULES, both learned from the round-7 image.
 *
 *   1. IT MUST LEAVE THE FRAME. The previous support sleeve was 162 mm long and
 *      its capped elbow landed at (1137, 971) — inside a 1920x1080 frame. A
 *      capped cone end, seen near-on, is a disc with a rim: the reviewers who
 *      wrote "the rifle floats with nothing gripping it" were looking straight
 *      at that disc and reading it as a length of pipe lying in the level. So
 *      the length here is set to run the elbow off the edge in every pose, and
 *      the far end is left uncapped as a second line of defence.
 *   2. IT MUST NOT BE SMOOTH. A single cone reads as pipe. Two sections with a
 *      few degrees of break between them, a rolled seam at the join, a flared
 *      gauntlet cuff and a closure strap read as a sleeve.
 */
/**
 * A run of fabric folds along a conical sleeve section: a helical bead walked in
 * short segments so each one sits at the *local* cone radius.
 *
 * This is the single most effective anti-pipe measure there is. A cone has one
 * highlight, a straight one, running down its length; fold beads break that into
 * several skewed highlights of different lengths, which is what tells a viewer
 * "cloth over a limb" instead of "tube". Walking the run rather than laying one
 * straight cylinder at the mean radius matters: on a sleeve that goes from 23 mm
 * to 35 mm, a straight fold is 6 mm buried at the wrist and 6 mm airborne at the
 * elbow.
 */
function foldRun(m, base, z0, z1, r0, r1, a0, a1, w) {
  const N = 4;
  for (let i = 0; i < N; i++) {
    const ka = i / N, kb = (i + 1) / N;
    const za = lerp(z0, z1, ka), zb = lerp(z0, z1, kb);
    const ra = lerp(r0, r1, ka), rb = lerp(r0, r1, kb);
    const aa = lerp(a0, a1, ka), ab = lerp(a0, a1, kb);
    const ax = Math.cos(aa) * ra, ay = Math.sin(aa) * ra;
    const bx = Math.cos(ab) * rb, by = Math.sin(ab) * rb;
    const dx = bx - ax, dy = by - ay, dz = zb - za;
    const len = Math.hypot(dx, dy, dz);
    const mx = (ax + bx) * 0.5, my = (ay + by) * 0.5;
    const rm = Math.hypot(mx, my) || 1;
    const f = frameAt(base, mx, my, (za + zb) * 0.5, [dx, dy, dz], [mx / rm, my / rm, 0]);
    cylG(m, { mat4: f, r0: w, r1: w * 0.92, len: len * 1.06, seg: 6, c: w * 0.3,
      capA: false, capB: false });
  }
}

export function forearm(m, wrist, o) {
  const r = o.r;

  /**
   * THE CUFF IS THE JOINT. Without a clearly separated, flared, strapped cuff
   * the sleeve simply continues out of the hand and the whole assembly reads as
   * one tapered object — which is a pipe. So: a flared gauntlet, a thick lip, a
   * dark closure strap over it and a pull tab standing off the silhouette. Four
   * events inside 30 mm, at the one place the viewer needs to be told that a
   * hand ends and an arm begins.
   */
  m.use('glove');
  cylG(m, { mat4: child(wrist, 0, 0, o.cuff * 0.5),
    r0: r * 0.94, r1: r * 1.20, len: o.cuff, seg: 14, c: 0.0016, capA: false });
  cylG(m, { mat4: child(wrist, 0, 0, o.cuff),
    r0: r * 1.24, len: 0.0052, seg: 14, c: 0.0016 });

  // Hook-and-loop closure strap and its pull tab.
  m.use('pad');
  cylG(m, { mat4: child(wrist, 0, 0, o.cuff - 0.0072),
    r0: r * 1.21, len: 0.0104, seg: 14, c: 0.0012 });
  boxG(m, { mat4: child(wrist, r * 1.20, 0, o.cuff - 0.0072, 0, 0, 0.25),
    w: 0.0080, h: 0.0190, d: 0.0116, c: 0.0012, simple: true });

  m.use('sleeve');
  const z0 = o.cuff + 0.0032;
  const half = o.len * 0.38;
  // The forearm TAPERS HARD. A cone whose radius changes by 6% over 300 mm is a
  // pipe by definition; a real sleeved forearm goes from a 21 mm wrist to a
  // 34 mm elbow, and that widening is most of what says "arm" at a glance.
  cylG(m, { mat4: child(wrist, 0, 0, z0 + half * 0.5),
    r0: r * 1.06, r1: r * 1.26, len: half, seg: 14, c: 0.0022, capA: false, capB: false });
  const mid = child(wrist, 0, 0, z0 + half, o.break ?? 0.22, -0.10);
  cylG(m, { mat4: child(mid, 0, 0, (o.len - half) * 0.5),
    r0: r * 1.26, r1: r * 1.62, len: o.len - half, seg: 14, c: 0.0026,
    capA: false, capB: false });
  // Rolled seam at the panel join, a mid-forearm reinforcement band and an
  // elbow pad: three transverse events along the run, so the eye has something
  // to measure the taper against instead of one unbroken sweep.
  cylG(m, { mat4: child(wrist, 0, 0, z0 + half),
    r0: r * 1.30, len: 0.0052, seg: 14, c: 0.0016 });
  /**
   * ONE dark band on the sleeve, not three. Three transverse rubber rings plus
   * five longitudinal folds is a corrugated conduit, which is a *different* wrong
   * answer to the same question the pipe was. The folds do the anti-pipe work;
   * the band's only job is to be the one place the run is interrupted.
   */
  m.use('pad');
  cylG(m, { mat4: child(mid, 0, 0, (o.len - half) * 0.34),
    r0: r * 1.42, len: 0.0070, seg: 14, c: 0.0014 });

  // Fabric folds. Five helical runs at different pitches over both sections, so
  // no two of the highlights they carve are parallel.
  m.use('sleeve');
  const tail = o.len - half;
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + (o.foldPhase ?? 0.4);
    const skew = 0.34 + 0.20 * Math.sin(i * 2.1);
    foldRun(m, wrist, z0 + 0.0030, z0 + half, r * 1.045, r * 1.245, a, a + skew, 0.0028);
    foldRun(m, mid, 0.0030, tail, r * 1.245, r * 1.605, a + skew, a + skew * 2.1, 0.0030);
  }
}
