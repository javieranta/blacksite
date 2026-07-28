import * as THREE from 'three';

/**
 * OWNER: fx agent.
 *
 * One GPU-instanced particle batch: a single unit quad drawn `count` times, one
 * draw call for the whole batch. Two of these exist (additive + alpha-blended).
 *
 * Storage layout — every particle is a row of plain floats in typed arrays, so
 * the simulation is a flat loop with no objects, no closures and no allocation.
 * Dead particles are removed by swapping the last live particle into the hole,
 * which keeps the live set contiguous: `geometry.instanceCount = count` then
 * draws exactly what is alive and nothing else.
 *
 * GPU attributes (27 floats/particle):
 *   aPos  vec3   world position
 *   aVel  vec3   world velocity (the vertex shader needs it for motion stretch)
 *   aT    float  normalised age 0..1 — drives every curve
 *   aSize vec3   3-key size curve (birth / mid / death), quadratic Bézier
 *   aRot  float  billboard roll
 *   aC0/aC1/aC2  vec4 rgb+alpha colour-over-life ramp, same Bézier
 *   aP    vec4   x=atlas tile · y=motion stretch (m per m/s) · z=soft-fade
 *                distance in metres · w=HDR brightness multiplier
 *
 * Simulation-only arrays (never uploaded): lifetime, age, gravity scale, drag,
 * turbulence, spin, floor height and restitution.
 */

const VERT = /* glsl */`
attribute vec3 aPos;
attribute vec3 aVel;
attribute float aT;
attribute vec3 aSize;
attribute float aRot;
attribute vec4 aC0;
attribute vec4 aC1;
attribute vec4 aC2;
attribute vec4 aP;

uniform vec2 uAtlas;
uniform float uInset;
uniform float uMaxNDC;

varying vec2 vUv;
varying vec4 vCol;
varying float vViewZ;
varying float vSoft;
varying float vBright;

void main() {
  float t = clamp(aT, 0.0, 1.0);
  float o = 1.0 - t;
  float w0 = o * o;
  float w1 = 2.0 * o * t;
  float w2 = t * t;

  float size = aSize.x * w0 + aSize.y * w1 + aSize.z * w2;
  vCol = aC0 * w0 + aC1 * w1 + aC2 * w2;
  vSoft = aP.z;
  vBright = aP.w;

  vec4 mv = modelViewMatrix * vec4(aPos, 1.0);

  // Screen-coverage clamp. A 40cm puff half a metre from the lens fills the
  // frame and costs a full-screen blend; capping its projected radius keeps the
  // fill-rate bill bounded no matter where the player stands.
  float ndc = size * 0.5 * projectionMatrix[1][1] / max(-mv.z, 0.02);
  if (ndc > uMaxNDC) size *= uMaxNDC / ndc;

  vec2 q = position.xy;
  float c = cos(aRot);
  float s = sin(aRot);
  vec2 off = vec2(q.x * c - q.y * s, q.x * s + q.y * c) * size;

  // Motion stretch: elongate the quad along the screen-space velocity and hang
  // the trailing edge behind the particle so the head stays on the position.
  if (aP.y > 0.0) {
    vec3 vv = (viewMatrix * vec4(aVel, 0.0)).xyz;
    vec2 d2 = vv.xy;
    float len = length(d2);
    if (len > 0.001) {
      vec2 dir = d2 / len;
      vec2 per = vec2(-dir.y, dir.x);
      float lng = size + len * aP.y;
      off = dir * ((q.x - 0.5) * lng) + per * (q.y * size);
    }
  }

  mv.xy += off;
  vViewZ = -mv.z;

  vec2 tile = vec2(mod(aP.x, uAtlas.x), floor(aP.x / uAtlas.x + 0.001));
  vUv = (tile + vec2(uInset) + uv * (1.0 - 2.0 * uInset)) / uAtlas;

  gl_Position = projectionMatrix * mv;
}
`;

const FRAG = /* glsl */`
uniform sampler2D uMap;
uniform sampler2D uDepth;
uniform vec2 uRes;
uniform vec2 uClip;
uniform float uUseDepth;
uniform float uNearFade;
uniform vec3 uFogColour;
uniform float uFogDensity;
uniform float uFog;

varying vec2 vUv;
varying vec4 vCol;
varying float vViewZ;
varying float vSoft;
varying float vBright;

void main() {
  vec4 tx = texture2D(uMap, vUv);
  float a = tx.a * vCol.a;
  if (a < 0.0025) discard;

  // Soft particles: fade where the billboard would otherwise cut a hard line
  // through world geometry. The depth buffer is the composer's stable copy —
  // one frame old, which is imperceptible for a fade width of ~1m.
  if (uUseDepth > 0.5 && vSoft > 0.0) {
    vec2 suv = gl_FragCoord.xy / uRes;
    float d = texture2D(uDepth, suv).x;
    float sceneZ = (uClip.x * uClip.y) / (uClip.y - (uClip.y - uClip.x) * d);
    a *= clamp((sceneZ - vViewZ) / vSoft, 0.0, 1.0);
  }
  // Never let a sprite slam into the near plane in the player's face.
  a *= smoothstep(uNearFade * 0.30, uNearFade, vViewZ);

  vec3 col = tx.rgb * vCol.rgb * vBright;

  float f = 1.0 - exp(-uFogDensity * uFogDensity * vViewZ * vViewZ);
  #ifdef ADDITIVE
    // Aerial extinction on an emissive sprite means *less light arrives*, not a
    // shift toward the fog colour.
    col *= 1.0 - f * uFog;
    gl_FragColor = vec4(col, a);
  #else
    col = mix(col, uFogColour, f * uFog);
    gl_FragColor = vec4(col, a);
  #endif
}
`;

/** Scratch descriptor: `Particles` fills this and calls push(). No garbage. */
export function makeDescriptor() {
  return {
    x: 0, y: 0, z: 0,
    vx: 0, vy: 0, vz: 0,
    life: 1,
    s0: 0.2, s1: 0.3, s2: 0.1,
    rot: 0, spin: 0,
    tile: 0, stretch: 0, soft: 0, bright: 1,
    r0: 1, g0: 1, b0: 1, a0: 1,
    r1: 1, g1: 1, b1: 1, a1: 1,
    r2: 1, g2: 1, b2: 1, a2: 0,
    grav: 0, drag: 0, turb: 0,
    floorY: -1e9, bounce: 0,
  };
}

export class ParticleBatch {
  /**
   * @param {object} o
   * @param {number} o.capacity   max live particles
   * @param {boolean} o.additive  additive (emissive) or alpha-blended path
   * @param {THREE.Texture} o.atlas
   */
  constructor({ capacity, additive, atlas, cols, rows, name }) {
    this.capacity = capacity;
    this.additive = additive;
    this.count = 0;
    this.dropped = 0;

    // --- GPU attribute storage -----------------------------------------------
    this.aPos = f32(capacity, 3);
    this.aVel = f32(capacity, 3);
    this.aT = f32(capacity, 1);
    this.aSize = f32(capacity, 3);
    this.aRot = f32(capacity, 1);
    this.aC0 = f32(capacity, 4);
    this.aC1 = f32(capacity, 4);
    this.aC2 = f32(capacity, 4);
    this.aP = f32(capacity, 4);

    // --- simulation-only storage ---------------------------------------------
    this.life = new Float32Array(capacity);
    this.age = new Float32Array(capacity);
    this.grav = new Float32Array(capacity);
    this.drag = new Float32Array(capacity);
    this.turb = new Float32Array(capacity);
    this.spin = new Float32Array(capacity);
    this.floorY = new Float32Array(capacity);
    this.bounce = new Float32Array(capacity);

    // Unit quad, authored by hand so nothing is shared with a geometry that
    // later gets disposed.
    const geo = new THREE.InstancedBufferGeometry();
    geo.setIndex([0, 2, 1, 2, 3, 1]);
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
      -0.5, 0.5, 0, 0.5, 0.5, 0, -0.5, -0.5, 0, 0.5, -0.5, 0,
    ]), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([
      0, 1, 1, 1, 0, 0, 1, 0,
    ]), 2));

    this._attrs = [];
    const bind = (nm, arr, items, dynamic) => {
      const a = new THREE.InstancedBufferAttribute(arr, items);
      a.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute(nm, a);
      this._attrs.push({ a, items, dynamic });
      return a;
    };
    this._pos = bind('aPos', this.aPos, 3, true);
    this._vel = bind('aVel', this.aVel, 3, true);
    this._t = bind('aT', this.aT, 1, true);
    this._size = bind('aSize', this.aSize, 3, false);
    this._rotA = bind('aRot', this.aRot, 1, true);
    bind('aC0', this.aC0, 4, false);
    bind('aC1', this.aC1, 4, false);
    bind('aC2', this.aC2, 4, false);
    bind('aP', this.aP, 4, false);

    geo.instanceCount = 0;
    // The batch is world-space geometry authored at the origin; never let the
    // frustum test throw it away and never let three try to bound it.
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    geo.computeBoundingSphere = () => {};
    this.geometry = geo;

    this.material = new THREE.ShaderMaterial({
      defines: additive ? { ADDITIVE: '' } : {},
      uniforms: {
        uMap: { value: atlas },
        uDepth: { value: null },
        uRes: { value: new THREE.Vector2(1920, 1080) },
        uClip: { value: new THREE.Vector2(0.02, 900) },
        uUseDepth: { value: 0 },
        uNearFade: { value: additive ? 0.10 : 0.35 },
        uFogColour: { value: new THREE.Color(0x9fb4c6) },
        uFogDensity: { value: 0.0 },
        uFog: { value: additive ? 0.55 : 1.0 },
        uAtlas: { value: new THREE.Vector2(cols, rows) },
        uInset: { value: 0.018 },
        uMaxNDC: { value: additive ? 0.75 : 0.22 },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      side: THREE.DoubleSide,
      toneMapped: false,
    });

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.name = name;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = additive ? 12 : 10;
    this.mesh.matrixAutoUpdate = false;

    this._hasRanges = typeof this._pos.addUpdateRange === 'function';
    this._staticDirty = false;
  }

  /** @returns {boolean} false when the batch is full (caller may downscale). */
  push(p) {
    const i = this.count;
    if (i >= this.capacity) { this.dropped++; return false; }
    const i1 = i;
    const i3 = i * 3;
    const i4 = i * 4;

    const pos = this.aPos; const vel = this.aVel;
    pos[i3] = p.x; pos[i3 + 1] = p.y; pos[i3 + 2] = p.z;
    vel[i3] = p.vx; vel[i3 + 1] = p.vy; vel[i3 + 2] = p.vz;
    this.aT[i1] = 0;
    this.aSize[i3] = p.s0; this.aSize[i3 + 1] = p.s1; this.aSize[i3 + 2] = p.s2;
    this.aRot[i1] = p.rot;
    const c0 = this.aC0; const c1 = this.aC1; const c2 = this.aC2; const pp = this.aP;
    c0[i4] = p.r0; c0[i4 + 1] = p.g0; c0[i4 + 2] = p.b0; c0[i4 + 3] = p.a0;
    c1[i4] = p.r1; c1[i4 + 1] = p.g1; c1[i4 + 2] = p.b1; c1[i4 + 3] = p.a1;
    c2[i4] = p.r2; c2[i4 + 1] = p.g2; c2[i4 + 2] = p.b2; c2[i4 + 3] = p.a2;
    pp[i4] = p.tile; pp[i4 + 1] = p.stretch; pp[i4 + 2] = p.soft; pp[i4 + 3] = p.bright;

    this.life[i1] = p.life;
    this.age[i1] = 0;
    this.grav[i1] = p.grav;
    this.drag[i1] = p.drag;
    this.turb[i1] = p.turb;
    this.spin[i1] = p.spin;
    this.floorY[i1] = p.floorY;
    this.bounce[i1] = p.bounce;

    this.count = i + 1;
    this._staticDirty = true;
    return true;
  }

  /** Moves the particle at `from` into `to`. Flat copies, no branching. */
  _move(to, from) {
    cw(this.aPos, to, from, 3); cw(this.aVel, to, from, 3);
    cw(this.aT, to, from, 1); cw(this.aSize, to, from, 3);
    cw(this.aRot, to, from, 1);
    cw(this.aC0, to, from, 4); cw(this.aC1, to, from, 4);
    cw(this.aC2, to, from, 4); cw(this.aP, to, from, 4);
    this.life[to] = this.life[from];
    this.age[to] = this.age[from];
    this.grav[to] = this.grav[from];
    this.drag[to] = this.drag[from];
    this.turb[to] = this.turb[from];
    this.spin[to] = this.spin[from];
    this.floorY[to] = this.floorY[from];
    this.bounce[to] = this.bounce[from];
  }

  /**
   * Integrate. Semi-implicit Euler with drag, gravity scale and an analytic
   * curl-ish turbulence field (only evaluated for particles that asked for it —
   * smoke does, sparks do not, and that keeps the trig off the hot path).
   */
  simulate(dt, gravity, time) {
    const pos = this.aPos; const vel = this.aVel; const T = this.aT;
    const rot = this.aRot; const spin = this.spin;
    const age = this.age; const life = this.life;
    let n = this.count;

    for (let i = 0; i < n;) {
      const a = age[i] + dt;
      const L = life[i];
      if (a >= L) {
        n--;
        if (i !== n) this._move(i, n);
        continue;
      }
      age[i] = a;
      const i3 = i * 3;
      let vx = vel[i3]; let vy = vel[i3 + 1]; let vz = vel[i3 + 2];

      const g = this.grav[i];
      if (g !== 0) vy += gravity * g * dt;

      const tb = this.turb[i];
      if (tb > 0) {
        const px = pos[i3]; const py = pos[i3 + 1]; const pz = pos[i3 + 2];
        vx += Math.sin(py * 1.9 + pz * 0.7 + time * 1.7) * tb * dt;
        vy += Math.sin(px * 2.3 - pz * 1.1 + time * 1.1) * tb * 0.5 * dt;
        vz += Math.cos(px * 1.7 + py * 0.6 + time * 1.3) * tb * dt;
      }

      const d = this.drag[i];
      if (d > 0) {
        const k = 1 - (d * dt > 0.9 ? 0.9 : d * dt);
        vx *= k; vy *= k; vz *= k;
      }

      let x = pos[i3] + vx * dt;
      let y = pos[i3 + 1] + vy * dt;
      let z = pos[i3 + 2] + vz * dt;

      const b = this.bounce[i];
      if (b > 0 && y < this.floorY[i]) {
        y = this.floorY[i];
        if (vy < 0) vy = -vy * b;
        vx *= 0.62; vz *= 0.62;
        spin[i] *= 0.45;
      }

      pos[i3] = x; pos[i3 + 1] = y; pos[i3 + 2] = z;
      vel[i3] = vx; vel[i3 + 1] = vy; vel[i3 + 2] = vz;
      T[i] = a / L;
      rot[i] += spin[i] * dt;
      i++;
    }

    if (n !== this.count) this._staticDirty = true;
    this.count = n;
  }

  /** Uploads only the live prefix of each attribute. */
  flush() {
    const n = this.count;
    this.geometry.instanceCount = n;
    if (n === 0) return;
    for (const rec of this._attrs) {
      if (!rec.dynamic && !this._staticDirty) continue;
      if (this._hasRanges) {
        rec.a.clearUpdateRanges();
        rec.a.addUpdateRange(0, n * rec.items);
      }
      rec.a.needsUpdate = true;
    }
    this._staticDirty = false;
  }

  setDepth(texture, resX, resY, near, far) {
    const u = this.material.uniforms;
    u.uDepth.value = texture;
    u.uUseDepth.value = texture ? 1 : 0;
    u.uRes.value.set(resX, resY);
    u.uClip.value.set(near, far);
  }

  setFog(colour, density) {
    const u = this.material.uniforms;
    if (colour) u.uFogColour.value.copy(colour);
    u.uFogDensity.value = density;
  }

  clear() {
    this.count = 0;
    this.geometry.instanceCount = 0;
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}

function f32(capacity, items) {
  return new Float32Array(capacity * items);
}

function cw(arr, to, from, items) {
  if (items === 1) { arr[to] = arr[from]; return; }
  arr.copyWithin(to * items, from * items, from * items + items);
}
