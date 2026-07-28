import * as THREE from 'three';
import { Effect, EffectAttribute, BlendFunction } from 'postprocessing';
import { DOF } from './PostConstants.js';

/**
 * OWNER: postfx agent.
 *
 * Depth of field for an FPS, which mostly means: almost none.
 *
 * ── What was wrong before ───────────────────────────────────────────────────
 * The chain used postprocessing's DepthOfFieldEffect configured with
 * `focusDistance: 3.4`. That option is a **normalised depth** in [0,1], not
 * metres — 3.4 is four times past the far plane, so every pixel in the frame
 * came out on the near side of focus and the whole image was assigned a
 * near-field circle of confusion. `focusRange: 6.5` then landed on
 * `focalLength` through the effect's option aliasing. The pass happened to be
 * disabled at hipfire, so the defect only showed in ADS captures, where it
 * blurred the nearest ground and the mid-ground alike.
 *
 * ── What this is ────────────────────────────────────────────────────────────
 * A real thin lens. Focal length follows from the ADS vertical FOV on a 35mm
 * frame, the aperture is f/5.6, and the circle of confusion is
 *
 *     C = (f/N) · f · |z − z_f| / (z · (z_f − f))
 *
 * in metres on the sensor, converted to pixels by the sensor height. Focus is
 * locked to the depth under the reticle, sampled from the centre of the depth
 * buffer with a 5-tap nearest-wins filter so a sliver of railing across the
 * crosshair cannot yank focus to 1m.
 *
 * At f/5.6 focused 30m out the far-field CoC is a fraction of a pixel — the
 * far plate stays *sharp*, which is what you want when the thing you are
 * shooting at is 60m away. The clamps make that a guarantee rather than a
 * consequence: 2px maximum behind focus, 4.5px in front. What survives is a
 * mild near-field falloff on the ground and cover in the bottom of the frame,
 * which is exactly the read a real sight picture has.
 *
 * The weapon is not in this buffer at all — ViewModelPass composites it after
 * this pass with a cleared depth buffer — so the viewmodel is excluded by
 * construction and cannot be blurred by whatever wall is behind it.
 */
const fragmentShader = /* glsl */ `
uniform float uAperture;      // f / N, metres
uniform float uFocalLength;   // metres
uniform float uSensorHeight;  // metres
uniform float uMaxFar;        // px
uniform float uMaxNear;       // px
uniform float uMinCoC;        // px
uniform float uAmount;        // 0..1 ADS ease
uniform vec2 uFocusRange;     // metres, clamp on the reticle probe

float linearZ(const in float d) {
  return -(cameraNear * cameraFar) / ((cameraFar - cameraNear) * d - cameraFar);
}

/** Signed circle of confusion in pixels. Negative = in front of focus. */
float cocPixels(const in float z, const in float zf) {
  float c = uAperture * uFocalLength * (z - zf) / max(z * (zf - uFocalLength), 1e-5);
  float px = c / uSensorHeight * resolution.y;
  return clamp(px, -uMaxNear, uMaxFar) * uAmount;
}

/** Reticle depth: nearest of five taps around the screen centre. */
float focusDistance() {
  vec2 o = texelSize * 3.0;
  float z = linearZ(readDepth(vec2(0.5, 0.5)));
  z = min(z, linearZ(readDepth(vec2(0.5 + o.x, 0.5))));
  z = min(z, linearZ(readDepth(vec2(0.5 - o.x, 0.5))));
  z = min(z, linearZ(readDepth(vec2(0.5, 0.5 + o.y))));
  z = min(z, linearZ(readDepth(vec2(0.5, 0.5 - o.y))));
  return clamp(z, uFocusRange.x, uFocusRange.y);
}

// Two hexagonal rings, the outer one rotated 30°: 13 taps total, which is
// plenty for a 4px maximum radius and avoids the ring artefacts a single
// hexagon shows. GLSL ES 1.00 has no const array initialisers, so the
// directions are evaluated — six sin/cos pairs is free next to the texture
// fetches they position.
#define DOF_STEP 1.0471975512
#define DOF_HALF_STEP 0.5235987756

void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor) {
  float zf = focusDistance();
  float z = linearZ(depth);
  float coc = cocPixels(z, zf);
  float r = abs(coc);

  if (r < uMinCoC) {
    outputColor = inputColor;
    return;
  }

  vec3 acc = inputColor.rgb;
  float wsum = 1.0;

  for (int i = 0; i < 6; i++) {
    float a = float(i) * DOF_STEP;
    vec2 d1 = vec2(cos(a), sin(a)) * (r * 0.55) * texelSize;
    float b = a + DOF_HALF_STEP;
    vec2 d2 = vec2(cos(b), sin(b)) * r * texelSize;

    vec2 uv1 = clamp(uv + d1, vec2(0.0), vec2(1.0));
    vec2 uv2 = clamp(uv + d2, vec2(0.0), vec2(1.0));

    float c1 = abs(cocPixels(linearZ(readDepth(uv1)), zf));
    float c2 = abs(cocPixels(linearZ(readDepth(uv2)), zf));

    // A tap only contributes if its own blur circle actually reaches this
    // pixel. Without that test a sharp background bleeds over a blurred
    // foreground and every silhouette grows a halo.
    float w1 = clamp(c1 - r * 0.55 + 1.0, 0.0, 1.0);
    float w2 = clamp(c2 - r + 1.0, 0.0, 1.0);

    acc += texture2D(inputBuffer, uv1).rgb * w1;
    acc += texture2D(inputBuffer, uv2).rgb * w2;
    wsum += w1 + w2;
  }

  outputColor = vec4(acc / wsum, inputColor.a);
}
`;

export class DoFEffect extends Effect {
  constructor() {
    super('DoFEffect', fragmentShader, {
      blendFunction: BlendFunction.SRC,
      attributes: EffectAttribute.DEPTH | EffectAttribute.CONVOLUTION,
      uniforms: new Map([
        ['uAperture', new THREE.Uniform(0.0062)],
        ['uFocalLength', new THREE.Uniform(0.0346)],
        ['uSensorHeight', new THREE.Uniform(DOF.sensorHeightMM * 0.001)],
        ['uMaxFar', new THREE.Uniform(DOF.maxFarCoCPx)],
        ['uMaxNear', new THREE.Uniform(DOF.maxNearCoCPx)],
        ['uMinCoC', new THREE.Uniform(DOF.minCoCPx)],
        ['uAmount', new THREE.Uniform(0)],
        [
          'uFocusRange',
          new THREE.Uniform(new THREE.Vector2(DOF.minFocus, DOF.maxFocus)),
        ],
      ]),
    });
  }

  /**
   * Derives the focal length from the camera's current vertical FOV on a 35mm
   * frame, then the aperture from the f-stop.
   * @param {number} fovDeg vertical field of view in degrees
   */
  setLens(fovDeg) {
    const half = THREE.MathUtils.degToRad(fovDeg) * 0.5;
    const sensor = DOF.sensorHeightMM * 0.001;
    const f = (sensor * 0.5) / Math.max(Math.tan(half), 1e-4);
    this.uniforms.get('uFocalLength').value = f;
    this.uniforms.get('uAperture').value = f / DOF.fStop;
  }

  /** 0 = no depth of field at all, 1 = the full ADS lens. */
  set amount(v) {
    this.uniforms.get('uAmount').value = v;
  }

  get amount() {
    return this.uniforms.get('uAmount').value;
  }
}
