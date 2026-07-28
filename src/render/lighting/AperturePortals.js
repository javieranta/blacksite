import * as THREE from 'three';

/**
 * OWNER: lighting agent.
 *
 * Window bounce, using the `level.apertures` seam the level agent publishes
 * exactly for this ("every window, rooflight, clerestory and shutter opening in
 * the map... Lighting can hang volumetric shafts on these").
 *
 * The problem this solves
 * ----------------------
 * An enclosed hall with three glazed walls should read as a room lit *through*
 * those walls: bright near the glazing, a gradient falling into the depth of the
 * plan, and a soft wash on the wall opposite each window. What an image-based
 * ambient term actually gives it is one constant fill, because an IBL has no
 * notion of where the openings are — it lights the middle of a windowless room
 * exactly as brightly as the sill.
 *
 * The fix is the oldest trick in interior lighting: treat each opening as an
 * emitter. A small pool of point lights is parked just inside the apertures
 * nearest the camera, coloured by the sky irradiance arriving through them and
 * scaled by their area. That is a crude single-bounce approximation of a portal
 * light, and it buys the one thing the constant term cannot: a gradient with a
 * direction, anchored to architecture the player can see.
 *
 * It costs nothing outdoors — the pool idles at zero intensity until the
 * enclosure probe says the camera is under a roof — and nothing per frame
 * indoors beyond a rebind every quarter second. The lights exist for the whole
 * process lifetime so binding them never recompiles a shader.
 */

const REBIND_INTERVAL = 0.25;
/** Apertures further than this contribute nothing worth a light slot. */
const MAX_RANGE = 24;

const _camPos = new THREE.Vector3();

const _inward = new THREE.Vector3();

export class AperturePortals {
  /**
   * @param {object} ctx engine context
   * @param {number} count size of the light pool
   */
  constructor(ctx, count = 4) {
    this.ctx = ctx;
    this.count = count;
    this.group = new THREE.Group();
    this.group.name = 'aperture-portals';

    /** @type {THREE.PointLight[]} */
    this.lights = [];
    for (let i = 0; i < count; i++) {
      const l = new THREE.PointLight(0xbcd4ee, 0, 11, 2);
      l.name = `portal-${i}`;
      l.castShadow = false;
      this.group.add(l);
      this.lights.push(l);
    }
    ctx.scene.add(this.group);

    this._tint = new THREE.Color(0xbcd4ee);
    this._gain = 0;
    this._timer = 0;
    this._enclosure = 0;
    // Fixed-size candidate buffer: rebinding must not allocate even though it
    // only runs four times a second.
    this._bestIdx = new Int32Array(count);
    this._bestScore = new Float32Array(count);
  }

  /**
   * @param {THREE.Color} skyIrradiance hemispherical irradiance from the model
   * @param {number} gain rig-level multiplier (0 disables)
   */
  setSky(skyIrradiance, gain) {
    const m = Math.max(skyIrradiance.r, skyIrradiance.g, skyIrradiance.b);
    if (m > 1e-5) {
      this._tint.setRGB(skyIrradiance.r / m, skyIrradiance.g / m, skyIrradiance.b / m);
    }
    // Irradiance -> candela for a ~1 m^2 opening at ~1 m. The absolute figure is
    // arbitrary; what matters is that it tracks the sky so a portal is bright at
    // midday, dim at dusk and nearly nothing at night.
    this._gain = gain * m * 12;
    for (const l of this.lights) l.color.copy(this._tint);
  }

  /**
   * @param {number} dt seconds
   * @param {number} enclosure 0..1 from Lighting's roof probe
   */
  update(dt, enclosure) {
    this._enclosure = enclosure;
    if (enclosure < 0.12 || this._gain <= 0) {
      if (this._active) {
        for (const l of this.lights) l.intensity = 0;
        this._active = false;
      }
      return;
    }
    this._active = true;

    this._timer -= dt;
    if (this._timer > 0) return;
    this._timer = REBIND_INTERVAL;
    this._rebind();
  }

  _rebind() {
    const apertures = this.ctx.get('level')?.apertures;
    const n = this.count;
    for (let i = 0; i < n; i++) { this._bestIdx[i] = -1; this._bestScore[i] = 0; }
    if (!apertures || apertures.length === 0) {
      for (const l of this.lights) l.intensity = 0;
      return;
    }

    this.ctx.camera.getWorldPosition(_camPos);

    for (let a = 0; a < apertures.length; a++) {
      const ap = apertures[a];
      const p = ap.position;
      if (!p) continue;
      const dx = _camPos.x - p.x;
      const dy = _camPos.y - p.y;
      const dz = _camPos.z - p.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > MAX_RANGE * MAX_RANGE) continue;

      // Only openings whose *inside* faces us are worth lighting from: an
      // aperture normal points out of the wall, so the camera must be on the
      // opposite side of it (or the aperture is a rooflight and always counts).
      const nrm = ap.normal;
      let facing = 1;
      if (nrm) {
        const dot = (dx * nrm.x + dy * nrm.y + dz * nrm.z) / Math.max(0.001, Math.sqrt(d2));
        if (Math.abs(nrm.y) < 0.7 && dot > 0.25) continue;
        facing = 0.4 + 0.6 * Math.min(1, Math.abs(dot));
      }

      const area = Math.max(0.3, (ap.width ?? 1.4) * (ap.height ?? 1.6));
      const score = (area * facing) / Math.max(2.5, d2 * 0.05);

      // Insert into the fixed-size top-N.
      for (let s = 0; s < n; s++) {
        if (score <= this._bestScore[s]) continue;
        for (let k = n - 1; k > s; k--) {
          this._bestScore[k] = this._bestScore[k - 1];
          this._bestIdx[k] = this._bestIdx[k - 1];
        }
        this._bestScore[s] = score;
        this._bestIdx[s] = a;
        break;
      }
    }

    for (let i = 0; i < n; i++) {
      const light = this.lights[i];
      const idx = this._bestIdx[i];
      if (idx < 0) { light.intensity = 0; continue; }
      const ap = apertures[idx];
      const nrm = ap.normal;
      // Sit the emitter just inside the opening, on the room side.
      if (nrm) {
        _inward.set(-nrm.x, -nrm.y, -nrm.z);
      } else {
        _inward.subVectors(_camPos, ap.position).normalize();
      }
      light.position.copy(ap.position).addScaledVector(_inward, 0.75);
      const area = Math.max(0.3, (ap.width ?? 1.4) * (ap.height ?? 1.6));
      const reach = THREE.MathUtils.clamp(3.2 * Math.sqrt(area), 5, 16);
      light.distance = reach;
      light.intensity = this._gain * area * this._enclosure;
    }
  }

  dispose() {
    for (const l of this.lights) l.dispose();
    this.lights.length = 0;
    this.group.removeFromParent();
  }
}
