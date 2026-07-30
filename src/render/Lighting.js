import * as THREE from 'three';
import { RENDER, TIME_OF_DAY } from '../core/Constants.js';
import { applyShadowPatch, shadowPatchActive } from './lighting/ShadowShaderPatch.js';
import { applyIrradiancePatch, irradiancePatchActive } from './lighting/IrradiancePatch.js';
import { applySpecularClamp, specularClampActive } from './lighting/SpecularClampPatch.js';
import { CascadedShadowMap } from './lighting/CascadedShadowMap.js';
import { EnvironmentBuilder } from './lighting/EnvironmentBuilder.js';
import { SkyRadianceModel, RADIANCE_GAIN } from './lighting/SkyRadianceModel.js';
import { VolumetricLight } from './lighting/VolumetricLight.js';
import { Practicals } from './lighting/Practicals.js';
import { AperturePortals } from './lighting/AperturePortals.js';
import { FlashPool } from './lighting/FlashPool.js';
import { rigFor, keyOfPreset } from './lighting/LightRigs.js';
import { EnclosureProbe } from './lighting/EnclosureProbe.js';

/**
 * OWNER: lighting agent.
 * CONTRACT:
 *   lighting.sun         : THREE.DirectionalLight  (cascade 0 — the key light)
 *   lighting.addPoint(o) : register a local light (lamp, fire, scripted source)
 *   lighting.flash(pos, colour, intensity, decay) : one-shot light pop
 *
 * What this system is
 * -------------------
 * A complete light rig, not a lamp. Per time-of-day preset it reconfigures:
 *
 *   key light      4 nested cascaded shadow maps, sphere-fitted and texel
 *                  snapped, filtered with a PCSS Poisson-disc kernel whose
 *                  penumbra widens with blocker distance and is capped in WORLD
 *                  METRES per cascade — see CascadedShadowMap.filterTexels(),
 *                  which is where crisp shadows come from
 *                  (lighting/CascadedShadowMap.js + ShadowShaderPatch.js)
 *   indirect       one analytic radiance sphere (lighting/SkyRadianceModel.js)
 *                  with a real azimuthal warm/cool split and a lit-ground lower
 *                  hemisphere, projected to 9-band spherical harmonics and
 *                  injected into *every* material's indirect diffuse
 *                  (lighting/IrradiancePatch.js). Specular still samples Sky's
 *                  dome, so reflections show the sky in frame while diffuse gets
 *                  direction and colour transfer.
 *   secondary      a sunward ground-bounce directional plus token hemisphere and
 *                  ambient terms kept only as insurance for non-physical
 *                  materials — the flat fill is no longer the plan
 *   volumetrics    shadow-map-occluded raymarched shafts with blue-noise dither
 *                  and temporal jitter, on an interior/exterior blended medium
 *                  driven by a roof probe (lighting/VolumetricLight.js)
 *   practicals     photometric ownership of every fixture the level publishes:
 *                  colour temperature, inverse-square reach per fixture type,
 *                  day/night dimming and baked 512 shadow cubemaps on the few
 *                  that earn one (lighting/Practicals.js)
 *   portals        window bounce — a small pool of emitters parked inside the
 *                  apertures nearest the camera (lighting/AperturePortals.js)
 *   exposure       per-preset stop offset on top of RENDER.exposure, so night
 *                  opens up instead of clipping to black
 *
 * Seams consumed: `sky.sunDirection`, `sky.sunColour`, `sky.ambientSH`,
 * `sky.skyColour`, `sky.fogColour` (all optional — every one has a fallback),
 * `level.colliders` for the enclosure probe, `level.bounds` and `level.heightAt`
 * for the fallback fixture rig, `level.lightAnchors` for fixture kinds,
 * `level.apertures` for window portals, and the `sky:tod` / `sky:changed` /
 * `render:quality` events.
 *
 * Seams published: `lighting:exposure` { exposure } so PostFX can own tone
 * mapping if it wants to, and `lighting:rig` { key, rig } for anyone who wants
 * to art-direct against the active rig.
 *
 * Reserved: no other system may add a shadow-casting DirectionalLight to
 * ctx.scene — the cascade selection in the patched shader assumes the
 * shadow-casting directional lights are exactly this rig's cascades.
 */
export class Lighting {
  constructor() {
    this.name = 'lighting';
    this._dir = new THREE.Vector3(0, 1, 0);
    this._colour = new THREE.Color(0xffffff);
    this._bounceDir = new THREE.Vector3();
    this._skyTint = new THREE.Color();
    this._groundTint = new THREE.Color();
    this._presetKey = 'golden';
    /** @type {THREE.Light[]} */
    this._registered = [];
    this._qualityKey = 'high';
    this.shPatched = false;
    this._materialsLive = false;

    // Enclosure: 0 outdoors, 1 inside a building. See lighting/EnclosureProbe.js.
    this.enclosure = new EnclosureProbe();
    this._interior = 0;

    /** Reused scattering-medium record so _blendMedium never allocates. */
    this._medium = {
      density: 0.016, intensity: 0.55, anisotropy: 0.76,
      maxDistance: 110, heightFalloff: 0.03,
    };
    this._volMedium = null;
  }

  init(ctx) {
    this.ctx = ctx;
    const sky = ctx.get('sky');
    this.sky = sky;

    this._qualityKey = this._inferQuality(ctx.quality);
    const params = new URLSearchParams(location.search);
    // `?csmdebug=1..8` paints a diagnostic instead of the shadow term (see
    // ShadowShaderPatch.js for the table); `=9` leaves three's stock PCF alone.
    this._csmDebug = params.has('csmdebug') ? parseInt(params.get('csmdebug'), 10) || 0 : 0;
    // `?keyelev=N` overrides the active rig's key-light elevation floor. Whether a
    // preset's sun is high enough to lay a legible shadow *pattern* on the yard
    // (rather than putting all of it inside one shadow) can only be settled by
    // sweeping it and looking, and that sweep is worth being able to repeat.
    this._keyElevation = params.has('keyelev') ? parseFloat(params.get('keyelev')) : null;

    // ---- cascaded shadow maps ----------------------------------------------
    // Built BEFORE the shader patch: the patch bakes this rig's per-cascade
    // texel-to-metre conversion in as compile-time constants, so it needs the
    // cascade geometry to exist first. Nothing has compiled a shader yet at this
    // point in init (Level and Props register after Lighting), so there is no
    // recompile to pay for.
    const mapSize = ctx.quality?.shadowMapSize ?? RENDER.shadowMapSize;
    this.csm = new CascadedShadowMap(ctx, {
      count: RENDER.shadowCascades,
      mapSize,
      distance: Math.max(RENDER.shadowDistance, 150),
    });

    // ---- shader-level shadow upgrade ---------------------------------------
    this._syncShadowPatch(false);

    // ---- shader-level specular headroom -------------------------------------
    // Also before anything compiles. Patches `common`, `lights_physical_fragment`
    // and `aomap_fragment` — three chunks no other patch in the project touches.
    //
    // `?spec=knee,span,metalFloor,kappa` overrides the calibration without an
    // edit, and `?specdebug=1|2|3` ablates the two specular terms — see
    // SpecularClampPatch.js. Both exist because the round-7 build had a live
    // clamp and a clipped image at the same time, and the only way to tell which
    // term was responsible was to sweep and to ablate.
    this._specular = { ...SPECULAR, debug: parseInt(params.get('specdebug'), 10) || 0 };
    if (params.has('spec')) {
      const [k, sp, mf, kap] = params.get('spec').split(',').map(Number);
      if (Number.isFinite(k)) this._specular.knee = k;
      if (Number.isFinite(sp)) this._specular.span = sp;
      if (Number.isFinite(mf)) this._specular.metalRoughnessFloor = mf;
      if (Number.isFinite(kap)) this._specular.normalVarianceKappa = kap;
    }
    applySpecularClamp(this._specular);
    this.specClamped = specularClampActive();

    /** @type {THREE.DirectionalLight} contract handle */
    this.sun = this.csm.sun;
    this.sunDirection = this.csm.sunDirection;
    this.sunColour = this.csm.sunColour;

    // ---- indirect ----------------------------------------------------------
    // One analytic radiance sphere drives everything indirect: the fallback
    // PMREM bake, the SH irradiance injected into every material, and the tints
    // the secondary fills use.
    this.skyModel = new SkyRadianceModel();
    this.envBuilder = new EnvironmentBuilder(ctx.renderer, this.skyModel);
    this._sh = null;

    // Hemisphere + ambient are *insurance*, not the plan. Physical materials get
    // their fill from the SH term; these two only matter for the handful of
    // non-physical materials in the project (and as a floor if the SH patch
    // fails to bind against a future three release), so they run an order of
    // magnitude below where they used to and get folded up entirely if the patch
    // takes.
    this.hemi = new THREE.HemisphereLight(0xbcd4ee, 0x4a4034, 0.3);
    this.hemi.name = 'hemi-fill';
    ctx.scene.add(this.hemi);

    // Ground bounce. Physically the strongest bounce arrives from the *sunward*
    // ground — that is the patch of ground with sun on it — so this points up
    // and back along the sun's bearing, not away from it. It survives alongside
    // the SH term because a single directional carries specular response that a
    // 9-band irradiance projection cannot.
    this.bounce = new THREE.DirectionalLight(0x6a5a44, 0.0);
    this.bounce.name = 'ground-bounce';
    this.bounce.castShadow = false;
    ctx.scene.add(this.bounce, this.bounce.target);

    // Absolute floor. Small — the IBL does the real work — but it guarantees no
    // surface in any preset can reach pure black.
    this.ambient = new THREE.AmbientLight(0x8ea4c0, 0.03);
    this.ambient.name = 'ambient-floor';
    ctx.scene.add(this.ambient);

    // ---- dynamic + artificial ----------------------------------------------
    this.flashes = new FlashPool(ctx, 4);
    this.practicals = new Practicals(ctx, 5);
    this.portals = new AperturePortals(ctx, 4);

    // ---- volumetrics -------------------------------------------------------
    const steps = ctx.quality?.volumetricSteps ?? RENDER.volumetricSteps;
    this.volumetrics = new VolumetricLight(ctx, this.csm, {
      steps,
      depthScale: 0.5,
      marchScale: 0.25,
    });
    // `?volmul=N` scales the shaft term. Whether a shaft reads is a *contrast*
    // question against whatever is behind it, which no amount of arithmetic
    // settles — it has to be swept and looked at.
    this._volMul = params.has('volmul') ? Math.max(0, parseFloat(params.get('volmul'))) : 1;
    this.volumetrics.strength = RENDER.volumetricIntensity * 1.5 * this._volMul;

    // ---- initial state -----------------------------------------------------
    this._presetKey = keyOfPreset(sky?.preset) ?? 'golden';
    this._applyRig(sky?.preset ?? TIME_OF_DAY.golden, this._presetKey);

    ctx.bus.on('sky:tod', ({ key, preset }) => {
      if (key) this._presetKey = key;
      if (preset) this._applyRig(preset, this._presetKey);
    });
    ctx.bus.on('sky:changed', ({ preset, direction, colour }) => {
      const key = keyOfPreset(preset) ?? this._presetKey;
      this._presetKey = key;
      this._applyRig(preset, key, direction, colour);
    });
    ctx.bus.on('render:quality', ({ key, preset }) => this._applyQuality(key, preset));

    // From here on a chunk change has to be pushed into already-compiled
    // programs; during init there is nothing compiled yet, so we skip the churn.
    this._materialsLive = true;

    if (params.has('lightdebug')) this._auditNormals();
  }

  // -------------------------------------------------------------------------
  // rig application
  // -------------------------------------------------------------------------

  /**
   * @param {object} preset TIME_OF_DAY entry
   * @param {string} key preset key
   * @param {THREE.Vector3=} direction sun direction published by Sky
   * @param {THREE.Color=} colour sun tint published by Sky
   */
  _applyRig(preset, key, direction, colour) {
    const ctx = this.ctx;
    const rig = rigFor(key);
    this.rig = rig;

    // --- key light direction ------------------------------------------------
    const src = direction ?? this.sky?.sunDirection;
    if (src) this._dir.copy(src).normalize();
    else Lighting.directionFrom(preset.elevation, preset.azimuth, this._dir);

    // Below the horizon the sun cannot be the key light. Swap in the moon so
    // every silhouette keeps a rim instead of dissolving into the background.
    const isMoon = !!rig.moon || this._dir.y < 0.015;
    const keyElevation = this._keyElevation ?? rig.keyElevation;
    if (isMoon) {
      const m = rig.moon ?? { elevation: 34, azimuth: (preset.azimuth + 180) % 360 };
      Lighting.directionFrom(m.elevation, m.azimuth, this._dir);
    } else if (keyElevation !== undefined && keyElevation !== null) {
      Lighting.liftElevation(this._dir, keyElevation);
    }

    const srcColour = colour ?? this.sky?.sunColour;
    if (rig.sunColour !== undefined) this._colour.setHex(rig.sunColour);
    else if (srcColour) this._colour.copy(srcColour);
    else this._colour.setHex(preset.tint);

    const intensity = Math.max(0, preset.intensity * rig.sunFactor);
    this.csm.setSun(this._dir, this._colour, intensity, rig.sunSoftness);
    if (this.csm.setMapSize(ctx.quality?.shadowMapSize ?? RENDER.shadowMapSize)) {
      this._syncShadowPatch(true);
    }

    // --- the radiance sphere every indirect term is derived from -------------
    this.skyModel.configure(
      rig, this._dir, this._colour, intensity,
      this.sky?.skyColour ?? null, this.sky?.fogColour ?? null,
    );

    // --- IBL ----------------------------------------------------------------
    const env = this._resolveEnvironment(key, rig);
    ctx.scene.environment = env;
    ctx.scene.environmentIntensity = rig.envIntensity;
    if (ctx.viewScene) {
      ctx.viewScene.environment = env;
      ctx.viewScene.environmentIntensity = rig.envIntensity * 0.9;
    }

    // --- directional indirect diffuse (SH-projected, per-normal) -------------
    this._applyIrradiance(rig);

    // --- secondary fills, tinted from the model ------------------------------
    const skyIrr = this.envBuilder.lastSkyIrradiance;
    const groundRad = this.envBuilder.lastGroundRadiance;
    normaliseTo(this._skyTint, skyIrr, rig.zenith);
    normaliseTo(this._groundTint, groundRad, rig.groundAlbedo);
    const fillScale = this.shPatched ? rig.fillWithSH ?? 0.22 : 1.0;
    this.hemi.color.copy(this._skyTint);
    this.hemi.groundColor.copy(this._groundTint);
    this.hemi.intensity = rig.hemiIntensity * fillScale;

    // --- ground bounce ------------------------------------------------------
    // Up and back along the sun's *bearing*: the bright ground is the sunlit
    // ground, so that is where the bounce comes from. Pointing it at the
    // anti-sun side (as this used to) fills the terminator with light that has
    // no physical source and flattens every shaded face to one value.
    let hx = this._dir.x;
    let hz = this._dir.z;
    const hl = Math.hypot(hx, hz);
    if (hl < 0.15) { hx = -0.42; hz = 0.91; }
    else { hx /= hl; hz /= hl; }
    this._bounceDir.set(hx * 0.86, -0.51, hz * 0.86).normalize();
    this.bounce.position.copy(this._bounceDir).multiplyScalar(-90);
    this.bounce.target.position.set(0, 0, 0);
    this.bounce.target.updateMatrixWorld();
    this.bounce.color.copy(this._groundTint);
    this.bounce.intensity = intensity * rig.bounceIntensity * Math.max(0.10, this._dir.y)
      * (this.shPatched ? 0.55 : 1.0);

    // --- ambient floor ------------------------------------------------------
    this.ambient.color.copy(this._skyTint);
    this.ambient.intensity = rig.ambientFloor * fillScale;

    // --- practicals + window portals ----------------------------------------
    this.practicals.setRig(rig, key);
    this.portals.setSky(this.envBuilder.lastSkyIrradiance, rig.portalGain ?? 1);

    // --- volumetrics --------------------------------------------------------
    this._volMedium = rig.volumetric;
    this.volumetrics.setMedium(this._blendMedium(rig));
    this.volumetrics.setSun(this._dir, this._colour);

    // --- exposure -----------------------------------------------------------
    const exposure = RENDER.exposure * rig.exposure;
    ctx.renderer.toneMappingExposure = exposure;
    ctx.bus.emit('lighting:exposure', { exposure });
    ctx.bus.emit('lighting:rig', { key, rig });
  }

  /**
   * Prefer whatever Sky publishes on `ambientSH` — a specular reflection should
   * show the sky that is actually in frame — and fall back to the analytic bake.
   * Both paths end up as a PMREM cubeUV texture. Note the analytic bake still
   * runs its irradiance bookkeeping either way, because the SH term and the fill
   * tints are derived from the model, not from whichever texture wins here.
   */
  _resolveEnvironment(key, rig) {
    const gain = RADIANCE_GAIN * (rig.radianceGain ?? 1);
    const supplied = this.sky?.ambientSH;
    if (supplied && supplied.isTexture) {
      // Keep the model's irradiance numbers current for the fill tints.
      this.envBuilder.lastSkyIrradiance.copy(this.skyModel.skyIrradiance).multiplyScalar(gain);
      this.envBuilder.lastGroundRadiance.copy(this.skyModel.groundRadiance).multiplyScalar(gain);
      if (supplied.mapping === THREE.CubeUVReflectionMapping) return supplied;
      try {
        if (this._skyPmremKey !== supplied.uuid) {
          this._skyPmrem?.dispose?.();
          this._skyPmrem = supplied.isCubeTexture
            ? this.envBuilder.pmrem.fromCubemap(supplied)
            : this.envBuilder.pmrem.fromEquirectangular(supplied);
          this._skyPmremKey = supplied.uuid;
        }
        return this._skyPmrem.texture;
      } catch (e) {
        console.warn('[lighting] could not process sky.ambientSH, using procedural env', e);
      }
    }
    return this.envBuilder.build(key, gain);
  }

  /**
   * Project the radiance model to SH and bake it into every material's indirect
   * diffuse. The DC band is attenuated because the environment map already
   * carries the overall ambient level; bands 1 and 2 — the warm sunward lobe,
   * the cool anti-sun lobe and the ground-bounce lobe from below — are what this
   * exists to add, and they integrate to zero over all normals, so the frame's
   * total ambient energy is unchanged while its *shape* becomes correct.
   */
  _applyIrradiance(rig) {
    const gain = RADIANCE_GAIN * (rig.radianceGain ?? 1);
    const { coeff } = this.skyModel.projectSH(64);
    for (let i = 0; i < coeff.length; i++) coeff[i] *= gain;
    this._sh = coeff;
    const changed = applyIrradiancePatch(coeff, {
      acGain: rig.shDirectional ?? 1.0,
      dcGain: rig.shAmbient ?? 0.30,
    });
    this.shPatched = irradiancePatchActive();
    if (changed && this._materialsLive) this._recompileMaterials();
  }

  /**
   * Interiors need a very different scattering medium from open sky: much more
   * suspended dust, no height falloff to speak of, and a broader phase function
   * because the light arriving through a window is not a collimated beam from
   * the sun's bearing. Without this the west hall gets the outdoor medium — nine
   * thousandths of a unit of density — and its window shafts never appear.
   *
   * `_interior` is a 0..1 measure of enclosure maintained by `_probeEnclosure()`.
   */
  _blendMedium(rig) {
    const t = this._interior;
    const out = this._medium;
    const a = rig.volumetric;
    const b = rig.interiorVolumetric ?? a;
    out.density = lerp(a.density, b.density, t);
    out.intensity = lerp(a.intensity, b.intensity, t);
    out.anisotropy = lerp(a.anisotropy, b.anisotropy, t);
    out.maxDistance = lerp(a.maxDistance, b.maxDistance, t);
    out.heightFalloff = lerp(a.heightFalloff, b.heightFalloff, t);
    return out;
  }

  /**
   * Refresh the enclosure measurement. Delegated because the discriminating test
   * and the calibration table behind it are a page of their own — see
   * lighting/EnclosureProbe.js.
   */
  _probeEnclosure(dt) {
    this._interior = this.enclosure.update(dt, this.ctx.camera, this.ctx.get('level')?.colliders);
  }

  _inferQuality(quality) {
    const steps = quality?.volumetricSteps ?? RENDER.volumetricSteps;
    if (steps <= 0) return 'low';
    if (steps <= 24) return 'medium';
    if (steps <= 40) return 'high';
    return 'cinematic';
  }

  /**
   * Rebuild the shadow shader chunk from the current quality tier *and* the
   * current cascade geometry. Returns true if the chunk actually changed.
   * @param {boolean} recompile force live materials to pick the new chunk up
   */
  _syncShadowPatch(recompile) {
    if (this._csmDebug === 9) { this.patched = false; return false; }
    const base = Lighting.SHADOW_TUNING[this._qualityKey] ?? Lighting.SHADOW_TUNING.high;
    const filter = this.csm.filterTexels();
    const changed = applyShadowPatch({
      ...base,
      maxTexels: filter.max,
      minTexels: filter.min,
      debug: this._csmDebug,
    });
    this.patched = shadowPatchActive();
    if (changed && recompile) this._recompileMaterials();
    return changed;
  }

  _applyQuality(key, preset) {
    const ctx = this.ctx;
    this._qualityKey = key ?? this._qualityKey;
    if (preset) {
      if (preset.shadowMapSize) this.csm.setMapSize(preset.shadowMapSize);
      if (preset.volumetricSteps !== undefined && this.volumetrics) {
        const wanted = preset.volumetricSteps;
        if (wanted !== this.volumetrics.steps) {
          const strength = this.volumetrics.strength;
          this.volumetrics.dispose();
          this.volumetrics = new VolumetricLight(ctx, this.csm, {
            steps: wanted, depthScale: 0.5, marchScale: 0.25,
          });
          this.volumetrics.strength = strength;
          this.volumetrics.setMedium(this._blendMedium(this.rig));
          this.volumetrics.setSun(this._dir, this._colour);
          const s = ctx.renderer.getSize(new THREE.Vector2());
          this.volumetrics.resize(s.x, s.y);
        }
      }
    }
    this._syncShadowPatch(true);
  }

  /** Shader chunks changed — force every live program to be rebuilt. */
  _recompileMaterials() {
    const bump = (obj) => {
      const m = obj.material;
      if (!m) return;
      if (Array.isArray(m)) for (const mm of m) mm.needsUpdate = true;
      else m.needsUpdate = true;
    };
    this.ctx.scene.traverse(bump);
    this.ctx.viewScene?.traverse(bump);
  }

  // -------------------------------------------------------------------------
  // public API
  // -------------------------------------------------------------------------

  /**
   * Register a long-lived local light owned by another system — Level hands its
   * `lightAnchors` through here.
   *
   * This is not a passthrough. Handing a light to the lighting rig means the rig
   * owns its photometry: a fixture arrives with an authored colour, position and
   * rough brightness, and leaves with a correct colour temperature, an
   * inverse-square falloff whose radius matches the fixture type, a shadow
   * cubemap if it is close enough to earn one, and a place in the day/night
   * dimming schedule. Before this, a wall lamp at midnight emitted a glow sprite
   * and threw no light on the column it was bolted to, because nothing was
   * responsible for the difference between "a light exists here" and "this
   * fixture illuminates this surface".
   */
  addPoint(light) {
    if (!light) return null;
    if (!light.parent) this.ctx.scene.add(light);
    this._registered.push(light);
    this.practicals.adopt(light);
    return light;
  }

  removePoint(light) {
    const i = this._registered.indexOf(light);
    if (i >= 0) this._registered.splice(i, 1);
    this.practicals.release(light);
    light?.removeFromParent();
  }

  /**
   * One-shot dynamic light — muzzle flashes, explosions, sparks.
   * Pooled: no allocation, no shader recompile, correct inverse-square falloff.
   */
  flash(position, colour = 0xffd9a0, intensity = 6, decay = 0.06) {
    return this.flashes.flash(position, colour, intensity, decay);
  }

  /** Master dimmer for the artificial rig (scripted blackouts, generators). */
  setPracticals(dim) {
    this.practicals.setDim(dim);
  }

  // -------------------------------------------------------------------------
  // frame
  // -------------------------------------------------------------------------

  update(dt, ctx) {
    this.csm.update(ctx.camera);
    this.flashes.update(dt);
    this.practicals.update(dt, ctx.camera);

    // Enclosure drives the scattering medium: window shafts only read if the
    // interior carries far more suspended dust than the open yard does.
    const before = this._interior;
    this._probeEnclosure(dt);
    if (this.rig && Math.abs(this._interior - before) > 0.004) {
      this.volumetrics.setMedium(this._blendMedium(this.rig));
    }
    this.portals.update(dt, this._interior);

    // If PostFX has taken the frame it is compositing in HDR, so our additive
    // shaft pass must not tonemap itself.
    const postfx = ctx.get('postfx');
    this.volumetrics.setHDRComposite(postfx?.enabled === true);
  }

  render(dt, ctx) {
    this.volumetrics.render();
    return false;   // PostFX owns the frame
  }

  resize(w, h) {
    this.volumetrics.resize(w, h);
  }

  dispose() {
    this.volumetrics.dispose();
    this.practicals.dispose();
    this.portals.dispose();
    this.flashes.dispose();
    this.csm.dispose();
    this.envBuilder.dispose();
    this._skyPmrem?.dispose?.();
    this.hemi.removeFromParent();
    this.bounce.removeFromParent();
    this.ambient.removeFromParent();
  }

  // -------------------------------------------------------------------------
  // diagnostics
  // -------------------------------------------------------------------------

  /**
   * `?lightdebug=1` — reports meshes whose normals are unnormalised, missing or
   * inverted relative to their bounding-box centre. A face reading pure black
   * under a good ambient term is almost always one of those three.
   */
  _auditNormals() {
    let missing = 0;
    let unnormalised = 0;
    const bad = [];
    this.ctx.scene.traverse((o) => {
      if (!o.isMesh || !o.geometry) return;
      const n = o.geometry.attributes.normal;
      if (!n) { missing++; bad.push(o.name || o.type); return; }
      const a = n.array;
      const step = Math.max(1, Math.floor(n.count / 24));
      for (let i = 0; i < n.count; i += step) {
        const j = i * 3;
        const len = Math.hypot(a[j], a[j + 1], a[j + 2]);
        if (Math.abs(len - 1) > 0.02) { unnormalised++; bad.push(o.name || o.type); break; }
      }
    });
    console.info(
      `[lighting] normal audit: ${missing} mesh(es) without normals, ` +
      `${unnormalised} with unnormalised normals`, bad.slice(0, 12),
    );
  }

  // -------------------------------------------------------------------------

  /**
   * Raise a sun direction to at least `minElevationDeg`, keeping its azimuth.
   * A no-op when the sun is already higher than the floor.
   *
   * Why the rig needs this at all: below roughly 20 deg the compound's own
   * massing puts the whole courtyard inside one cast shadow — a 10 m wall throws
   * 51 m at 11 deg — so the floor carries no shadow *pattern*, only a uniform
   * shade, however good the light ratio is. See the SEAM NOTE in LightRigs.js:
   * the altitude the sky draws its disc at is not lifted with it, because that
   * value lives in a file this agent does not own.
   *
   * @param {THREE.Vector3} dir normalised, pointing toward the sun (mutated)
   * @param {number} minElevationDeg
   */
  static liftElevation(dir, minElevationDeg) {
    const wantY = Math.sin(THREE.MathUtils.degToRad(minElevationDeg));
    if (dir.y >= wantY) return dir;
    const horiz = Math.hypot(dir.x, dir.z);
    if (horiz < 1e-5) return dir;
    const scale = Math.sqrt(Math.max(0, 1 - wantY * wantY)) / horiz;
    dir.x *= scale;
    dir.z *= scale;
    dir.y = wantY;
    return dir.normalize();
  }

  static directionFrom(elevationDeg, azimuthDeg, out) {
    const el = THREE.MathUtils.degToRad(elevationDeg);
    const az = THREE.MathUtils.degToRad(azimuthDeg);
    return out.set(
      Math.cos(el) * Math.sin(az),
      Math.sin(el),
      Math.cos(el) * Math.cos(az),
    ).normalize();
  }
}

/**
 * Poisson tap counts per quality preset. Taps are the dominant cost of the
 * shadow lookup, so this is the main dial that buys frame time back on weaker
 * GPUs. The penumbra *radii* are NOT here — they are per cascade and come from
 * CascadedShadowMap.filterTexels(), because a texel-space radius is meaningless
 * without knowing how many millimetres that cascade's texel covers.
 */
/**
 * Specular headroom, applied to every material in the project by
 * lighting/SpecularClampPatch.js. Sweep it live with `?spec=knee,span,floor,kappa`.
 *
 * `knee` and `span` are in scene-linear units, i.e. the same units the light
 * intensities in LightRigs are authored in, read *before* exposure and tone
 * mapping. They are therefore only meaningful against the tone curve PostFX
 * applies, and the round-7 numbers (knee 2.6, asymptotic ceiling 9.0) were wrong
 * for two reasons: 2.6 is already 8-bit code ~238 so the compression only
 * engaged after the tone mapper had done its own compressing, and an asymptote at
 * 9.0 — reachable independently by the direct AND the indirect term, so really 18 —
 * turned every highlight in the project into one value. Measured on the round-7
 * `interior` capture: 221 consecutive pixels at or above code 252 along the
 * foreground pipe.
 *
 * `span` is now the softness of a *logarithmic* knee rather than the distance to
 * a ceiling; see SpecularClampPatch.js for why an asymptote cannot fix a plateau.
 * The knee is deliberately LOW — around code 200 rather than 240 — because the
 * only place compression buys anything is *below* the tone curve's shoulder,
 * where 8-bit code values are still moving with radiance.
 *
 * Measured on `interior`, across the foreground pipe at y = 762, before -> after:
 * the longest run at or above code 252 goes 221 px -> 0 px, the band's peak goes
 * 255 -> 243, and the rust pattern is legible through the highlight in a 1.4x
 * crop where previously the band contained no detail at all. Swept: knee/span of
 * 1.10/2.30 leaves a 71 px run at 248+, 0.85/1.25 leaves 3 px, 0.60/0.85 leaves
 * none, and 0.45/0.60 only dims the whole band by a further 5 codes without
 * flattening it any less — which is where the curve stops earning anything and
 * starts costing the metal its brightness.
 *
 * `metalRoughnessFloor` is the one number a material author cannot be trusted
 * with: outdoor industrial steel is never smoother than about a third, and below
 * that the solar lobe is narrow enough to deliver the disc's radiance almost
 * undiluted to a band of pixels.
 *
 * `normalVarianceKappa` caps the roughness the geometric specular-AA filter may
 * add, in GGX alpha. 0.12 means a surface whose normal turns a full radian
 * across one pixel is shaded at roughness >= sqrt(0.12) = 0.35 however smooth
 * its map says it is; that is the correction that gives the highlight on a pipe a
 * soft edge instead of a hard step. Zero disables the filter.
 */
Lighting.SPECULAR = {
  knee: 0.60,
  span: 0.85,
  metalRoughnessFloor: 0.34,
  normalVarianceKappa: 0.12,
};
const SPECULAR = Lighting.SPECULAR;

Lighting.SHADOW_TUNING = {
  cinematic: { blockerTaps: 12, filterTaps: 24, borderFade: 0.045, rpdbClamp: 0.0012, searchSpan: 0.040 },
  high:      { blockerTaps: 10, filterTaps: 18, borderFade: 0.045, rpdbClamp: 0.0012, searchSpan: 0.038 },
  medium:    { blockerTaps: 6,  filterTaps: 12, borderFade: 0.050, rpdbClamp: 0.0015, searchSpan: 0.034 },
  low:       { blockerTaps: 4,  filterTaps: 8,  borderFade: 0.060, rpdbClamp: 0.0020, searchSpan: 0.030 },
};

const lerp = (a, b, t) => a + (b - a) * t;

/** Normalise an HDR colour to a unit-ish tint, falling back to a hex. */
function normaliseTo(out, hdr, fallbackHex) {
  const m = Math.max(hdr.r, hdr.g, hdr.b);
  if (m <= 1e-5) { out.setHex(fallbackHex); return out; }
  out.setRGB(hdr.r / m, hdr.g / m, hdr.b / m);
  return out;
}
