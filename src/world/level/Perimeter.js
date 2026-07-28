import * as THREE from 'three';
import { chamferBox, jitter, razorCoil, rng, tube } from './GeoKit.js';
import { wall, cladding, coping, ladder, kerb } from './Modules.js';
import { L } from './Site.js';

/**
 * OWNER: level agent.
 *
 * The perimeter. Split out of Compound.js when it stopped being four walls.
 *
 * ROOT CAUSE this rewrite addresses: the old perimeter was ONE `wall()` call per
 * side — a single 94m panel of constant 4.6m height with pilasters every 6m and
 * a dead-straight coping. At 40-55m that is a flat unbroken band of one value
 * across the frame with a razor-straight top edge, which is precisely what the
 * combat capture's right third was: a white ribbon and then sky. A wall reads as
 * a wall because of what varies along it, not because of what it is made of.
 *
 * So the run is now assembled bay by bay:
 *   - PIERS every ~7.6m standing 0.5m proud of the panel head, so the top edge
 *     is a rhythm of steps instead of a single line.
 *   - PANEL HEIGHTS varying 4.9-6.7m in a seeded pattern per side.
 *   - LOW BAYS at 2.6m. These matter more than anything else here: at eye height
 *     a 2.6m bay puts the entire outfield band — 20-46m of tanks, stacks and
 *     gantries — into the frame above it. That is the "gap that shows through to
 *     distance", achieved without a hole in the collision.
 *   - A BREACH per camera-facing side: collapsed to rubble and made good with a
 *     run of vertical steel bars. Visually open, still a solid collider, so the
 *     player and the AI cannot walk out of the map.
 *   - CLAD BAYS where the concrete has been replaced with corrugated hoarding
 *     over a low stub, for a second material and a second silhouette.
 *   - CONCERTINA RAZOR COIL along the whole head, plus the straight strands.
 *   - FOUR GUARD TOWERS at differing heights, so the corners have landmarks.
 *
 * Collision contract: every panel, pier, stub, bar and tower goes through the
 * normal solid bake path, so it all lands in `level.colliders` with a BVH.
 */

const ZONE = 'perimeter';
const Y0 = -0.75;          // formation level is -0.40, so the wall foot is buried
const BAY = 7.6;
const PIER_W = 0.7;

/** kinds of bay, in the order the seeded pattern picks them */
const PANEL = 0, LOW = 1, CLAD = 2, BREACH = 3, GATE = 4;

/* ------------------------------------------------------------------ helpers - */

/** Rubble heap for a collapsed bay: real broken concrete, not a flat decal. */
function rubble(b, x, z, len, axis, seed) {
  const r = rng(seed);
  const ux = axis === 'x' ? 1 : 0, uz = axis === 'x' ? 0 : 1;
  for (let i = 0; i < 8; i++) {
    const s = 0.22 + r() * 0.55;
    const t = (r() - 0.5) * len;
    const o = (r() - 0.5) * 1.9;
    b.geo('concrete', jitter(chamferBox(s * 1.7, s, s * 1.2, s * 0.2, 1), s * 0.22, 3.4),
      b.xform(x + ux * t + uz * o, -0.32 + s * 0.42, z + uz * t + ux * o,
        { ry: r() * 3.1, rz: (r() - 0.5) * 0.5, rx: (r() - 0.5) * 0.4 }),
      { zone: ZONE, tile: 0.9, solid: false, cast: false });
  }
  // two lengths of exposed starter bar bent out of the stub
  for (let i = 0; i < 3; i++) {
    const t = (i - 1) * len * 0.22;
    b.geo('metal_rusted', tube([
      [x + ux * t, 0.4, z + uz * t],
      [x + ux * t + uz * 0.3, 1.05 + r() * 0.3, z + uz * t + ux * 0.3],
    ], 0.016, 4, { segLen: 1 }), null, { zone: ZONE, tile: 0.3, solid: false, cast: false });
  }
}

/** Vertical-bar barrier making good a breach: see-through, still a collider. */
function barScreen(b, x, z, len, top, axis) {
  const ux = axis === 'x' ? 1 : 0, uz = axis === 'x' ? 0 : 1;
  const ry = axis === 'x' ? 0 : Math.PI / 2;
  const n = Math.max(4, Math.round(len / 0.33));
  for (let i = 0; i <= n; i++) {
    const t = -len / 2 + (i / n) * len;
    b.box('metal_rusted', x + ux * t, (top + 0.9) / 2, z + uz * t, 0.05, top - 0.9, 0.05,
      { zone: ZONE, bevel: 0.012, tile: 0.5 });
  }
  for (const yy of [top - 0.1, 1.1]) {
    b.box('metal_painted', x, yy, z, axis === 'x' ? len : 0.11, 0.11, axis === 'x' ? 0.11 : len,
      { zone: ZONE, bevel: 0.02, tile: 0.6 });
  }
  // raking props off the inside face
  for (const s of [-1, 1]) {
    b.geo('metal_rusted', tube([
      [x + ux * s * len * 0.3 - uz * 1.4, 0.0, z + uz * s * len * 0.3 - ux * 1.4],
      [x + ux * s * len * 0.3, top - 0.6, z + uz * s * len * 0.3],
    ], 0.055, 6, { segLen: 3 }), null, { zone: ZONE, tile: 0.6 });
  }
  void ry;
}

/* ---------------------------------------------------------------- the runs -- */

/**
 * One side of the perimeter. `axis` is the direction the run travels; `c` is the
 * fixed world coordinate of the wall centreline; `out` is the outward normal
 * sign along the perpendicular axis.
 */
function buildRun(b, w, o) {
  const { axis, c, u0, u1, out, seed } = o;
  const at = (u) => (axis === 'x' ? [u, c] : [c, u]);
  const total = u1 - u0;
  const bays = Math.max(4, Math.round(total / BAY));
  const bw = total / bays;
  const r = rng(seed);

  for (let i = 0; i < bays; i++) {
    const uc = u0 + (i + 0.5) * bw;
    const [px, pz] = at(uc);
    let kind = PANEL;
    const k = r();
    // Gates are declared explicitly and win over the pattern.
    for (const g of o.gates) if (Math.abs(uc - g.u) < g.w / 2 + bw * 0.35) kind = GATE;
    if (kind !== GATE) {
      if (o.breaches.some((bu) => Math.abs(uc - bu) < bw * 0.6)) kind = BREACH;
      else if (o.lows.some((lu) => Math.abs(uc - lu) < bw * 0.6)) kind = LOW;
      else if (k > 0.88) kind = CLAD;
    }

    const top = kind === LOW ? 2.6
      : kind === BREACH ? 5.4
        : 4.9 + [0.0, 0.85, 0.35, 1.35, 0.55, 1.0][i % 6];
    const panelLen = bw - PIER_W;

    if (kind === GATE) {
      // no panel — the gate leaf and its guides fill the opening
    } else if (kind === BREACH) {
      b.box('concrete', px, (Y0 + 0.95) / 2, pz, axis === 'x' ? panelLen : 0.46, 0.95 - Y0,
        axis === 'x' ? 0.46 : panelLen, { zone: ZONE, bevel: 0.05, seg: 3, jitter: 0.03 });
      rubble(b, px + (axis === 'x' ? 0 : out * 1.3), pz + (axis === 'x' ? out * 1.3 : 0),
        panelLen, axis, seed * 7 + i);
      barScreen(b, px, pz, panelLen, top, axis);
    } else if (kind === CLAD) {
      const stub = 2.3;
      b.box('concrete', px, (Y0 + stub) / 2, pz, axis === 'x' ? panelLen : 0.44, stub - Y0,
        axis === 'x' ? 0.44 : panelLen, { zone: ZONE, bevel: 0.04, seg: 3 });
      coping(b, {
        x: px, y: stub, z: pz, w: 0.6, len: panelLen,
        ry: axis === 'x' ? 0 : Math.PI / 2, zone: ZONE,
      });
      cladding(b, {
        cx: px, cy: (stub + top) / 2 + 0.1, cz: pz, len: panelLen, height: top - stub,
        axis, zone: ZONE, mat: 'metal_rusted', rails: 2, backFace: true, offset: out * 0.1,
        pitch: 0.19,
      });
    } else {
      wall(b, {
        cx: px, cz: pz, len: panelLen, height: top - Y0, thick: 0.44, axis, y0: Y0,
        mat: 'concrete', zone: ZONE, openings: [], pilasterEvery: 0, plinthH: 0.78,
      });
      coping(b, {
        x: px, y: top, z: pz, w: 0.68, len: panelLen,
        ry: axis === 'x' ? 0 : Math.PI / 2, zone: ZONE,
      });
    }

    // razor concertina along the head of everything except the gate
    if (kind !== GATE) {
      const coilY = top + (kind === LOW ? 0.42 : 0.48);
      b.geo('metal_rusted', razorCoil(panelLen - 0.2, { radius: 0.3, turnLen: 0.8, perTurn: 5 }),
        b.xform(px, coilY, pz, { ry: axis === 'x' ? 0 : Math.PI / 2 }),
        { zone: ZONE, tile: 0.4, cast: false, solid: false });
      // brackets carrying the coil, canted outboard
      for (const t of [-0.3, 0.3]) {
        const [bx, bz] = at(uc + t * panelLen);
        b.box('metal_rusted', bx, top + 0.26, bz, 0.06, 0.6, 0.06, {
          zone: ZONE, bevel: 0.012, solid: false, cast: false,
          rx: axis === 'x' ? 0 : out * 0.42, rz: axis === 'x' ? -out * 0.42 : 0,
        });
      }
    }

    // pier on the leading edge of every bay
    const [qx, qz] = at(u0 + i * bw);
    const pierTop = Math.max(top, 5.2) + 0.55;
    b.box('concrete', qx, (Y0 + pierTop) / 2, qz, 0.78, pierTop - Y0, 0.78,
      { zone: ZONE, bevel: 0.045, seg: 2 });
    b.box('concrete', qx, pierTop + 0.11, qz, 0.98, 0.22, 0.98, { zone: ZONE, bevel: 0.05, seg: 2 });
  }
  // closing pier
  const [ex, ez] = at(u1);
  b.box('concrete', ex, (Y0 + 6.0) / 2, ez, 0.78, 6.0 - Y0, 0.78,
    { zone: ZONE, bevel: 0.045, seg: 2 });
  b.box('concrete', ex, 6.11, ez, 0.98, 0.22, 0.98, { zone: ZONE, bevel: 0.05, seg: 2 });

  // straight barbed strands above the coil, the full length of the run
  for (const yy of [6.9, 7.15]) {
    const a = at(u0); const d = at(u1);
    b.geo('metal_rusted', tube([[a[0], yy, a[1]], [d[0], yy, d[1]]], 0.02, 4,
      { segLen: 12, maxSeg: 10 }), null, { zone: ZONE, tile: 1, cast: false, solid: false });
  }
  void w;
}

/* ------------------------------------------------------------- guard towers - */

function wallRing(b, x, z, y, size, h, mat) {
  const s = size / 2;
  for (const [dx, dz, w2, d2] of [[0, s, size, 0.22], [0, -s, size, 0.22],
    [s, 0, 0.22, size], [-s, 0, 0.22, size]]) {
    b.box(mat, x + dx, y + h / 2, z + dz, w2, h, d2, { zone: ZONE, bevel: 0.03, seg: 2 });
  }
}

function guardTower(b, w, x, z, h) {
  const cab = h - 3.5;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    b.box('concrete', x + sx * 1.1, (cab + Y0) / 2, z + sz * 1.1, 0.34, cab - Y0,
      0.34, { zone: ZONE, bevel: 0.025, seg: 3 });
    // cross-bracing between the legs, which is what makes a tower read as a
    // tower rather than as four sticks under a box
    for (const t of [0.42]) {
      b.geo('metal_rusted', tube([[x + sx * 1.1, Y0 + (cab - Y0) * t, z + sz * 1.1],
        [x + sx * 1.1, Y0 + (cab - Y0) * (t + 0.34), z - sz * 1.1]], 0.045, 4, { segLen: 8 }),
      null, { zone: ZONE, tile: 0.8, solid: false });
    }
  }
  b.box('concrete', x, cab + 0.17, z, 3.6, 0.34, 3.6, { zone: ZONE, bevel: 0.04, seg: 3 });
  wallRing(b, x, z, cab + 0.34, 3.5, 1.05, 'concrete');
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    b.box('metal_painted', x + sx * 1.6, cab + 2.2, z + sz * 1.6, 0.1, 2.6, 0.1,
      { zone: ZONE, bevel: 0.02 });
  }
  b.box('metal_rusted', x, cab + 3.62, z, 4.5, 0.24, 4.5, { zone: ZONE, bevel: 0.05, seg: 3 });
  b.box('metal_rusted', x, cab + 3.9, z, 3.0, 0.32, 3.0, { zone: ZONE, bevel: 0.05 });
  // a searchlight on the parapet and a whip antenna — silhouette above the roof
  b.box('metal_painted', x + 1.2, cab + 1.7, z - 1.2, 0.6, 0.5, 0.44,
    { zone: ZONE, bevel: 0.04, seg: 2, ry: 0.7 });
  b.geo('metal_rusted', tube([[x - 1.5, cab + 3.7, z + 1.5], [x - 1.5, cab + 6.6, z + 1.5]],
    0.035, 4, { segLen: 4 }), null, { zone: ZONE, tile: 0.5, solid: false });
  ladder(b, { x: x + 1.9, y: Y0 + 0.4, z, h: cab - Y0 - 0.1, zone: ZONE });
  w.lightAnchors.push({
    position: new THREE.Vector3(x, cab + 1.5, z), colour: 0xfff0cc,
    intensity: 70, distance: 55, kind: 'flood', priority: 2,
  });
}

/* -------------------------------------------------------------------- entry - */

export function buildPerimeter(b, w) {
  const { x0, x1, z0, z1 } = L.perim;

  // Breaches and low bays are sited against the cameras: the north run is what
  // the hero and combat framings look at, the east run is the right of both and
  // the whole of silhouette-dusk.
  buildRun(b, w, {
    axis: 'x', c: z0, u0: x0, u1: x1, out: -1, seed: 1109,
    gates: [{ u: 6, w: 9 }], breaches: [-26], lows: [30, -14],
  });
  buildRun(b, w, {
    axis: 'x', c: z1, u0: x0, u1: x1, out: 1, seed: 2237,
    gates: [], breaches: [22], lows: [-8, 40],
  });
  buildRun(b, w, {
    axis: 'z', c: x0, u0: z0, u1: z1, out: -1, seed: 3313,
    gates: [], breaches: [8], lows: [-14, 42],
  });
  buildRun(b, w, {
    axis: 'z', c: x1, u0: z0, u1: z1, out: 1, seed: 4421,
    gates: [{ u: 14, w: 7 }], breaches: [44], lows: [-6, 28],
  });

  // vehicle gate: sliding leaf on its rail, plus a boom and a kerbed island
  b.box('metal_rusted', 6, 1.55, z0, 8.6, 3.9, 0.14, { zone: ZONE, bevel: 0.03, seg: 4 });
  for (let i = 0; i < 10; i++) {
    b.box('metal_painted', 1.9 + i * 0.92, 1.55, z0 - 0.16, 0.12, 3.8, 0.12,
      { zone: ZONE, bevel: 0.02 });
  }
  b.box('metal_painted', 6, 3.62, z0, 9.2, 0.26, 0.3, { zone: ZONE, bevel: 0.03, seg: 3 });
  b.box('concrete', 11.4, 0.05, z0 + 1.6, 1.6, 0.9, 2.4, { zone: ZONE, bevel: 0.05, seg: 3 });
  b.geo('metal_painted', tube([[11.4, 0.9, z0 + 1.6], [11.4, 1.55, z0 + 1.6]], 0.09, 8,
    { segLen: 1 }), null, { zone: ZONE, tile: 0.5 });
  b.box('metal_painted', 7.2, 1.6, z0 + 1.6, 8.0, 0.16, 0.16, { zone: ZONE, bevel: 0.02, seg: 3 });
  kerb(b, { x: 11.4, y: -0.36, z: z0 + 1.6, len: 3.2, ry: Math.PI / 2, zone: ZONE });

  guardTower(b, w, x0 + 1.5, z0 + 1.5, 9.8);
  guardTower(b, w, x1 - 1.5, z1 - 1.5, 11.4);
  guardTower(b, w, x1 - 1.5, z0 + 1.5, 8.9);
  guardTower(b, w, x0 + 1.5, z1 - 1.5, 10.6);
}
