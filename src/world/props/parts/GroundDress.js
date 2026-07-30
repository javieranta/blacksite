import * as THREE from 'three';
import { boxUV01, atlasRemap } from '../GeoUtil.js';
import { familyTint } from '../Clusters.js';

/**
 * Open-ground dressing. OWNER: props agent.
 *
 * TWO PROBLEMS, ONE PASS
 *
 * 1. THE BARE APRON. The round-5 combat frame has ten metres of empty concrete
 *    across the middle of the image. The existing clutter scatter is driven by a
 *    density field plus a wall-proximity boost, which is right for corners and
 *    wrong for the middle of a yard: out in the open, both terms are near zero,
 *    so the open ground gets nothing. What a real apron actually carries is not
 *    more objects — it is MARKS. Tyre tracks, scuff smears, oil, and grit swept
 *    into the lee of every kerb. Those cost one merged draw call and they are
 *    what stops a slab reading as a slab of nothing.
 *
 * 2. LITTER THAT LOOKS LIKE IT IS HOVERING. Several hundred small props are
 *    drawn with castShadow off — correct, because each shadow-casting prototype
 *    costs a draw call in every shadow cascade and there are eighty of them —
 *    but an unshadowed object on a flat floor under a low sun has no contact
 *    cue at all and the eye reads it as floating. That is most of what the
 *    review saw as "floating props" in the mid-ground. Rather than buy sixty
 *    shadow draws, this pass drops a soft contact patch under every one of them:
 *    one more quad in the same merged decal batch, zero extra draw calls.
 *
 * Everything here writes into the shared `decal` batch (transparent, no depth
 * write, polygon-offset toward the camera) or reuses prototypes that already
 * exist, so the whole file costs exactly one draw call.
 */

/** 4x4 decal atlas cells — [col, uvRow]; see paint/Extras.buildDecalAtlas. */
export const DECAL = {
  tyre: [0, 3],
  scuff: [1, 3],
  oil: [2, 3],
  contact: [3, 3],
  puddle: [0, 2],
  crack: [1, 2],
  dust: [2, 2],
  wash: [3, 2],
  grit: [0, 1],
  paint: [1, 1],
  /* Incident, added for the surface-story pass — see paint/Extras.js. */
  spall: [2, 1],
  drainCover: [3, 1],
  hazard: [0, 0],
  spill: [1, 0],
  rustRun: [2, 0],
  chips: [3, 0],
};

/** 4x4 grime atlas cells — the multiply layer; see paint/Extras.buildGrimeAtlas. */
export const GRIME = {
  pool: [0, 3],
  edge: [1, 3],
  bleed: [2, 3],
  mottleA: [3, 3],
  mottleB: [0, 2],
  lane: [1, 2],
  drain: [2, 2],
  foot: [3, 2],
};

const _v = new THREE.Vector3();
const _p = new THREE.Vector3();
const _white = new THREE.Color(1, 1, 1);

/**
 * Attach a flat per-quad RGBA so the shared atlas can serve several moods.
 *
 * The alpha channel is the important half. three enables USE_COLOR_ALPHA when
 * the `color` attribute has four components, and then multiplies vColor into
 * diffuseColor including its alpha — so one cell of the atlas can be laid down
 * as a broad 12 m sun-bleach wash at a fifth of its strength AND as a sharp 2 m
 * stain at full strength, with no second texture and no second draw call.
 * Layering weak wide marks under strong narrow ones is what actually breaks up
 * a big pale slab; a hundred marks all at the same strength just look spotty.
 */
function tintQuad(g, colour, alpha = 1) {
  const n = g.attributes.position.count;
  const c = new Float32Array(n * 4);
  const col = colour ?? _white;
  for (let i = 0; i < n; i++) {
    c[i * 4] = col.r; c[i * 4 + 1] = col.g; c[i * 4 + 2] = col.b; c[i * 4 + 3] = alpha;
  }
  g.setAttribute('color', new THREE.BufferAttribute(c, 4));
  return g;
}

/** A horizontal decal quad, w x d metres, centred at (x,y,z), yawed. */
export function patch(cell, x, y, z, w, d, yaw, colour = null, alpha = 1) {
  const g = new THREE.PlaneGeometry(w, d);
  atlasRemap(boxUV01(g), cell[0], cell[1], 4, 4);
  g.rotateX(-Math.PI / 2);
  g.rotateY(yaw);
  g.translate(x, y, z);
  return tintQuad(g, colour, alpha);
}

/**
 * A quad that spans from a to b with width `w`, draped `lift` above the ground.
 * Used for tyre tracks, which have to follow the surface rather than lie on one
 * plane — a straight decal across a kerb is worse than no decal.
 */
export function segment(cell, ax, ay, az, bx, by, bz, w, colour = null, alpha = 1) {
  const dx = bx - ax, dz = bz - az;
  const len = Math.hypot(dx, dz);
  if (len < 0.05) return null;
  const g = new THREE.PlaneGeometry(w, len);
  atlasRemap(boxUV01(g), cell[0], cell[1], 4, 4);
  g.rotateX(-Math.PI / 2);
  g.rotateY(Math.atan2(dx, dz));
  g.translate((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
  return tintQuad(g, colour, alpha);
}

/**
 * The ground that is worth dressing.
 *
 * ROOT CAUSE OF THE BARE COURTYARD (round 5 / round 6 combat.png)
 *   This filter used to be `wallDist > 3.4 && !indoor && level === 0`, and both
 *   halves of it threw the hero courtyard away:
 *
 *     `indoor` is set by the survey whenever ANYTHING is overhead within 14 m.
 *     The courtyard in the combat framing is crossed by a signage gantry, a pipe
 *     bridge and an entry canopy, so most of it is flagged indoor and every
 *     apron pass skipped it. A yard with a gantry over it is still a yard.
 *
 *     `wallDist > 3.4` is measured against ANY vertical surface within 7 m, and
 *     an apron full of columns, barriers and silo skirts almost never clears
 *     3.4 m. That is exactly backwards: proximity to a kerb or a column base is
 *     where grit and run-off actually collect.
 *
 *   Enclosure — the fraction of lateral rays that hit something — is the honest
 *   test for "is this a room", and it is already surveyed.
 */
export function openGround(samples, { maxEnclosure = 0.62, minWall = 1.15, ground = true } = {}) {
  return samples.filter((s) => (!ground || s.level === 0)
    && s.enclosure < maxEnclosure
    && s.wallDist > minWall);
}

/* ========================================================================= */
/*                          MARKS ON OPEN GROUND                             */
/* ========================================================================= */

/**
 * Tyre tracks, scuffs, oil stains and kerb drifts across the parts of the level
 * that the density-field scatter deliberately leaves bare.
 *
 * @param {object} api
 * @param {Array} samples surveyed standable ground
 * @returns {{tracks:number, scuffs:number, stains:number, drifts:number, quads:number}}
 */
export function groundMarks(api, samples, {
  tracks = 14, scuffs = 66, stains = 30, driftBudget = 190,
} = {}) {
  const { rng, probe } = api;
  const quads = [];
  const stats = { tracks: 0, scuffs: 0, stains: 0, drifts: 0, quads: 0, openSamples: 0 };

  // Open ground: see openGround() for why the old filter emptied the courtyard.
  const open = openGround(samples);
  if (!open.length) return stats;
  rng.shuffle(open);
  stats.openSamples = open.length;
  // Tyre tracks alone still want genuine run-up, so they keep a stricter test.
  const runway = open.filter((s) => s.wallDist > 2.0);

  /* --- tyre tracks -------------------------------------------------------- */
  for (let t = 0; t < tracks && runway.length && t < runway.length; t++) {
    const s = runway[t * 3 % runway.length];
    let a = rng.range(0, Math.PI * 2);
    let x = s.x, z = s.z;
    const gauge = rng.range(1.55, 2.05);
    const width = rng.range(0.20, 0.30);
    const nodes = rng.int(5, 9);
    const step = rng.range(2.0, 3.4);
    let laid = 0;
    let prev = null;
    for (let i = 0; i < nodes; i++) {
      const g = probe.ground(x, z, s.y + 1.4);
      if (!g || Math.abs(g.point.y - s.y) > 1.2) break;
      const node = { x, y: g.point.y + 0.012, z, a };
      if (prev) {
        for (const side of [-0.5, 0.5]) {
          const nx = Math.sin(prev.a) * side * gauge, nz = -Math.cos(prev.a) * side * gauge;
          /*
           * ALPHA ABOVE 1 IS THE LEVER, NOT COLOUR.
           *
           * The atlas cell for a tyre track peaks at 0.20 alpha — deliberately,
           * after a round in which tracks read as "black gaffer tape". The
           * correction went too far and tools/groundcheck.mjs measured the
           * result: authored content moved 38% of the hero floor's pixels by a
           * mean of 6.2/255, i.e. it was there and invisible, and only 0.73 of
           * the floor's 10.6 block variance was authored at all.
           *
           * Darkening the tint cannot fix that: vColor multiplies ALBEDO, and at
           * 0.2 coverage a black mark and a grey one differ by 3/255. The per-quad
           * alpha multiplies COVERAGE and is not clamped before blending, so a
           * value above 1 scales the whole cell up while keeping every feathered
           * edge feathered — which is the property that stopped it reading as
           * tape.
           */
          const q = segment(DECAL.tyre,
            prev.x + nx, prev.y, prev.z + nz,
            node.x + nx, node.y, node.z + nz, width, null, 2.4);
          if (q) { quads.push(q); laid++; }
        }
      }
      prev = node;
      a += rng.jit(0.16);
      x += Math.cos(a) * step;
      z += Math.sin(a) * step;
    }
    if (laid) stats.tracks++;
  }

  /* --- scuffs and oil ----------------------------------------------------- */
  for (let i = 0; i < scuffs; i++) {
    const s = open[(i * 7 + 3) % open.length];
    const g = probe.ground(s.x, s.z, s.y + 1.2);
    if (!g) continue;
    const w = rng.range(1.1, 3.2);
    quads.push(patch(DECAL.scuff, s.x + rng.jit(1.1), g.point.y + 0.011, s.z + rng.jit(1.1),
      w, w * rng.range(0.35, 0.8), rng.range(0, Math.PI * 2), null, 1.5));
    stats.scuffs++;
  }
  for (let i = 0; i < stains; i++) {
    const s = open[(i * 11 + 5) % open.length];
    const g = probe.ground(s.x, s.z, s.y + 1.2);
    if (!g) continue;
    const w = rng.range(0.7, 2.1);
    quads.push(patch(DECAL.oil, s.x + rng.jit(0.9), g.point.y + 0.010, s.z + rng.jit(0.9),
      w, w * rng.range(0.7, 1.25), rng.range(0, Math.PI * 2), null, 1.35));
    stats.stains++;
  }

  /* --- gravel drifts in the lee of kerbs ---------------------------------- */
  /*
   * A kerb is not something the props system is told about — it is found. Four
   * lateral probes at 55 cm; if one of them is 5-40 cm higher than the sample,
   * there is a step there, and grit always collects on the low side of a step.
   */
  let made = 0;
  for (const s of open) {
    if (made >= driftBudget) break;
    if (!rng.bool(0.36)) continue;
    let bestDx = 0, bestDz = 0, bestStep = 0;
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2 + 0.4;
      const ox = Math.cos(a) * 0.55, oz = Math.sin(a) * 0.55;
      const h = probe.ground(s.x + ox, s.z + oz, s.y + 1.2);
      if (!h) continue;
      const step = h.point.y - s.y;
      if (step > 0.05 && step < 0.40 && step > bestStep) {
        bestStep = step; bestDx = ox; bestDz = oz;
      }
    }
    if (bestStep === 0) continue;
    const along = Math.atan2(-bestDz, bestDx);
    const n = rng.int(2, 4);
    for (let i = 0; i < n && made < driftBudget; i++) {
      const fam = rng.pick(['drift', 'grit', 'grit', 'chip', 'brickbit']);
      const key = api.protos.pick(fam, rng);
      if (!key) continue;
      const t = rng.range(-0.8, 0.8);
      const res = api.placer.put(key, api.protos.get(key), {
        x: s.x + bestDx * rng.range(0.45, 0.85) + Math.cos(along) * t,
        z: s.z + bestDz * rng.range(0.45, 0.85) + Math.sin(along) * t,
        yaw: along + rng.jit(0.2),
        tilt: rng.jit(0.03), tiltDir: rng.range(0, Math.PI * 2),
        tint: 1, tintColour: familyTint(fam, rng),
        sink: rng.range(0.006, 0.018), scale: rng.range(0.9, 1.25),
        align: 0.97, ignoreOccupancy: true, radius: 0.09, from: s.y + 1.2,
      });
      if (res) { made++; stats.drifts++; }
    }
  }

  // Every quad has to prove it is lying on something before it is welded into
  // the batch, because after the merge there is no per-quad identity left to
  // judge. See seatQuads.
  stats.decal = seatQuads(api.probe, quads);
  if (quads.length) {
    api.batcher.merge('decal', mergeQuads(quads), api.mats.get('decal'),
      { solid: false, castShadow: false, receiveShadow: false });
  }
  stats.quads = quads.length;
  return stats;
}

/**
 * Wind-blown paper, cable coils and concrete chunks out on the apron.
 *
 * Deliberately separate from Scatter.scatterClutter: that pass is driven by a
 * density field that is near zero in the middle of a yard, which is exactly
 * where this one works. Uses existing prototypes, so it costs no draw calls at
 * all — only instances.
 */
export function apronClutter(api, samples, { budget = 320 } = {}) {
  const { rng } = api;
  const open = openGround(samples, { ground: false });
  if (!open.length) return 0;
  rng.shuffle(open);
  const FAM = [
    { f: 'papers', w: 1.0, flat: true }, { f: 'paper', w: 0.8, flat: true },
    { f: 'cardflat', w: 0.6, flat: true }, { f: 'chip', w: 0.9 },
    { f: 'rubble', w: 0.5 }, { f: 'brickbit', w: 0.5 },
    { f: 'coil', w: 0.22 }, { f: 'wirebit', w: 0.3 },
    { f: 'can', w: 0.45 }, { f: 'grit', w: 0.7, flat: true },
    { f: 'batten', w: 0.35 }, { f: 'rag', w: 0.2 },
  ];
  const total = FAM.reduce((a, b) => a + b.w, 0);
  const pick = () => {
    let r = rng.next() * total;
    for (const e of FAM) { r -= e.w; if (r <= 0) return e; }
    return FAM[0];
  };

  let made = 0;
  for (const s of open) {
    if (made >= budget) break;
    if (!rng.bool(0.30)) continue;
    // Wind-blown litter arrives in streaks, not dots: a short line of two to
    // four pieces on a shared bearing.
    const a = rng.range(0, Math.PI * 2);
    const n = rng.int(2, 4);
    for (let i = 0; i < n && made < budget; i++) {
      const e = pick();
      const key = api.protos.pick(e.f, rng);
      if (!key) continue;
      const d = i * rng.range(0.35, 0.95);
      const res = api.placer.put(key, api.protos.get(key), {
        x: s.x + Math.cos(a) * d + rng.jit(0.28),
        z: s.z + Math.sin(a) * d + rng.jit(0.28),
        yaw: e.flat ? a + rng.jit(0.5) : rng.range(0, Math.PI * 2),
        tilt: e.flat ? rng.jit(0.04) : rng.jit(0.14),
        tiltDir: rng.range(0, Math.PI * 2),
        tint: 1, tintColour: familyTint(e.f, rng),
        sink: rng.range(0.008, 0.02), scale: rng.range(0.85, 1.15),
        align: e.flat ? 1.0 : 0.92,
        ignoreOccupancy: true, radius: 0.09, from: s.y + 1.5,
      });
      if (res) made++;
    }
  }
  return made;
}

/* ========================================================================= */
/*                            CONTACT PATCHES                                */
/* ========================================================================= */

/**
 * Drop a soft dark patch under every shadowless prop that is big enough for the
 * eye to notice it has no shadow.
 *
 * MUST run after ContactPass (so the transforms are final) and before
 * Batcher.build() (so the transforms are still readable).
 *
 * @param {import('../Kit.js').Batcher} batcher
 * @returns {number} patches written
 */
export function contactPatches(api, batcher, { minRadius = 0.11, maxRadius = 1.4 } = {}) {
  const quads = [];
  const bb = new THREE.Box3();
  for (const p of batcher.protos()) {
    // Only the props that draw no shadow of their own need one faked.
    if (p.castShadow) continue;
    if (!p.geometry?.attributes?.position) continue;
    if (!p.geometry.boundingBox) p.geometry.computeBoundingBox();
    const gb = p.geometry.boundingBox;
    const localR = Math.max(gb.max.x - gb.min.x, gb.max.z - gb.min.z) * 0.5;
    if (localR < minRadius || localR > maxRadius) continue;
    // Alpha-tested cut-outs (chain-link, foliage) are see-through and a dark
    // ellipse under them reads as a stain, not a shadow.
    const surf = p.material?.userData?.surface;
    if (p.material?.alphaTest > 0 && surf !== 'concrete') continue;

    for (let i = 0; i < p.matrices.length; i++) {
      const m = p.matrices[i];
      bb.copy(gb).applyMatrix4(m);
      const w = bb.max.x - bb.min.x, d = bb.max.z - bb.min.z;
      const r = Math.max(w, d) * 0.5;
      if (r < minRadius || r > maxRadius) continue;
      _p.set(m.elements[12], bb.min.y, m.elements[14]);
      quads.push(patch(DECAL.contact,
        (bb.min.x + bb.max.x) * 0.5, _p.y + 0.008, (bb.min.z + bb.max.z) * 0.5,
        w * 1.75 + 0.06, d * 1.75 + 0.06,
        Math.atan2(m.elements[8], m.elements[10])));
    }
  }
  /*
   * NOT seatQuads()'d, deliberately, and this is the one exception.
   *
   * A contact patch is written at the BASE OF A PROP, and a prop may be standing
   * on another prop — a can on a crate, a rag on a pallet. Props are not in the
   * world BVH, so seatQuads would find nothing under those patches and delete
   * them: measured, 304 of 2033 patches, 15% of the contact cue that stops
   * unshadowed litter reading as hovering. The patch cannot be airborne anyway,
   * because it is derived from a bounding box that FloatSweep has already
   * guaranteed is resting on something.
   */
  if (!quads.length) return 0;
  api.batcher.merge('decal', mergeQuads(quads), api.mats.get('decal'),
    { solid: false, castShadow: false, receiveShadow: false });
  return quads.length;
}

/* ------------------------------------------------------------------------- */

/**
 * THE DECAL CONTACT GUARANTEE.
 *
 * WHY THIS EXISTS. FloatSweep skipped the whole `decal` batch with the comment
 * "decals lie ON the ground". That was an assumption, and in round 9
 * tools/floatcheck.mjs measured it: EIGHTEEN props-owned decal quads were
 * hanging in mid-air. A 3.25 x 3.42 m mark 53 cm clear of anything at
 * (21.2, 1.9, 1.0). A 5.7 x 5.6 m wash 22 cm off the hall roof. Several more out
 * past the compound wall at y = 11. A decal is drawn with polygonOffset and no
 * depth write, so one that misses its surface does not fade into anything — it
 * hangs there as a flat grey rectangle, and from the elevated framing that is
 * exactly as obvious as a floating plate.
 *
 * The check cannot live in FloatSweep, which is where it belongs conceptually,
 * because by then every quad has been welded into one merged buffer per pass:
 * the sweep would be judging a 2000-quad blob as a single object, and 60% of a
 * blob is always in contact. It has to happen HERE, per quad, before the merge.
 *
 * Each quad is judged on its own four corners:
 *   every corner within CONTACT of a real surface   keep
 *   every corner has ground below at the same depth drop it onto that surface
 *   otherwise                                      discard
 * The middle case fixes the millimetre-to-centimetre misses that come from a
 * survey sample taken at a slightly different height than the quad was written
 * at. The last case is a quad overhanging a roof edge or a stair void, which no
 * translation can seat and which has no business being drawn.
 *
 * @param {import('../Surfaces.js').SurfaceProbe} probe
 * @param {THREE.BufferGeometry[]} list quads, filtered IN PLACE
 * @returns {{checked:number, ok:number, seated:number, dropped:number, worst:number}}
 */
export function seatQuads(probe, list) {
  const out = { checked: 0, ok: 0, seated: 0, dropped: 0, worst: 0 };
  if (!list?.length || !probe?.ok) return out;
  const CONTACT = 0.035;
  const MAX_DROP = 0.9;
  let w = 0;
  for (let i = 0; i < list.length; i++) {
    const g = list[i];
    const pos = g?.attributes?.position;
    if (!pos) { list[w++] = g; continue; }
    out.checked++;
    const n = pos.count;
    const step = Math.max(1, Math.floor(n / 8));
    let sampled = 0, touching = 0, droppable = 0;
    let deepest = 0, shallowest = Infinity, worst = 0;
    for (let k = 0; k < n; k += step) {
      _p.fromBufferAttribute(pos, k);
      sampled++;
      if (probe.nearest(_p.x, _p.y, _p.z, CONTACT) < CONTACT) { touching++; continue; }
      const hit = probe.ground(_p.x, _p.z, _p.y + 0.05);
      const drop = hit ? _p.y - hit.point.y : Infinity;
      if (Number.isFinite(drop) && drop > worst) worst = drop;
      if (drop > 0.002 && drop < MAX_DROP) {
        droppable++;
        if (drop > deepest) deepest = drop;
        if (drop < shallowest) shallowest = drop;
      }
    }
    if (worst > out.worst) out.worst = worst;
    if (!sampled || touching === sampled) { out.ok++; list[w++] = g; continue; }
    // Parallel to its surface, merely written at the wrong height: one shift.
    if (droppable === sampled - touching && deepest - shallowest < 0.05) {
      g.translate(0, -(deepest - 0.008), 0);
      out.seated++;
      list[w++] = g;
      continue;
    }
    g.dispose();
    out.dropped++;
  }
  list.length = w;
  return out;
}

/**
 * Local merge that keeps position/normal/uv/colour — decals need nothing else.
 * The colour channel is what lets one atlas cell serve several moods: the same
 * soft ellipse is an oil pool, a damp patch or a dust bloom depending on the
 * flat tint welded into it, and it still costs no extra draw call.
 */
export function mergeQuads(list) {
  let verts = 0, idx = 0;
  for (const g of list) {
    verts += g.attributes.position.count;
    idx += g.index ? g.index.count : g.attributes.position.count;
  }
  const pos = new Float32Array(verts * 3);
  const nor = new Float32Array(verts * 3);
  const uv = new Float32Array(verts * 2);
  const col = new Float32Array(verts * 4);
  const index = verts > 65535 ? new Uint32Array(idx) : new Uint16Array(idx);
  let vo = 0, io = 0;
  for (const g of list) {
    const gp = g.attributes.position, gn = g.attributes.normal, gu = g.attributes.uv;
    const gc = g.attributes.color;
    const n = gp.count;
    for (let i = 0; i < n; i++) {
      pos[(vo + i) * 3] = gp.getX(i); pos[(vo + i) * 3 + 1] = gp.getY(i); pos[(vo + i) * 3 + 2] = gp.getZ(i);
      nor[(vo + i) * 3] = gn ? gn.getX(i) : 0;
      nor[(vo + i) * 3 + 1] = gn ? gn.getY(i) : 1;
      nor[(vo + i) * 3 + 2] = gn ? gn.getZ(i) : 0;
      uv[(vo + i) * 2] = gu ? gu.getX(i) : 0;
      uv[(vo + i) * 2 + 1] = gu ? gu.getY(i) : 0;
      col[(vo + i) * 4] = gc ? gc.getX(i) : 1;
      col[(vo + i) * 4 + 1] = gc ? gc.getY(i) : 1;
      col[(vo + i) * 4 + 2] = gc ? gc.getZ(i) : 1;
      col[(vo + i) * 4 + 3] = gc && gc.itemSize === 4 ? gc.getW(i) : 1;
    }
    if (g.index) {
      for (let i = 0; i < g.index.count; i++) index[io++] = vo + g.index.getX(i);
    } else {
      for (let i = 0; i < n; i++) index[io++] = vo + i;
    }
    vo += n;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.setAttribute('color', new THREE.BufferAttribute(col, 4));
  out.setIndex(new THREE.BufferAttribute(index, 1));
  out.computeBoundingSphere();
  void _v;
  return out;
}
