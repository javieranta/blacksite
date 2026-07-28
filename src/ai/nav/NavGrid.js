import * as THREE from 'three';
import { AI } from '../AIConfig.js';

/**
 * OWNER: ai agent.
 *
 * Navigation representation built by *sampling the level itself* — no authored
 * navmesh, nothing for the level agent to keep in sync. Downward BVH raycasts on
 * a lattice find every walkable surface in each column (up to three, so the
 * three-storey admin block, the 4.7 m pipe gantry and the ground under a roof
 * all get their own node), then:
 *
 *   - walkability = ground normal + head clearance to the surface above
 *   - connectivity = 8-way, no corner cutting, step limit between cells
 *   - reachability = flood fill from the spawn set, which prunes rooftops and
 *     tank tops that look walkable but nothing can get to
 *   - cover = per-node 8-direction bitmasks derived from neighbouring column
 *     heights, so cover scoring costs no raycasts at runtime
 *
 * A* runs on preallocated typed arrays with a generation stamp instead of a
 * clear, and paths are string-pulled against the same grid before use.
 */

const LAYERS = 3;
const DIRS = [
  [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1],
];
/** Precomputed heading of each of the 8 links — protection() is a hot loop. */
const DIR_COS = new Float32Array(8);
const DIR_SIN = new Float32Array(8);
for (let d = 0; d < 8; d++) {
  const l = Math.hypot(DIRS[d][0], DIRS[d][1]);
  DIR_COS[d] = DIRS[d][0] / l;
  DIR_SIN[d] = DIRS[d][1] / l;
}
const _v = new THREE.Vector3();
const _o = new THREE.Vector3();
const _d = new THREE.Vector3(0, -1, 0);
const _box = new THREE.Box3();

/**
 * Column sampler. level.raycast() walks every collider mesh in the scene, which
 * is the right trade for a handful of bullets but not for the ~9000 probes a nav
 * bake needs — that measured 2.9 s. Bucketing the collider meshes into a coarse
 * XZ grid first means a column only tests the two or three merged meshes that
 * actually overlap it, and each of those already carries a BVH.
 */
class ColumnSampler {
  constructor(level, bounds) {
    this.ray = new THREE.Raycaster();
    this.ray.firstHitOnly = true;
    this.cell = 8;
    this.x0 = bounds.min.x; this.z0 = bounds.min.z;
    this.nx = Math.ceil((bounds.max.x - this.x0) / this.cell) + 1;
    this.nz = Math.ceil((bounds.max.z - this.z0) / this.cell) + 1;
    this.buckets = new Array(this.nx * this.nz);
    let meshes = 0;
    let bvhBuilt = 0;
    level.colliders.updateMatrixWorld(true);
    level.colliders.traverse((o) => {
      if (!o.isMesh || !o.geometry) return;
      meshes++;
      const g = o.geometry;
      // Any collider without an acceleration structure costs a brute-force
      // triangle sweep on every probe — which is where a nav bake goes to die.
      // Level already installs three-mesh-bvh on the prototype; use it.
      const tris = (g.index ? g.index.count : g.attributes.position.count) / 3;
      if (!g.boundsTree && tris > 2000 && typeof g.computeBoundsTree === 'function') {
        g.computeBoundsTree({ maxLeafTris: 12 });
        bvhBuilt++;
      }
      if (!g.boundingBox) g.computeBoundingBox();
      _box.copy(g.boundingBox).applyMatrix4(o.matrixWorld);
      const ix0 = Math.max(0, Math.floor((_box.min.x - this.x0) / this.cell));
      const ix1 = Math.min(this.nx - 1, Math.floor((_box.max.x - this.x0) / this.cell));
      const iz0 = Math.max(0, Math.floor((_box.min.z - this.z0) / this.cell));
      const iz1 = Math.min(this.nz - 1, Math.floor((_box.max.z - this.z0) / this.cell));
      for (let iz = iz0; iz <= iz1; iz++) {
        for (let ix = ix0; ix <= ix1; ix++) {
          const k = iz * this.nx + ix;
          (this.buckets[k] || (this.buckets[k] = [])).push(o);
        }
      }
    });
    this.meshes = meshes;
    this.bvhBuilt = bvhBuilt;
    this.empty = [];
  }

  at(x, z) {
    const ix = Math.floor((x - this.x0) / this.cell);
    const iz = Math.floor((z - this.z0) / this.cell);
    if (ix < 0 || iz < 0 || ix >= this.nx || iz >= this.nz) return this.empty;
    return this.buckets[iz * this.nx + ix] || this.empty;
  }

  /** Nearest downward hit below `fromY`. Returns [y, normalY] or null. */
  drop(x, fromY, z, far, list) {
    if (!list.length) return null;
    _o.set(x, fromY, z);
    this.ray.set(_o, _d);
    this.ray.near = 0;
    this.ray.far = far;
    const hits = this.ray.intersectObjects(list, false);
    if (!hits.length) return null;
    let h = hits[0];
    for (let i = 1; i < hits.length; i++) if (hits[i].distance < h.distance) h = hits[i];
    let ny = 1;
    if (h.face) {
      _v.copy(h.face.normal).transformDirection(h.object.matrixWorld).normalize();
      ny = Math.abs(_v.y);
    }
    return [h.point.y, ny];
  }
}

export class NavGrid {
  constructor() {
    this.ready = false;
    this.cell = AI.navCell;
  }

  build(level, spawnHints = []) {
    const t0 = performance.now();
    const b = level.bounds;
    const cell = this.cell;
    this.x0 = Math.floor(b.min.x / cell) * cell;
    this.z0 = Math.floor(b.min.z / cell) * cell;
    this.nx = Math.ceil((b.max.x - this.x0) / cell);
    this.nz = Math.ceil((b.max.z - this.z0) / cell);
    const N = this.nx * this.nz * LAYERS;

    this.height = new Float32Array(N).fill(NaN);
    this.flags = new Uint8Array(N);         // 1 walk, 2 reachable
    this.coverLow = new Uint8Array(N);
    this.coverHigh = new Uint8Array(N);
    this.count = N;

    const tSampler = performance.now();
    const sampler = new ColumnSampler(level, b);
    const msSampler = Math.round(performance.now() - tSampler);
    const tProbe = performance.now();
    let rays = 0;
    // Start below the stack and the tank tops: nothing walks up there, and a
    // shorter probe touches far fewer BVH nodes.
    const top = Math.min(b.max.y + 2, 13.5);
    for (let iz = 0; iz < this.nz; iz++) {
      for (let ix = 0; ix < this.nx; ix++) {
        const x = this.x0 + (ix + 0.5) * cell;
        const z = this.z0 + (iz + 0.5) * cell;
        const list = sampler.at(x, z);
        let from = top;
        for (let l = 0; l < LAYERS; l++) {
          const hit = sampler.drop(x, from, z, from - b.min.y + 4, list);
          rays++;
          if (!hit) break;
          const i = (iz * this.nx + ix) * LAYERS + l;
          this.height[i] = hit[0];
          // Slope test now; clearance needs the layer above, so it is a second pass.
          if (hit[1] >= AI.navSlope) this.flags[i] = 1;
          from = hit[0] - 0.30;
          if (from < b.min.y) break;
          // Deeper layers only matter under something — a roof, a deck, a
          // canopy. On open ground the first hit is the floor, so stop.
          if (l === 0 && hit[0] < 1.6) break;
        }
      }
    }
    this.navMeshes = sampler.meshes;
    const msProbe = Math.round(performance.now() - tProbe);

    // Head clearance: layer l is capped by layer l-1 in the same column.
    for (let c = 0; c < this.nx * this.nz; c++) {
      for (let l = 0; l < LAYERS; l++) {
        const i = c * LAYERS + l;
        if (!this.flags[i]) continue;
        if (l > 0) {
          const above = this.height[c * LAYERS + (l - 1)];
          if (!Number.isNaN(above) && above - this.height[i] < AI.navClearance) this.flags[i] = 0;
        }
      }
    }

    this._buildCover();
    const reached = this._flood(spawnHints);

    // A* working set.
    this.g = new Float32Array(N);
    this.f = new Float32Array(N);
    this.from = new Int32Array(N);
    this.stamp = new Int32Array(N);
    this.closed = new Uint8Array(N);
    this.gen = 0;
    this.heapKey = new Float32Array(N + 1);
    this.heapVal = new Int32Array(N + 1);
    this.heapLen = 0;

    // Cover candidate index.
    const cov = [];
    for (let i = 0; i < N; i++) if ((this.flags[i] & 3) === 3 && (this.coverLow[i] || this.coverHigh[i])) cov.push(i);
    this.coverNodes = Int32Array.from(cov);
    this._buildCoverIndex();

    this.ready = true;
    this.stats = {
      cells: this.nx * this.nz, nodes: N, rays,
      meshes: sampler.meshes, bvhBuilt: sampler.bvhBuilt,
      msSampler, msProbe,
      walkable: this.flags.reduce((a, v) => a + (v & 1), 0),
      reachable: reached,
      cover: this.coverNodes.length,
      ms: Math.round(performance.now() - t0),
    };
    return this.stats;
  }

  _buildCover() {
    const { nx, nz } = this;
    for (let iz = 0; iz < nz; iz++) {
      for (let ix = 0; ix < nx; ix++) {
        for (let l = 0; l < LAYERS; l++) {
          const i = (iz * nx + ix) * LAYERS + l;
          if (!this.flags[i]) continue;
          const y = this.height[i];
          let low = 0, high = 0;
          for (let d = 0; d < 8; d++) {
            const jx = ix + DIRS[d][0], jz = iz + DIRS[d][1];
            if (jx < 0 || jz < 0 || jx >= nx || jz >= nz) { low |= 1 << d; high |= 1 << d; continue; }
            // The tallest surface in the neighbouring column that is above us.
            let tall = -Infinity;
            for (let k = 0; k < LAYERS; k++) {
              const h = this.height[(jz * nx + jx) * LAYERS + k];
              if (!Number.isNaN(h) && h > y + 0.20 && h > tall) tall = h;
            }
            const rise = tall - y;
            if (rise >= 0.70) low |= 1 << d;
            if (rise >= 1.45) high |= 1 << d;
          }
          this.coverLow[i] = low;
          this.coverHigh[i] = high;
        }
      }
    }
  }

  /** Breadth-first reachability from the spawn set; prunes unreachable islands. */
  _flood(hints) {
    const queue = new Int32Array(this.count);
    let head = 0, tail = 0;
    for (const p of hints) {
      const n = this.nodeAt(p.x, p.y, p.z, 3.0);
      if (n >= 0 && !(this.flags[n] & 2)) { this.flags[n] |= 2; queue[tail++] = n; }
    }
    while (head < tail) {
      const n = queue[head++];
      for (let d = 0; d < 8; d++) {
        const m = this.neighbour(n, d);
        if (m < 0 || (this.flags[m] & 2)) continue;
        this.flags[m] |= 2;
        queue[tail++] = m;
      }
    }
    return tail;
  }

  /* ------------------------------------------------------------- topology -- */

  ix(node) { return ((node / LAYERS) | 0) % this.nx; }
  iz(node) { return (((node / LAYERS) | 0) / this.nx) | 0; }
  wx(node) { return this.x0 + (this.ix(node) + 0.5) * this.cell; }
  wz(node) { return this.z0 + (this.iz(node) + 0.5) * this.cell; }
  wy(node) { return this.height[node]; }

  worldOf(node, out) { return out.set(this.wx(node), this.height[node], this.wz(node)); }
  usable(node) { return node >= 0 && (this.flags[node] & 3) === 3; }

  /** The walkable node whose surface is closest to y in this column. */
  nodeAt(x, y, z, tol = 2.2) {
    const ix = Math.floor((x - this.x0) / this.cell);
    const iz = Math.floor((z - this.z0) / this.cell);
    if (ix < 0 || iz < 0 || ix >= this.nx || iz >= this.nz) return -1;
    const c = (iz * this.nx + ix) * LAYERS;
    let best = -1, bestD = tol;
    for (let l = 0; l < LAYERS; l++) {
      if (!(this.flags[c + l] & 1)) continue;
      const d = Math.abs(this.height[c + l] - y);
      if (d < bestD) { bestD = d; best = c + l; }
    }
    return best;
  }

  /** Nearest usable node, spiralling out — for spawn snapping and goal repair. */
  nearest(x, y, z, maxRings = 8) {
    let n = this.nodeAt(x, y, z, 2.6);
    if (this.usable(n)) return n;
    const ix0 = Math.floor((x - this.x0) / this.cell);
    const iz0 = Math.floor((z - this.z0) / this.cell);
    for (let r = 1; r <= maxRings; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const ix = ix0 + dx, iz = iz0 + dz;
          if (ix < 0 || iz < 0 || ix >= this.nx || iz >= this.nz) continue;
          const c = (iz * this.nx + ix) * LAYERS;
          for (let l = 0; l < LAYERS; l++) {
            if ((this.flags[c + l] & 3) === 3 && Math.abs(this.height[c + l] - y) < 3.4) return c + l;
          }
        }
      }
    }
    return -1;
  }

  neighbour(node, d) {
    const ix = this.ix(node) + DIRS[d][0];
    const iz = this.iz(node) + DIRS[d][1];
    if (ix < 0 || iz < 0 || ix >= this.nx || iz >= this.nz) return -1;
    const y = this.height[node];
    const c = (iz * this.nx + ix) * LAYERS;
    let best = -1, bestD = AI.navStep;
    for (let l = 0; l < LAYERS; l++) {
      if (!(this.flags[c + l] & 1)) continue;
      const dy = Math.abs(this.height[c + l] - y);
      if (dy < bestD) { bestD = dy; best = c + l; }
    }
    if (best < 0) return -1;
    // No cutting diagonal corners through a wall.
    if (DIRS[d][0] && DIRS[d][1]) {
      const a = this._orth(node, DIRS[d][0], 0, y);
      const b = this._orth(node, 0, DIRS[d][1], y);
      if (a < 0 || b < 0) return -1;
    }
    return best;
  }

  _orth(node, dx, dz, y) {
    const ix = this.ix(node) + dx, iz = this.iz(node) + dz;
    if (ix < 0 || iz < 0 || ix >= this.nx || iz >= this.nz) return -1;
    const c = (iz * this.nx + ix) * LAYERS;
    for (let l = 0; l < LAYERS; l++) {
      if ((this.flags[c + l] & 1) && Math.abs(this.height[c + l] - y) < AI.navStep) return c + l;
    }
    return -1;
  }

  /* ------------------------------------------------------------------- A* -- */

  _push(key, val) {
    let i = ++this.heapLen;
    this.heapKey[i] = key; this.heapVal[i] = val;
    while (i > 1) {
      const p = i >> 1;
      if (this.heapKey[p] <= this.heapKey[i]) break;
      const tk = this.heapKey[p], tv = this.heapVal[p];
      this.heapKey[p] = this.heapKey[i]; this.heapVal[p] = this.heapVal[i];
      this.heapKey[i] = tk; this.heapVal[i] = tv;
      i = p;
    }
  }

  _pop() {
    const out = this.heapVal[1];
    this.heapKey[1] = this.heapKey[this.heapLen];
    this.heapVal[1] = this.heapVal[this.heapLen--];
    let i = 1;
    for (;;) {
      const l = i << 1, r = l + 1;
      let m = i;
      if (l <= this.heapLen && this.heapKey[l] < this.heapKey[m]) m = l;
      if (r <= this.heapLen && this.heapKey[r] < this.heapKey[m]) m = r;
      if (m === i) break;
      const tk = this.heapKey[m], tv = this.heapVal[m];
      this.heapKey[m] = this.heapKey[i]; this.heapVal[m] = this.heapVal[i];
      this.heapKey[i] = tk; this.heapVal[i] = tv;
      i = m;
    }
    return out;
  }

  _h(a, b) {
    const dx = Math.abs(this.ix(a) - this.ix(b));
    const dz = Math.abs(this.iz(a) - this.iz(b));
    const dy = Math.abs(this.height[a] - this.height[b]) / this.cell;
    const mn = Math.min(dx, dz), mx = Math.max(dx, dz);
    return (mx - mn + mn * 1.4142 + dy * 1.2) * this.cell;
  }

  /**
   * A* between two world points. Writes waypoints into `out` (an array of
   * reusable Vector3) and returns how many are valid. 0 means no path.
   */
  findPath(start, goal, out, maxOut = 24) {
    if (!this.ready) return 0;
    const s = this.nearest(start.x, start.y, start.z);
    let g = this.nearest(goal.x, goal.y, goal.z);
    if (s < 0 || g < 0) return 0;
    if (s === g) {
      out[0].set(goal.x, this.height[g], goal.z);
      return 1;
    }

    const gen = ++this.gen;
    this.heapLen = 0;
    this.stamp[s] = gen; this.g[s] = 0; this.from[s] = -1; this.closed[s] = 0;
    this._push(this._h(s, g), s);
    let found = false;
    let expanded = 0;
    const budget = AI.pathBudget;

    while (this.heapLen > 0 && expanded < budget) {
      const n = this._pop();
      if (this.closed[n] === 1 && this.stamp[n] === gen) continue;
      this.closed[n] = 1;
      if (n === g) { found = true; break; }
      expanded++;
      const gn = this.g[n];
      for (let d = 0; d < 8; d++) {
        const m = this.neighbour(n, d);
        if (m < 0 || (this.flags[m] & 2) === 0) continue;
        if (this.stamp[m] === gen && this.closed[m] === 1) continue;
        const step = (DIRS[d][0] && DIRS[d][1]) ? this.cell * 1.4142 : this.cell;
        const climb = Math.abs(this.height[m] - this.height[n]) * 2.2;
        const ng = gn + step + climb;
        if (this.stamp[m] !== gen || ng < this.g[m]) {
          this.stamp[m] = gen;
          this.g[m] = ng;
          this.from[m] = n;
          this.closed[m] = 0;
          this._push(ng + this._h(m, g), m);
        }
      }
    }
    if (!found) return 0;

    // Walk back, then string-pull in forward order.
    const raw = this._raw || (this._raw = new Int32Array(4096));
    let n = g, len = 0;
    while (n >= 0 && len < raw.length) { raw[len++] = n; n = this.from[n]; }
    // reverse in place
    for (let i = 0, j = len - 1; i < j; i++, j--) { const t = raw[i]; raw[i] = raw[j]; raw[j] = t; }

    let count = 0;
    let anchor = 0;
    for (let i = 1; i < len && count < maxOut - 1; i++) {
      if (i === len - 1) break;
      if (!this.lineClear(raw[anchor], raw[i + 1])) {
        this.worldOf(raw[i], out[count++]);
        anchor = i;
      }
    }
    out[count].set(goal.x, this.height[g], goal.z);
    count++;
    return count;
  }

  /** Can an agent walk the straight line between two nodes? */
  lineClear(a, b) {
    const ax = this.wx(a), az = this.wz(a), ay = this.height[a];
    const bx = this.wx(b), bz = this.wz(b), by = this.height[b];
    const dist = Math.hypot(bx - ax, bz - az);
    const steps = Math.max(2, Math.ceil(dist / (this.cell * 0.5)));
    let prevY = ay;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const x = ax + (bx - ax) * t, z = az + (bz - az) * t;
      const y = ay + (by - ay) * t;
      const n = this.nodeAt(x, y, z, 0.85);
      if (!this.usable(n)) return false;
      if (Math.abs(this.height[n] - prevY) > AI.navStep) return false;
      prevY = this.height[n];
    }
    return true;
  }

  /**
   * How well a node is protected from a shooter at `threat`.
   * 1.0 = hard cover standing, 0.6 = cover only while crouched, 0 = exposed.
   */
  protection(node, threatX, threatZ) {
    let dx = threatX - this.wx(node);
    let dz = threatZ - this.wz(node);
    const len = Math.hypot(dx, dz);
    if (len < 1e-4) return 0;
    dx /= len; dz /= len;
    const hi = this.coverHigh[node], lo = this.coverLow[node];
    if (!hi && !lo) return 0;
    let best = 0;
    for (let d = 0; d < 8; d++) {
      const w = DIR_COS[d] * dx + DIR_SIN[d] * dz;   // cos of the angle between
      if (w < 0.55) continue;                        // only bits facing the threat
      const bit = 1 << d;
      if (hi & bit) { if (w > best) best = w; }
      else if (lo & bit) { const v = 0.62 * w; if (v > best) best = v; }
    }
    return best;
  }

  /* -------------------------------------------------- cover spatial index -- */

  /**
   * A coarse XZ bucket over `coverNodes`, stored CSR-style in two typed arrays.
   *
   * Cover scoring is the single most expensive thing the brains do, and it used
   * to be a linear scan of every cover node in the level — 3027 of them — with
   * a nested loop over the squad inside. Nine men re-picking cover roughly once
   * a second turned that into ~250k iterations a second for results that can
   * only ever come from a 15.5 m neighbourhood. Bucketing makes it a local
   * query: on this level a 15.5 m ask visits about 90 nodes instead of 3027.
   */
  _buildCoverIndex() {
    const cs = 8;
    this.covCell = cs;
    this.covNX = Math.max(1, Math.ceil((this.nx * this.cell) / cs) + 1);
    this.covNZ = Math.max(1, Math.ceil((this.nz * this.cell) / cs) + 1);
    const cells = this.covNX * this.covNZ;
    const nodes = this.coverNodes;
    const start = new Int32Array(cells + 1);
    const bin = new Int32Array(nodes.length);
    for (let i = 0; i < nodes.length; i++) {
      const b = this._covBin(this.wx(nodes[i]), this.wz(nodes[i]));
      bin[i] = b;
      start[b + 1]++;
    }
    for (let i = 0; i < cells; i++) start[i + 1] += start[i];
    const items = new Int32Array(nodes.length);
    const cursor = Int32Array.from(start.subarray(0, cells));
    for (let i = 0; i < nodes.length; i++) items[cursor[bin[i]]++] = nodes[i];
    this.covStart = start;
    this.covItems = items;
  }

  _covBin(x, z) {
    const ix = Math.min(this.covNX - 1, Math.max(0, Math.floor((x - this.x0) / this.covCell)));
    const iz = Math.min(this.covNZ - 1, Math.max(0, Math.floor((z - this.z0) / this.covCell)));
    return iz * this.covNX + ix;
  }

  /**
   * Cover nodes within `radius` of (x, z), written into the caller's `out`
   * Int32Array. Returns how many were written; the caller owns the buffer, so
   * this allocates nothing and is safe to call from a brain tick.
   */
  coverNear(x, z, radius, out) {
    if (!this.covStart) return 0;
    const cs = this.covCell;
    const ix0 = Math.max(0, Math.floor((x - radius - this.x0) / cs));
    const ix1 = Math.min(this.covNX - 1, Math.floor((x + radius - this.x0) / cs));
    const iz0 = Math.max(0, Math.floor((z - radius - this.z0) / cs));
    const iz1 = Math.min(this.covNZ - 1, Math.floor((z + radius - this.z0) / cs));
    const r2 = radius * radius;
    const cap = out.length;
    let n = 0;
    for (let iz = iz0; iz <= iz1; iz++) {
      const row = iz * this.covNX;
      for (let ix = ix0; ix <= ix1; ix++) {
        const b = row + ix;
        const e = this.covStart[b + 1];
        for (let k = this.covStart[b]; k < e; k++) {
          if (n >= cap) return n;
          const node = this.covItems[k];
          const dx = this.wx(node) - x, dz = this.wz(node) - z;
          if (dx * dx + dz * dz > r2) continue;
          out[n++] = node;
        }
      }
    }
    return n;
  }

  /** A usable node at a random offset — patrol targets, flank staging. */
  randomNear(x, y, z, radius, rng) {
    for (let i = 0; i < 14; i++) {
      const a = rng() * Math.PI * 2;
      const r = radius * (0.35 + rng() * 0.65);
      const n = this.nodeAt(x + Math.cos(a) * r, y, z + Math.sin(a) * r, 2.2);
      if (this.usable(n)) return n;
    }
    return -1;
  }
}
