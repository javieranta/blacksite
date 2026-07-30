import * as THREE from 'three';

/**
 * OWNER: lighting agent.
 *
 * Visible cones of air under the practical fixtures.
 *
 * Why this is a separate mechanism from VolumetricLight
 * ----------------------------------------------------
 * VolumetricLight raymarches the *cascade* shadow maps — it is the sun's
 * instrument, and it is occluded by the same four maps the key light writes. A
 * point light has no cascade; giving 21 fixtures a marched medium each would mean
 * 21 shadow cubemap lookups per step per pixel, which is not a frame-budget
 * conversation worth having when the thing being sold is a soft haze.
 *
 * So this is the analytic version: one instanced open cone per downward-facing
 * fixture, additively blended, with the brightness profile a beam through
 * suspended dust actually has. It is a single draw call for the whole rig.
 *
 * The shading model, and why the cone is brighter at its silhouette
 * ----------------------------------------------------------------
 * The mesh is a hollow shell, so it cannot integrate path length through the
 * volume it stands for. What it can do is use the shell's own normal: at the
 * silhouette the surface is edge-on to the eye, which is where a real cone of
 * scattering medium presents the most depth, and looking straight down the axis
 * you see the least. `pow(1 - |N.V|, 2)` reproduces that, and it is why an
 * additively-blended cone reads as a beam rather than as a paper lampshade.
 *
 * Three further terms keep it honest:
 *   - inverse-square-ish falloff from the apex, so the air right under the
 *     luminaire is the brightest part and the far end is nearly gone;
 *   - a base fade over the last fifth of the cone, because the shell would
 *     otherwise terminate in a hard ellipse where it meets the ground and no
 *     amount of blending hides an intersection edge;
 *   - a screen-space fade as the camera enters the cone, so walking under a lamp
 *     does not wash the frame out.
 *
 * The cones depth-test but do not depth-write and do not soft-fade against the
 * depth buffer, so where a shell crosses geometry it crosses it hard. The floor
 * is the case that matters and it is handled by construction: a cone is cut to
 * the fixture's height above the ground under it, not to its lit reach, so the
 * base fade lands exactly where the floor is. Sizing on reach alone — which is
 * what this did first — buries the base four or five metres under the slab for
 * any lamp whose reach exceeds its mounting height, which is all of them, and
 * the fade then happens underground while the shell draws a hard ellipse across
 * the concrete.
 */

/** Ceiling on cone height as a fraction of the fixture's lit reach. */
const LENGTH_OF_REACH = 0.82;
/** Base radius as a fraction of cone height — a ~30 deg half-angle luminaire. */
const SPREAD = 0.56;
/** Below this mounting height a fixture gets no cone: the shell would clip. */
const MIN_HEIGHT = 2.2;
/** Hard cap. Cones are cheap but they are still overdraw. */
const MAX_CONES = 24;

const VERT = /* glsl */`
  varying float vH;
  varying float vFacing;
  varying vec3 vColour;
  varying float vFade;
  attribute vec3 aColour;
  attribute float aFade;
  void main() {
    vH = -position.y;                       // 0 at the apex, 1 at the base
    vColour = aColour;
    vFade = aFade;
    vec4 world = instanceMatrix * vec4(position, 1.0);
    vec3 wn = normalize(mat3(instanceMatrix) * normal);
    vec4 view = modelViewMatrix * world;
    vec3 toEye = normalize(-(view.xyz));
    vec3 vn = normalize(normalMatrix * wn);
    vFacing = abs(dot(vn, toEye));
    gl_Position = projectionMatrix * view;
  }
`;

const FRAG = /* glsl */`
  precision highp float;
  varying float vH;
  varying float vFacing;
  varying vec3 vColour;
  varying float vFade;
  uniform float uStrength;
  void main() {
    // Path length through the shell: maximal edge-on, minimal down the axis.
    float rim = pow(1.0 - clamp(vFacing, 0.0, 1.0), 2.0);
    // Falloff from the luminaire. Not literally inverse square — the shell also
    // widens with vH, so the energy is already spreading — but close enough that
    // the air under the lamp is clearly the brightest part of the beam.
    float axial = 1.0 / (1.0 + 5.2 * vH * vH);
    // Kill the base before it can draw an ellipse on the floor.
    float foot = smoothstep(1.0, 0.74, vH);
    float a = uStrength * vFade * foot * axial * (0.22 + 0.78 * rim);
    if (a <= 0.0015) discard;
    gl_FragColor = vec4(vColour * a, 1.0);
  }
`;

const _pos = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _camPos = new THREE.Vector3();

const _ray = new THREE.Raycaster();
const _down = new THREE.Vector3(0, -1, 0);
const _hits = [];

/**
 * Distance from a fixture straight down to whatever it is lighting.
 *
 * This must be a RAYCAST, not `level.heightAt`. heightAt is a top-down surface
 * query: over a roofed hall it answers with the roof, so a highbay hanging at
 * 7.85 m under a 10.5 m roof reports a floor 2.65 m ABOVE itself and a negative
 * drop. Measured on this level, all fourteen fixtures the level publishes came
 * back negative that way and were silently skipped — only the five yard masts,
 * which happen to stand on the ground plane where heightAt is right, ever got a
 * cone. Casting down against the collider group asks the question that was
 * actually meant.
 *
 * @returns {number} metres to the first surface below, or 0 if nothing is there
 */
function dropUnder(level, pos) {
  const colliders = level?.colliders;
  if (colliders && colliders.children.length) {
    _ray.set(pos, _down);
    _ray.near = 0.05;
    _ray.far = 60;
    _hits.length = 0;
    _ray.intersectObject(colliders, true, _hits);
    if (_hits.length) {
      let best = Infinity;
      for (let i = 0; i < _hits.length; i++) if (_hits[i].distance < best) best = _hits[i].distance;
      _hits.length = 0;
      if (Number.isFinite(best)) return best;
    }
  }
  // No collider under it (an open gantry over a void, a level with no collider
  // group). Fall back to the height field, sanity-bounded the same way
  // Practicals bounds its mast placement.
  if (level?.heightAt) {
    const y = level.heightAt(pos.x, pos.z);
    if (Number.isFinite(y) && y > -20 && y < 20 && pos.y - y > 0) return pos.y - y;
  }
  return 0;
}

export class LightCones {
  /** @param {object} ctx engine context */
  constructor(ctx) {
    this.ctx = ctx;
    this.mesh = null;
    this._built = 0;
    this._rig = null;
    this._fadeAttr = null;
    this._sites = [];
  }

  /**
   * @param {object|null} cones rig entry: { strength, length, spread } or absent
   *   for every preset that is not night — a lamp in daylight has no visible cone
   *   and drawing one is the single most obvious way to make a rig look fake.
   */
  setRig(cones) {
    this._rig = cones ?? null;
    if (this.mesh) this.mesh.visible = !!cones;
  }

  /**
   * (Re)build from the practical units. Called when the fixture set settles, not
   * per frame — the fixtures are static.
   * @param {{light:THREE.PointLight, spec:object, tint:THREE.Color}[]} units
   */
  build(units) {
    this.dispose();
    if (!units.length) return;

    const level = this.ctx.get('level');
    const sites = [];
    for (let i = 0; i < units.length && sites.length < MAX_CONES; i++) {
      const u = units[i];
      if (!u.light || u.spec.peak <= 0) continue;
      u.light.getWorldPosition(_pos);
      const drop = dropUnder(level, _pos);
      if (drop < MIN_HEIGHT) continue;
      const reach = u.light.distance > 0 ? u.light.distance : u.spec.reach;
      sites.push({
        x: _pos.x, y: _pos.y, z: _pos.z,
        reach,
        // 6% past the floor so the base fade straddles the slab instead of
        // stopping on it.
        drop: drop * 1.06,
        r: u.tint.r, g: u.tint.g, b: u.tint.b,
      });
    }
    if (!sites.length) return;
    this._sites = sites;

    const geo = new THREE.ConeGeometry(SPREAD, 1, 22, 5, true);
    // Apex at the origin, base at y = -1, so the instance matrix can hang the
    // cone off the luminaire with a plain scale.
    geo.translate(0, -0.5, 0);

    const colours = new Float32Array(sites.length * 3);
    const fades = new Float32Array(sites.length);
    for (let i = 0; i < sites.length; i++) {
      colours[i * 3] = sites[i].r;
      colours[i * 3 + 1] = sites[i].g;
      colours[i * 3 + 2] = sites[i].b;
      fades[i] = 1;
    }
    geo.setAttribute('aColour', new THREE.InstancedBufferAttribute(colours, 3));
    geo.setAttribute('aFade', new THREE.InstancedBufferAttribute(fades, 1));
    this._fadeAttr = geo.getAttribute('aFade');

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: { uStrength: { value: 0 } },
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      toneMapped: true,
      fog: false,
    });

    this.mesh = new THREE.InstancedMesh(geo, this.material, sites.length);
    this.mesh.name = 'practical-cones';
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.renderOrder = 12;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.visible = !!this._rig;

    const lengthMul = this._rig?.length ?? 1;
    const spreadMul = this._rig?.spread ?? 1;
    for (let i = 0; i < sites.length; i++) {
      const s = sites[i];
      const h = Math.min(s.reach * LENGTH_OF_REACH * lengthMul, s.drop);
      _pos.set(s.x, s.y, s.z);
      _q.identity();
      _s.set(spreadMul * h, h, spreadMul * h);
      _m.compose(_pos, _q, _s);
      this.mesh.setMatrixAt(i, _m);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.ctx.scene.add(this.mesh);
    this._built = sites.length;
  }

  /** @param {number} dim 0..1 practical dimmer */
  update(dim, camera) {
    if (!this.mesh) return;
    const rig = this._rig;
    if (!rig || dim <= 0.001) {
      this.mesh.visible = false;
      return;
    }
    this.mesh.visible = true;
    this.material.uniforms.uStrength.value = 0.115 * rig.strength * dim;

    // Fade a cone out as the camera enters it. Without this, standing under a
    // lamp fills the frame with a flat additive wash and the auto-exposure meter
    // pulls the whole image down a stop to pay for it.
    if (!camera) return;
    camera.getWorldPosition(_camPos);
    const arr = this._fadeAttr.array;
    let changed = false;
    for (let i = 0; i < this._built; i++) {
      const s = this._sites[i];
      const dx = _camPos.x - s.x;
      const dy = _camPos.y - s.y;
      const dz = _camPos.z - s.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const near = s.reach * 0.34;
      const f = d <= near ? 0 : Math.min(1, (d - near) / (near * 0.9));
      if (Math.abs(arr[i] - f) > 0.004) { arr[i] = f; changed = true; }
    }
    if (changed) this._fadeAttr.needsUpdate = true;
  }

  /** Cone count, for diagnostics. */
  get count() { return this._built; }

  dispose() {
    if (!this.mesh) return;
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.mesh = null;
    this._fadeAttr = null;
    this._built = 0;
    this._sites.length = 0;
  }
}
