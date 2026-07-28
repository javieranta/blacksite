import * as THREE from 'three';
import { cyl, lathe, tube, fbm, rng, geoFrom, pushQuad } from './GeoKit.js';
import { truss } from './Modules.js';

/**
 * OWNER: level agent.
 * Everything past the perimeter wall: the terrain the compound sits in, a
 * silhouetted industrial skyline at 120-700m and two ridge layers at 600-1500m.
 *
 * The point of this file is that the world must never visibly END inside the
 * frame. The terrain runs past the far plane, the skyline closes the horizon
 * with parallaxing depth, and everything past ~250m is aerial-perspective food.
 */

const FLAT_R = 108;      // metres of dead-flat ground around the compound
const BLEND_R = 240;     // ...blending out to full terrain relief by here

/**
 * Formation level. This has to sit below the LOWEST built surface in the
 * compound, not below the courtyard apron — the site has two datums (courtyard
 * 0.00, service yard / hall floor -0.35) and at -0.18 the terrain plane was
 * physically ABOVE the yard datum. It buried the whole asphalt service yard,
 * the west hall's floor slab and the admin block's ground floor: everywhere the
 * yard should have been you were looking at the dirt terrain instead, which is
 * why those areas read as one uninterrupted featureless plane and why the
 * groundworks laid into them (crack sealing, puddles, markings) were invisible.
 *
 * -0.40 clears the yard datum by 50mm and leaves the courtyard slab standing
 * 400mm proud of grade, which is what a real apron does.
 */
export const TERRAIN_BASE = -0.40;

export function terrainHeight(x, z) {
  const d = Math.hypot(x - 8, z - 14);
  if (d < FLAT_R) return TERRAIN_BASE;
  const k = Math.min(1, (d - FLAT_R) / (BLEND_R - FLAT_R));
  const s = k * k * (3 - 2 * k);
  const broad = (fbm(x * 0.0032, 0, z * 0.0032, 4) - 0.45) * 34;
  const mid = (fbm(x * 0.014, 7, z * 0.014, 3) - 0.5) * 4.2;
  const fine = (fbm(x * 0.06, 13, z * 0.06, 2) - 0.5) * 0.9;
  return TERRAIN_BASE + s * (broad + mid) + s * fine;
}

export function buildTerrain(b) {
  // 144 rather than 208 divisions: the inner 108m radius is dead flat by
  // construction and the broad noise has a ~300m wavelength, so 12m cells
  // resolve everything the terrain actually does. Buys back ~45k triangles,
  // which is what pays for the outfield band.
  const size = 1760, seg = 144;
  const g = new THREE.PlaneGeometry(size, size, seg, seg);
  g.rotateX(-Math.PI / 2);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i) + 8, z = p.getZ(i) + 14;
    p.setY(i, terrainHeight(x, z));
    p.setX(i, x); p.setZ(i, z);
  }
  g.computeVertexNormals();
  b.geo('dirt', g, null, { zone: 'terrain', cast: false, recv: true, solid: true, tile: 3.0 });

  // A gravel apron so the concrete slab does not meet raw dirt in a hard line.
  const r = rng(4021);
  for (let i = 0; i < 90; i++) {
    const a = r() * Math.PI * 2, rad = 62 + r() * 78;
    const x = 8 + Math.cos(a) * rad, z = 14 + Math.sin(a) * rad;
    const s = 1.6 + r() * 5.5;
    b.box(r() > 0.55 ? 'sand' : 'dirt', x, terrainHeight(x, z) + 0.06, z, s, 0.16, s * (0.6 + r()),
      { zone: 'terrain', bevel: 0.06, seg: 2, ry: r() * 3.14, cast: false, jitter: 0.05 });
  }
}

/* ------------------------------------------------------------- mid distance - */

/**
 * Real, shadow-free structures in the 110-260m band. These are what stop the
 * horizon reading as "plane meets sky" in a mid-height shot.
 */
export function buildMidDistance(b) {
  const r = rng(90211);
  const zone = 'far_mid';
  const opts = { zone, cast: false, recv: false, solid: false };
  // Twenty-two clusters rather than twelve. Twelve left ~30 degrees of open
  // azimuth between neighbours, and a 30-degree gap at 200m is a hole in the
  // horizon wide enough to swallow a whole framing — which is exactly what the
  // right of the combat view was looking through.
  const ring = [
    [-150, 120], [-190, -40], [-120, -150], [30, -195], [175, -120],
    [215, 40], [150, 165], [10, 215], [-70, 190], [230, -60], [-230, 60], [95, -230],
    [-96, 205], [78, 196], [196, 118], [244, -18], [162, -178], [-46, -222],
    [-172, -138], [-236, 6], [-186, 152], [258, 74],
  ];
  for (const [ox, oz] of ring) {
    const cx = 8 + ox, cz = 14 + oz;
    const kind = r();
    if (kind < 0.4) {
      // long-span warehouse with a sawtooth roof
      const w = 26 + r() * 34, d = 16 + r() * 22, h = 9 + r() * 7;
      const ry = r() * Math.PI;
      b.box('metal_painted', cx, h / 2, cz, w, h, d, { ...opts, ry, bevel: 0.12, seg: 3 });
      const teeth = Math.max(3, Math.round(w / 6));
      for (let i = 0; i < teeth; i++) {
        const u = (i + 0.5) / teeth * w - w / 2;
        b.box('metal_rusted', cx + Math.cos(ry) * u, h + 1.5, cz - Math.sin(ry) * u,
          w / teeth * 0.92, 3.0, d * 0.98, { ...opts, ry, rz: 0.32, bevel: 0.08 });
      }
    } else if (kind < 0.68) {
      // tank farm
      for (let i = 0; i < 3 + Math.floor(r() * 3); i++) {
        const rr = 6 + r() * 7, hh = 9 + r() * 9;
        const px = cx + (r() - 0.5) * 44, pz = cz + (r() - 0.5) * 44;
        b.geo('metal_painted', cyl(rr, rr, hh, 20), b.xform(px, hh / 2, pz, {}), opts);
        b.geo('metal_rusted', lathe([[0, 0], [rr * 0.8, 0.5], [rr, 1.1]], 20),
          b.xform(px, hh, pz, {}), opts);
      }
    } else if (kind < 0.86) {
      // cooling tower pair
      for (const s of [-1, 1]) {
        const hh = 34 + r() * 16;
        const prof = [];
        for (let i = 0; i <= 12; i++) {
          const t = i / 12;
          const rr = 15 - 9 * Math.sin(Math.min(1, t * 1.15) * Math.PI * 0.5) + 5.5 * t * t;
          prof.push([rr, t * hh]);
        }
        b.geo('concrete', lathe(prof, 26), b.xform(cx + s * 22, 0, cz + s * 9, {}), opts);
      }
    } else {
      // gantry cranes over a rail yard
      const len = 40 + r() * 30, hh = 16 + r() * 10, ry = r() * Math.PI;
      const dir = new THREE.Vector3(Math.sin(ry), 0, Math.cos(ry));
      truss(b, {
        from: new THREE.Vector3(cx - dir.x * len / 2, hh, cz - dir.z * len / 2),
        to: new THREE.Vector3(cx + dir.x * len / 2, hh, cz + dir.z * len / 2),
        depth: 3.2, width: 3.0, chord: 0.4, bays: 10, zone,
        cast: false, recv: false, solid: false,
      });
      for (const s of [-1, 1]) {
        b.box('metal_painted', cx + dir.x * s * len / 2, hh / 2, cz + dir.z * s * len / 2,
          2.4, hh, 2.4, { ...opts, ry, bevel: 0.1 });
      }
    }
  }
}

/* ------------------------------------------------------------------ skyline - */

/** A dense industrial skyline at 330-720m: chimneys, towers, cranes, blocks. */
export function buildSkyline(b) {
  const r = rng(771133);
  const zone = 'skyline';
  const opts = { zone, cast: false, recv: false, solid: false, tile: 8 };
  const bands = [
    { r0: 330, r1: 430, scale: 1.0, n: 46 },
    { r0: 460, r1: 600, scale: 1.45, n: 40 },
    { r0: 640, r1: 780, scale: 2.0, n: 30 },
  ];
  for (const band of bands) {
    for (let i = 0; i < band.n; i++) {
      const a = (i / band.n) * Math.PI * 2 + r() * 0.14;
      const rad = band.r0 + r() * (band.r1 - band.r0);
      const x = 8 + Math.cos(a) * rad, z = 14 + Math.sin(a) * rad;
      const s = band.scale * (0.7 + r() * 0.8);
      const k = r();
      if (k < 0.22) {
        const h = (36 + r() * 44) * s;
        b.geo('concrete', cyl(2.0 * s, 3.4 * s, h, 14), b.xform(x, h / 2, z, {}), opts);
        b.geo('metal_rusted', cyl(2.4 * s, 2.4 * s, 1.6, 14), b.xform(x, h, z, {}), opts);
      } else if (k < 0.42) {
        const h = (18 + r() * 26) * s, w = (16 + r() * 26) * s, d = (12 + r() * 20) * s;
        b.box('concrete', x, h / 2, z, w, h, d, { ...opts, ry: r() * 3.14, bevel: 0.3, seg: 2 });
        b.box('metal_rusted', x, h + 1.1 * s, z, w * 0.8, 2.2 * s, d * 0.8,
          { ...opts, ry: r() * 3.14, bevel: 0.2 });
      } else if (k < 0.58) {
        const h = (26 + r() * 30) * s, rr = (7 + r() * 8) * s;
        const prof = [];
        for (let j = 0; j <= 10; j++) {
          const t = j / 10;
          prof.push([rr * (1 - 0.55 * Math.sin(Math.min(1, t * 1.2) * Math.PI * 0.5)) + rr * 0.35 * t * t, t * h]);
        }
        b.geo('concrete', lathe(prof, 20), b.xform(x, 0, z, {}), opts);
      } else if (k < 0.74) {
        const hh = (12 + r() * 10) * s;
        for (let j = 0; j < 4; j++) {
          const rr = (5 + r() * 4) * s;
          b.geo('metal_painted', cyl(rr, rr, hh, 16),
            b.xform(x + (r() - 0.5) * 30 * s, hh / 2, z + (r() - 0.5) * 30 * s, {}), opts);
        }
      } else if (k < 0.88) {
        // lattice pylon
        const h = (30 + r() * 22) * s;
        for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
          b.geo('metal_rusted', tube([[x + sx * 2.4 * s, 0, z + sz * 2.4 * s],
            [x + sx * 0.7 * s, h, z + sz * 0.7 * s]], 0.34 * s, 6, { segLen: 14 }), null, opts);
        }
        for (let j = 1; j < 5; j++) {
          const t = j / 5, yy = h * t, rr = (2.4 - 1.7 * t) * s;
          b.box('metal_rusted', x, yy, z, rr * 2, 0.5 * s, rr * 2, { ...opts, bevel: 0.1 });
        }
        for (const sx of [-1, 1]) {
          b.box('metal_rusted', x + sx * 5.5 * s, h * 0.82, z, 11 * s, 0.5 * s, 0.9 * s, { ...opts, bevel: 0.08 });
        }
      } else {
        // dockside crane silhouette
        const h = (24 + r() * 16) * s, ry = r() * Math.PI;
        const dir = new THREE.Vector3(Math.sin(ry), 0, Math.cos(ry));
        b.box('metal_painted', x, h / 2, z, 3 * s, h, 3 * s, { ...opts, ry, bevel: 0.15 });
        b.box('metal_painted', x + dir.x * 14 * s, h, z + dir.z * 14 * s, 34 * s, 1.6 * s, 2 * s,
          { ...opts, ry, bevel: 0.12 });
        b.geo('metal_rusted', tube([[x, h + 9 * s, z], [x + dir.x * 26 * s, h + 0.8 * s, z + dir.z * 26 * s]],
          0.32 * s, 6, { segLen: 20 }), null, opts);
      }
    }
  }
}

/* -------------------------------------------------------------------- ridge - */

/**
 * Two silhouette ridge layers well past the fog opacity distance. Vertical
 * curtains: at 700m+ nobody reads the missing thickness, but the parallax
 * between the layers is what makes the horizon feel deep instead of painted.
 */
export function buildRidge(b) {
  const layers = [
    { rad: 620, amp: 90, base: 26, seed: 11, cols: 300, rough: 2.4 },
    { rad: 815, amp: 155, base: 44, seed: 57, cols: 260, rough: 1.5 },
  ];
  for (const L of layers) {
    const pos = [], nor = [];
    const hAt = (i) => {
      const a = (i / L.cols) * Math.PI * 2;
      const n1 = fbm(Math.cos(a) * L.rough + L.seed, 0, Math.sin(a) * L.rough, 4);
      const n2 = fbm(Math.cos(a) * L.rough * 4.1 + L.seed, 3, Math.sin(a) * L.rough * 4.1, 3);
      return L.base + (n1 * 0.78 + n2 * 0.22) * L.amp;
    };
    const rAt = (i) => {
      const a = (i / L.cols) * Math.PI * 2;
      return L.rad * (0.86 + fbm(Math.cos(a) * 1.7 + L.seed * 2, 9, Math.sin(a) * 1.7, 3) * 0.3);
    };
    for (let i = 0; i < L.cols; i++) {
      const a0 = (i / L.cols) * Math.PI * 2, a1 = ((i + 1) / L.cols) * Math.PI * 2;
      const r0 = rAt(i), r1 = rAt(i + 1);
      const h0 = hAt(i), h1 = hAt(i + 1);
      const x0 = 8 + Math.cos(a0) * r0, z0 = 14 + Math.sin(a0) * r0;
      const x1 = 8 + Math.cos(a1) * r1, z1 = 14 + Math.sin(a1) * r1;
      const mx = (x0 + x1) / 2 - 8, mz = (z0 + z1) / 2 - 14;
      const ln = Math.hypot(mx, mz) || 1;
      const n = [-mx / ln, 0.16, -mz / ln];
      pushQuad(pos, nor, [x0, -30, z0], [x1, -30, z1], [x1, h1, z1], [x0, h0, z0], n);
    }
    const g = geoFrom(pos, nor);
    b.geo('dirt', g, null, { zone: 'ridge', cast: false, recv: false, solid: false, tile: 24 });
  }
}
