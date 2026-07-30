import * as THREE from 'three';
import { Mesher, boxG, cylG } from './Shapes.js';
import {
  IDENT, child, frameAt, ridge, offsetPath, wrapDigit, bandOnPath,
  digit, phalanges, forearm,
} from './Wrap.js';

/**
 * OWNER: viewmodel agent.
 *
 * Gloved first-person hands and forearms.
 *
 * ─── WHY FOUR PREVIOUS REVISIONS WERE INVISIBLE ───────────────────────────
 *
 * Every one of them was diagnosed as a geometry bug and was not. Round 7's hands
 * were built (6684 triangles), parented under the rig root, in ctx.viewScene,
 * on layer 0, `visible === true`, inside the 0.005-12 m view frustum, with valid
 * materials, projecting to screen bounds 1049..1514 x 638..1204 — dead centre of
 * the weapon. Hiding every weapon mesh made them appear immediately. They were
 * being drawn and then losing the depth test, in full, every frame.
 *
 * Because they were on the wrong side of the gun.
 *
 * MEASURE THE EYE FIRST. The hip pose puts the weapon at camera-space
 * (0.1890, -0.1797, -0.6159) with YXZ rotation (0.0484, 0.2505, 0.1007). Invert
 * that and the camera sits, in *weapon* space, at
 *
 *      (-0.3134, +0.2389, +0.5404)     — 313 mm LEFT of the bore,
 *                                        239 mm ABOVE it, 540 mm BEHIND.
 *
 * so the eye sees the weapon's LEFT flank, its top, and its rear. Everything at
 * x > 0 that sits behind a surface at x ~ 0 is invisible, and the receiver,
 * magwell, magazine and stock are all at x ~ 0.
 *
 * Round 7's firing hand was authored entirely at grip x = +0.015..+0.036 — the
 * far flank. The magazine occluded it. Its thumb was a detached island behind the
 * receiver. The support hand sat under its own oversized sleeve. The only hand
 * geometry that survived the depth test was that support sleeve, which ran out to
 * x = -0.089 and *ended inside the frame* with a capped elbow: a smooth dark
 * cone with a rimmed disc on the end, crossing in front of the receiver. Five
 * reviewers looked straight at it and read it as a length of pipe in the level.
 *
 * ─── WHAT IS AUTHORED HERE, AND WHY EACH PART EARNS ITS PLACE ─────────────
 *
 * Nothing goes in unless a ray from it to (-0.3134, 0.2389, 0.5404) clears the
 * weapon. Concretely:
 *
 *   SUPPORT HAND — the load-bearing read, and the largest. A C-clamp grip: the
 *   palm lies along the handguard's LEFT flank (the flank the eye is looking at),
 *   the four metacarpal heads ride the shoulder between the handguard and the
 *   rail, the fingers bridge that notch, cross OVER the rail and come down the
 *   far side, and the thumb points forward along the upper-left beside the rail.
 *   That puts a 78 x 52 mm slab of glove, four separated rubber knuckles, four
 *   converging metacarpal ridges and a thumb entirely in the clear, and it
 *   silhouettes the finger tops against the background above the weapon.
 *     In ADS the same hand is *correctly* hidden: from an on-axis eye, anything
 *   above y = 0.039 at z = -0.104 falls in the optic housing's shadow, so the
 *   knuckles do not appear in the sight picture. Only the palm's lower-left edge
 *   shows, which is what a real ADS frame shows.
 *
 *   SUPPORT FOREARM — the biggest single element, ~450 px running from the hand
 *   down to the bottom-left corner. Directed (-0.60, -0.66, 0.45) and 300 mm
 *   long so the elbow lands at (1000, 1187): off the bottom edge, never a disc.
 *
 *   FIRING HAND — the grip is 17 px from the bottom of the frame, so its palm,
 *   knuckles, thumb, heel and wrist are all either on the far flank or below the
 *   frame, and no amount of modelling changes that. What *is* visible is the
 *   finger wrap: seeded on the grip's right flank, round the front strap, tips
 *   landing on the LEFT flank at grip x = -0.022 — 6 mm proud of a flank the eye
 *   sees square-on, with nothing in front of them (the magwell lip stops at
 *   y = -0.0445, the trigger guard at |x| = 0.0143). Three stacked fingertips
 *   breaking the grip's front-left silhouette is exactly what a real hipfire
 *   frame shows of a firing hand. The rest of the hand is built anyway, because
 *   the inspect pose and the reload roll do show it.
 *
 * ─── THE POSES ────────────────────────────────────────────────────────────
 *
 * Both hands are rigid children of the weapon rig, so idle sway, breathing, the
 * walk cycle, sprint carry, recoil, the reload roll and the ADS transition all
 * carry them with the weapon by construction: there is no pose in which a hand
 * can slide off the gun, because there is no independent hand transform to get
 * out of step. What each pose changes is which parts the eye can see, and that is
 * why the wrap is authored to touch on *all* sides rather than to look right from
 * one camera.
 */

/* ------------------------------------------------------------- firing hand */

/**
 * The pistol grip's section, in grip-local (x, y), listed in the wrap direction:
 * from the backstrap over the right flank, round the front strap, up the left
 * flank. The grip box is 32.2 x 43.0 mm with a 7 mm chamfer and a slight taper;
 * these are its mid-length half-extents with the chamfer corners called out, so
 * the offset path arcs round exactly the radius the real front strap has.
 *
 * Grip frame: +X right, +Y rearward (toward the backstrap), +Z down the grip.
 */
const GRIP_SEC = [
  [0.0088, 0.0210],    // backstrap, right corner
  [0.0158, 0.0140],    // right flank, top of the chamfer
  [0.0158, -0.0140],   // right flank, bottom of the chamfer
  [0.0088, -0.0210],   // front strap, right corner
  [-0.0088, -0.0210],  // front strap, left corner
  [-0.0158, -0.0140],  // left flank, bottom of the chamfer
  [-0.0158, 0.0140],   // left flank, top of the chamfer
];

/** Grip frame in weapon space — matches lowerReceiver()'s `grip` exactly. */
const GRIP = child(IDENT, 0, -0.0742, 0.1178, Math.PI / 2 - 0.30);

function firingHand(m) {
  const digits = offsetPath(GRIP_SEC, 0.0064);
  const palm = offsetPath(GRIP_SEC, 0.0118);
  const knuck = offsetPath(GRIP_SEC, 0.0132);
  const DORS = [1, 0, 0];                        // outboard = back of the hand

  // Rows run down the grip: middle, ring, little. The index is the trigger
  // finger and is built separately, in weapon space.
  const rows = [-0.0100, 0.0100, 0.0300];
  /**
   * WRAP FURTHER THAN LOOKS NECESSARY. The grip's front strap faces weapon
   * (0, -0.296, -0.955) — down and *forward* — so from an eye 540 mm behind the
   * weapon it is a back face. Everything a finger does on the front strap is
   * hidden; only the part that comes round onto the LEFT flank is photographed.
   * A 57 mm finger (which is what a 23 mm proximal gives) reaches the flank with
   * 4 mm to spare and shows three fingertip nubs and nothing else. A 68 mm
   * finger — which is also the real length of a gloved middle finger from the
   * MCP — puts its whole middle phalanx and its whole distal on the flank, so
   * each digit shows about 30 mm of length with a crease bead in the middle.
   * That is the difference between "three pale nubs" and "a hand gripping".
   */
  const lens = [0.0273, 0.0258, 0.0232];
  // Seeds sit in the arc off the right flank's front chamfer, so the metacarpal
  // heads land on the flank behind the front strap, which is where a fist's
  // knuckles actually are. Each successive finger starts a shade further round,
  // the way a fist's knuckle line rakes.
  const seeds = [0.0450, 0.0464, 0.0478];

  // ---- palm, thenar and heel ----------------------------------------------
  /**
   * Three band steps, not five, with 6 mm of overlap. A band emits a chamfered
   * slab per step, and from a raking eye every step edge is a ledge: six of them
   * up the flank read as a stack of armour plates, which is what the first pass
   * of this rewrite looked like. Three heavily-overlapped steps read as one mass
   * with a curve in it.
   */
  m.use('glove');
  bandOnPath(m, palm, {
    s0: 0.0040, s1: 0.0450, z: 0.0040, steps: 3, overlap: 0.0060,
    w0: 0.0770, w1: 0.0710, h0: 0.0214, h1: 0.0198,
  });
  /**
   * Thenar eminence and palm heel — the web at the base of the thumb and the
   * mass behind the backstrap.
   *
   * These are the ONLY parts of the firing hand's bulk the hip pose photographs:
   * the thenar projects to about (1371, 940) and the heel to (1405, 1039), both
   * in open air behind the grip and below the receiver's rear, with nothing in
   * front of them. First pass they were chamfered boxes and came back as two
   * pale bricks — a box has six flat faces and three hard silhouette corners, and
   * at 4x magnification that is what they looked like.
   *
   * Built from crossed cylinders instead. A cylinder's silhouette is a curve and
   * its shading is a gradient, so three overlapping ones read as one soft mass
   * with a fleshy edge, which is what the back of a fist is. Same triangle count,
   * completely different photograph.
   */
  cylG(m, { mat4: child(GRIP, 0.0130, 0.0230, -0.0180, 0, Math.PI / 2, 0.28),
    r0: 0.0132, r1: 0.0116, len: 0.0290, seg: 12, c: 0.0028 });
  cylG(m, { mat4: child(GRIP, 0.0146, 0.0206, 0.0060, 0.16, 0, 0),
    r0: 0.0126, r1: 0.0134, len: 0.0330, seg: 12, c: 0.0026 });
  cylG(m, { mat4: child(GRIP, 0.0160, 0.0230, 0.0330, 0.12, 0, 0),
    r0: 0.0134, r1: 0.0120, len: 0.0330, seg: 12, c: 0.0026 });
  // Thumb metacarpal riding over the web, so the thumb grows out of the mass.
  cylG(m, { mat4: child(GRIP, 0.0068, 0.0306, -0.0200, 0, 0, 0.24),
    r0: 0.0064, r1: 0.0054, len: 0.0250, seg: 10, c: 0.0016 });
  /**
   * Fist toe, below the grip's buttcap. The grip's own toe projects to
   * (1356, 1063) — 17 px off the bottom edge — so this is off-frame in hipfire
   * and is here for the inspect pose and for the reload, where the weapon rolls
   * far enough up that the bottom of the fist comes into shot.
   */
  boxG(m, { mat4: child(GRIP, 0.0070, 0.0020, 0.0560, 0, 0, 0.06),
    w: 0.0400, h: 0.0428, d: 0.0300, c: 0.0060 });

  // ---- metacarpals and knuckle armour -------------------------------------
  const wristLocal = [0.0230, 0.0250, 0.0350];
  const kp = [0, 0, 0, 0, 0, 0];
  for (let i = 0; i < 3; i++) {
    knuck.at(seeds[i], kp);
    ridge(m, GRIP, wristLocal, [kp[0], kp[1], rows[i]], 0.0034, 0.0034, DORS);
  }
  m.use('pad');
  for (let i = 0; i < 3; i++) {
    knuck.at(seeds[i], kp);
    boxG(m, { mat4: frameAt(GRIP, kp[0], kp[1], rows[i], [0, 0, 1], [kp[4], kp[5], 0]),
      w: 0.0132, h: 0.0122, d: 0.0074, c: 0.0016, simple: true });
  }

  // ---- the wrap -----------------------------------------------------------
  /**
   * Three fingers walk the offset path from the right flank, round the front
   * strap, onto the left flank. Solved, not posed — `wrapDigit` bisects each
   * phalanx's arc-length step so the bone is its real length and both ends sit
   * on the offset curve, which is one finger half-thickness off the grip.
   */
  m.use('glove');
  for (let i = 0; i < 3; i++) {
    const w = wrapDigit(digits, seeds[i], phalanges(lens[i]));
    digit(m, frameAt(GRIP, w.p[0], w.p[1], rows[i], [w.dir[0], w.dir[1], 0], [w.back[0], w.back[1], 0]), {
      len: lens[i], thick: 0.0118 - i * 0.0006, curls: w.curls, pad: true,
    });
  }

  /**
   * Trigger finger, on the trigger. Built in weapon space, not grip space: the
   * grip is raked 17 degrees, so "forward" in the grip frame runs 17 degrees
   * downhill and a finger built there dives under the guard instead of reaching
   * the trigger face at (0, -0.0398, 0.0748). Kept inside |x| < 0.023 so it stays
   * within the trigger guard's loop rather than poking through its outside.
   */
  const tf = frameAt(IDENT, 0.0186, -0.0286, 0.1010, [-0.20, -0.30, -0.93], [0.62, 0.78, 0.06]);
  digit(m, tf, { len: 0.0212, thick: 0.0110, curls: [0.34, 0.46, 0.52], pad: true });

  /**
   * Thumb ACROSS the backstrap and down the LEFT flank, pointing forward.
   *
   * Not a stylistic choice — it is the only route that puts a thumb in the
   * picture. A right thumb parked on the right flank by the selector is behind
   * the receiver from this eye, and one laid high on the left flank at grip
   * y > +0.02 is inside the lower receiver (which spans |x| < 0.019,
   * y -0.029..+0.023). At grip (0.006, 0.0218, -0.030) curling down-left it
   * crosses the backstrap and lands on the flank at about weapon
   * (-0.017, -0.061, 0.126) — 32 mm below the receiver's floor, in clear air,
   * directly above the fingertips. A thumb crossing the grip's silhouette above
   * three fingertips is the whole grip read in one shape.
   */
  const th = frameAt(GRIP, 0.0060, 0.0218, -0.0300, [-0.88, -0.16, 0.44], [0.16, 0.92, 0.36]);
  digit(m, th, { len: 0.0215, thick: 0.0138, curls: [0.30, 0.34, 0.30], tipPad: true });

  // ---- forearm: back, down and outboard toward the right shoulder ----------
  forearm(m, frameAt(IDENT, 0.0210, -0.1210, 0.1520, [0.30, -0.60, 0.74], [-0.30, 0.62, 0.72]),
    { r: 0.0236, cuff: 0.0250, len: 0.2400, break: 0.10 });
}

/* ------------------------------------------------------------ support hand */

/**
 * The silhouette the support hand actually wraps: handguard PLUS top rail, as
 * one convex outline in weapon (x, y).
 *
 * The handguard is a 38 mm octagon on the bore at y = 0.030 (left flat at
 * x = -0.019 spanning y 0.0216..0.0384). The rail sits on top, |x| < 0.0106, and
 * with its polymer cover the top surface is at y = 0.0668. Between the
 * handguard's upper shoulder and the rail's flank there is a re-entrant notch —
 * so the outline *bridges* it, from (-0.0190, 0.0384) straight to
 * (-0.0106, 0.0668). A finger does the same: it spans the notch and touches at
 * both ends. Following the notch in is how a wrap ends up inside the rail cover.
 *
 * Listed in the wrap direction: up the left flank, over the rail, down the far
 * side.
 */
const HG_SEC = [
  [-0.0084, 0.0104],   // lower-left diagonal, below the flat
  [-0.0190, 0.0216],   // left flat, bottom
  [-0.0190, 0.0384],   // left flat, top — start of the bridge
  [-0.0106, 0.0668],   // rail cover, top-left
  [0.0106, 0.0668],    // rail cover, top-right
  [0.0190, 0.0384],    // right flat, top
  [0.0190, 0.0216],    // right flat, bottom
];

function supportHand(m) {
  const digits = offsetPath(HG_SEC, 0.0058);
  const palm = offsetPath(HG_SEC, 0.0115);
  const knuck = offsetPath(HG_SEC, 0.0128);

  /**
   * Rows spread along the bore, index forward. The window z -0.146..-0.074 is
   * the only clear stretch on this handguard: the left accessory rail stub
   * occupies z -0.190..-0.142 (out to x = -0.0285), the QD socket sits at
   * z = -0.150, the handstop at -0.166, and the optic's hood reaches z = -0.045.
   * Every finger here also stays above y = 0.045, which clears the stub and the
   * socket outright.
   */
  const rows = [-0.1430, -0.1225, -0.1020, -0.0815];
  const lens = [0.0228, 0.0225, 0.0210, 0.0188];
  // Mid-bridge, so the metacarpal heads ride the handguard/rail shoulder at
  // (-0.0204, 0.0542) — 9.6 mm clear of the rail web, on the flank the eye sees.
  const seeds = [0.0530, 0.0530, 0.0538, 0.0552];

  // ---- palm: a band up the left flank onto the shoulder --------------------
  /**
   * The single largest camera-facing surface on either hand. It runs from below
   * the handguard's lower-left diagonal (the hypothenar heel) up the left flat
   * and onto the bridge, ending under the knuckles, following the octagon's
   * facets rather than standing off them.
   */
  /**
   * ONE MASS, THREE STEPS, HEAVY OVERLAP — and no second "dorsum" band on top.
   *
   * The first pass of this rewrite used a six-step band plus a four-step dorsum
   * plate. Both run *up* the section while the eye looks *down* the flank, so
   * every step edge presented as a ledge and the ten of them stacked into a
   * corrugated ramp: at 5x magnification the support hand read as a pile of
   * armour plates bolted to the handguard. Fewer, deeper, overlapped steps read
   * as a palm with a curve in it, and the relief the hand needs comes from the
   * knuckles and the metacarpals instead — which are transverse to the stack and
   * therefore add information rather than more of the same.
   */
  m.use('glove');
  bandOnPath(m, palm, {
    s0: 0.0020, s1: 0.0600, z: -0.1120, steps: 3, overlap: 0.0070,
    w0: 0.0700, w1: 0.0800, h0: 0.0216, h1: 0.0250,
  });

  // ---- metacarpals fanning from the wrist onto the knuckle heads -----------
  /**
   * Wrist, below-left of the handguard's lower-left diagonal — outside the
   * section (x < -0.019) and below it (y < 0.011), so nothing of the arm is
   * inside the furniture, and 6 mm forward of the upper receiver's front face at
   * z = -0.062 so the sleeve never intersects it.
   *
   * Pushed 3 mm further down and left than the first pass, because a 25.7 mm
   * gauntlet cuff seated at the palm's own heel covered the bottom third of the
   * palm and the arm appeared to emerge from in front of the handguard rather
   * than out of the hand.
   */
  const wristPt = [-0.0255, -0.0095, -0.0790];
  const kp = [0, 0, 0, 0, 0, 0];
  /**
   * Rubber knuckle armour over the metacarpal heads — four dark blocks on a
   * lighter glove, 20.5 mm apart along the bore, dead centre of the
   * camera-facing quadrant. Kept 12.6 mm wide against that 20.5 mm pitch so
   * there is an 8 mm gap between neighbours: a knuckle row reads from its gaps,
   * and 16 mm blocks closed those gaps to 4 mm and merged into one bar.
   */
  m.use('pad');
  for (let i = 0; i < 4; i++) {
    knuck.at(seeds[i], kp);
    boxG(m, { mat4: frameAt(IDENT, kp[0], kp[1], rows[i], [0, 0, 1], [kp[4], kp[5], 0]),
      w: 0.0126, h: 0.0140, d: 0.0086, c: 0.0016, simple: true });
  }
  // Metacarpals converging on those four heads, kept low so they modulate the
  // palm rather than competing with the knuckles.
  m.use('glove');
  for (let i = 0; i < 4; i++) {
    knuck.at(seeds[i], kp);
    ridge(m, IDENT, wristPt, [kp[0], kp[1], rows[i]], 0.0032, 0.0026, [-0.90, 0.44, 0]);
  }

  // ---- the wrap: bridge the shoulder, cross the rail, down the far side ----
  m.use('glove');
  for (let i = 0; i < 4; i++) {
    const w = wrapDigit(digits, seeds[i], phalanges(lens[i]));
    digit(m, frameAt(IDENT, w.p[0], w.p[1], rows[i], [w.dir[0], w.dir[1], 0], [w.back[0], w.back[1], 0]), {
      len: lens[i], thick: 0.0114 - i * 0.0005, curls: w.curls, pad: true,
    });
  }

  /**
   * Thumb forward along the upper-left, beside the rail — the "thumb over bore"
   * cue, and the one digit silhouetted against the world rather than against the
   * weapon in every pose. It runs from the web at z = -0.1380 forward to about
   * z = -0.1930 at y 0.046..0.055, which threads above the accessory rail stub
   * (top at y = 0.041) and outboard of the folded front iron (|x| < 0.0065).
   */
  const tf = frameAt(IDENT, -0.0244, 0.0452, -0.1380, [0.05, 0.11, -0.99], [-0.90, 0.42, 0]);
  digit(m, tf, { len: 0.0224, thick: 0.0136, curls: [0.13, 0.12, 0.15], tipPad: true });

  // ---- forearm: down, left and back, off the bottom-left corner ------------
  forearm(m, frameAt(IDENT, wristPt[0], wristPt[1], wristPt[2],
    [-0.60, -0.66, 0.45], [-0.74, 0.62, 0.26]),
    { r: 0.0192, cuff: 0.0250, len: 0.3000, break: 0.18, foldPhase: 0.9 });
}

/* ------------------------------------------------------------------ build */

/**
 * @returns {{ group, meshes, triangles, right, left }}
 *
 * The two hands get their own Mesher and their own sub-group. That costs three
 * extra draw calls and buys the ability to ablate one hand at a time from the
 * screenshot rig — which is the tool that finally located this defect, after
 * four rounds in which "the geometry is there and it projects into frame" was
 * accepted as evidence that it was on screen.
 */
export function buildHands(mats) {
  const group = new THREE.Group();
  group.name = 'vm:hands';
  const meshes = [];
  let triangles = 0;
  const out = {};

  for (const [side, build] of [['right', firingHand], ['left', supportHand]]) {
    const m = new Mesher();
    build(m);
    const sub = new THREE.Group();
    sub.name = `vm:hand:${side}`;
    for (const [key, geo] of m.geometries()) {
      const mesh = new THREE.Mesh(geo, mats[key] ?? mats.glove);
      mesh.name = `vm:hand:${side}:${key}`;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.frustumCulled = false;
      sub.add(mesh);
      meshes.push(mesh);
    }
    triangles += m.triangleCount();
    group.add(sub);
    out[side] = sub;
  }

  return { group, meshes, triangles, right: out.right, left: out.left };
}
