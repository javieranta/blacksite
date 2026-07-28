import * as THREE from 'three';
import { mergeAll, boxUV, warp, seat, xf } from '../GeoUtil.js';
import { lerp, smoothstep } from '../Rand.js';

/**
 * The sandbag kit. OWNER: props agent.
 *
 * WHAT WAS WRONG (round 5 review, combat.png)
 *   "a row of smooth uniform yellow sausages: each bag is an identical capsule,
 *   evenly spaced, same orientation, no sag, no compression where they stack."
 *   The screenshot backs that up exactly. Three separate causes, all fixed here:
 *
 *   1. NO CONTACT FACES. The bags were superellipses of exponent 2.45-3.05,
 *      which is a *pillow*, not a tamped bag. Pillows touch at a point, so a
 *      stack of them is a stack of separate objects with daylight between the
 *      courses, and the eye reads the whole run as a tube. A filled bag under
 *      load is pressed genuinely FLAT where it meets its neighbours: see
 *      `contact plateau` in sandbagBag, which lerps the crown and the belly onto
 *      real planes across the middle 60% of the width and lets the sides keep
 *      bulging. Now stacked bags interpenetrate on a plane and read as masonry.
 *   2. NO COMPRESSION. Every bag was the same shape at the same uniform scale,
 *      so a bag carrying four courses looked exactly like the one on top. Load
 *      is now expressed per instance with a NON-UNIFORM scale — squashed in y,
 *      spread in x/z to conserve volume — which costs nothing and is the single
 *      biggest readability win in the file. Crown bags get the opposite: a sag
 *      scale plus roll, so the top of a wall slumps.
 *   3. ONE BAG DEEP, ONE ORIENTATION. Every course was stretchers laid
 *      end-to-end, so the wall was 31 cm thick with a smooth extruded profile.
 *      The modules below are two bags deep at the base, alternate stretcher and
 *      HEADER courses (bags turned across the wall, ends showing), batter back
 *      as they rise and step down at the ends.
 *
 * ASSEMBLY
 *   Walls are three pre-authored MODULES — a two-deep parapet, a five-course
 *   battered revetment and an L-shaped emplacement — each a fixed list of local
 *   bag transforms with per-bag yaw / lean / non-uniform scale / colour baked in
 *   at build time. Placement then only has to seat the module on the real
 *   ground, which it does per ground-course bag, so a wall follows a kerb.
 */

/**
 * UV units per metre for the hessian tile.
 *
 * Was 5.6 — a 18 cm tile at 15 threads, i.e. 1.2 cm threads, which is basketry
 * and is why the bags read as woven cane in the round-5 shot. 13.0 puts the tile
 * at 7.7 cm and a thread at 5 mm: still four times coarser than real jute (so it
 * survives mipping at 10 m) but fine enough that at 3 m it reads as cloth.
 */
export const WEAVE_UV = 13.0;

/** Nominal course pitch. Bags overlap ~22%, which is how a real wall is laid. */
export const COURSE_PITCH = 0.118;

/** Along-run pitch for a bag laid long-ways / turned across the wall. */
const STRETCHER = 0.452;
const HEADER = 0.322;

const BAG_SPECS = [
  /*
   * Three genuinely different bags, not three seeds of one bag.
   *   L/H/W  metres once tamped.
   *   n      superellipse exponent: 2 is an ellipse, 4 is nearly a box.
   *   flat   how hard the crown and belly are pressed onto a plane (0..1). This
   *          is the contact face; it is what makes a stack look stacked.
   *   slump  biases the fullest part of the bulge downward.
   *   bend   banana in the horizontal plane.
   */
  // 0 — the standard stretcher: long, low, firmly tamped, hard flats.
  { L: 0.540, H: 0.152, W: 0.300, slump: 0.10, bend: 0.026, tie: 1, n: 3.30, flat: 0.80 },
  // 1 — over-filled and round-shouldered: short, deep, soft flats, big belly.
  { L: 0.442, H: 0.196, W: 0.352, slump: 0.26, bend: -0.024, tie: -1, n: 2.75, flat: 0.52 },
  // 2 — half-empty and floppy: long, thin, drawn-in ends, very flat faces.
  { L: 0.585, H: 0.124, W: 0.286, slump: 0.05, bend: 0.056, tie: 1, n: 3.70, flat: 0.88 },
];

export const BAG_VARIANTS = BAG_SPECS.length;

/**
 * One sandbag. 124 triangles.
 *
 * 5x2x3 segments is the budget decision: a sandbag casts into four shadow
 * cascades plus the main pass, so every triangle here is spent five times and a
 * revetment is ~39 bags. Four rows across the width is the minimum that lets the
 * plateau be genuinely flat with a chamfer outboard of it; three rows up the
 * side carry the belly. Everything finer is the weave normal map's job.
 *
 * @param {import('../Rand.js').Rand} rng
 * @param {number} variant 0..2
 */
export function sandbagBag(rng, variant) {
  const s = BAG_SPECS[variant % BAG_SPECS.length];
  const L = s.L * rng.range(0.97, 1.03);
  const H = s.H * rng.range(0.95, 1.05);
  const W = s.W * rng.range(0.97, 1.03);
  const n = s.n;
  const invN = 1 / n;

  const geo = new THREE.BoxGeometry(1, 1, 1, 5, 2, 3);
  const p = geo.attributes.position;

  for (let k = 0; k < p.count; k++) {
    const u = p.getX(k) * 2;              // -1..1 along the length
    let v = p.getY(k) * 2;                // -1..1 up
    const w = p.getZ(k) * 2;              // -1..1 across
    const au = Math.abs(u);

    // A filled bag settles: compress the crown, let the belly hang.
    v = v >= 0 ? v * (1 - s.slump) : v * (1 + s.slump * 0.45);
    const av = Math.abs(v), aw = Math.abs(w);

    // Superellipse cross-section in the (width, height) plane. m is the point's
    // square-radius, so interior vertices scale linearly and only the boundary
    // is bent.
    const m = Math.max(av, aw);
    let t = 1;
    if (m > 1e-6) {
      t = m / Math.pow(Math.pow(aw, n) + Math.pow(av, n), invN);
    }

    // Ends draw in; the sewn/tied end draws in harder than the folded one.
    const tied = (u * s.tie > 0) ? 1 : 0;
    const taper = 1 - (0.30 + tied * 0.20) * smoothstep(0.30, 1.0, au);

    const x = u * 0.5 * L;
    let y = v * t * 0.5 * H * lerp(1, 0.86, tied * smoothstep(0.5, 1, au));
    let z = w * t * 0.5 * W * taper;
    y *= lerp(1, taper, 0.55);

    /*
     * THE CONTACT PLATEAU. Across the middle of the width, and away from the
     * ends, the crown and the belly are pulled onto real horizontal planes.
     * `band` is 1 over the central 45% of the width and falls to 0 by the
     * shoulder, and it fades out over the last 45% of the length so the ends
     * stay rounded. The result is a bag with a flat top, a flat bottom, bulging
     * sides and rounded ends — which is what a tamped bag is, and what lets two
     * of them interpenetrate along a plane instead of kissing at a point.
     */
    const band = (1 - smoothstep(0.45, 0.97, aw)) * (1 - smoothstep(0.55, 1.0, au));
    if (band > 0 && av > 0.05) {
      const plane = Math.sign(v) * 0.5 * H
        * (v >= 0 ? (1 - s.slump) : (1 + s.slump * 0.45))
        * lerp(1, taper, 0.55);
      y = lerp(y, plane, band * s.flat);
    }

    // Stitched welt along the two long top edges — the single detail that most
    // sells "sewn sack" at 3 m, and it survives being a normal-mapped surface.
    if (aw > 0.92 && av > 0.86) {
      z += Math.sign(w) * 0.0105;
      y -= Math.sign(v) * 0.0045;
    }
    // The crown dips very slightly between the bags underneath.
    if (v > 0.2) y -= 0.005 * (1 - au * au);

    // banana bend
    z += s.bend * (1 - u * u) * 0.5;
    y -= Math.abs(s.bend) * 0.22 * u * u;

    p.setXYZ(k, x, y, z);
  }
  p.needsUpdate = true;
  geo.computeVertexNormals();
  // Warp AFTER the normals so the shading stays soft while the silhouette gains
  // the lumpiness of loose fill. Amplitude is deliberately tiny — 6 mm — and it
  // is damped on the flats so the contact faces stay contact faces.
  warp(geo, 0.009, 7, rng.int(1, 9999));
  boxUV(geo, WEAVE_UV);
  weatherBag(geo, rng);
  return seat(geo);
}

/**
 * Bake dust, damp and blotching into the bag as VERTEX COLOUR.
 *
 * WHY VERTEX COLOUR AND NOT MORE INSTANCE TINTS
 *   instanceColor is one multiplier for the whole bag, so it can make bag A
 *   different from bag B but it cannot make the TOP of a bag different from its
 *   underside — and that is the cue the round-5 wall was missing. A real
 *   revetment is pale and chalky where the dust has settled on every upward
 *   face, and two stops darker in the shaded belly where it never dries. Without
 *   that the run reads as one moulded object no matter how the instances are
 *   tinted, because every bag has the same flat value across its whole surface.
 *
 *   three multiplies vertexColor AND instanceColor into the same diffuse term,
 *   so the two compose for free: this function owns the within-bag variation,
 *   placeWallModule owns the bag-to-bag variation.
 */
function weatherBag(geo, rng) {
  const pos = geo.attributes.position;
  const nrm = geo.attributes.normal;
  if (!pos || !nrm) return geo;
  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  const span = Math.max(1e-4, bb.max.y - bb.min.y);
  const col = new Float32Array(pos.count * 3);
  const ph = rng.range(0, Math.PI * 2);

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const up = Math.max(0, nrm.getY(i));
    const h = Math.min(1, Math.max(0, (y - bb.min.y) / span));

    // Dust settles on whatever faces the sky, and the crown collects the most.
    const dust = Math.pow(up, 1.5) * (0.30 + 0.70 * h);
    // The belly is permanently damp, shaded and dirt-splashed.
    const wet = (1 - h) * (1 - h) * (1 - up * 0.65);
    // Low-frequency blotching: slumped fill, patched dirt, uneven sun bleach.
    const blot = Math.sin(x * 9.3 + ph) * Math.sin(z * 11.7 - ph * 0.7)
      * Math.sin(y * 6.1 + ph * 1.9);
    const stain = blot * 0.065;

    col[i * 3] = 1 + 0.370 * dust - 0.250 * wet + stain;
    col[i * 3 + 1] = 1 + 0.330 * dust - 0.230 * wet + stain * 0.88;
    col[i * 3 + 2] = 1 + 0.235 * dust - 0.185 * wet + stain * 0.66;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}

/**
 * A loose heap of bags dumped rather than laid — a bagged-goods pile, not a
 * wall. The old version stacked 3-4 bags on a 10 cm vertical pitch with almost
 * no lateral spread, which produced the vertical caterpillar visible in the
 * round-5 shot. A dumped heap is WIDE: a base ring of four or five lying flat
 * and splayed, then two or three thrown on top at large angles.
 */
export function sandbagHeap(rng) {
  const parts = [];
  const base = rng.int(4, 5);
  for (let i = 0; i < base; i++) {
    const a = (i / base) * Math.PI * 2 + rng.jit(0.5);
    const r = rng.range(0.13, 0.26);
    const g = sandbagBag(rng.fork(70 + i), rng.int(0, BAG_VARIANTS - 1));
    xf(g,
      Math.cos(a) * r, rng.range(0, 0.012), Math.sin(a) * r,
      rng.jit(0.10), a + Math.PI / 2 + rng.jit(0.45), rng.jit(0.14),
      rng.range(0.94, 1.06), rng.range(0.88, 0.96), rng.range(1.02, 1.10));
    parts.push(g);
  }
  const top = rng.int(2, 3);
  for (let i = 0; i < top; i++) {
    const g = sandbagBag(rng.fork(90 + i), rng.int(0, BAG_VARIANTS - 1));
    xf(g,
      rng.jit(0.15), 0.108 + rng.range(0, 0.02), rng.jit(0.14),
      rng.jit(0.22), rng.range(0, Math.PI * 2), rng.jit(0.26),
      rng.range(0.95, 1.05), rng.range(0.86, 0.98), rng.range(1.0, 1.08));
    parts.push(g);
  }
  return seat(mergeAll(parts));
}

/* ========================================================================= */
/*                              WALL MODULES                                 */
/* ========================================================================= */

/**
 * Lay one course.
 *
 * Local +X runs along the wall, +Z is its depth (the batter), y is up.
 *
 * @param {object} o
 *   n        bags in the course
 *   y        course height
 *   depth    lateral offset from the wall centreline — a course laid at
 *            -0.15 and again at +0.15 is a wall two bags thick
 *   run      offset along the run; half a pitch staggers the bond
 *   header   0 = all stretchers, 1 = all headers, 0.5 = mixed. A header shows
 *            the bag's END to the front, which is the single thing that stops a
 *            multi-course wall reading as extruded corduroy.
 *   squash   vertical load compression (0.86 = carrying four courses)
 *   sag      crown slump: extra squash plus roll, for the top of a stack
 *   endStep  bags at the ends of the course sink, so a run tapers off
 */
function course(out, rng, {
  n, y, depth = 0, run = 0, header = 0, axis = 'x', corner = 0,
  squash = 1, sag = 0, endStep = 0, damp = 0,
}) {
  if (n <= 0) return;
  // Walk a cursor so header and stretcher bags can share a course at their own
  // pitches, then centre the whole run.
  const slot = [];
  let cursor = 0;
  for (let i = 0; i < n; i++) {
    const isHeader = header >= 1 ? true : (header > 0 && rng.bool(header));
    const pitch = isHeader ? HEADER : STRETCHER;
    cursor += pitch * 0.5;
    slot.push({ t: cursor, isHeader });
    cursor += pitch * 0.5 + rng.range(-0.014, 0.022);
  }
  const half = cursor * 0.5;

  for (let i = 0; i < n; i++) {
    const { t: raw, isHeader } = slot[i];
    const t = raw - half + run;
    // Volume is conserved: a bag squashed in y spreads in x and z.
    const load = squash * (1 - sag * rng.range(0.10, 0.20));
    const spread = 1 + (1 - load) * 0.85;
    const size = rng.range(0.92, 1.08);          // +/-8% per bag, as briefed
    // 6% of bags are cocked well out of line — a real wall always has a few.
    const cocked = rng.bool(0.06);
    const edge = endStep * (i === 0 || i === n - 1 ? 1 : 0);
    /*
     * Damp climbs the wall from the ground up, independently of whatever the
     * course itself declares: rain splash and wicking do not care which course
     * a bag belongs to, they care how close to the puddle it is. Two courses is
     * about 24 cm, which is where a real revetment's tide line sits.
     */
    const rise = Math.max(0, 1 - y / (COURSE_PITCH * 2.6));

    const jx = rng.jit(0.018), jz = rng.jit(0.015);
    const along = axis === 'x'
      ? { x: t + jx, z: depth + jz }
      : { x: depth + jz + corner, z: t + jx };

    push(out, {
      v: rng.int(0, BAG_VARIANTS - 1),
      x: along.x,
      y: y - edge * 0.055,
      z: along.z,
      yaw: (isHeader ? Math.PI / 2 : 0)
        + (axis === 'z' ? Math.PI / 2 : 0)
        + rng.jit(0.14) + (cocked ? rng.jit(0.42) : 0),
      pitch: rng.jit(0.055) + (cocked ? rng.jit(0.10) : 0),
      roll: rng.jit(0.045) + sag * rng.jit(0.16),
      sx: size * (1 + (spread - 1) * 0.55) * (1 + sag * 0.06),
      sy: size * load,
      sz: size * spread,
      hue: rng.int(0, BAG_TINTS.length - 1),
      // Bags at the foot of a wall are damp and dirt-splashed; crown bags are
      // sun-bleached. One multiplier, and the wall stops being one colour.
      dark: 1 - damp * rng.range(0.6, 1.0) + (sag > 0 ? rng.range(0.02, 0.07) : 0),
      rise,
      course: (y / COURSE_PITCH + 0.001) | 0,
      ground: y < 0.001,
    });
  }
}

/**
 * File a finished bag record.
 *
 * `odd` — the one-in-eleven bag that came out of a different pallet: a blue
 * polypropylene sack, a soot-black one, red spoil rather than sand. A run of
 * identical hessian is the tell; the odd bag out is what breaks it. It is drawn
 * from the bag's own hash rather than from `rng` on purpose: the module fork
 * feeds every module's footprint, and a footprint that changes re-rolls the
 * occupancy grid and with it the composition of the whole level.
 */
function push(out, bag) {
  bag.odd = bagHash(bag, 5) < 0.09 ? (bagHash(bag, 6) * BAG_ODDITIES.length) | 0 : -1;
  // Damp wicks up from the ground independently of which course a bag is in —
  // see `rise` in course(). Same reasoning as `odd` for using the hash.
  if (bag.rise) bag.dark *= 1 - 0.15 * bag.rise * (0.55 + bagHash(bag, 7) * 0.45);
  out.push(bag);
  return bag;
}

/** A couple of bags knocked off the top, lying at the foot of the wall. */
function spill(out, rng, { count, halfX, side = -1 }) {
  for (let i = 0; i < count; i++) {
    push(out, {
      v: rng.int(0, BAG_VARIANTS - 1),
      x: rng.range(-halfX, halfX), y: 0, z: side * rng.range(0.40, 0.78),
      yaw: rng.range(0, Math.PI * 2), pitch: rng.jit(0.26), roll: rng.jit(0.42),
      sx: rng.range(0.94, 1.06), sy: rng.range(0.86, 0.96), sz: rng.range(1.0, 1.10),
      hue: rng.int(0, BAG_TINTS.length - 1),
      // A bag lying in the puddle at the foot of the wall is the wettest thing
      // in the shot.
      dark: rng.range(0.66, 0.80),
      course: 0, ground: true,
    });
  }
}

function finish(name, bags) {
  let maxX = 0, maxZ = 0, maxY = 0;
  for (const b of bags) {
    maxX = Math.max(maxX, Math.abs(b.x) + 0.30);
    maxZ = Math.max(maxZ, Math.abs(b.z) + 0.24);
    maxY = Math.max(maxY, b.y);
  }
  return { name, bags, radius: Math.hypot(maxX, maxZ), halfX: maxX, halfZ: maxZ, height: maxY + 0.16 };
}

/**
 * Waist-high parapet, two bags deep at the base. Three courses: a paired
 * stretcher base, a mixed course that ties the two rows together, and a sagging
 * crown.
 */
function parapet(rng) {
  const bags = [];
  const n = rng.int(6, 8);
  const P = COURSE_PITCH;
  course(bags, rng, { n, y: 0, depth: -0.152, squash: 0.90, damp: 0.16 });
  course(bags, rng, { n: n - 1, y: 0, depth: 0.156, run: STRETCHER * 0.5, squash: 0.90, damp: 0.18 });
  course(bags, rng, { n: Math.round(n * 1.15), y: P, depth: 0.004, header: 0.55, squash: 0.94, endStep: 1 });
  course(bags, rng, { n: n - 1, y: P * 2, depth: 0.018, run: STRETCHER * 0.5, squash: 0.99, sag: 1, endStep: 1 });
  spill(bags, rng, { count: rng.int(1, 2), halfX: n * 0.2 });
  return finish('parapet', bags);
}

/**
 * Five-course battered revetment, two bags deep for the bottom four courses.
 * Chest-high cover and the piece that reads instantly as a defended position.
 */
function revetment(rng) {
  const bags = [];
  const n = rng.int(5, 7);
  const P = COURSE_PITCH;
  // paired stretcher base
  course(bags, rng, { n, y: 0, depth: -0.158, squash: 0.86, damp: 0.22 });
  course(bags, rng, { n: n - 1, y: 0, depth: 0.160, run: STRETCHER * 0.5, squash: 0.86, damp: 0.24 });
  // header course ties the two rows and breaks the vertical repeat
  course(bags, rng, { n: Math.round(n * 1.45), y: P, depth: 0.012, header: 1, squash: 0.89, damp: 0.12 });
  // second pair, battered back
  course(bags, rng, { n: n - 1, y: P * 2, depth: -0.128, run: STRETCHER * 0.5, squash: 0.92, damp: 0.05 });
  course(bags, rng, { n: n - 2, y: P * 2, depth: 0.150, squash: 0.92, damp: 0.06 });
  // second header, battered further
  course(bags, rng, { n: Math.round((n - 1) * 1.4), y: P * 3, depth: 0.030, header: 1, squash: 0.96, endStep: 1 });
  // sagging crown
  course(bags, rng, { n: n - 2, y: P * 4, depth: 0.046, run: STRETCHER * 0.5, squash: 1.0, sag: 1, endStep: 1 });
  spill(bags, rng, { count: rng.int(1, 3), halfX: n * 0.22 });
  return finish('revetment', bags);
}

/**
 * L-shaped emplacement — a firing position rather than a fence. The long leg is
 * two deep for its bottom course; the short leg stays single so the corner does
 * not turn into a blockhouse.
 */
function emplacement(rng) {
  const bags = [];
  const nA = rng.int(4, 5), nB = rng.int(3, 4);
  const P = COURSE_PITCH;
  const cornerX = (nA - 1) * STRETCHER * 0.5 + 0.24;
  const runB = -(nB - 1) * STRETCHER * 0.5 - 0.34;

  course(bags, rng, { n: nA, y: 0, depth: -0.150, squash: 0.88, damp: 0.20 });
  course(bags, rng, { n: nA - 1, y: 0, depth: 0.152, run: STRETCHER * 0.5, squash: 0.88, damp: 0.22 });
  course(bags, rng, { n: nB, y: 0, depth: 0, run: runB, axis: 'z', corner: cornerX, squash: 0.88, damp: 0.20 });

  course(bags, rng, { n: Math.round(nA * 1.4), y: P, depth: 0.004, header: 1, squash: 0.92 });
  course(bags, rng, { n: nB, y: P, depth: 0, run: runB + STRETCHER * 0.5, axis: 'z', corner: cornerX, squash: 0.92, header: 0.4 });

  course(bags, rng, { n: nA - 1, y: P * 2, depth: 0.020, run: STRETCHER * 0.5, squash: 0.98, sag: 1, endStep: 1 });
  course(bags, rng, { n: nB - 1, y: P * 2, depth: 0.020, run: runB, axis: 'z', corner: cornerX, squash: 0.98, sag: 1, endStep: 1 });
  spill(bags, rng, { count: 1, halfX: nA * 0.2 });
  return finish('emplacement', bags);
}

export function buildWallModules(rng) {
  return [parapet(rng.fork(11)), revetment(rng.fork(12)), emplacement(rng.fork(13))];
}

/* ========================================================================= */
/*                              PLACEMENT                                    */
/* ========================================================================= */

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();
const _IDENT = new THREE.Quaternion();

/**
 * Instance-colour multipliers: sun-bleached sand through to damp, dirty olive.
 * All below 1.0 — under a golden key anything brighter blows out to cream, which
 * is half of why the round-4 bags read as blocks of butter. Two grey-olive
 * entries were added in round 5 so a wall is not one hue at five values.
 */
export const BAG_TINTS = [
  new THREE.Color(0xd6c9a8), new THREE.Color(0xbcae8c),
  new THREE.Color(0xa89e7f), new THREE.Color(0x968b6d),
  new THREE.Color(0xb6ad85), new THREE.Color(0xa39a78),
  new THREE.Color(0x94896c),
];

/**
 * The odd bag out. A defended position is not built from one delivery: there is
 * always a blue polypropylene sack from a builders' merchant, one filled with
 * red spoil instead of sand, one that has been in a fire. These are picked for
 * roughly one bag in eleven and they are what stops a wall reading as a single
 * moulded object even before the value variation is counted.
 */
export const BAG_ODDITIES = [
  new THREE.Color(0x8d99a4),   // faded UN-blue woven polypropylene
  new THREE.Color(0x6d6a5f),   // soot-blackened
  new THREE.Color(0xa8785a),   // filled with red spoil, not sand
  new THREE.Color(0xdcd6c2),   // fresh cement-white sack
  new THREE.Color(0x79835f),   // olive-drab issue bag
];

const _tint = new THREE.Color();

/**
 * Deterministic 0..1 from a bag's own identity.
 *
 * The hue jitter deliberately does NOT draw from the caller's Rand. That stream
 * is the shared dressing stream — every subsequent site, litter knot and kerb
 * drift in the level is downstream of it — so spending two extra numbers per
 * sandbag would silently re-roll the entire level's composition. Hashing the
 * bag's own position instead keeps the jitter per-bag, stable and free.
 */
function bagHash(b, salt = 0) {
  const s = Math.sin(b.x * 127.1 + b.z * 311.7 + (b.course ?? 0) * 74.7
    + (b.hue ?? 0) * 19.3 + salt * 53.9) * 43758.5453;
  return s - Math.floor(s);
}

/**
 * Per-bag albedo: pick the sack, apply its damp/bleach multiplier, then jitter
 * hue and value by +/-8%. The hue term swings warm (dust, rust) against cool
 * (damp, shade) rather than sliding around the wheel, because a wall of bags
 * that differ in HUE at the same value still reads as one object, and a colour
 * wheel of sandbags reads as a bug.
 *
 * @param {object} b      bag record
 * @param {number} jitter one value from the caller's stream, ~0.93..1.05
 */
function bagAlbedo(b, jitter) {
  _tint.copy(b.odd >= 0
    ? BAG_ODDITIES[b.odd % BAG_ODDITIES.length]
    : BAG_TINTS[b.hue % BAG_TINTS.length]);
  const value = b.dark * jitter * (0.92 + bagHash(b, 1) * 0.16);
  const warm = (bagHash(b, 2) * 2 - 1) * 0.08;
  return _tint.setRGB(
    Math.max(0.02, _tint.r * value * (1 + warm)),
    Math.max(0.02, _tint.g * value * (1 + warm * 0.22)),
    Math.max(0.02, _tint.b * value * (1 - warm * 0.92)),
  );
}

/**
 * Seat a wall module on the probed world and emit its bags.
 *
 * Every bag in the ground course is raycast individually, so the wall follows
 * whatever it is standing on; upper courses ride on the course below. If more
 * than a third of the ground course finds no support the whole module is
 * refused — a wall that half-floats is worse than no wall.
 *
 * @returns {boolean} true if the module was placed
 */
export function placeWallModule(api, mod, x, z, yaw, { keys, groundFlag = 1 } = {}) {
  const { probe, placer, batcher, rng } = api;
  if (!keys || !keys.length) return false;

  const base = probe.ground(x, z, placer.floorHint);
  if (!base) return false;
  if (!probe.isFree(x, z, Math.min(1.5, mod.radius * 0.4))) return false;

  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const worldOf = (lx, lz, out) => out.set(x + lx * cy + lz * sy, 0, z - lx * sy + lz * cy);

  // Support survey along the run before committing anything. A wall is allowed
  // to run off the end of its support by one probe — the ground course is
  // seated per bag and any bag with no floor under it is simply not emitted, so
  // a short wall is a correct outcome; only a wall with no ground at all is not.
  let probes = 0, ok = 0;
  for (let i = -2; i <= 2; i++) {
    worldOf((i / 2) * mod.halfX * 0.85, 0, _v);
    const h = probe.ground(_v.x, _v.z, base.point.y + 1.2);
    probes++;
    if (h && Math.abs(h.point.y - base.point.y) < 0.40) ok++;
  }
  if (ok < probes - 2) return false;

  // Ground heights per bag, then emit.
  let emitted = 0;
  for (const b of mod.bags) {
    worldOf(b.x, b.z, _v);
    let gy = base.point.y;
    if (b.ground) {
      const h = probe.ground(_v.x, _v.z, base.point.y + 1.0);
      if (!h || Math.abs(h.point.y - base.point.y) > 0.32) continue;
      gy = h.point.y - 0.016;
    }
    const key = keys[b.v % keys.length];
    if (!key) continue;

    _e.set(b.pitch, yaw + b.yaw, b.roll);
    _q.setFromEuler(_e);
    if (base.normal && base.normal.y < 0.999) {
      _q2.setFromUnitVectors(_s.set(0, 1, 0), base.normal);
      _q2.slerp(_IDENT, 0.62);                    // partial slope alignment (~38%)
      _q.premultiply(_q2);
    }
    _s.set(b.sx, b.sy, b.sz);
    _v.y = gy + b.y;
    _m.compose(_v, _q, _s);

    batcher.add(key, _m, 1, bagAlbedo(b, rng.range(0.93, 1.05)), b.ground ? groundFlag : 0);
    if (b.ground) {
      placer.placed.push({ key, x: _v.x, y: _v.y, z: _v.z, r: 0.26, snapped: false, matrix: _m.clone() });
    }
    emitted++;
  }
  if (!emitted) return false;

  // Claim the footprint so nothing else lands inside the wall.
  for (let i = -1; i <= 1; i++) {
    worldOf(i * mod.halfX * 0.6, 0, _v);
    probe.claim(_v.x, _v.z, Math.max(0.45, mod.halfX * 0.42));
  }
  return true;
}

/**
 * Vertical stack helper for putting a couple of bags on top of a barrier or a
 * roof parapet. Contact height comes from the caller, so no probing is done.
 * The bags are squashed and splayed like the wall bags so the two kits never
 * look like different props.
 */
export function bagsOnTop(api, keys, x, y, z, yaw, count, flags = 0) {
  const { batcher, rng } = api;
  if (!keys?.length) return 0;
  let made = 0;
  for (let i = 0; i < count; i++) {
    const key = keys[rng.int(0, keys.length - 1)];
    _e.set(rng.jit(0.07), yaw + rng.jit(0.30), rng.jit(0.07));
    _q.setFromEuler(_e);
    const size = rng.range(0.93, 1.07);
    _s.set(size * 1.03, size * rng.range(0.86, 0.94), size * 1.08);
    _v.set(x + (i - (count - 1) / 2) * 0.44 + rng.jit(0.03), y + 0.004, z + rng.jit(0.03));
    _m.compose(_v, _q, _s);
    // Exactly two draws from the caller's stream, as before — see bagHash.
    const hue = rng.int(0, BAG_TINTS.length - 1);
    const jitter = rng.range(0.9, 1.05);
    const rec = { x: _v.x, z: _v.z, course: i, hue, odd: -1, dark: 1 };
    if (bagHash(rec, 3) < 0.1) rec.odd = (bagHash(rec, 4) * BAG_ODDITIES.length) | 0;
    batcher.add(key, _m, 1, bagAlbedo(rec, jitter), flags);
    made++;
  }
  return made;
}
