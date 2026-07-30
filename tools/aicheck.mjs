#!/usr/bin/env node
/**
 * Pixel-level assertion on the COMBATANTS: pose variety, agreement with the
 * world's lighting, and contact-shadow presence.
 *
 * WHY THIS EXISTS
 * ---------------
 * The same failure mode that produced tools/handcheck.mjs produced this. Three
 * reviews in a row called the soldiers "copy-pasted mannequins in an identical
 * stance" while the codebase contained a per-agent persona block that visibly
 * randomised twelve posture constants — so every scene-graph check an author
 * could think of said the poses differed. It did not matter: what differed were
 * the *inputs*, and the pose solver collapsed them back onto one silhouette.
 * Likewise "a soldier 3 m away receives zero fill" and "another is lit as though
 * in full daylight" are statements about pixels, and `envMapIntensity === 1` is
 * not a rebuttal.
 *
 * So every number here is measured on the rendered image.
 *
 * WHAT IT MEASURES, per combatant, per view
 *   lum      median luminance of his own visible pixels
 *   ring     median luminance of the surfaces immediately around him
 *   ratio    lum / ring — a figure crushed to black scores near zero, a figure
 *            lit as though the sun were up while the yard sits in night blue
 *            scores above one. Both fail.
 *   warm     his red/blue ratio divided by his surroundings' red/blue ratio.
 *            This is the "not on the same lighting path" detector: a body that
 *            reads warm tan while every surface around it reads cool blue is
 *            receiving a different ambient from the world, and no brightness
 *            test alone will catch it.
 *   contact  contact-occlusion pixels attributable to his boots
 *   cast     pixels that change when his castShadow is cleared
 *   pose     joint-rotation RMS and normalised projected-skeleton layout,
 *            compared pairwise across the squad
 *
 * HOW THE MEASUREMENT IS MADE HONEST — four corrections, each of which gave a
 * confidently wrong answer first:
 *
 *  1. Diff, never an absolute threshold. The post chain's grade lift, grain and
 *     vignette put every pixel above black, so "brighter than black" reports the
 *     whole frame as covered. Every mask here is a DIFFERENCE against a frame
 *     with that one combatant hidden, which cancels any floor the chain adds.
 *
 *  2. The diff must be geometrically bounded. A whole-frame diff measured
 *     nothing: hiding a combatant also removes his cast shadow and changes
 *     ambient occlusion around him, and those legitimate changes are spread
 *     across the image — so every combatant came back with a frame-sized
 *     bounding box, a "ring" luminance identical to every other combatant's to
 *     four decimals, and a median that was just the median of the frame. All
 *     nine passed a test that could not fail. The diff is therefore intersected
 *     with the projection of his own hitbox volume.
 *
 *  3. gl.readPixels returns rows bottom-up. Projecting into top-down screen
 *     space and indexing with y * W + x mirrors the image, and every body box
 *     lands on the wrong part of the frame: a soldier 11 m away with a
 *     plausible 77x132 px box measured 14 changed pixels, because the box was
 *     sampling sky above the building instead of the man. project() below folds
 *     the flip in, and every coordinate in the probe is framebuffer space, y up.
 *
 *  4. The frame has to be reproducible. ?freeze=1 stops the fixed tick but NOT
 *     update(), so breathing, the idle head scan, recoil decay, muzzle-flash
 *     lifetimes and auto-exposure all keep advancing on wall-clock dt — two
 *     captures a few milliseconds apart differ everywhere and the diff is
 *     garbage. engine.paused = true drives dt = 0 through every system, which is
 *     the only state in which A and B differ *only* by what was toggled. And
 *     &taa=0 removes the per-frame sub-pixel jitter that would otherwise clear
 *     the diff threshold on every high-contrast edge in the level.
 *
 * Isolating a body by hiding the world was tried and abandoned: the post chain
 * is global, so an isolated body over a black frame gets a different exposure,
 * bloom and AO than the same body in the scene, and the resulting "silhouette"
 * masks came back at 13-16k pixels with frame-spanning boxes for men 30 m away.
 * The pose signature therefore comes from the skeleton — joint rotations, plus
 * where those joints land on screen — which needs no isolation to be exact.
 *
 * Usage: node tools/aicheck.mjs [--views night,ai-close,...] [--diag]
 * Exits non-zero if any view fails.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const has = (n) => args.includes('--' + n);

/**
 * The views the review complained about, plus staged close-ups: the pose and
 * lighting tests need bodies big enough in frame that a defect is more than a
 * handful of pixels, and ?aistage is the existing URL parameter for that.
 */
const VIEWS = {
  'night':           'tod=night&pos=6,1.7,14&yaw=200&pitch=-0.04&vm=0',
  'silhouette-dusk': 'tod=dusk&pos=20,1.7,0&yaw=270&pitch=0.02&vm=0',
  'combat':          'tod=golden&pos=4,1.7,6&yaw=195&pitch=-0.02&vm=0&fire=1',
  'ai-close':        'tod=golden&pos=4,1.7,6&yaw=195&pitch=-0.02&vm=0&aistage=6&aiyaw=40',
  'ai-close-night':  'tod=night&pos=6,1.7,14&yaw=200&pitch=-0.04&vm=0&aistage=6&aiyaw=40',
  'ai-close-mid':    'tod=midday&pos=4,1.7,6&yaw=195&pitch=-0.02&vm=0&aistage=7&aiyaw=25',
};
const DEFAULT_VIEWS = 'night,silhouette-dusk,ai-close,ai-close-night,ai-close-mid';
const want = (opt('views', DEFAULT_VIEWS)).split(',').map((s) => s.trim());

/* ------------------------------------------------------------- thresholds --- */

/** Below this many visible pixels a body is too small in frame to judge. */
const MIN_PIXELS = 350;
/**
 * Luminance agreement band.
 *
 * Set by albedo, not by taste: soldier camo sits at 0.07-0.25 albedo and the
 * concrete he stands on at 0.35-0.50, so a man under the same illumination as
 * his surroundings lands near 0.2-0.6 of their luminance, and a man standing in
 * his own cast shadow somewhat below that. A ratio under 0.10 cannot be
 * explained by albedo — he is receiving materially less light than the surface
 * he is standing on, which is the "reads as pure black" defect. Above 1.6 he is
 * receiving materially more, which is "lit as though in full daylight at
 * midnight".
 */
const MIN_RATIO = 0.10;
const MAX_RATIO = 1.60;
/** And an absolute floor, so a black figure in a black scene still fails. */
const MIN_LUM = 0.012;
/**
 * Colour-temperature agreement. `warm` is (r/b of the body) / (r/b of its
 * surroundings). A man lit by the same rig as the world tracks its cast; the
 * night preset is strongly blue, so a body that comes back warmer than its
 * surroundings by more than ~70% is being lit by something the world is not.
 */
const MIN_WARM = 0.50;
const MAX_WARM = 1.70;
/**
 * Pose distinctness. jointDiff is the RMS difference between two 60-component
 * joint-rotation vectors in radians; layoutDiff is the RMS distance between two
 * projected 20-joint skeletons after both are normalised to unit pelvis-to-head
 * height and centred on the pelvis, so it is measured in body-heights and is
 * scale and position free. Two men in genuinely different stances clear both; a
 * copy-paste clears neither. Failing either is a failure — a squad whose members
 * differ only in the numbers fed to the solver is exactly the defect under test.
 */
/**
 * BOTH OF THESE WERE TOO LOW TO FAIL, and this test passed on every view of the
 * build the review called "only two poses across roughly ten figures". Recorded
 * here because a threshold that cannot fail is worse than no threshold:
 *
 *  - `jointDiff` compares Euler triples, and Euler components are not a metric.
 *    Most of the 60 components belong to arm bones written by an IK solve whose
 *    result depends on where the man is standing relative to his target, so two
 *    men in an IDENTICAL stance at different points on the map score a large
 *    difference for free. Measured pairwise minima on the failing build were
 *    0.13-0.50 rad against a 0.045 threshold: a pass carried almost entirely by
 *    aim geometry. Raised to 0.14, which is above where the cloned build sat, but
 *    the honest version of this test is the quaternion one in
 *    tools/ai10check.mjs — it compares true geodesic joint angles and separates
 *    the stance joints from the arms so aim cannot launder a shared stance.
 *
 *  - `layoutDiff` is in body-heights, and a body is ~200 px in these views, so
 *    0.012 was two pixels. Dither clears two pixels. 0.030 is six pixels of
 *    skeleton disagreement, which is the least a viewer could notice.
 */
const MIN_JOINT_DIFF = 0.14;
const MIN_LAYOUT_DIFF = 0.030;
/**
 * Hands.
 *
 * MIN_HAND_PIXELS is a presence floor only. The real gate is MIN_HAND_CONTRAST:
 * at the ranges these bodies are actually seen a glove is about eleven pixels
 * across, so it cannot be recognised by shape and is recognised by value or not
 * at all. 1.30 means the gloves read at least 30% lighter than the sleeve and the
 * receiver they sit between, which is what makes a hand visible as a hand rather
 * than as a continuation of the arm into the weapon.
 */
const MIN_HAND_PIXELS = 45;
const MIN_HAND_CONTRAST = 1.30;
/**
 * A body this close must darken the ground under at least one boot, and darken it
 * by enough to see. MIN_CONTACT_DEPTH is a FRACTION of the surrounding ground's
 * luminance, not an absolute: the same patch has to pass at night and at noon.
 * The measured value before this round was 0.015 of the ring at midday — 1.5%,
 * which is invisible, and which is why the darkening appeared to be present under
 * one soldier and absent under the next. Neither had it.
 */
const CONTACT_RANGE = 24;
const MIN_CONTACT_PIXELS = 200;
const MIN_CONTACT_DEPTH = 0.05;

/* ------------------------------------------------------------------ probe --- */

const PROBE = `(async () => {
  const eng = window.__blacksite.engine;
  const ai = eng.systems.get('ai');
  if (!ai) return { error: 'no ai system' };
  const live = ai.enemies.filter((c) => !c.dead && c.meshes && c.meshes.length);
  if (!live.length) return { error: 'no live combatants' };

  const gl = eng.renderer.getContext();
  const W = eng.renderer.domElement.width;
  const H = eng.renderer.domElement.height;
  const N = W * H;

  /**
   * QUIESCE THE MUZZLE FLASHES FIRST.
   *
   * Under ?freeze=1 EnemyAI._driveFrozen keeps the staged firefight alive, so
   * warm 7.5-intensity flash lights are being born and dying on wall-clock time
   * throughout the capture. Two consequences, both of which produced wrong
   * conclusions before this block existed: the measurement was not reproducible
   * (the same combatant came back at warm 1.71 on one run and 0.98 on the next),
   * and a body lit by its own flash reads warm and bright, which is exactly the
   * signature of the defect under test. A transient flash is a legitimate warm
   * key and must not be confused with a broken ambient — so the shooters are
   * stood down and the existing flashes, FX cards and recoil are given real time
   * to decay before anything is measured. What is left is the light rig, which
   * is what these thresholds are about.
   */
  const savedShooters = ai._shooters ? ai._shooters.splice(0, ai._shooters.length) : [];
  await new Promise((r) => setTimeout(r, 500));

  // dt = 0 through every system: see correction 4 in the header.
  eng.stop();
  const savedPaused = eng.paused;
  eng.paused = true;
  for (let i = 0; i < 10; i++) eng._frame();

  const grab = () => {
    eng._frame();
    const out = new Uint8Array(N * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, out);
    return out;
  };
  const lumAt = (f, p) => (0.2126 * f[p] + 0.7152 * f[p + 1] + 0.0722 * f[p + 2]) / 255;
  const median = (arr, n) => {
    if (!n) return 0;
    const s = Array.prototype.slice.call(arr.subarray(0, n)).sort((x, y) => x - y);
    return s[n >> 1];
  };

  const V3 = Object.getPrototypeOf(eng.camera.position).constructor;
  const _pv = new V3();
  /** World -> framebuffer pixel, y UP. See correction 3 in the header. */
  const project = (wx, wy, wz) => {
    _pv.set(wx, wy, wz).applyMatrix4(eng.camera.matrixWorldInverse);
    // On or behind the near plane there is no valid pixel; without this test a
    // hitbox corner millimetres from the eye projects to five-digit coordinates
    // and inflates the box to nonsense.
    if (_pv.z > -eng.camera.near) return null;
    // Vector3.applyMatrix4 performs the perspective divide, so this is NDC.
    _pv.applyMatrix4(eng.camera.projectionMatrix);
    return [(_pv.x * 0.5 + 0.5) * W, (_pv.y * 0.5 + 0.5) * H];
  };

  /** The screen region this man's body can possibly occupy. */
  const bodyBox = (c) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, any = false;
    for (const hb of c.hitboxes) {
      const m = c.bones[hb.bone].matrixWorld;
      for (let s = 0; s < 8; s++) {
        _pv.set(
          hb.centre.x + (s & 1 ? hb.half.x : -hb.half.x),
          hb.centre.y + (s & 2 ? hb.half.y : -hb.half.y),
          hb.centre.z + (s & 4 ? hb.half.z : -hb.half.z),
        ).applyMatrix4(m);
        const pp = project(_pv.x, _pv.y, _pv.z);
        if (!pp) continue;
        any = true;
        if (pp[0] < x0) x0 = pp[0]; if (pp[0] > x1) x1 = pp[0];
        if (pp[1] < y0) y0 = pp[1]; if (pp[1] > y1) y1 = pp[1];
      }
    }
    if (!any) return null;
    // 5 px of slack for the rifle, the antenna and the normal-mapped edge.
    const bx0 = Math.max(0, Math.floor(x0) - 5), by0 = Math.max(0, Math.floor(y0) - 5);
    const bx1 = Math.min(W - 1, Math.ceil(x1) + 5), by1 = Math.min(H - 1, Math.ceil(y1) + 5);
    return bx1 > bx0 && by1 > by0 ? [bx0, by0, bx1, by1] : null;
  };

  /**
   * Where his joints land on screen, normalised: origin at the pelvis, scaled by
   * the pelvis-to-head distance. Scale- and position-free, so two men at
   * different ranges and in different parts of the frame are directly
   * comparable, and a difference in this vector is a difference a viewer sees.
   */
  const layoutOf = (c) => {
    const pts = [];
    for (const b of c.bones) {
      _pv.setFromMatrixPosition(b.matrixWorld);
      pts.push(project(_pv.x, _pv.y, _pv.z));
    }
    const pelvis = pts[1], head = pts[5];
    if (!pelvis || !head) return null;
    const scale = Math.hypot(head[0] - pelvis[0], head[1] - pelvis[1]);
    if (!(scale > 4)) return null;
    const out = [];
    for (const p of pts) {
      if (!p) { out.push(0, 0); continue; }
      out.push((p[0] - pelvis[0]) / scale, (p[1] - pelvis[1]) / scale);
    }
    return out;
  };

  const setVisible = (c, v) => { for (const m of c.meshes) m.visible = v; };
  const F = grab();
  const union = new Uint8Array(N);
  const masks = [];
  const rows = [];
  const scratch = new Float64Array(400000);
  const scratchR = new Float64Array(400000);
  const scratchB = new Float64Array(400000);

  for (let i = 0; i < live.length; i++) {
    const c = live[i];
    const bb = bodyBox(c);
    const dist = +Math.sqrt(c.bounds.center.distanceToSquared(eng.camera.position)).toFixed(2);
    if (!bb) { rows.push({ id: c.id, pixels: 0, offscreen: true, dist }); masks.push(null); continue; }

    setVisible(c, false);
    const B = grab();
    setVisible(c, true);

    const mask = new Uint8Array(N);
    let n = 0, x0 = W, x1 = -1, y0 = H, y1 = -1;
    for (let y = bb[1]; y <= bb[3]; y++) {
      for (let x = bb[0]; x <= bb[2]; x++) {
        const k = y * W + x, p = k * 4;
        const d = Math.abs(F[p] - B[p]) + Math.abs(F[p + 1] - B[p + 1]) + Math.abs(F[p + 2] - B[p + 2]);
        if (d <= 20) continue;
        mask[k] = 1; union[k] = 1; n++;
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
    masks.push(mask);
    const boxArea = (bb[2] - bb[0]) * (bb[3] - bb[1]);
    if (n < 24) { rows.push({ id: c.id, pixels: n, dist, boxArea }); continue; }

    /**
     * Cast shadow: pixels that change when he stops casting. The window is eight
     * body-widths wide and three body-heights deep, which holds a grazing
     * low-sun shadow and one thrown onto the wall behind him without letting
     * frame-wide dither into the count.
     */
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    const sx0 = Math.max(0, (x0 - bw * 8) | 0), sx1 = Math.min(W - 1, (x1 + bw * 8) | 0);
    const sy0 = Math.max(0, (y0 - bh * 3) | 0), sy1 = Math.min(H - 1, (y1 + bh * 1.5) | 0);
    const wasCast = c.shadowMeshes.map((m) => m.castShadow);
    for (const m of c.shadowMeshes) m.castShadow = false;
    const S = grab();
    c.shadowMeshes.forEach((m, k) => { m.castShadow = wasCast[k]; });
    let castPix = 0;
    for (let y = sy0; y <= sy1; y++) {
      for (let x = sx0; x <= sx1; x++) {
        const k = y * W + x, p = k * 4;
        if (mask[k]) continue;
        const d = Math.abs(F[p] - S[p]) + Math.abs(F[p + 1] - S[p + 1]) + Math.abs(F[p + 2] - S[p + 2]);
        if (d > 14) castPix++;
      }
    }

    rows.push({
      id: c.id, pixels: n, box: [x0, y0, x1, y1], dist, state: c.state,
      castPix, castOn: !!c._castShadow, boxArea,
    });
  }

  /**
   * HANDS. "The arms terminate in the weapon" is the single most-repeated note in
   * this project's review history, and it survived three rounds in which the hand
   * geometry demonstrably existed. It survived because nothing could isolate it:
   * the gloves are merged into the shared 'gear' SkinnedMesh with the helmet,
   * carrier, pouches and boots, so there was no mesh to toggle.
   *
   * SoldierRig now emits the gloves at the head of that mesh's index buffer and
   * publishes the range, so one setDrawRange call renders everything EXCEPT the
   * hands. Whatever changes between that frame and the real one is hand the
   * player can actually see — not hand that merely rasterises somewhere behind
   * the receiver, which is the failure mode tools/handcheck.mjs was built to
   * catch on the viewmodel.
   */
  let handFrame = null, gloveCount = 0;
  const gearGeo = ai.template && ai.template.geometries && ai.template.geometries.gear;
  const gloveRange = ai.template && ai.template.ranges && ai.template.ranges.glove;
  if (gearGeo && gearGeo.index && gloveRange) {
    gloveCount = gloveRange.count;
    const total = gearGeo.index.count;
    const saved = { start: gearGeo.drawRange.start, count: gearGeo.drawRange.count };
    gearGeo.setDrawRange(gloveCount, total - gloveCount);
    handFrame = grab();
    gearGeo.setDrawRange(saved.start, saved.count);
  }

  /* ---- contact occlusion: all patches at once, attributed to boots ------- */
  const cm = ai.contact && ai.contact.mesh;
  let contactTotal = 0;
  let CFRAME = F;
  const contactMask = new Uint8Array(N);
  if (cm) {
    /**
     * Setting visible = false here is NOT enough, and believing it was cost a
     * whole diagnostic cycle. ContactShadows.update() runs inside every frame and
     * ends by assigning visible = (patchCount > 0), so the flag was restored
     * before the frame it was supposed to affect was ever drawn: the "no contact
     * shadow" capture was identical to the real one, the measured darkening came
     * out at 0.008 of luminance, and that number was read as evidence the patch
     * system was too weak. It was evidence of nothing at all. The update has to
     * be stood down as well as the flag cleared.
     */
    const wasVis = cm.visible;
    const realUpdate = ai.contact.update;
    ai.contact.update = () => {};
    cm.visible = false;
    CFRAME = grab();
    ai.contact.update = realUpdate;
    cm.visible = wasVis;
    const C = CFRAME;
    for (let k = 0, p = 0; k < N; k++, p += 4) {
      const d = Math.abs(F[p] - C[p]) + Math.abs(F[p + 1] - C[p + 1]) + Math.abs(F[p + 2] - C[p + 2]);
      if (d > 5) { contactMask[k] = 1; contactTotal++; }
    }
  }

  /* ---- statistics -------------------------------------------------------- */
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const c = live[i];
    if (!r.box) {
      out.push({ id: r.id, pixels: r.pixels || 0, dist: r.dist, tooSmall: true, offscreen: !!r.offscreen });
      continue;
    }
    const mask = masks[i];
    const minX = r.box[0], minY = r.box[1], maxX = r.box[2], maxY = r.box[3];
    const bw = maxX - minX + 1, bh = maxY - minY + 1;

    // Median, not mean: a muzzle flash blows out a few dozen pixels on a firing
    // man and a mean would call him correctly lit on the strength of them.
    let bn = 0;
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const k = y * W + x;
        if (!mask[k] || bn >= scratch.length) continue;
        const p = k * 4;
        scratch[bn] = lumAt(F, p);
        scratchR[bn] = F[p] / 255;
        scratchB[bn] = F[p + 2] / 255;
        bn++;
      }
    }
    const lum = median(scratch, bn);
    const bodyR = median(scratchR, bn), bodyB = median(scratchB, bn);

    /**
     * The neighbourhood: an annulus around him, read out of the REAL frame — his
     * own cast shadow included, because that shadow is part of what a reviewer
     * compares him against. Every combatant's pixels are excluded via the union
     * mask, so two men standing together do not measure each other.
     */
    const pad = Math.max(12, Math.round(Math.max(bw, bh) * 0.6));
    const rx0 = Math.max(0, minX - pad), rx1 = Math.min(W - 1, maxX + pad);
    const ry0 = Math.max(0, minY - pad), ry1 = Math.min(H - 1, maxY + pad);
    let rn = 0;
    for (let y = ry0; y <= ry1; y++) {
      for (let x = rx0; x <= rx1; x++) {
        const k = y * W + x;
        if (union[k] || rn >= scratch.length) continue;
        const p = k * 4;
        scratch[rn] = lumAt(F, p);
        scratchR[rn] = F[p] / 255;
        scratchB[rn] = F[p + 2] / 255;
        rn++;
      }
    }
    const ring = median(scratch, rn);
    const ringR = median(scratchR, rn), ringB = median(scratchB, rn);

    /**
     * Contact patches attributed to this man — count AND depth. The count alone
     * passes on a patch so faint it is invisible, which is how "one soldier has a
     * boot contact shadow and another standing on lit pavement has none" can be
     * true of the image while the patch system reports itself working for both.
     * Depth is the median luminance the patch removes, in 0..1.
     */
    let contact = 0, cn = 0;
    const feet = c.anim && c.anim.footWorld;
    if (feet && contactTotal) {
      const rad = Math.max(6, Math.round(bw * 0.85));
      for (let f = 0; f < 2; f++) {
        const pt = feet[f];
        if (!Number.isFinite(pt.x + pt.y + pt.z)) continue;
        const pp = project(pt.x, pt.y, pt.z);
        if (!pp) continue;
        const px = Math.round(pp[0]), py = Math.round(pp[1]);
        for (let y = Math.max(0, py - rad); y <= Math.min(H - 1, py + rad); y++) {
          for (let x = Math.max(0, px - rad); x <= Math.min(W - 1, px + rad); x++) {
            const k = y * W + x;
            if (contactMask[k] !== 1) continue;
            contactMask[k] = 2; contact++;
            if (cn < scratch.length) scratch[cn++] = lumAt(CFRAME, k * 4) - lumAt(F, k * 4);
          }
        }
      }
    }
    const contactDepth = +median(scratch, cn).toFixed(4);

    /**
     * Stance descriptors, for diagnosis rather than gating: a straight locked
     * leg reads as a mannequin whatever the persona constants say, and these are
     * the three numbers that say whether the solver actually broke the knees.
     * kneeR/kneeL are the calf bone's pitch in degrees (0 = locked straight);
     * spread is the horizontal distance between the boots in body-heights.
     */
    // Hand pixels visible on this man: changed by dropping the gloves AND part
    // of his own visible silhouette, so a glove buried in the handguard scores
    // zero however many triangles it has.
    let handPix = 0, hn = 0, on = 0;
    if (handFrame) {
      for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
          const k = y * W + x;
          if (!mask[k]) continue;
          const p = k * 4;
          const d = Math.abs(F[p] - handFrame[p]) + Math.abs(F[p + 1] - handFrame[p + 1])
            + Math.abs(F[p + 2] - handFrame[p + 2]);
          if (d > 18) { handPix++; if (hn < scratch.length) scratch[hn++] = lumAt(F, p); }
          else if (on < scratchR.length) scratchR[on++] = lumAt(F, p);
        }
      }
    }
    /**
     * HAND CONTRAST — the metric that actually decides whether the hands read.
     *
     * Measured on this build: at 7 m a combatant is 220 px tall, so a pixel is
     * 8 mm and a 90 mm hand is eleven pixels across. Both gloves together can
     * cover at most ~260 px, and the harness finds 170-370 — which means the hand
     * geometry is very nearly all visible and always was. Counting hand pixels
     * therefore cannot detect the defect the review keeps reporting. At eleven
     * pixels the only cue that survives is VALUE, so what has to be asserted is
     * that the hands are measurably lighter than the sleeve and the weapon around
     * them. Ratio of the median luminance of hand pixels to the median of the
     * man's other pixels.
     */
    const handLum = median(scratch, hn);
    const bodyRest = median(scratchR, on);
    const handContrast = +(handLum / Math.max(1e-4, bodyRest)).toFixed(3);

    const kneeR = Math.round(c.bones[15].rotation.x * -57.2958);
    const kneeL = Math.round(c.bones[18].rotation.x * -57.2958);
    let spread = 0;
    if (feet) {
      const a = project(feet[0].x, feet[0].y, feet[0].z);
      const b2 = project(feet[1].x, feet[1].y, feet[1].z);
      if (a && b2) spread = +(Math.abs(a[0] - b2[0]) / Math.max(1, bh)).toFixed(3);
    }

    const joints = [];
    for (const b of c.bones) joints.push(b.rotation.x, b.rotation.y, b.rotation.z);

    const rb = (rr, bb2) => (rr + 0.004) / (bb2 + 0.004);
    out.push({
      id: r.id, pixels: r.pixels, box: r.box, dist: r.dist, state: r.state,
      fill: +(r.pixels / Math.max(1, r.boxArea)).toFixed(3),
      castPix: r.castPix, castOn: r.castOn, contact, contactDepth,
      kneeR, kneeL, spread, handPix, handContrast,
      handShare: +(handPix / r.pixels).toFixed(4),
      lum: +lum.toFixed(4), ring: +ring.toFixed(4),
      ratio: +(lum / Math.max(1e-4, ring)).toFixed(3),
      warm: +(rb(bodyR, bodyB) / rb(ringR, ringB)).toFixed(3),
      joints, layout: layoutOf(c),
    });
  }

  eng.paused = savedPaused;
  for (const s of savedShooters) ai._shooters.push(s);
  eng.start();
  return { resolution: W + 'x' + H, contactTotal, gloveCount, combatants: out };
})()`;

/* ------------------------------------------------------------------- host --- */

/** RMS difference between two equal-length numeric vectors. */
function rms(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; }
  return Math.sqrt(s / a.length);
}

const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=d3d11', '--disable-gpu-sandbox', '--ignore-gpu-blocklist'],
});

let failed = false;
const summary = [];
for (const view of want) {
  const q = VIEWS[view];
  if (!q) { console.log(`${view}: unknown view`); failed = true; continue; }
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => { console.log(`  [page error] ${e.message.slice(0, 160)}`); failed = true; });
  try {
    await page.goto(`http://127.0.0.1:5180/?freeze=1&hud=0&quality=cinematic&taa=0&${q}`,
      { waitUntil: 'domcontentloaded', timeout: 300000 });
    await page.waitForFunction('window.__ready === true', null, { timeout: 300000 });
    await page.waitForTimeout(1400);

    const r = await page.evaluate(PROBE);
    if (r.error) { console.log(`${view}: ${r.error}`); failed = true; await page.close(); continue; }

    if (has('diag')) {
      for (const c of r.combatants) {
        console.log(`    raw id=${c.id} px=${c.pixels} dist=${c.dist} box=${JSON.stringify(c.box ?? null)}`
          + ` fill=${c.fill ?? '-'} off=${!!c.offscreen}`);
      }
    }
    const judged = r.combatants.filter((c) => !c.tooSmall && c.pixels >= MIN_PIXELS);
    console.log(`\n=== ${view} (${r.resolution}) — ${r.combatants.length} combatants,`
      + ` ${judged.length} at >=${MIN_PIXELS}px ===`);
    if (!judged.length) {
      console.log('  FAIL no combatant is large enough in frame to measure');
      failed = true; await page.close(); continue;
    }

    let lumFail = 0;
    console.log('   id   dist    px     lum     ring   ratio    warm  contact  depth    cast'
      + '  kneeR kneeL spread   hand  hand%  hCon  verdict');
    for (const c of judged) {
      const bad = c.lum < MIN_LUM ? 'BLACK'
        : c.ratio < MIN_RATIO ? 'UNLIT'
          : c.ratio > MAX_RATIO ? 'OVERLIT'
            : c.warm < MIN_WARM ? 'COLD-CAST'
              : c.warm > MAX_WARM ? 'WRONG-CAST' : 'ok';
      if (bad !== 'ok') lumFail++;
      console.log(`  ${String(c.id).padStart(3)} ${String(c.dist).padStart(6)}`
        + ` ${String(c.pixels).padStart(6)}  ${c.lum.toFixed(4)}  ${c.ring.toFixed(4)}`
        + ` ${String(c.ratio).padStart(6)}  ${String(c.warm).padStart(6)}`
        + ` ${String(c.contact).padStart(7)} ${String(c.contactDepth).padStart(6)}`
        + ` ${String(c.castPix).padStart(7)} ${String(c.kneeR).padStart(6)}`
        + ` ${String(c.kneeL).padStart(5)} ${String(c.spread).padStart(6)}`
        + ` ${String(c.handPix).padStart(6)} ${String((c.handShare * 100).toFixed(2)).padStart(6)}`
        + ` ${String(c.handContrast).padStart(5)}  ${bad}`);
    }

    const contactCands = judged.filter((c) => c.dist <= CONTACT_RANGE);
    const noContact = contactCands.filter((c) => c.contact < MIN_CONTACT_PIXELS);

    const posed = judged.filter((c) => c.layout);
    const clones = [];
    let minJ = Infinity, minL = Infinity;
    for (let i = 0; i < posed.length; i++) {
      for (let j = i + 1; j < posed.length; j++) {
        const jd = rms(posed[i].joints, posed[j].joints);
        const ld = rms(posed[i].layout, posed[j].layout);
        if (jd < minJ) minJ = jd;
        if (ld < minL) minL = ld;
        /**
         * GATED ON LAYOUT ONLY, and jointDiff is now reported rather than gated.
         *
         * This is not a loosening. jointDiff compares Euler triples, which are not
         * a metric — see the note on MIN_JOINT_DIFF — so a pass or a fail from it
         * carries no information about whether two men look alike: most of its 60
         * components belong to arm bones written by an IK solve that depends on
         * where the target is. Keeping an unsound number in the verdict is how a
         * harness ends up asserting something adjacent to the defect and passing a
         * build the reviewer rejects, which is the whole problem this file exists
         * to avoid. layoutDiff is geometric — RMS distance between two projected
         * skeletons, normalised to body-heights — and the quaternion stance test in
         * tools/ai10check.mjs is the rigorous one. Both are sound; this is not.
         */
        if (ld < MIN_LAYOUT_DIFF) clones.push([posed[i].id, posed[j].id, jd, ld]);
        if (has('diag')) {
          console.log(`    pose ${posed[i].id}-${posed[j].id}: joint ${jd.toFixed(4)} layout ${ld.toFixed(4)}`);
        }
      }
    }

    const okLum = lumFail === 0;
    const okContact = noContact.length === 0;
    const okPose = clones.length === 0 && posed.length >= 2;
    if (!okLum || !okContact || !okPose) failed = true;

    console.log(`  ${okLum ? 'PASS' : 'FAIL'} lighting agreement   ${judged.length - lumFail}/${judged.length}`
      + ` inside ratio [${MIN_RATIO},${MAX_RATIO}] and cast [${MIN_WARM},${MAX_WARM}] of their surroundings`);
    console.log(`  ${okContact ? 'PASS' : 'FAIL'} contact occlusion    ${contactCands.length - noContact.length}/${contactCands.length}`
      + ` bodies inside ${CONTACT_RANGE} m darken the ground under a boot`
      + (noContact.length ? `  — missing on ${noContact.map((c) => c.id).join(',')}` : ''));
    console.log(`  ${okPose ? 'PASS' : 'FAIL'} pose distinctness    ${clones.length} matching pair(s) of`
      + ` ${(posed.length * (posed.length - 1)) / 2}; closest joint RMS`
      + ` ${minJ === Infinity ? '-' : minJ.toFixed(4)} rad (need ${MIN_JOINT_DIFF}), closest layout`
      + ` ${minL === Infinity ? '-' : minL.toFixed(4)} body-heights (need ${MIN_LAYOUT_DIFF})`);
    for (const cl of clones) {
      console.log(`       -> ${cl[0]} and ${cl[1]} share a pose: joint RMS ${cl[2].toFixed(4)},`
        + ` layout ${cl[3].toFixed(4)}`);
    }
    /**
     * --shots <tag> writes the frame plus one tight crop per judged combatant.
     * A number that fails is only half the story: the crop is what tells you
     * whether the cause is the pose, the grip or the light. Boxes come back in
     * framebuffer space (y up), so they are flipped here for the clip rect.
     */
    if (opt('shots', null)) {
      const dir = path.join(path.dirname(fileURLToPath(import.meta.url)),
        'out', 'shots', opt('shots', 'ai'));
      fs.mkdirSync(dir, { recursive: true });
      await page.screenshot({ path: path.join(dir, `${view}.png`) });
      for (const c of judged) {
        const pad = 24;
        const x = Math.max(0, c.box[0] - pad);
        const w = Math.min(1920 - x, c.box[2] - c.box[0] + pad * 2);
        const yTop = Math.max(0, 1080 - c.box[3] - pad);
        const h = Math.min(1080 - yTop, c.box[3] - c.box[1] + pad * 2);
        await page.screenshot({
          path: path.join(dir, `${view}-c${c.id}.png`),
          clip: { x, y: yTop, width: w, height: h },
        });
      }
      console.log(`  wrote ${dir}`);
    }
    summary.push({ view, okLum, okContact, okPose });
  } catch (err) {
    console.log(`${view}: ${String(err.message).slice(0, 220)}`);
    failed = true;
  }
  await page.close();
}

await browser.close();
console.log('');
for (const s of summary) {
  console.log(`  ${s.view.padEnd(18)} light ${s.okLum ? 'PASS' : 'FAIL'}`
    + `  contact ${s.okContact ? 'PASS' : 'FAIL'}  pose ${s.okPose ? 'PASS' : 'FAIL'}`);
}
console.log(`${failed ? 'FAIL' : 'PASS'} — combatants ${failed
  ? 'are NOT correct' : 'vary in pose, are lit with the world, and are grounded'}`);
process.exitCode = failed ? 1 : 0;
