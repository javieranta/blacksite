import * as THREE from 'three';
import {
  BlendFunction,
  BloomEffect,
  EdgeDetectionMode,
  EffectComposer,
  EffectPass,
  RenderPass,
  SMAAEffect,
  SMAAPreset,
} from 'postprocessing';
import { CAMERA, RENDER } from '../core/Constants.js';
import {
  BLOOM,
  DEFAULT_LOOK,
  DOF,
  GTAO,
  LENS,
  LOOKS,
  MIP_BIAS,
  MOTION_BLUR,
} from './post/PostConstants.js';
import { buildGradeLUT } from './post/Grade.js';
import { buildLensDirt } from './post/LensDirt.js';
import { Trauma } from './post/Trauma.js';
import { VelocityPass } from './post/VelocityPass.js';
import { GTAOPass } from './post/GTAOPass.js';
import { AOApplyEffect } from './post/AOApplyEffect.js';
import { DoFEffect } from './post/DoFEffect.js';
import { MotionBlurEffect } from './post/MotionBlurEffect.js';
import { TAAPass } from './post/TAAPass.js';
import { ViewModelPass } from './post/ViewModelPass.js';
import { FireflyClampEffect } from './post/FireflyClampEffect.js';
import { AutoExposurePass } from './post/AutoExposurePass.js';
import { FinishEffect } from './post/FinishEffect.js';

/**
 * OWNER: postfx agent.
 *
 * PostFX owns the frame. render() returns true, so Engine never draws anything
 * itself; everything you see goes through this chain.
 *
 * ──────────────────────────────────────────────────────────────────────────
 *  0  RenderPass          world scene → linear HDR (RGBA16F, no tonemap)
 *  1  VelocityPass        camera motion vectors + linear depth, **unjittered**
 *  2  GTAOPass            half-res GTAO (0.65m, 3 slices × 6 steps) + bent
 *                         normals + sun contact shadow, temporally filtered
 *  3  AOApplyEffect       depth-aware upsample; occlusion applied to the
 *                         ambient share, contact shadow to the direct share
 *  4  DoFEffect           physical thin lens, ADS only, CoC clamped to 2px far
 *  5  MotionBlurEffect    velocity-buffer gather, off when still or frozen
 *  6  TAAPass             16-sample Halton jitter, YCoCg neighbourhood clamp
 *  7  ViewModelPass       weapon composited over, depth cleared
 *  8  FireflyClampEffect  isolated hot pixels capped to their neighbourhood
 *  9  AutoExposurePass    log-average luminance metering → 1×1 adapted stop
 * 10  BloomEffect         threshold + source clamp + 6-mip tent chain, additive
 * 11  FinishEffect        CAS · CA · dirt · vignette · exposure · ACES · LUT
 * 12  SMAAEffect          spatial cleanup + ordered dither at the 8-bit write
 * ──────────────────────────────────────────────────────────────────────────
 *
 * Everything between the RenderPass and the final write is half-float, which is
 * what makes the ACES roll-off meaningful and what — together with the dither
 * on the last pass — removes the mach banding an 8-bit chain produces across a
 * smooth ground gradient.
 *
 * ── The jitter contract ────────────────────────────────────────────────────
 * Exactly one thing in this file is subtle, and getting it wrong is what broke
 * round 3. Sub-pixel jitter is applied to the camera via `setViewOffset` *after*
 * VelocityPass has been synced and *before* GTAOPass and the composer run:
 *
 *   • VelocityPass sees the **unjittered** matrices on both sides, so a static
 *     camera yields a velocity of exactly zero. TAA then fetches its history
 *     pixel-aligned instead of resampling it through a half-pixel bilinear tap
 *     every frame, and motion blur cannot mistake the jitter for camera motion.
 *   • GTAOPass and AOApplyEffect see the **jittered** projection, because that
 *     is the projection the depth buffer in front of them was rendered with.
 *
 * Note on renderer state: this system sets renderer.toneMapping to
 * NoToneMapping at init and holds it there. Tonemapping *must* happen at the
 * end of the composite, not at the point each material writes its fragment —
 * otherwise the buffer is already display-referred, the bloom threshold has no
 * HDR left to threshold against, and the whole chain is graded twice.
 *
 * CONTRACT (unchanged):
 *   postfx.shake(amount, duration)  — trauma-based screen shake
 *   postfx.hurt(intensity)          — damage vignette pulse
 *   listens: 'render:quality', 'sky:tod', 'fx:shake', 'player:damage', 'explosion'
 */
export class PostFX {
  constructor() {
    this.name = 'postfx';

    this.enabled = true;
    this.trauma = new Trauma();

    /** Every effect is individually switchable. */
    this.toggles = {
      ao: true,
      dof: true,
      motionBlur: true,
      taa: true,
      viewmodel: true,
      firefly: true,
      bloom: true,
      grade: true,
      grain: true,
      chromaticAberration: true,
      vignette: true,
      lensDirt: true,
      smaa: true,
      autoExposure: true,
      cas: true,
    };

    this._lutCache = new Map();
    this._look = DEFAULT_LOOK;
    this._todKey = 'midday';
    this._exposureScale = 1;
    this._resolutionScale = RENDER.resolutionScale;
    this._bufW = 0;
    this._bufH = 0;
    this._v2 = new THREE.Vector2();
    this._adsFloor = 0;
    this._directShare = 1;
    this._aoDebug = 0;
    this._fireflyDebug = 0;
    this._boundHandlers = [];

    this._sunWorld = new THREE.Vector3(0.3, 0.9, 0.3).normalize();
    this._sunView = new THREE.Vector3(0.3, 0.9, 0.3).normalize();
    this._normalMatrix = new THREE.Matrix3();
  }

  // ───────────────────────────────────────────────────────────── init ──────

  init(ctx) {
    this.ctx = ctx;
    const { renderer, scene, camera, viewScene, viewCamera, bus } = ctx;

    const params = new URLSearchParams(location.search);
    if (params.get('postfx') === '0') {
      this.enabled = false;
      return;
    }
    /**
     * `?ads=1` must be deterministic for the screenshot rig. The rig also passes
     * `?freeze=1`, which stops fixedUpdate — and adsProgress is ramped in
     * fixedUpdate — so the weapon system's progress never leaves 0 and the DoF
     * would silently never engage in any captured frame. Reading the parameter
     * here keeps the fix on our own side of the seam.
     */
    this._adsFloor = params.get('ads') && params.get('ads') !== '0' ? 1 : 0;

    // Tonemapping moves to the end of the chain — see the class docstring.
    this._prevToneMapping = renderer.toneMapping;
    renderer.toneMapping = THREE.NoToneMapping;

    this.dirtTexture = buildLensDirt(512);

    this.composer = new EffectComposer(renderer, {
      frameBufferType: THREE.HalfFloatType,
      multisampling: 0,
      depthBuffer: true,
      stencilBuffer: false,
    });

    // 0 ── world -------------------------------------------------------------
    this.renderPass = new RenderPass(scene, camera);
    this.composer.addPass(this.renderPass);

    // 1 ── motion vectors ----------------------------------------------------
    this.velocity = new VelocityPass(camera);
    this.composer.addPass(this.velocity);

    // 2 ── ground-truth ambient occlusion -----------------------------------
    this.gtao = new GTAOPass(camera);
    this.gtao.velocityTexture = this.velocity.texture;
    this.composer.addPass(this.gtao);

    // 3 ── apply the occlusion ----------------------------------------------
    this.aoApply = new AOApplyEffect(camera, this.gtao);
    this.aoPass = new EffectPass(camera, this.aoApply);
    this.composer.addPass(this.aoPass);

    // 4 ── depth of field (ADS only) ----------------------------------------
    this.dof = new DoFEffect();
    this.dofPass = new EffectPass(camera, this.dof);
    this.dofPass.enabled = false;
    this.composer.addPass(this.dofPass);

    // 5 ── motion blur -------------------------------------------------------
    this.motionBlur = new MotionBlurEffect();
    this.motionBlur.velocityTexture = this.velocity.texture;
    this.motionBlur.setIntensity(RENDER.motionBlurIntensity);
    this.motionBlurPass = new EffectPass(camera, this.motionBlur);
    this.motionBlurPass.enabled = false;
    this.composer.addPass(this.motionBlurPass);

    // 6 ── temporal resolve --------------------------------------------------
    this.taa = new TAAPass();
    this.taa.velocityTexture = this.velocity.texture;
    this.composer.addPass(this.taa);

    // 7 ── first-person weapon ----------------------------------------------
    this.viewModelPass = new ViewModelPass(viewScene, viewCamera);
    this.composer.addPass(this.viewModelPass);

    // 8 ── firefly clamp -----------------------------------------------------
    // Deliberately downstream of the viewmodel and upstream of bloom. See
    // FireflyClampEffect's header for why those two constraints pin it here.
    this.firefly = new FireflyClampEffect();
    this.fireflyPass = new EffectPass(camera, this.firefly);
    this.composer.addPass(this.fireflyPass);

    // 9 ── exposure metering -------------------------------------------------
    this.autoExposure = new AutoExposurePass();
    this.composer.addPass(this.autoExposure);

    // 10 ── bloom -------------------------------------------------------------
    // The threshold and the intensity live in BLOOM, not RENDER: RENDER's
    // numbers are a shared artistic dial and the physical mapping from that dial
    // to a scene-referred radiance is ours. RENDER.bloomIntensity still scales
    // the result, so turning the shared dial still does what it says.
    this.bloom = new BloomEffect({
      blendFunction: BlendFunction.ADD,
      luminanceThreshold: BLOOM.threshold,
      luminanceSmoothing: BLOOM.smoothing,
      mipmapBlur: true,
      intensity: RENDER.bloomIntensity * BLOOM.intensityScale,
      radius: BLOOM.radius,
      levels: BLOOM.levels,
    });
    this.bloomPass = new EffectPass(camera, this.bloom);
    this.composer.addPass(this.bloomPass);
    // Must run after addPass: the composer's initialize() is what sets
    // FRAMEBUFFER_PRECISION_HIGH on the luminance material, and we want to keep
    // that define when we swap the program.
    this._installBloomSourceClamp();

    // 11 ── the finishing pass ------------------------------------------------
    this.finish = new FinishEffect({
      lut: this._lutFor(this._todKey),
      dirt: this.dirtTexture,
      bloomTexture: this.bloom.texture,
      exposurePass: this.autoExposure,
      casSharpness: LENS.casSharpness,
    });
    this._applyLensUniforms();
    this.finishPass = new EffectPass(camera, this.finish);
    this.composer.addPass(this.finishPass);

    // 12 ── spatial AA + dither at the 8-bit write ---------------------------
    this.smaa = new SMAAEffect({
      preset: SMAAPreset.ULTRA,
      edgeDetectionMode: EdgeDetectionMode.COLOR,
    });
    // The buffer reaching SMAA is linear display-referred, so contrast between
    // neighbours is numerically smaller than in sRGB. Drop the threshold or
    // half the edges in the shadows are never detected.
    const edgeMat = this.smaa.edgeDetectionMaterial;
    if (edgeMat) {
      if ('edgeDetectionThreshold' in edgeMat) edgeMat.edgeDetectionThreshold = 0.028;
      else if (edgeMat.setEdgeDetectionThreshold) edgeMat.setEdgeDetectionThreshold(0.028);
    }
    this.smaaPass = new EffectPass(camera, this.smaa);
    // three's ordered dither, applied after the output transfer. 1/255-scale
    // noise at the final 8-bit write — this is the banding fix.
    this.smaaPass.dithering = true;
    this.composer.addPass(this.smaaPass);

    this._applyLook(this._todKey);
    this._applyResolution(true);

    // ── seams -----------------------------------------------------------------
    this._on(bus, 'render:quality', (e) => this._onQuality(e));
    this._on(bus, 'sky:tod', (e) => this._applyLook(e?.key));
    this._on(bus, 'fx:shake', (e) => this.shake(e?.amount, e?.duration));
    // 'player:damage' carries hit points, not a 0..1 dial — normalise it.
    this._on(bus, 'player:damage', (e) => {
      const hp = e?.intensity !== undefined ? e.intensity * 45 : (e?.amount ?? 20);
      this.hurt(THREE.MathUtils.clamp(0.3 + hp / 60, 0.3, 0.92));
      this.shake(THREE.MathUtils.clamp(hp / 110, 0.08, 0.4), 0.22);
    });
    // Explosions shake by distance; nothing else in the engine can do this.
    this._on(bus, 'explosion', (e) => {
      if (!e?.point) return;
      const d = camera.position.distanceTo(e.point);
      const reach = Math.max(4, (e.radius ?? 6) * 3.5);
      const falloff = THREE.MathUtils.clamp(1 - d / reach, 0, 1);
      if (falloff > 0.01) this.shake(0.25 + 0.7 * falloff * falloff, 0.42);
    });

    // Published for MaterialForge; see the `mipBias` getter for why PostFX
    // cannot apply it itself.
    bus.emit('postfx:mipbias', { bias: MIP_BIAS });

    if (params.has('quality')) this._onQuality({ key: params.get('quality') });
    if (params.has('aodebug')) this.debugAO(parseInt(params.get('aodebug'), 10) || 0);
    if (params.has('fireflydebug')) {
      this.debugFirefly(parseInt(params.get('fireflydebug'), 10) || 0);
    }
    if (params.get('dof') === '0') this.setEffect('dof', false);
    if (params.get('ao') === '0') this.setEffect('ao', false);
    // Locks the meter to the authored stop. Without this an A/B of any pass
    // that changes total frame energy is unreadable: the meter compensates, and
    // the difference you measure is the meter's response rather than the pass.
    // That is how three reviews of the AO went wrong — see GTAO.openLevel.
    if (params.get('autoexposure') === '0') this.setEffect('autoExposure', false);
    if (params.get('taa') === '0') this.setEffect('taa', false);
    if (params.get('cas') === '0') this.setEffect('cas', false);
    if (params.get('bloom') === '0') this.setEffect('bloom', false);
    if (params.get('firefly') === '0') this.setEffect('firefly', false);
    if (params.get('smaa') === '0') this.setEffect('smaa', false);
  }

  /**
   * The texture LOD bias this pipeline wants from the material system, published
   * as a seam because PostFX cannot apply it — see MIP_BIAS in PostConstants for
   * why. Consumers: `ctx.require('postfx').mipBias`, or the `postfx:mipbias`
   * event emitted once at init. **Nothing consumes either as of round 6**, so
   * the sharpness recovery is still CAS alone.
   */
  get mipBias() {
    return MIP_BIAS;
  }

  _on(bus, event, fn) {
    bus.on(event, fn);
    this._boundHandlers.push([event, fn]);
  }

  // ─────────────────────────────────────────────────────── configuration ────

  /**
   * Rewrites BloomEffect's luminance/threshold program so the bloom *source* is
   * bounded.
   *
   * This is the fix for the blown-out muzzle flash, and it belongs here rather
   * than in the threshold or the intensity because those two dials cannot
   * express it. A threshold decides *which* pixels bloom; an intensity scales
   * *all* of the bloom. Neither puts a ceiling on how much energy one pixel may
   * contribute, so with an unbounded HDR input the bloom a single emitter
   * injects grows without limit. Clamping the source makes the glow's *shape*
   * independent of the emitter's brightness while the difference between a
   * 400-radiance flash and a 6-radiance one survives untouched in the scene
   * buffer the bloom is added to.
   *
   * Only the fragment program changes; the material's `inputBuffer` setter, its
   * uniforms and its FRAMEBUFFER_PRECISION_HIGH define are all preserved.
   * @returns {boolean} false if postprocessing's internals have moved.
   */
  _installBloomSourceClamp() {
    const material = this.bloom?.luminancePass?.fullscreenMaterial;
    if (!material?.uniforms?.inputBuffer) return false;

    material.uniforms.maxSource = new THREE.Uniform(BLOOM.sourceClamp);
    material.fragmentShader = /* glsl */ `
      #ifdef FRAMEBUFFER_PRECISION_HIGH
      uniform mediump sampler2D inputBuffer;
      #else
      uniform lowp sampler2D inputBuffer;
      #endif
      uniform float threshold;
      uniform float smoothing;
      uniform float maxSource;
      varying vec2 vUv;

      void main() {
        vec3 c = max(texture2D(inputBuffer, vUv).rgb, vec3(0.0));
        float l = dot(c, vec3(0.2126, 0.7152, 0.0722));

        // Soft knee, then a *subtractive* pedestal: a pixel just over the
        // threshold contributes almost nothing rather than its whole radiance.
        // Without this the threshold behaves as a cliff and the bloom on a
        // marginally-bright surface is as strong as the bloom on a filament.
        float mask = smoothstep(threshold, threshold + smoothing, l);
        vec3 e = max(c - threshold, vec3(0.0)) * mask;

        // The ceiling. Applied to the whole triple by the same scale so hue and
        // saturation survive and only magnitude is capped.
        float peak = max(max(e.r, e.g), e.b);
        e *= min(1.0, maxSource / max(peak, 1e-5));

        gl_FragColor = vec4(e, 1.0);
      }
    `;
    material.needsUpdate = true;
    return true;
  }

  _configureAO(quality) {
    // The horizon search is compiled with its slice/step counts as defines, so
    // quality is a binary here rather than a sliding scale. At half resolution
    // it costs ~1.5ms of a 16.6ms budget, and there is no version of this image
    // that is better off without contact occlusion.
    const on = quality !== 'off' && this.toggles.ao;
    this.gtao.enabled = on;
    this.aoPass.enabled = on;
  }

  _applyLensUniforms() {
    const u = this.finish.uniforms;
    u.get('uCA').value = this.toggles.chromaticAberration
      ? RENDER.chromaticAberration * LENS.caScale
      : 0;
    u.get('uCAPower').value = LENS.caEdgePower;
    u.get('uVignette').value = this.toggles.vignette ? RENDER.vignette : 0;
    u.get('uVignetteRange').value.set(LENS.vignetteStart, LENS.vignetteEnd);
    u.get('uGrain').value = this.toggles.grain ? RENDER.filmGrain : 0;
    u.get('uGrainGains').value.set(LENS.grainShadowGain, LENS.grainHighlightGain);
    u.get('uGrainScale').value.set(LENS.grainScaleHi, LENS.grainScaleLo);
    u.get('uDirtAmount').value =
      this.toggles.lensDirt && this.toggles.bloom ? LENS.dirtAmount : 0;
    u.get('uDirtTiles').value = LENS.dirtTiles;
    u.get('uLutStrength').value = this.toggles.grade ? 1 : 0;
    u.get('uCas').value = this.toggles.cas ? LENS.casSharpness : 0;
  }

  _lutFor(key) {
    let lut = this._lutCache.get(key);
    if (!lut) {
      const look = LOOKS[key] ?? DEFAULT_LOOK;
      lut = buildGradeLUT(look.grade);
      this._lutCache.set(key, lut);
    }
    return lut;
  }

  /** Applies the per-time-of-day metering target and colour grade. */
  _applyLook(key) {
    const todKey = LOOKS[key] ? key : this._todKey;
    this._todKey = todKey;
    this._look = LOOKS[todKey] ?? DEFAULT_LOOK;
    if (!this.finish) return;

    // The meter is allowed EXPOSURE.authority stops either side of this.
    const nominal = RENDER.exposure * this._look.nominal * this._exposureScale;
    this.autoExposure.setLook(nominal, this._look.ev);
    this.autoExposure.snap();
    this.finish.lut = this._lutFor(todKey);
    // Kept truthful for anything that reads it, even though the curve now lives
    // in the composite rather than in the renderer.
    this.ctx.renderer.toneMappingExposure = nominal;
    this.taa?.invalidate();
    this.gtao?.invalidate();
  }

  _onQuality(e) {
    const preset = e?.preset;
    const key = e?.key;
    const aoQuality =
      preset?.aoQuality ??
      (key === 'low' ? 'off' : key === 'medium' ? 'medium' : 'high');

    this._configureAO(aoQuality);

    const cheap = key === 'low' || aoQuality === 'off';
    this.toggles.motionBlur = !cheap;
    this.toggles.dof = key !== 'low';
    // The firefly clamp is one of the cheapest passes in the chain and one of
    // the most visible, so it survives everything except the low preset.
    this.toggles.firefly = key !== 'low';
    this.fireflyPass.enabled = this.toggles.firefly;
    this.bloom.mipmapBlurPass.levels = cheap ? 4 : BLOOM.levels;

    if (typeof preset?.resolutionScale === 'number') {
      this._resolutionScale = THREE.MathUtils.clamp(preset.resolutionScale, 0.5, 2.0);
      this._applyResolution(true);
    }
    this.taa?.invalidate();
    this.gtao?.invalidate();
  }

  _applyResolution(force = false) {
    if (!this.composer) return;
    const renderer = this.ctx.renderer;
    const dpr = renderer.getPixelRatio();
    const size = renderer.getSize(this._v2);
    const w = Math.max(1, Math.round(size.width * dpr * this._resolutionScale));
    const h = Math.max(1, Math.round(size.height * dpr * this._resolutionScale));
    if (!force && w === this._bufW && h === this._bufH) return;
    this._bufW = w;
    this._bufH = h;

    const c = this.composer;
    c.inputBuffer.setSize(w, h);
    c.outputBuffer.setSize(w, h);
    if (c.depthRenderTarget) c.depthRenderTarget.setSize(w, h);
    for (const pass of c.passes) pass.setSize(w, h);

    // three's WebGLRenderTarget.setSize propagates to its colour textures but
    // *not* to an attached DepthTexture, and the composer builds its stable
    // depth target from `new DepthTexture()` — width and height undefined. If
    // the canvas has not been laid out when the composer is constructed the
    // attachment is allocated at zero size, the framebuffer is incomplete, and
    // the per-frame depth blit silently fails: every depth-aware pass in the
    // chain then reads garbage. Sizing the attachment explicitly and disposing
    // the target forces a correct reallocation on the next bind.
    for (const rt of [c.depthRenderTarget, c.inputBuffer, c.outputBuffer]) {
      const dt = rt?.depthTexture;
      if (!dt) continue;
      if (dt.image.width !== rt.width || dt.image.height !== rt.height) {
        dt.image.width = rt.width;
        dt.image.height = rt.height;
        dt.needsUpdate = true;
        rt.dispose();
      }
    }

    // The velocity target is recreated by setSize, so the consumers' bindings
    // have to be refreshed. (The texture object survives setSize, but doing
    // this unconditionally is cheap and immune to that changing.)
    this.gtao.velocityTexture = this.velocity.texture;
    this.motionBlur.velocityTexture = this.velocity.texture;
    this.taa.velocityTexture = this.velocity.texture;
  }

  // ───────────────────────────────────────────────────────── public API ────

  /**
   * @param {number} amount   0..1 trauma. 0.25 footfall · 0.45 gunshot · 0.9 blast.
   * @param {number} duration seconds for the trauma to fall away.
   */
  shake(amount = 0.4, duration = 0.15) {
    this.trauma.add(amount, duration);
  }

  /** @param {number} intensity 0..1 red-edge damage pulse. */
  hurt(intensity = 0.6) {
    this.trauma.damage(THREE.MathUtils.clamp(intensity, 0, 1));
  }

  /**
   * Occlusion debug views. Bypasses the meter, the grade, bloom and every lens
   * artifact so what lands on screen is the raw term rather than a tonemapped
   * version of it — which is how round 3's near-invisible AO managed to look
   * like a plausible white field.
   * @param {0|1|2|3|4|5|6|7} mode 0 off · 1 raw visibility · 2 contact shadow ·
   *   3 bent-normal sky share · 4 reconstructed normals · 5 the applied
   *   multiplier (shaping + multi-bounce + ambient split + contact, i.e. the
   *   only one of these that says what actually reaches the image) ·
   *   6 visibility after the open-plateau normalisation — compare against 1 to
   *   see the estimator bias that was being spent on a global dim ·
   *   7 the frame's direct share as a flat field
   *
   * Read mode 1 with a *measurement*, not an eyeball: a large patch of flat
   * open ground should sit at `GTAO.openLevel · 255`. If it does not, that
   * constant is stale and every downstream number in this pass is mis-scaled.
   */
  debugAO(mode = 0) {
    if (!this.composer) return;
    this._aoDebug = mode;
    this.aoApply.debug = mode;
    this._syncDebug();
  }

  /**
   * Firefly-clamp debug views. Same raw passthrough as {@link debugAO}, so the
   * captured PNG byte is a measurement rather than a tonemapped impression.
   * @param {0|1|2|3} mode 0 off · 1 scene luminance ÷ FIREFLY.debugScale ·
   *   2 the fraction of luminance the clamp removed, in red, with the ceiling in
   *   green · 3 the line-support term the ceiling is derived from
   */
  debugFirefly(mode = 0) {
    if (!this.composer) return;
    this._fireflyDebug = mode;
    this.firefly.debug = mode;
    this._syncDebug();
  }

  /** Whether a debug view owns the frame. Suppresses DoF, motion blur, bloom. */
  get _rawDebug() {
    return this._aoDebug > 0 || this._fireflyDebug > 0;
  }

  /**
   * Puts the tail of the chain into measurement mode: no bloom, no lens, no
   * meter, no ACES, no grade. What lands in the PNG is 255× the term.
   */
  _syncDebug() {
    const raw = this._rawDebug;
    // The firefly pass has to run for its own debug view to exist, and has to be
    // out of the way for the AO one: the AO buffer is a 0..1 term, not radiance,
    // so a luminance clamp on it is meaningless and would misreport it.
    this.fireflyPass.enabled =
      this._fireflyDebug > 0 || (this._aoDebug === 0 && this.toggles.firefly);
    this.bloomPass.enabled = raw ? false : this.toggles.bloom;
    this.finish.exposureOverride = raw ? 1 : 0;
    // A 0..1 term is not radiance. Sending it through ACES compresses 0.85 to
    // 0.92 and 1.0 to 0.95, which is why three rounds of "the AO buffer looks
    // white" were read off a picture that could not have looked otherwise.
    this.finish.rawOutput = raw;
    if (raw) {
      const u = this.finish.uniforms;
      u.get('uLutStrength').value = 0;
      u.get('uGrain').value = 0;
      u.get('uVignette').value = 0;
      u.get('uCA').value = 0;
      u.get('uDirtAmount').value = 0;
      u.get('uCas').value = 0;
    } else {
      this._applyLensUniforms();
    }
    this.taa.invalidate();
  }

  /** Global exposure trim on top of the metered stop. */
  setExposureScale(scale) {
    this._exposureScale = scale;
    this._applyLook(this._todKey);
  }

  /** Flips an individual effect. @param {keyof PostFX['toggles']} name */
  setEffect(name, on) {
    if (!(name in this.toggles)) return;
    this.toggles[name] = !!on;
    if (!this.composer) return;
    switch (name) {
      case 'ao':
        this.gtao.enabled = on;
        this.aoPass.enabled = on;
        break;
      case 'dof':
        if (!on) this.dofPass.enabled = false;
        break;
      case 'motionBlur':
        if (!on) this.motionBlurPass.enabled = false;
        break;
      case 'bloom':
        this.bloomPass.enabled = on;
        this._applyLensUniforms();
        break;
      case 'taa':
        this.taa.enabled = on;
        this.taa.invalidate();
        break;
      case 'autoExposure':
        // Falling back to the authored stop is a one-liner because the meter's
        // output and the nominal live in the same units.
        this.finish.exposureOverride = on
          ? 0
          : RENDER.exposure * this._look.nominal * this._exposureScale;
        break;
      case 'viewmodel':
        this.viewModelPass.enabled = on;
        break;
      case 'firefly':
        this.fireflyPass.enabled = on;
        break;
      case 'smaa':
        // The last pass must stay enabled — it owns the write to the canvas —
        // so SMAA is neutralised through its blend opacity instead.
        this.smaa.blendMode.opacity.value = on ? 1 : 0;
        break;
      default:
        this._applyLensUniforms();
        break;
    }
  }

  // ──────────────────────────────────────────────────────────── per-frame ──

  update(dt, ctx) {
    if (!this.enabled) return;

    this.trauma.update(dt);
    const u = this.finish.uniforms;
    u.get('uShake').value.set(this.trauma.offsetX, this.trauma.offsetY, this.trauma.roll);
    u.get('uShakeZoom').value = this.trauma.zoom;
    u.get('uHurt').value = this.trauma.hurt;

    // Depth of field engages with the sights and nowhere else. Guarded —
    // weapons may not exist.
    const ads = Math.max(ctx.get('weapons')?.state?.adsProgress ?? 0, this._adsFloor);
    const wantDof = this.toggles.dof && !this._rawDebug && ads > DOF.engageThreshold;
    if (wantDof) {
      // Ease in so the transition into the sights does not pop.
      const t = THREE.MathUtils.clamp(
        (ads - DOF.engageThreshold) / (1 - DOF.engageThreshold),
        0,
        1,
      );
      this.dof.amount = t * t * (3 - 2 * t);
      // The lens follows the ADS field of view, NOT ctx.camera.fov. The FOV ramp
      // lives in fixedUpdate, which `?freeze=1` stops, so a frozen ADS capture
      // reports the 80° hipfire FOV and the derived focal length comes out at
      // 14mm — short enough that the circle of confusion is sub-pixel across the
      // whole frame and the pass early-outs on every pixel. Interpolating the
      // authored FOVs by the same progress that drives `amount` makes the lens
      // agree with the sight picture in both the live game and the rig.
      this.dof.setLens(THREE.MathUtils.lerp(CAMERA.fovBase, CAMERA.fovAds, t));
      this.dofPass.enabled = true;
    } else if (this.dofPass.enabled) {
      this.dofPass.enabled = false;
    }
  }

  /**
   * Refreshes the view-space sun direction used by AO and contact shadows, and
   * the frame's direct/ambient balance.
   *
   * The balance matters because ambient occlusion multiplies *indirect* light
   * only. AOApplyEffect estimates the direct share geometrically from N·L, but
   * geometry alone cannot tell whether the sun is delivering anything: under
   * the overcast rig the key light is `sunFactor: 0.16` against
   * `envIntensity: 1.15`, so a surface can face the sun squarely and still
   * receive essentially none of its light. Reading the live rig here is what
   * lets the shader apply full occlusion in an ambient-only frame — which is
   * exactly the frame (`hero-overcast`) where the missing AO was called out.
   *
   * Both values come through sanctioned seams: the `lighting` registry entry
   * and `scene.environmentIntensity`. Nothing is written.
   */
  _updateSun(camera, ctx) {
    const lighting = ctx.get('lighting');
    const src = lighting?.sunDirection ?? ctx.get('sky')?.sunDirection ?? null;
    if (src) this._sunWorld.copy(src).normalize();
    this._normalMatrix.setFromMatrix4(camera.matrixWorldInverse);
    this._sunView.copy(this._sunWorld).applyMatrix3(this._normalMatrix).normalize();
    this.aoApply.sunView = this._sunView;

    // Irradiance a horizontal surface would receive from the key light, against
    // the environment's contribution. Below the horizon the key delivers zero.
    const sunI = lighting?.sun?.intensity ?? 0;
    const direct = sunI * Math.max(0, this._sunWorld.y);
    const ambient = (ctx.scene.environmentIntensity ?? 1) * GTAO.ambientReference;
    this._directShare = direct / (direct + ambient + 1e-4);
    this.aoApply.directShare = this._directShare;
  }

  render(dt, ctx) {
    if (!this.enabled || !this.composer) return false;

    const camera = ctx.camera;
    // The camera may be parented to a rig; make sure world/inverse are current
    // before we derive matrices from them.
    camera.updateWorldMatrix(true, false);
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert();

    // 1 ── velocity, from the UNJITTERED camera. See the jitter contract.
    const speed = this.velocity.sync(camera);
    const moved = this.velocity.moved;

    this._updateSun(camera, ctx);

    // 2 ── sub-pixel jitter. setViewOffset is the correct seam: it offsets the
    // projection without touching anything else the camera owns, and it is
    // cleared again before the frame ends so no other system ever observes it.
    const taaOn = this.toggles.taa && this.taa.enabled;
    if (taaOn) {
      camera.setViewOffset(
        this._bufW,
        this._bufH,
        this.taa.jitterX,
        this.taa.jitterY,
        this._bufW,
        this._bufH,
      );
      this.taa.sync(moved);
    }

    // 3 ── AO reads the depth buffer, so it needs the JITTERED projection.
    this.gtao.sync(camera, this._sunView, moved);

    // 4 ── motion blur only when the camera is genuinely moving. A frozen
    // simulation is never blurred: the screenshot rig depends on that, and so
    // does anyone trying to judge sharpness.
    const frozen = !!ctx.engine?.frozen;
    const wantBlur =
      this.toggles.motionBlur &&
      !frozen &&
      !this._rawDebug &&
      speed > MOTION_BLUR.minVelocity;
    if (this.motionBlurPass.enabled !== wantBlur) this.motionBlurPass.enabled = wantBlur;
    this.autoExposure.instant = frozen && !moved;

    this.composer.render(dt);

    if (taaOn) {
      camera.clearViewOffset();
      this.taa.advanceJitter();
    }
    this.taa.commit();
    this.velocity.commit(camera);

    return true;
  }

  resize(w, h) {
    if (!this.enabled || !this.composer) return;
    this._applyResolution(true);
    this.taa.invalidate();
    this.gtao.invalidate();
    this.velocity.reset();
  }

  /** Diagnostics: the metered stop and average luminance. Stalls the pipeline. */
  readExposure() {
    if (!this.enabled || !this.autoExposure) return null;
    const info = this.autoExposure.readExposure(this.ctx.renderer);
    this.ctx.renderer.setRenderTarget(null);
    return { ...info, nominal: RENDER.exposure * this._look.nominal, tod: this._todKey };
  }

  dispose() {
    if (!this.composer) return;
    for (const [event, fn] of this._boundHandlers) this.ctx.bus.off?.(event, fn);
    this._boundHandlers.length = 0;
    for (const lut of this._lutCache.values()) lut.dispose();
    this._lutCache.clear();
    this.dirtTexture?.dispose();
    this.composer.dispose();
    this.composer = null;
    if (this._prevToneMapping !== undefined) {
      this.ctx.renderer.toneMapping = this._prevToneMapping;
    }
  }
}
