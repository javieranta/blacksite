import * as THREE from 'three';

/**
 * The contact guarantee. OWNER: props agent.
 *
 * THE DEFECT THIS EXISTS TO MAKE IMPOSSIBLE
 *   A prop hanging in the air with no support, no rope and no contact shadow.
 *   The Placer already validated placements, but it validated the *bounding
 *   box*, and a bounding box is the wrong thing to validate:
 *
 *     - a tyre lying flat has a 70 cm hole through its middle, so the one ray it
 *       cast (down the box centre) passed straight through whatever the tyre was
 *       supposed to be resting on;
 *     - a prop straddling a kerb rests on its box corner, not its centre;
 *     - a prop that was correct at placement time can be left behind if the
 *       surface it was measured against belonged to a different storey.
 *
 * TWO PASSES, TWO DIFFERENT QUESTIONS
 *
 *   run()   — "is this prop on the ground?"  Every instance flagged GROUND is
 *             re-seated against the real world mesh by raycast, or deleted.
 *
 *   audit() — "is this prop on ANYTHING?"  Round 5 found the hole in the first
 *             pass: it only ever looked at instances it had itself flagged. A
 *             crate stacked on another crate, a bag on a barrier, a lid on a
 *             drum — none of those are GROUND, so none of them were checked, and
 *             if run() deleted the thing underneath they were left hanging with
 *             nothing to explain them. audit() closes that: it builds a registry
 *             of the TOPS of every prop that survived pass one, then requires
 *             every remaining instance to be supported either by the world or by
 *             a registered prop top. Anything that is neither is deleted.
 *
 *             Fixtures that are *meant* to be off the ground — a wall lamp, a
 *             pipe bracket, a scaffold tube, the second half of a rigid
 *             two-material machine — carry the ATTACHED flag and are exempt by
 *             declaration rather than by luck.
 *
 *   Both passes are O(instances x 9) raycasts against the same private BVH the
 *   survey used — a few tens of milliseconds at init, zero cost per frame.
 */

/** Instance flag: this transform was ground-snapped and must be verified. */
export const GROUND = 1;
/**
 * Instance flag: this transform is bolted to something (a wall, a beam, another
 * instance's matrix) and is legitimately not touching the floor. Exempt.
 */
export const ATTACHED = 2;

/** How far below its supporting surface the resting point is driven. */
const SINK = 0.015;
/** Tolerance for the post-correction audit. */
const TOL = 0.01;
/** How far above/below a footprint point we will accept a support surface. */
const BAND = 0.55;
/** Fraction of footprint points that must find support. */
const NEED = 0.6;
/** How far below a loose prop's base a prop top may be and still support it. */
const STACK_REACH = 0.34;
/** How far a loose prop's base may be *inside* its support. */
const STACK_BITE = 0.14;
/** Support registry cell size, metres. */
const CELL = 1.0;

const _v = new THREE.Vector3();
const _p = new THREE.Vector3();

/**
 * Lowest vertex per cell of a 3x3 XZ grid. Up to 9 points, which is the whole
 * footprint of anything prop-sized, and always includes the true minimum.
 */
function footprintOf(geo) {
  const pos = geo.attributes.position;
  if (!pos) return [];
  if (!geo.boundingBox) geo.computeBoundingBox();
  const bb = geo.boundingBox;
  const ex = Math.max(1e-4, bb.max.x - bb.min.x);
  const ez = Math.max(1e-4, bb.max.z - bb.min.z);
  const yLimit = bb.min.y + Math.max(0.008, (bb.max.y - bb.min.y) * 0.22);

  const cells = new Array(9).fill(null);
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    if (y > yLimit) continue;
    const x = pos.getX(i), z = pos.getZ(i);
    const cx = Math.min(2, Math.max(0, ((x - bb.min.x) / ex * 3) | 0));
    const cz = Math.min(2, Math.max(0, ((z - bb.min.z) / ez * 3) | 0));
    const k = cz * 3 + cx;
    const cur = cells[k];
    if (!cur || y < cur.y) cells[k] = { x, y, z };
  }
  const out = [];
  for (const c of cells) if (c) out.push(c);
  // A geometry so thin that no vertex cleared the y filter still needs a
  // footprint: fall back to the box base corners, inset so we sample material.
  if (out.length < 3) {
    const ix = bb.min.x + ex * 0.2, ax = bb.max.x - ex * 0.2;
    const iz = bb.min.z + ez * 0.2, az = bb.max.z - ez * 0.2;
    return [
      { x: ix, y: bb.min.y, z: iz }, { x: ax, y: bb.min.y, z: iz },
      { x: ix, y: bb.min.y, z: az }, { x: ax, y: bb.min.y, z: az },
      { x: (ix + ax) / 2, y: bb.min.y, z: (iz + az) / 2 },
    ];
  }
  return out;
}

/** World-space AABB of a geometry under a matrix, written into `out`. */
function worldBox(geo, matrix, out) {
  if (!geo.boundingBox) geo.computeBoundingBox();
  const bb = geo.boundingBox;
  out.minX = out.minY = out.minZ = Infinity;
  out.maxX = out.maxY = out.maxZ = -Infinity;
  for (let c = 0; c < 8; c++) {
    _p.set(
      (c & 1) ? bb.max.x : bb.min.x,
      (c & 2) ? bb.max.y : bb.min.y,
      (c & 4) ? bb.max.z : bb.min.z,
    ).applyMatrix4(matrix);
    if (_p.x < out.minX) out.minX = _p.x;
    if (_p.x > out.maxX) out.maxX = _p.x;
    if (_p.y < out.minY) out.minY = _p.y;
    if (_p.y > out.maxY) out.maxY = _p.y;
    if (_p.z < out.minZ) out.minZ = _p.z;
    if (_p.z > out.maxZ) out.maxZ = _p.z;
  }
  return out;
}

export class ContactPass {
  /** @param {import('./Surfaces.js').SurfaceProbe} probe */
  constructor(probe) {
    this.probe = probe;
    this._fp = new Map();
    this.stats = {
      checked: 0, reseated: 0, dropped: 0, worstBefore: 0, worstAfter: 0, moved: 0,
      loose: 0, onWorld: 0, onProp: 0, orphaned: 0, exempt: 0,
    };
    this._hits = new Float64Array(9);
    /** grid cell key -> flat array [minX,maxX,minZ,maxZ,top, ...] */
    this._support = new Map();
    this._box = {
      minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0,
    };
  }

  _footprint(key, geo) {
    let f = this._fp.get(key);
    if (!f) { f = footprintOf(geo); this._fp.set(key, f); }
    return f;
  }

  /* --------------------------------------------------------- support registry */

  _register(b) {
    const x0 = Math.floor(b.minX / CELL), x1 = Math.floor(b.maxX / CELL);
    const z0 = Math.floor(b.minZ / CELL), z1 = Math.floor(b.maxZ / CELL);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const k = `${cx},${cz}`;
        let list = this._support.get(k);
        if (!list) { list = []; this._support.set(k, list); }
        list.push(b.minX, b.maxX, b.minZ, b.maxZ, b.maxY);
      }
    }
  }

  /** Highest registered prop top under (x,z) that could carry a base at `baseY`. */
  _supportAt(x, z, baseY) {
    const list = this._support.get(`${Math.floor(x / CELL)},${Math.floor(z / CELL)}`);
    if (!list) return null;
    let best = null;
    for (let i = 0; i < list.length; i += 5) {
      if (x < list[i] || x > list[i + 1] || z < list[i + 2] || z > list[i + 3]) continue;
      const top = list[i + 4];
      if (top < baseY - STACK_REACH || top > baseY + STACK_BITE) continue;
      if (best === null || top > best) best = top;
    }
    return best;
  }

  /* ------------------------------------------------------------------ pass 1 */

  /**
   * Re-seat or delete every ground-flagged instance queued in the batcher, and
   * register the top of everything that survives.
   * Must run BEFORE Batcher.build(), while the transforms are still mutable.
   */
  run(batcher) {
    const s = this.stats;
    const box = this._box;
    batcher.remap((key, geo, matrix, flags) => {
      if (!(flags & GROUND)) return true;
      const fp = this._footprint(key, geo);
      if (fp.length === 0) return true;
      s.checked++;

      let best = -Infinity, found = 0, worst = 0;
      for (let i = 0; i < fp.length; i++) {
        const f = fp[i];
        _p.set(f.x, f.y, f.z).applyMatrix4(matrix);
        const hit = this.probe.ground(_p.x, _p.z, _p.y + 0.35);
        this._hits[i] = NaN;
        if (!hit) continue;
        const dy = hit.point.y - _p.y;
        if (dy > BAND || dy < -BAND) continue;
        this._hits[i] = hit.point.y;
        found++;
        if (dy > best) best = dy;
        if (dy < worst) worst = dy;                // most negative = biggest float
      }
      if (found < Math.max(2, Math.ceil(fp.length * NEED))) { s.dropped++; return false; }

      const gapBefore = -worst;                    // how high the prop hovered
      if (gapBefore > s.worstBefore) s.worstBefore = gapBefore;

      const dy = best - SINK;
      if (Math.abs(dy) > 0.0005) {
        matrix.elements[13] += dy;
        s.reseated++;
        if (Math.abs(dy) > 0.004) s.moved++;
      }

      // Audit the corrected transform against the hits we already have.
      let after = Infinity;
      for (let i = 0; i < fp.length; i++) {
        const h = this._hits[i];
        if (Number.isNaN(h)) continue;
        const f = fp[i];
        _v.set(f.x, f.y, f.z).applyMatrix4(matrix);
        const gap = _v.y - h;
        if (gap < after) after = gap;
      }
      if (!Number.isFinite(after)) after = 0;
      // `after` is the smallest signed clearance: negative means the prop bites
      // into its support, which is what we want. A positive value is a float.
      if (after > TOL) { s.dropped++; return false; }
      if (after > s.worstAfter) s.worstAfter = after;

      this._register(worldBox(geo, matrix, box));
      return true;
    });
    return this.stats;
  }

  /* ------------------------------------------------------------------ pass 2 */

  /**
   * Require every remaining instance to rest on something real.
   *
   * Loose instances are collected first, then resolved in up to three sweeps so
   * a three-high crate stack settles regardless of the order the batcher happens
   * to store its prototypes in. Only the last sweep deletes, so a crate is never
   * thrown away merely because the crate below it had not been reached yet.
   */
  audit(batcher) {
    const s = this.stats;
    const box = this._box;
    /** @type {Array<{geo:THREE.BufferGeometry, matrix:THREE.Matrix4, key:string}>} */
    const loose = [];

    batcher.remap((key, geo, matrix, flags) => {
      if (flags & GROUND) return true;
      if (flags & ATTACHED) { s.exempt++; this._register(worldBox(geo, matrix, box)); return true; }
      loose.push({ key, geo, matrix });
      return true;
    });
    s.loose = loose.length;

    // Six sweeps covers the tallest thing the kit can build (a five-course
    // revetment plus a crown) even in the worst prototype ordering.
    const SWEEPS = 6;
    const doomed = new Set();
    let pending = loose;
    for (let sweep = 0; sweep < SWEEPS && pending.length; sweep++) {
      const last = sweep === SWEEPS - 1;
      const next = [];
      for (const it of pending) {
        const b = worldBox(it.geo, it.matrix, box);
        const cx = (b.minX + b.maxX) * 0.5, cz = (b.minZ + b.maxZ) * 0.5;
        const ex = (b.maxX - b.minX) * 0.3, ez = (b.maxZ - b.minZ) * 0.3;

        // 1 — the world itself, sampled at the base centre and four insets.
        let ok = false;
        for (let i = 0; i < 5 && !ok; i++) {
          const px = cx + (i === 1 ? ex : i === 2 ? -ex : 0);
          const pz = cz + (i === 3 ? ez : i === 4 ? -ez : 0);
          const g = this.probe.ground(px, pz, b.minY + 0.12);
          if (g && b.minY - g.point.y < 0.06) ok = true;
        }
        if (ok) {
          s.onWorld++;
          this._register({ ...b });
          continue;
        }

        // 2 — the top of a prop that has already been validated.
        let sup = this._supportAt(cx, cz, b.minY);
        if (sup === null) sup = this._supportAt(cx + ex, cz, b.minY);
        if (sup === null) sup = this._supportAt(cx - ex, cz, b.minY);
        if (sup === null) sup = this._supportAt(cx, cz + ez, b.minY);
        if (sup === null) sup = this._supportAt(cx, cz - ez, b.minY);
        if (sup !== null) {
          s.onProp++;
          this._register({ ...b });
          continue;
        }

        if (last) { doomed.add(it.matrix); s.orphaned++; } else next.push(it);
      }
      pending = next;
    }

    if (doomed.size) {
      batcher.remap((key, geo, matrix) => !doomed.has(matrix));
      s.dropped += doomed.size;
    }
    return this.stats;
  }
}
