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

/**
 * Distance from the bottom of the sole to the ankle bone, in the bind pose. The
 * ankle sits at y = 0.040 and the pelvis solve adds a further 0.055 of hip
 * clearance, so a leg whose hip is `h` above its own ankle puts the sole exactly
 * `hipY - h - ANKLE_CLEAR` off the floor. Naming it stops the two magic numbers
 * drifting apart the next time the pelvis maths is touched.
 */
const ANKLE_CLEAR = 0.095;

export class SoldierAnim {
  /**
   * @param bones  array of THREE.Bone in BONES order
   * @param rng    deterministic per-agent rng
   * @param index  the man's spawn ordinal, used to round-robin the posture
   *   archetype. Drawing the archetype from the rng instead looks correct and is
   *   not: nine men sampling five rows independently collide about six times by
   *   the birthday argument, and a collision is two men with the same stance
   *   topology — which is precisely the "two poses across ten figures" the review
   *   reported. Round-robin makes any five consecutive men structurally distinct
   *   by construction, and every continuous term inside the row is still drawn
   *   from the rng, so no two men are alike even when they share a row.
   */
  constructor(bones, rng, index = 0) {
    this.bones = bones;
    this.rng = rng;
    this.phase = rng();
    this.time = rng() * 10;
    this.idleSeed = rng() * 6.28;

    /**
     * Per-man posture constants — the thing that stops nine riflemen being nine
     * copies of one rifleman.
     *
     * The previous build already varied `phase`, `time` and `idleSeed`, which is
     * enough to desynchronise a *walk*. It is not enough for a squad that is
     * standing and shooting, because in that state every term that shapes the
     * pose (the fighting-stance splay, the knee break, the carry angle, the head
     * track) was a hard-coded constant identical for everyone — so the moment
     * they stopped moving they snapped into the same silhouette. The staged
     * capture showed three men at 4 m with the same arm angle, the same body
     * pitch and the same foot spacing to the pixel.
     *
     * These are drawn once from the agent's deterministic rng, so the squad is
     * varied but a freeze-frame is still reproducible between rounds. Ranges are
     * deliberately modest: this is the difference between individuals, not
     * between styles.
     */
    /**
     * Ranges widened across the board. The previous spans were deliberately
     * "modest" — ±25% on most terms — and the harness showed what modest bought:
     * three staged men at 7 m with knee angles of 31/49, 30/51 and 31/49 degrees
     * and foot spreads of 0.235, 0.249, 0.257 body-heights. Individual variation
     * has to be visible at 200 px to count as variation at all, so `width`,
     * `drop`, `blade` and `toe` now span roughly 2:1 rather than 1.3:1.
     */
    const P = {
      width: 0.55 + rng() * 1.15,        // stance width
      drop: 0.45 + rng() * 1.35,         // how deep he sits into the stance
      blade: 0.55 + rng() * 1.15,        // fore/aft foot stagger
      weight: rng() * 2 - 1,             // standing weight bias, left/right
      carry: rng() * 2 - 1,              // muzzle carry height at low ready
      cant: rng() * 2 - 1,               // weapon cant
      head: rng() * 2 - 1,               // head yaw bias off the aim line
      lean: rng() * 2 - 1,               // torso side lean
      slouch: rng() * 2 - 1,             // torso pitch
      shoulder: rng() * 2 - 1,           // shoulder height asymmetry
      breath: 0.78 + rng() * 0.46,       // breathing rate
      scan: 0.55 + rng() * 0.85,         // idle head scan amplitude
      toe: 0.55 + rng() * 1.05,          // how far the trailing foot turns out
    };

    /**
     * POSTURE ARCHETYPE — the part the previous build was missing.
     *
     * Scaling twelve constants by ±25% desynchronises a squad on paper and does
     * nothing at all in the image, and the harness proves it: three staged men at
     * 7 m came back with knee angles of 31/49, 30/51 and 31/49 degrees, foot
     * spreads of 0.235, 0.249 and 0.257 body-heights, and a pairwise joint RMS of
     * 0.083 rad. They were the same man three times, because every term that
     * shapes a standing fighting stance was multiplied — never switched — and a
     * multiplied term cannot change a topology.
     *
     * These three do change it. `lead` flips WHICH foot is forward, so an
     * archetype-2 rifleman stands in a mirrored stagger rather than a slightly
     * wider one. `crouchBias` puts a man permanently down in his knees whatever
     * the brain asked for, which moves the hips, both knees, the spine and the
     * weapon line together. `leanOut` rolls the trunk off vertical, the posture of
     * a man working the edge of cover. The result is three structurally different
     * silhouettes rather than one silhouette at three sizes.
     */
    /**
     * FIVE archetypes, not three, and each one is a table row rather than a
     * scatter of conditionals.
     *
     * Three was not enough for a section of nine: with nine men drawing uniformly
     * from three rows, the expected number of *repeated* rows is six, and the
     * review counted exactly that — "only two poses across roughly ten figures".
     * Five rows over nine men, each row also carrying its own continuous jitter,
     * is the difference between a squad and a rank.
     *
     *   lead        which foot leads, and by how much. Negative mirrors the
     *               stagger, so the man stands in a different FOOTPRINT rather
     *               than a wider version of the same one.
     *   crouchBias  permanent sit into the knees, independent of what the brain
     *               asked for. Moves hips, both knees, the spine and the weapon
     *               line together, so it changes the silhouette's topology.
     *   leanOut     trunk rolled off vertical — a man working the edge of cover.
     *   widthMul    stance width multiplier on top of P.width.
     *   pitchBias   trunk pitch, so one man is folded over the gun and another
     *               stands tall behind it.
     */
    const ARCH = [
      // upright, square, weight even — the man standing tall behind his rifle
      { lead: 1.00, crouch: [0.00, 0.00], lean: 0.00, widthMul: 0.92, pitch: -0.04 },
      // low fighter, deep in the knees, wide base
      { lead: 0.85, crouch: [0.26, 0.26], lean: 0.04, widthMul: 1.24, pitch: 0.07 },
      // mirrored stagger, leaning out past cover
      { lead: -0.62, crouch: [0.08, 0.10], lean: 0.15, widthMul: 1.02, pitch: 0.02 },
      // narrow, bladed hard, folded over the weapon
      { lead: 1.35, crouch: [0.04, 0.14], lean: -0.10, widthMul: 0.70, pitch: 0.12 },
      // very wide, shallow, almost side-on
      { lead: 0.45, crouch: [0.14, 0.16], lean: -0.17, widthMul: 1.38, pitch: -0.02 },
    ];
    const arch = ((index % ARCH.length) + ARCH.length) % ARCH.length;
    const A = ARCH[arch];
    P.arch = arch;
    P.lead = A.lead * (0.86 + rng() * 0.28);
    P.crouchBias = A.crouch[0] + rng() * A.crouch[1];
    P.leanOut = A.lean + (rng() * 2 - 1) * 0.10;
    // Clamped, because `width` and `widthMul` multiply: the raw product spans
    // 0.39-2.35 and the hip splay it drives is (0.055 + 0.16*crouch + 0.115*fight)
    // radians per unit, so an unclamped 2.35 puts a fully crouched man's thighs
    // 45 degrees apart — a squat, not a fighting stance. 1.75 caps that at 33.
    P.width = clamp(P.width * A.widthMul, 0.45, 1.75);
    P.pitchBias = A.pitch + (rng() * 2 - 1) * 0.035;
    /** Per-leg knee-break asymmetry: nobody breaks both knees equally. */
    P.kneeR = 0.45 + rng() * 1.25;
    P.kneeL = 0.45 + rng() * 1.25;
    this.persona = P;

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
      /**
       * World Y of the ground actually under each boot, or NaN if unknown.
       * Written by the Combatant from a short downward cast; see _footPlant.
       */
      groundR: NaN,
      groundL: NaN,
    };

    /**
     * Published world position of each boot's contact patch, for whoever needs
     * to sample the ground under it (the Combatant's foot cast, the contact
     * shadow). Updated at the end of every solve; reused, never reallocated.
     */
    this.footWorld = [new THREE.Vector3(), new THREE.Vector3()];
    /** Damped ground offsets, relative to the body origin. */
    this._gR = 0;
    this._gL = 0;

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
    const P = this.persona;
    const runBlend = clamp((S.speed - 2.3) / 2.4, 0, 1);
    /**
     * A man's own resting depth, folded into the crouch the brain asked for. This
     * is what makes archetype 1 a permanently low fighter and archetype 0 an
     * upright one; because it enters as `c`, every consequence — hip height, both
     * knee solves, the spine pitch, where the weapon ends up — follows from it,
     * which is why it changes the silhouette instead of nudging it. Only while he
     * is up and engaging: a man walking is a man walking.
     */
    const c = clamp(S.crouch + (1 - S.crouch) * P.crouchBias * S.aim
      * (1 - clamp(S.speed / 1.2, 0, 1)), 0, 1);

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

    // Idle: shift weight from leg to leg and settle onto one hip. The persona
    // bias means a man at rest has a *preferred* hip rather than oscillating
    // symmetrically about the centre, which is what people actually do.
    const idleT = this.time * 0.42 * P.breath + this.idleSeed;
    const shift = clamp(Math.sin(idleT) * 0.72 + P.weight * 0.55, -1.2, 1.2) * (1 - moving);
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
      // sg = +1 is the right (firing-side) leg: it trails, the left leads — except
      // for archetype 2, where P.lead is negative and the stagger mirrors, so that
      // man stands in a visibly different footprint rather than a wider one.
      leg.thigh += fight * (sg > 0 ? -0.17 : 0.24) * P.blade * P.lead;
      leg.knee -= fight * (sg > 0 ? 0.09 * P.kneeR : 0.15 * P.kneeL);
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
     * Sink into the stance — the fix for the locked-knee mannequin.
     *
     * `support` is the reach of the most *extended* planted leg, and the solve
     * below then forces every other planted leg to reach exactly that height. So
     * whichever leg was straightest dictated the hip, and all the deliberate
     * knee flexion added above was immediately undone: measured at the pose the
     * close-up captured, both knees came out at under 4 degrees. The legs
     * rendered as two smooth pipes with no joint anywhere on them, which is the
     * single loudest "this is not a person" cue in the whole frame.
     *
     * A standing man carries his hips a few centimetres below full extension; a
     * rifleman in a fighting stance carries them a good deal lower than that,
     * because a broken knee is what lets him drive into recoil. Dropping the hip
     * by a deliberate amount and letting the inverse-cosine solve find the knee
     * angle gives ~19 deg at rest and ~34 deg fully squared up, with the
     * per-man `drop` spreading the squad either side of that.
     *
     * Cheap to verify: knee = acos((sink-corrected h - T*cos(thigh)) / C), so a
     * 30 mm sink on T=0.445 C=0.425 is 20 deg and 80 mm is 36 deg.
     */
    /**
     * Raised from 0.028 + 0.055. The harness measured the result of the old
     * numbers on the rendered pose: one staged man came back with a trailing knee
     * at 1 degree — locked dead straight — and the rest sat at 31/49. A rifleman
     * driving into recoil carries his hips a good deal lower than that, and the
     * lower bound matters more than the average, because a single locked leg is
     * what reads as a shop mannequin. 0.040 + 0.075 puts the shallowest man near
     * 22 degrees and the deepest past 45.
     */
    const sink = (0.040 + 0.075 * fight * P.drop) * (1 - c * 0.55);
    // The floor is a sanity rail, not a stance dial: a fully crouched man's hip
    // sits at ~0.43 above his ankle, so anything at or above that would silently
    // cancel the crouch.
    support = Math.max(0.26, support - sink);

    /**
     * Ground both feet, on ground that is not necessarily flat.
     *
     * The pelvis sits at the reach of the supporting leg, so any other planted
     * leg that is more flexed than that cannot reach the floor — its boot simply
     * hangs in the air. Worse, until now the floor was assumed to be a single
     * plane through the body's origin, so a man straddling a step, a kerb or one
     * of the deck plates had one boot buried and one floating.
     *
     * `groundR` / `groundL` are real downward casts under each boot (see
     * Combatant._footPlant). Both are turned into offsets from the body origin,
     * the pelvis rides whichever foot is HIGHER, and each planted leg then
     * solves for the hip height above *its own* ground:
     *   h(thigh, knee) = T*cos(thigh) + C*cos(thigh + knee)
     *   knee = -acos( (h - T*cos(thigh)) / C ) - thigh          (flexed branch)
     * The leg on the low side extends, the leg on the high side folds, and both
     * soles finish on the surface they are actually standing on.
     */
    const baseY = group.position.y;
    const gR = I.groundR, gL = I.groundL;
    const tR = Number.isFinite(gR) ? clamp(gR - baseY, -0.45, 0.45) : 0;
    const tL = Number.isFinite(gL) ? clamp(gL - baseY, -0.45, 0.45) : 0;
    // Damped so a cast that steps from one surface to the next does not pop.
    this._gR = damp(this._gR, tR, 9, dt);
    this._gL = damp(this._gL, tL, 9, dt);
    const dR = this._gR, dL = this._gL;
    const dHi = dR > dL ? dR : dL;

    /**
     * The splay is applied at the thigh's Z, which rotates the whole leg chain
     * about the hip — so a leg that reaches `h` in the sagittal plane only
     * reaches `h * cos(splay)` vertically. At the widest fighting stance that is
     * 13 mm of float per boot, which is small but systematic and always in the
     * same direction. Solving against `need / cos(splay)` removes it exactly and
     * costs two cosines.
     */
    const splayR = (0.055 + 0.16 * c + 0.115 * fight) * P.width;
    const splayL = -(0.055 + 0.16 * c + 0.070 * fight) * P.width;

    /**
     * Where the pelvis can actually go.
     *
     * Riding the higher foot alone is not enough, and the first cut of this got
     * it wrong in a way the render showed immediately: with the hip near full
     * extension there is only ~35 mm of spare leg, so the moment one boot landed
     * on anything taller than a kerb the other could not reach its own ground —
     * the inverse cosine went out of range, the knee kept whatever value it had,
     * and the trailing boot hung in mid air. Which is the exact defect this code
     * exists to remove.
     *
     * A person straddling a step does not lift the low foot; he drops his hips
     * until the low leg reaches. So the pelvis takes the LOWER of "what the high
     * foot wants" and "the furthest the low leg can stretch", with a floor so a
     * pathological step cannot fold the high leg past its limit. Both legs are
     * then always inside their solvable range, and neither boot can float.
     */
    const dLo = dR < dL ? dR : dL;
    const reach = (RIG.thigh + RIG.calf) * 0.985;
    let hipRel = Math.min(support + dHi, dLo + reach);
    hipRel = Math.max(hipRel, dHi + 0.30);
    const hipY = ANKLE_CLEAR + hipRel;
    for (const [leg, d, sp] of [[R, dR, splayR], [L, dL, splayL]]) {
      if (!leg.planted) continue;
      const need = (hipRel - d) / Math.cos(sp);              // hip above THIS ankle
      const v = (need - RIG.thigh * Math.cos(leg.thigh)) / RIG.calf;
      // Saturate rather than skip. Leaving the knee at a stale value when the
      // solve is out of range is what put a boot in the air; a leg that is
      // simply straight (or fully folded) is always a defensible pose.
      leg.knee = v >= 1 ? -0.015
        : v <= -1 ? -2.45
          : clamp(-Math.acos(v) - leg.thigh, -2.45, -0.015);
      this._solveAnkle(leg);
    }

    rot[B.thighR * 3] = R.thigh; rot[B.calfR * 3] = R.knee; rot[B.footR * 3] = R.ankle;
    rot[B.thighL * 3] = L.thigh; rot[B.calfL * 3] = L.knee; rot[B.footL * 3] = L.ankle;
    // Legs splay and the knees track outward — a soldier's stance is never
    // knock-kneed, and it widens as he settles into the fight. Per-man width so
    // no two men in a section stand on the same footprint.
    rot[B.thighR * 3 + 2] = splayR;
    rot[B.thighL * 3 + 2] = splayL;
    // Toes follow the stance rather than the hips: lead foot square to the
    // threat, trailing foot turned out.
    rot[B.thighR * 3 + 1] = 0.20 * fight * P.toe * P.lead;
    rot[B.thighL * 3 + 1] = -0.07 * fight * P.toe * P.lead;
    // _solveAnkle levels the sole fore-and-aft; the splay above rolls it
    // sideways, so cancel that at the ankle too or the boots stand on their
    // inside edges. Yaw needs no correction — turning a foot does not tilt it.
    rot[B.footR * 3 + 2] = -rot[B.thighR * 3 + 2];
    rot[B.footL * 3 + 2] = -rot[B.thighL * 3 + 2];

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

    const breath = Math.sin(this.time * 1.55 * P.breath + this.idleSeed) * (1 - moving * 0.6);
    const twist = dYaw * lerp(0.32, 0.62, S.aim);
    rot[B.spine * 3 + 1] = twist * 0.42;
    rot[B.chest * 3 + 1] = twist * 0.58;
    // Persona pitch/lean: one man stands square and upright, the next carries a
    // rolled shoulder and a slight forward crouch. Applied to the trunk rather
    // than the head so it survives the aim solve.
    // `pitchBias` is the archetype's trunk attitude: one man folded over the
    // weapon, the next standing tall behind it. It scales with `fight` so it is a
    // fighting posture rather than a permanent hunch.
    rot[B.spine * 3] = -0.05 + P.slouch * 0.030 + breath * 0.016 + lerp(0.0, 0.10, runBlend) * moving
      + P.pitchBias * fight * 0.55;
    rot[B.chest * 3] = -0.06 + P.slouch * 0.026 - pitch * 0.22 * S.aim + breath * 0.022
      + lerp(0, 0.12, runBlend) * moving + P.pitchBias * fight * 0.85;
    // `leanOut` is the archetype term: a trunk rolled off vertical, the posture of
    // a man working the edge of cover rather than standing square behind it. It
    // scales with `fight` so it only appears when he is up and engaging.
    rot[B.chest * 3 + 2] = -Math.sin(p0 * Math.PI * 2) * 0.05 * moving
      + P.lean * 0.042 * (1 - moving) + P.leanOut * fight * 0.62;
    rot[B.spine * 3 + 2] = Math.sin(p0 * Math.PI * 2) * 0.03 * moving
      + P.lean * 0.026 * (1 - moving) + P.leanOut * fight * 0.38;

    // Head tracks the target independently of the torso, with a lazy scan when
    // idle. The persona bias is a small permanent offset off the aim line —
    // people do not point their heads exactly where their rifle points.
    const scan = (1 - S.aim) * Math.sin(this.time * 0.31 * P.breath + this.idleSeed * 2) * 0.34 * P.scan;
    const headYaw = clamp(dYaw - twist, -1.1, 1.1) * lerp(0.55, 1.0, S.aim)
      + scan + P.head * 0.10 * (1 - S.aim * 0.55);
    rot[B.neck * 3 + 1] = headYaw * 0.35;
    rot[B.head * 3 + 1] = headYaw * 0.65;
    rot[B.neck * 3] = -pitch * 0.25 - 0.04 + 0.10 * c - P.slouch * 0.030;
    rot[B.head * 3] = -pitch * 0.45 * lerp(0.4, 1, S.aim) + 0.06 - P.slouch * 0.022;

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
    /**
     * Clavicles carry the per-man shoulder asymmetry. They sit above the arm
     * bones in the hierarchy but outside the IK chain — `_twoBone` reads the
     * upper arm's parent world quaternion — so rotating them simply moves the
     * shoulder sockets and the IK re-solves onto the same rifle. A firing
     * shoulder rolled up and forward into the stock, and a support shoulder that
     * differs from man to man, is most of what distinguishes two people holding
     * the same weapon.
     */
    const shr = P.shoulder * 0.055;
    bones[B.clavR].rotation.set(-0.05 * S.aim + shr * 0.6, 0, -0.09 * S.aim - shr);
    bones[B.clavL].rotation.set(-0.03 * S.aim - shr * 0.4, 0, 0.05 * S.aim - shr * 0.7);
    group.rotation.y = I.bodyYaw;
    group.updateMatrixWorld(true);

    /* ---- weapon placement + arm IK --------------------------------------- */
    this._placeWeapon(dt, reloading);

    /**
     * Publish each boot's contact patch so the Combatant can cast for the ground
     * under it next tick, and the contact shadow can be parked on it. The offset
     * is the sole's centre in the foot bone's frame, not the ankle joint.
     */
    _v4.set(0, -0.036, -0.064).applyMatrix4(bones[B.footR].matrixWorld);
    this.footWorld[0].copy(_v4);
    _v4.set(0, -0.036, -0.064).applyMatrix4(bones[B.footL].matrixWorld);
    this.footWorld[1].copy(_v4);
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
    const P = this.persona;
    const sprint = clamp((S.speed - 3.4) / 2.0, 0, 1) * (1 - aim);

    // Butt-of-stock anchor, in chest space: shoulder pocket when aiming, dropped
    // to the ribs at low ready, tucked across the body at a sprint. The persona
    // nudges where in the pocket the butt sits and how high the weapon is
    // carried — a 2 cm spread, which is enough that two men side by side do not
    // hold the rifle at the same height.
    _v2.set(
      lerp(0.142, 0.086, aim) - sprint * 0.02 + P.shoulder * 0.014,
      lerp(-0.070, 0.128, aim) - sprint * 0.10 + P.carry * 0.017,
      lerp(0.055, 0.040, aim) + sprint * 0.02 + P.carry * 0.008,
    );
    _v2.z += S.recoil * 0.035;                  // recoil into the shoulder
    _v2.applyQuaternion(qc).add(_v1);           // -> world butt position

    // Bore direction: the aim line when up, angled down and inboard otherwise.
    bore.copy(this._aimDir);
    if (aim < 0.999) {
      _bz.set(0, 0, -1).applyQuaternion(qc);
      _by.set(0, 1, 0);
      _bx.crossVectors(_by, _bz).normalize();
      const down = lerp(0.56, 0.98, sprint) + P.carry * 0.10;
      const inb = lerp(0.16, 0.60, sprint) + P.cant * 0.05;
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
    _q1.setFromAxisAngle(_bz, lerp(-0.15, -0.05, aim) + P.cant * 0.055);
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
