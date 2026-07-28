import * as THREE from 'three';
import { mergeAll, triCount } from './GeoUtil.js';

/**
 * Draw-call budget management for the prop library. OWNER: props agent.
 *
 * Two batching strategies, both resolved at build time:
 *   proto()/add()  — an InstancedMesh per (geometry variant, material). Anything
 *                    that repeats (crates, drums, sandbags, bolts, planks) goes
 *                    here; 400 sandbags cost one draw call.
 *   merge()        — unique world-space geometry accumulated into a single
 *                    buffer per material. Cable runs, pipe routes and signage
 *                    are all one-offs, so instancing cannot help; merging can.
 *
 * The whole prop set targets well under 100 draw calls in the hero view.
 */

const MAX_MERGE_TRIS = 120000;
const _c = new THREE.Color();

export class Batcher {
  constructor(scene, level) {
    this.scene = scene;
    this.level = level;
    this._protos = new Map();
    this._merges = new Map();
    /** @type {Map<string, THREE.InstancedMesh>} */
    this.instanced = new Map();
    /** @type {THREE.Object3D[]} */
    this.built = [];
    this.stats = { instancedMeshes: 0, mergedMeshes: 0, instances: 0, triangles: 0 };
  }

  /**
   * Declare an instanced prototype.
   * @param {string} key unique id
   * @param {THREE.BufferGeometry} geometry local-space, seated so y=0 is the base
   * @param {THREE.Material} material
   */
  proto(key, geometry, material, {
    castShadow = true, receiveShadow = true, solid = false, tint = 0.0,
  } = {}) {
    if (this._protos.has(key)) return this._protos.get(key);
    const p = {
      key, geometry, material, castShadow, receiveShadow, solid, tint,
      matrices: [], colours: [], flags: [],
    };
    this._protos.set(key, p);
    return p;
  }

  has(key) { return this._protos.has(key); }

  /**
   * Read-only view of every declared prototype and its queued transforms.
   *
   * The ground-dressing pass needs to know where things actually ended up —
   * after the contact pass has re-seated them — so it can drop a contact patch
   * under each piece of litter that is too small to be worth a shadow-cascade
   * draw call of its own. Iterating the queue is the only way to get that, and
   * it must happen before build() packs the matrices into GPU buffers.
   */
  protos() { return this._protos.values(); }

  /**
   * Queue one instance. `matrix` is copied; `tintScale` multiplies albedo.
   * `flags` is an opaque bitfield carried through to the post-placement passes —
   * see Contact.js GROUND, which marks the transforms that must be verified
   * against the world before they are baked into a buffer.
   */
  add(key, matrix, tintScale = 1, tintHue = null, flags = 0) {
    const p = this._protos.get(key);
    if (!p) throw new Error(`[props] unknown instance proto "${key}"`);
    p.matrices.push(matrix.clone());
    if (tintHue) p.colours.push(tintHue.clone());
    else p.colours.push(_c.setScalar(tintScale).clone());
    p.flags.push(flags);
    return p.matrices.length - 1;
  }

  /**
   * Rewrite or reject queued instances before they are resolved to GPU buffers.
   *
   * `fn(key, geometry, matrix, flags)` may mutate `matrix` in place and returns
   * false to delete the instance. This is the only sanctioned way to correct a
   * transform after the dressing passes have run — once build() has packed the
   * InstancedMesh, per-instance edits mean touching GPU buffers, and rejecting
   * an instance means renumbering the whole batch.
   *
   * @returns {{visited:number, dropped:number}}
   */
  remap(fn) {
    let visited = 0, dropped = 0;
    for (const p of this._protos.values()) {
      let w = 0;
      for (let i = 0; i < p.matrices.length; i++) {
        visited++;
        if (fn(p.key, p.geometry, p.matrices[i], p.flags[i] ?? 0)) {
          if (w !== i) {
            p.matrices[w] = p.matrices[i];
            p.colours[w] = p.colours[i];
            p.flags[w] = p.flags[i];
          }
          w++;
        } else {
          dropped++;
        }
      }
      p.matrices.length = w;
      p.colours.length = w;
      p.flags.length = w;
    }
    return { visited, dropped };
  }

  /**
   * Rewrite or reject queued MERGED geometry before it is welded into a buffer.
   *
   * The instance passes cannot see any of this: a pipe run, a conduit drop, a
   * cable span and a sign quad are unique world-space buffers, not instances, so
   * they never reach `remap`. The float sweep needs a seam that does reach them,
   * and once `build()` has welded a chunk there is no per-piece identity left to
   * delete. `fn(matKey, geometry)` returns false to drop the piece.
   *
   * @returns {{visited:number, dropped:number}}
   */
  remapMerges(fn) {
    let visited = 0, dropped = 0;
    for (const [key, b] of this._merges) {
      for (let ci = 0; ci < b.chunks.length; ci++) {
        const list = b.chunks[ci];
        let w = 0;
        for (let i = 0; i < list.length; i++) {
          visited++;
          if (fn(key, list[i])) {
            if (w !== i) list[w] = list[i];
            w++;
          } else {
            b.tris[ci] -= triCount(list[i]);
            list[i].dispose();
            dropped++;
          }
        }
        list.length = w;
      }
    }
    return { visited, dropped };
  }

  /**
   * Queue unique geometry (already in world space) into a merged batch.
   * @param {string} matKey batch id, normally the material name
   */
  merge(matKey, geometry, material, { castShadow = true, receiveShadow = true, solid = false } = {}) {
    let b = this._merges.get(matKey);
    if (!b) {
      b = { material, castShadow, receiveShadow, solid, chunks: [[]], tris: [0] };
      this._merges.set(matKey, b);
    }
    const t = triCount(geometry);
    let i = b.chunks.length - 1;
    if (b.tris[i] + t > MAX_MERGE_TRIS) { b.chunks.push([]); b.tris.push(0); i++; }
    b.chunks[i].push(geometry);
    b.tris[i] += t;
  }

  _place(mesh, solid) {
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    if (solid && this.level?.addCollider) this.level.addCollider(mesh);
    else this.scene.add(mesh);
    this.built.push(mesh);
  }

  build() {
    for (const p of this._protos.values()) {
      const n = p.matrices.length;
      if (n === 0) { p.geometry.dispose(); continue; }
      const im = new THREE.InstancedMesh(p.geometry, p.material, n);
      im.name = `prop:${p.key}`;
      im.castShadow = p.castShadow;
      im.receiveShadow = p.receiveShadow;
      let tinted = false;
      for (let i = 0; i < n; i++) {
        im.setMatrixAt(i, p.matrices[i]);
        const c = p.colours[i];
        if (c && (c.r !== 1 || c.g !== 1 || c.b !== 1)) tinted = true;
        im.setColorAt(i, c ?? _c.setScalar(1));
      }
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
      if (!tinted && im.instanceColor) { im.instanceColor = null; }
      im.computeBoundingBox();
      im.computeBoundingSphere();
      this.instanced.set(p.key, im);
      this._place(im, p.solid);
      this.stats.instancedMeshes++;
      this.stats.instances += n;
      this.stats.triangles += triCount(p.geometry) * n;
      p.matrices.length = 0;
      p.colours.length = 0;
      p.flags.length = 0;
    }

    for (const [key, b] of this._merges) {
      b.chunks.forEach((list, ci) => {
        if (!list.length) return;
        const geo = mergeAll(list);
        const mesh = new THREE.Mesh(geo, b.material);
        mesh.name = `prop:${key}${ci ? `#${ci}` : ''}`;
        mesh.castShadow = b.castShadow;
        mesh.receiveShadow = b.receiveShadow;
        this._place(mesh, b.solid);
        this.stats.mergedMeshes++;
        this.stats.triangles += triCount(geo);
      });
    }
    this._merges.clear();
    return this.stats;
  }

  dispose() {
    for (const o of this.built) {
      o.parent?.remove(o);
      o.geometry?.dispose();
      if (o.dispose) o.dispose();
    }
    this.built.length = 0;
    this.instanced.clear();
  }
}
