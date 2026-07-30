import { tube, cyl, rng } from './GeoKit.js';

/**
 * OWNER: level agent.
 *
 * Elevation dressing: everything that turns a large flat wall into a building.
 *
 * ROOT CAUSE this file exists to fix: `Modules.wall()` gives a wall a plinth, a
 * string course, pilasters and chamfered reveals — good architecture, but all of
 * it is at the scale of the WHOLE elevation. Between two pilasters there is
 * still 6 m x 11 m of unbroken panel grid, and the `silhouette-dusk` camera at
 * (20, 1.7, 0) looking east sits ten metres off exactly such a bay, so roughly
 * 40% of that frame was one flat rectangle. A wall does not need a better
 * texture to fix that; it needs the things a real one carries — rainwater goods,
 * vents, conduit, boxes, movement joints, patch repairs, damage, stencilled
 * identification and an eaves line that throws a shadow.
 *
 * COORDINATES. Everything is authored in the same (u, y) elevation space that
 * `Modules.wall()` takes: `u` runs 0..len from the wall's left end, `y` is world
 * height. `face` is +1 or -1 along the wall normal and picks which side gets
 * dressed; text and asymmetric parts are mirrored accordingly.
 *
 * COST. `dressElevation` on a 38 m x 11 m elevation is about 9k triangles and
 * reuses the materials already present in that zone, plus `concrete_poured` for
 * repairs and `paint_dark` for stencils.
 */

const HALF_PI = Math.PI / 2;

function frame(axis) {
  if (axis === 'x') return { ry: 0, ux: 1, uz: 0, nx: 0, nz: 1 };
  return { ry: HALF_PI, ux: 0, uz: -1, nx: 1, nz: 0 };
}

/** A wall-space cursor: (u, y, out) -> world position, plus the wall's yaw. */
function cursor(o) {
  const f = frame(o.axis ?? 'x');
  const sgn = o.face ?? 1;
  const half = o.len / 2;
  const t = (o.thick ?? 0.4) / 2;
  return {
    ry: f.ry,
    sgn,
    /**
     * World position of elevation point (u, y) standing `out` metres proud.
     * `u` keeps `Modules.wall()`'s handedness whichever face is being dressed —
     * only the offset along the normal flips — so an opening list can be handed
     * straight to `dressElevation` without remapping.
     */
    at(u, y, out = 0) {
      const du = u - half;
      const dn = sgn * (t + out);
      return [o.cx + f.ux * du + f.nx * dn, y, o.cz + f.uz * du + f.nz * dn];
    },
  };
}

/* ------------------------------------------------------------ rainwater ---- */

/**
 * Rainwater downpipe: hopper head, pipe on brackets, swan-neck shoe, and the
 * grey wash the overflow has left on the wall beside it. Vertical, dark, and
 * casting its own shadow, this is the single cheapest thing that breaks a
 * blank elevation.
 */
export function downpipe(b, c, o) {
  const zone = o.zone, u = o.u, yTop = o.yTop, yBot = o.yBot;
  const r = o.r ?? 0.075;
  const out = 0.17;
  const top = c.at(u, yTop, out), bot = c.at(u, yBot + 0.42, out);
  b.geo('metal_rusted', tube([top, bot], r, 8, { segLen: 2.2, caps: false }), null,
    { zone, tile: 1.0 });
  // hopper head
  const hp = c.at(u, yTop - 0.02, out + 0.02);
  b.box('metal_rusted', hp[0], hp[1], hp[2], 0.42, 0.34, 0.3,
    { zone, ry: c.ry, bevel: 0.02, seg: 2 });
  // swan neck back to the plinth
  const s0 = c.at(u, yBot + 0.42, out);
  const s1 = c.at(u, yBot + 0.16, out * 0.35);
  const s2 = c.at(u, yBot + 0.05, out * 0.35);
  b.geo('metal_rusted', tube([s0, s1, s2], r, 8, { segLen: 0.4 }), null, { zone, tile: 0.8 });
  // brackets
  const n = Math.max(2, Math.round((yTop - yBot) / 2.1));
  for (let i = 0; i < n; i++) {
    const y = yBot + 0.9 + (i * (yTop - yBot - 1.3)) / Math.max(1, n - 1);
    const p = c.at(u, y, out * 0.5);
    b.box('metal_painted', p[0], p[1], p[2], 0.05, 0.05, out,
      { zone, ry: c.ry, bevel: 0.01, cast: false });
  }
  // the wash mark: 60 mm of stained concrete each side of the pipe
  const wm = c.at(u + 0.16, (yTop + yBot) / 2 - 0.4, 0.012);
  b.box('paint_grey', wm[0], wm[1], wm[2], 0.34, yTop - yBot - 1.2, 0.014,
    { zone, ry: c.ry, bevel: 0.004, cast: false, solid: false });
}

/* ---------------------------------------------------------------- vents ---- */

/** Louvred wall vent: recessed dark box, angled blades, storm frame, birdmesh. */
export function louvreBank(b, c, o) {
  const zone = o.zone, w = o.w, h = o.h;
  const p = c.at(o.u, o.y, 0.02);
  b.box('tower_shade', p[0], p[1], p[2], w - 0.1, h - 0.1, 0.1,
    { zone, ry: c.ry, bevel: 0.01, cast: false });
  const blades = Math.max(3, Math.round(h / 0.19));
  for (let i = 0; i < blades; i++) {
    const y = o.y - h / 2 + (i + 0.5) * (h / blades);
    const q = c.at(o.u, y, 0.09);
    b.box('metal_painted', q[0], q[1], q[2], w - 0.16, 0.045, 0.15,
      { zone, ry: c.ry, rx: 0.55 * c.sgn, bevel: 0.008 });
  }
  // storm frame
  for (const [dw, dh, du, dy] of [[w + 0.14, 0.1, 0, h / 2], [w + 0.14, 0.1, 0, -h / 2],
    [0.1, h, -w / 2, 0], [0.1, h, w / 2, 0]]) {
    const q = c.at(o.u + du, o.y + dy, 0.12);
    b.box('metal_painted', q[0], q[1], q[2], dw, dh, 0.11, { zone, ry: c.ry, bevel: 0.014 });
  }
  if (o.hood !== false) {
    const q = c.at(o.u, o.y + h / 2 + 0.16, 0.24);
    b.box('metal_rusted', q[0], q[1], q[2], w + 0.34, 0.08, 0.42,
      { zone, ry: c.ry, rx: -0.22 * c.sgn, bevel: 0.018 });
  }
}

/** Extract fan penetration: a cowled duct through the wall on a base plate. */
export function wallFan(b, c, o) {
  const zone = o.zone, r = o.r ?? 0.42;
  const p = c.at(o.u, o.y, 0.04);
  b.box('metal_painted', p[0], p[1], p[2], r * 2.5, r * 2.5, 0.09,
    { zone, ry: c.ry, bevel: 0.02, seg: 2 });
  const q = c.at(o.u, o.y, 0.36);
  const m = b.xform(q[0], q[1], q[2], { ry: c.ry, rx: HALF_PI });
  b.geo('metal_rusted', cyl(r, r, 0.62, 14, { open: true }), m, { zone, tile: 0.9 });
  const h = c.at(o.u, o.y + r + 0.16, 0.5);
  b.box('metal_rusted', h[0], h[1], h[2], r * 2.3, 0.07, r * 1.6,
    { zone, ry: c.ry, rx: -0.3 * c.sgn, bevel: 0.016 });
  for (let i = 0; i < 4; i++) {
    const bl = c.at(o.u, o.y, 0.34);
    b.box('metal_painted', bl[0], bl[1], bl[2], r * 1.7, 0.06, 0.05,
      { zone, ry: c.ry, rz: (i / 4) * Math.PI, bevel: 0.01, cast: false });
  }
}

/* --------------------------------------------------------------- services -- */

/** Horizontal conduit bank on saddles, with a drop leg into a box. */
export function conduitBank(b, c, o) {
  const zone = o.zone;
  const n = o.n ?? 3;
  for (let i = 0; i < n; i++) {
    const out = 0.14 + i * 0.075;
    const a = c.at(o.u0, o.y + i * 0.012, out);
    const d = c.at(o.u1, o.y + i * 0.012, out);
    b.geo(i % 2 ? 'metal_painted' : 'metal_rusted',
      tube([a, d], 0.035 + (i % 2) * 0.015, 6, { segLen: 3.2, caps: false }), null,
      { zone, tile: 0.9, solid: false });
  }
  const saddles = Math.max(2, Math.round(Math.abs(o.u1 - o.u0) / 2.4));
  for (let i = 0; i <= saddles; i++) {
    const u = o.u0 + ((o.u1 - o.u0) * i) / saddles;
    const p = c.at(u, o.y + 0.02, 0.16);
    b.box('metal_painted', p[0], p[1], p[2], 0.06, 0.16, 0.34,
      { zone, ry: c.ry, bevel: 0.012, cast: false });
  }
  if (o.drop) {
    const a = c.at(o.u1, o.y, 0.15);
    const d = c.at(o.u1, o.drop, 0.15);
    b.geo('metal_rusted', tube([a, d], 0.04, 6, { segLen: 2.4, caps: false }), null,
      { zone, tile: 0.9, solid: false });
  }
}

/** Wall-mounted junction box with a bolted lid and a gland plate. */
export function junctionBox(b, c, o) {
  const zone = o.zone;
  const w = o.w ?? 0.44, h = o.h ?? 0.56, d = o.d ?? 0.2;
  const p = c.at(o.u, o.y, d / 2);
  b.box('metal_painted', p[0], p[1], p[2], w, h, d, { zone, ry: c.ry, bevel: 0.02, seg: 2 });
  const l = c.at(o.u, o.y, d + 0.02);
  b.box('metal_rusted', l[0], l[1], l[2], w - 0.06, h - 0.06, 0.035,
    { zone, ry: c.ry, bevel: 0.012 });
  for (const su of [-1, 1]) {
    for (const sy of [-1, 1]) {
      const q = c.at(o.u + su * (w / 2 - 0.05), o.y + sy * (h / 2 - 0.05), d + 0.05);
      b.box('metal_painted', q[0], q[1], q[2], 0.035, 0.035, 0.03,
        { zone, ry: c.ry, bevel: 0.006, cast: false });
    }
  }
  const g = c.at(o.u, o.y - h / 2 - 0.06, d * 0.6);
  b.geo('metal_rusted', cyl(0.03, 0.03, 0.16, 8), b.xform(g[0], g[1], g[2], {}),
    { zone, tile: 0.4, cast: false });
}

/* -------------------------------------------------------------- concrete --- */

/**
 * Movement joint: a 25 mm gap between two proud arrises, with a pressed metal
 * cover strip over it. Every 20-30 m of concrete elevation has one, and it is
 * the only vertical line on a wall that is allowed to run edge to edge.
 */
export function movementJoint(b, c, o) {
  const zone = o.zone;
  for (const s of [-1, 1]) {
    const p = c.at(o.u + s * 0.085, o.y, 0.018);
    b.box('concrete', p[0], p[1], p[2], 0.1, o.h, 0.04,
      { zone, ry: c.ry, bevel: 0.014, cast: false });
  }
  const q = c.at(o.u, o.y, 0.03);
  b.box('metal_painted', q[0], q[1], q[2], 0.14, o.h - 0.2, 0.02,
    { zone, ry: c.ry, bevel: 0.006, cast: false, solid: false });
}

/** Shotcrete patch repair — a different concrete, cast proud, with drill scars. */
export function patchRepair(b, c, o) {
  const zone = o.zone;
  const p = c.at(o.u, o.y, 0.028);
  // A hand-floated patch is never square to the panel grid. Two degrees of skew
  // and a 25 mm surface wobble is the whole difference between a repair and a
  // poster stuck on the wall.
  b.box('concrete_poured', p[0], p[1], p[2], o.w, o.h, 0.055, {
    zone, ry: c.ry, rz: o.rz ?? 0, bevel: 0.022, seg: 4,
    jitter: 0.026, jitterFreq: 1.6, cast: false,
  });
  const holes = Math.max(2, Math.round(o.w));
  for (let i = 0; i < holes; i++) {
    const q = c.at(o.u - o.w / 2 + ((i + 0.5) * o.w) / holes, o.y + o.h / 2 - 0.12, 0.06);
    b.geo('metal_rusted', cyl(0.016, 0.016, 0.04, 6), b.xform(q[0], q[1], q[2], { rx: HALF_PI }),
      { zone, tile: 0.3, cast: false, solid: false });
  }
}

/** Spalled concrete: a shallow recess with the reinforcement showing through. */
export function spall(b, c, o) {
  const zone = o.zone;
  const p = c.at(o.u, o.y, -0.03);
  b.box('tower_shade', p[0], p[1], p[2], o.w, o.h, 0.06,
    { zone, ry: c.ry, bevel: 0.03, seg: 3, jitter: 0.02, cast: false });
  for (let i = 0; i < 3; i++) {
    const q = c.at(o.u - o.w / 2 + ((i + 0.5) * o.w) / 3, o.y, 0.01);
    b.box('metal_rusted', q[0], q[1], q[2], 0.016, o.h * 0.86, 0.016,
      { zone, ry: c.ry, bevel: 0.004, cast: false, solid: false });
  }
  const r = c.at(o.u, o.y, 0.012);
  b.box('metal_rusted', r[0], r[1], r[2], o.w * 0.8, 0.016, 0.014,
    { zone, ry: c.ry, bevel: 0.004, cast: false, solid: false });
}

/* --------------------------------------------------------------- stencil --- */

/**
 * A stroke font. Industrial identification is stencilled 300-600 mm high in
 * black on pale concrete, and it is the one piece of dressing that tells a
 * viewer the building has a NAME. Each stroke is a chamfered box 15 mm proud of
 * the wall, so the paint film catches its own grazing highlight.
 */
const GLYPH = {
  0: [[0, 0, 1, 0], [1, 0, 1, 1], [1, 1, 0, 1], [0, 1, 0, 0]],
  1: [[0.5, 0, 0.5, 1], [0.16, 0.8, 0.5, 1]],
  2: [[0, 1, 1, 1], [1, 1, 1, 0.5], [1, 0.5, 0, 0.5], [0, 0.5, 0, 0], [0, 0, 1, 0]],
  3: [[0, 1, 1, 1], [1, 1, 1, 0], [0, 0, 1, 0], [0.25, 0.5, 1, 0.5]],
  4: [[0, 1, 0, 0.45], [0, 0.45, 1, 0.45], [1, 1, 1, 0]],
  5: [[1, 1, 0, 1], [0, 1, 0, 0.5], [0, 0.5, 1, 0.5], [1, 0.5, 1, 0], [1, 0, 0, 0]],
  6: [[1, 1, 0, 1], [0, 1, 0, 0], [0, 0, 1, 0], [1, 0, 1, 0.5], [1, 0.5, 0, 0.5]],
  7: [[0, 1, 1, 1], [1, 1, 0.32, 0]],
  8: [[0, 0, 1, 0], [1, 0, 1, 1], [1, 1, 0, 1], [0, 1, 0, 0], [0, 0.5, 1, 0.5]],
  9: [[1, 0, 1, 1], [1, 1, 0, 1], [0, 1, 0, 0.5], [0, 0.5, 1, 0.5]],
  A: [[0, 0, 0.5, 1], [0.5, 1, 1, 0], [0.2, 0.38, 0.8, 0.38]],
  B: [[0, 0, 0, 1], [0, 1, 0.84, 1], [0.84, 1, 0.84, 0.52], [0, 0.52, 1, 0.52], [1, 0.52, 1, 0], [0, 0, 1, 0]],
  C: [[1, 1, 0, 1], [0, 1, 0, 0], [0, 0, 1, 0]],
  D: [[0, 0, 0, 1], [0, 1, 0.75, 1], [0.75, 1, 1, 0.75], [1, 0.75, 1, 0.25], [1, 0.25, 0.75, 0], [0.75, 0, 0, 0]],
  E: [[1, 1, 0, 1], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0.5, 0.78, 0.5]],
  F: [[1, 1, 0, 1], [0, 1, 0, 0], [0, 0.5, 0.78, 0.5]],
  G: [[1, 1, 0, 1], [0, 1, 0, 0], [0, 0, 1, 0], [1, 0, 1, 0.48], [1, 0.48, 0.48, 0.48]],
  H: [[0, 0, 0, 1], [1, 0, 1, 1], [0, 0.5, 1, 0.5]],
  I: [[0.5, 0, 0.5, 1], [0.15, 1, 0.85, 1], [0.15, 0, 0.85, 0]],
  K: [[0, 0, 0, 1], [0, 0.48, 1, 1], [0, 0.48, 1, 0]],
  L: [[0, 1, 0, 0], [0, 0, 1, 0]],
  M: [[0, 0, 0, 1], [0, 1, 0.5, 0.42], [0.5, 0.42, 1, 1], [1, 1, 1, 0]],
  N: [[0, 0, 0, 1], [0, 1, 1, 0], [1, 0, 1, 1]],
  O: [[0, 0, 1, 0], [1, 0, 1, 1], [1, 1, 0, 1], [0, 1, 0, 0]],
  P: [[0, 0, 0, 1], [0, 1, 1, 1], [1, 1, 1, 0.5], [1, 0.5, 0, 0.5]],
  R: [[0, 0, 0, 1], [0, 1, 1, 1], [1, 1, 1, 0.5], [1, 0.5, 0, 0.5], [0.42, 0.5, 1, 0]],
  S: [[1, 1, 0, 1], [0, 1, 0, 0.5], [0, 0.5, 1, 0.5], [1, 0.5, 1, 0], [1, 0, 0, 0]],
  T: [[0, 1, 1, 1], [0.5, 1, 0.5, 0]],
  U: [[0, 1, 0, 0], [0, 0, 1, 0], [1, 0, 1, 1]],
  V: [[0, 1, 0.5, 0], [0.5, 0, 1, 1]],
  W: [[0, 1, 0.25, 0], [0.25, 0, 0.5, 0.58], [0.5, 0.58, 0.75, 0], [0.75, 0, 1, 1]],
  X: [[0, 0, 1, 1], [0, 1, 1, 0]],
  Y: [[0, 1, 0.5, 0.48], [1, 1, 0.5, 0.48], [0.5, 0.48, 0.5, 0]],
  Z: [[0, 1, 1, 1], [1, 1, 0, 0], [0, 0, 1, 0]],
  '-': [[0.08, 0.5, 0.92, 0.5]],
  '.': [[0.4, 0, 0.6, 0]],
  '/': [[0, 0, 1, 1]],
  ' ': [],
};

/** Stencil `text` with its baseline at y and its left edge at u. */
export function stencil(b, c, o) {
  const zone = o.zone;
  const size = o.size ?? 0.5;
  const gw = size * 0.62, gap = size * 0.26;
  const th = o.thick ?? Math.max(0.045, size * 0.13);
  const mat = o.mat ?? 'paint_dark';
  const text = String(o.text).toUpperCase();
  // Glyph x advances along the VIEWER's right, which is -u on a face whose
  // normal points the other way. Without this the sign reads mirrored.
  let adv = 0;
  for (const ch of text) {
    const strokes = GLYPH[ch];
    if (strokes) {
      for (const [x0, y0, x1, y1] of strokes) {
        const au = o.u + c.sgn * (adv + x0 * gw);
        const bu = o.u + c.sgn * (adv + x1 * gw);
        const ay = o.y + y0 * size, by = o.y + y1 * size;
        const du = bu - au, dy = by - ay;
        const len = Math.hypot(du, dy);
        const p = c.at((au + bu) / 2, (ay + by) / 2, 0.016);
        b.box(mat, p[0], p[1], p[2], len + th * 0.5, th, 0.016,
          { zone, ry: c.ry, rz: Math.atan2(dy, du), bevel: 0.005, cast: false, solid: false });
      }
    }
    adv += gw + gap;
  }
  return o.u + c.sgn * (adv - gap);
}

/* ----------------------------------------------------------------- eaves --- */

/**
 * Projecting eaves band. A 550 mm overhang throws a hard horizontal shadow the
 * full width of an elevation, which is the strongest single tonal break you can
 * put on a tall wall — and it costs one box and one drip nib.
 */
export function eavesBand(b, c, o) {
  const zone = o.zone;
  const p = c.at(o.len / 2, o.y, 0.28);
  b.box('concrete', p[0], p[1], p[2], o.len, 0.34, 0.62,
    { zone, ry: c.ry, bevel: 0.035, seg: 3 });
  const d = c.at(o.len / 2, o.y - 0.22, 0.5);
  b.box('concrete', d[0], d[1], d[2], o.len, 0.11, 0.13,
    { zone, ry: c.ry, bevel: 0.016, cast: false });
  // corbels under it, so the band is carried and not glued on
  const n = Math.max(2, Math.round(o.len / 4.5));
  for (let i = 0; i <= n; i++) {
    const q = c.at((o.len * i) / n, o.y - 0.5, 0.2);
    b.box('concrete', q[0], q[1], q[2], 0.28, 0.66, 0.44,
      { zone, ry: c.ry, bevel: 0.03, seg: 2 });
  }
}

/**
 * A ventilation / cable riser: a 700 mm square duct standing off the wall from
 * plinth to eaves on stand-off brackets, with a flanged joint every storey and
 * a weather cowl on top. It is the one piece of dressing tall enough to cut an
 * eleven-metre elevation in two, and it puts a hard vertical shadow on the wall
 * behind it at every sun angle.
 */
export function riser(b, c, o) {
  const zone = o.zone;
  const w = o.w ?? 0.72, out = 0.46;
  const mid = (o.y0 + o.y1) / 2;
  const p = c.at(o.u, mid, out);
  b.box('metal_painted', p[0], p[1], p[2], w, o.y1 - o.y0, w,
    { zone, ry: c.ry, bevel: 0.028, seg: 3 });
  const joints = Math.max(2, Math.round((o.y1 - o.y0) / 2.6));
  for (let i = 1; i < joints; i++) {
    const y = o.y0 + ((o.y1 - o.y0) * i) / joints;
    const q = c.at(o.u, y, out);
    b.box('metal_rusted', q[0], q[1], q[2], w + 0.09, 0.075, w + 0.09,
      { zone, ry: c.ry, bevel: 0.014 });
    // stand-off bracket back to the wall
    const s = c.at(o.u, y + 0.1, out * 0.5);
    b.box('metal_painted', s[0], s[1], s[2], 0.07, 0.07, out,
      { zone, ry: c.ry, bevel: 0.012, cast: false });
  }
  const cap = c.at(o.u, o.y1 + 0.16, out);
  b.box('metal_rusted', cap[0], cap[1], cap[2], w + 0.3, 0.09, w + 0.3,
    { zone, ry: c.ry, bevel: 0.02 });
  const cowl = c.at(o.u, o.y1 + 0.42, out);
  b.box('metal_rusted', cowl[0], cowl[1], cowl[2], w + 0.16, 0.42, w + 0.16,
    { zone, ry: c.ry, bevel: 0.024, seg: 2 });
  // inspection hatch at working height
  const hd = c.at(o.u, o.y0 + 1.35, out + w / 2);
  b.box('metal_rusted', hd[0], hd[1], hd[2], w * 0.62, 0.5, 0.03,
    { zone, ry: c.ry, bevel: 0.01, cast: false });
}

/** Horizontal string course at a floor line, with a throated drip. */
export function stringCourse(b, c, o) {
  const zone = o.zone;
  const p = c.at(o.len / 2, o.y, 0.1);
  b.box('concrete', p[0], p[1], p[2], o.len - 0.2, 0.22, 0.28,
    { zone, ry: c.ry, bevel: 0.028, seg: 2, cast: false });
}

/* ------------------------------------------------------------ orchestrator - */

const overlaps = (list, u, y, w, h, pad) => {
  for (const k of list) {
    if (u + w / 2 + pad > k.u && u - w / 2 - pad < k.u + k.w
      && y + h / 2 + pad > k.y && y - h / 2 - pad < k.y + k.h) return true;
  }
  return false;
};

/**
 * The u-intervals of an elevation that no opening occupies at ANY height —
 * i.e. the columns a full-height item (downpipe, riser, movement joint) can
 * actually stand in.
 *
 * This is the difference between dressing landing and not landing. The first
 * version nudged a candidate along by 1.3 m up to six times and gave up; on the
 * admin block's west elevation, which carries fourteen openings across 38 m,
 * that rejected every downpipe and both movement joints, and the wall came back
 * from the render still bare. Solving for the gaps directly cannot fail.
 */
function freeColumns(open, len, pad) {
  const spans = open
    .map((k) => [k.u - pad, k.u + k.w + pad])
    .sort((a, c) => a[0] - c[0]);
  const out = [];
  let cur = 0.35;
  for (const [a, e] of spans) {
    if (a > cur) out.push([cur, Math.min(a, len - 0.35)]);
    cur = Math.max(cur, e);
  }
  if (cur < len - 0.35) out.push([cur, len - 0.35]);
  return out.filter(([a, e]) => e - a > 0.55).sort((a, c) => (c[1] - c[0]) - (a[1] - a[0]));
}

/**
 * Try `tries` random spots for a w x h item; call `fn(u, y)` on the first fit.
 * A placed item is pushed back into the exclusion list, so two vents can never
 * be dropped on top of each other — which is what happened on the first pass and
 * rendered as one louvre growing out of the side of another.
 */
function scatter(r, open, o, n, tries, w, h, yLo, yHi, pad, fn) {
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < tries; k++) {
      const u = w / 2 + 0.4 + r() * Math.max(0.1, o.len - w - 0.8);
      const y = yLo + r() * Math.max(0.1, yHi - yLo);
      if (overlaps(open, u, y, w, h, pad)) continue;
      fn(u, y);
      open.push({ u: u - w / 2, y: y - h / 2, w, h });
      break;
    }
  }
}

/**
 * Dress a whole elevation. Deterministic from `seed`, and every placement is
 * tested against the opening list first so nothing lands in a window.
 *
 * o = { axis, cx, cz, len, y0, height, thick, face, zone, seed, openings,
 *       eaves, joints, labels:[{u,y,text,size}], density }
 */
export function dressElevation(b, o) {
  const c = cursor(o);
  const zone = o.zone;
  const r = rng(o.seed ?? 4001);
  const open = (o.openings ?? []).map((k) => ({ u: k.u, y: k.y, w: k.w, h: k.h }));
  const y0 = o.y0, top = o.y0 + o.height;
  const D = o.density ?? 1;

  if (o.eaves !== false) eavesBand(b, c, { zone, len: o.len, y: top - 0.35 });
  for (const y of o.courses ?? []) stringCourse(b, c, { zone, len: o.len, y });

  // ---- full-height items.
  //
  // Corners first: every real building puts its rainwater goods on the corner,
  // and a corner is the one part of an elevation guaranteed to be clear of
  // openings — which also means the item is guaranteed to land in frame when the
  // camera is looking at that corner. Everything else takes a clear column from
  // the solved gap list, widest first, and each column is consumed as it is used
  // so two full-height items can never occupy the same one.
  const cols = freeColumns(open, o.len, 0.4);
  const nextCol = (want) => {
    for (let k = 0; k < cols.length; k++) {
      if (cols[k][1] - cols[k][0] >= want) return cols.splice(k, 1)[0];
    }
    return null;
  };

  for (const u of o.corners ?? [0.52, o.len - 0.52]) {
    if (overlaps(open, u, y0 + o.height / 2, 0.5, o.height, 0.1)) continue;
    downpipe(b, c, { zone, u, yTop: top - 0.9, yBot: y0 });
  }

  // service risers: a 700 mm square duct from the plinth to the eaves. The one
  // vertical element big enough to break an eleven-metre elevation in half.
  for (let i = 0; i < (o.risers ?? (D >= 1 ? 2 : 1)); i++) {
    const col = nextCol(1.35);
    if (!col) break;
    riser(b, c, { zone, u: (col[0] + col[1]) / 2, y0: y0 + 0.4, y1: top - 0.8 });
  }

  // downpipes: one per 11 m of run, standing in the remaining clear columns
  const pipes = Math.max(1, Math.round((o.len / 11) * D));
  for (let i = 0; i < pipes; i++) {
    const col = nextCol(0.7);
    if (!col) break;
    const u = col[0] + 0.35 + r() * Math.max(0, col[1] - col[0] - 0.7);
    downpipe(b, c, { zone, u, yTop: top - 0.9, yBot: y0 });
  }

  if (o.joints !== false) {
    const n = Math.max(1, Math.round(o.len / 22));
    for (let i = 0; i < n; i++) {
      const col = nextCol(0.85);
      if (!col) break;
      movementJoint(b, c, {
        zone, u: (col[0] + col[1]) / 2, y: y0 + o.height / 2 - 0.2, h: o.height - 1.2,
      });
    }
  }

  // louvre banks and a fan or two, at plant-room heights
  scatter(r, open, o, Math.max(1, Math.round((o.len / 13) * D)), 14,
    2.2, 1.3, y0 + 1.4, y0 + Math.max(1.5, o.height - 2.6), 0.45, (u, y) => {
      louvreBank(b, c, { zone, u, y, w: 1.2 + r() * 1.5, h: 0.85 + r() * 0.7 });
    });
  scatter(r, open, o, D >= 1 ? 2 : 1, 12, 1.5, 1.5,
    y0 + 2.0, y0 + Math.max(2.2, o.height - 3.2), 0.45, (u, y) => {
      wallFan(b, c, { zone, u, y, r: 0.34 + r() * 0.16 });
    });

  // conduit: one long horizontal run at service height plus drops into boxes.
  // `serviceY` lets a caller move it clear of a hand-placed pipe run.
  const runY = o.serviceY ?? y0 + 2.4 + r() * 0.8;
  const u0 = 0.8 + r() * 2, u1 = o.len - 0.8 - r() * 2;
  if (o.conduits !== false && u1 - u0 > 4) {
    conduitBank(b, c, { zone, u0, u1, y: runY, n: 2 + Math.round(r() * 2), drop: y0 + 0.9 });
  }
  scatter(r, open, o, Math.max(3, Math.round((o.len / 6) * D)), 12,
    0.8, 0.9, y0 + 1.25, y0 + 2.3, 0.3, (u, y) => {
      junctionBox(b, c, {
        zone, u, y, w: 0.32 + r() * 0.22, h: 0.4 + r() * 0.3, d: 0.16 + r() * 0.09,
      });
    });

  // wear: patch repairs and spalls, concentrated low where plant hits concrete
  scatter(r, open, o, Math.max(4, Math.round((o.len / 4.5) * D)), 12,
    2.0, 1.5, y0 + 0.6, y0 + Math.max(0.8, o.height * 0.62), 0.3, (u, y) => {
      const w = 0.7 + r() * 1.9, h = 0.5 + r() * 1.5;
      if (r() < 0.62) patchRepair(b, c, { zone, u, y, w, h, rz: (r() - 0.5) * 0.09 });
      else spall(b, c, { zone, u, y, w: Math.min(w, 0.9), h: Math.min(h, 0.7) });
    });

  for (const t of o.labels ?? []) {
    stencil(b, c, { zone, u: t.u, y: t.y, text: t.text, size: t.size ?? 0.55, mat: t.mat });
  }
  return c;
}

export { cursor };
