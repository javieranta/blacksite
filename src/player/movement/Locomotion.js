import * as THREE from 'three';
import { MOVE } from '../PlayerTuning.js';

/**
 * OWNER: player-movement agent.
 *
 * The mechanical half of the controller: Quake/Source-style acceleration and
 * friction, substepped capsule integration against the collision world, wall
 * sliding, and step-up. No state machine, no input, no events — those live in
 * PlayerController.
 *
 * CAPSULE CONVENTION
 *   `top` is the top of the capsule (the head reference). The two sphere centres
 *   are at `top.y - height + radius` and `top.y - radius`, so the feet are at
 *   `top.y - height`. Keeping the head as the origin is what makes the crouch
 *   blend and the `player:teleport` contract behave: teleport places the head,
 *   and the eye is a fixed offset below it.
 *
 * Nothing in here allocates.
 */

const MAX_NORMALS = 12;

export class Locomotion {
  constructor(world) {
    this.world = world;

    this._segA = new THREE.Vector3();
    this._segB = new THREE.Vector3();
    this._step = new THREE.Vector3();
    this._save = new THREE.Vector3();
    this._try = new THREE.Vector3();
    this._flat = new THREE.Vector3();
    this._tan = new THREE.Vector3();
    this._probe = new THREE.Vector3();
    this._down = new THREE.Vector3(0, -1, 0);

    /** Contact normals accumulated over the whole move, deduplicated. */
    this.normals = [];
    for (let i = 0; i < MAX_NORMALS; i++) this.normals.push(new THREE.Vector3());
    this.normalCount = 0;

    /** Best (most upward) normal seen while moving. */
    this.touchNormal = new THREE.Vector3(0, 1, 0);
    this.touchBest = -1;
    this.touched = false;
    /** Vertical correction the collision pass applied — the camera smooths it. */
    this.pushedUp = 0;
    /** Set when step-up ran and succeeded. */
    this.stepped = 0;

    /** Ground probe result. */
    this.ground = {
      hit: false, walkable: false, y: 0, surface: 'concrete',
      normal: new THREE.Vector3(0, 1, 0),
    };
    this.maxSlope = 0.72;
    this._gn = new THREE.Vector3();
  }

  /* --------------------------------------------------------------- kinematics */

  /**
   * Source ground friction: constant deceleration with a `stopSpeed` floor, so
   * walking stops crisply instead of asymptotically creeping.
   */
  applyFriction(vel, h, friction, stopSpeed) {
    const sx = vel.x, sz = vel.z;
    const speed = Math.sqrt(sx * sx + sz * sz);
    if (speed < 1e-4) { vel.x = 0; vel.z = 0; return; }
    const control = speed < stopSpeed ? stopSpeed : speed;
    const drop = control * friction * h;
    const next = speed - drop;
    const scale = next <= 0 ? 0 : next / speed;
    vel.x = sx * scale;
    vel.z = sz * scale;
  }

  /**
   * Source acceleration. Only ever adds speed *along* wishDir and only up to
   * wishSpeed in that direction, which is why strafe-accelerating feels alive
   * instead of clamping the whole velocity vector every tick.
   */
  accelerate(vel, wishDir, wishSpeed, accel, h) {
    const current = vel.x * wishDir.x + vel.z * wishDir.z;
    const add = wishSpeed - current;
    if (add <= 0) return;
    let a = accel * wishSpeed * h;
    if (a > add) a = add;
    vel.x += wishDir.x * a;
    vel.z += wishDir.z * a;
  }

  /**
   * Airborne steering: rotate the horizontal velocity toward wishDir at a fixed
   * angular rate, preserving speed. This is the CoD-style air control — you can
   * redirect a jump but never gain speed from it.
   */
  airSteer(vel, wishDir, rate, h) {
    const sx = vel.x, sz = vel.z;
    const speed = Math.sqrt(sx * sx + sz * sz);
    if (speed < 0.2) return;
    const cx = sx / speed, cz = sz / speed;
    const dot = cx * wishDir.x + cz * wishDir.z;
    if (dot > 0.9995) return;
    const maxTurn = rate * h;
    const angle = Math.acos(dot < -1 ? -1 : dot > 1 ? 1 : dot);
    const t = angle < 1e-4 ? 0 : Math.min(1, maxTurn / angle);
    const nx = cx + (wishDir.x - cx) * t;
    const nz = cz + (wishDir.z - cz) * t;
    const nl = Math.sqrt(nx * nx + nz * nz) || 1;
    vel.x = (nx / nl) * speed;
    vel.z = (nz / nl) * speed;
  }

  /** Remove the components of `vel` that push into the recorded contacts. */
  clipVelocity(vel) {
    for (let i = 0; i < this.normalCount; i++) {
      const n = this.normals[i];
      const into = vel.dot(n);
      if (into < 0) vel.addScaledVector(n, -into);
    }
  }

  /**
   * Downhill acceleration on a slope too steep to stand on. Called instead of
   * ground accel so the player slides off rather than sticking or bouncing.
   */
  applySlopeSlide(vel, normal, h) {
    // Downhill tangent = gravity projected onto the slope plane.
    this._tan.set(0, -1, 0);
    this._tan.addScaledVector(normal, -this._tan.dot(normal));
    const l = this._tan.length();
    if (l < 1e-4) return;
    this._tan.multiplyScalar(1 / l);
    vel.addScaledVector(this._tan, MOVE.slopeSlide * h);
  }

  /* ---------------------------------------------------------------- collision */

  _resolve(top, radius, height) {
    const w = this.world;
    if (!w.ok) return;
    this._segA.set(top.x, top.y - height + radius, top.z);
    this._segB.set(top.x, top.y - radius, top.z);
    const before = this._segB.y;
    const n = w.depenetrate(this._segA, this._segB, radius, MOVE.pushIterations, this.maxSlope);
    if (n === 0) return;
    top.set(this._segB.x, this._segB.y + radius, this._segB.z);
    this.pushedUp += this._segB.y - before;
    this.touched = true;
    if (w.bestGroundY > this.touchBest) {
      this.touchBest = w.bestGroundY;
      this.touchNormal.copy(w.bestGroundNormal);
    }
    for (let i = 0; i < w.contactCount; i++) this._addNormal(w.contacts[i]);
  }

  _addNormal(n) {
    for (let i = 0; i < this.normalCount; i++) {
      if (this.normals[i].dot(n) > 0.985) return;
    }
    if (this.normalCount >= MAX_NORMALS) return;
    this.normals[this.normalCount++].copy(n);
  }

  /** Substepped translation along `disp`, depenetrating after every substep. */
  _sweep(top, disp, radius, height) {
    const len = disp.length();
    if (len < 1e-7) { this._resolve(top, radius, height); return; }
    const steps = Math.min(16, Math.max(1, Math.ceil(len / MOVE.substep)));
    const inv = 1 / steps;
    for (let i = 0; i < steps; i++) {
      top.addScaledVector(disp, inv);
      this._resolve(top, radius, height);
    }
  }

  /**
   * Integrate one tick of displacement. Vertical first (so you land before you
   * walk), then horizontal with a step-up retry.
   *
   * @returns {void} — results land in `this.normals`, `this.pushedUp`,
   *                   `this.stepped` and `this.touchNormal`.
   */
  move(top, disp, radius, height, stepHeight, grounded, maxSlope) {
    this.maxSlope = maxSlope;
    this.normalCount = 0;
    this.touched = false;
    this.touchBest = -1;
    this.touchNormal.set(0, 1, 0);
    this.pushedUp = 0;
    this.stepped = 0;

    // ---- vertical ----------------------------------------------------------
    if (Math.abs(disp.y) > 1e-7) {
      this._step.set(0, disp.y, 0);
      this._sweep(top, this._step, radius, height);
    }

    // ---- horizontal --------------------------------------------------------
    const wantX = disp.x, wantZ = disp.z;
    const wantLen = Math.sqrt(wantX * wantX + wantZ * wantZ);
    if (wantLen < 1e-7) return;

    this._save.copy(top);
    this._step.set(wantX, 0, wantZ);
    this._sweep(top, this._step, radius, height);

    const gotX = top.x - this._save.x, gotZ = top.z - this._save.z;
    const got = Math.sqrt(gotX * gotX + gotZ * gotZ);
    // Progressed most of the way, or not on the ground: nothing to step over.
    if (!grounded || got > wantLen * 0.72 || stepHeight <= 0.01 || wantLen < 0.004) return;

    // A too-steep face must be *slid down*, never stepped up — otherwise the
    // step-up ratchets the player up a 60° ramp at metres per second and
    // `maxSlope` means nothing. The contact normal alone cannot tell the two
    // apart: the top edge of a kerb produces the same diagonal normal as a steep
    // slope. What distinguishes a step is that there is a *walkable surface just
    // ahead of you, within one step height* — so look for it directly.
    const inv = 1 / wantLen;
    const feetY = this._save.y - height;
    this._probe.set(
      this._save.x + wantX * inv * (radius + 0.06),
      feetY + stepHeight + 0.25,
      this._save.z + wantZ * inv * (radius + 0.06),
    );
    const ahead = this.world.cast(this._probe, this._down, stepHeight + 0.30);
    if (!ahead || ahead.normal.y < maxSlope) return;
    const aheadRise = ahead.point.y - feetY;
    if (aheadRise < -0.02 || aheadRise > stepHeight + 0.02) return;

    // ---- step-up retry -----------------------------------------------------
    // Lift, translate, drop. The lift is only attempted if the raised capsule
    // has somewhere to be — otherwise a low soffit would let you climb a wall.
    this._try.copy(this._save);
    this._try.y += stepHeight;
    if (!this.world.capsuleFree(this._try.x, this._try.y, this._try.z, height, radius, 0.03)) return;

    // The flat attempt's contacts stay in [0, baseCount); the retry appends
    // above them so either result can be kept without a second pool.
    const baseCount = this.normalCount;
    const basePush = this.pushedUp;

    this._step.set(wantX, 0, wantZ);
    this._sweep(this._try, this._step, radius, height);
    const stepX = this._try.x - this._save.x, stepZ = this._try.z - this._save.z;
    const stepGot = Math.sqrt(stepX * stepX + stepZ * stepZ);

    let rise = -Infinity;
    if (stepGot > got + 0.002) {
      // Set the lifted capsule back down with a swept time-of-impact descent.
      //
      // Neither of the obvious alternatives works. A downward *ray* from the
      // capsule centre is short of the kerb edge, so it only ever finds the floor
      // you are already standing on and the step is rejected forever. A
      // translate-and-depenetrate descent is worse: the contact normal on a convex
      // edge is mostly horizontal, so the capsule is pushed sideways and slides
      // straight back off the step. A true swept descent stops the instant the
      // capsule touches, which perches it on the edge — and that is how a capsule
      // climbs a kerb, a few centimetres per tick.
      const drop = this._descend(this._try, radius, height, stepHeight + 0.03);
      rise = drop < 0 ? -Infinity : this._try.y - this._save.y;
    }
    // Nothing underneath (rise goes negative) or a lift bigger than a step:
    // discard the retry and keep the flat slide.
    if (rise < -0.001 || rise > stepHeight + 0.03) {
      this.normalCount = baseCount;
      this.pushedUp = basePush;
      return;
    }

    // Keep only the retry's contacts, so the wall we just climbed does not clip
    // the very velocity that carried us over it.
    for (let i = baseCount; i < this.normalCount; i++) this.normals[i - baseCount].copy(this.normals[i]);
    this.normalCount -= baseCount;
    this.stepped = rise;
    this.pushedUp = basePush + rise;
    top.copy(this._try);
  }

  /**
   * Lower the capsule until it first touches something, by bisection on a cheap
   * overlap test. Nine probes resolve the contact to under 1 mm over a 45 cm
   * drop. Returns the distance descended, or -1 if the capsule is already
   * overlapping or there is nothing at all beneath it.
   */
  _descend(top, radius, height, maxDrop) {
    const w = this.world;
    const x = top.x, z = top.z, y0 = top.y;
    const SHRINK = 0.006;
    if (!w.capsuleFree(x, y0, z, height, radius, SHRINK)) return -1;
    if (w.capsuleFree(x, y0 - maxDrop, z, height, radius, SHRINK)) return -1;
    let lo = 0, hi = maxDrop;
    for (let i = 0; i < 9; i++) {
      const mid = (lo + hi) * 0.5;
      if (w.capsuleFree(x, y0 - mid, z, height, radius, SHRINK)) lo = mid; else hi = mid;
    }
    top.y = y0 - lo;
    return lo;
  }

  /**
   * Five downward rays from just inside the feet: centre plus four at 74% of the
   * radius. A single centre ray drops you off the lip of every stair tread; the
   * ring keeps the highest contact under the whole footprint, which is what makes
   * walking down stairs smooth instead of a series of small falls.
   */
  groundProbe(top, radius, height, dist, maxSlope) {
    const g = this.ground;
    g.hit = false;
    g.walkable = false;
    if (!this.world.ok) return g;

    const feet = top.y - height;
    const start = feet + 0.10;
    const far = dist + 0.10;
    const s = radius * MOVE.probeSpread;
    let bestY = -Infinity;

    for (let i = 0; i < 5; i++) {
      const ox = i === 1 ? s : i === 2 ? -s : 0;
      const oz = i === 3 ? s : i === 4 ? -s : 0;
      this._probe.set(top.x + ox, start, top.z + oz);
      const hit = this.world.cast(this._probe, this._down, far);
      if (!hit) continue;
      if (hit.point.y <= bestY) continue;
      bestY = hit.point.y;
      this._gn.copy(hit.normal);
      g.surface = hit.surface;
    }
    if (bestY === -Infinity) return g;

    g.hit = true;
    g.y = bestY;
    g.normal.copy(this._gn);
    g.walkable = g.normal.y >= maxSlope;
    return g;
  }
}
