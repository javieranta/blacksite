import * as THREE from 'three';
import { chamferBox, corrugated, cyl, tube, gratingPanel, rng } from './GeoKit.js';
import {
  wall, cladding, windowUnit, doorUnit, shutter, slab, landing, pillar,
  stair, railingRun, catwalk, pipeRun, truss, coping, ladder,
} from './Modules.js';
import { L } from './Compound.js';
import { dressElevation } from './Facade.js';
import { buildHallPlant } from './HallPlant.js';

/**
 * OWNER: level agent.
 * The two enclosed buildings.
 *
 * WEST HALL  x[-38,-7.5]  z[-18,22]  floor -0.35  roof 9.8 + a glazed monitor
 *   A genuinely sealed volume: four walls, a ceiling, deliberate apertures on
 *   every elevation and three roof lights. Shot from (-8,1.7,-4) looking -X you
 *   see no sky except through the openings — which is the entire point.
 *
 * ADMIN BLOCK  x[30,48]  z[-8,30]  three storeys at 0 / 3.7 / 7.4, roof 11.1
 *   Carries the right-hand mass of the hero frame and the far wall of the
 *   silhouette frame, with a lit shutter opening you can see straight through.
 */

const HALL = { x0: -38, x1: -7.5, z0: -18, z1: 22, floor: L.yard, roof: 9.8 };

/* ------------------------------------------------------------- west hall --- */

export function buildWestHall(b, w) {
  const zone = 'hall';
  const zi = 'hall_int';
  const ap = w.apertures;
  const { x0, x1, z0, z1, floor, roof } = HALL;
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  const W = x1 - x0, D = z1 - z0, H = roof - floor;

  // ---- floor slab, drainage and machine bases
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 5; j++) {
      const pw = W / 4, pd = D / 5;
      b.box(i === 1 && j === 2 ? 'concrete_wet' : 'concrete',
        x0 + (i + 0.5) * pw, floor - 0.3, z0 + (j + 0.5) * pd, pw - 0.06, 0.6, pd - 0.06,
        { zone: zi, bevel: 0.05, seg: 6, jitter: 0.01, cast: false });
    }
  }

  // ---- shell walls with deliberate, generous apertures
  // South elevation: the mid-height window band, plus a continuous clerestory
  // at 8.0m. The clerestory is the one that matters for the interior read — a
  // band of light sources above the truss line rakes right across the hall and
  // gives the volumetrics a long throw, where the mid-height windows only wash
  // the wall opposite.
  const southOpen = [
    { u: 4.0, y: floor + 3.2, w: 4.2, h: 3.4 },
    { u: 13.2, y: floor + 3.2, w: 4.2, h: 3.4 },
    { u: 22.4, y: floor + 3.2, w: 4.2, h: 3.4 },
    { u: 27.4, y: floor + 0.1, w: 1.4, h: 2.1 },
    { u: 2.4, y: floor + 8.0, w: 5.2, h: 1.7 },
    { u: 10.4, y: floor + 8.0, w: 5.2, h: 1.7 },
    { u: 18.4, y: floor + 8.0, w: 5.2, h: 1.7 },
    { u: 25.0, y: floor + 8.0, w: 4.2, h: 1.7 },
  ];
  wall(b, {
    cx, cz: z0, len: W, height: H, thick: 0.42, axis: 'x', y0: floor, zone, mat: 'concrete',
    openings: southOpen, pilasterEvery: 5.0, apertures: ap,
  });
  const northOpen = [
    { u: 5.0, y: floor + 3.4, w: 3.6, h: 3.0 },
    { u: 13.0, y: floor + 3.4, w: 3.6, h: 3.0 },
    { u: 22.0, y: floor + 0.1, w: 3.0, h: 3.4 },
  ];
  wall(b, {
    cx, cz: z1, len: W, height: H, thick: 0.42, axis: 'x', y0: floor, zone, mat: 'concrete',
    openings: northOpen, pilasterEvery: 5.0, apertures: ap,
  });
  // west elevation: a tall glazed band, the light source the interior shot faces
  const westOpen = [];
  for (let i = 0; i < 5; i++) westOpen.push({ u: 3.0 + i * 7.0, y: floor + 2.9, w: 4.6, h: 5.0 });
  westOpen.push({ u: 36.0, y: floor + 0.1, w: 1.4, h: 2.1 });
  wall(b, {
    cx: x0, cz, len: D, height: H, thick: 0.45, axis: 'z', y0: floor, zone, mat: 'concrete',
    openings: westOpen, pilasterEvery: 5.0, apertures: ap,
  });
  // east elevation: big vehicle shutter into the service yard + a door
  // The 8x6.5m vehicle opening is deliberately placed at z 0..-8 so the elevated
  // plant-deck framing looks straight down into the hall: the enclosed interior
  // becomes the midground of an exterior shot instead of a blank elevation.
  const eastOpen = [
    { u: 22.0, y: floor + 0.1, w: 8.0, h: 6.5 },   // vehicle shutter  -> z  0..-8
    { u: 19.2, y: L.deck, w: 1.6, h: 2.2 },        // high-level door  -> z  2.0
    { u: 34.0, y: floor + 0.1, w: 1.4, h: 2.1 },   // personnel door   -> z -12.7
    { u: 6.0, y: floor + 4.4, w: 3.2, h: 2.6 },
    { u: 12.0, y: floor + 4.4, w: 3.2, h: 2.6 },
  ];
  wall(b, {
    cx: x1, cz, len: D, height: H, thick: 0.42, axis: 'z', y0: floor, zone, mat: 'concrete',
    openings: eastOpen, pilasterEvery: 5.0, apertures: ap,
  });

  // frames + glazing in the apertures
  const zOf = (u) => z1 - u;            // axis 'z' runs from z1 toward z0
  const xOf = (u) => x0 + u;            // axis 'x' runs from x0 toward x1
  for (const o of southOpen.slice(0, 3)) {
    windowUnit(b, {
      x: xOf(o.u + o.w / 2), y: o.y + o.h / 2, z: z0, w: o.w, h: o.h, axis: 'x',
      zone, cols: 4, rows: 3, apertures: ap,
    });
  }
  for (const o of southOpen.slice(4)) {
    windowUnit(b, {
      x: xOf(o.u + o.w / 2), y: o.y + o.h / 2, z: z0, w: o.w, h: o.h, axis: 'x',
      zone, cols: 5, rows: 1, apertures: ap,
    });
  }
  for (const o of northOpen.slice(0, 2)) {
    windowUnit(b, {
      x: xOf(o.u + o.w / 2), y: o.y + o.h / 2, z: z1, w: o.w, h: o.h, axis: 'x',
      zone, cols: 3, rows: 3, apertures: ap,
    });
  }
  for (const o of westOpen.slice(0, 5)) {
    windowUnit(b, {
      x: x0, y: o.y + o.h / 2, z: zOf(o.u + o.w / 2), w: o.w, h: o.h, axis: 'z',
      zone, cols: 4, rows: 4, apertures: ap,
    });
  }
  for (const o of eastOpen.slice(3)) {
    windowUnit(b, {
      x: x1, y: o.y + o.h / 2, z: zOf(o.u + o.w / 2), w: o.w, h: o.h, axis: 'z',
      zone, cols: 3, rows: 2, apertures: ap,
    });
  }
  doorUnit(b, { x: x1, y: L.deck, z: zOf(20.0), w: 1.6, h: 2.2, axis: 'z', zone, leaf: true, open: true });
  doorUnit(b, { x: xOf(28.1), y: floor + 0.1, z: z0, w: 1.4, h: 2.1, axis: 'x', zone, leaf: true, open: true });
  doorUnit(b, { x: x0, y: floor + 0.1, z: zOf(36.7), w: 1.4, h: 2.1, axis: 'z', zone, leaf: true });
  doorUnit(b, { x: x1, y: floor + 0.1, z: zOf(34.7), w: 1.4, h: 2.1, axis: 'z', zone, leaf: true, open: true });
  shutter(b, { x: x1, y: floor + 0.1, z: zOf(26.0), w: 8.0, h: 6.5, axis: 'z', zone, closed: 0.2 });

  // ---- elevation dressing. The east elevation is the left-hand mass of both
  // hero framings and the far wall of `vertical`, so it gets the density; the
  // south elevation is the long backdrop of the service-yard framings. The
  // conduit run is pushed to 5.4 m to stay clear of the hand-placed pipe run
  // and ladder further down this function.
  dressElevation(b, {
    axis: 'z', cx: x1, cz, len: D, y0: floor, height: H, thick: 0.42, face: 1,
    zone, seed: 6203, openings: eastOpen, density: 0.85, serviceY: floor + 5.4,
    labels: [
      { u: 30.6, y: floor + 4.6, text: 'HALL 2', size: 0.62 },
      { u: 15.6, y: floor + 7.4, text: 'W-12', size: 0.45 },
    ],
  });
  dressElevation(b, {
    axis: 'x', cx, cz: z0, len: W, y0: floor, height: H, thick: 0.42, face: -1,
    zone, seed: 6211, openings: southOpen, density: 0.9,
    labels: [{ u: 8.2, y: floor + 5.4, text: 'H-2', size: 0.6 }],
  });
  dressElevation(b, {
    axis: 'z', cx: x0, cz, len: D, y0: floor, height: H, thick: 0.45, face: -1,
    zone, seed: 6217, openings: westOpen, density: 0.55, joints: false,
  });

  // cladding band over the concrete on the north and east elevations
  cladding(b, {
    cx, cy: floor + H - 2.2, cz: z1 + 0.24, len: W, height: 3.6, axis: 'x', zone,
    mat: 'metal_rusted', rails: 3, backFace: false,
  });

  // ---- roof: deck, three roof lights, parapet, and a glazed ridge monitor
  // Roof lights. Seven of them, at 4.4-5.2m rather than the previous four at
  // 3.0-3.6m. A 3m opening 10m above the floor throws a shaft whose cross
  // section is under 3% of the hall's plan area — nowhere near enough for the
  // volumetrics to have anything to bite on. These are sized and spaced so that
  // the interior capture at (-8,1.7,-4) looking west has three of them stacked
  // down its sightline, and every one of them carries a real mullion grid, so
  // what lands on the floor is a pattern and not a soft rectangle.
  const holes = [
    { x: 12.0, z: -9.0, w: 4.4, d: 4.4 },
    { x: 9.0, z: -1.0, w: 5.0, d: 5.0 },    // 5m in front of the capture position
    { x: 9.0, z: 9.0, w: 5.0, d: 5.0 },
    { x: 9.0, z: -13.5, w: 4.4, d: 4.4 },
    { x: -8.0, z: 0.0, w: 5.2, d: 5.2 },
    { x: -8.0, z: -11.5, w: 4.6, d: 4.6 },
    { x: -8.0, z: 11.5, w: 4.6, d: 4.6 },
  ];
  slab(b, {
    x: cx, y: roof, z: cz, w: W + 0.5, d: D + 0.5, thick: 0.4, zone, mat: 'concrete',
    holes: [...holes, { x: 0, z: 0, w: 5.0, d: D - 6 }],
  });
  for (const h of holes) {
    for (const s of [-1, 1]) {
      b.box('metal_painted', cx + h.x + s * (h.w / 2 + 0.1), roof + 0.42, cz + h.z, 0.2, 0.6, h.d + 0.4,
        { zone, bevel: 0.02, seg: 2 });
      b.box('metal_painted', cx + h.x, roof + 0.42, cz + h.z + s * (h.d / 2 + 0.1), h.w + 0.4, 0.6, 0.2,
        { zone, bevel: 0.02, seg: 2 });
    }
    b.geo('glass', chamferBox(h.w, 0.03, h.d, 0.008), b.xform(cx + h.x, roof + 0.62, cz + h.z, {}),
      { zone, tile: 2, cast: false });
    // glazing bars: a 3x3 grid of 90mm sections across the light. These are the
    // only thing in the roof that can put a cross pattern on the floor, and they
    // cost sixty triangles each.
    for (let i = 1; i < 3; i++) {
      b.box('metal_painted', cx + h.x - h.w / 2 + (i / 3) * h.w, roof + 0.58, cz + h.z,
        0.09, 0.11, h.d, { zone, bevel: 0.014 });
      b.box('metal_painted', cx + h.x, roof + 0.58, cz + h.z - h.d / 2 + (i / 3) * h.d,
        h.w, 0.11, 0.09, { zone, bevel: 0.014 });
    }
    ap.push({
      position: new THREE.Vector3(cx + h.x, roof, cz + h.z),
      normal: new THREE.Vector3(0, 1, 0), width: h.w, height: h.d, kind: 'rooflight',
    });
  }
  // ridge monitor over the central void
  const mz = D - 6;
  for (const s of [-1, 1]) {
    b.box('concrete', cx + s * 2.6, roof + 1.35, cz, 0.28, 2.7, mz, { zone, bevel: 0.03, seg: 4 });
    b.geo('glass', chamferBox(0.03, 2.1, mz - 0.6, 0.01),
      b.xform(cx + s * 2.6, roof + 1.5, cz, {}), { zone, tile: 2, cast: false });
    for (let i = 0; i < 9; i++) {
      b.box('metal_painted', cx + s * 2.62, roof + 1.5, cz - mz / 2 + (i + 0.5) * (mz / 9),
        0.07, 2.1, 0.06, { zone, bevel: 0.012 });
    }
    ap.push({
      position: new THREE.Vector3(cx + s * 2.6, roof + 1.5, cz),
      normal: new THREE.Vector3(s, 0, 0), width: mz, height: 2.1, kind: 'clerestory',
    });
  }
  slab(b, { x: cx, y: roof + 2.9, z: cz, w: 6.6, d: mz + 0.6, thick: 0.28, zone, mat: 'metal_painted' });
  for (let i = 0; i < 5; i++) {
    const g = corrugated(6.8, (mz + 0.8) / 5, { backFace: false, pitch: 0.09 });
    b.geo('metal_rusted', g,
      b.xform(cx, roof + 3.12, cz - (mz + 0.8) / 2 + (i + 0.5) * ((mz + 0.8) / 5), { rx: -Math.PI / 2 }),
      { zone, tile: 1.5 });
  }
  // parapet all round
  for (const [px, pz, pw, pd] of [[cx, z0 - 0.2, W + 0.9, 0.34], [cx, z1 + 0.2, W + 0.9, 0.34],
    [x0 - 0.2, cz, 0.34, D + 0.9], [x1 + 0.2, cz, 0.34, D + 0.9]]) {
    b.box('concrete', px, roof + 0.75, pz, pw, 1.1, pd, { zone, bevel: 0.035, seg: 3 });
    coping(b, {
      x: px, y: roof + 1.3, z: pz, w: 0.5, len: pw > pd ? pw : pd,
      ry: pw > pd ? 0 : Math.PI / 2, zone,
    });
  }

  // ---- interior structure
  for (const px of [x0 + 7.0, x0 + 22.0]) {
    for (let i = 0; i < 5; i++) {
      pillar(b, {
        x: px, y: floor, z: z0 + 4 + i * 8, w: 0.7, h: H - 0.6, zone: zi, mat: 'concrete',
        seg: 5, corbel: true,
      });
    }
  }
  for (let i = 0; i < 10; i++) {
    const tz = z0 + 2 + i * 4;
    truss(b, {
      from: new THREE.Vector3(x0 + 0.3, floor + H - 1.9, tz),
      to: new THREE.Vector3(x1 - 0.3, floor + H - 1.9, tz),
      depth: 1.25, width: 1.0, chord: 0.07, bays: 12, zone: zi, mat: 'metal_rusted',
    });
  }
  // overhead crane: rails, bridge girder, trolley
  for (const s of [-1, 1]) {
    b.box('metal_painted', cx, floor + 6.5, cz + s * (D / 2 - 1.6), W - 1.0, 0.5, 0.34,
      { zone: zi, bevel: 0.02, seg: 4 });
    b.box('metal_rusted', cx, floor + 6.82, cz + s * (D / 2 - 1.6), W - 1.0, 0.14, 0.12,
      { zone: zi, bevel: 0.02 });
  }
  for (const s of [-1, 1]) {
    b.box('metal_painted', cx - 6.0, floor + 7.5, cz + s * 0.9, W - 1.6, 1.1, 0.34,
      { zone: zi, bevel: 0.03, seg: 4 });
  }
  b.box('metal_painted', cx - 6.0, floor + 8.15, cz, W - 1.6, 0.22, 2.1, { zone: zi, bevel: 0.03, seg: 3 });
  b.box('metal_rusted', cx - 2.0, floor + 7.1, cz, 1.9, 1.3, 2.0, { zone: zi, bevel: 0.04, seg: 3 });
  b.geo('metal_rusted', tube([[cx - 2.0, floor + 6.5, cz], [cx - 2.0, floor + 2.4, cz]], 0.04, 6,
    { segLen: 3 }), null, { zone: zi, tile: 1 });
  b.box('metal_rusted', cx - 2.0, floor + 2.1, cz, 0.5, 0.6, 0.36, { zone: zi, bevel: 0.03 });

  // sunken inspection pit with railings and a ladder
  const pit = { x: cx - 4.0, z: cz - 4.0, w: 8.0, d: 7.0, depth: 2.3 };
  for (const s of [-1, 1]) {
    b.box('concrete', pit.x + s * (pit.w / 2), floor - pit.depth / 2, pit.z, 0.4, pit.depth, pit.d + 0.8,
      { zone: zi, bevel: 0.03, seg: 4 });
    b.box('concrete', pit.x, floor - pit.depth / 2, pit.z + s * (pit.d / 2), pit.w, pit.depth, 0.4,
      { zone: zi, bevel: 0.03, seg: 4 });
  }
  b.box('concrete_wet', pit.x, floor - pit.depth - 0.15, pit.z, pit.w, 0.3, pit.d,
    { zone: zi, bevel: 0.04, seg: 6, cast: false });
  for (const [ax, az, bx, bz] of [
    [pit.x - pit.w / 2, pit.z - pit.d / 2, pit.x + pit.w / 2, pit.z - pit.d / 2],
    [pit.x - pit.w / 2, pit.z + pit.d / 2, pit.x + pit.w / 2, pit.z + pit.d / 2],
    [pit.x - pit.w / 2, pit.z - pit.d / 2, pit.x - pit.w / 2, pit.z + pit.d / 2],
  ]) {
    railingRun(b, {
      from: new THREE.Vector3(ax, floor, az), to: new THREE.Vector3(bx, floor, bz), zone: zi,
    });
  }
  ladder(b, { x: pit.x + pit.w / 2 - 0.6, y: floor - pit.depth, z: pit.z + pit.d / 2 - 0.5, h: 2.6, zone: zi });

  // mezzanine deck on the west side + access stair
  const mez = { x0: x0 + 0.4, x1: x0 + 11.0, z0: cz - 2.0, z1: z1 - 0.4, y: floor + 5.07 };
  slab(b, {
    x: (mez.x0 + mez.x1) / 2, y: mez.y, z: (mez.z0 + mez.z1) / 2,
    w: mez.x1 - mez.x0, d: mez.z1 - mez.z0, thick: 0.34, zone: zi, mat: 'concrete',
  });
  for (const px of [mez.x0 + 3.2, mez.x1 - 0.6]) {
    for (let i = 0; i < 4; i++) {
      const pz = mez.z0 + 1.5 + i * ((mez.z1 - mez.z0 - 3) / 3);
      b.box('metal_painted', px, floor + 2.54, pz, 0.26, 5.07, 0.26, { zone: zi, bevel: 0.02, seg: 3 });
    }
  }
  // TRAVERSAL: the east edge railing used to run the mezzanine's full length,
  // including straight across the head of its own access stair — so the flight
  // climbed 5.07 m into a handrail. It now stops 3.6 m short and a landing
  // bridges the 0.55 m of open air between the top tread and the deck edge.
  railingRun(b, {
    from: new THREE.Vector3(mez.x1, mez.y + 0.17, mez.z0),
    to: new THREE.Vector3(mez.x1, mez.y + 0.17, mez.z0 + 9.2), zone: zi,
  });
  railingRun(b, {
    from: new THREE.Vector3(mez.x1, mez.y + 0.17, mez.z0 + 12.4),
    to: new THREE.Vector3(mez.x1, mez.y + 0.17, mez.z1), zone: zi,
  });
  railingRun(b, {
    from: new THREE.Vector3(mez.x0, mez.y + 0.17, mez.z0), to: new THREE.Vector3(mez.x1, mez.y + 0.17, mez.z0), zone: zi,
  });
  // TRAVERSAL: the flight used to start at z = mez.z0 - 4.6 = -4.6, which is
  // INSIDE the inspection pit (x -30.75..-22.75, z -5.5..1.5) — it sprang off a
  // 2.3 m void and its approach was sealed by the pit's own guard rail at
  // z = -5.5. Measured: the player moved 0.14 m and stopped. Moved north of the
  // pit entirely (the pit's north guard rail is at z = +1.5), onto solid floor.
  const sx = mez.x1 + 1.3, sz0 = mez.z0 + 2.6;
  stair(b, {
    x: sx, y: floor, z: sz0, steps: 26, rise: 0.195, run: 0.29, width: 1.5,
    dir: new THREE.Vector3(0, 0, 1), zone: zi, mat: 'metal_rusted', stringerMat: 'metal_painted',
    railSides: [1],
  });
  // top of the flight is floor + 26 x 0.195 = 4.72; the mezzanine deck is
  // mez.y + 0.17 = 4.89, so the landing sits at the stair's level and the last
  // move onto the deck is a 0.17 m step.
  // The landing starts exactly where the flight ends (sz0 + 26 x 0.29 = 9.54).
  // A landing that reaches BACK over its own top treads buries them inside its
  // slab and turns the last move into a step the controller will not take.
  const sTop = sz0 + 26 * 0.29;
  landing(b, {
    x: mez.x1 + 1.05, y: mez.y - 0.10, z: sTop + 0.8,
    w: 2.1, d: 1.6, thick: 0.2, zone: zi, mat: 'metal_rusted', fascia: 0.26,
  });
  railingRun(b, {
    from: new THREE.Vector3(sx + 0.84, 4.72, sTop),
    to: new THREE.Vector3(sx + 0.84, 4.72, sTop + 1.6), zone: zi,
  });
  railingRun(b, {
    from: new THREE.Vector3(mez.x1, 4.72, sTop + 1.6),
    to: new THREE.Vector3(sx + 0.84, 4.72, sTop + 1.6), zone: zi,
  });

  // ceiling services: pipe runs, cable tray, ducting
  for (const [pz, rad, mat] of [[cz - 8, 0.26, 'metal_rusted'], [cz - 7.3, 0.16, 'metal_painted'],
    [cz + 8, 0.3, 'metal_rusted'], [cz + 8.8, 0.13, 'metal_painted']]) {
    pipeRun(b, {
      points: [[x0 + 1, floor + H - 0.9, pz], [cx, floor + H - 0.9, pz], [x1 - 1, floor + H - 0.9, pz]],
      radius: rad, zone: zi, mat, seg: 12, segLen: 3, flanges: false,
    });
    for (let i = 0; i < 6; i++) {
      const px = x0 + 3 + i * 5;
      b.geo('metal_painted', tube([[px, floor + H - 0.1, pz], [px, floor + H - 0.9 - rad, pz]], 0.025, 6,
        { segLen: 2 }), null, { zone: zi, tile: 1 });
    }
  }
  b.geo('metal_rusted', gratingPanel(0.55, W - 3, { pitch: 0.18, barH: 0.09 }),
    b.xform(cx, floor + H - 1.4, cz + 6.0, { ry: Math.PI / 2 }), { zone: zi, tile: 1 });

  // Machine plinths + vessels. Deliberately kept clear of the capture position
  // at (-8,-4) so nothing becomes an unreadable blob against the near clip.
  const r = rng(31337);
  for (let i = 0; i < 7; i++) {
    const px = x0 + 7.5 + (i % 3) * 7.5 + r() * 1.2;
    const pz = z0 + 5 + Math.floor(i / 3) * 11 + r() * 2;
    b.box('concrete', px, floor + 0.22, pz, 2.6 + r(), 0.44, 2.0 + r(), { zone: zi, bevel: 0.04, seg: 4 });
    const hh = 1.6 + r() * 1.4;
    b.geo('metal_painted', cyl(0.75, 0.8, hh, 18), b.xform(px, floor + 0.44 + hh / 2, pz, {}), { zone: zi, tile: 1.2 });
    b.geo('metal_rusted', cyl(0.86, 0.86, 0.12, 18), b.xform(px, floor + 0.5 + hh, pz, {}), { zone: zi, tile: 1 });
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2;
      b.box('metal_rusted', px + Math.cos(a) * 0.82, floor + 0.44 + hh * 0.5, pz + Math.sin(a) * 0.82,
        0.07, hh * 0.9, 0.07, { zone: zi, bevel: 0.014 });
    }
    b.geo('metal_rusted', tube([[px, floor + 0.56 + hh, pz], [px, floor + H - 1.2, pz]], 0.09, 8,
      { segLen: 2 }), null, { zone: zi, tile: 1 });
  }

  // Low pump skid + valve stand 4.5m down the interior sightline: gives the
  // frame a waist-height foreground subject without blocking the depth.
  const sk = { x: x0 + 25.6, z: z0 + 11.0 };
  b.box('concrete', sk.x, floor + 0.16, sk.z, 3.4, 0.32, 2.0, { zone: zi, bevel: 0.04, seg: 4 });
  b.box('metal_painted', sk.x, floor + 0.42, sk.z, 3.0, 0.2, 1.6, { zone: zi, bevel: 0.025, seg: 3 });
  for (const dz of [-0.45, 0.45]) {
    b.geo('metal_painted', cyl(0.28, 0.28, 1.5, 18),
      b.xform(sk.x, floor + 0.66, sk.z + dz, { rz: Math.PI / 2 }), { zone: zi, tile: 0.9 });
    b.geo('metal_rusted', cyl(0.34, 0.34, 0.09, 18),
      b.xform(sk.x + 0.72, floor + 0.66, sk.z + dz, { rz: Math.PI / 2 }), { zone: zi, tile: 0.7 });
    b.geo('metal_rusted', cyl(0.17, 0.17, 0.5, 12),
      b.xform(sk.x - 0.95, floor + 0.66, sk.z + dz, { rz: Math.PI / 2 }), { zone: zi, tile: 0.7 });
  }
  // discharge main stays below the eyeline so it dresses the floor plane instead
  // of bisecting the interior framing
  pipeRun(b, {
    points: [[sk.x + 0.9, floor + 0.66, sk.z - 0.45], [sk.x + 2.2, floor + 0.66, sk.z - 0.45],
      [sk.x + 2.2, floor + 1.05, sk.z - 0.45], [sk.x + 2.2, floor + 1.05, sk.z + 5.0]],
    radius: 0.14, zone: zi, seg: 12, segLen: 1.1,
  });
  for (const pz of [sk.z + 1.4, sk.z + 3.6]) {
    b.box('metal_painted', sk.x + 2.2, floor + 0.5, pz, 0.14, 1.0, 0.14, { zone: zi, bevel: 0.015 });
    b.box('metal_painted', sk.x + 2.2, floor + 0.04, pz, 0.44, 0.08, 0.44, { zone: zi, bevel: 0.02 });
  }
  for (const dz of [-0.45, 0.45]) {
    b.geo('metal_painted', new THREE.TorusGeometry(0.19, 0.03, 6, 16),
      b.xform(sk.x - 0.3, floor + 1.0, sk.z + dz, { rx: Math.PI / 2 }), { zone: zi, tile: 0.6 });
    b.box('metal_painted', sk.x - 0.3, floor + 0.83, sk.z + dz, 0.05, 0.34, 0.05,
      { zone: zi, bevel: 0.01 });
  }
  // floor drainage channel with grating, and a kerbed hazard bay
  b.box('concrete_wet', x0 + 17.0, floor - 0.2, cz, 0.9, 0.4, D - 6, { zone: zi, bevel: 0.03, seg: 5, cast: false });
  for (let i = 0; i < 8; i++) {
    b.geo('metal_rusted', gratingPanel(0.86, 3.6, { pitch: 0.09 }),
      b.xform(x0 + 17.0, floor - 0.03, cz - (D - 7) / 2 + i * ((D - 7) / 7), { ry: Math.PI / 2 }),
      { zone: zi, tile: 0.9 });
  }
  for (const dz of [-6.0, 6.0]) {
    b.box('concrete', x0 + 23.0, floor + 0.07, cz + dz, 9.0, 0.14, 0.2, { zone: zi, bevel: 0.03, cast: false });
  }

  // east elevation dressing, seen up close from the plant deck
  for (const pz of [z1 - 6.0, z0 + 6.0]) {
    b.geo('metal_rusted', tube([[x1 + 0.3, floor + 0.1, pz], [x1 + 0.3, floor + H - 0.4, pz]], 0.06, 8,
      { segLen: 3 }), null, { zone, tile: 1 });
  }
  b.box('metal_painted', x1 + 0.55, floor + 4.2, z1 - 10.5, 0.7, 8.6, 1.0, { zone, bevel: 0.04, seg: 5 });
  for (let i = 0; i < 6; i++) {
    b.box('metal_rusted', x1 + 0.55, floor + 0.6 + i * 1.5, z1 - 10.5, 0.86, 0.14, 1.16,
      { zone, bevel: 0.02 });
  }
  ladder(b, { x: x1 + 0.55, y: floor + 0.2, z: z1 - 13.4, h: 9.0, zone });
  pipeRun(b, {
    points: [[x1 + 0.45, floor + 2.5, z0 + 2], [x1 + 0.45, floor + 2.5, cz], [x1 + 0.45, floor + 2.5, z1 - 2]],
    radius: 0.2, zone, seg: 12, segLen: 3, flanges: false,
  });
  for (let i = 0; i < 7; i++) {
    b.box('metal_painted', x1 + 0.28, floor + 2.5, z0 + 3 + i * 5.5, 0.36, 0.09, 0.09,
      { zone, bevel: 0.014 });
  }

  // interior lighting rig — high bays in two rows
  for (let i = 0; i < 4; i++) {
    for (const s of [-1, 1]) {
      const px = cx + s * 7.5, pz = z0 + 6 + i * 9;
      b.geo('metal_painted', cyl(0.42, 0.26, 0.32, 14), b.xform(px, floor + H - 1.65, pz, { rx: Math.PI }),
        { zone: zi, tile: 0.8 });
      b.geo('metal_painted', tube([[px, floor + H - 1.5, pz], [px, floor + H - 1.05, pz]], 0.028, 6,
        { segLen: 1 }), null, { zone: zi, tile: 1 });
      w.lightAnchors.push({
        position: new THREE.Vector3(px, floor + H - 1.95, pz), colour: 0xfff1d4,
        intensity: 44, distance: 30, kind: 'highbay', priority: 10,
      });
    }
  }

  // Process plant: crane, purlins, ducts, turbine deck, vessels, control cabin.
  // Kept in its own module because it is the half of the hall the lighting
  // agent's shafts have to fall across, and it doubles the file otherwise.
  buildHallPlant(b, w, HALL);

  w.enemySpawns.push(
    new THREE.Vector3(cx - 6, floor + 1.78, cz + 12),
    new THREE.Vector3(mez.x1 - 2, mez.y + 1.78, mez.z1 - 3),
    new THREE.Vector3(x0 + 5, floor + 1.78, z0 + 4),
  );
  w.spawnPoints.push(new THREE.Vector3(x1 - 4, floor + 1.78, cz + 8));
}

/* ------------------------------------------------------------ admin block --- */

export function buildAdminBlock(b, w) {
  const zone = 'admin';
  const zi = 'admin_int';
  const ap = w.apertures;
  const x0 = 30, x1 = 48, z0 = -8, z1 = 30;
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, W = x1 - x0, D = z1 - z0;
  const lv = [L.yard, L.yard + 3.7, L.yard + 7.4];
  const roof = L.yard + 11.1;

  // floor slabs (ground slab is paving, upper slabs have a stair void)
  for (let i = 1; i < 3; i++) {
    slab(b, {
      x: cx, y: lv[i], z: cz, w: W - 0.6, d: D - 0.6, thick: 0.34, zone: zi, mat: 'concrete',
      holes: [{ x: -5.5, z: 11.0, w: 4.2, d: 6.4 }],
    });
  }
  slab(b, {
    x: cx, y: roof, z: cz, w: W + 0.5, d: D + 0.5, thick: 0.4, zone, mat: 'concrete',
    holes: [{ x: -5.5, z: 11.0, w: 3.0, d: 3.0 }],
  });

  // ---- elevations
  const bays = (yBase, n, u0, step, wid, hgt) => {
    const out = [];
    for (let i = 0; i < n; i++) out.push({ u: u0 + i * step, y: yBase, w: wid, h: hgt });
    return out;
  };
  // West elevation faces the yard: shutter at ground, window bays above.
  //
  // The strip u 29..38 — which is z -8..1, i.e. the south end — used to carry no
  // opening at any level, and it is precisely what the `silhouette-dusk` camera
  // at (20, 1.7, 0) is pointed at from ten metres away: a 9 x 11 m rectangle of
  // nothing, about 40% of that frame. Ground-floor bays and a third stack of
  // windows at the south end give the frame something to read; `dressElevation`
  // below handles what a wall carries between its openings.
  const westGlazed = [
    { u: 2.4, y: lv[0] + 1.35, w: 3.4, h: 1.7 },
    { u: 7.6, y: lv[0] + 1.35, w: 3.4, h: 1.7 },
    { u: 15.2, y: lv[0] + 1.35, w: 3.4, h: 1.7 },
    // The south stack sits at 35.0 rather than hard against the corner: that
    // leaves a 2 m clear column at u 32.6-34.6 for a service riser and keeps
    // u 37.5 free for the corner downpipe, and those two verticals are what
    // actually break the strip the silhouette camera is pointed at.
    { u: 35.0, y: lv[0] + 1.35, w: 2.6, h: 1.7 },
    ...bays(lv[1] + 1.0, 5, 3.0, 6.4, 3.6, 1.9),
    { u: 35.0, y: lv[1] + 1.0, w: 2.6, h: 1.9 },
    ...bays(lv[2] + 1.0, 5, 3.0, 6.4, 3.6, 1.9),
    { u: 35.0, y: lv[2] + 1.0, w: 2.6, h: 1.9 },
  ];
  const westOpen = [
    { u: 22.0, y: L.yard + 0.15, w: 7.0, h: 5.0 },
    ...westGlazed,
    { u: 12.0, y: L.yard + 0.15, w: 1.4, h: 2.2 },
  ];
  wall(b, {
    cx: x0, cz, len: D, height: roof - L.yard, thick: 0.4, axis: 'z', y0: L.yard, zone,
    mat: 'concrete', openings: westOpen, pilasterEvery: 6.4, apertures: ap,
  });
  const eastOpen = [
    ...bays(lv[0] + 1.2, 4, 4.0, 8.0, 3.2, 1.8),
    ...bays(lv[1] + 1.0, 4, 4.0, 8.0, 3.2, 1.9),
    ...bays(lv[2] + 1.0, 4, 4.0, 8.0, 3.2, 1.9),
  ];
  wall(b, {
    cx: x1, cz, len: D, height: roof - L.yard, thick: 0.4, axis: 'z', y0: L.yard, zone,
    mat: 'concrete', openings: eastOpen, pilasterEvery: 6.4, apertures: ap,
  });
  for (const [pz, sgn] of [[z0, -1], [z1, 1]]) {
    const open = [
      ...bays(lv[1] + 1.0, 2, 3.5, 8.0, 3.4, 1.9),
      ...bays(lv[2] + 1.0, 2, 3.5, 8.0, 3.4, 1.9),
      { u: 8.0, y: L.yard + 0.15, w: 1.4, h: 2.2 },
    ];
    wall(b, {
      cx, cz: pz, len: W, height: roof - L.yard, thick: 0.4, axis: 'x', y0: L.yard, zone,
      mat: 'concrete', openings: open, pilasterEvery: 6.0, apertures: ap,
    });
    void sgn;
  }
  // glazing
  const zOf = (u) => z1 - u;
  for (const o of westGlazed) {
    windowUnit(b, {
      x: x0, y: o.y + o.h / 2, z: zOf(o.u + o.w / 2), w: o.w, h: o.h, axis: 'z',
      zone, cols: 3, rows: 2, apertures: ap,
    });
  }
  for (const o of eastOpen) {
    windowUnit(b, {
      x: x1, y: o.y + o.h / 2, z: zOf(o.u + o.w / 2), w: o.w, h: o.h, axis: 'z',
      zone, cols: 3, rows: 2,
    });
  }
  shutter(b, { x: x0, y: L.yard + 0.15, z: zOf(25.5), w: 7.0, h: 5.0, axis: 'z', zone, closed: 0.18 });
  doorUnit(b, { x: x0, y: L.yard + 0.15, z: zOf(12.7), w: 1.4, h: 2.2, axis: 'z', zone, leaf: true, open: true });

  // ---- elevation dressing. The west face carries the silhouette frame, so it
  // gets the full density and the building's identification; the returns and the
  // rear elevation get enough to stop them reading as blank once the eye is
  // already looking for it.
  const H = roof - L.yard;
  dressElevation(b, {
    axis: 'z', cx: x0, cz, len: D, y0: L.yard, height: H, thick: 0.4, face: -1,
    zone, seed: 5501, openings: westOpen, density: 1.25,
    courses: [lv[1] - 0.35, lv[2] - 0.35],
    labels: [
      { u: 30.4, y: lv[0] + 4.4, text: 'B-04', size: 0.72 },
      { u: 37.0, y: lv[0] + 2.6, text: 'ADMIN', size: 0.36 },
      { u: 19.6, y: lv[0] + 5.6, text: 'NO ENTRY', size: 0.34 },
    ],
  });
  dressElevation(b, {
    axis: 'z', cx: x1, cz, len: D, y0: L.yard, height: H, thick: 0.4, face: 1,
    zone, seed: 5507, openings: eastOpen, density: 0.7,
  });
  for (const [pz, fc] of [[z0, -1], [z1, 1]]) {
    dressElevation(b, {
      axis: 'x', cx, cz: pz, len: W, y0: L.yard, height: H, thick: 0.4, face: fc,
      zone, seed: 5511 + (fc > 0 ? 40 : 0), density: 0.8, joints: false,
      openings: [
        ...bays(lv[1] + 1.0, 2, 3.5, 8.0, 3.4, 1.9),
        ...bays(lv[2] + 1.0, 2, 3.5, 8.0, 3.4, 1.9),
        { u: 8.0, y: L.yard + 0.15, w: 1.4, h: 2.2 },
      ],
      labels: fc > 0 ? [{ u: 12.4, y: lv[2] + 0.4, text: 'BLOCK 4', size: 0.5 }] : null,
    });
  }

  // ---- projecting stair tower breaks the facade silhouette
  const tz = 18.0;
  for (const s of [-1, 1]) {
    b.box('concrete', x0 - 1.6, (roof + L.yard) / 2, tz + s * 2.6, 3.6, roof - L.yard, 0.36,
      { zone, bevel: 0.035, seg: 5 });
  }
  wall(b, {
    cx: x0 - 3.3, cz: tz, len: 5.2, height: roof - L.yard, thick: 0.36, axis: 'z', y0: L.yard, zone,
    mat: 'concrete', openings: [
      { u: 1.4, y: L.yard + 1.4, w: 0.9, h: 6.4 },
      { u: 3.0, y: L.yard + 1.4, w: 0.9, h: 6.4 },
    ], pilasterEvery: 0, apertures: ap,
  });
  slab(b, { x: x0 - 1.6, y: roof, z: tz, w: 4.2, d: 5.8, thick: 0.34, zone, mat: 'concrete' });
  // TRAVERSAL: the ground flight used to start at lv[0] = -0.35, but the tower
  // projects out over the east apron paving, which is laid at y = 0.00 — so its
  // bottom two treads were buried in the ground and the player stalled 0.13 m up
  // with nothing to step onto. The ground flight now springs off the paving and
  // the flight above it makes up the 1.50 m difference to lv[1] in ten risers.
  for (let f = 0; f < 3; f++) {
    const base = f === 0 ? 0.0 : lv[f];
    stair(b, {
      x: x0 - 2.6, y: base, z: tz - 2.0, steps: 10, rise: 0.185, run: 0.29, width: 1.2,
      dir: new THREE.Vector3(0, 0, 1), zone: zi, mat: 'concrete', railSides: [-1],
    });
    if (f < 2) {
      stair(b, {
        x: x0 - 0.6, y: base + 1.85, z: tz + 2.0, steps: 10,
        rise: (lv[f + 1] - base - 1.85) / 10, run: 0.29, width: 1.2,
        dir: new THREE.Vector3(0, 0, -1), zone: zi, mat: 'concrete', railSides: [1],
      });
    }
  }

  // ---- roof: parapet, plant, ducts and a beacon
  for (const [px, pz, pw, pd] of [[cx, z0 - 0.2, W + 0.9, 0.36], [cx, z1 + 0.2, W + 0.9, 0.36],
    [x0 - 0.2, cz, 0.36, D + 0.9], [x1 + 0.2, cz, 0.36, D + 0.9]]) {
    b.box('concrete', px, roof + 0.78, pz, pw, 1.16, pd, { zone, bevel: 0.035, seg: 3 });
    coping(b, {
      x: px, y: roof + 1.36, z: pz, w: 0.52, len: pw > pd ? pw : pd,
      ry: pw > pd ? 0 : Math.PI / 2, zone,
    });
  }
  for (let i = 0; i < 3; i++) {
    const px = cx + 2 + (i % 2) * 5, pz = cz - 8 + i * 8;
    b.box('metal_painted', px, roof + 1.3, pz, 3.4, 2.2, 2.6, { zone, bevel: 0.05, seg: 4 });
    b.geo('metal_rusted', cyl(0.9, 0.9, 0.7, 16), b.xform(px, roof + 2.7, pz, {}), { zone, tile: 1 });
    for (let j = 0; j < 6; j++) {
      b.box('metal_rusted', px - 1.72, roof + 0.7 + j * 0.28, pz, 0.08, 0.2, 2.3,
        { zone, bevel: 0.015, rx: 0.4 });
    }
  }
  pipeRun(b, {
    points: [[x0 + 2, roof + 0.9, cz - 12], [x0 + 2, roof + 0.9, cz + 12], [x1 - 3, roof + 0.9, cz + 14]],
    radius: 0.22, zone, seg: 12, segLen: 3,
  });
  ladder(b, { x: x0 + 1.2, y: roof + 0.4, z: z0 + 3.0, h: 3.4, zone });
  w.lightAnchors.push({ position: new THREE.Vector3(cx, roof + 3.4, cz - 8), colour: 0xff4433, intensity: 2.5, distance: 30, kind: 'beacon', priority: 1 });

  // ---- interior: partitions, ceiling and lighting so the shutter reads as a room
  for (let f = 0; f < 3; f++) {
    const y = lv[f];
    for (const pz of [cz - 7.0, cz + 7.0]) {
      wall(b, {
        cx: cx + 1.0, cz: pz, len: W - 4.0, height: 3.4, thick: 0.2, axis: 'x', y0: y, zone: zi,
        mat: 'plaster', openings: [{ u: 3.0, y: y + 0.1, w: 1.5, h: 2.1 }, { u: 9.0, y: y + 0.1, w: 1.5, h: 2.1 }],
        plinth: false, course: false, pilasterEvery: 0,
      });
    }
    b.box('plaster', cx + 4.0, y + 3.5, cz, W - 8.0, 0.14, D - 6.0,
      { zone: zi, bevel: 0.02, seg: 5, cast: false });
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        const px = cx - 4 + i * 5, pz = cz - 10 + j * 10;
        b.box('metal_painted', px, y + 3.36, pz, 1.3, 0.1, 0.34, { zone: zi, bevel: 0.02, cast: false });
        if (f > 0 || i !== 1) continue;
        w.lightAnchors.push({
          position: new THREE.Vector3(px, y + 3.16, pz), colour: 0xd8e6ff,
          intensity: 15, distance: 14, kind: 'strip', priority: 4,
        });
      }
    }
  }
  // the bridge that links the block to the courtyard catwalk ring
  catwalk(b, {
    from: new THREE.Vector3(x0, L.deck, 10.0), to: new THREE.Vector3(21.0, L.deck, 10.0),
    width: 1.6, zone: 'catwalk',
  });
  for (const x of [26.5]) {
    b.box('metal_painted', x, (L.deck + L.yard) / 2 - 0.2, 10.0, 0.26, L.deck - L.yard - 0.4, 0.26,
      { zone: 'catwalk', bevel: 0.02, seg: 3 });
  }
  catwalk(b, {
    from: new THREE.Vector3(21.0, L.deck, 10.0), to: new THREE.Vector3(21.0, L.deck, 15.9),
    width: 1.6, zone: 'catwalk', rail: false,
  });

  w.enemySpawns.push(
    new THREE.Vector3(cx, lv[0] + 1.78, cz - 10),
    new THREE.Vector3(cx, lv[1] + 1.78, cz + 10),
    new THREE.Vector3(x0 + 3, lv[2] + 1.78, cz),
  );
  w.spawnPoints.push(new THREE.Vector3(cx, lv[0] + 1.78, cz + 12));
}

export { HALL };
