import * as THREE from 'three';
import {
  IDENT, child, frameAt, offsetPath, wrapDigit, phalanges, buildRig,
  loft, jointBlend, blister, Skin, SEG_TH,
} from './Wrap.js';

/**
 * OWNER: viewmodel agent.
 *
 * Gloved first-person hands: ONE SKINNED SURFACE PER LIMB, on a 17-bone rig.
 *
 * ─── WHAT WAS WRONG, AND IT WAS NOT THE PLACEMENT ─────────────────────────
 *
 * Six revisions solved *where* the hand goes. The seventh review said the
 * placement was finally right and the asset was still disqualifying:
 *
 *   "the hand is a stack of unskinned PVC capsules … four detached capsules with
 *    visible gaps beside the grip — there is no palm … no thumb wrap … every
 *    joint capped by a teal ring … the support hand has zero finger separation
 *    and reads as a wooden foregrip."
 *
 * Two numbers, both now asserted by tools/handcheck.mjs, say how far off it was:
 * the hand mask had **120 connected components** where a hand has one, and 1.62%
 * of its pixels sat in the cyan hue band. Neither is a placement problem. Both
 * are consequences of building a hand out of closed solids — see the header of
 * Wrap.js for the mechanism, which was measured rather than guessed.
 *
 * ─── WHAT IS KEPT, BECAUSE IT WAS THE PART THAT WORKED ────────────────────
 *
 * `offsetPath` and `wrapDigit`. Those solved the one thing four rounds could not:
 * a digit whose joints all sit exactly one half-thickness off a *faceted* weapon
 * section, walked by chord length so each phalanx is its true length. That solve
 * is still what places every joint here. What changed is that the solution is now
 * a LOFT PATH rather than a list of places to drop capsules — so the surface
 * between the joints exists, and the joints cannot gap because there is nothing
 * there to come apart.
 *
 * The measured eye position is also unchanged and still governs everything. In
 * *weapon* space the camera sits at (-0.3134, +0.2389, +0.5404): 313 mm left of
 * the bore, 239 mm above, 540 mm behind. It therefore sees the weapon's LEFT
 * flank, its top and its rear, and the receiver/magwell/magazine occlude
 * everything at x > 0 behind them. Every part of these hands that is meant to be
 * seen is on the left flank, the underside or in open air.
 *
 * ─── THE ANATOMY ──────────────────────────────────────────────────────────
 *
 *   PALM. A closed lofted tube swept along the weapon's own offset path, one palm
 *   half-thickness out, from the wrist to just past the knuckle line, capped at
 *   the distal end with the section's own topology. Its width axis is the finger
 *   row axis, so the four fingers grow out of that cap where a real hand's do.
 *   Four metacarpal ridges and the knuckle heads are radial DISPLACEMENT of that
 *   one surface, not parts bolted to it, so they add relief without adding a
 *   silhouette — which is what turned the last version's relief into couplings.
 *
 *   FINGERS. One tube each, through all three phalanges, rooted 7 mm INSIDE the
 *   palm so there is no seam to see and no cap to catch a rim light. The knuckle
 *   bulges and the flexion creases are displacement on the same surface.
 *
 *   THUMB IN OPPOSITION. A tube that starts inside the palm at the thenar, so the
 *   ball of the thumb and the thumb are one mass, and crosses to the far side of
 *   the grip. On the firing hand it comes over the backstrap and down the LEFT
 *   flank, breaking the grip's silhouette above the fingertips; on the support
 *   hand it runs forward along the upper left beside the rail, silhouetted
 *   against the world in every pose.
 *
 *   PANELS. The leather palm panel, the knuckle pads and the finger pads are
 *   *blisters* on the surface they sit on: raised in the middle, tapering to zero
 *   at their own rim, lifted a tenth of a millimetre so they cannot z-fight. A
 *   blister has no edge and no cap, and it deforms with the finger because it
 *   shares the finger's stations and therefore its skin weights.
 *
 *   CUFF AND FOREARM. One tube continuing out of the wrist section, so the glove
 *   does not end in a disc. Its wrinkles are a helical displacement field on that
 *   single surface — the previous version's separate fold cylinders were what
 *   turned the forearm into corrugated conduit, and every one of them contributed
 *   another grazing ring.
 */

/* ------------------------------------------------------------------- rig ids */

const B_WRIST = 0;
const B_PALM = 1;
/** Digit d (0..3 fingers, 4 thumb), phalanx k (0..2). */
const BD = (d, k) => 2 + d * 3 + k;
const N_BONES = 17;

/** Segment bone/parent pairs for a wrapped finger: root-in-palm, then 3 bones. */
const fingerBones = (d) => [
  [BD(d, 0), B_PALM], [BD(d, 0), B_PALM], [BD(d, 1), BD(d, 0)], [BD(d, 2), BD(d, 1)],
];
/** Thumb: metacarpal out of the palm, then two phalanges. */
const THUMB_BONES = [[BD(4, 0), B_PALM], [BD(4, 1), BD(4, 0)], [BD(4, 2), BD(4, 1)]];

const lerp = (a, b, t) => a + (b - a) * t;
const sstep = (e0, e1, x) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/* --------------------------------------------------------------- profiles */

/**
 * A digit's section along its own length.
 *
 * 1.17:1 wide-to-deep. A round finger reads as a peg and four pegs read as a
 * rake; the flattening is what lets four fingers side by side still show four
 * gaps, which is the only cue that separates a hand from a foregrip.
 *
 * Segment 0 is the root inside the palm and is 1.34x thick, so it is comfortably
 * buried in the palm mass no matter how the loft curves into it.
 */
function digitProf(th) {
  return (s, u) => {
    const k = s === 0
      ? lerp(1.34, 1.0, u)
      : lerp(SEG_TH[s - 1], SEG_TH[s], u);
    return {
      /**
       * n 2.90, up from 2.45, and the width down from 0.585 to 0.556.
       *
       * Both changes serve one thing the review named twice: "the support hand
       * is a smooth cream sausage with no finger separation". Four fingers at
       * 20.5 mm centres with 13.7 mm sections already had 6.8 mm of air between
       * them — the gap was never missing, it was invisible. A near-elliptical
       * section shades continuously from its own centre out to its silhouette, so
       * two neighbouring ellipses meet in a smooth ramp with no boundary in it,
       * and at ADS foreshortening that ramp is the whole read. A higher
       * superelliptic exponent puts flat sides and a defined corner on each
       * digit: the flanks are parallel walls facing each other, the light between
       * them falls off fast, and the corner gives the eye a line to stop on.
       *
       * Narrowing by 5% widens each gap by 0.7 mm on top of that. Any more and
       * the fingers stop touching the weapon, which is the property four earlier
       * rounds were spent buying.
       */
      a: th * 0.556 * k, b: th * 0.500 * k, n: 2.90,
      wp: s === 0 ? 0 : jointBlend(u),
    };
  };
}

/**
 * A pad with a FLAT top and a rolled edge, rather than a blister.
 *
 * `blister` tapers to zero at its own rim in both axes, which is exactly right
 * for a knuckle bulge and exactly wrong for a piece of armour lying ON the
 * glove: a shape that reaches its height only at its centre never breaks the
 * silhouette of the thing it sits on, so the review saw "no knuckle pads" while
 * five of them were being emitted per hand. This holds full height across the
 * middle of its window and rolls off over the last `roll` of each axis, so the
 * pad has an EDGE — a step the glove's outline is visibly interrupted by — and
 * still returns to zero at the rim so the surface stays closed.
 */
function plateau(c0, c1, r0, r1, h, roll = 0.16) {
  return (t, rf) => {
    if (t < c0 || t > c1 || rf < r0 || rf > r1) return 0;
    const a = (t - c0) / (c1 - c0), b = (rf - r0) / (r1 - r0);
    const fa = Math.min(1, Math.min(a, 1 - a) / roll);
    const fb = Math.min(1, Math.min(b, 1 - b) / roll);
    return h * Math.pow(fa, 0.55) * Math.pow(fb, 0.55);
  };
}

/**
 * Lateral panel seams, at the ring parameters where a glove's two halves are
 * sewn together — t = 0 (and 1) and t = 0.5, i.e. the two sides of the digit.
 *
 * Seams belong on the SIDES, not down the back. A seam on the dorsal centreline
 * is a decoration; a seam on the flank sits on the digit's own silhouette from
 * almost every angle, so it breaks the outline as well as the surface, and it
 * lands in the same place as the shadow between adjacent fingers. The tiled
 * glove texture already carries stitching, but a tiled texture cannot know where
 * a panel edge is — only the geometry does, which is the same argument the
 * weapon's M-LOK cavities are built on.
 *
 * @returns { ridge(t,rf), groove(t,rf) } displacement and occlusion, 0..1
 */
function lateralSeam(width = 0.030) {
  const d = (t) => {
    const a = Math.min(Math.abs(t - 0.5), Math.min(t, 1 - t));
    return Math.max(0, 1 - a / width);
  };
  return {
    ridge: (t, rf) => Math.pow(d(t), 1.6) * sstep(0.02, 0.14, rf),
    groove: (t, rf) => Math.pow(d(t), 0.9) * sstep(0.02, 0.14, rf),
  };
}

/**
 * Knuckle bulges and flexion creases as displacement.
 *
 * With four loft segments the interior joints land at row fractions 0.50 and
 * 0.75 exactly, which is why the loft uses a uniform station count per segment
 * rather than a length-proportional one — it makes the joint positions
 * addressable in the displacement field without threading a table through.
 *
 * Dorsal is ring parameter 0.25, palmar 0.75.
 */
function digitDisp(th, jr) {
  const bulge = jr.map((r) => blister(0.02, 0.48, r - 0.105, r + 0.105, th * 0.155));
  const crease = jr.map((r) => blister(0.54, 0.96, r - 0.055, r + 0.055, -th * 0.215));
  // The crease wraps ROUND the digit, not just across its palmar face: a flexed
  // knuckle folds the whole tube. Without the dorsal half of it the back of the
  // finger is a smooth cylinder between two bulges, which is most of what made
  // it read as a peg.
  const dorsal = jr.map((r) => blister(0.02, 0.48, r - 0.030, r + 0.030, -th * 0.070));
  const seam = lateralSeam();
  return (t, rf) => {
    let d = 0;
    for (let i = 0; i < bulge.length; i++) {
      d += bulge[i](t, rf) + crease[i](t, rf) + dorsal[i](t, rf);
    }
    // The sewn panel edge stands a third of a millimetre proud all down the
    // flank; the welt beside it is pulled in.
    return d + seam.ridge(t, rf) * th * 0.055 - seam.groove(t, rf) * th * 0.030;
  };
}

/**
 * Contact occlusion between neighbouring digits.
 *
 * Four fingers side by side shadow each other. Nothing in the renderer supplies
 * that: the viewmodel is composited after the screen-space AO pass, so the hands
 * get no ambient occlusion at all, and the tiled texture cannot know that this
 * particular patch of glove has another finger 3 mm from it. Only the geometry
 * knows, and `aCav` is the channel that already carries exactly this kind of
 * knowledge on the weapon.
 *
 * It is strongest at the flanks (t near 0 and 0.5, where the neighbour is),
 * strongest at the root and fading toward the tip (where the fingers splay), and
 * biased to the palmar side because that is the side that closes up.
 */
function digitContact() {
  const seam = lateralSeam(0.085);
  return (t, rf) => {
    const flank = Math.pow(Math.max(0, 1
      - Math.min(Math.abs(t - 0.5), Math.min(t, 1 - t)) / 0.085), 1.2);
    const palmar = 0.62 + 0.38 * Math.sin(Math.PI * Math.min(1, Math.max(0, t)));
    return Math.min(0.85, flank * palmar * (1 - 0.45 * sstep(0.45, 1.0, rf))
      + seam.groove(t, rf) * 0.30);
  };
}

/** Forward kinematics down a hinge chain, for digits not solved on a wrap path. */
function fkJoints(frame, lens, curls) {
  const pts = [new THREE.Vector3().setFromMatrixPosition(frame)];
  let j = frame;
  for (let s = 0; s < lens.length; s++) {
    j = child(child(j, 0, 0, 0, curls[s] ?? 0), 0, 0, lens[s]);
    pts.push(new THREE.Vector3().setFromMatrixPosition(j));
  }
  return pts;
}

/* ------------------------------------------------------------ hand assembly */

/**
 * Build one hand. `d` supplies the weapon-specific solve; everything structural
 * — palm, fingers, thumb, pads, cuff, forearm, rig — is shared, because the two
 * hands differ only in which section they wrap and how far round it they go.
 */
function buildHand(d) {
  const skin = new Skin();
  const joints = new Array(N_BONES);
  const put = (i, name, parent, p, m) => { joints[i] = { name, parent, p, m }; };

  // ---- palm ---------------------------------------------------------------
  /**
   * The palm's axis lies on the weapon's offset path at exactly the palm's own
   * half-thickness, so its inner surface is ON the weapon and its outer surface
   * is one thickness out. The previous version's straight slab could not do that:
   * a chord across a grip flank runs 8 mm inside the surface at its middle, which
   * is why the palm band had to be authored as a stack of steps and why the steps
   * read as armour plates.
   */
  const palmPath = offsetPath(d.sec, d.palmB);
  const pp = [0, 0, 0, 0, 0, 0];
  const onPath = (s) => {
    palmPath.at(s, pp);
    return new THREE.Vector3(pp[0], pp[1], d.rowMid).applyMatrix4(d.frame);
  };
  palmPath.at(d.palmS0, pp);
  const heelDir = [pp[2], pp[3], 0];        // path tangent at the wrist end
  const heelBack = [pp[4], pp[5], 0];       // path outward normal = dorsal
  /**
   * THE WRIST IS AUTHORED, NOT DERIVED.
   *
   * Deriving it by walking back along the path's own tangent was tried and put
   * the wrist under the handguard's lower-left facet, where a section thick
   * enough to be a wrist is 9 mm inside the furniture. These two points are the
   * ones the previous revision had already verified clear of every part: the
   * support wrist is outside the octagon (x < -0.019) and below it (y < 0.011) and
   * 6 mm forward of the upper receiver's front face; the firing wrist is below and
   * behind the grip's buttcap.
   */
  const wristP = new THREE.Vector3(d.wrist[0], d.wrist[1], d.wrist[2]).applyMatrix4(d.frame);
  const wristM = frameAt(d.frame, d.wrist[0], d.wrist[1], d.wrist[2], heelDir, heelBack);

  const palmJ = [wristP];
  const NP = 5;
  for (let i = 0; i <= NP; i++) palmJ.push(onPath(lerp(d.palmS0, d.palmS1, i / NP)));
  const palmBones = palmJ.slice(1).map(() => [B_PALM, B_WRIST]);

  /**
   * Palm section: a nearly round WRIST at one end, a wide flat PALM at the other.
   *
   * These have to be two independent pairs of numbers, and getting that wrong is
   * visible immediately. The first pass derived the wrist from the palm's width
   * (which is the span across the four metacarpals, 72 mm) and its thickness
   * (19 mm, because the palm has to hug a 38 mm handguard). That makes a 72 x 19
   * wrist, and since the forearm inherits the wrist section to keep the seam
   * watertight, both forearms rendered as flat ribbons — clearly wrong in the
   * first screenshot and not guessable from the code.
   *
   * `n` also interpolates: a wrist is round, the back of a hand is flat. An
   * elliptical palm is the second most common reason a first-person hand reads as
   * a sausage; the first is a round finger.
   */
  const palmProf = (s, u, gu) => ({
    a: lerp(d.wristA, d.palmA, sstep(0.05, 0.50, gu)) * lerp(1.0, 0.95, sstep(0.76, 1.0, gu)),
    b: lerp(d.wristB, d.palmB, sstep(0.03, 0.58, gu)) * lerp(1.0, 0.88, sstep(0.70, 1.0, gu)),
    n: lerp(2.25, 3.00, sstep(0.05, 0.55, gu)),
    wp: gu < 0.24 ? 0.44 * (1 - gu / 0.24) : 0,
  });

  const palmSt = loft(palmJ, 3, palmProf, wristM, palmBones);
  put(B_WRIST, 'wrist', -1, wristP.toArray(), wristM);
  put(B_PALM, 'palm', B_WRIST, palmJ[2].toArray(), palmSt.frames[1]);

  // ---- fingers -------------------------------------------------------------
  const digits = offsetPath(d.sec, d.digitOff);
  const kp = [0, 0, 0, 0, 0, 0];
  /** Ring parameter of each finger row on the palm's dorsal face, for ridges. */
  const ridgeT = [];
  const fingerSt = [];

  for (let i = 0; i < 4; i++) {
    const row = d.rows[i];
    ridgeT.push(0.25 - ((row - d.rowMid) / d.palmA) * 0.155);

    let jw, seedDir, seedBack;
    if (d.trigger && i === d.trigger.index) {
      // The trigger finger is not on the wrap path: it leaves the grip and
      // reaches into the guard, so it is solved by FK from an aimed frame.
      const t = d.trigger;
      const f = frameAt(d.frame, t.p[0], t.p[1], row, t.dir, t.back);
      jw = fkJoints(f, phalanges(t.len), t.curls);
      seedDir = t.dir; seedBack = t.back;
    } else {
      const w = wrapDigit(digits, d.seeds[i], phalanges(d.lens[i]));
      jw = w.joints.map((q) => new THREE.Vector3(q[0], q[1], row).applyMatrix4(d.frame));
      seedDir = [w.dir[0], w.dir[1], 0];
      seedBack = [w.back[0], w.back[1], 0];
    }

    // Root the finger inside the palm: prepend a joint 7 mm back along the seed
    // direction. That is what removes the gap the review called out — the first
    // ring of the tube is submerged, so there is nothing to see and nothing to
    // cap.
    digits.at(d.seeds[i], kp);
    const back = new THREE.Vector3(seedDir[0], seedDir[1], seedDir[2] ?? 0)
      .transformDirection(d.frame).multiplyScalar(-0.0070);
    const jAll = [jw[0].clone().add(back), ...jw];

    const th = d.thick - i * d.thickStep;
    const first = frameAt(d.frame, kp[0], kp[1], row, seedDir, seedBack);
    first.setPosition(jAll[0]);
    const st = loft(jAll, 3, digitProf(th), first, fingerBones(i));
    fingerSt.push({ st, th });

    put(BD(i, 0), `f${i}a`, B_PALM, jAll[1].toArray(), st.frames[1]);
    put(BD(i, 1), `f${i}b`, BD(i, 0), jAll[2].toArray(), st.frames[2]);
    put(BD(i, 2), `f${i}c`, BD(i, 1), jAll[3].toArray(), st.frames[3]);
  }

  // ---- thumb ---------------------------------------------------------------
  const t = d.thumb;
  const thumbFrame = frameAt(d.frame, t.p[0], t.p[1], t.p[2], t.dir, t.back);
  /**
   * A thumb has TWO phalanges, not three, and the metacarpal is the third segment
   * — which here runs from inside the palm out to the MCP, so the thenar eminence
   * and the thumb are one mass rather than the previous version's detached web
   * cylinder plus a floating digit.
   */
  const thJ = fkJoints(thumbFrame, [t.len, t.len * 0.78], t.curls);
  const thRoot = new THREE.Vector3(t.root[0], t.root[1], t.root[2]).applyMatrix4(d.frame);
  const thAll = [thRoot, ...thJ];
  const thumbProf = (s, u) => {
    const k = s === 0 ? lerp(1.62, 1.02, u) : lerp(SEG_TH[s], SEG_TH[s + 1], u);
    return { a: t.th * 0.60 * k, b: t.th * 0.52 * k, n: 2.5, wp: s === 0 ? 0 : jointBlend(u) };
  };
  const thumbSt = loft(thAll, 3, thumbProf, thumbFrame, THUMB_BONES);
  /**
   * A bone's origin is the START joint of the first segment it weights, not the
   * end. The thumb is off by one from the fingers because its first segment is the
   * metacarpal and it is weighted to `tha`, whereas a finger's first two segments
   * (the in-palm root and the proximal phalanx) are BOTH weighted to `f*a`, whose
   * pivot is therefore the MCP. Getting this wrong is invisible at rest — the bind
   * inverses absorb any origin — and wrong the moment a bone is rotated.
   */
  put(BD(4, 0), 'tha', B_PALM, thAll[0].toArray(), thumbSt.frames[0]);
  put(BD(4, 1), 'thb', BD(4, 0), thAll[1].toArray(), thumbSt.frames[1]);
  put(BD(4, 2), 'thc', BD(4, 1), thAll[2].toArray(), thumbSt.frames[2]);

  // ---- emit the glove surfaces --------------------------------------------
  /**
   * Metacarpal ridges and knuckle heads, as displacement on the palm.
   *
   * Four ridges *parallel* across the back of a hand read as corrugation; four
   * converging from one wrist onto four separated knuckle heads read as a hand.
   * The convergence is in the ridge's ring parameter, which walks from the row's
   * own angle at the knuckles to a single angle at the wrist.
   */
  /**
   * Crease occlusion, in the `aCav` channel the wear shader already reads. A fold
   * in fabric is dark because it is a fold, and the tiled glove texture cannot
   * know where the folds are — only the geometry does. This is the mechanism the
   * weapon's M-LOK slots use, reused on cloth, and it is what the review meant by
   * "crease darkening in the finger folds".
   */
  const contact = digitContact();
  const digitCav = (jr) => {
    const f = jr.map((r) => blister(0.50, 1.00, r - 0.085, r + 0.085, 0.72));
    // The dorsal half of the same fold. A knuckle crease that darkens only the
    // palm side leaves the back of the finger as an unbroken tube.
    const g = jr.map((r) => blister(0.00, 0.50, r - 0.040, r + 0.040, 0.34));
    return (tt, gf) => {
      let c = 0;
      for (let i = 0; i < f.length; i++) c += f[i](tt, gf) + g[i](tt, gf);
      return Math.min(0.86, c + contact(tt, gf) * 0.55);
    };
  };
  /**
   * Palm occlusion, plus the WEB VALLEYS between the metacarpal heads.
   *
   * Four knuckle mounds with nothing between them are four mounds on a slab. The
   * gap between two fingers does not start at the fingers — it starts 15 mm back
   * on the back of the hand, as a valley running down between the metacarpals,
   * and that valley is what carries the separation at any angle where the fingers
   * themselves are foreshortened. Which is exactly the ADS frame, where the
   * review read the support hand as one sausage.
   */
  const webT = [];
  for (let i = 0; i + 1 < 4; i++) webT.push((ridgeT[i] + ridgeT[i + 1]) * 0.5);
  const palmCav = (tt, gf) => {
    let web = 0;
    for (const c of webT) {
      web += Math.pow(Math.max(0, 1 - Math.abs(tt - c) / 0.036), 1.3)
        * sstep(0.30, 0.78, gf);
    }
    return Math.min(0.72,
      blister(0.56, 0.96, 0.30, 0.94, 0.42)(tt, gf)
      + blister(0.02, 0.48, 0.90, 1.00, 0.34)(tt, gf)
      + Math.min(0.55, web));
  };

  const palmDisp = (tt, rf) => {
    let dd = 0;
    const grow = sstep(0.16, 0.62, rf);
    for (let i = 0; i < 4; i++) {
      const tc = lerp(0.25, ridgeT[i], Math.min(1, rf * 1.30));
      const w = Math.exp(-(((tt - tc) / 0.0295) ** 2));
      dd += 0.00175 * w * grow;
      // Knuckle head: a broader, taller mound over the last quarter.
      const wh = Math.exp(-(((tt - ridgeT[i]) / 0.052) ** 2));
      dd += 0.00300 * wh * sstep(0.66, 0.94, rf) * (1 - sstep(0.94, 1.0, rf));
    }
    // The valleys between them, cut as far as they are raised. A mound needs a
    // trough beside it or it is a bump on a flat, and it is the trough that
    // survives foreshortening.
    for (let i = 0; i + 1 < 4; i++) {
      const c = (ridgeT[i] + ridgeT[i + 1]) * 0.5;
      dd -= 0.00195 * Math.exp(-(((tt - c) / 0.034) ** 2)) * sstep(0.28, 0.76, rf);
    }
    // Hypothenar pad on the palmar side near the wrist, and a shallow palm hollow.
    dd += blister(0.56, 0.94, 0.04, 0.42, 0.0018)(tt, rf);
    dd -= blister(0.60, 0.90, 0.42, 0.86, 0.0013)(tt, rf);
    return dd;
  };

  skin.use('glove');
  skin.tube(palmSt, { seg: 22, capEnd: 3, capScale: 0.40, disp: palmDisp, cav: palmCav });
  for (let i = 0; i < 4; i++) {
    const { st, th } = fingerSt[i];
    skin.tube(st, {
      seg: 14, capEnd: 3, disp: digitDisp(th, [0.50, 0.75]), cav: digitCav([0.50, 0.75]),
    });
  }
  skin.tube(thumbSt, {
    seg: 14, capEnd: 3, disp: digitDisp(t.th, [0.667]), cav: digitCav([0.667]),
  });

  // ---- leather palm panel --------------------------------------------------
  /**
   * The hide panel a real tactical glove has across its palm. It is the largest
   * single camera-facing surface on either hand, and it is a different material
   * from the woven back for a measurable reason: at the same material the biggest
   * shape on the hand had no internal boundary anywhere. Roughness 0.46-0.62
   * against the fabric's 0.74-0.95 parts them under any light without needing a
   * value trick to do it.
   */
  skin.use('leather');
  skin.tube(palmSt, {
    seg: 16, arc: [0.545, 0.955],
    disp: (tt, rf) => 0.00012 + blister(0.545, 0.955, 0.02, 0.99, 0.00085)(tt, rf)
      + palmDisp(tt, rf),
  });

  // ---- knuckle armour and finger pads -------------------------------------
  /**
   * Rubber knuckle armour over the proximal phalanges and pads on the palmar side
   * of the distal ones. Both are blisters on the finger's own surface, so they
   * carry the finger's skin weights and cannot detach from it; and being blisters
   * they have no rim edge to catch the fill light.
   */
  /**
   * A pad is emitted over a SLICE of its finger's stations — the proximal phalanx
   * for the knuckle armour, the distal for the fingertip pad. Because `disp` is
   * keyed to each station's fraction along the ORIGINAL run and not to its row
   * index in this call, the slice sits on exactly the surface the full finger has
   * there, bulges included. Emitting over the whole run instead would clothe the
   * entire finger in dark rubber, which is the trap this indirection exists for.
   */
  skin.use('pad');
  for (let i = 0; i < 4; i++) {
    const { st, th } = fingerSt[i];
    const base = digitDisp(th, [0.50, 0.75]);
    /**
     * KNUCKLE ARMOUR, now with an edge. `plateau` instead of `blister`, and 2.4x
     * the height: 0.26 of the digit's thickness is 3.1 mm of moulded rubber
     * standing off a 12 mm finger, which is what a hard-knuckle glove actually
     * has and which is thick enough that the finger's outline steps at the pad's
     * rim. At the old 0.15 with a blister profile the pad reached its height only
     * at its own centre and contributed no silhouette anywhere, which is why the
     * review could not find it.
     */
    skin.tube(st.slice(2, 8), {
      seg: 14, arc: [0.045, 0.455],
      disp: (tt, gf) => 0.00012 + base(tt, gf)
        + plateau(0.045, 0.455, 0.235, 0.525, th * 0.260)(tt, gf),
      // The pad's own rim casts into the glove under it, and the moulded relief
      // has a valley down its centre.
      cav: (tt, gf) => 0.30 * plateau(0.045, 0.455, 0.235, 0.525, 1, 0.30)(tt, gf),
    });
    // Narrower than the knuckle pad and stopping short of the tip: at foreground
    // magnification a pad that reached the fingertip and wrapped a third of the
    // section read as a grey bruise rather than as a grip pad.
    skin.tube(st.slice(8, 13), {
      seg: 12, arc: [0.615, 0.885],
      disp: (tt, gf) => 0.00012 + base(tt, gf)
        + plateau(0.615, 0.885, 0.770, 0.968, th * 0.155, 0.22)(tt, gf),
    });
  }
  const thBase = digitDisp(t.th, [0.667]);
  skin.tube(thumbSt.slice(6, 10), {
    seg: 12, arc: [0.575, 0.925],
    disp: (tt, gf) => 0.00012 + thBase(tt, gf)
      + plateau(0.575, 0.925, 0.735, 0.995, t.th * 0.160, 0.22)(tt, gf),
  });
  /**
   * THUMB-CROTCH SEAM. The web between thumb and palm is where every panel on a
   * glove meets, and the review asked for it by name. It is emitted as a raised
   * binding on the thumb's own metacarpal stations, wrapping the side that faces
   * the palm, so it deforms with the thumb and reads as the join between the
   * thenar panel and the back.
   */
  skin.tube(thumbSt.slice(0, 4), {
    seg: 12, arc: [0.145, 0.470],
    disp: (tt, gf) => 0.00010 + thBase(tt, gf)
      + plateau(0.145, 0.470, 0.0, 0.34, t.th * 0.085, 0.34)(tt, gf),
    cav: (tt, gf) => 0.55 * plateau(0.145, 0.470, 0.0, 0.34, 1, 0.42)(tt, gf),
  });

  // ---- cuff and forearm ----------------------------------------------------
  /**
   * ONE tube out of the wrist section, seeded on the palm's own first station and
   * pushed 6 mm back INTO the palm so the two surfaces interpenetrate rather than
   * merely abut. Two rules survive from the round-7 image, and both were paid for
   * with a review that read the forearm as plumbing:
   *
   *   1. IT MUST LEAVE THE FRAME. A capped cone end seen near-on is a disc with a
   *      rim, and five reviewers read one as a length of pipe lying in the level.
   *      No cap here at all, and the run is long enough to put the elbow off the
   *      edge in every pose.
   *   2. IT MUST NOT BE SMOOTH. A cone has exactly one highlight, a straight one
   *      down its length. Here the taper is hard (a real sleeved forearm goes from
   *      a 21 mm wrist to a 34 mm elbow), there is a break between the two panels,
   *      and helical wrinkles break the highlight everywhere along the run —
   *      as DISPLACEMENT, not as the separate fold cylinders the last version
   *      used, every one of which added another grazing ring.
   */
  const fwd = new THREE.Vector3(d.fore.dir[0], d.fore.dir[1], d.fore.dir[2]).normalize();
  const foreJ = [
    wristP.clone().addScaledVector(fwd, -0.0060),
    wristP.clone().addScaledVector(fwd, d.fore.len * 0.30),
    wristP.clone().addScaledVector(fwd, d.fore.len * 0.62),
  ];
  // A break between the panels: the second half swings a few degrees.
  const bend = new THREE.Vector3(d.fore.bend[0], d.fore.bend[1], d.fore.bend[2]);
  foreJ.push(foreJ[2].clone().addScaledVector(fwd, d.fore.len * 0.38).add(bend));
  const foreM = frameAt(IDENT, foreJ[0].x, foreJ[0].y, foreJ[0].z,
    d.fore.dir, [heelBack[0], heelBack[1], heelBack[2]]);
  // The forearm inherits the WRIST section exactly, which is what makes the seam
  // watertight without a cap at either end.
  const fa = d.wristA, fb = d.wristB;
  const foreProf = (s, u, gu) => {
    // Gauntlet cuff: a flare over the first 18% of the run, then the sleeve.
    const flare = 1 + 0.185 * Math.sin(Math.PI * Math.min(1, gu / 0.19));
    // A real sleeved forearm swells markedly from wrist to elbow; 1.62 left it
    // reading as a tube of constant width under foreshortening.
    const grow = lerp(1.0, 1.92, sstep(0.14, 1.0, gu));
    return { a: fa * flare * grow, b: fb * flare * grow, n: 2.25, wp: 0 };
  };
  const foreSt = loft(foreJ, 3, foreProf, foreM,
    foreJ.slice(1).map(() => [B_WRIST, B_WRIST]));

  skin.use('sleeve');
  skin.tube(foreSt, {
    seg: 18,
    disp: (tt, rf) => {
      if (rf < 0.20) return 0;
      const amp = 0.00105 * (0.35 + rf);
      return amp * (0.62 * Math.sin((tt * 3 + rf * 4.4) * Math.PI * 2)
        + 0.38 * Math.sin((tt * 5 - rf * 2.7) * Math.PI * 2 + 1.1));
    },
  });
  /**
   * ---- WRIST CUFF -------------------------------------------------------
   *
   * The review: "No wrist cuff; a hard diagonal colour break butts hand to
   * sleeve." Both halves of that are one defect. The glove tube ended and the
   * sleeve tube began at the same station, in two materials four stops apart in
   * value, so the join was a line across the arm with nothing on it — and a line
   * across a limb reads as a coupling, which is the exact failure this file
   * spent round 7 removing from the forearm.
   *
   * A real glove does not solve this by blending the two colours. It solves it
   * with a THIRD PIECE: a neoprene gauntlet that laps over the sleeve and is
   * bound to the glove, so the transition is 55 mm of a different substance with
   * its own edges, its own nap and its own closure. That is what this is.
   *
   * It is a separate loft rather than a profile bump on the forearm for one
   * reason that matters: it has to start INSIDE the palm. Seeded 10 mm back from
   * the wrist along the forearm axis and at 1.16x the wrist section, its first
   * rings are buried in the glove, so there is no boundary between cuff and
   * glove anywhere — the cuff simply emerges. At its far end it tucks back under
   * the sleeve at 0.97x, so there is no open ring and no second butt joint
   * either. Two overlaps instead of two abutments.
   */
  const cuffJ = [
    wristP.clone().addScaledVector(fwd, -0.0100),
    wristP.clone().addScaledVector(fwd, 0.0120),
    wristP.clone().addScaledVector(fwd, 0.0330),
    wristP.clone().addScaledVector(fwd, 0.0520),
  ];
  const cuffM = frameAt(IDENT, cuffJ[0].x, cuffJ[0].y, cuffJ[0].z,
    d.fore.dir, [heelBack[0], heelBack[1], heelBack[2]]);
  // Radius against the two neighbours it has to cover. The forearm at this end
  // of its run is wrist x flare x grow; the cuff stays proud of it until the
  // last station, where it dives under.
  const cuffK = [1.16, 1.26, 1.24, 0.97];
  const cuffProf = (s, u) => {
    const k = lerp(cuffK[s], cuffK[s + 1], u);
    return { a: fa * k, b: fb * k, n: 2.30, wp: 0 };
  };
  const cuffSt = loft(cuffJ, 3, cuffProf, cuffM,
    cuffJ.slice(1).map(() => [B_WRIST, B_WRIST]));

  skin.use('cuff');
  skin.tube(cuffSt, {
    seg: 20,
    // Elasticated gathers: a ring of shallow tucks round the band, deepest in
    // its middle where the elastic pulls hardest. Displacement on the one
    // surface, never separate rings — see the forearm's note above.
    disp: (tt, rf) => {
      const pull = Math.sin(Math.PI * Math.min(1, Math.max(0, rf)));
      return 0.00090 * pull * Math.sin(tt * 9 * Math.PI * 2)
        - 0.00060 * sstep(0.86, 1.0, rf);
    },
    cav: (tt, rf) => Math.min(0.70,
      0.34 * (0.5 - 0.5 * Math.cos(tt * 9 * Math.PI * 2))
        * Math.sin(Math.PI * Math.min(1, Math.max(0, rf)))
      + 0.55 * sstep(0.88, 1.0, rf)),
  });

  // Closure strap across the cuff: one interrupted arc, not a ring. A continuous
  // dark band round a cone is half of the coupling read all by itself. It now
  // sits on the CUFF rather than on the bare sleeve, which is where a
  // hook-and-loop tab actually is and which gives the band an object to belong
  // to instead of being a stripe painted on an arm.
  skin.use('pad');
  skin.tube(cuffSt.slice(2, 8), {
    seg: 14, arc: [0.62, 1.06],
    disp: (tt, gf) => 0.00014
      + plateau(0.62, 1.06, 0.20, 0.58, 0.00095, 0.20)(tt, gf),
    cav: (tt, gf) => 0.42 * plateau(0.62, 1.06, 0.20, 0.58, 1, 0.30)(tt, gf),
  });

  return { skin, joints };
}

/* ------------------------------------------------------- the two hand solves */

/**
 * Firing hand. The pistol grip's section in grip-local (x, y), in the wrap
 * direction: from the backstrap over the right flank, round the front strap, up
 * the left flank. The grip box is 32.2 x 43.0 mm with a 7 mm chamfer; these are
 * its mid-length half-extents with the chamfer corners called out, so the offset
 * path arcs round exactly the radius the real front strap has.
 *
 * Grip frame: +X right, +Y rearward (toward the backstrap), +Z down the grip.
 */
const GRIP_SEC = [
  [0.0088, 0.0210], [0.0158, 0.0140], [0.0158, -0.0140], [0.0088, -0.0210],
  [-0.0088, -0.0210], [-0.0158, -0.0140], [-0.0158, 0.0140],
];

/** Grip frame in weapon space — matches lowerReceiver()'s `grip` exactly. */
const GRIP = child(IDENT, 0, -0.0742, 0.1178, Math.PI / 2 - 0.30);

const RIGHT = {
  frame: GRIP, sec: GRIP_SEC,
  /**
   * WRAP FURTHER THAN LOOKS NECESSARY. The grip's front strap faces weapon
   * (0, -0.296, -0.955) — down and *forward* — so from an eye 540 mm behind the
   * weapon it is a back face, and everything a finger does there is hidden. Only
   * the part that comes round onto the LEFT flank is photographed. A 57 mm finger
   * reaches the flank with 4 mm to spare and shows three fingertip nubs; a 68 mm
   * one — also the real length of a gloved middle finger from the MCP — puts its
   * whole middle and distal phalanges on the flank, so each digit shows about
   * 30 mm of length with a crease across it. That is the difference between
   * "three pale nubs" and "a hand gripping".
   */
  rows: [-0.0300, -0.0100, 0.0100, 0.0300],
  rowMid: 0.0,
  lens: [0.0212, 0.0273, 0.0258, 0.0232],
  // Seeds sit in the arc off the right flank's front chamfer, so the metacarpal
  // heads land behind the front strap, which is where a fist's knuckles are.
  // Each successive finger starts a shade further round, the way a knuckle line
  // rakes.
  seeds: [0.0440, 0.0450, 0.0464, 0.0478],
  digitOff: 0.0064,
  thick: 0.0122, thickStep: 0.0006,
  palmA: 0.0335, palmB: 0.0122,
  // Wrist: below and behind the grip's buttcap, so nothing of the arm is inside
  // the lower receiver. A gloved wrist with its gauntlet cuff is 45 x 39 mm.
  wrist: [0.0180, 0.0295, 0.0470], wristA: 0.0225, wristB: 0.0195,
  palmS0: 0.0035, palmS1: 0.0520,
  /**
   * Trigger finger, aimed off the grip into the guard. Solved by FK, not on the
   * wrap path: the grip is raked 17 degrees, so a finger walked along the grip's
   * own section runs downhill and dives under the guard instead of reaching the
   * trigger face at grip (0, -0.0309, -0.0456).
   *
   * ─── THE DETACHED BLOB, AND WHY IT IS A ROUTING BUG ─────────────────────
   *
   * The round-10 review found "a detached rounded blob floats above the trigger
   * guard". tools/_trigsolve.mjs reproduces this FK in weapon space and ray-casts
   * every sample on the finger back to the measured eye against the weapon's own
   * occluder boxes. The old numbers name the defect exactly:
   *
   *     24 samples: 1 visible in 1 run, longest 1, 22 inside solid geometry
   *     first visible sample (-0.0195, -0.0263, 0.0970)
   *
   * The whole finger was buried in the lower receiver and the magwell, and a
   * single point of it punched out through the receiver's LEFT flank at the
   * receiver floor. One emergent patch with hidden geometry on both sides of it
   * is not a finger — there is no reading of it available except "a blob".
   *
   * ─── AND WHY THE ANSWER IS TO HIDE IT COMPLETELY ────────────────────────
   *
   * The same tool answers the obvious follow-up ("re-aim it so the whole finger
   * shows in the guard window") with a flat no. From an eye 313 mm LEFT of the
   * bore, every sight line into the trigger-guard window passes through the lower
   * receiver first: a ray from any point in the window crosses x = -0.019 while
   * still inside y -0.029..0.023 and z -0.042..0.134. The window is not visible
   * from here at all. That is also simply true of the real thing — you do not see
   * a right-handed shooter's own trigger finger from over his left shoulder.
   *
   * So the finger is routed to be anatomically right and entirely occluded: out
   * of the index MCP on the grip's front-right, forward under the receiver, then
   * hooked back onto the trigger face with the pad on the blade. Searched rather
   * than hand-aimed, against exactly two constraints — zero visible samples and
   * the tip within 10 mm of the trigger — and it lands the tip 9.6 mm off the
   * blade with 0 of 24 samples reaching the eye.
   */
  trigger: {
    index: 0, p: [0.0210, -0.0210], len: 0.0212,
    dir: [0.10, -0.50, -0.10], back: [0.40, -0.91, 0.0],
    curls: [0.10, 1.30, 1.30],
  },
  /**
   * Thumb ACROSS the backstrap and down the LEFT flank, pointing forward — the
   * only route that puts a right thumb in this picture at all. One parked on the
   * right flank by the selector is behind the receiver from this eye, and one
   * laid high on the left flank at grip y > +0.02 is inside the lower receiver
   * (which spans |x| < 0.019, y -0.029..+0.023). From grip (0.006, 0.0218,
   * -0.030), curling down-left, it crosses the backstrap and lands on the flank
   * at about weapon (-0.017, -0.061, 0.126) — 32 mm below the receiver's floor,
   * in clear air, directly above the fingertips. A thumb crossing the grip's
   * silhouette above three fingertips is the whole grip read in one shape.
   */
  thumb: {
    root: [0.0150, 0.0250, -0.0130], p: [0.0060, 0.0218, -0.0300],
    dir: [-0.88, -0.16, 0.44], back: [0.16, 0.92, 0.36],
    len: 0.0215, th: 0.0146, curls: [0.30, 0.34, 0.30],
  },
  // Back, down and outboard toward the right shoulder.
  fore: { dir: [0.30, -0.62, 0.72], bend: [0.010, -0.014, 0.020], len: 0.2500 },
};

/**
 * Support hand. The silhouette it wraps is handguard PLUS top rail as one convex
 * outline in weapon (x, y).
 *
 * The handguard is a 38 mm octagon on the bore at y = 0.030 (left flat at
 * x = -0.019 spanning y 0.0216..0.0384). The rail sits on top, |x| < 0.0106, and
 * with its polymer cover the top surface is at y = 0.0668. Between the
 * handguard's upper shoulder and the rail's flank there is a re-entrant notch, so
 * the outline BRIDGES it, from (-0.0190, 0.0384) straight to (-0.0106, 0.0668). A
 * finger does the same: it spans the notch and touches at both ends. Following
 * the notch in is how a wrap ends up inside the rail cover.
 */
const HG_SEC = [
  [-0.0084, 0.0104], [-0.0190, 0.0216], [-0.0190, 0.0384], [-0.0106, 0.0668],
  [0.0106, 0.0668], [0.0190, 0.0384], [0.0190, 0.0216],
];

const LEFT = {
  frame: IDENT, sec: HG_SEC,
  /**
   * Rows spread along the bore, index forward. The window z -0.146..-0.074 is the
   * only clear stretch on this handguard: the left accessory rail stub occupies
   * z -0.190..-0.142 out to x = -0.0285, the QD socket sits at z = -0.150, the
   * handstop at -0.166, and the optic's hood reaches z = -0.045. Every finger
   * here also stays above y = 0.045, which clears the stub and the socket
   * outright.
   */
  rows: [-0.1430, -0.1225, -0.1020, -0.0815],
  rowMid: -0.1120,
  lens: [0.0228, 0.0225, 0.0210, 0.0188],
  // Mid-bridge, so the metacarpal heads ride the handguard/rail shoulder at
  // (-0.0204, 0.0542) — 9.6 mm clear of the rail web, on the flank the eye sees.
  seeds: [0.0530, 0.0530, 0.0538, 0.0552],
  digitOff: 0.0058,
  /**
   * Bulked for a military build. The player's report was that this hand read as
   * "super thin", and it was: palmB 0.0094 against the right hand's 0.0122, so
   * the support hand was measurably shallower than the firing hand on the same
   * body. Finger thickness only goes up 12% because the clearances documented
   * above are tight — the rail stub top is at y = 0.041 and the metacarpal heads
   * ride the shoulder 9.6 mm clear of the rail web — but the palm, wrist and
   * forearm carry most of the visual mass anyway.
   */
  thick: 0.0132, thickStep: 0.0006,
  palmA: 0.0388, palmB: 0.0128,
  // Wrist below-left of the handguard's lower-left diagonal: outside the section
  // (x < -0.019), below it (y < 0.011), and 6 mm forward of the upper receiver's
  // front face at z = -0.062 so the sleeve never intersects it.
  // The forearm inherits this section exactly (see `fa`/`fb` in the build), so
  // the wrist ellipse sets the whole arm's girth — this is the single number
  // that makes the arm read as a forearm rather than a wire.
  wrist: [-0.0255, -0.0095, -0.0790], wristA: 0.0244, wristB: 0.0214,
  palmS0: 0.0030, palmS1: 0.0555,
  trigger: null,
  /**
   * Thumb forward along the upper-left beside the rail — the "thumb over bore"
   * cue, and the one digit silhouetted against the world rather than against the
   * weapon in every pose. It runs from the web at z = -0.1380 forward to about
   * z = -0.1930 at y 0.046..0.055, which threads above the accessory rail stub
   * (top at y = 0.041) and outboard of the folded front iron (|x| < 0.0065).
   */
  thumb: {
    root: [-0.0205, 0.0400, -0.1180], p: [-0.0244, 0.0452, -0.1380],
    dir: [0.05, 0.11, -0.99], back: [-0.90, 0.42, 0.0],
    len: 0.0224, th: 0.0156, curls: [0.13, 0.12, 0.15],
  },
  // Down, left and back, off the bottom-left corner of the frame.
  fore: { dir: [-0.60, -0.66, 0.45], bend: [-0.016, -0.010, 0.014], len: 0.3100 },
};

/* ------------------------------------------------------------------ build */

/**
 * @returns {{ group, meshes, triangles, right, left, rigs }}
 *
 * Each hand is its own sub-group holding its bone root and its SkinnedMeshes as
 * siblings, with the meshes at identity. That is not incidental: three.js
 * recomputes `bindMatrixInverse` from the mesh's live world matrix every frame in
 * the default attached bind mode, so a bind matrix of identity plus bones under
 * the same parent gives correct skinning no matter how the viewmodel rig moves —
 * and the viewmodel rig moves every frame, in camera space, under a camera that
 * is itself moving.
 *
 * The two hands keep separate Meshers and sub-groups so the screenshot rig can
 * ablate one at a time. That tool is what located the defect four rounds of
 * "the geometry is there and it projects into frame" could not.
 */
export function buildHands(mats) {
  const group = new THREE.Group();
  group.name = 'vm:hands';
  const meshes = [];
  const rigs = {};
  let triangles = 0;
  const out = {};

  for (const [side, def] of [['right', RIGHT], ['left', LEFT]]) {
    const { skin, joints } = buildHand(def);
    const rig = buildRig(joints);
    // Bind while the skeleton is still standalone at the origin, so every bone
    // inverse is the pure local bind matrix and the bind matrix can be identity.
    rig.root.updateMatrixWorld(true);
    const skeleton = new THREE.Skeleton(rig.bones);

    const sub = new THREE.Group();
    sub.name = `vm:hand:${side}`;
    sub.add(rig.root);
    for (const [key, geo] of skin.geometries()) {
      const mesh = new THREE.SkinnedMesh(geo, mats[key] ?? mats.glove);
      mesh.name = `vm:hand:${side}:${key}`;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.frustumCulled = false;
      sub.add(mesh);
      mesh.bind(skeleton, new THREE.Matrix4());
      meshes.push(mesh);
    }
    triangles += skin.tris;
    group.add(sub);
    out[side] = sub;
    rigs[side] = { skeleton, bones: rig.bones, byName: {} };
    rig.bones.forEach((b) => { rigs[side].byName[b.name] = b; });
  }

  return { group, meshes, triangles, right: out.right, left: out.left, rigs };
}
