import * as THREE from 'three';
import {
  pieceMovable, movePiece, removePiece, refreshBounds, sharedGeometries,
} from './LevelSurgery.js';
import { sceneMeshes, triangleWalker, closestOnTri } from './LevelSeatScan.js';

/**
 * THE PERCH PASS. OWNER: props agent.
 *
 * ============ WHY AN EIGHTH PASS AT "FLOATING RUSTED PLATES" ================
 * Read LevelSeat.js first; this is its missing half, and the reason it was
 * missing is the whole finding of round 11.
 *
 * Every float pass in this project — Contact.js, Float.js, LevelFloat.js,
 * LevelTies.js, LevelSeat.js — asks ONE question: is there anything within 5 cm
 * of this object? Round 11 pointed tools/floatcheck.mjs at the object the
 * round-10 reviewer circled in hero-overcast, the pale panel hanging in the sky at
 * the top of the frame, and got back:
 *
 *      HELD  0.65 x 0.33 x 0.57 m  @ 8.92, 3.36, 16
 *            DAYLIGHT to nearest other surface: 0.034 m
 *
 * The measurement was right. The question was wrong. That panel is a precast slab
 * balanced across two 4 cm rusty rods, tilted thirty degrees, 3.4 m in the air
 * with sky on five sides. It passes every proximity test ever written here, and it
 * is the single most-noticed defect in the level. PROXIMITY IS NOT SUPPORT.
 *
 * That is why seven reseat passes all reported success and the plates stayed: the
 * plates were never in the floating population. They were in the SUPPORTED
 * population, held there by a tangent.
 *
 * ============ WHAT THIS PASS ASKS ==========================================
 * Statics, over the finished scene graph, after LevelSeat has run:
 *
 *   1. weld world triangles into islands at the contact radius
 *   2. area-weighted CENTRE OF MASS per island — not the AABB centre, which for a
 *      bent plate or an angle bracket is in the air outside the material
 *   3. the CONTACT SET: every 5 cm cell where another island's surface touches,
 *      tagged with the island that produced it
 *   4. a verdict, over the contacts that come from things which themselves stand:
 *        RESTING  centre of mass inside the footprint of its SOLID bearing
 *        FIXED    a dozen contact cells (a seam, a flange, a clamped collar) or a
 *                 patch covering a real fraction of its own largest face
 *        HUNG     contacts ABOVE the centre of mass spanning enough to sling it
 *        PERCHED  bearing only on rods, cables and wires — balanced on a wire
 *        TOPPLE   touching, but nothing that could hold it in that pose
 *
 * A support is judged by its own build: an island whose MEDIAN dimension is under
 * SLENDER is a rod, a cable or a conduit, and things do not sit on those. The
 * median and not the smallest, because a 2 x 1.2 x 0.1 m deck plate is thin and is
 * a perfectly good thing to stand something on.
 *
 * ============ WHAT IT DOES ABOUT IT ========================================
 *   DROP    onto the highest solid, near-horizontal surface under its own
 *           footprint, when one is inside the budget. Resting means touching.
 *   STRIP   when nothing is under it. A slab balanced on a powerline serves no
 *           purpose; the brief for this round is explicit that purposeless
 *           dressing is deleted rather than propped.
 *   REPORT  anything too large for either. Named in the console, never guessed at.
 *
 * Deliberately NARROW. It acts only on objects that are panel-shaped, legible in
 * a shoot-rig frame, and touching the world at a handful of points — the exact
 * population a reviewer circles. Islands with a dozen or more live contacts are
 * measured, counted and left alone whatever their statics, because at that point
 * the thing is welded to something and the pose is the level's business.
 *
 * VERIFY WITH: node tools/supportcheck.mjs
 * That tool knows nothing about this pass and re-measures the rendered scene
 * graph. If the two disagree, the tool is right.
 */

/** Weld cell; the weld radius is 2x and equals CONTACT, so no band can hide. */
const CELL = 0.025;
/** Surfaces this close are touching. Matches every other pass in the project. */
const CONTACT = 0.05;
/** Residual gap left after a drop: touching, without interpenetrating. */
const SEATED = 0.004;
/** Contact-set resolution. One cell is about the footprint of a bolt head. */
const PATCH = 0.05;
/** Below this an island is floor, kerb or paving. Support, never a suspect. */
const Y_GROUND = 0.42;
/** Above this is roofline: measured, never dressed. */
const Y_MAX = 15.0;
const XZ_LIMIT = 56;
/** Bigger or heavier than this IS the building. Support, never a suspect. */
const STRUCTURE_DIM = 12;
const STRUCTURE_TRIS = 4000;
const MIN_DIM = 0.09;
/** Angular size below which an unsupported object is not a visible defect. */
const MIN_ANGULAR = 0.012;
/**
 * A support whose MEDIAN dimension is under this is a rod, cable, wire or
 * conduit. Bearing on one is PERCHED, not RESTING. See the header.
 */
const SLENDER = 0.15;
/** Distinct contact cells that constitute a seam whatever the coverage. */
const SEAM_PATCHES = 12;
/** ...or this fraction of the island's own largest face, with a few cells. */
const FIX_COVERAGE = 0.05;
const FIX_PATCHES = 4;
/** Slop on the support-polygon test: a bootlace, not a licence. */
const REST_SLOP = 0.04;
/** A footprint narrower than this is a tangent, not a footprint. */
const REST_SPAN = 0.10;
/** Overhead contacts have to span this much of the object to read as slung. */
const HANG_SPAN = 0.45;
const HANG_PATCHES = 3;
/** Vertices sampled per island. */
const MAX_SAMPLES = 400;
/**
 * Search radius for the contact set. This pass only needs CONTACT, unlike
 * LevelSeat which has to find a seat target up to 0.75 m away — which is why this
 * whole pass costs a fraction of that one despite doing more per island.
 */
const REACH = 0.07;
/** Query grid cell, metres. */
const GRID = 0.5;
/** Furthest an island may be dropped onto the surface under it. */
const DROP_MAX = 0.9;
/** Largest island this pass will remove. Above it, report and leave alone. */
const STRIP_MAX = 2.6;
/** Largest island it will touch at all. */
const ACT_DIM = 4.0;
/** Panel-shaped and legible in frame: the population a reviewer circles. */
const ACT_FACE = 0.25;
const ACT_FACE_MRAD = 15;
/**
 * Live contacts above which an island is left alone whatever its statics.
 *
 * THIS IS THE SAFETY VALVE AND IT IS DELIBERATELY TIGHT. The measurement finds
 * two populations: things balanced on a point (a handful of contact cells) and
 * things whose support chain does not bottom out because they lean on each other
 * in a stack. The first is unambiguous and is what eight reviews have described.
 * The second needs the level's own intent to resolve and a pass that started
 * deleting stacks would be doing what the first run of LevelSeat did when it laid
 * the canopy purlins out on the courtyard. Eight is comfortably above the panel
 * this round is about (seven) and far below a welded seam.
 */
const MAX_LIVE = 8;
/**
 * Live contacts a PERCHED object may have and still be removed. Above it the
 * thing is resting on a rail as well as a cable, which is a pose that reads.
 */
const STRIP_MAX_LIVE = 8;
/** ...and it has to be big enough in frame that a viewer would circle it. */
const STRIP_FACE_MRAD = 40;
/**
 * Ceiling on actions. Not the gate — the gate is the evidence test at the strip
 * site — but a dressing pass that removes hundreds of pieces of a level it does
 * not own is a worse bug than the one it is fixing, and this makes that
 * impossible rather than unlikely.
 */
const ACT_BUDGET = 90;

export class LevelPerchPass {
  constructor() {
    this.stats = {
      meshes: 0, triangles: 0, islands: 0, candidates: 0,
      resting: 0, fixed: 0, hung: 0, perched: 0, topple: 0,
      actionable: 0, dropped: 0, stripped: 0, unmovable: 0, left: 0, ms: 0,
    };
    /** What was done, most visible first. */
    this.report = [];
    /** What it found and did not act on, so the next round starts here. */
    this.stuck = [];
  }

  /**
   * @param {{scene: THREE.Scene}} ctx
   * @param {{x:number,y:number,z:number}[]} eyes shoot-rig camera positions
   */
  run(ctx, eyes = []) {
    const t0 = performance.now();
    try {
      if (new URLSearchParams(location.search).get('noperch') === '1') return this.stats;
    } catch { /* no URL context */ }
    try {
      this._sweep(ctx, eyes);
    } catch (err) {
      console.warn('[props] perch pass failed, leaving the world untouched:', err);
    }
    this.stats.ms = performance.now() - t0;
    return this.stats;
  }

  _sweep(ctx, eyes) {
    const meshes = sceneMeshes(ctx.scene);
    this.stats.meshes = meshes.length;
    if (!meshes.length) return;
    const each = triangleWalker(meshes, { xz: XZ_LIMIT, yMax: Y_MAX });

    /* ---- A: weld -------------------------------------------------------- */
    // Strides derived from CELL so the key cannot silently wrap: at 0.025 m the
    // envelope plus straddler slack is +-3844 cells, well past any fixed offset.
    const SPAN = Math.ceil((XZ_LIMIT + 40) / CELL) + 4;
    const SPANY = Math.ceil((Y_MAX + 24) / CELL) + 4;
    const SX = 2 * SPAN + 1, SY = 2 * SPANY + 1;
    const ids = new Map();
    const parent = [];
    let nCells = 0;
    const clamp = (i, lim) => (i < -lim ? -lim : (i > lim ? lim : i));
    const idOf = (ix, iy, iz) => {
      const key = (clamp(ix, SPAN) + SPAN) + (clamp(iy, SPANY) + SPANY) * SX
        + (clamp(iz, SPAN) + SPAN) * SX * SY;
      let id = ids.get(key);
      if (id === undefined) { id = nCells++; ids.set(key, id); parent.push(id); }
      return id;
    };
    const find = (a) => {
      let r = a;
      while (parent[r] !== r) r = parent[r];
      while (parent[a] !== r) { const nx = parent[a]; parent[a] = r; a = nx; }
      return r;
    };
    const kk = [0, 0, 0];
    const cellsOf = (v) => {
      let m = 0;
      for (let k = 0; k < 3; k++) {
        const id = idOf(Math.floor(v[k * 3] / CELL), Math.floor(v[k * 3 + 1] / CELL),
          Math.floor(v[k * 3 + 2] / CELL));
        let dup = false;
        for (let j = 0; j < m; j++) if (kk[j] === id) { dup = true; break; }
        if (!dup) kk[m++] = id;
      }
      return m;
    };

    let triTotal = 0;
    each((v) => {
      triTotal++;
      const m = cellsOf(v);
      for (let j = 1; j < m; j++) {
        const ra = find(kk[0]), rb = find(kk[j]);
        if (ra !== rb) parent[rb] = ra;
      }
    });
    this.stats.triangles = triTotal;
    if (!triTotal) return;

    /* ---- B: extents, triangle count, area-weighted centre of mass -------- */
    const rootOf = new Int32Array(triTotal);
    const isle = new Map();
    let ti = 0;
    each((v, mi, ni, f, loX, hiX, loY, hiY, loZ, hiZ) => {
      cellsOf(v);
      const r = find(kk[0]);
      rootOf[ti++] = r;
      let c = isle.get(r);
      if (!c) {
        c = {
          root: r, tris: 0, area: 0, cx: 0, cy: 0, cz: 0,
          min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity],
        };
        isle.set(r, c);
      }
      if (loX < c.min[0]) c.min[0] = loX; if (hiX > c.max[0]) c.max[0] = hiX;
      if (loY < c.min[1]) c.min[1] = loY; if (hiY > c.max[1]) c.max[1] = hiY;
      if (loZ < c.min[2]) c.min[2] = loZ; if (hiZ > c.max[2]) c.max[2] = hiZ;
      const ux = v[3] - v[0], uy = v[4] - v[1], uz = v[5] - v[2];
      const wx = v[6] - v[0], wy = v[7] - v[1], wz = v[8] - v[2];
      const a = 0.5 * Math.hypot(uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx);
      c.area += a;
      c.cx += a * (v[0] + v[3] + v[6]) / 3;
      c.cy += a * (v[1] + v[4] + v[7]) / 3;
      c.cz += a * (v[2] + v[5] + v[8]) / 3;
      c.tris++;
      void mi; void ni; void f;
    });
    this.stats.islands = isle.size;

    /* ---- classify ------------------------------------------------------- */
    const dimsOf = (c) => [c.max[0] - c.min[0], c.max[1] - c.min[1], c.max[2] - c.min[2]];
    const slenderCache = new Map();
    const isSlender = (r) => {
      let v = slenderCache.get(r);
      if (v === undefined) {
        const s = isle.get(r);
        v = s ? dimsOf(s).sort((a, b) => b - a)[1] < SLENDER : false;
        slenderCache.set(r, v);
      }
      return v;
    };

    const candidates = [];
    for (const c of isle.values()) {
      const d = dimsOf(c);
      c.dim = Math.max(d[0], d[1], d[2]);
      const sorted = d.slice().sort((a, b) => b - a);
      c.face = sorted[1];
      c.faceArea = sorted[0] * sorted[1];
      c.span = Math.max(d[0], d[2]);
      c.card = Math.min(d[0], d[1], d[2]) < 0.005;
      if (c.area > 0) { c.cx /= c.area; c.cy /= c.area; c.cz /= c.area; }
      if (c.dim > STRUCTURE_DIM || c.tris > STRUCTURE_TRIS) continue;
      if (c.min[1] < Y_GROUND || c.min[1] > Y_MAX || c.dim < MIN_DIM) continue;
      if (Math.abs((c.min[0] + c.max[0]) / 2) > XZ_LIMIT) continue;
      if (Math.abs((c.min[2] + c.max[2]) / 2) > XZ_LIMIT) continue;
      let ang = 1, eyeDist = 4;
      if (eyes.length) {
        ang = 0; eyeDist = Infinity;
        for (const e of eyes) {
          const dd = Math.hypot(e.x - (c.min[0] + c.max[0]) / 2,
            (e.y ?? 1.7) - (c.min[1] + c.max[1]) / 2, e.z - (c.min[2] + c.max[2]) / 2);
          const a = c.dim / Math.max(1, dd);
          if (a > ang) ang = a;
          if (dd < eyeDist) eyeDist = dd;
        }
      }
      if (ang < MIN_ANGULAR) continue;
      c.ang = ang; c.eyeDist = Math.max(1, eyeDist);
      c.faceMrad = (c.face / c.eyeDist) * 1000;
      candidates.push(c);
    }
    this.stats.candidates = candidates.length;
    if (!candidates.length) return;

    /* ---- C: vertices and a triangle grid round the candidates ------------ */
    const want = new Set();
    const byCell = new Map();
    for (const c of candidates) {
      c.verts = [];
      c.stride = Math.max(1, Math.ceil(c.tris / Math.max(1, MAX_SAMPLES / 3)));
      c.seen = 0;
      c.px = []; c.py = []; c.pz = []; c.pr = [];
      c.keys = new Set();
      c.touch = new Set();
      c.underY = -Infinity;
      for (let x = Math.floor(c.min[0] - REACH); x <= Math.floor(c.max[0] + REACH); x++) {
        for (let z = Math.floor(c.min[2] - REACH); z <= Math.floor(c.max[2] + REACH); z++) {
          const k = x * 4096 + z;
          want.add(k);
          let l = byCell.get(k);
          if (!l) { l = []; byCell.set(k, l); }
          l.push(c);
        }
      }
    }

    const tris = [];
    const triRoot = [];
    const triBox = [];
    const big = [];
    const buckets = new Map();
    const gKey = (ix, iy, iz) => ix * 16777216 + iy * 4096 + iz;
    ti = 0;
    each((v, mi, ni, f, loX, hiX, loY, hiY, loZ, hiZ) => {
      const r = rootOf[ti++];
      // Any overlapping cell counts. Testing only the centroid cell is what threw
      // away the level's paving in LevelSeat's first version — a merged ground
      // bucket holds single triangles 100 m across whose centroid is nowhere near
      // the thing they support.
      const cx0 = Math.floor(loX), cx1 = Math.floor(hiX);
      const cz0 = Math.floor(loZ), cz1 = Math.floor(hiZ);
      const span = (cx1 - cx0 + 1) * (cz1 - cz0 + 1);
      let keep = span > 12;
      if (!keep) {
        for (let x = cx0; x <= cx1 && !keep; x++) {
          for (let z = cz0; z <= cz1; z++) if (want.has(x * 4096 + z)) { keep = true; break; }
        }
      }
      if (!keep) return;
      const id = triRoot.length;
      for (let k = 0; k < 9; k++) tris.push(v[k]);
      triRoot.push(r);
      triBox.push(loX, hiX, loY, hiY, loZ, hiZ);
      if (span > 12) big.push(id);
      else {
        for (let ix = Math.floor(loX / GRID); ix <= Math.floor(hiX / GRID); ix++) {
          for (let iy = Math.floor(loY / GRID); iy <= Math.floor(hiY / GRID); iy++) {
            for (let iz = Math.floor(loZ / GRID); iz <= Math.floor(hiZ / GRID); iz++) {
              const k = gKey(ix, iy, iz);
              let l = buckets.get(k);
              if (!l) { l = []; buckets.set(k, l); }
              l.push(id);
            }
          }
        }
      }
      const list = byCell.get(Math.floor(loX) * 4096 + Math.floor(loZ))
        ?? byCell.get(Math.floor(hiX) * 4096 + Math.floor(hiZ));
      if (list) {
        for (const c of list) {
          if (c.root !== r) continue;
          if ((c.seen++ % c.stride) !== 0) break;
          if (c.verts.length >= MAX_SAMPLES * 3) break;
          c.verts.push(v[0], v[1], v[2], v[3], v[4], v[5], v[6], v[7], v[8]);
          break;
        }
      }
      void mi; void ni; void f;
    });
    const triArr = new Float64Array(tris);
    const boxArr = new Float64Array(triBox);
    const triRootArr = new Int32Array(triRoot);

    /* ---- D: the contact set, and the surface under each island ---------- */
    const stampArr = new Int32Array(triRootArr.length).fill(-1);
    const q = new THREE.Vector3();
    const local = [];
    let stamp = 0;
    const gather = (c, rad, out, st) => {
      out.length = 0;
      for (let ix = Math.floor((c.min[0] - rad) / GRID); ix <= Math.floor((c.max[0] + rad) / GRID); ix++) {
        for (let iy = Math.floor((c.min[1] - rad) / GRID); iy <= Math.floor((c.max[1] + rad) / GRID); iy++) {
          for (let iz = Math.floor((c.min[2] - rad) / GRID); iz <= Math.floor((c.max[2] + rad) / GRID); iz++) {
            const l = buckets.get(gKey(ix, iy, iz));
            if (!l) continue;
            for (const id of l) {
              if (stampArr[id] === st) continue;
              stampArr[id] = st; out.push(id);
            }
          }
        }
      }
      for (let i = 0; i < big.length; i++) {
        const id = big[i];
        if (stampArr[id] === st) continue;
        const b = id * 6;
        if (boxArr[b] - c.max[0] > rad || c.min[0] - boxArr[b + 1] > rad) continue;
        if (boxArr[b + 2] - c.max[1] > rad || c.min[1] - boxArr[b + 3] > rad) continue;
        if (boxArr[b + 4] - c.max[2] > rad || c.min[2] - boxArr[b + 5] > rad) continue;
        stampArr[id] = st; out.push(id);
      }
    };

    const C2 = CONTACT * CONTACT;
    for (const c of candidates) {
      if (!c.verts.length) continue;
      gather(c, CONTACT, local, stamp++);
      for (const id of local) {
        const r = triRootArr[id];
        if (r === c.root) continue;
        const off = id * 9;
        const tri = triArr.subarray(off, off + 9);
        for (let i = 0; i < c.verts.length; i += 3) {
          if (closestOnTri(c.verts[i], c.verts[i + 1], c.verts[i + 2], tri, q) > C2) continue;
          const key = `${Math.round(q.x / PATCH)},${Math.round(q.y / PATCH)},${Math.round(q.z / PATCH)}`;
          if (!c.keys.has(key)) {
            c.keys.add(key);
            c.px.push(q.x); c.py.push(q.y); c.pz.push(q.z); c.pr.push(r);
            c.touch.add(r);
          }
          break;
        }
      }
      // The highest solid, near-horizontal surface under this island's own
      // footprint. This is where a DROP lands, and it is measured rather than
      // raycast so the answer is in the same island numbering as the verdict.
      gather(c, DROP_MAX, local, stamp++);
      const inx0 = c.min[0] + 0.02, inx1 = c.max[0] - 0.02;
      const inz0 = c.min[2] + 0.02, inz1 = c.max[2] - 0.02;
      for (const id of local) {
        const r = triRootArr[id];
        if (r === c.root || isSlender(r)) continue;
        const o = id * 9;
        const ty = (triArr[o + 1] + triArr[o + 4] + triArr[o + 7]) / 3;
        if (ty >= c.min[1] - SEATED || ty < c.min[1] - DROP_MAX || ty <= c.underY) continue;
        const tx = (triArr[o] + triArr[o + 3] + triArr[o + 6]) / 3;
        const tz = (triArr[o + 2] + triArr[o + 5] + triArr[o + 8]) / 3;
        if (tx < inx0 || tx > inx1 || tz < inz0 || tz > inz1) continue;
        const ux = triArr[o + 3] - triArr[o], uy = triArr[o + 4] - triArr[o + 1];
        const uz = triArr[o + 5] - triArr[o + 2];
        const wx = triArr[o + 6] - triArr[o], wy = triArr[o + 7] - triArr[o + 1];
        const wz = triArr[o + 8] - triArr[o + 2];
        const ny = uz * wx - ux * wz;
        const nl = Math.hypot(uy * wz - uz * wy, ny, ux * wy - uy * wx);
        if (nl < 1e-9 || Math.abs(ny) / nl < 0.6) continue;
        c.underY = ty;
        c.underRoot = r;
      }
    }

    /* ---- E: the verdict -------------------------------------------------- */
    const byRoot = new Map();
    for (const c of candidates) byRoot.set(c.root, c);
    const stands = new Set();
    const B = {}, O = {};
    const reset = (b) => { b.n = 0; b.x0 = Infinity; b.x1 = -Infinity; b.z0 = Infinity; b.z1 = -Infinity; };
    const grow = (b, x, z) => {
      b.n++;
      if (x < b.x0) b.x0 = x; if (x > b.x1) b.x1 = x;
      if (z < b.z0) b.z0 = z; if (z > b.z1) b.z1 = z;
    };
    const statics = (c) => {
      reset(B); reset(O);
      let live = 0, slenderBear = 0;
      for (let i = 0; i < c.px.length; i++) {
        const r = c.pr[i];
        if (byRoot.has(r) && !stands.has(r)) continue;   // held up by a float
        live++;
        // Routed by height: hanging FROM a cable is what cables are for, standing
        // ON one is the defect. See the header.
        if (c.py[i] <= c.cy + PATCH) {
          if (isSlender(r)) { slenderBear++; continue; }
          grow(B, c.px[i], c.pz[i]);
        } else grow(O, c.px[i], c.pz[i]);
      }
      c.live = live;
      c.slenderBear = slenderBear;
      c.restSpan = B.n ? Math.max(B.x1 - B.x0, B.z1 - B.z0) : 0;
      c.overSpan = O.n ? Math.max(O.x1 - O.x0, O.z1 - O.z0) : 0;
      c.coverage = c.faceArea > 0 ? (live * PATCH * PATCH) / c.faceArea : 0;
      const inside = B.n >= 2
        && c.cx >= B.x0 - REST_SLOP && c.cx <= B.x1 + REST_SLOP
        && c.cz >= B.z0 - REST_SLOP && c.cz <= B.z1 + REST_SLOP;
      if (inside && c.restSpan >= REST_SPAN) return 'RESTING';
      if (live >= SEAM_PATCHES) return 'FIXED';
      if (live >= FIX_PATCHES && c.coverage >= FIX_COVERAGE) return 'FIXED';
      if (O.n >= HANG_PATCHES && c.overSpan >= HANG_SPAN * Math.max(0.05, c.span)) return 'HUNG';
      if (slenderBear) return 'PERCHED';
      return null;
    };
    for (const c of candidates) {
      c.mode = statics(c);
      if (c.mode && c.mode !== 'PERCHED') stands.add(c.root);
    }
    // Fixpoint, not a recursive walk: two plates leaning on each other in mid-air
    // must not hold each other up, and relaxation cannot poison a cycle.
    for (let pass = 0, changed = true; changed && pass < 24; pass++) {
      changed = false;
      for (const c of candidates) {
        if (stands.has(c.root)) continue;
        const m = statics(c);
        c.mode = m;
        if (m && m !== 'PERCHED') { stands.add(c.root); changed = true; }
      }
    }
    for (const c of candidates) {
      c.mode = statics(c) ?? c.mode ?? 'TOPPLE';
      if (!stands.has(c.root) && c.mode !== 'PERCHED') c.mode = 'TOPPLE';
      if (c.mode === 'RESTING') this.stats.resting++;
      else if (c.mode === 'FIXED') this.stats.fixed++;
      else if (c.mode === 'HUNG') this.stats.hung++;
      else if (c.mode === 'PERCHED') this.stats.perched++;
      else this.stats.topple++;
    }

    /* ---- F: act ---------------------------------------------------------- */
    const targets = candidates.filter((c) => (c.mode === 'PERCHED' || c.mode === 'TOPPLE')
      && !c.card && c.dim <= ACT_DIM && c.face >= ACT_FACE && c.faceMrad >= ACT_FACE_MRAD
      && c.live <= MAX_LIVE);
    this.stats.actionable = targets.length;
    if (!targets.length) return;

    const wanted = new Map();
    for (const c of targets) { c.pieces = new Map(); wanted.set(c.root, c); }
    ti = 0;
    each((v, mi, ni, f) => {
      const r = rootOf[ti++];
      const c = wanted.get(r);
      if (!c) return;
      const key = mi * 100000 + ni;
      let p = c.pieces.get(key);
      if (!p) { p = { mesh: meshes[mi], instance: ni, faces: [] }; c.pieces.set(key, p); }
      p.faces.push(f);
      void v;
    });

    const shared = sharedGeometries(meshes);
    const touched = new Set();
    targets.sort((a, b) => b.faceMrad - a.faceMrad);
    const label = (c, pieces) => `${(c.max[0] - c.min[0]).toFixed(2)}x`
      + `${(c.max[1] - c.min[1]).toFixed(2)}x${(c.max[2] - c.min[2]).toFixed(2)} `
      + `${c.mode} (${c.faceMrad | 0}mrad, ${c.live} live contact(s)`
      + `${c.slenderBear ? `, ${c.slenderBear} of them a rod or cable` : ''}) `
      + `@${((c.min[0] + c.max[0]) / 2).toFixed(1)},${((c.min[1] + c.max[1]) / 2).toFixed(1)},`
      + `${((c.min[2] + c.max[2]) / 2).toFixed(1)} [${pieces[0]?.mesh?.name || '?'}]`;

    let acted = 0;
    for (const c of targets) {
      const pieces = [...c.pieces.values()];
      if (!pieces.length) continue;
      if (acted >= ACT_BUDGET) {
        this.stats.left++;
        if (this.stuck.length < 12) this.stuck.push(`${label(c, pieces)} — over the action budget`);
        continue;
      }
      let reason = null;
      for (const p of pieces) {
        const r = pieceMovable(p, shared);
        if (r) { reason = r; break; }
      }
      if (reason) {
        this.stats.unmovable++;
        if (this.stuck.length < 12) this.stuck.push(`${label(c, pieces)} — ${reason}`);
        continue;
      }
      /*
       * DROP FIRST, AND IT IS ALWAYS SAFE.
       *
       * There is a solid, near-horizontal surface directly under this object's own
       * footprint and the object is not touching it. Closing that gap cannot make
       * the frame worse whatever the statics verdict was — at worst it moves
       * something a few millimetres onto the thing it was already meant to be
       * lying on. Nearly every action this pass takes is one of these, which is
       * why the strip gate below can afford to be as narrow as it is.
       */
      if (c.underY > -Infinity) {
        const dy = (c.underY + SEATED) - c.min[1];
        if (dy < 0 && dy >= -DROP_MAX) {
          for (const p of pieces) { movePiece(p, 0, dy, 0); touched.add(p.mesh); }
          this.stats.dropped++;
          acted++;
          if (this.report.length < 14) {
            this.report.push(`DROPPED ${label(c, pieces)} by ${(-dy).toFixed(3)}m onto the surface under it`);
          }
          continue;
        }
      }
      /*
       * STRIPPING IS DESTRUCTIVE, SO IT IS GATED ON EVIDENCE, NOT ON A BUDGET.
       *
       * The first version of this pass stripped anything the statics rejected and
       * was saved only by an action cap, which means the 48 things it removed were
       * chosen by their angular size and nothing else. That is how LevelSeat's own
       * first run came to lay the canopy purlins out on the courtyard.
       *
       * Removal now needs one of exactly two proofs, both of them unambiguous and
       * both of them describing something no viewer can read as intentional:
       *   · the object touches NOTHING AT ALL. Not "its support chain does not
       *     bottom out" — literally no other surface within 5 cm of it anywhere.
       *   · the object is PERCHED: every bit of bearing it has is on a rod, a
       *     cable or a wire. A slab balanced on a powerline.
       * Anything whose support is merely questionable is measured, named in the
       * console and left for the level's own author.
       */
      const untouched = c.px.length === 0;
      const perched = c.mode === 'PERCHED' && c.live <= STRIP_MAX_LIVE;
      if ((untouched || perched) && c.dim <= STRIP_MAX && c.faceMrad >= STRIP_FACE_MRAD) {
        for (const p of pieces) { removePiece(p); touched.add(p.mesh); }
        this.stats.stripped++;
        acted++;
        if (this.report.length < 14) {
          this.report.push(`STRIPPED ${label(c, pieces)} — ${untouched
            ? 'touching nothing at all' : 'balanced on a rod or cable'}`);
        }
        continue;
      }
      this.stats.left++;
      if (this.stuck.length < 12) {
        this.stuck.push(`${label(c, pieces)} — too large to strip and nothing under it`);
      }
    }
    refreshBounds(touched);
  }
}

/** One-line console summary. */
export function perchSummary(s) {
  return `${s.islands} islands from ${(s.triangles / 1000) | 0}k world triangles in `
    + `${s.meshes} meshes · ${s.candidates} loose objects judged BY STATICS, not by `
    + `proximity: ${s.resting} resting, ${s.fixed} bolted or welded, ${s.hung} slung, `
    + `${s.perched} PERCHED on a rod or cable, ${s.topple} in a pose nothing holds `
    + `→ ${s.actionable} panel-shaped and legible in frame with <= ${MAX_LIVE} live `
    + `contacts: ${s.dropped} DROPPED onto the surface under them, ${s.stripped} STRIPPED, `
    + `${s.unmovable} unmovable, ${s.left} left · ${s.ms | 0} ms`;
}
