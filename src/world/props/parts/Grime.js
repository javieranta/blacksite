import * as THREE from 'three';
import { familyTint } from '../Clusters.js';
import { DECAL, GRIME, patch, segment, mergeQuads, seatQuads } from './GroundDress.js';

/**
 * THE SURFACE-STORY PASS. OWNER: props agent.
 *
 * THE DEFECT (round-10 review, the single item it called highest-leverage)
 *   "the bottom 30% of interior, the centre deck of combat and hud, the centre
 *    ground and left facade of silhouette-dusk, and the bottom-left of vertical
 *    are uniform slabs carrying a noise grain and a couple of seam lines — no
 *    decals, no grime gradient at wall bases, no drainage staining, no cracks,
 *    no debris, no tyre marks."
 *
 * THE ROOT CAUSE, and it is an INSTRUMENT bug before it is a content bug.
 *   Three ground passes already existed and tools/groundcheck.mjs already said
 *   they PASS. What groundcheck measures is the mean WITHIN-block standard
 *   deviation of the floor: a statistic that a speckle normal map, an aggregate
 *   albedo and a shadow stripe all raise, and that is nearly blind to the thing
 *   the eye actually calls flatness — every 32-px block having the SAME MEAN as
 *   its neighbours. tools/surfacecheck.mjs measures the complementary statistic,
 *   the spread ACROSS block means, attributed by ablation, and on the round-10
 *   build it reads:
 *
 *     interior      authored macro spread 0.01/255,  99.3% of blocks untouched
 *     hero-golden   authored macro spread 1.30/255,  91.1% untouched
 *     combat        authored macro spread 2.99/255,  73.6% untouched
 *
 *   Interiors are the extreme case and the reason is structural, not accidental:
 *   `openGround` excludes anything with enclosure >= 0.62 by design, and the one
 *   indoor pass that compensates was budgeted at 128 marks for every interior in
 *   the level put together, restricted to `level === 0`. The hall floor in the
 *   interior framing was receiving, measurably, nothing.
 *
 * WHAT THIS FILE ADDS, in the order the review prescribed
 *   1. A large-scale dirt/AO MULTIPLY layer — the mottle over open floor, the
 *      gradient at every wall base and kerb, the pool under every prop foot,
 *      worn traffic lanes, drain sinks and rust bleed. This is a new material
 *      (Materials.js 'grime') that blends as `dst * mix(1, rgb, a)` rather than
 *      alpha-blending, so it modulates the surface instead of covering it. One
 *      draw call for the level.
 *   2. Authored incident decals in the lit batch — spalled concrete with
 *      exposed aggregate, cast drain covers, worn hazard chevrons, dried spills
 *      with a tide edge, rust runs off fixings, angular chip fields — placed
 *      over interiors as well as open ground. Zero extra draw calls; they go
 *      into the existing merged `decal` batch.
 *   3. Near-field grit scatter, inside 7 m of the canonical framings only, so
 *      it costs nothing at distance.
 *
 * ORDERING. This pass runs LAST, after ContactPass, FloatSweep and the level
 * seat pass, for the same reason contactPatches does: prop transforms have to be
 * final before anything is written underneath them.
 */

const CFG = {
  /** Mottle: one per occupied grid cell of this size, in metres. */
  mottleCell: 3.8,
  mottleBudget: 1250,
  mottleMin: 3.4,
  mottleMax: 6.2,
  wallFootBudget: 900,
  wallFootCell: 1.75,
  laneRuns: 22,
  drains: 22,
  /** Prop-foot AO. Anything with a footprint in this range gets a pool. */
  footMin: 0.18,
  footMax: 1.8,
  /** Hard cap on a foot pool's size in metres — fill rate, not triangles. */
  footSpan: 4.2,
  /** Incident decals, per family. */
  spalls: 210,
  hazards: 52,
  spills: 72,
  rustRuns: 90,
  chipFields: 340,
  /** Near-field grit: radius round each canonical camera, and pieces per ring. */
  nearRadius: 7.0,
  nearInner: 1.25,
  nearPerCamera: 130,
};

const _p = new THREE.Vector3();
const _bb = new THREE.Box3();

/**
 * Per-quad tints.
 *
 * On the GRIME material these multiply the atlas colour, which is painted very
 * dark, so their range is deliberately small: the multiply target is near black
 * whatever the tint, and ALPHA is the lever with real range on it. `rust` and
 * `soot` are worth having because they shift the HUE of the darkening, which is
 * visible on a pale slab even when the amount is not.
 */
const TONE = {
  neutral: new THREE.Color(1.00, 1.00, 1.00),
  soot: new THREE.Color(0.74, 0.75, 0.78),
  rust: new THREE.Color(1.10, 0.80, 0.62),
  plain: new THREE.Color(1, 1, 1),
};

/**
 * A LENIENT contact test for the broad grime quads.
 *
 * seatQuads (the strict one used by every lit decal pass) discards any quad
 * whose corners disagree about how far the ground is by more than 5 cm. That is
 * right for a 1 m stain and catastrophic for a 6 m mottle: a courtyard is full
 * of kerbs, plinths and 15 cm steps, so almost every broad quad would be thrown
 * away and the pass would report hundreds of marks placed and show none — which
 * is precisely the failure mode this whole round is about.
 *
 * A soft multiply gradient hanging 15 cm above a lower slab is invisible; one
 * hanging three metres over a stairwell void is not. So the test is: at least
 * half the corners must find ground within `maxDrop`, and the quad is then
 * dropped onto the HIGHEST ground under it so no part of it ever sinks.
 *
 * @param {import('../Surfaces.js').SurfaceProbe} probe
 * @param {THREE.BufferGeometry[]} list filtered IN PLACE
 */
function seatSoft(probe, list, maxDrop = 1.4) {
  const out = { checked: 0, seated: 0, dropped: 0 };
  if (!list?.length || !probe?.ok) return out;
  let w = 0;
  for (let i = 0; i < list.length; i++) {
    const g = list[i];
    const pos = g?.attributes?.position;
    if (!pos) { list[w++] = g; continue; }
    out.checked++;
    const n = pos.count;
    const step = Math.max(1, Math.floor(n / 4));
    let found = 0, sampled = 0, minDrop = Infinity;
    for (let k = 0; k < n; k += step) {
      _p.fromBufferAttribute(pos, k);
      sampled++;
      const hit = probe.ground(_p.x, _p.z, _p.y + 0.06);
      if (!hit) continue;
      const drop = _p.y - hit.point.y;
      if (drop < -0.02 || drop > maxDrop) continue;
      found++;
      if (drop < minDrop) minDrop = drop;
    }
    if (found * 2 < sampled || !Number.isFinite(minDrop)) { g.dispose(); out.dropped++; continue; }
    if (Math.abs(minDrop - 0.006) > 0.002) { g.translate(0, -(minDrop - 0.006), 0); out.seated++; }
    list[w++] = g;
  }
  list.length = w;
  return out;
}

/* ------------------------------------------------------------------------- */
/*                             THE DIRT FIELD                                  */
/* ------------------------------------------------------------------------- */
/**
 * A low-frequency scalar field over the whole level: 0 = this floor is clean,
 * 1 = this floor is filthy.
 *
 * WHY THE FIRST CUT OF THIS PASS FAILED ITS OWN ASSERTION.
 *   The mottle originally went down one quad per 3.4 m cell over every floor in
 *   the level. tools/surfacecheck.mjs measured the result and it was worse than
 *   useless: authored content covered 86.7% of the interior floor and moved it
 *   by 15.6/255, and the SPREAD across block means went DOWN, to -0.10. Grime
 *   applied everywhere at roughly the same weight is a uniform tint. It darkens
 *   a flat slab into a darker flat slab, which is the exact failure the round-9
 *   broad-wash attempt hit and which a count of quads placed cannot see.
 *
 *   Real dirt is not uniform: it is organised at the scale of the room, of the
 *   route through it, of the corner nobody sweeps — ten to thirty metres. So the
 *   layer needs a low-frequency field with genuine CLEAN regions in it, because
 *   contrast is what the eye reads and a clean patch is half of every contrast.
 *
 * Two octaves of value noise at 26 m and 11 m plus a light 5 m break-up.
 * Deterministic in world space, so it is stable across rebuilds and independent
 * of sample order.
 */
function hash2(i, j) {
  let h = Math.imul(i | 0, 374761393) ^ Math.imul(j | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function vnoise(x, z) {
  const i = Math.floor(x), j = Math.floor(z);
  const fx = x - i, fz = z - j;
  const ux = fx * fx * (3 - 2 * fx), uz = fz * fz * (3 - 2 * fz);
  const a = hash2(i, j), b = hash2(i + 1, j);
  const c = hash2(i, j + 1), d = hash2(i + 1, j + 1);
  return (a + (b - a) * ux) + ((c + (d - c) * ux) - (a + (b - a) * ux)) * uz;
}

/**
 * WAVELENGTHS ARE SET BY THE FRAME, NOT BY REALISM.
 *
 * The first version used 26 m / 11.5 m / 5.2 m, which is honest about how dirt
 * organises itself and useless here: a framing sees fifteen to twenty-five
 * metres of floor, so a 26 m octave can put an ENTIRE shot inside one clean
 * trough. Measured — the roof deck under the `vertical` framing came out at 72
 * grime quads per 250 m2 against 300+ everywhere else, and the review's "the
 * bottom-left of vertical" stayed a bare slab through a pass that had already
 * fixed the interior.
 *
 * The contrast has to live INSIDE the frame, so the dominant octave is 13 m:
 * every framing gets at least one full clean-to-filthy cycle across it.
 */
export function dirtField(x, z) {
  const f = 0.45 * vnoise(x / 13 + 11.3, z / 13 - 4.7)
    + 0.35 * vnoise(x / 6.2 - 31.1, z / 6.2 + 17.9)
    + 0.20 * vnoise(x / 2.9 + 3.3, z / 2.9 + 7.1);
  // stretch: the field's natural distribution clusters round 0.5 and a floor
  // whose dirt never reaches either end has no contrast in it at all.
  return Math.min(1, Math.max(0, (f - 0.28) * 1.95));
}

/** Bucket samples into a grid so a pass covers ground evenly instead of clumping. */
function gridPick(samples, cellSize, rng) {
  const cells = new Map();
  for (const s of samples) {
    const k = `${Math.round(s.x / cellSize)},${Math.round(s.z / cellSize)},${s.level}`;
    if (!cells.has(k)) cells.set(k, s);
  }
  const list = [...cells.values()];
  rng.shuffle(list);
  return list;
}

/* ========================================================================= */
/*                          1 — THE MULTIPLY LAYER                           */
/* ========================================================================= */

/**
 * Broad value variation over every floor in the level, interiors included.
 *
 * THIS is the pass that moves the macro-spread number. Each quad is one low
 * frequency lobe cluster three to seven metres across, laid one per grid cell so
 * they tile the floor rather than pile up in the corners the density field
 * likes. The STRENGTH is deliberately spread wide and slightly bimodal — a
 * hundred marks all at one weight average back out to a uniform slab, which is
 * exactly what the round-9 attempt at broad washes produced.
 */
function floorMottle(api, samples, quads) {
  const { rng, probe } = api;
  const pool = gridPick(samples, CFG.mottleCell, rng);
  let made = 0, skipped = 0;
  for (const s of pool) {
    if (made >= CFG.mottleBudget) break;
    const f = dirtField(s.x, s.z);
    /*
     * CLEAN IS FAINT, NOT ABSENT — and getting this wrong cost a whole cycle.
     *
     * The version before this one skipped the low end of the field entirely, on
     * the reasoning that a clean patch is the other half of every contrast. It
     * is, but tools/surfacecheck.mjs then reported 50-86% DEAD BLOCKS on combat,
     * vertical and silhouette-dusk: half the floor was back to carrying nothing
     * at all, which is the original defect with a better excuse. A real clean
     * floor still has dust on it. So every cell gets a quad and the FIELD sets
     * the weight over an 0.10-0.95 range — a nine-to-one contrast, with no part
     * of the floor left untouched. Only a small random fraction is skipped, to
     * keep the coverage from reading as a regular grid.
     */
    if (rng.next() < 0.10) { skipped++; continue; }
    const g = probe.ground(s.x, s.z, s.y + 1.2);
    if (!g) continue;
    const w = rng.range(CFG.mottleMin, CFG.mottleMax);
    /*
     * Strength tracks the field, hard. The tint barely matters here: the atlas
     * cells are painted very dark, so the multiply target is near black however
     * it is tinted, and ALPHA is the only lever with real range on it.
     */
    const a = 0.10 + f * f * 0.85;
    quads.push(patch(
      rng.bool(0.5) ? GRIME.mottleA : GRIME.mottleB,
      s.x + rng.jit(1.2), g.point.y + 0.006, s.z + rng.jit(1.2),
      w, w * rng.range(0.62, 1.05), rng.range(0, Math.PI * 2),
      f > 0.7 ? TONE.soot : TONE.neutral, Math.min(1, a * rng.range(0.8, 1.2)),
    ));
    made++;
  }
  return { made, skipped };
}

/**
 * The gradient where a floor meets something vertical.
 *
 * "No grime gradient at wall bases" was the review's first named omission, and
 * it is the cheapest realism there is: real rooms accumulate dirt at every
 * junction. Unlike the lit wall-base wash this runs on EVERY level and inside
 * enclosed rooms, which is where the defect is worst.
 */
function wallFootGrime(api, samples, quads) {
  const { rng, probe } = api;
  const near = samples.filter((s) => s.wallDist < 2.5 && s.wallNormal && s.wallPoint);
  const pool = gridPick(near, CFG.wallFootCell, rng);
  let made = 0;
  for (const s of pool) {
    if (made >= CFG.wallFootBudget) break;
    const n = s.wallNormal, wp = s.wallPoint;
    const along = Math.atan2(-n.z, n.x);
    const depth = rng.range(0.55, 1.35);
    const px = wp.x + n.x * depth * 0.5;
    const pz = wp.z + n.z * depth * 0.5;
    const g = probe.ground(px, pz, s.y + 1.4);
    if (!g || Math.abs(g.point.y - s.y) > 0.5) continue;
    // The field modulates the wall base too, so a clean room's skirting stays
    // comparatively clean and the contrast survives at the room scale.
    const fa = 0.30 + dirtField(px, pz) * 0.70;
    quads.push(patch(GRIME.edge, px, g.point.y + 0.006, pz,
      rng.range(1.6, 3.4), depth, along + Math.PI / 2,
      rng.bool(0.22) ? TONE.rust : TONE.neutral, Math.min(1, fa * rng.range(0.8, 1.15))));
    made++;
    // Rust weeping out of a fixing, half the time, offset along the same wall.
    if (rng.bool(0.16)) {
      const t = rng.range(-1.2, 1.2);
      const bx = px + Math.cos(along) * t, bz = pz + Math.sin(along) * t;
      const bg = probe.ground(bx, bz, s.y + 1.4);
      if (bg) {
        quads.push(patch(GRIME.bleed, bx, bg.point.y + 0.006, bz,
          rng.range(0.35, 0.8), rng.range(0.7, 1.6), along + Math.PI / 2,
          TONE.rust, rng.range(0.5, 0.95)));
      }
    }
  }
  return made;
}

/**
 * A soft occlusion pool under every prop foot.
 *
 * The second half of the review's first item — "column feet and under props".
 * ContactPass and FloatSweep have already guaranteed each of these bounding
 * boxes is resting on something, so unlike every other quad in this file these
 * are NOT re-seated: a prop may be standing on another prop, and props are not
 * in the world BVH, so a contact test would delete exactly the ones that need
 * the cue most. Same reasoning as GroundDress.contactPatches, which this
 * complements — that pass fakes a missing shadow for small litter, this one adds
 * the accumulated dirt that a real shadow would not supply.
 */
function propFootGrime(api, quads) {
  let made = 0;
  for (const p of api.batcher.protos()) {
    if (!p.geometry?.attributes?.position) continue;
    if (!p.geometry.boundingBox) p.geometry.computeBoundingBox();
    const gb = p.geometry.boundingBox;
    const localR = Math.max(gb.max.x - gb.min.x, gb.max.z - gb.min.z) * 0.5;
    if (localR < CFG.footMin || localR > CFG.footMax) continue;
    for (let i = 0; i < p.matrices.length; i++) {
      const m = p.matrices[i];
      _bb.copy(gb).applyMatrix4(m);
      const w = _bb.max.x - _bb.min.x, d = _bb.max.z - _bb.min.z;
      const r = Math.max(w, d) * 0.5;
      if (r < CFG.footMin || r > CFG.footMax) continue;
      const tight = r > 0.5;
      quads.push(patch(tight ? GRIME.foot : GRIME.pool,
        (_bb.min.x + _bb.max.x) * 0.5, _bb.min.y + 0.005, (_bb.min.z + _bb.max.z) * 0.5,
        Math.min(CFG.footSpan, w * 2.1 + 0.14), Math.min(CFG.footSpan, d * 2.1 + 0.14),
        Math.atan2(m.elements[8], m.elements[10]),
        TONE.neutral, tight ? 0.85 : 0.62));
      made++;
    }
  }
  return made;
}

/**
 * Worn traffic lanes: a soft band walked end to end across the floor.
 *
 * The only broad mark in the set with a DIRECTION. A slab with a lane across it
 * has a history of use and, more usefully for the image, a line the eye can
 * follow into depth — which is what stops a large floor reading as a plane.
 */
function trafficLanes(api, samples, quads) {
  const { rng, probe } = api;
  const pool = samples.filter((s) => s.wallDist > 1.6);
  if (pool.length < 8) return 0;
  rng.shuffle(pool);
  let runs = 0;
  for (let i = 0; i < pool.length && runs < CFG.laneRuns; i++) {
    const s = pool[i];
    let a = rng.range(0, Math.PI * 2);
    let x = s.x, z = s.z;
    const width = rng.range(1.5, 2.6);
    const step = rng.range(2.4, 4.2);
    const alpha = rng.range(0.34, 0.72);
    let prev = null, laid = 0;
    for (let k = 0; k < rng.int(4, 8); k++) {
      const g = probe.ground(x, z, s.y + 1.5);
      if (!g || Math.abs(g.point.y - s.y) > 1.6) break;
      const node = { x, y: g.point.y + 0.006, z };
      if (prev) {
        const q = segment(GRIME.lane, prev.x, prev.y, prev.z, node.x, node.y, node.z,
          width, TONE.neutral, alpha);
        if (q) { quads.push(q); laid++; }
      }
      prev = node;
      a += rng.jit(0.22);
      x += Math.cos(a) * step;
      z += Math.sin(a) * step;
    }
    if (laid) runs++;
  }
  return runs;
}

/**
 * Floor drains: the dished sink of dirt in the grime layer plus the cast cover
 * itself in the lit batch. A slab with a drain in it is a floor that was built;
 * a slab without one is a plane that was extruded.
 */
function drains(api, samples, grimeQuads, decalQuads) {
  const { rng, probe } = api;
  const pool = gridPick(samples.filter((s) => s.wallDist > 1.3), 7.5, rng);
  let made = 0;
  for (const s of pool) {
    if (made >= CFG.drains) break;
    const g = probe.ground(s.x, s.z, s.y + 1.2);
    if (!g) continue;
    const px = s.x + rng.jit(0.6), pz = s.z + rng.jit(0.6);
    const w = rng.range(1.7, 3.1);
    grimeQuads.push(patch(GRIME.drain, px, g.point.y + 0.006, pz,
      w, w * rng.range(0.85, 1.1), rng.range(0, Math.PI * 2),
      TONE.neutral, rng.range(0.6, 1.0)));
    const cw = rng.range(0.38, 0.62);
    decalQuads.push(patch(DECAL.drainCover, px, g.point.y + 0.014, pz,
      cw, cw, rng.range(0, Math.PI * 2), TONE.plain, 1.25));
    made++;
  }
  return made;
}

/* ========================================================================= */
/*                        2 — AUTHORED INCIDENT DECALS                       */
/* ========================================================================= */

/**
 * The lit half: things that HAPPENED to this floor.
 *
 * Every mark the level carried before this round was weather — soft, edgeless,
 * scale-free. These six have edges and known real-world sizes, which is what
 * lets the eye measure a surface. They are placed over interiors and open ground
 * alike, at the 15-25 marks per 100 m2 the review asked for, and they all go
 * into the existing merged `decal` batch: no extra draw call.
 */
function incidentDecals(api, samples, quads) {
  const { rng, probe } = api;
  const stats = { spalls: 0, hazards: 0, spills: 0, rustRuns: 0, chipFields: 0 };
  if (!samples.length) return stats;

  const put = (cell, s, w, aspect, tint, alpha, jit = 0.9) => {
    const g = probe.ground(s.x, s.z, s.y + 1.2);
    if (!g) return false;
    quads.push(patch(cell, s.x + rng.jit(jit), g.point.y + 0.013, s.z + rng.jit(jit),
      w, w * aspect, rng.range(0, Math.PI * 2), tint, alpha));
    return true;
  };

  // Spalling goes where a slab actually breaks up: near edges and traffic.
  const spallPool = gridPick(samples, 2.6, rng);
  for (let i = 0; i < spallPool.length && stats.spalls < CFG.spalls; i++) {
    if (!rng.bool(0.5)) continue;
    const w = rng.range(0.55, 1.9);
    if (put(DECAL.spall, spallPool[i], w, rng.range(0.65, 1.0), TONE.plain, rng.range(0.9, 1.3), 0.7)) {
      stats.spalls++;
    }
  }
  // Chip fields are the near-field scale reference — dense, small, hard-edged.
  const chipPool = gridPick(samples, 2.2, rng);
  for (let i = 0; i < chipPool.length && stats.chipFields < CFG.chipFields; i++) {
    if (!rng.bool(0.55)) continue;
    const w = rng.range(0.7, 2.2);
    if (put(DECAL.chips, chipPool[i], w, rng.range(0.7, 1.15), TONE.plain, rng.range(0.85, 1.25))) {
      stats.chipFields++;
    }
  }
  // Hazard markings belong on thresholds and against structure, not mid-yard.
  const edgePool = gridPick(samples.filter((s) => s.wallDist < 3.2 && s.wallNormal), 4.2, rng);
  for (let i = 0; i < edgePool.length && stats.hazards < CFG.hazards; i++) {
    const s = edgePool[i];
    const g = probe.ground(s.x, s.z, s.y + 1.2);
    if (!g) continue;
    const along = Math.atan2(-s.wallNormal.z, s.wallNormal.x);
    const len = rng.range(1.6, 3.6);
    quads.push(patch(DECAL.hazard, s.x + rng.jit(0.5), g.point.y + 0.012, s.z + rng.jit(0.5),
      len, rng.range(0.45, 0.85), along + rng.jit(0.05), TONE.plain, rng.range(0.7, 1.05)));
    stats.hazards++;
  }
  // Spills and rust runs cluster round the things that spill and the things
  // that rust; both are read back out of the placer's own log.
  const LEAKY = /^(drum_|jerry_|bottle_|spool_|gen|hvac|bucket_|can_)/;
  const FERROUS = /^(jersey_|guardrail_|fencePost_|ladder_|duct_|junction_|mast_|clamp_|pipeBracket_|scrap_)/;
  const placed = api.placer.placed;
  for (const p of rng.shuffle(placed.slice())) {
    if (stats.spills >= CFG.spills && stats.rustRuns >= CFG.rustRuns) break;
    const spill = LEAKY.test(p.key), rust = FERROUS.test(p.key);
    if (!spill && !rust) continue;
    if (!rng.bool(0.4)) continue;
    const a = rng.range(0, Math.PI * 2);
    const r = p.r * rng.range(0.7, 1.8);
    const px = p.x + Math.cos(a) * r, pz = p.z + Math.sin(a) * r;
    const g = probe.ground(px, pz, p.y + 1.5);
    if (!g) continue;
    if (spill && stats.spills < CFG.spills) {
      const w = rng.range(0.6, 1.6);
      quads.push(patch(DECAL.spill, px, g.point.y + 0.012, pz,
        w, w * rng.range(0.7, 1.1), rng.range(0, Math.PI * 2), TONE.plain, rng.range(1.0, 1.4)));
      stats.spills++;
    } else if (rust && stats.rustRuns < CFG.rustRuns) {
      // The fan runs AWAY from the fixing, which is what gives it direction.
      const w = rng.range(0.35, 0.85);
      quads.push(patch(DECAL.rustRun, px, g.point.y + 0.012, pz,
        w, rng.range(0.6, 1.5), a + Math.PI / 2, TONE.plain, rng.range(1.0, 1.45)));
      stats.rustRuns++;
    }
  }
  return stats;
}

/* ========================================================================= */
/*                           3 — NEAR-FIELD SCATTER                          */
/* ========================================================================= */

/**
 * Grit, chips, bolts and wire ends inside 7 m of the canonical framings.
 *
 * The review asked for 3-8 items per square metre "in the NEAR FIELD ONLY — so
 * it costs nothing at distance". A ring rather than a disc: the innermost metre
 * and a quarter is where the camera stands, and the density-field scatter has
 * already filled the corners, so this pass only has to fill the open floor the
 * hero cameras are actually pointed at.
 *
 * Everything here is an existing prototype, so the cost is instances and
 * triangles, never draw calls.
 */
export function nearFieldGrit(api, heroes) {
  const { rng, probe } = api;
  const FAM = ['grit', 'grit', 'grit', 'chip', 'chip', 'brickbit', 'bolts', 'wirebit'];
  let made = 0;
  for (const h of heroes) {
    let placed = 0;
    for (let i = 0; i < CFG.nearPerCamera * 4 && placed < CFG.nearPerCamera; i++) {
      const a = rng.range(0, Math.PI * 2);
      // sqrt keeps the density uniform per unit area rather than piling up inside
      const r = Math.sqrt(rng.range(
        (CFG.nearInner / CFG.nearRadius) ** 2, 1,
      )) * CFG.nearRadius;
      const x = h.x + Math.cos(a) * r, z = h.z + Math.sin(a) * r;
      const g = probe.ground(x, z, h.y + 1.2);
      if (!g || Math.abs(g.point.y - (h.y - 1.6)) > 2.2) continue;
      const fam = rng.pick(FAM);
      const key = api.protos.pick(fam, rng);
      if (!key) continue;
      const res = api.placer.put(key, api.protos.get(key), {
        x, z, yaw: rng.range(0, Math.PI * 2),
        tilt: rng.jit(0.05), tiltDir: rng.range(0, Math.PI * 2),
        tint: 1, tintColour: familyTint(fam, rng),
        sink: rng.range(0.004, 0.018), scale: rng.range(0.7, 1.25),
        align: 0.96, ignoreOccupancy: true, radius: 0.07, from: g.point.y + 0.9,
      });
      if (res) { placed++; made++; }
    }
  }
  return made;
}

/* ========================================================================= */

/**
 * Run the whole surface-story pass.
 *
 * MUST run after ContactPass, FloatSweep and the seat passes so that prop
 * transforms are final, and before Batcher.build() so the quads still merge.
 *
 * @param {object} api the props build api
 * @param {Array} samples the surveyed standable ground
 * @returns {object} counts for the build log
 */
export function surfaceStory(api, samples) {
  const floor = samples.filter((s) => s.headroom > 1.9);
  const grimeQuads = [];
  const decalQuads = [];

  const mottle = floorMottle(api, floor, grimeQuads);
  const wallFoot = wallFootGrime(api, floor, grimeQuads);
  const lanes = trafficLanes(api, floor, grimeQuads);
  const drainCount = drains(api, floor, grimeQuads, decalQuads);
  /*
   * The broad quads are seated leniently and BEFORE the prop-foot pools are
   * added, because a pool derived from a validated bounding box must not be
   * re-tested against a world BVH that does not contain props. See seatSoft and
   * propFootGrime.
   */
  const softSeat = seatSoft(api.probe, grimeQuads);
  const feet = propFootGrime(api, grimeQuads);

  const incident = incidentDecals(api, floor, decalQuads);
  const decalSeat = seatQuads(api.probe, decalQuads);

  if (grimeQuads.length) {
    api.batcher.merge('grime', mergeQuads(grimeQuads), api.mats.get('grime'),
      { solid: false, castShadow: false, receiveShadow: false });
  }
  if (decalQuads.length) {
    api.batcher.merge('decal', mergeQuads(decalQuads), api.mats.get('decal'),
      { solid: false, castShadow: false, receiveShadow: false });
  }

  return {
    grimeMottle: mottle.made,
    grimeClean: mottle.skipped,
    grimeWallFoot: wallFoot,
    grimeLanes: lanes,
    grimeDrains: drainCount,
    grimeFeet: feet,
    grimeQuads: grimeQuads.length,
    grimeDropped: softSeat.dropped,
    grimeSeated: softSeat.seated,
    ...incident,
    incidentQuads: decalQuads.length,
    incidentDropped: decalSeat.dropped,
  };
}
