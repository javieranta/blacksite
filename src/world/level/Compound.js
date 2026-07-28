import * as THREE from 'three';
import { chamferBox, corrugated, cyl, lathe, tube, jitter, rng } from './GeoKit.js';
import {
  wall, windowUnit, doorUnit, slab, pillar, ibeam,
  stair, railingRun, catwalk, pipeRun, truss, jersey, kerb, ramp, coping,
  ladder, stack, tank, haunch, basePlate, dripEdge,
} from './Modules.js';
import { L, pave } from './Site.js';
import { buildSubstation, buildPlantDeck } from './ServiceYard.js';

/**
 * OWNER: level agent.
 * The exterior of the blacksite: paved ground, perimeter, the contested
 * courtyard, the entry canopy that frames the hero shot, and the north
 * industrial yard that carries the skyline silhouette.
 *
 * The site datum lives in Site.js; the substation and plant deck in
 * ServiceYard.js. Anything that occupies the ground *plane* — markings, joints,
 * standing water, the rail siding — lives in Groundworks.js, and the near-camera
 * framing layer in Foreground.js. Several element positions in this file are
 * coordinated with those two (the siding runs along z = 20.4 and the slot drain
 * along z = 17.24), so check them before moving anything in that band.
 */

export { L, pave };

/* ------------------------------------------------------------------ ground -- */

export function buildGround(b, w) {
  // courtyard + north yard, one level
  pave(b, L.court.x0, L.court.x1, L.court.z0, 42, { y: 0, seed: 12, zone: 'ground' });
  pave(b, -14, 40, 42, 58, { y: 0, seed: 55, zone: 'ground', cell: 11 });
  // service yard, one step down
  pave(b, -7.5, 30, -24, 8, { y: L.yard, seed: 88, zone: 'ground', mat: 'asphalt', cell: 11 });
  pave(b, 30, 50, -24, -8, { y: L.yard, seed: 3, zone: 'ground', cell: 11 });
  // west and east perimeter strips
  pave(b, -40, -38, -24, 58, { y: 0, seed: 21, zone: 'ground', cell: 12 });
  pave(b, 40, 50, 30, 58, { y: 0, seed: 71, zone: 'ground', cell: 12 });

  // Aprons closing the last unsurfaced pockets inside the wall. With formation
  // level dropped to -0.40 these are no longer level with the terrain, so an
  // unpaved pocket now reads as a 400mm hole in the middle of the compound
  // rather than as a continuous ground plane. The east apron in particular is
  // dead centre-right of both hero framings.
  pave(b, 26, 40, 8, 42, { y: 0, seed: 34, zone: 'ground', cell: 12, seg: 4 });
  pave(b, -7.5, -3, 8, 42, { y: 0, seed: 66, zone: 'ground', cell: 12, seg: 4 });
  // compacted gravel hardstanding over the two back-of-house pockets: cheaper
  // than concrete to read, and the material change is itself incident
  for (const [gx0, gx1, gz0, gz1, gs] of [[-38, -7.5, 22, 42, 5], [-40, -7.5, -25, -18, 9]]) {
    pave(b, gx0, gx1, gz0, gz1, {
      y: -0.30, seed: gs, zone: 'ground', cell: 14, seg: 3, thick: 0.24,
      mat: 'sand', jitter: 0.055, jitterFreq: 1.1,
    });
  }

  // retaining wall between the two levels, with coping, steps and a ramp
  const y = L.yard, rise = -L.yard;
  for (const [x0, x1] of [[-3, 3.2], [10.5, 26]]) {
    b.box('concrete', (x0 + x1) / 2, y + rise / 2, 8, x1 - x0, rise + 0.02, 0.5,
      { zone: 'court', bevel: 0.03, seg: 3 });
    coping(b, { x: (x0 + x1) / 2, y: 0.0, z: 8, w: 0.62, len: x1 - x0, zone: 'court' });
    // throated drip under the coping on the exposed yard face. This is the one
    // wall in the compound whose underside you actually see from the low
    // framings, so it is the one that needs the shadow line.
    dripEdge(b, { x: (x0 + x1) / 2, y: -0.04, z: 7.72, len: x1 - x0, axis: 'x', zone: 'court' });
  }
  // three broad steps up into the courtyard
  for (let i = 0; i < 3; i++) {
    b.box('concrete', 6.85, y + (i + 0.5) * (rise / 3), 8 - 0.62 + i * 0.31,
      7.3 - i * 0.4, rise / 3 + 0.02, 0.62, { zone: 'court', bevel: 0.022, seg: 2 });
  }
  kerb(b, { x: 3.2, y: 0, z: 7.75, len: 0.9, ry: Math.PI / 2, zone: 'court' });
  kerb(b, { x: 10.5, y: 0, z: 7.75, len: 0.9, ry: Math.PI / 2, zone: 'court' });

  // drainage channel — a leading line straight at the landmark stack
  const cx0 = 12.4, cx1 = 14.0;
  for (const s of [0, 1]) {
    const x = s ? cx1 : cx0;
    b.box('concrete_wet', x + (s ? 0.12 : -0.12), -0.5, 25, 0.26, 1.0, 34,
      { zone: 'court', bevel: 0.02, seg: 3 });
  }
  b.box('concrete_wet', 13.2, -1.02, 25, 1.9, 0.3, 34, { zone: 'court', bevel: 0.02, seg: 4, cast: false });
  // cover slabs. z=20.4 is where the rail siding crosses, so one lands there.
  for (const z of [12, 20.4, 28, 36]) {
    b.box('metal_rusted', 13.2, -0.03, z, 1.75, 0.1, 1.5, { zone: 'court', bevel: 0.02, seg: 2 });
  }
  for (const s of [-1, 1]) {
    kerb(b, { x: 13.2 + s * 1.0, y: 0, z: 25, len: 34, ry: 0, zone: 'court' });
  }

  // hazard-banded kerb line along the courtyard's east edge
  kerb(b, { x: 25.6, y: 0, z: 25, len: 34, ry: 0, zone: 'court' });
  kerb(b, { x: -2.6, y: 0, z: 25, len: 34, ry: 0, zone: 'court' });
}

/* ------------------------------------------------------------- entry canopy - */

/**
 * The foreground layer of the hero shot. A vehicle inspection canopy that hangs
 * over the frame's upper-left, with two columns breaking the left edge — so the
 * courtyard reads through a dark architectural frame instead of floating in
 * dead space.
 */
export function buildCanopy(b, w) {
  const zone = 'canopy';
  const cols = [[5.2, 19.0], [5.2, 26.8], [-2.6, 19.0], [-2.6, 26.8]];
  for (const [x, z] of cols) {
    pillar(b, { x, y: 0, z, w: 0.68, h: 4.72, zone, mat: 'concrete', seg: 4, corbel: true });
    // A cast plinth at the foot and a haunch each way at the head. These two
    // columns fill the near right of the hero frame, so this is where the
    // difference between "a prism" and "a column" is actually legible: the
    // plinth gives the base a shadow line and the haunches tie the head into
    // the portal beams instead of letting them just intersect.
    b.box('concrete', x, 0.28, z, 1.14, 0.56, 1.14,
      { zone, bevel: 0.055, seg: 3, jitter: 0.01, tile: 1.4 });
    b.box('concrete', x, 0.62, z, 0.86, 0.16, 0.86, { zone, bevel: 0.05, seg: 2, tile: 1.2 });
    for (const [ry, dx, dz] of [[0, 0.32, 0], [Math.PI, -0.32, 0],
      [Math.PI / 2, 0, -0.32], [-Math.PI / 2, 0, 0.32]]) {
      haunch(b, {
        x: x + dx, y: 4.68, z: z + dz, reach: 0.56, rise: 0.6, width: 0.3,
        ry, flip: true, zone,
      });
    }
    // downpipe strapped to each column, on a shoe at the foot
    b.geo('metal_rusted', tube([[x + 0.42, 0.7, z + 0.42], [x + 0.42, 4.5, z + 0.42]], 0.055, 8,
      { segLen: 3 }), null, { zone, tile: 1 });
    b.geo('metal_rusted', tube([[x + 0.42, 0.78, z + 0.42], [x + 0.62, 0.34, z + 0.62]], 0.06, 8,
      { segLen: 1 }), null, { zone, tile: 0.8 });
    // knee braces off the corbels
    for (const s of [-1, 1]) {
      b.geo('metal_rusted', tube([[x, 3.7, z], [x + s * 1.0, 4.78, z]], 0.055, 8, { segLen: 2 }),
        null, { zone, tile: 1 });
    }
  }
  // The canopy is DERELICT: the frame survives, most of the sheeting does not.
  // That keeps a strong lattice silhouette in the hero foreground while letting
  // low sun through onto the courtyard instead of dropping a black slab on it.
  for (const z of [19.0, 26.8]) {
    ibeam(b, { x: 1.3, y: 4.95, z, len: 9.4, h: 0.44, fw: 0.24, ry: Math.PI / 2, zone });
  }
  for (const x of [-2.6, 5.2]) {
    ibeam(b, { x, y: 4.95, z: 22.9, len: 10.2, h: 0.4, fw: 0.22, ry: 0, zone });
  }
  for (let i = 0; i < 9; i++) {
    const z = 18.5 + i * 1.12;
    b.box('metal_rusted', 1.3, 5.28, z, 9.6, 0.14, 0.09, { zone, bevel: 0.02, seg: 2 });
  }
  for (let i = 0; i < 4; i++) {
    b.geo('metal_rusted', tube([[-2.6, 4.78, 19.0 + i * 2.6], [5.2, 5.2, 20.6 + i * 2.6]], 0.03, 6,
      { segLen: 4 }), null, { zone, tile: 1 });
  }
  // the two bays of sheeting that are left, at the far end
  for (let i = 0; i < 2; i++) {
    const g = corrugated(9.6, 2.2, { backFace: true, pitch: 0.09 });
    b.geo('metal_rusted', g, b.xform(1.3, 5.38, 24.2 + i * 2.24, { rx: -Math.PI / 2 }),
      { zone, tile: 1.5, recv: false });
  }
  // one torn sheet hanging off the frame — silhouette interest, no dead mass
  b.geo('metal_rusted', corrugated(2.0, 2.4, { backFace: true, pitch: 0.09 }),
    b.xform(-1.4, 3.95, 22.2, { rx: -0.42, ry: 0.22, rz: 0.28 }), { zone, tile: 1.5 });
  // hanging lamp bar under the canopy
  for (const z of [20.2]) {
    b.box('metal_painted', 1.3, 4.4, z, 8.6, 0.14, 0.22, { zone, bevel: 0.02 });
    for (const x of [-1.4, 1.3, 4.0]) {
      b.box('metal_painted', x, 4.24, z, 0.5, 0.2, 0.34, { zone, bevel: 0.03 });
      w.lightAnchors.push({
        position: new THREE.Vector3(x, 4.06, z), colour: 0xffe6bd,
        intensity: 22, distance: 20, kind: 'lamp', priority: 6,
      });
    }
  }
  // signage gantry across the entry, gives the skyline a horizontal break
  b.box('metal_rusted', 11.5, 3.2, 12.0, 0.24, 6.4, 0.24, { zone, bevel: 0.02, seg: 3 });
  b.box('metal_rusted', 24.5, 3.2, 12.0, 0.24, 6.4, 0.24, { zone, bevel: 0.02, seg: 3 });
  truss(b, {
    from: new THREE.Vector3(11.5, 6.0, 12.0), to: new THREE.Vector3(24.5, 6.0, 12.0),
    depth: 0.9, width: 0.8, chord: 0.05, bays: 9, zone,
  });
  b.box('metal_painted', 18.0, 6.9, 12.0, 6.4, 1.1, 0.12, { zone, bevel: 0.02, seg: 3 });
}

/* ---------------------------------------------------------------- courtyard - */

export function buildCourtyard(b, w) {
  const zone = 'court';
  const r = rng(60613);

  // hard cover: barrier lines placed to create lanes, not scattered. The two in
  // the 15-25m band are clear of the rail siding at z = 20.4 (see Groundworks).
  const lines = [
    { x: 2.0, z: 24.7, ry: 0, n: 2 }, { x: 7.6, z: 30.0, ry: Math.PI / 2, n: 3 },
    { x: 18.5, z: 18.0, ry: Math.PI / 2, n: 4 }, { x: 22.0, z: 33.5, ry: 0, n: 2 },
    { x: -0.5, z: 36.0, ry: Math.PI / 2, n: 3 },
  ];
  for (const ln of lines) {
    for (let i = 0; i < ln.n; i++) {
      const off = (i - (ln.n - 1) / 2) * 3.06;
      jersey(b, {
        x: ln.ry ? ln.x + off : ln.x, y: 0,
        z: ln.ry ? ln.z : ln.z + off, ry: ln.ry, len: 3.0, zone,
      });
    }
  }

  // Midground cover. These sit at 10-16m, not 5m: at 5m a 3.2m revetment fills
  // a third of the hero frame with one flat unbroken face and kills every layer
  // behind it. Staggered and skewed off the view axis they read as a defended
  // line instead of a wall, and they leave the 2-8m band to the groundworks.
  const revet = [[8.8, 23.9, 0.36], [10.2, 27.8, -0.22], [19.6, 24.6, -0.3]];
  for (const [x, z, ry] of revet) {
    b.box('concrete', x, 0.62, z, 3.2, 1.24, 1.05, { zone, bevel: 0.05, seg: 5, jitter: 0.018, ry });
    coping(b, { x, y: 1.22, z, w: 1.22, len: 3.2, ry, zone });
    // sandbags stepped along the revetment's own axis, not along world X
    const ux = Math.cos(ry), uz = -Math.sin(ry);
    for (let i = 0; i < 3; i++) {
      const t = (i - 1) * 1.0;
      const sack = new THREE.SphereGeometry(0.54, 12, 7);
      jitter(sack, 0.075, 2.4);
      b.geo('fabric', sack,
        b.xform(x + ux * t, 1.45 - Math.abs(i - 1) * 0.04, z + uz * t,
          { sx: 1.02, sy: 0.42, sz: 0.9, ry: ry + (i - 1) * 0.11 }),
        { zone, tile: 0.7 });
    }
  }
  // A toppled barrier and a spilled steel drum give the near ground a story.
  // The barrier lies on its side — rz brings the profile over, so it reads as a
  // unit that has been pushed off its footing rather than a slab standing on end.
  jersey(b, { x: 5.0, y: 0.47, z: 22.55, len: 2.8, ry: 0.62, rz: Math.PI / 2, rx: -0.04, zone });
  b.geo('metal_rusted', cyl(0.31, 0.31, 0.9, 18),
    b.xform(10.15, 0.31, 18.55, { rz: Math.PI / 2, ry: 0.7 }), { zone, tile: 0.9 });
  for (const t of [-0.34, 0.34]) {
    b.geo('metal_rusted', new THREE.TorusGeometry(0.315, 0.03, 6, 18),
      b.xform(10.15 + Math.cos(0.7) * t, 0.31, 18.55 - Math.sin(0.7) * t, { ry: 0.7 }), { zone, tile: 0.8 });
  }
  b.geo('metal_rusted', cyl(0.3, 0.3, 0.88, 18), b.xform(3.1, 0.44, 17.2, {}), { zone, tile: 0.9 });

  // near-ground architecture in the spawn band so the bottom of the hero frame
  // carries readable, correctly scaled detail rather than bare paving
  for (let i = 0; i < 6; i++) {
    b.box('metal_rusted', 1.2 + i * 0.94, 0.04, 15.4 + i * 0.22, 0.9, 0.08, 0.66,
      { zone, bevel: 0.016, seg: 2, ry: 0.23 });
  }
  for (const [px, pz] of [[8.2, 13.4], [10.9, 12.6], [2.0, 24.0], [9.4, 27.5]]) {
    b.box('concrete', px, 0.09, pz, 1.7, 0.18, 0.24, { zone, bevel: 0.035, seg: 2 });
    for (const s of [-1, 1]) {
      b.geo('metal_rusted', cyl(0.03, 0.03, 0.1, 8), b.xform(px + s * 0.6, 0.2, pz, {}),
        { zone, tile: 0.4, cast: false });
    }
  }
  b.box('concrete_wet', 4.9, -0.06, 16.2, 0.72, 0.2, 0.72, { zone, bevel: 0.03, seg: 3, cast: false });
  b.box('metal_rusted', 4.9, 0.02, 16.2, 0.56, 0.07, 0.56, { zone, bevel: 0.014, seg: 2 });
  // Kerb line, broken by the rail siding's level crossing at z = 20.4 — a run of
  // kerb that a track walks straight through is one of the tells that a level
  // was assembled rather than laid out.
  for (const [cz, len] of [[16.4, 5.6], [24.3, 4.6]]) {
    kerb(b, { x: 11.0, y: 0, z: cz, len, ry: 0, zone });
  }
  for (const z of [16.2, 23.2, 26.4]) {
    b.geo('metal_painted', cyl(0.085, 0.1, 0.92, 12), b.xform(11.0, 0.46, z, {}), { zone, tile: 0.6 });
    b.geo('metal_rusted', cyl(0.11, 0.11, 0.07, 12), b.xform(11.0, 0.95, z, {}), { zone, tile: 0.6 });
  }

  // heavy concrete blocks — chest-high cover with real chamfers and wear
  const blocks = [[16.0, 24.0, 1.8, 1.35, 1.8],
    [4.0, 28.5, 2.8, 1.2, 1.4], [21.0, 27.5, 1.6, 1.9, 1.6], [11.5, 35.5, 3.2, 1.1, 1.5]];
  for (const [x, z, bw, bh, bd] of blocks) {
    b.box('concrete', x, bh / 2, z, bw, bh, bd,
      { zone, bevel: 0.05, seg: 4, jitter: 0.02, ry: (r() - 0.5) * 0.06 });
    b.box('concrete_wet', x, bh + 0.05, z, bw + 0.16, 0.1, bd + 0.16, { zone, bevel: 0.03, seg: 2 });
  }

  // raised planter / blast bund with a kerbed edge
  b.box('concrete', -0.2, 0.35, 32.0, 5.2, 0.7, 7.2, { zone, bevel: 0.05, seg: 5 });
  b.box('dirt', -0.2, 0.74, 32.0, 4.5, 0.16, 6.5, { zone, bevel: 0.04, seg: 5, jitter: 0.05, cast: false });
  coping(b, { x: -0.2, y: 0.7, z: 28.4, w: 0.5, len: 5.2, zone });
  coping(b, { x: -0.2, y: 0.7, z: 35.6, w: 0.5, len: 5.2, zone });

  // loading dock along the east side, 1.2m, with edge protection and steps
  b.box('concrete', 24.0, 0.6, 26.0, 4.0, 1.2, 16.0, { zone, bevel: 0.05, seg: 6 });
  b.box('metal_rusted', 22.05, 1.14, 26.0, 0.12, 0.24, 16.0, { zone, bevel: 0.03 });
  for (let i = 0; i < 4; i++) {
    b.box('concrete', 21.4, 0.15 + i * 0.3, 19.0, 1.6, 0.3, 0.62 - i * 0.02, { zone, bevel: 0.02, seg: 2 });
  }
  for (const z of [23.0, 26.2, 29.4, 32.6]) {
    b.box('fabric', 22.1, 0.8, z, 0.22, 0.9, 0.5, { zone, bevel: 0.06, seg: 3 });
  }
  // haunched edge beam under the dock nose — a 1.2m deck cantilevering off
  // nothing is the sort of thing that reads as a floating box
  for (const dz of [20.0, 24.0, 28.0, 32.0]) {
    haunch(b, { x: 22.06, y: 0.1, z: dz, reach: 0.58, rise: 0.5, width: 0.4, ry: Math.PI, zone });
  }
  dripEdge(b, { x: 21.96, y: 0.9, z: 26.0, len: 16.0, axis: 'z', zone });

  // bollards guarding the channel crossings (never at z = 20.4 — the siding)
  for (const z of [11.5, 17.0, 27.0, 34.0]) {
    for (const s of [-1, 1]) {
      b.geo('metal_painted', cyl(0.09, 0.11, 1.0, 12), b.xform(13.2 + s * 1.55, 0.5, z, {}),
        { zone, tile: 0.8 });
      b.geo('metal_rusted', cyl(0.12, 0.12, 0.08, 12), b.xform(13.2 + s * 1.55, 1.02, z, {}),
        { zone, tile: 0.8 });
    }
  }

  // stair tower up to the catwalk ring — the elevated position
  const zone2 = 'stairs';
  b.box('concrete', 22.6, 2.35, 14.5, 3.4, 4.7, 0.36, { zone: zone2, bevel: 0.035, seg: 4 });
  b.box('concrete', 24.15, 2.35, 16.2, 0.36, 4.7, 3.8, { zone: zone2, bevel: 0.035, seg: 4 });
  stair(b, {
    x: 21.0, y: 0, z: 12.4, steps: 13, rise: 0.185, run: 0.3, width: 1.5,
    dir: new THREE.Vector3(0, 0, 1), zone: zone2, mat: 'concrete', railSides: [-1],
  });
  stair(b, {
    x: 21.0, y: 2.405, z: 18.4, steps: 13, rise: 0.177, run: 0.3, width: 1.5,
    dir: new THREE.Vector3(0, 0, -1), zone: zone2, mat: 'concrete', railSides: [1],
  });
  slab(b, { x: 21.0, y: 2.32, z: 17.2, w: 1.9, d: 1.9, thick: 0.24, zone: zone2 });
  slab(b, { x: 21.0, y: L.deck - 0.12, z: 15.0, w: 1.9, d: 2.6, thick: 0.24, zone: zone2 });
  railingRun(b, {
    from: new THREE.Vector3(20.05, L.deck, 13.7), to: new THREE.Vector3(21.95, L.deck, 13.7), zone: zone2,
  });

  // catwalk ring: stair head -> north over the courtyard -> pump house
  catwalk(b, {
    from: new THREE.Vector3(21.0, L.deck, 15.9), to: new THREE.Vector3(21.0, L.deck, 30.0),
    width: 1.6, zone: 'catwalk',
  });
  catwalk(b, {
    from: new THREE.Vector3(21.0, L.deck, 30.0), to: new THREE.Vector3(13.2, L.deck, 30.0),
    width: 1.6, zone: 'catwalk',
  });
  // stanchions. z = 18.4 rather than 20 so the rail siding runs clear of it.
  for (const [x, z] of [[21.0, 18.4], [21.0, 26.0], [17.5, 30.0]]) {
    b.box('metal_painted', x, L.deck / 2 - 0.2, z, 0.26, L.deck - 0.4, 0.26,
      { zone: 'catwalk', bevel: 0.02, seg: 3 });
    basePlate(b, { x, y: 0, z, size: 0.46, zone: 'catwalk', ribAxis: 'x', stem: 0.11 });
    // knee braces up to the walkway soffit
    for (const s of [-1, 1]) {
      b.geo('metal_rusted', tube([[x, L.deck - 1.5, z], [x, L.deck - 0.45, z + s * 1.0]], 0.045, 6,
        { segLen: 2 }), null, { zone: 'catwalk', tile: 1.0 });
    }
  }

  buildGantry(b);
}

/**
 * A derelict travelling gantry crane straddling the courtyard at z = 36.
 *
 * This is the MIDGROUND layer of the hero framing and it is sited by
 * measurement, not by eye: from the hero camera at (6,1.7,14) looking 200
 * degrees, the girder crosses the frame dead centre at 23m and the two legs land
 * at 67% and 38% of frame width. It is open lattice in rusted steel, so it reads
 * as a hard dark silhouette against the sky while still letting the stack and
 * the cooling tower show through it — a solid box there would have deleted the
 * background layer instead of separating it.
 *
 * It also earns its keep on the ground: the crane runs on two embedded rails
 * that put a pair of 12m leading lines into the courtyard slab.
 */
function buildGantry(b) {
  // Shares the courtyard's zone and the groundworks' zone rather than owning
  // one of its own, so the whole crane merges into buckets that already exist
  // and costs no additional draw call.
  const zone = 'court';
  const gz = 'gw';
  const WX = 3.4, EX = 24.6, GZ = 36.0, GY = 9.6;

  for (const lx of [WX, EX]) {
    // rail: flush concrete trough, dark flangeway, rail head proud
    b.box('concrete', lx, 0.0, 36.0, 1.5, 0.16, 12.0,
      { zone: gz, bevel: 0.02, seg: 4, cast: false, solid: false, tile: 2.0 });
    b.box('paint_dark', lx, -0.05, 36.0, 0.2, 0.12, 12.0,
      { zone: gz, bevel: 0.006, cast: false, solid: false, tile: 2.0 });
    b.box('metal_rusted', lx, 0.09, 36.0, 0.11, 0.1, 12.0,
      { zone: gz, bevel: 0.012, cast: false, solid: false, tile: 1.0 });
    for (let i = 0; i < 9; i++) {
      b.box('metal_rusted', lx, 0.03, 30.6 + i * 1.35, 1.24, 0.07, 0.2,
        { zone: gz, bevel: 0.01, cast: false, solid: false, tile: 0.8 });
    }
    // bogie, then a braced A-leg up to the girder
    b.box('metal_painted', lx, 0.42, GZ, 1.3, 0.62, 3.0, { zone, bevel: 0.035, seg: 3 });
    for (const s of [-1, 1]) {
      b.geo('metal_rusted', cyl(0.4, 0.4, 0.28, 12),
        b.xform(lx, 0.28, GZ + s * 1.15, { rz: Math.PI / 2 }), { zone, tile: 0.7 });
      b.geo('metal_painted', tube([[lx, 0.75, GZ + s * 1.35], [lx, GY - 0.6, GZ + s * 0.42]],
        0.16, 8, { segLen: 3 }), null, { zone, tile: 1.2 });
    }
    for (let i = 0; i < 4; i++) {
      const t = 0.15 + i * 0.22;
      b.geo('metal_rusted', tube([[lx, 0.75 + (GY - 1.35) * t, GZ - 1.35 + 0.93 * t],
        [lx, 0.75 + (GY - 1.35) * (t + 0.2), GZ + 1.35 - 0.93 * (t + 0.2)]], 0.05, 6,
      { segLen: 3 }), null, { zone, tile: 0.8 });
    }
    b.box('metal_painted', lx, GY - 0.42, GZ, 0.7, 0.5, 3.2, { zone, bevel: 0.03, seg: 3 });
  }
  // the girder itself
  truss(b, {
    from: new THREE.Vector3(WX - 1.6, GY, GZ), to: new THREE.Vector3(EX + 1.6, GY, GZ),
    depth: 1.5, width: 1.5, chord: 0.12, bays: 14, zone, mat: 'metal_rusted',
  });
  catwalk(b, {
    from: new THREE.Vector3(WX - 1.4, GY + 1.62, GZ + 1.1),
    to: new THREE.Vector3(EX + 1.4, GY + 1.62, GZ + 1.1),
    width: 0.9, zone, brackets: false,
  });
  // seized trolley with its rope and hook block hanging over the courtyard
  b.box('metal_painted', 16.4, GY + 0.95, GZ, 2.3, 1.3, 2.4, { zone, bevel: 0.04, seg: 3 });
  b.geo('metal_rusted', cyl(0.44, 0.44, 1.5, 12),
    b.xform(16.4, GY + 1.05, GZ, { rz: Math.PI / 2 }), { zone, tile: 0.8 });
  for (const s of [-1, 1]) {
    b.geo('metal_rusted', tube([[16.4 + s * 0.2, GY + 0.75, GZ], [16.4 + s * 0.2, 3.5, GZ]],
      0.024, 5, { segLen: 3 }), null, { zone, tile: 0.5, solid: false, cast: false });
  }
  b.box('metal_rusted', 16.4, 3.05, GZ, 0.66, 0.9, 0.5, { zone, bevel: 0.05, seg: 2 });
  b.geo('metal_rusted', new THREE.TorusGeometry(0.3, 0.06, 6, 14),
    b.xform(16.4, 2.4, GZ, { rx: Math.PI / 2, rz: 0.3 }), { zone, tile: 0.5 });
  // festoon cable sagging along the girder — a thin catenary under the lattice
  for (let i = 0; i < 6; i++) {
    const a = WX - 1.0 + i * 3.9, c = a + 3.9;
    b.geo('metal_rusted', tube([[a, GY - 0.5, GZ - 0.95], [(a + c) / 2, GY - 1.05, GZ - 0.95],
      [c, GY - 0.5, GZ - 0.95]], 0.028, 5, { segLen: 1.6 }), null,
    { zone, tile: 0.5, cast: false, solid: false });
  }
  // end stops on both rails
  for (const lx of [WX, EX]) {
    for (const s of [-1, 1]) {
      b.box('metal_painted', lx, 0.24, GZ + s * 5.6, 1.0, 0.48, 0.4, { zone, bevel: 0.03, seg: 2 });
    }
  }
}

/* ---------------------------------------------------- pump house (midground) - */

/**
 * A small failed structure in the middle of the courtyard: readable silhouette,
 * an interior you can see into, and a collapsed corner that justifies its one
 * non-orthogonal element.
 */
export function buildPumpHouse(b, w) {
  const zone = 'pump';
  const cx = 17.2, cz = 33.5, W = 9.2, D = 7.0, H = 4.4;
  const ap = w.apertures;
  wall(b, {
    cx, cz: cz - D / 2, len: W, height: H, thick: 0.34, axis: 'x', zone, mat: 'plaster',
    openings: [{ u: 1.4, y: 1.1, w: 2.0, h: 1.6 }, { u: 5.6, y: 0, w: 1.3, h: 2.1 }],
    pilasterEvery: 3.0, apertures: ap,
  });
  wall(b, {
    cx, cz: cz + D / 2, len: W, height: H, thick: 0.34, axis: 'x', zone, mat: 'plaster',
    openings: [{ u: 3.2, y: 1.2, w: 3.4, h: 1.9 }], pilasterEvery: 3.0, apertures: ap,
  });
  wall(b, {
    cx: cx - W / 2, cz, len: D, height: H, thick: 0.34, axis: 'z', zone, mat: 'plaster',
    openings: [{ u: 2.2, y: 1.2, w: 2.2, h: 1.7 }], pilasterEvery: 3.5, apertures: ap,
  });
  wall(b, {
    cx: cx + W / 2, cz, len: D, height: H, thick: 0.34, axis: 'z', zone, mat: 'plaster',
    openings: [{ u: 1.0, y: 0, w: 1.4, h: 2.1 }], pilasterEvery: 3.5, apertures: ap,
  });
  windowUnit(b, { x: cx - W / 2 + 2.4, y: 1.9, z: cz - D / 2, w: 2.0, h: 1.6, axis: 'x', zone, cols: 2, rows: 2 });
  windowUnit(b, { x: cx, y: 2.15, z: cz + D / 2, w: 3.4, h: 1.9, axis: 'x', zone, cols: 3, rows: 2 });
  windowUnit(b, { x: cx - W / 2, y: 2.05, z: cz - D / 2 + 3.3, w: 2.2, h: 1.7, axis: 'z', zone, cols: 2, rows: 2 });
  doorUnit(b, { x: cx + W / 2 - 5.6 + 0.65, y: 0, z: cz - D / 2, w: 1.3, h: 2.1, axis: 'x', zone, leaf: true, open: true });
  doorUnit(b, { x: cx + W / 2, y: 0, z: cz - D / 2 + 1.7, w: 1.4, h: 2.1, axis: 'z', zone, leaf: true });

  // roof: two thirds intact, one third collapsed into the room
  slab(b, { x: cx - 1.4, y: H + 0.1, z: cz, w: W - 2.6, d: D + 0.5, thick: 0.3, zone, mat: 'concrete' });
  for (const [px, pz, pw, pd] of [[cx, cz - D / 2 - 0.1, W + 0.5, 0.34], [cx, cz + D / 2 + 0.1, W + 0.5, 0.34]]) {
    b.box('concrete', px, H + 0.55, pz, pw, 0.9, pd, { zone, bevel: 0.04, seg: 3 });
    coping(b, { x: px, y: H + 1.0, z: pz, w: 0.5, len: pw, zone });
    // throated drip under the coping overhang — the shadow line that makes a
    // parapet read as a cast edge rather than a painted-on stripe
    const s = pz > cz ? 1 : -1;
    dripEdge(b, { x: px, y: H + 0.96, z: pz + s * 0.2, len: pw, axis: 'x', zone });
  }
  const g = chamferBox(4.2, 0.28, 5.4, 0.04, 4);
  b.geo('concrete', g, b.xform(cx + 2.9, 2.35, cz + 0.6, { rz: -0.55, ry: 0.16 }), { zone, tile: 2 });
  for (let i = 0; i < 5; i++) {
    b.geo('metal_rusted', tube([[cx + 1.2, 3.9 - i * 0.1, cz - 2.4 + i * 1.2],
      [cx + 4.6, 1.1, cz - 2.0 + i * 1.2]], 0.022, 6, { segLen: 2 }), null, { zone, tile: 1 });
  }
  // machinery inside, visible through the openings
  for (const [px, pz] of [[cx - 2.6, cz - 1.4], [cx - 2.6, cz + 1.6]]) {
    b.box('concrete', px, 0.22, pz, 2.2, 0.44, 1.6, { zone, bevel: 0.03, seg: 3 });
    b.geo('metal_painted', cyl(0.52, 0.52, 1.5, 18), b.xform(px, 1.2, pz, { rz: Math.PI / 2 }), { zone, tile: 1 });
    b.geo('metal_rusted', cyl(0.16, 0.16, 1.9, 12), b.xform(px, 1.2, pz, { rz: Math.PI / 2 }), { zone, tile: 1 });
  }
  pipeRun(b, {
    points: [[cx - 4.0, 1.2, cz - 1.4], [cx - 4.0, 3.4, cz - 1.4], [cx - 4.0, 3.4, cz + 3.4], [cx - 4.0, 3.4, cz + 6.0]],
    radius: 0.19, zone,
  });
  w.lightAnchors.push({ position: new THREE.Vector3(cx - 2.0, 3.6, cz), colour: 0xffd9a0, intensity: 20, distance: 16, kind: 'lamp', priority: 3 });
}

/* -------------------------------------------------------------- north yard -- */

/** The landmark cluster: everything the hero shot looks AT. */
export function buildNorthYard(b, w) {
  const zone = 'north';
  stack(b, { x: 14.5, y: 0, z: 50.0, h: 27.5, rBase: 3.4, rTop: 2.15, seg: 28, zone });
  ladder(b, { x: 14.5 + 3.1, y: 0.4, z: 50.0, h: 22, zone });
  tank(b, { x: -5.0, y: 0, z: 47.5, r: 5.4, h: 7.2, legH: 9.4, seg: 26, zone });

  // pipe bridge across the courtyard's north end — mid-height horizontal break
  truss(b, {
    from: new THREE.Vector3(-6, 8.4, 41.5), to: new THREE.Vector3(27, 8.4, 41.5),
    depth: 1.7, width: 1.8, chord: 0.09, bays: 14, zone,
  });
  for (const [dy, rad] of [[0.45, 0.28], [0.45, 0.2], [1.5, 0.34]]) {
    pipeRun(b, {
      points: [[-6, 8.4 + dy, 41.5 + (rad > 0.3 ? 0.6 : -0.5)], [27, 8.4 + dy, 41.5 + (rad > 0.3 ? 0.6 : -0.5)]],
      radius: rad, zone, seg: 14, segLen: 3.2, flanges: false,
    });
  }
  for (const x of [-6, 6.5, 20, 27]) {
    for (const s of [-1, 1]) {
      b.box('concrete', x, 4.1, 41.5 + s * 0.9, 0.55, 8.2, 0.55, { zone, bevel: 0.035, seg: 4 });
    }
    b.box('concrete', x, 0.18, 41.5, 1.7, 0.36, 2.8, { zone, bevel: 0.04, seg: 2 });
  }
  catwalk(b, {
    from: new THREE.Vector3(-6, 10.3, 43.1), to: new THREE.Vector3(27, 10.3, 43.1),
    width: 1.2, zone, brackets: false,
  });

  // cooling tower — second landmark, sited to close the sky gap that opens
  // between the admin block and the stack in the hero framing
  {
    const prof = [];
    for (let i = 0; i <= 16; i++) {
      const t = i / 16;
      const rr = 10.5 - 6.4 * Math.sin(Math.min(1, t * 1.18) * Math.PI * 0.5) + 4.2 * t * t;
      prof.push([rr, t * 29.0]);
    }
    b.geo('concrete', lathe(prof, 34), b.xform(37.0, 0, 46.0, {}), { zone, tile: 3.0 });
    for (let i = 0; i < 22; i++) {
      const a = (i / 22) * Math.PI * 2;
      b.geo('concrete', tube([[37 + Math.cos(a) * 11.6, 0, 46 + Math.sin(a) * 11.6],
        [37 + Math.cos(a) * 10.2, 4.2, 46 + Math.sin(a) * 10.2]], 0.28, 6, { segLen: 6 }), null,
        { zone, tile: 1.4 });
    }
    b.geo('concrete', new THREE.TorusGeometry(6.5, 0.35, 6, 34),
      b.xform(37.0, 29.0, 46.0, { rx: Math.PI / 2 }), { zone, tile: 1.4 });
    b.box('concrete', 37.0, 0.3, 46.0, 25.0, 0.6, 25.0, { zone, bevel: 0.08, seg: 4, cast: false });
  }

  // silo bank
  for (let i = 0; i < 3; i++) {
    const x = -17 + i * 6.4;
    b.geo('metal_painted', cyl(3.0, 3.0, 12.0, 22), b.xform(x, 9.0, 52.5, {}), { zone, tile: 2.2 });
    b.geo('metal_rusted', new THREE.ConeGeometry(3.05, 2.2, 22), b.xform(x, 16.1, 52.5, {}), { zone, tile: 1.6 });
    b.geo('metal_rusted', new THREE.ConeGeometry(3.0, 2.6, 22), b.xform(x, 1.7, 52.5, { rx: Math.PI }), { zone, tile: 1.6 });
    for (let j = 0; j < 3; j++) {
      b.geo('metal_rusted', new THREE.TorusGeometry(3.06, 0.06, 6, 22),
        b.xform(x, 4.6 + j * 3.4, 52.5, { rx: Math.PI / 2 }), { zone, tile: 1 });
    }
    for (let j = 0; j < 4; j++) {
      const a = (j / 4) * Math.PI * 2 + 0.78;
      b.geo('metal_rusted', tube([[x + Math.cos(a) * 2.4, 0, 52.5 + Math.sin(a) * 2.4],
        [x + Math.cos(a) * 2.4, 3.2, 52.5 + Math.sin(a) * 2.4]], 0.13, 8, { segLen: 4 }), null,
        { zone, tile: 1 });
    }
    b.box('concrete', x, 0.3, 52.5, 6.6, 0.6, 6.6, { zone, bevel: 0.05, seg: 3 });
  }
  catwalk(b, {
    from: new THREE.Vector3(-17, 15.2, 52.5), to: new THREE.Vector3(-4.2, 15.2, 52.5),
    width: 1.1, zone, brackets: false,
  });
  ladder(b, { x: -17, y: 0.6, z: 55.7, h: 14.6, zone });

  // extract fan / cooling cell bank
  for (let i = 0; i < 4; i++) {
    const x = 27 + i * 3.4;
    b.box('metal_painted', x, 2.6, 48.0, 3.2, 5.2, 4.4, { zone, bevel: 0.05, seg: 4 });
    b.geo('metal_rusted', cyl(1.3, 1.3, 0.9, 18), b.xform(x, 5.6, 48.0, {}), { zone, tile: 1.2 });
    for (let j = 0; j < 5; j++) {
      b.box('metal_rusted', x, 3.6 + j * 0.5, 45.75, 2.9, 0.2, 0.3, { zone, bevel: 0.02, rx: 0.45 });
    }
  }
  w.lightAnchors.push({ position: new THREE.Vector3(14.5, 27.0, 50.0), colour: 0xff4433, intensity: 3, distance: 40, kind: 'beacon', priority: 1 });
}

/* ------------------------------------------------- service yard + closeups -- */

/**
 * The 2-8m band in front of the material-closeup camera at (2,1.4,3) yaw 180:
 * kerbs, a manhole, a flanged pipe run and a hazard plinth. Texel density and
 * normal detail are judged here, so everything is real geometry at 1:1 scale.
 */
export function buildServiceYard(b, w) {
  const zone = 'yard';
  const y = L.yard;
  // low plinth with coping, right under the closeup camera's gaze
  b.box('concrete', 0.6, y + 0.34, 6.4, 3.2, 0.68, 1.5, { zone, bevel: 0.04, seg: 5, jitter: 0.012 });
  coping(b, { x: 0.6, y: y + 0.66, z: 6.4, w: 1.66, len: 3.2, zone });
  for (const s of [-1, 1]) {
    b.geo('metal_rusted', cyl(0.05, 0.05, 0.18, 10), b.xform(0.6 + s * 1.3, y + 0.78, 6.4, {}), { zone, tile: 0.5 });
  }
  // flanged pipe run at waist height crossing the frame
  pipeRun(b, {
    points: [[-4.5, y + 0.95, 5.2], [3.5, y + 0.95, 5.2], [6.5, y + 0.95, 5.2], [9.5, y + 1.6, 5.2]],
    radius: 0.17, zone, seg: 14, segLen: 1.2,
  });
  for (const x of [-3.0, 1.0, 5.0]) {
    b.box('metal_painted', x, y + 0.47, 5.2, 0.12, 0.95, 0.12, { zone, bevel: 0.015 });
    b.box('metal_painted', x, y + 0.05, 5.2, 0.4, 0.1, 0.4, { zone, bevel: 0.02 });
  }
  // cable-duct covers running across the closeup camera's near ground
  for (let i = 0; i < 5; i++) {
    b.box('metal_rusted', 0.2 + i * 0.86, y + 0.035, 4.3, 0.82, 0.07, 0.62,
      { zone, bevel: 0.014, seg: 2 });
    for (const s of [-1, 1]) {
      b.geo('metal_painted', cyl(0.028, 0.028, 0.05, 8),
        b.xform(0.2 + i * 0.86, y + 0.075, 4.3 + s * 0.22, {}), { zone, tile: 0.4 });
    }
  }
  b.box('concrete', 2.0, y + 0.09, 4.72, 4.6, 0.18, 0.2, { zone, bevel: 0.03, seg: 3, cast: false });
  b.box('concrete', 2.0, y + 0.09, 3.88, 4.6, 0.18, 0.2, { zone, bevel: 0.03, seg: 3, cast: false });

  // manhole + gully
  b.geo('metal_rusted', cyl(0.42, 0.44, 0.08, 20), b.xform(2.4, y + 0.03, 8.9, {}), { zone, tile: 0.6 });
  b.geo('concrete', cyl(0.56, 0.56, 0.16, 20), b.xform(2.4, y - 0.05, 8.9, {}), { zone, tile: 0.8, cast: false });
  b.box('metal_rusted', -1.6, y + 0.02, 7.4, 0.5, 0.06, 0.42, { zone, bevel: 0.012 });
  // kerb line and bollards guiding the eye to the steps
  kerb(b, { x: -2.2, y, z: 2.0, len: 12, ry: 0, zone });
  for (const z of [1.0, 3.2, 5.4]) {
    b.geo('metal_painted', cyl(0.085, 0.1, 0.95, 12), b.xform(-2.2, y + 0.47, z, {}), { zone, tile: 0.6 });
  }
  // switchgear cabinets — foreground mass for the silhouette view
  for (let i = 0; i < 3; i++) {
    const x = 22.6 + i * 1.35;
    b.box('metal_painted', x, y + 1.05, 1.4, 1.25, 2.1, 0.95, { zone, bevel: 0.03, seg: 4 });
    b.box('metal_rusted', x, y + 2.16, 1.4, 1.4, 0.14, 1.1, { zone, bevel: 0.03 });
    for (let j = 0; j < 6; j++) {
      b.box('metal_rusted', x, y + 1.7 - j * 0.11, 0.9, 0.95, 0.055, 0.06, { zone, bevel: 0.012, rx: 0.4 });
    }
    b.box('concrete', x, y + 0.06, 1.4, 1.6, 0.12, 1.3, { zone, bevel: 0.03, cast: false });
  }
  buildPlantDeck(b, w);
  buildSubstation(b, w);
  ramp(b, { x: 33, y, z: -14, rise: 1.1, len: 6.0, width: 4.0, ry: Math.PI / 2, zone });
}
