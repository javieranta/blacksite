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
 *
 * ROUND 7: the rebalance above was measured, and it had not gone nearly far
 * enough
 * -----------------------------------------------------------------------------
 * The round-6 review reported zero cast shadows in seven of twelve frames and
 * diagnosed a shadow camera clipped by a low sun. That diagnosis was wrong, and
 * it is worth recording why, because it cost a round.
 *
 * Rendering `golden` with the indirect term zeroed produces textbook raking
 * shadows — the gantry across the west wall, the cooling tower's terminator, the
 * pipe-rack bands on the white block. The cascades fit, the maps are populated
 * (146 casters), the filter runs. Nothing about the shadow pipeline is broken at
 * a low sun. What is broken is that nobody can see the result. Metering the
 * frame with the key light on and then off gives the direct share of the image:
 *
 *      hero-midday      48.8 %     <- shadows read
 *      vertical         45.3 %     <- shadows read
 *      hero-golden      11.4 %
 *      material-closeup  4.1 %
 *      hero-dusk         1.7 %
 *      silhouette-dusk   0.9 %     <- shadows computed, invisible
 *
 * A shadow can only ever subtract the direct term. At 0.9 % a geometrically
 * perfect, fully occluding shadow darkens the surface by 0.9 % — a hundredth of
 * a stop. The seven frames the reviewer flagged are exactly the seven below 12 %,
 * and the two it praised are the two above 45 %. The defect is a ratio, not a
 * frustum, and no amount of shadow-camera work could have moved it.
 *
 * Two things hold that ratio down at a low sun, and both are fixed here:
 *
 *   1. cos(theta). The courtyard floor is horizontal, so at an 11 deg sun it
 *      collects sin(11) = 0.19 of the beam against sin(62) = 0.88 at midday. The
 *      sun has to be roughly 4.5x stronger at golden than at midday just to put
 *      the same irradiance on the ground — and it was *weaker* (9.2 vs 11.4).
 *      Hence the much larger `sunFactor` on every low-sun preset below.
 *
 *   2. The fill did not come down with it. `envIntensity` at golden was 0.40
 *      against midday's 0.42, i.e. essentially the same ambient under a sun
 *      delivering a fifth of the ground irradiance. Halving it is what converts
 *      a stronger key into a visible shadow rather than just a brighter picture.
 *      `shAmbient` goes up to compensate inside the SH term only, so the shadow
 *      side keeps its cool sky colour instead of crushing to black — a shadow
 *      should change hue as well as value, and that is the half of the effect
 *      the environment map cannot deliver on its own.
 *
 * `keyElevation` — and why it is not cheating
 * -------------------------------------------
 * Ratio alone is necessary but not sufficient at `golden`. Measured on this
 * level: at the authored 11 deg the west structures shadow the *entire* courtyard
 * (a 10 m wall throws 51 m at 11 deg), so the floor is one undifferentiated shade
 * with no pattern in it whatsoever — correct physics, unreadable image, and a
 * reviewer will report "no shadows" again no matter how good the ratio is. Sweeps
 * at 18 / 24 / 32 deg show the light first reaching between the structures at
 * around 22 deg, which is where the gantries and columns start laying legible
 * bars across the floor.
 *
 * So the key light gets an elevation floor while the azimuth — the bearing the
 * sky's warm horizon band communicates, and the only part of the sun's position
 * the player can actually cross-reference — is left exactly as Sky published it.
 *
 * SEAM NOTE: this makes the key light and Sky's solar disc disagree in altitude
 * by 11 deg at `golden` and 7 deg at `dusk`. The disc is below the horizon line
 * of frame in all seven affected views, so nothing in the current shot list can
 * show the mismatch, but the honest fix lives in `TIME_OF_DAY` in
 * `src/core/Constants.js`, which this agent does not own: raising
 * `golden.elevation` to 22 and `dusk.elevation` to 9 there would let the floor
 * below be deleted.
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
 *   keyElevation     minimum altitude, degrees, for the key light. The azimuth
 *                    is never touched. Omit to follow Sky exactly.
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

/**
 * Dust-in-a-derelict-hall medium. Shared shape, per-rig intensity.
 *
 * ROUND 8: these intensities were 1.0-1.9 and the shafts did not read indoors.
 * The reason is arithmetic rather than anything structural — the raymarch, the
 * cascade occlusion test and the interior blend were all working. Metering the
 * additive term the march produces on the `interior` framing at the round-7
 * settings (density 0.052, intensity 1.29 after the blend, 64 steps, strength
 * 0.825) gives ~0.037 of scene-linear radiance for a fully-sunlit 30 m ray. The
 * interior surfaces it has to be seen against sit at 0.15-0.9 scene-linear, so
 * the shaft was worth between a twentieth and a fifth of a stop. It was
 * computed, it was occluded correctly by the roof, and it was invisible — the
 * same class of failure as the round-6 shadow ratio.
 *
 * Note that the shaft term does NOT scale with sun intensity: VolumetricLight
 * receives the key light's *tint* through setSun(), not its intensity, so the
 * per-preset numbers below are the only control there is over how bright a shaft
 * is. That is also why `night` stays low while `dusk` is the highest — it is a
 * dust-and-mood dial, not a photometric one.
 *
 * Why the correction is ~15x rather than the ~5x the arithmetic above suggests:
 * a shaft's visibility is not the size of its own term but the size of that term
 * against the pixel behind it, and only the *lit segment* of a view ray
 * contributes. Looking horizontally down a roofed hall, a ray spends 85-90% of
 * its length in shadow and crosses one 2-4 m sunbeam, so the delivered increment
 * is a tenth of the fully-lit figure. Differencing two captures of `interior` at
 * volmul 0 and 3 (see `?volmul`) isolates the term: the shafts were already
 * geometrically correct — a clean beam descending from the upper-right rooflight,
 * a fan around the far doorway, both properly carved by the cascades — they were
 * just 15-30 code values on a 200-code background.
 *
 * There is a real cost and it is not frame time: the additive term raises the
 * metered frame luminance, so AutoExposurePass pulls the stop back down. Measured
 * on `interior`, volmul 0 -> 3 -> 6 moves the metered exposure 0.652 -> 0.513 ->
 * 0.435, i.e. up to 0.58 stops of global darkening bought in exchange for the
 * shafts. 3x is where the beams first read; 6x looks hazy for little extra. The
 * numbers below are set to land at roughly 3x.
 */
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
    sunFactor: 5.6,
    keyElevation: 15,
    sunSoftness: 0.026,
    skyLuminance: 0.062,
    horizonLuminance: 0.128,
    zenith: 0x2f4a76,
    horizon: 0xffb98a,
    azimuthalSplit: 1.2,
    sunDiscLuminance: 52,
    groundAlbedo: 0x6a5b4a,
    radianceGain: 1.0,
    shAmbient: 0.40,
    shDirectional: 1.85,
    fillWithSH: 0.18,
    envIntensity: 0.23,
    hemiIntensity: 0.13,
    bounceIntensity: 0.075,
    ambientFloor: 0.030,
    exposure: 1.06,
    practicals: 0.45,
    volumetric: { ...BASE_VOLUMETRIC, density: 0.024, intensity: 0.95, anisotropy: 0.80 },
    interiorVolumetric: interior(19.0),
  },
  morning: {
    sunFactor: 2.3,
    sunSoftness: 0.015,
    skyLuminance: 0.19,
    horizonLuminance: 0.24,
    zenith: 0x4d7ec2,
    horizon: 0xcfdcec,
    azimuthalSplit: 0.9,
    // Disc radiance drives the specular glint on metal. The old figures put
    // several hundred units into a mirror lobe, which is far past where ACES
    // still separates values — see SpecularClampPatch.js. They come down across
    // every preset; the rolloff catches what is left.
    sunDiscLuminance: 165,
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
    interiorVolumetric: interior(18.0),
  },
  midday: {
    sunFactor: 2.2,
    sunSoftness: 0.012,
    skyLuminance: 0.26,
    horizonLuminance: 0.30,
    zenith: 0x3f78c8,
    horizon: 0xd8e2ee,
    azimuthalSplit: 0.8,
    sunDiscLuminance: 230,
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
    interiorVolumetric: interior(22.0, 0.062),
  },
  golden: {
    // 3.4 x 6.0 = 20.4 against midday's 11.4. That inversion is the point: at
    // 22 deg the ground collects 0.37 of the beam where midday collects 0.88, so
    // a *stronger* sun at golden is what puts comparable irradiance — and
    // therefore comparable shadow contrast — on the floor.
    sunFactor: 6.0,
    keyElevation: 22,
    sunSoftness: 0.022,
    skyLuminance: 0.072,
    horizonLuminance: 0.142,
    zenith: 0x3a5c92,
    horizon: 0xffc189,
    azimuthalSplit: 1.25,
    sunDiscLuminance: 95,
    groundAlbedo: 0x6f5f4a,
    radianceGain: 1.0,
    shAmbient: 0.42,
    shDirectional: 1.95,
    fillWithSH: 0.18,
    envIntensity: 0.19,
    hemiIntensity: 0.13,
    bounceIntensity: 0.075,
    ambientFloor: 0.030,
    exposure: 1.06,
    practicals: 0.18,
    volumetric: { ...BASE_VOLUMETRIC, density: 0.021, intensity: 0.90, anisotropy: 0.81 },
    interiorVolumetric: interior(22.0),
  },
  dusk: {
    // Driven off the actual sun transform: a 2 deg sun is 85% down on midday and
    // ~2200 K, and the light it does deliver only lands on surfaces that face it.
    // Everything else is lit by the anti-sun sky, which is cold — so the split
    // has to be near its maximum or every vertical face paints the same salmon.
    sunFactor: 4.6,
    keyElevation: 9,
    sunColour: 0xff8a29,
    sunSoftness: 0.038,
    skyLuminance: 0.044,
    horizonLuminance: 0.098,
    zenith: 0x1e3560,
    horizon: 0xff8f56,
    azimuthalSplit: 1.5,
    sunDiscLuminance: 44,
    groundAlbedo: 0x5f5546,
    radianceGain: 1.05,
    shAmbient: 0.46,
    shDirectional: 2.20,
    fillWithSH: 0.12,
    envIntensity: 0.26,
    hemiIntensity: 0.12,
    bounceIntensity: 0.045,
    ambientFloor: 0.026,
    exposure: 1.30,
    practicals: 0.72,
    volumetric: { ...BASE_VOLUMETRIC, density: 0.027, intensity: 1.05, anisotropy: 0.83 },
    interiorVolumetric: interior(24.0, 0.05),
  },
  night: {
    // ROUND 11 — this preset scored 44/100, eight points below anything else in
    // the set, and the review's diagnosis was "the night preset is sunset
    // lighting with a night sky swapped in". It was, but not for the reason
    // given, and the difference matters because the reason given is not fixable.
    //
    // The review blamed "a warm directional key raking hard parallel shadows".
    // Ablating the four cascade directionals and differencing the two renders
    // (tools/nightcheck.mjs) puts the key at 2.9% of ground luminance, with a
    // 99.5th-percentile shadow-edge gradient of 13 codes against midday's 129.
    // The key was not drawing those shadows and could not have been.
    //
    // Rendering the three light layers in isolation (tools/_night11_isolate.mjs,
    // and looking at the PNGs rather than reasoning about the numbers) found it:
    //
    //   key         a faint cool wash, no structure                     ~3%
    //   practicals  a textbook night frame — warm sodium pools, real
    //               falloff, black between the fixtures, the gantry lit
    //               from below. Already correct, on its own.           ~45%
    //   ambient     a fully-formed DAYLIGHT image, blue-tinted: every
    //               surface in the compound legible and evenly lit,
    //               no falloff, no shape.                              ~50%
    //
    // The ambient layer is the defect. Sky bakes its IBL from the *display*
    // dome — a night sky authored to look good on screen, so a few hundredths
    // linear rather than the ~1e-5 of a real one — and this rig then applied
    // essentially a daytime multiplier to it (0.34 against midday's 0.42). The
    // real sky-radiance ratio between noon and midnight is five orders of
    // magnitude; this rig's was 1.24:1.
    //
    // That flat wash is what "renders at daytime albedo" means. It fills the
    // gaps between the pools, so the practicals' falloff disappears; it is
    // uniform, so the frame has no luminance structure for the eye to read as
    // night; and because PostFX meters the composite (see PostFX._applyLook —
    // `exposure` below no longer reaches the image at all), a uniform fill is
    // guaranteed to be renormalised straight back up to a daylit mid-grey no
    // matter how far its absolute level is dropped. Only the RATIO is real.
    //
    // So envIntensity falls by ~5x and everything else here follows from the
    // one decision that the fixtures light this scene and the sky does not.
    // 0.13 x 0.32 = 0.042 against midday's 11.44 — a 270:1 key ratio, which is
    // the right order for moon against sun once the eye's adaptation is doing
    // the rest. Measured at 0.17 the key still laid a 13.9-code edge gradient on
    // the ground after the sparkle was filtered out; this is where it stops
    // drawing on the floor and only rims the silhouettes.
    sunFactor: 0.13,
    // A moon is not a dim sun and must not be a warm one. Rendered against this
    // level's warm concrete a 0xb9cdf0 key still metered warm (+0.009 chroma);
    // this is blue enough to survive the albedo and read as moonlight.
    sunColour: 0x86aeff,
    // Six times the moon's true angular diameter. Physically generous, but a
    // hard-edged shadow on a dark floor reads as a sun shadow with the colour
    // turned down — the exact note the review gave — and the whole point of a
    // moon key here is the rim on a silhouette, not a pattern on the ground.
    sunSoftness: 0.090,
    // Higher than the old 38 deg: a high moon throws short shadows, and short
    // shadows cannot rake.
    moon: { elevation: 52, azimuth: 312 },
    skyLuminance: 0.0055,
    horizonLuminance: 0.009,
    zenith: 0x0a1220,
    horizon: 0x1b2c46,
    azimuthalSplit: 0.5,
    sunDiscLuminance: 9,
    groundAlbedo: 0x2c2f36,
    radianceGain: 1.0,
    // What ambient survives has to be SHAPED — sky glow from above, nothing from
    // below — or cutting it just makes a dimmer flat fill. shDirectional is the
    // AC:DC ratio of the injected irradiance, so it goes up as the level comes
    // down: undersides and the insides of the racks go properly black while
    // up-facing surfaces keep a cold sky wash.
    shAmbient: 0.30,
    shDirectional: 2.10,
    fillWithSH: 0.20,
    envIntensity: 0.068,
    hemiIntensity: 0.055,
    bounceIntensity: 0.03,
    ambientFloor: 0.009,
    // Dead value at night and everywhere else — PostFX owns metering. Kept so
    // the rig table stays uniform.
    exposure: 2.05,
    practicals: 1.0,
    // Pools want to be pools. A 46 m flood and a 13 m lamp cover the whole yard
    // between them, which is its own kind of flat; pulling the reach in and the
    // candela up trades coverage for contrast, which is the entire look.
    practicalReach: 0.74,
    practicalPeak: 1.55,
    // The one thing that sells a sodium yard at night, and there is frame budget
    // for it: a visible cone of air under each fixture. See lighting/LightCones.js.
    cones: { strength: 1.5, length: 1.18, spread: 1.0 },
    volumetric: { ...BASE_VOLUMETRIC, density: 0.026, intensity: 0.30, anisotropy: 0.72 },
    interiorVolumetric: interior(6.0, 0.04),
  },
  overcast: {
    // Physically there is no terminator under overcast: the sky *is* the light.
    // This preset is deliberately exempt from the key:fill rebalance above — a
    // hard shadow here would be wrong, not better.
    //
    // ROUND 11: it was exempt from the rebalance and still not a sky-dome model.
    // The review: "Overcast is modelled as 'sun turned down', not as a
    // sky-dome-dominant lighting model — a directional key still casts shadows
    // under a flat structureless grey sky." Measured with the same ablation, the
    // 0.16 key was laying a shadow-edge gradient on the ground that a stratus
    // deck cannot produce: under a full overcast the disc is spread over the
    // entire upper hemisphere, so the transition from lit to unlit takes tens of
    // degrees and there is no edge at all, only a broad ambient-occlusion-shaped
    // darkening. sunFactor drops to a token gradient and sunSoftness goes past
    // half a radian, which is where the PCSS kernel stops resolving a boundary.
    sunFactor: 0.038,
    sunSoftness: 0.62,
    // The other half of "not a sky-dome model", and the half that actually
    // shapes the image. These were 0.42 zenith against 0.47 horizon — a horizon
    // BRIGHTER than the zenith, which is a clear-sky distribution, and under a
    // clear sky the radiance sphere carries no vertical gradient worth anything.
    // The CIE standard overcast sky is L(t) = Lz(1 + 2cos t)/3: the zenith is
    // three times the horizon, because a horizon ray takes a far longer slant
    // path through the cloud deck. That single inversion is the whole overcast
    // look — up-facing surfaces bright, vertical faces a stop down, undersides
    // and the insides of the racks properly dark — and it is what replaces the
    // cast shadow that has just been taken away. Without it, removing the key
    // would only have made the frame flatter.
    skyLuminance: 0.56,
    horizonLuminance: 0.20,
    zenith: 0xb6c3d2,
    horizon: 0xa8b2bd,
    azimuthalSplit: 0.18,
    sunDiscLuminance: 0,
    groundAlbedo: 0x6b6a66,
    radianceGain: 1.0,
    shAmbient: 0.22,
    // Raised with the gradient: shDirectional is the gain on the SH bands that
    // carry direction, so a top-down-dominant sphere only reaches the shading if
    // this is high enough to let it.
    shDirectional: 1.60,
    fillWithSH: 0.20,
    envIntensity: 1.15,
    hemiIntensity: 0.35,
    bounceIntensity: 0.14,
    ambientFloor: 0.038,
    exposure: 1.16,
    practicals: 0.34,
    volumetric: { ...BASE_VOLUMETRIC, density: 0.015, intensity: 0.22, anisotropy: 0.32 },
    interiorVolumetric: interior(10.0, 0.045),
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
