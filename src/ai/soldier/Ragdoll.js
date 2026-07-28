import * as THREE from 'three';
import { B, BIND, RIG } from './SoldierRig.js';

/**
 * OWNER: ai agent.
 *
 * Death by verlet ragdoll. Eleven particles, distance constraints and a ground
 * plane; the bone rotations are then *reconstructed* from the particle positions
 * by aiming each bone's bind direction (-Y) down its chain. That gives a
 * collapse that responds to where the round landed and to the geometry the body
 * falls onto, for a fraction of the cost of a real solver — and it never
 * explodes, because verlet integration with position projection is
 * unconditionally stable.
 *
 * Points (indices are local to this file):
 *   0 pelvis  1 chest  2 head  3 shoulderR 4 handR  5 shoulderL 6 handL
 *   7 kneeR   8 footR  9 kneeL 10 footL
 */

const P = {
  pelvis: 0, chest: 1, head: 2, shR: 3, handR: 4, shL: 5, handL: 6,
  kneeR: 7, footR: 8, kneeL: 9, footL: 10,
};
const COUNT = 11;

/** [a, b, stiffness] — rest lengths are captured from the pose at death. */
const LINKS = [
  [P.pelvis, P.chest, 1.0], [P.chest, P.head, 1.0],
  [P.chest, P.shR, 1.0], [P.chest, P.shL, 1.0],
  [P.shR, P.handR, 0.85], [P.shL, P.handL, 0.85],
  [P.pelvis, P.kneeR, 1.0], [P.kneeR, P.footR, 1.0],
  [P.pelvis, P.kneeL, 1.0], [P.kneeL, P.footL, 1.0],
  // cross-braces stand in for joint limits: they stop the body folding in half
  [P.pelvis, P.head, 0.28], [P.shR, P.shL, 0.7],
  [P.pelvis, P.shR, 0.55], [P.pelvis, P.shL, 0.55],
  [P.kneeR, P.kneeL, 0.20], [P.footR, P.footL, 0.12],
  [P.chest, P.handR, 0.18], [P.chest, P.handL, 0.18],
];

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _down = new THREE.Vector3(0, -1, 0);
const _upv = new THREE.Vector3(0, 1, 0);

export class Ragdoll {
  constructor() {
    this.pos = new Float32Array(COUNT * 3);
    this.prev = new Float32Array(COUNT * 3);
    this.rest = new Float32Array(LINKS.length);
    this.active = false;
    this.groundY = 0;
    this.settle = 0;
  }

  /**
   * Snapshot the live pose and convert it into particles.
   * @param bones  live bone array (world matrices already up to date)
   * @param impulse world-space velocity to inject (the round's momentum)
   * @param groundY floor height under the body
   */
  start(bones, impulse, groundY) {
    const map = [
      B.pelvis, B.chest, B.head, B.armR, B.handR, B.armL, B.handL,
      B.calfR, B.footR, B.calfL, B.footL,
    ];
    for (let i = 0; i < COUNT; i++) {
      bones[map[i]].getWorldPosition(_v);
      this.pos[i * 3] = _v.x; this.pos[i * 3 + 1] = _v.y; this.pos[i * 3 + 2] = _v.z;
      // Seeding prev with a backward offset injects the initial velocity.
      this.prev[i * 3] = _v.x - impulse.x * 0.0083;
      this.prev[i * 3 + 1] = _v.y - impulse.y * 0.0083;
      this.prev[i * 3 + 2] = _v.z - impulse.z * 0.0083;
    }
    for (let i = 0; i < LINKS.length; i++) {
      const [a, b] = LINKS[i];
      this.rest[i] = Math.hypot(
        this.pos[a * 3] - this.pos[b * 3],
        this.pos[a * 3 + 1] - this.pos[b * 3 + 1],
        this.pos[a * 3 + 2] - this.pos[b * 3 + 2],
      );
    }
    this.groundY = groundY;
    this.active = true;
    this.settle = 0;
    this.radii = this.radii || new Float32Array([
      0.17, 0.19, 0.14, 0.10, 0.07, 0.10, 0.07, 0.09, 0.07, 0.09, 0.07,
    ]);
  }

  step(dt) {
    if (!this.active) return;
    const h = Math.min(dt, 1 / 60);
    const pos = this.pos, prev = this.prev;
    const drag = 0.992;
    const g = -19.5 * h * h;

    for (let i = 0; i < COUNT; i++) {
      const o = i * 3;
      for (let k = 0; k < 3; k++) {
        const p = pos[o + k];
        let v = (p - prev[o + k]) * drag;
        if (v > 0.6) v = 0.6; else if (v < -0.6) v = -0.6;
        prev[o + k] = p;
        pos[o + k] = p + v + (k === 1 ? g : 0);
      }
    }

    // Constraints, a few iterations — more iterations = stiffer body.
    for (let it = 0; it < 6; it++) {
      for (let i = 0; i < LINKS.length; i++) {
        const [a, b, k] = LINKS[i];
        const ao = a * 3, bo = b * 3;
        const dx = pos[bo] - pos[ao], dy = pos[bo + 1] - pos[ao + 1], dz = pos[bo + 2] - pos[ao + 2];
        const d = Math.hypot(dx, dy, dz) || 1e-5;
        const diff = ((d - this.rest[i]) / d) * 0.5 * k;
        pos[ao] += dx * diff; pos[ao + 1] += dy * diff; pos[ao + 2] += dz * diff;
        pos[bo] -= dx * diff; pos[bo + 1] -= dy * diff; pos[bo + 2] -= dz * diff;
      }
      // Ground: project up, and scrub tangential motion so limbs do not skate.
      for (let i = 0; i < COUNT; i++) {
        const o = i * 3;
        const floor = this.groundY + this.radii[i] * 0.55;
        if (pos[o + 1] < floor) {
          pos[o + 1] = floor;
          prev[o] += (pos[o] - prev[o]) * 0.55;
          prev[o + 2] += (pos[o + 2] - prev[o + 2]) * 0.55;
        }
      }
    }

    let motion = 0;
    for (let i = 0; i < COUNT * 3; i++) motion += Math.abs(pos[i] - prev[i]);
    if (motion < 0.006) this.settle += dt; else this.settle = 0;
    if (this.settle > 1.4) this.active = false;   // asleep: stop integrating
  }

  /** Rebuild the skeleton from the particle cloud. */
  apply(bones, group) {
    const pos = this.pos;
    const get = (i, out) => out.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);

    // Root the group at the pelvis, keep its yaw, and let the bones do the rest.
    bones[B.pelvis].position.y = BIND[B.pelvis].y;
    get(P.pelvis, _v);
    group.position.copy(_v);
    group.position.y -= BIND[B.pelvis].y;
    group.rotation.set(0, group.rotation.y, 0);
    group.updateMatrixWorld(true);

    const aim = (bone, from, to, extra) => {
      get(from, _v); get(to, _v2);
      _v2.sub(_v);
      if (_v2.lengthSq() < 1e-8) return;
      _v2.normalize();
      bone.parent.getWorldQuaternion(_q);
      _q.invert();
      const local = _v2.applyQuaternion(_q);
      _q.setFromUnitVectors(_down, local);
      bone.quaternion.copy(_q);
      if (extra) bone.rotateX(extra);
      bone.updateWorldMatrix(false, false);
    };

    // Spine: pelvis -> chest -> head. The trunk bones' bind direction is +Y, so
    // aim them with the chain inverted.
    get(P.pelvis, _v); get(P.chest, _v2);
    _v2.sub(_v).normalize();
    bones[B.pelvis].parent.getWorldQuaternion(_q);
    _q.invert();
    _v2.applyQuaternion(_q);
    _q.setFromUnitVectors(_upv, _v2);
    bones[B.pelvis].quaternion.copy(_q);
    bones[B.pelvis].updateWorldMatrix(false, false);
    bones[B.spine].quaternion.identity();
    bones[B.spine].updateWorldMatrix(false, false);

    get(P.chest, _v); get(P.head, _v2);
    _v2.sub(_v).normalize();
    bones[B.chest].parent.getWorldQuaternion(_q);
    _q.invert();
    _v2.applyQuaternion(_q);
    _q.setFromUnitVectors(_upv, _v2);
    bones[B.chest].quaternion.copy(_q);
    bones[B.chest].updateWorldMatrix(false, false);
    bones[B.neck].quaternion.identity();
    bones[B.neck].updateWorldMatrix(false, false);
    bones[B.head].quaternion.identity();
    bones[B.head].updateWorldMatrix(false, false);

    bones[B.clavR].quaternion.identity(); bones[B.clavR].updateWorldMatrix(false, false);
    bones[B.clavL].quaternion.identity(); bones[B.clavL].updateWorldMatrix(false, false);

    // Limbs: upper segment aims at the mid point, lower segment at the tip. The
    // mid points are implied by the constraint network, so elbows and knees end
    // up where the links put them.
    aim(bones[B.armR], P.shR, P.handR);
    bones[B.foreR].quaternion.identity(); bones[B.foreR].rotateX(-0.75);
    bones[B.foreR].updateWorldMatrix(false, false);
    bones[B.handR].quaternion.identity(); bones[B.handR].updateWorldMatrix(false, false);

    aim(bones[B.armL], P.shL, P.handL);
    bones[B.foreL].quaternion.identity(); bones[B.foreL].rotateX(-0.55);
    bones[B.foreL].updateWorldMatrix(false, false);
    bones[B.handL].quaternion.identity(); bones[B.handL].updateWorldMatrix(false, false);

    aim(bones[B.thighR], P.pelvis, P.kneeR);
    aim(bones[B.calfR], P.kneeR, P.footR);
    bones[B.footR].quaternion.identity(); bones[B.footR].rotateX(0.35);
    bones[B.footR].updateWorldMatrix(false, false);

    aim(bones[B.thighL], P.pelvis, P.kneeL);
    aim(bones[B.calfL], P.kneeL, P.footL);
    bones[B.footL].quaternion.identity(); bones[B.footL].rotateX(0.35);
    bones[B.footL].updateWorldMatrix(false, false);
  }
}

export { RIG as RAGDOLL_RIG };
