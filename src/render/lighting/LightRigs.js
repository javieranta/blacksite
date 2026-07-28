import { TIME_OF_DAY } from '../../core/Constants.js';

/**
 * OWNER: lighting agent.
 *
 * A sky preset is not a colour — it is a *light rig*. Each entry below fully
 * reconfigures the sun, the sky radiance that feeds the IBL bake and the
 * spherical-harmonic indirect term, the ground bounce, the practical
 * (artificial) lights, exposure and the volumetric medium. Changing time of day
 * therefore changes the shape of the light, not just its tint.
 *
 * Units:
 *   sunFactor        multiplier applied to TIME_OF_DAY[key].intensity
 *   sunColour        optional override for the key light's tint (hex)
 *   sunSoftness      world metres of penumbra per metre of blocker/receiver
 *                    separation — i.e. the source's angular diameter. Real sun
 *                    is 0.0093; games exaggerate slightly. Read by
 *                    CascadedShadowMap, which trims it further per cascade.
 *   skyLuminance     radiance (linear, arbitrary but consistent) at the zenith
 *   horizonLuminance radiance at the horizon band
 *   zenith           zenith chroma
 *   horizon          chroma of the SUNWARD horizon; the anti-sun horizon is
 *                    derived from the zenith, which is what gives a low sun its
 *                    warm/cold split across the compass
 *   azimuthalSplit   gain on that split (1 = physical-ish)
 *   sunDiscLuminance radiance of the solar disc inside the env bake — drives
 *                    specular glints on metal
 *   groundAlbedo     albedo of the notional ground plane used for the lower
 *                    hemisphere of the radiance model AND the bounce tint
 *   radianceGain     extra gain on the whole radiance model on top of the global
 *                    RADIANCE_GAIN
 *   shAmbient        DC-band gain for the injected SH irradiance. Below 1
 *                    because the environment map already supplies the base
 *                    ambient level.
 *
 * The key:fill ratio, and why these numbers moved
 * -----------------------------------------------
 * Measured on the round-5 build, at `golden`, on the courtyard floor: the
 * environment term supplied 95% of the surface's light and the key light 5%
 * (in-frame linear luminance 0.093 vs 0.0047). At `midday` it was 52/48. In
 * other words the IBL outweighed the sun by 20:1 where physics says roughly 1:1
 * on a horizontal surface at an 11 deg sun, and 5-7:1 the other way on a
 * sun-facing vertical one.
 *
 * That single ratio is why the build had no readable shadows. A shadow can only
 * ever remove the *direct* term, so when direct is 5% of a surface's light, a
 * geometrically perfect, fully-occluding shadow darkens that surface by 5% —
 * about a fifteenth of a stop. It is computed, it is correct, and it is
 * invisible. Cascades, filter width, bias and caster flags were all verified
 * good; none of them could have fixed this.
 *
 * So `sunFactor` goes up and `envIntensity` comes down, together, per preset —
 * roughly a 6-7x swing in the direct:indirect ratio. Two things make that safe:
 *
 *   - PostFX meters the frame (AutoExposurePass), so cutting the fill does not
 *     leave a dark image; it leaves a *contrastier* one at the same key. The
 *     ratio is the part the rig controls and auto-exposure cannot undo.
 *   - `envIntensity` is the same uniform the SH irradiance is scaled by (three
 *     folds scene.environmentIntensity into envMapIntensity, and
 *     IrradiancePatch multiplies by it), so cutting it would flatten the
 *     directional shape too. `shDirectional` is therefore raised alongside:
 *     the AC:DC ratio of the indirect term goes UP, which is what puts cool sky
 *     on the shadow side instead of grey.
 *
 * `bounceIntensity` is scaled by the sun's intensity at the call site, so it is
 * divided back down by the same factor the sun went up — otherwise the ground
 * bounce would refill every shadow it was just made possible to see.
 *   shDirectional    gain on SH bands 1 and 2 — the part that actually carries
 *                    direction and colour transfer. This is the dial that turns
 *                    "one flat fill on every face" into "warm sunward, cold
 *                    shadow side, ground bounce underneath".
 *   fillWithSH       how much of the legacy hemisphere/ambient fill survives once
 *                    the SH patch is live (it is insurance for non-physical
 *                    materials, not the plan)
 *   envIntensity     scene.environmentIntensity
 *   hemiIntensity    secondary hemisphere fill, before fillWithSH
 *   bounceIntensity  fraction of sun irradiance re-emitted upward off the ground
 *   ambientFloor     absolute black-floor insurance, before fillWithSH
 *   exposure         multiplier on RENDER.exposure
 *   practicals       0..1 dimmer for the artificial fixture rig
 *   moon             { elevation, azimuth } — used when the sun is below horizon
 *   volumetric       single-scattering medium in open air
 *   interiorVolumetric  the medium blended toward when the camera is enclosed.
 *                    Interiors carry far more suspended dust and the light
 *                    arriving through a window is not collimated, so density
 *                    goes up and the phase function broadens. Without this a
 *                    hall with three glazed walls shows no shafts at all.
 */

const BASE_VOLUMETRIC = {
  density: 0.016,
  intensity: 0.55,
  anisotropy: 0.76,
  maxDistance: 110,
  heightFalloff: 0.030,
};

/** Dust-in-a-derelict-hall medium. Shared shape, per-rig intensity. */
const interior = (intensity, density = 0.055) => ({
  density,
  intensity,
  anisotropy: 0.52,
  maxDistance: 46,
  heightFalloff: 0.004,
});

/** @type {Record<string, any>} */
export const LIGHT_RIGS = {
  dawn: {
    sunFactor: 2.6,
    sunSoftness: 0.026,
    skyLuminance: 0.075,
    horizonLuminance: 0.15,
    zenith: 0x2f4a76,
    horizon: 0xffb98a,
    azimuthalSplit: 1.05,
    sunDiscLuminance: 70,
    groundAlbedo: 0x6a5b4a,
    radianceGain: 1.0,
    shAmbient: 0.23,
    shDirectional: 1.45,
    fillWithSH: 0.22,
    envIntensity: 0.44,
    hemiIntensity: 0.16,
    bounceIntensity: 0.17,
    ambientFloor: 0.036,
    exposure: 1.06,
    practicals: 0.45,
    volumetric: { ...BASE_VOLUMETRIC, density: 0.024, intensity: 0.95, anisotropy: 0.80 },
    interiorVolumetric: interior(1.6),
  },
  morning: {
    sunFactor: 2.3,
    sunSoftness: 0.015,
    skyLuminance: 0.19,
    horizonLuminance: 0.24,
    zenith: 0x4d7ec2,
    horizon: 0xcfdcec,
    azimuthalSplit: 0.9,
    sunDiscLuminance: 240,
    groundAlbedo: 0x6d6659,
    radianceGain: 1.0,
    shAmbient: 0.21,
    shDirectional: 1.30,
    fillWithSH: 0.22,
    envIntensity: 0.42,
    hemiIntensity: 0.16,
    bounceIntensity: 0.15,
    ambientFloor: 0.036,
    exposure: 1.0,
    practicals: 0.0,
    volumetric: { ...BASE_VOLUMETRIC, density: 0.013, intensity: 0.45 },
    interiorVolumetric: interior(1.35),
  },
  midday: {
    sunFactor: 2.2,
    sunSoftness: 0.012,
    skyLuminance: 0.26,
    horizonLuminance: 0.30,
    zenith: 0x3f78c8,
    horizon: 0xd8e2ee,
    azimuthalSplit: 0.8,
    sunDiscLuminance: 420,
    groundAlbedo: 0x6f6a60,
    radianceGain: 1.0,
    shAmbient: 0.20,
    shDirectional: 1.25,
    fillWithSH: 0.20,
    envIntensity: 0.42,
    hemiIntensity: 0.15,
    bounceIntensity: 0.16,
    ambientFloor: 0.040,
    exposure: 0.98,
    practicals: 0.0,
    volumetric: { ...BASE_VOLUMETRIC, density: 0.009, intensity: 0.30, anisotropy: 0.70 },
    interiorVolumetric: interior(1.5, 0.062),
  },
  golden: {
    sunFactor: 2.7,
    sunSoftness: 0.022,
    skyLuminance: 0.09,
    horizonLuminance: 0.17,
    zenith: 0x3a5c92,
    horizon: 0xffc189,
    azimuthalSplit: 1.1,
    sunDiscLuminance: 130,
    groundAlbedo: 0x6f5f4a,
    radianceGain: 1.0,
    shAmbient: 0.22,
    shDirectional: 1.50,
    fillWithSH: 0.20,
    envIntensity: 0.40,
    hemiIntensity: 0.16,
    bounceIntensity: 0.19,
    ambientFloor: 0.038,
    exposure: 1.06,
    practicals: 0.18,
    volumetric: { ...BASE_VOLUMETRIC, density: 0.021, intensity: 0.90, anisotropy: 0.81 },
    interiorVolumetric: interior(1.7),
  },
  dusk: {
    // Driven off the actual sun transform: a 2 deg sun is 85% down on midday and
    // ~2200 K, and the light it does deliver only lands on surfaces that face it.
    // Everything else is lit by the anti-sun sky, which is cold — so the split
    // has to be near its maximum or every vertical face paints the same salmon.
    sunFactor: 1.15,
    sunColour: 0xff8a29,
    sunSoftness: 0.038,
    skyLuminance: 0.052,
    horizonLuminance: 0.115,
    zenith: 0x1e3560,
    horizon: 0xff8f56,
    azimuthalSplit: 1.35,
    sunDiscLuminance: 55,
    groundAlbedo: 0x5f5546,
    radianceGain: 1.05,
    shAmbient: 0.26,
    shDirectional: 1.85,
    fillWithSH: 0.14,
    envIntensity: 0.55,
    hemiIntensity: 0.15,
    bounceIntensity: 0.15,
    ambientFloor: 0.032,
    exposure: 1.30,
    practicals: 0.72,
    volumetric: { ...BASE_VOLUMETRIC, density: 0.027, intensity: 1.05, anisotropy: 0.83 },
    interiorVolumetric: interior(1.9, 0.05),
  },
  night: {
    // The "sun" light becomes the moon: cool, dim, but present on every
    // silhouette so nothing in frame is unreadable.
    sunFactor: 0.42,
    sunColour: 0xb9cdf0,
    sunSoftness: 0.020,
    moon: { elevation: 38, azimuth: 312 },
    skyLuminance: 0.0055,
    horizonLuminance: 0.009,
    zenith: 0x0a1220,
    horizon: 0x1b2c46,
    azimuthalSplit: 0.5,
    sunDiscLuminance: 9,
    groundAlbedo: 0x2c2f36,
    radianceGain: 1.0,
    shAmbient: 0.26,
    shDirectional: 1.15,
    fillWithSH: 0.30,
    envIntensity: 0.72,
    hemiIntensity: 0.09,
    bounceIntensity: 0.07,
    ambientFloor: 0.018,
    exposure: 2.05,
    practicals: 1.0,
    volumetric: { ...BASE_VOLUMETRIC, density: 0.022, intensity: 0.38, anisotropy: 0.72 },
    interiorVolumetric: interior(0.9, 0.04),
  },
  overcast: {
    // Physically there is no terminator under overcast: the sky *is* the light.
    // This preset is deliberately exempt from the key:fill rebalance above — a
    // hard shadow here would be wrong, not better.
    sunFactor: 0.16,
    sunSoftness: 0.30,
    skyLuminance: 0.42,
    horizonLuminance: 0.47,
    zenith: 0x9fb0c2,
    horizon: 0xc6cfd8,
    azimuthalSplit: 0.22,
    sunDiscLuminance: 0,
    groundAlbedo: 0x6b6a66,
    radianceGain: 1.0,
    shAmbient: 0.22,
    shDirectional: 0.9,
    fillWithSH: 0.20,
    envIntensity: 1.15,
    hemiIntensity: 0.35,
    bounceIntensity: 0.14,
    ambientFloor: 0.038,
    exposure: 1.16,
    practicals: 0.34,
    volumetric: { ...BASE_VOLUMETRIC, density: 0.015, intensity: 0.22, anisotropy: 0.32 },
    interiorVolumetric: interior(1.1, 0.045),
  },
};

const DEFAULT_RIG = LIGHT_RIGS.golden;

/** Recover the preset key from a TIME_OF_DAY object (identity, then value match). */
export function keyOfPreset(preset) {
  if (!preset) return null;
  for (const k in TIME_OF_DAY) if (TIME_OF_DAY[k] === preset) return k;
  for (const k in TIME_OF_DAY) {
    const p = TIME_OF_DAY[k];
    if (p.elevation === preset.elevation && p.azimuth === preset.azimuth && p.tint === preset.tint) return k;
  }
  return null;
}

export function rigFor(key) {
  return LIGHT_RIGS[key] ?? DEFAULT_RIG;
}
