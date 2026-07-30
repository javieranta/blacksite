import * as THREE from 'three';
import { PLAYER } from '../core/Constants.js';
import { WEAPONS, WEAPON_ORDER, buildRecoilPattern } from './WeaponData.js';
import { Grenades } from './Grenades.js';

/**
 * OWNER: weapons agent.
 * CONTRACT:
 *   weapons.current   : weapon def (from WeaponData)
 *   weapons.ammo      : { mag, reserve }
 *   weapons.state     : { firing, reloading, ads, adsProgress 0..1, shotIndex,
 *                         mode, spread, switching, burstLeft, slot, empty }
 *   emits: 'weapon:fire'   { origin, dir, weapon, seed, mode, spread, ads }
 *          'weapon:reload' { weapon, phase:'start'|'end'|'cancel', empty, duration }
 *          'weapon:switch' { from, to, slot }
 *          'weapon:mode'   { weapon, mode }
 *          'weapon:dryfire'{ weapon }
 *          'shell:eject'   { point, velocity, spin, calibre, weapon }
 *   listens: 'weapon:force' { ads, firing }   — the screenshot rig's ?ads / ?fire
 *   weapons.grenades  : the player's hand-grenade system (src/weapons/Grenades.js)
 *
 * GRENADES are owned here rather than registered in main.js: the registration
 * list belongs to another agent and is frozen, so this system forwards
 * init/update/fixedUpdate to them. Everything else reaches them through
 * `ctx.get('weapons').grenades` or the 'grenade:*' events on the bus.
 *
 * FIRE CONTROL is a time accumulator, never a per-frame boolean: `_fireTimer`
 * counts down by dt and a shot *adds* the RPM interval back, so 720 rpm is 720
 * rpm at 30 fps, at 60 fps and at 144 fps, and a frame that runs long fires the
 * two rounds it owed instead of swallowing one.
 *
 * ACCURACY is a small state machine rather than one constant:
 *   base      hip <-> ADS cone, blended on adsProgress
 *   movement  scales with planar speed, damped while aiming
 *   air       hard multiplier while off the ground
 *   crouch    discount while crouched
 *   bloom     grows per round fired, bleeds off at a per-weapon rate
 *   settled   a stationary shooter with no bloom gets first-shot accuracy —
 *             the round goes exactly where the sight is
 *
 * RECOIL comes from the deterministic learnable pattern in WeaponData: shot n
 * applies the *delta* from shot n-1, so the muzzle walks the pattern, and the
 * camera rig's own decay returns the view to the original aim point.
 */
export class WeaponSystem {
  constructor() {
    this.name = 'weapons';

    /** One record per loadout slot, each with its own ammo, mode and pattern. */
    this.slots = WEAPON_ORDER.map((id) => {
      const weapon = WEAPONS[id];
      return {
        id,
        weapon,
        pattern: buildRecoilPattern(weapon),
        ammo: { mag: weapon.magSize, reserve: weapon.reserve },
        modeIndex: 0,
      };
    });

    this._slot = 0;
    const s = this.slots[0];
    this.current = s.weapon;
    this.pattern = s.pattern;
    this.ammo = s.ammo;

    this.state = {
      firing: false, reloading: false, ads: false, adsProgress: 0, shotIndex: 0,
      mode: s.weapon.fireModes[0], spread: s.weapon.spreadHip,
      switching: false, switchProgress: 1, burstLeft: 0,
      slot: 0, empty: false, reloadProgress: 0,
    };

    this._fireTimer = 0;
    this._sinceFire = 99;
    this._bloom = 0;
    this._pending = 0;
    this._burstCooldown = 0;
    this._reloadT = 0;
    this._reloadDur = 0;
    this._reloadEmpty = false;
    this._switchT = 0;
    this._switchStage = 'idle';
    this._switchTarget = 0;
    this._forced = { ads: false, firing: false };
    this._forcedShots = 0;

    /** Hand grenades. Ticked from this system's own update/fixedUpdate. */
    this.grenades = new Grenades();

    // scratch — _fire allocates only the two event payload vectors
    this._origin = new THREE.Vector3();
    this._dir = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._up = new THREE.Vector3();
    this._fwd = new THREE.Vector3();
    this._shellPoint = new THREE.Vector3();
    this._shellVel = new THREE.Vector3();
    this._shellSpin = new THREE.Vector3();
    this._seed = 0x2f6e2b1;
  }

  init(ctx) {
    this.ctx = ctx;
    this.input = ctx.require('input');
    this.player = ctx.require('player');
    this.rig = ctx.require('camerarig');

    // Additive bindings on the shared action map. Input owns the map; adding
    // names to it at runtime is the sanctioned way to claim keys without
    // touching another agent's file.
    const b = this.input.binds;
    if (!b.fireMode) b.fireMode = ['KeyB'];
    if (!b.weapon1) b.weapon1 = ['Digit1'];
    if (!b.weapon2) b.weapon2 = ['Digit2'];
    if (!b.weapon3) b.weapon3 = ['Digit3'];

    ctx.bus.on('weapon:force', ({ ads, firing }) => {
      if (ads !== undefined) this._forced.ads = !!ads;
      if (firing !== undefined) this._forced.firing = !!firing;
      this._forcedShots = 0;
    });

    this.grenades.init(ctx);
  }

  /** Gameplay tick. Grenade flight is physics, so it belongs at 120Hz. */
  fixedUpdate(h, ctx) {
    this.grenades.fixedUpdate(h, ctx);
  }

  dispose() {
    this.grenades.dispose();
  }

  // ------------------------------------------------------------------ query ---

  get modeLabel() { return this.state.mode.toUpperCase(); }
  get spreadRadians() { return this.state.spread; }
  get reloadProgress() { return this._reloadDur > 0 ? Math.min(1, this._reloadT / this._reloadDur) : 0; }

  // ----------------------------------------------------------------- update ---

  update(dt, ctx) {
    const inp = this.input;
    const w = this.current;
    const forcedFire = this._forced.firing;

    this._sinceFire += dt;
    if (this._burstCooldown > 0) this._burstCooldown -= dt;

    this._updateSwitch(dt, ctx);
    this._updateReload(dt, ctx);
    this._updateAds(dt, w);

    const trigger = forcedFire || (inp.mouse.left && inp.locked);
    const triggerEdge = forcedFire || (inp.mouse.leftPressed && inp.locked);

    // ---- discrete inputs ---------------------------------------------------
    if (inp.actionPressed('fireMode')) this._cycleMode(ctx);
    if (inp.actionPressed('weapon1')) this._requestSwitch(0);
    else if (inp.actionPressed('weapon2')) this._requestSwitch(1);
    else if (inp.actionPressed('weapon3')) this._requestSwitch(2);
    else if (inp.mouse.wheel) this._requestSwitch(this._slot + (inp.mouse.wheel > 0 ? 1 : -1));

    if (inp.actionPressed('reload')) this._startReload(ctx);

    // Firing interrupts a reload — but only once there are rounds in the gun,
    // which is what makes a cancelled reload feel fair rather than punishing.
    if (this.state.reloading && triggerEdge && this.ammo.mag > 0) this._cancelReload(ctx);

    this._updateSpread(dt, w);

    // ---- intent ------------------------------------------------------------
    const mode = forcedFire ? 'auto' : this.state.mode;
    if (mode === 'auto') {
      this._pending = trigger ? 1 : 0;
    } else if (mode === 'semi') {
      if (triggerEdge) this._pending = 1;
      else if (!trigger) this._pending = 0;
    } else if (mode === 'burst') {
      if (triggerEdge && this._burstCooldown <= 0 && this.state.burstLeft === 0) {
        this.state.burstLeft = w.burstCount ?? 3;
      }
    }

    // Dry fire / auto-reload on an empty magazine.
    if (trigger && this.ammo.mag <= 0 && !forcedFire) {
      this._pending = 0;
      this.state.burstLeft = 0;
      if (triggerEdge) ctx.bus.emit('weapon:dryfire', { weapon: w });
      this._startReload(ctx);
    }

    // ---- the accumulator ---------------------------------------------------
    const interval = 60 / Math.max(30, w.rpm);
    this._fireTimer -= dt;
    // Owe at most three rounds after a long frame. Without a cap a 500 ms hitch
    // would dump half a magazine on the next tick; with too tight a cap the
    // effective rate collapses below the RPM whenever the frame time exceeds the
    // shot interval, which is exactly what frame-rate independence must prevent.
    if (this._fireTimer < -interval * 3) this._fireTimer = -interval * 3;

    let guard = 0;
    while (this._fireTimer <= 0 && guard++ < 4) {
      if (!this._consumeShot(ctx, mode, w, forcedFire)) {
        if (this._fireTimer < 0) this._fireTimer = 0;
        break;
      }
      this._fireTimer += interval;
    }

    this.state.firing = forcedFire || this._sinceFire < 0.085;
    this.state.empty = this.ammo.mag <= 0;
    this.state.slot = this._slot;
    this.state.reloadProgress = this.reloadProgress;

    // The pattern only resets once the trigger has been off long enough for the
    // muzzle to settle — that is what makes the pattern learnable.
    if (this._sinceFire > 0.35 && this.state.shotIndex > 0) this.state.shotIndex = 0;

    // Grenades poll the same edge-cleared input map, so they have to be ticked
    // inside the update phase, before `input:flush` wipes the frame's edges.
    this.grenades.update(dt, ctx);
  }

  /** @returns {boolean} true if a round left the barrel */
  _consumeShot(ctx, mode, w, forcedFire) {
    if (this.state.switching) return false;
    if (this.state.reloading) return false;
    if (!forcedFire && this.ammo.mag <= 0) return false;

    if (this.state.burstLeft > 0) {
      this.state.burstLeft--;
      if (this.state.burstLeft === 0) this._burstCooldown = w.burstDelay ?? 0.18;
    } else if (this._pending > 0) {
      if (mode === 'semi') this._pending = 0;
    } else {
      return false;
    }

    this._fire(ctx, w, forcedFire);
    return true;
  }

  // ------------------------------------------------------------------- fire ---

  _fire(ctx, w, forcedFire) {
    const cam = ctx.camera;
    const idx = this.state.shotIndex;

    this._sinceFire = 0;
    if (!forcedFire) this.ammo.mag--;

    // Camera basis. Firing from the eye rather than the model's muzzle is the
    // standard FPS convention: it is what the reticle promises.
    this._origin.copy(cam.position);
    this._fwd.set(0, 0, -1).applyQuaternion(cam.quaternion);
    this._right.set(1, 0, 0).applyQuaternion(cam.quaternion);
    this._up.set(0, 1, 0).applyQuaternion(cam.quaternion);

    this._dir.copy(this._fwd);
    const spread = this.state.spread;
    if (spread > 1e-6) {
      // sqrt(u) gives a uniform disc rather than a centre-heavy one
      const a = Math.sqrt(this._rand()) * spread;
      const th = this._rand() * Math.PI * 2;
      this._dir.addScaledVector(this._right, Math.cos(th) * a)
        .addScaledVector(this._up, Math.sin(th) * a)
        .normalize();
    }

    // ---- recoil ------------------------------------------------------------
    const pat = this.pattern;
    const pi = Math.min(idx, pat.length - 1);
    const cur = pat[pi];
    const prev = pi > 0 ? pat[pi - 1] : null;
    const dp = (cur[0] - (prev ? prev[0] : 0)) * (w.recoilVisual ?? 1);
    const dy = (cur[1] - (prev ? prev[1] : 0)) * (w.recoilVisual ?? 1);
    // Forced firing is a screenshot pose: applying recoil there would let the
    // aim point drift during the rig's settle window and break the framing.
    if (!forcedFire) this.rig.addRecoil(dp, dy, dy * (w.recoilRoll ?? 0.3));
    else this._forcedShots++;

    this.state.shotIndex = idx + 1;
    this._bloom = Math.min(w.bloomMax ?? 0.03, this._bloom + (w.bloomPerShot ?? 0.006));

    ctx.bus.emit('weapon:fire', {
      origin: this._origin.clone(),
      dir: this._dir.clone(),
      weapon: w,
      seed: this.state.shotIndex,
      mode: this.state.mode,
      spread,
      ads: this.state.adsProgress,
      shooter: 'player',
    });

    this._ejectShell(ctx, w);
  }

  /**
   * A casing leaves the port at a few metres per second, up and to the right,
   * and inherits the shooter's own velocity — otherwise brass hangs in the air
   * behind a sprinting player.
   */
  _ejectShell(ctx, w) {
    const ev = w.ejectVelocity ?? [2.6, 1.9, -0.5];
    const j = () => 0.82 + this._rand() * 0.36;
    this._shellPoint.copy(this._origin)
      .addScaledVector(this._right, 0.155)
      .addScaledVector(this._up, -0.065)
      .addScaledVector(this._fwd, 0.30);
    this._shellVel.set(0, 0, 0)
      .addScaledVector(this._right, ev[0] * j())
      .addScaledVector(this._up, ev[1] * j())
      .addScaledVector(this._fwd, ev[2] * j())
      .add(this.player.velocity);
    this._shellSpin.set(
      16 + this._rand() * 12,
      (this._rand() - 0.5) * 14,
      9 + this._rand() * 8,
    );
    ctx.bus.emit('shell:eject', {
      point: this._shellPoint.clone(),
      velocity: this._shellVel.clone(),
      spin: this._shellSpin.clone(),
      calibre: w.shellCalibre ?? w.calibre,
      weapon: w,
    });
  }

  // ----------------------------------------------------------------- spread ---

  _updateSpread(dt, w) {
    this._bloom = Math.max(0, this._bloom - (w.bloomDecay ?? 0.03) * dt);

    const p = this.player;
    const ads = this.state.adsProgress;
    const speed = Math.hypot(p.velocity.x, p.velocity.z);
    const moveT = Math.min(1, speed / Math.max(0.5, PLAYER.walkSpeed));

    const base = THREE.MathUtils.lerp(w.spreadHip, w.spreadAds, ads);
    let mul = 1 + moveT * ((w.spreadMoveScale ?? 2) - 1) * (1 - 0.45 * ads);
    if (!p.state.grounded) mul *= w.airPenalty ?? 2.5;
    else if (p.state.crouching) mul *= w.crouchBonus ?? 0.65;

    let s = base * mul + this._bloom;
    const settled = this._bloom <= 1e-5 && this._sinceFire > 0.28 && moveT < 0.12 && p.state.grounded;
    if (settled) {
      // First-shot accuracy is an aiming reward, so it is worth far more down
      // the sights than from the hip — a settled hipfire round still goes
      // roughly where the gun is pointed, not exactly where the reticle is.
      const fs = THREE.MathUtils.lerp(0.78, w.firstShotScale ?? 0.25, ads);
      s = Math.min(s, base * mul * fs + 1.5e-4);
    }
    this.state.spread = s;
  }

  _updateAds(dt, w) {
    const blocked = this.state.reloading || this.state.switching;
    const want = (this._forced.ads || (this.input.mouse.right && this.input.locked)) && !blocked;
    this.state.ads = want;
    this.player.state.ads = want;
    if (this._forced.ads) { this.state.adsProgress = 1; return; }
    const rate = dt / Math.max(0.02, w.adsTime);
    this.state.adsProgress = THREE.MathUtils.clamp(
      this.state.adsProgress + (want ? rate : -rate * 1.25), 0, 1,
    );
  }

  // ----------------------------------------------------------------- reload ---

  _startReload(ctx) {
    const w = this.current;
    if (this.state.reloading || this.state.switching) return;
    if (this.ammo.mag >= w.magSize || this.ammo.reserve <= 0) return;
    this._reloadEmpty = this.ammo.mag === 0;
    this._reloadDur = this._reloadEmpty ? w.reloadEmptyTime : w.reloadTime;
    this._reloadT = 0;
    this.state.reloading = true;
    this.state.burstLeft = 0;
    this._pending = 0;
    ctx.bus.emit('weapon:reload', {
      weapon: w, phase: 'start', empty: this._reloadEmpty, duration: this._reloadDur,
    });
  }

  _updateReload(dt, ctx) {
    if (!this.state.reloading) return;
    this._reloadT += dt;
    if (this._reloadT < this._reloadDur) return;
    const w = this.current;
    const take = Math.min(w.magSize - this.ammo.mag, this.ammo.reserve);
    this.ammo.mag += take;
    this.ammo.reserve -= take;
    this.state.reloading = false;
    ctx.bus.emit('weapon:reload', {
      weapon: w, phase: 'end', empty: this._reloadEmpty, duration: this._reloadDur,
    });
  }

  _cancelReload(ctx) {
    if (!this.state.reloading) return;
    this.state.reloading = false;
    ctx.bus.emit('weapon:reload', {
      weapon: this.current, phase: 'cancel', empty: this._reloadEmpty, duration: this._reloadDur,
    });
  }

  // ------------------------------------------------------------ mode/switch ---

  _cycleMode(ctx) {
    const slot = this.slots[this._slot];
    const modes = slot.weapon.fireModes;
    if (!modes || modes.length < 2) return;
    slot.modeIndex = (slot.modeIndex + 1) % modes.length;
    this.state.mode = modes[slot.modeIndex];
    this.state.burstLeft = 0;
    this._pending = 0;
    ctx.bus.emit('weapon:mode', { weapon: slot.weapon, mode: this.state.mode });
  }

  _requestSwitch(index) {
    const n = this.slots.length;
    const i = ((index % n) + n) % n;
    if (i === this._slot || this.state.switching) return;
    if (this.state.reloading) this._cancelReload(this.ctx);
    this._switchTarget = i;
    this._switchStage = 'holster';
    this._switchT = 0;
    this.state.switching = true;
    this.state.switchProgress = 0;
    this.state.burstLeft = 0;
    this._pending = 0;
  }

  _updateSwitch(dt, ctx) {
    if (!this.state.switching) return;
    this._switchT += dt;
    if (this._switchStage === 'holster') {
      const dur = Math.max(0.02, this.current.holsterTime ?? 0.25);
      this.state.switchProgress = Math.min(1, this._switchT / dur) * 0.5;
      if (this._switchT < dur) return;
      const from = this.current;
      this._applySlot(this._switchTarget);
      this._switchT = 0;
      this._switchStage = 'draw';
      ctx.bus.emit('weapon:switch', { from, to: this.current, slot: this._slot });
      return;
    }
    const dur = Math.max(0.02, this.current.drawTime ?? 0.4);
    this.state.switchProgress = 0.5 + Math.min(1, this._switchT / dur) * 0.5;
    if (this._switchT < dur) return;
    this.state.switching = false;
    this._switchStage = 'idle';
    this.state.switchProgress = 1;
  }

  _applySlot(i) {
    const slot = this.slots[i];
    this._slot = i;
    this.current = slot.weapon;
    this.pattern = slot.pattern;
    this.ammo = slot.ammo;
    this.state.mode = slot.weapon.fireModes[slot.modeIndex] ?? slot.weapon.fireModes[0];
    this.state.shotIndex = 0;
    this.state.burstLeft = 0;
    this.state.spread = slot.weapon.spreadHip;
    this._bloom = 0;
    this._fireTimer = 0;
    this._sinceFire = 99;
  }

  /** mulberry32 — a burst fired from the same state sprays identically. */
  _rand() {
    let t = (this._seed = (this._seed + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
}
