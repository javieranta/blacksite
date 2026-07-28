import * as THREE from 'three';
import { Pass } from 'postprocessing';

/**
 * OWNER: postfx agent.
 *
 * The motion-vector pass. One fullscreen draw that turns the depth buffer into
 * a screen-space velocity + linear-depth buffer which TAA, the AO temporal
 * filter and motion blur all consume:
 *
 *   RG — velocity in UV units, `thisFrameUV − previousFrameUV`
 *   B  — linear view depth in metres (positive)
 *   A  — 1 for geometry, 0 for sky
 *
 * ── Why this pass exists, and why round 3 was soft ──────────────────────────
 * The reprojection matrices *must* be jitter-free. Round 3 reconstructed world
 * position with the **jittered** inverse view-projection and reprojected with
 * the unjittered previous one, so a perfectly stationary camera produced a
 * velocity of exactly the current sub-pixel jitter — half a pixel, in a new
 * direction every frame. Consequences, both of which the reviewer saw:
 *
 *   • TAA resampled its history through a bilinear tap offset by ½px *every*
 *     frame. Sixteen frames of that is a real ~1.5px blur, which is why thin
 *     metal came out soft and, once the unsharp filter fought back, aliased.
 *   • Motion blur's velocity floor (0.0004 UV ≈ 0.8px) sat *below* the jitter,
 *     so the pass never switched off. Because reprojected velocity scales with
 *     1/depth for translation but is constant for rotation, the two components
 *     cancel at one particular distance — giving a sharp mid-ground with a
 *     blurred near field *and* a blurred far field. That is what was diagnosed
 *     as "depth of field is on and wrong"; the DoF pass was never even enabled.
 *
 * So: both matrices here are the unjittered ones. A static camera yields
 * exactly zero, history is fetched pixel-aligned, and the resolve stays sharp.
 */

const vertexShader = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 1.0, 1.0);
}
`;

const fragmentShader = /* glsl */ `
uniform highp sampler2D depthBuffer;
uniform mat4 uInvViewProj;
uniform mat4 uPrevViewProj;
uniform float uNear;
uniform float uFar;
varying vec2 vUv;

void main() {
  float d = texture2D(depthBuffer, vUv).r;

  // three's perspectiveDepthToViewZ, inlined: negative, metres.
  float viewZ = (uNear * uFar) / ((uFar - uNear) * d - uFar);

  vec4 ndc = vec4(vUv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  vec4 world = uInvViewProj * ndc;
  world /= world.w;

  vec4 prev = uPrevViewProj * world;
  vec2 vel = vec2(0.0);
  if (prev.w > 1e-6) {
    vec2 prevUV = (prev.xy / prev.w) * 0.5 + 0.5;
    vel = vUv - prevUV;
  }

  gl_FragColor = vec4(vel, -viewZ, d >= 0.999999 ? 0.0 : 1.0);
}
`;

export class VelocityPass extends Pass {
  constructor(camera) {
    super('VelocityPass');
    this.needsSwap = false;
    this.needsDepthTexture = true;
    // NB: `this.camera` belongs to the base class — it is the orthographic
    // camera that draws the fullscreen quad. The world camera lives here.
    this.worldCamera = camera;

    this._material = new THREE.ShaderMaterial({
      name: 'VelocityResolve',
      uniforms: {
        depthBuffer: { value: null },
        uInvViewProj: { value: new THREE.Matrix4() },
        uPrevViewProj: { value: new THREE.Matrix4() },
        uNear: { value: 0.02 },
        uFar: { value: 900 },
      },
      vertexShader,
      fragmentShader,
      depthWrite: false,
      depthTest: false,
    });
    this.fullscreenMaterial = this._material;

    this.target = new THREE.WebGLRenderTarget(1, 1, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      type: THREE.HalfFloatType,
      depthBuffer: false,
      stencilBuffer: false,
    });
    this.target.texture.name = 'PostFX.Velocity';

    this._viewProj = new THREE.Matrix4();
    this._prevViewProj = new THREE.Matrix4();
    this._invViewProj = new THREE.Matrix4();
    this._prevWorldInverse = new THREE.Matrix4();
    this._prevProjection = new THREE.Matrix4();
    this._hasPrev = false;

    /** Screen-space camera speed in UV units, measured this frame. */
    this.speed = 0;
    /** True when the unjittered camera changed since the last commit. */
    this.moved = true;

    this._probe = new THREE.Vector3();
    this._pa = new THREE.Vector3();
    this._pb = new THREE.Vector3();
  }

  set mainCamera(value) {
    this.worldCamera = value;
  }

  getDepthTexture() {
    return this._material.uniforms.depthBuffer.value;
  }

  setDepthTexture(depthTexture) {
    this._material.uniforms.depthBuffer.value = depthTexture;
  }

  get texture() {
    return this.target.texture;
  }

  /**
   * Recomputes the reprojection matrices from the **unjittered** camera. Must
   * be called before any sub-pixel jitter is applied for the frame.
   * @returns {number} screen-space camera speed in UV units.
   */
  sync(camera) {
    const cam = camera || this.worldCamera;
    const u = this._material.uniforms;
    u.uNear.value = cam.near;
    u.uFar.value = cam.far;

    this._viewProj.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    this._invViewProj.copy(this._viewProj).invert();

    this.moved =
      !this._hasPrev ||
      !this._prevWorldInverse.equals(cam.matrixWorldInverse) ||
      !this._prevProjection.equals(cam.projectionMatrix);

    if (!this._hasPrev) {
      this._prevViewProj.copy(this._viewProj);
      this._hasPrev = true;
    }

    u.uInvViewProj.value.copy(this._invViewProj);
    u.uPrevViewProj.value.copy(this._prevViewProj);

    // Screen displacement of a point 10m down the view axis: one number that
    // captures rotation and translation together, allocation-free.
    this._probe.set(0, 0, -10).applyMatrix4(cam.matrixWorld);
    this._pa.copy(this._probe).applyMatrix4(this._viewProj);
    this._pb.copy(this._probe).applyMatrix4(this._prevViewProj);
    const dx = (this._pa.x - this._pb.x) * 0.5;
    const dy = (this._pa.y - this._pb.y) * 0.5;
    this.speed = Math.sqrt(dx * dx + dy * dy);
    return this.speed;
  }

  /** Rolls this frame's unjittered matrices into the history slots. */
  commit(camera) {
    const cam = camera || this.worldCamera;
    this._prevViewProj.copy(this._viewProj);
    this._prevWorldInverse.copy(cam.matrixWorldInverse);
    this._prevProjection.copy(cam.projectionMatrix);
  }

  reset() {
    this._hasPrev = false;
    this.speed = 0;
    this.moved = true;
  }

  render(renderer) {
    renderer.setRenderTarget(this.target);
    renderer.render(this.scene, this.camera);
  }

  setSize(width, height) {
    this.target.setSize(Math.max(1, width), Math.max(1, height));
  }

  dispose() {
    this.target.dispose();
    this._material.dispose();
    super.dispose();
  }
}
