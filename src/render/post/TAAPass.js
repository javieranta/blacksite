import * as THREE from 'three';
import { Pass } from 'postprocessing';
import { TAA } from './PostConstants.js';

/**
 * OWNER: postfx agent.
 *
 * Temporal antialiasing: 8-sample Halton(2,3) sub-pixel jitter accumulated
 * through velocity-buffer reprojection with a neighbourhood clamp.
 *
 * ── The bug this rewrite fixes ──────────────────────────────────────────────
 * Round 3 reconstructed each pixel's world position from the **jittered**
 * inverse view-projection and reprojected it through the previous frame's
 * **unjittered** one. The two disagree by exactly the current sub-pixel offset,
 * so a perfectly stationary camera produced a reprojection of up to half a
 * pixel — in a new direction every frame. History was therefore resampled
 * through an off-centre bilinear tap on *every* frame, and eight or sixteen
 * frames of that is a genuine ~1.5px low-pass. That is why round 3's thin metal
 * came out soft, and why the unsharp filter bolted on to compensate re-exposed
 * the stair-stepping it was meant to hide.
 *
 * Velocity now comes from VelocityPass, which uses unjittered matrices on both
 * sides. A static camera reprojects to exactly the same texel, the history
 * fetch is pixel-aligned, and the resolve converges to a true 8× supersample
 * with no blur at all. Sharpening moved out of this pass entirely — CAS in the
 * finishing pass does it once, contrast-adaptively, at the end of the chain.
 *
 * ── The rest of the resolve ─────────────────────────────────────────────────
 *   • Velocity is dilated over the 3×3 neighbourhood, taking the vector
 *     belonging to the *closest* sample. Thin geometry is a fraction of a pixel
 *     wide, so without dilation its own velocity is never the one sampled and
 *     it ghosts — this is the specific fix for shimmering railings and grating.
 *   • History is clipped to the current frame's neighbourhood in **YCoCg**
 *     using an AABB *line clip* rather than a per-channel clamp: chroma and
 *     luma decorrelate there, so the box is far tighter around real signal and
 *     the clip stops eating the sub-pixel detail we are accumulating.
 *   • Blending happens in Karis' reversible tonemapped space, which keeps a
 *     single blown specular from dragging the whole neighbourhood mean up and
 *     flickering.
 *   • The weight is 1/n while the camera is still — so a frozen frame is a
 *     genuine N-sample supersample, which is exactly what the screenshot rig
 *     captures — and a fixed 0.10 while it moves.
 */

const vertexShader = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 1.0, 1.0);
}
`;

const fragmentShader = /* glsl */ `
uniform sampler2D inputBuffer;
uniform sampler2D historyBuffer;
uniform sampler2D velocityBuffer;
uniform vec2 uTexel;
uniform float uAlpha;
uniform float uClipGamma;
uniform float uLumaClip;
varying vec2 vUv;

vec3 rgbToYCoCg(const in vec3 c) {
  return vec3(
    0.25 * c.r + 0.5 * c.g + 0.25 * c.b,
    0.5 * c.r - 0.5 * c.b,
    -0.25 * c.r + 0.5 * c.g - 0.25 * c.b
  );
}

vec3 ycocgToRgb(const in vec3 c) {
  float t = c.x - c.z;
  return vec3(t + c.y, c.x + c.z, t - c.y);
}

/** Karis' reversible range compression — blend in a bounded space. */
vec3 compress(const in vec3 c) { return c / (1.0 + max(max(c.r, c.g), c.b)); }
vec3 expand(const in vec3 c) { return c / max(1.0 - max(max(c.r, c.g), c.b), 1e-4); }

vec3 fetch(const in vec2 uv) {
  return compress(max(texture2D(inputBuffer, uv).rgb, vec3(0.0)));
}

/**
 * Clips q toward p against the AABB, returning the point where the segment
 * enters the box. Softer and far more detail preserving than a componentwise
 * clamp, which snaps to a corner and flattens gradients.
 */
vec3 clipToAABB(const in vec3 lo, const in vec3 hi, const in vec3 p, const in vec3 q) {
  vec3 centre = 0.5 * (hi + lo);
  vec3 extent = 0.5 * (hi - lo) + vec3(1e-5);
  vec3 offset = q - centre;
  vec3 unit = extent / max(abs(offset), vec3(1e-6));
  float t = clamp(min(min(unit.x, unit.y), unit.z), 0.0, 1.0);
  return centre + offset * t;
}

void main() {
  // --- 3×3 neighbourhood statistics + closest-depth velocity dilation -----
  vec3 m1 = vec3(0.0);
  vec3 m2 = vec3(0.0);
  vec3 mn = vec3(1e20);
  vec3 mx = vec3(-1e20);
  vec3 curr = vec3(0.0);

  vec2 vel = vec2(0.0);
  float closest = 1e30;

  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 o = vec2(float(x), float(y)) * uTexel;
      vec3 c = rgbToYCoCg(fetch(vUv + o));
      m1 += c;
      m2 += c * c;
      mn = min(mn, c);
      mx = max(mx, c);
      if (x == 0 && y == 0) curr = c;

      vec3 v = texture2D(velocityBuffer, vUv + o).xyz;
      if (v.z < closest) { closest = v.z; vel = v.xy; }
    }
  }

  vec2 prevUV = vUv - vel;
  vec3 result = curr;

  if (prevUV.x >= 0.0 && prevUV.x <= 1.0 && prevUV.y >= 0.0 && prevUV.y <= 1.0) {
    vec3 history = rgbToYCoCg(compress(max(texture2D(historyBuffer, prevUV).rgb, vec3(0.0))));

    vec3 mean = m1 / 9.0;
    vec3 sigma = sqrt(max(m2 / 9.0 - mean * mean, vec3(0.0)));
    vec3 gamma = vec3(uClipGamma * uLumaClip, uClipGamma, uClipGamma);
    vec3 lo = max(mean - sigma * gamma, mn);
    vec3 hi = min(mean + sigma * gamma, mx);

    history = clipToAABB(lo, hi, curr, history);
    result = mix(history, curr, uAlpha);
  }

  gl_FragColor = vec4(max(expand(ycocgToRgb(result)), vec3(0.0)), 1.0);
}
`;

const copyFragment = /* glsl */ `
uniform sampler2D tSrc;
varying vec2 vUv;
void main() { gl_FragColor = texture2D(tSrc, vUv); }
`;

/** Halton radical-inverse in an arbitrary base. */
function halton(index, base) {
  let f = 1;
  let r = 0;
  let i = index;
  while (i > 0) {
    f /= base;
    r += f * (i % base);
    i = Math.floor(i / base);
  }
  return r;
}

export class TAAPass extends Pass {
  constructor() {
    super('TAAPass');
    this.needsSwap = true;

    this._material = new THREE.ShaderMaterial({
      name: 'TAAResolve',
      uniforms: {
        inputBuffer: { value: null },
        historyBuffer: { value: null },
        velocityBuffer: { value: null },
        uTexel: { value: new THREE.Vector2(1 / 1920, 1 / 1080) },
        uAlpha: { value: 1 },
        uClipGamma: { value: TAA.clipGammaMoving },
        uLumaClip: { value: TAA.lumaClip },
      },
      vertexShader,
      fragmentShader,
      depthWrite: false,
      depthTest: false,
    });
    this.fullscreenMaterial = this._material;

    // Second tiny material used to publish the resolve into the composer's
    // ping-pong chain (the resolve itself must land in a persistent history
    // target, which the composer's buffers are not).
    this._copyMaterial = new THREE.ShaderMaterial({
      name: 'TAACopy',
      uniforms: { tSrc: { value: null } },
      vertexShader,
      fragmentShader: copyFragment,
      depthWrite: false,
      depthTest: false,
    });
    this._copyScene = new THREE.Scene();
    this._copyQuad = new THREE.Mesh(Pass.fullscreenGeometry, this._copyMaterial);
    this._copyQuad.frustumCulled = false;
    this._copyScene.add(this._copyQuad);

    const opts = {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      type: THREE.HalfFloatType,
      depthBuffer: false,
      stencilBuffer: false,
    };
    this._historyA = new THREE.WebGLRenderTarget(1, 1, opts);
    this._historyA.texture.name = 'TAA.HistoryA';
    this._historyB = new THREE.WebGLRenderTarget(1, 1, opts);
    this._historyB.texture.name = 'TAA.HistoryB';
    this._write = 0;

    this._jitterX = new Float32Array(TAA.sampleCount);
    this._jitterY = new Float32Array(TAA.sampleCount);
    for (let i = 0; i < TAA.sampleCount; i++) {
      this._jitterX[i] = halton(i + 1, 2) - 0.5;
      this._jitterY[i] = halton(i + 1, 3) - 0.5;
    }
    this._jitterIndex = 0;

    this._accumulated = 0;
    this._first = true;
    this.width = 1;
    this.height = 1;

    this.invalidate();
  }

  set velocityTexture(tex) {
    this._material.uniforms.velocityBuffer.value = tex;
  }

  invalidate() {
    this._first = true;
    this._accumulated = 0;
  }

  /** Current sub-pixel jitter in pixels, applied by PostFX via setViewOffset. */
  get jitterX() {
    return this._jitterX[this._jitterIndex];
  }

  get jitterY() {
    return this._jitterY[this._jitterIndex];
  }

  advanceJitter() {
    this._jitterIndex = (this._jitterIndex + 1) % TAA.sampleCount;
  }

  /**
   * Decides accumulate-vs-reproject for this frame. Call once from PostFX,
   * before composer.render.
   * @param {boolean} moved whether the unjittered camera changed this frame
   */
  sync(moved) {
    const u = this._material.uniforms;

    if (this._first) {
      this._accumulated = 0;
      u.uAlpha.value = 1;
      u.uClipGamma.value = TAA.clipGammaMoving;
    } else if (moved) {
      this._accumulated = 0;
      u.uAlpha.value = TAA.movingAlpha;
      u.uClipGamma.value = TAA.clipGammaMoving;
    } else {
      // 1/n accumulation, floored at 1/sampleCount so the average keeps
      // tracking the jitter cycle instead of freezing on the first N frames.
      this._accumulated = Math.min(this._accumulated + 1, TAA.sampleCount);
      u.uAlpha.value = 1 / this._accumulated;
      u.uClipGamma.value = TAA.clipGammaStatic;
    }
  }

  /** Marks the first frame as consumed. Call after composer.render. */
  commit() {
    this._first = false;
  }

  render(renderer, inputBuffer, outputBuffer) {
    const u = this._material.uniforms;
    const write = this._write === 0 ? this._historyA : this._historyB;
    const read = this._write === 0 ? this._historyB : this._historyA;

    u.inputBuffer.value = inputBuffer.texture;
    u.historyBuffer.value = read.texture;

    renderer.setRenderTarget(write);
    renderer.render(this.scene, this.camera);

    // Publish into the composer chain. The resolve itself has to land in a
    // persistent target (the composer's two buffers get overwritten
    // downstream), so one cheap blit is the price of keeping a valid history.
    this._copyMaterial.uniforms.tSrc.value = write.texture;
    renderer.setRenderTarget(this.renderToScreen ? null : outputBuffer);
    renderer.render(this._copyScene, this.camera);

    this._write ^= 1;
  }

  setSize(width, height) {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this._historyA.setSize(this.width, this.height);
    this._historyB.setSize(this.width, this.height);
    this._material.uniforms.uTexel.value.set(1 / this.width, 1 / this.height);
    this.invalidate();
  }

  dispose() {
    this._historyA.dispose();
    this._historyB.dispose();
    this._material.dispose();
    this._copyMaterial.dispose();
    super.dispose();
  }
}
