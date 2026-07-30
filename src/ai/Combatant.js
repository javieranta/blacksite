import * as THREE from 'three';
import { AI, makeRng } from './AIConfig.js';
import { B, BIND, HITBOXES, RIG, buildSkeletonBones } from './soldier/SoldierRig.js';
import { MATERIAL_ORDER } from './soldier/SoldierMaterials.js';
import { SoldierAnim } from './soldier/SoldierAnim.js';
import { Ragdoll } from './soldier/Ragdoll.js';

/**
 * OWNER: ai agent. One hostile rifleman.
 *
 * Owns its body (4 SkinnedMesh sharing the squad's geometry), its brain (a small
 * state machine over a perception model) and its own hitboxes. It is registered
 * with Ballistics so the player can kill it, and it shoots back through the
 * event bus.
 *
 * The brain ticks at AI.logicHz; the body animates every frame.
 */

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _up = new THREE.Vector3(0, 1, 0);
const _down = new THREE.Vector3(0, -1, 0);
const _flash = new THREE.Vector3();
const _eject = new THREE.Vector3();
const _ejectDir = new THREE.Vector3();
const _ejectV = new THREE.Vector3();
const _qh = new THREE.Quaternion();
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const lerp = (a, b, t) => a + (b - a) * t;

const STATE = {
  IDLE: 'idle', PATROL: 'patrol', HUNT: 'hunt', ADVANCE: 'advance',
  COVER: 'cover', PEEK: 'peek', RELOAD: 'reload', SUPPRESSED: 'suppressed',
  DEAD: 'dead',
};

let NEXT_ID = 1;

export class Combatant {
  constructor(ctx, template, materials, nav, spawn, seed) {
    this.id = NEXT_ID++;
    this.ctx = ctx;
    this.nav = nav;
    this.rng = makeRng(seed * 2654435761);
    this.level = ctx.require('level');

    /* ---- body -------------------------------------------------------- */
    this.group = new THREE.Group();
    this.group.name = `combatant-${this.id}`;
    this.bones = buildSkeletonBones();
    this.skeleton = new THREE.Skeleton(this.bones, template.boneInverses);
    this.group.add(this.bones[0]);
    this.meshes = [];
    this.shadowMeshes = [];
    for (const family of MATERIAL_ORDER) {
      const geo = template.geometries[family];
      if (!geo) continue;
      const mesh = new THREE.SkinnedMesh(geo, materials[family]);
      /**
       * THE RIFLE CASTS. This used to exclude 'steel' to save a shadow draw call
       * per cascade, on the reasoning that a carbine is "a pencil-thin line in a
       * shadow". The review disagreed, in the only terms that matter: the dusk
       * figure "casts a wall shadow but with no limb or rifle definition". Of
       * course it has no rifle definition — the rifle was not in the shadow pass.
       * A shadow that shows a man's outline with no weapon in it is worse than no
       * shadow, because it reads as a statue rather than as a shooter, and the
       * 0.9 m carbine held across the chest is the single most identifying part of
       * the silhouette. 'visor' still does not cast: it is 800 triangles of lens
       * entirely inside the helmet's own shadow.
       */
      mesh.castShadow = family === 'fatigue' || family === 'gear' || family === 'steel';
      if (mesh.castShadow) this.shadowMeshes.push(mesh);
      mesh.receiveShadow = true;
      mesh.frustumCulled = true;
      mesh.matrixAutoUpdate = false;      // the group carries the transform
      mesh.bind(this.skeleton, new THREE.Matrix4());
      this.group.add(mesh);
      this.meshes.push(mesh);
    }

    // `seed` is the man's 1-based spawn ordinal (see EnemyAI._spawn); it selects
    // his posture archetype by round-robin so the squad covers all five.
    this.anim = new SoldierAnim(this.bones, this.rng, (seed | 0) - 1);
    this.ragdoll = new Ragdoll();

    /* ---- state ------------------------------------------------------- */
    this.pos = new THREE.Vector3().copy(spawn);
    this.vel = new THREE.Vector3();
    this.yaw = this.rng() * Math.PI * 2;
    /**
     * HOW FAR OFF THE AIM LINE THIS PARTICULAR MAN STANDS.
     *
     * `AI.bladeAngle` was applied as a single shared constant in the yaw solve
     * below, so every engaged combatant in the squad squared up to the threat at
     * exactly the same angle. That is the mechanical cause of the review's "all
     * squared to camera": nine men computing the same bearing to the same player
     * and adding the same 20 degrees arrive at nine identical facings, and no
     * amount of per-man posture variation inside the animation can rescue it,
     * because the whole body is being rotated to the same number.
     *
     * A real fire team does not agree on a stance. One man stands almost square
     * behind his cover, the next is bladed 40 degrees with his support shoulder
     * forward. Drawn once per man from his own deterministic rng, so a freeze
     * frame stays reproducible for the shoot rig. The rifle still ends up on the
     * target whatever this is — SoldierAnim twists the torso by the difference
     * and solves the arms onto the bore — so this buys silhouette variety for
     * free, without any man aiming somewhere he is not shooting.
     */
    this.bladeBias = AI.bladeAngle + (this.rng() * 2 - 1) * AI.bladeSpread;
    this.health = AI.maxHealth;
    this.ammo = AI.magSize;
    this.state = STATE.IDLE;
    this.role = 'hold';
    this.dead = false;

    this.aware = 0;              // 0..1 perception build-up
    this.alerted = false;
    this.canSee = false;
    this.reaction = 0;
    this.lastSeen = new THREE.Vector3().copy(spawn);
    this.lastSeenAge = 99;
    this.suppression = 0;

    this.coverNode = -1;
    this.peekDir = new THREE.Vector3();
    this.stance = 0;             // 0 = tucked in cover, 1 = peeking out
    this.stanceTimer = 1 + this.rng();
    this.burst = 0;
    this.fireCd = 0;
    this.reloadT = -1;
    this.logicCd = this.rng() * (1 / AI.logicHz);
    this.losCd = this.rng() * AI.losInterval;

    this.path = [];
    for (let i = 0; i < 24; i++) this.path.push(new THREE.Vector3());
    this.pathLen = 0;
    this.pathIdx = 0;
    this.repathCd = 0;
    this.goal = new THREE.Vector3().copy(spawn);
    this.hasGoal = false;
    this.stuck = 0;
    this._lastPos = new THREE.Vector3().copy(spawn);

    /* ---- hitboxes ---------------------------------------------------- */
    this.hitboxes = HITBOXES.map(([name, bone, cx, cy, cz, hx, hy, hz, mult]) => ({
      name, bone, mult,
      centre: new THREE.Vector3(cx, cy, cz),
      half: new THREE.Vector3(hx, hy, hz),
    }));
    this.bounds = new THREE.Sphere(new THREE.Vector3().copy(spawn), 1.35);

    this.group.position.copy(this.pos);
    this.group.rotation.y = this.yaw;
    this.group.updateMatrixWorld(true);
    // Perception runs in fixedUpdate, which happens before the first animation
    // tick — seed the eye so the very first LOS ray comes from the head.
    this.anim.eye.set(spawn.x, spawn.y + AI.eyeHeight, spawn.z);
    this.coverCd = 0;
    this.speed = 0;
    this.mustCrouch = false;
    /** Shoot-rig only: hold a full kneel while engaging. See EnemyAI._stagePose. */
    this.stageKneel = false;
    this.navNode = -1;
    this._animAcc = 0;
    this._corpseSettled = false;
    this._castShadow = true;
    /** Foot-plant probe: staggered per man so the squad never casts in lockstep. */
    this._gcd = this.rng() * AI.footProbeInterval;
    this._footSide = 0;
    /** Ground height under the body, published for the contact shadow. */
    this.groundY = spawn.y;
  }

  /* --------------------------------------------------------------- damage -- */

  /** Ray vs. every live hitbox. Returns the nearest hit or null. */
  hitTest(origin, dir, maxDist = 400) {
    if (this.dead) return null;
    // Broadphase against the body sphere first.
    _v1.subVectors(this.bounds.center, origin);
    const along = _v1.dot(dir);
    if (along < -this.bounds.radius || along > maxDist + this.bounds.radius) return null;
    if (_v1.lengthSq() - along * along > this.bounds.radius * this.bounds.radius) return null;

    let best = null;
    for (const hb of this.hitboxes) {
      const bone = this.bones[hb.bone];
      _m.copy(bone.matrixWorld).invert();
      _v1.copy(origin).applyMatrix4(_m).sub(hb.centre);
      _v2.copy(dir).transformDirection(_m);
      let t0 = 0, t1 = maxDist;
      let ok = true;
      for (let a = 0; a < 3; a++) {
        const o = a === 0 ? _v1.x : a === 1 ? _v1.y : _v1.z;
        const d = a === 0 ? _v2.x : a === 1 ? _v2.y : _v2.z;
        const h = a === 0 ? hb.half.x : a === 1 ? hb.half.y : hb.half.z;
        if (Math.abs(d) < 1e-6) { if (Math.abs(o) > h) { ok = false; break; } continue; }
        let ta = (-h - o) / d, tb = (h - o) / d;
        if (ta > tb) { const tmp = ta; ta = tb; tb = tmp; }
        if (ta > t0) t0 = ta;
        if (tb < t1) t1 = tb;
        if (t0 > t1) { ok = false; break; }
      }
      if (!ok || t0 < 0) continue;
      if (!best || t0 < best.distance) {
        best = best || { distance: 0, point: new THREE.Vector3(), normal: new THREE.Vector3(), part: '', mult: 1, actor: this };
        best.distance = t0;
        best.part = hb.name;
        best.mult = hb.mult;
        best.point.copy(origin).addScaledVector(dir, t0);
        best.normal.copy(origin).addScaledVector(dir, t0).sub(this.bounds.center).normalize();
      }
    }
    return best;
  }

  applyDamage(amount, info = {}) {
    if (this.dead) return;
    const mult = info.mult ?? 1;
    const dmg = amount * mult;
    this.health -= dmg;
    this.suppression = Math.min(1.6, this.suppression + 0.5);

    // Being shot at is the loudest possible contact report.
    if (!this.alerted) {
      this.alerted = true;
      this.aware = 1;
      this.reaction = 0;
      if (info.from) this.lastSeen.copy(info.from), this.lastSeenAge = 0;
    }

    const part = info.part ?? 'chest';
    const boneIdx = this._boneForPart(part);
    const dir = info.dir || _v3.set(0, 0, -1);
    if (this.health > 0) {
      this.anim.addFlinch(boneIdx, clamp(dmg / 34, 0.18, 0.9), dir.x, dir.z);
      const p = this.ctx.get('particles');
      if (p && info.point) p.spawn('blood', { position: info.point, normal: dir, scale: 0.8 });
      const a = this.ctx.get('audio');
      if (a) a.play('hitmarker', { position: this.bounds.center, volume: 0.5 });
    } else {
      this._die(dir, info.point);
    }
  }

  _boneForPart(part) {
    switch (part) {
      case 'head': return B.head;
      case 'armR': return B.armR; case 'armL': return B.armL;
      case 'foreR': return B.foreR; case 'foreL': return B.foreL;
      case 'thighR': return B.thighR; case 'thighL': return B.thighL;
      case 'calfR': return B.calfR; case 'calfL': return B.calfL;
      case 'pelvis': return B.pelvis; case 'abdomen': return B.spine;
      default: return B.chest;
    }
  }

  _die(dir, point) {
    this.dead = true;
    this.state = STATE.DEAD;
    this.vel.set(0, 0, 0);
    _v1.copy(dir).setLength(3.6);
    if (!Number.isFinite(_v1.x + _v1.y + _v1.z)) _v1.set(0, 0, 0);
    _v1.y += 1.1 + this.rng() * 0.8;
    /**
     * The verlet solver seeds every particle from this floor height and then
     * projects against it for the whole collapse, so one bad value here turns
     * eleven particles, twenty bone rotations and four skinned meshes into NaN
     * for the rest of the body's life. Both sources can legitimately miss —
     * wy() of an unusable node is NaN by design (the height array is
     * NaN-filled), and heightAt() has no obligation to hit anything under a
     * body that died on a gantry — so the value is checked, not trusted.
     */
    let groundY = this.nav.usable(this.navNode)
      ? this.nav.wy(this.navNode)
      : this.level.heightAt(this.pos.x, this.pos.z);
    if (!Number.isFinite(groundY)) groundY = this.pos.y;
    if (!Number.isFinite(groundY)) groundY = 0;
    this.group.updateMatrixWorld(true);
    this.ragdoll.start(this.bones, _v1, groundY);
    // Ballistics emits 'actor:death' for the records it owns (and its payload is
    // the richer one — killer, weapon, headshot). Emitting here as well would
    // double every kill in the HUD counter and fire two death barks.
    if (!this.deathAnnouncedExternally) {
      this.ctx.bus.emit('actor:death', { actor: this, point: (point || this.bounds.center).clone() });
    }
    const a = this.ctx.get('audio');
    if (a) a.play('bark_death', { position: this.bounds.center });
  }

  /* ------------------------------------------------------------ perception -- */

  _look(dt, player) {
    this.losCd -= dt;
    this.lastSeenAge += dt;
    if (this.losCd > 0) return;
    this.losCd += AI.losInterval;

    const eye = this.anim.eye;
    _v1.copy(player.eyePosition).sub(eye);
    const dist = _v1.length();
    let visible = false;
    // `dist > 1e-3` also rejects NaN, so a bad eye position cannot turn the
    // look direction into infinities and poison the LOS ray.
    if (dist > 1e-3 && dist < AI.sightRange) {
      _v1.divideScalar(dist);
      _v2.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
      const facing = _v1.dot(_v2);
      if (facing > Math.cos(AI.fov * 0.5) || dist < AI.peripheralRange) {
        const hit = this.level.raycast(eye, _v1, dist - 0.30);
        visible = !hit;
      }
    }
    this.canSee = visible;
    if (visible) {
      this.lastSeen.copy(player.eyePosition);
      this.lastSeenAge = 0;
      const speed = 1 / lerp(AI.reactionMin, AI.reactionMax, clamp(dist / 55, 0, 1));
      this.aware = Math.min(1, this.aware + AI.losInterval * speed * 1.6);
      if (this.aware >= 1 && !this.alerted) {
        this.alerted = true;
        this.onFirstContact?.(this);
      }
    } else {
      this.aware = Math.max(0, this.aware - AI.losInterval * 0.35);
    }
  }

  /** Squadmate or player gunfire pins them down. */
  suppress(amount) {
    this.suppression = Math.min(1.8, this.suppression + amount);
    if (!this.alerted && amount > 0.2) { this.aware = Math.max(this.aware, 0.75); }
  }

  alert(position) {
    if (this.dead) return;
    if (!this.alerted) this.aware = Math.max(this.aware, 0.85);
    this.alerted = true;
    if (position && this.lastSeenAge > 0.5) { this.lastSeen.copy(position); this.lastSeenAge = 0.5; }
  }

  /* ----------------------------------------------------------------- brain -- */

  think(player, squad) {
    const rng = this.rng;
    const dist = this.pos.distanceTo(player.position);
    const engaged = this.alerted && this.lastSeenAge < AI.memoryTime;

    if (this.reloadT >= 0) { this.state = STATE.RELOAD; return; }
    if (this.ammo <= 0) {
      this.reloadT = 0;
      this.state = STATE.RELOAD;
      const a = this.ctx.get('audio');
      if (a) a.play('bark_reload', { position: this.bounds.center });
      return;
    }

    if (!engaged) {
      // Idle sentries drift between posts so the level never looks static.
      if (this.state !== STATE.PATROL || !this.hasGoal) {
        const n = this.nav.randomNear(this.pos.x, this.pos.y, this.pos.z, 7.5, rng);
        if (n >= 0 && rng() < 0.5) { this.nav.worldOf(n, _v1); this._setGoal(_v1); this.state = STATE.PATROL; }
        else this.state = STATE.IDLE;
      }
      return;
    }

    if (this.suppression > AI.suppressPin) { this.state = STATE.SUPPRESSED; this.stance = 0; return; }

    // Flankers commit to their route before they think about cover again.
    if (this.role === 'flank' && squad.flankGoal && this.hasGoal
        && this.pos.distanceTo(this.goal) > AI.arriveRadius * 3) {
      this.state = STATE.ADVANCE;
      return;
    }

    // Pick or re-pick cover — rate limited, the scoring pass is the one place
    // this brain does real work.
    this.coverCd -= 1 / AI.logicHz;
    const needCover = this.coverNode < 0
      || !this.nav.usable(this.coverNode)
      || this.nav.protection(this.coverNode, player.position.x, player.position.z) < 0.3
      || (this.role === 'flank' && this.pos.distanceTo(this.goal) < AI.arriveRadius * 3);
    if (needCover && this.coverCd <= 0) {
      this.coverCd = 0.55 + this.rng() * 0.5;
      this._chooseCover(player, squad);
    }

    if (this.coverNode >= 0) {
      this.nav.worldOf(this.coverNode, _v1);
      const atCover = this.pos.distanceTo(_v1) < AI.arriveRadius * 2.4;
      if (!atCover) { this._setGoal(_v1); this.state = STATE.ADVANCE; return; }
      this._setGoal(_v1);
      this.pathLen = 0;

      // Peek / return cycle. Suppressors spend far longer exposed.
      this.stanceTimer -= 1 / AI.logicHz;
      if (this.stanceTimer <= 0) {
        if (this.stance > 0.5) {
          this.stance = 0;
          this.stanceTimer = lerp(AI.coverHoldMin, AI.coverHoldMax, rng())
            * (this.role === 'suppress' ? 0.55 : 1) * (1 + this.suppression);
        } else {
          this.stance = 1;
          this.stanceTimer = lerp(AI.peekHoldMin, AI.peekHoldMax, rng())
            * (this.role === 'suppress' ? 1.9 : 1);
          this.burst = Math.round(lerp(AI.burstMin, AI.burstMax, rng()));
        }
      }
      this.state = this.stance > 0.5 ? STATE.PEEK : STATE.COVER;
    } else if (this.canSee && dist < AI.engageMax) {
      this.state = STATE.PEEK;      // nowhere to hide: stand and fight
      this.stance = 1;
      if (this.burst <= 0) this.burst = Math.round(lerp(AI.burstMin, AI.burstMax, rng()));
    } else {
      this._setGoal(this.lastSeen);
      this.state = STATE.HUNT;
    }
  }

  /**
   * Cover selection. Scores every known cover node in range on protection from
   * the player's CURRENT position, travel cost, standoff range, whether an ally
   * already owns it, and whether it advances on the target.
   */
  _chooseCover(player, squad) {
    const nav = this.nav;
    const w = AI.coverScoreWeights;
    const px = player.position.x, pz = player.position.z;
    let best = -1, bestScore = -1e9;
    const preferX = this.role === 'flank' && squad.flankGoal ? squad.flankGoal.x : px;
    const preferZ = this.role === 'flank' && squad.flankGoal ? squad.flankGoal.z : pz;

    // Local query instead of a scan of every cover node on the map — the radius
    // test is now the bucket lookup rather than 3000 rejected distance checks.
    const scratch = this._covScratch || (this._covScratch = new Int32Array(2048));
    const found = nav.coverNear(this.pos.x, this.pos.z, AI.coverSearchRadius, scratch);

    for (let i = 0; i < found; i++) {
      const n = scratch[i];
      const nx = nav.wx(n), nz = nav.wz(n);
      const dSelf = Math.hypot(nx - this.pos.x, nz - this.pos.z);
      if (Math.abs(nav.wy(n) - this.pos.y) > 3.2) continue;
      const prot = nav.protection(n, px, pz);
      if (prot < 0.3) continue;
      const dPlayer = Math.hypot(nx - px, nz - pz);
      if (dPlayer < 6.5 || dPlayer > AI.engageMax) continue;

      let ally = 0;
      for (const o of squad.members) {
        if (o === this || o.dead || o.coverNode < 0) continue;
        if (o.coverNode === n) { ally = 3; break; }
        if (Math.hypot(nav.wx(o.coverNode) - nx, nav.wz(o.coverNode) - nz) < 2.6) ally += 1;
      }
      const forward = (Math.hypot(this.pos.x - preferX, this.pos.z - preferZ)
        - Math.hypot(nx - preferX, nz - preferZ));

      const score = prot * w.protection + dSelf * w.distance
        + Math.abs(dPlayer - 22) * w.range + ally * w.ally + forward * w.forward
        + this.rng() * 0.5;
      if (score > bestScore) { bestScore = score; best = n; }
    }

    this.coverNode = best;
    this.stance = 0;
    this.stanceTimer = lerp(AI.coverHoldMin, AI.coverHoldMax, this.rng());
    if (best >= 0) {
      // Lean out on the side that is actually open. If the player is standing
      // exactly on the cover node there is no "out" — leave peekDir zero, which
      // the movement code already reads as "hold position", rather than letting
      // a zero-length normalise decide the lean direction.
      nav.worldOf(best, _v1);
      _v2.set(px - _v1.x, 0, pz - _v1.z);
      if (_v2.lengthSq() < 1e-6) { this.peekDir.set(0, 0, 0); this.mustCrouch = (nav.coverHigh[best] === 0); return; }
      _v2.normalize();
      this.peekDir.crossVectors(_up, _v2).normalize();
      this.mustCrouch = (nav.coverHigh[best] === 0);
      /**
       * Which way to lean — decided by line of sight, not by a protection proxy.
       *
       * The old test asked the nav grid whether the lean node was *unprotected*
       * (`protection < 0.5`) and zeroed peekDir if not. That is the wrong
       * question twice over: protection is about incoming fire and this is about
       * outgoing, and the two only coincide in the open. Behind good hard cover
       * — exactly the cover worth taking — both sides read as protected, peekDir
       * was zeroed, the man was welded in place with a permanently blocked bore,
       * and _shoot correctly refused to let him shoot his own wall. Measured
       * live: nine alerted men fired one round in 26 seconds.
       *
       * Asking the actual question (can a round get from a peek stance to the
       * player?) costs one to three casts per cover decision, about 1 Hz per
       * man. If no stance has a lane the node is not a fighting position at all,
       * so it is rejected and think() falls through to "stand and fight" —
       * which is a worse tactical position but an infinitely better behaviour
       * than paralysis.
       */
      if (this._lane(best, 1, player)) { /* lean right: keep peekDir as is */ }
      else if (this._lane(best, -1, player)) this.peekDir.multiplyScalar(-1);
      else if (this._lane(best, 0, player)) this.peekDir.set(0, 0, 0);   // rise over it
      else { this.coverNode = -1; this.peekDir.set(0, 0, 0); }
    }
  }

  /**
   * Can a round reach the player from this cover node at lean offset `s`?
   * s = ±1 leans out to that side, s = 0 stands up behind it.
   */
  _lane(node, s, player) {
    this.nav.worldOf(node, _v3);
    if (!Number.isFinite(_v3.y)) return false;
    _v2.set(
      _v3.x + this.peekDir.x * s * AI.coverPeekOffset,
      _v3.y + AI.eyeHeight - (s === 0 && this.mustCrouch ? 0.42 : 0),
      _v3.z + this.peekDir.z * s * AI.coverPeekOffset,
    );
    _v3.subVectors(player.eyePosition, _v2);
    const d = _v3.length();
    if (!(d > 0.5)) return true;
    _v3.divideScalar(d);
    return !this.level.raycast(_v2, _v3, d - 0.35);
  }

  _setGoal(p) {
    if (this.hasGoal && this.goal.distanceToSquared(p) < 0.36) return;
    this.goal.copy(p);
    this.hasGoal = true;
    this.repathCd = 0;
  }

  /* ------------------------------------------------------------- movement -- */

  _move(dt, squad) {
    const nav = this.nav;
    let desiredSpeed = 0;
    const target = _v1;
    let haveTarget = false;

    if (this.state === STATE.ADVANCE || this.state === STATE.HUNT || this.state === STATE.PATROL) {
      /**
       * Repath rate limiting.
       *
       * This used to read `if (this.pathLen === 0 || this.repathCd <= 0)`, and
       * that disjunction was a performance trap: a search that FAILS leaves
       * pathLen at 0, so the very next fixed tick took the same branch and ran
       * the same doomed A* again — at 120 Hz, per stuck man, with a 5200-node
       * expansion budget. Five men unable to path meant ~600 full graph searches
       * a second, which measured as 2.5 ms of the fixed tick on its own.
       *
       * The cooldown is now unconditional. A new goal still repaths at once
       * (_setGoal zeroes it), a success waits the full interval, and a failure
       * backs off to a short retry instead of spinning.
       */
      this.repathCd -= dt;
      if (this.repathCd <= 0) {
        this.pathLen = nav.findPath(this.pos, this.goal, this.path);
        this.pathIdx = 0;
        if (this.pathLen > 0) { this.pathFails = 0; this.repathCd = AI.repathInterval; }
        else { this.pathFails = (this.pathFails || 0) + 1; this.repathCd = AI.repathRetry; }
      }
      const speedFor = () => (this.state === STATE.PATROL ? AI.walkSpeed
        : (this.state === STATE.HUNT ? AI.walkSpeed * 1.4 : AI.runSpeed));
      if (this.pathIdx < this.pathLen) {
        target.copy(this.path[this.pathIdx]);
        haveTarget = true;
        if (Math.hypot(target.x - this.pos.x, target.z - this.pos.z) < AI.arriveRadius) {
          this.pathIdx++;
          if (this.pathIdx >= this.pathLen) { this.pathLen = 0; this.hasGoal = false; }
        }
        desiredSpeed = speedFor();
      } else if (this.hasGoal) {
        /**
         * A* found nothing. Previously this fell through with haveTarget false,
         * so the man stood still with desiredSpeed 0 — and because the stuck
         * detector below only arms when `haveTarget && desiredSpeed > 1`, the
         * one thing that could have rescued him was gated off by the exact
         * condition that trapped him. Measured live: five of nine combatants
         * were frozen in ADVANCE for the entire 26 s test and the squad fired a
         * single round.
         *
         * Steering straight at the goal is the right fallback: the per-axis nav
         * validation further down still refuses to walk him through a wall, and
         * it gives the stuck timer a live target to expire on, so a man who
         * genuinely cannot get there abandons the spot instead of standing in
         * the open forever.
         */
        target.copy(this.goal);
        haveTarget = true;
        desiredSpeed = speedFor();
        // Repeated failures mean the destination is the problem, not the route.
        if ((this.pathFails || 0) >= 2) {
          this.pathFails = 0;
          this.coverNode = -1;
          this.coverCd = 0;
          this.hasGoal = false;
        }
      }
    } else if (this.coverNode >= 0) {
      // Hold the cover spot; peeking is a lateral step out of it.
      nav.worldOf(this.coverNode, target);
      target.addScaledVector(this.peekDir, this.stance * AI.coverPeekOffset);
      haveTarget = true;
      desiredSpeed = AI.crouchSpeed * 1.5;
    }

    // Steering + separation so a squad never stacks into one silhouette.
    _v2.set(0, 0, 0);
    if (haveTarget) {
      _v2.set(target.x - this.pos.x, 0, target.z - this.pos.z);
      const d = _v2.length();
      if (d > 0.02) _v2.multiplyScalar(Math.min(1, d / 0.6) * desiredSpeed / d);
      else _v2.set(0, 0, 0);
    }
    for (const o of squad.members) {
      if (o === this || o.dead) continue;
      const dx = this.pos.x - o.pos.x, dz = this.pos.z - o.pos.z;
      const d2 = dx * dx + dz * dz;
      const rr = (AI.radius * 2.1) ** 2;
      if (d2 < rr && d2 > 1e-4) {
        const d = Math.sqrt(d2);
        const push = (1 - d / (AI.radius * 2.1)) * 2.4;
        _v2.x += (dx / d) * push;
        _v2.z += (dz / d) * push;
      }
    }

    const maxV = Math.max(desiredSpeed, 1.2);
    const vl = Math.hypot(_v2.x, _v2.z);
    if (vl > maxV) _v2.multiplyScalar(maxV / vl);

    this.vel.x += (_v2.x - this.vel.x) * Math.min(1, AI.accel * dt);
    this.vel.z += (_v2.z - this.vel.z) * Math.min(1, AI.accel * dt);

    const nx = this.pos.x + this.vel.x * dt;
    const nz = this.pos.z + this.vel.z * dt;
    const node = nav.nodeAt(nx, this.pos.y, nz, 1.1);
    if (nav.usable(node)) {
      this.pos.x = nx;
      this.pos.z = nz;
      this.navNode = node;
      this.pos.y += (nav.wy(node) - this.pos.y) * Math.min(1, dt * 12);
    } else {
      // Slide along whichever axis is still legal, then force a repath.
      const nodeX = nav.nodeAt(nx, this.pos.y, this.pos.z, 1.1);
      const nodeZ = nav.nodeAt(this.pos.x, this.pos.y, nz, 1.1);
      if (nav.usable(nodeX)) { this.pos.x = nx; this.navNode = nodeX; this.vel.z *= 0.3; }
      else if (nav.usable(nodeZ)) { this.pos.z = nz; this.navNode = nodeZ; this.vel.x *= 0.3; }
      else { this.vel.multiplyScalar(0.2); }
      this.repathCd = Math.min(this.repathCd, 0.15);
    }

    this.speed = Math.hypot(this.vel.x, this.vel.z);
    this._deoverlap(squad);

    // Stuck detection: if the brain wants to travel but nothing is happening,
    // throw the path away and let A* try from the new position.
    if (haveTarget && desiredSpeed > 1 && this.speed < 0.35) {
      this.stuck += dt;
      if (this.stuck > 0.9) { this.stuck = 0; this.pathLen = 0; this.repathCd = 0; this.coverNode = -1; }
    } else this.stuck = 0;
  }

  /**
   * Hard positional separation.
   *
   * The steering above adds a repulsion to the *velocity*, which is the right
   * behaviour for two men walking past each other and completely inadequate for
   * two men who both want to stand on the same cover node: the desired-velocity
   * term pulls each of them onto the node with more authority than the
   * repulsion pushes them apart, so they converge and settle inside one another.
   * `viewmodel-ads` caught exactly that — two combatants co-located and
   * intersecting, one body's arm passing through the other's chest.
   *
   * Steering cannot fix it because it is not a steering problem: two solids may
   * not share a volume, and that is a constraint, not a preference. So it is
   * resolved as a constraint, on position, after integration. Each man takes
   * half the correction and his neighbour takes the other half on his own tick,
   * so the pair converges in one frame without either needing to know it was
   * "the one that moved".
   */
  _deoverlap(squad) {
    const nav = this.nav;
    const minSep = AI.radius * AI.separationScale;
    const min2 = minSep * minSep;
    for (const o of squad.members) {
      if (o === this || o.dead) continue;
      const dx = this.pos.x - o.pos.x, dz = this.pos.z - o.pos.z;
      const d2 = dx * dx + dz * dz;
      if (d2 >= min2) continue;
      let ux, uz, d;
      if (d2 > 1e-6) { d = Math.sqrt(d2); ux = dx / d; uz = dz / d; } else {
        // Exactly co-located. There is no separating axis to normalise, so pick
        // one from the pair's identities — deterministic, and opposite for the
        // two of them, so they do not both step the same way forever.
        const a = (this.id * 2.3999632 + (this.id > o.id ? Math.PI : 0)) % 6.2831853;
        d = 0; ux = Math.cos(a); uz = Math.sin(a);
      }
      const push = (minSep - d) * 0.5;
      const nx = this.pos.x + ux * push;
      const nz = this.pos.z + uz * push;
      const n = nav.nodeAt(nx, this.pos.y, nz, 1.1);
      if (!nav.usable(n)) continue;      // never push a man into a wall
      this.pos.x = nx;
      this.pos.z = nz;
      this.navNode = n;
    }
  }

  /**
   * Cast for the ground under one boot.
   *
   * The pelvis solve grounds both feet against a single plane through the body's
   * origin, which is the nav node's height — correct on open deck and wrong
   * everywhere interesting. A man standing at the lip of a plate, on a step or
   * astride a kerb had one boot buried and the other hanging, and the eye reads
   * a floating foot instantly.
   *
   * Alternating feet at ~9 Hz costs one short cast per man per 0.11 s, and only
   * inside the detail band (20 m), where the animation is already solving every
   * frame. That is three or four casts a second across a squad in view — against
   * ~1200 for the ballistics of a single burst — and the anim damps the result,
   * so the lower rate is invisible. Beyond the band the offsets are released to
   * flat, which is what a thirty-pixel silhouette wants anyway.
   */
  _footPlant(dt, near) {
    const a = this.anim;
    if (!near) { a.in.groundR = NaN; a.in.groundL = NaN; return; }
    this._gcd -= dt;
    if (this._gcd > 0) return;
    this._gcd += AI.footProbeInterval;
    this._footSide ^= 1;
    const f = a.footWorld[this._footSide];
    // Before the first solve footWorld is still the origin; casting there would
    // measure the ground under the middle of the map.
    const dx = f.x - this.pos.x, dz = f.z - this.pos.z;
    if (dx * dx + dz * dz > 1.44) return;
    _v1.set(f.x, this.pos.y + 0.55, f.z);
    const hit = this.level.raycast(_v1, _down, 1.35);
    const y = hit ? hit.point.y : NaN;
    if (this._footSide === 0) a.in.groundR = y; else a.in.groundL = y;
    if (Number.isFinite(y)) this.groundY = y;
  }

  /* -------------------------------------------------------------- shooting -- */

  _shoot(dt, player) {
    this.fireCd -= dt;
    const exposed = this.state === STATE.PEEK;
    if (!exposed || this.burst <= 0 || this.ammo <= 0 || this.fireCd > 0) return;
    // Only fire if the bore actually has a lane to the target.
    _v1.copy(player.eyePosition).sub(this.anim.muzzle);
    const dist = _v1.length();
    if (!(dist > 0.5) || dist > AI.engageMax) return;
    _v1.divideScalar(dist);
    if (_v1.dot(this.anim.muzzleDir) < 0.90) return;      // still swinging on target
    if (this.level.raycast(this.anim.muzzle, _v1, dist - 0.35)) {
      // Cover in the way: hold fire rather than shooting the wall in front.
      this.fireCd = 0.25;
      return;
    }

    this.fireCd = 60 / AI.fireRpm;
    this.ammo--;
    this.burst--;
    if (this.burst <= 0) {
      this.stanceTimer = Math.min(this.stanceTimer, lerp(AI.burstPauseMin, AI.burstPauseMax, this.rng()));
    }
    this.anim.kick(1);

    const muzzle = this.anim.muzzle;
    const spread = AI.spreadBase
      + this.speed * 0.008
      + this.suppression * AI.spreadSuppressed * 0.5;
    _v2.copy(_v1);
    _v2.x += (this.rng() - 0.5) * spread * 2;
    _v2.y += (this.rng() - 0.5) * spread * 2;
    _v2.z += (this.rng() - 0.5) * spread * 2;
    _v2.normalize();

    const ctx = this.ctx;
    const lighting = ctx.get('lighting');
    if (lighting?.flash) {
      /**
       * The flash light goes DOWN THE BORE, not on the muzzle.
       *
       * FlashPool lights are physically correct inverse-square, and the muzzle
       * sits about 0.55 m from the shooter's own chest — so a light parked on it
       * delivered intensity/0.3 to his torso. At night, where the scene sits
       * near 0.02 and the preset opens the shutter to exposure 2.05, that is an
       * irradiance two orders of magnitude above everything around him: the
       * night capture showed one combatant rendered as a pale tan, full-daylight
       * figure while every surface beside him sat in deep blue. He was being lit
       * by his own muzzle flash, and by nothing else.
       *
       * Pushing the source a metre down the bore is both cheaper and more
       * correct than dimming it: the flash still throws light onto the ground,
       * the cover and the men in front of him — which is what a muzzle flash is
       * FOR, visually — while his own body falls from 0.3 m^2 to 2.4 m^2 of
       * inverse-square distance, an 8x drop, and the wall of light comes off
       * him. See AI.muzzleFlashForward.
       */
      _flash.copy(muzzle).addScaledVector(this.anim.muzzleDir, AI.muzzleFlashForward);
      lighting.flash(_flash, 0xffd2a0, AI.muzzleFlashIntensity, 0.055);
    }
    const particles = ctx.get('particles');
    if (particles) {
      particles.spawn('muzzle', { position: muzzle, direction: _v2, scale: 0.85 });
      particles.spawn('tracer', { position: muzzle, direction: _v2, scale: 1.0, colour: 0xffc070 });
      /**
       * BRASS LEAVES THE EJECTION PORT, SIDEWAYS. It used to be spawned at the
       * MUZZLE travelling along the bullet's own direction, which is why the
       * review has reported casings "hanging 30 m downrange" for several rounds
       * running: a case given the round's velocity vector flies to whatever the
       * man is shooting at. A real case is thrown out of a port on the right of
       * the receiver, up and slightly back, and is on the floor beside his boot a
       * second later. Both the origin and the direction were wrong; the size is
       * the particle system's own (see the note in the report).
       */
      _eject.copy(RIG.ejectLocal).applyMatrix4(this.bones[B.handR].matrixWorld);
      this.bones[B.handR].getWorldQuaternion(_qh);
      /**
       * The velocity has to be passed as vx/vy/vz, not as `direction`: Effects.shell
       * reads `o.vx ?? 2.7, o.vy ?? -2.6, o.vz ?? 0.4` and ignores `direction`
       * entirely, so a direction-only call left every man in the squad throwing
       * brass along the same fixed WORLD axis regardless of which way he was
       * facing. Built from the weapon's own right and rear axes so the case leaves
       * the port the way it does on the man's own flank, and biased downward — the
       * particle agent's note on this effect explains why brass must arc down and
       * out rather than up: a case that crests the eye plane is read against the
       * horizon and appears to be metres long.
       */
      _ejectDir.set(1, 0, 0).applyQuaternion(_qh);            // weapon right
      _ejectV.copy(_ejectDir).multiplyScalar(2.55);
      _ejectDir.set(0, 0, 1).applyQuaternion(_qh);            // weapon rear
      _ejectV.addScaledVector(_ejectDir, 0.55);
      _ejectV.y -= 1.15;
      particles.spawn('shell', {
        position: _eject, direction: _ejectDir, scale: 0.6,
        vx: _ejectV.x, vy: _ejectV.y, vz: _ejectV.z,
        floorY: this.groundY,
      });
    }
    const audio = ctx.get('audio');
    if (audio) audio.play('fire_ar', { position: muzzle, volume: 0.9, pitch: 0.94 });
    ctx.bus.emit('ai:fire', { actor: this, origin: muzzle, dir: _v2 });
    if (this.onFire) this.onFire(this, muzzle, _v2);

    // Resolve the round. Hit chance falls off with range and rises as they
    // settle; a miss still has to land somewhere, which is what sells incoming
    // fire — chips off the cover the player is hiding behind.
    const hitChance = lerp(AI.hitChanceNear, AI.hitChanceFar, clamp((dist - 12) / 33, 0, 1))
      * (1 - this.suppression * 0.45) * (this.speed > 1.5 ? 0.55 : 1);
    const willHit = this.rng() < hitChance;
    if (willHit) {
      ctx.bus.emit('player:damage', {
        amount: AI.rifleDamage * lerp(1.0, 0.62, clamp((dist - 18) / 40, 0, 1)),
        from: muzzle.clone(),
      });
      if (audio) audio.play('whizby', { position: player.eyePosition, volume: 0.6 });
    } else {
      // Where does the miss land? Nudge the ray off the player and trace it.
      _v3.copy(_v2);
      _v3.x += (this.rng() - 0.5) * 0.035;
      _v3.y += (this.rng() - 0.5) * 0.028;
      _v3.normalize();
      const hit = this.level.raycast(muzzle, _v3, 140);
      if (hit) {
        ctx.bus.emit('hit:surface', {
          point: hit.point,
          normal: hit.normal,
          surface: hit.surface ?? 'concrete',
          incoming: _v3.clone(),
          energy: 0.8,
        });
      }
      if (audio && dist < 40) audio.play('whizby', { position: player.eyePosition, volume: 0.45 });
    }
  }

  /* ----------------------------------------------------------------- ticks -- */

  /** Gameplay tick. Called at the engine's fixed rate. */
  fixedUpdate(dt, player, squad) {
    if (this.dead) return;

    this.suppression = Math.max(0, this.suppression - AI.suppressDecay * dt);
    if (this.reloadT >= 0) {
      this.reloadT += dt;
      if (this.reloadT >= AI.reloadTime) { this.reloadT = -1; this.ammo = AI.magSize; }
    }

    this._look(dt, player);

    this.logicCd -= dt;
    if (this.logicCd <= 0) {
      this.logicCd += 1 / AI.logicHz;
      this.think(player, squad);
    }

    this._move(dt, squad);
    this._shoot(dt, player);

    /* body yaw: face the threat when engaged, the path when moving ---------- */
    let wantYaw = this.yaw;
    const engaged = this.alerted && this.lastSeenAge < AI.memoryTime;
    if (engaged) {
      _v1.copy(this.lastSeen).sub(this.pos);
      // Bladed stance, at THIS man's own angle — see this.bladeBias. A shared
      // constant here is what made the squad read as one pose repeated.
      wantYaw = Math.atan2(-_v1.x, -_v1.z) + this.bladeBias;
    } else if (this.speed > 0.4) {
      wantYaw = Math.atan2(-this.vel.x, -this.vel.z);
    }
    let d = wantYaw - this.yaw;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    this.yaw += clamp(d, -AI.turnRate * dt, AI.turnRate * dt);
  }

  /**
   * Visual tick. Runs every frame, including while the sim is frozen.
   *
   * @param dt        seconds since the last frame
   * @param interval  minimum seconds between full pose solves. 0 = every frame.
   *   Posing a body is two-bone IK on four limbs plus a rifle basis and twenty
   *   bone writes; at 40 m none of that resolves to a pixel of difference
   *   between one frame and the next, so EnemyAI hands distant men a coarser
   *   interval. Skipping simply holds the last pose — the bones are untouched,
   *   so the skinning stays valid and nothing pops.
   */
  update(dt, interval = 0) {
    const anim = this.anim;

    if (interval > 0) {
      this._animAcc += dt;
      if (this._animAcc < interval) return;
      dt = this._animAcc;
      this._animAcc = 0;
    }

    if (this.dead) {
      // A settled ragdoll is a static prop: stop rebuilding the skeleton from
      // particles that are no longer moving.
      if (!this.ragdoll.active && this._corpseSettled) return;
      this.ragdoll.step(dt);
      this.ragdoll.apply(this.bones, this.group);
      if (!this.ragdoll.active) this._corpseSettled = true;
      this.bounds.center.setFromMatrixPosition(this.bones[B.chest].matrixWorld);
      for (const m of this.meshes) m.matrixWorld.copy(this.group.matrixWorld);
      return;
    }

    const engaged = this.alerted && this.lastSeenAge < AI.memoryTime;
    const st = this.state;
    anim.in.speed = this.speed ?? 0;
    // `stageKneel` is the shoot rig's "firing from a genuine kneel" — a full
    // crouch while still up and engaging, which a crouched PEEK otherwise only
    // gets 0.35 of. See EnemyAI._stagePose.
    /**
     * The kneel depth is PER MAN, not a constant 0.92.
     *
     * A constant was measurably self-defeating: a full kneel pins both knees near
     * maximum flexion, so it erases the very stance differences the archetypes
     * exist to create. The harness caught it — two men in different archetypes came
     * back at 127 and 129 degrees of knee flexion and a mean joint separation of
     * 0.098 rad, right on the clone threshold, because the role had overridden the
     * posture. Keying the depth to the man's own `drop` spreads kneeling men across
     * 0.72-0.98 of a full crouch, which is a visible difference in hip height and a
     * measurable one in the pose signature.
     */
    anim.in.crouch = this.stageKneel
      ? 0.72 + 0.26 * clamp((this.anim.persona.drop - 0.45) / 1.35, 0, 1)
      : (st === STATE.SUPPRESSED || (this.mustCrouch && st === STATE.COVER)) ? 1
        : (st === STATE.COVER ? 0.7 : (st === STATE.PEEK && this.mustCrouch ? 0.35 : 0));
    anim.in.aim = st === STATE.PEEK ? 1
      : st === STATE.RELOAD ? 0.25
        : st === STATE.SUPPRESSED ? 0.15
          : engaged ? 0.55 : 0.0;
    anim.in.reloadT = this.reloadT;
    anim.in.bodyYaw = this.yaw;
    anim.in.aimAt.copy(engaged ? this.lastSeen : this._idleLook());

    this._footPlant(dt, interval === 0);
    this.group.position.copy(this.pos);
    anim.update(dt, this.group);

    this.bounds.center.setFromMatrixPosition(this.bones[B.chest].matrixWorld);
    // The meshes carry no transform of their own; copying the group's world
    // matrix keeps skinning correct with matrixAutoUpdate off.
    for (const m of this.meshes) m.matrixWorld.copy(this.group.matrixWorld);
  }

  _idleLook() {
    const p = this._look2 || (this._look2 = new THREE.Vector3());
    p.set(
      this.pos.x - Math.sin(this.yaw) * 12,
      this.pos.y + 1.55,
      this.pos.z - Math.cos(this.yaw) * 12,
    );
    return p;
  }

  dispose() {
    this.group.removeFromParent();
    this.skeleton.dispose?.();
  }
}

export { STATE };
