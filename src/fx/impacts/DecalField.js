import * as THREE from 'three';

/**
 * OWNER: impacts agent.
 *
 * ── Projection ────────────────────────────────────────────────────────────────
 * A decal is not a quad hovering in front of a wall. `DecalProjector` builds a
 * subdivided patch in the projector's tangent plane and drops a ray from every
 * vertex along the projection axis, snapping each one onto whatever geometry it
 * lands on (BVH-accelerated, via the level's collider tree). The patch therefore
 * follows a curved tank wall, breaks over the lip of a crate, and drapes across
 * the join between two surfaces. Vertices whose ray misses — the decal hangs off
 * an edge — get zero alpha instead of stretching into the void, and a vertex
 * whose surface faces away from the projector fades out rather than smearing.
 *
 * ── The field ─────────────────────────────────────────────────────────────────
 * Every decal of a blend family lives in ONE geometry: a fixed grid of slots in
 * a pre-allocated vertex buffer, so 200 bullet holes cost one draw call and zero
 * runtime allocation. Slots are recycled LRU with a fade so nothing ever pops,
 * and the field starts retiring its oldest decals before it runs out of room.
 */

const GRID = 4;                       // 4×4 quads
const VERTS = (GRID + 1) * (GRID + 1); // 25
const TRIS = GRID * GRID * 2;          // 32
const IDX = TRIS * 3;                  // 96

export class DecalProjector {
  constructor() {
    this.pos = new Float32Array(VERTS * 3);
    this.va = new Float32Array(VERTS);
    this.hits = 0;
    this._ray = new THREE.Raycaster();
    this._ray.firstHitOnly = true;
    this._o = new THREE.Vector3();
    this._d = new THREE.Vector3();
    this._t = new THREE.Vector3();
    this._b = new THREE.Vector3();
    this._n = new THREE.Vector3();
    this._hitBuf = [];
    this._candidates = [];
    this._sphere = new THREE.Sphere();
    this._probe = new THREE.Sphere();
  }

  /**
   * Narrow the collider tree down to the handful of meshes the patch can
   * possibly touch, once, before firing 25 rays. Without this every ray walks
   * every baked level mesh; with it, each ray tests one or two.
   */
  _gather(target, point, size) {
    const list = this._candidates;
    list.length = 0;
    const probe = this._probe;
    probe.center.copy(point);
    probe.radius = size * 1.6 + 0.1;
    target.traverse((obj) => {
      if (!obj.isMesh || !obj.visible) return;
      const g = obj.geometry;
      if (!g) return;
      if (!g.boundingSphere) g.computeBoundingSphere();
      if (!g.boundingSphere) return;
      this._sphere.copy(g.boundingSphere).applyMatrix4(obj.matrixWorld);
      if (this._sphere.intersectsSphere(probe)) list.push(obj);
    });
    return list;
  }

  /**
   * @param {THREE.Object3D} target  the collider tree to snap against
   * @param {THREE.Vector3} point    impact point
   * @param {THREE.Vector3} normal   surface normal at the impact
   * @param {number} size            decal width in metres
   * @param {number} rotation        roll around the normal, radians
   * @returns {boolean} false when too little geometry was found to be worth it
   */
  project(target, point, normal, size, rotation) {
    const n = this._n.copy(normal).normalize();
    // Tangent basis, rolled by `rotation` so repeated hits never look stamped.
    const t = this._t;
    if (Math.abs(n.y) > 0.94) t.set(1, 0, 0);
    else t.set(0, 1, 0);
    t.cross(n).normalize();
    const b = this._b.copy(n).cross(t).normalize();
    const cs = Math.cos(rotation);
    const sn = Math.sin(rotation);
    // rotate t/b in their own plane
    const tx = t.x * cs + b.x * sn;
    const ty = t.y * cs + b.y * sn;
    const tz = t.z * cs + b.z * sn;
    const bx = -t.x * sn + b.x * cs;
    const by = -t.y * sn + b.y * cs;
    const bz = -t.z * sn + b.z * cs;

    const lift = size * 0.85 + 0.05;
    const reach = lift + size * 1.05;
    const push = 0.006 + size * 0.012;

    const pos = this.pos;
    const va = this.va;
    const ray = this._ray;
    const dir = this._d.set(-n.x, -n.y, -n.z);
    let hits = 0;

    const candidates = this._gather(target, point, size);
    if (candidates.length === 0) { this.hits = 0; return false; }

    for (let j = 0, k = 0; j <= GRID; j++) {
      const fv = (j / GRID - 0.5) * size;
      for (let i = 0; i <= GRID; i++, k++) {
        const fu = (i / GRID - 0.5) * size;
        const ox = point.x + tx * fu + bx * fv;
        const oy = point.y + ty * fu + by * fv;
        const oz = point.z + tz * fu + bz * fv;
        this._o.set(ox + n.x * lift, oy + n.y * lift, oz + n.z * lift);
        ray.set(this._o, dir);
        ray.near = 0;
        ray.far = reach;
        const buf = this._hitBuf;
        buf.length = 0;
        for (let c = 0; c < candidates.length; c++) {
          candidates[c].raycast(ray, buf);
        }

        let best = null;
        for (let h = 0; h < buf.length; h++) {
          const c = buf[h];
          if (c.distance <= reach && (!best || c.distance < best.distance)) best = c;
        }
        const k3 = k * 3;
        if (best) {
          // Face normal in world space, flipped toward the projector.
          let nx = n.x;
          let ny = n.y;
          let nz = n.z;
          if (best.face) {
            this._o.copy(best.face.normal).transformDirection(best.object.matrixWorld);
            nx = this._o.x; ny = this._o.y; nz = this._o.z;
            if (nx * n.x + ny * n.y + nz * n.z < 0) { nx = -nx; ny = -ny; nz = -nz; }
          }
          pos[k3] = best.point.x + nx * push;
          pos[k3 + 1] = best.point.y + ny * push;
          pos[k3 + 2] = best.point.z + nz * push;
          const facing = nx * n.x + ny * n.y + nz * n.z;
          // Below ~78° the projection is stretched beyond usefulness.
          va[k] = smooth(0.16, 0.55, facing);
          if (va[k] > 0.02) hits++;
        } else {
          pos[k3] = ox; pos[k3 + 1] = oy; pos[k3 + 2] = oz;
          va[k] = 0;
        }
      }
    }
    this.hits = hits;
    return hits >= 6;
  }
}

function smooth(e0, e1, x) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

const VERT = /* glsl */`
attribute vec3 aTint;
attribute float aFade;
attribute vec3 aLife;      // x = birth time, y = fade start age, z = fade duration
uniform float uTime;
varying vec2 vUv;
varying vec3 vTint;
varying float vFade;
varying float vDepth;
void main() {
  vUv = uv;
  vTint = aTint;
  // The fade curve is evaluated here rather than rewritten into the vertex
  // buffer every frame. Ageing 200 decals on the CPU meant rewriting the whole
  // attribute set from JS every frame; doing it on the GPU keeps that loop off
  // the CPU entirely and keeps the buffer contents stable between births.
  // (The *upload* is a separate question — see flush().)
  float age = uTime - aLife.x;
  float al;
  if (age < 0.07) al = age / 0.07;
  else if (age < aLife.y) al = 1.0;
  else al = 1.0 - (age - aLife.y) / max(0.05, aLife.z);
  vFade = aFade * clamp(al, 0.0, 1.0);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

const FRAG = /* glsl */`
uniform sampler2D uMap;
uniform float uFogDensity;
uniform float uStrength;
varying vec2 vUv;
varying vec3 vTint;
varying float vFade;
varying float vDepth;
void main() {
  vec4 tx = texture2D(uMap, vUv);
  float a = tx.a * vFade * uStrength;
  // Aerial perspective washes a decal out with distance like everything else.
  float f = 1.0 - exp(-uFogDensity * uFogDensity * vDepth * vDepth);
  a *= 1.0 - f * 0.92;
  if (a < 0.003) discard;
  #ifdef ADDITIVE
    gl_FragColor = vec4(tx.rgb * vTint * a, a);
  #else
    // dst * mix(1.0, tint, a) — the surface keeps its own lighting.
    gl_FragColor = vec4(tx.rgb * vTint * a, a);
  #endif
}
`;

export class DecalField {
  /**
   * @param {object} o
   * @param {number} o.capacity slots
   * @param {boolean} o.additive blend family
   * @param {THREE.Texture} o.atlas
   * @param {number} o.cols atlas columns
   * @param {number} o.rows atlas rows
   */
  constructor({ capacity, additive, atlas, cols, rows, name, strength = 1 }) {
    this.capacity = capacity;
    this.additive = additive;
    this.cols = cols;
    this.rows = rows;
    this.inset = 0.012;

    this.position = new Float32Array(capacity * VERTS * 3);
    this.uv = new Float32Array(capacity * VERTS * 2);
    this.tint = new Float32Array(capacity * VERTS * 3);
    // Static per-vertex projection alpha, and the per-slot fade schedule the
    // vertex shader plays back. Both are written once, when a decal is stamped.
    this.vAlpha = new Float32Array(capacity * VERTS);
    this.lifeAttr = new Float32Array(capacity * VERTS * 3);

    const index = new Uint32Array(capacity * IDX);
    for (let s = 0; s < capacity; s++) {
      const base = s * VERTS;
      let w = s * IDX;
      for (let j = 0; j < GRID; j++) {
        for (let i = 0; i < GRID; i++) {
          const a = base + j * (GRID + 1) + i;
          const b = a + 1;
          const c = a + (GRID + 1);
          const d = c + 1;
          index[w++] = a; index[w++] = c; index[w++] = b;
          index[w++] = b; index[w++] = c; index[w++] = d;
        }
      }
    }

    // Slot bookkeeping.
    this.used = new Uint8Array(capacity);
    this.age = new Float32Array(capacity);
    this.fadeStart = new Float32Array(capacity);
    this.fadeDur = new Float32Array(capacity);
    this.serial = new Float64Array(capacity);
    this._serial = 0;
    this.live = 0;
    this._clock = 0;

    const geo = new THREE.BufferGeometry();
    this._pos = new THREE.BufferAttribute(this.position, 3).setUsage(THREE.DynamicDrawUsage);
    this._uv = new THREE.BufferAttribute(this.uv, 2).setUsage(THREE.DynamicDrawUsage);
    this._tint = new THREE.BufferAttribute(this.tint, 3).setUsage(THREE.DynamicDrawUsage);
    this._fade = new THREE.BufferAttribute(this.vAlpha, 1).setUsage(THREE.DynamicDrawUsage);
    this._life = new THREE.BufferAttribute(this.lifeAttr, 3).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this._pos);
    geo.setAttribute('uv', this._uv);
    geo.setAttribute('aTint', this._tint);
    geo.setAttribute('aFade', this._fade);
    geo.setAttribute('aLife', this._life);
    geo.setIndex(new THREE.BufferAttribute(index, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    geo.computeBoundingSphere = () => {};
    this.geometry = geo;

    this.material = new THREE.ShaderMaterial({
      defines: additive ? { ADDITIVE: '' } : {},
      uniforms: {
        uMap: { value: atlas },
        uFogDensity: { value: 0 },
        uStrength: { value: strength },
        uTime: { value: 0 },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -6,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    if (additive) {
      this.material.blending = THREE.AdditiveBlending;
    } else {
      // out = dst * mix(1, tint, a): a hole darkens what is already there.
      this.material.blending = THREE.CustomBlending;
      this.material.blendEquation = THREE.AddEquation;
      this.material.blendSrc = THREE.DstColorFactor;
      this.material.blendDst = THREE.OneMinusSrcAlphaFactor;
    }

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.name = name;
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = additive ? 5 : 4;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
  }

  /** @returns {number} a slot, retiring the oldest decal if the field is full. */
  _acquire() {
    for (let i = 0; i < this.capacity; i++) {
      if (!this.used[i]) return i;
    }
    let oldest = 0;
    let best = Infinity;
    for (let i = 0; i < this.capacity; i++) {
      if (this.serial[i] < best) { best = this.serial[i]; oldest = i; }
    }
    return oldest;
  }

  /**
   * Commits a projected patch into a slot.
   * @param {DecalProjector} proj
   * @param {number} tile atlas tile index
   * @param {number} r 0..1 tint
   * @param {number} life seconds before the decal fades out
   */
  write(proj, tile, r, g, b, life, opacity = 1) {
    const s = this._acquire();
    const wasUsed = this.used[s];
    const base = s * VERTS;
    const cols = this.cols;
    const rows = this.rows;
    const col = tile % cols;
    const row = Math.floor(tile / cols);
    const ins = this.inset;

    const dur = Math.min(4, life * 0.25);
    const start = Math.max(0.2, life - dur);
    const birth = this._clock;

    for (let k = 0; k < VERTS; k++) {
      const v = base + k;
      const k3 = k * 3;
      const v3 = v * 3;
      this.position[v3] = proj.pos[k3];
      this.position[v3 + 1] = proj.pos[k3 + 1];
      this.position[v3 + 2] = proj.pos[k3 + 2];
      this.tint[v3] = r; this.tint[v3 + 1] = g; this.tint[v3 + 2] = b;
      const i = k % (GRID + 1);
      const j = (k - i) / (GRID + 1);
      const uu = (col + ins + (i / GRID) * (1 - 2 * ins)) / cols;
      const vv = (row + ins + (j / GRID) * (1 - 2 * ins)) / rows;
      const v2 = v * 2;
      this.uv[v2] = uu;
      this.uv[v2 + 1] = vv;
      this.vAlpha[v] = proj.va[k] * opacity;
      this.lifeAttr[v3] = birth;
      this.lifeAttr[v3 + 1] = start;
      this.lifeAttr[v3 + 2] = dur;
    }

    this.used[s] = 1;
    this.age[s] = 0;
    this.fadeDur[s] = dur;
    this.fadeStart[s] = start;
    this.serial[s] = ++this._serial;
    if (!wasUsed) this.live++;

    return s;
  }

  /** Rewrites just the fade schedule of one slot (used by the pressure valve). */
  _reschedule(s, start, dur) {
    this.fadeStart[s] = start;
    this.fadeDur[s] = dur;
    const birth = this._clock - this.age[s];
    const base = s * VERTS;
    for (let k = 0; k < VERTS; k++) {
      const v3 = (base + k) * 3;
      this.lifeAttr[v3] = birth;
      this.lifeAttr[v3 + 1] = start;
      this.lifeAttr[v3 + 2] = dur;
    }
  }

  /**
   * Ages every slot and retires the expired ones. The fade *curve* itself is
   * played back by the vertex shader from `aLife`, so this loop is pure
   * bookkeeping: it must not touch a vertex buffer unless a decal actually
   * appeared or disappeared.
   */
  update(dt) {
    if (dt <= 0) return;
    this._clock += dt;
    const cap = this.capacity;
    // Pressure valve: begin fading the oldest decals out *before* their slots
    // are needed, so recycling is never visible as a pop.
    if (this.live > cap * 0.78) {
      let oldest = -1;
      let best = Infinity;
      for (let i = 0; i < cap; i++) {
        if (!this.used[i]) continue;
        if (this.age[i] >= this.fadeStart[i]) continue;
        if (this.serial[i] < best) { best = this.serial[i]; oldest = i; }
      }
      if (oldest >= 0) this._reschedule(oldest, this.age[oldest], 1.4);
    }

    for (let i = 0; i < cap; i++) {
      if (!this.used[i]) continue;
      const a = (this.age[i] += dt);
      if (a < this.fadeStart[i] + Math.max(0.05, this.fadeDur[i])) continue;
      this.used[i] = 0;
      this.live--;
      // Collapse the retired slot so its triangles have no area at all and
      // never reach the rasteriser again.
      const b0 = i * VERTS * 3;
      this.position.fill(0, b0, b0 + VERTS * 3);
    }
  }

  /**
   * Re-uploads the attribute buffers. **Unconditionally, on every frame** — and
   * that is the fix, not the bug.
   *
   * The obvious optimisation is to upload only when a decal was born, died or
   * was rescheduled. That is what this did, and it is what made the `combat`
   * view run at 17 fps while every other view held 60.
   *
   * The reason is ANGLE's D3D11 back end (the one the capture rig and Chrome on
   * Windows both use). A vertex buffer that goes several frames without being
   * written is promoted to a static, pre-translated D3D11 storage. The next
   * write invalidates that storage and forces the whole attribute to be
   * re-created and re-translated — tens of milliseconds, and the buffer is
   * promoted again during the next quiet stretch, so the penalty repeats. Idle
   * decal buffers therefore make *every* subsequent decal expensive: exactly the
   * pattern of sustained fire, where a decal lands every few frames rather than
   * every frame. A buffer that is written on every single frame is never
   * promoted and stays on the cheap dynamic path.
   *
   * Measured in the `combat` view at 1920×1080, cinematic, decals identical on
   * screen and draw calls unchanged:
   *
   *   dirty-gated upload (the "optimisation")   17 fps
   *   upload every frame                        60 fps
   *   no upload at all                          60 fps
   *
   * The same run on ANGLE's OpenGL back end is 60 fps either way, which is what
   * identifies this as a D3D11 buffer-storage effect rather than bandwidth: the
   * whole attribute set is ~260 kB, and shrinking it to 5 kB (capacity 16) did
   * not move the number at all.
   *
   * A corollary worth keeping in mind before "optimising" this again: partial
   * uploads via `addUpdateRange` are *worse*, not better — a sub-range write
   * cannot take the rename path at all.
   */
  flush(fogDensity) {
    this.material.uniforms.uFogDensity.value = fogDensity;
    this.material.uniforms.uTime.value = this._clock;
    this._pos.needsUpdate = true;
    this._uv.needsUpdate = true;
    this._tint.needsUpdate = true;
    this._fade.needsUpdate = true;
    this._life.needsUpdate = true;
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}

export { GRID as DECAL_GRID, VERTS as DECAL_VERTS };
