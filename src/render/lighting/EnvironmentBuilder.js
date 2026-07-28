import * as THREE from 'three';

/**
 * OWNER: lighting agent.
 *
 * Bakes SkyRadianceModel into an equirectangular float texture and runs it
 * through three's PMREMGenerator, so roughness responds correctly across the
 * mip chain. Zero external assets — the HDR is evaluated analytically in JS.
 *
 * This is the *fallback* IBL. When Sky publishes `ambientSH` (a PMREM of the
 * dome the player can actually see) that wins, because reflections should show
 * the sky that is in frame. The analytic bake is what keeps the rig working
 * standalone — and, more importantly, the same model feeds the spherical
 * harmonics that drive indirect diffuse for *both* paths, so the two never
 * disagree about which direction the light is coming from.
 *
 * 512x256 rather than 256x128: the solar disc is ~0.5 deg and the aureole falls
 * off over ~20 deg, and at 1.4 deg per texel the disc landed on a single texel
 * and the glow stair-stepped in the low mips. At 0.7 deg per texel the bake is
 * still under 5 ms and runs once per preset.
 *
 * Results are cached per rig key so switching time of day twice is free.
 */

const W = 512;
const H = 256;

export class EnvironmentBuilder {
  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {import('./SkyRadianceModel.js').SkyRadianceModel} model shared model
   */
  constructor(renderer, model) {
    this.renderer = renderer;
    this.model = model;
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.pmrem.compileEquirectangularShader();

    this._data = new Float32Array(W * H * 4);
    this._source = new THREE.DataTexture(this._data, W, H, THREE.RGBAFormat, THREE.FloatType);
    this._source.mapping = THREE.EquirectangularReflectionMapping;
    this._source.minFilter = THREE.LinearFilter;
    this._source.magFilter = THREE.LinearFilter;
    this._source.colorSpace = THREE.LinearSRGBColorSpace;
    this._source.generateMipmaps = false;

    /** @type {Map<string, THREE.WebGLRenderTarget>} */
    this._cache = new Map();

    /** Mirrors of the model's most recent numbers — used to tune secondary fills. */
    this.lastSkyIrradiance = new THREE.Color(0, 0, 0);
    this.lastGroundRadiance = new THREE.Color(0, 0, 0);
  }

  /**
   * @param {string} key cache key (rig name)
   * @param {number} gain radiance gain applied to the whole bake
   * @returns {THREE.Texture}
   */
  build(key, gain) {
    this.lastSkyIrradiance.copy(this.model.skyIrradiance).multiplyScalar(gain);
    this.lastGroundRadiance.copy(this.model.groundRadiance).multiplyScalar(gain);

    const cached = this._cache.get(key);
    if (cached) return cached.texture;

    const data = this._data;
    const model = this.model;
    for (let y = 0; y < H; y++) {
      // equirect: v=0 at +Y (three samples with theta from the top)
      const theta = ((y + 0.5) / H) * Math.PI;
      const sinT = Math.sin(theta);
      const dy = Math.cos(theta);
      for (let x = 0; x < W; x++) {
        const phi = ((x + 0.5) / W) * Math.PI * 2 - Math.PI;
        const c = model.radiance(sinT * Math.sin(phi), dy, sinT * Math.cos(phi));
        const o = (y * W + x) * 4;
        data[o] = c[0] * gain;
        data[o + 1] = c[1] * gain;
        data[o + 2] = c[2] * gain;
        data[o + 3] = 1;
      }
    }

    this._source.needsUpdate = true;
    const target = this.pmrem.fromEquirectangular(this._source);
    this._cache.set(key, target);
    return target.texture;
  }

  dispose() {
    for (const rt of this._cache.values()) rt.dispose();
    this._cache.clear();
    this._source.dispose();
    this.pmrem.dispose();
  }
}
