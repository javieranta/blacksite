import * as THREE from 'three';
import { cyl, lathe, tube, chamferBox } from './GeoKit.js';
import { railingRun, stair, pipeRun, ladder, basePlate, haunch, coping } from './Modules.js';

/**
 * OWNER: level agent.
 *
 * The West Hall's process plant: everything a light shaft can fall across.
 *
 * ROOT CAUSE this file exists to fix: the hall had a shell, a mezzanine, roof
 * trusses and seven small machine plinths, and between the plinths and the
 * trusses there was ten metres of empty air. Seven rooflights throw seven clean
 * parallelograms onto a clean floor and stop — no shaft is INTERRUPTED by
 * anything, and an uninterrupted shaft reads as a projected texture rather than
 * as light in a volume. The lighting agent is rebuilding the shafts this round
 * and needs occluders at every height between the roof and the floor.
 *
 * So this adds, from the top down:
 *   - roof purlins at 2.3 m centres, which chop every shaft into blades,
 *   - a proper overhead travelling crane on corbelled rails, with the bridge,
 *     end carriages, trolley, rope and hook block,
 *   - a cable-tray pair and a rectangular extract duct at truss height,
 *   - a turbine deck: raised foundation, horizontal casing on saddles, split
 *     flange, end covers, lube skid, handrail and access stair,
 *   - two vertical pressure vessels with ring platforms, and
 *   - a glazed control cabin on the mezzanine.
 *
 * Everything is placed clear of the interior capture position at (-8, 1.7, -4)
 * looking -X, of the inspection pit, and of the machine plinth grid already in
 * Interiors.js — the plan positions below are coordinated with both.
 */

const HALF_PI = Math.PI / 2;

/* ------------------------------------------------------------------ roof --- */

/** Purlins spanning between the trusses. The cheapest shadow blades there are. */
function purlins(b, h, zi) {
  const y = h.roof - 0.62;
  const n = Math.round((h.x1 - h.x0) / 2.3);
  for (let i = 1; i < n; i++) {
    const x = h.x0 + ((h.x1 - h.x0) * i) / n;
    b.box('metal_painted', x, y, h.cz, 0.13, 0.26, h.z1 - h.z0 - 1.4,
      { zone: zi, bevel: 0.02 });
    // sag rods at third points keep the purlin run from reading as loose bars
    for (const t of [0.33, 0.67]) {
      const z = h.z0 + 0.7 + (h.z1 - h.z0 - 1.4) * t;
      b.box('metal_rusted', x, y - 0.02, z, 0.05, 0.05, 2.2, { zone: zi, bevel: 0.01, rx: 0.35 });
    }
  }
}

/* ----------------------------------------------------------------- crane --- */

/**
 * Overhead travelling crane. Rails run along the hall on corbels off the two
 * pillar lines; the bridge spans between them; the hook block hangs 3 m into the
 * volume on a rope. It is the one object in an industrial hall that occupies the
 * middle of the air, which is exactly where a light shaft needs an occluder.
 */
function crane(b, h, zi) {
  const railY = h.floor + 6.85;
  const [xa, xb] = h.craneRails;
  const zBridge = h.craneZ;
  for (const rx of [xa, xb]) {
    b.box('concrete', rx, railY - 0.34, h.cz, 0.9, 0.42, h.z1 - h.z0 - 1.2,
      { zone: zi, bevel: 0.04, seg: 3 });
    b.box('metal_painted', rx, railY, h.cz, 0.42, 0.28, h.z1 - h.z0 - 1.2,
      { zone: zi, bevel: 0.025, seg: 3 });
    b.box('metal_rusted', rx, railY + 0.2, h.cz, 0.11, 0.13, h.z1 - h.z0 - 1.2,
      { zone: zi, bevel: 0.02 });
    // corbel brackets off each pillar
    for (let i = 0; i < 5; i++) {
      const z = h.z0 + 4 + i * 8;
      haunch(b, {
        x: rx + (rx < h.cx ? 0.45 : -0.45), y: railY - 1.5, z,
        reach: 0.8, rise: 1.1, width: 0.42, zone: zi,
        ry: rx < h.cx ? 0 : Math.PI,
      });
    }
  }
  const span = xb - xa;
  const mid = (xa + xb) / 2;
  for (const s of [-1, 1]) {
    b.box('metal_painted', mid, railY + 0.95, zBridge + s * 1.15, span - 0.4, 1.15, 0.36,
      { zone: zi, bevel: 0.03, seg: 4 });
    b.box('metal_rusted', mid, railY + 1.56, zBridge + s * 1.15, span - 0.4, 0.09, 0.52,
      { zone: zi, bevel: 0.02 });
  }
  // walkway along one side of the bridge
  b.geo('metal_rusted', chamferBox(span - 0.6, 0.05, 0.8, 0.01),
    b.xform(mid, railY + 1.62, zBridge + 2.0, {}), { zone: zi, tile: 0.9 });
  railingRun(b, {
    from: new THREE.Vector3(xa + 0.3, railY + 1.64, zBridge + 2.38),
    to: new THREE.Vector3(xb - 0.3, railY + 1.64, zBridge + 2.38), zone: zi, toe: false,
  });
  for (const rx of [xa, xb]) {
    b.box('metal_painted', rx, railY + 0.42, zBridge, 1.5, 0.7, 3.4,
      { zone: zi, bevel: 0.03, seg: 3 });
    for (const s of [-1, 1]) {
      b.geo('metal_rusted', cyl(0.3, 0.3, 0.16, 12),
        b.xform(rx, railY + 0.1, zBridge + s * 1.3, { rx: HALF_PI }), { zone: zi, tile: 0.6 });
    }
  }
  // trolley, rope and hook block
  const tx = mid + h.craneTrolley;
  b.box('metal_painted', tx, railY + 1.9, zBridge, 2.4, 1.5, 3.0, { zone: zi, bevel: 0.04, seg: 3 });
  b.box('metal_rusted', tx - 0.9, railY + 2.72, zBridge, 1.1, 0.3, 1.5, { zone: zi, bevel: 0.03 });
  for (const s of [-1, 1]) {
    b.geo('metal_rusted', tube([[tx + s * 0.16, railY + 1.2, zBridge],
      [tx + s * 0.16, h.floor + 3.9, zBridge]], 0.028, 5, { segLen: 4, caps: false }), null,
    { zone: zi, tile: 1.0, solid: false });
  }
  b.box('metal_painted', tx, h.floor + 3.62, zBridge, 0.62, 0.72, 0.9, { zone: zi, bevel: 0.03, seg: 2 });
  b.geo('metal_rusted', new THREE.TorusGeometry(0.3, 0.055, 5, 12, Math.PI * 1.3),
    b.xform(tx, h.floor + 3.0, zBridge, { rx: 0, rz: Math.PI }), { zone: zi, tile: 0.5 });
  // festoon cable loops back along the bridge
  for (let i = 0; i < 7; i++) {
    const x0 = xa + 1.2 + i * ((span - 2.4) / 7);
    const x1 = x0 + (span - 2.4) / 7;
    b.geo('metal_rusted', tube([
      [x0, railY + 1.5, zBridge - 1.5], [(x0 + x1) / 2, railY + 1.05, zBridge - 1.5],
      [x1, railY + 1.5, zBridge - 1.5],
    ], 0.035, 4, { segLen: 1.2, caps: false }), null, { zone: zi, tile: 1.0, solid: false });
  }
}

/* -------------------------------------------------------------- services --- */

/** Rectangular extract duct at truss height, with flanges, hangers and an elbow. */
function ductRun(b, h, zi) {
  const y = h.floor + 8.6, z = h.ductZ;
  const x0 = h.x0 + 2.4, x1 = h.x1 - 2.2;
  b.box('metal_painted', (x0 + x1) / 2, y, z, x1 - x0, 1.1, 1.5,
    { zone: zi, bevel: 0.035, seg: 5 });
  const joints = Math.round((x1 - x0) / 3.0);
  for (let i = 1; i < joints; i++) {
    const x = x0 + ((x1 - x0) * i) / joints;
    b.box('metal_rusted', x, y, z, 0.09, 1.24, 1.64, { zone: zi, bevel: 0.02 });
    for (const s of [-1, 1]) {
      b.geo('metal_painted', tube([[x, y + 0.58, z + s * 0.8], [x, h.roof - 0.25, z + s * 0.8]],
        0.026, 5, { segLen: 2, caps: false }), null, { zone: zi, tile: 1.0, solid: false });
    }
  }
  // elbow down to a filter box at the west end
  b.box('metal_painted', x0 - 0.6, y - 0.6, z, 1.5, 2.3, 1.5, { zone: zi, bevel: 0.04, seg: 3 });
  b.box('metal_rusted', x0 - 0.6, y - 1.9, z, 1.8, 0.5, 1.8, { zone: zi, bevel: 0.03, seg: 2 });
}

/** Ladder-type cable tray: two rails and a rung every 500 mm — striped shadow. */
function cableTray(b, h, zi, z, y, w = 0.5) {
  const x0 = h.x0 + 1.6, x1 = h.x1 - 1.4;
  for (const s of [-1, 1]) {
    b.box('metal_painted', (x0 + x1) / 2, y, z + s * w / 2, x1 - x0, 0.1, 0.045,
      { zone: zi, bevel: 0.014, seg: 4 });
  }
  const n = Math.floor((x1 - x0) / 0.5);
  for (let i = 0; i < n; i++) {
    b.box('metal_painted', x0 + (i + 0.5) * 0.5, y - 0.03, z, 0.035, 0.025, w,
      { zone: zi, bevel: 0.006, cast: true, solid: false });
  }
  const hangers = Math.round((x1 - x0) / 3.2);
  for (let i = 0; i <= hangers; i++) {
    const x = x0 + ((x1 - x0) * i) / hangers;
    b.box('metal_rusted', x, y + 0.62, z, 0.05, 1.2, 0.05, { zone: zi, bevel: 0.01, solid: false });
    b.box('metal_rusted', x, y + 0.1, z, 0.05, 0.05, w + 0.2, { zone: zi, bevel: 0.01, solid: false });
  }
}

/* ----------------------------------------------------------------- plant --- */

/**
 * Turbine deck: a raised foundation block with a horizontal casing on saddles.
 * The casing is a lathe with a real split flange down the centre line, bolted
 * every 400 mm, because the split line is what says "machine" rather than
 * "cylinder".
 */
function turbineDeck(b, h, zi) {
  const x = h.turbine[0], z = h.turbine[1];
  const y = h.floor;
  b.box('concrete', x, y + 0.5, z, 11.0, 1.0, 5.2, { zone: zi, bevel: 0.06, seg: 6, jitter: 0.01 });
  coping(b, { x, y: y + 1.0, z: z - 2.6, w: 0.5, len: 11.0, zone: zi });
  coping(b, { x, y: y + 1.0, z: z + 2.6, w: 0.5, len: 11.0, zone: zi });
  // anchor pockets
  for (let i = 0; i < 6; i++) {
    for (const s of [-1, 1]) {
      b.box('metal_rusted', x - 4.4 + i * 1.76, y + 1.02, z + s * 1.85, 0.24, 0.06, 0.24,
        { zone: zi, bevel: 0.02, cast: false });
    }
  }
  const cy = y + 1.0 + 1.62;
  const R = 1.52;
  // casing: two half shells with a split flange between them
  for (const s of [-1, 1]) {
    b.geo('metal_painted', cyl(R, R, 7.2, 20, { open: true, heightSeg: 1 }),
      b.xform(x, cy + s * 0.001, z, { rz: HALF_PI }), { zone: zi, tile: 1.4 });
  }
  b.box('metal_painted', x, cy, z, 7.2, 0.1, R * 2.24, { zone: zi, bevel: 0.02, seg: 4 });
  for (let i = 0; i < 18; i++) {
    for (const s of [-1, 1]) {
      b.geo('metal_rusted', cyl(0.055, 0.055, 0.14, 6),
        b.xform(x - 3.4 + i * 0.4, cy + 0.09, z + s * R * 1.02, {}), { zone: zi, tile: 0.4, solid: false });
    }
  }
  // end covers
  for (const s of [-1, 1]) {
    b.geo('metal_painted', lathe([[0, 0], [R * 0.6, 0.06], [R, 0.34], [R * 1.08, 0.62]], 20),
      b.xform(x + s * 3.6, cy, z, { rz: s * HALF_PI }), { zone: zi, tile: 1.2 });
    b.geo('metal_rusted', cyl(R * 1.1, R * 1.1, 0.1, 20),
      b.xform(x + s * 3.62, cy, z, { rz: HALF_PI }), { zone: zi, tile: 0.9 });
  }
  // saddles
  for (const s of [-1, 1]) {
    b.box('metal_painted', x + s * 2.7, y + 1.4, z, 0.5, 0.8, R * 2.1,
      { zone: zi, bevel: 0.03, seg: 3 });
  }
  // steam / lube pipework off the casing
  pipeRun(b, {
    points: [[x - 1.6, cy + R, z], [x - 1.6, cy + R + 1.4, z], [x - 1.6, cy + R + 1.4, z - 3.4],
      [x - 1.6, h.floor + 7.6, z - 3.4]],
    radius: 0.26, zone: zi, seg: 12, segLen: 1.2,
  });
  pipeRun(b, {
    points: [[x + 2.2, cy - R * 0.4, z + 1.4], [x + 2.2, cy - R * 0.4, z + 3.6],
      [x + 6.4, cy - R * 0.4, z + 3.6]],
    radius: 0.19, zone: zi, seg: 10, segLen: 1.4,
  });
  // lube-oil skid alongside
  b.box('concrete', x + 4.6, y + 0.24, z + 3.9, 3.0, 0.48, 2.0, { zone: zi, bevel: 0.04, seg: 3 });
  b.geo('metal_painted', cyl(0.72, 0.72, 2.4, 16),
    b.xform(x + 4.6, y + 0.48 + 0.9, z + 3.9, { rz: HALF_PI }), { zone: zi, tile: 1.0 });
  for (const s of [-1, 1]) {
    b.box('metal_rusted', x + 4.6 + s * 1.15, y + 0.6, z + 3.9, 0.14, 0.6, 1.5,
      { zone: zi, bevel: 0.02 });
  }
  // deck handrail and access stair
  for (const [ax, az, bx, bz] of [
    [x - 5.5, z - 2.6, x + 5.5, z - 2.6],
    [x - 5.5, z + 2.6, x + 2.6, z + 2.6],
    [x - 5.5, z - 2.6, x - 5.5, z + 2.6],
  ]) {
    railingRun(b, {
      from: new THREE.Vector3(ax, y + 1.0, az), to: new THREE.Vector3(bx, y + 1.0, bz), zone: zi,
    });
  }
  stair(b, {
    x: x + 4.2, y, z: z - 4.6, steps: 6, rise: 0.185, run: 0.29, width: 1.2,
    dir: new THREE.Vector3(0, 0, 1), zone: zi, mat: 'metal_rusted', stringerMat: 'metal_painted',
  });
}

/** Vertical pressure vessel on a skirt, with a ring platform and a caged ladder. */
function vessel(b, h, zi, x, z, r, hh) {
  const y = h.floor;
  b.box('concrete', x, y + 0.3, z, r * 2.9, 0.6, r * 2.9, { zone: zi, bevel: 0.05, seg: 4 });
  b.geo('metal_rusted', cyl(r * 0.92, r * 0.92, 1.5, 18, { open: true }),
    b.xform(x, y + 1.35, z, {}), { zone: zi, tile: 1.2 });
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.4;
    b.box('metal_rusted', x + Math.cos(a) * r * 0.92, y + 1.1, z + Math.sin(a) * r * 0.92,
      0.5, 0.9, 0.06, { zone: zi, bevel: 0.02, ry: -a });
  }
  b.geo('metal_painted', cyl(r, r, hh, 20), b.xform(x, y + 2.1 + hh / 2, z, {}), { zone: zi, tile: 1.5 });
  for (const s of [-1, 1]) {
    b.geo('metal_painted', lathe([[0, 0], [r * 0.62, 0.16], [r, 0.5]], 20),
      b.xform(x, y + 2.1 + hh / 2 + s * (hh / 2), z, { rx: s > 0 ? 0 : Math.PI }),
      { zone: zi, tile: 1.2 });
  }
  for (const t of [0.3, 0.72]) {
    b.geo('metal_rusted', new THREE.TorusGeometry(r + 0.04, 0.05, 5, 20),
      b.xform(x, y + 2.1 + hh * t, z, { rx: HALF_PI }), { zone: zi, tile: 0.8 });
  }
  // ring platform with grating and a railing
  const py = y + 2.1 + hh * 0.62;
  b.geo('metal_rusted', lathe([[r + 0.05, 0], [r + 1.15, 0], [r + 1.15, 0.06], [r + 0.05, 0.06]], 20),
    b.xform(x, py, z, {}), { zone: zi, tile: 0.9 });
  const posts = 12;
  for (let i = 0; i < posts; i++) {
    const a = (i / posts) * Math.PI * 2;
    b.box('metal_painted', x + Math.cos(a) * (r + 1.05), py + 0.55, z + Math.sin(a) * (r + 1.05),
      0.05, 1.05, 0.05, { zone: zi, bevel: 0.01, ry: -a, solid: false });
  }
  for (const yo of [1.05, 0.6]) {
    b.geo('metal_painted', new THREE.TorusGeometry(r + 1.05, 0.026, 4, 20),
      b.xform(x, py + yo, z, { rx: HALF_PI }), { zone: zi, tile: 0.9, solid: false });
  }
  ladder(b, { x, y: y + 0.6, z: z + r + 1.1, h: hh * 0.62 + 1.8, zone: zi });
  // relief line up into the roof services
  pipeRun(b, {
    points: [[x, y + 2.1 + hh + 0.5, z], [x, h.floor + 8.2, z], [x + 2.6, h.floor + 8.2, z]],
    radius: 0.15, zone: zi, seg: 10, segLen: 1.4,
  });
  basePlate(b, { x: x + r + 1.1, y, z: z + r + 1.1, size: 0.36, zone: zi });
}

/** Glazed control cabin on the mezzanine — a lit box in the far dark. */
function controlCabin(b, h, zi) {
  const x = h.cabin[0], z = h.cabin[1], y = h.cabin[2];
  const w = 5.6, d = 3.8, ht = 2.7;
  b.box('concrete', x, y + 0.06, z, w + 0.5, 0.12, d + 0.5, { zone: zi, bevel: 0.03, cast: false });
  // three solid walls, one glazed elevation facing down the hall
  b.box('metal_painted', x - w / 2, y + ht / 2, z, 0.14, ht, d, { zone: zi, bevel: 0.03, seg: 3 });
  for (const s of [-1, 1]) {
    b.box('metal_painted', x, y + ht / 2, z + s * d / 2, w, ht, 0.14, { zone: zi, bevel: 0.03, seg: 3 });
  }
  b.box('metal_painted', x + w / 2, y + 0.42, z, 0.14, 0.84, d, { zone: zi, bevel: 0.03, seg: 2 });
  b.box('metal_painted', x + w / 2, y + ht - 0.2, z, 0.14, 0.4, d, { zone: zi, bevel: 0.03, seg: 2 });
  b.box('glass', x + w / 2, y + 1.55, z, 0.02, 1.4, d - 0.3,
    { zone: zi, bevel: 0.006, cast: false, tile: 2.4 });
  for (let i = 1; i < 4; i++) {
    b.box('metal_painted', x + w / 2 + 0.02, y + 1.55, z - d / 2 + (i / 4) * d, 0.07, 1.4, 0.06,
      { zone: zi, bevel: 0.012 });
  }
  b.box('metal_rusted', x, y + ht + 0.1, z, w + 0.4, 0.16, d + 0.4, { zone: zi, bevel: 0.03, seg: 3 });
  // desk inside, so the glass has something behind it
  b.box('metal_rusted', x + 0.9, y + 0.85, z, 1.0, 0.08, d - 1.0, { zone: zi, bevel: 0.02, cast: false });
  for (let i = 0; i < 3; i++) {
    b.box('metal_painted', x + 0.9, y + 1.25, z - 1.0 + i * 1.0, 0.16, 0.7, 0.6,
      { zone: zi, bevel: 0.02, rx: 0.2 });
  }
  return { x, y, z, w, d, ht };
}

/* ------------------------------------------------------------------ entry -- */

export function buildHallPlant(b, w, hall) {
  const zi = 'hall_int';
  const h = {
    ...hall,
    cx: (hall.x0 + hall.x1) / 2,
    cz: (hall.z0 + hall.z1) / 2,
    craneRails: [hall.x0 + 7.0, hall.x0 + 22.0],
    craneZ: 3.0,
    craneTrolley: 1.8,
    ductZ: 4.6,
    turbine: [hall.x0 + 17.0, 3.5],
    cabin: [hall.x0 + 4.6, 8.0, hall.floor + 5.24],
  };

  purlins(b, h, zi);
  crane(b, h, zi);
  ductRun(b, h, zi);
  cableTray(b, h, zi, -2.2, h.floor + 7.15);
  cableTray(b, h, zi, 6.4, h.floor + 6.75, 0.42);
  turbineDeck(b, h, zi);
  vessel(b, h, zi, hall.x0 + 17.5, -11.5, 1.15, 5.6);
  vessel(b, h, zi, hall.x0 + 12.0, -15.0, 0.95, 4.6);
  controlCabin(b, h, zi);

  // the turbine deck is cover, so it is worth standing on
  w.enemySpawns.push(new THREE.Vector3(h.turbine[0] - 3.0, hall.floor + 2.85, h.turbine[1]));
  w.lightAnchors.push({
    position: new THREE.Vector3(h.cabin[0] + 1.6, h.cabin[2] + 1.9, h.cabin[1]),
    colour: 0xcfe2ff, intensity: 10, distance: 12, kind: 'cabin', priority: 6,
  });
}
