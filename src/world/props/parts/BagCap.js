import { bagsOnTop, COURSE_PITCH } from './Sandbags.js';

/**
 * PLACEHOLDER SANDBAG REPLACEMENT. OWNER: props agent.
 *
 * WHAT THIS IS FOR
 *   The round-7 review said the sandbag emplacement in the hero shots "reads as
 *   one smooth pale mass â€” a row of uniform light lumps with no bag boundaries,
 *   no fabric, no sag and one flat colour". Round 8 raycast the offending pixels
 *   to find out which mesh that actually is:
 *
 *     pixel (945,522)  -> `court|fabric|111` at (9.56, 1.42, 23.13)
 *     pixel (1002,516) -> `court|fabric|111` at (8.76, 1.51, 23.46)
 *
 *   Those are `src/world/level/Compound.js`, buildCourtyard(): three
 *   `THREE.SphereGeometry(0.54, 12, 7)` blobs scaled to (1.02, 0.42, 0.90) on
 *   top of each of the three concrete revetments. A 1.1 m squashed sphere in the
 *   `fabric` material. They are LEVEL geometry.
 *
 *   Props already owns a full sandbag kit â€” three tamped bag variants with
 *   contact plateaus, per-bag yaw, load compression, crown sag, damp wicking, an
 *   odd-sack-in-eleven and a forge hessian weave (see parts/Sandbags.js). None of
 *   it was anywhere near the hero frame: an instance dump from the hero camera
 *   showed 331 props sandbags in the level and ZERO on screen, because
 *   coverForCamera sites its walls behind the eye. So every reviewer who looked
 *   at a sandbag in this project was looking at the level's placeholder blobs and
 *   grading the props kit for it.
 *
 * WHAT IT DOES
 *   Props does not edit the level. It dresses it. A concrete revetment coping
 *   with a bag-shaped blob on it is a parapet that has been sketched, so this
 *   pass lays a REAL parapet over it: courses of the actual kit's bags on the
 *   real pitch, deep enough and one course higher than the blob, so the blob ends
 *   up inside the bag mass instead of being the visible surface.
 *
 *   The blobs are found by measurement, not by coordinate: the world float audit
 *   already clusters every level triangle into islands, so this only has to ask
 *   which islands are (a) `fabric`, (b) the size and proportion of a filled bag,
 *   (c) resting on something at parapet height. If the level replaces them with
 *   real bags this pass finds nothing and does nothing, which is the correct
 *   behaviour in both directions.
 *
 * Draw calls: zero. Every bag is an instance of an existing sandbag prototype.
 */

/** Lateral pitch between rows of bags across the wall. Bags are 0.30 wide. */
const ROW_PITCH = 0.255;
/** Along-run pitch. bagsOnTop's default 0.38 already overlaps neighbours ~16%. */
const RUN_PITCH = 0.38;
/** Blobs whose boxes are within this of each other are one parapet run. */
const JOIN = 0.85;
/** How far a laid course may hang over the edge of what carries it. */
const OVERHANG = 0.19;
/** Tamped bag dimensions, from BAG_SPECS in Sandbags.js. */
const BAG_L = 0.52;
const BAG_W = 0.31;
const BAG_H = 0.15;
/** Courses are capped so a mis-detected blob cannot grow a tower of bags. */
const MAX_COURSES = 6;
const MAX_ROWS = 5;

/** Is this island the level's sketch of a sandbag parapet? */
function isBagBlob(c) {
  if (!c.fabric || !c.pts || c.pts.length < 30) return false;
  const dx = c.max[0] - c.min[0], dy = c.max[1] - c.min[1], dz = c.max[2] - c.min[2];
  const wide = Math.max(dx, dz), narrow = Math.min(dx, dz);
  /*
   * A single filled bag is 0.3-0.6 m. A SKETCHED emplacement is one blob standing
   * in for several, and the courtyard's three overlapping blobs weld into one
   * island 2.95 m long, so the window has to run to 4 m. Flatter than 0.15 m is a
   * tarpaulin; taller than 0.85 m is a sack standing on end, not a bag lying down;
   * and a real bag kit has far more than 600 triangles per 3 m of wall, so the
   * triangle ceiling is what distinguishes a placeholder from the real thing and
   * makes this pass a no-op once the level stops sketching.
   */
  if (wide < 0.45 || wide > 4.0) return false;
  if (narrow < 0.28) return false;
  if (dy < 0.15 || dy > 0.85) return false;
  if (dy > narrow * 1.4) return false;
  if (c.tris > 600) return false;
  // Parapet height: on a barrier, a revetment, a block or a window ledge.
  return c.min[1] > 0.25 && c.min[1] < 2.4;
}

/**
 * Principal horizontal axis of an island, from its own triangle centroids.
 *
 * The three revetments are yawed 0.36, -0.22 and -0.30 rad. Taking the run
 * direction from the axis-aligned bounding box instead walks the bags diagonally
 * off the end of the coping, which is a worse defect than the one being fixed.
 * @returns {{yaw:number, along:number, across:number, cx:number, cy:number, cz:number}}
 */
function principal(c) {
  const p = c.pts;
  const n = p.length / 3;
  let mx = 0, mz = 0;
  for (let i = 0; i < p.length; i += 3) { mx += p[i]; mz += p[i + 2]; }
  mx /= n; mz /= n;
  let sxx = 0, szz = 0, sxz = 0;
  for (let i = 0; i < p.length; i += 3) {
    const ax = p[i] - mx, az = p[i + 2] - mz;
    sxx += ax * ax; szz += az * az; sxz += ax * az;
  }
  const theta = 0.5 * Math.atan2(2 * sxz, sxx - szz);
  const ux = Math.cos(theta), uz = Math.sin(theta);
  // exact extents along and across the axis
  let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
  for (let i = 0; i < p.length; i += 3) {
    const ax = p[i] - mx, az = p[i + 2] - mz;
    const a = ax * ux + az * uz;
    const b = -ax * uz + az * ux;
    if (a < a0) a0 = a; if (a > a1) a1 = a;
    if (b < b0) b0 = b; if (b > b1) b1 = b;
  }
  // bagsOnTop advances along (cos yaw, -sin yaw), hence the negated angle
  return {
    yaw: -theta,
    along: a1 - a0,
    across: b1 - b0,
    cx: mx + ((a0 + a1) * 0.5) * ux - ((b0 + b1) * 0.5) * uz,
    cz: mz + ((a0 + a1) * 0.5) * uz + ((b0 + b1) * 0.5) * ux,
    cy: 0,
  };
}

/**
 * How far the thing the blob is standing on actually extends, measured in the
 * blob's own axis frame.
 *
 * Sizing the parapet from the blob alone gets it wrong in both directions: fit it
 * to the blob and the blob's rounded ends stick out past the last bag; fit it
 * around the blob and the outer course cantilevers over thin air. The coping is
 * the only thing that knows how wide the wall may be, so this asks it by raycast
 * — which also means the parapet follows a barrier, a block or a ledge of any
 * size without being told what it is standing on.
 *
 * @returns {{a0:number, a1:number, b0:number, b1:number}} extents in metres,
 *   relative to the blob's centre, along (a) and across (b) the run
 */
function measureSupport(probe, ax, baseY, need) {
  const ux = Math.cos(-ax.yaw), uz = Math.sin(-ax.yaw);   // along
  const vx = -uz, vz = ux;                                // across
  /*
   * The acceptance band is generous ABOVE the island's own base on purpose: the
   * level's blobs are half sunk into their coping, so the coping top (1.354 m
   * here) sits well above the blob's bounding-box base (1.18 m). A band of
   * +0.14 m rejected every sample and the whole pass silently collapsed to two
   * bags per course, which is exactly the kind of quiet failure this project has
   * been bitten by before.
   */
  const from = baseY + 0.62;
  const lo = baseY - 0.34, hi = baseY + 0.58;
  let topSum = 0, topN = 0;
  const supported = (a, b) => {
    const x = ax.cx + a * ux + b * vx;
    const z = ax.cz + a * uz + b * vz;
    const h = probe.ground(x, z, from);
    if (!h || h.point.y <= lo || h.point.y >= hi) return false;
    topSum += h.point.y; topN++;
    return true;
  };
  // Walk out from the centre in 6 cm steps and stop at the first gap. Three
  // lateral samples per step, so a chamfered coping edge does not read as solid.
  const reach = (dir, axis) => {
    let last = 0;
    for (let t = 0.06; t <= 2.4; t += 0.06) {
      const d = dir * t;
      const ok = axis === 'a'
        ? supported(d, 0) && supported(d, need.b * 0.30) && supported(d, -need.b * 0.30)
        : supported(0, d) && supported(need.a * 0.30, d) && supported(-need.a * 0.30, d);
      if (!ok) break;
      last = d;
    }
    return last;
  };
  const out = {
    a0: reach(-1, 'a'), a1: reach(1, 'a'),
    b0: reach(-1, 'b'), b1: reach(1, 'b'),
  };
  // The height the bags actually stand on, not the blob's sunk-in box base.
  out.y = topN ? topSum / topN : baseY;
  return out;
}

/**
 * @param {object} api the props dressing api ({ batcher, rng, protos })
 * @param {Array<object>} islands fabric-only islands from the world float audit
 * @returns {{runs:number, blobs:number, bags:number}}
 */
export function capPlaceholderBags(api, islands) {
  const keys = api.protos?.bagKeys;
  const out = { runs: 0, blobs: 0, bags: 0 };
  if (!keys?.length || !islands?.length) return out;
  const { rng } = api;

  for (const c of islands) {
    if (!isBagBlob(c)) continue;
    out.blobs++;
    const ax = principal(c);
    /*
     * Bag CENTRES span the support minus one bag, so the outer bag's EDGE lands
     * on the edge of the coping: no cantilever, and no rounded end of the
     * placeholder blob left sticking out past the last bag.
     */
    const sup = measureSupport(api.probe, ax, c.min[1], { a: ax.along, b: ax.across });
    const supA = sup.a1 - sup.a0, supB = sup.b1 - sup.b0;
    /*
     * The PCA extents come from triangle CENTROIDS, which sit inside the surface,
     * so they under-report the blob by up to half a triangle — and a 12x7 sphere
     * has big triangles. Without the bleed below the run covered the blob to
     * within a centimetre and its rounded shoulder still showed through the
     * rounded end of the last bag at midday. The bleed is capped by the support,
     * plus the slack a real laid course takes over the edge of its coping.
     */
    /*
     * The support may only EXTEND the run, never shrink it below the blob it is
     * covering. Letting it shrink is how the second attempt left a whole
     * placeholder sphere standing in the open at the right-hand end: the coping
     * chamfers off at its ends, the three-sample support walk stops there, and the
     * bags stopped with it while the blob carried on.
     */
    const alongSpan = Math.max(0.1,
      Math.max(ax.along, Math.min(supA, ax.along + OVERHANG * 2)) + 0.26 - BAG_L);
    const acrossSpan = Math.max(0.1,
      Math.max(ax.across, Math.min(supB, ax.across + OVERHANG)) + 0.14 - BAG_W);
    /*
     * Courses start at the blob's own box base, NOT at the coping top the support
     * walk found. The blobs are half sunk into their coping, and starting above it
     * left the blob's pale belly bulging out from under the bottom course. The
     * base course interpenetrating the coping is invisible and correct: a laid bag
     * beds into what it sits on.
     */
    const base = c.min[1] - 0.02;
    /*
     * Centre the parapet on the BLOB, not on the midpoint of the support walk.
     * Centring on the support recentres the run whenever the walk stops early on
     * one side — which it does at a chamfered coping end — and slides the whole
     * wall off the blob in the opposite direction. That left the last placeholder
     * sphere hanging out past the right-hand end while bags overhung the left.
     */
    const shiftA = 0;
    const shiftB = 0;
    /*
     * Count from the nominal pitch, then SPREAD the bags to fill the span
     * exactly. Rounding the count and keeping the nominal pitch loses up to a
     * third of a bag at each end, which is precisely where the placeholder blob's
     * rounded shoulder was still showing through in the first attempt.
     */
    const rows = Math.min(MAX_ROWS, Math.max(1, Math.round(acrossSpan / ROW_PITCH) + 1));
    const along = Math.max(2, Math.round(alongSpan / RUN_PITCH) + 1);
    const rowPitch = rows > 1 ? acrossSpan / (rows - 1) : 0;
    const runPitch = alongSpan / (along - 1);
    /*
     * One course higher than the blob. The blob's top is what a reviewer can see,
     * so the bag mass has to close over it: 4 courses at 0.118 m clears a 0.45 m
     * sphere with a course to spare, and the crown course is the one that carries
     * the sag.
     */
    const courses = Math.min(
      MAX_COURSES,
      Math.max(3, Math.ceil((c.max[1] - base - BAG_H * 0.66) / COURSE_PITCH) + 1),
    );

    for (let ci = 0; ci < courses; ci++) {
      const y = base + ci * COURSE_PITCH;
      /*
       * The wall draws in as it rises, but only ACROSS. Shortening the crown
       * along the run as well left the placeholder blob's rounded shoulder
       * peeking over the last bag at the right-hand end, which is the same
       * defect in miniature.
       */
      const rowsHere = ci >= courses - 1 ? Math.max(1, rows - 1) : rows;
      const alongHere = along;
      for (let r = 0; r < rowsHere; r++) {
        const across = shiftB + (r - (rowsHere - 1) / 2) * rowPitch;
        out.bags += bagsOnTop(api, keys, ax.cx, y, ax.cz, ax.yaw + rng.jit(0.05), alongHere, 0, {
          across,
          // Half-bag stagger per course AND per row, so no two neighbouring
          // courses share a joint. Aligned joints read as extruded corduroy.
          pitch: runPitch,
          run: shiftA + ((ci + r) % 2) * runPitch * 0.5,
        });
      }
    }
    out.runs++;
  }
  return out;
}
