import * as THREE from 'three';
import { GROUND, ATTACHED } from './Contact.js';

/**
 * THE FLOAT SWEEP — the last word on "nothing may hang in the air". OWNER: props.
 *
 * WHY THIS EXISTS ON TOP OF ContactPass
 *   ContactPass has two passes and both of them have a declared blind spot:
 *
 *     run()   only ever looks at instances flagged GROUND.
 *     audit() explicitly EXEMPTS everything flagged ATTACHED — 629 instances in
 *             the current build — on the grounds that a wall lamp is supposed to
 *             be off the floor. That is true, but "supposed to be off the floor"
 *             is not the same as "bolted to something". A fixture whose wall was
 *             moved, thinned or deleted by the level system after the raycast
 *             that found it keeps its transform and hangs in space forever, and
 *             nothing in the pipeline was ever going to notice.
 *
 *     Neither pass looks at MERGED geometry at all. Pipe runs, conduit drops,
 *     cable spans and sign quads are unique world-space buffers, so they skip
 *     the instance passes entirely.
 *
 * WHAT THIS PASS DOES
 *   Every prop the system owns — instanced and merged — is checked exactly once,
 *   by raycast, against the real world mesh:
 *
 *     1. Ground-flagged instances get a down-ray from the footprint centre and
 *        are RE-SEATED so their lowest point sits 1.5 cm below the hit.
 *     2. Stacked and attached instances are never moved (moving them shears a
 *        rigid pair or collapses a stack) but they must PROVE support: either
 *        floor within 3 m below, or a surface within reach of the box in one of
 *        the six axis directions — that is what "bolted to a wall" looks like to
 *        a raycast.
 *     3. Anything that proves neither is deleted.
 *
 *   The counts are printed by Props so the pass is falsifiable: if the numbers
 *   are not in the console, the guarantee did not run.
 *
 * Cost: ~4700 instances x 1-7 rays against the same private BVH the survey used.
 * Tens of milliseconds at init, zero per frame.
 */

/** Depth the re-seated base is driven below its contact surface. */
const SINK = 0.015;
/** A ground prop more than this above the floor beneath it is floating. */
const MAX_DROP = 3.0;
/** A prop this far below the surface over it is inside another storey; leave it. */
const MAX_LIFT = 0.75;
/** Extra reach, past the box's own half-extent, allowed when hunting an anchor. */
const ANCHOR_MARGIN = 0.85;
/** Movements below this are not worth counting as a re-seat. */
const EPS = 0.004;

const _p = new THREE.Vector3();
const _o = new THREE.Vector3();
const _d = new THREE.Vector3();

const DIRS = [
  [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0],
];

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
    );
    if (matrix) _p.applyMatrix4(matrix);
    if (_p.x < out.minX) out.minX = _p.x;
    if (_p.x > out.maxX) out.maxX = _p.x;
    if (_p.y < out.minY) out.minY = _p.y;
    if (_p.y > out.maxY) out.maxY = _p.y;
    if (_p.z < out.minZ) out.minZ = _p.z;
    if (_p.z > out.maxZ) out.maxZ = _p.z;
  }
  return out;
}

export class FloatSweep {
  /** @param {import('./Surfaces.js').SurfaceProbe} probe */
  constructor(probe) {
    this.probe = probe;
    this.stats = {
      checked: 0, reseated: 0, deleted: 0, anchored: 0, grounded: 0,
      mergedChecked: 0, mergedDeleted: 0, worstFloat: 0, worstLeft: 0,
    };
    this._box = { minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0 };
  }

  /**
   * Is there anything solid within reach of this box in ANY axis direction?
   * This is the raycast definition of "bolted to something": a wall lamp finds
   * its wall behind it, a ceiling duct finds the slab above, a fence rail finds
   * the ground below. A plate hanging in clear air finds nothing.
   */
  _anchored(b) {
    const cx = (b.minX + b.maxX) * 0.5;
    const cy = (b.minY + b.maxY) * 0.5;
    const cz = (b.minZ + b.maxZ) * 0.5;
    const ex = (b.maxX - b.minX) * 0.5 + ANCHOR_MARGIN;
    const ey = (b.maxY - b.minY) * 0.5 + ANCHOR_MARGIN;
    const ez = (b.maxZ - b.minZ) * 0.5 + ANCHOR_MARGIN;
    _o.set(cx, cy, cz);
    for (let i = 0; i < DIRS.length; i++) {
      const d = DIRS[i];
      _d.set(d[0], d[1], d[2]);
      const reach = d[0] ? ex : d[1] ? ey : ez;
      if (this.probe.cast(_o, _d, reach)) return true;
    }
    return false;
  }

  /** Is this box inside the part of the world the probe actually knows about? */
  _inScope(b) {
    const bounds = this.probe.bounds;
    if (!bounds) return true;
    const cx = (b.minX + b.maxX) * 0.5;
    const cz = (b.minZ + b.maxZ) * 0.5;
    return cx > bounds.min.x - 2 && cx < bounds.max.x + 2
      && cz > bounds.min.z - 2 && cz < bounds.max.z + 2;
  }

  /**
   * Sweep every queued instance and every queued merged piece.
   * MUST run before Batcher.build(), while transforms and chunks are mutable.
   *
   * @param {import('./Kit.js').Batcher} batcher
   * @returns {typeof FloatSweep.prototype.stats}
   */
  run(batcher) {
    const s = this.stats;
    const box = this._box;

    batcher.remap((key, geo, matrix, flags) => {
      const b = worldBox(geo, matrix, box);
      if (!this._inScope(b)) return true;
      s.checked++;

      const cx = (b.minX + b.maxX) * 0.5;
      const cz = (b.minZ + b.maxZ) * 0.5;
      const hit = this.probe.ground(cx, cz, b.maxY + 0.25);
      const drop = hit ? b.minY - hit.point.y : Infinity;

      if (flags & GROUND) {
        // A loose prop standing on the floor. If there is floor under it within
        // a sane distance, seat it on that floor and be done.
        if (hit && drop < MAX_DROP && drop > -MAX_LIFT) {
          if (drop > s.worstFloat) s.worstFloat = drop;
          s.grounded++;
          /*
           * Only ever correct DOWNWARD, and only when the centre ray says the
           * prop is genuinely hovering. ContactPass seats against the highest of
           * nine footprint points, which is the right answer on a kerb or a
           * slope; a single centre ray is coarser, so using it to lift or to
           * "tidy" an already-biting transform would bury corners that were
           * correct. A positive gap, however, is a float by any measure.
           */
          if (drop > EPS + 0.006) {
            matrix.elements[13] -= (drop + SINK);
            s.reseated++;
          } else if (drop > s.worstLeft) s.worstLeft = drop;
          return true;
        }
        // No floor under it at all, or the floor is metres down. It may still be
        // legitimately wedged against something (a bag on a barrier top that the
        // world snapshot does own); give it the anchor test before deleting.
        if (hit && drop >= MAX_DROP && drop > s.worstFloat) s.worstFloat = drop;
        if (this._anchored(b)) { s.anchored++; return true; }
        s.deleted++;
        return false;
      }

      // Stacked (flags 0) and declared-ATTACHED instances are never moved: the
      // first would collapse a stack, the second would shear a rigid pair. They
      // only have to prove they are touching the world or reaching something.
      if (hit && drop < MAX_DROP && drop > -MAX_LIFT) return true;
      if (this._anchored(b)) { s.anchored++; return true; }
      if (hit && drop > s.worstFloat) s.worstFloat = drop;
      s.deleted++;
      void flags; void ATTACHED; void key;
      return false;
    });

    // Merged pieces are already in world space, so their matrix is the identity.
    // They are verified but never moved — a pipe run follows a wall and shifting
    // it down would put it through the floor.
    batcher.remapMerges?.((matKey, geo) => {
      if (matKey === 'decal') return true;            // decals lie ON the ground
      const b = worldBox(geo, null, box);
      if (!this._inScope(b)) return true;             // the distance band
      s.mergedChecked++;
      const cx = (b.minX + b.maxX) * 0.5;
      const cz = (b.minZ + b.maxZ) * 0.5;
      const hit = this.probe.ground(cx, cz, b.maxY + 0.25);
      if (hit && b.minY - hit.point.y < MAX_DROP) return true;
      if (this._anchored(b)) { s.anchored++; return true; }
      s.mergedDeleted++;
      return false;
    });

    return s;
  }
}
