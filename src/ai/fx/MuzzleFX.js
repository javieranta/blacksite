import * as THREE from 'three';

/**
 * OWNER: ai agent.
 *
 * A tiny pooled muzzle-flash billboard for enemy fire. The Particles system owns
 * the general-purpose effects and gets called too — this exists because the
 * flash is the single most important read in a firefight (it is what tells the
 * player where he is being shot from) and the AI should not depend on another
 * system's pool being populated to produce it.
 *
 * One additive quad plus a stubby bore cone per shot, both hidden when idle, so
 * an inactive squad costs zero draw calls.
 */

const SIZE = 64;

function flashTexture() {
  const d = new Uint8Array(SIZE * SIZE * 4);
  const c = (SIZE - 1) / 2;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const dx = (x - c) / c, dy = (y - c) / c;
      const r = Math.hypot(dx, dy);
      const a = Math.atan2(dy, dx);
      // Radial core + four hard spikes + a ring of soft petals.
      const core = Math.max(0, 1 - r * 1.9) ** 2.2;
      const spike = Math.max(0, 1 - r) ** 2.6 * (Math.abs(Math.cos(a * 2)) ** 8) * 0.9;
      const petal = Math.max(0, 1 - r * 1.25) ** 3 * (0.55 + 0.45 * Math.cos(a * 7)) * 0.5;
      const v = Math.min(1, core * 1.5 + spike + petal);
      const i = (y * SIZE + x) * 4;
      d[i] = Math.min(255, v * 300);
      d[i + 1] = Math.min(255, v * 232);
      d[i + 2] = Math.min(255, v * 150 + core * 90);
      d[i + 3] = Math.min(255, v * 255);
    }
  }
  const t = new THREE.DataTexture(d, SIZE, SIZE, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.colorSpace = THREE.SRGBColorSpace;
  t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

export class MuzzleFX {
  constructor(count = 6) {
    this.group = new THREE.Group();
    this.group.name = 'ai:muzzlefx';
    this.tex = flashTexture();
    this.mat = new THREE.MeshBasicMaterial({
      map: this.tex, transparent: true, blending: THREE.AdditiveBlending,
      depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
    });
    this.coneMat = new THREE.MeshBasicMaterial({
      color: 0xffd9a0, transparent: true, opacity: 0.85,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
    });
    const quad = new THREE.PlaneGeometry(1, 1);
    const cone = new THREE.ConeGeometry(0.055, 0.30, 8, 1, true);
    cone.rotateX(-Math.PI / 2);
    cone.translate(0, 0, -0.13);
    this.items = [];
    for (let i = 0; i < count; i++) {
      const card = new THREE.Mesh(quad, this.mat);
      const spike = new THREE.Mesh(cone, this.coneMat);
      card.visible = spike.visible = false;
      card.frustumCulled = false;
      spike.frustumCulled = false;
      this.group.add(card, spike);
      this.items.push({ card, spike, life: 0, dur: 0.055, scale: 1, roll: 0 });
    }
    this.next = 0;
    this._up = new THREE.Vector3(0, 1, 0);
    // Deterministic jitter: the shoot rig compares rounds frame for frame, so
    // the flash must not depend on Math.random.
    this._seed = 12345;
  }

  _rnd() {
    this._seed = (Math.imul(this._seed, 1664525) + 1013904223) >>> 0;
    return this._seed / 4294967296;
  }

  /** Fire a flash at `position`, pointing along `dir`. */
  spawn(position, dir, scale = 1) {
    const it = this.items[this.next];
    this.next = (this.next + 1) % this.items.length;
    it.life = it.dur;
    it.scale = scale * (0.85 + this._rnd() * 0.4);
    it.roll = this._rnd() * Math.PI;
    it.card.position.copy(position).addScaledVector(dir, 0.06);
    it.spike.position.copy(position);
    // The cone is authored down -Z, which is exactly where lookAt points.
    it.spike.lookAt(
      it.spike.position.x + dir.x,
      it.spike.position.y + dir.y,
      it.spike.position.z + dir.z,
    );
    it.card.visible = it.spike.visible = true;
  }

  update(dt, camera) {
    for (const it of this.items) {
      if (it.life <= 0) continue;
      it.life -= dt;
      if (it.life <= 0) { it.card.visible = it.spike.visible = false; continue; }
      const k = it.life / it.dur;
      const s = it.scale * (0.55 + k * 0.85);
      it.card.scale.setScalar(s * 0.55);
      it.card.quaternion.copy(camera.quaternion);
      it.card.rotateZ(it.roll);
      it.spike.scale.set(0.7 + k * 0.5, 0.7 + k * 0.5, 0.6 + k * 0.9);
    }
  }

  dispose() {
    this.tex.dispose();
    this.mat.dispose();
    this.coneMat.dispose();
    this.items[0]?.card.geometry.dispose();
    this.items[0]?.spike.geometry.dispose();
    this.group.removeFromParent();
  }
}
