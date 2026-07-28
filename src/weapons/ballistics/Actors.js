import * as THREE from 'three';

/**
 * OWNER: ballistics agent (private to src/weapons/ballistics).
 *
 * The actor/hitbox registry behind `ballistics.registerActor()`.
 *
 * Hitboxes live in the ACTOR'S LOCAL FRAME, so one matrix inverse per actor per
 * cast converts the bullet into a space where every box is axis-aligned. That is
 * the whole trick: a humanoid with eight hitboxes costs one inverse and eight
 * slab tests, not eight inverses.
 *
 * A hitbox may name a `node` (an Object3D from the actor's rig). Its centre is
 * then read from that node's world matrix every cast, so boxes track animation
 * without the AI system having to push anything back to us.
 *
 * If the AI registers an actor with no hitboxes we synthesise a humanoid set
 * from the object's bounding box — enemies are always shootable, and headshots
 * always work, even before the AI system authors its own rig.
 */

const _box3 = new THREE.Box3();
const _v = new THREE.Vector3();
const _o = new THREE.Vector3();
const _d = new THREE.Vector3();
const _inv = new THREE.Matrix4();
const _nrm = new THREE.Matrix3();
const _min = new THREE.Vector3();
const _max = new THREE.Vector3();

export function makeActorHit() {
  return {
    /** the registry record */ record: null,
    /** the Object3D the AI registered */ object: null,
    name: '', multiplier: 1, headshot: false,
    distance: 0, thickness: 0,
    point: new THREE.Vector3(),
    normal: new THREE.Vector3(),
  };
}

const asVec = (v, dx, dy, dz) => {
  if (!v) return { x: dx, y: dy, z: dz };
  if (Array.isArray(v)) return { x: v[0] ?? dx, y: v[1] ?? dy, z: v[2] ?? dz };
  return { x: v.x ?? dx, y: v.y ?? dy, z: v.z ?? dz };
};

/** A believable humanoid set, scaled to the actor's measured height. */
function defaultHumanoid(height) {
  const H = height > 0.4 ? height : 1.8;
  const s = H / 1.8;
  return [
    { name: 'head', headshot: true, multiplier: 1.0, offset: [0, H - 0.13 * s, 0], size: [0.21 * s, 0.25 * s, 0.23 * s] },
    { name: 'neck', multiplier: 1.35, offset: [0, H - 0.28 * s, 0], size: [0.15 * s, 0.10 * s, 0.15 * s] },
    { name: 'chest', multiplier: 1.0, offset: [0, H * 0.72, 0], size: [0.46 * s, 0.34 * s, 0.26 * s] },
    { name: 'stomach', multiplier: 1.0, offset: [0, H * 0.55, 0], size: [0.40 * s, 0.24 * s, 0.24 * s] },
    // The pelvis exists so a shot at hip height down the centreline connects.
    // Two leg boxes alone leave a hole between the thighs you could drive a
    // magazine through, and nothing looks worse than a centred miss.
    { name: 'pelvis', multiplier: 1.0, offset: [0, H * 0.41, 0], size: [0.36 * s, 0.24 * s, 0.24 * s] },
    { name: 'arm_l', multiplier: 0.72, offset: [-0.30 * s, H * 0.66, 0], size: [0.14 * s, 0.56 * s, 0.16 * s] },
    { name: 'arm_r', multiplier: 0.72, offset: [0.30 * s, H * 0.66, 0], size: [0.14 * s, 0.56 * s, 0.16 * s] },
    { name: 'leg_l', multiplier: 0.68, offset: [-0.11 * s, H * 0.16, 0], size: [0.20 * s, H * 0.36, 0.21 * s] },
    { name: 'leg_r', multiplier: 0.68, offset: [0.11 * s, H * 0.16, 0], size: [0.20 * s, H * 0.36, 0.21 * s] },
  ];
}

export class ActorRegistry {
  constructor() {
    /** @type {Set<object>} kept as a Set because the old contract exposed one */
    this.actors = new Set();
    /** @type {Array<object>} iteration order, no allocation on cast */
    this.list = [];
  }

  register(object, opts = {}) {
    if (!object) throw new Error('[ballistics] registerActor needs an Object3D');
    object.updateWorldMatrix(true, true);

    let height = opts.height ?? 0;
    let radius = opts.radius ?? 0;
    if (!height || !radius) {
      _box3.makeEmpty();
      try { _box3.setFromObject(object); } catch { /* empty rig */ }
      if (!_box3.isEmpty()) {
        _box3.getSize(_v);
        if (!height) height = _v.y;
        if (!radius) radius = 0.5 * Math.hypot(_v.x, _v.y, _v.z) + 0.05;
      }
    }
    if (!height) height = 1.8;
    if (!radius) radius = 1.15;

    const raw = opts.hitboxes?.length ? opts.hitboxes : defaultHumanoid(height);
    const hitboxes = raw.map((h, i) => {
      const off = asVec(h.offset ?? h.centre ?? h.center, 0, height * 0.6, 0);
      const half = h.radius
        ? { x: h.radius, y: h.radius, z: h.radius }
        : (() => { const s = asVec(h.size, 0.3, 0.3, 0.3); return { x: s.x * 0.5, y: s.y * 0.5, z: s.z * 0.5 }; })();
      return {
        name: h.name ?? `box_${i}`,
        headshot: !!(h.headshot ?? (h.name === 'head')),
        multiplier: h.multiplier ?? 1,
        node: h.node ?? null,
        ox: off.x, oy: off.y, oz: off.z,
        hx: Math.max(0.01, half.x), hy: Math.max(0.01, half.y), hz: Math.max(0.01, half.z),
      };
    });

    const rec = {
      object,
      hitboxes,
      height,
      radius,
      // Broadphase sphere centre, in the actor's local frame.
      cx: 0, cy: height * 0.5, cz: 0,
      maxHealth: opts.health ?? 100,
      health: opts.health ?? 100,
      dead: false,
      team: opts.team ?? 'enemy',
      onDamage: opts.onDamage ?? null,
      onDeath: opts.onDeath ?? null,
      userData: opts.userData ?? null,
      _whiz: -1,
    };
    if (opts.centre) {
      const c = asVec(opts.centre, 0, height * 0.5, 0);
      rec.cx = c.x; rec.cy = c.y; rec.cz = c.z;
    }

    this.actors.add(rec);
    this.list.push(rec);
    return rec;
  }

  unregister(rec) {
    if (!rec) return;
    this.actors.delete(rec);
    const i = this.list.indexOf(rec);
    if (i >= 0) this.list.splice(i, 1);
  }

  /** World-space broadphase centre of an actor, written into `out`. */
  centreOf(rec, out) {
    return out.set(rec.cx, rec.cy, rec.cz).applyMatrix4(rec.object.matrixWorld);
  }

  /**
   * Nearest hitbox hit along the segment. `skip` lets a penetrating round ignore
   * the actor it just punched through.
   * @returns {boolean} true if `out` was written
   */
  cast(origin, dir, near, far, skip, out) {
    let best = far;
    let found = false;
    const list = this.list;

    for (let ai = 0; ai < list.length; ai++) {
      const rec = list[ai];
      if (rec === skip || rec.dead) continue;
      const obj = rec.object;
      if (!obj.visible || !obj.parent) continue;

      // --- sphere broadphase ------------------------------------------------
      this.centreOf(rec, _v);
      const lx = _v.x - origin.x, ly = _v.y - origin.y, lz = _v.z - origin.z;
      const tca = lx * dir.x + ly * dir.y + lz * dir.z;
      const r2 = rec.radius * rec.radius;
      const perp = lx * lx + ly * ly + lz * lz - tca * tca;
      if (perp > r2) continue;
      const thc = Math.sqrt(Math.max(0, r2 - perp));
      if (tca + thc < near || tca - thc > best) continue;

      // --- into actor-local space -------------------------------------------
      _inv.copy(obj.matrixWorld).invert();
      _o.copy(origin).applyMatrix4(_inv);
      _d.copy(origin).add(dir).applyMatrix4(_inv).sub(_o);
      const k = _d.length();
      if (k < 1e-9) continue;
      _d.multiplyScalar(1 / k);

      for (let hi = 0; hi < rec.hitboxes.length; hi++) {
        const hb = rec.hitboxes[hi];
        let cxl = hb.ox, cyl = hb.oy, czl = hb.oz;
        if (hb.node) {
          _v.setFromMatrixPosition(hb.node.matrixWorld).applyMatrix4(_inv);
          cxl = _v.x + hb.ox; cyl = _v.y + hb.oy; czl = _v.z + hb.oz;
        }
        _min.set(cxl - hb.hx, cyl - hb.hy, czl - hb.hz);
        _max.set(cxl + hb.hx, cyl + hb.hy, czl + hb.hz);

        // slab test in local units, tracking entry axis for the surface normal
        let t0 = -Infinity, t1 = Infinity, axis = 1, sign = 1;
        for (let c = 0; c < 3; c++) {
          const oc = c === 0 ? _o.x : c === 1 ? _o.y : _o.z;
          const dc = c === 0 ? _d.x : c === 1 ? _d.y : _d.z;
          const mn = c === 0 ? _min.x : c === 1 ? _min.y : _min.z;
          const mx = c === 0 ? _max.x : c === 1 ? _max.y : _max.z;
          if (Math.abs(dc) < 1e-9) {
            if (oc < mn || oc > mx) { t0 = Infinity; break; }
            continue;
          }
          const invd = 1 / dc;
          let lo = (mn - oc) * invd, hi2 = (mx - oc) * invd;
          let s = -1;
          if (lo > hi2) { const t = lo; lo = hi2; hi2 = t; s = 1; }
          if (lo > t0) { t0 = lo; axis = c; sign = s; }
          if (hi2 < t1) t1 = hi2;
          if (t0 > t1) { t0 = Infinity; break; }
        }
        if (!(t0 < t1) || t0 === Infinity) continue;

        const wEnter = Math.max(t0, 0) / k;
        if (wEnter < near || wEnter >= best) continue;

        best = wEnter;
        found = true;
        out.record = rec;
        out.object = obj;
        out.name = hb.name;
        out.multiplier = hb.multiplier;
        out.headshot = hb.headshot;
        out.distance = wEnter;
        out.thickness = Math.max(0.02, (t1 - Math.max(t0, 0)) / k);
        out.point.copy(origin).addScaledVector(dir, wEnter);
        // Local axis normal -> world.
        _v.set(axis === 0 ? sign : 0, axis === 1 ? sign : 0, axis === 2 ? sign : 0);
        _nrm.getNormalMatrix(obj.matrixWorld);
        out.normal.copy(_v).applyMatrix3(_nrm).normalize();
        if (out.normal.dot(dir) > 0) out.normal.negate();
      }
    }
    return found;
  }

  /**
   * Perpendicular distance from a segment to each live actor's centre. Used for
   * suppression ('whizby'). `cb(rec, distance, closestPoint)`; `point` is a
   * shared scratch vector — copy it if you need to keep it.
   */
  forEachNear(origin, dir, length, radius, roundId, point, cb) {
    const list = this.list;
    for (let i = 0; i < list.length; i++) {
      const rec = list[i];
      if (rec.dead || rec._whiz === roundId) continue;
      if (!rec.object.visible || !rec.object.parent) continue;
      this.centreOf(rec, _v);
      const lx = _v.x - origin.x, ly = _v.y - origin.y, lz = _v.z - origin.z;
      let t = lx * dir.x + ly * dir.y + lz * dir.z;
      if (t < 0) t = 0; else if (t > length) t = length;
      point.copy(origin).addScaledVector(dir, t);
      const dist = point.distanceTo(_v);
      if (dist > radius) continue;
      rec._whiz = roundId;
      cb(rec, dist, point);
    }
  }

  dispose() {
    this.actors.clear();
    this.list.length = 0;
  }
}
