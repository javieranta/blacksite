import * as THREE from 'three';
import { MATERIAL_ORDER } from './SoldierMaterials.js';

/**
 * OWNER: ai agent.
 *
 * The combatant body: a 20-bone skeleton and a rigidly-skinned procedural mesh
 * built from primitives, merged down to ONE SkinnedMesh PER MATERIAL — four
 * draw calls for a whole soldier, geometry shared across the squad.
 *
 * Conventions that the rest of the AI depends on:
 *   - the character faces -Z, its right side is +X, feet at y = 0
 *   - every bone's bind rotation is identity, so a bone's bind world matrix is a
 *     pure translation. That makes "author the part in character space, name the
 *     bone" a valid way to skin, and makes the IK trivially invertible.
 *   - the bind direction of every limb bone is -Y (arms hang, legs stand), so
 *     one IK routine serves arms and legs alike.
 *   - the rifle is skinned to the right hand bone, so it costs no extra draw
 *     call and no extra matrix.
 *
 * Crown of the helmet lands at 1.80 m; shoulder-to-elbow 0.285, elbow-to-wrist
 * 0.265, hip-to-knee 0.445, knee-to-ankle 0.425 — real 50th-percentile male
 * proportions, not a stack of cubes.
 */

/* ------------------------------------------------------------------ bones --- */

export const BONES = [
  ['root',   -1, 0, 0, 0],
  ['pelvis',  0, 0, 0.965, 0],
  ['spine',   1, 0, 0.135, 0],
  ['chest',   2, 0, 0.185, 0],
  ['neck',    3, 0, 0.225, 0],
  ['head',    4, 0, 0.095, 0],
  ['clavR',   3, 0.045, 0.145, 0],
  ['armR',    6, 0.155, 0.015, 0],
  ['foreR',   7, 0, -0.285, 0],
  ['handR',   8, 0, -0.265, 0],
  ['clavL',   3, -0.045, 0.145, 0],
  ['armL',   10, -0.155, 0.015, 0],
  ['foreL',  11, 0, -0.285, 0],
  ['handL',  12, 0, -0.265, 0],
  ['thighR',  1, 0.098, -0.055, 0],
  ['calfR',  14, 0, -0.445, 0],
  ['footR',  15, 0, -0.425, 0],
  ['thighL',  1, -0.098, -0.055, 0],
  ['calfL',  17, 0, -0.445, 0],
  ['footL',  18, 0, -0.425, 0],
];

export const B = {};
BONES.forEach((b, i) => { B[b[0]] = i; });

/** Bind-pose world position of every bone, in character space. */
export const BIND = (() => {
  const out = [];
  for (let i = 0; i < BONES.length; i++) {
    const [, p, x, y, z] = BONES[i];
    const base = p < 0 ? { x: 0, y: 0, z: 0 } : out[p];
    out.push({ x: base.x + x, y: base.y + y, z: base.z + z });
  }
  return out;
})();

/** Bone-space anchors the animation layer needs. */
export const RIG = {
  /** Rifle is authored with its grip exactly on the right wrist. */
  rifleGrip: new THREE.Vector3(BIND[B.handR].x, BIND[B.handR].y, BIND[B.handR].z),
  muzzleLocal: new THREE.Vector3(0, 0.077, -0.545),
  /**
   * The support hand sits well back on the handguard — a modern "C-clamp close
   * to the magwell" grip. That is not just a style choice: with the butt in the
   * shoulder pocket, a foregrip further out puts the support hand at 0.53 m from
   * the left shoulder, which is 96% of arm length, and the IK has no choice but
   * to lock the elbow straight. Pulling it back to 0.185 gives the arm a real
   * bend to solve for.
   */
  foreGripLocal: new THREE.Vector3(0, 0.016, -0.185),
  buttLocal: new THREE.Vector3(0, 0.062, 0.215),
  /**
   * Ejection port, in the hand bone's frame — right of the receiver, level with
   * the bore, just behind the chamber. Brass is thrown from HERE, not from the
   * muzzle; see the note in Combatant._shoot.
   */
  ejectLocal: new THREE.Vector3(0.040, 0.082, -0.028),
  /** And thrown out to the shooter's right, up a little, and slightly back. */
  ejectDir: new THREE.Vector3(0.86, 0.40, 0.32),
  sightLocal: new THREE.Vector3(0, 0.148, -0.085),
  upperArm: 0.285,
  foreArm: 0.265,
  thigh: 0.445,
  calf: 0.425,
  eyeLocal: new THREE.Vector3(0, 0.062, -0.10),   // relative to head bone
};

/** name, bone, local centre, half extents, damage multiplier. */
export const HITBOXES = [
  ['head',    B.head,   0, 0.075, 0,     0.118, 0.130, 0.128, 2.1],
  ['chest',   B.chest,  0, 0.020, 0,     0.205, 0.135, 0.140, 1.0],
  ['abdomen', B.spine,  0, 0.000, 0,     0.170, 0.105, 0.120, 1.0],
  ['pelvis',  B.pelvis, 0, -0.020, 0,    0.175, 0.105, 0.115, 1.0],
  ['armR',    B.armR,   0, -0.140, 0,    0.066, 0.158, 0.066, 0.75],
  ['armL',    B.armL,   0, -0.140, 0,    0.066, 0.158, 0.066, 0.75],
  ['foreR',   B.foreR,  0, -0.130, 0,    0.054, 0.152, 0.054, 0.75],
  ['foreL',   B.foreL,  0, -0.130, 0,    0.054, 0.152, 0.054, 0.75],
  ['thighR',  B.thighR, 0, -0.220, 0,    0.100, 0.235, 0.100, 0.75],
  ['thighL',  B.thighL, 0, -0.220, 0,    0.100, 0.235, 0.100, 0.75],
  ['calfR',   B.calfR,  0, -0.210, 0,    0.075, 0.225, 0.075, 0.75],
  ['calfL',   B.calfL,  0, -0.210, 0,    0.075, 0.225, 0.075, 0.75],
];

/* ------------------------------------------------------------- kit tints --- */

/**
 * Per-part albedo multipliers, baked into a vertex colour attribute.
 *
 * Four material families is the right number of draw calls, but it is the wrong
 * number of *values*: helmet, plate carrier, pouches, knee pads, gloves and
 * boots all landed on one `gear` texture, so the entire load-bearing kit painted
 * at a single lightness and the man read as a torso-shaped lump with a gun. In
 * silhouette that is the difference between "soldier" and "mannequin", and no
 * amount of normal-map detail rescues it — separation in a silhouette is a
 * *value* problem.
 *
 * A vertex colour costs three bytes a vertex and zero draw calls, and three
 * multiplies the albedo by it before anything else touches the surface, so this
 * is a free per-part value ladder on top of the shared textures. Values are
 * linear multipliers on an albedo that already sits at 0.08-0.19, so even the
 * brightest entry stays well inside a plausible dielectric range.
 *
 * The ladder, lightest to darkest: helmet shell -> webbing/yokes -> gloves ->
 * smock -> trousers -> pouches -> plate carrier -> pads -> boots. That puts a
 * light mass at the top of the figure, a dark band across the chest and dark
 * feet, which is the value structure a real photograph of a rifleman has.
 */
export const KIT = {
  smock:    [1.10, 1.09, 1.06],
  trouser:  [0.86, 0.87, 0.88],
  /**
   * The helmet was 1.62 — the highest value on the figure by a wide margin, on a
   * shell that is also the largest single unbroken area. Against a night rig that
   * is what makes a man read as "a pale, high-value figure while every surface
   * around him sits in deep night blue": his brightest, biggest facet is 25%
   * lighter than anything he is standing near. Pulled down so the helmet is still
   * the lightest piece of KIT but no longer competes with lit concrete.
   */
  helmet:   [1.30, 1.29, 1.20],
  earcup:   [0.86, 0.88, 0.92],
  webbing:  [1.34, 1.28, 1.10],
  yoke:     [1.24, 1.20, 1.06],
  carrier:  [0.66, 0.70, 0.72],
  pouch:    [1.16, 1.02, 0.80],
  pad:      [0.62, 0.64, 0.68],
  /**
   * THE GLOVES ARE NOW THE LIGHTEST THING ON THE MAN, and that is the fix for
   * "the arms terminate in the weapon".
   *
   * Measured: at 7 m a combatant is 220 px tall, which is 8 mm per pixel, so a
   * 90 mm hand is eleven pixels across — about 130 px of area. The harness says
   * 170-370 px of glove survive into the frame across both hands, i.e. the
   * geometry is very nearly all visible already. Nothing was missing. What was
   * missing was CONTRAST: a twelve-pixel blob at 0.15 albedo, between a 0.19
   * albedo sleeve and a 0.06 albedo receiver, is a smudge, and a smudge is
   * exactly what a reviewer describes as "no hands". At this size the only cue
   * that survives is value, so the glove has to be the brightest thing in the
   * region. 2.05 on a gear tone of 0.10-0.17 lands at 0.21-0.35 albedo, which is
   * a light coyote nomex glove and is physically ordinary.
   */
  glove:    [2.05, 1.98, 1.88],
  boot:     [0.54, 0.55, 0.58],
  belt:     [0.92, 0.90, 0.84],
  skin:     [1.00, 1.00, 1.00],
  gunSteel: [1.00, 1.00, 1.00],
  gunPoly:  [0.72, 0.73, 0.76],
  gunFurn:  [0.88, 0.86, 0.80],
  optic:    [1.00, 1.00, 1.00],
  lens:     [1.00, 1.00, 1.00],
};

/* -------------------------------------------------------------- geo utils --- */

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

/**
 * Taper a part along Y. `cx`/`cz` are the part's own axis in character space —
 * the scale happens about that axis, so an off-centre part (a boot, a magazine)
 * narrows in place instead of sliding toward the origin.
 */
function taperY(g, sBot, sTop, cx = 0, cz = 0) {
  const p = g.attributes.position;
  let y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < p.count; i++) { const y = p.getY(i); if (y < y0) y0 = y; if (y > y1) y1 = y; }
  const span = Math.max(1e-6, y1 - y0);
  for (let i = 0; i < p.count; i++) {
    const t = (p.getY(i) - y0) / span;
    const s = sBot + (sTop - sBot) * t;
    p.setX(i, cx + (p.getX(i) - cx) * s);
    p.setZ(i, cz + (p.getZ(i) - cz) * s);
  }
  g.computeVertexNormals();
  return g;
}

/** Bow a flat panel around a vertical axis so armour hugs the torso. */
function curveX(g, k, cx = 0) {
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i) - cx;
    p.setZ(i, p.getZ(i) + x * x * k);
  }
  g.computeVertexNormals();
  return g;
}

/** A tapered capsule between two character-space points. */
function limb(ax, ay, az, bx, by, bz, rA, rB, radial = 10) {
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const len = Math.hypot(dx, dy, dz);
  const r = Math.max(rA, rB);
  const g = new THREE.CapsuleGeometry(r, Math.max(0.01, len - r * 0.55), 5, radial);
  taperY(g, rA / r, rB / r);
  _v.set(dx / len, dy / len, dz / len);
  _q.setFromUnitVectors(_up, _v);
  _m.compose(new THREE.Vector3((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2), _q, new THREE.Vector3(1, 1, 1));
  g.applyMatrix4(_m);
  return g;
}

function blob(r, x, y, z, sx = 1, sy = 1, sz = 1, seg = 12) {
  const g = new THREE.SphereGeometry(r, seg, Math.max(6, seg >> 1));
  g.scale(sx, sy, sz);
  g.translate(x, y, z);
  return g;
}

function box(w, h, d, x, y, z, rx = 0, ry = 0, rz = 0, seg = 1) {
  const g = new THREE.BoxGeometry(w, h, d, seg, seg, seg);
  if (rx || ry || rz) g.rotateX(rx), g.rotateY(ry), g.rotateZ(rz);
  g.translate(x, y, z);
  return g;
}

function tube(r0, r1, len, x, y, z, axis = 'z', radial = 12) {
  const g = new THREE.CylinderGeometry(r0, r1, len, radial, 1, false);
  if (axis === 'z') g.rotateX(Math.PI / 2);
  else if (axis === 'x') g.rotateZ(Math.PI / 2);
  g.translate(x, y, z);
  return g;
}

function dome(r, x, y, z, sx, sy, sz, theta = 2.0) {
  const g = new THREE.SphereGeometry(r, 20, 14, 0, Math.PI * 2, 0, theta);
  g.scale(sx, sy, sz);
  g.translate(x, y, z);
  return g;
}

/* ------------------------------------------------------------- the skinner -- */

class Skinner {
  constructor() {
    this.groups = new Map();
    for (const f of MATERIAL_ORDER) {
      this.groups.set(f, { pos: [], nrm: [], uv: [], col: [], si: [], sw: [], idx: [], verts: 0, tris: 0 });
    }
    /**
     * Named index ranges inside a family, so a harness can render one sub-part
     * of a merged mesh on its own.
     *
     * This exists because of the hands. "Are the hands on the weapon" is a
     * question about pixels, and there was no way to ask it: the gloves are
     * merged into the shared `gear` mesh along with the helmet, carrier, pouches
     * and boots, so nothing could isolate them. `setDrawRange` can — but only
     * over ONE contiguous span, which is why buildSoldierTemplate() now emits the
     * gloves before any other `gear` part. tools/aicheck.mjs uses
     *   geometry.setDrawRange(0, ranges.glove.count)              -> hands only
     *   geometry.setDrawRange(ranges.glove.count, rest)           -> no hands
     * and diffs the two against the real frame. Zero runtime cost: it is a pair
     * of integers recorded at build time.
     */
    this.ranges = {};
  }

  /** Record the index range that `fn` appends to `family`. */
  mark(family, name, fn) {
    const G = this.groups.get(family);
    const start = G.idx.length;
    fn();
    this.ranges[name] = { family, start, count: G.idx.length - start };
    return this;
  }

  /**
   * @param family  material family key
   * @param g       geometry already placed in character space
   * @param bone    primary bone index
   * @param o       { uv:number, uo:[u,v], blend:{bone, y0, y1}, tint:[r,g,b] }
   */
  add(family, g, bone, o = {}) {
    const G = this.groups.get(family);
    const pos = g.attributes.position, nrm = g.attributes.normal, uv = g.attributes.uv;
    const index = g.index;
    const uvs = o.uv ?? 4.0;
    const uo = o.uo ?? [0, 0];
    const bl = o.blend;
    const tint = o.tint ?? KIT.skin;
    const base = G.verts;

    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      G.pos.push(x, y, z);
      G.nrm.push(nrm.getX(i), nrm.getY(i), nrm.getZ(i));
      G.uv.push(uv.getX(i) * uvs + uo[0], uv.getY(i) * uvs + uo[1]);
      G.col.push(tint[0], tint[1], tint[2]);
      let t = 0;
      if (bl) t = Math.min(1, Math.max(0, (y - bl.y0) / (bl.y1 - bl.y0)));
      G.si.push(bone, bl ? bl.bone : 0, 0, 0);
      G.sw.push(1 - t, t, 0, 0);
    }
    if (index) {
      for (let i = 0; i < index.count; i++) G.idx.push(base + index.getX(i));
      G.tris += index.count / 3;
    } else {
      for (let i = 0; i < pos.count; i++) G.idx.push(base + i);
      G.tris += pos.count / 3;
    }
    G.verts += pos.count;
    g.dispose();
    return this;
  }

  finish() {
    const out = { __ranges: this.ranges };
    let tris = 0;
    for (const [family, G] of this.groups) {
      if (!G.verts) continue;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(G.pos, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(G.nrm, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(G.uv, 2));
      g.setAttribute('color', new THREE.Float32BufferAttribute(G.col, 3));
      g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(G.si, 4));
      g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(G.sw, 4));
      g.setIndex(G.idx);
      // Animated bounds: a fixed generous sphere keeps frustum culling correct
      // for every pose (and for a collapsed ragdoll) without per-frame work.
      g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.9, 0), 1.55);
      g.boundingBox = new THREE.Box3(new THREE.Vector3(-1.4, -0.4, -1.4), new THREE.Vector3(1.4, 2.1, 1.4));
      out[family] = g;
      tris += G.tris;
    }
    out.__tris = Math.round(tris);
    return out;
  }
}

/* ---------------------------------------------------------------- the body -- */

function buildTorso(s) {
  const yHip = BIND[B.pelvis].y, ySpine = BIND[B.spine].y, yChest = BIND[B.chest].y;
  // Trunk: three overlapping ovoids, weights blended vertically so the spine
  // actually bends instead of shearing at the seams.
  s.add('fatigue', taperY(blob(0.150, 0, yHip - 0.015, 0, 1.16, 0.72, 0.86, 14), 0.92, 1.0), B.pelvis,
    { uv: 1.8, tint: KIT.trouser });
  s.add('fatigue', taperY(blob(0.152, 0, ySpine, 0, 1.10, 0.80, 0.82, 14), 0.98, 1.02), B.spine,
    { uv: 1.8, tint: KIT.smock, blend: { bone: B.chest, y0: ySpine, y1: yChest } });
  s.add('fatigue', taperY(blob(0.176, 0, yChest + 0.01, 0, 1.14, 0.86, 0.80, 16), 0.92, 0.96), B.chest,
    { uv: 1.8, tint: KIT.smock, blend: { bone: B.spine, y0: yChest, y1: ySpine } });
  // collar of the smock
  s.add('fatigue', tube(0.086, 0.078, 0.075, 0, BIND[B.neck].y - 0.02, 0, 'y', 14), B.chest,
    { uv: 2, tint: KIT.smock });
  s.add('gear', taperY(blob(0.055, 0, BIND[B.neck].y + 0.035, 0, 1, 1.2, 1, 10), 1, 1), B.neck,
    { uv: 2, tint: KIT.earcup });
}

function buildCarrier(s) {
  const y = BIND[B.chest].y;
  /**
   * Front + rear plates, bowed round the ribs, with a moulded cummerbund.
   *
   * The bow constant is not a style dial — it is solved. The chest ovoid is
   * r=0.176 scaled (1.14, ., 0.80), so its surface at the plate's edge
   * (x = ±0.15) sits at z = -0.1408 * sqrt(1 - (0.15/0.2006)^2) = -0.0935,
   * while the plate's own front face is at -0.148. A bow of k gives the edge
   * +0.0225k of relief, so k must be at least (0.148 - 0.0935)/0.0225 = 2.4 for
   * the plate edge to stay ON the ribs. At the old 0.55 the corners of the
   * carrier floated 4.2 cm clear of the torso — visible daylight under the
   * armour from any three-quarter angle.
   */
  s.add('gear', curveX(box(0.300, 0.360, 0.040, 0, y + 0.010, -0.134, 0, 0, 0, 6), 2.5), B.chest,
    { uv: 2.2, tint: KIT.carrier });
  s.add('gear', curveX(box(0.300, 0.350, 0.038, 0, y + 0.015, 0.136, 0, 0, 0, 6), -2.5), B.chest,
    { uv: 2.2, uo: [0.3, 0.6], tint: KIT.carrier });
  s.add('gear', tube(0.204, 0.196, 0.135, 0, BIND[B.spine].y - 0.015, 0, 'y', 18), B.spine,
    { uv: 2.4, tint: KIT.carrier });
  // shoulder yokes
  for (const sg of [1, -1]) {
    const bone = sg > 0 ? B.armR : B.armL;
    s.add('gear', blob(0.088, sg * 0.196, BIND[B.armR].y + 0.012, 0, 1.0, 0.78, 1.06, 12), bone,
      { uv: 2, tint: KIT.yoke });
    s.add('gear', curveX(box(0.092, 0.150, 0.032, sg * 0.115, y + 0.150, -0.078, 0, 0, sg * 0.30, 3), 0.4, sg * 0.115), B.chest,
      { uv: 2, tint: KIT.webbing });
  }
  // triple rifle-mag pouch, admin pouch, radio, dump pouch
  for (let i = -1; i <= 1; i++) {
    s.add('gear', box(0.078, 0.148, 0.070, i * 0.084, BIND[B.spine].y - 0.005, -0.166, 0.06, 0, 0, 2),
      B.spine, { uv: 2.6, uo: [i * 0.2, 0], tint: KIT.pouch });
    s.add('gear', box(0.070, 0.020, 0.058, i * 0.084, BIND[B.spine].y + 0.072, -0.172, 0.06, 0, 0, 1),
      B.spine, { uv: 2, tint: KIT.webbing });
  }
  s.add('gear', box(0.104, 0.126, 0.070, 0.196, BIND[B.spine].y + 0.020, 0.010, 0, 0, -0.10, 2), B.spine,
    { uv: 2.4, tint: KIT.pouch });
  s.add('gear', box(0.118, 0.156, 0.062, -0.075, y + 0.020, 0.150, 0, 0, 0.06, 2), B.chest,
    { uv: 2.4, tint: KIT.pouch });
  s.add('steel', tube(0.008, 0.008, 0.115, -0.075, y + 0.150, 0.150, 'y', 6), B.chest,
    { uv: 1, tint: KIT.gunSteel });   // antenna
  // belt + drop-leg holster
  s.add('gear', tube(0.166, 0.160, 0.062, 0, BIND[B.pelvis].y - 0.030, 0, 'y', 18), B.pelvis,
    { uv: 2.4, tint: KIT.belt });
  s.add('gear', box(0.078, 0.170, 0.062, 0.150, 0.800, 0.015, 0, 0, -0.06, 2), B.thighR,
    { uv: 2.4, tint: KIT.pouch });
  s.add('steel', box(0.028, 0.070, 0.034, 0.150, 0.880, 0.030, -0.10, 0, -0.06), B.thighR,
    { uv: 1, tint: KIT.gunSteel });
}

function buildArms(s) {
  for (const sg of [1, -1]) {
    const x = sg * 0.200;
    const aUp = sg > 0 ? B.armR : B.armL;
    const aFo = sg > 0 ? B.foreR : B.foreL;
    const yS = BIND[B.armR].y, yE = yS - RIG.upperArm, yW = yE - RIG.foreArm;
    s.add('fatigue', limb(x, yS, 0, x, yE, 0, 0.066, 0.053, 10), aUp,
      { uv: 2, uo: [sg * 0.3, 0], tint: KIT.smock });
    s.add('fatigue', limb(x, yE, 0, x, yW, 0, 0.055, 0.041, 10), aFo,
      { uv: 2, uo: [0, sg * 0.4], tint: KIT.smock });
    // Elbow pad. Same job as the knee pad: a hard dark mass on the outside of a
    // joint is what tells the eye there IS a joint there, and without one an
    // upper arm and a forearm at 15 deg read as one bent sausage.
    s.add('gear', blob(0.052, x, yE + 0.004, -0.044, 1.0, 1.16, 0.72, 10), aFo,
      { uv: 2, tint: KIT.pad });
    // rolled cuff, on the forearm so it stays put when the wrist breaks over
    s.add('gear', tube(0.048, 0.046, 0.050, x, yW + 0.020, 0, 'y', 10), aFo,
      { uv: 2, tint: KIT.webbing });
  }
  // The hands are emitted first, from buildSoldierTemplate — see the note there.
}

/**
 * One finger, as ONE CONTINUOUS SURFACE swept through the three joints.
 *
 * It used to be two capsules plus a knuckle sphere: three closed solids per
 * finger, thirty per pair of hands. The viewmodel agent measured the consequence
 * of exactly that construction on the first-person hand and it is worth quoting,
 * because it is the same geometry and therefore the same defect — the hand mask
 * came back with "120 connected components where a hand has one", and the review
 * called it "a stack of unskinned PVC capsules … visible gaps beside the grip …
 * every joint capped by a teal ring".
 *
 * Both symptoms follow from the closed solids. Two capsules meeting at a bent
 * joint interpenetrate on the inside of the bend and GAP on the outside, so the
 * finger comes apart exactly where the eye looks for articulation; and every cap
 * is a ring of near-silhouette normals, which is precisely the geometry a Fresnel
 * rim term lights hardest — hence a bright ring at every joint rather than along
 * the finger.
 *
 * A tube lofted along a Catmull-Rom through the same three joints has no internal
 * caps and cannot gap, because there is no seam between the phalanges to come
 * apart. The taper is applied per ring rather than per segment, so the finger
 * still narrows from knuckle to tip, and the only cap left is the fingertip —
 * where a rounded end is correct anatomy. ~90 triangles a finger, against ~110
 * for the three solids it replaces.
 */
const _dc = new THREE.Vector3();
const _dv = new THREE.Vector3();
function digit(ax, ay, az, mx, my, mz, bx, by, bz, rA, rB, radial = 6, seg = 6) {
  const curve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(ax, ay, az),
    new THREE.Vector3(mx, my, mz),
    new THREE.Vector3(bx, by, bz),
  ]);
  const g = new THREE.TubeGeometry(curve, seg, rA, radial, false);
  // TubeGeometry lays out (seg+1) rings of (radial+1) vertices and places ring i
  // at curve.getPointAt(i / seg), so the taper can be applied by pulling each
  // ring toward its own centre. Same parameterisation, so the centres are exact.
  const pos = g.attributes.position;
  const ring = radial + 1;
  for (let i = 0; i <= seg; i++) {
    const t = i / seg;
    curve.getPointAt(t, _dc);
    /**
     * Knuckle as DISPLACEMENT, not as a bolted-on sphere.
     *
     * The sphere this replaces was there for a good reason — at 4 m a smooth tube
     * reads as a mitten and the row of knuckles is what says "fingers wrapped
     * round something" — but a sphere at a joint is another closed solid and
     * another silhouette ring for the rim to catch. A gaussian bulge in the radius
     * profile near the proximal end gives the same relief on the one surface, so
     * it adds shading without adding an outline.
     */
    const knuckle = 1 + 0.24 * Math.exp(-(((t - 0.10) / 0.16) ** 2));
    const f = ((rA + (rB - rA) * t) / rA) * knuckle;
    for (let j = 0; j < ring; j++) {
      const k = i * ring + j;
      _dv.fromBufferAttribute(pos, k).sub(_dc).multiplyScalar(f).add(_dc);
      pos.setXYZ(k, _dv.x, _dv.y, _dv.z);
    }
  }
  g.computeVertexNormals();
  return g;
}

function finger(s, bone, ax, ay, az, mx, my, mz, bx, by, bz, r = 0.0132) {
  s.add('gear', digit(ax, ay, az, mx, my, mz, bx, by, bz, r, r * 0.80), bone,
    { uv: 3.0, tint: KIT.glove });
  // The fingertip is the one place a cap belongs. Concentric with the tube's last
  // ring, so it cannot separate from it.
  s.add('gear', blob(r * 0.80, bx, by, bz, 1, 1, 1, 6), bone, { uv: 3.0, tint: KIT.glove });
}

/**
 * The firing hand, wrapped around the pistol grip.
 *
 * The wrist bone sits at (0.200, 0.895, 0) but the grip it holds is at
 * (0.200, 0.867, 0.052) — 5 cm behind and 3 cm below, which is exactly where a
 * hand extending from the wrist lands. Authoring the glove around the *grip*
 * rather than around the *joint* is the whole fix: previously the palm was a
 * blob centred on the wrist, so the hand read as hovering 5 cm behind the gun
 * with no fingers on it at all.
 *
 * Everything is skinned rigid to handR, and the rifle is too, so the grip is
 * exact in every pose — there is no IK error to accumulate.
 */
function buildFiringHand(s) {
  const H = B.handR;
  const gx = RIG.rifleGrip.x, gy = RIG.rifleGrip.y, gz = RIG.rifleGrip.z;
  // Grip box: 0.048 x 0.116 x 0.062 centred (gx, gy-0.028, gz+0.052).
  // Front strap at z = gz+0.021, back strap at gz+0.083.
  const front = gz + 0.012;      // finger centreline, just clear of the frontstrap
  const back = gz + 0.078;

  // Palm heel wrapping the outboard face of the grip. Its outer surface reaches
  // gx+0.055, which is 24 mm proud of the receiver's own gx+0.031 — the back of
  // the hand is the near-side mass, and it must not be inside the gun.
  s.add('gear', taperY(blob(0.050, gx + 0.026, gy - 0.022, gz + 0.050, 0.68, 1.30, 1.08, 10), 0.92, 1.0,
    gx + 0.026, gz + 0.050), H, { uv: 2.2, tint: KIT.glove });
  // Web of the thumb, filling the corner behind the backstrap.
  s.add('gear', blob(0.034, gx + 0.016, gy + 0.004, back + 0.004, 1.05, 0.90, 0.95, 10), H,
    { uv: 2.2, tint: KIT.glove });
  /**
   * Back-of-hand plate. This used to be KIT.pad — 0.62, the darkest value on the
   * figure — laid across the largest face of the glove. At eleven pixels across
   * that is not "an internal edge", it is most of the hand painted the same value
   * as the weapon behind it, which is precisely why the hand stopped reading.
   * Mid-value webbing keeps a break in the surface without eating the contrast.
   */
  s.add('gear', box(0.022, 0.076, 0.062, gx + 0.040, gy - 0.014, gz + 0.044, 0.10, 0, 0.12, 2), H,
    { uv: 2.6, tint: KIT.webbing });
  /**
   * Wrist cuff. The arm and the hand are the same family and, at range, nearly
   * the same value, so there was no visual event at the wrist and the limb read
   * as one continuous tube that happened to end at the gun. A pale cuff ring is a
   * hard horizontal break at exactly the joint a viewer looks for.
   */
  s.add('gear', tube(0.040, 0.036, 0.030, gx + 0.010, gy + 0.028, gz + 0.062, 'y', 10), H,
    { uv: 2.4, tint: KIT.glove });

  // Three fingers curled round the frontstrap, plus the index on the trigger.
  const rows = [[-0.026, 0.0136], [-0.052, 0.0132], [-0.076, 0.0118]];
  for (const [dy, r] of rows) {
    finger(s, H,
      gx + 0.030, gy + dy + 0.004, gz + 0.044,     // knuckle, proud of the grip
      gx + 0.014, gy + dy, front,                  // mid joint, round the front
      gx - 0.020, gy + dy - 0.004, front + 0.006,  // tip, inboard
      r);
  }
  // Trigger finger: forward off the grip into the trigger guard at z = gz-0.010.
  finger(s, H,
    gx + 0.030, gy - 0.002, gz + 0.040,
    gx + 0.018, gy - 0.004, gz + 0.006,
    gx + 0.002, gy + 0.002, gz - 0.016,
    0.0138);
  // Thumb, laid over the top of the backstrap toward the safety. It crosses the
  // receiver's top line, which is the one hand shape that is unambiguous in
  // silhouette from the side.
  finger(s, H,
    gx + 0.028, gy + 0.016, back,
    gx + 0.006, gy + 0.026, back - 0.020,
    gx - 0.016, gy + 0.024, back - 0.044,
    0.0152);
}

/**
 * The support hand, a closed fist around the vertical foregrip.
 *
 * SoldierAnim derives handL's world orientation straight from the rifle basis
 * (see _placeWeapon), so this bone's local frame IS the rifle's frame: +X the
 * rifle's right, +Y up, -Z down the bore. The foregrip post therefore stands
 * along local Y at the bone origin, and a fist authored around that post grips
 * it correctly whatever the rifle is doing. The old code hard-coded
 * handL.rotation to (-0.72, 0, 0.25) and authored a mirrored copy of the firing
 * glove, which is why the support hand sat near the handguard rather than on it.
 */
function buildSupportHand(s) {
  const H = B.handL;
  const ox = BIND[B.handL].x, oy = BIND[B.handL].y, oz = BIND[B.handL].z;
  // Foregrip post: 0.030 x 0.082 x 0.036 centred on the bone origin, so it
  // spans x ±0.015, y ±0.041, z ±0.018. The fist closes around it in XZ.
  const fz = oz - 0.028;          // finger centreline, forward of the post

  s.add('gear', taperY(blob(0.049, ox - 0.023, oy + 0.002, oz + 0.004, 0.76, 1.16, 1.04, 10), 0.94, 1.0,
    ox - 0.023, oz + 0.004), H, { uv: 2.2, tint: KIT.glove });
  s.add('gear', blob(0.032, ox - 0.012, oy + 0.032, oz + 0.012, 1.0, 0.88, 0.95, 10), H,
    { uv: 2.2, tint: KIT.glove });
  // Mid-value, not KIT.pad — same reasoning as the firing hand's back plate.
  s.add('gear', box(0.021, 0.074, 0.056, ox - 0.038, oy - 0.004, oz - 0.004, 0.08, 0, -0.10, 2), H,
    { uv: 2.6, tint: KIT.webbing });
  // Wrist cuff, breaking the forearm from the fist.
  s.add('gear', tube(0.038, 0.034, 0.030, ox - 0.012, oy - 0.030, oz + 0.014, 'y', 10), H,
    { uv: 2.4, tint: KIT.glove });

  /**
   * The fingers wrap the front of the post and their tips reach past it to the
   * rifle's RIGHT (+x local), which is the near side for a camera on the man's
   * firing flank. That matters: the handguard is 56 mm wide and the foregrip post
   * 30 mm, so a fist whose mass sits only on the left of the post is entirely
   * behind the weapon from the side and contributes nothing.
   */
  const rows = [[0.018, 0.0136], [-0.006, 0.0134], [-0.030, 0.0124], [-0.052, 0.0112]];
  for (const [dy, r] of rows) {
    finger(s, H,
      ox - 0.026, oy + dy, oz - 0.010,
      ox - 0.006, oy + dy - 0.002, fz,
      ox + 0.026, oy + dy - 0.006, fz + 0.008,
      r);
  }
  // Thumb over the top of the post, pointing down the bore — the support-hand
  // thumb-forward grip every modern carbine manual teaches.
  finger(s, H,
    ox - 0.020, oy + 0.030, oz - 0.006,
    ox - 0.002, oy + 0.038, oz - 0.032,
    ox + 0.018, oy + 0.036, oz - 0.058,
    0.0150);
}

function buildLegs(s) {
  for (const sg of [1, -1]) {
    const x = sg * 0.098;
    const th = sg > 0 ? B.thighR : B.thighL;
    const ca = sg > 0 ? B.calfR : B.calfL;
    const fo = sg > 0 ? B.footR : B.footL;
    const yH = BIND[B.thighR].y, yK = yH - RIG.thigh, yA = yK - RIG.calf;
    /**
     * Leg volume.
     *
     * The old capsules ran 0.102 -> 0.074 at the knee and 0.078 -> 0.056 at the
     * ankle: an ankle 55% the radius of the hip, over a 0.87 m span, with a
     * 0.16 m knee pad sitting on top of it. At any range where the figure is
     * more than a smudge that reads as a ball-jointed mannequin on stilts —
     * the single worst thing about these bodies close up.
     *
     * Real combat trousers are full-cut and barely taper: thigh circumference
     * ~58 cm at the seat falling to ~40 cm above the knee, and the calf has a
     * belly a third of the way down that is WIDER than the knee, not narrower.
     * So the thigh is fuller with less taper, the shank is built as two
     * segments with the gastrocnemius bulge between them, and a seat mass fills
     * the hip so the trunk no longer sits on the legs like a wedge on sticks.
     */
    s.add('fatigue', taperY(blob(0.108, x, yH - 0.045, 0.010, 1.05, 0.80, 1.0, 12), 1.0, 0.9, x, 0.010), th,
      { uv: 2, tint: KIT.trouser }); // seat / hip mass
    /**
     * The thigh now stops SHORT of the knee (yK + 0.055 rather than yK + 0.010).
     * A thigh capsule that runs all the way into the shank capsule welds the two
     * into one continuous tube and the joint disappears — which is exactly what
     * the close-up showed: a pair of smooth bowed pipes with no knee anywhere on
     * them, whatever angle the IK actually put the leg at. Leaving a 4-5 cm gap
     * and filling it with a narrower knee sleeve gives the silhouette a real
     * waist at the joint, so a bent leg reads as bent.
     */
    s.add('fatigue', limb(x, yH + 0.02, 0, x, yK + 0.055, 0, 0.116, 0.086, 12), th,
      { uv: 2, uo: [sg * 0.2, 0.5], tint: KIT.trouser });
    // knee sleeve: narrow, spans the joint, skinned to the shank so it follows
    s.add('fatigue', limb(x, yK + 0.062, 0, x, yK - 0.042, -0.004, 0.074, 0.080, 12), ca,
      { uv: 2, uo: [sg * 0.2, 0.5], tint: KIT.trouser });
    const yB = yK - RIG.calf * 0.34;                       // calf belly
    s.add('fatigue', limb(x, yK - 0.030, -0.004, x, yB, -0.008, 0.084, 0.100, 12), ca,
      { uv: 2, uo: [0, sg * 0.3], tint: KIT.trouser });
    s.add('fatigue', limb(x, yB, -0.008, x, yA + 0.055, 0, 0.100, 0.062, 12), ca,
      { uv: 2, uo: [0, sg * 0.3], tint: KIT.trouser });
    // cargo pocket on the thigh, knee pad, boot
    s.add('fatigue', curveX(box(0.104, 0.148, 0.038, sg * 0.152, yH - 0.150, -0.044, 0, sg * 0.22, 0, 3), 0.6, sg * 0.152), th,
      { uv: 2, tint: KIT.pouch });
    /**
     * Knee pad. Was 12 mm proud of a 88 mm shank — inside the silhouette, so it
     * contributed nothing. Now a hard cap standing 40 mm off the front of the
     * joint, in the darkest value on the figure, which is what turns a leg into
     * a leg-with-a-knee from across the yard.
     */
    s.add('gear', blob(0.074, x, yK + 0.006, -0.080, 1.02, 1.48, 0.74, 12), ca,
      { uv: 2, tint: KIT.pad });
    s.add('gear', box(0.128, 0.020, 0.030, x, yK - 0.052, -0.044, 0.35, 0, 0, 2), ca,
      { uv: 2, tint: KIT.webbing });   // lower retention strap
    s.add('gear', taperY(blob(0.064, x, yA + 0.075, 0, 1.05, 1.15, 1.0, 12), 1.0, 0.92, x, 0), ca,
      { uv: 2.2, tint: KIT.webbing });   // boot cuff
    /**
     * The ankle bone sits at yA = 0.040 and the floor is y = 0, so the sole has
     * exactly 40 mm to work with. The sole slab used to be centred at yA-0.040
     * with a half-height of 0.015, putting its underside at y = -0.015: every
     * standing soldier was buried 15 mm into the deck, which reads as sinking
     * rather than standing. Raised so the tread sits 5 mm proud of the floor —
     * clear contact, and far enough off to never z-fight with the concrete.
     */
    // Boots were 100 x 240 mm — a size 5. A 50th-percentile male in a combat
    // boot is nearer 115 x 300, and an undersized foot is what makes a figure
    // look like it is balancing on hooves.
    s.add('gear', taperY(box(0.114, 0.086, 0.286, x, yA + 0.018, -0.062, 0, 0, 0, 2), 1.0, 0.86, x, -0.062), fo,
      { uv: 2.4, tint: KIT.boot });
    s.add('gear', box(0.122, 0.032, 0.298, x, yA - 0.020, -0.064, 0, 0, 0, 2), fo,
      { uv: 3.2, tint: KIT.boot });
    s.add('gear', taperY(blob(0.056, x, yA + 0.006, -0.198, 1.0, 0.62, 1.0, 10), 1, 0.8, x, -0.198), fo,
      { uv: 2, tint: KIT.boot });    // toe cap
  }
}

function buildHead(s) {
  const yH = BIND[B.head].y;
  // balaclava'd skull + jaw, then the helmet shell over the top
  s.add('gear', blob(0.116, 0, yH + 0.072, 0.004, 0.94, 1.06, 1.02, 16), B.head,
    { uv: 2, tint: KIT.earcup });
  s.add('gear', taperY(blob(0.086, 0, yH + 0.006, -0.020, 1.0, 0.86, 1.10, 14), 0.86, 1.0, 0, -0.020), B.head,
    { uv: 2, tint: KIT.earcup });
  s.add('gear', dome(0.134, 0, yH + 0.068, 0.006, 1.0, 0.96, 1.06, 2.02), B.head,
    { uv: 2.8, tint: KIT.helmet });
  s.add('gear', tube(0.132, 0.136, 0.026, 0, yH + 0.006, 0.006, 'y', 20), B.head,
    { uv: 2.4, tint: KIT.helmet });      // helmet rim
  for (const sg of [1, -1]) {
    s.add('gear', blob(0.052, sg * 0.126, yH + 0.012, 0.010, 0.7, 1.05, 1.15, 10), B.head,
      { uv: 2, tint: KIT.earcup }); // ear cup
    s.add('steel', box(0.010, 0.016, 0.130, sg * 0.128, yH + 0.070, 0.010, 0, 0, 0, 2), B.head,
      { uv: 1, tint: KIT.gunSteel }); // rail
    s.add('gear', box(0.014, 0.070, 0.014, sg * 0.116, yH - 0.030, -0.010, 0, 0, sg * 0.22), B.head,
      { uv: 2, tint: KIT.webbing }); // chin strap
  }
  s.add('steel', box(0.056, 0.052, 0.030, 0, yH + 0.118, -0.116), B.head,
    { uv: 1, tint: KIT.gunSteel });                 // NVG shroud
  s.add('steel', tube(0.013, 0.013, 0.030, 0, yH + 0.118, -0.134, 'z', 8), B.head,
    { uv: 1, tint: KIT.gunSteel });
  // smoked goggles across the brow, on a webbing band
  s.add('visor', curveX(box(0.200, 0.062, 0.024, 0, yH + 0.062, -0.108, -0.06, 0, 0, 8), 1.5), B.head,
    { tint: KIT.lens });
  s.add('gear', curveX(box(0.216, 0.028, 0.020, 0, yH + 0.070, -0.100, -0.06, 0, 0, 6), 1.5), B.head,
    { uv: 2, tint: KIT.webbing });
  s.add('gear', tube(0.130, 0.132, 0.028, 0, yH + 0.066, 0.014, 'y', 18), B.head,
    { uv: 2, tint: KIT.webbing });
}

/**
 * The carbine. Authored in character space with its grip on the right wrist and
 * the bore along -Z, then skinned rigid to the hand — so the muzzle direction is
 * exactly the hand's -Z axis, which is what makes "aim at the target" exact
 * rather than approximate.
 */
function buildRifle(s) {
  const gx = RIG.rifleGrip.x, gy = RIG.rifleGrip.y, gz = RIG.rifleGrip.z;
  const H = B.handR;
  const bore = gy + 0.077;
  const P = (w, h, d, x, y, z, rx = 0, ry = 0, rz = 0) => box(w, h, d, gx + x, gy + y, gz + z, rx, ry, rz, 2);
  const T = (r0, r1, l, x, y, z, ax = 'z', rad = 10) => tube(r0, r1, l, gx + x, gy + y, gz + z, ax, rad);
  const ST = { uv: 1, tint: KIT.gunSteel };

  s.add('steel', P(0.062, 0.092, 0.270, 0, 0.077, -0.020), H, { uv: 1.6, tint: KIT.gunSteel }); // upper+lower receiver
  s.add('steel', P(0.050, 0.040, 0.120, 0, 0.020, 0.010), H, { uv: 1.2, tint: KIT.gunSteel });  // trigger housing
  s.add('steel', P(0.048, 0.116, 0.062, 0, -0.028, 0.052, 0.22), H, { uv: 1.6, tint: KIT.gunSteel }); // pistol grip
  s.add('gear',  P(0.052, 0.120, 0.058, 0, -0.030, 0.052, 0.22), H, { uv: 2.2, tint: KIT.gunPoly });  // grip overmould
  s.add('steel', taperY(P(0.048, 0.210, 0.088, 0, -0.070, -0.030, 0.10), 0.94, 1.0, gx, gz - 0.030), H,
    { uv: 1.6, tint: KIT.gunSteel }); // magazine
  s.add('steel', P(0.056, 0.062, 0.300, 0, 0.078, -0.300), H, { uv: 1.6, tint: KIT.gunFurn });  // handguard
  for (let i = 0; i < 5; i++) {                                                             // handguard vents
    s.add('steel', P(0.060, 0.010, 0.016, 0, 0.052, -0.190 - i * 0.048), H, ST);
  }
  s.add('steel', T(0.012, 0.011, 0.330, 0, 0.077, -0.310), H, ST);                          // barrel
  s.add('steel', T(0.019, 0.017, 0.062, 0, 0.077, -0.500, 'z', 12), H, ST);                 // muzzle brake
  s.add('steel', T(0.021, 0.021, 0.014, 0, 0.077, -0.472, 'z', 12), H, ST);
  s.add('steel', P(0.030, 0.026, 0.070, 0, 0.126, -0.196), H, ST);                          // gas block
  s.add('steel', P(0.026, 0.024, 0.170, 0.030, 0.086, -0.060), H, ST);                      // charging handle side
  s.add('steel', T(0.024, 0.024, 0.130, 0, 0.056, 0.130, 'z', 10), H, ST);                  // buffer tube
  s.add('gear',  P(0.062, 0.110, 0.052, 0, 0.052, 0.214), H, { uv: 2.2, tint: KIT.gunPoly });// butt pad
  s.add('gear',  P(0.058, 0.048, 0.120, 0, 0.104, 0.150), H, { uv: 2.2, tint: KIT.gunPoly });// cheek riser
  s.add('steel', P(0.048, 0.020, 0.240, 0, 0.128, -0.060), H, ST);                          // top rail
  s.add('steel', T(0.026, 0.026, 0.104, 0, 0.150, -0.086, 'z', 12), H, ST);                 // optic body
  s.add('steel', P(0.040, 0.038, 0.040, 0, 0.132, -0.086), H, ST);                          // optic mount
  s.add('visor', T(0.023, 0.023, 0.006, 0, 0.150, -0.140, 'z', 12), H, { tint: KIT.lens }); // objective lens
  s.add('visor', T(0.021, 0.021, 0.006, 0, 0.150, -0.032, 'z', 12), H, { tint: KIT.lens }); // ocular lens
  s.add('steel', P(0.030, 0.082, 0.036, 0, 0.028, -0.185), H, { uv: 1.2, tint: KIT.gunSteel }); // vertical foregrip
  s.add('gear',  P(0.034, 0.058, 0.040, 0, 0.012, -0.185), H, { uv: 2.2, tint: KIT.gunPoly });
  s.add('gear',  P(0.058, 0.014, 0.058, 0, 0.046, -0.185), H, { uv: 2.2, tint: KIT.gunPoly }); // handstop shelf
  s.add('steel', P(0.014, 0.030, 0.014, 0, 0.116, -0.404), H, ST);                          // folded front sight
  s.add('steel', T(0.006, 0.006, 0.026, 0.032, 0.050, 0.100, 'x', 6), H, ST);               // sling swivel
}

/**
 * Builds the shared geometry once. Returns { geometries, boneInverses, tris }.
 */
export function buildSoldierTemplate() {
  const t0 = performance.now();
  const s = new Skinner();
  /**
   * THE GLOVES GO FIRST, and the order is load-bearing.
   *
   * They are the head of the `gear` index buffer so that `setDrawRange(0, n)`
   * renders the hands alone and `setDrawRange(n, rest)` renders everything but
   * the hands. That is the only way to ask, in pixels, whether the hands are on
   * the weapon — see Skinner.ranges. Nothing else depends on family ordering:
   * the parts are merged into one buffer and drawn in a single call, so moving
   * them changes no visual result.
   */
  s.mark('gear', 'glove', () => { buildFiringHand(s); buildSupportHand(s); });
  buildTorso(s);
  buildCarrier(s);
  buildArms(s);
  buildLegs(s);
  buildHead(s);
  buildRifle(s);
  const geometries = s.finish();
  const ranges = geometries.__ranges;
  delete geometries.__ranges;

  const boneInverses = BIND.map((p) => new THREE.Matrix4().makeTranslation(-p.x, -p.y, -p.z));
  return {
    geometries,
    ranges,
    boneInverses,
    tris: geometries.__tris,
    buildMs: Math.round(performance.now() - t0),
  };
}

/** A fresh bone hierarchy (one per combatant; the geometry is shared). */
export function buildSkeletonBones() {
  const bones = [];
  for (const [name, parent, x, y, z] of BONES) {
    const b = new THREE.Bone();
    b.name = name;
    b.position.set(x, y, z);
    bones.push(b);
    if (parent >= 0) bones[parent].add(b);
  }
  return bones;
}
