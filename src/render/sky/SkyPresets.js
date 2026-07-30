import * as THREE from 'three';
import { TIME_OF_DAY } from '../../core/Constants.js';

/**
 * OWNER: sky-atmosphere agent.
 *
 * Art direction for the atmosphere. `TIME_OF_DAY` in Constants.js is shared with
 * Lighting and only carries the sun rig (elevation, azimuth, turbidity, tint,
 * intensity, ambient). Everything that is purely *sky* — aerosol load, aerial
 * perspective range, which cloudscape is overhead, how much the image is
 * deliberately pushed away from the physics — lives here so it can be tuned
 * without touching a shared file.
 *
 * Each of the seven presets is a different photograph, not a different colour:
 *   dawn      thin cold light under a heavy mackerel cirrus deck, valley mist
 *   morning   clean air, crisp fair-weather cumulus, deep blue
 *   midday    hard vertical light, few small clouds, longest visibility
 *   golden    warm, aerosol-loaded, big lit cumulus, strong forward glow
 *   dusk      ozone-blue high sky, hot underlit cloud bases, thick low haze
 *   night     moonlit Rayleigh blue, dark cloud silhouettes, stars
 *   overcast  a luminous grey stratus ceiling and no visible sun at all
 */

/** Turbidity -> Mie density, following Preetham's aerosol concentration fit. */
function mieFromTurbidity(t) {
  return Math.max(0.35, (0.6544 * t - 0.651) / 1.31);
}

const D2R = Math.PI / 180;

/**
 * Top-of-atmosphere solar irradiance in the arbitrary radiance units the dome
 * and the fog share. Calibrated (not guessed): it is the value at which the
 * integrated midday zenith lands on ~0.13 linear and the horizon on ~0.85 —
 * the same absolute range the hand-authored gradient this replaced sat in, so
 * PostFX's exposure and Sky.IBL_GAIN stay valid and Lighting does not shift.
 */
const SUN_IRRADIANCE = 3.40;

/** Sky-only overrides, keyed by the TIME_OF_DAY key. */
const ART = {
  dawn: {
    exposure: 1.30, tint: [1.06, 0.98, 1.00], desaturate: 0.06,
    multiScatter: 0.42, mieG: 0.80,
    extinction: 0.0034, extinctionTint: [0.94, 0.96, 1.00],
    hazeHeight: 480, mistHeight: 26, mistGain: 1.05,
    apMieStrength: 0.10, apGain: 1.00, cloudHaze: 0.052,
    cumulus: { coverage: 0.38, softness: 0.42, altitude: 1750, scale: 2050, drift: 5.5, absorption: 1.5, detail: 0.55 },
    cirrus: { coverage: 0.62, altitude: 6400, scale: 5200, drift: 16, brightness: 1.05 },
    sunDisc: 12, star: 0.22, moon: 0.10,
    airglow: [0.00030, 0.00026, 0.00044],
  },
  morning: {
    exposure: 1.06, tint: [1.00, 1.00, 1.02], desaturate: 0.0,
    multiScatter: 0.34, mieG: 0.76,
    extinction: 0.0019, extinctionTint: [0.86, 0.94, 1.00],
    hazeHeight: 620, mistHeight: 34, mistGain: 0.42,
    apMieStrength: 0.07, apGain: 1.00, cloudHaze: 0.070,
    cumulus: { coverage: 0.47, softness: 0.26, altitude: 1500, scale: 1750, drift: 7.0, absorption: 2.3, detail: 0.85 },
    cirrus: { coverage: 0.18, altitude: 6000, scale: 4200, drift: 20, brightness: 0.85 },
    sunDisc: 34, star: 0.0, moon: 0.0,
    airglow: [0, 0, 0],
  },
  midday: {
    exposure: 0.98, tint: [0.98, 0.99, 1.04], desaturate: 0.0,
    multiScatter: 0.30, mieG: 0.74,
    extinction: 0.0014, extinctionTint: [0.80, 0.91, 1.00],
    hazeHeight: 760, mistHeight: 40, mistGain: 0.30,
    apMieStrength: 0.05, apGain: 1.00, cloudHaze: 0.085,
    cumulus: { coverage: 0.39, softness: 0.18, altitude: 1650, scale: 1600, drift: 6.0, absorption: 3.0, detail: 1.0 },
    cirrus: { coverage: 0.10, altitude: 6800, scale: 4600, drift: 22, brightness: 0.75 },
    sunDisc: 46, star: 0.0, moon: 0.0,
    airglow: [0, 0, 0],
  },
  golden: {
    exposure: 1.16, tint: [1.05, 1.00, 0.97], desaturate: 0.0,
    multiScatter: 0.34, mieG: 0.80,
    extinction: 0.0026, extinctionTint: [1.00, 0.95, 0.90],
    hazeHeight: 430, mistHeight: 30, mistGain: 0.80,
    apMieStrength: 0.22, apGain: 1.00, cloudHaze: 0.060,
    cumulus: { coverage: 0.48, softness: 0.30, altitude: 1500, scale: 1980, drift: 5.0, absorption: 2.0, detail: 0.9 },
    cirrus: { coverage: 0.28, altitude: 6200, scale: 4800, drift: 15, brightness: 1.15 },
    sunDisc: 20, star: 0.0, moon: 0.0,
    airglow: [0, 0, 0],
  },
  dusk: {
    exposure: 1.45, tint: [1.06, 0.99, 1.02], desaturate: 0.0,
    multiScatter: 0.34, mieG: 0.82,
    extinction: 0.0031, extinctionTint: [1.00, 0.92, 0.86],
    hazeHeight: 360, mistHeight: 24, mistGain: 1.25,
    apMieStrength: 0.26, apGain: 1.00, cloudHaze: 0.055,
    cumulus: { coverage: 0.44, softness: 0.36, altitude: 1450, scale: 2050, drift: 4.2, absorption: 2.6, detail: 0.8 },
    cirrus: { coverage: 0.50, altitude: 6600, scale: 5000, drift: 13, brightness: 1.30 },
    sunDisc: 9, star: 0.30, moon: 0.16,
    airglow: [0.00036, 0.00030, 0.00050],
  },
  night: {
    exposure: 1.0, tint: [0.92, 0.98, 1.10], desaturate: 0.0,
    multiScatter: 0.55, mieG: 0.78,
    extinction: 0.0021, extinctionTint: [0.90, 0.95, 1.00],
    hazeHeight: 420, mistHeight: 28, mistGain: 0.85,
    apMieStrength: 0.04, apGain: 1.00, cloudHaze: 0.075,
    cumulus: { coverage: 0.34, softness: 0.40, altitude: 1550, scale: 1900, drift: 4.0, absorption: 3.2, detail: 0.7 },
    cirrus: { coverage: 0.14, altitude: 6200, scale: 4400, drift: 12, brightness: 0.55 },
    sunDisc: 0, star: 1.0, moon: 1.0,
    airglow: [0.00042, 0.00036, 0.00058],
  },
  overcast: {
    // ROUND 11 — "a flat structureless grey sky". It was: `overcast: 0.90`
    // blends ninety per cent of the dome toward one constant colour, so whatever
    // cloud form the shader computes survives at a tenth strength and is then
    // desaturated by more than half on top. There is nothing left to see. A real
    // stratus deck is not featureless — it has base texture, thickness variation
    // and a luminance gradient — it is only *low contrast*, which is a different
    // thing and the one the eye still reads as sky rather than as backdrop.
    //
    // So the flat blend comes down to two thirds, the desaturation comes off,
    // and the cloud layer is retuned to be a low overcast deck rather than a
    // heavy cumulus field: near-total coverage, a harder edge profile so the base
    // shows structure, more high-frequency detail, and more absorption so the
    // thicker parts genuinely darken.
    exposure: 1.0, tint: [1.0, 1.0, 1.0], desaturate: 0.38,
    multiScatter: 0.62, mieG: 0.84,
    extinction: 0.0038, extinctionTint: [0.96, 0.98, 1.00],
    hazeHeight: 520, mistHeight: 44, mistGain: 0.55,
    apMieStrength: 0.0, apGain: 1.00, cloudHaze: 0.045,
    overcast: 0.66, overcastTint: [0.94, 0.96, 1.00], overcastLevel: 0.50,
    cumulus: { coverage: 0.95, softness: 0.38, altitude: 820, scale: 1780, drift: 9.0, absorption: 2.5, detail: 0.88 },
    cirrus: { coverage: 0.0, altitude: 7000, scale: 4000, drift: 18, brightness: 0.5 },
    sunDisc: 0, star: 0.0, moon: 0.0,
    airglow: [0, 0, 0],
  },
};

/** Weather is a modifier on top of whatever the time of day already implies. */
export const WEATHER = {
  clear: { cumulus: 1.00, cirrus: 1.00, extinction: 1.00, mist: 1.00, mie: 1.00, tint: [1, 1, 1] },
  hazy: { cumulus: 1.10, cirrus: 1.10, extinction: 1.55, mist: 1.60, mie: 1.35, tint: [1.00, 0.99, 0.98] },
  overcast: { cumulus: 1.60, cirrus: 0.20, extinction: 1.85, mist: 1.70, mie: 1.60, tint: [0.98, 0.99, 1.00] },
  dust: { cumulus: 0.70, cirrus: 0.55, extinction: 2.40, mist: 2.10, mie: 1.90, tint: [1.12, 0.96, 0.78] },
};

export function presetKeyOf(preset) {
  for (const k in TIME_OF_DAY) if (TIME_OF_DAY[k] === preset) return k;
  return null;
}

const _sun = new THREE.Vector3();
const _moon = new THREE.Vector3();

/**
 * Fold a TIME_OF_DAY entry, its art overrides and the current weather into the
 * single flat parameter block Atmosphere / SkyDome / AerialPerspective consume.
 */
export function buildSkyParams(preset, key, weatherKey) {
  const art = ART[key] ?? ART.golden;
  const w = WEATHER[weatherKey] ?? WEATHER.clear;

  const el = preset.elevation * D2R;
  const az = preset.azimuth * D2R;
  _sun.set(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)).normalize();
  // The moon rides the anti-solar point, which puts it high when the sun is
  // well below the horizon — exactly when we need it to light the clouds.
  _moon.copy(_sun).negate();

  const day = THREE.MathUtils.smoothstep(Math.sin(el), -0.14, 0.26);
  const mieScale = mieFromTurbidity(preset.turbidity) * w.mie;

  // Top-of-atmosphere solar irradiance, in the arbitrary radiance units the
  // dome and the fog both work in. Flat spectrum: all of the colour in the
  // final image comes out of the scattering integral, not out of a tint.
  const sunIrr = day > 0.001 ? [SUN_IRRADIANCE, SUN_IRRADIANCE, SUN_IRRADIANCE] : [0, 0, 0];
  const moonScale = art.moon > 0 ? (1 - day) : 0;
  const moonIrr = [0.105 * moonScale, 0.119 * moonScale, 0.162 * moonScale];

  const ext = art.extinction * w.extinction;
  const tint = [
    art.tint[0] * w.tint[0],
    art.tint[1] * w.tint[1],
    art.tint[2] * w.tint[2],
  ];

  return {
    key,
    day,
    sunDir: _sun.clone(),
    moonDir: _moon.clone(),
    sunIrradiance: sunIrr,
    moonIrradiance: moonIrr,

    // --- scattering medium
    mieScale,
    mieG: art.mieG,
    multiScatter: art.multiScatter,
    groundAlbedo: [0.215, 0.198, 0.168],

    // --- grade
    exposure: art.exposure,
    tint,
    desaturate: art.desaturate,
    overcast: (art.overcast ?? 0) * (weatherKey === 'dust' ? 0.5 : 1),
    overcastTint: art.overcastTint ?? [1, 1, 1],
    overcastLevel: art.overcastLevel ?? 1,
    airglow: art.airglow,

    // --- aerial perspective
    extinction: [
      ext * art.extinctionTint[0],
      ext * art.extinctionTint[1],
      ext * art.extinctionTint[2],
    ],
    hazeHeight: art.hazeHeight,
    mistHeight: art.mistHeight,
    mistGain: art.mistGain * w.mist,
    apMieStrength: art.apMieStrength,
    apGain: art.apGain,
    apMaxOpacity: 0.995,
    cloudHaze: art.cloudHaze,

    // --- sky features
    cumulus: {
      ...art.cumulus,
      coverage: THREE.MathUtils.clamp(art.cumulus.coverage * w.cumulus, 0, 1),
    },
    cirrus: {
      ...art.cirrus,
      coverage: THREE.MathUtils.clamp(art.cirrus.coverage * w.cirrus, 0, 1),
    },
    sunDisc: art.sunDisc * (1 - (art.overcast ?? 0)),
    // Stars have to lose to a bright sky, or dawn shows a field over daylight.
    starIntensity: art.star * (1 - day * 0.72),
    moonIntensity: art.moon * (1 - day),
    sunTint: new THREE.Color(preset.tint),
    sunIntensity: preset.intensity,
  };
}
