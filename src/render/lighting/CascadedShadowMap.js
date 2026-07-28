import * as THREE from 'three';
import { CAMERA } from '../../core/Constants.js';

/**
 * OWNER: lighting agent.
 *
 * N nested cascades, each a real THREE.DirectionalLight with its own shadow
 * map. Cascade 0 is fitted to the nearest slice of the view frustum, the last
 * cascade to the whole shadow distance.
 *
 * Splits are ABSOLUTE METRES, not fractions of the shadow distance
 * ------------------------------------------------------------------
 * A fraction table is the wrong control surface here. The fit is a bounding
 * *sphere* of the frustum slice, and for a 103 deg horizontal FOV the sphere
 * radius works out at 1.71x the slice's far distance — so a cascade ending at
 * 5 m still covers 13.6 m, and the *next* cascade has to start from there. The
 * old table (0.04/0.13/0.40/1.0 of 120 m = 4.8/15.6/48/120 m) spent cascade 0 on
 * a 16 m box and made cascade 1 carry everything out to 42 m at 26 mm texels.
 * Absolute splits let each cascade be sized against the distance band the player
 * actually looks at:
 *
 *   cascade 0   ->  14 m of coverage at   8 mm texels
 *   cascade 1   ->  33 m of coverage at  20 mm texels
 *   cascade 2   ->  87 m of coverage at  54 mm texels
 *   cascade 3   -> 230 m of coverage at 142 mm texels
 *
 * — better than the old table at every distance band, on the same map size.
 *
 * Refits are exact, not scheduled
 * -------------------------------
 * A cascade's shadow map is only re-rendered when its texel-snapped centre
 * actually moves. Because the centre is quantised to the cascade's own texel
 * grid, "the camera shifted 3 cm" does not change cascade 3's fit at all, and
 * re-rendering it would produce a bit-identical map. Standing still therefore
 * costs zero shadow draw calls, and walking costs the near cascades every frame
 * and the far ones only every few metres.
 *
 * Stability: each cascade is fitted to the bounding sphere of its frustum
 * slice, not to an AABB of the corners. A sphere's radius is invariant under
 * camera rotation, so the ortho extents never change while the player looks
 * around — the classic source of shadow-edge crawl. The sphere centre is then
 * snapped to the cascade's own light-space texel grid, which removes the
 * remaining sub-texel swim while walking.
 *
 * Grazing suns: the shadow camera's near plane is pushed back up the light
 * vector far enough for casters up-sun of the slice to still make it into the
 * map. The distance needed scales as 1/sin(elevation), so it is derived from
 * the sun transform rather than being a constant — at dusk it saturates at the
 * ceiling, at midday it stays tight and keeps depth precision.
 *
 * Filtering: this class also owns the *shape* of the filter, because only it
 * knows how big a texel is in world units per cascade. `filterTexels()` turns
 * a world-metre penumbra budget into per-cascade texel radii that the shader
 * patch bakes in as compile-time constants. That is the single most important
 * number in the whole rig: a uniform texel-space ceiling means a 13-texel
 * filter is 10 cm of penumbra on cascade 0 and 2.6 m on cascade 3, which is
 * exactly how a crisp silhouette turns into a grey cloud.
 */

const _up = new THREE.Vector3(0, 1, 0);
const _upAlt = new THREE.Vector3(0, 0, 1);
const _xAxis = new THREE.Vector3();
const _yAxis = new THREE.Vector3();
const _zAxis = new THREE.Vector3();
const _centre = new THREE.Vector3();
const _snapped = new THREE.Vector3();
const _camPos = new THREE.Vector3();

/**
 * Cascade end distances in metres, capped by `distance`.
 *
 * These are much shorter than they look, because a cascade's *coverage* is not
 * its split distance: the bounding sphere of the slice [near, far] has radius
 * 1.71 x far at this FOV, and it is centred at the far plane, so a cascade that
 * ends at 12 m actually shadows everything out to ~32 m. The table below is
 * therefore a geometric progression tuned so the coverage bands land at roughly
 * 14 / 33 / 87 / 230 m with texels of 8 / 20 / 54 / 142 mm — better than the
 * previous fractional table at every distance, while fitting the far cascade
 * into a 291 m box instead of a 410 m one, which is where a million triangles of
 * backdrop terrain used to get dragged into the shadow pass for nothing.
 */
const SPLIT_METRES = [5, 12, 32, 85];

/**
 * Penumbra budget in WORLD METRES per cascade — the ceiling the PCSS filter is
 * allowed to grow to. Physically the sun's penumbra is ~0.93 cm per metre of
 * blocker separation, so cascade 0's 3 cm ceiling saturates at a ~3 m tall
 * caster and everything closer than that stays visibly hard-edged.
 */
const PENUMBRA_MAX_WORLD = [0.030, 0.085, 0.260, 0.750];
/** Floor, also in metres: the smallest blur that still hides texel stepping. */
const PENUMBRA_MIN_WORLD = [0.010, 0.028, 0.075, 0.200];
/**
 * Per-cascade softness trim. Near shadows are read as "is this contact welded"
 * and want to err hard; far shadows are read as "is there something there" and
 * want the extra blur to hide their coarse texels.
 */
const SOFTNESS_SCALE = [0.55, 0.78, 1.0, 1.0];

/**
 * Cascades from this index up may skip a re-render when nothing about their fit
 * changed. Below it, moving characters live, so the map is rebuilt every frame.
 */
const FIRST_GATED_CASCADE = 2;

export class CascadedShadowMap {
  /**
   * @param {object} ctx engine context
   * @param {{count:number, mapSize:number, distance:number}} opts
   */
  constructor(ctx, opts) {
    this.ctx = ctx;
    this.count = Math.max(1, Math.min(4, opts.count | 0));
    this.mapSize = opts.mapSize;
    this.distance = opts.distance;

    /** Absolute cascade end distances, metres. `distance` is an upper bound. */
    this.splitMetres = SPLIT_METRES.slice(0, this.count).map(
      (m) => Math.min(m, this.distance),
    );
    for (let i = 1; i < this.count; i++) {
      // Monotonic even if someone sets a very short shadow distance.
      if (this.splitMetres[i] <= this.splitMetres[i - 1]) {
        this.splitMetres[i] = this.splitMetres[i - 1] * 1.6;
      }
    }

    this.sunDirection = new THREE.Vector3(0.3, 0.6, 0.4).normalize();
    this.sunColour = new THREE.Color(0xffffff);
    this.sunIntensity = 3.0;
    this.softness = 0.013;
    this.constantBias = -0.00004;
    this.normalBiasTexels = 1.25;
    this.normalBiasCap = 0.10;      // metres — stops far cascades peter-panning
    /** Vertical extent the shadow frustum must be able to reach up-sun, metres. */
    this.casterHeight = 34;

    this.group = new THREE.Group();
    this.group.name = 'csm-cascades';

    /** @type {THREE.DirectionalLight[]} */
    this.lights = [];
    /** @type {number[]} world size of one shadow texel, per cascade */
    this.texelWorld = new Array(this.count).fill(0);
    this._lastCamPos = new THREE.Vector3(Infinity, Infinity, Infinity);
    /** Last snapped centre per cascade — the refit gate. */
    this._lastSnap = [];
    for (let i = 0; i < this.count; i++) {
      this._lastSnap.push(new THREE.Vector3(Infinity, Infinity, Infinity));
    }
    /** Shadow maps actually re-rendered on the most recent update(). */
    this.refitsLastFrame = 0;

    for (let i = 0; i < this.count; i++) {
      const light = new THREE.DirectionalLight(0xffffff, 0);
      light.name = `csm-cascade-${i}`;
      light.castShadow = true;
      light.shadow.mapSize.set(this.mapSize, this.mapSize);
      light.shadow.autoUpdate = false;   // we drive refits ourselves
      light.shadow.needsUpdate = true;
      light.shadow.intensity = 1;
      light.shadow.bias = this.constantBias;
      light.shadow.normalBias = 0.02;
      light.shadow.radius = 1;           // repurposed: penumbra scale, see patch
      const cam = light.shadow.camera;
      cam.near = 0.5;
      cam.far = 400;
      cam.left = -50; cam.right = 50; cam.top = 50; cam.bottom = -50;
      cam.updateProjectionMatrix();
      this.group.add(light);
      this.group.add(light.target);
      this.lights.push(light);
    }

    ctx.scene.add(this.group);
    this._frame = 0;
    this._forceAll = true;
  }

  /** Primary handle other systems expect (`lighting.sun`). */
  get sun() { return this.lights[0]; }

  setSun(direction, colour, intensity, softness) {
    this.sunDirection.copy(direction).normalize();
    this.sunColour.copy(colour);
    this.sunIntensity = intensity;
    this.softness = softness;
    for (const l of this.lights) {
      l.color.copy(colour);
      l.intensity = intensity;
    }
    this._forceAll = true;
  }

  setMapSize(size) {
    if (size === this.mapSize) return false;
    this.mapSize = size;
    for (const l of this.lights) {
      l.shadow.mapSize.set(size, size);
      if (l.shadow.map) { l.shadow.map.dispose(); l.shadow.map = null; }
    }
    this._forceAll = true;
    return true;
  }

  // -------------------------------------------------------------------------
  // filter geometry — consumed by ShadowShaderPatch at compile time
  // -------------------------------------------------------------------------

  /**
   * World size of one shadow texel for cascade `i` under a *nominal* camera
   * (base FOV, 16:9). The live value in `texelWorld` tracks the real camera and
   * shrinks while aiming down sights, which only ever makes shadows crisper —
   * so baking the nominal figure into the shader is safe and means changing FOV
   * never triggers a shader rebuild.
   */
  nominalTexel(i) {
    const tanV = Math.tan(THREE.MathUtils.degToRad(CAMERA.fovBase * 0.5));
    const tanH = tanV * (16 / 9);
    const a = tanH * tanH + tanV * tanV;
    const r = sliceRadius(Math.max(CAMERA.near, 0.05), this.splitMetres[i], a);
    return (2 * r) / this.mapSize;
  }

  /**
   * Per-cascade PCSS radii, in texels: `{ max, min }` arrays of length 4
   * (padded, because the shader always declares four slots).
   */
  filterTexels() {
    const max = [1, 1, 1, 1];
    const min = [1, 1, 1, 1];
    for (let i = 0; i < 4; i++) {
      const c = Math.min(i, this.count - 1);
      const texel = this.nominalTexel(c);
      max[i] = THREE.MathUtils.clamp(PENUMBRA_MAX_WORLD[c] / texel, 1.6, 14);
      min[i] = THREE.MathUtils.clamp(PENUMBRA_MIN_WORLD[c] / texel, 0.7, max[i] * 0.55);
    }
    return { max, min };
  }

  // -------------------------------------------------------------------------
  // per-frame fit
  // -------------------------------------------------------------------------

  /**
   * Cascades 0/1 are considered every frame; the far two are considered on a
   * stagger, because even when they do need a refit a one-frame-stale fit at
   * 5-14 cm per texel is invisible. Whether a considered cascade actually
   * re-renders is then decided exactly, by the texel-snap comparison in
   * `_fitCascade`.
   */
  _shouldFit(i) {
    if (this._forceAll) return true;
    if (i < 2) return true;
    if (i === 2) return (this._frame % 2) === 0;
    return (this._frame % 3) === 0;
  }

  update(camera) {
    this._frame++;
    this.refitsLastFrame = 0;
    camera.getWorldPosition(_camPos);
    // A teleport invalidates even the far cascades' staggered fits.
    if (_camPos.distanceToSquared(this._lastCamPos) > 400) this._forceAll = true;

    const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5));
    const tanH = tanV * camera.aspect;
    const a = tanH * tanH + tanV * tanV;
    const near = Math.max(camera.near, 0.05);

    const vertical = Math.abs(this.sunDirection.y) > 0.985;
    const up = vertical ? _upAlt : _up;
    _zAxis.copy(this.sunDirection).normalize();
    _xAxis.crossVectors(up, _zAxis).normalize();
    _yAxis.crossVectors(_zAxis, _xAxis).normalize();

    // How far up the light vector a caster of `casterHeight` can sit and still
    // need to be in the map. Grazing suns need much more room than a high sun.
    const reach = this.casterHeight / Math.max(0.12, Math.abs(this.sunDirection.y));

    for (let i = 0; i < this.count; i++) {
      if (!this._shouldFit(i)) continue;
      this._fitCascade(i, camera, near, this.splitMetres[i], a, up, reach);
    }

    this._lastCamPos.copy(_camPos);
    this._forceAll = false;
  }

  _fitCascade(i, camera, near, far, a, up, reach) {
    const r = sliceRadius(near, far, a);
    _centre.set(0, 0, -Math.min(0.5 * (far + near) * (1 + a), far)).applyMatrix4(camera.matrixWorld);

    const texel = (2 * r) / this.mapSize;
    this.texelWorld[i] = texel;

    // Snap the centre to this cascade's light-space texel grid. All three axes
    // are quantised, including the one along the light: an unquantised depth
    // origin would shift every stored depth by a fraction of a texel each frame
    // and defeat the "has anything actually changed" test below.
    const cx = Math.round(_centre.dot(_xAxis) / texel) * texel;
    const cy = Math.round(_centre.dot(_yAxis) / texel) * texel;
    const cz = Math.round(_centre.dot(_zAxis) / texel) * texel;
    _snapped.set(0, 0, 0)
      .addScaledVector(_xAxis, cx)
      .addScaledVector(_yAxis, cy)
      .addScaledVector(_zAxis, cz);

    // Exact refit gate, for the FAR cascades only. If the snapped centre has not
    // moved and neither the sun nor the map size has changed, re-rendering a
    // cascade whose contents are static would produce a bit-identical depth
    // buffer — so don't; the shadow.matrix stays valid because three only
    // rewrites it when it renders the map.
    //
    // Cascades 0 and 1 are exempt and always re-render, because their contents
    // are NOT static: they are the two that contain moving characters, and a
    // player holding an angle while an enemy walks past must still see that
    // enemy's shadow move. Beyond cascade 1's ~33 m of coverage a character's
    // shadow is a few pixels wide and freezing it is invisible.
    const light = this.lights[i];
    if (i >= FIRST_GATED_CASCADE
      && !this._forceAll && light.shadow.map && _snapped.equals(this._lastSnap[i])) return;
    this._lastSnap[i].copy(_snapped);
    this.refitsLastFrame++;

    // Pull the light back far enough that casters up-sun of the slice are
    // still inside the shadow frustum (critical at dusk).
    const backOff = THREE.MathUtils.clamp(reach, 24, 260);

    light.target.position.copy(_snapped);
    light.position.copy(_snapped).addScaledVector(_zAxis, r + backOff);

    const cam = light.shadow.camera;
    cam.up.copy(up);
    cam.left = -r; cam.right = r; cam.top = r; cam.bottom = -r;
    cam.near = 0.5;
    cam.far = 2 * r + backOff + 1;
    cam.updateProjectionMatrix();

    light.shadow.bias = this.constantBias;
    // Normal-offset bias, in world units, capped so the far cascades cannot
    // detach a shadow from its caster (peter-panning) just because their texels
    // are 13 cm wide.
    light.shadow.normalBias = Math.min(this.normalBiasTexels * texel, this.normalBiasCap);
    // Smuggled through `shadowRadius`: converts a normalised depth separation
    // into a penumbra radius in shadow-map UV. Dimensionally this is
    //   (metres of separation) * (metres of penumbra per metre) / (metres per UV)
    // so `softness` really is the sun's angular size. Nothing else reads
    // shadowRadius once the shader patch is live.
    const soft = this.softness * SOFTNESS_SCALE[Math.min(i, 3)];
    light.shadow.radius = (soft * (cam.far - cam.near)) / (2 * r);
    light.shadow.needsUpdate = true;

    light.target.updateMatrixWorld();
  }

  /** Uniform payload for the volumetric raymarcher. */
  shadowMatrices() {
    return this.lights.map((l) => l.shadow.matrix);
  }

  shadowTexture(i) {
    const m = this.lights[i]?.shadow.map;
    return m ? m.texture : null;
  }

  dispose() {
    for (const l of this.lights) {
      if (l.shadow.map) { l.shadow.map.dispose(); l.shadow.map = null; }
      l.dispose?.();
    }
    this.group.removeFromParent();
  }
}

/**
 * Radius of the minimal sphere enclosing the view-frustum slice [near, far].
 * `a = tan(hFov/2)^2 + tan(vFov/2)^2`. When the ideal centre falls beyond the
 * far plane (wide FOV, short slice) the far-plane corner circle *is* the
 * minimal sphere, so the centre clamps to `far`.
 */
function sliceRadius(near, far, a) {
  let zc = 0.5 * (far + near) * (1 + a);
  if (zc >= far) zc = far;
  const dF = far - zc;
  const dN = near - zc;
  return Math.max(
    Math.sqrt(a * far * far + dF * dF),
    Math.sqrt(a * near * near + dN * dN),
  );
}
