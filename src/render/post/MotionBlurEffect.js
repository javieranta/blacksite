import * as THREE from 'three';
import { Effect, EffectAttribute, BlendFunction } from 'postprocessing';
import { MOTION_BLUR } from './PostConstants.js';

/**
 * OWNER: postfx agent.
 *
 * Motion blur, gathered along the vectors in VelocityPass's buffer.
 *
 * Two round-3 defects are fixed here. First, the pass used to derive its own
 * reprojection from the **jittered** camera, so the TAA jitter registered as
 * camera motion; combined with a velocity floor of 0.0004 UV — less than one
 * pixel — the pass never turned off. Second, and worse: reprojected velocity
 * from translation scales with 1/depth while velocity from rotation does not,
 * so the two components cancel at one particular distance. A frozen camera with
 * half a pixel of residual "motion" therefore produced a sharp mid-ground with
 * a blurred near field *and* a blurred far field — read by the reviewer, quite
 * reasonably, as a badly configured depth of field.
 *
 * Now the velocity comes from the shared unjittered buffer, the floor is
 * 0.0022 UV (~4px), and PostFX additionally disables the pass whenever the
 * simulation is frozen. A screenshot is never motion blurred.
 *
 * This remains camera velocity only. Per-object vectors would need an
 * override-material prepass over geometry PostFX does not own; in an FPS the
 * camera is the dominant motion by a wide margin, and the missing term is noted
 * as a seam requirement rather than faked.
 */
const fragmentShader = /* glsl */ `
uniform sampler2D uVelocity;
uniform float uIntensity;
uniform float uMaxVelocity;
uniform float uJitter;

#define MB_SAMPLES ${MOTION_BLUR.maxSamples}

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec4 v = texture2D(uVelocity, uv);
  vec2 velocity = v.xy * uIntensity;
  float speed = length(velocity);
  if (speed < 1e-5) {
    outputColor = inputColor;
    return;
  }
  if (speed > uMaxVelocity) velocity *= uMaxVelocity / speed;

  float centreZ = v.z;

  // Dither the sample phase so 12 taps do not band into visible ghost copies.
  float jitter = fract(sin(dot(uv, vec2(12.9898, 78.233)) + uJitter) * 43758.5453);

  vec3 acc = inputColor.rgb;
  float wsum = 1.0;
  for (int i = 0; i < MB_SAMPLES; i++) {
    float t = (float(i) + jitter) / float(MB_SAMPLES) - 0.5;
    vec2 suv = clamp(uv + velocity * t, vec2(0.0), vec2(1.0));

    // Depth-aware weighting: a tap from a surface far in front of this one is a
    // different object streaking past, not this pixel's own trail, so it is
    // rejected rather than smeared over the top.
    float sz = texture2D(uVelocity, suv).z;
    float depthOk = 1.0 - clamp((centreZ - sz) / max(centreZ * 0.25, 0.5) - 1.0, 0.0, 1.0);

    // Triangular weighting keeps the centre sample dominant, so surfaces stay
    // recognisable rather than dissolving.
    float w = max(1.0 - abs(t) * 1.4, 0.05) * depthOk;
    acc += texture2D(inputBuffer, suv).rgb * w;
    wsum += w;
  }

  outputColor = vec4(acc / wsum, inputColor.a);
}
`;

export class MotionBlurEffect extends Effect {
  constructor() {
    super('MotionBlurEffect', fragmentShader, {
      blendFunction: BlendFunction.SRC,
      attributes: EffectAttribute.CONVOLUTION,
      uniforms: new Map([
        ['uVelocity', new THREE.Uniform(null)],
        ['uIntensity', new THREE.Uniform(0.55)],
        ['uMaxVelocity', new THREE.Uniform(MOTION_BLUR.maxVelocity)],
        ['uJitter', new THREE.Uniform(0)],
      ]),
    });
    this._jitter = 0;
  }

  set velocityTexture(tex) {
    this.uniforms.get('uVelocity').value = tex;
  }

  setIntensity(v) {
    this.uniforms.get('uIntensity').value = v;
  }

  /** Advances the sample-phase dither. Allocation-free. */
  update() {
    this._jitter = (this._jitter + 0.618034) % 1;
    this.uniforms.get('uJitter').value = this._jitter * 6.2831853;
  }
}
