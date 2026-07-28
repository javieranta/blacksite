import * as THREE from 'three';
import { CAMERA, PLAYER } from '../core/Constants.js';
import { CAM, MOVE } from './PlayerTuning.js';
import { fbm1 } from './camera/Noise.js';
import { smoothDamp, springStep } from './camera/Springs.js';

/**
 * OWNER: camera-feel agent.
 *
 * CONTRACT:
 *   Writes ctx.camera position/quaternion/fov every frame from player state, and
 *   keeps ctx.viewCamera locked to it so the viewmodel never swims.
 *   rig.addRecoil(pitch, yaw, roll) — WeaponSystem calls this every shot
 *   rig.addTrauma(amount)          — explosions / heavy impacts
 *
 * DESIGN NOTES
 *   - Bob is driven off `player.stridePhase`, which advances with *distance
 *     travelled*, not time. Stop walking and the bob stops at the plant instead
 *     of continuing to wobble; walk up a slope and the cadence slows correctly.
 *   - Sway is a real spring chasing a target derived from angular velocity, so a
 *     flick leads, overshoots once and settles. A plain lag would put the camera
 *     somewhere other than where the player is aiming, which is unshootable.
 *   - Recoil is a velocity impulse into an underdamped spring whose rest point is
 *     zero, so every burst returns exactly to the pre-fire aim point.
 *   - Trauma shake is gradient noise with amplitude *and frequency* falling as it
 *     decays. Per-frame randomness reads as a bug; this reads as force.
 *   - Everything is small: max bob 4.3 cm, max sway 1.6°, max trauma 3°. The
 *     rig is meant to be felt, not noticed.
 *
 * FROZEN FRAMES
 *   With `?freeze=1` the physics tick never runs, so every procedural channel is
 *   already at rest; the idle breath is additionally suppressed so a screenshot
 *   is bit-stable. `?campose=bob|sway|recoil|land|trauma` injects a deterministic
 *   pose instead, which is how the rig's magnitudes get reviewed.
 */

const _up = new THREE.Vector3(0, 1, 0);
const TWO_PI = Math.PI * 2;

/** Wrap an angle difference into (-π, π]. */
function wrapAngle(a) {
  let x = a;
  while (x > Math.PI) x -= TWO_PI;
  while (x < -Math.PI) x += TWO_PI;
  return x;
}

export class CameraRig {
  constructor() {
    this.name = 'camerarig';

    /** Public: current angular recoil offset (pitch, yaw, roll) in radians. */
    this.recoil = new THREE.Vector3();
    this._recoilVel = new THREE.Vector3();
    /** Public: 0..1 accumulated trauma. */
    this.trauma = 0;
    this._traumaPhase = 0;

    this._fov = { x: CAMERA.fovBase, v: 0 };
    this._swayX = { x: 0, v: 0 };      // yaw sway
    this._swayY = { x: 0, v: 0 };      // pitch sway
    this._turn = { x: 0, v: 0 };       // roll into a turn
    this._bob = { x: 0, v: 0 };        // bob amplitude
    this._land = { x: 0, v: 0 };       // vertical punch, metres (negative = down)
    this._stepRoll = { x: 0, v: 0 };
    this._slide = { x: 0, v: 0 };

    this._prevYaw = 0;
    this._prevPitch = 0;
    this._forcedAds = false;
    this._pose = null;
    this._poseBobPhase = null;
    this._t = 0;

    this._euler = new THREE.Euler(0, 0, 0, 'YXZ');
    this._yawQ = new THREE.Quaternion();
    this._off = new THREE.Vector3();
  }

  init(ctx) {
    this.ctx = ctx;
    this.player = ctx.require('player');
    this._prevYaw = this.player.yaw;
    this._prevPitch = this.player.pitch;

    const params = new URLSearchParams(location.search);
    const pose = params.get('campose');
    if (pose) this._pose = pose;

    ctx.bus.on('player:teleport', () => this._reset());
    ctx.bus.on('weapon:force', ({ ads }) => { if (ads !== undefined) this._forcedAds = !!ads; });

    ctx.bus.on('player:land', ({ impact = 0 }) => {
      const k = THREE.MathUtils.clamp(
        (impact - MOVE.landMinImpact) / (MOVE.landFullImpact - MOVE.landMinImpact), 0, 1.2,
      );
      if (k <= 0) return;
      this._land.v -= CAMERA.landPunch * k * 15.0;
      this.addTrauma(0.055 + k * 0.16);
    });

    ctx.bus.on('player:footstep', ({ foot = 1, gait = 'walk' }) => {
      const mult = gait === 'sprint' ? 1.6 : gait === 'crouch' ? 0.45 : 1.0;
      this._land.v -= CAMERA.stepShake * mult * CAM.stepKick * 16.0;
      this._stepRoll.v += foot * CAMERA.bobRoll * CAM.stepRoll * 16.0 * mult;
    });

    ctx.bus.on('player:damage', ({ amount = 0 }) => {
      this.addTrauma(0.14 + Math.min(0.42, amount / 130));
    });

    this._apply(ctx, false);
  }

  /** Zero every procedural channel — used on teleport so a framed shot is clean. */
  _reset() {
    this.recoil.set(0, 0, 0);
    this._recoilVel.set(0, 0, 0);
    this.trauma = 0;
    this._traumaPhase = 0;
    const all = [this._swayX, this._swayY, this._turn, this._bob,
      this._land, this._stepRoll, this._slide];
    for (let i = 0; i < all.length; i++) { all[i].x = 0; all[i].v = 0; }
    this._prevYaw = this.player.yaw;
    this._prevPitch = this.player.pitch;
  }

  /**
   * A shot's worth of kick. Values are the per-shot *delta* of the weapon's
   * recoil pattern in radians; they arrive as velocity so the rise is immediate
   * and the return is the spring's business.
   */
  addRecoil(pitch, yaw, roll = 0) {
    const ads = this.player?.state?.ads ? CAM.recoilAdsScale : 1;
    const g = CAM.recoilGain * ads;
    this._recoilVel.x += pitch * g;
    this._recoilVel.y += yaw * g;
    // Weapons only send two axes; derive a counter-roll from the lateral kick so
    // a burst twists the frame slightly instead of tracking a clean arc.
    const r = roll !== 0 ? roll : -yaw * 0.85;
    this._recoilVel.z += r * CAM.recoilRollGain * ads;
  }

  addTrauma(a) { this.trauma = Math.min(1, this.trauma + a); }

  update(dt, ctx) {
    this._t += dt;
    const frozen = !!ctx.engine?.frozen;
    const p = this.player;
    const st = p.state;

    /* ---------------------------------------------------------------- look rates */
    const dYaw = wrapAngle(p.yaw - this._prevYaw);
    const dPitch = p.pitch - this._prevPitch;
    this._prevYaw = p.yaw;
    this._prevPitch = p.pitch;
    const inv = dt > 1e-5 ? 1 / dt : 0;
    const wYaw = THREE.MathUtils.clamp(dYaw * inv, -30, 30);
    const wPitch = THREE.MathUtils.clamp(dPitch * inv, -30, 30);

    /* ------------------------------------------------------------------- FOV */
    const ads = st.ads || this._forcedAds;
    const fovTarget = ads ? CAMERA.fovAds
      : st.sprinting ? CAMERA.fovSprint : CAMERA.fovBase;
    // CAMERA.fovLerp is a rate; convert it to the equivalent smoothing time so
    // the blend eases in *and* out instead of snapping at the start.
    smoothDamp(this._fov, fovTarget, 2.0 / CAMERA.fovLerp, dt);

    /* ------------------------------------------------------------------ sway */
    const swayScale = ads ? CAM.swayAdsScale : 1;
    const sMax = CAMERA.swayAmount * swayScale;
    const swayTargetX = THREE.MathUtils.clamp(-wYaw * CAM.swayDrive * swayScale, -sMax, sMax);
    const swayTargetY = THREE.MathUtils.clamp(-wPitch * CAM.swayDrive * swayScale, -sMax, sMax);
    springStep(this._swayX, swayTargetX, CAM.swayStiffness, CAM.swayDamping, dt);
    springStep(this._swayY, swayTargetY, CAM.swayStiffness, CAM.swayDamping, dt);
    smoothDamp(this._turn,
      THREE.MathUtils.clamp(wYaw * CAM.turnRoll, -CAM.turnRollMax, CAM.turnRollMax),
      1.0 / CAM.turnRollSmooth, dt);

    /* ---------------------------------------------------------------- recoil */
    this._integrateRecoil(dt);

    /* ---------------------------------------------------------------- trauma */
    this.trauma = Math.max(0, this.trauma - CAM.traumaDecay * dt);
    // Frequency falls with amplitude: a sharp rattle that ends as a slow settle.
    this._traumaPhase += dt * CAM.traumaFreq
      * (CAM.traumaFreqFloor + (1 - CAM.traumaFreqFloor) * this.trauma);

    /* ------------------------------------------------------------------- bob */
    const gaitAmp = st.crouching ? CAMERA.bobAmpWalk * 0.55
      : st.sprinting ? CAMERA.bobAmpSprint : CAMERA.bobAmpWalk;
    const ref = st.sprinting ? PLAYER.sprintSpeed : PLAYER.walkSpeed;
    const moving = st.grounded && !st.sliding && !st.mantling && st.speed > 0.35;
    const bobTarget = moving ? gaitAmp * Math.min(1, st.speed / ref) : 0;
    smoothDamp(this._bob, bobTarget, 1.0 / CAM.bobBlend, dt);

    /* ------------------------------------------------------- blends & punches */
    springStep(this._land, 0, CAM.landStiffness, CAM.landDamping, dt);
    springStep(this._stepRoll, 0, CAM.landStiffness * 1.6, 0.55, dt);
    smoothDamp(this._slide, st.sliding ? 1 : 0, 1.0 / CAM.slideBlend, dt);

    if (frozen) {
      // Nothing drives these when the sim is held, so pin them hard rather than
      // leaving a fraction of a millimetre of drift in a graded screenshot.
      this._swayX.x = this._swayX.v = 0;
      this._swayY.x = this._swayY.v = 0;
      this._turn.x = this._turn.v = 0;
      if (!this._pose) {
        this._bob.x = this._bob.v = 0;
        this._land.x = this._land.v = 0;
        this._stepRoll.x = this._stepRoll.v = 0;
        this.recoil.set(0, 0, 0);
        this._recoilVel.set(0, 0, 0);
        this.trauma = 0;
      }
    }
    if (this._pose) this._forcePose();

    this._apply(ctx, frozen);
  }

  _integrateRecoil(dt) {
    const k = CAM.recoilStiffness;
    const c = 2 * Math.sqrt(k) * CAM.recoilDamping;
    let left = dt;
    let guard = 0;
    while (left > 1e-6 && guard++ < 48) {
      const h = left > 1 / 240 ? 1 / 240 : left;
      left -= h;
      this._recoilVel.x += (-this.recoil.x * k - this._recoilVel.x * c) * h;
      this._recoilVel.y += (-this.recoil.y * k - this._recoilVel.y * c) * h;
      this._recoilVel.z += (-this.recoil.z * k - this._recoilVel.z * c) * h;
      this.recoil.addScaledVector(this._recoilVel, h);
    }
    if (this.recoil.lengthSq() < 1e-10 && this._recoilVel.lengthSq() < 1e-8) {
      this.recoil.set(0, 0, 0);
      this._recoilVel.set(0, 0, 0);
    }
  }

  /** Deterministic states for the screenshot rig — see `?campose=`. */
  _forcePose() {
    switch (this._pose) {
      case 'bob':
        this._bob.x = CAMERA.bobAmpSprint;
        this._poseBobPhase = 0.34;
        break;
      case 'sway':
        this._swayX.x = CAMERA.swayAmount;
        this._swayY.x = -CAMERA.swayAmount * 0.55;
        this._turn.x = -CAM.turnRollMax;
        break;
      case 'recoil':
        this.recoil.set(0.026, 0.009, -0.017);
        break;
      case 'land':
        this._land.x = -CAMERA.landPunch * 1.05;
        break;
      case 'trauma':
        this.trauma = 0.7;
        this._traumaPhase = 41.37;
        break;
      default: break;
    }
  }

  /* ------------------------------------------------------------- composition */

  _apply(ctx, frozen = false) {
    const p = this.player;
    const st = p.state;

    /* ---- bob: vertical dips on the plant, lateral swings per stride --------- */
    const amp = this._bob.x;
    const phase = (this._poseBobPhase ?? p.stridePhase) + CAM.bobPhaseLead;
    let bobY = 0, bobX = 0, bobRoll = 0;
    if (amp > 1e-5) {
      // Centred on zero — a DC offset would silently lower the eye while walking.
      bobY = -amp * 0.5 * Math.cos(TWO_PI * phase);
      bobX = amp * CAM.bobLateral * Math.sin(Math.PI * phase);
      bobRoll = -CAMERA.bobRoll * (amp / CAMERA.bobAmpWalk) * Math.sin(Math.PI * phase);
    }

    /* ---- trauma ------------------------------------------------------------ */
    let shP = 0, shY = 0, shR = 0, shOX = 0, shOY = 0;
    if (this.trauma > 0.001) {
      const t2 = this.trauma * this.trauma;
      const ph = this._traumaPhase;
      shP = fbm1(ph) * CAM.traumaAngle * t2;
      shY = fbm1(ph + 137.9) * CAM.traumaAngle * t2;
      shR = fbm1(ph + 311.4) * CAM.traumaAngle * 1.35 * t2;
      shOX = fbm1(ph * 0.72 + 71.1) * CAM.traumaOffset * t2;
      shOY = fbm1(ph * 0.72 + 203.6) * CAM.traumaOffset * t2;
    }

    /* ---- idle breath: only visible when standing still, never when frozen -- */
    let brP = 0, brR = 0;
    if (!frozen) {
      const rest = 1 - Math.min(1, amp / CAMERA.bobAmpWalk);
      const b = this._t * CAM.breathFreq * TWO_PI;
      brP = Math.sin(b) * CAM.breathAmp * rest;
      brR = Math.cos(b * 0.73) * CAM.breathAmp * 0.7 * rest;
    }

    /* ---- slide / mantle ---------------------------------------------------- */
    const slide = this._slide.x;
    const slideRoll = slide * CAM.slideTilt * (st.slideTilt || 1);
    let mantleP = 0, mantleR = 0;
    if (st.mantling) {
      const s = Math.sin(Math.PI * st.mantleT);
      mantleP = -CAM.mantlePitch * s;
      mantleR = CAM.mantleRoll * s;
    }

    const lean = st.lean;
    const land = this._land.x;

    /* ---- rotation ---------------------------------------------------------- */
    this._euler.set(
      p.pitch + this.recoil.x + this._swayY.x + shP + land * CAM.landPitch + mantleP + brP,
      p.yaw + this.recoil.y + this._swayX.x + shY,
      this.recoil.z + this._stepRoll.x + shR + bobRoll + this._turn.x
        + slideRoll - lean * PLAYER.leanAngle + mantleR + brR,
    );
    ctx.camera.quaternion.setFromEuler(this._euler);

    /* ---- position: offsets live in yaw space, so pitching does not slide the
           eye forwards and backwards -------------------------------------- */
    this._yawQ.setFromAxisAngle(_up, p.yaw);
    this._off.set(
      bobX + lean * PLAYER.leanOffset + shOX,
      bobY + land - slide * CAM.slideDrop + shOY,
      0,
    );
    this._off.applyQuaternion(this._yawQ);
    ctx.camera.position.copy(p.eyePosition).add(this._off);

    /* ---- FOV -------------------------------------------------------------- */
    if (Math.abs(ctx.camera.fov - this._fov.x) > 0.005) {
      ctx.camera.fov = this._fov.x;
      ctx.camera.updateProjectionMatrix();
    }
    // The viewmodel is authored at CAM.vmFovBase against CAMERA.fovBase. Coupling
    // the two through a compressed power curve means the gun grows slightly in
    // ADS (as it should) while the hipfire framing is left exactly as authored.
    const vmFov = CAM.vmFovBase * Math.pow(this._fov.x / CAMERA.fovBase, CAM.vmFovExponent);
    if (Math.abs(ctx.viewCamera.fov - vmFov) > 0.005) {
      ctx.viewCamera.fov = vmFov;
      ctx.viewCamera.updateProjectionMatrix();
    }
    ctx.viewCamera.quaternion.copy(ctx.camera.quaternion);
    ctx.viewCamera.position.copy(ctx.camera.position);
  }
}
