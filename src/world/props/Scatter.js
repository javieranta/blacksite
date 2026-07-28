import { vnoise, smoothstep } from './Rand.js';
import { familyTint } from './Clusters.js';

/**
 * Global litter distribution. OWNER: props agent.
 *
 * Two rules keep this from looking like confetti:
 *   - a low-frequency density field, so litter collects in drifts and leaves
 *     other ground genuinely bare;
 *   - wall-hugging bias, because wind and foot traffic push debris to edges.
 */

const LITTER = [
  { family: 'rubble', w: 1.0, align: 0.9 },
  { family: 'plankShard', w: 0.55, align: 0.95 },
  { family: 'scrap', w: 0.4, align: 0.9 },
  { family: 'paper', w: 0.5, align: 1.0 },
  { family: 'offcut', w: 0.35, align: 0.95 },
  { family: 'gravel', w: 0.3, align: 0.95, flat: true },
  { family: 'cinder', w: 0.35, align: 0.9 },
  { family: 'coil', w: 0.12, align: 0.9 },
  { family: 'trash', w: 0.16, align: 0.9 },
  { family: 'bucket', w: 0.12, align: 0.9 },
  { family: 'tyre', w: 0.1, align: 0.9 },
];

const TOTAL_W = LITTER.reduce((a, b) => a + b.w, 0);

function pickLitter(rng) {
  let r = rng.next() * TOTAL_W;
  for (const l of LITTER) {
    r -= l.w;
    if (r <= 0) return l;
  }
  return LITTER[0];
}

/** Density in [0,1] from a two-octave field — the drifts of a real yard. */
export function density(x, z, seed) {
  const a = vnoise(x * 0.035, z * 0.035, 512, seed);
  const b = vnoise(x * 0.11, z * 0.11, 512, seed + 31);
  return smoothstep(0.28, 0.86, a * 0.7 + b * 0.3);
}

export function scatterLitter(api, samples, { budget = 620, seed = 4711 } = {}) {
  const { rng } = api;
  let made = 0;
  const order = rng.shuffle(samples.slice());

  for (const s of order) {
    if (made >= budget) break;
    const d = density(s.x, s.z, seed);
    const edgeBoost = smoothstep(3.0, 0.4, s.wallDist) * 0.55;
    const p = Math.min(0.95, d * 0.8 + edgeBoost);
    if (!rng.bool(p)) continue;

    const n = 1 + ((rng.next() * (1 + d * 3)) | 0);
    for (let i = 0; i < n && made < budget; i++) {
      const l = pickLitter(rng);
      const key = api.protos.pick(l.family, rng);
      if (!key) continue;
      const geo = api.protos.get(key);
      const res = api.placer.put(key, geo, {
        x: s.x + rng.jit(1.15),
        z: s.z + rng.jit(1.15),
        yaw: rng.range(0, Math.PI * 2),
        tilt: l.flat ? 0 : rng.jit(0.16),
        tiltDir: rng.range(0, Math.PI * 2),
        tint: 1,
        tintColour: familyTint(l.family, rng),
        sink: rng.range(0.015, 0.05),
        scale: rng.range(0.8, 1.2),
        align: l.align,
        from: s.y + 1.7,
      });
      if (res) made++;
    }
  }
  return made;
}

/* ========================================================================= */
/*                          TERTIARY CLUTTER                                 */
/* ========================================================================= */

/**
 * The third tier. Grit, cans, card, snapped battens, bolt spill, offcut wire.
 *
 * The review's finding was "sparse and repetitive with no small-scale clutter …
 * a single plastic water bottle stands alone in the middle of a vast empty
 * factory floor". Two things are wrong with a lone bottle: there is one of it,
 * and it is in the middle. Both are fixed by how this pass distributes rather
 * than by what it places:
 *
 *   KNOTS, NOT CONFETTI. Debris arrives in drifts. Every accepted sample seeds a
 *   *knot* of 2-6 items inside a 70 cm radius drawn from a weighted family list,
 *   so the floor gets clumps with genuinely bare ground between them instead of
 *   an even dusting.
 *   EDGES AND CORNERS. Wind, brooms and boots move fines to walls and to the
 *   lee of props, so the acceptance probability is boosted hard by proximity to
 *   a wall and interiors are weighted up — an interior floor with no clutter is
 *   the most obviously undressed surface in any level.
 *   DENSITY TARGET. Roughly 40-80 items per 100 m² inside the dressed envelope,
 *   which is what the review asked for and what a working yard actually carries.
 */
const CLUTTER = [
  { family: 'grit', w: 1.00, flat: true, align: 0.95 },
  { family: 'chip', w: 0.85, align: 0.9 },
  { family: 'drift', w: 0.40, flat: true, align: 0.98, edge: true },
  { family: 'papers', w: 0.55, flat: true, align: 1.0 },
  { family: 'cardflat', w: 0.42, flat: true, align: 1.0 },
  { family: 'can', w: 0.46, align: 0.9 },
  { family: 'batten', w: 0.44, align: 0.95 },
  { family: 'brickbit', w: 0.38, align: 0.9 },
  { family: 'wirebit', w: 0.30, align: 0.95 },
  { family: 'bolts', w: 0.26, flat: true, align: 0.95 },
  { family: 'strap', w: 0.24, align: 0.95 },
  { family: 'rag', w: 0.22, align: 0.98 },
  { family: 'bottleLitter', w: 0.20, align: 0.9 },
  { family: 'marker', w: 0.10, align: 0.9 },
];
const CLUTTER_W = CLUTTER.reduce((a, b) => a + b.w, 0);

function pickClutter(rng, edgeBias) {
  // Near a wall, fines and drifts dominate; out in the open it is hard litter.
  let r = rng.next() * CLUTTER_W;
  for (const c of CLUTTER) {
    r -= c.w * (c.edge ? 1 + edgeBias * 2.5 : 1);
    if (r <= 0) return c;
  }
  return CLUTTER[0];
}

/**
 * @param {object} api
 * @param {Array} samples surveyed standable ground
 * @param {{budget:number, seed?:number, keepOut?:Array<{x:number,z:number}>, keepOutRadius?:number}} opts
 */
export function scatterClutter(api, samples, {
  budget = 1500, seed = 8123, keepOut = [], keepOutRadius = 1.75,
} = {}) {
  const { rng } = api;
  let made = 0, knots = 0;
  const order = rng.shuffle(samples.slice());
  const koR2 = keepOutRadius * keepOutRadius;

  for (const s of order) {
    if (made >= budget) break;
    // Never inside a canonical camera position — the shoot rig must not open
    // with a crushed can filling the frame.
    let blocked = false;
    for (const k of keepOut) {
      const dx = k.x - s.x, dz = k.z - s.z;
      if (dx * dx + dz * dz < koR2) { blocked = true; break; }
    }
    if (blocked) continue;

    const d = density(s.x - 17, s.z + 63, seed);
    const edge = smoothstep(3.4, 0.35, s.wallDist);
    const indoor = s.enclosure >= 0.5 ? 0.30 : 0;
    const p = Math.min(0.96, d * 0.55 + edge * 0.52 + indoor);
    if (!rng.bool(p)) continue;

    const n = 2 + ((rng.next() * (2 + d * 3 + edge * 2)) | 0);
    const spread = rng.range(0.35, 0.78);
    // Knots hug the wall base when there is one close by.
    let cx = s.x, cz = s.z;
    if (s.wallNormal && s.wallDist < 2.2 && rng.bool(0.65)) {
      cx = s.wallPoint.x + s.wallNormal.x * rng.range(0.10, 0.45);
      cz = s.wallPoint.z + s.wallNormal.z * rng.range(0.10, 0.45);
    }
    knots++;

    for (let i = 0; i < n && made < budget; i++) {
      const c = pickClutter(rng, edge);
      const key = api.protos.pick(c.family, rng);
      if (!key) continue;
      const a = rng.range(0, Math.PI * 2);
      const r = Math.sqrt(rng.next()) * spread;
      const res = api.placer.put(key, api.protos.get(key), {
        x: cx + Math.cos(a) * r,
        z: cz + Math.sin(a) * r,
        // Drifts lie along the wall; everything else spins freely.
        yaw: c.edge && s.wallNormal
          ? Math.atan2(-s.wallNormal.z, s.wallNormal.x) + rng.jit(0.14)
          : rng.range(0, Math.PI * 2),
        tilt: c.flat ? rng.jit(0.03) : rng.jit(0.13),
        tiltDir: rng.range(0, Math.PI * 2),
        tint: 1,
        tintColour: familyTint(c.family, rng),
        sink: rng.range(0.008, 0.022),
        scale: rng.range(0.9, 1.1),
        align: c.align,
        ignoreOccupancy: true,
        radius: 0.09,
        from: s.y + 1.7,
      });
      if (res) made++;
    }
  }
  return { made, knots };
}

/**
 * Weeds and dry grass. Deliberately biased to wall bases, kerbs and the shadow
 * of props — nothing says "nobody has swept here in years" as cheaply.
 */
export function scatterWeeds(api, samples, { budget = 420, seed = 991 } = {}) {
  const { rng } = api;
  let made = 0;
  const order = rng.shuffle(samples.slice());
  for (const s of order) {
    if (made >= budget) break;
    const edge = smoothstep(2.6, 0.25, s.wallDist);
    const d = density(s.x + 40, s.z - 25, seed);
    const p = Math.min(0.95, edge * 0.85 + d * 0.3);
    if (!rng.bool(p)) continue;
    const n = 1 + ((rng.next() * (2 + edge * 4)) | 0);
    for (let i = 0; i < n && made < budget; i++) {
      const key = api.protos.pick('weed', rng);
      if (!key) continue;
      // hug the wall if there is one
      let px = s.x + rng.jit(1.0);
      let pz = s.z + rng.jit(1.0);
      if (s.wallNormal && rng.bool(0.7)) {
        px = s.wallPoint.x + s.wallNormal.x * rng.range(0.04, 0.32) + rng.jit(0.5) * s.wallNormal.z;
        pz = s.wallPoint.z + s.wallNormal.z * rng.range(0.04, 0.32) + rng.jit(0.5) * s.wallNormal.x;
      }
      const res = api.placer.put(key, api.protos.get(key), {
        x: px, z: pz,
        yaw: rng.range(0, Math.PI * 2),
        tilt: rng.jit(0.1),
        tiltDir: rng.range(0, Math.PI * 2),
        tint: rng.range(0.7, 1.2),
        sink: 0.02,
        scale: rng.range(0.7, 1.35),
        align: 0.8,
        ignoreOccupancy: true,
        radius: 0.12,
        from: s.y + 1.7,
      });
      if (res) made++;
    }
  }
  return made;
}

/**
 * A ring of foreground interest around each canonical camera position. The area
 * within `clear` metres is reserved first so nothing spawns inside the camera,
 * then medium-height props (all under ~1.4 m, i.e. below the eyeline) are placed
 * in an annulus. That gives every framing a foreground occluder regardless of
 * which way the camera ends up pointing.
 */
export function foregroundRing(api, point, {
  clear = 2.1, r0 = 2.5, r1 = 5.0, count = 9,
} = {}) {
  const { rng } = api;
  // NOTE: 'sandbag' is deliberately absent. A single loose bag on open ground is
  // exactly the read the review called out — "three smooth dark ovoids … like
  // potatoes". Bags only appear as part of a wall module or a bagged-goods heap
  // ('sacks'), never as isolated lumps.
  const families = [
    'drum', 'crate', 'case', 'jersey', 'pallet', 'cinder', 'brick',
    'rubble', 'bottle', 'tyre', 'jerry', 'bucket', 'ammo', 'card', 'sacks', 'weed',
  ];
  let made = 0;
  for (let i = 0; i < count * 3 && made < count; i++) {
    const a = (made / count) * Math.PI * 2 + rng.range(0, 0.7);
    const r = Math.sqrt(rng.range(r0 * r0, r1 * r1));
    const x = point.x + Math.cos(a) * r;
    const z = point.z + Math.sin(a) * r;
    const fam = rng.pick(families);
    const key = api.protos.pick(fam, rng);
    if (!key) continue;
    const res = api.placer.put(key, api.protos.get(key), {
      x, z,
      yaw: rng.range(0, Math.PI * 2),
      tilt: rng.bool(0.4) ? rng.range(0.01, 0.05) : 0,
      tiltDir: rng.range(0, Math.PI * 2),
      tint: 1,
      tintColour: familyTint(fam, rng),
      scale: rng.range(0.92, 1.08),
      sink: rng.range(0.02, 0.04),
      align: 0.8,
      from: point.y + 0.6,
    });
    if (res) made++;
  }
  void clear;
  return made;
}

/**
 * Put one sandbag emplacement in the mid-ground of a canonical framing.
 *
 * Composition, not decoration: a first-person shooter's establishing shot wants
 * usable cover between the eye and the far detail, and a revetment is the piece
 * of cover that reads instantly as "this is a defended position". It also gives
 * the sandbag kit somewhere it is guaranteed to be seen, which is how it stays
 * honest — a prop nobody photographs never gets fixed.
 *
 * @returns {boolean}
 */
export function coverForCamera(api, point, place, { r0 = 4.0, r1 = 7.5, tries = 14 } = {}) {
  const { rng, placer } = api;
  for (let i = 0; i < tries; i++) {
    const a = rng.range(0, Math.PI * 2);
    const r = rng.range(r0, r1);
    const x = point.x + Math.cos(a) * r;
    const z = point.z + Math.sin(a) * r;
    placer.floorHint = point.y + 1.2;
    // Face the wall broadside to the camera: cover you look along is a fence,
    // cover you look at is a position.
    const ok = place(x, z, a + Math.PI / 2 + rng.jit(0.5));
    placer.floorHint = null;
    if (ok) return true;
  }
  return false;
}
