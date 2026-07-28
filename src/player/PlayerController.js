import * as THREE from 'three';
import { PLAYER, WORLD, CAMERA } from '../core/Constants.js';
import { MOVE } from './PlayerTuning.js';
import { CollisionWorld } from './collision/CollisionWorld.js';
import { Locomotion } from './movement/Locomotion.js';

/**
 * OWNER: player-movement agent.
 *
 * CONTRACT (read by CameraRig, ViewModel, WeaponSystem, HUD):
 *   player.position    : THREE.Vector3 — top of the capsule (head reference)
 *   player.velocity    : THREE.Vector3
 *   player.yaw/pitch   : number (radians) — CameraRig reads, does not write
 *   player.state       : { grounded, crouching, sprinting, sliding, mantling,
 *                          ads, lean, speed, slideT, mantleT, crouchAmount }
 *   player.eyePosition : THREE.Vector3 (read-only, refreshed every frame)
 *   player.stridePhase : number — advances 1.0 per foot plant, distance-driven
 *   player.health      : number
 *   listens: 'player:teleport', 'player:damage'
 *   emits:   'player:footstep' { position, surface, foot, speed, gait }
 *            'player:land'     { position, impact, surface }
 *            'player:jump'     { position, surface }
 *            'player:death'    { position }
 *   (payload Vector3s on those four are freshly allocated — they fire a couple of
 *    times a second at most, so listeners may keep them.)
 *
 * WHY THE CAPSULE ORIGIN IS THE HEAD
 *   `player:teleport` places `position` verbatim and the screenshot rig depends on
 *   the resulting eye height, so `position` has to stay the head reference it has
 *   always been: eye = position.y + PLAYER.eyeOffset, feet = position.y - height.
 *   Crouching therefore *lowers* position.y while holding the feet — which is
 *   exactly the motion you want the camera to see.
 */

const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _wish = new THREE.Vector3();
const _disp = new THREE.Vector3();
const _probe = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _down = new THREE.Vector3(0, -1, 0);
const _vol = new THREE.Box3();

const MANTLE_WALL_HEIGHTS = [0.30, 0.70, 1.10];

export class PlayerController {
  constructor() {
    this.name = 'player';
    this.position = new THREE.Vector3(0, PLAYER.height, 8);
    this.velocity = new THREE.Vector3();
    this.eyePosition = new THREE.Vector3();
    this.groundNormal = new THREE.Vector3(0, 1, 0);
    this.yaw = 0;
    this.pitch = 0;
    this.health = PLAYER.maxHealth;

    this.radius = PLAYER.radius;
    this.height = PLAYER.height;          // live, blended by the crouch system
    this.groundSurface = 'concrete';
    this.stridePhase = 0;
    this.footSign = 1;

    /**
     * Absorber for discontinuous vertical corrections (step-ups, stair snaps).
     * The body teleports; the eye does not. Decays to zero every frame.
     */
    this.viewOffsetY = 0;

    this.state = {
      grounded: true, crouching: false, sprinting: false,
      sliding: false, mantling: false, ads: false, lean: 0,
      speed: 0, slideT: 0, slideTilt: 0, mantleT: 0,
      crouchAmount: 0, airborneTime: 0,
    };

    this.collision = new CollisionWorld();
    this.loco = new Locomotion(this.collision);

    this._sinceGrounded = 0;
    this._jumpBufferT = 0;
    this._jumpConsumed = false;
    this._pressJump = false;
    this._pressCrouch = false;
    this._sinceDamage = 99;
    this._slideT = 0;
    this._slideCooldown = 0;
    this._mantleT = 0;
    this._mantleFrom = new THREE.Vector3();
    this._mantleTo = new THREE.Vector3();
    this._spawn = new THREE.Vector3(0, PLAYER.height, 8);
    this._floorY = -1e4;
    this._dead = false;
    this._forcedStance = null;
  }

  init(ctx) {
    this.ctx = ctx;
    this.input = ctx.require('input');
    this.level = ctx.require('level');

    const spawn = this.level.spawnPoints?.[0];
    if (spawn) { this.position.copy(spawn); this._spawn.copy(spawn); }

    // Collision volume: the level's own bounds, opened up enough that the
    // terrain apron and the outside of the perimeter wall are still solid.
    _vol.copy(this.level.bounds ?? new THREE.Box3(
      new THREE.Vector3(-60, -10, -60), new THREE.Vector3(60, 40, 60),
    ));
    _vol.expandByVector(new THREE.Vector3(30, 14, 30));

    const t0 = performance.now();
    const ok = this.collision.build(this.level, ctx, _vol);
    this._floorY = (ok ? this.collision.bounds.min.y : -10) - MOVE.voidMargin;
    console.info(
      ok
        ? `[player] collision snapshot: ${this.collision.triangles.toLocaleString()} tris from `
          + `${this.collision.sources.length} colliders in ${Math.round(performance.now() - t0)}ms`
        : '[player] collision snapshot unavailable — falling back to a ground plane',
    );

    ctx.bus.on('player:teleport', ({ position, yaw, pitch }) => {
      // Verbatim, by contract. No depenetration, no ground snap — the screenshot
      // rig frames shots to the centimetre and physics must not second-guess it.
      this.position.copy(position);
      this.velocity.set(0, 0, 0);
      if (yaw !== undefined) this.yaw = THREE.MathUtils.degToRad(yaw);
      if (pitch !== undefined) this.pitch = pitch;
      this.viewOffsetY = 0;
      this.stridePhase = 0;
      this.height = PLAYER.height;
      this.state.sliding = false;
      this.state.mantling = false;
      this.state.lean = 0;
      this.state.slideT = 0;
      this.state.mantleT = 0;
      this._slideT = 0;
      this._mantleT = 0;
      this._applyForcedStance();
      this._updateEye();
    });

    ctx.bus.on('player:damage', ({ amount = 0 }) => {
      if (this._dead) return;
      this.health = Math.max(0, this.health - amount);
      this._sinceDamage = 0;
      if (this.health <= 0) {
        this._dead = true;
        ctx.bus.emit('player:death', { position: this.position.clone() });
      }
    });

    // Stance forcing for the screenshot rig: ?stance=crouch|slide|sprint|lean-l|lean-r
    const p = new URLSearchParams(location.search).get('stance');
    if (p) this._forcedStance = p;
    this._applyForcedStance();
    this._updateEye();
  }

  /** Static poses the shoot rig can hold in a frozen frame. */
  _applyForcedStance() {
    const s = this._forcedStance;
    if (!s) return;
    if (s === 'crouch' || s === 'slide') {
      const drop = PLAYER.height - PLAYER.crouchHeight;
      this.height = PLAYER.crouchHeight;
      this.position.y -= drop;
      this.state.crouching = true;
      this.state.crouchAmount = 1;
      if (s === 'slide') {
        this.state.sliding = true;
        this.state.slideT = 0.35;
        this.state.slideTilt = 1;
        this.state.speed = PLAYER.slideImpulse * 0.8;
      }
    } else if (s === 'sprint') {
      this.state.sprinting = true;
      this.state.speed = PLAYER.sprintSpeed;
    } else if (s === 'lean-l') {
      this.state.lean = -1;
    } else if (s === 'lean-r') {
      this.state.lean = 1;
    }
  }

  /* --------------------------------------------------------------- per frame */

  update(dt) {
    const inp = this.input;

    // Mouse look belongs on the frame clock, not the physics clock: the deltas
    // are accumulated per frame and cleared per frame, so integrating them in
    // fixedUpdate would multiply sensitivity by the substep count.
    if (inp.locked && inp.enabled) {
      const sens = CAMERA.sensitivity * (this.state.ads ? CAMERA.adsSensScale : 1);
      this.yaw -= inp.mouse.dx * sens;
      this.pitch = THREE.MathUtils.clamp(
        this.pitch - inp.mouse.dy * sens, -CAMERA.pitchClamp, CAMERA.pitchClamp,
      );
      if (this.yaw > Math.PI) this.yaw -= Math.PI * 2;
      else if (this.yaw < -Math.PI) this.yaw += Math.PI * 2;
    }

    // Latch edges here as well as in fixedUpdate: a frame that produces zero
    // physics substeps must not swallow a keypress.
    this._sampleEdges();

    // The step absorber lives on the frame clock so it is smooth at any refresh.
    if (this.viewOffsetY !== 0) {
      const k = Math.exp(-12.0 * dt);
      this.viewOffsetY *= k;
      if (Math.abs(this.viewOffsetY) < 0.0004) this.viewOffsetY = 0;
    }
    this._updateEye();
  }

  _sampleEdges() {
    const inp = this.input;
    if (inp.actionPressed('jump')) this._pressJump = true;
    if (inp.actionPressed('crouch')) this._pressCrouch = true;
  }

  /* -------------------------------------------------------------- fixed tick */

  fixedUpdate(h, ctx) {
    this._sampleEdges();
    if (this._pressJump) { this._jumpBufferT = PLAYER.jumpBuffer; this._pressJump = false; }
    if (this._jumpBufferT > 0) this._jumpBufferT -= h;
    this._slideCooldown = Math.max(0, this._slideCooldown - h);
    this._sinceDamage += h;

    if (this.state.mantling) {
      this._updateMantle(h, ctx);
      this._regen(h);
      this._updateEye();
      return;
    }

    this._updateStance(h);
    if (!this._tryMantle(ctx)) this._tryJump(ctx);

    const wishSpeed = this._wishDir(_wish);
    this._accelerate(h, _wish, wishSpeed);
    if (!this.state.grounded) this.velocity.y += WORLD.gravity * h;

    // Captured before collision: `clipVelocity` cancels the downward component
    // against the floor the instant you touch it, so reading velocity.y after the
    // move would report every landing as a zero-impact one.
    this._preVy = this.velocity.y;

    _disp.copy(this.velocity).multiplyScalar(h);
    if (this.collision.ok) {
      const step = (this.state.grounded && !this.state.sliding) ? PLAYER.stepHeight : 0.0;
      this.loco.move(
        this.position, _disp, this.radius, this.height,
        step, this.state.grounded, PLAYER.maxSlope,
      );
      this.loco.clipVelocity(this.velocity);
      if (this.loco.stepped > 0) this._absorb(-this.loco.stepped);
      this._groundCheck(h, ctx);
    } else {
      this._flatFallback(h, ctx);
    }

    this._updateLean(h);
    this._updateStride(h, ctx);
    this._regen(h);
    this._safety();
    this._updateEye();
  }

  /**
   * Feed a discontinuous vertical body correction into the eye absorber.
   *
   * The clamp is deliberately asymmetric. Upward corrections (step-ups) are rare
   * and large, so they get the full step height of smoothing — that is what stops
   * a 42 cm kerb from flinging the camera. Downward corrections (the per-tread
   * snap while running down stairs) arrive several times a second, so they are
   * capped tight: an unbounded absorber would leave the camera floating half a
   * metre above the body all the way down a staircase.
   */
  _absorb(dy) {
    this.viewOffsetY = THREE.MathUtils.clamp(
      this.viewOffsetY + dy, -(PLAYER.stepHeight + 0.05), 0.16,
    );
  }

  /** Fills `out` with a unit horizontal wish direction; returns the wish speed. */
  _wishDir(out) {
    const inp = this.input;
    // Read the actions directly: `input.moveAxis` is a getter that builds an
    // object, and this runs 120 times a second.
    let ix = (inp.action('right') ? 1 : 0) - (inp.action('left') ? 1 : 0);
    let iy = (inp.action('forward') ? 1 : 0) - (inp.action('back') ? 1 : 0);
    const st = this.state;

    st.sprinting = inp.action('sprint') && iy > 0.1 && !st.crouching && !st.ads && !st.sliding;

    if (ix === 0 && iy === 0) { out.set(0, 0, 0); return 0; }
    const l = Math.hypot(ix, iy);
    ix /= l; iy /= l;

    _fwd.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    _right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    out.set(
      _fwd.x * iy + _right.x * ix, 0,
      _fwd.z * iy + _right.z * ix,
    );
    const ol = Math.hypot(out.x, out.z) || 1;
    out.x /= ol; out.z /= ol;

    let speed = st.crouching ? PLAYER.crouchSpeed : st.sprinting ? PLAYER.sprintSpeed : PLAYER.walkSpeed;
    if (st.ads) speed *= PLAYER.adsSpeedScale;
    if (iy < -0.1) speed *= 0.84;          // backpedal penalty
    return speed;
  }

  _accelerate(h, wish, wishSpeed) {
    const v = this.velocity;
    const st = this.state;

    if (st.sliding) {
      this.loco.applyFriction(v, h, PLAYER.slideFriction, 0.35);
      if (wishSpeed > 0) this.loco.airSteer(v, wish, MOVE.slideSteer, h);
      return;
    }
    if (st.grounded) {
      this.loco.applyFriction(v, h, PLAYER.groundFriction, PLAYER.stopSpeed);
      if (wishSpeed > 0) this.loco.accelerate(v, wish, wishSpeed, PLAYER.groundAccel, h);
    } else if (wishSpeed > 0) {
      // Air: you may redirect, and you may top up to walk speed, but you cannot
      // accelerate to sprint speed off the ground.
      this.loco.accelerate(v, wish, Math.min(wishSpeed, PLAYER.walkSpeed), PLAYER.airAccel, h);
      this.loco.airSteer(v, wish, MOVE.airSteer * PLAYER.airControl * 4.5, h);
    }
  }

  /* ------------------------------------------------------------------ ground */

  _groundCheck(h, ctx) {
    const st = this.state;
    const wasGrounded = st.grounded;
    const fall = this._preVy ?? this.velocity.y;
    const rising = this.velocity.y > 0.6;
    const dist = (wasGrounded && !rising) ? MOVE.groundSnap : MOVE.airProbe;

    const g = this.loco.groundProbe(this.position, this.radius, this.height, dist, PLAYER.maxSlope);
    let grounded = false;
    if (this.loco.stepped > 0.001 || (this.loco.touchBest >= PLAYER.maxSlope && !rising)) {
      // Either a step-up just seated the capsule on something, or the collision
      // pass is already resting it on a walkable contact — the foot of a ramp,
      // for instance, where the surface is *above* where a downward ray from the
      // feet can see. Snapping down in either case would drag the player back off
      // the thing they just climbed, and the two would fight forever.
      grounded = true;
    } else if (g.hit && g.walkable && !rising) {
      const gap = (this.position.y - this.height) - g.y;
      if (gap <= dist + 0.001) {
        grounded = true;
        if (Math.abs(gap) > 0.0005) {
          this.position.y -= gap;        // glue to the surface
          // Walking a continuous slope produces a small gap every single tick and
          // that motion is already smooth — only feed the absorber the part that
          // is genuinely a discontinuity (a stair tread, a kerb).
          if (gap > 0.035) this._absorb(gap - 0.035);
          else if (gap < -0.035) this._absorb(gap + 0.035);
        }
      }
    }

    if (grounded) {
      if (g.hit) this.groundNormal.copy(g.normal); else this.groundNormal.set(0, 1, 0);
      this.groundSurface = g.hit ? g.surface : this.groundSurface;
      if (this.velocity.y < 0) this.velocity.y = 0;
      this._sinceGrounded = 0;
      this._jumpConsumed = false;
      st.airborneTime = 0;
      if (!wasGrounded && fall < -MOVE.landMinImpact) {
        ctx.bus.emit('player:land', {
          position: this.position.clone(), impact: -fall, surface: g.surface,
        });
      }
    } else {
      this._sinceGrounded += h;
      st.airborneTime += h;
      // Touching something too steep to stand on: accelerate down the fall line
      // so steep faces shed the player instead of catching them.
      if (this.loco.touchBest > 0.05 && this.loco.touchBest < PLAYER.maxSlope) {
        this.loco.applySlopeSlide(this.velocity, this.loco.touchNormal, h);
      }
    }
    st.grounded = grounded;
  }

  /** Used only if the collision snapshot could not be built. */
  _flatFallback(h, ctx) {
    this.position.addScaledVector(this.velocity, h);
    const floor = this.height;
    if (this.position.y <= floor) {
      const fall = this.velocity.y;
      if (!this.state.grounded && fall < -MOVE.landMinImpact) {
        ctx.bus.emit('player:land', {
          position: this.position.clone(), impact: -fall, surface: 'concrete',
        });
      }
      this.position.y = floor;
      this.velocity.y = 0;
      this.state.grounded = true;
      this._jumpConsumed = false;
      this._sinceGrounded = 0;
    } else {
      this.state.grounded = false;
      this._sinceGrounded += h;
    }
  }

  /* ------------------------------------------------------ stance: crouch/slide */

  _updateStance(h) {
    const inp = this.input;
    const st = this.state;
    const crouchHeld = inp.action('crouch');
    const speed = Math.hypot(this.velocity.x, this.velocity.z);

    if (this._pressCrouch) {
      this._pressCrouch = false;
      if (st.grounded && !st.sliding && this._slideCooldown <= 0
          && speed > MOVE.slideMinSpeed && (inp.action('sprint') || speed > PLAYER.walkSpeed * 1.02)) {
        this._startSlide(speed);
      }
    }

    if (st.sliding) {
      this._slideT += h;
      st.slideT = Math.min(1, this._slideT / PLAYER.slideDuration);
      if (this._slideT >= PLAYER.slideDuration || !st.grounded || speed < MOVE.slideExitSpeed) {
        this._endSlide();
      }
    }

    st.crouching = st.sliding || crouchHeld;

    // ---- height blend, feet anchored -------------------------------------
    const target = st.crouching ? PLAYER.crouchHeight : PLAYER.height;
    let next = this.height + (target - this.height) * Math.min(1, MOVE.heightBlend * h);
    if (Math.abs(next - target) < 0.002) next = target;
    if (next > this.height + 1e-5 && this.collision.ok) {
      const feet = this.position.y - this.height;
      if (!this.collision.capsuleFree(this.position.x, feet + next, this.position.z, next, this.radius, 0.015)) {
        next = this.height;             // low ceiling — refuse to stand up
        st.crouching = true;
      }
    }
    const feet = this.position.y - this.height;
    this.height = next;
    this.position.y = feet + this.height;
    st.crouchAmount = (PLAYER.height - this.height) / (PLAYER.height - PLAYER.crouchHeight);
  }

  _startSlide(speed) {
    const st = this.state;
    st.sliding = true;
    this._slideT = 0;
    st.slideT = 0;
    st.slideTilt = this.footSign;
    const boost = Math.max(speed, PLAYER.slideImpulse);
    if (speed > 0.05) {
      const s = boost / speed;
      this.velocity.x *= s;
      this.velocity.z *= s;
    } else {
      _fwd.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
      this.velocity.x = _fwd.x * boost;
      this.velocity.z = _fwd.z * boost;
    }
  }

  _endSlide() {
    const st = this.state;
    st.sliding = false;
    st.slideT = 0;
    this._slideT = 0;
    this._slideCooldown = MOVE.slideCooldown;
  }

  /* ------------------------------------------------------------------- jump */

  _tryJump(ctx) {
    if (this._jumpBufferT <= 0) return;
    const st = this.state;
    const coyote = !st.grounded && this._sinceGrounded < PLAYER.coyoteTime && !this._jumpConsumed;
    if (!st.grounded && !coyote) return;

    this._jumpBufferT = 0;
    this._jumpConsumed = true;
    let vy = PLAYER.jumpVelocity;
    if (st.sliding) {
      // Slide-jump keeps — and slightly rewards — the momentum you built.
      this.velocity.x *= MOVE.slideJumpBoost;
      this.velocity.z *= MOVE.slideJumpBoost;
      this._endSlide();
    } else if (st.crouching) {
      vy *= 0.86;
    }
    this.velocity.y = vy;
    st.grounded = false;
    this._sinceGrounded = PLAYER.coyoteTime + 1;
    ctx.bus.emit('player:jump', {
      position: this.position.clone(), surface: this.groundSurface,
    });
  }

  /* ----------------------------------------------------------------- mantle */

  /**
   * Look for a walkable ledge between `mantleMinRise` and `PLAYER.mantleMaxHeight`
   * directly ahead, with standing clearance on top of it. Three wall probes at
   * different heights so a knee-high crate and a chest-high wall both register.
   */
  _tryMantle(ctx) {
    if (this._jumpBufferT <= 0 || this.state.sliding || !this.collision.ok) return false;
    const inp = this.input;
    if (!inp.action('forward')) return false;

    _fwd.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const feet = this.position.y - this.height;
    const reach = this.radius + MOVE.mantleReach;

    let wallDist = -1;
    for (let i = 0; i < MANTLE_WALL_HEIGHTS.length; i++) {
      const y = feet + MANTLE_WALL_HEIGHTS[i];
      if (y > feet + PLAYER.mantleMaxHeight) break;
      _probe.set(this.position.x, y, this.position.z);
      const wall = this.collision.cast(_probe, _fwd, reach);
      if (wall && Math.abs(wall.normal.y) < 0.45) { wallDist = wall.distance; break; }
    }
    if (wallDist < 0) return false;

    const inset = wallDist + MOVE.mantleLandInset + this.radius * 0.55;
    const lx = this.position.x + _fwd.x * inset;
    const lz = this.position.z + _fwd.z * inset;
    const from = feet + PLAYER.mantleMaxHeight + 0.6;
    _probe.set(lx, from, lz);
    const ledge = this.collision.cast(_probe, _down, PLAYER.mantleMaxHeight + 0.8);
    if (!ledge || ledge.normal.y < PLAYER.maxSlope) return false;

    const ledgeY = ledge.point.y;
    const rise = ledgeY - feet;
    if (rise < MOVE.mantleMinRise || rise > PLAYER.mantleMaxHeight) return false;
    if (!this.collision.capsuleFree(lx, ledgeY + PLAYER.height, lz, PLAYER.height, this.radius, 0.03)) {
      return false;
    }

    this._jumpBufferT = 0;
    this._mantleT = 0;
    this._mantleFrom.copy(this.position);
    this._mantleTo.set(lx, ledgeY + PLAYER.height, lz);
    this.state.mantling = true;
    this.state.mantleT = 0;
    this.state.sprinting = false;
    this.velocity.set(0, 0, 0);
    ctx.bus.emit('player:mantle', { position: this._mantleTo.clone(), rise });
    return true;
  }

  _updateMantle(h, ctx) {
    this._mantleT += h;
    const p = Math.min(1, this._mantleT / PLAYER.mantleDuration);
    // Rise first, translate second, with a small apex overshoot: a straight lerp
    // reads as an elevator, this reads as pulling yourself over an edge.
    const yp = 1 - Math.pow(1 - Math.min(1, p / 0.66), 3);
    const q = Math.max(0, (p - 0.22) / 0.78);
    const xp = q * q * (3 - 2 * q);
    const a = this._mantleFrom, b = this._mantleTo;
    this.position.x = a.x + (b.x - a.x) * xp;
    this.position.z = a.z + (b.z - a.z) * xp;
    this.position.y = a.y + (b.y - a.y) * yp + Math.sin(Math.PI * p) * 0.055;
    this.velocity.set(0, 0, 0);
    this.height += (PLAYER.height - this.height) * Math.min(1, MOVE.heightBlend * h);
    this.state.mantleT = p;
    this.state.crouching = false;
    this.state.crouchAmount = (PLAYER.height - this.height) / (PLAYER.height - PLAYER.crouchHeight);

    if (p >= 1) {
      this.height = PLAYER.height;
      this.position.copy(b);
      this.state.mantling = false;
      this.state.mantleT = 0;
      this.state.grounded = true;
      this._sinceGrounded = 0;
      this._jumpConsumed = false;
      _fwd.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
      this.velocity.set(_fwd.x * 1.6, 0, _fwd.z * 1.6);
      ctx.bus.emit('player:footstep', {
        position: this.position.clone(), surface: this.groundSurface,
        foot: this.footSign, speed: 1.6, gait: 'mantle',
      });
    }
  }

  /* ------------------------------------------------------------------- lean */

  _updateLean(h) {
    const inp = this.input;
    const st = this.state;
    let t = (inp.action('leanRight') ? 1 : 0) - (inp.action('leanLeft') ? 1 : 0);
    if (st.sliding || st.mantling || st.sprinting) t = 0;

    if (t !== 0 && this.collision.ok) {
      _right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
      _dir.copy(_right).multiplyScalar(t);
      _probe.set(this.position.x, this.position.y + PLAYER.eyeOffset, this.position.z);
      const hit = this.collision.cast(_probe, _dir, PLAYER.leanOffset + MOVE.leanClearance);
      if (hit) {
        // Only lean as far as there is room for your shoulder.
        const room = Math.max(0, (hit.distance - MOVE.leanClearance) / PLAYER.leanOffset);
        t *= Math.min(1, room);
      }
    }

    st.lean += (t - st.lean) * Math.min(1, MOVE.leanRate * h);
    if (Math.abs(st.lean) < 1e-4) st.lean = 0;
  }

  /* -------------------------------------------------------------- footsteps */

  _updateStride(h, ctx) {
    const st = this.state;
    const speed = Math.hypot(this.velocity.x, this.velocity.z);
    st.speed = speed;
    if (!st.grounded || st.sliding || st.mantling || speed < 0.30) return;

    const stride = st.crouching ? MOVE.strideCrouch
      : st.sprinting ? MOVE.strideSprint : MOVE.strideWalk;
    const before = this.stridePhase;
    this.stridePhase += (speed * h) / stride;

    if (Math.floor(this.stridePhase) > Math.floor(before)) {
      this.footSign = -this.footSign;
      this._emitFootstep(ctx, speed, st);
    }
    // Keep the phase small and even, so the bob's 2-step cycle stays continuous.
    if (this.stridePhase > 1024) this.stridePhase -= 1024;
  }

  _emitFootstep(ctx, speed, st) {
    // The surface under the *foot*, not under the capsule centre.
    _right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const ox = _right.x * this.radius * 0.45 * this.footSign;
    const oz = _right.z * this.radius * 0.45 * this.footSign;
    const feet = this.position.y - this.height;
    let surface = this.groundSurface;
    _probe.set(this.position.x + ox, feet + 0.22, this.position.z + oz);
    const hit = this.collision.ok ? this.collision.cast(_probe, _down, 0.55) : null;
    if (hit) surface = hit.surface;

    ctx.bus.emit('player:footstep', {
      position: new THREE.Vector3(this.position.x + ox, hit ? hit.point.y : feet, this.position.z + oz),
      surface,
      foot: this.footSign,
      speed,
      gait: st.crouching ? 'crouch' : st.sprinting ? 'sprint' : 'walk',
    });
  }

  /* ----------------------------------------------------------------- health */

  _regen(h) {
    if (this._dead) return;
    if (this.health < PLAYER.maxHealth && this._sinceDamage >= PLAYER.regenDelay) {
      this.health = Math.min(PLAYER.maxHealth, this.health + PLAYER.regenRate * h);
    }
  }

  _safety() {
    const p = this.position;
    if (Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z) && p.y > this._floorY) return;
    p.copy(this._spawn);
    this.velocity.set(0, 0, 0);
    this.height = PLAYER.height;
    this.viewOffsetY = 0;
  }

  _updateEye() {
    this.eyePosition.set(
      this.position.x,
      this.position.y + PLAYER.eyeOffset + this.viewOffsetY,
      this.position.z,
    );
  }

  dispose() {
    this.collision.dispose();
  }
}
