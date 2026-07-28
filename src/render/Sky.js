import * as THREE from 'three';
import { TIME_OF_DAY, RENDER } from '../core/Constants.js';
import { SkyDome } from './sky/SkyDome.js';
import { Atmosphere } from './sky/Atmosphere.js';
import { buildSkyParams, presetKeyOf, WEATHER } from './sky/SkyPresets.js';
import { apUniforms, installAerialPerspective, isAerialPerspectiveInstalled }
  from './sky/AerialPerspective.js';

/**
 * OWNER: sky-atmosphere agent.
 *
 * CONTRACT (read by Lighting, ViewModel and the shoot rig)
 *   sky.sunDirection : THREE.Vector3  normalised, world space
 *   sky.sunColour    : THREE.Color    key-light tint
 *   sky.ambientSH    : THREE.Texture  PMREM of the visible sky, for IBL
 *   sky.skyColour    : THREE.Color    average upper-hemisphere radiance
 *   sky.fogColour    : THREE.Color    horizon in-scatter (fallback / debug)
 *   sky.preset       : the active TIME_OF_DAY entry
 *   listens: 'sky:tod' { key, preset }, 'sky:weather' { key }
 *   emits:   'sky:changed' { preset, direction, colour }
 *
 * HOW IT FITS TOGETHER
 * --------------------
 * 1. `Atmosphere` integrates Rayleigh + Mie + ozone single scattering (plus an
 *    isotropic multiple-scattering term) on the CPU into a 96x48 half-float
 *    radiance table parameterised by (angle-to-sun, elevation). One rebuild per
 *    sky change, ~10-40 ms, never per frame.
 * 2. `SkyDome` samples that table and adds the sharp features analytically: sun
 *    disc with limb darkening, moon, stars, and two cloud decks.
 * 3. `AerialPerspective` rewrites three's fog `ShaderChunk`s so *every* material
 *    in the project — including geometry owned by other systems — evaluates
 *      out = colour * exp(-ext * heightIntegratedMass) + skyLUT(viewDir) * (1-T)
 *    That is the fix for "the far cooling towers are flat white cutouts brighter
 *    than the sky behind them": the in-scatter is now read from the same table
 *    the sky is drawn from, in the view direction, so a silhouette physically
 *    cannot end up brighter than its background.
 * 4. The dome is baked to a PMREM on every change and published as `ambientSH`,
 *    so the image-based lighting is the sky you can see. Its below-horizon rows
 *    hold lit-ground radiance rather than a dark cap — Lighting depends on that
 *    lower hemisphere for the warm bounce that keeps shadow sides off black.
 */

/** Reused so applyPreset never allocates. */
const WHITE = new THREE.Color(1, 0.975, 0.94);

export class Sky {
  constructor() {
    this.name = 'sky';

    this.sunDirection = new THREE.Vector3(0.3, 0.6, 0.4).normalize();
    this.sunColour = new THREE.Color(0xfff0d8);
    this.ambientSH = null;
    this.skyColour = new THREE.Color(0x6f94c4);
    this.fogColour = new THREE.Color(0xa8bccf);
    this.preset = TIME_OF_DAY.golden;
    this.presetKey = 'golden';
    this.weather = 'clear';

    this.atmosphere = new Atmosphere();
    /** Current flat parameter block — see SkyPresets.buildSkyParams. */
    this.params = null;

    this._t = 0;
    this._sunLinear = new THREE.Color();
    this._ambLinear = new THREE.Color();
    this._horizonDir = new THREE.Vector3();
    this._probe = new THREE.Color();
    this._cloudKey = new THREE.Color();
    this._apReady = false;
  }

  init(ctx) {
    this.ctx = ctx;

    // Must happen before the first program is compiled: three resolves #include
    // at compile time and caches programs by material parameters, so a later
    // chunk edit would silently not take. Nothing has rendered yet at this point
    // (Level, Props, ViewModel and PostFX all initialise after us).
    this._apReady = installAerialPerspective(this.atmosphere.texture);

    this.dome = new SkyDome();
    ctx.scene.add(this.dome.mesh);
    ctx.scene.background = null;

    // `scene.fog` is what makes three define USE_FOG at all, so it has to exist
    // even though the patched chunk ignores its colour and density. If the patch
    // ever fails to install these values are the fallback the stock chunk uses.
    ctx.scene.fog = new THREE.FogExp2(0xa8bccf, RENDER.fogDensity);

    // A second mesh sharing the same geometry AND uniforms — an Object3D cannot
    // live in two scenes, and this is what gets baked into the IBL.
    this._envScene = new THREE.Scene();
    this._envMesh = new THREE.Mesh(this.dome.mesh.geometry, this.dome.material);
    this._envMesh.frustumCulled = false;
    this._envScene.add(this._envMesh);

    this._pmrem = new THREE.PMREMGenerator(ctx.renderer);

    this.applyPreset(TIME_OF_DAY.golden, 'golden');

    ctx.bus.on('sky:tod', ({ key, preset }) => {
      const p = preset ?? TIME_OF_DAY[key];
      if (p) this.applyPreset(p, key ?? presetKeyOf(p));
    });
    ctx.bus.on('sky:weather', ({ key }) => {
      if (!WEATHER[key]) return;
      this.weather = key;
      this.applyPreset(this.preset, this.presetKey);
    });
  }

  /* ------------------------------------------------------------------ preset */

  applyPreset(preset, key = null) {
    this.preset = preset;
    this.presetKey = key ?? presetKeyOf(preset) ?? 'golden';

    const p = buildSkyParams(preset, this.presetKey, this.weather);
    this.params = p;

    this.sunDirection.copy(p.sunDir);
    this.sunColour.setHex(preset.tint);
    this._sunLinear.copy(this.sunColour);

    this.atmosphere.build(p);

    this._publishAerial(p);
    this._publishDome(p);

    // Average upper-hemisphere radiance: Lighting's fallback sky *tint*, so keep
    // it inside a unit range while preserving the ratios that carry the colour.
    this.skyColour.copy(this.atmosphere.average);
    const peak = Math.max(this.skyColour.r, this.skyColour.g, this.skyColour.b);
    if (peak > 0.85) this.skyColour.multiplyScalar(0.85 / peak);

    // Horizon in-scatter in the sun's bearing, kept on `scene.fog.color` so
    // anything that reads it (or the stock chunk, if the patch bailed out) still
    // agrees with the image.
    this._horizonDir.set(p.sunDir.x, 0.02, p.sunDir.z).normalize();
    this.atmosphere.radianceInto(this.fogColour, this._horizonDir, p.sunDir);
    if (this.ctx) {
      this.ctx.scene.fog.color.copy(this.fogColour);
      // Beer extinction -> the FogExp2 density that matches it at 300 m, so the
      // fallback path is at least in the right ballpark.
      const ext = (p.extinction[0] + p.extinction[1] + p.extinction[2]) / 3;
      this.ctx.scene.fog.density = Math.sqrt(ext * (1 + p.mistGain) / 300);
      this._bakeEnvironment();
    }

    this.ctx?.bus.emit('sky:changed', {
      preset, direction: this.sunDirection, colour: this.sunColour,
    });
  }

  /** Push the atmosphere into the uniforms every fogged material shares. */
  _publishAerial(p) {
    apUniforms.bsApSunDir.value.copy(p.sunDir);
    apUniforms.bsApSunColour.value.set(
      this._sunLinear.r * 0.9, this._sunLinear.g * 0.9, this._sunLinear.b * 0.9);
    apUniforms.bsApExt.value.set(p.extinction[0], p.extinction[1], p.extinction[2]);
    apUniforms.bsApFalloff.value.set(p.hazeHeight, p.mistHeight, p.mistGain, p.apMaxOpacity);
    apUniforms.bsApMie.value.set(p.mieG, p.apMieStrength, p.apGain, p.cloudHaze);
    apUniforms.bsApSky.value = this.atmosphere.texture;
  }

  /** Everything only the visible dome needs. */
  _publishDome(p) {
    const u = this.dome.uniforms;

    u.bsCumulus.value.set(p.cumulus.coverage, p.cumulus.softness,
      p.cumulus.absorption, p.cumulus.detail);
    u.bsCumulusGeo.value.set(p.cumulus.altitude, p.cumulus.scale, p.cumulus.drift, 1);
    u.bsCirrus.value.set(p.cirrus.coverage, p.cirrus.altitude, p.cirrus.scale, p.cirrus.drift);

    // Cloud tops are lit by the same key Lighting uses, attenuated for a low sun
    // the way the long slant path really attenuates it. Calibrated so a fully
    // lit thick top lands near 0.9 linear — which is what albedo 0.85 under this
    // atmosphere's solar irradiance actually gives. Overshoot here is what makes
    // alpha-blended clouds read as glowing paper.
    const reach = THREE.MathUtils.clamp(p.sunDir.y * 3.0 + 0.18, 0, 1);
    const keyGain = 0.26 + 0.95 * reach * p.day;
    // A saturated art tint (golden hour is 0xffa955) starves the blue channel and
    // turns white cloud into orange gel; pull it back toward the physical
    // transmitted colour, which is far less saturated than the key light.
    this._cloudKey.copy(this._sunLinear).lerp(WHITE, 0.30).multiplyScalar(keyGain);
    u.bsCloudSun.value.set(this._cloudKey.r, this._cloudKey.g, this._cloudKey.b);

    // Ambient on the deck: the sky it sits in, plus the ground bounce below it.
    this._ambLinear.copy(this.atmosphere.average).lerp(this.atmosphere.groundAvg, 0.35);
    u.bsCloudAmb.value.set(
      this._ambLinear.r * 0.85, this._ambLinear.g * 0.85, this._ambLinear.b * 0.85);

    // The disc reddens and dims as it sets; the aureole carries the rest.
    const t = THREE.MathUtils.clamp(p.sunDir.y * 4.0, 0, 1);
    const discCol = this._probe.copy(this._sunLinear).lerp(WHITE, t * 0.7);
    u.bsDiscColour.value.set(discCol.r, discCol.g, discCol.b);
    u.bsDisc.value.set(p.sunDisc, p.moonIntensity, p.starIntensity, 1.0);
    u.bsMoonDir.value.copy(p.moonDir);
  }

  /**
   * Re-bake the dome into a PMREM and publish it as `ambientSH`. Runs only when
   * the sky actually changes (preset / weather), never per frame.
   *
   * The dome is authored for *display* — its values sit in a low range because
   * PostFX tone maps the composite. An IBL needs physical radiance, so the bake
   * runs at a gain. Without it the environment is dimmer than the procedural one
   * Lighting falls back to, and enclosed spaces lose most of their fill and go
   * muddy. Only the absolute scale differs; the colour and gradient the player
   * sees are identical, so sky and IBL still agree.
   */
  _bakeEnvironment() {
    const u = this.dome.uniforms.bsDisc;
    const shown = u.value.w;
    // Freeze the clouds at t = 0 for the bake so the IBL is reproducible.
    const tu = this.dome.uniforms.bsCloudTime;
    const shownT = tu.value;
    try {
      u.value.w = shown * Sky.IBL_GAIN;
      tu.value = 0;
      const next = this._pmrem.fromScene(this._envScene, 0, 0.1, 100);
      this._envRT?.dispose();
      this._envRT = next;
      this.ambientSH = next.texture;
    } catch (err) {
      // Lighting has its own procedural fallback for exactly this case.
      console.warn('[sky] environment bake failed, lighting will fall back:', err);
      this.ambientSH = null;
    } finally {
      u.value.w = shown;
      tu.value = shownT;
    }
  }

  /* ------------------------------------------------------------------ update */

  update(dt, ctx) {
    // Cloud drift. The engine still calls update() while frozen, so gate on it
    // explicitly — otherwise the sky would keep moving between the rig's freeze
    // and its exposure and screenshots would not be reproducible.
    if (ctx?.engine?.frozen) return;
    this._t += dt;
    this.dome.uniforms.bsCloudTime.value = this._t;
  }

  /**
   * Camera-dependent uniforms are pushed here, not in `update()`. Sky is
   * registered third, long before CameraRig, so anything read during update()
   * would be a frame stale — and a stale camera matrix in the fog vertex chunk
   * means every world position is reconstructed from last frame's view, which
   * smears the aerial perspective whenever the player turns.
   *
   * Returns false: PostFX owns the frame.
   */
  render(dt, ctx) {
    const cam = ctx.camera;
    cam.updateMatrixWorld();
    if (this._apReady) apUniforms.bsApViewInv.value.copy(cam.matrixWorld);
    this.dome.uniforms.bsEye.value.copy(cam.position);
    return false;
  }

  /** True when the shader-chunk aerial perspective patch is live. */
  get aerialPerspectiveActive() {
    return this._apReady && isAerialPerspectiveInstalled();
  }

  dispose() {
    this.dome.mesh.removeFromParent();
    this._envMesh.removeFromParent();
    this.dome.dispose();
    this.atmosphere.dispose();
    this._envRT?.dispose();
    this._pmrem?.dispose();
  }
}

/**
 * Radiance multiplier applied to the dome only while baking the IBL. Tuned so an
 * enclosed interior under the midday preset matches the fill it had from
 * Lighting's own procedural environment.
 */
Sky.IBL_GAIN = 3.2;
