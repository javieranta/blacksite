import * as THREE from 'three';
import { drawTie, drawStandoff } from './LevelTies.js';
import { clusterIslands } from './LevelIslands.js';
import { FAN, findAnchor, standoffPairs, eyeDistance } from './LevelAnchors.js';

/**
 * THE WORLD FLOAT AUDIT. OWNER: props agent.
 *
 * WHY THIS EXISTS — READ THIS BEFORE WRITING ANOTHER RESEAT PASS
 *   "Rusted plates float in mid-air" has been raised in FIVE consecutive reviews
 *   and four props agents have attempted it. Every one of them worked on the
 *   props system, because that is the system that owns floating-prop defects, and
 *   every one of the fixes worked. The plates stayed, because the plates are
 *   baked LEVEL geometry and some of them are `solid: false`, so they live in
 *   `level.decor` and are not even in the BVH snapshot the props system probes:
 *   Placer, ContactPass, FloatSweep and Props._auditWorld cannot see them at all.
 *
 *   The two named offenders, both measured by tools/floatcheck.mjs:
 *     hero-golden  `fg|fabric` x2 @ (5.85, 3.48, 17.84), 23.6 cm clear of
 *                  anything. src/world/level/Foreground.js buildNearBent(), the
 *                  two pieces commented "torn mineral-wool lagging peeling off
 *                  the underside of the pipe", placed 0.3 m and 1.3 m clear of
 *                  the pipe they peel off. The dimpled diamond pattern every
 *                  reviewer called "a rusted perforated plate" is the hessian
 *                  weave normal on the `fabric` recipe, seen edge-on.
 *     vertical     `hall|metal_rusted` 1.44 x 2.15 x 0.68 m @ (-6.7, 5.8, 0.64),
 *                  9.9 cm clear of the hall wall. src/world/level/Interiors.js.
 *
 *   ROUND 9: this pass EXISTED in round 8 and still did not fix either of them.
 *   Three separate reasons, all now addressed and all documented at the constant
 *   or function responsible:
 *     · MAX_DIM / DECK_SPAN excluded the vertical.png plate as "structure".
 *     · MAX_BRACES 28 discarded 44 of the 82 floats found, by its own console line.
 *     · _findAnchor tied the hero-golden panel to the OTHER floating lagging
 *       piece and reported success.
 *   And a fourth, in LevelTies.js: the ties it drew were 7.5 mm wire, which is
 *   1.1 px wide at 4.2 m.
 *
 * WHAT THIS PASS DOES ABOUT IT
 *   Props does not own the level and will not edit it. What props CAN do is what
 *   a set-dressing pass is for: find the unsupported pieces of the world by
 *   measurement, and give them visible, physically-legible support — a strap, a
 *   bolted eye plate, an angle bracket — built out of props-owned geometry that is
 *   sited by raycast, so it follows the level if the level moves.
 *
 *   1. CLUSTER. Every level mesh — colliders AND decor — is walked triangle by
 *      triangle in world space and welded into "islands" by union-find over a
 *      14 cm cell grid, so anything within ~28 cm of anything else is one object.
 *      Large triangles keep their full AABB, so a wall is one huge cluster and is
 *      skipped as structure rather than mistaken for a floating panel.
 *   2. SUSPECT. Panel-or-box shaped clusters under MAX_DIM and MAX_TRIS whose base
 *      is off the ground and which subtend more than MIN_ANGULAR from one of the
 *      shoot rig's cameras.
 *   3. PROVE. Cleared if resting on something, or if the nearest OTHER surface is
 *      within a bracket's span of its REAL VERTICES. Measuring from the bounding
 *      box is what made the first version of this pass report the round-7 panel as
 *      attached at 7 cm while it had clear sky along its whole silhouette. Read
 *      _gap() before changing that.
 *   4. BRACE. The nearest real surface within BRACE_REACH that is not itself
 *      floating, found by a 26-direction fan from the island's own vertices, and a
 *      tie drawn from a real vertex to it. Anything with nothing in reach is named
 *      and counted in the console, because props cannot invent support that is not
 *      there and should not pretend otherwise.
 *
 *   VERIFY WITH: node tools/floatcheck.mjs --view vertical
 *   That tool measures the same question from the rendered scene graph without
 *   knowing this pass exists, which is the only reason the numbers here can be
 *   trusted.
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
 *
 * ROUND 9: 2.2 -> 3.4 and DECK_SPAN 1.3 -> 2.6. THIS PAIR OF CONSTANTS WAS THE
 * BUG. The plate the round-8 review called "the clearest case" in vertical.png is
 * `hall|metal_rusted|111`, a 1.44 x 2.15 x 0.68 m island at (-6.7, 5.8, 0.64)
 * floating 9.9 cm clear of the hall wall behind it — measured by
 * tools/floatcheck.mjs, which walks the same geometry without a size filter.
 * Its middle dimension is 1.44 m, so `sorted[1] > DECK_SPAN` classified it as
 * "a floor, roof or deck plate" and this pass never looked at it again. Four
 * rounds of work on floating plates could not reach the plate.
 *
 * The gap test below is what keeps the wider band safe: a real deck resting on
 * real beams measures a gap of zero from its own vertices and is never a
 * suspect, whatever its span. Only genuinely isolated geometry gets this far.
 */
const MAX_DIM = 3.4;
/**
 * A cluster whose two LARGEST dimensions both exceed this is a floor, roof or
 * deck plate however thin it is. Bracing one with a rod looks like a mistake.
 */
const DECK_SPAN = 2.6;
/** Triangles above which a cluster is machinery or structure, not a panel. */
const MAX_TRIS = 1200;
/** Daylight allowed under a cluster before it stops counting as "resting". */
const REST_REACH = 0.055;
/**
 * THREE BANDS, NOT TWO. This is the round-9 correction to the verdict.
 *
 * Round 8 had one threshold: anything with a surface inside NEAR_REACH was
 * declared "attached" and left alone, on the reasoning that a bracket spans that
 * far so the panel is plausibly mounted. The reasoning is sound and the
 * conclusion was wrong, because a bracket that is not DRAWN does not hold
 * anything up. The plate the review called the clearest case sits 9.9 cm off the
 * hall wall — inside NEAR_REACH, therefore exempt, therefore never touched — and
 * at 6.3 m that 9.9 cm is 17 px of daylight with the new shadow pass throwing the
 * plate's own shadow onto the wall behind it. The review's words: the shadow
 * "proves the float".
 *
 *   gap <= CONTACT_GAP      touching. Nothing to do.
 *   gap <= NEAR_REACH       plausibly a standoff-mounted panel, so props DRAWS
 *                           the standoff: studs through the gap with a bolt head
 *                           on the panel face and a pad on the wall.
 *   gap >  NEAR_REACH       genuinely in mid-air. Full tie, see LevelTies.js.
 */
const CONTACT_GAP = 0.03;
/** Widest gap that a bolted standoff can plausibly account for. */
const NEAR_REACH = 0.16;
/** Standoffs drawn per panel, spread across its face. */
const STANDOFFS = 3;
/** How far a tie may reach for something to fasten to. */
const BRACE_REACH = 2.8;
/**
 * Ties we are willing to draw. Beyond this, report instead of dressing.
 *
 * ROUND 9: 28 -> 96. The round-8 console said it plainly and nobody read it:
 * "28 FLOATING and given 54 visible tie(s) ... 44 floating and left for the
 * level agent (tie budget 28)". Three fifths of the floats found were dropped on
 * the floor by the budget. 96 ties is ~38k triangles in an existing merged batch
 * and zero extra draw calls, against a level that renders 1.1M.
 */
const MAX_BRACES = 96;
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
const _o = new THREE.Vector3();
const _d = new THREE.Vector3();
const _down = new THREE.Vector3(0, -1, 0);

/** Offsets across a box face, as fractions of the face's half-extents. */
const TAPS = [[0, 0], [0.7, 0.7], [-0.7, 0.7], [0.7, -0.7], [-0.7, -0.7]];


export class LevelFloatPass {
  /** @param {import('./Surfaces.js').SurfaceProbe} probe */
  constructor(probe) {
    this.probe = probe;
    this.stats = {
      meshes: 0, triangles: 0, clusters: 0, suspects: 0,
      resting: 0, attached: 0, braced: 0, unbraceable: 0, overBudget: 0, wires: 0,
      bolted: 0, studs: 0, worst: 0,
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

  /** Weld the world into islands. See props/LevelIslands.js. */
  _cluster(meshes) {
    const { roots, triangles } = clusterIslands(meshes, {
      cell: CELL, yMin: Y_MIN, yMax: Y_MAX, xzLimit: XZ_LIMIT,
      inProbe: this._inProbe, surfaceOf: (m) => this.surfaceOf(m),
      collectPoints: this._collect,
    });
    this.stats.triangles = triangles;
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

  /* ------------------------------------------------------------------ run */

  /**
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

    /*
     * ?floatdbg=x,z,r — trace the verdict for the islands near one place.
     *
     * The counts this pass prints are aggregate, and aggregate counts are how a
     * pass gets reported as working while the one object a reviewer named goes on
     * floating: round 8's console said "28 FLOATING and given 54 visible ties"
     * and the panel in hero-golden was not one of them. With this you can ask
     * about that panel specifically and see its band, its measured gap, whether
     * an anchor was found and how far away it was.
     */
    let dbg = null;
    try {
      const q = new URLSearchParams(location.search).get('floatdbg');
      if (q) {
        const [x, z, r] = q.split(',').map(Number);
        if (Number.isFinite(x) && Number.isFinite(z)) dbg = { x, z, r: r || 2 };
      }
    } catch { /* no URL context */ }
    const trace = (c, msg) => {
      if (!dbg) return;
      const cx = (c.min[0] + c.max[0]) * 0.5, cz = (c.min[2] + c.max[2]) * 0.5;
      if (Math.hypot(cx - dbg.x, cz - dbg.z) > dbg.r) return;
      console.info(`[props][floatdbg] ${(c.max[0] - c.min[0]).toFixed(2)}x`
        + `${(c.max[1] - c.min[1]).toFixed(2)}x${(c.max[2] - c.min[2]).toFixed(2)} @`
        + `${cx.toFixed(2)},${((c.min[1] + c.max[1]) * 0.5).toFixed(2)},${cz.toFixed(2)} `
        + `tris=${c.tris} inBVH=${c.inBVH} — ${msg}`);
    };

    // 3 — verdict, in three bands. See CONTACT_GAP.
    const floating = [];
    const standoff = [];
    for (const c of suspects) {
      if (this._resting(c)) { s.resting++; trace(c, 'RESTING'); continue; }
      const gap = this._gap(c, verts.get(c));
      c.gap = gap;
      trace(c, `gap=${Number.isFinite(gap) ? gap.toFixed(3) : '>reach'} verts=${verts.get(c)?.length ?? 0}`);
      if (gap <= CONTACT_GAP) { s.attached++; continue; }
      if (gap <= NEAR_REACH) { standoff.push(c); continue; }
      floating.push(c);
    }

    /*
     * 3b — the standoff band: a panel a few centimetres off a wall is mounted on
     * spacers, so draw the spacers. This is the band round 8 exempted, and the
     * band the review's "clearest case" — the vertical.png plate, measured 9.9 cm
     * off the hall wall — was sitting in.
     *
     * Runs BEFORE the ties, because an island in this band that turns out to have
     * nothing to bolt to is not held up either, and must therefore not become a
     * legitimate anchor for the ties in step 4.
     */
    const unheld = [];
    for (const c of standoff) {
      const vs = verts.get(c);
      const pairs = vs?.length
        ? standoffPairs(this.probe, c, vs, { reach: NEAR_REACH + 0.03, count: STANDOFFS })
        : null;
      /*
       * COUNT STUDS, NOT CANDIDATES. This used to branch on `pairs.length`, so a
       * panel whose candidate pairs all produced degenerate tubes was counted as
       * bolted, was left out of the `avoid` list below, and then became a
       * legitimate anchor for the ties in step 4 — which is how the hero-golden
       * panel ended up strapped to a lagging sleeve that had itself received no
       * hardware at all. What the pass believes must be what the pass drew.
       */
      const n = pairs?.length ? drawStandoff(batcher, mats, pairs, eyeDistance(c, eyes)) : 0;
      if (n > 0) {
        s.studs += n;
        s.bolted++;
        trace(c, `STANDOFF band, ${n} stud(s) drawn to a surface `
          + `${pairs[0].from.distanceTo(pairs[0].to).toFixed(3)}m away`);
      } else {
        s.attached++;      // nothing to bolt to after all; leave it alone
        unheld.push({ min: c.min, max: c.max });
        trace(c, `STANDOFF band, ${pairs?.length ?? 0} candidate(s) but 0 studs drawn `
          + '— NOT counted as held');
      }
    }
    if (!floating.length) return s;

    // Most visible first, so the brace budget is spent where a reviewer looks.
    floating.sort((a, b) => b.ang - a.ang);

    /*
     * The boxes a tie may NOT anchor to: everything on this list is itself in
     * mid-air. Built before any tie is drawn, so the order in which islands are
     * braced cannot let an early one become a legitimate anchor for a later one.
     */
    const avoid = floating.map((f) => ({ min: f.min, max: f.max })).concat(unheld);

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
        trace(c, 'FLOATING but over the tie budget');
        if (this.orphans.length < 10) this.orphans.push(`${size} @${where} [over tie budget]`);
        continue;
      }
      const anchor = vs && vs.length
        ? findAnchor(this.probe, c, vs, BRACE_REACH, avoid) : null;
      if (anchor) {
        // The tie's members are sized from the distance a camera sees them at.
        // A 7.5 mm wire rope 4.2 m from the hero eye is 1.1 px wide: the round-8
        // ties were geometrically correct and photographically absent, which is
        // why the review said "no bracket, bolt, hinge or cable".
        const w = drawTie(batcher, mats, c, anchor, vs, rng, eyeDistance(c, eyes));
        trace(c, `FLOATING, anchor ${anchor.dist.toFixed(3)}m away at `
          + `${anchor.point.x.toFixed(2)},${anchor.point.y.toFixed(2)},`
          + `${anchor.point.z.toFixed(2)} — ${w} tie(s) drawn`);
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
      trace(c, `FLOATING and UNBRACEABLE — no non-floating surface within ${BRACE_REACH}m`);
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
      + `${s.attached} in contact within ${(CONTACT_GAP * 100) | 0}cm, `
      + `${s.bolted} STANDING OFF a surface by ${(CONTACT_GAP * 100) | 0}-`
      + `${(NEAR_REACH * 100) | 0}cm and given ${s.studs} visible spacer stud(s), `
      + `${s.braced} FLOATING and given ${s.wires} visible tie(s), `
      + `${s.unbraceable} floating with nothing within ${BRACE_REACH}m to fasten to, `
      + `${s.overBudget} floating and left for the level agent (tie budget ${MAX_BRACES})`;
  }
}
