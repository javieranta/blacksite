#!/usr/bin/env node
/**
 * FLOATCHECK — the assertion that nothing in the world hangs in mid-air.
 *
 * WHY THIS EXISTS
 *   "Rusted plates float in mid-air" has been raised in FIVE consecutive reviews.
 *   Four rounds attempted it. At least two wrote downward-raycast reseat passes
 *   over the props system and reported success — correctly, for props. The plates
 *   stayed, because every one of those passes only ever looked at things the
 *   props system had itself placed, and the offenders are baked LEVEL geometry.
 *   Round 8 added props/LevelFloat.js, which does walk level geometry, and the
 *   plates STILL stayed, because its shortlist filters (MAX_DIM 2.2 m,
 *   DECK_SPAN 1.3 m) exclude exactly the large panels a reviewer notices.
 *
 *   Every one of those five rounds ended with an agent believing it was fixed.
 *   None of them had a measurement that would have said otherwise. This is it.
 *
 * WHAT IT MEASURES, AND WHY IT IS MEASURED THIS WAY
 *   The question "does anything float" is a question about the whole rendered
 *   world, so this tool is deliberately ignorant of which system owns what. It
 *   walks `ctx.scene` — level colliders, level decor, props instances, props
 *   merged batches, backdrop, everything visible — expands InstancedMesh
 *   transforms, and works in world-space triangles.
 *
 *   1. ISLANDS. Triangles are welded into connected components by union-find over
 *      a 14 cm cell grid keyed on their vertices. Anything within ~28 cm of
 *      anything else is one island. A crate sunk into tarmac is part of the
 *      ground island and therefore never a suspect; a plate hanging 1.4 m off a
 *      pipe is its own island.
 *
 *   2. SUSPECTS. Islands that are (a) inside the play envelope, (b) off the
 *      ground, and (c) large enough in frame from one of tools/shoot.mjs's own
 *      camera positions to be visible as unsupported.
 *
 *      NOTE THE ABSENCE of an upper size limit on a suspect's footprint. That
 *      limit is precisely the bug in LevelFloat's own shortlist: the panel in
 *      vertical.png is 1.9 x 1.4 m, so `sorted[1] > DECK_SPAN` threw it out as
 *      "a deck, roof or wall panel — structure the level owns". A reviewer does
 *      not care who owns it.
 *
 *   3. GAP, MEASURED FROM REAL VERTICES. For each suspect, the minimum distance
 *      from its own world-space vertices to any triangle belonging to a DIFFERENT
 *      island. Not bounding box to bounding box: a 0.62 x 0.80 x 0.03 slab tilted
 *      in two axes has an AABB that is 96% air, and box proximity is what made
 *      LevelFloat's first cut report the round-7 offender as attached at 7 cm
 *      while it had clear sky along its entire silhouette.
 *
 *   4. SUPPORT IS TRANSITIVE. A suspect is supported if its nearest island is
 *      within CONTACT and that island is itself supported. Two floating plates
 *      5 cm apart do not support each other.
 *
 * MODES
 *   node tools/floatcheck.mjs                    assert over every shoot view
 *   node tools/floatcheck.mjs --view vertical    one view's camera only
 *   node tools/floatcheck.mjs --pixel 110,300 --view vertical
 *                                                what is under that pixel, and
 *                                                which island it belongs to
 *   node tools/floatcheck.mjs --all              list every suspect, passing too
 *
 * Exits non-zero when any island floats. That is the whole point: it is the
 * thing that stops this defect coming back a sixth time.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * The shoot rig's camera list, READ FROM tools/shoot.mjs AS TEXT.
 *
 * shoot.mjs exports VIEWS, but it is a script and not a module: importing it
 * runs the whole screenshot rig as a side effect. (Doing that by accident cost
 * one iteration here and rewrote every untagged PNG in tools/out/shots/.)
 * Parsing the literal keeps the two in sync without executing anything, and
 * without editing a file this agent does not own.
 */
function shootViews() {
  const src = fs.readFileSync(path.join(here, 'shoot.mjs'), 'utf8');
  const out = [];
  for (const m of src.matchAll(
    /\{\s*name:\s*'([\w-]+)',[^}]*?pos:\s*'([-\d.,]+)'[^}]*?\}/g,
  )) {
    const [x, y, z] = m[2].split(',').map(Number);
    const tail = m[0];
    const num = (k, d) => {
      const g = tail.match(new RegExp(k + ':\\s*(-?[\\d.]+)'));
      return g ? Number(g[1]) : d;
    };
    const tod = tail.match(/tod:\s*'(\w+)'/);
    out.push({
      name: m[1], pos: m[2], x, y, z, yaw: num('yaw', 0), pitch: num('pitch', 0),
      tod: tod ? tod[1] : 'golden',
    });
  }
  if (!out.length) throw new Error('floatcheck: could not parse VIEWS out of tools/shoot.mjs');
  return out;
}

const VIEWS = shootViews();
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const flag = (n) => args.includes('--' + n);

const url = opt('url', 'http://127.0.0.1:5180');
const viewName = opt('view', 'vertical');
const pixel = opt('pixel', null);
const listAll = flag('all');

const view = VIEWS.find((v) => v.name === viewName) ?? VIEWS[0];

/**
 * Tuning. These are the thresholds the assertion fails on; they are the review's
 * standard, not a convenience.
 */
const CFG = {
  /** Cell size for island welding. Two pieces within ~2x this are one object. */
  cell: 0.14,
  /** Below this everything is floor, kerb and paving. */
  yMin: 0.42,
  /** Above this is roofline and gantry — structure, and out of a player's read. */
  yMax: 15.0,
  /** Play envelope. Outside it is backdrop silhouette, which may float. */
  xzLimit: 56,
  /** Smallest island worth judging (metres, largest extent). */
  minDim: 0.09,
  /**
   * Gap at or under which an island counts as touching its neighbour. 5 cm is
   * about the thickness of a mounting bracket; anything looser is visible sky.
   */
  contact: 0.05,
  /** How far out the gap search looks before giving up. */
  reach: 0.9,
  /**
   * Angular size below which an unsupported object is not a visible defect.
   * 0.012 rad is ~13 px in a 1080p frame at 78 deg vertical FOV.
   */
  minAngular: 0.012,
  /**
   * Vertices sampled per suspect for the gap measurement.
   *
   * THIS NUMBER WAS 400 AND THAT WAS A MEASUREMENT BUG, of exactly the kind this
   * project keeps being bitten by. The fabric island in hero-golden carries 1312
   * triangles once its spacer studs are counted, so a 400-vertex sample took every
   * eighth vertex — and the vertices that matter are the few dozen at the tips of
   * the studs, the ones actually touching the pipe. The tool reported a 0.241 m
   * gap for an island that was bolted to the pipe, i.e. it reported the fix as not
   * working when the fix worked. Six thousand means every island under ~2000
   * triangles is measured from ALL of its vertices, and the contact early-exit in
   * pass C keeps that affordable.
   */
  maxSamples: 6000,
  /**
   * An island larger or heavier than this is the building's own fabric, not a
   * loose object. It counts as ground for the support test and is never reported.
   * Note which side the filter is on: it excludes things TOO BIG to be dressing,
   * never things too small. LevelFloat's DECK_SPAN 1.3 m excluded a 1.9 x 1.4 m
   * floating panel, and that is the bug this whole tool exists to catch.
   */
  structureDim: 12,
  structureTris: 4000,
  /** Suspects reported in full. */
  maxReport: 24,
  /**
   * SEVERE — the class the exit code gates on: a panel-shaped object with visible
   * daylight all round it. See the severity block in the probe for why these four
   * and not a single size threshold.
   */
  /** Median dimension. A plate has one; a rod, a rail and a purlin do not. */
  severeFace: 0.25,
  /**
   * Daylight that reads unmistakably as sky rather than a tolerance.
   *
   * CALIBRATED, not chosen. The plate the round-8 review called "the clearest
   * case" — `hall|metal_rusted|111`, 1.44 x 2.15 x 0.68 m at (-6.7, 5.8, 0.64) —
   * measures 0.099 m of daylight. At 6.3 m that is 16 mrad, about 17 px of visible
   * sky between the plate and the wall behind it. A gate at 0.15 m would let the
   * exact object this assertion exists to catch through, which is how the last
   * four size thresholds in this project failed.
   */
  severeGap: 0.08,
  /** ... and both have to be resolvable from a camera the rig actually uses. */
  severeFaceMrad: 15,
  severeGapMrad: 6,
  /**
   * Largest object the SEVERE gate covers.
   *
   * Read the warning attached to structureDim before touching this, then read
   * this: the defect five reviews have been describing is a PLATE. The two named
   * offenders measure 2.15 m and 1.24 m across. Above 4 m the population is the
   * building's own fabric — 7.1 x 0.7 m precast perimeter wall panels, 8.3 m
   * gantry members — which props can neither move nor plausibly bolt a bracket
   * to, and which a reviewer reads as architecture rather than as dressing. They
   * are still measured, still listed, and still named in the console by the audit
   * itself; they simply do not fail this gate. 4 m leaves nearly a factor of two
   * of headroom over the largest object the reviews have ever pointed at.
   */
  severeDim: 4.0,
  /** --at "x,y,z;x,y,z" : report the islands at world points, whatever the rank. */
  at: null,
  dumpAll: false,
};
const atOpt = opt('at', null);
if (atOpt) CFG.at = atOpt.split(';').map((p) => p.split(',').map(Number));
/** --cell / --contact / --yMin: override a threshold to probe the instrument. */
for (const k of ['cell', 'contact', 'yMin', 'severeGap', 'reach']) {
  const v = opt(k, null);
  if (v !== null) CFG[k] = Number(v);
}
const jsonOut = opt('json', null);
if (jsonOut) CFG.dumpAll = true;

/**
 * Every camera the screenshot rig actually uses, so "visible" means visible in a
 * frame a reviewer will look at. Imported from shoot.mjs rather than copied.
 */
const EYES = VIEWS.map((v) => ({ name: v.name, x: v.x, y: v.y, z: v.z }))
  .filter((e) => Number.isFinite(e.x));

/* ------------------------------------------------------------------ page side */

/**
 * Runs in the page. Three passes over the world's triangles:
 *   A  weld islands, accumulate per-island extent / triangle count / provenance
 *   B  sample real world vertices for the shortlisted suspects
 *   C  measure each suspect's distance to the nearest triangle of another island
 *
 * Three passes rather than one because the shortlist is not known until A has
 * finished and the vertex samples are not known until B has. Each pass is a few
 * hundred ms over ~1M triangles; this is an init-time diagnostic, not a frame.
 */
const PROBE = /* js */ `(cfg, eyes) => {
  const eng = window.__blacksite && window.__blacksite.engine;
  if (!eng) return { error: 'no engine' };
  const scene = eng.scene;

  /* ---- 0: which meshes are in play ------------------------------------- */
  // traverseVisible respects the whole ancestor chain, so a hidden debug group
  // contributes nothing. Sky and cloud shells are excluded by name: they are
  // camera-locked shells, not world geometry, and they are supposed to be in the
  // air. Nothing else is excluded — in particular props are NOT excluded, so a
  // prop resting on a level plate correctly counts as support for it.
  const SKIP = /sky|cloud|star|moon|sun|aurora|volumetric|debug|helper|gizmo|impact|tracer|muzzle|decal:|particle/i;
  /**
   * TEST THE WHOLE ANCESTOR CHAIN, NOT THE LEAF NAME.
   *
   * NOTE FOR EDITORS: this whole PROBE is a template literal. No backticks and
   * no dollar-brace in here, or the tool stops parsing.
   *
   * This tested o.name alone, and the FX billboards it is meant to exclude are
   * ANONYMOUS children of a named group: the muzzle-flash cards are unnamed
   * Meshes under a group called 'ai:muzzlefx', so o.name was '' and the regex
   * never matched. The result was that a 0.38 x 0.52 x 0.51 m muzzle-flash quad
   * with 2 triangles came back as the WORST-RANKED SEVERE float in the report --
   * 512 mrad of "panel-shaped object hanging in mid-air with daylight all round
   * it", which is what a muzzle flash is supposed to be. Six of the 41 severe
   * findings were FX cards, all in the "SOURCE unknown" bucket, and the next
   * agent to read this report would have gone looking for level geometry that
   * does not exist.
   *
   * The named groups in this scene that match SKIP are exactly the intended
   * categories -- sky, sky-dome, impacts, particles, fx:particles, ai:muzzlefx.
   * Nothing load-bearing matches: colliders, level, level:decor, props,
   * ai:combatants and ai:contact-shadows all pass through, so props still count
   * as support for level plates.
   */
  const skipChain = (o) => {
    for (let p = o; p; p = p.parent) if (SKIP.test(p.name || '')) return true;
    return false;
  };
  const items = [];
  scene.traverseVisible((o) => {
    if (!(o.isMesh || o.isInstancedMesh)) return;
    const geo = o.geometry;
    if (!geo || !geo.attributes || !geo.attributes.position) return;
    if (skipChain(o)) return;
    const mat = Array.isArray(o.material) ? o.material[0] : o.material;
    if (mat && mat.isSprite) return;
    // A chain of names is what tells the reader which file made this.
    const chain = [];
    for (let p = o; p; p = p.parent) chain.push(o === p ? (o.name || o.type) : (p.name || p.type));
    items.push({ obj: o, chain: chain.join(' < ') });
  });
  if (!items.length) return { error: 'no geometry in scene' };

  /* ---- shared triangle walker ------------------------------------------ */
  const V = new Float64Array(9);
  const im = new (eng.camera.matrixWorld.constructor)();
  const tmp = new (eng.camera.position.constructor)();

  /** Calls fn(V, itemIndex) for every world-space triangle inside the envelope. */
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
          let lo = Infinity, hi = -Infinity, loX = Infinity, hiX = -Infinity, loZ = Infinity, hiZ = -Infinity;
          for (let k = 0; k < 3; k++) {
            const vi = idx ? idx.getX(f + k) : f + k;
            tmp.fromBufferAttribute(pos, vi).applyMatrix4(im);
            V[k * 3] = tmp.x; V[k * 3 + 1] = tmp.y; V[k * 3 + 2] = tmp.z;
            if (tmp.y < lo) lo = tmp.y; if (tmp.y > hi) hi = tmp.y;
            if (tmp.x < loX) loX = tmp.x; if (tmp.x > hiX) hiX = tmp.x;
            if (tmp.z < loZ) loZ = tmp.z; if (tmp.z > hiZ) hiZ = tmp.z;
          }
          if (hi < -2 || lo > cfg.yMax + 4) continue;
          if (loX > cfg.xzLimit || hiX < -cfg.xzLimit) continue;
          if (loZ > cfg.xzLimit || hiZ < -cfg.xzLimit) continue;
          fn(V, ii, lo, hi);
        }
      }
    }
  };

  /* ---- A: weld islands -------------------------------------------------- */
  const ids = new Map();
  const parent = [];
  let n = 0;
  /*
   * Cell key packing, SIZED FROM cfg.cell RATHER THAN HARD-CODED.
   *
   * This was (ix + 2048) + (iy + 512) * 8192 + (iz + 2048) * 8192 * 2048, which
   * is correct at cell 0.14 and silently wrong below cell 0.055: the play
   * envelope is |xz| < 56 m, so ix reaches +-1018 at 0.055 and +-2240 at 0.025,
   * and past the +-2048 offset the x term goes NEGATIVE and lands inside the y
   * bucket. Two cells 56 m apart would then share a key, union-find would weld
   * them, and the tool would report a plate as attached to a wall on the far side
   * of the level. Nothing warned; the numbers just came out reassuring. The
   * strides are now derived, and asserted, so lowering cfg.cell cannot do that.
   */
  // A triangle straddling the envelope boundary keeps its outside vertices, so
  // the grid has to reach past xzLimit. 40 m of slack covers every straddler in
  // this level; anything further out is dropped by eachTriangle's own filter. The
  // clamp is the safety net, and it can only ever weld cells that are already
  // outside the play envelope and therefore already excluded from suspects.
  const SPAN = Math.ceil((cfg.xzLimit + 40) / cfg.cell) + 4;
  const SPANY = Math.ceil((cfg.yMax + 24) / cfg.cell) + 4;
  const SX = 2 * SPAN + 1, SY = 2 * SPANY + 1;
  if (SX * SY * SX > Number.MAX_SAFE_INTEGER) {
    // No backticks in here — see the note on the walker's SKIP.
    return { error: 'floatcheck: cell ' + cfg.cell + ' m is too fine to key safely' };
  }
  const cl = (i, lim) => (i < -lim ? -lim : (i > lim ? lim : i));
  const idOf = (ix0, iy0, iz0) => {
    const ix = cl(ix0, SPAN), iy = cl(iy0, SPANY), iz = cl(iz0, SPAN);
    const key = (ix + SPAN) + (iy + SPANY) * SX + (iz + SPAN) * SX * SY;
    let id = ids.get(key);
    if (id === undefined) { id = n++; ids.set(key, id); parent.push(id); }
    return id;
  };
  const find = (a) => {
    let r = a;
    while (parent[r] !== r) r = parent[r];
    while (parent[a] !== r) { const nx = parent[a]; parent[a] = r; a = nx; }
    return r;
  };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[rb] = ra; };

  /** Cell ids of a triangle's three vertices, deduplicated. */
  const kk = [0, 0, 0];
  const cellsOf = (v) => {
    let m = 0;
    for (let k = 0; k < 3; k++) {
      const id = idOf(
        Math.floor(v[k * 3] / cfg.cell),
        Math.floor(v[k * 3 + 1] / cfg.cell),
        Math.floor(v[k * 3 + 2] / cfg.cell),
      );
      let dup = false;
      for (let j = 0; j < m; j++) if (kk[j] === id) { dup = true; break; }
      if (!dup) kk[m++] = id;
    }
    return m;
  };

  const T = [performance.now()];
  const mark = () => { T.push(performance.now()); };

  let triTotal = 0;
  eachTriangle((v) => {
    triTotal++;
    const m = cellsOf(v);
    const root = kk[0];
    for (let j = 1; j < m; j++) union(root, kk[j]);
  });
  mark();

  // Extents have to be folded in a SECOND sweep: a cell's final root is only
  // known once every union has been applied, and accumulating onto provisional
  // roots would scatter one island's extent across several entries.
  //
  // That second sweep also memoises each triangle's island into "roots", indexed
  // by triangle ordinal. eachTriangle visits the same meshes, instances and faces
  // in the same order every time and the scene is frozen, so the ordinal is
  // stable — which lets the two remaining passes skip the cell lookup entirely.
  const roots = new Int32Array(triTotal);
  let tri = 0;
  const cMin = new Map(), cMax = new Map(), cTri = new Map(), cItems = new Map();
  eachTriangle((v, ii) => {
    const m = cellsOf(v);
    const r = find(kk[0]);
    roots[tri++] = r;
    let lo0 = v[0], hi0 = v[0], lo1 = v[1], hi1 = v[1], lo2 = v[2], hi2 = v[2];
    for (let k = 1; k < 3; k++) {
      if (v[k * 3] < lo0) lo0 = v[k * 3]; if (v[k * 3] > hi0) hi0 = v[k * 3];
      if (v[k * 3 + 1] < lo1) lo1 = v[k * 3 + 1]; if (v[k * 3 + 1] > hi1) hi1 = v[k * 3 + 1];
      if (v[k * 3 + 2] < lo2) lo2 = v[k * 3 + 2]; if (v[k * 3 + 2] > hi2) hi2 = v[k * 3 + 2];
    }
    let mn = cMin.get(r);
    if (!mn) {
      mn = [Infinity, Infinity, Infinity]; cMin.set(r, mn);
      cMax.set(r, [-Infinity, -Infinity, -Infinity]);
      cTri.set(r, 0); cItems.set(r, new Set());
    }
    const mx = cMax.get(r);
    if (lo0 < mn[0]) mn[0] = lo0; if (hi0 > mx[0]) mx[0] = hi0;
    if (lo1 < mn[1]) mn[1] = lo1; if (hi1 > mx[1]) mx[1] = hi1;
    if (lo2 < mn[2]) mn[2] = lo2; if (hi2 > mx[2]) mx[2] = hi2;
    cTri.set(r, cTri.get(r) + 1);
    const s = cItems.get(r);
    if (s.size < 6) s.add(ii);
    void m;
  });
  mark();

  /* ---- suspects --------------------------------------------------------- */
  const angular = (mn, mx, dim) => {
    const cx = (mn[0] + mx[0]) / 2, cy = (mn[1] + mx[1]) / 2, cz = (mn[2] + mx[2]) / 2;
    let best = 0, from = '';
    for (const e of eyes) {
      const d = Math.hypot(e.x - cx, e.y - cy, e.z - cz);
      const a = dim / Math.max(1.0, d);
      if (a > best) { best = a; from = e.name + '@' + d.toFixed(1) + 'm'; }
    }
    return { ang: best, from };
  };

  const islands = [];
  for (const [r, mn] of cMin) {
    const mx = cMax.get(r);
    const dx = mx[0] - mn[0], dy = mx[1] - mn[1], dz = mx[2] - mn[2];
    const dim = Math.max(dx, dy, dz);
    const rec = {
      root: r, min: mn, max: mx, dim, tris: cTri.get(r), items: [...cItems.get(r)],
    };
    islands.push(rec);
    /*
     * STRUCTURE vs LOOSE OBJECT.
     *
     * Vertex-cell welding under-connects: a bolt touching the middle of a 20 m
     * handrail shares no cell with either of the rail's end vertices, so the two
     * come out as separate islands even though they are in contact. That is
     * harmless for loose objects — the surface-distance measurement in pass C
     * puts them back together — but it means the level's own fabric (decks,
     * catwalks, hall trusses, the perimeter run) arrives here as dozens of
     * separate "islands" tens of metres long, and judging those buries the actual
     * defect under structural noise.
     *
     * An island bigger than this, or heavier than this, IS the building. It is
     * treated as ground for the support test and never reported. Everything
     * smaller stays a candidate whatever its shape — the size filter that hid
     * this bug for four rounds was on the SMALL side (LevelFloat's DECK_SPAN
     * 1.3 m threw out a 1.9 x 1.4 m panel), and nothing here reintroduces it.
     */
    if (dim > cfg.structureDim || rec.tris > cfg.structureTris) { rec.structure = true; continue; }
    if (mn[1] < cfg.yMin) {
      /*
       * THE GROUND BAND, AND THE SECOND THING THIS TOOL COULD NOT SEE.
       *
       * Anything based below yMin is resting on the paving by definition, so it is
       * never judged for float. That is right, and it also meant the review's
       * "ground plates in hero-golden interpenetrating a kerb" could not be
       * reported by this tool at any threshold: the plate is
       * court|metal_rusted|111 with its top face at y = 0.08, four metres from
       * the hero eye, and it was excluded before a single measurement was taken.
       *
       * A loose plate down here therefore becomes a suspect for the INTERSECTION
       * test only — does another island's floor surface pass through this plate's
       * own thickness — because resting on a surface means touching it, not
       * cutting into it. It is still never judged for float.
       */
      if (dy >= 0.03 && dy <= 0.14 && dx <= 2.6 && dz <= 2.6 && dim >= 0.5
        && rec.tris >= 8) {
        const ga = angular(mn, mx, dim);
        if (ga.ang >= 0.05) {
          rec.suspect = true; rec.groundOnly = true; rec.ang = ga.ang; rec.eye = ga.from;
        }
      }
      continue;
    }
    if (mn[1] > cfg.yMax) continue;
    if (dim < cfg.minDim) continue;
    const cx = (mn[0] + mx[0]) / 2, cz = (mn[2] + mx[2]) / 2;
    if (Math.abs(cx) > cfg.xzLimit || Math.abs(cz) > cfg.xzLimit) continue;
    const a = angular(mn, mx, dim);
    if (a.ang < cfg.minAngular) continue;
    rec.suspect = true;
    rec.ang = a.ang;
    rec.eye = a.from;
  }
  const suspects = islands.filter((i) => i.suspect);

  /* ---- B: real vertices for the suspects -------------------------------- */
  const grid = new Map();
  for (const c of suspects) {
    c.verts = [];
    c.near = { d: Infinity, root: -1, item: -1, p: null };
    /** Highest other-island floor surface found INSIDE this plate. */
    c.underY = -Infinity;
    /** Every island whose surface comes within cfg.contact of this one. */
    c.touch = new Set();
    /*
     * Spread the vertex samples over the whole island instead of taking the
     * first N. Taking the first N is how you measure a 2 m catwalk section by
     * one end of it and conclude the other end is in mid-air.
     */
    c.stride = Math.max(1, Math.ceil((c.tris * 3) / cfg.maxSamples));
    c.seen = 0;
    for (let x = Math.floor(c.min[0] - cfg.reach); x <= Math.floor(c.max[0] + cfg.reach); x++) {
      for (let z = Math.floor(c.min[2] - cfg.reach); z <= Math.floor(c.max[2] + cfg.reach); z++) {
        const k = x + ',' + z;
        let l = grid.get(k);
        if (!l) { l = []; grid.set(k, l); }
        l.push(c);
      }
    }
  }
  if (suspects.length) {
    tri = 0;
    eachTriangle((v) => {
      const r = roots[tri++];
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
        }
      }
    });
  }
  mark();

  /* ---- C: nearest triangle belonging to a DIFFERENT island -------------- */
  // Closest point on a triangle to a point. Ericson, Real-Time Collision
  // Detection 5.1.5 — barycentric region test, no allocation.
  const dist2ToTri = (px, py, pz, v) => {
    const ax = v[0], ay = v[1], az = v[2];
    const bx = v[3], by = v[4], bz = v[5];
    const cx = v[6], cy = v[7], cz = v[8];
    const abx = bx - ax, aby = by - ay, abz = bz - az;
    const acx = cx - ax, acy = cy - ay, acz = cz - az;
    const apx = px - ax, apy = py - ay, apz = pz - az;
    const d1 = abx * apx + aby * apy + abz * apz;
    const d2 = acx * apx + acy * apy + acz * apz;
    let qx, qy, qz;
    if (d1 <= 0 && d2 <= 0) { qx = ax; qy = ay; qz = az; }
    else {
      const bpx = px - bx, bpy = py - by, bpz = pz - bz;
      const d3 = abx * bpx + aby * bpy + abz * bpz;
      const d4 = acx * bpx + acy * bpy + acz * bpz;
      if (d3 >= 0 && d4 <= d3) { qx = bx; qy = by; qz = bz; }
      else {
        const vc = d1 * d4 - d3 * d2;
        if (vc <= 0 && d1 >= 0 && d3 <= 0) {
          const t = d1 / (d1 - d3);
          qx = ax + abx * t; qy = ay + aby * t; qz = az + abz * t;
        } else {
          const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
          const d5 = abx * cpx + aby * cpy + abz * cpz;
          const d6 = acx * cpx + acy * cpy + acz * cpz;
          if (d6 >= 0 && d5 <= d6) { qx = cx; qy = cy; qz = cz; }
          else {
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
    const dx = px - qx, dy = py - qy, dz = pz - qz;
    return { d2: dx * dx + dy * dy + dz * dz, x: qx, y: qy, z: qz };
  };

  /** root -> suspect, needed so contact can be recorded in BOTH directions. */
  const byRoot = new Map();
  for (const c of suspects) byRoot.set(c.root, c);

  if (suspects.length) {
    const R = cfg.reach, R2 = R * R;
    // A triangle can land in several of a suspect's grid cells. A version stamp
    // costs one integer compare where a per-triangle Set would allocate ~1M
    // objects and dominate the runtime.
    let stamp = 0;
    for (const c of suspects) c.stamp = -1;

    /** Measure one candidate triangle against one suspect. */
    const consider = (c, v, ii, r, loX, hiX, loY, hiY, loZ, hiZ) => {
      /*
       * INTERSECTION, for ground plates. O(1) per triangle and it runs BEFORE the
       * contact early-exit below, because a plate cut by a kerb is in contact with
       * that kerb and would otherwise stop being measured after three hits.
       *
       * The test is: an UPWARD-facing triangle of another island whose centroid
       * lies inside this plate's footprint and strictly above its underside. The
       * lower margin is what excludes the surface the plate is resting ON; the
       * upper bound reaches the top face because the case in hero-golden is
       * near-coplanar, a paving slab and a rusted plate fighting over the same few
       * millimetres, not a plate buried halfway. A crate the plate lies on fails
       * twice: its top is at the plate's underside, and its sides are vertical.
       */
      if (c.groundOnly) {
        const ty = (v[1] + v[4] + v[7]) / 3;
        if (ty > c.min[1] + 0.02 && ty <= c.max[1] + 0.002 && ty > c.underY) {
          const tx = (v[0] + v[3] + v[6]) / 3, tz = (v[2] + v[5] + v[8]) / 3;
          if (tx > c.min[0] + 0.03 && tx < c.max[0] - 0.03
            && tz > c.min[2] + 0.03 && tz < c.max[2] - 0.03) {
            const ux = v[3] - v[0], uy = v[4] - v[1], uz = v[5] - v[2];
            const wx = v[6] - v[0], wy = v[7] - v[1], wz = v[8] - v[2];
            const ny = uz * wx - ux * wz;
            const nl = Math.hypot(uy * wz - uz * wy, ny, ux * wy - uy * wx);
            if (nl > 1e-9 && Math.abs(ny) / nl >= 0.6) c.underY = ty;
          }
        }
      }
      /*
       * Stop measuring an island once it is in contact with THREE other islands.
       * This is what makes an uncapped vertex sample affordable — the expensive
       * islands are exactly the ones that stop early — but it deliberately does
       * not stop at the FIRST contact: the reverse edges recorded below are how a
       * sparse-vertex object learns that something small is touching it, and an
       * island that quit after one contact would never record the rest of them.
       */
      if (c.near.d <= cfg.contact && c.touch.size >= 3) return;
      if (loX - c.max[0] > R || c.min[0] - hiX > R) return;
      if (loY - c.max[1] > R || c.min[1] - hiY > R) return;
      if (loZ - c.max[2] > R || c.min[2] - hiZ > R) return;
      const vs = c.verts;
      const C2 = cfg.contact * cfg.contact;
      for (let i = 0; i < vs.length; i += 3) {
        const res = dist2ToTri(vs[i], vs[i + 1], vs[i + 2], v);
        if (res.d2 >= R2) continue;
        if (res.d2 < c.near.d * c.near.d) {
          c.near.d = Math.sqrt(res.d2);
          c.near.root = r;
          c.near.item = ii;
          c.near.p = [res.x, res.y, res.z];
        }
        /*
         * EVERY island in contact, not just the closest one. Recording only the
         * closest is how a panel bolted to a wall at 5 mm AND resting against a
         * loose crate at 2 mm gets judged by the crate.
         *
         * AND IN BOTH DIRECTIONS. This measurement walks island A's VERTICES
         * against island B's TRIANGLES, which is not symmetric: a 12-segment open
         * cylinder has vertices only on its two end rings, so a spacer stud
         * touching the middle of its length is within 2 cm of the cylinder's
         * SURFACE and 45 cm from its nearest VERTEX. Measured in round 9: the
         * lagging sleeve at (5.65, 3.77, 17.74) was bolted to its pipe by three
         * studs, the studs registered contact with the sleeve, the sleeve did not
         * register contact with the studs, and the whole assembly was reported as
         * floating 23.6 cm clear of everything. Recording the reverse edge from
         * the same measurement costs one map lookup.
         */
        if (res.d2 <= C2) {
          c.touch.add(r);
          const other = byRoot.get(r);
          if (other) other.touch.add(c.root);
          break;
        }
      }
    };

    tri = 0;
    eachTriangle((v, ii) => {
      const r = roots[tri++];
      const loX = Math.min(v[0], v[3], v[6]), hiX = Math.max(v[0], v[3], v[6]);
      const loY = Math.min(v[1], v[4], v[7]), hiY = Math.max(v[1], v[4], v[7]);
      const loZ = Math.min(v[2], v[5], v[8]), hiZ = Math.max(v[2], v[5], v[8]);
      const cells = (Math.floor(hiX) - Math.floor(loX) + 1) * (Math.floor(hiZ) - Math.floor(loZ) + 1);
      // A merged ground bucket contains single triangles 100 m across. Walking
      // their 1 m grid footprint is 10,000 map lookups EACH, and the level has
      // thousands of them — that alone took the first version of this pass past
      // ten minutes without finishing. Anything spanning more than a dozen cells
      // is cheaper to test against the suspect list directly.
      if (cells > 12) {
        for (const c of suspects) {
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

  /* ---- transitive support ---------------------------------------------- */
  /*
   * A suspect is supported if it touches a supported island. Structure, and
   * anything welded into the ground band, is supported by definition.
   *
   * This is a FIXPOINT, deliberately, not a depth-first walk. The first version
   * recursed with a visited-set cycle guard that pre-marked each node false, so
   * two catwalk sections each resting on the other's deck poisoned one another
   * and both came out floating — which is how the first run of this tool claimed
   * 1579 floating objects in a level whose decks are perfectly well attached.
   * Relaxation cannot make that mistake: nothing is ever marked unsupported,
   * only not-yet-supported.
   */
  const supported = new Set();
  for (let pass = 0, changed = true; changed && pass < 64; pass++) {
    changed = false;
    for (const c of suspects) {
      if (supported.has(c.root)) continue;
      for (const t of c.touch) {
        // Not a suspect => structure or ground-welded => real support.
        if (!byRoot.has(t) || supported.has(t)) { supported.add(c.root); changed = true; break; }
      }
    }
  }
  const floating = suspects.filter((c) => !supported.has(c.root) && !c.groundOnly);

  /* ---- severity --------------------------------------------------------- */
  /*
   * Not every measured float is the defect five reviews have been naming. The
   * level's canopy purlins sit 24 cm off their beams; that is a real gap and this
   * pass reports it, but a 9 cm x 14 cm bar in the middle of a roof lattice is
   * not what a reviewer circles. What they circle is a PANEL: something with two
   * substantial dimensions, clear daylight all round it, big enough in frame to
   * see the daylight.
   *
   * So severity is computed from three measurements, all of them about what the
   * image shows:
   *   face   the MEDIAN dimension. For a plate this is its short side (1.4 m for
   *          the vertical.png offender); for a purlin it is its thickness
   *          (0.14 m). Using the LARGEST dimension instead ranks a 9.6 m thin bar
   *          above a 1.4 m plate, which is exactly backwards.
   *   gap    metres of daylight to the nearest other surface.
   *   both, divided by the distance to the nearest shoot camera, so the test is
   *          "can this be seen" and not "is this big".
   *
   * SEVERE is what the exit code gates on. Everything else is still printed and
   * counted — it cannot hide — but it does not fail the build, because failing on
   * 486 structural tolerances would make the gate useless and it would be
   * switched off, which is how this defect survived five rounds in the first
   * place.
   */
  for (const c of suspects) {
    const d = [c.max[0] - c.min[0], c.max[1] - c.min[1], c.max[2] - c.min[2]]
      .sort((a, b) => b - a);
    c.face = d[1];
    const cx = (c.min[0] + c.max[0]) / 2, cy = (c.min[1] + c.max[1]) / 2;
    const cz = (c.min[2] + c.max[2]) / 2;
    c.dist = Infinity;
    for (const e of eyes) {
      const dd = Math.hypot(e.x - cx, e.y - cy, e.z - cz);
      if (dd < c.dist) { c.dist = dd; c.eyeName = e.name; }
    }
    c.dist = Math.max(1.0, c.dist);
    const gap = Number.isFinite(c.near.d) ? c.near.d : cfg.reach;
    c.faceMrad = (c.face / c.dist) * 1000;
    c.gapMrad = (gap / c.dist) * 1000;
    c.severe = c.face >= cfg.severeFace && c.dim <= cfg.severeDim && gap >= cfg.severeGap
      && c.faceMrad >= cfg.severeFaceMrad && c.gapMrad >= cfg.severeGapMrad;
    c.score = c.faceMrad * Math.min(3, c.gapMrad / cfg.severeGapMrad);
  }
  /*
   * SUNK. Not a float — the opposite. A ground plate with another island's floor
   * surface inside its own thickness is intersecting rather than resting, which is
   * the "ground plates interpenetrating a kerb" the round-9 review reported and no
   * previous version of this tool measured at all.
   *
   * The gate is narrower than the report on purpose: 2 cm of intrusion at 8 mrad
   * with a face over 60 mrad is a hard edge cutting visibly across a plate in the
   * foreground. Everything measured is printed; only that class fails the build.
   */
  const sunk = [];
  for (const c of suspects) {
    if (!c.groundOnly || !(c.underY > -Infinity)) continue;
    c.sunkDepth = c.underY - c.min[1];
    c.sunkMrad = (c.sunkDepth / c.dist) * 1000;
    if (c.sunkDepth >= 0.02) sunk.push(c);
  }
  sunk.sort((a, b) => b.sunkMrad - a.sunkMrad);
  const sunkBad = sunk.filter((c) => c.sunkMrad >= 8 && c.faceMrad >= 60);
  const severe = floating.filter((c) => c.severe).sort((a, b) => b.score - a.score);
  const minor = floating.filter((c) => !c.severe).sort((a, b) => b.score - a.score);

  const describe = (c) => ({
    gap: Number.isFinite(c.near.d) ? +c.near.d.toFixed(3) : null,
    dim: +c.dim.toFixed(2),
    face: +c.face.toFixed(2),
    size: [+(c.max[0] - c.min[0]).toFixed(2), +(c.max[1] - c.min[1]).toFixed(2),
      +(c.max[2] - c.min[2]).toFixed(2)],
    centre: [+((c.min[0] + c.max[0]) / 2).toFixed(2), +((c.min[1] + c.max[1]) / 2).toFixed(2),
      +((c.min[2] + c.max[2]) / 2).toFixed(2)],
    baseY: +c.min[1].toFixed(2),
    tris: c.tris,
    faceMrad: Math.round(c.faceMrad),
    gapMrad: Math.round(c.gapMrad),
    eye: c.eyeName + '@' + c.dist.toFixed(1) + 'm',
    verts: c.verts ? c.verts.length / 3 : 0,
    owners: c.items.map((i) => items[i].chain),
    nearestOwner: c.near.item >= 0 ? items[c.near.item].chain : null,
    supported: supported.has(c.root),
    severe: !!c.severe,
    groundOnly: !!c.groundOnly,
    sunkDepth: c.sunkDepth === undefined ? null : +c.sunkDepth.toFixed(3),
    sunkMrad: c.sunkMrad === undefined ? null : Math.round(c.sunkMrad),
  });

  // Targeted query: the island containing (or nearest to) each given world point.
  const at = [];
  for (const q of cfg.at ?? []) {
    let best = null, bd = Infinity;
    for (const c of suspects) {
      const dx = Math.max(c.min[0] - q[0], 0, q[0] - c.max[0]);
      const dy = Math.max(c.min[1] - q[1], 0, q[1] - c.max[1]);
      const dz = Math.max(c.min[2] - q[2], 0, q[2] - c.max[2]);
      const d = Math.hypot(dx, dy, dz);
      if (d < bd) { bd = d; best = c; }
    }
    at.push(best
      ? { query: q, ...describe(best), boxDistance: +bd.toFixed(3) }
      : { query: q, none: true });
  }

  return {
    meshes: items.length,
    triangles: triTotal,
    islands: islands.length,
    structure: islands.filter((i) => i.structure).length,
    suspects: suspects.length,
    groundPlates: suspects.filter((c) => c.groundOnly).length,
    sunk: sunk.length,
    sunkFail: sunkBad.length,
    sunkList: sunk.slice(0, 8).map(describe),
    supported: suspects.filter((c) => supported.has(c.root)).length,
    floating: floating.length,
    severe: severe.length,
    minor: minor.length,
    worstGap: floating.length ? +Math.max(...floating.map(
      (c) => (Number.isFinite(c.near.d) ? c.near.d : cfg.reach),
    )).toFixed(3) : 0,
    list: severe.slice(0, cfg.maxReport).map(describe),
    minorList: minor.slice(0, cfg.maxReport).map(describe),
    allSuspects: suspects.slice().sort((a, b) => b.score - a.score)
      .slice(0, cfg.dumpAll ? suspects.length : 80).map(describe),
    at,
    ms: T.slice(1).map((t, i) => Math.round(t - T[i])),
  };
}`;

/**
 * Ray-cast one pixel of the current framing and say which island it hit.
 * Implemented against the same triangle walk rather than THREE.Raycaster so the
 * answer is in the same coordinate system and the same island numbering as the
 * assertion above.
 */
const PIXEL_PROBE = /* js */ `(cfg, px, py) => {
  const eng = window.__blacksite.engine;
  const cam = eng.camera;
  const W = eng.renderer.domElement.width, H = eng.renderer.domElement.height;
  const Vec = cam.position.constructor;
  const Mat = cam.matrixWorld.constructor;
  const ndcX = (px / W) * 2 - 1, ndcY = -((py / H) * 2 - 1);
  const target = new Vec(ndcX, ndcY, 0.5)
    .applyMatrix4(cam.projectionMatrixInverse).applyMatrix4(cam.matrixWorld);
  const o = cam.position.clone();
  const d = target.sub(o).normalize();

  const SKIP = /sky|cloud|star|moon|sun|aurora|volumetric|debug|helper|gizmo|impact|tracer|muzzle|decal:|particle/i;
  const items = [];
  eng.scene.traverseVisible((n) => {
    if (!(n.isMesh || n.isInstancedMesh)) return;
    if (!n.geometry || !n.geometry.attributes || !n.geometry.attributes.position) return;
    // Ancestor chain, not the leaf name — see the note on the main walker's SKIP.
    let skip = false;
    for (let p = n; p; p = p.parent) if (SKIP.test(p.name || '')) { skip = true; break; }
    if (skip) return;
    const chain = [];
    for (let p = n; p; p = p.parent) chain.push(n === p ? (n.name || n.type) : (p.name || p.type));
    items.push({ obj: n, chain: chain.join(' < ') });
  });

  const im = new Mat();
  const v = new Vec();
  const V = new Float64Array(9);
  let best = null;
  for (let ii = 0; ii < items.length; ii++) {
    const ob = items[ii].obj;
    ob.updateMatrixWorld(true);
    const pos = ob.geometry.attributes.position, idx = ob.geometry.index;
    const count = idx ? idx.count : pos.count;
    const insts = ob.isInstancedMesh ? ob.count : 1;
    for (let nn = 0; nn < insts; nn++) {
      if (ob.isInstancedMesh) { ob.getMatrixAt(nn, im); im.premultiply(ob.matrixWorld); }
      else im.copy(ob.matrixWorld);
      for (let f = 0; f + 2 < count; f += 3) {
        for (let k = 0; k < 3; k++) {
          const vi = idx ? idx.getX(f + k) : f + k;
          v.fromBufferAttribute(pos, vi).applyMatrix4(im);
          V[k * 3] = v.x; V[k * 3 + 1] = v.y; V[k * 3 + 2] = v.z;
        }
        // Moller-Trumbore, double sided.
        const e1x = V[3] - V[0], e1y = V[4] - V[1], e1z = V[5] - V[2];
        const e2x = V[6] - V[0], e2y = V[7] - V[1], e2z = V[8] - V[2];
        const hx = d.y * e2z - d.z * e2y, hy = d.z * e2x - d.x * e2z, hz = d.x * e2y - d.y * e2x;
        const a = e1x * hx + e1y * hy + e1z * hz;
        if (a > -1e-9 && a < 1e-9) continue;
        const inv = 1 / a;
        const sx = o.x - V[0], sy = o.y - V[1], sz = o.z - V[2];
        const u = inv * (sx * hx + sy * hy + sz * hz);
        if (u < 0 || u > 1) continue;
        const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
        const vv = inv * (d.x * qx + d.y * qy + d.z * qz);
        if (vv < 0 || u + vv > 1) continue;
        const t = inv * (e2x * qx + e2y * qy + e2z * qz);
        if (t < 0.02) continue;
        if (!best || t < best.t) {
          const mat = Array.isArray(ob.material) ? ob.material[0] : ob.material;
          best = {
            t, chain: items[ii].chain, name: ob.name || ob.type,
            instanced: !!ob.isInstancedMesh, instance: nn,
            material: mat && (mat.name || mat.type),
            surface: mat && mat.userData && mat.userData.surface,
            point: [o.x + d.x * t, o.y + d.y * t, o.z + d.z * t],
          };
        }
      }
    }
  }
  return { pixel: [px, py], resolution: W + 'x' + H, camera: [o.x, o.y, o.z], hit: best };
}`;

/* ------------------------------------------------------------------ node side */

/**
 * Zone prefix -> the level source file that emits it, read from the tree rather
 * than hard-coded, because a merged level mesh is named `<zone>|<material>|<flags>`
 * and the zone is the only provenance that survives baking.
 */
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

/** Best guess at the file that authored a mesh, from its name. */
function provenance(chain) {
  const own = String(chain).split(' < ')[0];
  if (own.startsWith('prop:')) return 'src/world/props/** (props agent — this system)';
  const zone = own.split('|')[0];
  const files = ZONES.get(zone);
  if (files && files.length) return files.map((f) => `src/world/level/${f}`).join(' or ');
  if (/^ai|enemy|actor/i.test(own)) return 'src/ai/**';
  return 'unknown';
}

const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=d3d11', '--disable-gpu-sandbox', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
const pageErrors = [];
const propsLog = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
// The dressing passes print their own falsifiable counts. Capturing them here is
// how you tell "the pass did not fire" from "the pass fired and did not help" —
// which is the distinction four rounds of this defect never made.
page.on('console', (m) => {
  const t = m.text();
  if (/^\[(props|level)\]/.test(t)) propsLog.push(t);
  if (m.type() === 'error') pageErrors.push(t);
});

const q = new URLSearchParams({
  freeze: '1', hud: '0', quality: 'cinematic', vm: '0',
  tod: view.tod ?? 'golden', pos: view.pos, yaw: String(view.yaw ?? 0), pitch: String(view.pitch ?? 0),
});
await page.goto(`${url}/?${q}`, { waitUntil: 'domcontentloaded', timeout: 300000 });
await page.waitForFunction('window.__ready === true', null, { timeout: 300000 });
await page.waitForTimeout(900);

let failed = false;
let lastResult = null;

if (pixel) {
  // Several pixels per page load: 'x,y;x,y;x,y'. Loading the level takes far
  // longer than the raycast, so probing one pixel per process is a waste.
  for (const one of pixel.split(';')) {
    const [px, py] = one.split(',').map(Number);
    const r = await page.evaluate(`(${PIXEL_PROBE})(${JSON.stringify(CFG)}, ${px}, ${py})`);
    console.log(`\n=== pixel probe: ${viewName} ${r.resolution} pixel (${px},${py}) ===`);
    console.log(`  camera ${r.camera.map((v) => v.toFixed(2)).join(', ')}`);
    if (!r.hit) console.log('  nothing hit (sky)');
    else {
      console.log(`  MESH        ${r.hit.name}${r.hit.instanced ? ` [instance ${r.hit.instance}]` : ''}`);
      console.log(`  parents     ${r.hit.chain}`);
      console.log(`  material    ${r.hit.material}  surface=${r.hit.surface}`);
      console.log(`  world       ${r.hit.point.map((v) => v.toFixed(2)).join(', ')}  at ${r.hit.t.toFixed(2)}m`);
      console.log(`  SOURCE      ${provenance(r.hit.chain)}`);
    }
  }
} else {
  /*
   * TWO WELD RADII, AND THE BUILD FAILS ON EITHER.
   *
   * THIS IS THE INSTRUMENT BUG THAT KEPT THIS DEFECT ALIVE FOR SEVEN ROUNDS.
   * Islands were welded at a 0.28 m radius while "touching" meant 0.05 m, so
   * any piece between 5 cm and 28 cm from its neighbour was ABSORBED INTO that
   * neighbour's island and could never be reported: its own daylight became an
   * internal detail of a bigger island whose measured gap was zero. The plate
   * the round-9 review named -- vertical.png's top-left, `hall|metal_rusted` at
   * (-6.9, 5.8, 0.5), raised twice before -- printed as
   *   " HELD  5.66 x 1.43 x 2.14 m ... DAYLIGHT to nearest other surface: 0 m"
   * because it had been welded to a catwalk it is 9.9 cm clear of. The tool
   * said the level was fine at the exact spot the reviewer circled.
   *
   * Coarse and fine answer different questions and both matter:
   *   0.14   does this ASSEMBLY float?        (a braced sign and its bracket)
   *   0.025  does any PIECE float within it?  (the piece the reviewer sees)
   * The fine radius equals cfg.contact, which is what closes the band for good.
   * --cell pins a single radius when you want to compare one against the other.
   */
  const welds = args.includes('--cell') ? [CFG.cell] : [0.14, 0.025];
  for (const cell of welds) {
  const r = await page.evaluate(
    `(${PROBE})(${JSON.stringify({ ...CFG, cell })}, ${JSON.stringify(EYES)})`,
  );
  lastResult = r;
  if (r.error) {
    console.log(`floatcheck: ${r.error}`);
    failed = true;
  } else {
    console.log(`\n=== floatcheck — ${viewName} framing, weld radius `
      + `${cell * 2} m, cameras from tools/shoot.mjs ===`);
    console.log(`  world        ${r.meshes} visible meshes, ${r.triangles.toLocaleString()} triangles `
      + `inside |xz|<${CFG.xzLimit}m, y<${CFG.yMax}m`);
    console.log(`  islands      ${r.islands} connected components (weld radius ${cell * 2} m)`);
    console.log(`  suspects     ${r.suspects} islands off the ground (base y>${CFG.yMin} m) and `
      + `>= ${CFG.minAngular * 1000} mrad in frame`);
    console.log(`  structure    ${r.structure} islands over ${CFG.structureDim} m or `
      + `${CFG.structureTris} tris — the building fabric, counted as ground`);
    console.log(`  supported    ${r.supported} within ${CFG.contact * 100} cm of another island `
      + '(transitively down to structure)');
    console.log(`  FLOATING     ${r.floating}  of which ${r.severe} SEVERE `
      + `(panel-shaped: face ${CFG.severeFace}-${CFG.severeDim} m, gap >= ${CFG.severeGap} m, `
      + `>= ${CFG.severeFaceMrad}/${CFG.severeGapMrad} mrad in frame)`);
    console.log(`               worst measured gap ${r.worstGap} m · pass timings ${r.ms.join('/')} ms`);

    const row = (it, tag) => {
      console.log(`\n${tag} ${it.size.join(' x ')} m  @ ${it.centre.join(', ')}  base y=${it.baseY}`);
      console.log(`        DAYLIGHT to nearest other surface: `
        + `${it.gap === null ? `> ${CFG.reach} m (nothing in reach)` : `${it.gap} m`}`);
      console.log(`        face ${it.face} m = ${it.faceMrad} mrad, gap = ${it.gapMrad} mrad, `
        + `from ${it.eye}`);
      console.log(`        ${it.tris} tris, ${it.verts} sampled verts`);
      for (const o of it.owners) console.log(`        mesh   ${o}`);
      console.log(`        SOURCE ${[...new Set(it.owners.map(provenance))].join(' + ')}`);
      if (it.nearestOwner) console.log(`        nearest ${it.nearestOwner}`);
    };

    for (const a of r.at ?? []) {
      console.log(`\n--- island nearest ${a.query.join(',')}`
        + `${a.none ? ' : no suspect island found' : ` (box distance ${a.boxDistance} m)`} ---`);
      if (!a.none) row(a, a.supported ? ' HELD ' : (a.severe ? 'SEVERE' : ' FLOAT'));
    }

    // Who owns the floats. This is the number that decides whether the props
    // agent can fix them at all, so it is printed rather than inferred.
    const bucket = new Map();
    for (const it of r.allSuspects) {
      if (it.supported) continue;
      for (const src of new Set(it.owners.map(provenance))) {
        const k = src.split(' or ')[0];
        const e = bucket.get(k) ?? { n: 0, severe: 0 };
        e.n++; if (it.severe) e.severe++;
        bucket.set(k, e);
      }
    }
    console.log('\n--- floats by authoring system (a float can touch two) ---');
    for (const [k, e] of [...bucket].sort((a, b) => b[1].severe - a[1].severe)) {
      console.log(`  ${String(e.severe).padStart(4)} severe / ${String(e.n).padStart(4)} total   ${k}`);
    }

    if (r.sunk) {
      console.log(`\n--- ${r.groundPlates} loose ground plates measured for INTERSECTION: `
        + `${r.sunk} have another island's floor surface inside their own thickness, `
        + `${r.sunkFail} of those visibly so (>= 2 cm at >= 8 mrad, face >= 60 mrad) ---`);
      for (const it of r.sunkList.slice(0, 6)) {
        console.log(`\n${it.sunkMrad >= 8 && it.faceMrad >= 60 ? ' SUNK ' : ' sunk '} `
          + `${it.size.join(' x ')} m  @ ${it.centre.join(', ')}  base y=${it.baseY}`);
        console.log(`        CUT BY a surface ${it.sunkDepth} m above its underside `
          + `= ${it.sunkMrad} mrad, face ${it.faceMrad} mrad, from ${it.eye}`);
        for (const o of it.owners) console.log(`        mesh   ${o}`);
        console.log(`        SOURCE ${[...new Set(it.owners.map(provenance))].join(' + ')}`);
      }
    }

    if (listAll) {
      for (const it of r.allSuspects) {
        row(it, it.supported ? '  ok  ' : (it.severe ? 'SEVERE' : ' minor'));
      }
    } else {
      for (const it of r.list) row(it, 'SEVERE');
      if (r.minor) {
        console.log(`\n--- ${r.minor} further floats below the severity gate `
          + '(advisory; --all lists everything) ---');
        for (const it of r.minorList.slice(0, 8)) row(it, ' minor');
      }
    }
    if (r.severe > 0) failed = true;
    if (r.sunkFail > 0) failed = true;
  }
  }
  if (propsLog.length) {
    console.log('\n--- what the dressing passes themselves reported ---');
    for (const l of propsLog.filter((t) => /float|contact|sandbag/i.test(t))) {
      console.log(`  ${l.replace(/\s+/g, ' ').slice(0, 400)}`);
    }
  }
}

if (jsonOut && lastResult) {
  fs.writeFileSync(jsonOut, JSON.stringify(lastResult, null, 1));
  console.log(`
wrote ${jsonOut}`);
}

if (pageErrors.length) {
  console.log(`\n${pageErrors.length} PAGE ERROR(S):`);
  for (const e of pageErrors.slice(0, 5)) console.log(`  ${e.slice(0, 200)}`);
  failed = true;
}

await page.close();
await browser.close();

if (!pixel) {
  console.log(`\n${failed ? 'FAIL' : 'PASS'} — ${failed
    ? 'a panel-shaped object is hanging in mid-air with visible daylight all round it'
    : 'no panel-shaped object is hanging in mid-air'}`);
}
process.exitCode = failed ? 1 : 0;
