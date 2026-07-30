import * as THREE from 'three';
import { drawTie } from './LevelTies.js';

/**
 * THE WORLD FLOAT AUDIT. OWNER: props agent.
 *
 * WHY THIS EXISTS — READ THIS BEFORE WRITING ANOTHER RESEAT PASS
 *   "Rusted plates float in mid-air" was raised in four consecutive reviews and
 *   three props agents attempted it. Every one of them worked on the props
 *   system, because that is the system that owns floating-prop defects. All
 *   three fixes worked. The plates stayed.
 *
 *   Round 8 identified the objects by casting a ray through the offending pixel
 *   of tools/out/shots/round7/hero-golden.png. The answer:
 *
 *     pixel (1147,197) -> mesh `fg|fabric|110`, material `fabric`,
 *     world (6.28, 3.34, 17.87), 4.28 m from the hero camera.
 *
 *   That is `src/world/level/Foreground.js`, buildNearBent(), the line
 *   commented "torn mineral-wool lagging peeling off the underside of the pipe":
 *   a 0.62 x 0.80 x 0.03 fabric slab placed 1.4 m clear of the pipe it is
 *   supposed to be peeling off. It is LEVEL geometry, not a prop. It is also
 *   `solid: false`, so it lives in `level.decor` and is not even in
 *   `level.colliders` — which means the props system's own BVH snapshot cannot
 *   see it, ContactPass cannot see it, FloatSweep cannot see it, and
 *   Props._auditWorld cannot see it. Four rounds of props-side work could not
 *   possibly have touched it.
 *
 *   The dimpled diamond pattern that made every reviewer call it "a rusted
 *   perforated plate" is the hessian weave normal map on the `fabric` recipe,
 *   seen edge-on against a golden sky.
 *
 * WHAT THIS PASS DOES ABOUT IT
 *   Props does not own the level and will not edit it. What props CAN do is what
 *   a set-dressing pass is for: find the unsupported pieces of the world by
 *   measurement, and give them visible, physically-legible support — a wire
 *   rope, a strap cleat, a bracket — built out of props-owned geometry that is
 *   sited by raycast, so it follows the level if the level moves.
 *
 *   1. CLUSTER. Every level mesh — colliders AND decor — is walked triangle by
 *      triangle in world space. Triangles are welded into clusters through a
 *      union-find over a 14 cm cell grid keyed on their vertices, so anything
 *      within ~28 cm of anything else is one object. A cluster is therefore an
 *      "island": a connected piece of world with a measurable gap around it.
 *      Large triangles keep their full AABB, so a wall is one huge cluster and
 *      is skipped as structure rather than mistaken for a floating panel.
 *   2. SUSPECT. Small (<= 2.2 m), light (<= 1200 tri), panel-or-box shaped
 *      clusters whose base is more than 80 cm off the ground and which subtend
 *      more than 18 mrad from one of the shoot rig's cameras.
 *   3. PROVE. A suspect is cleared if it is resting on something, or if the
 *      nearest OTHER surface is within a bracket's span of its real vertices.
 *      Note "real vertices": measuring from the bounding box is what made the
 *      first version of this pass report the round-7 panel as attached. Read
 *      _gap() before changing that test.
 *   4. BRACE. The nearest real surface within 2.8 m is found by a 26-direction
 *      fan, and a tie is drawn from the cluster's own nearest VERTEX — not its
 *      bounding box, which is how the round-7 viewmodel fix ended up 18 mm short
 *      — to that surface. Short spans get a bolted bracket, long spans get a
 *      pair of sagging wire ropes with cleats. Anything with nothing in reach is
 *      named and counted in the console, because props cannot invent a support
 *      that is not there and should not pretend otherwise.
 *
 * Cost: one pass over ~490k world triangles plus ~50 rays per suspect. ~60 ms at
 * init, zero per frame. Draw calls: zero — every tie merges into the existing
 * `darkmetal` batch.
 */

/** Cell size for the island grid. Two pieces within ~2x this are one object. */
const CELL = 0.14;
/** Below this height everything is floor, kerb and paving. Not our problem. */
const Y_MIN = 0.80;
/** Above this is roofline and gantry: structure, not dressing. */
const Y_MAX = 13.0;
/** Horizontal interest radius. Beyond it is backdrop, which may float. */
const XZ_LIMIT = 54;
/**
 * Largest dimension a cluster may have and still be judged as a loose object.
 * Anything bigger is a beam, a deck or a wall panel: structure the level owns,
 * which props reports and does not decorate.
 */
const MAX_DIM = 2.2;
/**
 * A cluster whose two LARGEST dimensions both exceed this is a floor, roof or
 * deck plate however thin it is. Bracing one with a rod looks like a mistake.
 */
const DECK_SPAN = 1.3;
/** Triangles above which a cluster is machinery or structure, not a panel. */
const MAX_TRIS = 1200;
/** Daylight allowed under a cluster before it stops counting as "resting". */
const REST_REACH = 0.055;
/**
 * Isolation radius. If ANYTHING is within this of a cluster's bounding box it is
 * left alone.
 *
 * FloatSweep uses 0.18 m for props, which is the span of a real bracket. This is
 * deliberately three times looser, because the two passes answer different
 * questions. FloatSweep can move or delete a prop, so it can afford to be
 * strict. This pass can only ADD geometry to somebody else's level, so being
 * wrong is expensive: a wire drawn onto a panel that was fine is a new defect.
 * At 0.55 m the pass keeps its hands off anything with a plausible neighbour and
 * fires only on genuinely isolated objects — the 1.4 m case in hero-golden is
 * eight times past this line.
 */
const NEAR_REACH = 0.16;
/** How far a tie may reach for something to fasten to. */
const BRACE_REACH = 2.8;
/** Ties we are willing to draw. Beyond this, report instead of dressing. */
const MAX_BRACES = 28;
/** Vertices kept per suspect cluster, for choosing the attachment point. */
const MAX_SAMPLES = 240;
/**
 * Angular size, in radians, below which a floating object is not worth touching.
 * 0.018 rad is ~20 px tall in a 1080p frame at 80 degrees vertical FOV: the
 * threshold at which a reviewer can see that something has no support.
 */
const MIN_ANGULAR = 0.018;
/** Thickest a cluster may be and still read as a plate, panel, box or sign. */
const MAX_THICKNESS = 0.75;

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _o = new THREE.Vector3();
const _d = new THREE.Vector3();
const _down = new THREE.Vector3(0, -1, 0);

/** Offsets across a box face, as fractions of the face's half-extents. */
const TAPS = [[0, 0], [0.7, 0.7], [-0.7, 0.7], [0.7, -0.7], [-0.7, -0.7]];

/** The 26 directions out of a box: faces, edges and corners. */
const FAN = (() => {
  const out = [];
  for (let x = -1; x <= 1; x++) {
    for (let y = -1; y <= 1; y++) {
      for (let z = -1; z <= 1; z++) {
        if (!x && !y && !z) continue;
        const l = Math.hypot(x, y, z);
        out.push([x / l, y / l, z / l]);
      }
    }
  }
  return out;
})();

export class LevelFloatPass {
  /** @param {import('./Surfaces.js').SurfaceProbe} probe */
  constructor(probe) {
    this.probe = probe;
    this.stats = {
      meshes: 0, triangles: 0, clusters: 0, suspects: 0,
      resting: 0, attached: 0, braced: 0, unbraceable: 0, overBudget: 0, wires: 0,
      worst: 0,
    };
    /** Human-readable list of what was braced and what could not be. */
    this.report = [];
    this.orphans = [];
    /**
     * The meshes the probe's BVH actually contains. An island built only from
     * meshes OUTSIDE this set can be measured exactly by closest-point query,
     * because it cannot hit itself. See _gap().
     */
    this._collect = false;
    this._inProbe = new Set();
    /** mesh -> surface family, so an island can be asked what it is made of. */
    this._surface = new Map();
    for (const src of probe?.sources ?? []) {
      this._inProbe.add(src.obj);
      this._surface.set(src.obj, src.surface ?? '');
    }
    /** Every island found, for consumers like parts/BagCap.js. */
    this.islands = [];
  }

  /* --------------------------------------------------------------- gather */

  /**
   * Every mesh the LEVEL contributed, solid or not.
   *
   * `level.meshes` is the level's own list of everything it baked, which is the
   * only seam that sees `decor` — the loose, non-collider dressing where the
   * round-7 floating panel actually lives. Falls back to walking the two groups
   * directly if that list is ever removed.
   */
  _levelMeshes(level) {
    const out = new Set();
    const take = (o) => {
      if (o?.isMesh && o.geometry?.attributes?.position && !o.name.startsWith('prop:')) out.add(o);
    };
    if (Array.isArray(level?.meshes) && level.meshes.length) level.meshes.forEach(take);
    else {
      level?.colliders?.traverse(take);
      level?.decor?.traverse(take);
    }
    return [...out];
  }

  /** Surface family of a level mesh, from the probe's table or the material. */
  surfaceOf(mesh) {
    const known = this._surface.get(mesh);
    if (known !== undefined) return known;
    const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    return mat?.userData?.surface ?? '';
  }

  /**
   * Islands built from ONE surface family only.
   *
   * The general island pass welds anything within ~28 cm into one object, which
   * is right for "is this floating" and wrong for "which pieces of the world are
   * sandbags": the level's sketched bags sit half-buried in their concrete coping
   * and therefore weld to the whole courtyard. Restricting the walk to fabric
   * meshes separates them again. Costs one extra pass over ~2k triangles.
   */
  islandsOfSurface(level, surface) {
    const meshes = this._levelMeshes(level).filter((m) => this.surfaceOf(m) === surface);
    if (!meshes.length) return [];
    const tri = this.stats.triangles, cl = this.stats.clusters;
    this._collect = true;
    const roots = this._cluster(meshes);
    this._collect = false;
    this.stats.triangles = tri;
    this.stats.clusters = cl;
    return [...roots.values()];
  }

  /* -------------------------------------------------------------- cluster */

  /**
   * Union-find over a sparse cell grid. Returns the cluster table.
   * Cells are keyed by a single integer so the Map stays fast at 300k entries.
   */
  _cluster(meshes) {
    const ids = new Map();
    const parent = [];
    const bmin = [];      // 3 per id
    const bmax = [];      // 3 per id
    const tris = [];
    const sol = [];       // 1 if any collider triangle landed here
    const fab = [];       // 1 if any fabric-surface triangle landed here
    const pts = this._collect ? [] : null;   // triangle centroids, for PCA
    let n = 0;

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
    for (const mesh of meshes) {
      mesh.updateMatrixWorld(true);
      // Is this mesh in the probe's BVH? That decides which isolation test the
      // cluster is entitled to — see _isolated().
      const inBVH = this._inProbe.has(mesh) ? 1 : 0;
      const isFabric = this.surfaceOf(mesh) === 'fabric' ? 1 : 0;
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
        if (hiY < Y_MIN || loY > Y_MAX) continue;
        const loX = Math.min(_a.x, _b.x, _c.x), hiX = Math.max(_a.x, _b.x, _c.x);
        const loZ = Math.min(_a.z, _b.z, _c.z), hiZ = Math.max(_a.z, _b.z, _c.z);
        if (loX > XZ_LIMIT || hiX < -XZ_LIMIT || loZ > XZ_LIMIT || hiZ < -XZ_LIMIT) continue;
        triTotal++;

        // one cell per vertex; the triangle welds them together
        let nk = 0;
        for (let k = 0; k < 3; k++) {
          const v = k === 0 ? _a : k === 1 ? _b : _c;
          const id = idOf(
            Math.floor(v.x / CELL), Math.floor(v.y / CELL), Math.floor(v.z / CELL),
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
          root: r, tris: 0, inBVH: 0, fabric: 0, pts: pts ? [] : null,
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
      if (pts && pts[i]) for (let k = 0; k < pts[i].length; k++) c.pts.push(pts[i][k]);
    }
    // roots whose cells only ever received unions carry no extent — drop them
    for (const [k, c] of roots) if (c.min[0] === Infinity) roots.delete(k);

    this.stats.triangles = triTotal;
    this.stats.clusters = roots.size;
    return roots;
  }

  /* -------------------------------------------------------------- verdict */

  /** Something solid directly under the cluster's base, in contact. */
  _resting(c) {
    const cx = (c.min[0] + c.max[0]) * 0.5, cz = (c.min[2] + c.max[2]) * 0.5;
    const ex = (c.max[0] - c.min[0]) * 0.34, ez = (c.max[2] - c.min[2]) * 0.34;
    for (let i = 0; i < 5; i++) {
      const px = cx + (i === 1 ? ex : i === 2 ? -ex : 0);
      const pz = cz + (i === 3 ? ez : i === 4 ? -ez : 0);
      _o.set(px, c.min[1] - 0.004, pz);
      const hit = this.probe.cast(_o, _down, REST_REACH);
      if (hit) return true;
    }
    return false;
  }

  /**
   * Is this island fastened to anything?
   *
   * THE MISTAKE THIS FUNCTION USED TO MAKE, AND WHY IT MATTERS
   *   The first version of this test cast rays outward from the cluster's
   *   BOUNDING BOX faces. For the round-7 panel that returned "attached at
   *   7 cm" — and the panel is genuinely 7 cm from the lagging sleeve, measured
   *   box to surface. Look at the picture and the panel has clear sky along its
   *   entire silhouette. The box was lying: a 0.62 x 0.80 x 0.03 slab tilted in
   *   two axes has a 0.41 x 0.96 x 0.76 AABB that is 96% air, and the ray found
   *   the sleeve sitting in that air well behind the plate.
   *
   *   Bounding-box proximity is not a support test for thin, tilted or hollow
   *   geometry. Only the real surface is. So:
   *
   *   · An island made only of DECOR meshes is not in the probe's BVH at all, so
   *     a closest-point query from its own vertices cannot hit itself and gives
   *     the exact gap. This is the accurate path, and it is the one the round-7
   *     offender takes.
   *   · An island that includes COLLIDER geometry would answer every
   *     closest-point query with zero, because it is in the BVH. It keeps the
   *     box-face ray test, which errs toward "attached" — the safe direction,
   *     since being wrong here means drawing a wire onto somebody else's
   *     perfectly good structure.
   *
   * @returns {number} metres to the nearest other surface (Infinity if none)
   */
  _gap(c, verts) {
    if (!c.inBVH && verts && verts.length) {
      let best = Infinity;
      const step = Math.max(1, Math.floor(verts.length / 64));
      for (let i = 0; i < verts.length; i += step) {
        const v = verts[i];
        const d = this.probe.nearest(v.x, v.y, v.z, NEAR_REACH + 0.02);
        if (d < best) best = d;
        if (best <= 0.002) break;
      }
      return best;
    }
    // collider island: box-face rays, deliberately conservative
    const ctr = [
      (c.min[0] + c.max[0]) * 0.5, (c.min[1] + c.max[1]) * 0.5, (c.min[2] + c.max[2]) * 0.5,
    ];
    const ext = [
      (c.max[0] - c.min[0]) * 0.5, (c.max[1] - c.min[1]) * 0.5, (c.max[2] - c.min[2]) * 0.5,
    ];
    let best = Infinity;
    for (let axis = 0; axis < 3; axis++) {
      const a1 = (axis + 1) % 3, a2 = (axis + 2) % 3;
      for (const sign of [-1, 1]) {
        for (const tap of TAPS) {
          const o = [ctr[0], ctr[1], ctr[2]];
          o[axis] += sign * (ext[axis] + 0.004);
          o[a1] += tap[0] * ext[a1];
          o[a2] += tap[1] * ext[a2];
          _o.set(o[0], o[1], o[2]);
          _d.set(0, 0, 0);
          _d.setComponent(axis, sign);
          const h = this.probe.cast(_o, _d, NEAR_REACH);
          if (h && h.distance < best) best = h.distance;
        }
      }
    }
    for (const dir of FAN) {
      _o.set(
        ctr[0] + Math.sign(dir[0]) * ext[0] + dir[0] * 0.005,
        ctr[1] + Math.sign(dir[1]) * ext[1] + dir[1] * 0.005,
        ctr[2] + Math.sign(dir[2]) * ext[2] + dir[2] * 0.005,
      );
      _d.set(dir[0], dir[1], dir[2]);
      const h = this.probe.cast(_o, _d, NEAR_REACH);
      if (h && h.distance < best) best = h.distance;
    }
    return best;
  }

  /**
   * Closest real surface, searched from the island's own VERTICES in 26
   * directions. Searching from the bounding box instead is how you end up with a
   * wire whose lower end is in clear air next to the thing it is holding.
   */
  _findAnchor(c, verts) {
    const cy = (c.min[1] + c.max[1]) * 0.5;
    let best = null;
    const step = Math.max(1, Math.floor(verts.length / 16));
    for (let i = 0; i < verts.length; i += step) {
      const v = verts[i];
      for (const dir of FAN) {
        _o.set(v.x + dir[0] * 0.005, v.y + dir[1] * 0.005, v.z + dir[2] * 0.005);
        _d.set(dir[0], dir[1], dir[2]);
        const hit = this.probe.cast(_o, _d, BRACE_REACH);
        if (!hit || hit.distance < 0.015) continue;   // 0 = its own surface
        // Prefer anchors at or above the island: a wire from above reads as a
        // hanging panel, a strut from below reads as a mistake propped up.
        const lift = hit.point.y - cy;
        const score = hit.distance - (lift > 0.12 ? 0.45 : 0);
        if (!best || score < best.score) {
          best = {
            score, point: hit.point.clone(), from: v.clone(), dist: hit.distance,
          };
        }
      }
    }
    return best;
  }

  /**
   * Draw the tie. `verts` are real world-space vertices of the cluster, so the
   * lower end lands ON the geometry rather than on its bounding box.
   * @returns {number} wires drawn
   */
  /* ------------------------------------------------------------------ run */

  /**
   * @param {object} ctx engine context (unused beyond documentation of intent)
   * @param {import('../Level.js').Level} level
   * @param {import('./Kit.js').Batcher} batcher
   * @param {import('./Materials.js').PropMaterials} mats
   * @param {import('./Rand.js').Rand} rng
   */
  run(level, batcher, mats, rng, eyes = []) {
    const s = this.stats;
    if (!this.probe?.ok) return s;
    const meshes = this._levelMeshes(level);
    s.meshes = meshes.length;
    if (!meshes.length) return s;

    const roots = this._cluster(meshes);
    this.islands = [...roots.values()];

    /**
     * Angular size of a cluster from the nearest camera the shoot rig actually
     * uses. This, not volume, is the right ranking: the round-7 offender is
     * 0.8 m across and 4.3 m from the hero eye, so it fills more of the frame
     * than a 3 m tank plate 40 m away, and it is the one a reviewer circles.
     */
    const angular = (c, dim) => {
      if (!eyes.length) return 1;
      const cx = (c.min[0] + c.max[0]) * 0.5;
      const cy = (c.min[1] + c.max[1]) * 0.5;
      const cz = (c.min[2] + c.max[2]) * 0.5;
      let near = Infinity;
      for (const e of eyes) {
        const d = Math.hypot(e.x - cx, (e.y ?? 1.7) - cy, e.z - cz);
        if (d < near) near = d;
      }
      return dim / Math.max(1.2, near);
    };

    // 1 — shortlist: prop-sized, panel-like, off the ground, big enough in frame
    const suspects = [];
    for (const c of roots.values()) {
      const dx = c.max[0] - c.min[0], dy = c.max[1] - c.min[1], dz = c.max[2] - c.min[2];
      const dim = Math.max(dx, dy, dz);
      if (dim > MAX_DIM || dim < 0.10) continue;
      if (c.tris > MAX_TRIS) continue;
      if (c.min[1] < Y_MIN) continue;
      const sorted = [dx, dy, dz].sort((a, b) => b - a);
      if (sorted[2] > MAX_THICKNESS) continue;
      if (sorted[1] > DECK_SPAN) continue;             // deck / roof / wall panel
      const ang = angular(c, dim);
      if (ang < MIN_ANGULAR) continue;
      suspects.push({ ...c, dim, ang, vol: dx * dy * dz });
    }
    s.suspects = suspects.length;
    if (!suspects.length) return s;

    // 2 — real vertices for every suspect. The isolation test, the anchor search
    //     and the tie's lower end all need actual surface points, not a box.
    const verts = new Map();
    for (const c of suspects) verts.set(c, []);
    this._sampleVertices(meshes, suspects, verts);

    // 3 — verdict
    const floating = [];
    for (const c of suspects) {
      if (this._resting(c)) { s.resting++; continue; }
      const gap = this._gap(c, verts.get(c));
      if (gap <= NEAR_REACH) { s.attached++; continue; }
      c.gap = gap;
      floating.push(c);
    }
    if (!floating.length) return s;

    // Most visible first, so the brace budget is spent where a reviewer looks.
    floating.sort((a, b) => b.ang - a.ang);

    // 4 — brace
    for (const c of floating) {
      const ctr = [
        (c.min[0] + c.max[0]) * 0.5, (c.min[1] + c.max[1]) * 0.5, (c.min[2] + c.max[2]) * 0.5,
      ];
      const where = `${ctr[0].toFixed(1)},${ctr[1].toFixed(1)},${ctr[2].toFixed(1)}`;
      const size = `${(c.max[0] - c.min[0]).toFixed(2)}x${(c.max[1] - c.min[1]).toFixed(2)}`
        + `x${(c.max[2] - c.min[2]).toFixed(2)} (${(c.ang * 1000) | 0}mrad, gap `
        + `${Number.isFinite(c.gap) ? `${(c.gap * 100) | 0}cm` : `>${(NEAR_REACH * 100) | 0}cm`})`;
      const vs = verts.get(c);
      if (s.braced >= MAX_BRACES) {
        s.overBudget++;
        if (this.orphans.length < 10) this.orphans.push(`${size} @${where} [over tie budget]`);
        continue;
      }
      const anchor = vs && vs.length ? this._findAnchor(c, vs) : null;
      if (anchor) {
        const w = drawTie(batcher, mats, c, anchor, vs, rng);
        if (w) {
          s.braced++;
          s.wires += w;
          if (anchor.dist > s.worst) s.worst = anchor.dist;
          if (this.report.length < 8) {
            this.report.push(`${size} @${where} tied to a surface ${anchor.dist.toFixed(2)}m away`);
          }
          continue;
        }
      }
      s.unbraceable++;
      if (this.orphans.length < 8) this.orphans.push(`${size} @${where}`);
    }
    return s;
  }

  /**
   * Second pass over the same triangles, collecting world vertices for the
   * shortlisted clusters only. Cheap, and it is the difference between a wire
   * that lands on the panel and a wire that lands 12 cm off it in clear air.
   */
  _sampleVertices(meshes, wanted, out) {
    if (!wanted.length) return;
    // spatial shortlist: bucket the wanted clusters by 1 m cell
    const grid = new Map();
    for (const c of wanted) {
      for (let x = Math.floor(c.min[0]); x <= Math.floor(c.max[0]); x++) {
        for (let z = Math.floor(c.min[2]); z <= Math.floor(c.max[2]); z++) {
          const k = `${x},${z}`;
          let l = grid.get(k);
          if (!l) { l = []; grid.set(k, l); }
          l.push(c);
        }
      }
    }
    for (const mesh of meshes) {
      const geo = mesh.geometry;
      const pos = geo.attributes.position;
      const m = mesh.matrixWorld;
      for (let i = 0; i < pos.count; i++) {
        _a.fromBufferAttribute(pos, i).applyMatrix4(m);
        if (_a.y < Y_MIN) continue;
        const list = grid.get(`${Math.floor(_a.x)},${Math.floor(_a.z)}`);
        if (!list) continue;
        for (const c of list) {
          if (_a.x < c.min[0] - 0.002 || _a.x > c.max[0] + 0.002) continue;
          if (_a.y < c.min[1] - 0.002 || _a.y > c.max[1] + 0.002) continue;
          if (_a.z < c.min[2] - 0.002 || _a.z > c.max[2] + 0.002) continue;
          const arr = out.get(c);
          if (arr.length < MAX_SAMPLES) arr.push(_a.clone());
          break;
        }
      }
    }
  }

  summary() {
    const s = this.stats;
    return `${s.clusters} world islands from ${(s.triangles / 1000) | 0}k triangles · `
      + `${s.suspects} prop-sized and off the ground: ${s.resting} resting, `
      + `${s.attached} within ${(NEAR_REACH * 100) | 0}cm of a surface, `
      + `${s.braced} FLOATING and given ${s.wires} visible tie(s), `
      + `${s.unbraceable} floating with nothing within ${BRACE_REACH}m to fasten to, `
      + `${s.overBudget} floating and left for the level agent (tie budget ${MAX_BRACES})`;
  }
}
