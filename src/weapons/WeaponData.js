/**
 * OWNER: weapons agent (shared with viewmodel + ballistics agents — read-only
 * for them). Pure data, no imports, so any system can consume it.
 *
 * recoilPattern: array of [pitch, yaw] in radians, indexed by shot number —
 * a *learnable* pattern, the way COD/CS weapons work, not random spray.
 *
 * Field groups, so it is obvious what a new weapon has to declare:
 *   identity     id, displayName, class, calibre, shellCalibre
 *   fire control rpm, fireModes, burstCount, burstDelay
 *   terminal     damage, damageFalloff, headshotMultiplier, penetration,
 *                muzzleVelocity
 *   handling     magSize, reserve, reloadTime, reloadEmptyTime, adsTime,
 *                holsterTime, drawTime
 *   accuracy     spreadHip, spreadAds, spreadMoveScale, firstShotScale,
 *                bloomPerShot, bloomMax, bloomDecay, airPenalty, crouchBonus
 *   recoil       recoilKick, recoilRecovery, recoilRoll, recoilVisual
 *   mechanics    ejectVelocity (local right/up/forward, m/s)
 */
export const WEAPONS = {
  ar_vector: {
    id: 'ar_vector',
    displayName: 'VK-7 VECTOR',
    class: 'assault',
    calibre: '5.56',
    rpm: 720,
    damage: 32,
    damageFalloff: [[0, 1.0], [28, 1.0], [55, 0.72], [90, 0.55]],
    headshotMultiplier: 2.1,
    magSize: 30,
    reserve: 210,
    reloadTime: 2.15,
    reloadEmptyTime: 2.85,
    adsTime: 0.22,
    spreadHip: 0.042,
    spreadAds: 0.0022,
    spreadMoveScale: 2.1,
    muzzleVelocity: 880,
    penetration: 0.55,
    recoilKick: 0.021,
    recoilRecovery: 11,
    shellCalibre: '5.56',
    fireModes: ['auto', 'burst', 'semi'],

    // ---- fire control -------------------------------------------------------
    burstCount: 3,
    burstDelay: 0.19,          // dead time between bursts, on top of the RPM gap
    // ---- accuracy state machine --------------------------------------------
    firstShotScale: 0.22,      // multiplier on a settled, un-bloomed first shot
    bloomPerShot: 0.0075,      // radians of cone added per round
    bloomMax: 0.034,
    bloomDecay: 0.032,         // radians/second bled off once you stop
    airPenalty: 2.6,
    crouchBonus: 0.62,
    // ---- recoil -------------------------------------------------------------
    recoilRoll: 0.32,          // fraction of the yaw step applied as camera roll
    recoilVisual: 1.0,
    // ---- handling -----------------------------------------------------------
    holsterTime: 0.26,
    drawTime: 0.44,
    ejectVelocity: [2.7, 1.9, -0.55],
  },
  smg_wraith: {
    id: 'smg_wraith',
    displayName: 'WRAITH-9',
    class: 'smg',
    calibre: '9mm',
    rpm: 900,
    damage: 24,
    damageFalloff: [[0, 1.0], [16, 1.0], [34, 0.66], [60, 0.44]],
    headshotMultiplier: 1.9,
    magSize: 36,
    reserve: 252,
    reloadTime: 1.85,
    reloadEmptyTime: 2.4,
    adsTime: 0.17,
    spreadHip: 0.055,
    spreadAds: 0.004,
    spreadMoveScale: 1.6,
    muzzleVelocity: 400,
    penetration: 0.32,
    recoilKick: 0.016,
    recoilRecovery: 13,
    shellCalibre: '9mm',
    fireModes: ['auto', 'semi'],

    burstCount: 3,
    burstDelay: 0.16,
    firstShotScale: 0.34,
    bloomPerShot: 0.0062,
    bloomMax: 0.046,
    bloomDecay: 0.040,
    airPenalty: 2.1,
    crouchBonus: 0.68,
    recoilRoll: 0.26,
    recoilVisual: 0.92,
    holsterTime: 0.21,
    drawTime: 0.34,
    ejectVelocity: [2.3, 1.7, -0.4],
  },
  dmr_lancet: {
    id: 'dmr_lancet',
    displayName: 'LANCET MK4',
    class: 'marksman',
    calibre: '7.62',
    rpm: 300,
    damage: 62,
    damageFalloff: [[0, 1.0], [70, 1.0], [140, 0.85]],
    headshotMultiplier: 2.4,
    magSize: 20,
    reserve: 120,
    reloadTime: 2.4,
    reloadEmptyTime: 3.1,
    adsTime: 0.30,
    spreadHip: 0.07,
    spreadAds: 0.0008,
    spreadMoveScale: 2.6,
    muzzleVelocity: 840,
    penetration: 0.82,
    recoilKick: 0.048,
    recoilRecovery: 8,
    shellCalibre: '7.62',
    fireModes: ['semi'],

    burstCount: 2,
    burstDelay: 0.26,
    firstShotScale: 0.10,
    bloomPerShot: 0.0130,
    bloomMax: 0.052,
    bloomDecay: 0.048,
    airPenalty: 3.2,
    crouchBonus: 0.55,
    recoilRoll: 0.42,
    recoilVisual: 1.12,
    holsterTime: 0.32,
    drawTime: 0.52,
    ejectVelocity: [3.1, 2.2, -0.7],
  },
};

/** Loadout order for weapon switching (slot 1..3, wheel next/prev). */
export const WEAPON_ORDER = ['ar_vector', 'smg_wraith', 'dmr_lancet'];

/**
 * Terminal-ballistics tuning. Lives here rather than in core/Constants.js
 * because Constants.js is not owned by this agent; it is the canonical home for
 * a `BALLISTICS` block and should be moved there when one agent owns that file.
 *
 * The penetration model: crossing `t` metres of a material costs
 *
 *     cost = t * penetrationCost * ((1 - surface.penetration)^2 + hardFloor)
 *                                 / max(0.08, weapon.penetration)
 *
 * energy units, out of a starting budget of 1.0. Worked examples with the
 * numbers below (5.56 rifle, penetration 0.55):
 *   50mm pine plank   (pen .72) -> 0.30  passes, ~70% energy left
 *   200mm timber beam (pen .72) -> 1.21  stopped
 *   300mm sandbag     (pen .95) -> 0.74  passes, badly slowed
 *   10mm glass        (pen .95) -> 0.02  passes, essentially free
 *   50mm concrete     (pen .35) -> 1.12  stopped
 *   250mm concrete    (pen .35) -> 5.6   stopped cold
 *   8mm sheet steel   (pen .18) -> 0.27  passes
 *   50mm steel plate  (pen .18) -> 1.71  stopped
 * The 7.62 marksman round (0.82) also gets through 50 mm concrete; the 9mm
 * (0.32) gets through wood, sand and glass and nothing else. Nothing on offer
 * defeats a 50 mm steel plate or a structural concrete wall, which is what makes
 * hard cover worth taking.
 */
export const BALLISTICS = {
  gravity: -9.81,             // real gravity, not the arcade WORLD.gravity
  maxRange: 420,
  hitscanVelocity: 620,       // at or above this, the whole flight resolves now
  segmentLength: 48,          // metres per cast segment (sets drop resolution)
  maxSegments: 14,
  dragPerMetre: 0.0011,       // v *= exp(-k * metres)
  minSpeed: 60,

  maxPenetrations: 4,
  penetrationCost: 26,
  hardFloor: 0.05,
  probeDepth: 1.6,            // deepest wall we bother probing for an exit face
  minEnergy: 0.05,
  penDamageTax: 0.82,         // damage penalty per wall crossed, on top of energy
  penDeflect: 0.010,          // radians of tumble imparted by a wall

  ricochetCos: 0.30,          // shallower than ~72.5 deg off normal may deflect
  ricochetMinHardness: 0.42,
  ricochetEnergy: 0.52,
  ricochetSpread: 0.09,
  ricochetDamage: 0.5,

  tracerEvery: 3,             // 1-in-N rounds is a tracer, like real belt loading
  whizbyRadius: 1.9,
  maxRounds: 96,
};

/** Deterministic recoil patterns — generated once, identical every run. */
export function buildRecoilPattern(weapon, shots = 40) {
  const out = [];
  let seed = [...weapon.id].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  const rnd = () => (((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1);
  let pitch = 0, yaw = 0;
  for (let i = 0; i < shots; i++) {
    // Climbs hard for the first third, then drifts into a lateral zig-zag.
    const climb = weapon.recoilKick * (i < shots / 3 ? 1.0 : 0.35);
    pitch += climb * (0.85 + Math.abs(rnd()) * 0.3);
    yaw += weapon.recoilKick * 0.55 * (i < 4 ? rnd() * 0.3 : Math.sin(i * 0.7) + rnd() * 0.4);
    out.push([pitch, yaw]);
  }
  return out;
}
