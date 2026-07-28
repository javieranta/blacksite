/**
 * OWNER: player-movement / camera-feel agent.
 *
 * Second-order tuning for the player and the camera rig. The *shared* numbers —
 * anything another system reads — stay in `core/Constants.js` (PLAYER, CAMERA).
 * These are the knobs only this subsystem touches, kept out of the shared file
 * so parallel agents never collide in it.
 *
 * Units: metres, seconds, radians.
 */

export const MOVE = {
  /** Height blend rate when crouching / standing (exponential, 1/s). */
  heightBlend: 11.0,

  /** Downward snap distance while grounded — keeps you glued to stairs/slopes. */
  groundSnap: 0.32,
  /** Downward probe while airborne: only enough to catch a landing. */
  airProbe: 0.06,
  /** Lateral offset of the four outer ground probes, as a fraction of radius. */
  probeSpread: 0.74,

  /** Maximum distance moved per collision substep — the anti-tunnelling limit. */
  substep: 0.12,
  /** Depenetration iterations per substep. */
  pushIterations: 4,

  /** Air steering: how fast the horizontal velocity direction turns (rad/s). */
  airSteer: 3.4,

  /** Slide. */
  slideMinSpeed: 3.9,
  slideCooldown: 0.5,
  slideSteer: 2.4,
  slideExitSpeed: 2.3,
  slideJumpBoost: 1.28,

  /** Mantle. */
  mantleMinRise: 0.42,
  mantleReach: 0.58,
  mantleProbeHeight: 0.85,
  mantleLandInset: 0.22,

  /** Lean. */
  leanRate: 8.0,
  leanClearance: 0.16,

  /** Stride length per gait — the footstep + head-bob cadence driver. */
  strideWalk: 1.16,
  strideSprint: 1.44,
  strideCrouch: 1.02,

  /** Steep-slope slide acceleration (m/s² along the downhill tangent). */
  slopeSlide: 9.0,

  /** Below this, the player is considered to have fallen out of the world. */
  voidMargin: 24,

  /** Landing impact (m/s of downward velocity) that produces a full punch. */
  landFullImpact: 11.0,
  landMinImpact: 1.9,
};

export const CAM = {
  /** Head bob. Vertical dips on the foot plant, lateral swings per stride. */
  bobLateral: 0.62,          // × the vertical amplitude
  bobPhaseLead: 0.12,        // fraction of a step the dip leads the plant by
  bobBlend: 6.5,             // how fast bob amplitude follows gait (1/s)

  /** Mouse-lag sway spring (angular, radians). */
  swayStiffness: 128,
  swayDamping: 0.78,
  // Sway target = -angularVelocity × swayDrive, clamped to CAMERA.swayAmount.
  // Sized so a 5 rad/s turn saturates: slow tracking gives a fraction of a
  // degree, a flick gives the full 1.6°, and it is proportional in between.
  swayDrive: 0.0055,
  swayAdsScale: 0.30,

  /** Roll that leans the camera into a fast turn (also × angular velocity). */
  turnRoll: 0.006,
  turnRollMax: 0.030,
  turnRollSmooth: 7.0,

  /** Recoil spring: fast kick, damped return to the pre-fire aim point. */
  recoilStiffness: 178,
  recoilDamping: 0.58,
  recoilGain: 24.0,
  recoilRollGain: 30.0,
  recoilAdsScale: 0.55,

  /** Landing punch. */
  landStiffness: 96,
  landDamping: 0.70,
  landPitch: 0.55,           // × the dip, in radians

  /** Footstep shake. */
  stepKick: 1.0,
  stepRoll: 0.34,

  /** Trauma shake. */
  traumaDecay: 1.35,
  traumaFreq: 15.0,
  traumaFreqFloor: 0.52,     // frequency multiplier as trauma -> 0
  traumaAngle: 0.052,        // rad at trauma = 1
  traumaOffset: 0.028,       // metres at trauma = 1

  /** Slide camera. */
  slideDrop: 0.10,
  slideTilt: 0.085,
  slideBlend: 9.0,

  /** Mantle camera. */
  mantlePitch: 0.10,
  mantleRoll: 0.055,

  /** FOV spring (critically damped-ish, so it eases in and out). */
  fovStiffness: 92,
  fovDamping: 1.0,

  /** Idle breathing — suppressed entirely while the sim is frozen. */
  breathFreq: 0.62,
  breathAmp: 0.0026,

  /**
   * Viewmodel FOV coupling. The viewmodel is authored at `vmFovBase`; the world
   * FOV moves a lot more than the gun should, so the ratio is compressed by a
   * power curve. At the base world FOV this is exactly 1.0, which is what keeps
   * the hipfire framing byte-identical to the authored pose.
   */
  vmFovBase: 65,
  vmFovExponent: 0.25,
};
