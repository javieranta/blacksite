import * as THREE from 'three';
import { chamferBox, cyl, tube, lathe, jitter, rng } from './GeoKit.js';
import { jersey, basePlate } from './Modules.js';

/**
 * OWNER: level agent.
 *
 * The near layer. Every framing in this map was previously a clean sweep from
 * the camera to the midground with nothing inside 4 metres, which is why the
 * hero shots read as flat: no foreground means no parallax, no value anchor and
 * nothing to bracket the composition against.
 *
 * This module builds the 2-4m band, sited explicitly against the hero camera
 * (eye 6,1.62,14 looking 200 degrees, vFOV 80, 16:9):
 *
 *   LEFT edge, 3.3m    a derelict yard mast — a 3.4m post that runs from the
 *                      top of frame to the bottom at 15% of frame width. The
 *                      single strongest thing in the image, because a hard
 *                      vertical at the edge is what tells the eye how deep the
 *                      rest of the frame is.
 *   RIGHT edge, 3.0m   a fractured barrier and a leaning weldmesh panel, with a
 *                      crash block pulled forward to 2.7m. Brackets the other
 *                      side and reads black against the lit paving.
 *   ACROSS the top     three cable swags off the mast head, two spanning out of
 *                      frame and one broken and hanging into the near ground.
 *                      Catenaries across the sky are the cheapest depth cue
 *                      there is and they cost about 300 triangles.
 *
 * Everything here is a real collider through the normal bake path, and all of it
 * is placed clear of the spawn walk-out lane so it frames the shot without
 * fighting the player.
 */

const ZONE = 'fg';
const MAST = { x: 10.3, z: 15.9, h: 3.0, plinth: 0.44 };

/** Catenary control points between two ends with a given mid-span sag. */
function swagPoints(p0, p1, sag, n = 5) {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    out.push([
      p0[0] + (p1[0] - p0[0]) * t,
      p0[1] + (p1[1] - p0[1]) * t - 4 * sag * t * (1 - t),
      p0[2] + (p1[2] - p0[2]) * t,
    ]);
  }
  return out;
}

/** Welded-mesh fence panel: real wires, so it reads as mesh in silhouette. */
function meshPanel(b, o) {
  const { w, h } = o;
  const nv = Math.max(3, Math.round(w / 0.19));
  const nh = Math.max(3, Math.round(h / 0.19));
  const wire = 0.011;
  const parts = [];
  for (let i = 0; i <= nv; i++) {
    const g = chamferBox(wire * 2, h, wire * 2, wire * 0.6, 1);
    g.translate(-w / 2 + (i / nv) * w, 0, 0);
    parts.push(g);
  }
  for (let j = 0; j <= nh; j++) {
    const g = chamferBox(w, wire * 2, wire * 2, wire * 0.6, 1);
    g.translate(0, -h / 2 + (j / nh) * h, wire * 1.8);
    parts.push(g);
  }
  // rolled top and bottom edge, and a corner post
  for (const s of [-1, 1]) {
    const g = chamferBox(w + 0.03, 0.028, 0.028, 0.008, 1);
    g.translate(0, s * h / 2, wire);
    parts.push(g);
  }
  for (const g of parts) {
    b.geo(o.mat ?? 'metal_rusted', g, o.matrix, { zone: ZONE, tile: 0.6, solid: false });
  }
}

/* ------------------------------------------------------------------ the mast - */

/**
 * A yard lighting / signalling mast that no longer works: post, cantilever arm,
 * a smashed floodlight, conduit, a junction box and a bolted warning plate.
 * Its job in the image is to be a hard black vertical at the left frame edge
 * from sy 0.14 to 0.86 — it converts an open sweep into a framed view.
 */
function buildMast(b, w) {
  const { x, z, h, plinth } = MAST;
  // plinth: a poured pad, a chamfered upstand, then a real bolted base
  b.box('concrete', x, 0.17, z, 0.98, 0.34, 0.98,
    { zone: ZONE, bevel: 0.045, seg: 3, jitter: 0.01, tile: 1.2 });
  b.box('concrete', x, plinth - 0.05, z, 0.66, 0.2, 0.66,
    { zone: ZONE, bevel: 0.035, seg: 2, tile: 1.0 });
  basePlate(b, { x, y: plinth, z, size: 0.42, zone: ZONE, ribAxis: 'x', stem: 0.1 });

  // the post: 190mm square hollow section, tapering very slightly
  b.box('metal_painted', x, plinth + 0.2 + h / 2, z, 0.19, h, 0.19,
    { zone: ZONE, bevel: 0.014, seg: 4, tile: 1.0 });
  const top = plinth + 0.2 + h;
  b.box('metal_painted', x, top + 0.025, z, 0.25, 0.05, 0.25, { zone: ZONE, bevel: 0.01, tile: 0.6 });

  // cantilever arm reaching into frame, with a diagonal stay under it
  const armEnd = [x - 1.22, top - 0.14, z + 0.1];
  b.geo('metal_painted', tube([[x - 0.06, top - 0.18, z], armEnd], 0.055, 8, { segLen: 1.4 }),
    null, { zone: ZONE, tile: 0.8 });
  b.geo('metal_rusted', tube([[x - 0.05, top - 0.95, z], [x - 0.92, top - 0.2, z + 0.07]], 0.032, 7,
    { segLen: 1.2 }), null, { zone: ZONE, tile: 0.6 });

  // the floodlight: hood, body, and a cracked lens that still catches the sun
  const lm = b.xform(armEnd[0] - 0.16, armEnd[1] - 0.14, armEnd[2], { rx: 0.44, ry: -0.3 });
  b.geo('metal_painted', chamferBox(0.56, 0.2, 0.42, 0.03, 2), lm, { zone: ZONE, tile: 0.7 });
  b.geo('metal_rusted', chamferBox(0.64, 0.05, 0.5, 0.02, 1),
    b.xform(armEnd[0] - 0.16, armEnd[1] - 0.02, armEnd[2], { rx: 0.44, ry: -0.3 }),
    { zone: ZONE, tile: 0.7 });
  b.geo('glass', chamferBox(0.46, 0.03, 0.33, 0.01, 1),
    b.xform(armEnd[0] - 0.19, armEnd[1] - 0.22, armEnd[2] + 0.02, { rx: 0.44, ry: -0.3 }),
    { zone: ZONE, tile: 0.9, cast: false });

  // conduit down the back of the post, junction box, cleats
  b.geo('metal_rusted', tube([[x + 0.12, top - 0.3, z + 0.11], [x + 0.12, plinth + 0.34, z + 0.11]],
    0.026, 7, { segLen: 1.6 }), null, { zone: ZONE, tile: 0.5, solid: false });
  b.box('metal_painted', x + 0.16, 1.46, z + 0.11, 0.16, 0.28, 0.13,
    { zone: ZONE, bevel: 0.014, tile: 0.5 });
  for (const yy of [0.95, 2.05, 2.75]) {
    b.box('metal_rusted', x + 0.13, yy, z + 0.11, 0.07, 0.03, 0.09,
      { zone: ZONE, bevel: 0.006, tile: 0.3, solid: false });
  }
  // bolted warning plate — a flat bright face that reads at 20m
  b.box('metal_painted', x - 0.115, 2.02, z, 0.03, 0.56, 0.42,
    { zone: ZONE, bevel: 0.012, seg: 2, tile: 0.7 });
  b.box('metal_rusted', x - 0.135, 2.02, z, 0.02, 0.42, 0.3,
    { zone: ZONE, bevel: 0.008, tile: 0.5, cast: false });

  // three insulator stacks at the head where the cables land
  for (let i = 0; i < 3; i++) {
    const px = x + 0.02, pz = z - 0.26 + i * 0.26;
    b.geo('metal_painted', lathe([[0, 0], [0.05, 0.01], [0.05, 0.04], [0.08, 0.06],
      [0.05, 0.08], [0.05, 0.11], [0.08, 0.13], [0.05, 0.15], [0.04, 0.17], [0, 0.17]], 10),
    b.xform(px, top + 0.05, pz, {}), { zone: ZONE, tile: 0.3, solid: false });
  }
  return { top: top + 0.2, armEnd };
}

/* ------------------------------------------------- the right-edge occluder --- */

/**
 * A fractured barrier line. One unit toppled onto its side, one snapped off at
 * the base with its reinforcement showing, a leaning mesh panel that carries the
 * tallest silhouette, and a crash block pulled forward to 2.7m so the bottom
 * right of the frame has real mass in it.
 */
function buildBrokenLine(b, w) {
  const r = rng(20771);
  // toppled unit — rz brings it onto its side, ry aims it across the frame edge
  jersey(b, {
    x: 4.42, y: 0.47, z: 18.15, len: 2.5, ry: 1.16, rz: Math.PI / 2, rx: 0.05,
    zone: ZONE, eyes: true,
  });
  // snapped stub still standing on its base, fracture face jittered
  b.geo('concrete', jitter(chamferBox(0.9, 0.78, 0.66, 0.045, 4), 0.03, 2.2),
    b.xform(3.28, 0.38, 18.72, { ry: 0.28 }), { zone: ZONE, tile: 1.2 });
  b.geo('concrete', jitter(chamferBox(0.82, 0.16, 0.6, 0.03, 3), 0.05, 3.4),
    b.xform(3.3, 0.8, 18.74, { ry: 0.28, rz: 0.06 }), { zone: ZONE, tile: 1.0 });
  // exposed reinforcement out of the fracture
  for (let i = 0; i < 5; i++) {
    const ox = -0.3 + i * 0.15, oz = (r() - 0.5) * 0.36;
    b.geo('metal_rusted', tube([
      [3.3 + ox, 0.6, 18.74 + oz],
      [3.3 + ox * 1.3, 0.98 + r() * 0.2, 18.74 + oz * 1.4],
      [3.3 + ox * 1.5 + (r() - 0.5) * 0.3, 1.12 + r() * 0.24, 18.74 + oz * 1.8 + (r() - 0.5) * 0.2],
    ], 0.012, 5, { segLen: 0.5 }), null, { zone: ZONE, tile: 0.3, solid: false });
  }
  // rubble at the break
  for (let i = 0; i < 9; i++) {
    const s = 0.1 + r() * 0.2;
    b.geo('concrete', jitter(chamferBox(s * 1.6, s, s * 1.3, s * 0.25, 1), s * 0.4, 4),
      b.xform(3.2 + (r() - 0.5) * 1.5, s * 0.5, 18.5 + (r() - 0.5) * 1.3, { ry: r() * 3.1, rz: (r() - 0.5) * 0.3 }),
      { zone: ZONE, tile: 0.7, solid: false });
  }
  // leaning weldmesh panel — the tallest thing in the near right of frame
  meshPanel(b, {
    w: 2.3, h: 1.85,
    matrix: b.xform(3.75, 0.94, 17.95, { ry: 1.1, rz: 0.17, rx: -0.24 }),
  });
  for (const s of [-1, 1]) {
    b.geo('metal_rusted', tube([[3.75 + s * 0.5, 0.02, 17.95 - s * 1.0],
      [3.75 + s * 0.52, 1.82, 17.95 - s * 1.06]], 0.028, 7, { segLen: 1.2 }), null,
    { zone: ZONE, tile: 0.5, solid: false });
  }
  // One crash block pulled to 2.7m from the camera. It is deliberately in wet
  // concrete: a foreground occluder has to sit *below* the midground in value
  // or it stops bracketing the shot and starts being the subject of it — the
  // first pass had two bright blocks here and they read as the brightest thing
  // in the image, which is exactly backwards.
  b.box('concrete_wet', 4.94, 0.29, 17.36, 0.9, 0.58, 0.9,
    { zone: ZONE, bevel: 0.055, seg: 4, jitter: 0.016, ry: -0.14, tile: 1.2 });
  for (const s of [-1, 1]) {
    b.geo('metal_rusted', new THREE.TorusGeometry(0.055, 0.014, 5, 12, Math.PI),
      b.xform(4.94, 0.59, 17.36 + s * 0.22, { ry: 0.2 }), { zone: ZONE, tile: 0.3, solid: false });
  }
  // and a stack of rusted deck plates leaning on it, which reads dark
  for (let i = 0; i < 4; i++) {
    b.box('metal_rusted', 4.62 - i * 0.035, 0.62 + i * 0.05, 17.5, 1.15, 0.045, 0.86,
      { zone: ZONE, bevel: 0.01, seg: 2, ry: 0.34 + i * 0.03, rz: 0.03, tile: 0.9 });
  }
  b.box('metal_rusted', 4.3, 0.55, 18.0, 1.05, 0.9, 0.05,
    { zone: ZONE, bevel: 0.012, seg: 2, ry: 0.9, rz: 0.34, tile: 0.9 });
  // split spiral ducting lying across the near ground
  b.geo('metal_rusted', cyl(0.34, 0.34, 2.2, 16, { open: true }),
    b.xform(3.95, 0.35, 17.75, { rz: Math.PI / 2, ry: 1.05 }), { zone: ZONE, tile: 0.9 });
  for (let i = 0; i < 7; i++) {
    b.geo('metal_rusted', new THREE.TorusGeometry(0.345, 0.022, 5, 14),
      b.xform(3.95 + Math.cos(1.05) * (-1.0 + i * 0.33), 0.35, 17.75 - Math.sin(1.05) * (-1.0 + i * 0.33),
        { rz: Math.PI / 2, ry: 1.05 }), { zone: ZONE, tile: 0.4, solid: false });
  }
  // a loose coil of cable
  for (let i = 0; i < 3; i++) {
    b.geo('metal_rusted', new THREE.TorusGeometry(0.34 - i * 0.05, 0.026, 5, 16),
      b.xform(3.05, 0.04 + i * 0.05, 17.0, { rx: Math.PI / 2, ry: i * 0.5 }),
      { zone: ZONE, tile: 0.4, solid: false });
  }
}

/* ---------------------------------------------------- the near-2m bracket --- */

/**
 * A snapped pipe-rack bent standing 2.2m from the hero camera.
 *
 * The hero framing already had a left bracket (the mast, at 3.3m) and a
 * mid-value right side, but nothing inside 2.7m and nothing on the right that
 * ran the full height of the frame — so the right third opened straight out to
 * the midground and the image had two layers, not three.
 *
 * The geometry is placed by projection, not by eye. From the eye at
 * (6,1.62,14) looking 200 degrees, forward is (0.342, 0, 0.940) and camera-right
 * is (-0.940, 0, 0.342); 2.2m forward and 2.6m right lands on (4.31, ~, 16.96),
 * which at vFOV 80 on 16:9 is 80% of the way to the right edge, and 3.4m of
 * height there fills the frame top to bottom. It is deliberately steel and
 * unlit-side-on: a near occluder has to be the darkest thing in the image or it
 * competes with the subject instead of framing it.
 */
function buildNearBent(b) {
  const X = 4.31, Z = 16.96, H = 3.42;
  // pad, grout haunch, base plate
  b.box('concrete', X, 0.13, Z, 1.05, 0.26, 1.05,
    { zone: ZONE, bevel: 0.05, seg: 3, jitter: 0.012, tile: 1.2 });
  b.box('concrete', X, 0.31, Z, 0.66, 0.14, 0.66, { zone: ZONE, bevel: 0.055, seg: 2, tile: 1.0 });
  basePlate(b, { x: X, y: 0.36, z: Z, size: 0.5, zone: ZONE, ribAxis: 'z', stem: 0.13 });
  // the stanchion: a 340mm universal column, snapped 300mm below the head
  b.box('metal_painted', X, 0.55 + H / 2, Z, 0.34, H, 0.2,
    { zone: ZONE, bevel: 0.016, seg: 4, ry: 0.22, tile: 0.9 });
  for (const s of [-1, 1]) {
    b.box('metal_painted', X + s * 0.145 * Math.cos(0.22), 0.55 + H / 2, Z - s * 0.145 * Math.sin(0.22),
      0.06, H, 0.34, { zone: ZONE, bevel: 0.012, seg: 3, ry: 0.22, tile: 0.9 });
  }
  // the fracture: a torn flange lip and four bent bolts where the cap tore off
  b.geo('metal_rusted', jitter(chamferBox(0.44, 0.05, 0.42, 0.012, 2), 0.03, 6),
    b.xform(X, 0.55 + H + 0.03, Z, { ry: 0.22, rz: 0.1 }), { zone: ZONE, tile: 0.6 });
  for (let i = 0; i < 4; i++) {
    const a = 0.22 + i * 1.57;
    b.geo('metal_rusted', tube([
      [X + Math.cos(a) * 0.16, 0.55 + H, Z + Math.sin(a) * 0.16],
      [X + Math.cos(a) * 0.2, 0.55 + H + 0.17, Z + Math.sin(a) * 0.2],
    ], 0.013, 4, { segLen: 0.5 }), null, { zone: ZONE, tile: 0.3, solid: false });
  }
  // The pipe the bent used to carry, sheared off over the camera's shoulder.
  // It runs across the top-right corner, which is the last part of the frame
  // with nothing in it.
  b.geo('metal_rusted', cyl(0.23, 0.23, 3.1, 14, { open: true }),
    b.xform(X + 0.55, 0.55 + H - 0.16, Z + 0.5, { rz: Math.PI / 2, ry: 1.28, rx: 0.06 }),
    { zone: ZONE, tile: 1.0 });
  b.geo('metal_painted', new THREE.TorusGeometry(0.245, 0.035, 6, 14),
    b.xform(X + 0.1, 0.55 + H - 0.16, Z + 0.07, { ry: 1.28, rx: Math.PI / 2 }),
    { zone: ZONE, tile: 0.4, solid: false });
  // torn mineral-wool lagging peeling off the underside of the pipe
  b.geo('fabric', cyl(0.32, 0.3, 0.9, 12, { open: true }),
    b.xform(X + 1.35, 0.55 + H - 0.2, Z + 0.78, { rz: Math.PI / 2, ry: 1.28, rx: 0.2 }),
    { zone: ZONE, tile: 0.8 });
  b.box('fabric', X + 1.95, 0.55 + H - 0.62, Z + 0.98, 0.62, 0.8, 0.03,
    { zone: ZONE, bevel: 0.02, seg: 2, ry: 1.1, rz: 0.34, tile: 0.7, solid: false });
  // conduit strapped up the web, and a severed drop cable swinging in the gap
  b.geo('metal_rusted', tube([[X + 0.17, 0.6, Z + 0.14], [X + 0.17, 0.55 + H - 0.4, Z + 0.14]],
    0.024, 6, { segLen: 2 }), null, { zone: ZONE, tile: 0.5, solid: false });
  b.geo('metal_rusted', tube([
    [X + 0.7, 0.55 + H - 0.32, Z + 0.62], [X + 0.86, 2.1, Z + 0.82],
    [X + 0.72, 1.1, Z + 0.7], [X + 0.9, 0.42, Z + 0.86], [X + 1.32, 0.06, Z + 1.02],
  ], 0.02, 6, { segLen: 0.5 }), null, { zone: ZONE, tile: 0.5, cast: false, solid: false });

  /* The bottom-left counterweight: an overturned cable drum at 1.9m. Reads as a
     dark disc against the lit paving and stops the near ground falling away on
     that side once the mast has left the bottom of frame. */
  const DX = 9.02, DZ = 14.93;
  for (const s of [-1, 1]) {
    b.geo('wood_plank', cyl(0.76, 0.76, 0.07, 18),
      b.xform(DX, 0.07, DZ + s * 0.0, { rz: Math.PI / 2, ry: 0.5, rx: s > 0 ? 0 : 0 }),
      { zone: ZONE, tile: 1.0 });
  }
  b.geo('wood_plank', cyl(0.76, 0.76, 0.62, 18, { open: true }),
    b.xform(DX, 0.42, DZ, { rz: Math.PI / 2, ry: 0.5 }), { zone: ZONE, tile: 1.0 });
  b.geo('wood_plank', cyl(0.31, 0.31, 0.66, 12),
    b.xform(DX, 0.42, DZ, { rz: Math.PI / 2, ry: 0.5 }), { zone: ZONE, tile: 0.8 });
  for (const s of [-1, 1]) {
    b.geo('wood_plank', cyl(0.78, 0.78, 0.06, 18),
      b.xform(DX + Math.cos(0.5) * s * 0.32, 0.42, DZ - Math.sin(0.5) * s * 0.32,
        { rz: Math.PI / 2, ry: 0.5 }), { zone: ZONE, tile: 1.0 });
  }
  // cable still on the drum, and a loose tail run out across the paving
  for (let i = 0; i < 5; i++) {
    b.geo('metal_rusted', new THREE.TorusGeometry(0.4 + i * 0.055, 0.03, 5, 16),
      b.xform(DX + Math.cos(0.5) * (i - 2) * 0.055, 0.42, DZ - Math.sin(0.5) * (i - 2) * 0.055,
        { rz: Math.PI / 2, ry: 0.5 }), { zone: ZONE, tile: 0.5, solid: false });
  }
  b.geo('metal_rusted', tube([
    [DX - 0.2, 0.85, DZ + 0.36], [DX - 0.9, 0.42, DZ + 0.9], [DX - 1.7, 0.05, DZ + 1.1],
    [DX - 2.5, 0.04, DZ + 0.72],
  ], 0.026, 6, { segLen: 0.7 }), null, { zone: ZONE, tile: 0.5, cast: false, solid: false });
}

/* ------------------------------------------------------------------- cables -- */

/**
 * Overhead cables off the mast head. Two spans leave the frame, one is broken
 * and hangs into the near ground with its end coiled on the paving. Three thin
 * catenaries are worth far more to the read of depth than their triangle count.
 */
function buildCables(b, w, mast) {
  const head = [MAST.x + 0.02, mast.top - 0.02, MAST.z];
  const spans = [
    { to: [5.2, 4.66, 19.0], sag: 0.62, n: 6 },     // to the canopy column head
    { to: [22.3, 3.52, 14.85], sag: 1.35, n: 7 },   // out of frame, past the stair tower
  ];
  for (const sp of spans) {
    for (let k = 0; k < 3; k++) {
      const off = (k - 1) * 0.26;
      const pts = swagPoints(
        [head[0], head[1] - Math.abs(off) * 0.1, head[2] + off],
        [sp.to[0], sp.to[1] - Math.abs(off) * 0.1, sp.to[2] + off],
        sp.sag + k * 0.06, sp.n,
      );
      b.geo('metal_rusted', tube(pts, 0.017, 6, { segLen: 1.5, tension: 0.5 }), null,
        { zone: ZONE, tile: 0.5, cast: false, solid: false });
    }
  }
  // the far anchor bracket, so the second span lands on something
  b.box('metal_rusted', 22.34, 3.52, 14.85, 0.3, 0.12, 0.12, { zone: ZONE, bevel: 0.014, tile: 0.4 });
  b.box('metal_painted', 22.5, 3.52, 14.85, 0.08, 0.34, 0.24, { zone: ZONE, bevel: 0.014, tile: 0.4 });

  // the broken span: leaves the arm, drops through the near frame, coils up
  const drop = [
    [mast.armEnd[0] + 0.1, mast.armEnd[1] - 0.06, mast.armEnd[2] + 0.02],
    [8.92, 2.42, 16.42], [8.66, 1.16, 16.86], [8.78, 0.42, 17.24], [9.16, 0.13, 17.52],
    [9.72, 0.09, 17.44],
  ];
  b.geo('metal_rusted', tube(drop, 0.021, 7, { segLen: 0.55 }), null,
    { zone: ZONE, tile: 0.5, cast: false, solid: false });
  for (let i = 0; i < 3; i++) {
    b.geo('metal_rusted', new THREE.TorusGeometry(0.3 - i * 0.06, 0.021, 5, 14),
      b.xform(9.95 + i * 0.06, 0.055 + i * 0.04, 17.34, { rx: Math.PI / 2, ry: 0.4 + i * 0.6 }),
      { zone: ZONE, tile: 0.4, cast: false, solid: false });
  }
  // a stub of severed conductor still swinging off the canopy end
  b.geo('metal_rusted', tube([[5.2, 4.6, 19.0], [5.34, 3.6, 19.24], [5.2, 2.7, 19.1]], 0.019, 6,
    { segLen: 0.7 }), null, { zone: ZONE, tile: 0.5, cast: false, solid: false });
}

/* ------------------------------------------------------- secondary framings -- */

/**
 * The other captures get the same treatment at lower cost. `vertical` looks
 * south-west off the plant deck, so it needs a near element on the deck itself;
 * `silhouette-dusk` looks west along the yard and had nothing inside 6m.
 */
function buildSecondary(b, w) {
  const deck = 4.70;
  // plant deck: a leaning stillage and a bundle of pipe offcuts in the near 2m
  b.box('metal_rusted', -1.35, deck + 0.52, -1.55, 1.15, 0.08, 0.85,
    { zone: ZONE, bevel: 0.02, seg: 2, tile: 0.8 });
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    b.box('metal_rusted', -1.35 + sx * 0.5, deck + 0.26, -1.55 + sz * 0.36, 0.07, 0.52, 0.07,
      { zone: ZONE, bevel: 0.01, tile: 0.4 });
  }
  for (let i = 0; i < 6; i++) {
    b.geo('metal_rusted', cyl(0.075, 0.075, 1.5, 10),
      b.xform(-1.5 + (i % 3) * 0.17, deck + 0.62 + Math.floor(i / 3) * 0.16, -1.55,
        { rz: Math.PI / 2, ry: 0.22 + i * 0.03 }), { zone: ZONE, tile: 0.6 });
  }
  b.geo('metal_painted', cyl(0.29, 0.32, 0.9, 16), b.xform(0.55, deck + 0.45, -1.72, { rz: 0.06 }),
    { zone: ZONE, tile: 0.8 });

  // Yard: a pipe trestle 2.4m in front of the `silhouette-dusk` camera, at the
  // left of that frame. Backlit at dusk it is a black bar across the near
  // ground — the one thing that shot had nothing of inside six metres.
  const y = -0.35, tx = 22.4, tz = -2.6;
  for (const s of [-1, 1]) {
    b.box('metal_painted', tx, y + 0.42, tz + s * 0.72, 0.1, 0.84, 0.1,
      { zone: ZONE, bevel: 0.012, tile: 0.5 });
    b.box('metal_painted', tx, y + 0.06, tz + s * 0.72, 0.5, 0.08, 0.34,
      { zone: ZONE, bevel: 0.014, tile: 0.4 });
    b.geo('metal_rusted', tube([[tx, y + 0.08, tz + s * 0.72], [tx + s * 0.0, y + 0.78, tz + s * 0.18]],
      0.024, 6, { segLen: 1 }), null, { zone: ZONE, tile: 0.4, solid: false });
  }
  b.box('metal_painted', tx, y + 0.86, tz, 0.16, 0.09, 1.7, { zone: ZONE, bevel: 0.012, tile: 0.5 });
  b.geo('metal_rusted', cyl(0.21, 0.21, 3.2, 14),
    b.xform(tx, y + 1.02, tz, { rx: Math.PI / 2, rz: 0.04 }), { zone: ZONE, tile: 1.0 });
  b.geo('metal_rusted', cyl(0.13, 0.13, 2.9, 12),
    b.xform(tx + 0.33, y + 0.98, tz + 0.1, { rx: Math.PI / 2, rz: 0.03 }), { zone: ZONE, tile: 1.0 });
  for (const t of [-1.0, 0.4]) {
    b.geo('metal_painted', new THREE.TorusGeometry(0.225, 0.03, 6, 14),
      b.xform(tx, y + 1.02, tz + t, { rx: Math.PI / 2 }), { zone: ZONE, tile: 0.4, solid: false });
  }
}

/* -------------------------------------------------------------------- entry -- */

export function buildForeground(b, w) {
  const mast = buildMast(b, w);
  buildBrokenLine(b, w);
  buildNearBent(b);
  buildCables(b, w, mast);
  buildSecondary(b, w);
}
