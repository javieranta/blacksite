import * as THREE from 'three';

/**
 * OWNER: ai agent.
 *
 * Contact occlusion for the combatants: a broad ambient pool under each body plus
 * a tight patch under each boot.
 *
 * This is NOT a substitute for the cascade — the bodies still cast real shadow
 * maps inside 28 m (see EnemyAI._shadowLOD). It is the other half of a grounded
 * figure, and the half a shadow map cannot supply: the tight, dark,
 * sub-decimetre darkening in the crevice where a sole meets a floor. A cascade
 * texel at 20 m is several centimetres across and PCF-softened on top of that, so
 * the contact edge under a boot is exactly the frequency it cannot resolve, and
 * the figure ends up with a shadow *near* it but no shadow *under* it. Every
 * shipped shooter pairs the two for this reason.
 *
 * Patches parked on the actual boot contact points, oriented with the boot, read
 * as two feet — information a single blob under the pelvis does not carry, and
 * which is why the boot layer exists. The pool underneath them carries the other
 * half of the story: the sky a 1.8 m occluder removes from a metre of deck all
 * round it, which no amount of sole-print darkening substitutes for.
 *
 * Two InstancedMeshes, two draw calls for the whole squad, no per-frame
 * allocation. Black over the linear buffer, so it can only ever darken, and it
 * composes correctly with a real cast shadow already lying across the same
 * ground.
 */

const SIZE = 64;

/**
 * Soft elliptical falloff, alpha only — the colour is flat black.
 *
 * THE PROFILE WAS THE BUG. (1-r)^2.1 * (0.55 + 0.45(1-r)^3) is 1.0 at the exact
 * centre and already under 0.25 by r = 0.45, so with the quad's centre hidden
 * beneath the boot itself, everything a viewer could actually see was the outer
 * 55% of the disc — where the alpha is a quarter or less. Measured on the
 * rendered frame at midday: the patch removed 0.008 of luminance from ground
 * sitting at 0.53, a 1.5% darkening. That is not a soft shadow, it is nothing,
 * and it is why one soldier appeared to have a boot contact shadow while the next
 * one on lit pavement appeared to have none. Neither of them did.
 *
 * A real contact-occlusion profile has a broad dark PLATEAU out to the radius of
 * the occluder and only then falls away. One minus a smoothstep over the outer
 * band gives that: full strength to r = 0.42, still 0.5 at r = 0.7, zero at the
 * rim.
 */
function patchTexture() {
  const d = new Uint8Array(SIZE * SIZE * 4);
  const c = (SIZE - 1) / 2;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const dx = (x - c) / c, dy = (y - c) / c;
      const r = Math.min(1, Math.hypot(dx, dy));
      const t = Math.min(1, Math.max(0, (r - 0.42) / 0.58));
      const a = 1 - t * t * (3 - 2 * t);
      const i = (y * SIZE + x) * 4;
      d[i] = d[i + 1] = d[i + 2] = 255;
      d[i + 3] = Math.round(Math.min(1, a) * 255);
    }
  }
  const t = new THREE.DataTexture(d, SIZE, SIZE, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.colorSpace = THREE.NoColorSpace;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _e = new THREE.Euler(-Math.PI / 2, 0, 0, 'YXZ');
const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);

export class ContactShadows {
  /**
   * @param maxBodies how many combatants can be shadowed at once
   *
   * The two layers need different opacities, and an InstancedMesh cannot vary
   * alpha per instance — instanceColor multiplies a colour that is already black.
   * So they are two InstancedMeshes sharing one geometry and one texture: two
   * draw calls for the whole squad, whatever its size.
   */
  constructor(maxBodies) {
    this.tex = patchTexture();
    this.group = new THREE.Group();
    this.group.name = 'ai:contact-shadows';
    /** Callers add and toggle a single object; keep the old handle name. */
    this.mesh = this.group;
    this._geo = new THREE.PlaneGeometry(1, 1);

    /**
     * OPACITY. 0.62 was measured, on the rendered frame, to remove 0.008 of
     * luminance from ground at 0.53 — invisible.
     *
     * The reason is the transfer function, not the number. This quad composites
     * into the LINEAR HDR buffer and the frame is tone-mapped afterwards; ground
     * at a linear 2.0 pulled down to 0.76 by an alpha-0.62 black quad lands
     * within a couple of percent of the same tone-mapped output, because the
     * curve is nearly flat that high. Contact occlusion has to be near-opaque at
     * its core to survive the transfer at all.
     */
    this.boots = this._layer(maxBodies * 2, 0.94, 3);
    this.pool = this._layer(maxBodies, 0.52, 2);
    this.group.add(this.pool.mesh, this.boots.mesh);
    /** Scaled by the light rig: a moonlit yard has weaker contact AO than noon. */
    this.strength = 1;
  }

  /** One instanced layer of patches. `order` decides what composites on top. */
  _layer(count, opacity, order) {
    const mat = new THREE.MeshBasicMaterial({
      map: this.tex,
      color: 0x000000,
      transparent: true,
      opacity,
      blending: THREE.NormalBlending,
      depthWrite: false,
      toneMapped: false,
      side: THREE.FrontSide,
      // The patch sits 10-16 mm above the ground, but a floor that is itself a
      // few metres from the camera can still win the depth test on a shallow
      // angle; the offset makes it unconditional without pushing the quad
      // visibly off the surface.
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    });
    const mesh = new THREE.InstancedMesh(this._geo, mat, count);
    mesh.name = `ai:contact-layer-${order}`;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.renderOrder = order;
    for (let i = 0; i < count; i++) mesh.setMatrixAt(i, HIDDEN);
    mesh.instanceMatrix.needsUpdate = true;
    return { mesh, mat, count, baseOpacity: opacity };
  }

  /**
   * Re-key both layers for a light rig.
   *
   * The floor is deliberately high. Under a sky with no directionality the
   * occlusion is softer and shallower, but it does not go away — and the old 0.55
   * floor multiplying an already-invisible profile produced effectively nothing
   * at dusk and at night, which is where the review found it missing.
   */
  setStrength(k) {
    this.strength = k;
    const f = 0.78 + 0.22 * Math.min(1, k);
    this.boots.mat.opacity = this.boots.baseOpacity * f;
    this.pool.mat.opacity = this.pool.baseOpacity * f;
  }

  /**
   * @param bodies   live combatants
   * @param camera   for the distance fade
   * @param maxDist  patches beyond this are not drawn at all
   *
   * maxDist was 26 m against a cast-shadow LOD that switches off at 28 m, which
   * left a band in which a man had neither a cast shadow nor a contact patch and
   * simply floated. 34 m covers the whole yard for one instance each.
   */
  update(bodies, camera, maxDist = 34) {
    let nb = 0, np = 0;
    const capB = this.boots.count, capP = this.pool.count;
    const far2 = maxDist * maxDist;
    for (let i = 0; i < bodies.length; i++) {
      if (nb + 2 > capB && np + 1 > capP) break;
      const c = bodies[i];
      if (c.dead) continue;
      const feet = c.anim?.footWorld;
      if (!feet) continue;
      const d2 = c.bounds.center.distanceToSquared(camera.position);
      if (d2 > far2) continue;
      // Fade the last 25% of the range so nothing pops on at the boundary.
      const fade = Math.min(1, (far2 - d2) / (far2 * 0.4));
      _e.set(-Math.PI / 2, c.yaw, 0);
      _q.setFromEuler(_e);
      const gIn = c.anim.in;
      /**
       * The boot's OWN measured ground, not the body's — a man astride a step has
       * one foot 200 mm above the other, and a single body-height patch would
       * bury one and float the other. These are the same casts the foot IK is
       * driven from, so the patch is on the surface the sole is on by
       * construction. With no cast (out of the probe band) it sits just under the
       * sole, which is right for a man standing still.
       */
      const gR = Number.isFinite(gIn.groundR) ? gIn.groundR : feet[0].y - 0.02;
      const gL = Number.isFinite(gIn.groundL) ? gIn.groundL : feet[1].y - 0.02;

      /**
       * The pool is centred between the boots, not under the pelvis: a man in a
       * bladed stance carries his hips well off the centre of his own footprint,
       * and the sky he blocks is missing from where his feet are.
       */
      const mx = (feet[0].x + feet[1].x) * 0.5;
      const mz = (feet[0].z + feet[1].z) * 0.5;
      if (np < capP && Number.isFinite(mx + mz + gR + gL)) {
        const w = 0.6 + 0.4 * fade;
        _p.set(mx, Math.min(gR, gL) + 0.010, mz);
        _s.set(1.15 * w, 1.02 * w, 1);
        _m.compose(_p, _q, _s);
        this.pool.mesh.setMatrixAt(np++, _m);
      }

      for (let f = 0; f < 2 && nb < capB; f++) {
        const p = feet[f];
        if (!Number.isFinite(p.x + p.y + p.z)) continue;
        const gy = f === 0 ? gR : gL;
        /**
         * A lifted foot loses its patch — that is what makes a walk read. The
         * ramp is far gentler than it was: at 6.5 per metre over a 15 mm
         * deadband, a boot whose IK settled 5 cm high lost two thirds of its
         * patch, and a standing man's feet routinely sit that high. That is
         * exactly how the darkening came to look conditional on which soldier you
         * happened to be looking at.
         */
        const lift = Math.max(0, p.y - gy - 0.035);
        const k = fade * Math.max(0, 1 - lift * 3.2);
        // No early-out. A patch that is skipped outright is the defect under
        // test; one scaled toward zero at least degrades continuously.
        _p.set(p.x, gy + 0.016, p.z);
        const s = 0.55 + 0.45 * k;
        _s.set(0.42 * s, 0.62 * s, 1);
        _m.compose(_p, _q, _s);
        this.boots.mesh.setMatrixAt(nb++, _m);
      }
    }
    for (let i = nb; i < capB; i++) this.boots.mesh.setMatrixAt(i, HIDDEN);
    for (let i = np; i < capP; i++) this.pool.mesh.setMatrixAt(i, HIDDEN);
    this.boots.mesh.instanceMatrix.needsUpdate = true;
    this.pool.mesh.instanceMatrix.needsUpdate = true;
    this.boots.mesh.visible = nb > 0;
    this.pool.mesh.visible = np > 0;
    this.group.visible = nb > 0 || np > 0;
  }

  dispose() {
    for (const l of [this.boots, this.pool]) {
      l.mat.dispose();
      l.mesh.removeFromParent();
      l.mesh.dispose();
    }
    this._geo.dispose();
    this.tex.dispose();
    this.group.removeFromParent();
  }
}
