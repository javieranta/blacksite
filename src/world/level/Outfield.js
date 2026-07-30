import * as THREE from 'three';
import { cyl, lathe, tube, rng } from './GeoKit.js';
import { coolingShell } from './Towers.js';
import { truss } from './Modules.js';

/**
 * OWNER: level agent.
 *
 * The 60-180m band immediately outside the perimeter wall.
 *
 * ROOT CAUSE this file exists to fix: the map had a 5m perimeter wall, then
 * NOTHING until the mid-distance ring at 110m and the skyline at 330m. The
 * mid-distance clusters top out at 16m — which, seen over a 5m wall from an eye
 * height of 1.7m at 120m, subtends about 4 degrees and is then bleached to
 * nothing by aerial perspective. The result is that every framing that looks
 * outward ends in wall, then a flat band of haze, then sky: the compound reads
 * as a diorama on a table rather than one plant among many.
 *
 * The fix is a ring of structures at 60-180m that are TALL — 20-48m — so they
 * break the skyline well above the wall and read as silhouette rather than as
 * texture. They are placed by hand, not scattered, and weighted toward the
 * azimuths the canonical captures actually look down:
 *
 *   hero / viewmodel / night   (6,1.7,14) -> NNE   the north and north-east band
 *   combat                     (4,1.7,6)  -> N     the north band
 *   silhouette-dusk           (20,1.7,0)  -> E     the east band
 *   vertical                   (0,6.5,0)  -> SW    the south and west bands
 *
 * COST: everything here shares the `far_mid` zone and the three materials the
 * mid-distance band already uses, so the whole outfield merges into the existing
 * buckets and adds ZERO draw calls. Nothing casts a shadow, nothing receives
 * one, and nothing is a collider — it is all outside the playable volume.
 */

const ZONE = 'far_mid';
const OPT = { zone: ZONE, cast: false, recv: false, solid: false, tile: 8 };

/* --------------------------------------------------------------- structures - */

/**
 * Flare / vent stack. The single most valuable silhouette in an industrial
 * backdrop: a 40m needle with a guy-wire tripod reads instantly as "plant" and
 * costs about 250 triangles.
 */
function flareStack(b, x, z, h, r = 1.5) {
  b.geo('metal_painted', cyl(r * 0.62, r, h, 10), b.xform(x, h / 2, z, {}), OPT);
  b.geo('metal_rusted', lathe([[r * 0.62, 0], [r * 1.5, 0.7], [r * 1.2, 2.1], [r * 0.8, 2.6]], 10),
    b.xform(x, h, z, {}), OPT);
  // guy tripod
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 0.4;
    b.geo('metal_rusted', tube([
      [x + Math.cos(a) * h * 0.24, 0, z + Math.sin(a) * h * 0.24],
      [x + Math.cos(a) * r * 1.1, h * 0.72, z + Math.sin(a) * r * 1.1],
    ], 0.09, 4, { segLen: 20 }), null, OPT);
  }
  // knock-out drum at the foot
  b.geo('metal_painted', cyl(2.2, 2.2, 6.0, 10), b.xform(x + 5.2, 3.0, z + 1.4, { rz: Math.PI / 2 }), OPT);
  b.box('concrete', x, 0.4, z, 9.0, 0.8, 9.0, { ...OPT, bevel: 0.2 });
}

/** Bunded tank farm: cylinders, cone roofs, a bund wall and a stair spiral. */
function tankFarm(b, x, z, seed, n = 5) {
  const r = rng(seed);
  const span = 15 + n * 3;
  b.box('concrete', x, 0.7, z, span * 2.1, 1.4, span * 1.5, { ...OPT, bevel: 0.2 });
  for (let i = 0; i < n; i++) {
    const rr = 6.5 + r() * 4.0, hh = 11 + r() * 9;
    const px = x + (i - (n - 1) / 2) * (span * 1.9 / n), pz = z + (r() - 0.5) * span * 0.9;
    b.geo('metal_painted', cyl(rr, rr, hh, 14), b.xform(px, hh / 2 + 1.2, pz, {}), OPT);
    b.geo('metal_rusted', lathe([[rr, 0], [rr * 0.72, 1.1], [0, 1.7]], 14),
      b.xform(px, hh + 1.2, pz, {}), OPT);
    for (const t of [0.34, 0.7]) {
      b.geo('metal_rusted', new THREE.TorusGeometry(rr + 0.08, 0.12, 4, 14),
        b.xform(px, 1.2 + hh * t, pz, { rx: Math.PI / 2 }), OPT);
    }
    // external stair as a leaning strip — reads as a helix at this range
    b.box('metal_rusted', px + rr, hh / 2 + 1.2, pz + rr * 0.5, 0.5, hh * 1.02, 0.5,
      { ...OPT, bevel: 0.06, rz: 0.14 });
  }
}

/** Portal gantry crane on rails — long horizontal plus two hard verticals. */
function gantryCrane(b, x, z, len, h, ry) {
  const dir = new THREE.Vector3(Math.sin(ry), 0, Math.cos(ry));
  truss(b, {
    from: new THREE.Vector3(x - dir.x * len / 2, h, z - dir.z * len / 2),
    to: new THREE.Vector3(x + dir.x * len / 2, h, z + dir.z * len / 2),
    depth: 3.4, width: 3.2, chord: 0.42, bays: 8, zone: ZONE, mat: 'metal_rusted',
    cast: false, recv: false, solid: false,
  });
  for (const s of [-1, 1]) {
    const lx = x + dir.x * s * len / 2, lz = z + dir.z * s * len / 2;
    for (const t of [-1, 1]) {
      b.geo('metal_painted', tube([
        [lx + dir.z * t * 2.6, 0, lz - dir.x * t * 2.6],
        [lx + dir.z * t * 0.9, h, lz - dir.x * t * 0.9],
      ], 0.42, 5, { segLen: 20 }), null, OPT);
    }
    b.box('metal_painted', lx, h * 0.55, lz, 4.6, 0.6, 4.6, { ...OPT, bevel: 0.12, ry });
  }
  // trolley + hook block
  b.box('metal_painted', x + dir.x * len * 0.18, h + 3.6, z + dir.z * len * 0.18, 5.0, 2.6, 4.2,
    { ...OPT, bevel: 0.12, ry });
  b.geo('metal_rusted', tube([[x + dir.x * len * 0.18, h + 2.4, z + dir.z * len * 0.18],
    [x + dir.x * len * 0.18, h * 0.35, z + dir.z * len * 0.18]], 0.1, 4, { segLen: 20 }), null, OPT);
}

/** Elevated pipe rack — a long, unbroken horizontal at mid height. */
function pipeRack(b, x0, z0, x1, z1, h) {
  const dx = x1 - x0, dz = z1 - z0;
  const len = Math.hypot(dx, dz);
  const ux = dx / len, uz = dz / len;
  const ry = Math.atan2(ux, uz);
  for (const [dy, rad] of [[0, 0.55], [0, 0.34], [1.5, 0.42], [1.5, 0.24]]) {
    const off = rad > 0.4 ? 1.1 : -1.0;
    b.geo('metal_rusted', tube([
      [x0 + uz * off, h + dy, z0 - ux * off], [x1 + uz * off, h + dy, z1 - ux * off],
    ], rad, 6, { segLen: 24, maxSeg: 12 }), null, OPT);
  }
  const bents = Math.max(3, Math.round(len / 14));
  for (let i = 0; i <= bents; i++) {
    const t = i / bents;
    const px = x0 + dx * t, pz = z0 + dz * t;
    for (const s of [-1, 1]) {
      b.box('concrete', px + uz * s * 1.8, h / 2, pz - ux * s * 1.8, 0.9, h, 0.9,
        { ...OPT, bevel: 0.1, ry });
    }
    b.box('concrete', px, h + 0.5, pz, 0.8, 0.9, 4.9, { ...OPT, bevel: 0.1, ry });
  }
}

/**
 * Hyperbolic cooling tower pair. The biggest, softest mass in the band — and
 * previously the flattest: an 18-segment lathe of `concrete` at 120 m has no
 * surface at all. `coolingShell` gives it the same construction language as the
 * compound's own tower (lift lines, colonnade, cornice, staining) for about 3k
 * triangles, which is what makes the two read as the same kind of object.
 */
function coolingPair(b, x, z, h, gap, seed) {
  for (const s of [-1, 1]) {
    coolingShell(b, {
      x: x + (s * gap) / 2, z: z + s * gap * 0.18,
      h: h * (s > 0 ? 1 : 0.88), zone: ZONE, seed: seed + (s > 0 ? 0 : 613),
    });
  }
}

/** Long-span shed with a sawtooth roof — north-light glazing reads at distance. */
function shedRow(b, x, z, wd, dp, h, ry, teeth) {
  b.box('metal_painted', x, h / 2, z, wd, h, dp, { ...OPT, ry, bevel: 0.2, seg: 2 });
  const c = Math.cos(ry), s = Math.sin(ry);
  for (let i = 0; i < teeth; i++) {
    const u = (i + 0.5) / teeth * wd - wd / 2;
    b.box('metal_rusted', x + c * u, h + 1.9, z - s * u, wd / teeth * 0.9, 3.6, dp * 0.98,
      { ...OPT, ry, rz: 0.34, bevel: 0.12 });
  }
  b.box('concrete', x, 0.5, z, wd + 5, 1.0, dp + 5, { ...OPT, ry, bevel: 0.2 });
}

/**
 * A run of lattice transmission pylons with catenary conductors. Pylons are the
 * cheapest way to put readable man-made structure across an empty horizon, and
 * the wires draw the eye out of frame — which is exactly the read of "this site
 * is connected to somewhere else".
 */
function pylonRun(b, from, to, count, h) {
  const heads = [];
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0 : i / (count - 1);
    const x = from[0] + (to[0] - from[0]) * t, z = from[1] + (to[1] - from[1]) * t;
    const hh = h * (0.9 + (i % 3) * 0.07);
    const base = hh * 0.16;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      b.geo('metal_rusted', tube([[x + sx * base, 0, z + sz * base],
        [x + sx * base * 0.3, hh, z + sz * base * 0.3]], 0.22, 4, { segLen: 30, maxSeg: 3 }),
      null, OPT);
    }
    for (let k = 1; k < 5; k++) {
      const tt = k / 5, rr = base * (1 - 0.7 * tt);
      b.box('metal_rusted', x, hh * tt, z, rr * 2, 0.3, rr * 2, { ...OPT, bevel: 0.06 });
    }
    const arms = [[hh * 0.66, hh * 0.3], [hh * 0.82, hh * 0.24], [hh * 0.95, hh * 0.15]];
    for (const [ay, arm] of arms) {
      b.box('metal_rusted', x, ay, z, arm * 2, 0.34, 0.6, { ...OPT, bevel: 0.06 });
    }
    heads.push([x, hh * 0.66, z, hh * 0.3]);
  }
  // conductors: two catenaries per span, one each side
  for (let i = 0; i + 1 < heads.length; i++) {
    const a = heads[i], c = heads[i + 1];
    for (const s of [-1, 1]) {
      const sag = 3.4;
      const pts = [];
      for (let k = 0; k <= 4; k++) {
        const t = k / 4;
        pts.push([
          a[0] + (c[0] - a[0]) * t + s * (a[3] + (c[3] - a[3]) * t) * 0.9,
          a[1] + (c[1] - a[1]) * t - 4 * sag * t * (1 - t),
          a[2] + (c[2] - a[2]) * t,
        ]);
      }
      b.geo('metal_rusted', tube(pts, 0.09, 3, { segLen: 12, maxSeg: 8, caps: false }), null, OPT);
    }
  }
}

/** Inclined conveyor gallery off a silo bank — a hard diagonal on the horizon. */
function conveyor(b, x, z, len, rise, ry) {
  const c = Math.cos(ry), s = Math.sin(ry);
  const ang = Math.atan2(rise, len);
  const run = Math.hypot(len, rise);
  b.box('metal_rusted', x + c * len / 2, rise / 2 + 2.0, z - s * len / 2, run, 2.6, 3.0,
    { ...OPT, ry, rz: ang, bevel: 0.1 });
  const legs = Math.max(2, Math.round(len / 12));
  for (let i = 0; i <= legs; i++) {
    const t = i / legs;
    const y = 2.0 + rise * t;
    b.box('concrete', x + c * len * t, y / 2, z - s * len * t, 0.8, y, 0.8, { ...OPT, ry, bevel: 0.1 });
  }
  // head house
  b.box('metal_painted', x + c * len, rise + 5.0, z - s * len, 7.0, 8.0, 6.0,
    { ...OPT, ry, bevel: 0.15, seg: 2 });
  for (let i = 0; i < 4; i++) {
    const px = x + c * (len + 9 + i * 8), pz = z - s * (len + 9 + i * 8);
    b.geo('metal_painted', cyl(4.2, 4.2, 18, 12), b.xform(px, 9.0, pz, {}), OPT);
    b.geo('metal_rusted', new THREE.ConeGeometry(4.3, 3.2, 12), b.xform(px, 19.6, pz, {}), OPT);
  }
}

/* -------------------------------------------------------------------- layout - */

export function buildOutfield(b, w) {
  /* ---- NORTH: the hero and combat sightline. Everything here is chosen to
     stack behind the compound's own stack and cooling tower, at 25-95m past the
     north wall, so the frame reads wall -> plant -> plant -> haze -> sky. */
  pipeRack(b, -34, 74, 78, 71, 9.0);
  tankFarm(b, 30, 92, 8821, 5);
  flareStack(b, -14, 100, 44, 1.6);
  coolingPair(b, 62, 116, 46, 42, 4801);
  gantryCrane(b, 92, 88, 62, 24, 0.42);
  conveyor(b, -52, 118, 46, 20, -0.5);
  shedRow(b, 8, 138, 62, 34, 15, 0.18, 9);
  flareStack(b, 118, 126, 33, 1.2);
  pylonRun(b, [-96, 152], [130, 158], 6, 34);

  /* ---- EAST: right of the hero frame and the whole of silhouette-dusk. The
     admin block stops at x 48, the wall at 52, and past it there was nothing. */
  pipeRack(b, 70, -34, 74, 56, 8.0);
  tankFarm(b, 96, 30, 3391, 4);
  flareStack(b, 88, -8, 38, 1.4);
  gantryCrane(b, 120, 62, 54, 21, 1.5);
  shedRow(b, 104, -52, 54, 30, 13, -0.3, 8);
  coolingPair(b, 152, 8, 38, 36, 9127);
  pylonRun(b, [66, -78], [78, 148], 7, 30);

  /* ---- SOUTH: behind the substation, and the far half of the vertical view. */
  tankFarm(b, 18, -78, 5527, 4);
  gantryCrane(b, -34, -70, 58, 22, -0.2);
  flareStack(b, 62, -86, 36, 1.3);
  shedRow(b, -6, -122, 70, 36, 14, 0.1, 10);
  coolingPair(b, 106, -110, 40, 38, 2255);

  /* ---- WEST: past the hall, and the near half of the vertical view. */
  pipeRack(b, -66, -46, -62, 44, 8.5);
  tankFarm(b, -92, 8, 7013, 5);
  flareStack(b, -74, 52, 40, 1.5);
  shedRow(b, -104, -66, 58, 32, 14, 0.26, 8);
  conveyor(b, -78, 84, 40, 17, 0.62);
  pylonRun(b, [-136, -96], [-124, 120], 7, 32);
  void w;
}
