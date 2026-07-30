import * as THREE from 'three';

/**
 * WHERE TO FASTEN TO. OWNER: props agent.
 *
 * Split out of LevelFloat.js when that file crossed 700 lines. The audit itself
 * lives there and should be read first; this file answers one question for it —
 * given an island of world geometry that is not touching anything, what real
 * surface may props legitimately fasten it to?
 *
 * Every function here searches from the island's REAL VERTICES, never from its
 * bounding box. A 0.62 x 0.80 x 0.03 slab tilted in two axes has an AABB that is
 * 96% air, and searching that box is how the first version of this audit
 * "attached" the round-7 panel to a sleeve sitting in the empty part of its own
 * box while the panel had clear sky along its whole silhouette.
 */

const _o = new THREE.Vector3();
const _d = new THREE.Vector3();

/** The 26 directions out of a box: faces, edges and corners. */
export const FAN = (() => {
  const out = [];
  for (let x = -1; x <= 1; x++) {
    for (let y = -1; y <= 1; y++) {
      for (let z = -1; z <= 1; z++) {
        if (!x && !y && !z) continue;
        const l = Math.hypot(x, y, z);
        out.push([x / l, y / l, z / l]);
      }
    }
  }
  return out;
})();

/** Is this point inside any of the given AABBs, with a skin? */
export function insideAny(p, boxes, s = 0.03) {
  for (const b of boxes) {
    if (p.x < b.min[0] - s || p.x > b.max[0] + s) continue;
    if (p.y < b.min[1] - s || p.y > b.max[1] + s) continue;
    if (p.z < b.min[2] - s || p.z > b.max[2] + s) continue;
    return true;
  }
  return false;
}

/**
 * Is this raycast hit the island hitting ITSELF?
 *
 * NEITHER HALF OF THIS TEST WORKS ALONE, and getting that wrong cost a whole
 * iteration in round 9:
 *
 *   BOX ALONE says yes for the lagging sleeve at (5.65, 3.77, 17.74), because the
 *   3.1 m pipe it is supposed to be wrapped around passes straight through the
 *   sleeve's bounding box. Rejecting the pipe on that basis logged the sleeve as
 *   "STANDOFF band but nothing to bolt to — left alone", and the torn panel
 *   hanging off it stayed in mid-air, which is the exact defect being fixed.
 *
 *   MESH ALONE says yes for a plate mounted on a wall that happens to be baked
 *   into the same (zone, material, flags) bucket — perimeter|concrete|111 holds
 *   both the panels and the wall — and would reject the only correct anchor there
 *   is.
 *
 * A self-hit is BOTH: on a mesh this island is made of, AND inside this island's
 * own extent.
 */
export function selfHit(hit, island) {
  if (!island?.meshes?.size || !hit.object) return false;
  if (!island.meshes.has(hit.object)) return false;
  return insideAny(hit.point, [{ min: island.min, max: island.max }], 0);
}

/** Distance from an island's box centre to the nearest shoot-rig camera. */
export function eyeDistance(c, eyes) {
  if (!eyes?.length) return 6;
  const cx = (c.min[0] + c.max[0]) * 0.5;
  const cy = (c.min[1] + c.max[1]) * 0.5;
  const cz = (c.min[2] + c.max[2]) * 0.5;
  let near = Infinity;
  for (const e of eyes) {
    const d = Math.hypot(e.x - cx, (e.y ?? 1.7) - cy, e.z - cz);
    if (d < near) near = d;
  }
  return Number.isFinite(near) ? Math.max(1.2, near) : 6;
}

/**
 * Closest real surface to a floating island, searched from its own vertices in 26
 * directions.
 *
 * `avoid` is the list of AABBs of every island the audit has ALREADY judged to be
 * floating, and it is the round-9 correction that mattered most. The round-8
 * console reported the hero-golden panel as handled — "0.41x0.96x0.76
 * @6.3,3.4,17.9 tied to a surface 0.32m away" — and the panel still read as
 * floating, because the surface 32 cm away is the OTHER piece of floating
 * lagging. Foreground.js buildNearBent() places two `fabric` pieces near that
 * pipe and both are in mid-air; the pass fastened one to the other and counted it
 * a success. A tie has to reach something that is itself held up, or it is not a
 * tie.
 *
 * @param {import('./Surfaces.js').SurfaceProbe} probe
 * @param {object} c island
 * @param {THREE.Vector3[]} verts real world vertices of the island
 * @param {number} reach how far a tie may look
 * @param {Array<{min:number[],max:number[]}>|null} avoid boxes not to anchor to
 */
export function findAnchor(probe, c, verts, reach, avoid = null) {
  const cy = (c.min[1] + c.max[1]) * 0.5;
  let best = null;
  const step = Math.max(1, Math.floor(verts.length / 16));
  for (let i = 0; i < verts.length; i += step) {
    const v = verts[i];
    for (const dir of FAN) {
      _o.set(v.x + dir[0] * 0.005, v.y + dir[1] * 0.005, v.z + dir[2] * 0.005);
      _d.set(dir[0], dir[1], dir[2]);
      const hit = probe.cast(_o, _d, reach);
      if (!hit || hit.distance < 0.015) continue;   // 0 = its own surface
      if (avoid && insideAny(hit.point, avoid)) continue;
      if (selfHit(hit, c)) continue;
      // Prefer anchors at or above the island: a wire from above reads as a
      // hanging panel, a strut from below reads as a mistake propped up.
      const lift = hit.point.y - cy;
      const score = hit.distance - (lift > 0.12 ? 0.45 : 0);
      if (!best || score < best.score) {
        best = { score, point: hit.point.clone(), from: v.clone(), dist: hit.distance };
      }
    }
  }
  return best;
}

/**
 * Up to `count` well-separated (panel vertex -> nearby surface) pairs: the ends
 * of the spacer studs for a panel sitting a few centimetres off something.
 *
 * Both ends have to be real — the near end is a genuine vertex of the panel, the
 * far end a genuine raycast hit on whatever is behind it. Candidates within a
 * third of the panel's size of one already taken are rejected, because three
 * studs 2 cm apart read as one stud and defeat the point of drawing three.
 *
 * @returns {Array<{from:THREE.Vector3, to:THREE.Vector3}>}
 */
export function standoffPairs(probe, c, verts, { reach, count = 3, minDist = 0.015 }) {
  const size = Math.max(
    c.max[0] - c.min[0], Math.max(c.max[1] - c.min[1], c.max[2] - c.min[2]),
  );
  const apart = Math.max(0.10, size * 0.32);
  const out = [];
  const step = Math.max(1, Math.floor(verts.length / 48));
  for (let i = 0; i < verts.length && out.length < count; i += step) {
    const v = verts[i];
    let best = null;
    for (const dir of FAN) {
      _o.set(v.x + dir[0] * 0.004, v.y + dir[1] * 0.004, v.z + dir[2] * 0.004);
      _d.set(dir[0], dir[1], dir[2]);
      const hit = probe.cast(_o, _d, reach);
      if (!hit || hit.distance < minDist) continue;
      if (selfHit(hit, c)) continue;
      if (!best || hit.distance < best.distance) best = hit;
    }
    if (!best) continue;
    let clash = false;
    for (const p of out) { if (p.from.distanceTo(v) < apart) { clash = true; break; } }
    if (clash) continue;
    out.push({ from: v.clone(), to: best.point.clone(), head: frontFace(probe, v, best.point) });
  }
  return out;
}

/**
 * Where the bolt head belongs: on the face of the panel that FACES AWAY from the
 * thing it is bolted to.
 *
 * WHY THIS IS NOT JUST `from`. A standoff stud runs from a vertex of the panel to
 * the wall behind it, so if the vertex happens to be on the panel's BACK face the
 * whole stud is hidden behind the panel and the mounting is invisible from every
 * angle that shows the panel's front. Measured in round 9: the vertical.png plate
 * got three studs, the console counted them, and the crop showed the plate with
 * no visible hardware at all — the same "the geometry exists and cannot be seen"
 * failure as the 1-pixel wire ropes it replaced.
 *
 * So walk BACK along the stud axis from in front of the panel and find the first
 * surface: that is the front face, and the head goes just proud of it with the
 * shank passing through. Only a hit in FRONT of the start vertex is accepted, so
 * a decor panel that is not in the BVH falls through to the caller's default
 * rather than putting the head on the wall.
 */
function frontFace(probe, from, to) {
  const back = 0.42;
  _d.subVectors(to, from).normalize();
  _o.copy(from).addScaledVector(_d, -back);
  const hit = probe.cast(_o, _d, back - 0.004);
  if (!hit) return null;
  // A head that has collapsed onto the far end degenerates the shank into a
  // zero-length tube, which the NaN guard in LevelTies then throws away — and the
  // panel silently gets no hardware while the pass counts a candidate. Reject it
  // here so the caller falls back to the vertex it started from.
  return hit.point.distanceTo(to) > 0.04 ? hit.point.clone() : null;
}
