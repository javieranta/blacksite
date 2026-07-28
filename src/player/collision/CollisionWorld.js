import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';

/**
 * OWNER: player-movement agent.
 *
 * A private, position-only snapshot BVH of `level.colliders`, built once at
 * init, used for every player query: capsule depenetration, ground probes,
 * ledge probes and lean occlusion.
 *
 * WHY A PRIVATE SNAPSHOT
 *   `level.colliders` is a heterogeneous Group — merged static meshes that carry
 *   their own `geometry.boundsTree`, plus `InstancedMesh` prop batches that
 *   carry none. Walking that graph per query would mean a matrix inverse and a
 *   separate shapecast per child, 120 times a second. Flattening it once into a
 *   single world-space triangle soup with one BVH turns every query into a
 *   single log-time traversal with no matrix work at all.
 *
 * ALLOCATION
 *   Nothing here allocates after `build()`. Every callback is bound once in the
 *   constructor, every temporary is module-scoped, and query results are written
 *   into reused records. Callers must copy out anything they intend to keep.
 */

const _tp = new THREE.Vector3();      // closest point on triangle
const _cp = new THREE.Vector3();      // closest point on capsule segment
const _push = new THREE.Vector3();
const _p = new THREE.Vector3();
const _v = new THREE.Vector3();
const _srcBox = new THREE.Box3();
const _im = new THREE.Matrix4();

const MAX_CONTACTS = 10;

export class CollisionWorld {
  constructor() {
    this.ok = false;
    this.bvh = null;
    this.triangles = 0;
    this.sources = [];              // { surface }
    this.triSource = null;          // Int32Array triIndex -> source index
    this.bounds = new THREE.Box3();

    // ---- capsule query state ----------------------------------------------
    this.seg = new THREE.Line3();   // live capsule segment (sphere centres)
    this._radius = 0.34;
    this._queryBox = new THREE.Box3();

    /** Deduplicated contact normals from the last depenetration pass. */
    this.contacts = [];
    for (let i = 0; i < MAX_CONTACTS; i++) this.contacts.push(new THREE.Vector3());
    this.contactDepth = new Float32Array(MAX_CONTACTS);
    this.contactCount = 0;
    this.bestGroundNormal = new THREE.Vector3(0, 1, 0);
    this.bestGroundY = -1;
    this.hitSomething = false;

    // ---- ray query state ---------------------------------------------------
    this._maxSlope = -1;
    this.ray = new THREE.Ray();
    this._rayBox = new THREE.Box3();
    this._rayFar = 0;
    this._bestDist = Infinity;
    this.hit = {
      point: new THREE.Vector3(),
      normal: new THREE.Vector3(0, 1, 0),
      distance: 0,
      triIndex: -1,
      surface: 'concrete',
    };

    // ---- bound callbacks (no per-query closures) ---------------------------
    this._cbBounds = (box) => box.intersectsBox(this._queryBox);
    this._cbPush = (tri) => this._onPushTri(tri);
    this._cbOverlap = (tri) => this._onOverlapTri(tri);
    this._cbRayBounds = (box) => box.intersectsBox(this._rayBox);
    this._cbRayTri = (tri, i) => this._onRayTri(tri, i);
    this._pushArgs = { intersectsBounds: this._cbBounds, intersectsTriangle: this._cbPush };
    this._overlapArgs = { intersectsBounds: this._cbBounds, intersectsTriangle: this._cbOverlap };
    this._rayArgs = { intersectsBounds: this._cbRayBounds, intersectsTriangle: this._cbRayTri };
  }

  /**
   * Flatten every collider inside `volume` into one BVH.
   * @param {object} level  the level system (needs `.colliders`)
   * @param {object} ctx    engine context (for `forge.surfaceOf`)
   * @param {THREE.Box3} volume  only colliders overlapping this are included
   * @param {number} budget maximum triangles
   */
  build(level, ctx, volume, budget = 1_200_000) {
    const root = level?.colliders;
    if (!root) return false;
    const forge = ctx.get('forge');
    root.updateMatrixWorld(true);

    // ---- pass 1: pick sources (whole meshes / whole instances) -------------
    const picks = [];
    let total = 0;
    root.traverse((o) => {
      if (!o.isMesh && !o.isInstancedMesh) return;
      const geo = o.geometry;
      const pos = geo?.attributes?.position;
      if (!pos) return;
      if (!geo.boundingBox) geo.computeBoundingBox();
      const tris = (geo.index ? geo.index.count : pos.count) / 3;
      if (tris < 1) return;
      const mat = Array.isArray(o.material) ? o.material[0] : o.material;
      const surface = mat?.userData?.surface ?? forge?.surfaceOf?.(mat) ?? 'concrete';
      const count = o.isInstancedMesh ? o.count : 1;
      for (let i = 0; i < count; i++) {
        if (o.isInstancedMesh) {
          o.getMatrixAt(i, _im);
          _im.premultiply(o.matrixWorld);
        } else {
          _im.copy(o.matrixWorld);
        }
        _srcBox.copy(geo.boundingBox).applyMatrix4(_im);
        if (!volume.intersectsBox(_srcBox)) continue;
        if (total + tris > budget) continue;
        total += tris;
        picks.push({ obj: o, matrix: _im.clone(), tris, surface });
      }
    });
    if (!picks.length) return false;

    // ---- pass 2: bake world-space triangle soup ----------------------------
    const positions = new Float32Array(total * 9);
    this.triSource = new Int32Array(total);
    this.sources = picks;
    let w = 0, t = 0;
    for (let s = 0; s < picks.length; s++) {
      const e = picks[s];
      const geo = e.obj.geometry;
      const pos = geo.attributes.position;
      const idx = geo.index;
      for (let f = 0; f < e.tris; f++) {
        for (let k = 0; k < 3; k++) {
          const vi = idx ? idx.getX(f * 3 + k) : f * 3 + k;
          _v.fromBufferAttribute(pos, vi).applyMatrix4(e.matrix);
          positions[w++] = _v.x; positions[w++] = _v.y; positions[w++] = _v.z;
        }
        this.triSource[t++] = s;
      }
      e.matrix = null;              // release; only the surface tag is needed now
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.computeBoundingBox();
    this._geo = geo;
    try {
      this.bvh = new MeshBVH(geo, { targetLeafSize: 8 });
      this.ok = true;
    } catch (err) {
      console.warn('[player] collision BVH build failed', err);
      this.ok = false;
      return false;
    }
    this.bounds.copy(geo.boundingBox);
    this.triangles = total;
    return true;
  }

  /* ------------------------------------------------------- capsule contacts */

  /**
   * Push the capsule out of every triangle it overlaps, iterating so corners
   * and concave junctions converge instead of fighting.
   *
   * The segment is mutated in place *during* traversal — that is deliberate:
   * resolving each contact immediately means the second wall of a corner is
   * tested against the already-corrected position, which is what stops the
   * classic corner jitter where two walls take turns ejecting you.
   *
   * @param {THREE.Vector3} segStart bottom sphere centre (mutated)
   * @param {THREE.Vector3} segEnd   top sphere centre (mutated)
   * @param {number} radius
   * @param {number} iterations
   * @returns {number} contact count
   */
  depenetrate(segStart, segEnd, radius, iterations = 4, maxSlope = -1) {
    this.contactCount = 0;
    this.bestGroundY = -1;
    this.bestGroundNormal.set(0, 1, 0);
    this.hitSomething = false;
    if (!this.ok) return 0;

    this._maxSlope = maxSlope;
    this._radius = radius;
    this.seg.start.copy(segStart);
    this.seg.end.copy(segEnd);

    for (let i = 0; i < iterations; i++) {
      this._queryBox.makeEmpty();
      this._queryBox.expandByPoint(this.seg.start);
      this._queryBox.expandByPoint(this.seg.end);
      this._queryBox.min.addScalar(-radius);
      this._queryBox.max.addScalar(radius);
      const before = this.contactCount;
      const movedFrom = _p.copy(this.seg.start);
      this.bvh.shapecast(this._pushArgs);
      // Converged: nothing moved this iteration.
      if (this.contactCount === before && movedFrom.distanceToSquared(this.seg.start) < 1e-10) break;
    }

    segStart.copy(this.seg.start);
    segEnd.copy(this.seg.end);
    return this.contactCount;
  }

  _onPushTri(tri) {
    const r = this._radius;
    const dist = tri.closestPointToSegment(this.seg, _tp, _cp);
    if (dist >= r) return false;
    const depth = r - dist;
    _push.subVectors(_cp, _tp);
    const l2 = _push.lengthSq();
    if (l2 > 1e-12) _push.multiplyScalar(1 / Math.sqrt(l2));
    else tri.getNormal(_push);
    // A 0.1 mm slop keeps the capsule a hair off the surface so the next tick
    // does not immediately re-detect the same contact at depth 0.
    let move = depth + 0.0001;
    // On a face too steep to stand on, take the whole separation *horizontally*.
    // The naive push runs along the contact normal, which has an upward component
    // — and that lets a player creep up a 60° wall at nearly two metres a second
    // simply by holding forward, which makes `maxSlope` decorative. Climbing over
    // something is the step-up's job, and only where there is a walkable surface.
    if (this._maxSlope > 0 && _push.y > 0.001 && _push.y < this._maxSlope) {
      const hl = Math.sqrt(_push.x * _push.x + _push.z * _push.z);
      if (hl > 1e-4) {
        move /= hl;              // same separating distance along the true normal
        _push.set(_push.x / hl, 0, _push.z / hl);
      }
    }
    this.seg.start.addScaledVector(_push, move);
    this.seg.end.addScaledVector(_push, move);
    this.hitSomething = true;
    if (_push.y > this.bestGroundY) {
      this.bestGroundY = _push.y;
      this.bestGroundNormal.copy(_push);
    }
    this._record(_push, depth);
    return false;
  }

  /** Store a contact normal, folding near-duplicates together. */
  _record(n, depth) {
    for (let i = 0; i < this.contactCount; i++) {
      if (this.contacts[i].dot(n) > 0.985) {
        if (depth > this.contactDepth[i]) this.contactDepth[i] = depth;
        return;
      }
    }
    if (this.contactCount >= MAX_CONTACTS) return;
    this.contacts[this.contactCount].copy(n);
    this.contactDepth[this.contactCount] = depth;
    this.contactCount++;
  }

  /**
   * Cheap boolean: does a capsule at this pose touch anything? Used for
   * stand-up headroom and mantle landing clearance.
   */
  capsuleFree(x, topY, z, height, radius, shrink = 0.02) {
    if (!this.ok) return true;
    const r = Math.max(0.05, radius - shrink);
    const h = Math.max(2 * r + 0.02, height - shrink * 2);
    this._radius = r;
    this.seg.start.set(x, topY - h + r, z);
    this.seg.end.set(x, topY - r, z);
    this._queryBox.makeEmpty();
    this._queryBox.expandByPoint(this.seg.start);
    this._queryBox.expandByPoint(this.seg.end);
    this._queryBox.min.addScalar(-r);
    this._queryBox.max.addScalar(r);
    return this.bvh.shapecast(this._overlapArgs) === false;
  }

  _onOverlapTri(tri) {
    return tri.closestPointToSegment(this.seg, _tp, _cp) < this._radius;
  }

  /* ------------------------------------------------------------------- rays */

  /**
   * Closest hit along a short ray. Returns the shared `this.hit` record or null.
   * `dir` must be normalised.
   */
  cast(origin, dir, maxDist) {
    if (!this.ok) return null;
    this.ray.origin.copy(origin);
    this.ray.direction.copy(dir);
    this._rayFar = maxDist;
    this._bestDist = Infinity;
    this._rayBox.makeEmpty();
    this._rayBox.expandByPoint(origin);
    _p.copy(origin).addScaledVector(dir, maxDist);
    this._rayBox.expandByPoint(_p);
    this._rayBox.min.addScalar(-0.002);
    this._rayBox.max.addScalar(0.002);
    this.bvh.shapecast(this._rayArgs);
    if (!Number.isFinite(this._bestDist)) return null;
    this.hit.distance = this._bestDist;
    if (this.hit.normal.dot(dir) > 0) this.hit.normal.negate();
    const src = this.sources[this.triSource[this.hit.triIndex]];
    this.hit.surface = src?.surface ?? 'concrete';
    return this.hit;
  }

  _onRayTri(tri, i) {
    if (!this.ray.intersectTriangle(tri.a, tri.b, tri.c, false, _p)) return false;
    const d = this.ray.origin.distanceTo(_p);
    if (d > this._rayFar || d >= this._bestDist) return false;
    this._bestDist = d;
    this.hit.point.copy(_p);
    tri.getNormal(this.hit.normal);
    this.hit.triIndex = i;
    return false;
  }

  dispose() {
    this._geo?.dispose();
    this._geo = null;
    this.bvh = null;
    this.ok = false;
    this.sources.length = 0;
    this.triSource = null;
  }
}
