import * as THREE from 'three';
import { cyl, tube, gratingPanel, profileExtrude, fbm, rng } from './GeoKit.js';
import { kerb } from './Modules.js';

/**
 * OWNER: level agent.
 *
 * Everything that lives IN the ground plane. The compound's paving used to be
 * a 30x35m sheet of concrete carrying no incident, which is what made the hero
 * framing read flat: the lower half of the frame was one unbroken value with no
 * scale cues and nothing for the eye to travel along.
 *
 * The fix is not "more clutter" — it is the same set of things a real yard has,
 * at real sizes, laid out so they read as a plan:
 *
 *   construction joints   a 4.2m saw-cut grid, 45mm wide. Free triangles, and
 *                         the single biggest change to how big the yard looks.
 *   road markings         hazard hatching, keep-clear lines, arrows, a border.
 *                         Painted on real geometry (14mm proud) so they take
 *                         the sun and the AO, not decals faked into albedo.
 *   standing water        the drainage channel invert and three puddles. These
 *                         are near-mirrors: they punch a bright sky-coloured
 *                         hole in the darkest part of the frame, which is what
 *                         gives a wet industrial floor its whole character.
 *   a slot drain          transverse, flush, with real 30mm slots. Draws a hard
 *                         horizontal line across the lower frame.
 *   an embedded siding    narrow-gauge track from the loading dock out past
 *                         the canopy: 95% flush in concrete, one section broken
 *                         out to expose sleepers and ballast. The strongest
 *                         leading line in the map and it aims at the landmark.
 *   surface repairs       asphalt patches, a manhole, tyre paths, spalled kerb.
 *
 * All of it is non-solid decor (`solid: false`) sitting a few centimetres above
 * the paving: bullets and the player collide with the slab underneath, so none
 * of this costs a BVH node or changes movement. The only exceptions are the
 * things you can actually stand on or shoot behind.
 */

/** Level-local materials. The forge's library is shared; these are ours only. */
export function groundworkMaterials(forge) {
  const cw = forge.texture('concrete_wet');
  const cc = forge.texture('concrete');

  /** Worn line-paint over the concrete bake, so it inherits the surface wear. */
  const paint = (hex, rough, nScale) => {
    const m = new THREE.MeshStandardMaterial({
      color: new THREE.Color(hex),
      map: cc.map,
      normalMap: cc.normalMap,
      roughnessMap: cc.roughnessMap,
      aoMap: cc.aoMap,
      roughness: rough,
      metalness: 0.0,
      normalScale: new THREE.Vector2(nScale, nScale),
    });
    m.userData.surface = 'concrete';
    return m;
  };

  // Standing water. Near-mirror, dark, and lightly perturbed by the wet-concrete
  // normal so the reflection breaks up instead of looking like polished vinyl.
  const water = new THREE.MeshStandardMaterial({
    color: 0x28313a,
    normalMap: cw.normalMap,
    normalScale: new THREE.Vector2(0.16, 0.16),
    roughness: 0.05,
    // Physically water is a dielectric, and a dielectric puddle seen from
    // standing height sits inside its Fresnel minimum — about 3% reflectance,
    // which renders as a black smudge and nothing else. Driving metalness up
    // lifts the reflection at normal incidence so the puddle actually returns
    // the sky, which is the entire reason for putting it there.
    metalness: 0.55,
    envMapIntensity: 1.9,
    // Barely translucent, but depth-writing: TAA and motion blur need this
    // surface in the depth buffer or the reflection ghosts across the frame.
    transparent: true,
    opacity: 0.88,
    depthWrite: true,
  });
  water.userData.surface = 'water';

  return {
    // Line paint is far more saturated than it looks in reference: on a pale
    // concrete slab under a warm key it needs to be nearly orange or it greys
    // out entirely, which is exactly what happened on the first pass.
    paint_yellow: paint(0xc4882a, 0.54, 0.55),
    paint_white: paint(0xd8d6cb, 0.58, 0.55),
    paint_red: paint(0xa32c1e, 0.56, 0.55),
    paint_dark: paint(0x1e1d1a, 0.74, 0.70),
    // Saw cuts are a dark *grey* line, not a black slot. A near-black joint at
    // 45mm reads as a gap in the slab and the paving looks like loose tiles.
    paint_joint: paint(0x6e6858, 0.82, 0.85),
    paint_grey: paint(0x4a473e, 0.80, 0.85),
    water,
  };
}

const ZONE = 'gw';
const PAINT_Y = 0.017;     // paint film sits proud of the slab — thermoplastic does
const JOINT_Y = 0.0035;
const JOINT_W = 0.03;      // a saw cut is a line, not a slot: 30mm and no wider

/* ------------------------------------------------------------ small helpers - */

/**
 * A thin chamfered plate lying flat — the primitive every marking is made of.
 * `len` runs along the plate's own +X and `wide` across it; `o.ry` then spins
 * the pair together, so at ry = PI/2 the LENGTH ends up along world Z.
 */
function plate(b, mat, x, z, len, wide, o = {}) {
  b.box(mat, x, o.y ?? PAINT_Y, z, len, o.thick ?? 0.016, wide, {
    zone: o.zone ?? ZONE, bevel: o.bevel ?? 0.006, seg: o.seg ?? 1,
    ry: o.ry ?? 0, cast: false, solid: false, tile: o.tile ?? 1.0,
  });
}

/**
 * Liang–Barsky clip of the line p = c*n + t*d against an axis-aligned rect.
 * Returns [t0, t1] or null. Used to lay diagonal hatching inside a box without
 * the stripes overshooting the border.
 */
function clipLine(px, pz, dx, dz, x0, x1, z0, z1) {
  let t0 = -1e4, t1 = 1e4;
  const edge = (p, q) => {
    // p + t*q <= 0
    if (Math.abs(q) < 1e-9) return p <= 0;
    const t = -p / q;
    if (q > 0) { if (t < t1) t1 = t; } else if (t > t0) t0 = t;
    return true;
  };
  if (!edge(x0 - px, -dx) || !edge(px - x1, dx)) return null;
  if (!edge(z0 - pz, -dz) || !edge(pz - z1, dz)) return null;
  return t1 - t0 > 0.08 ? [t0, t1] : null;
}

/**
 * Diagonal hazard hatching filling a rectangle, clipped to it.
 *
 * `wear` (0..1) is the important parameter. Fresh full-width hatching two metres
 * from the camera reads as a graphic pasted onto the floor; the same hatching
 * with a third of it scuffed off, a couple of stripes missing and the survivors
 * varying in length reads as paint that has been driven over for twenty years.
 */
function hatchRect(b, mat, x0, x1, z0, z1, o = {}) {
  const a = o.angle ?? -Math.PI / 4;
  const dx = Math.cos(a), dz = Math.sin(a);
  const nx = -dz, nz = dx;
  const pitch = o.pitch ?? 1.15;
  const wide = o.wide ?? 0.32;
  const wear = o.wear ?? 0.35;
  const r = rng(o.seed ?? 7717);
  // Project the four corners onto the normal to find the span of c.
  let cMin = 1e9, cMax = -1e9;
  for (const [cx, cz] of [[x0, z0], [x1, z0], [x1, z1], [x0, z1]]) {
    const c = cx * nx + cz * nz;
    if (c < cMin) cMin = c;
    if (c > cMax) cMax = c;
  }
  const first = Math.ceil(cMin / pitch) * pitch;
  for (let c = first; c <= cMax; c += pitch) {
    const seg = clipLine(c * nx, c * nz, dx, dz, x0, x1, z0, z1);
    if (!seg) continue;
    let [t0, t1] = seg;
    if (r() < wear * 0.45) continue;                      // stripe gone entirely
    const eat = (t1 - t0) * wear;
    t0 += eat * r() * 0.7; t1 -= eat * r() * 0.7;         // worn back at the ends
    if (t1 - t0 < 0.25) continue;
    const mx = c * nx + dx * (t0 + t1) / 2, mz = c * nz + dz * (t0 + t1) / 2;
    plate(b, mat, mx, mz, t1 - t0, wide * (0.82 + r() * 0.24),
      { ry: -a, y: o.y ?? PAINT_Y, thick: 0.009, bevel: 0.004, tile: 1.4 });
  }
}

/**
 * An irregular puddle. A perfect disc reads as a decal; a noise-perturbed
 * outline with a damp halo one shade darker than dry concrete reads as water.
 */
function puddle(b, x, z, r, o = {}) {
  const seg = o.seg ?? 26;
  const seed = o.seed ?? 3;
  const pos = [], nor = [];
  const rAt = (i) => {
    const a = (i % seg) / seg * Math.PI * 2;
    const n = fbm(Math.cos(a) * 1.7 + seed, Math.sin(a) * 1.7, seed * 0.7, 3);
    return r * (0.66 + 0.62 * n) * (o.sx ?? 1);
  };
  for (let i = 0; i < seg; i++) {
    const a0 = i / seg * Math.PI * 2, a1 = (i + 1) / seg * Math.PI * 2;
    const r0 = rAt(i), r1 = rAt(i + 1);
    pos.push(0, 0, 0, Math.cos(a0) * r0, 0, Math.sin(a0) * r0, Math.cos(a1) * r1, 0, Math.sin(a1) * r1);
    for (let k = 0; k < 3; k++) nor.push(0, 1, 0);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  // 28mm above the slab: enough to sit clear of the 25mm paint film, so a
  // puddle lying across a hazard marking covers it instead of being pierced
  // by every stripe.
  const y = o.y ?? 0.028;
  b.geo('water', g, b.xform(x, y, z, {}),
    { zone: ZONE, tile: 3.0, cast: false, recv: false, solid: false });
  // damp halo: the same outline, scaled up, in wet concrete
  const halo = g.clone();
  halo.scale(1.36, 1, 1.36);
  b.geo('concrete_wet', halo, b.xform(x, y - 0.007, z, {}),
    { zone: ZONE, tile: 1.6, cast: false, solid: false });
}

/* -------------------------------------------------------------------- joints - */

/**
 * The saw-cut construction joint grid. 4.2m bays is what you actually pour, and
 * once the grid is there the eye has something to measure distance against —
 * this is why the same paving suddenly reads as 30 metres wide instead of as an
 * undifferentiated sheet.
 */
export function buildJoints(b, w) {
  const CH0 = 12.15, CH1 = 14.25;   // the drainage channel interrupts the run
  // Nearly flush and only a shade under the slab. Ambient occlusion puts a dark
  // halo either side of anything standing proud, so a 35mm strip 9mm high ends
  // up reading as a 100mm black slot — the joints have to be almost co-planar
  // with the paving or they take the picture over.
  const cut = (x, z, len, wide, ry) => plate(b, 'paint_joint', x, z, len, wide,
    { y: JOINT_Y, thick: 0.005, bevel: 0.0015, ry, tile: 2.4 });
  // longitudinal — parallel to the channel, uninterrupted
  for (const x of [-1.4, 2.8, 7.0, 11.3, 15.4, 19.6, 23.8]) {
    cut(x, 25.0, 33.4, JOINT_W, Math.PI / 2);
  }
  // transverse — split either side of the channel void
  for (const z of [12.2, 16.4, 24.8, 29.0, 33.2, 37.4, 41.4]) {
    cut((-2.6 + CH0) / 2, z, CH0 + 2.6, JOINT_W, 0);
    cut((CH1 + 25.6) / 2, z, 25.6 - CH1, JOINT_W, 0);
  }
  // the service yard is asphalt, so it gets crack sealing instead of saw cuts
  // The asphalt yard gets crack sealing instead of saw cuts. Clamped to the
  // asphalt's own extent — a sealed crack that wanders onto the courtyard slab
  // would be floating 350mm in the air.
  const r = rng(4471);
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  for (let i = 0; i < 14; i++) {
    let px = -6 + r() * 32, pz = -21 + r() * 26;
    for (let k = 0; k < 4; k++) {
      const len = 1.4 + r() * 2.6, a = (r() - 0.5) * 2.6;
      const nx = clamp(px + Math.cos(a) * len, -6.8, 28.5);
      const nz = clamp(pz + Math.sin(a) * len, -23, 7.2);
      const seg = Math.hypot(nx - px, nz - pz);
      if (seg > 0.4) {
        plate(b, 'paint_dark', (px + nx) / 2, (pz + nz) / 2, seg, 0.05,
          { y: -0.344, thick: 0.012, ry: -Math.atan2(nz - pz, nx - px), tile: 1.6 });
      }
      px = nx; pz = nz;
    }
  }
}

/* ------------------------------------------------------------------ markings - */

/**
 * Road markings in the courtyard. Sited against the hero camera at (6,1.7,14)
 * looking 200 degrees: the hazard box lands in the 2-6m band that reads as the
 * bottom-left third of that frame, which was the emptiest part of the image.
 */
export function buildMarkings(b, w) {
  // --- hazard box. Deliberately modest: at two metres from the hero camera a
  // dense full-width hatch fills a quarter of the frame with flat orange, so
  // this one is small, coarsely pitched and heavily worn.
  const x0 = 6.6, x1 = 9.9, z0 = 14.25, z1 = 16.5;
  hatchRect(b, 'paint_yellow', x0 + 0.16, x1 - 0.16, z0 + 0.16, z1 - 0.16,
    { pitch: 1.22, wide: 0.28, angle: -Math.PI / 4, wear: 0.46, seed: 331 });
  for (const [cx, cz, len, wide, ry] of [
    [(x0 + x1) / 2, z0, x1 - x0, 0.11, 0], [(x0 + x1) / 2, z1, x1 - x0, 0.11, 0],
    [x0, (z0 + z1) / 2, z1 - z0, 0.11, Math.PI / 2], [x1, (z0 + z1) / 2, z1 - z0, 0.11, Math.PI / 2],
  ]) plate(b, 'paint_white', cx, cz, len, wide, { ry, thick: 0.01, bevel: 0.004, tile: 1.6 });

  // --- keep-clear lines flanking the siding (clear of its 2.3m concrete panel)
  for (const z of [18.92, 21.88]) {
    plate(b, 'paint_white', 10.4, z, 19.0, 0.13, { thick: 0.01, bevel: 0.004, tile: 2.0 });
  }
  hatchRect(b, 'paint_yellow', 15.0, 18.6, 19.3, 21.5,
    { pitch: 1.05, wide: 0.3, angle: Math.PI / 3.2, wear: 0.4, seed: 917 });

  // --- two lane arrows pointing north along the channel corridor
  for (const [ax, az] of [[15.9, 24.6], [15.9, 33.4]]) {
    plate(b, 'paint_white', ax, az, 2.3, 0.24, { ry: Math.PI / 2, tile: 1.4 });
    for (const s of [-1, 1]) {
      plate(b, 'paint_white', ax + s * 0.38, az + 1.28, 1.25, 0.22,
        { ry: Math.PI / 2 + s * 0.62, tile: 1.2 });
    }
  }

  // --- dock edge line + hatched no-go strip at the dock nose
  plate(b, 'paint_yellow', 21.55, 26.0, 15.6, 0.16, { ry: Math.PI / 2, thick: 0.01, tile: 2.0 });
  hatchRect(b, 'paint_yellow', 19.4, 21.4, 18.4, 20.2,
    { pitch: 0.92, wide: 0.3, wear: 0.32, seed: 4409 });

  // --- bay number as three plain bars: reads as a stencil at 8m, costs nothing
  for (let i = 0; i < 3; i++) {
    plate(b, 'paint_white', 7.8 + i * 0.62, 18.3, 0.9, 0.16, { ry: Math.PI / 2, tile: 1.0 });
  }

  // --- worn tyre paths sweeping in from the gate, clamped to the courtyard slab.
  // These are a *scuff*, not a stripe: near-black at 300mm they read as gaffer
  // tape stuck to the floor, so they are narrow and only a shade under the slab.
  const r = rng(1913);
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  for (const off of [-0.84, 0.84]) {
    let px = 4.4, pz = 10.2, a = 1.16;
    for (let k = 0; k < 7; k++) {
      const len = 3.4 + r() * 1.2;
      a += (r() - 0.42) * 0.22;
      const nx = clamp(px + Math.cos(a) * len, -1.6, 24.6);
      const nz = clamp(pz + Math.sin(a) * len, 9.0, 41.0);
      const seg = Math.hypot(nx - px, nz - pz);
      if (seg > 0.5) {
        plate(b, 'paint_grey', (px + nx) / 2 + off * Math.sin(a), (pz + nz) / 2 - off * Math.cos(a),
          seg + 0.2, 0.2, { y: 0.008, thick: 0.008, bevel: 0.003, ry: -a, tile: 1.2 });
      }
      px = nx; pz = nz;
    }
  }
}

/* -------------------------------------------------------------------- water -- */

/**
 * Standing water. The channel invert is the important one: a 30m ribbon of
 * near-mirror pointing straight at the landmark stack, dropped into the darkest
 * band of the frame. Puddles do the same job locally in the 2-6m foreground.
 */
export function buildWater(b, w) {
  b.box('water', 13.2, -0.83, 25.5, 1.82, 0.04, 31.0,
    { zone: ZONE, bevel: 0.01, seg: 3, cast: false, recv: false, solid: false, tile: 4.0 });
  // wet staining up the channel walls
  for (const s of [-1, 1]) {
    b.box('concrete_wet', 13.2 + s * 0.9, -0.66, 25.5, 0.03, 0.36, 31.0,
      { zone: ZONE, bevel: 0.008, cast: false, solid: false, tile: 2.0 });
  }
  // The near two are sited in the hero camera's 2-4m band on purpose: a bright
  // sky-coloured hole in the darkest, emptiest part of the frame does more for
  // that composition than any amount of extra clutter would.
  puddle(b, 8.7, 16.55, 1.62, { seed: 2, seg: 32 });
  puddle(b, 6.75, 14.3, 0.95, { seed: 7, seg: 22 });
  puddle(b, 11.3, 18.9, 1.05, { seed: 21, seg: 22, sx: 1.2 });
  puddle(b, 12.55, 22.9, 0.98, { seed: 11, seg: 22, sx: 1.25 });
  puddle(b, 17.6, 28.2, 1.15, { seed: 4, seg: 24 });
  puddle(b, 3.1, 24.8, 0.86, { seed: 9, seg: 20 });
  // service yard (asphalt is 0.35m lower) — feeds the material-closeup framing
  puddle(b, 3.4, 6.9, 0.94, { seed: 5, seg: 22, y: -0.322 });
  puddle(b, -1.2, 1.4, 1.1, { seed: 13, seg: 24, y: -0.322 });
}

/* --------------------------------------------------------------- slot drain -- */

/**
 * A transverse slot drain across the courtyard's south end. Real 30mm slots in
 * real geometry, which is the point: it draws a hard, dead-straight horizontal
 * shadow line across the lower third of the hero frame and terminates the
 * hazard box, so the ground reads as two planes instead of one.
 */
export function buildSlotDrain(b, w) {
  // Stops short of the kerb line at x=11 and discharges into a catch pit, which
  // is how it would actually be built — and keeps the kerb from crossing it.
  const z = 17.24, x0 = 6.28, x1 = 10.62;
  const len = x1 - x0, cx = (x0 + x1) / 2;
  // Flush, not proud. A drain unit that stands 100mm above the slab reads as a
  // cattle grid dropped on the floor; a real one sits within 20mm of the paving
  // and all you see is the dark slot and the shadow inside it.
  for (const s of [-1, 1]) {
    b.box('concrete', cx, -0.055, z + s * 0.245, len, 0.15, 0.1,
      { zone: ZONE, bevel: 0.012, seg: 3, cast: false, solid: false, tile: 1.2 });
  }
  b.box('paint_dark', cx, -0.09, z, len, 0.16, 0.4,
    { zone: ZONE, bevel: 0.01, cast: false, solid: false, tile: 1.4 });
  b.geo('metal_rusted', gratingPanel(len, 0.39, { pitch: 0.19, barW: 0.026, barH: 0.038 }),
    b.xform(cx, 0.0, z, {}), { zone: ZONE, tile: 0.7, cast: false, solid: false });
  // catch pit at the low end
  b.box('concrete', 10.28, -0.05, z, 0.92, 0.16, 0.92,
    { zone: ZONE, bevel: 0.025, seg: 2, cast: false, solid: false, tile: 1.0 });
  b.geo('metal_rusted', gratingPanel(0.64, 0.64, { pitch: 0.09, barW: 0.022, barH: 0.034 }),
    b.xform(10.28, 0.012, z, {}), { zone: ZONE, tile: 0.6, cast: false, solid: false });
  // a manhole and a road gully in the same band
  for (const [mx, mz, mr] of [[9.9, 14.35, 0.44], [16.9, 22.6, 0.42], [4.6, 27.4, 0.4]]) {
    b.geo('concrete', cyl(mr + 0.16, mr + 0.16, 0.14, 18), b.xform(mx, 0.0, mz, {}),
      { zone: ZONE, tile: 0.9, cast: false, solid: false });
    b.geo('metal_rusted', cyl(mr, mr, 0.07, 18), b.xform(mx, 0.055, mz, {}),
      { zone: ZONE, tile: 0.5, cast: false, solid: false });
    for (let i = 0; i < 3; i++) {
      b.box('metal_rusted', mx, 0.09, mz - mr * 0.5 + i * mr * 0.5, mr * 1.4, 0.02, 0.05,
        { zone: ZONE, bevel: 0.006, cast: false, solid: false, tile: 0.4 });
    }
  }
}

/* ---------------------------------------------------------------- surfacing -- */

/**
 * Patch repairs. Two materials meeting along a saw-cut edge is the cheapest way
 * to break a large plane, and every yard this age is a quilt of them.
 */
export function buildPatches(b, w) {
  const patches = [
    ['asphalt', 8.2, 22.6, 2.9, 2.0, 0.1],
    ['asphalt', 16.8, 14.6, 4.4, 3.2, -0.06],
    ['asphalt', 20.6, 31.6, 3.6, 4.6, 0.04],
    ['asphalt', 2.6, 30.4, 4.2, 3.4, -0.08],
    ['concrete_wet', 10.4, 25.4, 3.4, 2.6, 0.05],
    ['concrete_wet', 18.0, 37.4, 4.6, 3.0, -0.03],
  ];
  for (const [mat, x, z, wd, dp, ry] of patches) {
    b.box(mat, x, 0.008, z, wd, 0.03, dp,
      { zone: ZONE, bevel: 0.012, seg: 3, ry, jitter: 0.006, jitterFreq: 1.4,
        cast: false, solid: false, tile: 2.0 });
    // The sealed saw cut is an OUTLINE, four strips round the rim. A solid
    // oversized dark slab under a patch does not read as a lip — it reads as a
    // black rectangle, because it is one.
    const c = Math.cos(ry), s = Math.sin(ry);
    for (const [ox, oz, lw, ld] of [
      [0, dp / 2, wd + 0.09, 0.05], [0, -dp / 2, wd + 0.09, 0.05],
      [wd / 2, 0, 0.05, dp + 0.09], [-wd / 2, 0, 0.05, dp + 0.09],
    ]) {
      b.box('paint_dark', x + ox * c + oz * s, 0.014, z - ox * s + oz * c, lw, 0.012, ld,
        { zone: ZONE, bevel: 0.004, ry, cast: false, solid: false, tile: 2.0 });
    }
  }
  // Spall craters — chipped concrete showing dark aggregate underneath. In
  // asphalt rather than near-black paint, and small: a 400mm black disc on a
  // pale slab reads as a hole, which is not what a spall looks like.
  const r = rng(8123);
  for (let i = 0; i < 22; i++) {
    const x = -2 + r() * 27, z = 9 + r() * 32;
    const rr = 0.11 + r() * 0.15;
    b.geo('asphalt', cyl(rr, rr * (1.1 + r() * 0.3), 0.016, 7),
      b.xform(x, 0.005, z, { ry: r() * 3 }),
      { zone: ZONE, tile: 0.5, cast: false, solid: false });
  }
}

/* -------------------------------------------------------------- rail siding -- */

const RAIL_Z = 20.4, GAUGE = 0.9;

/** 60mm-head flat-bottom rail section, extruded along its run. */
function railSection(len) {
  const p = [
    [-0.036, 0], [0.036, 0], [0.036, 0.018], [0.013, 0.03], [0.013, 0.064],
    [0.034, 0.074], [0.036, 0.086], [0.028, 0.096], [-0.028, 0.096],
    [-0.036, 0.086], [-0.034, 0.074], [-0.013, 0.064], [-0.013, 0.03], [-0.036, 0.018],
  ];
  return profileExtrude(p, len, { bevel: 0.004, bevelSegments: 1 });
}

/**
 * A narrow-gauge works siding running out of the loading dock, across the
 * courtyard and off under the entry canopy. Flush-embedded in a concrete
 * trough for most of its length — which is what real yard track is, and what
 * keeps it from becoming a 240mm trip hazard across the map — with one section
 * where the concrete has broken out to expose sleepers and ballast.
 *
 * In the hero framing it enters at the bottom-right frame edge and sweeps to
 * the left edge: the map's strongest leading line, and it aims the eye at the
 * midground revetments and the stack beyond.
 */
export function buildSiding(b, w) {
  // Shares the groundworks zone so its buckets merge with the rest of the ground
  // plane instead of adding a dozen draw calls of their own.
  const zone = ZONE;
  const X0 = 0.4, X1 = 21.5;
  const BREAK0 = 15.3, BREAK1 = 18.6;   // where the paving has failed

  // The concrete the rails are set into, as THREE separate strips with a 170mm
  // gap either side of each rail. Those gaps are the flangeways, and they are
  // what makes embedded track read at all: a solid slab with a 20mm rail head
  // proud of it disappears past five metres, whereas two real slots either side
  // of the head draw a pair of hard black lines the whole length of the run.
  const strips = [
    [RAIL_Z - GAUGE / 2 - 0.685, 0.6], [RAIL_Z, 0.73], [RAIL_Z + GAUGE / 2 + 0.685, 0.6],
  ];
  for (const [a, c] of [[X0, BREAK0], [BREAK1, X1]]) {
    for (const [sz, sw] of strips) {
      b.box('concrete', (a + c) / 2, 0.0, sz, c - a, 0.15, sw,
        { zone, bevel: 0.018, seg: 4, jitter: 0.008, jitterFreq: 0.9,
          cast: false, solid: false, tile: 2.0 });
    }
    // dark bed visible down the slots
    for (const s of [-1, 1]) {
      b.box('paint_dark', (a + c) / 2, -0.055, RAIL_Z + s * GAUGE / 2, c - a, 0.1, 0.17,
        { zone, bevel: 0.006, cast: false, solid: false, tile: 2.0 });
    }
  }
  // ballast + sleepers in the broken-out section
  b.box('dirt', (BREAK0 + BREAK1) / 2, -0.02, RAIL_Z, BREAK1 - BREAK0, 0.1, 2.28,
    { zone, bevel: 0.03, seg: 4, jitter: 0.03, jitterFreq: 2.2,
      cast: false, solid: false, tile: 1.4 });
  const r = rng(5501);
  for (let x = BREAK0 + 0.34; x < BREAK1; x += 0.66) {
    b.box('wood_plank', x, 0.055, RAIL_Z + (r() - 0.5) * 0.06, 0.22, 0.13, 1.62,
      { zone, bevel: 0.014, seg: 2, ry: (r() - 0.5) * 0.07, tile: 1.0 });
  }
  // broken concrete lips at each end of the failure
  for (const bx of [BREAK0, BREAK1]) {
    for (const s of [-1, 1]) {
      b.box('concrete', bx + (bx === BREAK0 ? -0.12 : 0.12), 0.06, RAIL_Z + s * 0.62,
        0.4, 0.12, 0.6, { zone, bevel: 0.03, seg: 2, ry: (r() - 0.5) * 0.4,
          rz: (r() - 0.5) * 0.2, cast: false, solid: false, tile: 1.2 });
    }
  }

  // the rails themselves, sitting in the slots with the head ~25mm proud
  for (const s of [-1, 1]) {
    const rz = RAIL_Z + s * GAUGE / 2;
    b.geo('metal_rusted', railSection(X1 - X0),
      b.xform((X0 + X1) / 2, 0.0, rz, { ry: Math.PI / 2 }), { zone, tile: 0.9, solid: false });
  }

  // Level crossing over the drainage channel: a bolted steel deck plate resting
  // on the channel kerbs, with two check strips continuing the rail line across.
  b.box('metal_rusted', 13.2, 0.19, RAIL_Z, 2.16, 0.06, 2.1,
    { zone, bevel: 0.012, seg: 3, cast: false, solid: false, tile: 1.0 });
  for (const s of [-1, 1]) {
    b.box('metal_rusted', 13.2, 0.235, RAIL_Z + s * GAUGE / 2, 2.16, 0.05, 0.075,
      { zone, bevel: 0.008, cast: false, solid: false, tile: 0.8 });
  }
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    b.geo('metal_painted', cyl(0.035, 0.035, 0.04, 8),
      b.xform(13.2 + sx * 0.94, 0.235, RAIL_Z + sz * 0.92, {}),
      { zone, tile: 0.4, cast: false, solid: false });
  }

  // buffer stop hard against the dock face
  b.box('concrete', 21.75, 0.28, RAIL_Z, 0.7, 0.56, 1.9,
    { zone, bevel: 0.035, seg: 3, tile: 1.4 });
  b.box('wood_plank', 21.4, 0.42, RAIL_Z, 0.22, 0.4, 1.7, { zone, bevel: 0.03, seg: 2, tile: 0.9 });
  for (const s of [-1, 1]) {
    b.geo('metal_rusted', tube([[21.9, 0.06, RAIL_Z + s * GAUGE / 2],
      [21.1, 0.58, RAIL_Z + s * GAUGE / 2]], 0.05, 7, { segLen: 1 }), null,
      { zone, tile: 0.7 });
  }
  // point lever + a stack of spare sleepers beside the track
  b.box('metal_rusted', 12.1, 0.16, RAIL_Z - 1.42, 0.34, 0.32, 0.9,
    { zone, bevel: 0.02, seg: 2, tile: 0.8 });
  b.geo('metal_painted', tube([[12.1, 0.28, RAIL_Z - 1.42], [12.35, 0.86, RAIL_Z - 1.06]],
    0.035, 7, { segLen: 1 }), null, { zone, tile: 0.5 });
  b.geo('metal_rusted', cyl(0.075, 0.075, 0.1, 10), b.xform(12.35, 0.9, RAIL_Z - 1.06, {}),
    { zone, tile: 0.4 });
  for (let i = 0; i < 5; i++) {
    b.box('wood_plank', 19.4, 0.07 + i * 0.14, RAIL_Z - 1.78 + (i % 2) * 0.05,
      0.24, 0.13, 1.6, { zone, bevel: 0.014, seg: 2, ry: (i % 2 ? 0.03 : -0.02), tile: 1.0 });
  }
}

/* ------------------------------------------------------------ service yard -- */

const YARD = -0.35;           // asphalt datum
const YP = YARD + 0.017;      // paint film on the asphalt

/**
 * The service yard's ground plane.
 *
 * This whole surface used to be INVISIBLE. Formation level sat at -0.18 and the
 * yard datum at -0.35, so the terrain plane covered the asphalt, its crack
 * sealing and its puddles by 170mm: every framing that looked south — the
 * bottom of `combat`, the near half of `vertical`, all of `material-closeup` —
 * was looking at bare dirt where a surfaced yard was supposed to be. Dropping
 * formation to -0.40 exposes it, and this function is what it exposes: a
 * marked-out working yard rather than a sheet of asphalt.
 *
 *   a transverse trench drain     hard horizontal across the lower frame
 *   marked vehicle bays           the biggest single change to perceived scale
 *   a hatched keep-clear apron    in front of the hall's vehicle shutter
 *   a routed lane + arrows        gate -> steps, the player's actual approach
 *   kerbs and bollards            a protected pedestrian edge, real colliders
 *   standing water and repairs    where the falls run to the drain
 */
export function buildYardworks(b, w) {
  // --- transverse trench drain at z = -8.5, discharging east into a catch pit
  const dz = -8.5, dx0 = -6.4, dx1 = 10.2;
  const dlen = dx1 - dx0, dcx = (dx0 + dx1) / 2;
  for (const s of [-1, 1]) {
    b.box('concrete', dcx, YARD + 0.05, dz + s * 0.3, dlen, 0.16, 0.14,
      { zone: ZONE, bevel: 0.012, seg: 3, cast: false, solid: false, tile: 1.2 });
  }
  b.box('paint_dark', dcx, YARD + 0.01, dz, dlen, 0.16, 0.48,
    { zone: ZONE, bevel: 0.01, cast: false, solid: false, tile: 1.4 });
  for (let i = 0; i < 5; i++) {
    b.geo('metal_rusted', gratingPanel(dlen / 5 - 0.04, 0.46, { pitch: 0.17, barW: 0.026, barH: 0.04 }),
      b.xform(dx0 + (i + 0.5) * (dlen / 5), YARD + 0.1, dz, {}),
      { zone: ZONE, tile: 0.7, cast: false, solid: false });
  }
  b.box('concrete', dx1 + 0.7, YARD + 0.06, dz, 1.0, 0.18, 1.0,
    { zone: ZONE, bevel: 0.025, seg: 2, cast: false, solid: false, tile: 1.0 });
  b.geo('metal_rusted', gratingPanel(0.7, 0.7, { pitch: 0.09, barW: 0.022, barH: 0.034 }),
    b.xform(dx1 + 0.7, YARD + 0.12, dz, {}), { zone: ZONE, tile: 0.6, cast: false, solid: false });

  // --- vehicle bays along the yard's south edge. Bay lines at 3.1m centres
  //     with a hatched aisle margin: the cheapest possible depth ruler.
  for (let i = 0; i <= 7; i++) {
    const bx = -5.0 + i * 3.1;
    plate(b, 'paint_white', bx, -15.4, 5.6, 0.12, { y: YP, ry: Math.PI / 2, thick: 0.01, tile: 2.0 });
  }
  plate(b, 'paint_white', 5.85, -12.6, 22.0, 0.14, { y: YP, thick: 0.01, tile: 2.4 });
  hatchRect(b, 'paint_yellow', -5.6, -1.4, -19.4, -17.6,
    { pitch: 1.0, wide: 0.3, wear: 0.4, seed: 6101, y: YP });
  for (let i = 0; i < 4; i++) {
    plate(b, 'paint_white', 12.6 + i * 0.6, -16.0, 1.0, 0.15, { y: YP, ry: Math.PI / 2, tile: 1.0 });
  }

  // --- keep-clear apron in front of the west hall's vehicle shutter (z 0..-8)
  hatchRect(b, 'paint_yellow', -6.7, -2.2, -7.4, -0.6,
    { pitch: 1.1, wide: 0.32, angle: Math.PI / 3.4, wear: 0.44, seed: 6203, y: YP });
  for (const [cx2, cz2, len, wide, ry] of [
    [-4.45, -0.5, 4.5, 0.13, 0], [-4.45, -7.5, 4.5, 0.13, 0],
    [-6.8, -4.0, 7.0, 0.13, Math.PI / 2],
  ]) plate(b, 'paint_white', cx2, cz2, len, wide, { y: YP, ry, thick: 0.01, tile: 1.8 });

  // --- the routed lane from the vehicle gate up to the courtyard steps
  for (const s of [-1, 1]) {
    plate(b, 'paint_white', 6.85 + s * 2.5, -12.0, 24.0, 0.13, { y: YP, ry: Math.PI / 2, thick: 0.01, tile: 2.4 });
  }
  for (const az of [-20.0, -13.0, -5.0]) {
    plate(b, 'paint_white', 6.85, az, 2.2, 0.24, { y: YP, ry: Math.PI / 2, tile: 1.4 });
    for (const s of [-1, 1]) {
      plate(b, 'paint_white', 6.85 + s * 0.36, az + 1.22, 1.2, 0.22,
        { y: YP, ry: Math.PI / 2 + s * 0.62, tile: 1.2 });
    }
  }

  // --- kerbed pedestrian edge with bollards. Solid, because it is a route the
  //     player and the AI both read off, not decoration.
  kerb(b, { x: 15.6, y: YARD, z: -14.0, len: 13.0, ry: 0, zone: ZONE });
  kerb(b, { x: 15.6, y: YARD, z: -21.4, len: 1.4, ry: Math.PI / 2, zone: ZONE });
  for (let i = 0; i < 5; i++) {
    const bz = -19.4 + i * 2.7;
    b.geo('metal_painted', cyl(0.085, 0.1, 0.95, 10), b.xform(15.6, YARD + 0.47, bz, {}),
      { zone: ZONE, tile: 0.6 });
    b.geo('metal_rusted', cyl(0.11, 0.11, 0.07, 10), b.xform(15.6, YARD + 0.97, bz, {}),
      { zone: ZONE, tile: 0.5 });
  }
  plate(b, 'paint_yellow', 15.6, -14.0, 13.0, 0.2, { y: YP, thick: 0.012, tile: 2.0 });

  // --- asphalt patch repairs and standing water where the falls collect
  for (const [px, pz, pw, pd, pr] of [
    [-3.2, -11.8, 3.8, 2.8, 0.08], [9.6, -18.4, 4.4, 3.2, -0.05], [13.0, -4.0, 3.0, 4.0, 0.03],
  ]) {
    b.box('concrete_wet', px, YARD + 0.008, pz, pw, 0.03, pd,
      { zone: ZONE, bevel: 0.012, seg: 3, ry: pr, jitter: 0.006, jitterFreq: 1.4,
        cast: false, solid: false, tile: 2.0 });
  }
  puddle(b, 2.0, -7.4, 1.45, { seed: 41, seg: 28, y: YARD + 0.028 });
  puddle(b, -4.4, -9.2, 1.05, { seed: 47, seg: 22, y: YARD + 0.028, sx: 1.3 });
  puddle(b, 11.4, -13.6, 1.2, { seed: 53, seg: 24, y: YARD + 0.028 });

  // --- east apron (x 26..40): lane edge and a hatched turning head, so the
  //     newly surfaced pocket is not a blank slab in the right of both heroes
  for (const lx of [27.4, 38.4]) {
    plate(b, 'paint_white', lx, 25.0, 32.0, 0.13, { ry: Math.PI / 2, thick: 0.01, tile: 2.4 });
  }
  hatchRect(b, 'paint_yellow', 29.0, 34.0, 12.0, 15.0,
    { pitch: 1.15, wide: 0.3, wear: 0.42, seed: 6317 });
  puddle(b, 32.6, 21.0, 1.5, { seed: 59, seg: 26, sx: 1.2 });
  void w;
}

/* -------------------------------------------------------------------- entry -- */

export function buildGroundworks(b, w) {
  buildJoints(b, w);
  buildMarkings(b, w);
  buildPatches(b, w);
  buildSlotDrain(b, w);
  buildSiding(b, w);
  buildYardworks(b, w);
  buildWater(b, w);
}
