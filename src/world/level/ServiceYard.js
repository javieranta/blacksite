import * as THREE from 'three';
import { chamferBox, cyl, tube, gratingPanel } from './GeoKit.js';
import {
  wall, doorUnit, slab, landing, stair, railingRun, catwalk, pipeRun, coping, basePlate,
} from './Modules.js';
import { L } from './Site.js';

/**
 * OWNER: level agent.
 * The south half of the compound: the substation that closes the horizon behind
 * the yard, and the elevated plant deck that is both the map's high ground and
 * the platform the `vertical` capture is shot from.
 *
 * Split out of Compound.js purely for file size — the two are called from
 * buildServiceYard and share its datum.
 */

/**
 * Substation compound at the south end of the service yard. Its job is depth:
 * it is the 18-24m midground of the elevated `vertical` framing, and it puts a
 * lattice pylon on the skyline so the perimeter is not the last thing you see.
 */
export function buildSubstation(b, w) {
  const zone = 'sub';
  const y = L.yard;
  const cx = -1.0, cz = -19.0;
  // switch house: monopitch roof, louvred vents, a personnel door
  wall(b, {
    cx, cz: cz - 3.0, len: 8.4, height: 4.0, thick: 0.32, axis: 'x', y0: y, zone, mat: 'concrete',
    openings: [{ u: 1.0, y: y + 0.15, w: 1.3, h: 2.15 }, { u: 5.2, y: y + 2.1, w: 2.2, h: 1.2 }],
    pilasterEvery: 2.8, apertures: w.apertures,
  });
  wall(b, {
    cx, cz: cz + 3.0, len: 8.4, height: 4.6, thick: 0.32, axis: 'x', y0: y, zone, mat: 'concrete',
    openings: [{ u: 3.0, y: y + 2.5, w: 2.6, h: 1.3 }], pilasterEvery: 2.8, apertures: w.apertures,
  });
  for (const s of [-1, 1]) {
    wall(b, {
      cx: cx + s * 4.2, cz, len: 6.0, height: 4.3, thick: 0.32, axis: 'z', y0: y, zone, mat: 'concrete',
      openings: s > 0 ? [{ u: 2.0, y: y + 2.2, w: 1.8, h: 1.2 }] : [], pilasterEvery: 3.0,
      apertures: w.apertures,
    });
  }
  b.geo('concrete', chamferBox(9.2, 0.3, 6.8, 0.04, 5),
    b.xform(cx, y + 4.4, cz, { rx: 0.098 }), { zone, tile: 2 });
  coping(b, { x: cx, y: y + 4.72, z: cz + 3.3, w: 0.5, len: 9.2, zone });
  doorUnit(b, { x: cx - 4.2 + 1.65, y: y + 0.15, z: cz - 3.0, w: 1.3, h: 2.15, axis: 'x', zone, leaf: true });
  for (const [ox, oz, ow, ax] of [[1.9, -3.0, 2.2, 'x'], [0.0, 3.0, 2.6, 'x'], [4.2, 0.6, 1.8, 'z']]) {
    for (let i = 0; i < 7; i++) {
      const t = i * 0.17;
      if (ax === 'x') {
        b.box('metal_painted', cx + ox, y + 2.2 + t, cz + oz, ow - 0.15, 0.1, 0.24,
          { zone, bevel: 0.015, rx: 0.42 });
      } else {
        b.box('metal_painted', cx + ox, y + 2.3 + t, cz + oz, 0.24, 0.1, ow - 0.15,
          { zone, bevel: 0.015, rz: 0.42 });
      }
    }
  }
  // transformer bays behind a mesh screen
  for (let i = 0; i < 2; i++) {
    const px = cx + 7.4 + i * 4.4;
    b.box('concrete', px, y + 0.2, cz, 3.6, 0.4, 3.6, { zone, bevel: 0.05, seg: 3, cast: false });
    b.box('metal_painted', px, y + 1.5, cz, 2.4, 2.2, 2.4, { zone, bevel: 0.05, seg: 4 });
    for (let j = 0; j < 9; j++) {
      b.box('metal_rusted', px - 1.25, y + 1.5, cz - 1.0 + j * 0.25, 0.16, 1.8, 0.09,
        { zone, bevel: 0.02 });
    }
    for (const dx of [-0.7, 0, 0.7]) {
      b.geo('metal_painted', cyl(0.16, 0.22, 0.9, 12), b.xform(px + dx, y + 3.05, cz, {}), { zone, tile: 0.6 });
      b.geo('glass', cyl(0.24, 0.24, 0.5, 12), b.xform(px + dx, y + 3.7, cz, {}), { zone, tile: 0.6, cast: false });
    }
  }
  for (let i = 0; i <= 16; i++) {
    const px = cx - 6.0 + i * 1.35;
    b.box('metal_rusted', px, y + 1.1, cz - 6.4, 0.07, 2.2, 0.07, { zone, bevel: 0.014 });
  }
  for (const yy of [y + 0.4, y + 2.1]) {
    b.geo('metal_rusted', tube([[cx - 6.0, yy, cz - 6.4], [cx + 15.6, yy, cz - 6.4]], 0.025, 6,
      { segLen: 6 }), null, { zone, tile: 1, cast: false });
  }
  // lattice pylon — the far silhouette in the elevated framing
  const px = cx + 3.0, pz = cz - 10.5, ph = 21.0;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      b.geo('metal_rusted', tube([[px + sx * 2.1, y, pz + sz * 2.1], [px + sx * 0.62, y + ph, pz + sz * 0.62]],
        0.11, 7, { segLen: 5 }), null, { zone, tile: 1.2 });
    }
    for (let i = 0; i < 7; i++) {
      const t0 = i / 7, t1 = (i + 1) / 7;
      const r0 = 2.1 - 1.48 * t0, r1 = 2.1 - 1.48 * t1;
      b.geo('metal_rusted', tube([[px + sx * r0, y + ph * t0, pz - r0], [px + sx * r1, y + ph * t1, pz + r1]],
        0.04, 5, { segLen: 5 }), null, { zone, tile: 1 });
    }
  }
  for (let i = 1; i < 7; i++) {
    const t = i / 7, rr = 2.1 - 1.48 * t;
    for (const [ax, az] of [[1, 0], [0, 1]]) {
      b.geo('metal_rusted', tube([[px - rr * ax, y + ph * t, pz - rr * az], [px + rr * ax, y + ph * t, pz + rr * az]],
        0.04, 5, { segLen: 5 }), null, { zone, tile: 1 });
    }
  }
  for (const [yy, arm] of [[ph * 0.72, 5.6], [ph * 0.88, 4.2]]) {
    b.geo('metal_rusted', tube([[px - arm, y + yy, pz], [px + arm, y + yy, pz]], 0.09, 6, { segLen: 5 }),
      null, { zone, tile: 1 });
    for (const s of [-1, 1]) {
      for (const t of [0.55, 1.0]) {
        b.geo('metal_painted', cyl(0.09, 0.09, 0.9, 8),
          b.xform(px + s * arm * t, y + yy - 0.55, pz, {}), { zone, tile: 0.5 });
      }
    }
  }
  w.lightAnchors.push({
    position: new THREE.Vector3(cx + 4.6, y + 4.4, cz - 3.2), colour: 0xfff0cc,
    intensity: 26, distance: 24, kind: 'wallpack', priority: 7,
  });
  w.enemySpawns.push(new THREE.Vector3(cx + 2, y + 1.78, cz - 7));
}

/**
 * The elevated plant deck. This is the map's high ground and the platform the
 * `vertical` capture is shot from: the camera stands 2m inside its south-west
 * corner, so the railing and deck plant read as a foreground layer while the
 * whole service yard, the hall elevation and the skyline open up beyond it.
 */
export function buildPlantDeck(b, w) {
  const zone = 'deck';
  const y = L.yard, deck = L.deck;
  const d0x = -2.0, d1x = 9.0, d0z = -2.0, d1z = 6.0;
  const cx = (d0x + d1x) / 2, cz = (d0z + d1z) / 2, W = d1x - d0x, D = d1z - d0z;

  slab(b, { x: cx, y: deck - 0.17, z: cz, w: W, d: D, thick: 0.34, zone, mat: 'concrete' });
  for (const [ax, az, bx, bz] of [
    [d0x, d0z, d1x, d0z], [d0x, d1z, d1x, d1z], [d0x, d0z, d0x, d1z], [d1x, d0z, d1x, 2.0],
  ]) {
    railingRun(b, {
      from: new THREE.Vector3(ax, deck, az), to: new THREE.Vector3(bx, deck, bz), zone,
    });
  }
  // columns, base pads and knee braces
  for (const px of [d0x + 0.7, cx, d1x - 0.7]) {
    for (const pz of [d0z + 0.7, d1z - 0.7]) {
      b.box('concrete', px, y + (deck - y) / 2 - 0.2, pz, 0.42, deck - y - 0.4, 0.42,
        { zone, bevel: 0.03, seg: 4 });
      b.box('concrete', px, y + 0.14, pz, 1.2, 0.28, 1.2, { zone, bevel: 0.04, cast: false });
      // grout haunch at the foot: concrete columns are cast against a kicker,
      // and the splay is what stops them reading as pushed into the floor
      b.box('concrete', px, y + 0.34, pz, 0.68, 0.22, 0.68, { zone, bevel: 0.06, cast: false });
      for (const s of [-1, 1]) {
        b.geo('metal_rusted', tube([[px, deck - 1.6, pz], [px + s * 1.1, deck - 0.5, pz]], 0.05, 6,
          { segLen: 3 }), null, { zone, tile: 1 });
      }
    }
    b.box('metal_painted', px, deck - 0.5, cz, 0.24, 0.34, D - 1.0, { zone, bevel: 0.02, seg: 3 });
  }
  // deck plant: an air handler, a pipe manifold and a cable tray riser
  b.box('metal_painted', -0.9, deck + 1.05, 4.1, 2.4, 2.1, 2.2, { zone, bevel: 0.05, seg: 4 });
  b.geo('metal_rusted', cyl(0.62, 0.62, 0.55, 16), b.xform(-0.9, deck + 2.36, 4.1, {}), { zone, tile: 1 });
  for (let i = 0; i < 7; i++) {
    b.box('metal_rusted', -0.9, deck + 1.5 - i * 0.17, 2.96, 2.1, 0.1, 0.24,
      { zone, bevel: 0.015, rx: 0.42 });
  }
  pipeRun(b, {
    points: [[0.4, deck + 0.55, 4.1], [3.4, deck + 0.55, 4.1], [3.4, deck + 0.55, 0.6], [8.6, deck + 0.55, 0.6]],
    radius: 0.17, zone, seg: 12, segLen: 1.4,
  });
  for (const [px, pz] of [[2.2, 4.1], [3.4, 2.2], [6.2, 0.6]]) {
    b.box('metal_painted', px, deck + 0.2, pz, 0.16, 0.7, 0.16, { zone, bevel: 0.015 });
  }
  b.box('metal_rusted', 4.6, deck + 1.4, -1.2, 0.5, 2.9, 0.16, { zone, bevel: 0.02, seg: 3 });
  for (let i = 0; i < 8; i++) {
    b.box('metal_rusted', 4.6, deck + 0.2 + i * 0.34, -1.2, 0.42, 0.06, 0.3, { zone, bevel: 0.01 });
  }
  b.geo('metal_rusted', gratingPanelSafe(1.4, 2.0), b.xform(7.4, deck + 0.02, 3.6, {}), { zone, tile: 0.9 });
  b.geo('metal_rusted', gratingPanelSafe(1.05, 1.5), b.xform(-1.15, deck + 0.02, -1.05, {}), { zone, tile: 0.9 });
  b.box('metal_painted', 1.9, deck + 0.13, 0.4, 0.42, 0.1, 4.2, { zone, bevel: 0.02, cast: false });
  for (let i = 0; i < 6; i++) {
    b.box('metal_rusted', 1.9, deck + 0.2, -1.3 + i * 0.7, 0.5, 0.06, 0.12,
      { zone, bevel: 0.014, cast: false });
  }
  b.box('concrete', 3.0, deck + 0.2, -1.4, 1.1, 0.4, 0.9, { zone, bevel: 0.04, seg: 3 });
  b.geo('metal_painted', cyl(0.26, 0.26, 0.7, 14), b.xform(3.0, deck + 0.75, -1.4, {}), { zone, tile: 0.7 });
  for (const s of [-1, 1]) {
    b.box('metal_rusted', -1.7, deck + 0.55, s * 1.1, 0.12, 1.1, 0.12, { zone, bevel: 0.02 });
  }
  buildDeckSurface(b);
  w.lightAnchors.push({
    position: new THREE.Vector3(cx, deck + 2.6, cz - 1.2), colour: 0xffe6bd,
    intensity: 20, distance: 22, kind: 'lamp', priority: 5,
  });

  // catwalk links: west to the hall's high-level door, east to the admin block
  catwalk(b, {
    from: new THREE.Vector3(-2.0, deck, 2.0), to: new THREE.Vector3(-7.2, deck, 2.0),
    width: 1.5, zone: 'catwalk',
  });
  // Split at x 13.4..15.0 so the stair spur can arrive from the south. A
  // railing run across the head of a stair is a wall; that window is the only
  // reason this walkway is reachable from the ground at all.
  catwalk(b, {
    from: new THREE.Vector3(9.0, deck, 2.0), to: new THREE.Vector3(13.4, deck, 2.0),
    width: 1.6, zone: 'catwalk',
  });
  catwalk(b, {
    from: new THREE.Vector3(13.4, deck, 2.0), to: new THREE.Vector3(15.0, deck, 2.0),
    width: 1.6, zone: 'catwalk', rail: false,
  });
  catwalk(b, {
    from: new THREE.Vector3(15.0, deck, 2.0), to: new THREE.Vector3(30.0, deck, 2.0),
    width: 1.6, zone: 'catwalk',
  });
  railingRun(b, {
    from: new THREE.Vector3(13.4, deck, 2.84), to: new THREE.Vector3(15.0, deck, 2.84),
    zone: 'catwalk', height: 1.1,
  });
  for (const x of [13.0, 18.0, 23.0, 28.0]) {
    for (const s of [-1, 1]) {
      b.box('metal_painted', x, y + (deck - y) / 2 - 0.2, 2.0 + s * 0.8, 0.2, deck - y - 0.4, 0.2,
        { zone: 'catwalk', bevel: 0.02, seg: 3 });
    }
    basePlate(b, { x, y, z: 2.0, size: 0.4, zone: 'catwalk', ribAxis: 'z', stem: 0.8 });
  }
  // pipe rack over the yard — overhead framing for the low silhouette view
  for (const [dz, rad] of [[0.4, 0.3], [-0.5, 0.19], [1.2, 0.13]]) {
    pipeRun(b, {
      points: [[12.0, deck + 1.35, dz], [21.0, deck + 1.35, dz], [30.0, deck + 1.35, dz]],
      radius: rad, zone: 'catwalk', seg: 14, segLen: 3, flanges: false,
    });
  }
  for (const x of [13.0, 18.0, 23.0, 28.0]) {
    b.box('metal_rusted', x, deck + 1.62, 0.35, 0.14, 0.14, 2.4, { zone: 'catwalk', bevel: 0.02 });
    b.box('metal_rusted', x, deck + 0.95, -0.85, 0.12, 1.4, 0.12, { zone: 'catwalk', bevel: 0.02 });
  }

  // Switchback stair from the yard up to the deck.
  //
  // TRAVERSAL: this used to climb the other way round — flight 1 north, flight 2
  // back south to a head at z = -5.3, with the linking catwalk then running the
  // full length of z -5.3..1.2 directly OVER flight 2. Bar grating has its
  // soffit 43 mm under the deck, so from the fourth tread up the player was
  // walking head-first into the walkway they were trying to reach and the whole
  // plant deck was cut off from the ground. Reversed, the climb ends at the
  // north end and the link runs away from the flight, over open yard.
  stair(b, {
    x: 11.6, y, z: -1.6, steps: 14, rise: 0.18, run: 0.3, width: 1.4,
    dir: new THREE.Vector3(0, 0, -1), zone: 'stairs', mat: 'metal_rusted',
    stringerMat: 'metal_painted', railSides: [-1],
  });
  landing(b, { x: 12.9, y: y + 2.52 - 0.1, z: -6.8, w: 3.4, d: 2.0, thick: 0.2, zone: 'stairs', mat: 'metal_rusted', fascia: 0.26 });
  stair(b, {
    x: 14.2, y: y + 2.52, z: -6.6, steps: 14, rise: 0.18, run: 0.3, width: 1.4,
    dir: new THREE.Vector3(0, 0, 1), zone: 'stairs', mat: 'metal_rusted',
    stringerMat: 'metal_painted', railSides: [1],
  });
  catwalk(b, {
    from: new THREE.Vector3(14.2, deck, -2.4), to: new THREE.Vector3(14.2, deck, 2.0),
    width: 1.4, zone: 'catwalk', rail: false,
  });
  for (const s of [-1, 1]) {
    railingRun(b, {
      from: new THREE.Vector3(14.2 + s * 0.74, deck, -2.4),
      to: new THREE.Vector3(14.2 + s * 0.74, deck, 1.0), zone: 'catwalk', height: 1.1,
    });
  }
  w.spawnPoints.push(new THREE.Vector3(4.0, deck + 1.78, 3.0));
  w.enemySpawns.push(new THREE.Vector3(6.5, deck + 1.78, 1.0));
}

/**
 * Incident on the deck slab itself. The `vertical` capture puts this plane
 * across the bottom 45% of frame, and a bare slab there reads as grey card —
 * so it gets the same treatment as the courtyard: a walkway marked out in
 * yellow, a chequer-plate access hatch, a drain sump and a bolted joint line.
 */
function buildDeckSurface(b) {
  const deck = L.deck, zone = 'gw';
  const y = deck + 0.02;
  const plate = (mat, x, z, len, wide, ry = 0) => b.box(mat, x, y, z, len, 0.014, wide,
    { zone, bevel: 0.005, ry, cast: false, solid: false, tile: 1.2 });
  // marked walkway down the deck with hatched margins
  for (const z of [-0.35, 1.75]) plate('paint_yellow', 3.4, z, 10.2, 0.12);
  for (let i = 0; i < 12; i++) {
    plate('paint_yellow', -1.4 + i * 0.98, 2.2, 0.6, 0.34, -0.7);
  }
  // a bolted cover plate and a shallow sump with a grate
  b.box('metal_rusted', 6.35, deck + 0.03, 4.35, 1.5, 0.03, 1.2,
    { zone, bevel: 0.01, seg: 2, cast: false, solid: false, tile: 0.7 });
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    b.geo('metal_painted', cyl(0.026, 0.026, 0.03, 8),
      b.xform(6.35 + sx * 0.66, deck + 0.055, 4.35 + sz * 0.5, {}),
      { zone, tile: 0.3, cast: false, solid: false });
  }
  b.box('concrete', 8.1, deck + 0.0, -1.3, 0.8, 0.1, 0.8,
    { zone, bevel: 0.03, cast: false, solid: false, tile: 0.9 });
  b.geo('metal_rusted', gratingPanel(0.56, 0.56, { pitch: 0.09, barW: 0.024, barH: 0.035 }),
    b.xform(8.1, deck + 0.055, -1.3, {}), { zone, tile: 0.5, cast: false, solid: false });
  // pooled water in the corner where the slab has settled
  b.box('concrete_wet', 1.1, deck + 0.005, 4.9, 3.4, 0.012, 2.2,
    { zone, bevel: 0.006, seg: 3, cast: false, solid: false, tile: 1.8 });
  b.box('water', 1.2, deck + 0.014, 4.95, 2.5, 0.014, 1.5,
    { zone, bevel: 0.006, seg: 2, cast: false, recv: false, solid: false, tile: 3.0 });
}

function gratingPanelSafe(wd, dp) {
  return gratingPanel(wd, dp, { pitch: 0.11 });
}
