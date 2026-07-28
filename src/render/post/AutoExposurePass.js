import * as THREE from 'three';
import { Pass } from 'postprocessing';
import { EXPOSURE } from './PostConstants.js';

/**
 * OWNER: postfx agent.
 *
 * Physical auto-exposure metering, entirely on the GPU.
 *
 * The scene-referred HDR frame is reduced to a single log-average luminance and
 * turned into an exposure multiplier which FinishEffect samples as a 1×1
 * texture. Nothing is read back to the CPU, so there is no pipeline stall and
 * no frame of latency.
 *
 *   128² → 32² → 8² → 2² → 1²   weighted log-luminance reduction (5 draws)
 *   1² adapt                     temporal eye response, in stops
 *
 * Metering is centre-weighted and the sky is held down: without either, walking
 * up to a wall or tipping the camera at the horizon swings the whole frame by a
 * stop and a half, which is the classic "auto-exposure pumping" that makes a
 * game look cheap. The result is then clamped to ±1.25 stops around the
 * per-time-of-day nominal, so metering trims the frame for content but the
 * authored look still owns the overall brightness.
 *
 * Round 3 had no metering at all — a fixed stop per time of day. That is why a
 * bright sunlit plaza and a shaded interior at the same hour came out on the
 * same curve, and why the grade had to do the work of exposure.
 */

const vertexShader = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 1.0, 1.0);
}
`;

/**
 * First reduction: 16 taps per output texel, straight off the HDR buffer.
 * Accumulates (Σ w·log L, Σ w) so every later stage is a plain average.
 */
const meterFragment = /* glsl */ `
uniform sampler2D uSource;
uniform vec2 uSourceTexel;
uniform float uCentreWeight;
uniform float uSkyRejection;
uniform float uMinLum;
varying vec2 vUv;

void main() {
  float sumLog = 0.0;
  float sumW = 0.0;
  for (int j = 0; j < 4; j++) {
    for (int i = 0; i < 4; i++) {
      vec2 o = (vec2(float(i), float(j)) - 1.5) * uSourceTexel * 4.0;
      vec2 uv = clamp(vUv + o, vec2(0.0), vec2(1.0));
      vec3 c = max(texture2D(uSource, uv).rgb, vec3(0.0));
      float lum = max(dot(c, vec3(0.2126, 0.7152, 0.0722)), uMinLum);

      // Centre weighting: the middle of the frame is what the player is aiming
      // at, so it decides the stop.
      vec2 d = uv - 0.5;
      float r = length(vec2(d.x * 1.6, d.y));
      float w = mix(1.0, 1.0 - uCentreWeight, clamp(r / 0.62, 0.0, 1.0));

      // Sky rejection: a 40:1 highlight occupying the top third of the frame
      // must not be allowed to stop the ground down into silhouette.
      w *= mix(1.0, 1.0 - uSkyRejection, clamp((lum - 2.0) / 6.0, 0.0, 1.0));

      sumLog += log(lum) * w;
      sumW += w;
    }
  }
  gl_FragColor = vec4(sumLog, sumW, 0.0, 1.0);
}
`;

/** Plain 4-tap box average of (Σ w·log L, Σ w) — ratios survive averaging. */
const reduceFragment = /* glsl */ `
uniform sampler2D uSource;
uniform vec2 uSourceTexel;
varying vec2 vUv;

void main() {
  vec2 o = uSourceTexel;
  vec4 s = texture2D(uSource, vUv + vec2(-o.x, -o.y));
  s += texture2D(uSource, vUv + vec2(o.x, -o.y));
  s += texture2D(uSource, vUv + vec2(-o.x, o.y));
  s += texture2D(uSource, vUv + vec2(o.x, o.y));
  gl_FragColor = s * 0.25;
}
`;

/**
 * Adaptation. Runs on a 1×1 target and reads its own previous value, so the
 * response is a proper exponential in stops rather than a linear crossfade
 * (which would take the same wall-clock time from 1 stop as from 6).
 */
const adaptFragment = /* glsl */ `
uniform sampler2D uReduced;
uniform sampler2D uPrevious;
uniform float uKey;
uniform float uNominal;
uniform float uEv;
uniform float uAuthority;
uniform float uMinLum;
uniform float uMaxLum;
uniform float uAdaptUp;
uniform float uAdaptDown;
uniform float uDt;
uniform float uInstant;
varying vec2 vUv;

void main() {
  vec2 r = texture2D(uReduced, vec2(0.5)).xy;
  float avgLum = exp(r.x / max(r.y, 1e-4));
  avgLum = clamp(avgLum, uMinLum, uMaxLum);

  float target = (uKey / avgLum) * exp2(uEv);
  float lo = uNominal / exp2(uAuthority);
  float hi = uNominal * exp2(uAuthority);
  target = clamp(target, lo, hi);

  float prev = texture2D(uPrevious, vec2(0.5)).r;
  if (!(prev > 1e-5) || uInstant > 0.5) {
    gl_FragColor = vec4(target, avgLum, 0.0, 1.0);
    return;
  }

  float lp = log2(prev);
  float lt = log2(target);
  float rate = lt > lp ? uAdaptUp : uAdaptDown;
  float k = 1.0 - exp(-max(rate, 0.001) * max(uDt, 0.0));
  gl_FragColor = vec4(exp2(lp + (lt - lp) * k), avgLum, 0.0, 1.0);
}
`;

// Full float, not half: the reduction sums logarithms (so precision matters at
// the tail) and the 1×1 adapt target has to be readable with readRenderTargetPixels
// for diagnostics, which needs a Float32Array view.
const RT_OPTS = {
  minFilter: THREE.LinearFilter,
  magFilter: THREE.LinearFilter,
  type: THREE.FloatType,
  depthBuffer: false,
  stencilBuffer: false,
};

export class AutoExposurePass extends Pass {
  constructor() {
    super('AutoExposurePass');
    this.needsSwap = false;

    this._meterMaterial = new THREE.ShaderMaterial({
      name: 'ExposureMeter',
      uniforms: {
        uSource: { value: null },
        uSourceTexel: { value: new THREE.Vector2(1 / 1920, 1 / 1080) },
        uCentreWeight: { value: EXPOSURE.centreWeight },
        uSkyRejection: { value: EXPOSURE.skyRejection },
        uMinLum: { value: EXPOSURE.minLuminance },
      },
      vertexShader,
      fragmentShader: meterFragment,
      depthWrite: false,
      depthTest: false,
    });

    this._reduceMaterial = new THREE.ShaderMaterial({
      name: 'ExposureReduce',
      uniforms: {
        uSource: { value: null },
        uSourceTexel: { value: new THREE.Vector2(1, 1) },
      },
      vertexShader,
      fragmentShader: reduceFragment,
      depthWrite: false,
      depthTest: false,
    });

    this._adaptMaterial = new THREE.ShaderMaterial({
      name: 'ExposureAdapt',
      uniforms: {
        uReduced: { value: null },
        uPrevious: { value: null },
        uKey: { value: EXPOSURE.key },
        uNominal: { value: 1 },
        uEv: { value: 0 },
        uAuthority: { value: EXPOSURE.authority },
        uMinLum: { value: EXPOSURE.minLuminance },
        uMaxLum: { value: EXPOSURE.maxLuminance },
        uAdaptUp: { value: EXPOSURE.adaptUp },
        uAdaptDown: { value: EXPOSURE.adaptDown },
        uDt: { value: 1 / 60 },
        uInstant: { value: 1 },
      },
      vertexShader,
      fragmentShader: adaptFragment,
      depthWrite: false,
      depthTest: false,
    });

    this._quadScene = new THREE.Scene();
    this._quad = new THREE.Mesh(Pass.fullscreenGeometry, this._reduceMaterial);
    this._quad.frustumCulled = false;
    this._quadScene.add(this._quad);

    // 128 → 32 → 8 → 2 → 1
    this._chain = [128, 32, 8, 2, 1].map((n) => {
      const rt = new THREE.WebGLRenderTarget(n, n, RT_OPTS);
      rt.texture.name = `Exposure.${n}`;
      return rt;
    });
    this._adaptA = new THREE.WebGLRenderTarget(1, 1, RT_OPTS);
    this._adaptA.texture.name = 'Exposure.AdaptA';
    this._adaptB = new THREE.WebGLRenderTarget(1, 1, RT_OPTS);
    this._adaptB.texture.name = 'Exposure.AdaptB';
    this._write = 0;
    this._primed = false;
    this._instant = false;
    this._pixels = new Float32Array(4);
  }

  /**
   * Reads the adapted stop back to the CPU. Diagnostics only — this stalls the
   * pipeline, so it is never called from the frame loop.
   * @returns {{exposure:number, luminance:number}}
   */
  readExposure(renderer) {
    const rt = this._write === 0 ? this._adaptA : this._adaptB;
    renderer.readRenderTargetPixels(rt, 0, 0, 1, 1, this._pixels);
    return { exposure: this._pixels[0], luminance: this._pixels[1] };
  }

  /** 1×1 texture: R = exposure multiplier, G = metered average luminance. */
  get texture() {
    return (this._write === 0 ? this._adaptA : this._adaptB).texture;
  }

  /**
   * @param {number} nominal the look's authored stop; metering stays within
   *   EXPOSURE.authority stops of it
   * @param {number} ev EV compensation for this time of day
   */
  setLook(nominal, ev) {
    this._adaptMaterial.uniforms.uNominal.value = nominal;
    this._adaptMaterial.uniforms.uEv.value = ev;
  }

  /** Skips adaptation for one frame — used on look changes and while frozen. */
  snap() {
    this._primed = false;
  }

  set instant(on) {
    this._instant = !!on;
  }

  render(renderer, inputBuffer, outputBuffer, deltaTime = 1 / 60) {
    const chain = this._chain;

    // 1 — meter the HDR frame into 128².
    this._meterMaterial.uniforms.uSource.value = inputBuffer.texture;
    this._meterMaterial.uniforms.uSourceTexel.value.set(
      1 / Math.max(1, inputBuffer.width),
      1 / Math.max(1, inputBuffer.height),
    );
    this._quad.material = this._meterMaterial;
    renderer.setRenderTarget(chain[0]);
    renderer.render(this._quadScene, this.camera);

    // 2 — reduce to 1².
    this._quad.material = this._reduceMaterial;
    for (let i = 1; i < chain.length; i++) {
      const src = chain[i - 1];
      this._reduceMaterial.uniforms.uSource.value = src.texture;
      this._reduceMaterial.uniforms.uSourceTexel.value.set(1 / src.width, 1 / src.height);
      renderer.setRenderTarget(chain[i]);
      renderer.render(this._quadScene, this.camera);
    }

    // 3 — adapt.
    const write = this._write === 0 ? this._adaptB : this._adaptA;
    const read = this._write === 0 ? this._adaptA : this._adaptB;
    const u = this._adaptMaterial.uniforms;
    u.uReduced.value = chain[chain.length - 1].texture;
    u.uPrevious.value = read.texture;
    u.uDt.value = Math.min(deltaTime, 0.25);
    u.uInstant.value = !this._primed || this._instant ? 1 : 0;
    this._quad.material = this._adaptMaterial;
    renderer.setRenderTarget(write);
    renderer.render(this._quadScene, this.camera);

    this._write ^= 1;
    this._primed = true;
  }

  setSize() {
    // The metering chain is resolution independent by design.
  }

  dispose() {
    for (const rt of this._chain) rt.dispose();
    this._adaptA.dispose();
    this._adaptB.dispose();
    this._meterMaterial.dispose();
    this._reduceMaterial.dispose();
    this._adaptMaterial.dispose();
    super.dispose();
  }
}
