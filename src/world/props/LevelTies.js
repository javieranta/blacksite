import * as THREE from 'three';
import { tubeAlong, boxUV, catenary } from './GeoUtil.js';

/**
 * TIE GEOMETRY for the world float audit. OWNER: props agent.
 *
 * Split out of LevelFloat.js only because that file crossed 700 lines; the
 * reasoning for the pass itself lives there and should be read first.
 *
 * A "tie" is the visible fastening props draws between an unsupported piece of
 * LEVEL geometry and the nearest real surface. Two forms, chosen by span:
 *
 *   under 0.34 m   a solid rod with a bolt pad at each end — a bracket.
 *   over 0.34 m    a sagging wire rope with an eye plate at the panel end. The
 *                  sag is the whole point: a straight cylinder between two
 *                  points reads as a strut, and a strut in tension reads as a
 *                  bug. `catenary` gives it real slack.
 *
 * Anything wider than a hand gets TWO of them plus a strap band across the face
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

/** Span below which a fastening is a rod, not a rope. */
const ROD_SPAN = 0.34;

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

/**
 * Draw the fastening.
 *
 * @param {import('./Kit.js').Batcher} batcher
 * @param {import('./Materials.js').PropMaterials} mats
 * @param {{min:number[], max:number[]}} c the island being held
 * @param {{point:THREE.Vector3, from:THREE.Vector3, dist:number}} anchor
 * @param {THREE.Vector3[]} verts real world vertices of the island
 * @param {import('./Rand.js').Rand} rng
 * @returns {number} ties drawn
 */
export function drawTie(batcher, mats, c, anchor, verts, rng) {
  const mat = mats.get('darkmetal') ?? mats.get('steel');
  if (!mat) return 0;
  // The anchor search already knows which vertex it fired from; that vertex is
  // the shortest real span and therefore where a fastening actually belongs.
  const near = anchor.from;
  if (!near) return 0;
  const span = near.distanceTo(anchor.point);
  // A zero-length tie degenerates the tube curve into NaN positions. Guard.
  if (!(span > 0.05)) return 0;
  _dir.subVectors(anchor.point, near).normalize();
  // a lateral axis to spread a pair of ties along
  _lat.crossVectors(_dir, _up);
  if (_lat.lengthSq() < 1e-4) _lat.set(1, 0, 0);
  _lat.normalize();

  const size = Math.max(
    c.max[0] - c.min[0], Math.max(c.max[1] - c.min[1], c.max[2] - c.min[2]),
  );
  const halfSpread = Math.min(0.19, Math.max(0.045, size * 0.30));
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
      catenary(_b, _a, 0.055 + rng.range(0, 0.03), 7, pts);
      add(batcher, mat, tubeAlong(pts, 0.0075, 5), true);
      const cleat = new THREE.CylinderGeometry(0.022, 0.026, 0.012, 8);
      cleat.translate(_a.x, _a.y, _a.z);
      add(batcher, mat, cleat, false);
    } else {
      add(batcher, mat, tubeAlong([_b.clone(), _a.clone()], 0.011, 6, 3), true);
      for (const p of [_a, _b]) {
        const pad = new THREE.CylinderGeometry(0.026, 0.03, 0.014, 8);
        pad.translate(p.x, p.y, p.z);
        add(batcher, mat, pad, false);
      }
    }
    wires++;
  }

  // A strap band across the panel between the two ties: it is what makes the
  // pair read as ONE fastening rather than two coincidental wires.
  if (wires === 2 && halfSpread > 0.03) {
    _a.copy(near).addScaledVector(_lat, -halfSpread);
    _b.copy(near).addScaledVector(_lat, halfSpread);
    add(batcher, mat, tubeAlong([_a.clone(), near.clone(), _b.clone()], 0.009, 5, 6), false);
  }
  return wires;
}
