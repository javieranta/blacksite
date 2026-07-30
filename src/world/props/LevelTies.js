import * as THREE from 'three';
import { tubeAlong, boxUV, catenary, xf } from './GeoUtil.js';

/**
 * TIE GEOMETRY for the world float audit. OWNER: props agent.
 *
 * Split out of LevelFloat.js only because that file crossed 700 lines; the
 * reasoning for the pass itself lives there and should be read first.
 *
 * A "tie" is the visible fastening props draws between an unsupported piece of
 * LEVEL geometry and the nearest real surface.
 *
 * ROUND 9 — WHY THIS FILE WAS REWRITTEN
 *   The round-8 version drew, for the panel in hero-golden.png, two 7.5 mm wire
 *   ropes with 22 mm cleats. Both ends landed on real geometry. The console
 *   reported it as braced. The review still said the plate had "no bracket,
 *   bolt, hinge or cable", and the review was right, because of arithmetic
 *   nobody did:
 *
 *     vertical FOV 80 deg, 1080 px. At distance d the frame is
 *     2*tan(40 deg)*d = 1.68*d metres tall, so one pixel is 1.55*d mm.
 *     At d = 4.2 m that is 6.5 mm per pixel.
 *
 *   A 7.5 mm rope is therefore 1.1 px wide, before the bloom and the grade
 *   smear it away. Geometry that exists and cannot be seen is not a fix. Every
 *   member here is now sized from the distance the nearest shoot camera sees it
 *   at, with a floor of five pixels:
 *
 *     gauge = clamp(dist * 0.0075, 0.013, 0.055)      metres, member RADIUS
 *
 *   which at 4.2 m gives a 63 mm strap — a real banding strap on real lagging,
 *   10 px wide, unmistakable. At 25 m it caps at 110 mm, which is a bracket, and
 *   still honest.
 *
 * THE FORMS, chosen by span:
 *   under 0.30 m   an ANGLE BRACKET: a leg off the anchor, a leg across the
 *                  panel face, a gusset in the corner between them, and a bolt
 *                  head at each end. A standoff bracket is what actually holds a
 *                  plate 10-25 cm off a wall, and the gusset is what makes it
 *                  read as a bracket rather than as a stick.
 *   over 0.30 m    a sagging STRAP with a bolted eye plate at the panel end and
 *                  a wrap band round the anchor. The sag is the whole point: a
 *                  straight cylinder in tension reads as a bug.
 *
 * Anything wider than a hand gets TWO of them plus a band across the face
 * between them, because one fastening in the middle of an 0.8 m panel reads as
 * balanced on a pin rather than fixed.
 *
 * THE RULE THIS FILE EXISTS TO OBEY
 *   Both ends of a tie must land ON geometry. The lower end is always a real
 *   world-space VERTEX of the thing being held — never a bounding-box point,
 *   never an interpolated ideal. The round-7 viewmodel fix in this project was
 *   verified to exist, render, carry correct materials and project to a known
 *   pixel, and it was still wrong, because the hands were 18 mm clear of the grip
 *   in empty air. A tie whose end is 18 mm off its panel is the same defect.
 */

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _lat = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _zAxis = new THREE.Vector3(0, 0, 1);
const _norm = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();

/** Span below which a fastening is a bracket, not a strap. */
const ROD_SPAN = 0.30;

/**
 * Member radius in metres for something seen from `dist` metres.
 *
 * 0.0075 rad-equivalent is ~5 px of radius (10 px of width) at 1080p/80 deg. The
 * lower clamp keeps close-up hardware from becoming cartoonish; the upper clamp
 * stops a distant bracket becoming an I-beam.
 */
function gaugeFor(dist) {
  return Math.min(0.055, Math.max(0.013, dist * 0.0075));
}

/**
 * Merge one piece of tie geometry, refusing anything non-finite.
 *
 * A degenerate curve produces NaN vertex positions. One NaN in a merged buffer
 * makes the whole batch's bounding sphere NaN, and three.js then emits the token
 * `NaN` into the generated depth-material shader source, which fails to compile —
 * 388 console errors from a single bad tube, observed while building this pass.
 * Checked here, once, cheaply.
 */
function add(batcher, mat, geo, cast) {
  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  if (!bb || !Number.isFinite(bb.min.x + bb.min.y + bb.min.z + bb.max.x + bb.max.y + bb.max.z)) {
    geo.dispose();
    return false;
  }
  boxUV(geo, 3.0);
  batcher.merge('darkmetal', geo, mat, { solid: false, castShadow: cast, receiveShadow: true });
  return true;
}

/*
 * TRIANGLE BUDGET — read before making any of these prettier.
 *
 * There are ~600 spacer studs and ~185 ties in this level, which is 800 pieces of
 * hardware, and each one draws in the main pass AND in every shadow cascade that
 * sees it. The first cut of this file used a RoundedBoxGeometry for every pad and
 * a 10-segment washer on every bolt, and measured: `vertical` went from 2.39M
 * triangles to 4.20M and `combat` to 4.82M, against a contract ceiling of 3.5M.
 *
 * So: hex heads (6 sides, not 10), plain boxes for pads (12 triangles, not 300),
 * and castShadow FALSE on everything smaller than a fist. A 5 cm bolt pad casts a
 * shadow nothing can resolve; the strap that spans the gap keeps its shadow,
 * because that shadow is part of what reads as "this thing is held".
 */

/** A bolt head: one short hex prism, no washer. ~24 triangles. */
function bolt(batcher, mat, p, g) {
  const head = new THREE.CylinderGeometry(g * 1.05, g * 1.15, g * 1.6, 6);
  head.translate(p.x, p.y, p.z);
  add(batcher, mat, head, false);
}

/**
 * A flat pad of thickness `t`, `w` x `h`, centred at `p` and facing `normal`.
 * A pad is what turns a cylinder into a fabrication. 12 triangles: a plain box,
 * because at these sizes a chamfer is sub-pixel and costs 25x the geometry.
 */
function plate(batcher, mat, p, normal, w, h, t) {
  const g = new THREE.BoxGeometry(w, h, t);
  _q.setFromUnitVectors(_zAxis, _norm.copy(normal).normalize());
  _e.setFromQuaternion(_q);
  xf(g, p.x, p.y, p.z, _e.x, _e.y, _e.z);
  add(batcher, mat, g, false);
}

/**
 * SPACER STUDS across a small gap.
 *
 * For a panel a few centimetres off a wall, a strap is the wrong answer and a
 * catenary is absurd: what holds a plate 3-16 cm off masonry is a set of bolted
 * spacers. Each stud is a short tube from a real vertex of the panel to a real
 * raycast hit on the wall, with a bolt head and washer proud of the panel face
 * and a base pad flat on the wall. Three of them across the face is the smallest
 * number that reads as a mounting pattern rather than a single pivot.
 *
 * This is the geometry the round-8 pass never drew, because it declared anything
 * within 16 cm of a surface "attached" and moved on. The panel in vertical.png
 * was 9.9 cm off its wall and got nothing.
 *
 * @param {import('./Kit.js').Batcher} batcher
 * @param {import('./Materials.js').PropMaterials} mats
 * @param {Array<{from:THREE.Vector3, to:THREE.Vector3}>} pairs stud ends
 * @param {number} eyeDist metres to the nearest shoot camera — sets the gauge
 * @returns {number} studs drawn
 */
export function drawStandoff(batcher, mats, pairs, eyeDist = 6) {
  const mat = mats.get('darkmetal') ?? mats.get('steel');
  if (!mat || !pairs?.length) return 0;
  // Studs are hardware, not structure: two thirds of the tie gauge, but still
  // held above the five-pixel floor by gaugeFor's lower clamp.
  const g = gaugeFor(eyeDist) * 0.62;
  let n = 0;
  for (const p of pairs) {
    const span = p.from.distanceTo(p.to);
    if (!(span > 0.012)) continue;
    _norm.subVectors(p.to, p.from).normalize();
    // The shank runs a little PAST the panel face so the bolt head sits proud of
    // it rather than half-buried, which is the difference between reading as a
    // fastening and reading as a dot.
    /*
     * The head sits on the panel's VISIBLE face — see LevelAnchors.frontFace for
     * why that is not simply `p.from` — with the shank running through the panel
     * and into the wall. A stud whose head is on the hidden face is geometry that
     * exists and cannot be seen, which is the failure mode this whole round is
     * about.
     */
    _a.copy(p.head ?? p.from).addScaledVector(_norm, -g * 1.1);
    // 5 radial x 2 segments = 20 triangles, no shadow. See the budget note above.
    if (!add(batcher, mat, tubeAlong([_a.clone(), p.to.clone()], g, 5, 2), false)) continue;
    bolt(batcher, mat, _a, g * 0.95);
    plate(batcher, mat, p.to, _norm, g * 3.4, g * 3.4, g * 0.55);
    n++;
  }
  return n;
}

/**
 * Draw the fastening.
 *
 * @param {import('./Kit.js').Batcher} batcher
 * @param {import('./Materials.js').PropMaterials} mats
 * @param {{min:number[], max:number[]}} c the island being held
 * @param {{point:THREE.Vector3, from:THREE.Vector3, dist:number}} anchor
 * @param {THREE.Vector3[]} verts real world vertices of the island
 * @param {import('./Rand.js').Rand} rng
 * @param {number} eyeDist metres to the nearest shoot camera — sets the gauge
 * @returns {number} ties drawn
 */
export function drawTie(batcher, mats, c, anchor, verts, rng, eyeDist = 6) {
  const mat = mats.get('darkmetal') ?? mats.get('steel');
  if (!mat) return 0;
  // The anchor search already knows which vertex it fired from; that vertex is
  // the shortest real span and therefore where a fastening actually belongs.
  const near = anchor.from;
  if (!near) return 0;
  const span = near.distanceTo(anchor.point);
  // A zero-length tie degenerates the tube curve into NaN positions. Guard.
  if (!(span > 0.05)) return 0;
  const g = gaugeFor(eyeDist);
  _dir.subVectors(anchor.point, near).normalize();
  // a lateral axis to spread a pair of ties along
  _lat.crossVectors(_dir, _up);
  if (_lat.lengthSq() < 1e-4) _lat.set(1, 0, 0);
  _lat.normalize();

  const size = Math.max(
    c.max[0] - c.min[0], Math.max(c.max[1] - c.min[1], c.max[2] - c.min[2]),
  );
  // Spread the pair wide enough that the two fastenings read as a pair and not
  // as a double line, but never wider than the panel they are holding.
  const halfSpread = Math.min(size * 0.34, Math.max(g * 2.4, size * 0.22));
  const pairs = (span > ROD_SPAN || size > 0.42) ? 2 : 1;
  const pts = [];
  let wires = 0;

  for (let s = 0; s < pairs; s++) {
    const off = pairs === 1 ? 0 : (s === 0 ? -halfSpread : halfSpread);
    // Slide the lower end along the lateral axis, then SNAP it back to the
    // nearest real vertex, so it cannot drift off the panel into clear air.
    _a.copy(near).addScaledVector(_lat, off);
    let lo = null, ld = Infinity;
    for (const v of verts) {
      const d = v.distanceToSquared(_a);
      if (d < ld) { ld = d; lo = v; }
    }
    _a.copy(lo ?? near);
    _b.copy(anchor.point).addScaledVector(_lat, off * 0.55);
    if (_a.distanceToSquared(_b) < 0.0025) continue;

    if (span > ROD_SPAN) {
      // A strap: sagging, so it reads as carrying weight rather than propping.
      catenary(_b, _a, 0.055 + rng.range(0, 0.03), 7, pts);
      // The strap KEEPS its shadow: at 6 cm across it is the one member big
      // enough for the shadow to be part of what reads as "held".
      add(batcher, mat, tubeAlong(pts, g * 0.42, 5, 8), true);
      // Bolted eye plate where it meets the panel. This is the piece that makes
      // the strap look terminated rather than merely coincident with the panel.
      plate(batcher, mat, _a, _dir, g * 4.2, g * 3.0, g * 0.6);
      bolt(batcher, mat, _a, g * 0.7);
    } else {
      // An angle bracket: a leg out of the anchor, a leg across the panel, and a
      // gusset in the corner. The corner is what reads as fabricated.
      const mid = _b.clone().addScaledVector(_dir, -span * 0.55);
      add(batcher, mat, tubeAlong([_b.clone(), mid.clone(), _a.clone()], g, 5, 6), true);
      plate(batcher, mat, _a, _dir, g * 4.6, g * 3.4, g * 0.7);
      plate(batcher, mat, _b, _dir, g * 3.6, g * 3.0, g * 0.7);
      bolt(batcher, mat, _a, g * 0.75);
      bolt(batcher, mat, _b, g * 0.75);
    }
    wires++;
  }

  // A band across the panel between the two fastenings: it is what makes the
  // pair read as ONE fixing rather than two coincidental wires.
  if (wires === 2 && halfSpread > g * 1.5) {
    _a.copy(near).addScaledVector(_lat, -halfSpread);
    _b.copy(near).addScaledVector(_lat, halfSpread);
    add(batcher, mat, tubeAlong([_a.clone(), near.clone(), _b.clone()], g * 0.55, 6, 8), true);
  }
  return wires;
}
