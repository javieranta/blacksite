import * as THREE from 'three';
import { Mesher, boxG, cylG } from './Shapes.js';
import { LAYOUT } from './Weapon.js';

/**
 * OWNER: viewmodel agent.
 *
 * Gloved first-person hands and forearms.
 *
 * Built on a nested matrix skeleton rather than flat offsets: a finger is three
 * tapering segments each rotated about its own joint frame, so a curl is one
 * number and the segments stay connected. That is the difference between hands
 * that wrap the weapon and blocks parked next to it.
 *
 * Materials do the rest — a twill glove texture with stitch rows in the normal
 * map, rubber knuckle and palm pads as separate raised geometry, and a ripstop
 * sleeve with a cuff strap. Nothing here is a box with a flat grey material,
 * which was the loudest tell in the previous revision.
 */

const IDENT = new THREE.Matrix4();

function child(parent, x, y, z, rx = 0, ry = 0, rz = 0) {
  const local = new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, 'YXZ')),
    new THREE.Vector3(1, 1, 1),
  );
  return new THREE.Matrix4().multiplyMatrices(parent, local);
}

/** Child frame with an explicit basis: columns are the new X, Y, Z axes. */
function childBasis(parent, x, y, z, ax, ay, az) {
  const local = new THREE.Matrix4().makeBasis(ax, ay, az);
  local.setPosition(x, y, z);
  return new THREE.Matrix4().multiplyMatrices(parent, local);
}

const V = (x, y, z) => new THREE.Vector3(x, y, z);

/**
 * One finger: three segments extending along the frame's +Z, each hinged about
 * the frame's X axis so the curl happens in the YZ plane. Knuckle pads ride on
 * the +Y side of the proximal segment.
 */
function finger(m, frame, o) {
  let joint = child(frame, 0, 0, 0);
  const curls = o.curls;
  for (let s = 0; s < 3; s++) {
    joint = child(joint, 0, 0, 0, curls[s]);
    const len = o.len * (1 - s * 0.17);
    const th = o.thick * (1 - s * 0.11);
    const th2 = o.thick * (1 - (s + 1) * 0.11);
    m.use('glove');
    boxG(m, {
      mat4: child(joint, 0, 0, len / 2),
      w: th, h: th * 1.10, d: len, w1: th2, h1: th2 * 1.10, c: 0.0011, simple: true,
    });
    // A soft crease bead at each joint stops the segments reading as a stack.
    if (s < 2) {
      cylG(m, {
        mat4: child(joint, 0, -th * 0.10, len - 0.0004, 0, Math.PI / 2),
        r0: th * 0.56, len: th * 0.80, seg: 8, c: 0.0004,
      });
    }
    if (s === 0 && o.pad) {
      m.use('pad');
      boxG(m, {
        mat4: child(joint, 0, th * 0.60, len * 0.46),
        w: th * 0.92, h: th * 0.34, d: len * 0.80, c: 0.0008, simple: true,
      });
    }
    joint = child(joint, 0, 0, len);
  }
  return joint;
}

/**
 * Forearm + sleeve running away from a wrist frame along its +Z. Tapers up
 * toward the elbow and gets a ripstop cuff with a strap and a tab.
 */
function forearm(m, wrist, o) {
  const r = o.r;
  m.use('glove');
  // Swept round rather than boxed: a rectangular prism 150 mm long reads as a
  // plank the moment it is seen at an angle, and the support forearm crosses a
  // lot of frame in the hipfire pose.
  cylG(m, { mat4: child(wrist, 0, 0, o.cuff * 0.5),
    r0: r * 0.90, r1: r, len: o.cuff, seg: 14, c: 0.0014, capA: false });
  m.use('sleeve');
  cylG(m, { mat4: child(wrist, 0, 0, o.cuff + 0.0090),
    r0: r * 1.15, r1: r * 1.12, len: 0.0180, seg: 14, c: 0.0018 });
  cylG(m, { mat4: child(wrist, 0, 0, o.cuff + 0.0180 + o.len * 0.5),
    r0: r * 1.06, r1: r * 1.36, len: o.len, seg: 14, c: 0.0024, capB: false });
  // adjustment strap across the cuff and a hook-and-loop tab
  m.use('pad');
  cylG(m, { mat4: child(wrist, 0, 0, o.cuff + 0.0090),
    r0: r * 1.21, len: 0.0072, seg: 14, c: 0.0010 });
  boxG(m, { mat4: child(wrist, r * 1.18, 0, o.cuff + 0.0090),
    w: 0.0062, h: 0.0150, d: 0.0110, c: 0.0010, simple: true });
}

/* ------------------------------------------------------------- firing hand */

function firingHand(m) {
  // The grip's own frame: +X right, +Y rearward, +Z down the grip. The grip box
  // is 32.2 x 44 mm, so its surfaces sit at |x| = 16.1 mm and y = -22 mm (front)
  // / +22 mm (back). Every knuckle below is placed *outside* those surfaces:
  // start a finger inside the grip and the whole wrap ends up buried in it,
  // leaving only stubby nubs poking out — which is exactly what happened first
  // time round.
  const grip = child(IDENT, 0, -0.0742, 0.1178, Math.PI / 2 - 0.30);

  m.use('glove');
  // palm against the right flank
  boxG(m, { mat4: child(grip, 0.0248, 0.0000, -0.0030),
    w: 0.0210, h: 0.0500, d: 0.0790, w1: 0.0186, h1: 0.0450, c: 0.0030 });
  // dorsum, standing slightly proud of the palm
  boxG(m, { mat4: child(grip, 0.0316, -0.0030, -0.0090),
    w: 0.0090, h: 0.0400, d: 0.0640, c: 0.0026 });
  // thenar pad at the thumb root, wrapping onto the backstrap
  boxG(m, { mat4: child(grip, 0.0180, 0.0250, -0.0300),
    w: 0.0290, h: 0.0210, d: 0.0300, c: 0.0026 });
  // heel of the hand at the base of the grip
  boxG(m, { mat4: child(grip, 0.0232, 0.0090, 0.0355),
    w: 0.0230, h: 0.0400, d: 0.0220, c: 0.0028 });
  m.use('pad');
  // knuckle armour across the back of the hand
  boxG(m, { mat4: child(grip, 0.0356, -0.0040, -0.0170),
    w: 0.0040, h: 0.0320, d: 0.0400, c: 0.0012, simple: true });

  /**
   * Fingers wrap the front of the grip: frame +Z forward, curl toward -X.
   * Curls of 0.75 / 1.10 / 1.00 turn the finger through 163 degrees, which
   * takes the tip from the right flank, around the front face and onto the
   * left-front corner — the arc a hand actually makes on a 32 mm grip.
   */
  const knuckle = (dz) => childBasis(grip, 0.0196, -0.0245, dz,
    V(0, 0, -1), V(1, 0, 0), V(0, -1, 0));
  const rows = [-0.0060, 0.0140, 0.0330];
  for (let i = 0; i < 3; i++) {
    finger(m, knuckle(rows[i]), {
      len: 0.0212 - i * 0.0012, thick: 0.0106 - i * 0.0005,
      curls: [0.75 + i * 0.05, 1.10, 1.00 - i * 0.05], pad: true,
    });
  }
  // Trigger finger: forward past the guard, then hooked back onto the shoe.
  const tf = childBasis(grip, 0.0190, -0.0230, -0.0290,
    V(0, 0, -1), V(1, 0, 0), V(0, -1, 0));
  finger(m, tf, { len: 0.0210, thick: 0.0108, curls: [0.20, 0.34, 1.10], pad: true });

  // Thumb over the top of the backstrap toward the selector. The basis must
  // stay right-handed — a mirrored frame flips the winding and the normals.
  const th = childBasis(grip, 0.0210, 0.0230, -0.0330,
    V(0, 0, 1), V(0, 1, 0), V(-1, 0, 0));
  finger(m, th, { len: 0.0196, thick: 0.0126, curls: [0.34, 0.34, 0.26], pad: false });

  // Wrist heading back, down and outboard toward the right shoulder. The Euler
  // is solved rather than guessed: for YXZ order the frame's +Z lands on
  // (cos b sin a, -sin b, cos b cos a), so a target direction fixes rx and ry.
  const wrist = childBasis(grip, 0.0250, 0.0140, 0.0440,
    V(1, 0, 0), V(0, 1, 0), V(0, 0, 1));
  forearm(m, child(wrist, 0, 0, 0, 0.602, 0.642, 0.10),
    { r: 0.0228, cuff: 0.0210, len: 0.1200 });
}

/* ------------------------------------------------------------ support hand */

function supportHand(m) {
  const HGZ = -0.1500;
  // Base frame is world-aligned at the left flank of the handguard (a 38 mm
  // octagon centred on the bore at y = 0.030, so its surfaces are at |x| = 19 mm
  // and y = 0.011 .. 0.049).
  const base = child(IDENT, -0.0215, 0.0300, HGZ, 0, 0, 0);

  m.use('glove');
  // palm on the upper-left flat, dorsum outboard and visible from the shooter's
  // eye — this is the hand you actually see in ADS
  boxG(m, { mat4: child(base, -0.0074, 0.0058, 0.0000, 0, 0, 0.20),
    w: 0.0200, h: 0.0420, d: 0.0700, c: 0.0030 });
  // hypothenar heel curling under the handguard
  boxG(m, { mat4: child(base, 0.0035, -0.0210, 0.0060, 0, 0, 0.35),
    w: 0.0250, h: 0.0190, d: 0.0620, c: 0.0028 });
  m.use('pad');
  // knuckle armour across the back of the hand
  boxG(m, { mat4: child(base, -0.0148, 0.0090, -0.0060, 0, 0, 0.20),
    w: 0.0044, h: 0.0300, d: 0.0420, c: 0.0012, simple: true });

  /**
   * The top of the handguard carries the rail, so the support fingers cannot
   * come over the top the way a bare-handguard C-clamp does. They drop down the
   * left flank, pass under the bottom flat and come up the right side — frame
   * +Z points down, curl toward +X.
   */
  const knuckle = (dz) => childBasis(base, -0.0045, -0.0050, dz,
    V(0, 0, 1), V(-1, 0, 0), V(0, -1, 0));
  const rows = [-0.0250, -0.0090, 0.0070, 0.0230];
  for (let i = 0; i < 4; i++) {
    finger(m, knuckle(rows[i]), {
      len: 0.0198 - i * 0.0010, thick: 0.0104 - i * 0.0004,
      curls: [0.55 + i * 0.04, 1.05, 0.95 - i * 0.05], pad: true,
    });
  }
  // Thumb lies along the top-left of the handguard beside the rail, pointing
  // forward — the tell that reads as a deliberate support grip.
  const th = childBasis(base, -0.0110, 0.0190, -0.0240,
    V(0, 1, 0), V(1, 0, 0), V(0, 0, -1));
  finger(m, th, { len: 0.0208, thick: 0.0124, curls: [0.20, 0.16, 0.14], pad: false });

  // Wrist back toward the left shoulder: rearward, down and inboard.
  const wrist = childBasis(base, -0.0080, -0.0140, 0.0330,
    V(1, 0, 0), V(0, 1, 0), V(0, 0, 1));
  // `forearm` sweeps a round section and takes a radius. This call site still
  // carried the box section (w 31 mm x h 41 mm) from before the forearm was
  // converted from a prism, so `o.r` was undefined and every vertex of the
  // support sleeve came out NaN. Radius is the mean half-extent of that section.
  forearm(m, child(wrist, 0, 0, 0, 0.706, -0.557, -0.16),
    { r: 0.0180, cuff: 0.0200, len: 0.1350 });
}

/* ------------------------------------------------------------------ build */

export function buildHands(mats) {
  const group = new THREE.Group();
  group.name = 'vm:hands';
  const m = new Mesher();
  firingHand(m);
  supportHand(m);

  const meshes = [];
  for (const [key, geo] of m.geometries()) {
    const mesh = new THREE.Mesh(geo, mats[key] ?? mats.glove);
    mesh.name = `vm:hand:${key}`;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.frustumCulled = false;
    group.add(mesh);
    meshes.push(mesh);
  }
  return { group, meshes, triangles: m.triangleCount() };
}
