import * as THREE from 'three';
import { B, BIND, RIG } from './SoldierRig.js';

/**
 * OWNER: ai agent.
 *
 * Procedural animation for one combatant. No clips, no keyframe data files —
 * every pose is computed, which is the only way to hit "zero external assets"
 * and still get a rifleman who plants his feet.
 *
 * The three techniques doing the heavy lifting:
 *
 * 1. PHASE FROM DISTANCE. The gait phase advances by ground distance travelled
 *    divided by stride length, never by time. Feet therefore cannot slide,
 *    whatever the speed, and acceleration reads correctly for free.
 *
 * 2. PELVIS FROM LEG FK. The pelvis height is *derived* from the supporting
 *    leg's forward kinematics each frame (hip-above-ankle for the most extended
 *    stance leg). The body bob and the crouch drop are consequences of the leg
 *    angles rather than a separate sine that has to be kept in sync — so the
 *    feet are always on the floor.
 *
 * 3. WEAPON-ANCHOR + TWO-BONE IK. Nothing animates the arms directly. The rifle
 *    is placed in the world (butt in the shoulder pocket, bore on the aim line),
 *    the right hand is derived from the rifle, and both arms are solved by
 *    analytic two-bone IK. That is why these soldiers actually point their guns
 *    at what they are shooting at.
 */

const DEG = Math.PI / 180;
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _pole = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _q3 = new THREE.Quaternion();
const _mb = new THREE.Matrix4();
const _down = new THREE.Vector3(0, -1, 0);
const _up = new THREE.Vector3(0, 1, 0);
const _ax = new THREE.Vector3();
const _bx = new THREE.Vector3();
const _by = new THREE.Vector3();
const _bz = new THREE.Vector3();

/**
 * NaN-safe clamp. The naive `x < a ? a : x > b ? b : x` passes NaN straight
 * through — both comparisons are false — so a single bad input upstream used to
 * survive every clamp in this file and end up in a vertex position. Both
 * comparisons being false is now the *fallback* case, and NaN lands on `a`.
 */
const clamp = (x, a, b) => (x >= a ? (x <= b ? x : b) : a);
const lerp = (a, b, t) => a + (b - a) * t;
/** Replace a non-finite component with `d`. Cheap; no allocation. */
function sanitise(v, d = 0) {
  if (!Number.isFinite(v.x)) v.x = d;
  if (!Number.isFinite(v.y)) v.y = d;
  if (!Number.isFinite(v.z)) v.z = d;
  return v;
}
/** Cyclic gaussian bump — the shape of a single flexion event in a gait cycle. */
function bump(p, c, w) {
  let d = p - c;
  if (d > 0.5) d -= 1; else if (d < -0.5) d += 1;
  const t = d / w;
  return Math.exp(-t * t);
}
/** Critically-damped follow, framerate independent. */
const damp = (cur, tgt, rate, dt) => cur + (tgt - cur) * (1 - Math.exp(-rate * dt));

/** Where the support hand goes during each stage of a reload. */
const RELOAD_KEYS = [
  [0.00, 'fore'], [0.22, 'well'], [0.42, 'well'], [0.62, 'pouch'],
  [1.05, 'pouch'], [1.42, 'well'], [1.70, 'well'], [1.94, 'charge'],
  [2.16, 'charge'], [2.45, 'fore'],
];

export class SoldierAnim {
  /**
   * @param bones  array of THREE.Bone in BONES order
   * @param rng    deterministic per-agent rng
   */
  constructor(bones, rng) {
    this.bones = bones;
    this.rng = rng;
    this.phase = rng();
    this.time = rng() * 10;
    this.idleSeed = rng() * 6.28;

    /** Written by the Combatant every tick. */
    this.in = {
      speed: 0,               // m/s of planar travel
      run: 0,                 // 0..1 blend toward the run cycle
      crouch: 0,              // 0..1
      aim: 0,                 // 0..1 weapon-up blend
      aimAt: new THREE.Vector3(0, 1.6, -10),
      bodyYaw: 0,
      firing: 0,              // 0..1 recoil impulse envelope
      reloadT: -1,            // >=0 while reloading
      dead: false,
    };

    this.smooth = { crouch: 0, aim: 0, speed: 0, recoil: 0, lean: 0 };
    /**
     * Cant of the support fist relative to the rifle: rolled slightly inboard
     * and dropped at the wrist, which is what a real C-clamp looks like. Built
     * once — _placeWeapon runs every frame and must not allocate.
     */
    this._qOffL = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.14, 0.05, 0.30));
    this.flinch = [];        // {bone, t, dur, mag, sx, sz}
    this.rot = new Float32Array(bones.length * 3);
    this.muzzle = new THREE.Vector3();
    this.muzzleDir = new THREE.Vector3(0, 0, -1);
    this.eye = new THREE.Vector3();
    this._legs = [
      { thigh: 0, knee: 0, ankle: 0, hipAbove: 0.87 },
      { thigh: 0, knee: 0, ankle: 0, hipAbove: 0.87 },
    ];
  }

  addFlinch(boneIndex, mag, dirX, dirZ) {
    if (this.flinch.length > 6) this.flinch.shift();
    this.flinch.push({ bone: boneIndex, t: 0, dur: 0.36, mag, sx: dirZ, sz: -dirX });
  }

  kick(strength = 1) { this.smooth.recoil = Math.min(1.6, this.smooth.recoil + strength); }

  /* ------------------------------------------------------------------ gait -- */

  /**
   * One leg's flexion for a cycle phase. `duty` is the fraction of the cycle
   * the foot spends planted (0.62 walking, 0.38 running).
   */
  _leg(out, p, amp, kneeStance, kneeSwing, duty) {
    out.thigh = amp * Math.cos(p * Math.PI * 2);
    out.knee = -(0.06 + kneeStance * bump(p, 0.12, 0.16) + kneeSwing * bump(p, 0.74, 0.20));
    out.planted = p < duty;
    // The ankle is NOT resolved here. Crouch and the idle weight-shift both add
    // to thigh and knee after this call, so an ankle computed now is stale by
    // the time it is committed — which is exactly why every standing soldier
    // used to be tilted a few degrees onto his heel. Stash the two gait terms
    // and let _solveAnkle close the chain once thigh and knee are final.
    out.push = 0.55 * bump(p, duty * 0.94, 0.10);   // plantarflex at toe-off
    out.swing = 0.22 * bump(p, 0.80, 0.22) - 0.05;  // dorsiflex through the swing
    out.ankle = 0;
    out.hipAbove = RIG.thigh * Math.cos(out.thigh) + RIG.calf * Math.cos(out.thigh + out.knee);
    return out;
  }

  /**
   * Close the leg chain so the sole is level with the floor.
   *
   * thigh, knee and ankle are all rotations about the same X axis, so the
   * foot's pitch in character space is their exact sum. Setting
   * ankle = -(thigh + knee) therefore puts the sole flat, by construction,
   * in every stance — standing, crouched, mid-step — with `push` the only
   * deliberate departure from level, at toe-off where it belongs.
   */
  _solveAnkle(leg) {
    leg.ankle = leg.planted ? -(leg.thigh + leg.knee) + leg.push : leg.swing;
    leg.hipAbove = RIG.thigh * Math.cos(leg.thigh) + RIG.calf * Math.cos(leg.thigh + leg.knee);
  }

  /* ------------------------------------------------------------------ pose -- */

  update(dt, group) {
    const I = this.in;
    const S = this.smooth;
    const bones = this.bones;
    const rot = this.rot;
    rot.fill(0);

    /**
     * The one place a bad number can enter this system: the aim target and the
     * body transform both come from outside. Everything downstream — the aim
     * direction, the two-bone IK, the rifle basis, the skinned vertex positions
     * — is arithmetic on these two, so sanitising here is sufficient to keep NaN
     * out of the geometry entirely. dt likewise: a stalled tab can hand us a
     * garbage delta.
     */
    if (!Number.isFinite(dt) || dt < 0) dt = 0;
    else if (dt > 0.25) dt = 0.25;
    sanitise(I.aimAt);
    sanitise(group.position);
    if (!Number.isFinite(I.bodyYaw)) I.bodyYaw = 0;
    if (!Number.isFinite(I.speed) || I.speed < 0) I.speed = 0;

    S.crouch = damp(S.crouch, I.crouch, 7.5, dt);
    S.aim = damp(S.aim, I.aim, 9.0, dt);
    S.speed = damp(S.speed, I.speed, 11.0, dt);
    S.recoil = Math.max(0, S.recoil - dt * 7.5);
    this.time += dt;

    const reloading = I.reloadT >= 0;
    const c = S.crouch;
    const runBlend = clamp((S.speed - 2.3) / 2.4, 0, 1);

    /* ---- locomotion ------------------------------------------------------ */
    const stride = lerp(1.42, 2.55, runBlend) * lerp(1, 0.72, c);
    if (S.speed > 0.05) this.phase = (this.phase + (S.speed * dt) / stride) % 1;
    const moving = clamp(S.speed / 1.2, 0, 1);
    const amp = lerp(0.30, 0.62, runBlend) * moving * lerp(1, 0.55, c);
    const kneeStance = lerp(0.30, 0.62, runBlend) * moving;
    const kneeSwing = lerp(0.80, 1.32, runBlend) * moving;
    const duty = lerp(0.62, 0.40, runBlend);

    const p0 = this.phase;
    const p1 = (this.phase + 0.5) % 1;
    const R = this._leg(this._legs[0], p0, amp, kneeStance, kneeSwing, duty);
    const L = this._leg(this._legs[1], p1, amp, kneeStance, kneeSwing, duty);

    // Idle: shift weight from leg to leg and settle onto one hip.
    const idleT = this.time * 0.42 + this.idleSeed;
    const shift = Math.sin(idleT) * (1 - moving);
    const crouchThigh = 1.15 * c, crouchKnee = -2.10 * c;
    // Standing still, `phase` is frozen at whatever the agent's rng seeded it
    // to — so roughly half the squad sat in the swing half of the cycle with a
    // foot lifted and the toe up, forever. A man who is not walking has both
    // feet planted; say so.
    const standing = moving < 0.02;
    /**
     * Fighting stance. A rifleman who is up and engaging does not stand at
     * attention with his heels together — he blades off, puts the support-side
     * foot forward, breaks both knees and drives his weight onto the front leg.
     * Without this the squad read as coat-stands with guns, which is exactly how
     * the first close-up came out. Scaled by aim and faded out as soon as he
     * starts moving, so it never fights the gait.
     */
    const fight = S.aim * (1 - moving) * (1 - c * 0.55);
    for (const [leg, sg] of [[R, 1], [L, -1]]) {
      leg.thigh += crouchThigh + (1 - moving) * (0.035 + shift * sg * 0.045);
      leg.knee += crouchKnee - (1 - moving) * (0.09 + shift * sg * 0.075);
      // sg = +1 is the right (firing-side) leg: it trails. The left leads.
      leg.thigh += fight * (sg > 0 ? -0.17 : 0.24);
      leg.knee -= fight * (sg > 0 ? 0.09 : 0.15);
      if (standing) { leg.planted = true; leg.push = 0; }
      this._solveAnkle(leg);
    }

    /* ---- pelvis: derived, so the feet stay on the ground ------------------ */
    let support = Math.max(
      R.planted ? R.hipAbove : 0,
      L.planted ? L.hipAbove : 0,
    );
    if (support === 0) support = Math.max(R.hipAbove, L.hipAbove);   // flight phase

    /**
     * Ground both feet.
     *
     * The pelvis sits at the reach of the most extended supporting leg, so any
     * other planted leg that is more flexed than that cannot reach the floor —
     * its boot simply hangs in the air. Previously nothing corrected for it, and
     * the bladed stance above (which deliberately bends the legs by different
     * amounts) would have left the trailing boot ~2 cm off the deck.
     *
     * The fix is exact rather than a fudge. Hip height above the ankle is
     *   h(thigh, knee) = T*cos(thigh) + C*cos(thigh + knee)
     * so for a required h the knee follows by one inverse cosine:
     *   knee = -acos( (h - T*cos(thigh)) / C ) - thigh
     * taking the flexed branch. Each planted leg straightens or bends to meet
     * the hip the others chose, and every boot ends up on the floor.
     */
    for (const leg of this._legs) {
      if (!leg.planted) continue;
      const v = (support - RIG.thigh * Math.cos(leg.thigh)) / RIG.calf;
      if (v > -1 && v < 1) {
        leg.knee = clamp(-Math.acos(v) - leg.thigh, -2.45, -0.015);
        this._solveAnkle(leg);
      }
    }

    rot[B.thighR * 3] = R.thigh; rot[B.calfR * 3] = R.knee; rot[B.footR * 3] = R.ankle;
    rot[B.thighL * 3] = L.thigh; rot[B.calfL * 3] = L.knee; rot[B.footL * 3] = L.ankle;
    // Legs splay and the knees track outward — a soldier's stance is never
    // knock-kneed, and it widens as he settles into the fight.
    rot[B.thighR * 3 + 2] = 0.055 + 0.16 * c + 0.085 * fight;
    rot[B.thighL * 3 + 2] = -0.055 - 0.16 * c - 0.045 * fight;
    // Toes follow the stance rather than the hips: lead foot square to the
    // threat, trailing foot turned out.
    rot[B.thighR * 3 + 1] = 0.20 * fight;
    rot[B.thighL * 3 + 1] = -0.07 * fight;
    // _solveAnkle levels the sole fore-and-aft; the splay above rolls it
    // sideways, so cancel that at the ankle too or the boots stand on their
    // inside edges. Yaw needs no correction — turning a foot does not tilt it.
    rot[B.footR * 3 + 2] = -rot[B.thighR * 3 + 2];
    rot[B.footL * 3 + 2] = -rot[B.thighL * 3 + 2];

    const hipY = 0.040 + support + 0.055;
    const pelvis = bones[B.pelvis];
    pelvis.position.y = damp(pelvis.position.y, hipY, 26, dt);

    // Hip counter-rotation and the drop over the swing leg.
    const swingSign = Math.sin(p0 * Math.PI * 2);
    rot[B.pelvis * 3 + 1] = swingSign * 0.17 * moving * (1 - c * 0.5);
    rot[B.pelvis * 3 + 2] = -Math.cos(p0 * Math.PI * 2) * 0.055 * moving + shift * 0.03 * (1 - moving);
    rot[B.pelvis * 3] = lerp(0.02, 0.16, runBlend) * moving + 0.18 * c;

    /* ---- spine, breathing, aim yaw --------------------------------------- */
    // Aim direction in body space decides how much the torso twists.
    const aimDir = this._aimDir || (this._aimDir = new THREE.Vector3(0, 0, -1));
    _v1.copy(I.aimAt);
    const chestY = BIND[B.chest].y - 0.44 * c;
    _v2.set(group.position.x, group.position.y + chestY, group.position.z);
    aimDir.subVectors(_v1, _v2);
    let aimDist = aimDir.length();
    // A target inside the chest has no direction. Fall back to straight ahead
    // rather than dividing by ~0 — this is the divide that would otherwise feed
    // an infinite bore vector into the rifle basis and the arm IK.
    if (!(aimDist > 0.5)) {
      aimDir.set(-Math.sin(I.bodyYaw), 0, -Math.cos(I.bodyYaw));
      aimDist = 1;
    } else {
      aimDir.divideScalar(aimDist);
    }
    const wantYaw = Math.atan2(-aimDir.x, -aimDir.z);
    let dYaw = wantYaw - I.bodyYaw;
    while (dYaw > Math.PI) dYaw -= Math.PI * 2;
    while (dYaw < -Math.PI) dYaw += Math.PI * 2;
    dYaw = clamp(dYaw, -1.15, 1.15);
    const pitch = clamp(Math.asin(clamp(aimDir.y, -1, 1)), -0.7, 0.6);

    const breath = Math.sin(this.time * 1.55 + this.idleSeed) * (1 - moving * 0.6);
    const twist = dYaw * lerp(0.32, 0.62, S.aim);
    rot[B.spine * 3 + 1] = twist * 0.42;
    rot[B.chest * 3 + 1] = twist * 0.58;
    rot[B.spine * 3] = -0.05 + breath * 0.016 + lerp(0.0, 0.10, runBlend) * moving;
    rot[B.chest * 3] = -0.06 - pitch * 0.22 * S.aim + breath * 0.022 + lerp(0, 0.12, runBlend) * moving;
    rot[B.chest * 3 + 2] = -Math.sin(p0 * Math.PI * 2) * 0.05 * moving;
    rot[B.spine * 3 + 2] = Math.sin(p0 * Math.PI * 2) * 0.03 * moving;

    // Head tracks the target independently of the torso, with a lazy scan when idle.
    const scan = (1 - S.aim) * Math.sin(this.time * 0.31 + this.idleSeed * 2) * 0.34;
    const headYaw = clamp(dYaw - twist, -1.1, 1.1) * lerp(0.55, 1.0, S.aim) + scan;
    rot[B.neck * 3 + 1] = headYaw * 0.35;
    rot[B.head * 3 + 1] = headYaw * 0.65;
    rot[B.neck * 3] = -pitch * 0.25 - 0.04 + 0.10 * c;
    rot[B.head * 3] = -pitch * 0.45 * lerp(0.4, 1, S.aim) + 0.06;

    /* ---- flinch ---------------------------------------------------------- */
    for (let i = this.flinch.length - 1; i >= 0; i--) {
      const f = this.flinch[i];
      f.t += dt;
      if (f.t >= f.dur) { this.flinch.splice(i, 1); continue; }
      const k = 1 - f.t / f.dur;
      const e = Math.sin(k * Math.PI) * k * f.mag;
      rot[f.bone * 3] += f.sx * e * 1.3;
      rot[f.bone * 3 + 2] += f.sz * e * 1.3;
      // The whole trunk absorbs part of it, which is what makes a hit read.
      rot[B.spine * 3] += f.sx * e * 0.30;
      rot[B.spine * 3 + 2] += f.sz * e * 0.30;
      rot[B.neck * 3] += f.sx * e * 0.22;
    }

    /* ---- recoil ---------------------------------------------------------- */
    const rk = S.recoil;
    rot[B.chest * 3] -= rk * 0.055;
    rot[B.spine * 3] -= rk * 0.03;
    rot[B.neck * 3] -= rk * 0.02;

    /* ---- commit FK ------------------------------------------------------- */
    for (let i = 0; i < bones.length; i++) {
      if (i === B.clavR || i === B.armR || i === B.foreR || i === B.handR) continue;
      if (i === B.clavL || i === B.armL || i === B.foreL || i === B.handL) continue;
      bones[i].rotation.set(rot[i * 3], rot[i * 3 + 1], rot[i * 3 + 2]);
    }
    bones[B.clavR].rotation.set(0, 0, 0);
    bones[B.clavL].rotation.set(0, 0, 0);
    group.rotation.y = I.bodyYaw;
    group.updateMatrixWorld(true);

    /* ---- weapon placement + arm IK --------------------------------------- */
    this._placeWeapon(dt, reloading);
  }

  /**
   * Puts the rifle in the world, then solves both arms onto it.
   * Everything here is world-space; the chest transform is already final.
   */
  _placeWeapon(dt, reloading) {
    const bones = this.bones;
    const chest = bones[B.chest];
    const S = this.smooth;
    const I = this.in;
    const qc = this._qc || (this._qc = new THREE.Quaternion());   // chest basis
    const qr = this._qr || (this._qr = new THREE.Quaternion());   // rifle basis
    const handPos = this._handR || (this._handR = new THREE.Vector3());
    const target = this._handL || (this._handL = new THREE.Vector3());
    const bore = this._bore || (this._bore = new THREE.Vector3());

    // Bind rotations are identity, so a bone's world quaternion IS its basis.
    chest.getWorldQuaternion(qc);
    chest.getWorldPosition(_v1);

    const aim = S.aim;
    const sprint = clamp((S.speed - 3.4) / 2.0, 0, 1) * (1 - aim);

    // Butt-of-stock anchor, in chest space: shoulder pocket when aiming, dropped
    // to the ribs at low ready, tucked across the body at a sprint.
    _v2.set(
      lerp(0.142, 0.086, aim) - sprint * 0.02,
      lerp(-0.070, 0.128, aim) - sprint * 0.10,
      lerp(0.055, 0.040, aim) + sprint * 0.02,
    );
    _v2.z += S.recoil * 0.035;                  // recoil into the shoulder
    _v2.applyQuaternion(qc).add(_v1);           // -> world butt position

    // Bore direction: the aim line when up, angled down and inboard otherwise.
    bore.copy(this._aimDir);
    if (aim < 0.999) {
      _bz.set(0, 0, -1).applyQuaternion(qc);
      _by.set(0, 1, 0);
      _bx.crossVectors(_by, _bz).normalize();
      const down = lerp(0.56, 0.98, sprint);
      const inb = lerp(0.16, 0.60, sprint);
      _v4.copy(_bz).multiplyScalar(Math.cos(down))
        .addScaledVector(_by, -Math.sin(down))
        .addScaledVector(_bx, -inb)
        .normalize();
      bore.lerp(_v4, 1 - aim).normalize();
    }
    if (S.recoil > 0) { bore.y += S.recoil * 0.05; bore.normalize(); }

    // Rifle world rotation: hand-local -Z onto the bore, plus a little cant.
    _bz.copy(bore).multiplyScalar(-1);
    _bx.crossVectors(_up, _bz);
    if (_bx.lengthSq() < 1e-6) _bx.set(1, 0, 0);
    _bx.normalize();
    _by.crossVectors(_bz, _bx).normalize();
    _mb.makeBasis(_bx, _by, _bz);
    qr.setFromRotationMatrix(_mb);
    _q1.setFromAxisAngle(_bz, lerp(-0.15, -0.05, aim));
    qr.premultiply(_q1);

    /* ---- reload timeline: cant the gun in, work the mag well -------------- */
    let supportKey = 'fore';
    let supportMix = 1;
    if (reloading) {
      const t = I.reloadT;
      let a = RELOAD_KEYS[0], b = RELOAD_KEYS[RELOAD_KEYS.length - 1];
      for (let i = 0; i < RELOAD_KEYS.length - 1; i++) {
        if (t >= RELOAD_KEYS[i][0] && t <= RELOAD_KEYS[i + 1][0]) { a = RELOAD_KEYS[i]; b = RELOAD_KEYS[i + 1]; break; }
      }
      const k = clamp((t - a[0]) / Math.max(1e-3, b[0] - a[0]), 0, 1);
      const ks = k * k * (3 - 2 * k);
      supportKey = ks < 0.5 ? a[1] : b[1];
      supportMix = ks < 0.5 ? 1 - ks * 2 : (ks - 0.5) * 2;
      const w = Math.sin(clamp(t / 2.45, 0, 1) * Math.PI);
      _q1.setFromAxisAngle(_bz, -0.50 * w);
      qr.premultiply(_q1);
      _q1.setFromAxisAngle(_bx, -0.26 * w);
      qr.premultiply(_q1);
      _v2.y -= 0.10 * w;
      _v2.addScaledVector(_bz, 0.05 * w);
    }

    // hand = butt - R * buttLocal
    handPos.copy(_v2);
    _v4.copy(RIG.buttLocal).applyQuaternion(qr);
    handPos.sub(_v4);

    /* ---- right arm: shoulder -> hand ------------------------------------- */
    bones[B.armR].getWorldPosition(_v1);
    _pole.set(0.50, -1, 0.20).applyQuaternion(qc).normalize();
    this._twoBone(bones[B.armR], bones[B.foreR], _v1, handPos, RIG.upperArm, RIG.foreArm, _pole);
    // Hand orientation is authoritative — the rifle is welded to it.
    bones[B.foreR].getWorldQuaternion(_q1);
    bones[B.handR].quaternion.copy(qr).premultiply(_q1.invert());
    bones[B.handR].updateWorldMatrix(false, false);

    /* ---- support hand target, derived from the rifle --------------------- */
    const handM = bones[B.handR].matrixWorld;
    target.copy(RIG.foreGripLocal).applyMatrix4(handM);
    if (reloading && supportKey !== 'fore') {
      const alt = this._alt || (this._alt = new THREE.Vector3());
      if (supportKey === 'well') alt.set(0, -0.085, -0.030).applyMatrix4(handM);
      else if (supportKey === 'charge') alt.set(0.060, 0.100, 0.030).applyMatrix4(handM);
      else {                                        // magazine pouch on the rig
        chest.getWorldPosition(alt);
        _v4.set(-0.09, -0.17, -0.21).applyQuaternion(qc);
        alt.add(_v4);
      }
      target.lerp(alt, supportMix);
    }

    bones[B.armL].getWorldPosition(_v1);
    // Support elbow drops under the handguard rather than winging outward.
    _pole.set(-0.12, -1, -0.10).applyQuaternion(qc).normalize();
    this._twoBone(bones[B.armL], bones[B.foreL], _v1, target, RIG.upperArm, RIG.foreArm, _pole);
    /**
     * Support hand orientation, derived from the rifle rather than hard-coded.
     *
     * handL's world basis is set to the rifle's basis plus a fixed cant, which
     * makes this bone's local frame identical to the weapon's frame. That is the
     * contract buildSupportHand() is authored against: the foregrip post stands
     * along local +Y at the bone origin, so the fist closes on it exactly, at
     * every rifle attitude, including through the reload cant. The previous
     * fixed Euler (-0.72, 0, 0.25) was correct for one arm pose and wrong for
     * every other — the hand drifted off the handguard as the gun moved.
     */
    const qhl = this._qhl || (this._qhl = new THREE.Quaternion());
    qhl.copy(qr).multiply(this._qOffL);
    bones[B.foreL].getWorldQuaternion(_q1);
    bones[B.handL].quaternion.copy(qhl).premultiply(_q1.invert());
    bones[B.handL].updateWorldMatrix(false, false);

    /* ---- publish muzzle + eye for the FX and perception layers ----------- */
    this.muzzle.copy(RIG.muzzleLocal).applyMatrix4(handM);
    bones[B.handR].getWorldQuaternion(_q1);
    this.muzzleDir.set(0, 0, -1).applyQuaternion(_q1).normalize();
    bones[B.head].getWorldPosition(this.eye);
    bones[B.head].getWorldQuaternion(_q1);
    _v4.copy(RIG.eyeLocal).applyQuaternion(_q1);
    this.eye.add(_v4);
  }

  /**
   * Analytic two-bone IK. Both bones' bind direction is -Y, so the solution is
   * two setFromUnitVectors calls plus one law-of-cosines. `pole` is the world
   * direction the joint should bend toward.
   */
  _twoBone(upper, lower, root, target, lenA, lenB, pole) {
    _v2.subVectors(target, root);
    let dist = _v2.length();
    // Written as `!(dist > eps)` so NaN takes the fallback branch too — with the
    // naive `dist < eps` a NaN target sailed through and every rotation this
    // routine writes became NaN, which is how a bad number reaches a bone.
    if (!(dist > 1e-4)) { _v2.set(0, -1, 0); dist = 1e-4; }
    const reach = lenA + lenB - 1e-4;
    const clampedDist = clamp(dist, Math.abs(lenA - lenB) + 1e-3, reach);
    _v2.divideScalar(dist);

    const cosA = clamp((lenA * lenA + clampedDist * clampedDist - lenB * lenB) / (2 * lenA * clampedDist), -1, 1);
    const angA = Math.acos(cosA);

    _ax.crossVectors(_v2, pole);
    if (_ax.lengthSq() < 1e-8) _ax.set(0, 0, 1);
    _ax.normalize();
    _v3.copy(_v2).applyAxisAngle(_ax, angA);          // upper bone direction
    _v4.copy(root).addScaledVector(_v3, lenA);        // elbow / knee
    _bx.subVectors(target, _v4).normalize();          // lower bone direction

    // world -> local, using the parent's world quaternion.
    upper.parent.getWorldQuaternion(_q3);
    _q1.setFromUnitVectors(_down, _v3);
    upper.quaternion.copy(_q3.invert()).multiply(_q1);
    upper.updateWorldMatrix(false, false);

    upper.getWorldQuaternion(_q3);
    _q1.setFromUnitVectors(_down, _bx);
    lower.quaternion.copy(_q3.invert()).multiply(_q1);
    lower.updateWorldMatrix(false, false);
  }
}
