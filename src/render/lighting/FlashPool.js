import * as THREE from 'three';

/**
 * OWNER: lighting agent.
 *
 * Pooled one-shot dynamic lights (muzzle flashes, explosions, sparks).
 *
 * Why a pool and not `new PointLight()` per shot: adding or removing a light
 * changes NUM_POINT_LIGHTS, which invalidates every shader program in the
 * scene. Doing that on every trigger pull produces a multi-frame hitch on the
 * first shot of each weapon and allocates a light + its uniforms per call. The
 * pool is created once, always present, and idle members simply sit at zero
 * intensity — the light count never changes and update() never allocates.
 *
 * Falloff is physically correct inverse-square (three's `decay = 2`), with the
 * cutoff distance derived from the peak intensity so a bright flash reaches
 * further than a dim one instead of every flash sharing one arbitrary radius.
 */
export class FlashPool {
  constructor(ctx, size = 4) {
    this.ctx = ctx;
    this.size = size;
    /** @type {THREE.PointLight[]} */
    this.lights = [];
    this.life = new Float32Array(size);
    this.maxLife = new Float32Array(size);
    this.peak = new Float32Array(size);
    this.active = new Uint8Array(size);

    this.group = new THREE.Group();
    this.group.name = 'flash-pool';
    for (let i = 0; i < size; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 24, 2);
      l.name = `flash-${i}`;
      l.castShadow = false;
      l.visible = true;      // never toggled — visibility churn also recompiles
      this.group.add(l);
      this.lights.push(l);
    }
    ctx.scene.add(this.group);
    this._cursor = 0;
  }

  /** @returns {number} index of a free slot, or the dimmest active one. */
  _acquire(intensity) {
    for (let i = 0; i < this.size; i++) {
      const k = (this._cursor + i) % this.size;
      if (!this.active[k]) { this._cursor = (k + 1) % this.size; return k; }
    }
    let worst = 0;
    let worstVal = Number.POSITIVE_INFINITY;
    for (let i = 0; i < this.size; i++) {
      const v = this.lights[i].intensity;
      if (v < worstVal) { worstVal = v; worst = i; }
    }
    return this.lights[worst].intensity < intensity ? worst : -1;
  }

  /**
   * @param {THREE.Vector3} position
   * @param {number|THREE.Color} colour
   * @param {number} intensity peak radiant intensity (candela-ish)
   * @param {number} decay seconds to fully fade
   * @returns {THREE.PointLight|null}
   */
  flash(position, colour, intensity, decay) {
    const i = this._acquire(intensity);
    if (i < 0) return null;
    const l = this.lights[i];
    if (colour instanceof THREE.Color) l.color.copy(colour);
    else l.color.set(colour);
    l.position.copy(position);
    l.intensity = intensity;
    // Physical cutoff: stop the light where it contributes < ~1/400 of a unit.
    l.distance = Math.min(60, Math.max(4, Math.sqrt(intensity * 400)));
    l.decay = 2;
    this.peak[i] = intensity;
    this.life[i] = decay;
    this.maxLife[i] = Math.max(1e-4, decay);
    this.active[i] = 1;
    return l;
  }

  update(dt) {
    for (let i = 0; i < this.size; i++) {
      if (!this.active[i]) continue;
      const t = this.life[i] - dt;
      if (t <= 0) {
        this.life[i] = 0;
        this.active[i] = 0;
        this.lights[i].intensity = 0;
        continue;
      }
      this.life[i] = t;
      const k = t / this.maxLife[i];
      // Squared falloff reads snappier than linear for a muzzle flash.
      this.lights[i].intensity = this.peak[i] * k * k;
    }
  }

  dispose() {
    for (const l of this.lights) l.dispose();
    this.group.removeFromParent();
  }
}
