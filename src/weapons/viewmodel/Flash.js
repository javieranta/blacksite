import * as THREE from 'three';

/**
 * OWNER: viewmodel agent.
 *
 * Muzzle flash. It has to be the brightest thing in the frame, which means it
 * cannot be a SpriteMaterial: PostFX composites the viewmodel into a half-float
 * HDR buffer *before* tonemapping, so a material clamped at 1.0 lands dimmer
 * than sunlit concrete and vanishes. Everything here runs additively at 4x-34x
 * linear intensity, which is also what pushes it over the bloom threshold.
 *
 * Four stacked cards, each with its own texture, scale curve and per-shot roll:
 *   core    tiny, near-white, decays fastest — the detonation itself
 *   star    six-petal burn, rolls randomly per shot so no two shots match
 *   halo    wide soft glow that expands as it fades
 *   plume   an elongated card along the bore for the forward gas jet
 *
 * A point light rides along so the handguard, the support hand and the barrel
 * are genuinely lit by the discharge rather than just having a sprite in front
 * of them. The *world* gets lit through lighting.flash() from ViewModel.
 */

function texture(size, fn) {
  const data = new Uint8Array(size * size * 4);
  const c = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x - c) / c, dy = (y - c) / c;
      const a = fn(Math.hypot(dx, dy), Math.atan2(dy, dx), dx, dy);
      const i = (y * size + x) * 4;
      data[i] = 255; data[i + 1] = 255; data[i + 2] = 255;
      data[i + 3] = Math.max(0, Math.min(255, Math.round(a * 255)));
    }
  }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.colorSpace = THREE.NoColorSpace;
  t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

/** Six-petal star with a hot core and a long tail. */
const starTex = (size = 96) => texture(size, (r, a) => {
  const petal = 0.52 + 0.48 * Math.pow(Math.abs(Math.cos(a * 3)), 0.55);
  const spike = 0.30 * Math.pow(Math.abs(Math.cos(a * 3 + Math.PI / 6)), 6.0);
  const edge = Math.max(0, 1 - r / (petal + spike));
  return Math.pow(edge, 2.0) * 0.5 + Math.pow(edge, 6.5) * 0.5;
});

/** Smooth radial glow. */
const glowTex = (size = 64) => texture(size, (r) => {
  const e = Math.max(0, 1 - r);
  return Math.pow(e, 2.6);
});

/** Forward gas plume: a teardrop, wide at the muzzle, tapering out. */
const plumeTex = (size = 96) => texture(size, (r, a, dx, dy) => {
  const t = (dy + 1) * 0.5;                       // 0 at the muzzle end
  const wid = 0.24 + 0.72 * Math.pow(1 - t, 0.75);
  const lat = Math.max(0, 1 - Math.abs(dx) / wid);
  const lon = Math.max(0, 1 - t) * (t > 0.02 ? 1 : 0);
  return Math.pow(lat, 2.2) * Math.pow(lon, 1.3);
});

const VERT = /* glsl */`
uniform float uRoll;
varying vec2 vUv;
void main() {
  vec2 c = uv - 0.5;
  float s = sin( uRoll ), k = cos( uRoll );
  vUv = vec2( c.x * k - c.y * s, c.x * s + c.y * k ) + 0.5;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`;

const FRAG = /* glsl */`
uniform sampler2D uMap;
uniform vec3 uEdge;
uniform vec3 uCore;
uniform float uInt;
varying vec2 vUv;
void main() {
  float a = texture2D( uMap, vUv ).a;
  vec3 col = mix( uEdge, uCore, a * a );
  gl_FragColor = vec4( col * a * uInt, 1.0 );
}
`;

function card(tex, edge, core) {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: tex },
      uEdge: { value: new THREE.Color(edge) },
      uCore: { value: new THREE.Color(core) },
      uInt: { value: 0 },
      uRoll: { value: 0 },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
  mesh.frustumCulled = false;
  mesh.visible = false;
  return mesh;
}

export class MuzzleFlash {
  /** @param parent an Object3D in camera space (the view camera itself). */
  constructor(parent) {
    this.t = 0;
    this._roll = 0;
    this._jitter = 1;
    this.group = new THREE.Group();
    this.group.name = 'vm:flash';
    this.group.renderOrder = 20;
    parent.add(this.group);

    this.texStar = starTex();
    this.texGlow = glowTex();
    this.texPlume = plumeTex();

    this.halo = card(this.texGlow, 0xff8a2e, 0xffc472);
    this.plume = card(this.texPlume, 0xff9a3a, 0xffe0a8);
    this.star = card(this.texStar, 0xffa542, 0xfff2d4);
    this.core = card(this.texGlow, 0xffd9a0, 0xffffff);
    for (const c of [this.halo, this.plume, this.star, this.core]) {
      c.renderOrder = 20;
      this.group.add(c);
    }

    // Lights the weapon and the hands from the front for the duration.
    //
    // Inverse-square is right for a light out in the world and wrong for one
    // sitting inside the object it lights: the trigger guard and the firing
    // hand's knuckles pass within 100 mm of the muzzle in the hipfire pose,
    // where a decay of 2 multiplies the intensity by a hundred and every facet
    // that happens to face the muzzle receives 100x its nominal irradiance. A
    // decay of 1.5 takes that to 32x and keeps the falloff across the length of
    // the weapon almost unchanged, so the discharge still reads on the
    // handguard and the barrel — which is what this light is for — without the
    // near geometry clipping to flat white. The brightness of the flash itself
    // lives in the additive cards, not here.
    this.light = new THREE.PointLight(0xffb066, 0, 1.4, 1.5);
    this.light.name = 'vm:flash:light';
    this.group.add(this.light);
  }

  /** Fire: reset the envelope and reroll the shape. */
  trigger(rng = Math.random) {
    this.t = 1;
    this._roll = rng() * Math.PI * 2;
    this._jitter = 0.82 + rng() * 0.36;
    this.star.material.uniforms.uRoll.value = this._roll;
    this.halo.material.uniforms.uRoll.value = rng() * Math.PI * 2;
    this.core.material.uniforms.uRoll.value = rng() * Math.PI * 2;
  }

  /** Hold a representative mid-event pose (the shoot rig's ?fire=1). */
  hold(v = 0.72) {
    this.t = v;
    if (this._roll === 0) this.trigger(() => 0.37);
    this.t = v;
  }

  /**
   * @param dt seconds
   * @param pos muzzle position in the parent's space
   * @param fwd bore direction in the parent's space (for the plume)
   */
  update(dt, pos, fwd) {
    if (this.t <= 0) {
      if (this.group.visible) {
        this.group.visible = false;
        this.light.intensity = 0;
      }
      return;
    }
    this.group.visible = true;
    this.group.position.copy(pos);
    // Draw at the *current* envelope value and decay afterwards, so a shot fired
    // this frame always gets one frame at full brightness. Decaying first meant
    // that at 30 fps a 33 ms envelope was already at zero by the time anything
    // was drawn, and the flash simply never appeared — which is exactly what
    // happened to the forced-fire screenshot view.
    const f = this.t;
    const j = this._jitter;

    // Each layer has its own decay exponent, so the shape changes as it dies
    // instead of the whole sprite simply dimming.
    const fCore = Math.pow(f, 2.4);
    const fStar = Math.pow(f, 1.15);
    const fHalo = Math.pow(f, 0.75);
    const grow = 1 - (1 - f) * (1 - f);

    // SIZE: a 5.56 flash is about a fist at the muzzle — 60-90 mm across, not the
    // 380 mm halo the previous revision grew to, which at 400 mm from the eye
    // subtended three quarters of the frame width and blew the whole exposure.
    // The linear intensities are untouched (and the halo is up, since it is now
    // spreading far less energy): the flash must still clip hard in the HDR
    // buffer and cross the bloom threshold. Small and blinding, not big and hazy.
    this.core.material.uniforms.uInt.value = fCore * 34.0;
    this.core.scale.setScalar((0.0130 + grow * 0.0090) * j);
    this.core.visible = fCore > 0.01;

    this.star.material.uniforms.uInt.value = fStar * 15.0;
    this.star.scale.setScalar((0.0300 + grow * 0.0330) * j);
    this.star.rotation.z = this._roll * 0.35;
    this.star.visible = fStar > 0.01;

    this.halo.material.uniforms.uInt.value = fHalo * 4.2;
    this.halo.scale.setScalar((0.0380 + grow * 0.0420) * j);
    this.halo.visible = fHalo > 0.01;

    // Plume points down the bore: build it flat on the muzzle axis.
    this.plume.material.uniforms.uInt.value = Math.pow(f, 1.8) * 9.0;
    this.plume.scale.set(0.0250 * j, (0.0400 + grow * 0.0420) * j, 1);
    this.plume.visible = f > 0.02;
    if (fwd) {
      // The card's +Y runs along the bore, and it billboards *about* the bore so
      // the jet never turns edge-on — which is exactly what would happen in ADS,
      // where the camera looks straight down the barrel.
      _up.copy(fwd).normalize();
      _toCam.copy(pos).negate();
      if (_toCam.lengthSq() < 1e-8) _toCam.set(0, 0, 1);
      _toCam.normalize();
      _zAx.copy(_toCam).addScaledVector(_up, -_toCam.dot(_up));
      if (_zAx.lengthSq() < 1e-8) _zAx.set(0, 1, 0).addScaledVector(_up, -_up.y);
      _zAx.normalize();
      _xAx.crossVectors(_up, _zAx).normalize();
      _basis.makeBasis(_xAx, _up, _zAx);
      this.plume.quaternion.setFromRotationMatrix(_basis);
      this.plume.position.copy(_up).multiplyScalar(0.020 * j);
    }

    this.light.intensity = Math.pow(f, 1.6) * 18.0;

    // 30 Hz decay = 33 ms = two frames at 60. A rifle flash is over before the
    // eye resolves it; anything longer reads as a fireball hanging off the barrel.
    this.t = Math.max(0, this.t - dt * 30.0);
  }

  dispose() {
    for (const c of [this.halo, this.plume, this.star, this.core]) {
      c.geometry.dispose();
      c.material.dispose();
    }
    this.texStar.dispose(); this.texGlow.dispose(); this.texPlume.dispose();
    this.group.removeFromParent();
  }
}

const _up = new THREE.Vector3();
const _toCam = new THREE.Vector3();
const _xAx = new THREE.Vector3();
const _zAx = new THREE.Vector3();
const _basis = new THREE.Matrix4();
