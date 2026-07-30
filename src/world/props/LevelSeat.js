import * as THREE from 'three';
import {
  pieceMovable, movePiece, removePiece, refreshBounds, sharedGeometries,
} from './LevelSurgery.js';
import { sceneMeshes, triangleWalker, closestOnTri } from './LevelSeatScan.js';

/**
 * THE SEAT PASS. OWNER: props agent.
 *
 * ================= WHY THE PREVIOUS SIX ATTEMPTS DID NOT WORK ================
 * "Floating rusted plates" has been raised in seven consecutive reviews. Every
 * previous attempt shared three properties, and each one is fatal on its own:
 *
 *  1. THEY RAN TOO EARLY. Placer, ContactPass, FloatSweep and LevelFloatPass all
 *     run in the middle of Props._build, BEFORE Batcher.build(). At that moment
 *     the props half of the world does not exist as scene geometry yet — the
 *     instanced meshes and merged batches are still queues — so no pass could see
 *     the world the reviewer is looking at. THIS PASS RUNS LAST, over the same
 *     finished scene graph tools/floatcheck.mjs walks.
 *
 *  2. THEY WELDED TOO COARSELY. Islands were welded at a 0.28 m radius while
 *     "touching" meant 0.05 m, so anything between 5 cm and 28 cm from its
 *     neighbour was absorbed INTO the neighbour's island and could never be
 *     reported. That band is exactly where the defect lives: the vertical.png
 *     plate measured 9.9 cm, the ServiceYard deck plates 19.8 cm, the Foreground
 *     lagging 23.6 cm. tools/floatcheck.mjs had the same hole, and it is why that
 *     tool called the plate the reviewer named this round " HELD ". Here the weld
 *     radius IS the contact threshold, so the band cannot exist.
 *
 *  3. THEY DREW SUPPORT INSTEAD OF MAKING CONTACT. A tie, a stud or a bracket
 *     drawn across a gap does not close the gap. Round 9's console reported an
 *     island "tied to a surface 0.28m away" and floatcheck then measured 0.236 m
 *     of clear sky around that same island. The reviewer sees daylight, not
 *     hardware.
 *
 * ================= WHAT THIS PASS DOES =======================================
 * It measures the finished world the way the assertion measures it, and then
 * moves geometry until the measurement comes out clean:
 *
 *   A  weld every world triangle into islands at CELL (weld radius = CONTACT)
 *   B  collect real world vertices for every candidate island and a triangle grid
 *      around them
 *   C  for each candidate, the exact distance from its own vertices to the
 *      nearest triangle of a DIFFERENT island — never a bounding box, because a
 *      thin tilted slab has an AABB that is 96% air
 *   D  transitive support: an island is held if it touches a held island. Two
 *      floating plates 5 cm apart do not hold each other up.
 *   E  ACT.  seat  -> translate into contact with the nearest HELD surface
 *            drop  -> translate down onto the ground below it
 *            strip -> collapse it out of the frame
 *      plus SUNK: a ground plate with another island's floor surface passing
 *      through its own thickness is lifted until it rests ON that surface.
 *      "Resting on a surface" means touching it, not intersecting it.
 *
 * VERIFY WITH: node tools/floatcheck.mjs
 * That tool knows nothing about this pass and re-measures from the rendered scene
 * graph. If the two ever disagree, the tool is right.
 */

/**
 * TWO WELD RADII, SWEPT IN ORDER, AND THE SECOND IS EQUAL TO CONTACT.
 *
 * The fine radius is what closes the band the previous six attempts hid in:
 * weld at 0.28 m while "touching" means 0.05 m and every piece 5-28 cm from its
 * neighbour is absorbed into that neighbour and can never be judged.
 *
 * The coarse radius is not a legacy value, it catches a DIFFERENT defect, and
 * the measurement proving that is on record. After the fine sweep had taken
 * tools/floatcheck.mjs from 24 severe to 0 at the fine radius, that tool still
 * reported 13 at the coarse one -- among them the hero-golden lagging,
 * 1.23 x 1.24 x 1.25 m at (5.85, 3.49, 17.85) with 0.236 m of daylight, which is
 * one of the four instances the round-9 review named. Its pieces all pass the
 * fine test because they are touching EACH OTHER: the lagging, its partner and
 * the spacer studs round 9 drew form a cluster that is mutually in contact and
 * collectively in mid-air. Fine asks "does this piece float", coarse asks "does
 * this assembly float", and the reviewer sees both.
 *
 * Coarse runs first so an assembly is seated as a unit before its pieces are
 * judged individually.
 */
const WELDS = [0.14, 0.025];
/** Surfaces this close count as touching. Matches tools/floatcheck.mjs. */
const CONTACT = 0.05;
/** Residual gap left after a seat: touching, without interpenetrating. */
const SEATED = 0.004;
/** Below this an island is floor, kerb or paving and counts as support. */
const Y_GROUND = 0.42;
/** Above this is roofline: still measured, never dressed. */
const Y_MAX = 15.0;
/** Play envelope. Outside it is backdrop silhouette, which may float. */
const XZ_LIMIT = 56;
/** How far the nearest-surface search looks before giving up. */
const REACH = 1.4;
/** Furthest an island may be translated to bring it into contact. */
const SEAT_MAX = 0.75;
/**
 * Largest island this pass will REMOVE, as opposed to nudge.
 *
 * THIS CONSTANT IS THE SCAR OF A REAL MISTAKE. The first run of this pass had no
 * such limit and a "drop it to the ground below" fallback, and its console read
 * "DROPPED 9.60x0.14x0.09 [canopy|metal_rusted] by 5.129m" — it had started
 * dismantling the level's canopy and laying the purlins on the courtyard, because
 * a 9.6 m purlin resting on beams it does not share vertices with is, by
 * measurement, an isolated island. Nudging such a thing 5 cm into contact is
 * harmless and correct. Relocating it is vandalism.
 *
 * 2.6 m is above the largest object any of the seven reviews has pointed at (the
 * Interiors plate at 2.15 m) and far below the level's structural members.
 */
const STRIP_MAX = 2.6;
/** Nothing over this is dressing; it is the building. Measured, never moved far. */
const ACT_DIM = 4.0;
/** An island bigger or heavier than this is the building. Support, never dressed. */
const STRUCTURE_DIM = 12;
const STRUCTURE_TRIS = 4000;
/** Smallest island worth judging. */
const MIN_DIM = 0.09;
/** Angular size below which an unsupported object is not a visible defect. */
const MIN_ANGULAR = 0.012;
/**
 * Vertices sampled per candidate island.
 *
 * All THREE vertices of every sampled triangle are kept, not just the first.
 * Keeping one per triangle is how you measure a 2 m plate by one corner of each
 * facet and miss the tip that is actually touching something.
 */
const MAX_SAMPLES = 450;
/** Query grid cell, metres. */
const GRID = 0.5;
/**
 * Ground-plate intersection: how far inside the plate's own thickness another
 * island's floor surface has to pass before it counts as cutting through it.
 *
 * WAS 0.006 AND THAT WAS USELESS: it reported 685 "ground plates cut by a kerb",
 * which is every pallet top board and every grit patch in the level, because
 * near-coplanar dressing sits a few millimetres inside its own footprint's paving
 * by construction. 2 cm of intrusion is a visible cut and nothing sane produces
 * it by accident.
 */
const SUNK_MARGIN = 0.02;
/**
 * Furthest a sunk plate may be lifted, and it is deliberately small.
 *
 * A SECOND SCAR. With a 0.25 m budget and no thickness limit the first run
 * reported 137 sunk "plates" and lifted 127 of them, including
 * "LIFTED 3.00x0.20x1.60 [hall_int|metal_painted] by 0.182m" and a 1.7 x 3.2 m
 * `yard|concrete` slab — ramps and floor pans that are supposed to be let into
 * the paving. Lifting those does not fix a defect, it cuts a step into the floor.
 *
 * Only loose plate-shaped debris qualifies now, and only for a correction small
 * enough that it cannot create a visible step. Anything needing more is named in
 * the console and left alone, because lifting a plate that genuinely straddles a
 * kerb step only trades an intersection for a float.
 */
const SUNK_MAX = 0.16;
/** A sunk plate must be plate-shaped, loose-sized and legible in frame. */
const SUNK_MIN_THICK = 0.03;
const SUNK_MAX_THICK = 0.14;
const SUNK_MIN_DIM = 0.6;
const SUNK_MAX_DIM = 2.6;
const SUNK_MIN_ANG = 0.06;
/** Surfaces that are the building's floor and are never lifted out of it. */
const FLOOR_SURFACE = /concrete|poured|asphalt|terrain|paving|precast/i;

export class LevelSeatPass {
  constructor() {
    this.stats = {
      meshes: 0, triangles: 0, islands: 0, candidates: 0, structure: 0,
      held: 0, floating: 0, severe: 0, seated: 0, stripped: 0,
      sunk: 0, lifted: 0, floorLeft: 0, unmovable: 0, unfixable: 0, worstGap: 0, ms: 0,
    };
    /** What was done to the largest-in-frame offenders, for the console. */
    this.report = [];
    /** Islands this pass could not fix, named so the next round starts here. */
    this.stuck = [];
  }

  /**
   * @param {{scene: THREE.Scene}} ctx
   * @param {{x:number,y:number,z:number}[]} eyes shoot-rig camera positions
   */
  run(ctx, eyes = []) {
    const t0 = performance.now();
    try {
      const bypass = new URLSearchParams(location.search).get('noseat');
      if (bypass === '1') return this.stats;
    } catch { /* no URL context */ }
    for (const cell of WELDS) this._sweep(ctx, eyes, cell);
    this.stats.ms = performance.now() - t0;
    return this.stats;
  }

  /**
   * One sweep at one weld radius. Every counter accumulates across sweeps; the
   * world description (meshes / islands / candidates) is from the last one.
   *
   * @param {number} CELL weld cell size; the weld radius is 2x this
   */
  _sweep(ctx, eyes, CELL) {
    const meshes = sceneMeshes(ctx.scene);
    this.stats.meshes = meshes.length;
    if (!meshes.length) return this.stats;
    const each = triangleWalker(meshes, { xz: XZ_LIMIT, yMax: Y_MAX });

    /* ---- A: weld -------------------------------------------------------- */
    // Key packing is derived from CELL so it cannot silently wrap: the envelope
    // plus straddler slack is +-96 m, which is +-3844 cells at 0.025 m.
    const SPAN = Math.ceil((XZ_LIMIT + 40) / CELL) + 4;
    const SPANY = Math.ceil((Y_MAX + 24) / CELL) + 4;
    const SX = 2 * SPAN + 1, SY = 2 * SPANY + 1;
    const ids = new Map();
    const parent = [];
    let nCells = 0;
    const clamp = (i, lim) => (i < -lim ? -lim : (i > lim ? lim : i));
    const idOf = (ix0, iy0, iz0) => {
      const key = (clamp(ix0, SPAN) + SPAN) + (clamp(iy0, SPANY) + SPANY) * SX
        + (clamp(iz0, SPAN) + SPAN) * SX * SY;
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
        const id = idOf(
          Math.floor(v[k * 3] / CELL),
          Math.floor(v[k * 3 + 1] / CELL),
          Math.floor(v[k * 3 + 2] / CELL),
        );
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
      const root = kk[0];
      for (let j = 1; j < m; j++) {
        const ra = find(root), rb = find(kk[j]);
        if (ra !== rb) parent[rb] = ra;
      }
    });
    this.stats.triangles = triTotal;
    if (!triTotal) return this.stats;

    // Extents fold in a second sweep: a cell's final root is only known once
    // every union has been applied.
    const rootOf = new Int32Array(triTotal);
    const isle = new Map();
    let ti = 0;
    each((v, mi, ni, f, loX, hiX, loY, hiY, loZ, hiZ) => {
      const m = cellsOf(v); void m;
      const r = find(kk[0]);
      rootOf[ti++] = r;
      let c = isle.get(r);
      if (!c) {
        c = {
          root: r, tris: 0,
          min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity],
        };
        isle.set(r, c);
      }
      if (loX < c.min[0]) c.min[0] = loX; if (hiX > c.max[0]) c.max[0] = hiX;
      if (loY < c.min[1]) c.min[1] = loY; if (hiY > c.max[1]) c.max[1] = hiY;
      if (loZ < c.min[2]) c.min[2] = loZ; if (hiZ > c.max[2]) c.max[2] = hiZ;
      c.tris++;
      void mi; void ni; void f;
    });
    this.stats.islands = isle.size;

    /* ---- classify ------------------------------------------------------- */
    const angular = (c) => {
      const dim = Math.max(c.max[0] - c.min[0], c.max[1] - c.min[1], c.max[2] - c.min[2]);
      if (!eyes.length) return { ang: 1, d: 4 };
      let best = 0, near = Infinity;
      for (const e of eyes) {
        const d = Math.hypot(
          e.x - (c.min[0] + c.max[0]) / 2,
          (e.y ?? 1.7) - (c.min[1] + c.max[1]) / 2,
          e.z - (c.min[2] + c.max[2]) / 2,
        );
        const a = dim / Math.max(1, d);
        if (a > best) { best = a; near = d; }
      }
      return { ang: best, d: near };
    };

    const candidates = [];
    for (const c of isle.values()) {
      const dx = c.max[0] - c.min[0], dy = c.max[1] - c.min[1], dz = c.max[2] - c.min[2];
      c.dim = Math.max(dx, dy, dz);
      c.thick = Math.min(dx, dy, dz);
      if (c.dim > STRUCTURE_DIM || c.tris > STRUCTURE_TRIS) {
        c.structure = true; this.stats.structure++; continue;
      }
      if (Math.abs((c.min[0] + c.max[0]) / 2) > XZ_LIMIT) continue;
      if (Math.abs((c.min[2] + c.max[2]) / 2) > XZ_LIMIT) continue;
      if (c.dim < MIN_DIM || c.min[1] > Y_MAX) continue;
      const a = angular(c);
      c.ang = a.ang; c.eyeDist = a.d;
      if (c.min[1] < Y_GROUND) {
        // Ground band. Never judged for float — it is resting on the paving by
        // definition — but a near-horizontal plate down here is exactly where the
        // review found geometry intersecting a kerb, so it is measured for that.
        if (dy >= SUNK_MIN_THICK && dy <= SUNK_MAX_THICK && c.tris >= 8
          && c.dim >= SUNK_MIN_DIM && c.dim <= SUNK_MAX_DIM && a.ang >= SUNK_MIN_ANG) {
          c.groundPlate = true;
          candidates.push(c);
        }
        continue;
      }
      if (a.ang < MIN_ANGULAR) continue;
      c.judged = true;
      candidates.push(c);
    }
    this.stats.candidates = candidates.length;
    if (!candidates.length) return this.stats;

    /* ---- B: vertices + a triangle grid round the candidates ------------- */
    const want = new Set();
    for (const c of candidates) {
      c.verts = [];
      c.stride = Math.max(1, Math.ceil(c.tris / Math.max(1, MAX_SAMPLES / 3)));
      c.seen = 0;
      c.near = { d: Infinity, root: -1, px: 0, py: 0, pz: 0, vx: 0, vy: 0, vz: 0 };
      c.touch = new Set();
      c.underY = -Infinity;
      for (let x = Math.floor(c.min[0] - REACH); x <= Math.floor(c.max[0] + REACH); x++) {
        for (let z = Math.floor(c.min[2] - REACH); z <= Math.floor(c.max[2] + REACH); z++) {
          want.add(x * 4096 + z);
        }
      }
    }
    // A candidate is looked up by 1 m XZ cell so a triangle can find it cheaply.
    const byCell = new Map();
    for (const c of candidates) {
      for (let x = Math.floor(c.min[0] - REACH); x <= Math.floor(c.max[0] + REACH); x++) {
        for (let z = Math.floor(c.min[2] - REACH); z <= Math.floor(c.max[2] + REACH); z++) {
          const k = x * 4096 + z;
          let l = byCell.get(k);
          if (!l) { l = []; byCell.set(k, l); }
          l.push(c);
        }
      }
    }

    const tris = [];        // flat 9-float triangles, only those near candidates
    const triRoot = [];
    const triBox = [];      // 6 floats each, for the big-triangle path
    const big = [];
    const buckets = new Map();
    const gKey = (ix, iy, iz) => ix * 16777216 + iy * 4096 + iz;
    ti = 0;
    each((v, mi, ni, f, loX, hiX, loY, hiY, loZ, hiZ) => {
      const r = rootOf[ti++];
      /*
       * WHICH TRIANGLES ARE KEPT, AND THE BUG THAT WAS HERE.
       *
       * This tested only the triangle's centroid cell and its min corner, which
       * silently threw away the level's PAVING: a merged ground bucket contains
       * single triangles 100 m across, whose centroid is nowhere near the
       * candidate they are supporting. With the paving missing from the grid,
       * every island resting on it measured as floating and every "nearest held
       * surface" search missed the obvious answer — which is why this pass found
       * 61 severe floats and tools/floatcheck.mjs still found 28 afterwards. Any
       * overlapping cell now counts, and triangles too large to bucket cheaply go
       * on a separate list that every query scans by AABB.
       */
      const cx0 = Math.floor(loX), cx1 = Math.floor(hiX);
      const cz0 = Math.floor(loZ), cz1 = Math.floor(hiZ);
      const span = (cx1 - cx0 + 1) * (cz1 - cz0 + 1);
      let keep = false;
      if (span > 12) keep = true;                 // paving: always relevant
      else {
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
      // sample this triangle's vertices into any candidate it belongs to
      const list = byCell.get(Math.floor(loX) * 4096 + Math.floor(loZ))
        ?? byCell.get(Math.floor(hiX) * 4096 + Math.floor(hiZ));
      if (!list) return;
      for (const c of list) {
        if (c.root !== r) continue;
        if ((c.seen++ % c.stride) !== 0) break;
        if (c.verts.length >= MAX_SAMPLES * 3) break;
        c.verts.push(v[0], v[1], v[2], v[3], v[4], v[5], v[6], v[7], v[8]);
        break;
      }
      void mi; void ni; void f;
    });
    const triArr = new Float64Array(tris);
    const boxArr = new Float64Array(triBox);
    const triRootArr = new Int32Array(triRoot);
    const nTri = triRootArr.length;

    /* ---- C: exact distance to the nearest triangle of another island ---- */
    const stampArr = new Int32Array(nTri).fill(-1);
    const q = new THREE.Vector3();
    /** Every triangle within `rad` of the box, deduplicated by stamp. */
    const gather = (c, rad, out, stamp) => {
      out.length = 0;
      for (let ix = Math.floor((c.min[0] - rad) / GRID); ix <= Math.floor((c.max[0] + rad) / GRID); ix++) {
        for (let iy = Math.floor((c.min[1] - rad) / GRID); iy <= Math.floor((c.max[1] + rad) / GRID); iy++) {
          for (let iz = Math.floor((c.min[2] - rad) / GRID); iz <= Math.floor((c.max[2] + rad) / GRID); iz++) {
            const l = buckets.get(gKey(ix, iy, iz));
            if (!l) continue;
            for (const id of l) {
              if (stampArr[id] === stamp) continue;
              stampArr[id] = stamp;
              out.push(id);
            }
          }
        }
      }
      // Triangles too large to bucket — the paving, the merged terrain shells.
      // An AABB reject is enough; there are a few thousand of them.
      for (let i = 0; i < big.length; i++) {
        const id = big[i];
        if (stampArr[id] === stamp) continue;
        const b = id * 6;
        if (boxArr[b] - c.max[0] > rad || c.min[0] - boxArr[b + 1] > rad) continue;
        if (boxArr[b + 2] - c.max[1] > rad || c.min[1] - boxArr[b + 3] > rad) continue;
        if (boxArr[b + 4] - c.max[2] > rad || c.min[2] - boxArr[b + 5] > rad) continue;
        stampArr[id] = stamp;
        out.push(id);
      }
    };

    const local = [];
    let stamp = 0;
    /*
     * Roots that are NOT candidates: structure, the ground band, geometry too
     * small or too far out of frame to judge. Every one of them is support, and
     * knowing that BEFORE the nearest-surface search is what lets tier 2 record a
     * separate "nearest guaranteed-held surface" alongside the nearest surface of
     * any kind.
     *
     * That distinction is the whole of the remaining defect. After the two-radius
     * sweep, the four floats tools/floatcheck.mjs still reported were all pairs:
     * a pump housing 14 cm from another pump housing, a lamp head 12 cm from its
     * own shade. Each one's NEAREST surface is its partner, the partner is not
     * held, so a seat aimed at the nearest surface is refused — correctly, since
     * round 9's bug was aiming exactly there — and the pair floated on. The plinth
     * 25 cm below is not a candidate and was the answer all along.
     */
    const candRoots = new Set(candidates.map((c) => c.root));
    for (const c of candidates) {
      if (!c.verts.length) continue;
      c.anchor = { d: Infinity, px: 0, py: 0, pz: 0, vx: 0, vy: 0, vz: 0, root: -1 };
      // Tier 1 — anything overlapping the box by CONTACT. Clears the vast
      // majority of candidates in a handful of triangle tests each.
      gather(c, CONTACT, local, stamp++);
      const C2 = CONTACT * CONTACT;
      for (const id of local) {
        const r = triRootArr[id];
        if (r === c.root) continue;
        const off = id * 9;
        for (let i = 0; i < c.verts.length; i += 3) {
          const d2 = closestOnTri(c.verts[i], c.verts[i + 1], c.verts[i + 2],
            triArr.subarray(off, off + 9), q);
          if (d2 <= C2) {
            c.touch.add(r);
            if (d2 < c.near.d * c.near.d) {
              c.near.d = Math.sqrt(d2); c.near.root = r;
            }
            break;
          }
        }
        if (c.touch.size >= 2) break;
      }
      if (c.touch.size) { c.near.d = Math.min(c.near.d, CONTACT); continue; }

      // Tier 2 — a genuine float. Full search out to REACH, recording the vector
      // that would bring it into contact.
      gather(c, REACH, local, stamp++);
      let best = Infinity, bestHeld = Infinity;
      for (const id of local) {
        const r = triRootArr[id];
        if (r === c.root) continue;
        const off = id * 9;
        const solid = !candRoots.has(r);
        for (let i = 0; i < c.verts.length; i += 3) {
          const d2 = closestOnTri(c.verts[i], c.verts[i + 1], c.verts[i + 2],
            triArr.subarray(off, off + 9), q);
          if (d2 < best) {
            best = d2;
            c.near.root = r;
            c.near.px = q.x; c.near.py = q.y; c.near.pz = q.z;
            c.near.vx = c.verts[i]; c.near.vy = c.verts[i + 1]; c.near.vz = c.verts[i + 2];
          }
          if (solid && d2 < bestHeld) {
            bestHeld = d2;
            c.anchor.root = r;
            c.anchor.px = q.x; c.anchor.py = q.y; c.anchor.pz = q.z;
            c.anchor.vx = c.verts[i]; c.anchor.vy = c.verts[i + 1]; c.anchor.vz = c.verts[i + 2];
          }
        }
      }
      c.anchor.d = bestHeld === Infinity ? Infinity : Math.sqrt(bestHeld);
      c.near.d = best === Infinity ? Infinity : Math.sqrt(best);
      if (c.near.d <= CONTACT) c.touch.add(c.near.root);
    }

    /* ---- D: transitive support ------------------------------------------ */
    const byRoot = new Map();
    for (const c of candidates) byRoot.set(c.root, c);
    // A root that is not a candidate is structure, ground, out of frame or below
    // MIN_DIM. None of those is the defect, so all of them count as support.
    const held = new Set();
    for (const c of candidates) {
      for (const r of c.touch) if (!byRoot.has(r)) { held.add(c.root); break; }
      if (c.groundPlate) held.add(c.root);
    }
    for (let pass = 0; pass < 12; pass++) {
      let grew = false;
      for (const c of candidates) {
        if (held.has(c.root)) continue;
        for (const r of c.touch) {
          if (held.has(r)) { held.add(c.root); grew = true; break; }
        }
      }
      if (!grew) break;
    }
    /*
     * SEVERITY, COPIED FROM THE ASSERTION ON PURPOSE.
     *
     * tools/floatcheck.mjs fails the build on "panel-shaped object with visible
     * daylight all round it": median dimension >= 0.25 m, largest <= 4 m, gap
     * >= 8 cm, and both the face and the gap resolvable from a camera the shoot
     * rig uses (15 / 6 mrad). If this pass used a different definition it would
     * either leave the thing the assertion fails on, or start moving things the
     * assertion never asked about — and the second is how the first run of this
     * file came to relocate a canopy purlin. So the gate is the same gate, and
     * the only difference is a margin on the SEAT side, which is a 5 cm nudge and
     * cannot do harm.
     */
    for (const c of candidates) {
      c.held = held.has(c.root);
      const d = [c.max[0] - c.min[0], c.max[1] - c.min[1], c.max[2] - c.min[2]]
        .sort((a, b) => b - a);
      c.face = d[1];
      const eye = Math.max(1, c.eyeDist);
      c.faceMrad = (c.face / eye) * 1000;
      c.gapMrad = (Number.isFinite(c.near.d) ? c.near.d / eye : REACH / eye) * 1000;
      c.severe = c.face >= 0.25 && c.dim <= ACT_DIM && c.near.d >= 0.08
        && c.faceMrad >= 15 && c.gapMrad >= 6;
      c.actionable = c.judged && !c.held && c.dim <= ACT_DIM && c.face >= 0.18
        && c.faceMrad >= 10 && c.gapMrad >= 4;
      if (c.judged) {
        if (c.held) this.stats.held++;
        else { this.stats.floating++; if (c.severe) this.stats.severe++; }
      }
      if (!c.held && c.judged && Number.isFinite(c.near.d) && c.near.d > this.stats.worstGap) {
        this.stats.worstGap = c.near.d;
      }
    }

    /* ---- ground plates cut by a kerb ------------------------------------ */
    // A near-horizontal surface belonging to another island, passing through this
    // plate's own thickness inside its footprint, means the plate is intersecting
    // rather than resting. A crate the plate lies on is excluded twice over: its
    // top face is outside the plate's span by SUNK_MARGIN, and its sides fail the
    // normal test.
    for (const c of candidates) {
      if (!c.groundPlate) continue;
      gather(c, 0, local, stamp++);
      const inx0 = c.min[0] + 0.03, inx1 = c.max[0] - 0.03;
      const inz0 = c.min[2] + 0.03, inz1 = c.max[2] - 0.03;
      for (const id of local) {
        if (triRootArr[id] === c.root) continue;
        const o = id * 9;
        const cy = (triArr[o + 1] + triArr[o + 4] + triArr[o + 7]) / 3;
        // Above the plate's underside by a visible margin, and not above its top.
        // The lower bound is what excludes the surface the plate is RESTING on;
        // the upper bound has to reach the top face, because the case the review
        // pointed at is near-coplanar — a paving slab and a rusted plate fighting
        // for the same few millimetres — not a plate buried halfway.
        if (cy <= c.min[1] + SUNK_MARGIN || cy > c.max[1] + 0.002) continue;
        const cx = (triArr[o] + triArr[o + 3] + triArr[o + 6]) / 3;
        const cz = (triArr[o + 2] + triArr[o + 5] + triArr[o + 8]) / 3;
        if (cx < inx0 || cx > inx1 || cz < inz0 || cz > inz1) continue;
        // upward-facing?
        const ux = triArr[o + 3] - triArr[o], uy = triArr[o + 4] - triArr[o + 1];
        const uz = triArr[o + 5] - triArr[o + 2];
        const wx = triArr[o + 6] - triArr[o], wy = triArr[o + 7] - triArr[o + 1];
        const wz = triArr[o + 8] - triArr[o + 2];
        const ny = uz * wx - ux * wz;
        const nl = Math.hypot(uy * wz - uz * wy, ny, ux * wy - uy * wx);
        if (nl < 1e-9 || Math.abs(ny) / nl < 0.6) continue;
        if (cy > c.underY) c.underY = cy;
      }
      if (c.underY > -Infinity) {
        c.sunk = c.underY - c.min[1] + SEATED;
        if (c.sunk > SUNK_MARGIN && c.sunk <= SUNK_MAX) this.stats.sunk++;
        else c.sunk = 0;
      }
    }

    /* ---- E: act --------------------------------------------------------- */
    const targets = candidates.filter((c) => c.actionable || c.sunk > 0);
    if (!targets.length) return this.stats;
    const wanted = new Map();
    for (const c of targets) wanted.set(c.root, c);

    // Provenance for the islands about to be edited, and only those.
    for (const c of targets) c.pieces = new Map();
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
    // Most visible first, so the console names what a reviewer would circle.
    targets.sort((a, b) => b.ang - a.ang);
    const label = (c, pieces) => `${(c.max[0] - c.min[0]).toFixed(2)}x`
      + `${(c.max[1] - c.min[1]).toFixed(2)}x${(c.max[2] - c.min[2]).toFixed(2)} `
      + `(${(c.ang * 1000) | 0}mrad) @${((c.min[0] + c.max[0]) / 2).toFixed(1)},`
      + `${((c.min[1] + c.max[1]) / 2).toFixed(1)},${((c.min[2] + c.max[2]) / 2).toFixed(1)} `
      + `[${pieces[0]?.mesh?.name || '?'}]`;

    /*
     * SEATING RESOLVES IN ROUNDS, because a float can be resting on a float.
     *
     * The lagging in hero-golden is two pieces 3 cm apart, both in mid-air. Seat
     * the first onto its pipe and the second is instantly supported by the first;
     * judge them once, in one pass, and the second is "floating 3 cm clear of
     * something that is not held" and gets reported as unfixable. Round 9 made the
     * mirror-image mistake in the other direction — it strapped one to the other
     * and called both fixed — so this deliberately never treats an unheld island
     * as an anchor, and instead re-asks the question after each round of seating.
     */
    const decided = new Set();
    for (let round = 0; round < 4; round++) {
      let acted = 0;
      for (const c of targets) {
        if (decided.has(c)) continue;
        const pieces = [...c.pieces.values()];
        let reason = null;
        for (const p of pieces) {
          const r = pieceMovable(p, shared);
          if (r) { reason = r; break; }
        }
        if (reason) {
          decided.add(c);
          this.stats.unmovable++;
          if (this.stuck.length < 12) this.stuck.push(`${label(c, pieces)} — ${reason}`);
          continue;
        }

        let dx = 0, dy = 0, dz = 0, act = '';
        if (c.sunk > 0 && !c.actionable) {
          // Never lift the building's own floor out of itself — see SUNK_MAX.
          const floor = pieces.some((p) => {
            const m = Array.isArray(p.mesh.material) ? p.mesh.material[0] : p.mesh.material;
            return FLOOR_SURFACE.test(m?.userData?.surface ?? '')
              || FLOOR_SURFACE.test(p.mesh.name ?? '');
          });
          if (floor) {
            decided.add(c);
            this.stats.floorLeft++;
            continue;
          }
          dy = c.sunk; act = 'LIFTED';
        } else {
          /*
           * Pick the target: the nearest surface if it is held, otherwise the
           * nearest surface that CANNOT be floating. Never an unheld candidate —
           * that is round 9's bug, where a panel was strapped to a lagging sleeve
           * that was itself in the air and both were reported fixed.
           */
          let t = null;
          if (Number.isFinite(c.near.d) && c.near.d <= SEAT_MAX && c.near.root >= 0
            && (held.has(c.near.root) || !byRoot.has(c.near.root))) t = c.near;
          else if (c.anchor && Number.isFinite(c.anchor.d) && c.anchor.d <= SEAT_MAX
            && c.anchor.root >= 0) t = c.anchor;
          if (t) {
            const gx = t.px - t.vx, gy = t.py - t.vy, gz = t.pz - t.vz;
            const len = Math.hypot(gx, gy, gz) || 1;
            const sc = Math.max(0, (len - SEATED) / len);
            dx = gx * sc; dy = gy * sc; dz = gz * sc;
            act = 'SEATED';
          }
        }
        if (!act) {
          if (round < 3) continue;      // wait: its anchor may yet become held
          if (c.dim <= STRIP_MAX) act = 'STRIPPED';
          else {
            // Too big to remove and nothing within a bracket's span to seat
            // against. Named rather than guessed at — see STRIP_MAX.
            decided.add(c);
            this.stats.unfixable++;
            if (this.stuck.length < 12) {
              this.stuck.push(`${label(c, pieces)} — floating ${Number.isFinite(c.near.d)
                ? `${(c.near.d * 100) | 0}cm` : `>${(REACH * 100) | 0}cm`} clear, too large to strip`);
            }
            continue;
          }
        }

        decided.add(c);
        acted++;
        if (act === 'STRIPPED') {
          for (const p of pieces) { removePiece(p); touched.add(p.mesh); }
          this.stats.stripped++;
        } else {
          for (const p of pieces) { movePiece(p, dx, dy, dz); touched.add(p.mesh); }
          if (act === 'SEATED') { this.stats.seated++; held.add(c.root); } else this.stats.lifted++;
        }
        if (this.report.length < 12) {
          this.report.push(`${act} ${label(c, pieces)} by ${Math.hypot(dx, dy, dz).toFixed(3)}m`);
        }
      }
      // Anything now touching a seated island is held, transitively.
      for (let p = 0; p < 12; p++) {
        let grew = false;
        for (const c of candidates) {
          if (held.has(c.root)) continue;
          for (const r of c.touch) if (held.has(r)) { held.add(c.root); grew = true; break; }
        }
        if (!grew) break;
      }
      if (!acted && round >= 3) break;
    }
    refreshBounds(touched);
    return this.stats;
  }
}

/** One-line console summary. */
export function seatSummary(s) {
  return `${s.islands} islands from ${(s.triangles / 1000) | 0}k world triangles in `
    + `${s.meshes} meshes · ${s.candidates} judged: ${s.held} held, ${s.floating} floating `
    + `of which ${s.severe} SEVERE by the assertion's own gate (worst gap `
    + `${s.worstGap.toFixed(3)}m) → ${s.seated} SEATED into contact, `
    + `${s.stripped} stripped out of frame; ${s.sunk} ground plate(s) cut by a surface, `
    + `${s.lifted} lifted clear (${s.floorLeft} left: the level's own floor); `
    + `${s.unmovable} unmovable, ${s.unfixable} too large to strip · ${s.ms | 0} ms`;
}
