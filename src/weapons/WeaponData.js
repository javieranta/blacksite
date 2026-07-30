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
 * VIEWMODEL GEOMETRY — one entry per weapon id, consumed by
 * `viewmodel/Weapon.js`. Metres, in weapon space: bore along -Z, +X right,
 * origin at the centre of the magwell.
 *
 * ─── WHY THIS TABLE EXISTS ────────────────────────────────────────────────
 *
 * Three weapons have been switchable since round 5 — keys 1/2/3 already changed
 * the ammo, the RPM, the recoil pattern and the handling — and all three
 * rendered as the same carbine, because `ViewModel.init` called `buildWeapon()`
 * once and `weapon:switch` only reset the reload timer. A player pressing 2 saw
 * the name change and the gun not, which is why "give me a smaller gun" was
 * filed as a missing feature for a weapon that was already in the build.
 *
 * ─── THE TWO INVARIANTS, AND WHY THEY ARE NOT NEGOTIABLE ──────────────────
 *
 * The gloved hands in `viewmodel/Hands.js` are solved against TWO surfaces:
 * the pistol grip (`GRIP` / `GRIP_SEC`) and the handguard-plus-rail outline
 * (`HG_SEC`), and that file is owned by another agent. Every finger joint sits
 * exactly one half-thickness off those sections, walked by chord length. Move
 * either section and the fingers float or sink — a defect that took six rounds
 * to remove the first time.
 *
 * So every weapon here declares:
 *   • the SAME pistol grip and lower receiver. Real weapon families share a
 *     lower; this one shares it because the firing hand is welded to it.
 *   • the SAME handguard cross-section (38 mm octagon on a 30 mm bore) and the
 *     SAME rail height (railY 0.0560). Only the handguard's LENGTH varies.
 *   • nothing bolted to the handguard between z = -0.150 and z = -0.075, which
 *     is where the support hand's four rows and its thumb live. The SMG has no
 *     accessory rail stub and no QD socket for exactly this reason: its
 *     handguard is too short to carry them clear of the fingers.
 *
 * Everything else — receiver length and section, barrel, muzzle device, stock,
 * magazine, optic and the hip pose — is per weapon, and that is enough to make
 * the three silhouettes measurably different (see tools/loadoutcheck.mjs).
 *
 * Overall length, muzzle anchor to buttpad:
 *   WRAITH-9    357 mm     LANCET MK4  718 mm     VK-7  556 mm
 */
export const VIEWMODEL = {
  ar_vector: {
    boreY: 0.0300, upperY: 0.0335, upperW: 0.0400, upperH: 0.0450,
    upperZ0: -0.0620, upperZ1: 0.1520,
    railY: 0.0560, railZ0: -0.2050, railZ1: 0.1500,
    hgZ0: -0.2050, hgZ1: -0.0600,
    // `z0` is the muzzle end of the plain barrel; the device hangs off it.
    bar: { r0: 0.0092, r1: 0.0102, z0: -0.2960, z1: -0.1980, gasY: 0.0424, gasZ: -0.2178 },
    dev: { r: 0.0132, len: 0.0380, teeth: 20, ports: 3 },
    acc: { stub: [-0.1900, -0.1420], stop: -0.1660, qd: -0.1500 },
    cover0: -0.1700, iron0: -0.1780,
    mag: { w: 0.0272, h: 0.0560, len: 0.1275, curve: 0, rows: 3, sp: 0.0230 },
    stock: {
      x: 0, y: 0.0300, z: 0.1320, ry: 0, zk: 1, hk: 1,
      tube: true, cheek: true, fold: false, riser: 0,
    },
    optic: {
      rIn: 0.0120, wall: 0.0024, depth: 0.0160, rise: 0.0330, z: -0.0620,
      relief: 0.0820, shadeIn: 0.0134, shadeOut: 0.0154, bell: 0, pupil: 0.0125,
      vig: [0.0125, 0.0290], cross: 0,
    },
    pose: { hip: [0.1850, -0.1790, -0.6150], rot: [0.0450, 0.2450, 0.0900] },
  },

  /**
   * WRAITH-9 — the compact. Everything that can be shortened is: a 104 mm
   * handguard against the carbine's 145, a 52 mm barrel behind a stubby
   * birdcage, a 164 mm receiver, no gas system at all (it is a blowback 9 mm,
   * so the gas block and tube are simply absent — a real difference a player
   * can point at), a curved 9 mm magazine, and a stock that is FOLDED against
   * the left flank rather than extended. The fold is what removes 88 mm of
   * silhouette in one move, and it folds LEFT because the first-person camera
   * sits 313 mm to the left of the bore and would never see a right-side fold.
   */
  smg_wraith: {
    boreY: 0.0300, upperY: 0.0322, upperW: 0.0368, upperH: 0.0418,
    upperZ0: -0.0560, upperZ1: 0.1120,
    railY: 0.0560, railZ0: -0.1560, railZ1: 0.1100,
    hgZ0: -0.1560, hgZ1: -0.0520,
    bar: { r0: 0.0084, r1: 0.0092, z0: -0.2020, z1: -0.1500, gasY: 0, gasZ: 0 },
    dev: { r: 0.0108, len: 0.0260, teeth: 16, ports: 3 },
    // No stub and no QD socket: on a 104 mm handguard both would land under the
    // support hand's fingers. The handstop moves to the front lip, where it is
    // below the bore and clear of every digit.
    acc: { stub: null, stop: -0.1480, qd: null },
    cover0: -0.1460, iron0: -0.1530,
    mag: { w: 0.0262, h: 0.0420, len: 0.1360, curve: 0.155, rows: 3, sp: 0.0230 },
    stock: {
      x: -0.0215, y: 0.0300, z: 0.1120, ry: -2.90, zk: 0.86, hk: 0.92,
      tube: false, cheek: false, fold: true, riser: 0,
    },
    optic: {
      rIn: 0.0102, wall: 0.0022, depth: 0.0140, rise: 0.0290, z: -0.0560,
      relief: 0.0760, shadeIn: 0.0118, shadeOut: 0.0136, bell: 0, pupil: 0.0110,
      vig: [0.0113, 0.0262], cross: 0,
    },
    pose: { hip: [0.1780, -0.1700, -0.6250], rot: [0.0450, 0.2350, 0.0900] },
  },

  /**
   * LANCET MK4 — the marksman rifle. Longer and heavier everywhere: a 253 mm
   * receiver in a fatter 44 x 50 mm section, a 190 mm handguard, a 130 mm
   * barrel behind a four-port brake, a 20-round 7.62 magazine and a full stock
   * with an adjustable cheek riser. The optic is a 31 mm-bore prism scope with
   * a flared objective bell and an etched crosshair instead of a dot — at 90 mm
   * eye relief its window is 261 px across at 1080p against the carbine's 245.
   */
  dmr_lancet: {
    boreY: 0.0300, upperY: 0.0345, upperW: 0.0440, upperH: 0.0500,
    upperZ0: -0.0750, upperZ1: 0.1780,
    railY: 0.0560, railZ0: -0.2600, railZ1: 0.1760,
    hgZ0: -0.2600, hgZ1: -0.0700,
    bar: { r0: 0.0104, r1: 0.0116, z0: -0.3900, z1: -0.2600, gasY: 0.0430, gasZ: -0.2820 },
    dev: { r: 0.0146, len: 0.0460, teeth: 24, ports: 4 },
    acc: { stub: [-0.2450, -0.1970], stop: -0.2210, qd: -0.2050 },
    cover0: -0.2250, iron0: -0.2330,
    mag: { w: 0.0288, h: 0.0640, len: 0.1480, curve: 0.070, rows: 3, sp: 0.0270 },
    stock: {
      x: 0, y: 0.0300, z: 0.1580, ry: 0, zk: 1.30, hk: 1.10,
      tube: true, cheek: true, fold: false, riser: 0.0170,
    },
    optic: {
      rIn: 0.0155, wall: 0.0030, depth: 0.0320, rise: 0.0360, z: -0.0480,
      relief: 0.0900, shadeIn: 0.0186, shadeOut: 0.0210, bell: 0.0224, pupil: 0.0125,
      vig: [0.0168, 0.0392], cross: 1,
    },
    pose: { hip: [0.1930, -0.1880, -0.6600], rot: [0.0480, 0.2600, 0.0920] },
  },
};

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
