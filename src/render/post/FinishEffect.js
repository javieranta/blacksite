import * as THREE from 'three';
import { Effect, EffectAttribute, BlendFunction } from 'postprocessing';
import { LUT_GLSL, LUT_SIZE } from './Grade.js';

/**
 * OWNER: postfx agent.
 *
 * The finishing pass: everything that happens between "the scene is lit" and
 * "the sensor reads out". Merged into a single program because these stages all
 * touch the same pixel and splitting them would cost eight more fullscreen
 * bandwidth round-trips for no image-quality gain.
 *
 * Order matters and is physical, not arbitrary:
 *
 *   0. CAS             — contrast-adaptive sharpening, applied in a reversible
 *                        range-compressed space so it works on HDR values.
 *                        WebGL2 has no per-texture LOD bias, so the −0.5 mip
 *                        bias a TAA pipeline normally uses to restore texture
 *                        sharpness is unavailable; CAS restores it at the
 *                        composite instead, and because its amplitude is driven
 *                        by local contrast it cannot re-introduce aliasing in
 *                        the flat regions a mip bias would have hurt.
 *   1. lens transform  — screen shake and the radial chromatic split are
 *                        properties of the glass, so they happen on the *sample
 *                        position*, before anything reads a colour.
 *   2. lens dirt       — additive, driven by the bloom buffer, so dirt is only
 *                        visible where something is actually blowing out.
 *   3. vignette        — a multiplicative light falloff, therefore linear and
 *                        pre-tonemap. Doing it after the curve looks painted on.
 *   4. exposure        — sampled from AutoExposurePass's 1×1 metering texture:
 *                        log-average luminance with EV compensation, clamped to
 *                        ±1 stop of the authored per-time-of-day stop.
 *   5. ACES filmic     — Hill's fitted RRT+ODT. Rolls the highlights instead of
 *                        clipping them.
 *   6. sRGB transfer   — we grade in display space, like every real colourist.
 *   7. 32³ LUT grade   — the authored look: lift/gamma/gain, so shadows,
 *                        midtones and highlights are tinted independently
 *                        rather than by one global multiply.
 *   8. film grain      — display-referred, weighted into shadows and midtones.
 *   9. damage pulse    — red edge wash on hurt().
 *  10. back to linear  — the final EffectPass applies the output transfer, and
 *                        three's ordered dither runs at the 8-bit write, which
 *                        is what kills the banding across the ground gradient.
 */
const fragmentShader = /* glsl */ `
uniform sampler2D uExposureTex;
uniform float uExposureScale;
uniform float uExposureOverride;
uniform float uRawOutput;

uniform sampler2D uLut;
uniform float uLutSize;
uniform float uLutStrength;

uniform sampler2D uBloomTex;
uniform sampler2D uDirtTex;
uniform float uDirtAmount;
uniform float uDirtTiles;

uniform float uCas;

uniform float uCA;
uniform float uCAPower;

uniform float uVignette;
uniform vec2 uVignetteRange;

uniform float uGrain;
uniform vec2 uGrainGains;
uniform vec2 uGrainScale;

uniform vec3 uShake;
uniform float uShakeZoom;

uniform float uHurt;
uniform vec3 uHurtColour;
uniform vec2 uHurtRange;

${LUT_GLSL}

const mat3 ACES_IN = mat3(
  0.59719, 0.07600, 0.02840,
  0.35458, 0.90834, 0.13383,
  0.04823, 0.01566, 0.83777
);
const mat3 ACES_OUT = mat3(
   1.60475, -0.10208, -0.00327,
  -0.53108,  1.10813, -0.07276,
  -0.07367, -0.00605,  1.07602
);

vec3 rrtOdtFit(const in vec3 v) {
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}

vec3 acesFilmic(const in vec3 colour) {
  vec3 v = ACES_IN * colour;
  v = rrtOdtFit(v);
  return clamp(ACES_OUT * v, 0.0, 1.0);
}

vec3 encodeTransfer(const in vec3 c) {
  vec3 lo = c * 12.92;
  vec3 hi = 1.055 * pow(max(c, vec3(0.0)), vec3(0.41666667)) - 0.055;
  return mix(hi, lo, step(c, vec3(0.0031308)));
}

vec3 decodeTransfer(const in vec3 c) {
  vec3 lo = c / 12.92;
  vec3 hi = pow(max((c + 0.055) / 1.055, vec3(0.0)), vec3(2.4));
  return mix(hi, lo, step(c, vec3(0.04045)));
}

/** Reversible range compression: HDR → [0,1) and back. */
vec3 rc(const in vec3 c) { return c / (1.0 + c); }
vec3 rcInv(const in vec3 c) { return c / max(1.0 - c, vec3(1e-4)); }

/**
 * AMD FidelityFX Contrast Adaptive Sharpening, cross-tap variant, evaluated in
 * compressed space so HDR radiance behaves. The amplitude term is what makes it
 * safe: it goes to zero where the neighbourhood is already at the extremes of
 * the range, so blown speculars and flat surfaces are left alone and only real
 * edge detail is boosted.
 */
vec3 cas(const in vec2 uv, const in vec3 centre) {
  if (uCas <= 0.0) return centre;
  vec3 e = rc(centre);
  vec3 n = rc(max(texture2D(inputBuffer, uv + vec2(0.0, texelSize.y)).rgb, vec3(0.0)));
  vec3 s = rc(max(texture2D(inputBuffer, uv - vec2(0.0, texelSize.y)).rgb, vec3(0.0)));
  vec3 w = rc(max(texture2D(inputBuffer, uv - vec2(texelSize.x, 0.0)).rgb, vec3(0.0)));
  vec3 v = rc(max(texture2D(inputBuffer, uv + vec2(texelSize.x, 0.0)).rgb, vec3(0.0)));

  vec3 mn = min(min(min(n, s), min(w, v)), e);
  vec3 mx = max(max(max(n, s), max(w, v)), e);
  vec3 amp = clamp(min(mn, vec3(1.0) - mx) / max(mx, vec3(1e-4)), 0.0, 1.0);
  amp = sqrt(amp);

  float peak = -1.0 / mix(9.0, 5.5, uCas);
  vec3 k = amp * peak;
  vec3 out0 = (e + (n + s + w + v) * k) / (1.0 + 4.0 * k);
  return rcInv(clamp(out0, vec3(0.0), vec3(0.9995)));
}

float hash21(const in vec2 p) {
  vec2 q = fract(p * vec2(123.34, 456.21));
  q += dot(q, q + 45.32);
  return fract(q.x * q.y);
}

float valueNoise(const in vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

/** Two-octave film grain — structured, not white noise, so it reads as stock. */
float filmGrain(const in vec2 uv, const in float t) {
  vec2 p = uv * resolution;
  float drift = floor(t * 24.0);
  float n = valueNoise(p * uGrainScale.x + vec2(drift * 17.31, drift * 9.77)) * 0.68;
  n += valueNoise(p * uGrainScale.y + vec2(drift * -5.13, drift * 11.09)) * 0.32;
  return n;
}

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  // --- 0. debug passthrough -------------------------------------------------
  // The AO/firefly debug views carry a *0..1 term*, not radiance. Running one
  // through ACES makes it unreadable in exactly the direction that hides a weak
  // term: the curve maps 0.85 → 0.92 and 1.0 → 0.95, so a 15% occlusion arrives
  // on screen as a 3% one and every previous "the AO buffer looks white" reading
  // was taken through a compressor. decodeTransfer here cancels the sRGB encode
  // the EffectPass applies at the write, so the PNG byte is 255·term exactly and
  // can be measured rather than eyeballed.
  if (uRawOutput > 0.5) {
    outputColor = vec4(decodeTransfer(clamp(inputColor.rgb, 0.0, 1.0)), inputColor.a);
    return;
  }

  // --- 1. lens transform: shake (zoom + roll + translate) ------------------
  vec2 c = uv - 0.5;
  c.x *= aspect;

  if (uShakeZoom < 0.99999 || uShake.z != 0.0) {
    c *= uShakeZoom;
    float sr = sin(uShake.z);
    float cr = cos(uShake.z);
    c = vec2(c.x * cr - c.y * sr, c.x * sr + c.y * cr);
  }

  float radius = length(c);
  vec2 sc = c;
  sc.x /= aspect;
  sc += uShake.xy;
  vec2 base = clamp(sc + 0.5, vec2(0.0005), vec2(0.9995));

  // --- 0/1b. CAS, then chromatic aberration (edges only) -------------------
  vec3 colour = cas(base, max(texture2D(inputBuffer, base).rgb, vec3(0.0)));
  if (uCA > 0.0) {
    // radius is aspect-corrected, so ~1.02 at the corners of a 16:9 frame.
    // Normalising by that (not by something smaller) plus a cubic falloff is
    // what keeps the fringing in the corners instead of halfway up the frame.
    float edge = pow(clamp(radius / 1.02, 0.0, 1.0), uCAPower);
    vec2 dir = sc * uCA * edge;
    colour.r = texture2D(inputBuffer, clamp(base + dir, vec2(0.0), vec2(1.0))).r;
    colour.b = texture2D(inputBuffer, clamp(base - dir, vec2(0.0), vec2(1.0))).b;
  }
  colour = max(colour, vec3(0.0));

  // --- 2. lens dirt, driven by what is actually blowing out ----------------
  if (uDirtAmount > 0.0) {
    vec3 bloomC = texture2D(uBloomTex, base).rgb;
    float bl = dot(bloomC, vec3(0.2126, 0.7152, 0.0722));
    vec3 dirt = texture2D(uDirtTex, uv * uDirtTiles).rgb;
    colour += dirt * bl * uDirtAmount;
  }

  // --- 3. vignette (linear, pre-curve) -------------------------------------
  if (uVignette > 0.0) {
    float v = 1.0 - smoothstep(uVignetteRange.x, uVignetteRange.y, radius) * uVignette;
    colour *= v;
  }

  // --- 4/5. metered exposure + ACES ----------------------------------------
  float exposure = uExposureOverride > 0.0
    ? uExposureOverride
    : texture2D(uExposureTex, vec2(0.5)).r * uExposureScale;
  colour *= max(exposure, 1e-4);
  colour = acesFilmic(colour);

  // --- 6/7. grade in display space -----------------------------------------
  vec3 disp = encodeTransfer(colour);
  if (uLutStrength > 0.0) {
    disp = mix(disp, sampleStripLUT(uLut, disp, uLutSize), uLutStrength);
  }

  // --- 8. film grain --------------------------------------------------------
  if (uGrain > 0.0) {
    float lum = dot(disp, vec3(0.2126, 0.7152, 0.0722));
    float w = mix(uGrainGains.x, uGrainGains.y, smoothstep(0.0, 0.82, lum));
    disp += (filmGrain(uv, time) - 0.5) * uGrain * w;
  }

  // --- 9. damage pulse ------------------------------------------------------
  if (uHurt > 0.0) {
    float edge = smoothstep(uHurtRange.x, uHurtRange.y, radius);
    disp = mix(disp, uHurtColour, clamp(edge * uHurt, 0.0, 1.0));
    disp += uHurtColour * 0.06 * uHurt;
  }

  disp = clamp(disp, 0.0, 1.0);
  outputColor = vec4(decodeTransfer(disp), inputColor.a);
}
`;

export class FinishEffect extends Effect {
  constructor({ lut, dirt, bloomTexture, exposurePass, casSharpness = 0.62 }) {
    super('FinishEffect', fragmentShader, {
      blendFunction: BlendFunction.SRC,
      attributes: EffectAttribute.CONVOLUTION,
      uniforms: new Map([
        ['uExposureTex', new THREE.Uniform(null)],
        ['uExposureScale', new THREE.Uniform(1.0)],
        ['uExposureOverride', new THREE.Uniform(0.0)],
        ['uRawOutput', new THREE.Uniform(0.0)],

        ['uLut', new THREE.Uniform(lut)],
        ['uLutSize', new THREE.Uniform(LUT_SIZE)],
        ['uLutStrength', new THREE.Uniform(1.0)],

        ['uBloomTex', new THREE.Uniform(bloomTexture)],
        ['uDirtTex', new THREE.Uniform(dirt)],
        ['uDirtAmount', new THREE.Uniform(0.42)],
        ['uDirtTiles', new THREE.Uniform(1.0)],

        ['uCas', new THREE.Uniform(casSharpness)],

        ['uCA', new THREE.Uniform(0.0032)],
        ['uCAPower', new THREE.Uniform(3.1)],

        ['uVignette', new THREE.Uniform(0.32)],
        ['uVignetteRange', new THREE.Uniform(new THREE.Vector2(0.42, 1.06))],

        ['uGrain', new THREE.Uniform(0.028)],
        ['uGrainGains', new THREE.Uniform(new THREE.Vector2(1.25, 0.3))],
        ['uGrainScale', new THREE.Uniform(new THREE.Vector2(0.55, 0.19))],

        ['uShake', new THREE.Uniform(new THREE.Vector3(0, 0, 0))],
        ['uShakeZoom', new THREE.Uniform(1)],

        ['uHurt', new THREE.Uniform(0)],
        ['uHurtColour', new THREE.Uniform(new THREE.Vector3(0.62, 0.028, 0.02))],
        ['uHurtRange', new THREE.Uniform(new THREE.Vector2(0.18, 0.86))],
      ]),
    });

    this.exposurePass = exposurePass;
  }

  /** The metering target ping-pongs, so the binding is refreshed each frame. */
  update() {
    if (this.exposurePass) {
      this.uniforms.get('uExposureTex').value = this.exposurePass.texture;
    }
  }

  /** Manual trim on top of the metered stop. */
  set exposureScale(v) {
    this.uniforms.get('uExposureScale').value = v;
  }

  /** > 0 bypasses the meter entirely. Used by the AO debug views. */
  set exposureOverride(v) {
    this.uniforms.get('uExposureOverride').value = v;
  }

  /**
   * Debug views only: emit the incoming 0..1 term untouched, so the captured
   * PNG byte is 255·term. Everything between here and the write — exposure,
   * ACES, grade, grain, lens — is skipped.
   */
  set rawOutput(on) {
    this.uniforms.get('uRawOutput').value = on ? 1 : 0;
  }

  set lut(tex) {
    this.uniforms.get('uLut').value = tex;
  }

  set bloomTexture(tex) {
    this.uniforms.get('uBloomTex').value = tex;
  }

  set cas(v) {
    this.uniforms.get('uCas').value = v;
  }
}
