#!/usr/bin/env node
/**
 * SUPPORTCHECK — does every visible object in the world have something HOLDING IT
 * UP, as opposed to merely something NEAR IT?
 *
 * ================== WHY A SECOND FLOAT TOOL EXISTS ==========================
 * "Floating rusted plates" has now been raised in EIGHT consecutive reviews and
 * seven rounds have attacked it. tools/floatcheck.mjs was round 9's answer and it
 * is a good instrument: it welds world triangles into islands and measures real
 * vertex-to-triangle daylight. Round 11 opened by pointing it at the plate the
 * round-10 reviewer circled in hero-overcast — the pale slab hanging in the sky at
 * the top-left of the frame, pixel (480, 90), world (8.8, 3.3, 15.9). floatcheck's
 * verdict:
 *
 *      HELD  0.65 x 0.33 x 0.57 m  @ 8.92, 3.36, 16
 *            DAYLIGHT to nearest other surface: 0.034 m
 *
 * It is not floating. It is 3.4 cm from a 4 cm rusty rod that clips one bottom
 * corner of it, and it hangs off that corner at 30 degrees with sky on five sides.
 * THE MEASUREMENT WAS RIGHT AND THE QUESTION WAS WRONG. Every pass in this project
 * — Contact.js, Float.js, LevelFloat.js, LevelTies.js, LevelSeat.js — asks
 * "is anything within 5 cm of this?" and stops there. Proximity is not support. A
 * reviewer does not measure daylight, they read whether the object could possibly
 * be where it is, and a slab balanced on the tip of a rod fails that instantly
 * whether the gap is 3 cm or 30.
 *
 * That is why seven reseat passes all reported success while the plates stayed:
 * the plates were never in the "floating" population. They were in the SUPPORTED
 * population, held there by a tangent.
 *
 * ================== WHAT THIS MEASURES ======================================
 * The same island decomposition, then statics instead of proximity.
 *
 *   1. ISLANDS.       Triangles welded by union-find over a cell grid, exactly as
 *                     floatcheck does, at two radii (assembly and piece).
 *   2. CENTRE OF MASS. Area-weighted centroid of the island's own triangles. Not
 *                     the AABB centre: a bent plate's AABB centre is in mid-air.
 *   3. THE CONTACT SET. Every point where another island's surface comes within
 *                     CONTACT of this island's surface, deduplicated onto a 5 cm
 *                     grid, split into BEARING contacts (at or below the centre of
 *                     mass — these can push up) and OVERHEAD contacts (above it —
 *                     these can only hang).
 *   4. THE VERDICT.   An object stands up if any one of these is true:
 *                       RESTING  the centre of mass projects inside the footprint
 *                                of its bearing contacts (the support polygon,
 *                                approximated by its XZ box), and that footprint
 *                                is wider than a tangent.
 *                       FIXED    the contact patch covers enough of the object's
 *                                own largest face to read as bolted or welded flat
 *                                against something — a wall sign, a bracketed
 *                                panel, lagging clamped round a pipe.
 *                       HUNG     overhead contacts spanning enough of the object
 *                                to read as suspended from above.
 *                     Anything else is reported. TOPPLE = touching, but nothing
 *                     under, across or over it that could hold it in that pose.
 *                     AIRBORNE = nothing at all within NEAR (0.3 m), the literal
 *                     test the brief asks for and the weaker of the two.
 *
 * ================== HOW THE GATE WAS CALIBRATED =============================
 * Not chosen — fitted, against objects in the round-10 frames that were looked at
 * in magnified crops first and classified by eye, then measured:
 *
 *   floating by eye, hero-overcast (480,90)   fg|metal_painted  bearing span 0.00
 *   floating by eye, hero-overcast (1250,90)  fg|fabric         bearing span 0.00
 *   fine by eye, the wall-mounted junction boxes                face coverage 0.21
 *   fine by eye, crates and pallets on the apron                CoM inside bearing
 *
 * See CFG for what each number means and what it costs to move it.
 *
 * ================== MODES ===================================================
 *   node tools/supportcheck.mjs                 assert; non-zero if anything floats
 *   node tools/supportcheck.mjs --all           every candidate, verdict and metrics
 *   node tools/supportcheck.mjs --at x,y,z      full metric dump for one object
 *   node tools/supportcheck.mjs --cell 0.025    pin one weld radius
 *   node tools/supportcheck.mjs --json out.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));

/** shoot.mjs's camera list, parsed as TEXT — importing it runs the whole rig. */
function shootViews() {
  const src = fs.readFileSync(path.join(here, 'shoot.mjs'), 'utf8');
  const out = [];
  for (const m of src.matchAll(/\{\s*name:\s*'([\w-]+)',[^}]*?pos:\s*'([-\d.,]+)'[^}]*?\}/g)) {
    const [x, y, z] = m[2].split(',').map(Number);
    const tod = m[0].match(/tod:\s*'(\w+)'/);
    const num = (k, d) => {
      const g = m[0].match(new RegExp(k + ':\\s*(-?[\\d.]+)'));
      return g ? Number(g[1]) : d;
    };
    out.push({
      name: m[1], pos: m[2], x, y, z, yaw: num('yaw', 0), pitch: num('pitch', 0),
      tod: tod ? tod[1] : 'golden',
    });
  }
  if (!out.length) throw new Error('supportcheck: could not parse VIEWS out of tools/shoot.mjs');
  return out;
}

const VIEWS = shootViews();
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const flag = (n) => args.includes('--' + n);

const url = opt('url', 'http://127.0.0.1:5180');
const viewName = opt('view', 'hero-overcast');
const view = VIEWS.find((v) => v.name === viewName) ?? VIEWS[0];

const CFG = {
  /** Weld cell. Radius is 2x. Assembly-scale then piece-scale, both asserted. */
  cell: 0.14,
  /** Surfaces this close are in contact. Same value the whole project uses. */
  contact: 0.05,
  /** Nothing within this at all = AIRBORNE. The brief's literal test. */
  near: 0.30,
  /** How far the nearest-surface search looks before giving up. */
  reach: 0.9,
  /** Below this everything is floor, kerb and paving; it is support, not a suspect. */
  yMin: 0.42,
  /** Above this is roofline — structure, out of a player's read. */
  yMax: 15.0,
  /** Play envelope. Outside it is backdrop silhouette, which may float. */
  xzLimit: 56,
  /** Smallest island worth judging. */
  minDim: 0.09,
  /** Bigger or heavier than this IS the building. Support, never a suspect. */
  structureDim: 12,
  structureTris: 4000,
  /** Angular size below which an unsupported object is not a visible defect. */
  minAngular: 0.012,
  /** Vertices sampled per island. See floatcheck's note on why this is not 400. */
  maxSamples: 4000,
  /** Contact points are deduplicated onto this grid before anything is measured. */
  patch: 0.05,
  /** Stop accumulating once an island is obviously well held. */
  maxPatches: 400,

  /* ---- the statics gate ------------------------------------------------- */
  /**
   * RESTING. The centre of mass has to project inside the XZ box of the bearing
   * contacts, inflated by this. 4 cm is a bootlace of slop: it forgives a crate
   * whose corner contact is sampled a cell short, and it does NOT forgive the
   * hero-overcast slab, whose centre of mass is 0.21 m outside its only contact.
   */
  restSlop: 0.04,
  /**
   * ...and that footprint has to be wider than a tangent. A slab touching a rod
   * along a line has a bearing box one cell wide across the line. Two cells is
   * the minimum that can be called a footprint rather than a point.
   */
  restSpan: 0.10,
  /**
   * FIXED. Contact patch area as a fraction of the island's own largest face.
   * A junction box screwed to a wall measures 0.21; lagging clamped round a pipe
   * 0.16; the slab on the rod 0.013. 0.05 sits an order of magnitude clear of the
   * offender and half an order below the cheapest genuine fixing in the level.
   */
  fixCoverage: 0.05,
  /** ...with at least this many patches, so one big triangle cannot fake it. */
  fixPatches: 4,
  /**
   * Distinct 5 cm contact cells that constitute a SEAM regardless of coverage.
   * Calibrated on the two ends of the population: the stair stringer welded down
   * its newel post has 24 and is obviously fine; the panel balanced on two rods in
   * hero-overcast has 7 and is the defect. 12 sits between them with a factor of
   * two either way.
   */
  seamPatches: 12,
  /**
   * HUNG. Overhead contacts have to span this fraction of the object's own
   * horizontal size before "suspended" is a reading a viewer would accept. Below
   * it the object is pivoting on a point in the sky, which looks exactly as wrong
   * as balancing on one.
   */
  hangSpan: 0.45,
  hangPatches: 3,

  /* ---- what fails the build --------------------------------------------- */
  /**
   * SEVERE, and deliberately the same shape of gate as floatcheck's: a
   * panel-shaped object, big enough in frame to read, in an impossible pose.
   * Everything measured is printed; only this class sets the exit code, because a
   * gate that fails on 400 structural tolerances gets switched off and that is how
   * this defect survived seven rounds.
   */
  severeFace: 0.25,
  severeDim: 4.0,
  severeFaceMrad: 15,
  maxReport: 20,
  at: null,
  dumpAll: false,
};
const atOpt = opt('at', null);
if (atOpt) CFG.at = atOpt.split(';').map((p) => p.split(',').map(Number));
for (const k of ['cell', 'contact', 'near', 'reach', 'restSpan', 'fixCoverage']) {
  const v = opt(k, null);
  if (v !== null) CFG[k] = Number(v);
}
const listAll = flag('all');
const jsonOut = opt('json', null);
if (jsonOut) CFG.dumpAll = true;

const EYES = VIEWS.map((v) => ({ name: v.name, x: v.x, y: v.y, z: v.z }))
  .filter((e) => Number.isFinite(e.x));

/* ------------------------------------------------------------------ page side */

const PROBE = /* js */ `(cfg, eyes) => {
  const eng = window.__blacksite && window.__blacksite.engine;
  if (!eng) return { error: 'no engine' };

  /* ---- which meshes are in play ---------------------------------------- */
  // Camera-locked shells and per-frame FX only. Tested over the WHOLE ancestor
  // chain: muzzle-flash cards are anonymous children of a named group, and a
  // muzzle flash IS a panel hanging in mid-air. No backticks in this template.
  const SKIP = /sky|cloud|star|moon|sun|aurora|volumetric|debug|helper|gizmo|impact|tracer|muzzle|decal:|particle/i;
  const items = [];
  eng.scene.traverseVisible((o) => {
    if (!(o.isMesh || o.isInstancedMesh)) return;
    if (!o.geometry || !o.geometry.attributes || !o.geometry.attributes.position) return;
    for (let p = o; p; p = p.parent) if (SKIP.test(p.name || '')) return;
    const chain = [];
    for (let p = o; p; p = p.parent) chain.push(o === p ? (o.name || o.type) : (p.name || p.type));
    items.push({ obj: o, chain: chain.join(' < ') });
  });
  if (!items.length) return { error: 'no geometry in scene' };

  const V = new Float64Array(9);
  const im = new (eng.camera.matrixWorld.constructor)();
  const tmp = new (eng.camera.position.constructor)();
  const eachTriangle = (fn) => {
    for (let ii = 0; ii < items.length; ii++) {
      const o = items[ii].obj;
      o.updateMatrixWorld(true);
      const geo = o.geometry;
      const pos = geo.attributes.position;
      const idx = geo.index;
      const count = idx ? idx.count : pos.count;
      const insts = o.isInstancedMesh ? o.count : 1;
      for (let n = 0; n < insts; n++) {
        if (o.isInstancedMesh) { o.getMatrixAt(n, im); im.premultiply(o.matrixWorld); }
        else im.copy(o.matrixWorld);
        for (let f = 0; f + 2 < count; f += 3) {
          let loX = Infinity, hiX = -Infinity, loY = Infinity, hiY = -Infinity;
          let loZ = Infinity, hiZ = -Infinity;
          for (let k = 0; k < 3; k++) {
            const vi = idx ? idx.getX(f + k) : f + k;
            tmp.fromBufferAttribute(pos, vi).applyMatrix4(im);
            V[k * 3] = tmp.x; V[k * 3 + 1] = tmp.y; V[k * 3 + 2] = tmp.z;
            if (tmp.x < loX) loX = tmp.x; if (tmp.x > hiX) hiX = tmp.x;
            if (tmp.y < loY) loY = tmp.y; if (tmp.y > hiY) hiY = tmp.y;
            if (tmp.z < loZ) loZ = tmp.z; if (tmp.z > hiZ) hiZ = tmp.z;
          }
          if (hiY < -2 || loY > cfg.yMax + 4) continue;
          if (loX > cfg.xzLimit || hiX < -cfg.xzLimit) continue;
          if (loZ > cfg.xzLimit || hiZ < -cfg.xzLimit) continue;
          fn(V, ii, loX, hiX, loY, hiY, loZ, hiZ);
        }
      }
    }
  };

  /* ---- A: weld ---------------------------------------------------------- */
  // Strides derived from cfg.cell, never hard-coded: at 0.025 m a hard-coded
  // +-2048 offset wraps and welds two cells 56 m apart into one island.
  const SPAN = Math.ceil((cfg.xzLimit + 40) / cfg.cell) + 4;
  const SPANY = Math.ceil((cfg.yMax + 24) / cfg.cell) + 4;
  const SX = 2 * SPAN + 1, SY = 2 * SPANY + 1;
  if (SX * SY * SX > Number.MAX_SAFE_INTEGER) {
    return { error: 'supportcheck: cell ' + cfg.cell + ' m is too fine to key safely' };
  }
  const ids = new Map();
  const parent = [];
  let nCells = 0;
  const cl = (i, lim) => (i < -lim ? -lim : (i > lim ? lim : i));
  const idOf = (ix, iy, iz) => {
    const key = (cl(ix, SPAN) + SPAN) + (cl(iy, SPANY) + SPANY) * SX + (cl(iz, SPAN) + SPAN) * SX * SY;
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
      const id = idOf(Math.floor(v[k * 3] / cfg.cell), Math.floor(v[k * 3 + 1] / cfg.cell),
        Math.floor(v[k * 3 + 2] / cfg.cell));
      let dup = false;
      for (let j = 0; j < m; j++) if (kk[j] === id) { dup = true; break; }
      if (!dup) kk[m++] = id;
    }
    return m;
  };

  const T = [performance.now()];
  const mark = () => T.push(performance.now());

  let triTotal = 0;
  eachTriangle((v) => {
    triTotal++;
    const m = cellsOf(v);
    for (let j = 1; j < m; j++) {
      const ra = find(kk[0]), rb = find(kk[j]);
      if (ra !== rb) parent[rb] = ra;
    }
  });
  mark();

  /* ---- B: extents, triangle count, AREA-WEIGHTED CENTRE OF MASS --------- */
  /*
   * The centre of mass is the whole reason this pass can answer a question
   * floatcheck cannot, so it is accumulated from real triangle areas rather than
   * taken as the AABB centre. A bent plate, an L-bracket and a length of angle all
   * have an AABB centre that is in the air outside the material; balancing the
   * statics test on that point would report a shelf bracket screwed to a wall as
   * impossible.
   */
  const roots = new Int32Array(triTotal);
  const isle = new Map();
  let ti = 0;
  eachTriangle((v, ii, loX, hiX, loY, hiY, loZ, hiZ) => {
    cellsOf(v);
    const r = find(kk[0]);
    roots[ti++] = r;
    let c = isle.get(r);
    if (!c) {
      c = {
        root: r, tris: 0, area: 0, cx: 0, cy: 0, cz: 0,
        min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity],
        items: new Set(),
      };
      isle.set(r, c);
    }
    if (loX < c.min[0]) c.min[0] = loX; if (hiX > c.max[0]) c.max[0] = hiX;
    if (loY < c.min[1]) c.min[1] = loY; if (hiY > c.max[1]) c.max[1] = hiY;
    if (loZ < c.min[2]) c.min[2] = loZ; if (hiZ > c.max[2]) c.max[2] = hiZ;
    const ux = v[3] - v[0], uy = v[4] - v[1], uz = v[5] - v[2];
    const wx = v[6] - v[0], wy = v[7] - v[1], wz = v[8] - v[2];
    const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    const a = 0.5 * Math.hypot(nx, ny, nz);
    c.area += a;
    c.cx += a * (v[0] + v[3] + v[6]) / 3;
    c.cy += a * (v[1] + v[4] + v[7]) / 3;
    c.cz += a * (v[2] + v[5] + v[8]) / 3;
    c.tris++;
    if (c.items.size < 6) c.items.add(ii);
  });
  mark();

  /* ---- candidates ------------------------------------------------------- */
  const angular = (c) => {
    const cx = (c.min[0] + c.max[0]) / 2, cy = (c.min[1] + c.max[1]) / 2;
    const cz = (c.min[2] + c.max[2]) / 2;
    let best = 0, near = Infinity, from = '';
    for (const e of eyes) {
      const d = Math.hypot(e.x - cx, e.y - cy, e.z - cz);
      const a = c.dim / Math.max(1, d);
      if (a > best) { best = a; from = e.name; }
      if (d < near) near = d;
    }
    return { ang: best, d: Math.max(1, near), from: from };
  };

  const candidates = [];
  const islands = [];
  for (const c of isle.values()) {
    const dx = c.max[0] - c.min[0], dy = c.max[1] - c.min[1], dz = c.max[2] - c.min[2];
    c.dim = Math.max(dx, dy, dz);
    const sorted = [dx, dy, dz].sort((a, b) => b - a);
    c.face = sorted[1];
    c.faceArea = sorted[0] * sorted[1];
    /*
     * A CARD IS NOT A PLATE.
     *
     * Decal quads — prop:grime, prop:decal, the painted floor marks — are exactly
     * zero thick, two triangles, alpha-blended and drawn with a polygon offset.
     * They have four vertices in total, all of them corners, so a 3 m stain lying
     * across a barrier top measures every one of its sampled points in mid-air
     * where the barrier stops: 301 of the first run's 573 SEVERE findings were
     * that artefact. They also cannot read as a floating plate, having no
     * thickness and no silhouette. They are still measured, still classed and
     * still counted — CARD — and they do not set the exit code.
     */
    c.card = Math.min(dx, dy, dz) < 0.005;
    c.span = Math.max(dx, dz);
    if (c.area > 0) { c.cx /= c.area; c.cy /= c.area; c.cz /= c.area; }
    islands.push(c);
    if (c.dim > cfg.structureDim || c.tris > cfg.structureTris) { c.structure = true; continue; }
    if (c.min[1] < cfg.yMin) continue;           // ground band: resting by definition
    if (c.min[1] > cfg.yMax) continue;
    if (c.dim < cfg.minDim) continue;
    if (Math.abs((c.min[0] + c.max[0]) / 2) > cfg.xzLimit) continue;
    if (Math.abs((c.min[2] + c.max[2]) / 2) > cfg.xzLimit) continue;
    const a = angular(c);
    if (a.ang < cfg.minAngular) continue;
    c.ang = a.ang; c.eyeDist = a.d; c.eyeName = a.from;
    c.candidate = true;
    candidates.push(c);
  }

  /* ---- C: real vertices ------------------------------------------------- */
  const grid = new Map();
  for (const c of candidates) {
    c.verts = [];
    c.stride = Math.max(1, Math.ceil((c.tris * 3) / cfg.maxSamples));
    c.seen = 0;
    c.gap = Infinity;
    c.nearRoot = -1;
    c.nearItem = -1;
    /** contact patch cell key -> the island root that produced it. */
    c.patches = new Map();
    c.px = []; c.py = []; c.pz = []; c.pr = [];
    /** Bearing from non-candidate, non-slender geometry: the early-exit proof. */
    c.solid = { n: 0, x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity };
    c.touch = new Set();
    c.done = false;
    for (let x = Math.floor(c.min[0] - cfg.reach); x <= Math.floor(c.max[0] + cfg.reach); x++) {
      for (let z = Math.floor(c.min[2] - cfg.reach); z <= Math.floor(c.max[2] + cfg.reach); z++) {
        const k = x + ',' + z;
        let l = grid.get(k);
        if (!l) { l = []; grid.set(k, l); }
        l.push(c);
      }
    }
  }
  if (candidates.length) {
    ti = 0;
    eachTriangle((v) => {
      const r = roots[ti++];
      for (let k = 0; k < 3; k++) {
        const x = v[k * 3], y = v[k * 3 + 1], z = v[k * 3 + 2];
        const l = grid.get(Math.floor(x) + ',' + Math.floor(z));
        if (!l) continue;
        for (const c of l) {
          if (c.root !== r) continue;
          if (x < c.min[0] - 0.002 || x > c.max[0] + 0.002) continue;
          if (y < c.min[1] - 0.002 || y > c.max[1] + 0.002) continue;
          if (z < c.min[2] - 0.002 || z > c.max[2] + 0.002) continue;
          if ((c.seen++ % c.stride) !== 0) break;
          if (c.verts.length >= cfg.maxSamples * 3) break;
          c.verts.push(x, y, z);
          break;
        }
      }
    });
  }
  mark();

  /* ---- D: the contact set ---------------------------------------------- */
  const dist2ToTri = (px, py, pz, v, out) => {
    const ax = v[0], ay = v[1], az = v[2];
    const bx = v[3], by = v[4], bz = v[5];
    const cx = v[6], cy = v[7], cz = v[8];
    const abx = bx - ax, aby = by - ay, abz = bz - az;
    const acx = cx - ax, acy = cy - ay, acz = cz - az;
    const apx = px - ax, apy = py - ay, apz = pz - az;
    const d1 = abx * apx + aby * apy + abz * apz;
    const d2 = acx * apx + acy * apy + acz * apz;
    let qx, qy, qz;
    if (d1 <= 0 && d2 <= 0) { qx = ax; qy = ay; qz = az; } else {
      const bpx = px - bx, bpy = py - by, bpz = pz - bz;
      const d3 = abx * bpx + aby * bpy + abz * bpz;
      const d4 = acx * bpx + acy * bpy + acz * bpz;
      if (d3 >= 0 && d4 <= d3) { qx = bx; qy = by; qz = bz; } else {
        const vc = d1 * d4 - d3 * d2;
        if (vc <= 0 && d1 >= 0 && d3 <= 0) {
          const t = d1 / (d1 - d3);
          qx = ax + abx * t; qy = ay + aby * t; qz = az + abz * t;
        } else {
          const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
          const d5 = abx * cpx + aby * cpy + abz * cpz;
          const d6 = acx * cpx + acy * cpy + acz * cpz;
          if (d6 >= 0 && d5 <= d6) { qx = cx; qy = cy; qz = cz; } else {
            const vb = d5 * d2 - d1 * d6;
            if (vb <= 0 && d2 >= 0 && d6 <= 0) {
              const t = d2 / (d2 - d6);
              qx = ax + acx * t; qy = ay + acy * t; qz = az + acz * t;
            } else {
              const va = d3 * d6 - d5 * d4;
              if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
                const t = (d4 - d3) / ((d4 - d3) + (d5 - d6));
                qx = bx + (cx - bx) * t; qy = by + (cy - by) * t; qz = bz + (cz - bz) * t;
              } else {
                const den = 1 / (va + vb + vc);
                const vv = vb * den, ww = vc * den;
                qx = ax + abx * vv + acx * ww;
                qy = ay + aby * vv + acy * ww;
                qz = az + abz * vv + acz * ww;
              }
            }
          }
        }
      }
    }
    out[0] = qx; out[1] = qy; out[2] = qz;
    const dx = px - qx, dy = py - qy, dz = pz - qz;
    return dx * dx + dy * dy + dz * dz;
  };

  const byRoot = new Map();
  for (const c of candidates) byRoot.set(c.root, c);
  const Q = new Float64Array(3);

  /*
   * IS THE THING UNDERNEATH SUBSTANTIAL, OR IS IT A WIRE?
   *
   * This is the measurement the whole round turns on. The object the round-10
   * reviewer circled in hero-overcast — a 1.7 m pale panel at (8.9, 3.4, 16.0),
   * tilted 30 degrees with sky on five sides — is in contact. It is RESTING, in
   * the strict statics sense: it sits on two rusty rods that cross beneath it and
   * its centre of mass is 4 cm from the middle of them. Every proximity test in
   * this project passes it and so does a naive statics test.
   *
   * What a viewer actually reads is that a precast panel is balanced on two 4 cm
   * cables. So a support is judged by its own build: an island whose MEDIAN
   * dimension is under this is a rod, a cable, a wire or a conduit. Things do not
   * sit on those. Bearing on one is PERCHED, not RESTING.
   *
   * The median, not the smallest: a 2 x 1.2 x 0.1 m catwalk deck plate is thin and
   * is a perfectly good thing to stand something on (median 1.2). A 3 x 0.04 x
   * 0.04 m rod is not (median 0.04). A 4 x 0.2 x 0.2 m beam is (median 0.2).
   */
  const SLENDER = 0.15;
  const slenderRoot = (r) => {
    const s = isle.get(r);
    if (!s) return false;
    const d = [s.max[0] - s.min[0], s.max[1] - s.min[1], s.max[2] - s.min[2]]
      .sort((a, b) => b - a);
    return d[1] < SLENDER;
  };
  const slenderCache = new Map();
  const isSlender = (r) => {
    let v = slenderCache.get(r);
    if (v === undefined) { v = slenderRoot(r); slenderCache.set(r, v); }
    return v;
  };

  /*
   * THE CONTACT SET IS KEPT, NOT SUMMARISED.
   *
   * Every patch is stored with the island that produced it, because the verdict
   * has to be recomputed later over the SUBSET of contacts that come from things
   * which are themselves standing up. Summarising into a bearing box here — which
   * is what an earlier version of this file did — makes that impossible, and
   * "supported by another floating plate" is the exact hole seven rounds fell in.
   *
   * The early exit is deliberately conservative: an island stops being measured
   * only once it has solid, non-slender bearing under its centre of mass from
   * something that is NOT a candidate, i.e. from structure or from the ground
   * band. No later contact can overturn that, so nothing is lost.
   */
  const addPatch = (c, qx, qy, qz, r) => {
    const key = Math.round(qx / cfg.patch) + ',' + Math.round(qy / cfg.patch)
      + ',' + Math.round(qz / cfg.patch);
    if (c.patches.has(key)) return;
    if (c.patches.size >= cfg.maxPatches) return;
    c.patches.set(key, r);
    c.px.push(qx); c.py.push(qy); c.pz.push(qz); c.pr.push(r);
    c.touch.add(r);
    if (qy <= c.cy + cfg.patch && !byRoot.has(r) && !isSlender(r)) {
      const b = c.solid;
      b.n++;
      if (qx < b.x0) b.x0 = qx; if (qx > b.x1) b.x1 = qx;
      if (qz < b.z0) b.z0 = qz; if (qz > b.z1) b.z1 = qz;
      if (b.n >= 2 && c.cx >= b.x0 - cfg.restSlop && c.cx <= b.x1 + cfg.restSlop
        && c.cz >= b.z0 - cfg.restSlop && c.cz <= b.z1 + cfg.restSlop
        && Math.max(b.x1 - b.x0, b.z1 - b.z0) >= cfg.restSpan) c.done = true;
    }
  };

  if (candidates.length) {
    const R = cfg.reach, R2 = R * R, C2 = cfg.contact * cfg.contact;
    let stamp = 0;
    for (const c of candidates) c.stamp = -1;
    const consider = (c, v, ii, r, loX, hiX, loY, hiY, loZ, hiZ) => {
      if (c.done) return;
      if (loX - c.max[0] > R || c.min[0] - hiX > R) return;
      if (loY - c.max[1] > R || c.min[1] - hiY > R) return;
      if (loZ - c.max[2] > R || c.min[2] - hiZ > R) return;
      const vs = c.verts;
      for (let i = 0; i < vs.length; i += 3) {
        const d2 = dist2ToTri(vs[i], vs[i + 1], vs[i + 2], v, Q);
        if (d2 >= R2) continue;
        if (d2 < c.gap * c.gap) {
          c.gap = Math.sqrt(d2); c.nearRoot = r; c.nearItem = ii;
          c.nearP = [Q[0], Q[1], Q[2]];
          c.nearV = [vs[i], vs[i + 1], vs[i + 2]];
        }
        if (d2 <= C2) {
          addPatch(c, Q[0], Q[1], Q[2], r);
          /*
           * AND IN BOTH DIRECTIONS. This walks island A's VERTICES against island
           * B's TRIANGLES, which is not symmetric: a stud touching the middle of an
           * open cylinder is 2 cm from its SURFACE and 45 cm from its nearest
           * VERTEX. Round 9 lost a whole assembly to that asymmetry. Recording the
           * reverse patch from the same measurement costs one map lookup.
           */
          const other = byRoot.get(r);
          if (other && !other.done) addPatch(other, Q[0], Q[1], Q[2], c.root);
          if (c.done) return;
        }
      }
    };
    ti = 0;
    eachTriangle((v, ii, loX, hiX, loY, hiY, loZ, hiZ) => {
      const r = roots[ti++];
      const cells = (Math.floor(hiX) - Math.floor(loX) + 1) * (Math.floor(hiZ) - Math.floor(loZ) + 1);
      // Merged ground buckets hold single triangles 100 m across; walking their
      // 1 m grid footprint is 10,000 lookups each. Test those directly.
      if (cells > 12) {
        for (const c of candidates) {
          if (c.root === r) continue;
          consider(c, v, ii, r, loX, hiX, loY, hiY, loZ, hiZ);
        }
        return;
      }
      stamp++;
      for (let x = Math.floor(loX); x <= Math.floor(hiX); x++) {
        for (let z = Math.floor(loZ); z <= Math.floor(hiZ); z++) {
          const l = grid.get(x + ',' + z);
          if (!l) continue;
          for (const c of l) {
            if (c.root === r || c.stamp === stamp) continue;
            c.stamp = stamp;
            consider(c, v, ii, r, loX, hiX, loY, hiY, loZ, hiZ);
          }
        }
      }
    });
  }
  mark();

  /* ---- E: the verdict --------------------------------------------------- */
  /*
   * TRANSITIVE, AND RECOMPUTED FROM THE CONTACT SET EACH ROUND.
   *
   * An object stands up only on contacts with things that themselves stand up.
   * Anything that is not a candidate — structure, the ground band, geometry too
   * small or too far out of frame to judge — is standing by definition. Everything
   * else has to earn it, and the statics are re-derived over the surviving subset
   * of patches every round, because a plate whose only bearing is another plate in
   * mid-air has, correctly, no bearing at all.
   *
   * A fixpoint rather than a recursive walk: relaxation cannot poison a cycle the
   * way a visited-set walk does. floatcheck's first version did exactly that and
   * reported 1579 floats in a level whose decks are perfectly well attached.
   */
  const stands = new Set();
  const B = { n: 0, x0: 0, x1: 0, z0: 0, z1: 0 };
  const O = { n: 0, x0: 0, x1: 0, z0: 0, z1: 0 };
  const reset = (b) => {
    b.n = 0; b.x0 = Infinity; b.x1 = -Infinity; b.z0 = Infinity; b.z1 = -Infinity;
  };
  const grow = (b, x, z) => {
    b.n++;
    if (x < b.x0) b.x0 = x; if (x > b.x1) b.x1 = x;
    if (z < b.z0) b.z0 = z; if (z > b.z1) b.z1 = z;
  };
  /**
   * Verdict for one island over the contacts that are currently valid support.
   * Writes its working out onto the island so the report can show it.
   */
  const statics = (c) => {
    reset(B); reset(O);
    let patches = 0, slenderBear = 0;
    for (let i = 0; i < c.px.length; i++) {
      const r = c.pr[i];
      if (byRoot.has(r) && !stands.has(r)) continue;   // held up by a float: not support
      patches++;
      /*
       * A SLENDER CONTACT IS ROUTED BY HEIGHT, AND THIS LINE IS THE DEFECT.
       *
       * Hanging FROM a cable is what cables are for; a tarp slung off a wire, a
       * lamp on a drop cord, lagging strapped under a pipe all read correctly.
       * Balancing ON a cable does not. The first version of this file put every
       * slender contact into the sling box, and the consequence was immediate and
       * exactly wrong: the panel the round-10 reviewer circled — perched on two
       * 4 cm rods that cross beneath it — came back HUNG with a 0.60 m sling span,
       * i.e. the tool declared the defect a legitimate suspended object. Above the
       * centre of mass it can pull; below it, it can only be perched on.
       */
      if (c.py[i] <= c.cy + cfg.patch) {
        if (isSlender(r)) { slenderBear++; continue; }
        grow(B, c.px[i], c.pz[i]);
      } else grow(O, c.px[i], c.pz[i]);
    }
    c.livePatches = patches;
    c.slenderBear = slenderBear;
    c.restSpan = B.n ? Math.max(B.x1 - B.x0, B.z1 - B.z0) : 0;
    c.overSpan = O.n ? Math.max(O.x1 - O.x0, O.z1 - O.z0) : 0;
    c.coverage = c.faceArea > 0 ? (patches * cfg.patch * cfg.patch) / c.faceArea : 0;
    c.restInside = !!(B.n >= 2
      && c.cx >= B.x0 - cfg.restSlop && c.cx <= B.x1 + cfg.restSlop
      && c.cz >= B.z0 - cfg.restSlop && c.cz <= B.z1 + cfg.restSlop);
    c.comOut = B.n
      ? Math.max(B.x0 - c.cx, c.cx - B.x1, B.z0 - c.cz, c.cz - B.z1, 0) : null;
    if (c.restInside && c.restSpan >= cfg.restSpan) return 'RESTING';
    /*
     * FIXED — bolted, welded or clamped. TWO ways in, and the second one matters.
     *
     * Area coverage alone misses everything joined along an EDGE. The stair
     * stringer at (9.6, 1.75, 23.0) is 0.06 x 2.4 x 3.93 m and is fastened to its
     * newel post down a 1.2 m vertical seam: 24 distinct contact cells, and a
     * coverage of 0.6% because the denominator is its own 9.4 m2 flank. It came
     * back TOPPLE, which is nonsense — it is welded to a post.
     *
     * So a raw count of distinct 5 cm contact cells is the second door. A dozen of
     * them is a seam, a flange or a clamped collar; nothing balanced on a tangent
     * produces it. The panel this whole round is about has seven.
     */
    if (patches >= cfg.seamPatches) return 'FIXED';
    if (patches >= cfg.fixPatches && c.coverage >= cfg.fixCoverage) return 'FIXED';
    // Suspended from above, or slung between cables — legitimate, if what holds it
    // spans enough of it that the pose is the one a hanging object would take.
    if (O.n >= cfg.hangPatches && c.overSpan >= cfg.hangSpan * Math.max(0.05, c.span)) return 'HUNG';
    // Bearing only on rods, cables or wires, and nothing above to sling it:
    // an object balanced on a wire. This is the round-10 hero-overcast panel.
    if (slenderBear) return 'PERCHED';
    return null;
  };
  for (const c of candidates) {
    c.mode = statics(c);
    if (c.mode && c.mode !== 'PERCHED') stands.add(c.root);
  }
  for (let pass = 0, changed = true; changed && pass < 24; pass++) {
    changed = false;
    for (const c of candidates) {
      if (stands.has(c.root)) continue;
      const m = statics(c);
      c.mode = m;
      if (m && m !== 'PERCHED') { stands.add(c.root); changed = true; }
    }
  }
  // Final metrics pass so every island's printed numbers match the settled world.
  for (const c of candidates) c.mode = statics(c) ?? c.mode;

  for (const c of candidates) {
    c.airborne = !(c.gap <= cfg.near);
    c.perched = c.mode === 'PERCHED' && !stands.has(c.root);
    c.floats = !stands.has(c.root);
    c.verdict = !c.floats ? c.mode
      : (c.card ? 'CARD' : (c.perched ? 'PERCHED' : (c.airborne ? 'AIRBORNE' : 'TOPPLE')));
    c.faceMrad = (c.face / c.eyeDist) * 1000;
    c.severe = c.floats && !c.card && c.face >= cfg.severeFace && c.dim <= cfg.severeDim
      && c.faceMrad >= cfg.severeFaceMrad;
    c.score = c.faceMrad * (c.airborne ? 2 : 1);
  }

  const describe = (c) => ({
    verdict: c.verdict,
    severe: !!c.severe,
    size: [+(c.max[0] - c.min[0]).toFixed(2), +(c.max[1] - c.min[1]).toFixed(2),
      +(c.max[2] - c.min[2]).toFixed(2)],
    centre: [+((c.min[0] + c.max[0]) / 2).toFixed(2), +((c.min[1] + c.max[1]) / 2).toFixed(2),
      +((c.min[2] + c.max[2]) / 2).toFixed(2)],
    com: [+c.cx.toFixed(2), +c.cy.toFixed(2), +c.cz.toFixed(2)],
    baseY: +c.min[1].toFixed(2),
    face: +c.face.toFixed(2),
    faceMrad: Math.round(c.faceMrad),
    gap: Number.isFinite(c.gap) ? +c.gap.toFixed(3) : null,
    patches: c.patches.size,
    livePatches: c.livePatches ?? 0,
    slenderBear: c.slenderBear ?? 0,
    restSpan: +(c.restSpan ?? 0).toFixed(3),
    restInside: !!c.restInside,
    overSpan: +(c.overSpan ?? 0).toFixed(3),
    coverage: +(c.coverage ?? 0).toFixed(3),
    comOut: c.comOut === null || c.comOut === undefined ? null : +c.comOut.toFixed(3),
    tris: c.tris,
    verts: c.verts ? c.verts.length / 3 : 0,
    eye: c.eyeName + '@' + c.eyeDist.toFixed(1) + 'm',
    owners: [...c.items].map((i) => items[i].chain),
    nearestOwner: c.nearItem >= 0 ? items[c.nearItem].chain : null,
  });

  const at = [];
  for (const qp of cfg.at || []) {
    let best = null, bd = Infinity;
    for (const c of candidates) {
      const dx = Math.max(c.min[0] - qp[0], 0, qp[0] - c.max[0]);
      const dy = Math.max(c.min[1] - qp[1], 0, qp[1] - c.max[1]);
      const dz = Math.max(c.min[2] - qp[2], 0, qp[2] - c.max[2]);
      const d = Math.hypot(dx, dy, dz);
      if (d < bd) { bd = d; best = c; }
    }
    at.push(best ? Object.assign({ query: qp, boxDistance: +bd.toFixed(3) }, describe(best))
      : { query: qp, none: true });
  }

  const floats = candidates.filter((c) => c.floats).sort((a, b) => b.score - a.score);
  const severe = floats.filter((c) => c.severe);
  const modes = {};
  for (const c of candidates) modes[c.verdict] = (modes[c.verdict] || 0) + 1;

  return {
    meshes: items.length,
    triangles: triTotal,
    islands: islands.length,
    structure: islands.filter((i) => i.structure).length,
    candidates: candidates.length,
    modes: modes,
    airborne: floats.filter((c) => c.airborne).length,
    topple: floats.filter((c) => !c.airborne).length,
    floats: floats.length,
    severe: severe.length,
    list: severe.slice(0, cfg.maxReport).map(describe),
    minorList: floats.filter((c) => !c.severe).slice(0, 10).map(describe),
    allCandidates: cfg.dumpAll
      ? candidates.slice().sort((a, b) => b.score - a.score).map(describe) : [],
    at: at,
    ms: T.slice(1).map((t, i) => Math.round(t - T[i])),
  };
}`;

/* ------------------------------------------------------------------ node side */

/** Zone prefix -> the level source file that emits it, read from the tree. */
function zoneMap() {
  const dir = path.join(here, '..', 'src', 'world', 'level');
  const out = new Map();
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    const local = [];
    const konst = src.match(/(?:const|let)\s+ZONE\s*=\s*'([a-zA-Z0-9_]+)'/);
    if (konst) local.push(konst[1]);
    for (const m of src.matchAll(/zone:\s*'([a-zA-Z0-9_]+)'/g)) local.push(m[1]);
    for (const m of src.matchAll(/(?:const|let)\s+zone\s*=\s*'([a-zA-Z0-9_]+)'/g)) local.push(m[1]);
    for (const z of local) {
      const list = out.get(z) ?? [];
      if (!list.includes(f)) list.push(f);
      out.set(z, list);
    }
  }
  return out;
}
const ZONES = zoneMap();

function provenance(chain) {
  const own = String(chain).split(' < ')[0];
  if (own.startsWith('prop:')) return 'src/world/props/** (props agent — this system)';
  const zone = own.split('|')[0];
  const files = ZONES.get(zone);
  if (files && files.length) return files.map((f) => `src/world/level/${f}`).join(' or ');
  if (/^ai|enemy|actor/i.test(own)) return 'src/ai/**';
  if (/practical|light|lamp/i.test(chain)) return 'src/world/Lighting.js';
  return 'unknown';
}

const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=d3d11', '--disable-gpu-sandbox', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(m.text()); });

const q = new URLSearchParams({
  freeze: '1', hud: '0', quality: 'cinematic', vm: '0',
  tod: view.tod ?? 'golden', pos: view.pos,
  yaw: String(view.yaw ?? 0), pitch: String(view.pitch ?? 0),
});
await page.goto(`${url}/?${q}`, { waitUntil: 'domcontentloaded', timeout: 300000 });
await page.waitForFunction('window.__ready === true', null, { timeout: 300000 });
await page.waitForTimeout(900);

let failed = false;
let last = null;

const row = (it, tag) => {
  console.log(`\n${tag} ${it.size.join(' x ')} m  @ ${it.centre.join(', ')}  base y=${it.baseY}`);
  console.log(`        centre of mass ${it.com.join(', ')} · face ${it.face} m = ${it.faceMrad} mrad `
    + `from ${it.eye}`);
  console.log(`        nearest surface ${it.gap === null ? `> ${CFG.reach} m (NOTHING IN REACH)` : `${it.gap} m`}`
    + ` · ${it.patches} contact patch(es), ${it.livePatches} of them with something that `
    + `itself stands up, ${it.slenderBear} of those a rod/cable/wire`);
  console.log(`        SOLID SUPPORT FOOTPRINT ${it.restSpan} m wide, centre of mass `
    + `${it.restInside ? 'INSIDE it' : (it.comOut === null ? 'has no footprint at all' : `${it.comOut} m OUTSIDE it`)}`
    + ` · overhead/sling span ${it.overSpan} m · patch covers `
    + `${(it.coverage * 100).toFixed(1)}% of its own largest face`);
  console.log(`        ${it.tris} tris, ${it.verts} sampled verts`);
  for (const o of it.owners) console.log(`        mesh   ${o}`);
  console.log(`        SOURCE ${[...new Set(it.owners.map(provenance))].join(' + ')}`);
  if (it.nearestOwner) console.log(`        nearest ${it.nearestOwner}`);
};

const welds = args.includes('--cell') ? [CFG.cell] : [0.14, 0.025];
for (const cell of welds) {
  const r = await page.evaluate(
    `(${PROBE})(${JSON.stringify({ ...CFG, cell })}, ${JSON.stringify(EYES)})`,
  );
  last = r;
  if (r.error) { console.log(`supportcheck: ${r.error}`); failed = true; continue; }
  console.log(`\n=== supportcheck — weld radius ${cell * 2} m, cameras from tools/shoot.mjs ===`);
  console.log(`  world       ${r.meshes} visible meshes, ${r.triangles.toLocaleString()} triangles`);
  console.log(`  islands     ${r.islands} connected components, ${r.structure} of them building fabric`);
  console.log(`  candidates  ${r.candidates} loose objects off the ground and >= `
    + `${CFG.minAngular * 1000} mrad in frame`);
  console.log(`  how they stand up: ${Object.entries(r.modes)
    .sort((a, b) => b[1] - a[1]).map(([k, v]) => `${v} ${k}`).join(' · ')}`);
  console.log(`  UNSUPPORTED ${r.floats}  = ${r.airborne} AIRBORNE (nothing within `
    + `${CFG.near} m) + ${r.topple} TOPPLE (touching something, but nothing that could `
    + `hold it in that pose)`);
  console.log(`              of which ${r.severe} SEVERE (face >= ${CFG.severeFace} m, `
    + `<= ${CFG.severeDim} m, >= ${CFG.severeFaceMrad} mrad in frame)`);
  console.log(`              pass timings ${r.ms.join('/')} ms`);

  for (const a of r.at ?? []) {
    console.log(`\n--- object nearest ${a.query.join(',')}`
      + `${a.none ? ' : none found' : ` (box distance ${a.boxDistance} m)`} ---`);
    if (!a.none) row(a, a.verdict.padEnd(8));
  }

  const bucket = new Map();
  for (const it of [...r.list, ...r.minorList]) {
    for (const src of new Set(it.owners.map(provenance))) {
      const k = src.split(' or ')[0];
      const e = bucket.get(k) ?? { n: 0, severe: 0 };
      e.n++; if (it.severe) e.severe++;
      bucket.set(k, e);
    }
  }
  if (bucket.size) {
    console.log('\n--- unsupported objects by authoring system ---');
    for (const [k, e] of [...bucket].sort((a, b) => b[1].severe - a[1].severe)) {
      console.log(`  ${String(e.severe).padStart(4)} severe / ${String(e.n).padStart(4)} listed   ${k}`);
    }
  }

  if (listAll) for (const it of r.allCandidates) row(it, it.verdict.padEnd(8));
  else {
    for (const it of r.list) row(it, 'SEVERE  ');
    if (r.minorList.length) {
      console.log(`\n--- ${r.floats - r.severe} further unsupported objects below the `
        + 'severity gate (advisory; --all lists everything) ---');
      for (const it of r.minorList) row(it, it.verdict.padEnd(8));
    }
  }
  if (r.severe > 0) failed = true;
}

if (jsonOut && last) {
  fs.writeFileSync(jsonOut, JSON.stringify(last, null, 1));
  console.log(`\nwrote ${jsonOut}`);
}
if (pageErrors.length) {
  console.log(`\n${pageErrors.length} PAGE ERROR(S):`);
  for (const e of pageErrors.slice(0, 5)) console.log(`  ${e.slice(0, 200)}`);
  failed = true;
}

await page.close();
await browser.close();

console.log(`\n${failed ? 'FAIL' : 'PASS'} — ${failed
  ? 'an object is standing in a pose nothing in the world could hold it in'
  : 'every visible loose object rests on, is fixed to, or hangs from something'}`);
process.exitCode = failed ? 1 : 0;
