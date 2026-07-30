import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { GROUND, ATTACHED } from './Contact.js';

/**
 * Surface discovery and contact-correct placement. OWNER: props agent.
 *
 * The props system does not know what the level looks like — another agent owns
 * it and it changes under us. So instead of hard-coding coordinates we *probe*:
 * a private BVH is built over level.colliders at init, and every prop is seated
 * by raycast against it. Nothing is ever positioned by assumption.
 *
 * DEFECT FIX (floating geometry): every placement runs through `Placer.put`,
 * which
 *   1. finds the ground under the prop,
 *   2. re-seats the prop so its bounding-box base sits `sink` metres BELOW that
 *      surface (2-5 cm), so no camera angle can reveal a gap,
 *   3. re-probes the four base corners and takes the highest contact, so props
 *      on slopes and kerbs still touch,
 *   4. and finally re-validates, dropping anything that still floats >1 cm.
 */

const _ray = new THREE.Ray();
const _dirDown = new THREE.Vector3(0, -1, 0);
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _box = new THREE.Box3();
const _mat = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _e = new THREE.Euler();
const _scale = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

const MAX_PROBE_TRIS = 1200000;

export class SurfaceProbe {
  constructor(ctx, level) {
    this.ctx = ctx;
    this.level = level;
    this.ok = false;
    this.bvh = null;
    this.sources = [];      // per source-mesh info
    this.triSource = null;  // Int32Array: triangle index -> source index
    this.bounds = new THREE.Box3(new THREE.Vector3(-60, -4, -60), new THREE.Vector3(60, 32, 60));
    this._fallback = new THREE.Raycaster();
    this._occupancy = new Map();
    this._cell = 1.5;
    this._near = {};
  }

  /** Snapshot the world into a private, position-only BVH. */
  build() {
    const root = this.level?.colliders;
    if (!root) return false;
    const forge = this.ctx.get('forge');
    const entries = [];
    let total = 0;

    root.updateMatrixWorld(true);
    root.traverse((o) => {
      if (!o.isMesh && !o.isInstancedMesh) return;
      const geo = o.geometry;
      if (!geo?.attributes?.position) return;
      const tris = (geo.index ? geo.index.count : geo.attributes.position.count) / 3;
      const count = o.isInstancedMesh ? o.count : 1;
      if (total + tris * count > MAX_PROBE_TRIS) return;
      total += tris * count;
      const mat = Array.isArray(o.material) ? o.material[0] : o.material;
      const surface = mat?.userData?.surface
        ?? forge?.surfaceOf?.(mat)
        ?? 'concrete';
      entries.push({ obj: o, tris, count, surface });
    });

    if (!entries.length || total === 0) return false;

    const positions = new Float32Array(total * 9);
    this.triSource = new Int32Array(total);
    let w = 0, t = 0;
    const im = new THREE.Matrix4();

    for (let si = 0; si < entries.length; si++) {
      const e = entries[si];
      const geo = e.obj.geometry;
      const pos = geo.attributes.position;
      const idx = geo.index;
      const triN = e.tris;
      for (let inst = 0; inst < e.count; inst++) {
        if (e.obj.isInstancedMesh) {
          e.obj.getMatrixAt(inst, im);
          im.premultiply(e.obj.matrixWorld);
        } else {
          im.copy(e.obj.matrixWorld);
        }
        for (let f = 0; f < triN; f++) {
          for (let k = 0; k < 3; k++) {
            const vi = idx ? idx.getX(f * 3 + k) : f * 3 + k;
            _v.fromBufferAttribute(pos, vi).applyMatrix4(im);
            positions[w++] = _v.x; positions[w++] = _v.y; positions[w++] = _v.z;
          }
          this.triSource[t++] = si;
        }
      }
    }

    this.sources = entries;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.computeBoundingBox();
    this._geo = geo;
    try {
      this.bvh = new MeshBVH(geo, { targetLeafSize: 8 });
      this.ok = true;
    } catch (err) {
      console.warn('[props] BVH build failed, falling back to scene raycast', err);
      this.ok = false;
    }
    this.bounds.copy(geo.boundingBox);
    if (this.level?.bounds) this.bounds.union(this.level.bounds);
    this.triangles = total;
    return this.ok;
  }

  /**
   * Cast a ray against the world snapshot.
   * @returns {{point:THREE.Vector3, normal:THREE.Vector3, distance:number, surface:string}|null}
   */
  cast(origin, dir, maxDist = 200, out = null) {
    if (this.ok) {
      _ray.origin.copy(origin);
      _ray.direction.copy(dir).normalize();
      const hit = this.bvh.raycastFirst(_ray, THREE.DoubleSide, 0.0005, maxDist);
      if (!hit) return null;
      const src = this.sources[this.triSource[hit.faceIndex]] ?? null;
      const n = hit.face
        ? new THREE.Vector3(hit.face.normal.x, hit.face.normal.y, hit.face.normal.z)
        : new THREE.Vector3(0, 1, 0);
      if (n.dot(_ray.direction) > 0) n.negate();
      const res = out ?? {};
      res.point = hit.point.clone();
      res.normal = n;
      res.distance = hit.distance;
      res.surface = src?.surface ?? 'concrete';
      res.object = src?.obj ?? null;
      return res;
    }
    // Fallback path: slow but correct.
    this._fallback.set(origin, _v2.copy(dir).normalize());
    this._fallback.far = maxDist;
    const hits = this._fallback.intersectObject(this.level.colliders, true);
    if (!hits.length) return null;
    const h = hits[0];
    const n = h.face
      ? h.face.normal.clone().transformDirection(h.object.matrixWorld)
      : new THREE.Vector3(0, 1, 0);
    if (n.dot(dir) > 0) n.negate();
    const mat = Array.isArray(h.object.material) ? h.object.material[0] : h.object.material;
    return {
      point: h.point.clone(), normal: n, distance: h.distance,
      surface: mat?.userData?.surface ?? 'concrete', object: h.object,
    };
  }

  /** Ground contact under (x,z). Returns null over a hole or outside the level. */
  ground(x, z, fromY = null) {
    _v2.set(x, fromY ?? (this.bounds.max.y + 4), z);
    const hit = this.cast(_v2, _dirDown, (fromY ?? this.bounds.max.y + 4) - this.bounds.min.y + 8);
    if (!hit) return null;
    if (hit.normal.y < 0.35) return null;   // a wall face, not a floor
    return hit;
  }

  /**
   * Every up-facing surface in a vertical column, top to bottom.
   *
   * A single downward ray from above a building finds its ROOF, never its floor,
   * which is why naive scatter dresses rooftops and leaves interiors empty. This
   * walks the whole column so each storey can be dressed on its own terms.
   */
  stack(x, z, out = []) {
    out.length = 0;
    let y = this.bounds.max.y + 4;
    const floor = this.bounds.min.y - 2;
    for (let i = 0; i < 8; i++) {
      _v2.set(x, y, z);
      const hit = this.cast(_v2, _dirDown, y - floor + 4);
      if (!hit) break;
      if (hit.normal.y >= 0.5) out.push(hit);
      y = hit.point.y - 0.04;
      if (y < floor) break;
    }
    return out;
  }

  /** Nearest vertical surface from a point, scanning `count` directions. */
  wall(x, y, z, maxDist = 8, count = 12, startAngle = 0) {
    let best = null;
    let hits = 0;
    _v2.set(x, y, z);
    for (let i = 0; i < count; i++) {
      const a = startAngle + (i / count) * Math.PI * 2;
      _v.set(Math.cos(a), 0, Math.sin(a));
      const hit = this.cast(_v2, _v, maxDist);
      if (!hit) continue;
      if (Math.abs(hit.normal.y) > 0.4) continue;   // floor/ceiling, not a wall
      hits++;
      if (!best || hit.distance < best.distance) { best = hit; best.dir = _v.clone(); }
    }
    // `hits` doubles as an enclosure measure: a point boxed in on most sides is
    // indoors, which is how interiors get dressed without asking the level.
    if (best) { best.hits = hits; best.rays = count; }
    return best;
  }

  /**
   * Distance from a point to the nearest world surface, capped at `maxDist`.
   *
   * This is the primitive the float sweep needs and could not previously
   * express: "is this prop actually touching anything?" is a proximity question,
   * not a ray question. Six rays from a box centre answer it only for props that
   * happen to be axis-aligned with their support; a closest-point query answers
   * it for a cable end, a bent pipe, a sign corner or a tilted plate as well.
   *
   * @returns {number} metres, or Infinity if nothing is within `maxDist`
   */
  nearest(x, y, z, maxDist = 0.25) {
    if (!this.ok || !this.bvh) return Infinity;
    _v2.set(x, y, z);
    const res = this.bvh.closestPointToPoint(_v2, this._near, 0, maxDist);
    if (!res || res.distance > maxDist) return Infinity;
    return res.distance;
  }

  /** Ceiling above a point (for hanging cables, ducts, lamps). */
  ceiling(x, y, z, maxDist = 12) {
    _v2.set(x, y, z);
    _v.set(0, 1, 0);
    const hit = this.cast(_v2, _v, maxDist);
    if (!hit || hit.normal.y > -0.4) return null;
    return hit;
  }

  /* ------------------------------------------------------------ occupancy */

  _key(x, z) { return `${Math.floor(x / this._cell)},${Math.floor(z / this._cell)}`; }

  isFree(x, z, r) {
    const c = this._cell;
    const x0 = Math.floor((x - r) / c), x1 = Math.floor((x + r) / c);
    const z0 = Math.floor((z - r) / c), z1 = Math.floor((z + r) / c);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const list = this._occupancy.get(`${cx},${cz}`);
        if (!list) continue;
        for (let i = 0; i < list.length; i += 3) {
          const dx = list[i] - x, dz = list[i + 1] - z;
          const rr = list[i + 2] + r;
          if (dx * dx + dz * dz < rr * rr) return false;
        }
      }
    }
    return true;
  }

  claim(x, z, r) {
    const c = this._cell;
    const x0 = Math.floor((x - r) / c), x1 = Math.floor((x + r) / c);
    const z0 = Math.floor((z - r) / c), z1 = Math.floor((z + r) / c);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const k = `${cx},${cz}`;
        let list = this._occupancy.get(k);
        if (!list) { list = []; this._occupancy.set(k, list); }
        list.push(x, z, r);
      }
    }
  }

  dispose() {
    this._geo?.dispose();
    this.bvh = null;
    this._occupancy.clear();
  }
}

/* ========================================================================= */

/**
 * Seats props against the probed world and feeds the batcher. Every solid prop
 * in the game goes through here — there is no other placement path.
 */
export class Placer {
  constructor(probe, batcher, rng) {
    this.probe = probe;
    this.batcher = batcher;
    this.rng = rng;
    this.placed = [];
    this.rejected = { noGround: 0, occupied: 0, steep: 0, floating: 0, buried: 0, overhang: 0 };
    this.tolerance = 0.01;   // 1 cm — the review's threshold
    /**
     * Height to start ground probes from. Set per cluster / per sample so props
     * meant for an interior floor are not snapped up onto the roof above it.
     */
    this.floorHint = null;
  }

  /**
   * @param {string} key       instanced proto key
   * @param {THREE.BufferGeometry} geo  the proto geometry (for its bounding box)
   */
  put(key, geo, {
    x, z, y = null, yaw = 0, tilt = 0, tiltDir = 0, scale = 1,
    sink = 0.025, radius = null, align = 0.0, tint = 1, tintColour = null,
    ignoreOccupancy = false, maxSlope = 0.55, claimScale = 1, from = null,
    /**
     * Opt out of the post-placement contact pass. Only for RIGID PAIRS — a
     * machine whose steel and dark-trim halves are two instances sharing one
     * transform. Re-seating them independently would shear the pair apart, and
     * they are validated here by the four-corner probe anyway.
     */
    verifyContact = true,
  }) {
    if (!geo.boundingBox) geo.computeBoundingBox();
    const bb = geo.boundingBox;
    const foot = radius ?? Math.max(
      Math.hypot(bb.max.x, bb.max.z), Math.hypot(bb.min.x, bb.min.z),
    ) * scale;

    // A prop resting on another prop cannot be verified against the world
    // snapshot (props are not in it), so its contact height is taken from the
    // support it was given and the world gap test is skipped.
    const stacked = y != null;
    const startY = from ?? this.floorHint;
    let gy = y;
    let normal = _up;
    if (gy == null) {
      const hit = this.probe.ground(x, z, startY);
      if (!hit) { this.rejected.noGround++; return null; }
      if (hit.normal.y < maxSlope) { this.rejected.steep++; return null; }
      gy = hit.point.y;
      normal = hit.normal;
    }
    if (!ignoreOccupancy && !this.probe.isFree(x, z, foot * 0.82)) {
      this.rejected.occupied++;
      return null;
    }

    // Orientation: yaw, then a small lean, then optional slope alignment.
    _e.set(0, yaw, 0);
    _q.setFromEuler(_e);
    if (tilt !== 0) {
      _v.set(Math.cos(tiltDir), 0, Math.sin(tiltDir));
      _q2.setFromAxisAngle(_v, tilt);
      _q.premultiply(_q2);
    }
    if (align > 0 && normal !== _up) {
      _q2.setFromUnitVectors(_up, normal);
      _q2.slerp(new THREE.Quaternion(), 1 - align);
      _q.premultiply(_q2);
    }
    _scale.setScalar(scale);

    // Provisional transform at y=0, then measure the real base and re-seat.
    _v.set(x, 0, z);
    _mat.compose(_v, _q, _scale);
    _box.copy(bb).applyMatrix4(_mat);
    const baseOffset = _box.min.y;                    // relative to y = 0

    // Sample contact under the footprint corners, not just the centre, so a prop
    // straddling a kerb rests on the high side instead of sinking into it.
    let contact = gy;
    if (!stacked) {
      const probes = [
        [foot * 0.7, 0], [-foot * 0.7, 0], [0, foot * 0.7], [0, -foot * 0.7],
      ];
      let hits = 0;
      let lo = gy;
      for (const [ox, oz] of probes) {
        const h = this.probe.ground(x + ox, z + oz, gy + 1.4);
        if (!h) continue;
        hits++;
        if (h.point.y > contact) contact = h.point.y;
        if (h.point.y < lo) lo = h.point.y;
      }
      // A prop whose footprint hangs off a roof edge or straddles a step reads as
      // floating from most angles, so it is refused rather than fudged.
      if (hits < probes.length) { this.rejected.overhang++; return null; }
      if (contact - lo > 0.15) { this.rejected.overhang++; return null; }
    }

    const bite = stacked ? 0.004 : sink;
    const py = contact - baseOffset - bite;
    _v.set(x, py, z);
    _mat.compose(_v, _q, _scale);

    // --- validation: nothing may hover, nothing may sink out of sight -------
    _box.copy(bb).applyMatrix4(_mat);
    if (!stacked) {
      const gap = this._measureGap(_box, x, z);
      if (gap > this.tolerance) {
        _v.y -= gap;                                  // one correction pass
        _mat.compose(_v, _q, _scale);
        _box.copy(bb).applyMatrix4(_mat);
        if (this._measureGap(_box, x, z) > this.tolerance) {
          this.rejected.floating++;
          return null;
        }
      }
      const height = bb.max.y - bb.min.y;
      if (contact - _box.min.y > height * 0.75 + sink) { this.rejected.buried++; return null; }
    }

    if (!ignoreOccupancy) this.probe.claim(x, z, foot * 0.82 * claimScale);
    /*
     * GROUND marks this transform for the mesh-accurate contact pass.
     * ATTACHED exempts a rigid pair — re-seating half of a two-material machine
     * against the world would shear it apart, and the four-corner probe above
     * has already validated it.
     * Everything else (a prop resting on another prop) is left unflagged, which
     * hands it to ContactPass.audit: its support is not in the world snapshot,
     * so it has to be checked against the registry of prop tops instead.
     */
    let flags = GROUND;
    if (!verifyContact) flags = ATTACHED;
    else if (stacked) flags = 0;
    this.batcher.add(key, _mat, tint, tintColour, flags);
    const matrix = _mat.clone();
    // `snapped` marks the placements the contact audit is allowed to verify:
    // a prop resting on another prop has no world surface under it to test.
    this.placed.push({ key, x, y: _v.y, z, r: foot, snapped: !stacked, matrix });
    return { x, y: _v.y, z, top: _box.max.y, radius: foot, matrix };
  }

  /** Vertical distance from a box base to the surface beneath it. */
  _measureGap(bbWorld, x, z) {
    const y0 = bbWorld.min.y;
    const h = this.probe.ground(x, z, y0 + 0.6);
    if (!h) return Infinity;
    return y0 - h.point.y;
  }

  report() {
    return {
      placed: this.placed.length,
      ...this.rejected,
    };
  }
}
