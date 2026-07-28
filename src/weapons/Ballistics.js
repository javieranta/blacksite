import * as THREE from 'three';
import { SURFACES } from '../core/Constants.js';
import { BALLISTICS } from './WeaponData.js';
import { CastWorld, makeHit } from './ballistics/CastWorld.js';
import { ActorRegistry, makeActorHit } from './ballistics/Actors.js';

/**
 * OWNER: ballistics agent.
 * CONTRACT:
 *   listens: 'weapon:fire'
 *   emits:   'hit:surface'   { point, normal, surface, incoming, energy, exit, ... }
 *            'hit:actor'     { actor, point, normal, damage, headshot, hitbox, ... }
 *            'hit:ricochet'  { point, normal, incoming, outgoing, surface, ... }
 *            'actor:death'   { actor, point, ... }
 *            'tracer'        { origin, dir, end, distance, velocity, hitscan, ... }
 *            'whizby'        { actor, point, distance, weapon, shooter }
 *   ballistics.registerActor(obj, { hitboxes, health, onDamage, onDeath })
 *   ballistics.fire({ origin, dir, weapon, shooter, damageScale })  — AI calls this
 *   ballistics.lineOfSight(from, to)                                — AI calls this
 *
 * THE MODEL. One code path serves both hitscan and travel-time rounds: a bullet
 * is a state record (position, velocity, energy) that is *marched* in segments.
 *
 *   - A fast round (>= BALLISTICS.hitscanVelocity: the 880 m/s rifle, the 840 m/s
 *     marksman rifle) is marched to completion inside `fire()`, so it lands on the
 *     same frame it was fired. It still gets gravity, because the march is
 *     segmented — 48 m per cast — and gravity is integrated between segments.
 *     A 5.56 round drops ~120 mm at 140 m, which is what it should do.
 *   - A slow round (the 400 m/s SMG) is marched by `fixedUpdate` at 1/120 s per
 *     tick: 3.3 m per tick, visibly lagging behind the rifle over any real
 *     distance. Same gravity, same quadratic drag, same penetration.
 *
 *   Impacts consume ENERGY, starting at 1.0. Crossing a material costs energy in
 *   proportion to its thickness (found with a BACK-face probe cast — that is why
 *   this system talks to the BVH directly instead of through THREE.Raycaster) and
 *   in inverse proportion to the round's penetration rating. If energy survives,
 *   the round continues from the exit face with reduced damage and a second
 *   'hit:surface' is emitted on the far side for the exit spall.
 *
 *   Grazing impacts on hard surfaces (concrete, metal) may deflect instead of
 *   penetrating, at a probability that rises as the angle gets shallower.
 */
export class Ballistics {
  constructor() {
    this.name = 'ballistics';

    this.world = new CastWorld();
    this.registry = new ActorRegistry();
    /** Legacy field from the original contract — the registry's record set. */
    this.actors = this.registry.actors;

    this._hit = makeHit();
    this._exit = makeHit();
    this._probe = makeHit();
    this._ah = makeActorHit();

    /** @type {Array<object>} pooled bullet records — never grows at runtime */
    this._rounds = [];
    for (let i = 0; i < BALLISTICS.maxRounds; i++) {
      this._rounds.push({
        i, active: false, hitscan: true, tracer: false, shot: 0,
        pos: new THREE.Vector3(), vel: new THREE.Vector3(), dir: new THREE.Vector3(0, 0, -1),
        weapon: null, shooter: null, skipActor: null,
        energy: 1, penMul: 1, damageScale: 1, travelled: 0, penetrations: 0,
        whizPlayer: false,
      });
    }
    this._live = 0;
    this._cursor = 0;
    this._shotId = 0;
    this._tracerCount = 0;

    // scratch — the march never allocates
    this._v = new THREE.Vector3();
    this._n = new THREE.Vector3();
    this._e = new THREE.Vector3();
    this._u = new THREE.Vector3();
    this._inc = new THREE.Vector3();
    this._t1 = new THREE.Vector3();
    this._t2 = new THREE.Vector3();

    this._seed = 0x6d2b79f5;
    this._syncTimer = 0;
    this._wr = null;
    this._wctx = null;
    this._whizCb = (rec, dist, point) => this._onWhizby(rec, dist, point);

    this.stats = {
      shots: 0, impacts: 0, penetrations: 0, ricochets: 0,
      hits: 0, headshots: 0, kills: 0, whizby: 0, live: 0,
    };
  }

  init(ctx) {
    this.ctx = ctx;
    this.level = ctx.require('level');
    this.forge = ctx.require('forge');
    this.world.build(this.level, this.forge);
    console.info(
      `[ballistics] BVH cast world: ${this.world.count} targets`
      + ` from ${this.level.colliders.children.length} collider roots`,
    );
    ctx.bus.on('weapon:fire', (e) => this.fire(e));
  }

  // ---------------------------------------------------------------- actors ---

  /**
   * @param {THREE.Object3D} object
   * @param {object} [opts] hitboxes, health, team, onDamage(dmg, info), onDeath(info),
   *   centre, radius, height. Omit `hitboxes` and a humanoid set is synthesised
   *   from the object's bounds, with a real head box.
   * @returns {Function} unregister
   */
  registerActor(object, opts = {}) {
    const rec = this.registry.register(object, opts);
    return () => this.registry.unregister(rec);
  }

  /** Direct access for the AI system (cover scoring, target validation). */
  actorRecord(object) {
    for (const rec of this.registry.list) if (rec.object === object) return rec;
    return null;
  }

  /** Is the straight line between two points clear of world geometry? */
  lineOfSight(from, to, slack = 0.05) {
    this._v.copy(to).sub(from);
    const len = this._v.length();
    if (len < 1e-4) return true;
    this._v.multiplyScalar(1 / len);
    return !this.world.cast(from, this._v, slack, len - slack, THREE.DoubleSide, this._probe);
  }

  /** Single BVH cast against the world. The record is shared — copy what you keep. */
  raycast(origin, dir, maxDist = BALLISTICS.maxRange) {
    return this.world.cast(origin, dir, 1e-3, maxDist, THREE.FrontSide, this._probe)
      ? this._probe : null;
  }

  // ------------------------------------------------------------------ fire ---

  /**
   * @param {object} e { origin, dir, weapon, shooter?, damageScale?, tracer? }
   *   `dir` need not be normalised. `shooter` is 'player' or an actor record.
   */
  fire(e) {
    const w = e?.weapon;
    if (!w || !e.origin || !e.dir) return null;
    this.world.sync(this.level, this.forge);

    const r = this._acquire();
    const speed = Math.max(80, w.muzzleVelocity ?? 800);
    r.weapon = w;
    r.shooter = e.shooter ?? 'player';
    r.pos.copy(e.origin);
    r.dir.copy(e.dir).normalize();
    r.vel.copy(r.dir).multiplyScalar(speed);
    r.energy = 1;
    r.penMul = 1;
    r.damageScale = e.damageScale ?? 1;
    r.travelled = 0;
    r.penetrations = 0;
    r.skipActor = null;
    r.whizPlayer = false;
    r.hitscan = speed >= BALLISTICS.hitscanVelocity;
    r.shot = ++this._shotId;
    r.active = true;
    this._live++;
    this.stats.shots++;
    this.stats.live = this._live;

    // Real belts load one tracer every few rounds; so do we.
    this._tracerCount++;
    r.tracer = e.tracer ?? (this._tracerCount % BALLISTICS.tracerEvery === 0);
    if (r.tracer) this._emitTracer(r, speed);

    // A fast round resolves entirely now. A slow one is handed to fixedUpdate.
    if (r.hitscan) this._march(r, BALLISTICS.maxRange / speed + 1e-3, this.ctx);
    return r;
  }

  fixedUpdate(h, ctx) {
    this._syncTimer += h;
    if (this._syncTimer > 1.5) { this._syncTimer = 0; this.world.sync(this.level, this.forge); }
    this.stats.live = this._live;
    if (this._live === 0) return;
    const rounds = this._rounds;
    for (let i = 0; i < rounds.length; i++) {
      const r = rounds[i];
      if (r.active) this._march(r, h, ctx);
    }
  }

  // ----------------------------------------------------------------- march ---

  /** Advance a round by up to `budget` seconds of flight. */
  _march(r, budget, ctx) {
    let time = budget;
    let guard = 0;
    while (r.active && time > 1e-7 && guard++ < BALLISTICS.maxSegments) {
      const speed = r.vel.length();
      if (speed < BALLISTICS.minSpeed || r.energy <= BALLISTICS.minEnergy) { this._retire(r); break; }
      r.dir.copy(r.vel).multiplyScalar(1 / speed);

      let seg = speed * time;
      if (seg > BALLISTICS.segmentLength) seg = BALLISTICS.segmentLength;
      const left = BALLISTICS.maxRange - r.travelled;
      if (seg > left) seg = left;
      if (seg <= 1e-4) { this._retire(r); break; }

      const wHit = this.world.cast(r.pos, r.dir, 1e-3, seg, THREE.FrontSide, this._hit);
      const aHit = this.registry.cast(
        r.pos, r.dir, 1e-3, wHit ? this._hit.distance : seg, r.skipActor, this._ah,
      );

      // Suppression: everything the round passes close to along this leg.
      this._whizby(r, aHit ? this._ah.distance : (wHit ? this._hit.distance : seg), ctx);

      let flown;
      if (aHit) flown = this._onActor(r, ctx);
      else if (wHit) flown = this._onSurface(r, ctx);
      else { r.pos.addScaledVector(r.dir, seg); r.travelled += seg; flown = seg; }

      const dt = flown / speed;
      time -= dt;
      // Semi-implicit integration between segments: gravity over the time flown,
      // quadratic drag over the distance flown.
      r.vel.y += BALLISTICS.gravity * dt;
      if (flown > 0) r.vel.multiplyScalar(Math.exp(-BALLISTICS.dragPerMetre * flown));
      if (r.active && r.travelled >= BALLISTICS.maxRange - 1e-3) this._retire(r);
    }
    // A hitscan round's whole flight is this one call. If it left the loop still
    // alive — the segment guard trips on a round that ricochets repeatedly — it
    // must be retired here, or it leaks a pool slot that nothing will ever step.
    if (r.active && r.hitscan) this._retire(r);
  }

  /** @returns {number} metres of travel consumed by this impact */
  _onSurface(r, ctx) {
    const hit = this._hit;
    const dist = hit.distance;
    r.travelled += dist;
    r.pos.copy(hit.point);
    if (hit.normal.dot(r.dir) > 0) hit.normal.negate();
    const cos = -hit.normal.dot(r.dir);
    const key = hit.surface;
    const surf = SURFACES[key] ?? SURFACES.concrete;
    this.stats.impacts++;
    this._emitSurface(r, hit.point, hit.normal, key, cos, false, ctx);

    // --- ricochet: shallow angle on something hard --------------------------
    if (cos < BALLISTICS.ricochetCos && surf.hardness >= BALLISTICS.ricochetMinHardness
        && r.energy > 0.22) {
      const chance = surf.hardness * (1 - cos / BALLISTICS.ricochetCos) * r.energy;
      if (this._rand() < chance) { this._ricochet(r, hit, key, ctx); return dist; }
    }

    // --- penetration: probe for the exit face -------------------------------
    const eps = 0.004;
    const entryTarget = hit._target;
    this._v.copy(hit.point).addScaledVector(r.dir, eps);
    // The exit face must belong to the object we just entered, otherwise a wall
    // 1 m behind a thin sheet would be measured as one metre of sheet metal.
    const through = this.world.cast(
      this._v, r.dir, 0, BALLISTICS.probeDepth, THREE.BackSide, this._exit, entryTarget,
    );
    const thickness = through ? this._exit.distance + eps : BALLISTICS.probeDepth;
    const hard = (1 - surf.penetration) * (1 - surf.penetration) + BALLISTICS.hardFloor;
    const cost = thickness * BALLISTICS.penetrationCost * hard
      / Math.max(0.08, r.weapon.penetration ?? 0.4);

    if (cost >= r.energy - BALLISTICS.minEnergy
        || r.penetrations >= BALLISTICS.maxPenetrations) {
      this._retire(r);
      return dist;
    }

    if (through) this._e.copy(this._exit.point); else this._e.copy(this._v).addScaledVector(r.dir, BALLISTICS.probeDepth);
    r.energy -= cost;
    r.penMul *= BALLISTICS.penDamageTax;
    r.penetrations++;
    this.stats.penetrations++;

    if (through) {
      // Exit spall: normal faces outward on the far side, i.e. along travel.
      this._n.copy(this._exit.normal);
      if (this._n.dot(r.dir) < 0) this._n.negate();
      this._emitSurface(r, this._e, this._n, key, cos, true, ctx);
    }
    r.pos.copy(this._e).addScaledVector(r.dir, 0.003);
    r.travelled += thickness;
    // Yaw instability from the material — a post-penetration round is not accurate.
    this._deflect(r.vel, BALLISTICS.penDeflect * (1.2 - r.energy));
    return dist + thickness;
  }

  /** @returns {number} metres of travel consumed */
  _onActor(r, ctx) {
    const ah = this._ah;
    const rec = ah.record;
    const dist = ah.distance;
    r.travelled += dist;
    r.pos.copy(ah.point);

    const w = r.weapon;
    const fall = Ballistics.falloff(w, r.travelled);
    const hs = ah.headshot;
    const damage = (w.damage ?? 25) * fall * r.energy * r.penMul
      * ah.multiplier * (hs ? (w.headshotMultiplier ?? 2) : 1) * r.damageScale;

    this.stats.hits++;
    if (hs) this.stats.headshots++;

    const payload = {
      actor: rec.object,
      record: rec,
      point: ah.point.clone(),
      normal: ah.normal.clone(),
      damage,
      headshot: hs,
      hitbox: ah.name,
      surface: 'flesh',
      incoming: r.dir.clone(),
      distance: r.travelled,
      energy: r.energy,
      weapon: w,
      shooter: r.shooter,
      penetrated: r.penetrations > 0,
    };
    ctx.bus.emit('hit:actor', payload);

    let remaining = rec.health - damage;
    if (rec.onDamage) {
      const res = rec.onDamage(damage, payload);
      if (typeof res === 'number') remaining = res;
    }
    rec.health = remaining;
    if (remaining <= 0 && !rec.dead) {
      rec.dead = true;
      this.stats.kills++;
      ctx.bus.emit('actor:death', {
        actor: rec.object,
        record: rec,
        point: ah.point.clone(),
        killer: r.shooter,
        weapon: w,
        headshot: hs,
      });
      rec.onDeath?.(payload);
    }

    // Over-penetration through a body: flesh is soft, but 300 mm of it stops
    // most pistol calibres and lets a 7.62 keep going.
    const surf = SURFACES.flesh;
    const hard = (1 - surf.penetration) * (1 - surf.penetration) + BALLISTICS.hardFloor;
    const cost = ah.thickness * BALLISTICS.penetrationCost * hard
      / Math.max(0.08, w.penetration ?? 0.4);
    if (cost >= r.energy - BALLISTICS.minEnergy
        || r.penetrations >= BALLISTICS.maxPenetrations) {
      this._retire(r);
      return dist;
    }
    r.energy -= cost;
    r.penMul *= BALLISTICS.penDamageTax;
    r.penetrations++;
    r.skipActor = rec;
    r.pos.addScaledVector(r.dir, ah.thickness + 0.006);
    r.travelled += ah.thickness;
    return dist + ah.thickness;
  }

  _ricochet(r, hit, key, ctx) {
    // Dedicated scratch: `_u` is the deflection basis vector and would be
    // overwritten by `_deflect` before the event is built.
    this._inc.copy(r.dir);
    r.vel.reflect(hit.normal);
    this._deflect(r.vel, BALLISTICS.ricochetSpread);
    r.vel.multiplyScalar(BALLISTICS.ricochetEnergy);
    r.energy *= BALLISTICS.ricochetEnergy;
    r.penMul *= BALLISTICS.ricochetDamage;
    r.pos.copy(hit.point).addScaledVector(hit.normal, 0.006);
    this.stats.ricochets++;
    this._n.copy(r.vel).normalize();
    ctx.bus.emit('hit:ricochet', {
      point: hit.point.clone(),
      normal: hit.normal.clone(),
      incoming: this._inc.clone(),
      outgoing: this._n.clone(),
      surface: key,
      energy: r.energy,
      weapon: r.weapon,
      distance: r.travelled,
      shooter: r.shooter,
    });
  }

  // ----------------------------------------------------------------- events ---

  _emitSurface(r, point, normal, key, cos, exit, ctx) {
    ctx.bus.emit('hit:surface', {
      point: point.clone(),
      normal: normal.clone(),
      surface: key,
      incoming: r.dir.clone(),
      energy: r.energy,
      angle: cos,
      exit,
      weapon: r.weapon,
      distance: r.travelled,
      shooter: r.shooter,
      penetrated: r.penetrations > 0,
    });
  }

  /**
   * Tracers carry the whole ray so FX can draw a streak in one go. The terminal
   * point comes from a straight predictive cast, which costs one extra traversal
   * on the one-in-three rounds that are actually tracers.
   */
  _emitTracer(r, speed) {
    const hitEnd = this.world.cast(
      r.pos, r.dir, 0.02, BALLISTICS.maxRange, THREE.FrontSide, this._probe,
    );
    if (hitEnd) this._e.copy(this._probe.point);
    else this._e.copy(r.pos).addScaledVector(r.dir, BALLISTICS.maxRange);
    const distance = r.pos.distanceTo(this._e);
    this.ctx.bus.emit('tracer', {
      origin: r.pos.clone(),
      dir: r.dir.clone(),
      end: this._e.clone(),
      distance,
      velocity: speed,
      travelTime: distance / speed,
      hitscan: r.hitscan,
      weapon: r.weapon,
      shooter: r.shooter,
      seed: r.shot,
    });
  }

  _whizby(r, length, ctx) {
    if (length <= 0) return;
    this._wr = r;
    this._wctx = ctx;
    this.registry.forEachNear(
      r.pos, r.dir, length, BALLISTICS.whizbyRadius, r.shot, this._v, this._whizCb,
    );
    // The player is not in the actor registry; suppress them explicitly.
    if (r.shooter !== 'player' && !r.whizPlayer) {
      const cam = ctx.camera.position;
      const lx = cam.x - r.pos.x, ly = cam.y - r.pos.y, lz = cam.z - r.pos.z;
      let t = lx * r.dir.x + ly * r.dir.y + lz * r.dir.z;
      if (t < 0) t = 0; else if (t > length) t = length;
      this._u.copy(r.pos).addScaledVector(r.dir, t);
      const d = this._u.distanceTo(cam);
      if (d < BALLISTICS.whizbyRadius) {
        r.whizPlayer = true;
        this.stats.whizby++;
        ctx.bus.emit('whizby', {
          actor: null, player: true, point: this._u.clone(), distance: d,
          weapon: r.weapon, shooter: r.shooter, dir: r.dir.clone(),
        });
      }
    }
  }

  _onWhizby(rec, dist, point) {
    const r = this._wr;
    if (rec === r.shooter) return;
    this.stats.whizby++;
    this._wctx.bus.emit('whizby', {
      actor: rec.object, record: rec, player: false,
      point: point.clone(), distance: dist,
      weapon: r.weapon, shooter: r.shooter, dir: r.dir.clone(),
    });
  }

  // ------------------------------------------------------------------ pool ---

  _acquire() {
    const rounds = this._rounds;
    const n = rounds.length;
    for (let k = 0; k < n; k++) {
      const i = (this._cursor + k) % n;
      if (!rounds[i].active) { this._cursor = (i + 1) % n; return rounds[i]; }
    }
    // Saturated: recycle the oldest slot rather than dropping the shot.
    const r = rounds[this._cursor];
    this._cursor = (this._cursor + 1) % n;
    if (r.active) { r.active = false; this._live--; }
    return r;
  }

  _retire(r) {
    if (!r.active) return;
    r.active = false;
    r.skipActor = null;
    this._live--;
    this.stats.live = this._live;
  }

  /** Perturb a velocity inside a small cone, keeping its magnitude. */
  _deflect(vel, amount) {
    if (amount <= 1e-6) return;
    const len = vel.length();
    if (len < 1e-5) return;
    this._u.copy(vel).multiplyScalar(1 / len);
    if (Math.abs(this._u.y) > 0.95) this._t1.set(1, 0, 0); else this._t1.set(0, 1, 0);
    this._t1.cross(this._u).normalize();
    this._t2.copy(this._u).cross(this._t1);
    const a = Math.sqrt(this._rand()) * amount;
    const th = this._rand() * Math.PI * 2;
    this._u.addScaledVector(this._t1, Math.cos(th) * a)
      .addScaledVector(this._t2, Math.sin(th) * a)
      .normalize();
    vel.copy(this._u).multiplyScalar(len);
  }

  /** mulberry32 — deterministic per session, so a replayed burst is identical. */
  _rand() {
    let t = (this._seed = (this._seed + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Damage at range, from the weapon's falloff curve. */
  static falloff(weapon, distance) {
    const c = weapon.damageFalloff;
    if (!c?.length) return 1;
    if (distance <= c[0][0]) return c[0][1];
    for (let i = 1; i < c.length; i++) {
      if (distance <= c[i][0]) {
        const t = (distance - c[i - 1][0]) / (c[i][0] - c[i - 1][0]);
        return THREE.MathUtils.lerp(c[i - 1][1], c[i][1], t);
      }
    }
    return c[c.length - 1][1];
  }

  dispose() {
    this.world.dispose();
    this.registry.dispose();
    this._live = 0;
    for (const r of this._rounds) r.active = false;
  }
}
