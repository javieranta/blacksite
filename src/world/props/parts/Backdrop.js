import * as THREE from 'three';
import { box, cyl, xf, mergeAll, boxUV, tubeAlong, catenary } from '../GeoUtil.js';

/**
 * The distance band. OWNER: props agent.
 *
 * WHY THIS EXISTS
 *   Round 5's combat frame ends at the perimeter wall. Beyond it there is flat
 *   dirt and haze, and the level's own skyline sits 400 m out — so the 60 m to
 *   400 m band, which is exactly where the eye looks to judge how big a place
 *   is, contains nothing at all. That is the difference between a map and a
 *   place, and no amount of set dressing inside the wire fixes it.
 *
 *   So: pylons marching away, a tank farm, a water tower, chimneys with plumes,
 *   sheds, and a broken treeline closing the horizon. All of it silhouette
 *   work — read at 200 m through aerial perspective, an object is a shape, a
 *   value and an edge, and nothing else.
 *
 * COST
 *   Four draw calls and about 30k triangles for the whole band. Everything is
 *   merged into four batches by material, nothing is solid (the player can
 *   never reach it), nothing casts or receives a shadow, and no piece is closer
 *   than the level's own perimeter. The sky system's fog supplies the depth
 *   grading, so the materials are plain.
 *
 * PLACEMENT
 *   Radii are measured from the world origin and start outside the probed level
 *   bounds, so this file never needs to know what the level agent built. Ground
 *   height comes from the same raycast probe everything else uses; where the
 *   terrain does not reach, a supplied base height is used.
 */

const FAR_CONCRETE = 'concrete#far';
const FAR_STEEL = 'steel#far';

const _mtx = new THREE.Matrix4();
const _mtx2 = new THREE.Matrix4();

/** Merge a list of pieces into one batch entry. */
function emit(api, matKey, parts, uv = 0.12) {
  if (!parts.length) return 0;
  const geo = mergeAll(parts);
  boxUV(geo, uv);
  api.batcher.merge(matKey, geo, api.mats.get(matKey), {
    solid: false, castShadow: false, receiveShadow: false,
  });
  return parts.length;
}

/* ------------------------------------------------------------------ pieces */

/**
 * Lattice suspension pylon. Members are 0.3-0.45 m, which at 150-300 m is one
 * to three pixels — thin enough that the tower reads as an open lattice against
 * the sky instead of a slab, which is the whole point of putting one there.
 */
function pylon(rng, h = 34) {
  const parts = [];
  const baseHalf = h * 0.135, topHalf = h * 0.038;
  const waist = h * 0.62;                       // where the legs stop tapering
  const m = 0.34;

  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      // two-segment leg: steep taper to the waist, near-vertical above it
      const x0 = sx * baseHalf, z0 = sz * baseHalf;
      const x1 = sx * topHalf * 1.9, z1 = sz * topHalf * 1.9;
      const len = Math.hypot(x1 - x0, waist, z1 - z0);
      // A leg leans in two axes at once, so it is built along +Y and rotated by
      // a composed matrix rather than by Euler angles applied in sequence.
      const yaw = Math.atan2(x1 - x0, z1 - z0);
      const lean = Math.atan2(Math.hypot(x1 - x0, z1 - z0), waist);
      const leg = box(m, len, m);
      leg.applyMatrix4(_mtx.makeRotationY(yaw).multiply(_mtx2.makeRotationX(lean)));
      leg.translate((x0 + x1) / 2, waist / 2, (z0 + z1) / 2);
      parts.push(leg);

      const up = box(m * 0.85, h - waist, m * 0.85);
      xf(up, x1, waist + (h - waist) / 2, z1);
      parts.push(up);
    }
  }
  // horizontal belts
  for (let i = 1; i <= 5; i++) {
    const t = i / 6;
    const y = t * waist;
    const half = baseHalf + (topHalf * 1.9 - baseHalf) * t;
    for (const sz of [-1, 1]) {
      const b = box(half * 2, m * 0.7, m * 0.7);
      xf(b, 0, y, sz * half); parts.push(b);
      const c = box(m * 0.7, m * 0.7, half * 2);
      xf(c, sz * half, y, 0); parts.push(c);
    }
  }
  // cross arms — the shape that says "transmission tower" at any distance
  const arms = [
    { y: h * 0.70, w: h * 0.50 },
    { y: h * 0.84, w: h * 0.40 },
    { y: h * 0.96, w: h * 0.27 },
  ];
  for (const a of arms) {
    const bar = box(a.w, m * 0.9, m * 0.7);
    xf(bar, 0, a.y, 0); parts.push(bar);
    for (const sx of [-1, 1]) {
      const stay = box(a.w * 0.5, m * 0.55, m * 0.5);
      xf(stay, sx * a.w * 0.25, a.y - h * 0.055, 0, 0, 0, sx * 0.42);
      parts.push(stay);
      // insulator strings hanging off the arm tips
      const ins = box(m * 0.5, h * 0.035, m * 0.5);
      xf(ins, sx * a.w * 0.5, a.y - h * 0.018, 0);
      parts.push(ins);
    }
  }
  // earth peak
  const peak = box(m * 0.6, h * 0.06, m * 0.6);
  xf(peak, 0, h * 1.0, 0);
  parts.push(peak);
  void rng;
  return mergeAll(parts);
}

/** Vertical storage tank with a shallow domed top. */
function tank(rng, r, h) {
  const parts = [];
  const shell = cyl(r, r * 1.01, h, 16, true, 3);
  xf(shell, 0, h / 2, 0);
  parts.push(shell);
  const dome = cyl(r * 0.24, r, h * 0.14, 16);
  xf(dome, 0, h + h * 0.07, 0);
  parts.push(dome);
  const cap = cyl(r * 0.24, r * 0.24, h * 0.05, 10);
  xf(cap, 0, h + h * 0.16, 0);
  parts.push(cap);
  // wind girder — the ring that makes a tank read as a tank
  const ring = cyl(r * 1.04, r * 1.04, h * 0.02, 16, true);
  xf(ring, 0, h * 0.72, 0);
  parts.push(ring);
  // access stair spiralling the shell, as a coarse ribbon
  const steps = 7;
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI * 1.7;
    const s = box(r * 0.55, h * 0.012, 0.5);
    xf(s, Math.cos(a) * r * 1.12, (i / steps) * h * 0.92 + h * 0.05, Math.sin(a) * r * 1.12, 0, -a, 0);
    parts.push(s);
  }
  void rng;
  return mergeAll(parts);
}

/** Water tower: a bowl on four splayed legs. Instant scale reference. */
function waterTower(h = 26, r = 5.2) {
  const parts = [];
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const leg = box(0.5, h * 0.72, 0.5);
    xf(leg, Math.cos(a) * r * 0.72, h * 0.36, Math.sin(a) * r * 0.72, 0, 0, 0);
    parts.push(leg);
    const brace = box(r * 1.3, 0.32, 0.32);
    xf(brace, Math.cos(a + Math.PI / 4) * r * 0.5, h * 0.34, Math.sin(a + Math.PI / 4) * r * 0.5,
      0, -a - Math.PI / 4, 0);
    parts.push(brace);
  }
  const cone = cyl(r, r * 0.35, h * 0.16, 14);
  xf(cone, 0, h * 0.72 + h * 0.08, 0);
  parts.push(cone);
  const bowl = cyl(r, r, h * 0.24, 14, true, 2);
  xf(bowl, 0, h * 0.88 + h * 0.04, 0);
  parts.push(bowl);
  const roof = cyl(0.5, r * 1.02, h * 0.09, 14);
  xf(roof, 0, h * 1.0 + h * 0.045, 0);
  parts.push(roof);
  return mergeAll(parts);
}

/** Tapered concrete chimney. */
function chimney(h = 58) {
  const parts = [];
  const stack = cyl(h * 0.035, h * 0.075, h, 14, true, 3);
  xf(stack, 0, h / 2, 0);
  parts.push(stack);
  const lip = cyl(h * 0.042, h * 0.042, h * 0.02, 14, true);
  xf(lip, 0, h * 0.99, 0);
  parts.push(lip);
  for (let i = 1; i <= 3; i++) {
    const band = cyl(h * 0.075 - i * h * 0.0098, h * 0.076 - i * h * 0.0098, h * 0.012, 14, true);
    xf(band, 0, (i / 4) * h, 0);
    parts.push(band);
  }
  return mergeAll(parts);
}

/** A low industrial shed with a shallow gable. */
function shed(rng, w, d, h) {
  const parts = [];
  const body = box(w, h, d);
  xf(body, 0, h / 2, 0);
  parts.push(body);
  const rise = Math.min(3.2, w * 0.10);
  for (const s of [-1, 1]) {
    const slope = box(w * 0.53, 0.35, d * 1.02);
    xf(slope, s * w * 0.26, h + rise * 0.5, 0, 0, 0, -s * Math.atan2(rise, w * 0.5));
    parts.push(slope);
  }
  // roof vents
  const n = Math.max(2, Math.round(d / 9));
  for (let i = 0; i < n; i++) {
    const v = box(1.4, 1.1, 1.4);
    xf(v, rng.jit(w * 0.2), h + rise * 0.85, ((i + 0.5) / n - 0.5) * d * 0.8);
    parts.push(v);
  }
  return mergeAll(parts);
}

/** A camera-facing quad, `w` x `h`, standing on y = base at (x,z). */
function billboard(x, base, z, w, h, faceX, faceZ, uOff = 0, uSpan = 1) {
  // PlaneGeometry already carries 0..1 UVs; the strip textures are sampled
  // through a window of them so neighbouring panels show different trees.
  const g = new THREE.PlaneGeometry(w, h);
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setX(i, uOff + uv.getX(i) * uSpan);
  uv.needsUpdate = true;
  g.rotateY(Math.atan2(faceX, faceZ));
  g.translate(x, base + h * 0.5, z);
  return g;
}

/* ------------------------------------------------------------------- build */

/**
 * Populate the 90-340 m band around the level.
 *
 * @param {object} api  the props api bundle (ctx, rng, probe, batcher, mats)
 * @param {{inner:number, baseY:number}} opts
 * @returns {object} counts, for the build report
 */
export function buildBackdrop(api, { inner = 95, baseY = 0 } = {}) {
  const { rng, probe } = api;
  const solids = [];
  const steels = [];
  const trees = [];
  const hazes = [];
  const stats = { pylons: 0, tanks: 0, sheds: 0, chimneys: 0, towers: 0, trees: 0 };

  /** Ground height at (x,z), falling back to the level's datum. */
  const groundAt = (x, z) => {
    const h = probe.ground(x, z, baseY + 90);
    return h ? h.point.y : baseY;
  };
  const put = (list, geo, x, z, yaw, y = null) => {
    const gy = y ?? groundAt(x, z);
    geo.rotateY(yaw);
    geo.translate(x, gy, z);
    list.push(geo);
  };
  const polar = (r, a) => [Math.cos(a) * r, Math.sin(a) * r];

  /* --- a transmission line marching out of frame ------------------------- */
  // One line, laid on a bearing, with the towers getting smaller as they go:
  // a receding row of identical objects is the strongest depth cue there is.
  const lineA = rng.range(0, Math.PI * 2);
  const perp = lineA + Math.PI / 2;
  const tips = [];
  for (let i = 0; i < 7; i++) {
    const r = inner + 18 + i * rng.range(46, 58);
    if (r > 420) break;
    const drift = (i - 3) * 26;
    const x = Math.cos(lineA) * r + Math.cos(perp) * drift;
    const z = Math.sin(lineA) * r + Math.sin(perp) * drift;
    const h = 34 - i * 0.6;
    put(steels, pylon(rng, h), x, z, rng.range(0, Math.PI * 2));
    tips.push({ x, y: groundAt(x, z) + h * 0.70, z, w: h * 0.50, yaw: 0 });
    stats.pylons++;
  }
  // conductors between the first few towers — a sagging line reads instantly
  for (let i = 0; i + 1 < Math.min(tips.length, 4); i++) {
    const a = tips[i], b = tips[i + 1];
    for (const s of [-1, 0, 1]) {
      const off = s * a.w * 0.5;
      const dx = b.x - a.x, dz = b.z - a.z;
      const len = Math.hypot(dx, dz) || 1;
      const nx = -dz / len, nz = dx / len;
      const p1 = new THREE.Vector3(a.x + nx * off, a.y, a.z + nz * off);
      const p2 = new THREE.Vector3(b.x + nx * off, b.y, b.z + nz * off);
      const pts = catenary(p1, p2, 0.055, 7);
      const g = tubeAlong(pts, 0.22, 4);
      steels.push(g);
    }
  }

  /* --- tank farm --------------------------------------------------------- */
  const farmA = lineA + rng.range(1.6, 2.4);
  const [fx, fz] = polar(inner + rng.range(28, 46), farmA);
  const rows = 3, cols = 3;
  for (let i = 0; i < rows * cols; i++) {
    if (rng.bool(0.18)) continue;
    const gx = ((i % cols) - (cols - 1) / 2) * 26 + rng.jit(3);
    const gz = (((i / cols) | 0) - (rows - 1) / 2) * 26 + rng.jit(3);
    const r = rng.range(6.5, 10.5);
    const h = r * rng.range(1.05, 1.7);
    const c = Math.cos(farmA), s = Math.sin(farmA);
    put(solids, tank(rng, r, h), fx + gx * c - gz * s, fz + gx * s + gz * c, rng.range(0, 6.28));
    stats.tanks++;
  }
  // bund wall around the farm
  const bund = cyl(60, 60, 3.2, 26, true);
  xf(bund, 0, 1.6, 0);
  put(solids, bund, fx, fz, 0);

  /* --- water tower ------------------------------------------------------- */
  {
    const [wx, wz] = polar(inner + rng.range(20, 60), lineA + rng.range(-1.3, -0.6));
    put(steels, waterTower(rng.range(23, 29), rng.range(4.6, 5.8)), wx, wz, rng.range(0, 6.28));
    stats.towers++;
  }

  /* --- chimneys with plumes ---------------------------------------------- */
  const chimA = lineA + rng.range(2.6, 3.6);
  const windX = Math.cos(chimA + 1.1), windZ = Math.sin(chimA + 1.1);
  for (let i = 0; i < 2; i++) {
    const [cx, cz] = polar(inner + rng.range(70, 130), chimA + i * rng.range(0.12, 0.22));
    const h = rng.range(48, 70);
    put(solids, chimney(h), cx, cz, 0);
    stats.chimneys++;
    const gy = groundAt(cx, cz);
    // The plume leans downwind and grows as it rises. Static quads facing the
    // level centre: at 200 m the parallax across the playable area is under two
    // degrees, so nothing gives the billboard away.
    for (let k = 0; k < 5; k++) {
      const t = k / 4;
      const px = cx + windX * t * rng.range(16, 26) * (k + 1) * 0.4;
      const pz = cz + windZ * t * rng.range(16, 26) * (k + 1) * 0.4;
      const size = 14 + t * 40;
      const fx2 = -px, fz2 = -pz;
      hazes.push(billboard(px, gy + h * 0.92 + t * 26 - size * 0.5, pz, size, size, fx2, fz2));
    }
  }
  // low dust haze sitting over the tank farm, which stops the band looking
  // like cut-outs on glass
  for (let i = 0; i < 3; i++) {
    const hx = fx + rng.jit(50), hz = fz + rng.jit(50);
    hazes.push(billboard(hx, groundAt(hx, hz) + 2, hz, rng.range(60, 95), rng.range(16, 26), -hx, -hz));
  }

  /* --- low sheds, the band nearest the fence ----------------------------- */
  for (let i = 0; i < 9; i++) {
    const a = rng.range(0, Math.PI * 2);
    const r = inner + rng.range(2, 48);
    const [sx, sz] = polar(r, a);
    put(solids, shed(rng, rng.range(22, 46), rng.range(12, 24), rng.range(6, 11)),
      sx, sz, a + rng.jit(0.6));
    stats.sheds++;
  }

  /* --- treeline ---------------------------------------------------------- */
  // A broken ring at 240-330 m. Panels overlap by a third and vary in height, so
  // the horizon gets an irregular edge instead of a ruled line.
  const panels = 46;
  for (let i = 0; i < panels; i++) {
    const a = (i / panels) * Math.PI * 2 + rng.jit(0.035);
    if (rng.bool(0.16)) continue;                 // gaps: a solid ring is a wall
    const r = 250 + rng.range(0, 78);
    const [tx, tz] = polar(r, a);
    const w = r * (Math.PI * 2 / panels) * 1.45;
    const h = rng.range(11, 19);
    const gy = groundAt(tx, tz);
    const uOff = rng.range(0, 0.6);
    trees.push(billboard(tx, gy - 1.2, tz, w, h, -tx, -tz, uOff, 0.4));
    stats.trees++;
  }

  emit(api, FAR_CONCRETE, solids, 0.09);
  emit(api, FAR_STEEL, steels, 0.35);
  if (trees.length) {
    api.batcher.merge('treeline', mergeAll(trees), api.mats.get('treeline'),
      { solid: false, castShadow: false, receiveShadow: false });
  }
  if (hazes.length) {
    api.batcher.merge('haze', mergeAll(hazes), api.mats.get('haze'),
      { solid: false, castShadow: false, receiveShadow: false });
  }
  return stats;
}
