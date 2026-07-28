import * as THREE from 'three';
import { whiteNoiseBuffer, softClipCurve } from './Synth.js';
import { buildImpulse, ZONES } from './Impulse.js';
import {
  cueForWeapon, fireShot, emptyClick, reloadStart, reloadEnd, adsMove, weaponSwitch,
} from './Guns.js';
import {
  impact, fleshHit, footstep, shellDrop, whizby, explosion, hitmarker, bodyFall, ricochet,
} from './WorldSfx.js';
import { bark, isBark } from './Voice.js';

/**
 * OWNER: audio agent.
 * CONTRACT:
 *   audio.play(name, { position, volume, pitch })
 *   Cue names other systems call:
 *     'fire_ar', 'fire_smg', 'fire_dmr', 'reload_start', 'reload_end',
 *     'impact_<surface>', 'shell_drop', 'footstep_<surface>', 'hitmarker',
 *     'explosion', 'whizby', 'ads_in', 'ads_out', 'empty_click'
 *   listens: 'weapon:fire', 'weapon:reload', 'hit:surface', 'hit:actor',
 *            'actor:death', 'player:footstep', 'shell:eject', 'explosion',
 *            'audio:zone', 'settings:volume', 'input:lock'
 *
 * 100% synthesis — no samples anywhere in the project.
 *
 * SIGNAL FLOW
 *   cue -> [out gain: distance attenuation]
 *            |-> air low-pass -> HRTF panner -> sfx bus ---.
 *            |-> send gain ------------------> reverb in --|
 *   reverb in -> convolver(exterior) -> return A ----------|
 *             \> convolver(interior) -> return B ----------|
 *   distant bus -> convolver(rolling) -> return C ---------|
 *   ui cues ----------------------------------------------> mix
 *   sfx bus (duckable) -----------------------------------> mix
 *   mix -> limiter (compressor, hard ratio) -> soft clipper -> master -> out
 *
 * The AudioContext is not created until a real user gesture, so the headless
 * screenshot rig — which never produces one — leaves this system inert and
 * silent instead of throwing.
 */
/** Up, then four horizontals. Shared, immutable, never reallocated. */
const PROBE_DIRS = [
  new THREE.Vector3(0, 1, 0),
  new THREE.Vector3(1, 0, 0),
  new THREE.Vector3(-1, 0, 0),
  new THREE.Vector3(0, 0, 1),
  new THREE.Vector3(0, 0, -1),
];

export class AudioEngine {
  constructor() {
    this.name = 'audio';
    this.ready = false;
    this.ac = null;
    this.zone = 'exterior';
    this.volume = { master: 0.85, sfx: 1.0 };

    this.maxVoices = 30;
    this._voiceEnds = new Float64Array(96);
    this._voiceCursor = 0;

    /**
     * Retrigger coalescing. Several systems legitimately voice the same event —
     * Impacts plays 'impact_<surface>' from its own decal path while this engine
     * also hears 'hit:surface' on the bus, and the AI plays 'hitmarker' at the
     * same moment Ballistics does. Playing both is a flam, not a louder hit. Any
     * identical cue at effectively the same place within one screen refresh is
     * therefore folded into the first. Preallocated: no allocation per cue.
     */
    this._dedupeWindow = 0.03;
    this._recent = [];
    for (let i = 0; i < 24; i++) this._recent.push({ name: '', t: -1, has: false, x: 0, y: 0, z: 0 });
    this._recentCursor = 0;

    this._lastShot = 0;
    this._lastEmpty = 0;
    this._wasAds = false;
    this._zoneTimer = 0;
    this._zoneInterval = 0.45;
    this._zoneCost = 0;
    this._lastZonePos = new THREE.Vector3(1e6, 0, 0);

    // Preallocated scratch — update() must not allocate.
    this._v = new THREE.Vector3();
    this._fwd = new THREE.Vector3();
    this._up = new THREE.Vector3();
    this._ray = new THREE.Raycaster();
    this._ray.far = 9;
    this._rayHits = [];
    this._listenerPos = new THREE.Vector3();

    // The shot context handed to the synth modules. Reused, because a cue is
    // fully built synchronously inside one play() call and never escapes it.
    this._sc = {
      ac: null, noise: null, t0: 0, out: null, far: null,
      dist: 0, rapid: false, tailScale: 1, pitch: 1, weapon: null, empty: false,
    };
  }

  init(ctx) {
    this.ctx = ctx;
    const bus = ctx.bus;

    // Browsers block an AudioContext until a gesture. Pointer lock is the one the
    // rest of the build already emits; a bare pointerdown/keydown covers menus.
    bus.on('input:lock', ({ locked }) => { if (locked) this._arm(); });
    this._gesture = () => this._arm();
    addEventListener('pointerdown', this._gesture, { passive: true });
    addEventListener('keydown', this._gesture, { passive: true });

    bus.on('weapon:fire', (e) => {
      this.play(cueForWeapon(e?.weapon), { position: e?.origin, weapon: e?.weapon });
    });
    bus.on('weapon:reload', (e) => {
      this.play(e?.phase === 'end' ? 'reload_end' : 'reload_start', { weapon: e?.weapon, empty: e?.empty });
    });
    bus.on('hit:surface', (e) => {
      this.play(`impact_${e?.surface ?? 'concrete'}`, { position: e?.point });
    });
    bus.on('hit:actor', (e) => {
      this.play('impact_flesh', { position: e?.point, headshot: !!e?.headshot });
      this.play('hitmarker', { kind: e?.headshot ? 'head' : 'hit' });
    });
    bus.on('actor:death', (e) => {
      this.play('hitmarker', { kind: 'kill' });
      this.play('body_fall', { position: e?.point });
    });
    bus.on('player:footstep', (e) => {
      // `speed` is the gait scalar the player controller publishes; a sprint
      // footfall should be heavier and slightly brighter than a walk.
      const s = e?.speed ?? 1;
      this.play(`footstep_${e?.surface ?? 'concrete'}`, {
        position: e?.position, volume: Math.min(1.3, 0.55 + s * 0.4),
        weight: Math.min(1.4, 0.6 + s * 0.45), pitch: 0.96 + Math.min(0.5, s * 0.1),
      });
    });
    bus.on('player:land', (e) => {
      const hard = Math.min(1.6, 0.6 + (e?.impact ?? 4) * 0.09);
      this.play(`footstep_${e?.surface ?? 'concrete'}`, {
        position: e?.position, volume: hard, weight: hard * 1.25, pitch: 0.88,
      });
    });
    bus.on('player:jump', (e) => {
      this.play(`footstep_${e?.surface ?? 'concrete'}`, {
        position: e?.position, volume: 0.5, weight: 0.55, pitch: 1.1,
      });
    });
    bus.on('weapon:dryfire', () => this.play('empty_click'));
    bus.on('weapon:switch', () => this.play('weapon_switch'));
    bus.on('hit:ricochet', (e) => this.play('ricochet', { position: e?.point }));
    bus.on('shell:eject', (e) => {
      // Brass has to fall before it lands. Delay is what sells the ejection.
      this.play('shell_drop', { position: e?.point, calibre: e?.calibre, delay: 0.34 });
    });
    bus.on('explosion', (e) => {
      this.play('explosion', { position: e?.point, radius: e?.radius ?? 6 });
    });
    // Ballistics emits this for rounds passing close to the player.
    bus.on('whizby', (e) => {
      if (e?.player === false) return;   // only rounds passing OUR head
      this.play('whizby', { position: e?.point, volume: 0.75 });
    });
    bus.on('audio:zone', (e) => this.setZone(e?.zone));
    bus.on('settings:volume', (e) => {
      if (typeof e?.master === 'number') this.volume.master = THREE.MathUtils.clamp(e.master, 0, 1);
      if (typeof e?.sfx === 'number') this.volume.sfx = THREE.MathUtils.clamp(e.sfx, 0, 1.5);
      if (this.master) this.master.gain.setTargetAtTime(this.volume.master, this.ac.currentTime, 0.03);
      if (this.sfx) this.sfx.gain.setTargetAtTime(this.volume.sfx, this.ac.currentTime, 0.03);
    });
  }

  // --------------------------------------------------------------------------
  // Graph construction (first gesture only)
  // --------------------------------------------------------------------------
  _arm() {
    if (this.ready) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try {
      this.ac = new AC({ latencyHint: 'interactive' });
    } catch {
      return;
    }
    const ac = this.ac;

    this.master = ac.createGain();
    this.master.gain.value = this.volume.master;

    // Brick-wall-ish limiter: a full-auto burst overlapping an explosion has ~20
    // voices going, and the sum will exceed 0 dBFS without this.
    this.limiter = ac.createDynamicsCompressor();
    this.limiter.threshold.value = -7.5;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.0025;
    this.limiter.release.value = 0.14;

    // Safety clipper after the limiter turns any residual overshoot into
    // harmonic dirt rather than a digital crack.
    this.clipper = ac.createWaveShaper();
    this.clipper.curve = softClipCurve(2048, 1.5);
    this.clipper.oversample = '2x';

    this.mix = ac.createGain();
    this.mix.gain.value = 1;

    this.mix.connect(this.limiter);
    this.limiter.connect(this.clipper);
    this.clipper.connect(this.master);
    this.master.connect(ac.destination);

    // Duckable spatial bus + non-duckable UI bus.
    this.sfx = ac.createGain();
    this.sfx.gain.value = this.volume.sfx;
    this.sfx.connect(this.mix);

    this.ui = ac.createGain();
    this.ui.gain.value = 0.9;
    this.ui.connect(this.mix);

    // Reverb: two room convolvers crossfaded by zone, plus a dedicated long
    // "rolling thunder" convolver that only distant reports feed.
    this.reverbIn = ac.createGain();
    this.reverbIn.gain.value = 1;
    this.farIn = ac.createGain();
    this.farIn.gain.value = 1;

    this.noise = whiteNoiseBuffer(ac, 3);

    this._zoneNodes = {};
    for (const key of ['exterior', 'interior']) {
      const conv = ac.createConvolver();
      conv.normalize = false;
      conv.buffer = buildImpulse(ac, ZONES[key], key === 'interior' ? 0x1f123bb5 : 0x2545f491);
      const ret = ac.createGain();
      ret.gain.value = key === this.zone ? ZONES[key].wet : 0.0001;
      // A touch of high-pass on the return keeps the tail out of the sub band
      // where the gunshot's own sweep lives.
      const hp = ac.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 130;
      this.reverbIn.connect(conv);
      conv.connect(hp);
      hp.connect(ret);
      ret.connect(this.mix);
      this._zoneNodes[key] = { conv, ret };
    }
    {
      const conv = ac.createConvolver();
      conv.normalize = false;
      conv.buffer = buildImpulse(ac, ZONES.distant, 0x68e31da4);
      const ret = ac.createGain();
      ret.gain.value = ZONES.distant.wet;
      this.farIn.connect(conv);
      conv.connect(ret);
      ret.connect(this.mix);
      this._zoneNodes.distant = { conv, ret };
    }

    if (ac.state === 'suspended') ac.resume().catch(() => {});
    this.ready = true;
    removeEventListener('pointerdown', this._gesture);
    removeEventListener('keydown', this._gesture);
  }

  // --------------------------------------------------------------------------
  // Zones
  // --------------------------------------------------------------------------
  setZone(zone) {
    if (zone !== 'interior' && zone !== 'exterior') return;
    if (zone === this.zone) return;
    this.zone = zone;
    if (!this.ready) return;
    const t = this.ac.currentTime;
    for (const key of ['exterior', 'interior']) {
      const n = this._zoneNodes[key];
      n.ret.gain.setTargetAtTime(key === zone ? ZONES[key].wet : 0.0001, t, 0.18);
    }
  }

  /** One probe ray. Returns true if anything solid is within the ray's range. */
  _hitAlong(ctx, dir, far) {
    this._ray.far = far;
    this._ray.set(this._listenerPos, dir);
    this._rayHits.length = 0;
    this._ray.intersectObject(ctx.scene, true, this._rayHits);
    for (let i = 0; i < this._rayHits.length; i++) {
      const h = this._rayHits[i];
      if (h.distance > 0.5 && h.object && h.object.visible !== false) {
        this._rayHits.length = 0;
        return true;
      }
    }
    this._rayHits.length = 0;
    return false;
  }

  /**
   * Enclosure probe. A roof overhead is not enough on its own — this compound is
   * full of gantries and pipe runs, and standing under one should not put you in
   * a corridor reverb. So a room needs a ceiling AND walls: three of four
   * horizontal probes must also come back blocked.
   *
   * Throttled, skipped until the listener has actually moved, and self-limiting:
   * if the scene makes the probe expensive the interval backs off, because the
   * frame budget matters more than instantaneous zone accuracy.
   */
  _probeZone(dt, ctx) {
    this._zoneTimer -= dt;
    if (this._zoneTimer > 0) return;
    this._zoneTimer = this._zoneInterval;
    const pos = this._listenerPos;
    if (pos.distanceToSquared(this._lastZonePos) < 1.44) return;
    this._lastZonePos.copy(pos);

    const t0 = performance.now();
    let interior = false;
    try {
      if (this._hitAlong(ctx, PROBE_DIRS[0], 9)) {
        let walls = 0;
        for (let i = 1; i < PROBE_DIRS.length; i++) {
          if (this._hitAlong(ctx, PROBE_DIRS[i], 7)) walls++;
        }
        interior = walls >= 3;
      }
    } catch {
      this._zoneInterval = 1e9;   // scene is not probe-safe; fall back to events
      return;
    }
    const cost = performance.now() - t0;
    this._zoneCost = this._zoneCost * 0.7 + cost * 0.3;
    if (this._zoneCost > 3.0) this._zoneInterval = Math.min(4, this._zoneInterval * 1.6);

    this.setZone(interior ? 'interior' : 'exterior');
  }

  // --------------------------------------------------------------------------
  // Per-frame
  // --------------------------------------------------------------------------
  update(dt, ctx) {
    const cam = ctx.camera;
    this._listenerPos.copy(cam.position);
    if (!this.ready) return;

    const ac = this.ac;
    const L = ac.listener;
    const t = ac.currentTime;
    cam.getWorldDirection(this._fwd);
    this._up.set(0, 1, 0).applyQuaternion(cam.quaternion);
    if (L.positionX) {
      L.positionX.setTargetAtTime(cam.position.x, t, 0.02);
      L.positionY.setTargetAtTime(cam.position.y, t, 0.02);
      L.positionZ.setTargetAtTime(cam.position.z, t, 0.02);
      L.forwardX.setTargetAtTime(this._fwd.x, t, 0.02);
      L.forwardY.setTargetAtTime(this._fwd.y, t, 0.02);
      L.forwardZ.setTargetAtTime(this._fwd.z, t, 0.02);
      L.upX.setTargetAtTime(this._up.x, t, 0.02);
      L.upY.setTargetAtTime(this._up.y, t, 0.02);
      L.upZ.setTargetAtTime(this._up.z, t, 0.02);
    } else if (L.setPosition) {
      L.setPosition(cam.position.x, cam.position.y, cam.position.z);
      L.setOrientation(this._fwd.x, this._fwd.y, this._fwd.z, this._up.x, this._up.y, this._up.z);
    }

    this._probeZone(dt, ctx);

    // ADS transitions and dry-fire are states, not events — nobody else has to
    // know audio exists, so we watch the weapon system ourselves.
    const w = ctx.get('weapons');
    if (w) {
      const ads = !!w.state?.ads;
      if (ads !== this._wasAds) {
        this._wasAds = ads;
        this.play(ads ? 'ads_in' : 'ads_out');
      }
      const inp = ctx.get('input');
      if (inp?.mouse?.left && w.ammo?.mag === 0 && !w.state?.reloading) {
        if (t - this._lastEmpty > 0.28) {
          this._lastEmpty = t;
          this.play('empty_click');
        }
      }
    }
  }

  // --------------------------------------------------------------------------
  // Voice allocation
  // --------------------------------------------------------------------------
  /** True when this exact cue has already been voiced a moment ago. */
  _coalesce(name, pos, now) {
    const w = this._dedupeWindow;
    for (let i = 0; i < this._recent.length; i++) {
      const r = this._recent[i];
      if (r.t < now - w || r.name !== name) continue;
      if (!r.has || !pos) return true;
      const dx = r.x - pos.x, dy = r.y - pos.y, dz = r.z - pos.z;
      if (dx * dx + dy * dy + dz * dz < 4) return true;
    }
    const slot = this._recent[this._recentCursor];
    this._recentCursor = (this._recentCursor + 1) % this._recent.length;
    slot.name = name;
    slot.t = now;
    slot.has = !!pos;
    if (pos) { slot.x = pos.x; slot.y = pos.y; slot.z = pos.z; }
    return false;
  }

  _budget(now, life) {
    let active = 0;
    const e = this._voiceEnds;
    for (let i = 0; i < e.length; i++) if (e[i] > now) active++;
    if (active >= this.maxVoices) return false;
    e[this._voiceCursor] = now + life;
    this._voiceCursor = (this._voiceCursor + 1) % e.length;
    return true;
  }

  /**
   * Build the per-cue chain and return the shot context the synth modules use.
   * `spatial` false routes to the dry UI bus with no panner, delay or reverb.
   */
  _open(opts, spatial, life, wetScale = 1) {
    const ac = this.ac;
    const now = ac.currentTime;
    if (!this._budget(now, life)) return null;

    const out = ac.createGain();
    let dist = 0;
    let t0 = now + 0.012 + (opts.delay ?? 0);

    if (spatial && opts.position) {
      dist = this._listenerPos.distanceTo(opts.position);
      // Speed of sound. A shot 200m away arrives 0.58s after the muzzle flash.
      t0 += dist / 343;

      // Air absorption: the low-pass closes as distance grows.
      const cutoff = THREE.MathUtils.clamp(16000 * Math.pow(0.5, dist / 42), 260, 19000);
      const air = ac.createBiquadFilter();
      air.type = 'lowpass';
      air.frequency.value = cutoff;
      air.Q.value = 0.35;

      // Inverse-square-ish attenuation with a soft near-field floor.
      out.gain.value = (opts.volume ?? 1) / (1 + Math.pow(dist / 7, 1.25));

      if (dist > 1.4) {
        const pan = ac.createPanner();
        pan.panningModel = 'HRTF';
        pan.distanceModel = 'inverse';
        pan.refDistance = 4;
        pan.rolloffFactor = 0.35;
        pan.maxDistance = 500;
        if (pan.positionX) {
          pan.positionX.value = opts.position.x;
          pan.positionY.value = opts.position.y;
          pan.positionZ.value = opts.position.z;
        } else if (pan.setPosition) {
          pan.setPosition(opts.position.x, opts.position.y, opts.position.z);
        }
        out.connect(air);
        air.connect(pan);
        pan.connect(this.sfx);
      } else {
        out.connect(air);
        air.connect(this.sfx);
      }

      // Farther sources are wetter — that ratio is most of the distance cue.
      const wet = ZONES[this.zone].wet * THREE.MathUtils.clamp(0.4 + dist / 34, 0.4, 1.9) * wetScale;
      const send = ac.createGain();
      send.gain.value = wet;
      out.connect(send);
      send.connect(this.reverbIn);
    } else {
      out.gain.value = opts.volume ?? 1;
      out.connect(spatial ? this.sfx : this.ui);
      if (spatial) {
        const send = ac.createGain();
        send.gain.value = ZONES[this.zone].wet * 0.55 * wetScale;
        out.connect(send);
        send.connect(this.reverbIn);
      }
    }

    const sc = this._sc;
    sc.ac = ac;
    sc.noise = this.noise;
    sc.t0 = t0;
    sc.out = out;
    sc.far = this.farIn;
    sc.dist = dist;
    sc.rapid = false;
    sc.tailScale = this.zone === 'interior' ? 0.62 : 1;
    sc.pitch = opts.pitch ?? 1;
    sc.weapon = opts.weapon;
    sc.empty = !!opts.empty;
    return sc;
  }

  /** Ducks the spatial bus so an explosion has room. Non-destructive, reversible. */
  _duck(amount, hold) {
    if (!this.ready) return;
    const t = this.ac.currentTime;
    const g = this.sfx.gain;
    g.cancelScheduledValues(t);
    g.setTargetAtTime(this.volume.sfx * amount, t, 0.02);
    g.setTargetAtTime(this.volume.sfx, t + hold, 0.25);
  }

  // --------------------------------------------------------------------------
  // The cue table
  // --------------------------------------------------------------------------
  play(name, opts = {}) {
    if (!this.ready || !name) return;
    if (this._coalesce(name, opts.position, this.ac.currentTime)) return;
    try {
      this._play(name, opts);
    } catch (err) {
      // Audio must never take the frame down.
      if (!this._warned) { this._warned = true; console.warn('[audio] cue failed:', name, err); }
    }
  }

  _play(name, opts) {
    if (name.startsWith('fire_')) {
      const sc = this._open(opts, true, 1.2);
      if (!sc) return;
      const now = this.ac.currentTime;
      sc.rapid = now - this._lastShot < 0.1;
      this._lastShot = now;
      fireShot(sc, name);
      return;
    }

    if (name.startsWith('impact_')) {
      const surface = name.slice(7);
      const sc = this._open(opts, true, 0.5);
      if (!sc) return;
      if (surface === 'flesh') fleshHit(sc, !!opts.headshot);
      else impact(sc, surface);
      return;
    }

    if (name.startsWith('footstep_')) {
      const sc = this._open(opts, true, 0.35, 0.7);
      if (!sc) return;
      footstep(sc, name.slice(9), opts.weight ?? 1);
      return;
    }

    if (isBark(name)) {
      const sc = this._open(opts, true, 1.2, 0.7);
      if (sc) bark(sc, name);
      return;
    }

    switch (name) {
      case 'reload_start': {
        const sc = this._open(opts, true, 1.0, 0.5);
        if (sc) reloadStart(sc, opts.weapon);
        return;
      }
      case 'reload_end': {
        const sc = this._open(opts, true, 1.0, 0.5);
        if (sc) reloadEnd(sc, opts.weapon);
        return;
      }
      case 'empty_click': {
        const sc = this._open(opts, true, 0.2, 0.35);
        if (sc) emptyClick(sc);
        return;
      }
      case 'ads_in':
      case 'ads_out': {
        const sc = this._open(opts, true, 0.3, 0.3);
        if (sc) adsMove(sc, name === 'ads_in');
        return;
      }
      case 'shell_drop': {
        const sc = this._open(opts, true, 0.9, 0.8);
        if (sc) shellDrop(sc, opts.calibre ?? '5.56');
        return;
      }
      case 'whizby': {
        const sc = this._open(opts, true, 0.3, 0.6);
        if (sc) whizby(sc);
        return;
      }
      case 'explosion': {
        const sc = this._open(opts, true, 3.0, 1.6);
        if (!sc) return;
        explosion(sc, opts.radius ?? 6);
        this._duck(0.42, 0.35);
        return;
      }
      case 'body_fall': {
        const sc = this._open(opts, true, 0.5, 0.9);
        if (sc) bodyFall(sc);
        return;
      }
      case 'ricochet': {
        const sc = this._open(opts, true, 0.5, 1.1);
        if (sc) ricochet(sc);
        return;
      }
      case 'weapon_switch': {
        const sc = this._open(opts, true, 0.6, 0.4);
        if (sc) weaponSwitch(sc);
        return;
      }
      case 'hitmarker': {
        const sc = this._open(opts, false, 0.35);
        if (sc) hitmarker(sc, opts.kind ?? 'hit');
        return;
      }
      default:
        return;
    }
  }

  dispose() {
    removeEventListener('pointerdown', this._gesture);
    removeEventListener('keydown', this._gesture);
    if (this.ac) this.ac.close().catch(() => {});
    this.ready = false;
  }
}
