/**
 * Central tuning surface. Every magic number that affects *feel* or *look* lives
 * here so it can be swept, A/B'd and critiqued without hunting through systems.
 * Units: metres, seconds, radians (unless a name says otherwise).
 */

export const WORLD = {
  gravity: -22.0,          // punchier than real 9.81 — standard FPS convention
  fixedStep: 1 / 120,      // physics tick
  maxSubSteps: 5,
  unitsPerMetre: 1,
};

export const PLAYER = {
  height: 1.78,
  crouchHeight: 1.05,
  radius: 0.34,
  eyeOffset: -0.16,        // eye height below capsule top

  walkSpeed: 4.1,
  sprintSpeed: 6.7,
  crouchSpeed: 2.0,
  adsSpeedScale: 0.42,
  airControl: 0.22,
  groundAccel: 62,
  airAccel: 14,
  groundFriction: 11,
  stopSpeed: 1.6,

  jumpVelocity: 6.4,
  coyoteTime: 0.11,
  jumpBuffer: 0.13,

  slideImpulse: 8.2,
  slideDuration: 0.85,
  slideFriction: 2.6,
  mantleMaxHeight: 1.35,
  mantleDuration: 0.42,
  leanAngle: 0.30,
  leanOffset: 0.42,

  stepHeight: 0.42,
  maxSlope: 0.72,          // cos of max walkable angle

  maxHealth: 100,
  regenDelay: 4.2,
  regenRate: 26,
};

export const CAMERA = {
  fovBase: 80,             // vertical-equivalent, set as vFOV from hFOV 103
  fovSprint: 86,
  fovAds: 55,
  fovLerp: 11,
  near: 0.02,
  far: 900,

  sensitivity: 0.0022,
  adsSensScale: 0.62,
  pitchClamp: 1.54,

  bobFreq: 8.4,
  bobAmpWalk: 0.021,
  bobAmpSprint: 0.043,
  bobRoll: 0.012,
  swayAmount: 0.028,
  swaySmooth: 9.0,
  landPunch: 0.085,
  stepShake: 0.004,
};

export const RENDER = {
  // Internal render scale; TAA/SMAA runs at this, UI at native.
  resolutionScale: 1.0,
  shadowCascades: 4,
  shadowMapSize: 2048,
  shadowDistance: 120,
  shadowBiasBase: -0.0004,

  exposure: 1.05,
  bloomIntensity: 0.62,
  bloomThreshold: 0.86,
  bloomSmoothing: 0.28,

  aoIntensity: 1.35,
  aoRadius: 1.9,
  aoDistanceFalloff: 1.0,

  vignette: 0.32,
  chromaticAberration: 0.0009,
  filmGrain: 0.028,
  motionBlurSamples: 12,
  motionBlurIntensity: 0.55,

  fogDensity: 0.0075,
  volumetricSteps: 48,
  volumetricIntensity: 0.55,
};

export const QUALITY = {
  // Named presets the settings menu + shoot rig can select.
  cinematic: { resolutionScale: 1.0, shadowMapSize: 2048, volumetricSteps: 64, aoQuality: 'high' },
  high:      { resolutionScale: 1.0, shadowMapSize: 2048, volumetricSteps: 40, aoQuality: 'high' },
  medium:    { resolutionScale: 0.85, shadowMapSize: 1536, volumetricSteps: 24, aoQuality: 'medium' },
  low:       { resolutionScale: 0.7, shadowMapSize: 1024, volumetricSteps: 0, aoQuality: 'off' },
};

/** Surface types drive impact FX, decals, audio and ballistic penetration. */
export const SURFACES = {
  concrete: { hardness: 0.85, penetration: 0.35, sparks: 0.05, dust: 1.0, colour: 0x9a9691 },
  metal:    { hardness: 1.00, penetration: 0.18, sparks: 1.00, dust: 0.15, colour: 0xb8bcc2 },
  wood:     { hardness: 0.45, penetration: 0.72, sparks: 0.00, dust: 0.65, colour: 0x8a6a44 },
  dirt:     { hardness: 0.25, penetration: 0.85, sparks: 0.00, dust: 1.30, colour: 0x6b5b47 },
  sand:     { hardness: 0.15, penetration: 0.95, sparks: 0.00, dust: 1.60, colour: 0xb8a179 },
  glass:    { hardness: 0.30, penetration: 0.95, sparks: 0.00, dust: 0.30, colour: 0xcfe3ea, shatters: true },
  fabric:   { hardness: 0.10, penetration: 0.90, sparks: 0.00, dust: 0.45, colour: 0x6d6455 },
  flesh:    { hardness: 0.20, penetration: 0.80, sparks: 0.00, dust: 0.00, colour: 0x8a2a22 },
  water:    { hardness: 0.05, penetration: 0.60, sparks: 0.00, dust: 0.00, colour: 0x2a4048 },
};

export const TIME_OF_DAY = {
  dawn:    { elevation: 6,  azimuth: 96,  turbidity: 5.2, tint: 0xffb27a, intensity: 2.6, ambient: 0.42 },
  morning: { elevation: 26, azimuth: 118, turbidity: 3.4, tint: 0xfff0d8, intensity: 4.1, ambient: 0.52 },
  midday:  { elevation: 62, azimuth: 172, turbidity: 2.4, tint: 0xfffaf0, intensity: 5.2, ambient: 0.60 },
  golden:  { elevation: 11, azimuth: 252, turbidity: 4.6, tint: 0xffa955, intensity: 3.4, ambient: 0.44 },
  dusk:    { elevation: 2,  azimuth: 266, turbidity: 6.0, tint: 0xff7a48, intensity: 1.9, ambient: 0.34 },
  night:   { elevation: -12, azimuth: 300, turbidity: 2.0, tint: 0x8fa8d8, intensity: 0.32, ambient: 0.14 },
  overcast:{ elevation: 40, azimuth: 160, turbidity: 9.0, tint: 0xc9d2dc, intensity: 1.7, ambient: 0.78 },
};

export const DEBUG = {
  showColliders: false,
  showNavmesh: false,
  freeCam: false,
};
