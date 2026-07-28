/**
 * OWNER: postfx agent.
 *
 * Tuning that belongs to the post stack alone. Everything *shared* still lives
 * in src/core/Constants.js — this file only holds numbers that describe how the
 * composite chain interprets those shared values, plus the per-time-of-day look
 * (EV compensation + colour grade), which is authored art direction rather than
 * a global engine constant.
 *
 * Nothing here is read by another system, so tweaking it cannot break anyone.
 */

/**
 * Ground-truth ambient occlusion (GTAO) — horizon-search visibility integral,
 * half resolution, temporally filtered. See GTAOPass.js for the estimator.
 *
 * `radius` is deliberately *not* read from RENDER.aoRadius (1.9m): a 2m radius
 * integrates whole rooms and produces the flat, low-contrast term that made
 * round-3 look like it had no AO at all. 0.6m is the contact scale — the one
 * that actually binds an object to the floor it stands on.
 */
export const GTAO = {
  /**
   * World-space search radius, metres. 0.65 is the contact scale: the band that
   * binds an object to the surface it stands on. Round 4 ran 0.85 to widen the
   * band, which did nothing useful — the band was invisible for reasons that had
   * nothing to do with its width (see `power` below) and the extra radius only
   * cost horizon-search coherence.
   */
  radius: 0.65,
  /**
   * Shaping of the raw visibility integral before it is applied:
   *   ao = 1 − (1 − visibility^power) · intensity
   *
   * ── ROUND 5 ROOT CAUSE ────────────────────────────────────────────────────
   * This constant, and `multiBounce` below, were both documented, both declared
   * as `uniform float` in AOApplyEffect's fragment shader, and **neither was
   * ever added to the uniform map or referenced in the shader body**. GLSL
   * strips unused uniforms silently, so nothing failed and nothing warned. The
   * shader was computing the unshaped `ao = 1 − (1 − visibility) · intensity`
   * and then handing the result to a *full-strength* multi-bounce remap, which
   * gives most of it straight back. An AO-only debug capture of
   * `material-closeup` showed the visibility term living almost entirely in
   * 0.88–1.0, i.e. at most a 12% multiply before multi-bounce lifted it again.
   * That is the whole of "there is effectively no ambient occlusion".
   *
   * The power is the term that turns a narrow band into a readable one: it
   * leaves an open surface alone (0.99^3 = 0.97) while taking a junction down
   * hard (0.85^3 = 0.61, 0.70^3 = 0.34).
   *
   * 3.0 rather than the 2.0 that was documented and never applied, because the
   * geometry in this level is *open*: an AO-only capture shows the raw integral
   * living in 0.85–1.0 almost everywhere, because the contacts here are 4cm base
   * plates and kerbs in a yard rather than the deep interior corners the
   * textbook value assumes. A power of 2 on a 0.90 input is a 19% multiply. A
   * power of 3 is 27%, and paired with the contact-shadow fix below that is what
   * finally reads as grounding.
   */
  power: 3.0,
  intensity: 0.95,
  /** Directional slices per pixel; each marches both ways from the centre. */
  slices: 3,
  /** Horizon-search steps per direction. 3 slices × 2 dirs × 6 = 36 taps. */
  steps: 6,
  /** Screen-space clamp on the search radius, in half-res pixels. */
  minRadiusPx: 3.0,
  maxRadiusPx: 96.0,
  /** Falloff band as a fraction of the radius: samples fade out over the tail. */
  falloffStart: 0.55,

  /**
   * Screen-space contact shadow, marched toward the sun.
   *
   * ── ROUND 5 FIX ───────────────────────────────────────────────────────────
   * A `?aodebug=2` capture showed this channel almost entirely white: the term
   * meant to bind objects to the ground under a hard sun was contributing
   * essentially nothing. The cause was the march *resolution*, not its strength.
   * 0.90m over 12 steps is a 7.5cm stride, and under a low golden-hour sun the
   * ray is nearly horizontal, so 7.5cm of world travel is ~20 half-res pixels
   * per step at close range. The march stepped clean over every 4cm kerb, base
   * plate and crate lip in the frame — precisely the occluders it exists to
   * catch — and the `diff < thickness` window then rejected what few hits landed
   * on the far side of a jump.
   *
   * 0.35m over 14 steps is a 2.5cm stride. Anything longer than ~0.4m is the
   * shadow map's job anyway; the whole purpose of this term is the last few
   * centimetres that a 6cm-per-texel cascade plus its depth bias cannot resolve.
   */
  contactLength: 0.35,   // metres
  contactSteps: 14,
  contactThickness: 0.16,
  contactStrength: 0.95,

  /** Temporal filter. Blend weight while the camera moves; 1/n while still. */
  movingAlpha: 0.20,
  historySamples: 8,

  /**
   * How much of a pixel's energy is treated as direct sun (and therefore
   * protected from ambient occlusion). 0 = AO multiplies everything, which is
   * wrong under a hard sun; 1 = AO never touches a lit surface.
   *
   * ── ROUND 6 ───────────────────────────────────────────────────────────────
   * 0.46 was a compromise struck when the AO term was believed to be invisible:
   * it let occlusion paint over direct sunlight to buy back some contrast. Now
   * that the term is measured (an aodebug=5 capture reads a mean multiplier of
   * 0.74 across a column base, p25 0.56) the compromise costs more than it buys,
   * and it is the wrong shape: ambient occlusion multiplies *indirect* light,
   * and a sunlit concrete face at golden hour is 70–85% direct.
   *
   * 0.70 is that physical share. It reads as *more* grounding, not less, because
   * a contact band is by definition where the sun does not reach: the shadowed
   * side of a junction keeps its full occlusion while the open sunlit floor two
   * centimetres away keeps its full brightness, which is exactly the contrast
   * that makes an object look like it is resting on something.
   */
  directProtect: 0.70,
  /**
   * How much of GTAO's albedo-aware multi-bounce remap to apply. At 1.0 it
   * lifts a 0.5 occlusion on bright concrete back to 0.65, which is physically
   * right and visually far too weak for this image; 0.45 keeps the
   * hue-preserving behaviour (occlusion on a rusted drum stays red rather than
   * going to soot) without giving the contrast back.
   *
   * This was dead until round 5 — see the note on `power`. The shader applied
   * the remap at full strength. Trimmed to 0.38 for round 6 alongside the
   * `directProtect` change: with the occlusion now confined to the ambient share
   * there is less of it in flight, so less of it can be handed back.
   */
  multiBounce: 0.38,
  /** Colour a fully occluded pixel converges to — crevices lose the blue sky. */
  occludedTint: [0.020, 0.021, 0.030],
  /** Extra occlusion where the bent normal has swung away from the sky. */
  skyBias: 0.30,
  /** Depth tolerance (metres per metre of distance) for the bilateral upsample. */
  upsampleTolerance: 0.02,
};

/**
 * Bloom.
 *
 * ── ROUND 5 ROOT CAUSE ──────────────────────────────────────────────────────
 * The chain fed an *unbounded* HDR buffer into a thresholded mip chain and then
 * added the result. Every term downstream of that is bounded — ACES rolls off,
 * the LUT is a [0,1] cube — but the addition itself is not, so the amount of
 * light bloom can inject scales linearly with the brightest emitter in frame.
 * The muzzle flash sits several hundred times above middle grey, so its mip-0
 * contribution alone was tens of stops over white; every mip in the chain
 * carried it, and the 6-level upsample smeared that over a third of the frame.
 * Nothing about the *threshold* caused that — a threshold decides what blooms,
 * not how much energy it is allowed to contribute. The missing term was a
 * ceiling on the bloom source.
 *
 * `sourceClamp` is that ceiling, applied inside the luminance/threshold pass so
 * it touches the bloom source only and never the frame: a 400-radiance flash
 * and a 6-radiance one produce the *same* peak glow, and the difference between
 * them survives in the unclamped scene buffer underneath. That is what makes
 * the glow compact with a visible falloff instead of a white disc, and it is
 * why this is robust for any bright emitter rather than tuned to one flash.
 */
export const BLOOM = {
  /** RENDER.bloomIntensity is the artistic 0..1 dial; this is the physical scale. */
  intensityScale: 0.46,   // 0.62 * 0.46 ≈ 0.29
  /**
   * Scene-referred linear luminance at which a pixel starts to bloom. Middle
   * grey lands near 0.14 pre-exposure at the golden stop, so 1.15 is ~8× middle
   * grey: sunlit concrete does not bloom, a specular glint and a lamp filament
   * do.
   */
  threshold: 1.15,
  smoothing: 0.42,
  /**
   * Hard ceiling on the bloom *source* radiance, per channel, after
   * thresholding. Not on the frame — see the note above.
   */
  sourceClamp: 5.0,
  radius: 0.55,           // tighter tent → the glow falls off inside ~5% of frame height
  levels: 6,              // 6-mip down/upsample chain with a 13-tap tent filter
};

/**
 * Firefly clamp — the spatial half of the specular-antialiasing fix.
 *
 * A sub-pixel specular highlight lands on one texel and produces a value one to
 * three orders of magnitude above its neighbours. TAA cannot remove it: the
 * neighbourhood variance clip is computed from a 3×3 window that *contains* the
 * firefly, so the firefly widens its own clip box and passes through. And the
 * weapon is composited after the TAA resolve (it has no valid motion vectors),
 * so on the viewmodel there is no temporal filtering at work at all — which is
 * exactly why the densest speckle in `combat.png` is on the gun.
 *
 * A single pixel cannot be a real specular: real speculars are several pixels
 * across because the BRDF lobe is continuous. So a pixel is limited to a
 * multiple of the brightest *line* running through it — the estimator lives in
 * FireflyClampEffect — which removes isolated texels and dither clusters and
 * leaves genuine highlights, whose lines are bright too, untouched.
 */
export const FIREFLY = {
  /**
   * Ceiling as a multiple of the *supported* neighbourhood (see the estimator in
   * FireflyClampEffect). 1.9 is roughly the steepest luminance step a continuous
   * specular lobe can make across one pixel at 1080p; anything steeper is
   * aliasing.
   */
  ratio: 1.9,
  /**
   * Absolute floor on the ceiling, in scene-referred linear. Below this the
   * clamp is not allowed to act at all.
   *
   * ── ROUND 6 ROOT CAUSE ────────────────────────────────────────────────────
   * This was 1.6 — about eight times middle grey — on the reasoning that a lone
   * bright pixel in a dark room is a light source rather than a firefly. That
   * reasoning is sound for emitters and wrong for aliasing. A `?fireflydebug=1`
   * capture measures the speckle on the weapon receiver in the combat frame in
   * the **0.15–0.4 scene-linear** band: it is a dark surface catching an
   * 11°-elevation sun, so the aliased texels are bright *relative to the
   * surface* and dim in absolute terms. Every one of them took the
   * `l <= uFloor` early-out, which is the whole of "the clamp is in the chain
   * and the speckle is still there".
   *
   * The measured scale of this scene, at the point in the chain where this pass
   * runs (scene-referred, pre-exposure — the meter multiplies by ~1.3–2.6
   * afterwards):
   *
   *     sunlit concrete   median 0.125   max 0.25
   *     open sky          median 0.26    p95 0.39
   *     receiver base     median 0.055
   *     receiver speckle  p90 0.15 · p99 0.22 · p99.9 0.39 · max 1.48
   *
   * So 1.6 was thirteen times the brightest sunlit surface in the frame. 0.10 is
   * below the speckle and above the shadow noise, which is the band this term
   * has to separate; it also keeps the clamp out of the deep shadows, where
   * neighbour *ratios* are large for reasons that have nothing to do with
   * aliasing. Real emitters are protected by the ratio test — their neighbours
   * are bright too — not by this floor.
   */
  floor: 0.10,
  /**
   * How much plain neighbourhood *max* to mix back into the support term. Pure
   * support is a morphological opening and is very slightly too eager on a
   * genuine two-pixel glint; a little of the max is headroom for one. It has to
   * stay small: in a dense dither field the max is another firefly, and at 0.15
   * the field pulls its own ceiling up by two thirds.
   */
  keep: 0.10,
  /** Divisor for the ?fireflydebug views, so 255 means this much luminance. */
  debugScale: 2.0,
};

/**
 * Depth of field. Gameplay DoF is *off*: an FPS that blurs the mid-ground costs
 * the player target acquisition, and round-3's chain had a mis-specified focus
 * distance that blurred the near field at hipfire — the single worst readability
 * defect in the build.
 *
 * What remains is a physically derived ADS-only near-field falloff. A 35mm lens
 * at f/5.6 focused 30m out has essentially no far-field circle of confusion, and
 * that is exactly the point: the numbers below are a real lens, not a dial.
 */
export const DOF = {
  fStop: 5.6,
  /** 35mm-format sensor, so focal length follows from the ADS vertical FOV. */
  sensorHeightMM: 24.0,
  /** Reticle metering clamp, metres. */
  minFocus: 1.2,
  maxFocus: 140.0,
  /** Hard circle-of-confusion clamps, in pixels at 1080p. */
  maxFarCoCPx: 2.0,
  maxNearCoCPx: 4.5,
  /** Below this the pass early-outs per pixel. */
  minCoCPx: 0.6,
  /** ADS progress at which the pass switches on at all. */
  engageThreshold: 0.06,
};

export const MOTION_BLUR = {
  maxSamples: 12,
  /** Screen-space cap so a fast 180° flick cannot smear the whole frame. */
  maxVelocity: 0.055,
  /**
   * Below this the pass is disabled outright. Round-3 used 0.0004 UV — smaller
   * than one pixel — so the TAA jitter itself kept the pass permanently on and
   * smeared every frozen screenshot. One pixel of camera motion is the floor.
   */
  minVelocity: 0.0022,
};

export const TAA = {
  /**
   * Halton(2,3) sub-pixel positions, ±0.5px. 16 rather than 8: the jitter cycle
   * length is what a *static* frame converges to, and 16 positions halve the
   * residual stair-step on the catwalk lattice and the handrail stanchions —
   * sub-pixel geometry whose coverage a 8-sample set quantises visibly. It costs
   * nothing; only the alpha floor changes.
   */
  sampleCount: 16,
  /** History weight while the camera is moving. */
  movingAlpha: 0.10,
  /** Variance-clip tolerance in YCoCg: tight while moving, loose while still. */
  clipGammaMoving: 1.05,
  clipGammaStatic: 2.60,
  /** Extra luma-only clamp width; keeps thin bright geometry from ghosting. */
  lumaClip: 1.25,
};

/**
 * Physical auto-exposure. The metering runs on the GPU as a log-average
 * luminance reduction, so there is no readback stall and no frame of lag.
 */
export const EXPOSURE = {
  /** Middle-grey key value in scene-referred linear: 18% grey. */
  key: 0.18,
  /** Adaptation rate, stops per second. Eyes open faster than they close. */
  adaptUp: 2.6,
  adaptDown: 1.4,
  /** Auto-exposure may deviate from the look's nominal stop by ±this many stops. */
  authority: 1.0,
  /** Metering weights: centre-weighted, and the sky is held down. */
  centreWeight: 0.72,
  skyRejection: 0.55,
  /** Luminance clamp before the log, guards a black or blown frame. */
  minLuminance: 0.0015,
  maxLuminance: 40.0,
};

export const LENS = {
  /**
   * Chromatic aberration is a *lens edge* artifact — zero in the centre.
   *
   * ── ROUND 6 ───────────────────────────────────────────────────────────────
   * caScale was 2.4, which with RENDER.chromaticAberration = 0.0032 puts the
   * red/blue split at 0.5 · 0.0032 · 2.4 ≈ 0.0038 UV — **7px at 1920 in the
   * corners, ~5px halfway out**. That is two to three times what a real fast
   * prime does and it is enough to paint a visible green/magenta fringe along
   * every sunlit edge of the catwalk truss on the left of the combat frame:
   * thin bright geometry against sky is exactly the worst case, because the
   * three channels are sampled from three different sides of a one-pixel edge.
   * The fringing reads as an artifact, not as glass.
   *
   * 1.3 puts the corner split at ~2.6px and the mid-frame split under 2px, which
   * is still visible as a lens signature on a hard highlight and no longer
   * separable into coloured pixels on a rail.
   */
  caEdgePower: 3.2,
  caScale: 1.3,          // multiplies RENDER.chromaticAberration
  vignetteStart: 0.42,
  vignetteEnd: 1.06,
  dirtAmount: 0.42,
  dirtTiles: 1.0,
  // Grain cell size in pixels: 1/0.55 ≈ 1.8px fine octave, 1/0.19 ≈ 5.3px coarse.
  // Anything finer than ~1.5px aliases into a shimmering dot crawl.
  grainScaleHi: 0.55,
  grainScaleLo: 0.19,
  /** Grain lives in the shadows and midtones, never in the highlights. */
  grainShadowGain: 1.25,
  grainHighlightGain: 0.30,
  /**
   * Contrast-adaptive sharpening. WebGL2 exposes no per-texture LOD bias, so
   * the -0.5 mip bias a TAA pipeline normally uses to recover texture sharpness
   * is not available to us; CAS at the composite recovers it instead, and
   * unlike a mip bias it cannot re-introduce aliasing (the amplitude is driven
   * by local contrast, so flat regions are left alone).
   */
  casSharpness: 0.62,
};

/**
 * The texture LOD bias a TAA pipeline wants, published as a seam.
 *
 * PostFX cannot apply this itself. A mip bias is a property of the *sampler
 * call* inside a material's fragment shader, and PostFX's shaders only ever
 * sample non-mipmapped fullscreen buffers — there is nothing here to bias.
 * WebGL2 also exposes no global sampler LOD bias state (EXT_texture_lod_bias
 * does not exist in WebGL), so it cannot be set on the renderer either. The only
 * place it can be applied is `texture(map, uv, MIP_BIAS)` inside the material
 * shaders, which belong to MaterialForge.
 *
 * PostFX therefore publishes the value it wants, on its own side of the seam:
 * `ctx.require('postfx').mipBias` and the `postfx:mipbias` event, both emitted
 * at init. Whoever owns material sampling can consume it; until then the
 * sharpness recovery is CAS alone.
 */
export const MIP_BIAS = -0.5;

export const SHAKE = {
  /** Trauma decays linearly; displacement follows trauma². */
  decay: 1.55,
  maxOffset: 0.020,      // fraction of screen height
  maxRoll: 0.030,        // radians
  /** Frequency falls as the shake dies — that is what reads as "impact", not noise. */
  freqHot: 27.0,
  freqCold: 9.0,
  zoom: 0.045,
};

export const HURT = {
  decay: 1.9,
  innerRadius: 0.18,
  outerRadius: 0.86,
  colour: [0.62, 0.028, 0.020],
  maxStrength: 0.92,
};

/**
 * Per-time-of-day look: an EV offset for the meter plus a grade baked into a
 * 32³ LUT at init.
 *
 * The grade is an ASC-style lift / gamma / gain rig, evaluated in
 * display-referred sRGB *after* ACES:
 *
 *     c = (gain − lift)·c + lift          per channel — lift owns the shadows,
 *                                         gain owns the highlights, and the two
 *                                         are independent by construction
 *     c = c ^ (1/gamma)                   per channel — midtone balance only
 *     contrast about pivot → toe → split tone → banded saturation →
 *     highlight crosstalk → black point
 *
 * There is deliberately no global `balance` multiply any more. A per-channel
 * gain on the *whole* signal is exactly the "flat global tint" defect: it warms
 * the shadows by the same ratio as the sun, so the frame reads as an orange
 * (or blue) sheet of acetate laid over the image. Warm highlights with cool
 * shadows is what a real golden hour does, and it can only be expressed as
 * gain ≠ lift.
 */
const NEUTRAL = {
  lift: [0.000, 0.000, 0.000],
  gain: [1.000, 1.000, 1.000],
  gamma: [1.000, 1.000, 1.000],
  contrast: 1.06,
  pivot: 0.435,
  shadowTint: [-0.006, 0.000, 0.012],
  shadowAmt: 1.0,
  highTint: [0.008, 0.004, -0.006],
  highAmt: 1.0,
  satShadow: 0.96,
  satMid: 1.05,
  satHigh: 0.88,
  crosstalk: 0.14,
  toe: 0.020,
  blackPoint: 0.010,
};

export const LOOKS = {
  dawn: {
    nominal: 1.05,
    ev: 0.10,
    grade: {
      ...NEUTRAL,
      lift: [0.006, 0.014, 0.036],
      gain: [1.052, 1.000, 0.930],
      gamma: [1.000, 0.995, 0.985],
      contrast: 1.07,
      shadowTint: [-0.010, -0.002, 0.020],
      highTint: [0.018, 0.008, -0.010],
      satMid: 1.10,
      toe: 0.028,
      blackPoint: 0.013,
    },
  },
  morning: {
    nominal: 0.74,
    ev: -0.05,
    grade: {
      ...NEUTRAL,
      lift: [0.004, 0.010, 0.026],
      gain: [1.032, 1.000, 0.960],
      contrast: 1.07,
      shadowTint: [-0.008, -0.001, 0.016],
      highTint: [0.014, 0.006, -0.008],
      satMid: 1.07,
      toe: 0.024,
      blackPoint: 0.011,
    },
  },
  midday: {
    nominal: 0.64,
    ev: -0.10,
    grade: {
      ...NEUTRAL,
      lift: [0.000, 0.008, 0.026],
      gain: [1.012, 1.000, 0.992],
      contrast: 1.11,
      pivot: 0.46,
      shadowTint: [-0.010, -0.002, 0.018],
      highTint: [0.008, 0.005, -0.002],
      satMid: 1.04,
      satHigh: 0.86,
      toe: 0.022,
      blackPoint: 0.010,
    },
  },
  golden: {
    // The signature look. Cool shadows, neutral mids, warm highlights — the
    // separation is the whole point, so gain and lift pull in opposite
    // directions and gamma stays at 1.
    nominal: 1.24,
    ev: 0.16,
    grade: {
      ...NEUTRAL,
      lift: [0.002, 0.014, 0.042],
      gain: [1.075, 1.000, 0.888],
      gamma: [1.000, 1.000, 1.010],
      contrast: 1.08,
      pivot: 0.42,
      shadowTint: [-0.014, -0.003, 0.026],
      highTint: [0.026, 0.010, -0.014],
      satShadow: 0.92,
      satMid: 1.09,
      satHigh: 0.90,
      crosstalk: 0.18,
      toe: 0.030,
      blackPoint: 0.012,
    },
  },
  dusk: {
    nominal: 1.45,
    ev: 0.22,
    grade: {
      ...NEUTRAL,
      lift: [0.004, 0.016, 0.054],
      gain: [1.085, 0.988, 0.900],
      contrast: 1.06,
      pivot: 0.40,
      shadowTint: [-0.016, -0.004, 0.034],
      highTint: [0.030, 0.009, -0.016],
      satShadow: 0.90,
      satMid: 1.11,
      satHigh: 0.92,
      crosstalk: 0.20,
      toe: 0.030,
      blackPoint: 0.014,
    },
  },
  night: {
    // Night is not "everything blue": moonlight is cool in the *highlights*,
    // and the shadows go neutral-black with a little residual sky in them.
    nominal: 3.3,
    ev: 0.35,
    grade: {
      ...NEUTRAL,
      lift: [0.008, 0.016, 0.032],
      gain: [0.905, 0.955, 1.055],
      gamma: [1.030, 1.020, 1.000],
      contrast: 1.08,
      pivot: 0.32,
      shadowTint: [-0.004, 0.002, 0.020],
      highTint: [0.004, 0.010, 0.022],
      satShadow: 0.70,
      satMid: 0.88,
      satHigh: 0.78,
      crosstalk: 0.10,
      toe: 0.018,
      blackPoint: 0.016,
    },
  },
  overcast: {
    // Flat light is the trap: neutral grading turns it into grey soup. The fix
    // is *more* contrast and *more* saturation, not a colour cast.
    nominal: 1.02,
    ev: -0.05,
    grade: {
      ...NEUTRAL,
      lift: [0.000, 0.006, 0.020],
      gain: [1.010, 1.000, 1.014],
      contrast: 1.15,
      pivot: 0.46,
      shadowTint: [-0.012, -0.004, 0.018],
      highTint: [0.010, 0.008, 0.000],
      satShadow: 1.00,
      satMid: 1.18,
      satHigh: 0.94,
      toe: 0.022,
      blackPoint: 0.010,
    },
  },
};

export const DEFAULT_LOOK = LOOKS.midday;
