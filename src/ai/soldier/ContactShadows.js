import * as THREE from 'three';

/**
 * OWNER: ai agent.
 *
 * Per-boot contact occlusion for the combatants.
 *
 * This is NOT a substitute for the cascade — the bodies still cast real shadow
 * maps inside 28 m (see EnemyAI._shadowLOD). It is the other half of a grounded
 * figure, and the half a shadow map cannot supply: the tight, dark, sub-decimetre
 * darkening in the crevice where a sole meets a floor. A cascade texel at 20 m is
 * several centimetres across and PCF-softened on top of that, so the contact edge
 * under a boot is exactly the frequency it cannot resolve, and the figure ends up
 * with a shadow *near* it but no shadow *under* it. Every shipped shooter pairs
 * the two for this reason.
 *
 * Two soft ellipses per man rather than one disc under the pelvis, because a
 * single blob is the PS2 tell: it tracks the body instead of the feet, so it
 * slides when he leans and stays put when he steps. Ellipses parked on the actual
 * boot contact patches, oriented with the boot, do the opposite — and they read
 * as two feet, which is information a blob does not carry.
 *
 * One InstancedMesh, one draw call for the whole squad, no per-frame allocation.
 * Multiply-blended so it can only ever darken, and it composes correctly with a
 * real cast shadow already lying across the same ground.
 */

const SIZE = 64;

/** Soft elliptical falloff, alpha only — the colour is flat black. */
function patchTexture() {
  const d = new Uint8Array(SIZE * SIZE * 4);
  const c = (SIZE - 1) / 2;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const dx = (x - c) / c, dy = (y - c) / c;
      const r = Math.min(1, Math.hypot(dx, dy));
      // Hard-ish core under the sole, long soft tail — the shape ambient
      // occlusion actually has against a diffuse floor.
      const a = (1 - r) ** 2.1 * (0.55 + 0.45 * (1 - r) ** 3);
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
  /** @param maxBodies how many combatants can be shadowed at once (2 patches each) */
  constructor(maxBodies) {
    this.count = maxBodies * 2;
    this.tex = patchTexture();
    this.mat = new THREE.MeshBasicMaterial({
      map: this.tex,
      color: 0x000000,
      transparent: true,
      opacity: 0.62,
      blending: THREE.NormalBlending,
      depthWrite: false,
      toneMapped: false,
      side: THREE.FrontSide,
      // The patch sits 15 mm above the ground, but a floor that is itself a few
      // metres from the camera can still win the depth test on a shallow angle;
      // the offset makes it unconditional without pushing the quad visibly off
      // the surface.
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    });
    const g = new THREE.PlaneGeometry(1, 1);
    this.mesh = new THREE.InstancedMesh(g, this.mat, this.count);
    this.mesh.name = 'ai:contact-shadows';
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.renderOrder = 2;
    for (let i = 0; i < this.count; i++) this.mesh.setMatrixAt(i, HIDDEN);
    this.mesh.instanceMatrix.needsUpdate = true;
    /** Scaled by the light rig: a moonlit yard has weaker contact AO than noon. */
    this.strength = 1;
  }

  setStrength(k) {
    this.strength = k;
    this.mat.opacity = 0.62 * k;
  }

  /**
   * @param bodies   live combatants
   * @param camera   for the distance fade
   * @param maxDist  patches beyond this are not drawn at all
   */
  update(bodies, camera, maxDist = 26) {
    let n = 0;
    const cap = this.count;
    const far2 = maxDist * maxDist;
    for (let i = 0; i < bodies.length && n < cap; i++) {
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
      for (let f = 0; f < 2 && n < cap; f++) {
        const p = feet[f];
        if (!Number.isFinite(p.x + p.y + p.z)) continue;
        /**
         * The boot's OWN measured ground, not the body's — a man astride a step
         * has one foot 200 mm above the other, and a single body-height patch
         * would bury one and float the other. These are the same casts the foot
         * IK is driven from, so the patch is on the surface the sole is on by
         * construction. With no cast (out of the probe band) the patch sits just
         * under the sole, which is right for a man standing still.
         */
        const g = f === 0 ? gIn.groundR : gIn.groundL;
        const gy = Number.isFinite(g) ? g : p.y - 0.02;
        // A lifted foot loses its patch — that is what makes a walk read.
        const lift = Math.max(0, p.y - gy - 0.015);
        const k = fade * Math.max(0, 1 - lift * 6.5);
        if (k < 0.02) continue;
        _p.set(p.x, gy + 0.015, p.z);
        _s.set(0.40 * (0.75 + k * 0.25), 0.60 * (0.75 + k * 0.25), 1);
        _m.compose(_p, _q, _s);
        this.mesh.setMatrixAt(n, _m);
        n++;
      }
    }
    for (let i = n; i < cap; i++) this.mesh.setMatrixAt(i, HIDDEN);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.visible = n > 0;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mat.dispose();
    this.tex.dispose();
    this.mesh.removeFromParent();
    this.mesh.dispose();
  }
}
