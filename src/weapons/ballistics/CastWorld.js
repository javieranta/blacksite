import * as THREE from 'three';

/**
 * OWNER: ballistics agent (private to src/weapons/ballistics).
 *
 * A flat, allocation-free ray-cast layer over `level.colliders`, sitting
 * directly on the three-mesh-bvh trees rather than on THREE.Raycaster.
 *
 * Why not Raycaster:
 *   1. `Raycaster.intersectObject(group, true)` walks the scene graph, allocates
 *      an intersection array plus a hit record per triangle candidate, and sorts.
 *      Ballistics casts several times per bullet (entry, exit probe, ricochet
 *      leg, per-segment drop steps), so that garbage adds up fast.
 *   2. Raycaster picks its cull side from `material.side`. Penetration needs the
 *      *exit* face of a wall, which is a BACK-face hit against a front-side
 *      material — Raycaster physically cannot express that query. `MeshBVH`
 *      takes the side as an argument, so `cast(..., THREE.BackSide)` gives the
 *      far side of a wall in one traversal.
 *
 * Colliders are harvested once into parallel arrays (world AABB in a
 * Float32Array, BVH + matrices in object arrays), one entry per mesh and one per
 * InstancedMesh instance. Every cast does a branch-light slab test against the
 * AABB with a progressively tightening `far`, so the BVH is only entered for the
 * handful of targets that can still beat the current best hit.
 */

const MAX_TARGETS = 8192;
const BIG = 1e30;

const _ray = new THREE.Ray();
const _o = new THREE.Vector3();
const _d = new THREE.Vector3();
const _box = new THREE.Box3();
const _mat = new THREE.Matrix4();

/** Reusable hit record. `cast` never allocates one. */
export function makeHit() {
  return {
    point: new THREE.Vector3(),
    normal: new THREE.Vector3(),
    distance: 0,
    surface: 'concrete',
    object: null,
    instanceId: -1,
    faceIndex: -1,
    _target: -1,
  };
}

export class CastWorld {
  constructor() {
    this.count = 0;
    this.aabb = new Float32Array(MAX_TARGETS * 6);
    /** @type {Array<import('three-mesh-bvh').MeshBVH>} */
    this.bvh = [];
    /** @type {Array<THREE.Matrix4|null>} */
    this.inv = [];
    /** @type {Array<THREE.Matrix3|null>} */
    this.nrm = [];
    this.mesh = [];
    this.surface = [];
    this.instanceId = [];

    this.stats = { targets: 0, casts: 0, candidates: 0, traversals: 0 };

    this._invDir = new Float32Array(3);
    this._sourceCount = -1;
  }

  /**
   * Harvest every solid mesh under `level.colliders`. Cheap enough to re-run
   * whenever the collider count changes (props stream in during their own init,
   * which happens before ours, but destructible geometry may arrive later).
   */
  build(level, forge) {
    const root = level?.colliders;
    this.count = 0;
    this.bvh.length = 0;
    this.inv.length = 0;
    this.nrm.length = 0;
    this.mesh.length = 0;
    this.surface.length = 0;
    this.instanceId.length = 0;
    if (!root) return;

    // Nothing has rendered yet on the first build, so matrixWorld may be stale.
    root.updateWorldMatrix(true, true);

    root.traverse((o) => {
      if (!o.isMesh && !o.isInstancedMesh) return;
      const geom = o.geometry;
      if (!geom) return;
      if (!geom.boundingBox) geom.computeBoundingBox();
      if (!geom.boundsTree) {
        // Level bakes its own trees; props do not. `computeBoundsTree` is
        // installed on BufferGeometry.prototype by the level system.
        if (typeof geom.computeBoundsTree !== 'function') return;
        try { geom.computeBoundsTree({ maxLeafTris: 12 }); } catch { return; }
      }
      if (!geom.boundsTree) return;

      const surface = forge?.surfaceOf ? forge.surfaceOf(o.material) : 'concrete';
      if (o.isInstancedMesh) {
        for (let i = 0; i < o.count; i++) {
          o.getMatrixAt(i, _mat);
          _mat.premultiply(o.matrixWorld);
          this._push(o, geom, _mat, surface, i);
        }
      } else {
        this._push(o, geom, o.matrixWorld, surface, -1);
      }
    });

    this._sourceCount = root.children.length;
    this.stats.targets = this.count;
  }

  /** Rebuild only if the collider list changed since the last harvest. */
  sync(level, forge) {
    const n = level?.colliders?.children.length ?? -1;
    if (n !== this._sourceCount) this.build(level, forge);
  }

  _push(mesh, geom, matrix, surface, instanceId) {
    const i = this.count;
    if (i >= MAX_TARGETS) return;

    const e = matrix.elements;
    const identity =
      Math.abs(e[0] - 1) < 1e-6 && Math.abs(e[5] - 1) < 1e-6 && Math.abs(e[10] - 1) < 1e-6 &&
      Math.abs(e[1]) < 1e-6 && Math.abs(e[2]) < 1e-6 && Math.abs(e[4]) < 1e-6 &&
      Math.abs(e[6]) < 1e-6 && Math.abs(e[8]) < 1e-6 && Math.abs(e[9]) < 1e-6 &&
      Math.abs(e[12]) < 1e-6 && Math.abs(e[13]) < 1e-6 && Math.abs(e[14]) < 1e-6;

    _box.copy(geom.boundingBox);
    if (!identity) _box.applyMatrix4(matrix);
    const b = i * 6;
    const a = this.aabb;
    // A metre of slop absorbs the epsilon walk-off used when a round re-enters
    // the same wall after a penetration step.
    a[b] = _box.min.x - 0.02; a[b + 1] = _box.min.y - 0.02; a[b + 2] = _box.min.z - 0.02;
    a[b + 3] = _box.max.x + 0.02; a[b + 4] = _box.max.y + 0.02; a[b + 5] = _box.max.z + 0.02;

    this.bvh.push(geom.boundsTree);
    if (identity) {
      this.inv.push(null);
      this.nrm.push(null);
    } else {
      this.inv.push(new THREE.Matrix4().copy(matrix).invert());
      this.nrm.push(new THREE.Matrix3().getNormalMatrix(matrix));
    }
    this.mesh.push(mesh);
    this.surface.push(surface);
    this.instanceId.push(instanceId);
    this.count = i + 1;
  }

  /**
   * Nearest hit along `origin + dir * t` for t in [near, far].
   * @param {THREE.Vector3} origin
   * @param {THREE.Vector3} dir must be unit length
   * @param {number} near
   * @param {number} far
   * @param {number} side THREE.FrontSide | THREE.BackSide | THREE.DoubleSide
   * @param {object} hit record from makeHit(), written in place
   * @param {number} [onlyTarget] restrict the query to one target index (from a
   *   previous hit's `_target`). This is what makes the penetration exit probe
   *   exact: the far face has to belong to the same object the round entered.
   * @returns {boolean}
   */
  cast(origin, dir, near, far, side, hit, onlyTarget = -1) {
    const n = this.count;
    if (n === 0 || !(far > near)) return false;

    const id = this._invDir;
    id[0] = dir.x !== 0 ? 1 / dir.x : BIG;
    id[1] = dir.y !== 0 ? 1 / dir.y : BIG;
    id[2] = dir.z !== 0 ? 1 / dir.z : BIG;

    const a = this.aabb;
    const ox = origin.x, oy = origin.y, oz = origin.z;
    let best = far;
    let found = -1;
    this.stats.casts++;

    const first = onlyTarget >= 0 ? onlyTarget : 0;
    const last = onlyTarget >= 0 ? Math.min(onlyTarget + 1, n) : n;

    for (let i = first; i < last; i++) {
      const b = i * 6;

      // --- slab test against the world AABB, clipped to [near, best] --------
      let t0 = near, t1 = best;
      let lo = (a[b] - ox) * id[0], hi = (a[b + 3] - ox) * id[0];
      if (lo > hi) { const s = lo; lo = hi; hi = s; }
      if (lo > t0) t0 = lo;
      if (hi < t1) t1 = hi;
      if (t0 > t1) continue;
      lo = (a[b + 1] - oy) * id[1]; hi = (a[b + 4] - oy) * id[1];
      if (lo > hi) { const s = lo; lo = hi; hi = s; }
      if (lo > t0) t0 = lo;
      if (hi < t1) t1 = hi;
      if (t0 > t1) continue;
      lo = (a[b + 2] - oz) * id[2]; hi = (a[b + 5] - oz) * id[2];
      if (lo > hi) { const s = lo; lo = hi; hi = s; }
      if (lo > t0) t0 = lo;
      if (hi < t1) t1 = hi;
      if (t0 > t1) continue;
      this.stats.candidates++;

      // --- narrow phase: BVH in the target's own frame ----------------------
      const inv = this.inv[i];
      let k = 1;
      if (inv) {
        _o.copy(origin).applyMatrix4(inv);
        _d.copy(origin).add(dir).applyMatrix4(inv).sub(_o);
        k = _d.length();
        if (k < 1e-9) continue;
        _d.multiplyScalar(1 / k);
        _ray.origin.copy(_o);
        _ray.direction.copy(_d);
      } else {
        _ray.origin.copy(origin);
        _ray.direction.copy(dir);
      }

      // t0/t1 already bound the useful span; feeding them to the BVH prunes
      // whole subtrees instead of relying on the returned distance.
      const lNear = Math.max(0, t0 - 1e-4) * k;
      const lFar = (t1 + 1e-4) * k;
      this.stats.traversals++;
      const h = this.bvh[i].raycastFirst(_ray, side, lNear, lFar);
      if (h === null) continue;

      const wd = h.distance / k;
      if (wd >= best || wd < near) continue;
      best = wd;
      found = i;
      hit.distance = wd;
      hit.faceIndex = h.faceIndex ?? -1;
      hit.normal.copy(h.face.normal);
    }

    if (found < 0) return false;
    hit.point.copy(origin).addScaledVector(dir, hit.distance);
    hit.object = this.mesh[found];
    hit.surface = this.surface[found];
    hit.instanceId = this.instanceId[found];
    hit._target = found;
    const nm = this.nrm[found];
    if (nm) hit.normal.applyMatrix3(nm);
    hit.normal.normalize();
    return true;
  }

  /** True if anything solid blocks the segment. Cheaper than a full cast. */
  occluded(origin, dir, near, far, hit) {
    return this.cast(origin, dir, near, far, THREE.DoubleSide, hit);
  }

  dispose() {
    this.count = 0;
    this.bvh.length = 0;
    this.inv.length = 0;
    this.nrm.length = 0;
    this.mesh.length = 0;
    this.surface.length = 0;
    this.instanceId.length = 0;
  }
}
