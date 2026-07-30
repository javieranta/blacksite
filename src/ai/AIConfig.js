/**
 * OWNER: ai agent. Tuning surface for the combatants.
 *
 * Constants.js is shared and owned by the core; everything that only the AI
 * cares about lives here so the AI can be swept without touching it.
 * Units: metres, seconds, radians.
 */

export const AI = {
  /* ---------------------------------------------------------------- body --- */
  height: 1.80,               // helmet crown in the bind pose
  eyeHeight: 1.62,
  radius: 0.34,               // soft body radius used for avoidance
  crouchDrop: 0.42,           // pelvis drop when crouched
  /**
   * Hard separation, as a multiple of `radius`.
   *
   * `radius` is the 0.34 m steering cylinder, and it is far too small to be the
   * separation constraint: a man in a bladed fighting stance spans ~0.9 m across
   * his feet and carries a 0.9 m carbine across his front, so two of them at
   * 0.7 m centres have interpenetrating boots and one rifle passing through the
   * other's chest. 3.0 gives 1.02 m — the men still read as a fire team working
   * one piece of cover, without any part of one body inside another.
   *
   * Used by Combatant._deoverlap as a *constraint*, not a steering force.
   */
  separationScale: 3.0,
  /** Seconds between foot-plant ground casts, alternating feet. */
  footProbeInterval: 0.11,

  /* ------------------------------------------------------------ movement --- */
  walkSpeed: 2.05,
  runSpeed: 5.05,
  crouchSpeed: 1.25,
  accel: 9.5,
  turnRate: 7.2,              // rad/s of body yaw
  /** Bladed stance: how far off the aim line the body squares up (radians). */
  bladeAngle: 0.36,
  /**
   * Per-man spread either side of `bladeAngle`, in radians.
   *
   * `bladeAngle` alone is a single number that every engaged combatant adds to
   * the same bearing, so the whole squad ends up on the same facing — the
   * mechanical cause of "ten figures, all squared to camera". 0.42 rad puts the
   * squad anywhere from square-on to bladed 45 degrees. The rifle still tracks
   * the target at any value: SoldierAnim twists the trunk by the difference and
   * solves both arms onto the bore.
   */
  bladeSpread: 0.42,
  strideWalk: 1.42,           // metres of ground travel per full walk cycle
  strideRun: 2.55,
  arriveRadius: 0.42,
  repathInterval: 1.15,
  /** Back-off after A* fails, so an unreachable goal cannot spin the search. */
  repathRetry: 0.55,
  /**
   * A* expansion ceiling. Was 5200 — a quarter of the whole graph, spent
   * proving that an unreachable goal is unreachable. Cover is picked inside
   * 15.5 m and hunts are rarely longer than 40 m, both of which resolve in a few
   * hundred expansions on 1.25 m cells; and since a failed search now falls back
   * to direct steering rather than paralysis, an early give-up degrades to a
   * slightly dumber route instead of a frozen man.
   */
  pathBudget: 1600,

  /* ---------------------------------------------------------- perception --- */
  fov: 2.10,                  // ~120 deg total cone
  sightRange: 78,
  peripheralRange: 26,        // seen inside this radius regardless of facing
  reactionMin: 0.22,
  reactionMax: 0.58,
  losInterval: 0.14,          // per-agent, staggered across the squad
  memoryTime: 7.5,            // seconds a lost target stays "last known"
  alertShareRadius: 44,

  /* -------------------------------------------------------------- combat --- */
  rifleDamage: 13,
  fireRpm: 620,
  burstMin: 3,
  burstMax: 7,
  burstPauseMin: 0.38,
  burstPauseMax: 1.25,
  magSize: 30,
  reloadTime: 2.45,
  /** Base angular error, scaled by range/state. Deliberately generous. */
  spreadBase: 0.022,
  spreadMoving: 0.055,
  spreadSuppressed: 0.09,
  hitChanceNear: 0.42,        // <12m
  hitChanceFar: 0.13,         // >45m
  muzzleFlashIntensity: 7.5,
  /**
   * How far down the bore the flash LIGHT is placed, in metres.
   *
   * FlashPool is physically correct inverse-square, so a light on the muzzle —
   * 0.55 m from the shooter's own chest — delivered ~8x more irradiance to him
   * than to anything he was shooting at. See Combatant._shoot for the full
   * reasoning. 1.05 m keeps the flash lighting the scene in front of the weapon
   * while taking the shooter's own body out of the near field.
   */
  muzzleFlashForward: 1.05,
  engageMax: 62,

  /* --------------------------------------------------------------- cover --- */
  coverSearchRadius: 15.5,
  coverPeekOffset: 0.62,
  peekHoldMin: 0.9,
  peekHoldMax: 2.1,
  coverHoldMin: 0.8,
  coverHoldMax: 2.0,
  coverScoreWeights: { protection: 4.2, distance: -0.09, range: -0.055, ally: -2.4, forward: 0.9 },

  /* --------------------------------------------------------- suppression --- */
  suppressRadius: 1.9,        // how close a round must pass to count
  suppressPerRound: 0.34,
  suppressDecay: 0.42,
  suppressPin: 0.75,          // above this they will not peek

  /* ------------------------------------------------------------ grenades --- */
  grenadeStaticTime: 3.4,     // player must be this stationary
  grenadeStaticDist: 1.7,
  grenadeCooldown: 13.0,
  grenadeMin: 8,
  grenadeMax: 30,
  grenadeFuse: 2.35,
  grenadeDamage: 78,
  grenadeRadius: 5.2,

  /* -------------------------------------------------------------- health --- */
  maxHealth: 100,
  flinchTime: 0.34,

  /* ---------------------------------------------------------------- nav ---- */
  navCell: 1.25,
  navClearance: 1.85,
  navStep: 0.52,              // max height an agent can step up between cells
  navSlope: 0.62,             // min ground-normal.y to be walkable

  /* -------------------------------------------------------------- budget --- */
  squadSize: 9,
  logicHz: 20,                // AI brain rate; animation still runs per frame
};

/**
 * Deterministic per-agent RNG so freeze-frame screenshots are reproducible.
 *
 * THIS WAS THE ROOT CAUSE OF "NINE COPIES OF ONE RIFLEMAN", and it had survived
 * every attempt to fix that defect at the animation layer because the animation
 * layer was never wrong.
 *
 * The previous generator was a bare LCG, `s = (s*1664525 + 1013904223) mod 2^32`,
 * seeded per man with `ordinal * 2654435761`. An LCG is an affine map, so its k-th
 * output is `(a^k * seed + c_k) mod 2^32` — LINEAR in the seed. Seeding it with an
 * arithmetic progression of ordinals therefore makes the k-th draw an arithmetic
 * progression ACROSS THE SQUAD, with a step of `a^k * 2654435761 mod 2^32`. For
 * some k that step is large and the men look varied; for others it is tiny and
 * every man in the section draws almost the same number. Measured on the nine
 * live seeds, draw 24 came out as
 *
 *     0.2374  0.2275  0.2177  0.2079  0.1981  0.1883  0.1785  0.1687  0.1589
 *
 * a constant step of -0.0098. That draw is the per-man blade angle, so the whole
 * squad stood within 0.03 rad of the same facing — the "all squared to camera"
 * note — while the code plainly asked for a spread of +-0.42. Draw 23 was another
 * progression with step -0.0712, and so on for every posture constant in
 * SoldierAnim's persona block. This is exactly why previous rounds could verify
 * that twelve constants "visibly randomised" and still ship one silhouette: they
 * were sampling a ramp, not a distribution.
 *
 * splitmix32 is counter-based — the state advances by a fixed odd increment and is
 * then run through a two-round avalanche — so the correlation between two seeds at
 * the same draw index is destroyed by the mixing rather than preserved by it. Same
 * cost, same determinism, same reproducibility for the shoot rig. Verified over
 * the nine live seeds: draw 24 is now 0.818, 0.165, 0.104, 0.262, 0.935, 0.459,
 * 0.362, 0.452, 0.520.
 */
export function makeRng(seed) {
  let s = (seed | 0) || 1;
  return () => {
    s = (s + 0x9e3779b9) | 0;
    let z = s;
    z ^= z >>> 16;
    z = Math.imul(z, 0x21f0aaad);
    z ^= z >>> 15;
    z = Math.imul(z, 0x735a2d97);
    z ^= z >>> 15;
    return (z >>> 0) / 4294967296;
  };
}
