import * as THREE from 'three';
import { Pass } from 'postprocessing';
import { GTAO } from './PostConstants.js';

/**
 * OWNER: postfx agent.
 *
 * Ground-truth ambient occlusion — the horizon-search visibility integral from
 * Jimenez et al. 2016 ("Practical Realtime Strategies for Accurate Indirect
 * Occlusion"), evaluated at half resolution with a temporal filter, plus a
 * screen-space contact shadow marched toward the sun and a bent normal.
 *
 * ── Why this replaced the round-3 obscurance estimator ──────────────────────
 * Round 3 ran McGuire's Scalable Ambient Obscurance at a 1.9m broad radius and
 * a 0.45m contact radius. The estimator was correct and the depth buffer it fed
 * on was verified good — but the *result* was wrong for this image in two ways
 * that compounded until nothing was visible:
 *
 *   • Obscurance is a cosine-weighted *sum*, not a visibility integral. It is
 *     numerically small unless several taps land squarely on an occluder, so a
 *     crate/floor junction returned ~0.85–0.95 where the true horizon-based
 *     visibility is ~0.35–0.5. An AO-only debug capture showed the term as a
 *     near-uniform white field with 2–3px dark hairlines at silhouettes.
 *   • Whatever survived was then run through the exposure stop, ACES and a LUT
 *     with a 0.026–0.044 black lift. A 10% multiply upstream of that chain is
 *     worth about two 8-bit codes on screen.
 *
 * GTAO's integral is bounded in [0,1] by construction and reaches genuinely low
 * values in a corner, so it survives the tone curve. The radius is 0.6m rather
 * than 1.9m for the same reason: a 2m radius integrates whole rooms and returns
 * a flat, low-contrast term, while 0.6m is the *contact* scale — the one that
 * binds an object to the floor it is standing on.
 *
 * ── Output ──────────────────────────────────────────────────────────────────
 *   R — visibility, 1 = unoccluded
 *   G — sun contact shadow, 1 = unshadowed
 *   B — bent-normal sky share: how much of the upper hemisphere the average
 *       unoccluded direction still faces. Undersides come out low, which is how
 *       AOApplyEffect knows to take more sky energy out of them.
 *   A — 1 for geometry, 0 for sky
 */

const vertexShader = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 1.0, 1.0);
}
`;

const aoFragment = /* glsl */ `
uniform highp sampler2D depthBuffer;
uniform mat4 uInvProjection;
uniform mat4 uProjection;
uniform mat3 uViewToWorld;
uniform vec2 uResolution;     // half-res pixel dimensions
uniform vec2 uFullTexel;      // 1 / full-res
uniform vec3 uSunView;
uniform float uRadius;
uniform float uFocalY;
uniform float uMinPx;
uniform float uMaxPx;
uniform float uFalloffStart;
uniform float uContactLength;
uniform float uContactThickness;
uniform float uContactStrength;
uniform float uFrame;
varying vec2 vUv;

#define SLICES ${GTAO.slices}
#define STEPS ${GTAO.steps}
#define CONTACT_STEPS ${GTAO.contactSteps}

const float PI = 3.141592653589793;
const float HALF_PI = 1.570796326794897;

float rawDepth(const in vec2 uv) {
  return texture2D(depthBuffer, uv).r;
}

vec3 viewFromDepth(const in vec2 uv, const in float d) {
  vec4 ndc = vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  vec4 v = uInvProjection * ndc;
  return v.xyz / v.w;
}

/**
 * View-space normal from four full-resolution depth taps, choosing the nearer
 * neighbour on each axis so silhouettes do not smear into black haloes.
 */
vec3 reconstructNormal(const in vec2 uv, const in vec3 p) {
  vec2 tx = vec2(uFullTexel.x, 0.0);
  vec2 ty = vec2(0.0, uFullTexel.y);
  vec3 l = viewFromDepth(uv - tx, rawDepth(uv - tx));
  vec3 r = viewFromDepth(uv + tx, rawDepth(uv + tx));
  vec3 d = viewFromDepth(uv - ty, rawDepth(uv - ty));
  vec3 u = viewFromDepth(uv + ty, rawDepth(uv + ty));
  vec3 dx = abs(l.z - p.z) < abs(r.z - p.z) ? (p - l) : (r - p);
  vec3 dy = abs(d.z - p.z) < abs(u.z - p.z) ? (p - d) : (u - p);
  vec3 n = cross(dx, dy);
  float len = length(n);
  return len > 1e-9 ? n / len : vec3(0.0, 0.0, 1.0);
}

/** Interleaved gradient noise — the cheapest good per-pixel rotation. */
float igNoise(const in vec2 pixel) {
  return fract(52.9829189 * fract(dot(pixel, vec2(0.06711056, 0.00583715))));
}

/**
 * Screen-space contact shadow: a short march toward the sun through the depth
 * buffer. This is the term a cascaded shadow map physically cannot deliver —
 * at 2048² over 120m a texel is ~6cm, and the depth bias needed to stop acne is
 * larger than the gap between a crate and the floor it rests on, so the last
 * few centimetres of every contact are lost. Marching the depth buffer gets
 * them back, and unlike AO this one is allowed to darken *direct* light.
 */
float contactShadow(const in vec3 p, const in vec3 n, const in float jitter) {
  float ndl = dot(n, uSunView);
  if (ndl <= 0.02) return 1.0;

  float occ = 0.0;
  float stepLen = uContactLength / float(CONTACT_STEPS);
  for (int i = 0; i < CONTACT_STEPS; i++) {
    float dist = (float(i) + jitter) * stepLen + 0.012;
    vec3 sp = p + uSunView * dist;
    vec4 cp = uProjection * vec4(sp, 1.0);
    if (cp.w <= 1e-5) break;
    vec2 suv = (cp.xy / cp.w) * 0.5 + 0.5;
    if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) break;

    float sd = rawDepth(suv);
    if (sd >= 0.999999) continue;
    float sz = -viewFromDepth(suv, sd).z;
    float diff = (-sp.z) - sz;   // >0 ⇒ something sits in front of the ray

    if (diff > 0.008 && diff < uContactThickness) {
      // Near hits matter most: a blocker 5cm away is a contact, one 50cm away
      // is the shadow map's job and would double-darken if taken at full value.
      float w = 1.0 - dist / uContactLength;
      occ = max(occ, w * w);
    }
  }
  return clamp(1.0 - occ * uContactStrength * clamp(ndl * 3.0, 0.0, 1.0), 0.0, 1.0);
}

void main() {
  float d = rawDepth(vUv);
  if (d >= 0.999999) {
    gl_FragColor = vec4(1.0, 1.0, 1.0, 0.0);
    return;
  }

  vec3 p = viewFromDepth(vUv, d);
  vec3 n = reconstructNormal(vUv, p);
  vec3 v = normalize(-p);
  float invZ = 1.0 / max(-p.z, 1e-4);

  // proj[1][1]/2 · (1/z) maps a world offset to NDC; times half-res height for
  // pixels. The x axis needs no separate term: proj[0][0]·W == proj[1][1]·H for
  // any correct aspect, so the search disk is isotropic in pixels.
  float rPx = clamp(uRadius * uFocalY * invZ * uResolution.y, uMinPx, uMaxPx);
  vec2 pxToUV = 1.0 / uResolution;

  vec2 pixel = vUv * uResolution;
  float rotBase = (igNoise(pixel) + uFrame * 0.6180339887) * PI;
  float stepOff = fract(igNoise(pixel + vec2(37.0, 17.0)) + uFrame * 0.7548776662);

  float visibility = 0.0;
  vec3 bent = vec3(0.0);
  float bentWeight = 0.0;
  float falloffSpan = max(uRadius * (1.0 - uFalloffStart), 1e-4);

  for (int s = 0; s < SLICES; s++) {
    float phi = rotBase + float(s) * (PI / float(SLICES));
    float cp = cos(phi);
    float sp = sin(phi);
    vec2 dirUV = vec2(cp, sp) * pxToUV;

    // Slice frame: the plane containing the view vector and the screen-space
    // direction. The normal is projected into it before the arc is integrated.
    vec3 dirVS = vec3(cp, sp, 0.0);
    vec3 ortho = dirVS - v * dot(dirVS, v);
    float orthoLen = length(ortho);
    if (orthoLen < 1e-5) continue;
    vec3 orthoN = ortho / orthoLen;
    vec3 axis = cross(orthoN, v);
    float axisLen = length(axis);
    if (axisLen < 1e-5) continue;
    axis /= axisLen;

    vec3 projN = n - axis * dot(n, axis);
    float projLen = length(projN);
    if (projLen < 1e-4) continue;
    float cosN = clamp(dot(projN, v) / projLen, -1.0, 1.0);
    float sgn = dot(orthoN, projN) < 0.0 ? -1.0 : 1.0;
    float nAngle = sgn * acos(cosN);

    float h0c = -1.0;   // horizon toward −orthoN
    float h1c = -1.0;   // horizon toward +orthoN

    for (int i = 0; i < STEPS; i++) {
      // A mild power distribution puts more taps near the centre, which is
      // where sub-metre contact occlusion actually lives.
      float t = (float(i) + stepOff) / float(STEPS);
      float px = max(1.0 + t * t * rPx, 1.0);
      vec2 off = dirUV * px;

      vec2 uvA = vUv + off;
      if (uvA.x > 0.0 && uvA.x < 1.0 && uvA.y > 0.0 && uvA.y < 1.0) {
        float sd = rawDepth(uvA);
        if (sd < 0.999999) {
          vec3 ds = viewFromDepth(uvA, sd) - p;
          float len = length(ds);
          if (len > 1e-5) {
            float c = dot(ds, v) / len;
            float w = clamp((uRadius - len) / falloffSpan, 0.0, 1.0);
            h1c = max(h1c, mix(-1.0, c, w));
          }
        }
      }

      vec2 uvB = vUv - off;
      if (uvB.x > 0.0 && uvB.x < 1.0 && uvB.y > 0.0 && uvB.y < 1.0) {
        float sd = rawDepth(uvB);
        if (sd < 0.999999) {
          vec3 ds = viewFromDepth(uvB, sd) - p;
          float len = length(ds);
          if (len > 1e-5) {
            float c = dot(ds, v) / len;
            float w = clamp((uRadius - len) / falloffSpan, 0.0, 1.0);
            h0c = max(h0c, mix(-1.0, c, w));
          }
        }
      }
    }

    // Horizons as signed angles from the view vector, clamped to the normal's
    // hemisphere, then the closed-form arc integral.
    float h0 = -acos(clamp(h0c, -1.0, 1.0));
    float h1 = acos(clamp(h1c, -1.0, 1.0));
    h0 = nAngle + max(h0 - nAngle, -HALF_PI);
    h1 = nAngle + min(h1 - nAngle, HALF_PI);

    float sinN = sin(nAngle);
    float a0 = 0.25 * (-cos(2.0 * h0 - nAngle) + cosN + 2.0 * h0 * sinN);
    float a1 = 0.25 * (-cos(2.0 * h1 - nAngle) + cosN + 2.0 * h1 * sinN);
    visibility += projLen * (a0 + a1);

    // Bent normal: the bisector of the unoccluded arc, weighted by how much of
    // the normal this slice actually represents.
    float bentAngle = (h0 + h1) * 0.5;
    bent += (v * cos(bentAngle) + orthoN * sin(bentAngle)) * projLen;
    bentWeight += projLen;
  }

  float vis = clamp(visibility / float(SLICES), 0.0, 1.0);

  vec3 bentN = bentWeight > 1e-5 ? normalize(bent) : n;
  float bentUp = (uViewToWorld * bentN).y;
  float skyShare = clamp(bentUp * 0.5 + 0.5, 0.0, 1.0);

  float jitter = fract(igNoise(pixel + vec2(11.0, 71.0)) + uFrame * 0.381966);
  float contact = contactShadow(p, n, jitter);

  gl_FragColor = vec4(vis, contact, skyShare, 1.0);
}
`;

const temporalFragment = /* glsl */ `
uniform sampler2D uRaw;
uniform sampler2D uHistory;
uniform sampler2D uVelocity;
uniform vec2 uTexel;
uniform float uAlpha;
varying vec2 vUv;

void main() {
  vec4 c = texture2D(uRaw, vUv);
  vec4 mn = c;
  vec4 mx = c;
  vec4 s;
  s = texture2D(uRaw, vUv + vec2(uTexel.x, 0.0));  mn = min(mn, s); mx = max(mx, s);
  s = texture2D(uRaw, vUv - vec2(uTexel.x, 0.0));  mn = min(mn, s); mx = max(mx, s);
  s = texture2D(uRaw, vUv + vec2(0.0, uTexel.y));  mn = min(mn, s); mx = max(mx, s);
  s = texture2D(uRaw, vUv - vec2(0.0, uTexel.y));  mn = min(mn, s); mx = max(mx, s);

  vec2 vel = texture2D(uVelocity, vUv).xy;
  vec2 prevUV = vUv - vel;

  float alpha = uAlpha;
  if (prevUV.x < 0.0 || prevUV.x > 1.0 || prevUV.y < 0.0 || prevUV.y > 1.0) {
    alpha = 1.0;
  }

  vec4 h = clamp(texture2D(uHistory, prevUV), mn, mx);
  gl_FragColor = mix(h, c, alpha);
}
`;

export class GTAOPass extends Pass {
  constructor(camera) {
    super('GTAOPass');
    this.needsSwap = false;
    this.needsDepthTexture = true;
    this.worldCamera = camera;

    this._aoMaterial = new THREE.ShaderMaterial({
      name: 'GTAO',
      uniforms: {
        depthBuffer: { value: null },
        uInvProjection: { value: new THREE.Matrix4() },
        uProjection: { value: new THREE.Matrix4() },
        uViewToWorld: { value: new THREE.Matrix3() },
        uResolution: { value: new THREE.Vector2(1, 1) },
        uFullTexel: { value: new THREE.Vector2(1, 1) },
        uSunView: { value: new THREE.Vector3(0.3, 0.9, 0.3) },
        uRadius: { value: GTAO.radius },
        uFocalY: { value: 0.6 },
        uMinPx: { value: GTAO.minRadiusPx },
        uMaxPx: { value: GTAO.maxRadiusPx },
        uFalloffStart: { value: GTAO.falloffStart },
        uContactLength: { value: GTAO.contactLength },
        uContactThickness: { value: GTAO.contactThickness },
        uContactStrength: { value: GTAO.contactStrength },
        uFrame: { value: 0 },
      },
      vertexShader,
      fragmentShader: aoFragment,
      depthWrite: false,
      depthTest: false,
    });
    this.fullscreenMaterial = this._aoMaterial;

    this._temporalMaterial = new THREE.ShaderMaterial({
      name: 'GTAOTemporal',
      uniforms: {
        uRaw: { value: null },
        uHistory: { value: null },
        uVelocity: { value: null },
        uTexel: { value: new THREE.Vector2(1, 1) },
        uAlpha: { value: 1 },
      },
      vertexShader,
      fragmentShader: temporalFragment,
      depthWrite: false,
      depthTest: false,
    });
    this._temporalScene = new THREE.Scene();
    this._temporalQuad = new THREE.Mesh(Pass.fullscreenGeometry, this._temporalMaterial);
    this._temporalQuad.frustumCulled = false;
    this._temporalScene.add(this._temporalQuad);

    const opts = {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      type: THREE.HalfFloatType,
      depthBuffer: false,
      stencilBuffer: false,
    };
    this._raw = new THREE.WebGLRenderTarget(1, 1, opts);
    this._raw.texture.name = 'GTAO.Raw';
    this._historyA = new THREE.WebGLRenderTarget(1, 1, opts);
    this._historyA.texture.name = 'GTAO.HistoryA';
    this._historyB = new THREE.WebGLRenderTarget(1, 1, opts);
    this._historyB.texture.name = 'GTAO.HistoryB';
    this._write = 0;

    this._frame = 0;
    this._accumulated = 0;
    this._first = true;
    this.halfWidth = 1;
    this.halfHeight = 1;
  }

  set mainCamera(value) {
    this.worldCamera = value;
  }

  getDepthTexture() {
    return this._aoMaterial.uniforms.depthBuffer.value;
  }

  setDepthTexture(depthTexture) {
    this._aoMaterial.uniforms.depthBuffer.value = depthTexture;
  }

  /** The temporally filtered occlusion buffer (half resolution). */
  get texture() {
    return (this._write === 0 ? this._historyA : this._historyB).texture;
  }

  get texel() {
    return this._temporalMaterial.uniforms.uTexel.value;
  }

  set velocityTexture(tex) {
    this._temporalMaterial.uniforms.uVelocity.value = tex;
  }

  invalidate() {
    this._first = true;
    this._accumulated = 0;
  }

  /**
   * @param {THREE.Camera} camera jittered world camera (matches the depth buffer)
   * @param {THREE.Vector3} sunView normalised sun direction in view space
   * @param {boolean} moved whether the unjittered camera changed this frame
   */
  sync(camera, sunView, moved) {
    const u = this._aoMaterial.uniforms;
    u.uInvProjection.value.copy(camera.projectionMatrixInverse);
    u.uProjection.value.copy(camera.projectionMatrix);
    u.uViewToWorld.value.setFromMatrix4(camera.matrixWorld);
    u.uFocalY.value = camera.projectionMatrix.elements[5] * 0.5;
    u.uSunView.value.copy(sunView);
    this._frame = (this._frame + 1) % 8;
    u.uFrame.value = this._frame;

    const t = this._temporalMaterial.uniforms;
    if (this._first || moved) {
      this._accumulated = 0;
      t.uAlpha.value = this._first ? 1 : GTAO.movingAlpha;
    } else {
      this._accumulated = Math.min(this._accumulated + 1, GTAO.historySamples);
      t.uAlpha.value = 1 / this._accumulated;
    }
    this._first = false;
  }

  render(renderer) {
    const write = this._write === 0 ? this._historyB : this._historyA;
    const read = this._write === 0 ? this._historyA : this._historyB;

    renderer.setRenderTarget(this._raw);
    renderer.render(this.scene, this.camera);

    const t = this._temporalMaterial.uniforms;
    t.uRaw.value = this._raw.texture;
    t.uHistory.value = read.texture;
    renderer.setRenderTarget(write);
    renderer.render(this._temporalScene, this.camera);

    this._write ^= 1;
  }

  setSize(width, height) {
    const w = Math.max(1, Math.ceil(width / 2));
    const h = Math.max(1, Math.ceil(height / 2));
    this.halfWidth = w;
    this.halfHeight = h;
    this._raw.setSize(w, h);
    this._historyA.setSize(w, h);
    this._historyB.setSize(w, h);
    this._aoMaterial.uniforms.uResolution.value.set(w, h);
    this._aoMaterial.uniforms.uFullTexel.value.set(1 / Math.max(1, width), 1 / Math.max(1, height));
    this._temporalMaterial.uniforms.uTexel.value.set(1 / w, 1 / h);
    this.invalidate();
  }

  dispose() {
    this._raw.dispose();
    this._historyA.dispose();
    this._historyB.dispose();
    this._aoMaterial.dispose();
    this._temporalMaterial.dispose();
    super.dispose();
  }
}
