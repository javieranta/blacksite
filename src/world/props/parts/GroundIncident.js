import * as THREE from 'three';
import { tubeAlong, boxUV } from '../GeoUtil.js';
import { familyTint } from '../Clusters.js';
import { DECAL, patch, segment, mergeQuads, openGround, seatQuads } from './GroundDress.js';

/**
 * Ground incident. OWNER: props agent.
 *
 * THE DEFECT
 *   "Large expanses of the courtyard floor are still a pale, uniform,
 *   near-featureless slab, which is where the eye notices flatness most."
 *
 * THE ROOT CAUSE was not a missing pass — groundMarks and apronClutter already
 * existed. It was that both of them filtered their samples down to
 * `!indoor && wallDist > 3.4`, and the hero courtyard is crossed by a signage
 * gantry, a pipe bridge and an entry canopy (so it is flagged `indoor`) and is
 * full of columns and barrier runs (so `wallDist` almost never clears 3.4 m).
 * The apron dressing was running on the parts of the level nobody was looking
 * at. `openGround` in GroundDress.js is the corrected test; this file is the
 * additional vocabulary that the corrected test can now place.
 *
 * WHAT GETS ADDED
 *   - drifts of grit and rubble banked against every kerb face and wall base
 *   - dried puddle rings in the local low spots
 *   - shrinkage crack nets and pale dust blooms, which break the slab's value
 *     in BOTH directions rather than only darkening it
 *   - run-off wash along the foot of walls, so floor and wall visibly meet
 *   - oil pools under the machinery that would actually leak
 *   - cable runs snaking across the floor between wall anchors
 *
 * BUDGET
 *   Everything except the cables is a two-triangle quad in the existing merged
 *   `decal` batch or an instance of a prototype that already exists — so the
 *   whole file costs ZERO extra draw calls and a few thousand triangles. That
 *   matters: the combat framing is within 1% of the triangle ceiling.
 */

const _v = new THREE.Vector3();
const _c = new THREE.Color();

/** Tints for the shared atlas cells. Weak — these are stains, not paint. */
const TINT = {
  damp: new THREE.Color(0.80, 0.84, 0.92),
  rust: new THREE.Color(1.06, 0.86, 0.70),
  soot: new THREE.Color(0.72, 0.72, 0.74),
  pale: new THREE.Color(1.05, 1.02, 0.94),
  plain: new THREE.Color(1, 1, 1),
};

/**
 * Find the local step at a sample: a kerb, a plinth edge, a wall base.
 * Eight probes at two radii, because a 55 cm probe ring misses a kerb that the
 * sample happens to be standing 80 cm away from — which is why the original
 * kerb-drift pass only ever found 54 of its 200 budgeted drifts.
 */
function findStep(probe, s, out) {
  let bestStep = 0;
  for (let ring = 0; ring < 2; ring++) {
    const r = 0.5 + ring * 0.42;
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2 + 0.31 + ring * 0.4;
      const ox = Math.cos(a) * r, oz = Math.sin(a) * r;
      const h = probe.ground(s.x + ox, s.z + oz, s.y + 1.3);
      if (!h) continue;
      const step = h.point.y - s.y;
      if (step > 0.04 && step < 0.55 && step > bestStep) {
        bestStep = step;
        out.set(ox, 0, oz);
      }
    }
  }
  return bestStep;
}

/**
 * Grit, chippings and rubble banked against kerbs, plinths and wall bases —
 * plus a grit-wash decal under each drift so the individual pebbles sit in
 * something instead of on nothing.
 */
export function kerbDrifts(api, samples, { budget = 230 } = {}) {
  const { rng, probe } = api;
  const open = openGround(samples, { minWall: 0.0 });
  if (!open.length) return { placed: 0, washes: 0, quads: [] };
  rng.shuffle(open);

  const quads = [];
  let placed = 0, washes = 0;
  const dir = new THREE.Vector3();

  for (const s of open) {
    if (placed >= budget) break;
    if (!rng.bool(0.46)) continue;
    const step = findStep(probe, s, dir);
    if (step === 0) continue;

    // The drift banks along the step, not out from it.
    const along = Math.atan2(-dir.z, dir.x);
    const cosA = Math.cos(along), sinA = Math.sin(along);
    const reach = rng.range(0.45, 0.9);
    const cx = s.x + dir.x * reach;
    const cz = s.z + dir.z * reach;

    // one grit wash under the whole drift
    const g = probe.ground(cx, cz, s.y + 1.2);
    if (g) {
      const len = rng.range(1.1, 2.6);
      quads.push(patch(DECAL.grit, cx, g.point.y + 0.009, cz,
        len, rng.range(0.35, 0.72), along + Math.PI / 2,
        rng.bool(0.3) ? TINT.rust : TINT.plain));
      washes++;
    }

    const n = rng.int(2, 4);
    for (let i = 0; i < n && placed < budget; i++) {
      // Flat families first: the grit-wash decal under the drift is doing most
      // of the reading, and the combat framing sits within 1% of the triangle
      // ceiling, so the instances on top of it have to be the cheap ones.
      const fam = rng.pick(['drift', 'drift', 'grit', 'grit', 'chip', 'brickbit']);
      const key = api.protos.pick(fam, rng);
      if (!key) continue;
      const t = rng.range(-1.0, 1.0);
      const res = api.placer.put(key, api.protos.get(key), {
        x: cx + cosA * t + rng.jit(0.14),
        z: cz + sinA * t + rng.jit(0.14),
        yaw: along + rng.jit(0.3),
        tilt: rng.jit(0.05), tiltDir: rng.range(0, Math.PI * 2),
        tint: 1, tintColour: familyTint(fam, rng),
        sink: rng.range(0.008, 0.024), scale: rng.range(0.8, 1.3),
        align: 0.97, ignoreOccupancy: true, radius: 0.09, from: s.y + 1.3,
      });
      if (res) placed++;
    }
  }
  return { placed, washes, quads };
}

/**
 * Dried puddles, crack nets and dust blooms across open slab.
 *
 * The three are deliberately placed by DIFFERENT rules. Puddles go to local low
 * spots (found by comparing a sample against its neighbours, so they land where
 * water would actually stand). Cracks go to the middle of large clear areas,
 * because that is where a slab has nothing else to say. Dust blooms go anywhere
 * and are the only mark in the set that is lighter than the concrete.
 */
export function slabIncident(api, samples, {
  puddles = 34, cracks = 96, blooms = 84, paint = 20, pool = null,
} = {}) {
  const { rng, probe } = api;
  const open = pool ?? openGround(samples);
  const stats = { puddles: 0, cracks: 0, blooms: 0, paint: 0, quads: [], wet: [] };
  if (!open.length) return stats;
  rng.shuffle(open);
  const quads = stats.quads;

  /* --- dried puddles in the low spots -------------------------------------- */
  for (let i = 0; i < open.length && stats.puddles < puddles; i++) {
    const s = open[i];
    // A low spot: every lateral probe comes back at or above this height.
    let low = true;
    let drop = 0;
    for (let k = 0; k < 4 && low; k++) {
      const a = (k / 4) * Math.PI * 2 + 0.6;
      const h = probe.ground(s.x + Math.cos(a) * 1.3, s.z + Math.sin(a) * 1.3, s.y + 1.2);
      if (!h) { low = false; break; }
      const d = h.point.y - s.y;
      if (d < -0.012) low = false;
      else drop += d;
    }
    if (!low || drop < 0.006) continue;
    const w = rng.range(1.3, 3.4);
    const px = s.x + rng.jit(0.5), pz = s.z + rng.jit(0.5);
    const d = w * rng.range(0.55, 0.95);
    const yaw = rng.range(0, Math.PI * 2);
    // The damp margin, in the matte batch: a puddle has a wet ring of concrete
    // round it that is darker but not reflective.
    quads.push(patch(DECAL.puddle, px, s.y + 0.010, pz, w, d, yaw, TINT.damp));
    /*
     * ...and the water itself, in the WET batch. This is the half that was
     * missing for three rounds: at roughness 0.94 a puddle decal is a bluish
     * matte smudge, and no amount of them reads as water. At roughness 0.05 over
     * a dark base the same shape returns the sky and the sun, which is the only
     * thing that says "wet" in an image. See Materials.js 'wet'.
     */
    stats.wet.push(patch(DECAL.puddle, px, s.y + 0.013, pz,
      w * rng.range(0.55, 0.78), d * rng.range(0.55, 0.78), yaw, TINT.plain, 0.92));
    stats.puddles++;
  }

  /* --- shrinkage cracking and dust blooms ---------------------------------- */
  for (let i = 0; i < open.length && stats.cracks < cracks; i++) {
    const s = open[(i * 5 + 2) % open.length];
    if (!rng.bool(0.55)) continue;
    const g = probe.ground(s.x, s.z, s.y + 1.2);
    if (!g) continue;
    const w = rng.range(2.2, 4.6);
    quads.push(patch(DECAL.crack, s.x + rng.jit(1.0), g.point.y + 0.008, s.z + rng.jit(1.0),
      w, w * rng.range(0.7, 1.15), rng.range(0, Math.PI * 2), TINT.plain,
      /*
       * 1.3-2.0 WAS TOO MUCH, and tools/groundcheck.mjs said so in the one number
       * that matters: pushing the broad cells up took hero-golden's AUTHORED share
       * of 32-px block variance from +0.73 to -0.30. Saturating a soft, cloudy
       * cell does not add detail, it lays a flat wash over the detail that was
       * there. Alpha above 1 belongs on the high-frequency cells only — the tyre
       * tread, which is a comb of hard bars — not on anything broad.
       */
      rng.range(0.9, 1.35)));
    stats.cracks++;
  }
  /*
   * Blooms come in two size classes: a minority of wide weak washes with sharper
   * marks scattered over them, which is what a floor that has weathered unevenly
   * looks like. A hundred marks all at one size and one strength reads as
   * measles. Per-quad alpha makes both cost the same two triangles.
   *
   * SIZE IS CAPPED AT 6.5 m ON PURPOSE. The first cut used 6-13 m and dropped
   * the combat framing from 27 fps to under 1: these are transparent quads with
   * a full standard-material shade, and a 13 m decal seen from 1.7 m covers most
   * of the screen, so thirty of them is thirty full-screen overdraws. Decals are
   * cheap in triangles and expensive in fill; the budget that binds here is fill.
   */
  for (let i = 0; i < open.length && stats.blooms < blooms; i++) {
    const s = open[(i * 9 + 4) % open.length];
    if (!rng.bool(0.5)) continue;
    const g = probe.ground(s.x, s.z, s.y + 1.2);
    if (!g) continue;
    const broad = rng.bool(0.22);
    const w = broad ? rng.range(4.2, 6.5) : rng.range(1.4, 4.0);
    quads.push(patch(DECAL.dust, s.x + rng.jit(1.2), g.point.y + (broad ? 0.007 : 0.009),
      s.z + rng.jit(1.2), w, w * rng.range(0.6, 1.1), rng.range(0, Math.PI * 2),
      broad && rng.bool(0.4) ? TINT.soot : TINT.pale,
      broad ? rng.range(0.20, 0.40) : rng.range(0.7, 1.0)));
    stats.blooms++;
  }

  /* --- worn bay markings --------------------------------------------------- */
  for (let i = 0; i < open.length && stats.paint < paint; i++) {
    const s = open[(i * 13 + 7) % open.length];
    if (!rng.bool(0.3)) continue;
    const g = probe.ground(s.x, s.z, s.y + 1.2);
    if (!g) continue;
    const along = s.wallNormal
      ? Math.atan2(-s.wallNormal.z, s.wallNormal.x) + rng.jit(0.05)
      : rng.pick([0, Math.PI / 2]) + rng.jit(0.05);
    const len = rng.range(2.2, 5.0);
    quads.push(patch(DECAL.paint, s.x + rng.jit(0.8), g.point.y + 0.012, s.z + rng.jit(0.8),
      len, rng.range(0.5, 0.9), along, TINT.plain));
    stats.paint++;
  }

  return stats;
}

/**
 * Run-off staining along the foot of every wall the survey found.
 *
 * A floor and a wall that meet on a clean line read as two primitives that
 * happen to intersect. A dark wash running out of the joint, thickest at the
 * wall and gone within half a metre, is the cheapest fix there is.
 */
export function wallBaseWash(api, samples, { budget = 260 } = {}) {
  const { rng, probe } = api;
  // Upper floors have wall bases too, and the interior framing looks along one.
  const near = samples.filter((s) => s.wallDist < 2.4 && s.wallNormal);
  if (!near.length) return { made: 0, quads: [] };
  rng.shuffle(near);
  const quads = [];
  let made = 0;

  for (const s of near) {
    if (made >= budget) break;
    if (!rng.bool(0.5)) continue;
    const n = s.wallNormal;
    const wp = s.wallPoint;
    if (!wp) continue;
    // Along the wall, and offset out from it by half the wash depth.
    const along = Math.atan2(-n.z, n.x);
    const depth = rng.range(0.35, 0.85);
    const px = wp.x + n.x * depth * 0.5;
    const pz = wp.z + n.z * depth * 0.5;
    const g = probe.ground(px, pz, s.y + 1.3);
    if (!g || Math.abs(g.point.y - s.y) > 0.4) continue;
    // The cell's gradient runs from its own +Z edge, so yaw it to face the wall.
    quads.push(patch(DECAL.wash, px, g.point.y + 0.010, pz,
      rng.range(1.4, 3.2), depth, along + Math.PI / 2,
      rng.bool(0.25) ? TINT.rust : TINT.soot));
    made++;
  }
  return { made, quads };
}

/**
 * Oil pools under the things that leak. Machinery positions are read back out of
 * the placer's own log, so this needs no knowledge of where the clusters chose
 * to put anything.
 */
export function machineryOil(api, { budget = 40 } = {}) {
  const { rng, probe, placer } = api;
  const LEAKY = /^(gen_|gendark_|hvac_|hvacdark_|drum_|jerry_|spool_|bottle_)/;
  const sites = placer.placed.filter((p) => LEAKY.test(p.key));
  if (!sites.length) return { made: 0, quads: [] };
  rng.shuffle(sites);
  const quads = [];
  let made = 0;

  for (const p of sites) {
    if (made >= budget) break;
    if (!rng.bool(0.55)) continue;
    const a = rng.range(0, Math.PI * 2);
    const r = p.r * rng.range(0.5, 1.5);
    const px = p.x + Math.cos(a) * r;
    const pz = p.z + Math.sin(a) * r;
    const g = probe.ground(px, pz, p.y + 1.4);
    if (!g) continue;
    const w = rng.range(0.5, 1.7);
    quads.push(patch(DECAL.oil, px, g.point.y + 0.011, pz,
      w, w * rng.range(0.7, 1.3), rng.range(0, Math.PI * 2),
      _c.copy(TINT.plain).multiplyScalar(rng.range(0.55, 0.8)).clone(),
      rng.range(1.15, 1.5)));
    // a thin runnel away from the pool, downhill-ish
    if (rng.bool(0.45)) {
      const bx = px + Math.cos(a) * rng.range(0.6, 1.8);
      const bz = pz + Math.sin(a) * rng.range(0.6, 1.8);
      const g2 = probe.ground(bx, bz, p.y + 1.4);
      if (g2) {
        const q = segment(DECAL.scuff, px, g.point.y + 0.010, pz,
          bx, g2.point.y + 0.010, bz, rng.range(0.10, 0.22), TINT.soot);
        if (q) quads.push(q);
      }
    }
    made++;
  }
  return { made, quads };
}

/**
 * Cable runs lying across the floor. Real sites route power at ground level far
 * more often than overhead, and a cable crossing the frame is one of the few
 * things that gives a large flat floor a readable direction.
 *
 * Merged into the existing `rubber` batch, so no new draw call.
 */
export function floorCables(api, samples, { runs = 10 } = {}) {
  const { rng, probe } = api;
  const open = openGround(samples, { minWall: 0.0 });
  if (open.length < 4) return 0;
  rng.shuffle(open);
  let made = 0;

  for (let i = 0; i < open.length && made < runs; i++) {
    const s = open[i];
    if (!rng.bool(0.5)) continue;
    // Walk a lazy S across the floor, sampling the real surface at every node.
    const pts = [];
    let a = rng.range(0, Math.PI * 2);
    let x = s.x, z = s.z;
    const nodes = rng.int(6, 11);
    const step = rng.range(0.85, 1.6);
    const radius = rng.range(0.018, 0.036);
    for (let k = 0; k < nodes; k++) {
      const g = probe.ground(x, z, s.y + 1.4);
      if (!g) break;
      if (pts.length && Math.abs(g.point.y - pts[pts.length - 1].y) > 0.32) break;
      pts.push(_v.set(x, g.point.y + radius * 0.72, z).clone());
      a += rng.jit(0.55);
      x += Math.cos(a) * step;
      z += Math.sin(a) * step;
    }
    if (pts.length < 4) continue;
    const geo = tubeAlong(pts, radius, 5);
    boxUV(geo, 3.2);
    api.batcher.merge('rubber', geo, api.mats.get('rubber'),
      { solid: false, castShadow: false, receiveShadow: true });
    made++;
  }
  return made;
}

/**
 * Run the whole incident pass and weld its decals into one merged batch.
 * @returns {object} counts for the build log
 */
export function groundIncident(api, samples) {
  const drifts = kerbDrifts(api, samples);
  const slab = slabIncident(api, samples);
  /*
   * An interior slab is every bit as flat as a courtyard one, and openGround
   * deliberately excludes it — so it gets its own pass over the enclosed
   * samples, at lower density and without the puddles (a hall floor drains).
   */
  /*
   * BUDGETS RAISED AND `level === 0` DROPPED, round 11.
   *
   * The old numbers came to 128 marks for every interior in the level put
   * together, and tools/surfacecheck.mjs measured what that is worth in the
   * image: in the `interior` framing the authored content moved 4.26% of floor
   * pixels and left 99.3% of 32-px blocks untouched. The level restriction made
   * it worse again — every mezzanine and upper deck was excluded outright, and
   * the interior framing looks along one.
   */
  const inside = slabIncident(api, samples, {
    pool: samples.filter((s) => s.enclosure >= 0.62),
    puddles: 18, cracks: 190, blooms: 150, paint: 34,
  });
  const wash = wallBaseWash(api, samples);
  const oil = machineryOil(api);
  const cables = floorCables(api, samples);

  const quads = [
    ...drifts.quads, ...slab.quads, ...inside.quads, ...wash.quads, ...oil.quads,
  ];
  /*
   * Standing water goes into its own batch because it is the only ground mark in
   * the level that is not an albedo change. See Materials.js 'wet': roughness
   * 0.05 over a dark base, which is what makes it return the sky instead of
   * looking like slightly bluer concrete. One extra draw call for the level.
   */
  const wetQuads = [...slab.wet, ...inside.wet];
  const wetSeated = seatQuads(api.probe, wetQuads);
  if (wetQuads.length) {
    api.batcher.merge('wet', mergeQuads(wetQuads), api.mats.get('wet'),
      { solid: false, castShadow: false, receiveShadow: false });
  }
  // Same contact guarantee as the other two decal batches — per quad, before the
  // merge destroys the per-quad identity. See GroundDress.seatQuads.
  const seated = seatQuads(api.probe, quads);
  if (quads.length) {
    api.batcher.merge('decal', mergeQuads(quads), api.mats.get('decal'),
      { solid: false, castShadow: false, receiveShadow: false });
  }
  return {
    drifts: drifts.placed,
    gritWashes: drifts.washes,
    puddles: slab.puddles + inside.puddles,
    cracks: slab.cracks + inside.cracks,
    blooms: slab.blooms + inside.blooms,
    bayMarks: slab.paint + inside.paint,
    indoorMarks: inside.cracks + inside.blooms + inside.paint + inside.puddles,
    wallWash: wash.made,
    oilPools: oil.made,
    floorCables: cables,
    decalsAirborne: seated.dropped,
    decalsSeated: seated.seated,
    decalWorst: +Math.max(seated.worst, wetSeated.worst).toFixed(3),
    wetPools: wetQuads.length,
    quads: quads.length + wetQuads.length,
  };
}
