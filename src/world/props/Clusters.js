import * as THREE from 'three';
import { boxUV01, atlasRemap } from './GeoUtil.js';
import { SIGN } from './Atlas.js';
import { placeWallModule, bagsOnTop } from './parts/Sandbags.js';
import { ATTACHED } from './Contact.js';

/**
 * Themed dressing clusters. OWNER: props agent.
 *
 * Real spaces are not uniformly cluttered — they have a fuel point, a store, a
 * checkpoint, a wreck, and long stretches of nothing in between. Uniform scatter
 * is the single clearest tell of procedural set dressing, so all the dense
 * dressing in this level is generated as one of five *themes* placed at surveyed
 * sites, and the litter pass only fills the gaps.
 */

const _m = new THREE.Matrix4();
const _mb = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _one = new THREE.Vector3(1, 1, 1);

/**
 * Place an instance in the local frame of a composed base matrix.
 *
 * Everything routed through here is part of a rigid assembly whose position was
 * decided by its parent — a scaffold tube, a lamp housing, a bracket on a pipe,
 * a rail between two fence posts. Those are legitimately off the floor, so they
 * carry ATTACHED and ContactPass.audit leaves them alone. Anything that is
 * supposed to be standing on the ground must go through Placer.put instead.
 */
export function local(api, key, base, px, py, pz, rx = 0, ry = 0, rz = 0, tint = 1) {
  if (!api.protos.get(key)) return;
  _e.set(rx, ry, rz);
  _q.setFromEuler(_e);
  _v.set(px, py, pz);
  _m.compose(_v, _q, _one);
  _m.premultiply(base);
  api.batcher.add(key, _m, tint, null, ATTACHED);
}

export function baseMatrix(x, y, z, yaw) {
  _e.set(0, yaw, 0);
  _q.setFromEuler(_e);
  _v.set(x, y, z);
  return _mb.clone().compose(_v, _q, _one);
}

/** A quad from the signage atlas, welded into the shared sign batch. */
export function signQuad(api, cell, w, h, matrix) {
  const geo = new THREE.PlaneGeometry(w, h);
  atlasRemap(boxUV01(geo), cell[0], cell[1], 4, 4);
  geo.applyMatrix4(matrix);
  api.batcher.merge('sign', geo, api.mats.get('sign'), { solid: false, castShadow: false, receiveShadow: false });
}

function annulus(rng, cx, cz, r0, r1) {
  const a = rng.range(0, Math.PI * 2);
  const r = Math.sqrt(rng.range(r0 * r0, r1 * r1));
  return [cx + Math.cos(a) * r, cz + Math.sin(a) * r];
}

/* ------------------------------------------------------------- weathering */

/**
 * Per-family instance colour. A greyscale tint alone cannot fix "identical
 * yellow crates": value variation without hue variation still reads as one
 * object lit differently. Each entry is a small hue/saturation envelope around
 * the material's own albedo, sampled per instance, so a run of ten crates
 * contains sun-bleached, damp and dirt-splashed members.
 */
const HUE_ENVELOPE = {
  jersey: { v: [0.84, 1.10], warm: 0.055, cool: 0.030 },
  crate: { v: [0.80, 1.12], warm: 0.075, cool: 0.022 },
  case: { v: [0.86, 1.08], warm: 0.030, cool: 0.045 },
  plasticCrate: { v: [0.80, 1.14], warm: 0.090, cool: 0.055 },
  card: { v: [0.78, 1.10], warm: 0.070, cool: 0.020 },
  cinder: { v: [0.84, 1.10], warm: 0.035, cool: 0.035 },
  brick: { v: [0.82, 1.12], warm: 0.065, cool: 0.020 },
  rubble: { v: [0.80, 1.14], warm: 0.045, cool: 0.030 },
  gravel: { v: [0.82, 1.12], warm: 0.040, cool: 0.030 },
  hescoFill: { v: [0.86, 1.08], warm: 0.035, cool: 0.030 },
  drum: { v: [0.84, 1.12], warm: 0.045, cool: 0.040 },
  pallet: { v: [0.80, 1.12], warm: 0.070, cool: 0.020 },
  _: { v: [0.86, 1.10], warm: 0.030, cool: 0.025 },
};
const _hue = new THREE.Color();

/**
 * Instance albedo multiplier for a family. Warm skews toward dust and rust,
 * cool toward damp concrete; both stay inside a few percent so nothing turns
 * into a colour-swatch parade.
 */
export function familyTint(family, rng) {
  const e = HUE_ENVELOPE[family] ?? HUE_ENVELOPE._;
  const v = rng.range(e.v[0], e.v[1]);
  const t = rng.range(-1, 1);
  const warm = t > 0 ? t * e.warm : 0;
  const cool = t < 0 ? -t * e.cool : 0;
  return _hue.setRGB(
    v * (1 + warm * 0.9 - cool * 0.35),
    v * (1 + warm * 0.25 - cool * 0.05),
    v * (1 - warm * 0.85 + cool * 1.0),
  ).clone();
}

/** Ground-place a prop from a family with sensible default jitter. */
function drop(api, family, x, z, opts = {}) {
  const key = api.protos.pick(family, api.rng);
  if (!key) return null;
  const geo = api.protos.get(key);
  return api.placer.put(key, geo, {
    x, z,
    yaw: opts.yaw ?? api.rng.range(0, Math.PI * 2),
    tilt: opts.tilt ?? (api.rng.bool(0.35) ? api.rng.range(0.008, 0.03) : 0),
    tiltDir: api.rng.range(0, Math.PI * 2),
    tint: opts.tint ?? 1,
    tintColour: opts.tintColour ?? familyTint(family, api.rng),
    // +/-10% scale on every dressed prop: the review's note about identical
    // instances is as much about size repetition as about colour.
    scale: opts.scale ?? api.rng.range(0.92, 1.08),
    sink: opts.sink ?? api.rng.range(0.02, 0.045),
    align: opts.align ?? 0.75,
    y: opts.y ?? null,
    ignoreOccupancy: opts.ignoreOccupancy ?? false,
    radius: opts.radius,
  });
}

/** Stack props on top of one another, honouring the support's real top. */
function stackOn(api, family, site, n, opts = {}) {
  let support = site;
  for (let i = 0; i < n && support; i++) {
    const key = api.protos.pick(family, api.rng);
    if (!key) break;
    const geo = api.protos.get(key);
    support = api.placer.put(key, geo, {
      x: support.x + api.rng.jit(0.06),
      z: support.z + api.rng.jit(0.06),
      y: support.top,
      yaw: api.rng.range(0, Math.PI * 2),
      tilt: api.rng.bool(0.4) ? api.rng.range(0.01, 0.04) : 0,
      tiltDir: api.rng.range(0, Math.PI * 2),
      tint: 1,
      tintColour: familyTint(family, api.rng),
      scale: api.rng.range(0.93, 1.07),
      ignoreOccupancy: true,
      ...opts,
    });
  }
  return support;
}

/* ============================== THEME: DEPOT ============================= */

export function depot(api, site) {
  const { rng } = api;
  const R = site.radius;

  // pallets with stacks on them
  const pallets = rng.int(1, 3);
  for (let i = 0; i < pallets; i++) {
    const [x, z] = annulus(rng, site.x, site.z, 0.2, R * 0.7);
    const base = drop(api, 'pallet', x, z, { tilt: 0 });
    if (!base) continue;
    if (rng.bool(0.75)) stackOn(api, rng.bool(0.6) ? 'crate' : 'card', base, rng.int(1, 3));
    else if (rng.bool(0.5)) stackOn(api, 'plasticCrate', base, rng.int(2, 3));
  }

  // loose crate groups
  const groups = rng.int(4, 7);
  for (let g = 0; g < groups; g++) {
    const [x, z] = annulus(rng, site.x, site.z, 0.4, R);
    const base = drop(api, rng.bool(0.7) ? 'crate' : 'case', x, z);
    if (base && rng.bool(0.55)) stackOn(api, rng.bool(0.5) ? 'case' : 'ammo', base, rng.int(1, 2));
  }

  // drums, sometimes toppled
  const drums = rng.int(4, 8);
  for (let i = 0; i < drums; i++) {
    const [x, z] = annulus(rng, site.x, site.z, 0.3, R * 1.05);
    if (rng.bool(0.18)) {
      drop(api, 'drum', x, z, { tilt: Math.PI / 2, align: 0.2, radius: 0.5 });
    } else {
      drop(api, 'drum', x, z, { tilt: rng.bool(0.2) ? rng.range(0.03, 0.09) : 0 });
    }
  }

  // small stuff
  for (let i = 0; i < rng.int(1, 3); i++) {
    const [x, z] = annulus(rng, site.x, site.z, 0.4, R);
    drop(api, 'jerry', x, z);
  }
  for (let i = 0; i < rng.int(1, 3); i++) {
    const [x, z] = annulus(rng, site.x, site.z, 0.5, R * 1.1);
    drop(api, rng.bool(0.5) ? 'card' : 'ammo', x, z);
  }
  if (rng.bool(0.6)) {
    const [x, z] = annulus(rng, site.x, site.z, 0.6, R);
    drop(api, 'tarp', x, z, { tilt: 0, align: 0.9 });
  }
  if (rng.bool(0.45)) {
    const [x, z] = annulus(rng, site.x, site.z, 0.8, R * 1.2);
    drop(api, 'spool', x, z, { yaw: rng.range(0, Math.PI * 2) });
  }
  for (let i = 0; i < rng.int(0, 2); i++) {
    const [x, z] = annulus(rng, site.x, site.z, 0.6, R * 1.2);
    drop(api, 'sacks', x, z);
  }
}

/* =========================== THEME: CHECKPOINT ========================== */

export function checkpoint(api, site) {
  const { rng } = api;
  const yaw = site.lineYaw ?? rng.range(0, Math.PI * 2);
  const dx = Math.cos(yaw), dz = Math.sin(yaw);

  // barrier line, deliberately imperfect
  const n = rng.int(4, 8);
  let cursor = -((n - 1) / 2) * 2.25;
  for (let i = 0; i < n; i++) {
    const gap = rng.range(0.04, 0.5);
    const x = site.x + dx * cursor + rng.jit(0.12);
    const z = site.z + dz * cursor + rng.jit(0.12);
    const key = api.protos.pick('jersey', rng);
    const res = api.placer.put(key, api.protos.get(key), {
      x, z,
      yaw: yaw + Math.PI / 2 + rng.jit(0.06),
      tilt: rng.bool(0.4) ? rng.range(0.008, 0.028) : 0,
      tiltDir: rng.range(0, Math.PI * 2),
      tint: 1,
      tintColour: familyTint('jersey', rng),
      scale: rng.range(0.95, 1.06),
      sink: rng.range(0.02, 0.04),
      align: 0.8,
    });
    if (res && rng.bool(0.5)) {
      local(api, 'chevron_0', baseMatrix(res.x, res.y, res.z, yaw + Math.PI / 2), 0, 0, 0);
    }
    // A couple of bags weighting the top of a barrier is a real thing crews do,
    // and it breaks the barrier line's flat top silhouette.
    if (res && rng.bool(0.22)) {
      bagsOnTop(api, api.protos.bagKeys, res.x, res.top, res.z,
        yaw + Math.PI / 2 + rng.jit(0.2), rng.int(1, 2));
    }
    cursor += 2.15 + gap;
  }

  // sandbag revetment offset behind the line
  if (rng.bool(0.85)) {
    const ox = site.x - dz * rng.range(1.7, 3.0);
    const oz = site.z + dx * rng.range(1.7, 3.0);
    sandbagWall(api, ox, oz, yaw + rng.jit(0.2));
  }

  // signage on a pair of posts
  if (rng.bool(0.7)) {
    const px = site.x + dx * rng.range(-3, 3) - dz * rng.range(0.5, 1.5);
    const pz = site.z + dz * rng.range(-3, 3) + dx * rng.range(0.5, 1.5);
    const post = api.placer.put('fencepost_0', api.protos.get('fencepost_0'), {
      x: px, z: pz, yaw: 0, tint: rng.range(0.85, 1.05), align: 0.9, radius: 0.25,
    });
    if (post) {
      const cell = rng.pick([SIGN.warning, SIGN.noEntry, SIGN.authorised, SIGN.muster, SIGN.highVoltage]);
      const w = rng.range(0.5, 0.72);
      const m = baseMatrix(post.x, post.y + rng.range(1.35, 1.75), post.z, yaw + Math.PI / 2 + rng.jit(0.25));
      _m.makeTranslation(0, 0, 0.04).premultiply(m);
      signQuad(api, cell, w, w, _m);
    }
  }

  // ammo cases in cover
  for (let i = 0; i < rng.int(1, 3); i++) {
    const [x, z] = annulus(rng, site.x - dz * 2.2, site.z + dx * 2.2, 0.2, 1.6);
    drop(api, rng.bool(0.5) ? 'ammo' : 'case', x, z);
  }
}

/**
 * Sandbag revetment, assembled from a pre-authored module.
 *
 * The old version laid bags one at a time and ground-snapped each of them
 * independently. That is why they never interlocked: every bag negotiated its
 * own contact height, so courses drifted apart and the result read as a line of
 * loose lumps. A module is a fixed, hand-tuned interlock — half-bag course
 * offsets, a header course, a battered face, two bags fallen off the top — and
 * placement only has to decide where the wall stands.
 *
 * @param {number} [pick] module index; omitted picks by weight
 */
export function sandbagWall(api, x, z, yaw, pick = null) {
  const { rng, protos } = api;
  const mods = protos.wallModules;
  if (!mods || !mods.length) return false;
  const idx = pick != null
    ? pick % mods.length
    : rng.pick([0, 1, 1, 2]);                   // revetments are the commonest
  return placeWallModule(api, mods[idx], x, z, yaw, { keys: protos.bagKeys });
}

/* ============================= THEME: UTILITY =========================== */

export function utility(api, site) {
  const { rng } = api;
  const R = site.radius;

  // paired-material plant: the two halves must share one transform
  const pairs = [
    ['hvacSteel', 'hvacDark'],
    ['genSteel', 'genDark'],
  ];
  const [aFam, bFam] = rng.bool(0.6) ? pairs[0] : pairs[1];
  const aList = api.protos.family(aFam), bList = api.protos.family(bFam);
  for (let i = 0; i < rng.int(1, 2) && aList.length; i++) {
    const idx = (rng.next() * aList.length) | 0;
    const key = aList[idx];
    const [x, z] = annulus(rng, site.x, site.z, 0.2, R * 0.8);
    const res = api.placer.put(key, api.protos.get(key), {
      x, z, yaw: rng.range(0, Math.PI * 2), tilt: 0, align: 0.85,
      tint: 1, tintColour: familyTint('_', rng), sink: rng.range(0.02, 0.04),
      // rigid two-material pair: both halves keep the placer's transform
      verifyContact: false,
    });
    if (res && bList[idx]) api.batcher.add(bList[idx], res.matrix, 1, null, ATTACHED);
  }

  for (let i = 0; i < rng.int(2, 4); i++) {
    const [x, z] = annulus(rng, site.x, site.z, 0.6, R);
    drop(api, 'bottle', x, z, { tilt: rng.bool(0.3) ? rng.range(0.01, 0.05) : 0 });
  }
  for (let i = 0; i < rng.int(1, 3); i++) {
    const [x, z] = annulus(rng, site.x, site.z, 0.5, R * 1.1);
    drop(api, rng.bool(0.5) ? 'bucket' : 'coil', x, z);
  }
  for (let i = 0; i < rng.int(1, 3); i++) {
    const [x, z] = annulus(rng, site.x, site.z, 0.7, R * 1.2);
    drop(api, 'offcut', x, z);
  }
  if (rng.bool(0.5)) {
    const [x, z] = annulus(rng, site.x, site.z, 0.8, R);
    drop(api, 'drum', x, z);
  }

  // a ladder, leaned against the nearest wall if there is one
  if (site.wall && rng.bool(0.6)) {
    const w = site.wall;
    const px = w.point.x + w.normal.x * 0.45;
    const pz = w.point.z + w.normal.z * 0.45;
    const yaw = Math.atan2(w.normal.x, w.normal.z);
    api.placer.put('ladder_0', api.protos.get('ladder_0'), {
      x: px, z: pz, yaw, tilt: 0.13, tiltDir: yaw + Math.PI / 2, align: 0.5,
      radius: 0.3, tint: rng.range(0.9, 1.05),
    });
  }
}

/* ============================== THEME: WRECK ============================ */

export function wreck(api, site) {
  const { rng } = api;
  const R = site.radius;
  const v = api.vehicles[(rng.next() * api.vehicles.length) | 0];
  if (v) {
    const yaw = rng.range(0, Math.PI * 2);
    const hit = api.probe.ground(site.x, site.z, api.placer.floorHint);
    if (hit) {
      const m = baseMatrix(site.x, hit.point.y - 0.03, site.z, yaw);
      let clear = true;
      // a vehicle is big — sample its footprint for support before committing
      for (const [ox, oz] of [[-2, 0], [2, 0], [0, -1], [0, 1]]) {
        const h = api.probe.ground(site.x + ox * Math.cos(yaw), site.z + oz + ox * Math.sin(yaw), hit.point.y + 1.2);
        if (!h || Math.abs(h.point.y - hit.point.y) > 0.35) { clear = false; break; }
      }
      if (clear && api.probe.isFree(site.x, site.z, 2.6)) {
        for (const [group, matName] of [['body', 'vehicle'], ['dark', 'darkmetal'], ['glass', 'glass'], ['rubber', 'tyre']]) {
          const geo = v[group];
          if (!geo || !geo.attributes?.position?.count) continue;
          const g = geo.clone();
          g.applyMatrix4(m);
          api.batcher.merge(`veh_${matName}`, g, api.mats.get(matName), {
            solid: matName !== 'glass', castShadow: true, receiveShadow: true,
          });
        }
        api.probe.claim(site.x, site.z, 2.6);
        api.placer.placed.push({ key: 'vehicle', x: site.x, y: hit.point.y, z: site.z, r: 2.6 });
      }
    }
  }

  for (let i = 0; i < rng.int(4, 9); i++) {
    const [x, z] = annulus(rng, site.x, site.z, 2.4, R * 1.3);
    drop(api, 'rubble', x, z, { align: 0.9 });
  }
  for (let i = 0; i < rng.int(1, 3); i++) {
    const [x, z] = annulus(rng, site.x, site.z, 2.6, R * 1.3);
    drop(api, 'gravel', x, z, { tilt: 0, align: 0.95 });
  }
  for (let i = 0; i < rng.int(2, 4); i++) {
    const [x, z] = annulus(rng, site.x, site.z, 2.2, R * 1.4);
    drop(api, 'scrap', x, z, { align: 0.9 });
  }
  /*
   * TYRES. The review found one hanging 1.5 m in the air. The old code stood
   * 40% of them on edge with `tilt: PI/2` and nothing to lean on, and a torus
   * standing on edge is the one shape the old bounding-box contact test could
   * not see through — its centre ray went straight down the hole. A tyre now
   * only ever lies flat, and gets *stacked* instead of stood up: a stack is what
   * a real yard has, it cannot float, and each tyre in it is verified by the
   * contact pass against the tread ring rather than the box.
   */
  for (let i = 0; i < rng.int(1, 3); i++) {
    const [x, z] = annulus(rng, site.x, site.z, 2.4, R * 1.4);
    const base = drop(api, 'tyre', x, z, { tilt: 0, align: 0.9, radius: 0.42 });
    if (base && rng.bool(0.5)) {
      stackOn(api, 'tyre', base, rng.int(1, 3), { tilt: rng.jit(0.03), align: 0 });
    }
  }
  if (rng.bool(0.6)) {
    const [x, z] = annulus(rng, site.x, site.z, 2.6, R);
    drop(api, 'drum', x, z, { tilt: Math.PI / 2, align: 0.2, radius: 0.5 });
  }
  // blast cover thrown up behind the wreck
  if (rng.bool(0.4)) {
    const yaw = rng.range(0, Math.PI * 2);
    sandbagWall(api, site.x + Math.cos(yaw) * R * 1.5, site.z + Math.sin(yaw) * R * 1.5,
      yaw + Math.PI / 2, 0);
  }
}

/* =========================== THEME: CONSTRUCTION ======================== */

export function construction(api, site) {
  const { rng } = api;
  const R = site.radius;

  if (rng.bool(0.85)) {
    const yaw = site.lineYaw ?? rng.range(0, Math.PI * 2);
    scaffoldTower(api, site.x, site.z, yaw, rng.int(1, 2));
  }
  for (let i = 0; i < rng.int(1, 3); i++) {
    const [x, z] = annulus(rng, site.x, site.z, 1.8, R);
    const base = drop(api, 'pallet', x, z, { tilt: 0 });
    if (base && rng.bool(0.5)) stackOn(api, 'cinder', base, rng.int(2, 4));
  }
  for (let i = 0; i < rng.int(2, 5); i++) {
    const [x, z] = annulus(rng, site.x, site.z, 1.6, R * 1.2);
    drop(api, 'brick', x, z);
  }
  for (let i = 0; i < rng.int(2, 5); i++) {
    const [x, z] = annulus(rng, site.x, site.z, 1.5, R * 1.3);
    drop(api, 'plankShard', x, z, { align: 0.95 });
  }
  for (let i = 0; i < rng.int(1, 3); i++) {
    const [x, z] = annulus(rng, site.x, site.z, 1.8, R * 1.2);
    drop(api, 'cinder', x, z);
  }
  if (rng.bool(0.6)) {
    const [x, z] = annulus(rng, site.x, site.z, 2.0, R);
    drop(api, 'gravel', x, z, { tilt: 0, align: 0.95 });
  }
  if (site.wall && rng.bool(0.55)) {
    const w = site.wall;
    api.placer.put('board_0', api.protos.get('board_0'), {
      x: w.point.x + w.normal.x * 0.28,
      z: w.point.z + w.normal.z * 0.28,
      yaw: Math.atan2(w.normal.x, w.normal.z),
      tilt: 0.16, tiltDir: Math.atan2(w.normal.x, w.normal.z) + Math.PI / 2,
      align: 0.4, radius: 0.22, tint: rng.range(0.88, 1.08),
    });
  }
}

/**
 * Scaffold tower from the instanced tube kit. Verticals rest on the probed
 * ground, so the tower is contact-correct by construction.
 */
export function scaffoldTower(api, x, z, yaw, bays = 1) {
  const { rng } = api;
  const hit = api.probe.ground(x, z, api.placer.floorHint);
  if (!hit) return;
  const w = 2.0, d = 1.35, h = 2.8;
  const base = baseMatrix(x, hit.point.y, z, yaw);
  const spanX = w * bays;
  if (!api.probe.isFree(x, z, Math.max(spanX, d) * 0.5)) return;

  for (let b = 0; b <= bays; b++) {
    const px = (b - bays / 2) * w;
    for (const sz of [-1, 1]) {
      local(api, 'tube280', base, px, h / 2 - 0.02, sz * d / 2, 0, 0, 0, rng.range(0.9, 1.08));
    }
  }
  for (const y of [0.35, 1.25, 2.15]) {
    for (const sz of [-1, 1]) {
      for (let b = 0; b < bays; b++) {
        const px = (b - bays / 2 + 0.5) * w;
        local(api, 'tube200', base, px, y, sz * d / 2, 0, 0, Math.PI / 2, rng.range(0.9, 1.05));
        local(api, 'clamp_0', base, px - w / 2, y, sz * d / 2);
        local(api, 'clamp_0', base, px + w / 2, y, sz * d / 2);
      }
    }
    for (let b = 0; b <= bays; b++) {
      const px = (b - bays / 2) * w;
      local(api, 'tube140', base, px, y, 0, Math.PI / 2, 0, 0, rng.range(0.9, 1.05));
    }
  }
  // diagonal braces on the long faces
  for (let b = 0; b < bays; b++) {
    const px = (b - bays / 2 + 0.5) * w;
    const ang = Math.atan2(w, 1.8);
    for (const sz of [-1, 1]) {
      local(api, 'tube280', base, px, 1.25, sz * d / 2, 0, 0, sz > 0 ? ang : -ang, rng.range(0.9, 1.05));
    }
  }
  // deck
  for (let b = 0; b < bays; b++) {
    const px = (b - bays / 2 + 0.5) * w;
    for (const off of [-0.13, 0.13]) {
      local(api, 'plank240', base, px, 2.2, off, 0, 0, 0, rng.range(0.88, 1.1));
    }
  }
  // odds and ends on the deck
  if (rng.bool(0.5)) {
    local(api, api.protos.pick('bucket', rng) ?? 'bucket_0', base, rng.jit(0.6), 2.24, rng.jit(0.3));
  }
  api.probe.claim(x, z, Math.max(spanX, d) * 0.45);
}

/**
 * Chain-link fence run. Posts are individually ground-snapped and leaned, the
 * mesh panels sag, and the run stops the moment the ground disappears.
 */
export function fenceRun(api, x, z, yaw, sections) {
  const { rng } = api;
  const dx = Math.cos(yaw), dz = Math.sin(yaw);
  const span = 2.4;
  let prev = null;
  for (let i = 0; i <= sections; i++) {
    const px = x + dx * i * span + rng.jit(0.05);
    const pz = z + dz * i * span + rng.jit(0.05);
    const post = api.placer.put('fencepost_0', api.protos.get('fencepost_0'), {
      x: px, z: pz, yaw: rng.range(0, 3), tilt: rng.jit(0.035), tiltDir: rng.range(0, 6.28),
      align: 0.8, radius: 0.22, tint: rng.range(0.85, 1.08), ignoreOccupancy: i > 0,
    });
    if (!post) { prev = null; continue; }
    if (prev) {
      const mx = (prev.x + post.x) / 2, mz = (prev.z + post.z) / 2;
      const my = Math.min(prev.y, post.y);
      const b = baseMatrix(mx, my, mz, yaw);
      local(api, api.protos.pick('chainPanel', rng) ?? 'chainpanel_0', b, 0, 0, 0);
      local(api, 'fencerail_0', b, 0, 1.98, 0, 0, 0, 0, rng.range(0.9, 1.05));
      local(api, 'fencerail_0', b, 0, 0.06, 0, 0, 0, 0, rng.range(0.9, 1.05));
      if (rng.bool(0.22)) {
        const cell = rng.pick([SIGN.warning, SIGN.noEntry, SIGN.keepClear, SIGN.sector]);
        _m.makeTranslation(0, 1.25, 0.05);
        _m.premultiply(b);
        signQuad(api, cell, 0.52, 0.52, _m);
      }
    }
    prev = post;
  }
}
