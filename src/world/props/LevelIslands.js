import * as THREE from 'three';

/**
 * ISLAND CLUSTERING for the world float audit. OWNER: props agent.
 *
 * Split out of LevelFloat.js when that file crossed 700 lines; the reasoning for
 * the audit itself lives there and should be read first.
 *
 * WHAT AN ISLAND IS
 *   A connected component of world geometry. Every triangle is walked in world
 *   space and its three vertices are dropped into a 14 cm cell grid; a triangle
 *   welds its own cells together, and union-find then merges everything that
 *   shares a cell. Two pieces whose vertices come within ~2 x CELL are therefore
 *   one object, and a piece with nothing near it is its own island with a
 *   measurable gap around it.
 *
 * THE ONE PROPERTY THAT MATTERS
 *   A cluster's extent is accumulated from the WHOLE triangle, not from the cell
 *   the triangle happened to be keyed on. That is what makes a 40 m wall come out
 *   as one enormous island — correctly identified as structure — instead of as
 *   three hundred small ones that each look like a floating panel.
 *
 * KNOWN LIMIT, and why the audit does not rely on this alone: vertex welding
 *   UNDER-connects. A bolt touching the middle of a 20 m handrail shares no cell
 *   with either of the rail's end vertices, so the two come out separate even
 *   though they are in contact. The audit therefore never treats "separate
 *   island" as "floating" — it measures the real surface gap afterwards.
 */

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();

/**
 * @param {THREE.Mesh[]} meshes world meshes to walk
 * @param {object} o
 * @param {number} o.cell        weld cell size, metres
 * @param {number} o.yMin        ignore triangles wholly below this
 * @param {number} o.yMax        ignore triangles wholly above this
 * @param {number} o.xzLimit     ignore triangles wholly outside this XZ box
 * @param {Set<THREE.Object3D>} o.inProbe meshes present in the probe's BVH
 * @param {(m:THREE.Mesh)=>string} o.surfaceOf surface family of a mesh
 * @param {boolean} [o.collectPoints] keep triangle centroids for PCA consumers
 * @returns {{roots: Map<number, object>, triangles: number}}
 */
export function clusterIslands(meshes, {
  cell, yMin, yMax, xzLimit, inProbe, surfaceOf, collectPoints = false,
}) {
  const ids = new Map();
  const parent = [];
  const bmin = [];      // 3 per id
  const bmax = [];      // 3 per id
  const tris = [];
  const sol = [];       // 1 if any collider triangle landed here
  const fab = [];       // 1 if any fabric-surface triangle landed here
  /*
   * First contributing mesh per cell. An island needs to know which meshes it is
   * made of so a raycast can tell a SELF-hit from a hit on something else: a ray
   * leaving one end of a 2 m panel and travelling along it strikes the panel's own
   * far end at a perfectly plausible 6 cm. Storing one index per cell rather than
   * a set keeps this to a single array — a cluster comes from one to three meshes
   * in practice, and the fold below collects all of them.
   */
  const first = [];
  const pts = collectPoints ? [] : null;
  let n = 0;

  // Cells are keyed by a single integer so the Map stays fast at 300k entries.
  const idOf = (ix, iy, iz) => {
    const key = (ix + 1024) + (iy + 256) * 4096 + (iz + 1024) * 4096 * 1024;
    let id = ids.get(key);
    if (id === undefined) {
      id = n++;
      ids.set(key, id);
      parent.push(id);
      bmin.push(Infinity, Infinity, Infinity);
      bmax.push(-Infinity, -Infinity, -Infinity);
      tris.push(0);
      sol.push(0);
      fab.push(0);
      first.push(-1);
      if (pts) pts.push(null);
    }
    return id;
  };
  const find = (a) => {
    let r = a;
    while (parent[r] !== r) r = parent[r];
    while (parent[a] !== r) { const nx = parent[a]; parent[a] = r; a = nx; }
    return r;
  };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[rb] = ra; };

  const key3 = [0, 0, 0];
  let triTotal = 0;
  for (let mi = 0; mi < meshes.length; mi++) {
    const mesh = meshes[mi];
    mesh.updateMatrixWorld(true);
    // Is this mesh in the probe's BVH? That decides which isolation test the
    // cluster is entitled to — see LevelFloatPass._gap().
    const inBVH = inProbe.has(mesh) ? 1 : 0;
    const isFabric = surfaceOf(mesh) === 'fabric' ? 1 : 0;
    const geo = mesh.geometry;
    const pos = geo.attributes.position;
    const idx = geo.index;
    const count = idx ? idx.count : pos.count;
    const m = mesh.matrixWorld;
    for (let f = 0; f + 2 < count; f += 3) {
      // three world vertices
      for (let k = 0; k < 3; k++) {
        const vi = idx ? idx.getX(f + k) : f + k;
        const v = k === 0 ? _a : k === 1 ? _b : _c;
        v.fromBufferAttribute(pos, vi).applyMatrix4(m);
      }
      const loY = Math.min(_a.y, _b.y, _c.y);
      const hiY = Math.max(_a.y, _b.y, _c.y);
      if (hiY < yMin || loY > yMax) continue;
      const loX = Math.min(_a.x, _b.x, _c.x), hiX = Math.max(_a.x, _b.x, _c.x);
      const loZ = Math.min(_a.z, _b.z, _c.z), hiZ = Math.max(_a.z, _b.z, _c.z);
      if (loX > xzLimit || hiX < -xzLimit || loZ > xzLimit || hiZ < -xzLimit) continue;
      triTotal++;

      // one cell per vertex; the triangle welds them together
      let nk = 0;
      for (let k = 0; k < 3; k++) {
        const v = k === 0 ? _a : k === 1 ? _b : _c;
        const id = idOf(
          Math.floor(v.x / cell), Math.floor(v.y / cell), Math.floor(v.z / cell),
        );
        let dup = false;
        for (let j = 0; j < nk; j++) if (key3[j] === id) { dup = true; break; }
        if (!dup) key3[nk++] = id;
      }
      const root = key3[0];
      for (let j = 1; j < nk; j++) union(root, key3[j]);

      // the WHOLE triangle's extent belongs to the cluster, so one big quad
      // makes one big cluster and can never be mistaken for a loose panel
      const i3 = root * 3;
      if (loX < bmin[i3]) bmin[i3] = loX;
      if (loY < bmin[i3 + 1]) bmin[i3 + 1] = loY;
      if (loZ < bmin[i3 + 2]) bmin[i3 + 2] = loZ;
      if (hiX > bmax[i3]) bmax[i3] = hiX;
      if (hiY > bmax[i3 + 1]) bmax[i3 + 1] = hiY;
      if (hiZ > bmax[i3 + 2]) bmax[i3 + 2] = hiZ;
      tris[root]++;
      sol[root] |= inBVH;
      fab[root] |= isFabric;
      if (first[root] < 0) first[root] = mi;
      if (pts) {
        let list = pts[root];
        if (!list) { list = []; pts[root] = list; }
        if (list.length < 1800) {
          list.push((_a.x + _b.x + _c.x) / 3, (_a.y + _b.y + _c.y) / 3, (_a.z + _b.z + _c.z) / 3);
        }
      }
    }
  }

  // fold every cell onto its root
  const roots = new Map();
  for (let i = 0; i < n; i++) {
    if (tris[i] === 0 && bmin[i * 3] === Infinity) continue;
    const r = find(i);
    let c = roots.get(r);
    if (!c) {
      c = {
        root: r, tris: 0, inBVH: 0, fabric: 0, pts: pts ? [] : null, meshes: new Set(),
        min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity],
      };
      roots.set(r, c);
    }
    const i3 = i * 3;
    for (let k = 0; k < 3; k++) {
      if (bmin[i3 + k] < c.min[k]) c.min[k] = bmin[i3 + k];
      if (bmax[i3 + k] > c.max[k]) c.max[k] = bmax[i3 + k];
    }
    c.tris += tris[i];
    c.inBVH |= sol[i];
    c.fabric |= fab[i];
    if (first[i] >= 0 && c.meshes.size < 8) c.meshes.add(meshes[first[i]]);
    if (pts && pts[i]) for (let k = 0; k < pts[i].length; k++) c.pts.push(pts[i][k]);
  }
  // roots whose cells only ever received unions carry no extent — drop them
  for (const [k, c] of roots) if (c.min[0] === Infinity) roots.delete(k);

  return { roots, triangles: triTotal };
}
