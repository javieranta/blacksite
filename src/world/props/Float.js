import * as THREE from 'three';
import { ATTACHED } from './Contact.js';
import { tubeAlong, boxUV } from './GeoUtil.js';

/**
 * THE FLOAT SWEEP — the last word on "nothing may hang in the air". OWNER: props.
 *
 * WHY THIS EXISTS ON TOP OF ContactPass
 *   ContactPass has two passes and both of them have a declared blind spot:
 *
 *     run()   only ever looks at instances flagged GROUND.
 *     audit() explicitly EXEMPTS everything flagged ATTACHED on the grounds that
 *             a wall lamp is supposed to be off the floor. That is true, but
 *             "supposed to be off the floor" is not the same as "bolted to
 *             something". A fixture whose wall was moved, thinned or deleted by
 *             the level system after the raycast that found it keeps its
 *             transform and hangs in space forever.
 *
 *     Neither pass looks at MERGED geometry at all. Pipe runs, conduit drops,
 *     cable spans and sign quads are unique world-space buffers, so they skip
 *     the instance passes entirely.
 *
 * WHAT ROUND 6 GOT WRONG, AND WHY IT IS FIXED HERE
 *   The round-6 version of this file asked the right question and then accepted
 *   almost any answer:
 *
 *     1. `_anchored` cast from the box CENTRE with a flat 0.85 m of extra reach
 *        in six directions. 0.85 m is most of a metre of empty air, so a plate
 *        drifting near a column, a cable or a beam was blessed as "bolted on".
 *        It is now cast from the box FACE with a 0.18 m margin — the distance a
 *        real bracket, strap or bolt actually spans — and from five points per
 *        face, so a long prop cannot pass on one lucky corner.
 *     2. Anything within 3 m of a surface below it was waved through *without
 *        being moved*. A crate hovering 2.2 m over the floor passed. Support is
 *        now a hard contact test: more than 8 mm of daylight and the prop is
 *        re-seated onto what is actually under it.
 *     3. Support could only ever come from the world. A crate on a crate had to
 *        fall back to the anchor test, which is why the anchor test had to be so
 *        loose. This pass keeps a registry of the TOPS of everything it has
 *        already validated, resolves in up to six ordering-independent sweeps,
 *        and so can tell "stacked" from "floating" without guessing.
 *
 * THE GUARANTEE
 *   After all placement is complete, every loose prop the system owns —
 *   instanced and merged — is checked exactly once:
 *
 *     · raycast down from the footprint against the world AND against the props
 *       already validated;
 *     · a hit within reach re-seats the prop so its lowest point sits 1.5 cm
 *       below the contact (fixtures declared ATTACHED are verified, never moved,
 *       because moving one shears a rigid pair);
 *     · no hit, or the nearest surface more than 3 m down, means the prop is
 *       floating. It is then either genuinely bolted to something (tight anchor
 *       test), genuinely hanging under something — in which case it gets VISIBLE
 *       support geometry, a pair of drop rods up to whatever it hangs from — or
 *       it is deleted.
 *
 *   The counts are printed by Props so the pass is falsifiable: if the numbers
 *   are not in the console, the guarantee did not run.
 *
 * Cost: ~4700 instances x 5-35 rays against the same private BVH the survey
 * used. Tens of milliseconds at init, zero per frame.
 */

/** Depth the re-seated base is driven below its contact surface. */
const SINK = 0.015;
/** How far below a prop we will look for the surface it belongs on. */
const MAX_DROP = 3.0;
/** A prop this far below the surface over it is inside another storey; leave it. */
const MAX_LIFT = 0.75;
/**
 * Daylight allowed between a prop and its support before it is re-seated.
 * 8 mm is under a pixel at 10 m and well inside the contact-shadow radius.
 */
const CONTACT = 0.008;
/**
 * How far past its own surface a prop may reach for an anchor. This is the span
 * of a real bracket, strap, bolt or weld — not a licence to float. A wall pipe
 * stands 5-13 cm off its wall, which is the widest legitimate case in the kit.
 */
const ANCHOR_MARGIN = 0.18;
/** How far above a hanging prop we will look for the thing it hangs from. */
const HANG_REACH = 1.35;
/** Most drop-rod pairs we are willing to draw. Beyond this, delete instead. */
const MAX_HANGERS = 48;
/** Movements below this are not worth counting as a re-seat. */
const EPS = 0.004;
/** Support registry cell size, metres. */
const CELL = 1.0;
/** How far below a prop's base a registered prop top may be and still carry it. */
const STACK_REACH = 0.34;
/** How far a prop's base may be *inside* its support. */
const STACK_BITE = 0.16;
/** Sweeps before an unresolved prop is deleted. Covers the tallest stack. */
const SWEEPS = 6;

const _p = new THREE.Vector3();
const _o = new THREE.Vector3();
const _d = new THREE.Vector3();

const DIRS = [
  [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0],
];
/** Offsets across a box face, as fractions of the face's half-extents. */
const FACE_TAPS = [[0, 0], [0.62, 0.62], [-0.62, 0.62], [0.62, -0.62], [-0.62, -0.62]];

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

const copyBox = (b) => ({
  minX: b.minX, maxX: b.maxX, minY: b.minY, maxY: b.maxY, minZ: b.minZ, maxZ: b.maxZ,
});

export class FloatSweep {
  /** @param {import('./Surfaces.js').SurfaceProbe} probe */
  constructor(probe) {
    this.probe = probe;
    this.stats = {
      checked: 0, reseated: 0, deleted: 0, anchored: 0, grounded: 0, hung: 0,
      mergedChecked: 0, mergedDeleted: 0, worstFloat: 0, worstLeft: 0,
    };
    this._box = { minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0 };
    /** grid cell key -> flat array [minX,maxX,minZ,maxZ,top, ...] */
    this._support = new Map();
    /** Per-key tally of what was deleted, for the console report. */
    this.deletedBy = new Map();
    this._hangers = [];
  }

  /* ------------------------------------------------------------ prop tops */

  /**
   * File a validated prop's full AABB. It serves two questions at once: what
   * can a prop STAND on (the top face) and what can a prop be BOLTED to (any
   * face). Round 6 only recorded tops, which is why a scaffold tube — held up
   * by the tube below it and braced by the tube beside it, touching the world
   * nowhere — had no way to answer either question.
   */
  _register(b) {
    const x0 = Math.floor(b.minX / CELL), x1 = Math.floor(b.maxX / CELL);
    const z0 = Math.floor(b.minZ / CELL), z1 = Math.floor(b.maxZ / CELL);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const k = `${cx},${cz}`;
        let list = this._support.get(k);
        if (!list) { list = []; this._support.set(k, list); }
        list.push(b.minX, b.maxX, b.minY, b.maxY, b.minZ, b.maxZ);
      }
    }
  }

  /** Highest registered prop top under (x,z) that could carry a base at `baseY`. */
  _propTop(x, z, baseY, reach = STACK_REACH) {
    const list = this._support.get(`${Math.floor(x / CELL)},${Math.floor(z / CELL)}`);
    if (!list) return null;
    let best = null;
    for (let i = 0; i < list.length; i += 6) {
      if (x < list[i] || x > list[i + 1] || z < list[i + 4] || z > list[i + 5]) continue;
      const top = list[i + 3];
      if (top < baseY - reach || top > baseY + STACK_BITE) continue;
      if (best === null || top > best) best = top;
    }
    return best;
  }

  /**
   * Is this box within a fastening's reach of a prop that has already proved
   * itself? This is how an assembly — a scaffold, a stacked pallet, a barrier
   * with a chevron bolted to it — resolves: the piece touching the world goes
   * first, and everything welded to it follows, one sweep at a time.
   */
  _touchesProp(b) {
    const m = ANCHOR_MARGIN * 0.5;
    const x0 = Math.floor((b.minX - m) / CELL), x1 = Math.floor((b.maxX + m) / CELL);
    const z0 = Math.floor((b.minZ - m) / CELL), z1 = Math.floor((b.maxZ + m) / CELL);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const list = this._support.get(`${cx},${cz}`);
        if (!list) continue;
        for (let i = 0; i < list.length; i += 6) {
          if (b.maxX + m < list[i] || b.minX - m > list[i + 1]) continue;
          if (b.maxY + m < list[i + 2] || b.minY - m > list[i + 3]) continue;
          if (b.maxZ + m < list[i + 4] || b.minZ - m > list[i + 5]) continue;
          return true;
        }
      }
    }
    return false;
  }

  /* ------------------------------------------------------------- support */

  /**
   * The highest surface under this box that could be holding it up, sampled at
   * the footprint centre and four insets so a prop straddling a kerb or a beam
   * finds the high side rather than the hole beside it.
   * @returns {number|null} world Y of the contact, or null if nothing is in reach
   */
  _supportUnder(b, drop = MAX_DROP) {
    const cx = (b.minX + b.maxX) * 0.5;
    const cz = (b.minZ + b.maxZ) * 0.5;
    const ex = (b.maxX - b.minX) * 0.32;
    const ez = (b.maxZ - b.minZ) * 0.32;
    const lo = b.minY - drop;
    const hi = b.minY + MAX_LIFT;
    let best = null;
    for (let i = 0; i < 5; i++) {
      const px = cx + (i === 1 ? ex : i === 2 ? -ex : 0);
      const pz = cz + (i === 3 ? ez : i === 4 ? -ez : 0);
      const hit = this.probe.ground(px, pz, hi + 0.05);
      if (!hit) continue;
      const y = hit.point.y;
      if (y < lo || y > hi) continue;
      if (best === null || y > best) best = y;
    }
    const reach = Math.min(STACK_REACH, drop);
    const top = this._propTop(cx, cz, b.minY, reach)
      ?? this._propTop(cx + ex, cz, b.minY, reach)
      ?? this._propTop(cx - ex, cz, b.minY, reach)
      ?? this._propTop(cx, cz + ez, b.minY, reach)
      ?? this._propTop(cx, cz - ez, b.minY, reach);
    if (top !== null && (best === null || top > best)) best = top;
    return best;
  }

  /**
   * Is this prop actually fixed to something?
   *
   * "Bolted on" is a PROXIMITY question, not a ray question. The round-6 version
   * cast six rays out of the bounding-box centre with 0.85 m of extra reach,
   * which answers a different question — "is there anything vaguely nearby" —
   * and answers it yes for almost every prop in a dressed level.
   *
   * This asks the world how far away it is, from the prop's own vertices, and
   * accepts only ANCHOR_MARGIN. A pipe bracket, a wall strap and a weld are all
   * inside that. A plate drifting 80 cm off a beam is not, at any orientation,
   * for any shape, which is the whole point.
   */
  _anchored(geo, matrix, b) {
    const pos = geo.attributes?.position;
    if (!pos || !this.probe.ok) return this._anchoredByRay(b);
    const n = pos.count;
    const step = Math.max(1, Math.floor(n / 40));
    for (let i = 0; i < n; i += step) {
      _p.fromBufferAttribute(pos, i);
      if (matrix) _p.applyMatrix4(matrix);
      if (this.probe.nearest(_p.x, _p.y, _p.z, ANCHOR_MARGIN) < ANCHOR_MARGIN) return true;
    }
    return false;
  }

  /** Ray fallback for the (never yet seen) case where the BVH failed to build. */
  _anchoredByRay(b) {
    const c = [(b.minX + b.maxX) * 0.5, (b.minY + b.maxY) * 0.5, (b.minZ + b.maxZ) * 0.5];
    const e = [(b.maxX - b.minX) * 0.5, (b.maxY - b.minY) * 0.5, (b.maxZ - b.minZ) * 0.5];
    for (let i = 0; i < DIRS.length; i++) {
      const d = DIRS[i];
      const axis = d[0] ? 0 : d[1] ? 1 : 2;
      const a1 = (axis + 1) % 3;
      const a2 = (axis + 2) % 3;
      _d.set(d[0], d[1], d[2]);
      for (let t = 0; t < FACE_TAPS.length; t++) {
        const tap = FACE_TAPS[t];
        const o = [c[0], c[1], c[2]];
        o[axis] += d[axis] * e[axis] * 0.96;
        o[a1] += tap[0] * e[a1];
        o[a2] += tap[1] * e[a2];
        _o.set(o[0], o[1], o[2]);
        if (this.probe.cast(_o, _d, e[axis] * 0.08 + ANCHOR_MARGIN)) return true;
      }
    }
    return false;
  }

  /**
   * Is there a structure directly overhead that this prop could credibly be
   * hanging from? Returns the surface Y, or null.
   */
  _ceilingOver(b) {
    const cx = (b.minX + b.maxX) * 0.5;
    const cz = (b.minZ + b.maxZ) * 0.5;
    _o.set(cx, b.maxY + 0.01, cz);
    _d.set(0, 1, 0);
    const hit = this.probe.cast(_o, _d, HANG_REACH);
    return hit ? hit.point.y : null;
  }

  /** Queue a visible pair of drop rods from the prop's top to what holds it. */
  _hang(b, topY) {
    if (this._hangers.length >= MAX_HANGERS) return false;
    const cx = (b.minX + b.maxX) * 0.5;
    const cz = (b.minZ + b.maxZ) * 0.5;
    const ex = Math.min(0.22, (b.maxX - b.minX) * 0.34);
    const ez = Math.min(0.22, (b.maxZ - b.minZ) * 0.34);
    for (let s = -1; s <= 1; s += 2) {
      const x = cx + ex * s;
      const z = cz + ez * s;
      this._hangers.push(tubeAlong([
        new THREE.Vector3(x, topY + 0.01, z),
        new THREE.Vector3(x + 0.012 * s, (topY + b.maxY) * 0.5, z - 0.012 * s),
        new THREE.Vector3(x, b.maxY - 0.02, z),
      ], 0.011, 5));
    }
    return true;
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

  /* ------------------------------------------------------------------ run */

  /**
   * Sweep every queued instance and every queued merged piece.
   * MUST run before Batcher.build(), while transforms and chunks are mutable.
   *
   * @param {import('./Kit.js').Batcher} batcher
   * @param {{mats?:import('./Materials.js').PropMaterials}} [api]
   * @returns {typeof FloatSweep.prototype.stats}
   */
  run(batcher, api = null) {
    const s = this.stats;
    const box = this._box;

    /**
     * One flat list of everything the props system owns, so the resolution
     * order is ours and not the batcher's prototype ordering.
     * @type {Array<{key:string, geo:THREE.BufferGeometry, matrix:THREE.Matrix4|null,
     *   flags:number, merged:boolean, b:object}>}
     */
    const items = [];
    batcher.remap((key, geo, matrix, flags) => {
      const b = worldBox(geo, matrix, box);
      if (!this._inScope(b)) return true;
      items.push({ key, geo, matrix, flags, merged: false, b: copyBox(b) });
      return true;
    });
    /*
     * Decals are judged, but not here.
     *
     * The old line read `if (matKey === 'decal') return true; // decals lie ON
     * the ground`, and that comment was an assumption. round 9 measured it with
     * tools/floatcheck.mjs and found EIGHTEEN props-owned decal quads hanging in
     * mid-air, up to 53 cm clear of anything. But by the time a decal reaches
     * this seam its pass has already welded every quad into one buffer, so there
     * is no per-quad identity left to reject: judging the blob would only ever
     * ask whether MOST of two thousand quads are in contact, and most of them
     * always are. The check therefore happens per quad, before the merge, in
     * parts/GroundDress.js seatQuads() — called by all three decal passes.
     */
    batcher.remapMerges?.((matKey, geo) => {
      // Both mark batches are judged per quad before the merge, for the reason
      // above: 'decal' by GroundDress.seatQuads, 'grime' by the same call in
      // parts/Grime.js. Neither has per-quad identity left by the time it
      // reaches this seam.
      if (matKey === 'decal' || matKey === 'grime') return true;
      const b = worldBox(geo, null, box);
      if (!this._inScope(b)) return true;             // the distance band
      items.push({ key: `merge:${matKey}`, geo, matrix: null, flags: ATTACHED, merged: true, b: copyBox(b) });
      return true;
    });

    s.checked = items.length;
    for (const it of items) if (it.merged) s.mergedChecked++;
    s.checked -= s.mergedChecked;

    /**
     * Resolve in sweeps. Only the last one deletes, so a crate is never thrown
     * away merely because the crate under it had not been reached yet.
     */
    const doomed = new Set();
    let pending = items;
    for (let sweep = 0; sweep < SWEEPS && pending.length; sweep++) {
      const last = sweep === SWEEPS - 1;
      const next = [];
      for (const it of pending) {
        const b = it.b;
        /*
         * A prop we are allowed to move only has to find a surface within
         * MAX_DROP; we then put it ON that surface, which is what makes the
         * guarantee a guarantee rather than a tolerance. A prop we are NOT
         * allowed to move — a rigid pair, a wall fixture, a welded pipe run —
         * has to already be in CONTACT, because "there is a floor three metres
         * below me" is exactly the reasoning that let round 6 pass a crate
         * hovering 2.2 m in the air.
         */
        const movable = !it.merged && !(it.flags & ATTACHED);
        const support = this._supportUnder(b, movable ? MAX_DROP : CONTACT + 0.05);

        if (support !== null) {
          const gap = b.minY - support;
          if (gap > s.worstFloat) s.worstFloat = gap;
          if (movable && gap > CONTACT) {
            const dy = gap + SINK;
            it.matrix.elements[13] -= dy;
            b.minY -= dy; b.maxY -= dy;
            if (dy > EPS) s.reseated++;
          } else if (gap > s.worstLeft) {
            s.worstLeft = gap;
          }
          s.grounded++;
          this._register(b);
          continue;
        }

        /*
         * Nothing underneath. It has to prove it is fixed to something, or that
         * it is hanging from something — and neither of those answers can change
         * between sweeps, because the world does not move. They are therefore
         * evaluated once per prop and cached; only `support` is worth re-asking,
         * because the prop-top registry grows as the sweep proceeds.
         */
        if (it.fixed === undefined) {
          it.fixed = this._anchored(it.geo, it.matrix, b)
            ? 'anchor'
            : (this._ceilingOver(b) ?? null);
        }
        if (it.fixed === 'anchor') {
          s.anchored++;
          this._register(b);
          continue;
        }
        // Bolted to another prop that has already proved itself. This one DOES
        // have to be re-asked every sweep, because the registry grows.
        if (this._touchesProp(b)) {
          s.anchored++;
          this._register(b);
          continue;
        }
        if (typeof it.fixed === 'number' && this._hang(b, it.fixed)) {
          s.hung++;
          this._register(b);
          continue;
        }

        if (!last) { next.push(it); continue; }
        doomed.add(it);
        this.deletedBy.set(it.key, (this.deletedBy.get(it.key) ?? 0) + 1);
        if (it.merged) s.mergedDeleted++; else s.deleted++;
      }
      pending = next;
    }

    if (doomed.size) {
      const dropMat = new Set();
      const dropGeo = new Set();
      for (const it of doomed) (it.merged ? dropGeo : dropMat).add(it.merged ? it.geo : it.matrix);
      if (dropMat.size) batcher.remap((key, geo, matrix) => !dropMat.has(matrix));
      if (dropGeo.size) batcher.remapMerges?.((matKey, geo) => !dropGeo.has(geo));
    }

    // Drop rods are queued during the sweep and merged afterwards, because
    // Batcher.merge() mutates the same map remapMerges() is walking.
    if (this._hangers.length && api?.mats) {
      const mat = api.mats.get('darkmetal') ?? api.mats.get('steel');
      for (const g of this._hangers) {
        boxUV(g, 2.5);
        batcher.merge('darkmetal', g, mat, { solid: false, castShadow: true, receiveShadow: true });
      }
    }

    return s;
  }

  /** "crate_0 x3, rag_0 x2" — what the sweep actually threw away. */
  deletionSummary(limit = 6) {
    const rows = [...this.deletedBy.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
    return rows.length ? rows.map(([k, n]) => `${k} x${n}`).join(', ') : 'nothing';
  }
}
