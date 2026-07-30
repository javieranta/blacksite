import * as THREE from 'three';
import { buildFragGeometry, buildFragMaterial } from './grenades/FragModel.js';

/**
 * OWNER: weapons agent.
 *
 * Player hand grenades. Driven by WeaponSystem (which owns a single instance and
 * forwards init/update/fixedUpdate) rather than registered separately, because
 * src/main.js belongs to another agent and the registration list is frozen.
 * Reachable as `ctx.get('weapons').grenades`.
 *
 * CONTRACT
 *   grenades.count       : rounds of ordnance left (finite, no resupply)
 *   grenades.cooking     : the pin is out and the grenade is still in hand
 *   grenades.fuseLeft    : seconds before it goes off, cooked or thrown
 *   grenades.beginCook() / .release() / .throwNow(opts) / .damageAt(p, target)
 *   emits: 'grenade:cook'  { phase:'start'|'end', fuse }
 *          'grenade:throw' { origin, dir, velocity, cookTime, fuse, count }
 *          'grenade:bounce'{ point, normal, speed }
 *          'grenade:hit'   { actor, damage, killed, point }   — HUD hitmarker
 *          'explosion'     { point, radius, damage }  — the frozen payload every
 *                            FX / audio / lighting / post responder already reads
 *          'actor:death'   { actor, record, point, killer, weapon }
 *          'player:damage' { amount, from }
 *   listens: nothing. Input is polled, so a key press cannot be swallowed by a
 *            handler that ran before the system existed.
 *
 * THE MECHANIC
 *   KeyG down pulls the pin: the fuse starts *now*, in your hand. KeyG up throws
 *   whatever is left of it. Hold past the fuse and it goes off against your own
 *   chest — which is the entire point of a cook timer being a timer.
 *
 * THE FLIGHT
 *   Real projectile: launch velocity from the camera forward plus a lift term
 *   plus 60% of the thrower's own velocity, then gravity, quadratic-ish drag,
 *   and swept collision against the level BVH through `level.raycast`. A bounce
 *   splits the velocity into normal and tangential parts and scales them
 *   separately — restitution kills the bounce, friction kills the slide — so a
 *   frag loses energy on every contact and comes to rest instead of skating.
 *
 * THE BLAST
 *   Falloff by distance AND a line-of-sight test per target, so a wall is
 *   genuinely cover. The same `damageAt()` that resolves gameplay damage is the
 *   one the assertion harness measures, so the two cannot drift apart.
 */

/** Tuning. Local to this system on purpose — Constants.js is shared. */
export const GRENADE = {
  stock: 3,              // no resupply
  fuse: 3.4,             // seconds from pin-pull to detonation
  radius: 6.2,           // metres — lethal-ish core, falls off to nothing
  damage: 128,
  falloffPower: 1.35,
  minCookThrow: 0.12,    // below this the release still throws, it just barely leaves

  throwSpeed: 16.5,      // m/s at the hand
  throwLift: 0.24,       // upward component added to the camera forward
  inherit: 0.6,          // fraction of the thrower's velocity carried over
  offsetFwd: 0.42,       // spawn ahead of the eye so it never starts inside you
  offsetRight: 0.13,
  offsetDown: 0.09,
  clearProbe: 0.75,      // if a wall is closer than this, spawn short of it

  gravity: -19.5,        // matches the AI's grenade arc (AIConfig)
  drag: 0.14,            // per second, applied as exp(-drag*dt)
  bodyRadius: 0.034,     // must match the modelled body — see buildFragGeometry
  restitution: 0.34,
  friction: 0.58,
  restSpeed: 0.95,       // a bounce slower than this on level ground stops it
  restNormalY: 0.42,
  maxBounces: 24,
  spinDamp: 2.4,

  selfMinDist: 0.45,     // inside this the blast is unavoidable — no LOS reprieve
  losSlack: 0.30,        // skip the surface the grenade is resting against
};

/** Killfeed / HUD label. Shaped like a weapon def so existing readers cope. */
const FRAG_DEF = {
  id: 'frag', displayName: 'M9 FRAG', calibre: 'HE',
  damage: GRENADE.damage, headshotMultiplier: 1,
};

const POOL = 6;

export class Grenades {
  constructor() {
    this.name = 'grenades';
    this.THREE = THREE;               // the harness builds vectors with this
    this.constants = GRENADE;

    this.count = GRENADE.stock;
    this.cooking = false;
    this.fuseLeft = 0;
    this.cookTime = 0;
    this.lastIndex = 0;
    this.liveCount = 0;

    this.stats = { thrown: 0, detonations: 0, bounces: 0, cookOffs: 0, kills: 0 };

    /** Pooled projectiles. Never grows; a throw with no free slot recycles. */
    this.pool = [];
    for (let i = 0; i < POOL; i++) {
      this.pool.push({
        i, active: false, rest: false, fuse: 0, bounces: 0, travelled: 0,
        pos: new THREE.Vector3(), vel: new THREE.Vector3(),
        spin: new THREE.Vector3(), euler: new THREE.Euler(),
        mesh: null,
      });
    }
    this._cursor = 0;

    // scratch — fixedUpdate and update allocate nothing
    this._v = new THREE.Vector3();
    this._d = new THREE.Vector3();
    this._n = new THREE.Vector3();
    this._t = new THREE.Vector3();
    this._c = new THREE.Vector3();
    this._fwd = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._up = new THREE.Vector3();
    this._origin = new THREE.Vector3();
    this._qa = new THREE.Vector3();     // damageAt() only
    this._qb = new THREE.Vector3();
    this._dbg = {
      active: false, rest: false, bounces: 0, travelled: 0, fuse: 0, speed: 0,
      pos: [0, 0, 0],
    };

    this._wantCook = false;
    this._wantRelease = false;
    this._heldLast = false;
    this._seed = 0x1f2a3b4c;
  }

  // -------------------------------------------------------------------- init --

  init(ctx) {
    this.ctx = ctx;
    this.level = ctx.require('level');
    this.player = ctx.require('player');
    this.input = ctx.get('input');
    this.ballistics = ctx.get('ballistics');
    this.rig = ctx.get('camerarig');
    // AudioEngine is registered AFTER WeaponSystem, so it does not exist yet at
    // this point — caching it here would cache `undefined` for the whole run.
    this.audio = null;

    this.group = new THREE.Group();
    this.group.name = 'weapons:ordnance';
    ctx.scene.add(this.group);

    const geo = buildFragGeometry();
    const mat = buildFragMaterial(ctx.get('forge'));
    this._geo = geo;
    this._mat = mat;
    for (const g of this.pool) {
      const m = new THREE.Mesh(geo, mat);
      m.castShadow = true;
      // NOT optional. With receiveShadow off the frag ignores the CSM entirely
      // and takes full direct sun even when it is lying inside a building's
      // shadow — which is why the macro capture showed a white-hot body on a
      // blue-grey shadowed floor. It looked like an albedo bug and was not one.
      m.receiveShadow = true;
      m.visible = false;
      m.matrixAutoUpdate = true;
      m.frustumCulled = true;
      g.mesh = m;
      this.group.add(m);
    }
  }

  // ------------------------------------------------------------------ input --

  /**
   * Polled rather than event-driven: `input.pressed` is cleared by the flush
   * system at the end of every frame, so an edge only exists during update.
   */
  update(dt) {
    const inp = this.input;
    if (inp) {
      const held = inp.action('grenade');
      if (held && !this._heldLast) this._wantCook = true;
      if (!held && this._heldLast) this._wantRelease = true;
      this._heldLast = held;
    }

    // Visual tumble runs on the render clock so it is smooth at any frame rate.
    for (const g of this.pool) {
      if (!g.active) continue;
      if (!g.rest) {
        g.euler.x += g.spin.x * dt;
        g.euler.y += g.spin.y * dt;
        g.euler.z += g.spin.z * dt;
        const damp = Math.exp(-GRENADE.spinDamp * dt * 0.35);
        g.spin.multiplyScalar(damp);
      }
      g.mesh.position.copy(g.pos);
      g.mesh.rotation.set(g.euler.x, g.euler.y, g.euler.z);
    }
  }

  // ------------------------------------------------------------------- tick --

  fixedUpdate(h, ctx) {
    if (this._wantCook) { this._wantCook = false; this.beginCook(); }
    if (this._wantRelease) { this._wantRelease = false; this.release(); }

    if (this.cooking) {
      this.fuseLeft -= h;
      this.cookTime += h;
      if (this.fuseLeft <= 0) this._cookOff(ctx);
    }

    let live = 0;
    for (const g of this.pool) {
      if (!g.active) continue;
      live++;
      g.fuse -= h;
      if (!g.rest) this._step(g, h, ctx);
      if (g.fuse <= 0) { this._detonate(g, ctx); live--; }
    }
    this.liveCount = live;
  }

  /** One fixed step of swept, bouncing rigid-ish motion. */
  _step(g, h, ctx) {
    g.vel.y += GRENADE.gravity * h;
    g.vel.multiplyScalar(Math.exp(-GRENADE.drag * h));

    const R = GRENADE.bodyRadius;
    let remain = h;
    let guard = 0;
    while (remain > 1e-6 && guard++ < 4) {
      const speed = g.vel.length();
      if (speed < 1e-4) break;
      this._d.copy(g.vel).multiplyScalar(1 / speed);
      const step = speed * remain;

      const hit = this.level.raycast(g.pos, this._d, step + R);
      if (!hit) {
        g.pos.addScaledVector(this._d, step);
        g.travelled += step;
        break;
      }

      // Stop the body's surface at the contact, not its centre.
      const travel = Math.max(0, hit.distance - R);
      g.pos.addScaledVector(this._d, travel);
      g.travelled += travel;
      remain -= travel / speed;

      this._n.copy(hit.normal);
      if (this._n.dot(g.vel) > 0) this._n.negate();
      g.pos.addScaledVector(this._n, 1e-3);

      // Split into normal / tangential and scale each: restitution kills the
      // bounce, friction kills the slide. One coefficient cannot do both, and
      // using one is why naive bouncers slide forever on a flat floor.
      const vn = g.vel.dot(this._n);
      this._t.copy(g.vel).addScaledVector(this._n, -vn);
      g.vel.copy(this._t).multiplyScalar(GRENADE.friction)
        .addScaledVector(this._n, -vn * GRENADE.restitution);

      g.bounces++;
      this.stats.bounces++;
      const impact = Math.abs(vn);
      if (impact > 1.2) {
        ctx.bus.emit('grenade:bounce', {
          point: hit.point.clone(), normal: this._n.clone(), speed: impact,
        });
        this._audio()?.play?.('shell_drop', {
          position: hit.point, volume: Math.min(0.8, 0.25 + impact * 0.09),
        });
      }

      const after = g.vel.length();
      if ((after < GRENADE.restSpeed && this._n.y > GRENADE.restNormalY)
          || g.bounces > GRENADE.maxBounces) {
        g.vel.set(0, 0, 0);
        g.spin.set(0, 0, 0);
        g.rest = true;
        this._settle(g, this._n, R);
        break;
      }
    }
  }

  /** Resolved once, on first use — the registry lookup must not run per bounce. */
  _audio() {
    if (this.audio === null) this.audio = this.ctx.get('audio') ?? false;
    return this.audio;
  }

  /**
   * Park the body exactly one radius off the surface it stopped against. The
   * swept solve leaves the centre roughly there already, but "roughly" on an
   * oblique final bounce is the difference between a frag sitting on the slab
   * and one hovering a centimetre over it. Uses `_v`/`_d`, which the caller has
   * finished with by the time it breaks out of the sweep.
   */
  _settle(g, n, R) {
    this._v.copy(g.pos).addScaledVector(n, 0.10);
    this._d.copy(n).negate();
    const hit = this.level.raycast(this._v, this._d, 0.10 + R + 0.06);
    if (hit) g.pos.copy(hit.point).addScaledVector(n, R);
  }

  // ------------------------------------------------------------- throw / cook --

  /** Pull the pin. The fuse runs from here, in hand. */
  beginCook() {
    if (this.cooking || this.count <= 0) return false;
    this.cooking = true;
    this.fuseLeft = GRENADE.fuse;
    this.cookTime = 0;
    this.ctx?.bus.emit('grenade:cook', { phase: 'start', fuse: this.fuseLeft });
    this._audio()?.play?.('empty_click', { volume: 0.35 });
    return true;
  }

  /** Let go. Whatever is left of the fuse flies with it. */
  release() {
    if (!this.cooking) return -1;
    const ctx = this.ctx;
    const cam = ctx.camera;
    const fuse = Math.max(GRENADE.minCookThrow, this.fuseLeft);

    this._fwd.set(0, 0, -1).applyQuaternion(cam.quaternion);
    this._right.set(1, 0, 0).applyQuaternion(cam.quaternion);
    this._up.set(0, 1, 0).applyQuaternion(cam.quaternion);

    // Spawn ahead of the eye — and if there is a wall in the way, short of it,
    // so releasing with your muzzle against concrete drops the grenade at your
    // feet instead of teleporting it through the wall.
    let ahead = GRENADE.offsetFwd;
    const probe = this.level.raycast(cam.position, this._fwd, GRENADE.clearProbe);
    if (probe) ahead = Math.max(0.10, probe.distance - GRENADE.bodyRadius - 0.06);
    this._origin.copy(cam.position)
      .addScaledVector(this._fwd, ahead)
      .addScaledVector(this._right, GRENADE.offsetRight)
      .addScaledVector(this._up, -GRENADE.offsetDown);

    this._d.copy(this._fwd).addScaledVector(this._up, GRENADE.throwLift).normalize();
    this._v.copy(this._d).multiplyScalar(GRENADE.throwSpeed)
      .addScaledVector(this.player.velocity, GRENADE.inherit);

    const idx = this._spawn(this._origin, this._v, fuse);
    this.cooking = false;
    this.count = Math.max(0, this.count - 1);
    this.fuseLeft = fuse;

    ctx.bus.emit('grenade:cook', { phase: 'end', fuse });
    ctx.bus.emit('grenade:throw', {
      origin: this._origin.clone(),
      dir: this._d.clone(),
      velocity: this._v.clone(),
      cookTime: this.cookTime,
      fuse,
      count: this.count,
    });
    // A small kick so the throw is felt even before the viewmodel animates it.
    this.rig?.addTrauma?.(0.05);
    this._audio()?.play?.('shell_drop', { position: this._origin, volume: 0.4 });
    return idx;
  }

  /**
   * Deterministic throw for tools and for anything scripted.
   * @param {object} o { origin:[x,y,z], dir:[x,y,z], speed, fuse, spin:[x,y,z],
   *                     consume:boolean, seed:number }
   * @returns {number} pool index, or -1 if refused (out of stock)
   */
  throwNow(o = {}) {
    if (o.consume) {
      if (this.count <= 0) return -1;
      this.count--;
    }
    if (o.seed !== undefined) this._seed = (o.seed | 0) || 1;
    const p = o.origin ?? [this.ctx.camera.position.x, this.ctx.camera.position.y, this.ctx.camera.position.z];
    const d = o.dir ?? [0, 0.2, -1];
    this._origin.set(p[0], p[1], p[2]);
    this._v.set(d[0], d[1], d[2]).normalize().multiplyScalar(o.speed ?? GRENADE.throwSpeed);
    const idx = this._spawn(this._origin, this._v, o.fuse ?? GRENADE.fuse, o.spin);
    this.ctx.bus.emit('grenade:throw', {
      origin: this._origin.clone(), dir: this._v.clone().normalize(),
      velocity: this._v.clone(), cookTime: 0, fuse: o.fuse ?? GRENADE.fuse, count: this.count,
    });
    return idx;
  }

  /** Restock (tools/debug only — gameplay never calls this). */
  reset(n = GRENADE.stock) {
    for (const g of this.pool) { g.active = false; g.rest = false; if (g.mesh) g.mesh.visible = false; }
    this.liveCount = 0;
    this.cooking = false;
    this.fuseLeft = 0;
    this.count = n;
    return this.count;
  }

  _spawn(origin, velocity, fuse, spin) {
    const g = this._acquire();
    g.pos.copy(origin);
    g.vel.copy(velocity);
    g.fuse = fuse;
    g.bounces = 0;
    g.travelled = 0;
    g.rest = false;
    g.active = true;
    if (spin) g.spin.set(spin[0], spin[1], spin[2]);
    else g.spin.set(6 + this._rand() * 9, (this._rand() - 0.5) * 12, 4 + this._rand() * 7);
    g.euler.set(this._rand() * 3, this._rand() * 3, this._rand() * 3);
    g.mesh.position.copy(g.pos);
    g.mesh.visible = true;
    this.stats.thrown++;
    this.lastIndex = g.i;
    this.liveCount++;
    return g.i;
  }

  _acquire() {
    for (let k = 0; k < POOL; k++) {
      const g = this.pool[(this._cursor + k) % POOL];
      if (!g.active) { this._cursor = (g.i + 1) % POOL; return g; }
    }
    const g = this.pool[this._cursor];
    this._cursor = (this._cursor + 1) % POOL;
    if (g.active) this.liveCount--;
    g.active = false;
    return g;
  }

  /** Held past the fuse: it goes off against your own chest. */
  _cookOff(ctx) {
    this.cooking = false;
    this.fuseLeft = 0;
    this.count = Math.max(0, this.count - 1);
    this.stats.cookOffs++;
    this._fwd.set(0, 0, -1).applyQuaternion(ctx.camera.quaternion);
    this._c.copy(ctx.camera.position).addScaledVector(this._fwd, 0.22);
    ctx.bus.emit('grenade:cook', { phase: 'end', fuse: 0 });
    this._blast(this._c, ctx);
  }

  // ------------------------------------------------------------------ blast --

  _detonate(g, ctx) {
    g.active = false;
    g.rest = false;
    g.mesh.visible = false;
    this._c.copy(g.pos);
    // Lift the blast origin a body radius off whatever it is lying on, so the
    // scorch decal and the line-of-sight tests are not fired from inside a slab.
    this._c.y += GRENADE.bodyRadius;
    this._blast(this._c, ctx);
  }

  /**
   * The one detonation path. Emits the frozen 'explosion' payload — Impacts,
   * AudioEngine, Lighting and PostFX all already listen for it — then resolves
   * damage with falloff and line of sight.
   */
  _blast(point, ctx) {
    this.stats.detonations++;
    ctx.bus.emit('explosion', {
      point: point.clone(), radius: GRENADE.radius, damage: GRENADE.damage,
    });
    this._damageActors(point, ctx);
    this._damagePlayer(point, ctx);
  }

  _damageActors(point, ctx) {
    const b = this.ballistics;
    const list = b?.registry?.list;
    if (!list) return;
    for (let i = 0; i < list.length; i++) {
      const rec = list[i];
      if (rec.dead) continue;
      b.registry.centreOf(rec, this._v);
      const dmg = this._damageBetween(point, this._v);
      if (dmg <= 0) continue;

      let remaining = rec.health - dmg;
      if (rec.onDamage) {
        const res = rec.onDamage(dmg, {
          part: 'chest', mult: 1, point: this._v.clone(),
          dir: this._d.copy(this._v).sub(point).normalize().clone(),
          weapon: FRAG_DEF, shooter: 'player', explosion: true,
        });
        if (typeof res === 'number') remaining = res;
      }
      rec.health = remaining;
      const killed = remaining <= 0 && !rec.dead;
      if (killed) {
        rec.dead = true;
        this.stats.kills++;
        const payload = {
          actor: rec.object, record: rec, point: this._v.clone(),
          killer: 'player', weapon: FRAG_DEF, headshot: false,
        };
        // Ballistics owns 'actor:death' for records it resolves; for a blast we
        // are the resolver, so the single announcement has to come from here or
        // the kill never reaches the feed.
        ctx.bus.emit('actor:death', payload);
        rec.onDeath?.(payload);
      }
      ctx.bus.emit('grenade:hit', {
        actor: rec.object, damage: dmg, killed, point: this._v.clone(),
      });
    }
  }

  _damagePlayer(point, ctx) {
    const eye = this.player.eyePosition;
    const dmg = this._damageBetween(point, eye);
    if (dmg <= 0) return;
    ctx.bus.emit('player:damage', { amount: dmg, from: point.clone() });
  }

  /**
   * Damage a target at `to` takes from a blast at `from`. Falloff by distance,
   * zero through geometry. Public via `damageAt` so a test measures gameplay,
   * not a copy of it.
   */
  _damageBetween(from, to) {
    const d = from.distanceTo(to);
    if (d >= GRENADE.radius) return 0;
    const falloff = (1 - d / GRENADE.radius) ** GRENADE.falloffPower;
    // Point blank: no amount of geometry saves you from a grenade at your feet,
    // and a LOS ray this short is numerically meaningless anyway.
    if (d > GRENADE.selfMinDist && !this._clear(from, to, d)) return 0;
    return GRENADE.damage * falloff;
  }

  /**
   * @param {number[]|THREE.Vector3} p blast point
   * @param {number[]|THREE.Vector3} t target
   * Uses its own scratch pair rather than `_t`/`_c`: `_c` holds the live blast
   * origin during a detonation, and an 'explosion' listener that asked this
   * question mid-dispatch would otherwise move the blast it was asking about.
   */
  damageAt(p, t) {
    const a = Array.isArray(p) ? this._qa.set(p[0], p[1], p[2]) : this._qa.copy(p);
    const b = Array.isArray(t) ? this._qb.set(t[0], t[1], t[2]) : this._qb.copy(t);
    return this._damageBetween(a, b);
  }

  _clear(from, to, dist) {
    const b = this.ballistics;
    if (b?.lineOfSight) return b.lineOfSight(from, to, GRENADE.losSlack);
    this._n.copy(to).sub(from).multiplyScalar(1 / Math.max(1e-4, dist));
    return !this.level.raycast(from, this._n, dist - GRENADE.losSlack);
  }

  // ------------------------------------------------------------------ debug --

  /** Flat, allocation-free view of a projectile for tools. */
  debug(i = this.lastIndex) {
    const g = this.pool[i] ?? this.pool[0];
    const d = this._dbg;
    d.active = g.active;
    d.rest = g.rest;
    d.bounces = g.bounces;
    d.travelled = +g.travelled.toFixed(3);
    d.fuse = +g.fuse.toFixed(3);
    d.speed = +g.vel.length().toFixed(3);
    d.pos[0] = +g.pos.x.toFixed(3);
    d.pos[1] = +g.pos.y.toFixed(3);
    d.pos[2] = +g.pos.z.toFixed(3);
    return d;
  }

  dispose() {
    for (const g of this.pool) g.mesh?.removeFromParent();
    this.group?.removeFromParent();
    this._geo?.dispose();
    this._mat?.dispose();
  }

  /** mulberry32 — a seeded throw tumbles identically every run. */
  _rand() {
    let t = (this._seed = (this._seed + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
}
