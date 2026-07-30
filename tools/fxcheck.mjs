#!/usr/bin/env node
/**
 * Pixel + world-space assertions for two FX defects that survived several rounds
 * of "fixed it" because nobody ever measured them.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * Round-8 review, at 4.5x magnification: "the casings measure 25-40px at 15-25m
 * depth, roughly 20-40x true scale — one is wider than the 55-gallon drum behind
 * it". And: "the concrete directly beneath and in front of the muzzle is
 * identical in value to concrete ten metres away. The light, if it exists, is on
 * the viewmodel layer only."
 *
 * Neither claim survives a look at the source, and both were nevertheless true of
 * the image. `Effects.shell` sets a 51 mm quad — correct in metres. The CASING
 * tile is painted at 4.67:1 — correct in proportion. `Particles._onFire` calls
 * `lighting.flash()` into the WORLD rig — correct in topology. Every reading of
 * the code says the feature works. What this harness found instead:
 *
 *   1. `AtlasCanvas.paint` placed tile row r at byte row (rows-1-r) while both
 *      consumers derived UVs as (row + uv)/rows, so every sprite was FETCHED FROM
 *      THE MIRRORED ROW. Casings (7) drew the EMBER tile — soft round dots — and
 *      embers (11) drew the CASING tile, which is what the reviewer actually
 *      measured: rising, evenly spaced, no gravity, no impact, no shadow, no
 *      rotation variance. Every scene-graph and world-space number about the
 *      casing system was correct and the wrong texture was on screen.
 *   2. The flash light does reach the ground: 2.2x local, control 13 m away at
 *      0.93x. What it did NOT do was survive a screenshot. With a 45 ms decay
 *      against an 83 ms cyclic interval the measured lit-frame share was exactly
 *      0.50, so half of all captures showed a completely unlit world.
 *
 * Hence the two metrics that would have caught these and that the assertions are
 * built on: the RENDERED silhouette in millimetres, and the LIT-FRAME SHARE.
 *
 * ── AND THE BUG IN THIS HARNESS, FOUND IN ROUND 10 ───────────────────────────
 * Round-9 review, again: "four casings sit 25-40 m downrange at first-storey
 * height; angular measurement gives about 50 px for a case that should be 45 mm,
 * i.e. roughly 25x true size". This file PASSED that build on every line —
 * 47.9 x 11 mm rendered, 3.95 m from the port, 66 px peak, aspect 4.37. Both
 * readings are correct. The reviewer measured 60 px and so did this harness.
 *
 * The disagreement is the DENOMINATOR. This harness converted pixels to
 * millimetres using the CASING's own view depth (0.55 m), which is the honest
 * physical size. A viewer has no access to that number: they divide by the depth
 * of whatever the brass is drawn AGAINST. Measured with a level raycast through
 * each on-screen case, the backdrop in the failing shot was 16.8-19.4 m away, so
 * 60 px reads as 60 / (proj11 * H/2) * 17 = 1.6 m of brass. The reviewer's ruler
 * was right, their diagnosis (a units bug, brass 25 m downrange) was wrong, and
 * this harness could not tell the difference because it never asked what was
 * behind the case.
 *
 * The cause was geometric and is now measured directly: the port sits 0.18 m
 * BELOW the eye plane and `WeaponData.ejectVelocity` launches at +1.9 m/s up,
 * which at the applied 9.9 m/s^2 lifts the case 0.18-0.25 m — exactly onto and
 * over the eye line, where its backdrop stops being the near ground and becomes
 * the skyline. Hence the three metrics added below: APPARENT LENGTH against the
 * real backdrop, samples ABOVE THE EYE PLANE, and casings on screen at once.
 *
 *   CASINGS  Reads the simulation arrays over ~1.8 s of sustained fire for quad
 *            size in metres, distance from the ejection port and peak on-screen
 *            length. Then picks the largest fully-on-screen casing, renders one
 *            frame with it and one without, flood-fills the difference, takes the
 *            principal axis of the blob and converts its extents to millimetres
 *            using the casing's known view depth. A 5.56 case is 44.7 x 9.6 mm.
 *            Separately, for every on-screen case it raycasts the level along the
 *            camera->case ray to find the backdrop and reports the size a viewer
 *            infers from it.
 *
 *            Two isolation strategies were tried and rejected, both for the same
 *            reason — they changed the thing being measured:
 *              · Hiding the world (handcheck.mjs's approach) does not work here
 *                because the particle group is a CHILD of ctx.scene, so it hid
 *                the brass and reported 0 coverage.
 *              · Hiding everything BUT the brass sends the post chain's
 *                auto-exposure to maximum, at which point every casing clips and
 *                blooms into a round ball. That version reported "aspect 1.02,
 *                circular" about a sprite authored at 4.67:1.
 *            The geometry pass therefore runs with PostFX DISABLED (plain forward
 *            render, no bloom, no exposure meter, no TAA), and the clipping check
 *            runs separately with it enabled, because clipping only means
 *            anything in the image that ships.
 *
 *   FLASH    Forces the flash pool into a known state, renders, samples a ground
 *            patch 1.6 m in front of the muzzle; repeats with one flash carrying
 *            Particles.MUZZLE_LIGHT's own numbers, position and forward bias
 *            included. Three patches, because one is not enough to tell a pool
 *            from an exposure shift: the near ground must brighten, the first
 *            surface DOWN THE BORE past 8 m must brighten a little (round 9: "the
 *            wall, scaffold and the enemies at 15 m all read within noise"), and a
 *            SEARCHED-FOR surface past 45 m must not move at all. Both of the
 *            latter two were wrong when first written and are documented at the
 *            point they are computed — the mid sample was taken on ground the aim
 *            grazes at 83 degrees, and the far "control" was a point behind a wall
 *            17 m away, so it sampled lit geometry and failed a light that
 *            contributes zero at 40 m. Then it steps the engine at real dt for 60
 *            frames and counts how many have the light actually contributing.
 *            The pool state is re-forced before EVERY frame: stepping a frame
 *            runs update() on every system, and even at dt = 0 the weapon and the
 *            AI each get one more shot off and recycle the slot. An earlier
 *            version reported a stolen AI flash's 54 m cutoff as the muzzle
 *            light's 6 m, so the frame it measured was not the light it named.
 *
 * Frames are driven by hand after eng.stop(), with eng.paused = 1 (dt = 0) where
 * the state must hold still. In headless Chromium the rAF loop is paced by a
 * virtual clock, so the engine's own loop would queue a normal frame over the
 * prepared one before readPixels sampled it.
 *
 * Usage: node tools/fxcheck.mjs [--casings] [--flash] [--json]
 *                              [--shot out.png]   isolated brass, for eyeballing
 * Exits non-zero if any threshold fails.
 */
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const has = (n) => args.includes('--' + n);
const only = has('casings') || has('flash') || has('vmshells');
const runCasings = has('casings') || !only;
const runFlash = has('flash') || !only;
const runVm = has('vmshells') || !only;

/** Mid-firefight framing — same as shoot.mjs's `combat` view. */
const VIEW = 'tod=golden&pos=4,1.7,6&yaw=195&pitch=-0.02&vm=1&fire=1';

// ── thresholds ───────────────────────────────────────────────────────────────
/** 5.56x45: case 44.7 mm long. The quad may exceed the brass, not by much. */
const SIZE_MIN_M = 0.030;
const SIZE_MAX_M = 0.060;
/**
 * Brass leaves a port and lands within a couple of metres. 7.0 was the old bound
 * and it was never the binding one — the failing build measured 3.95. Tightened
 * to 4.0 so it actually constrains something.
 */
const MAX_DIST_FROM_PORT_M = 4.0;
/**
 * THE METRIC THE OLD VERSION OF THIS FILE WAS MISSING.
 *
 * The size a viewer infers: the case's projected length divided by the projection
 * of the geometry BEHIND it. True brass against near ground reads a few
 * centimetres; the same 60 px against a 17 m building reads 1.6 m, which is what
 * two consecutive reviews reported as "metre-long casings downrange".
 *
 * 0.45 m is not a taste threshold, it is what the geometry can reach: a 45 mm case
 * genuinely 0.55 m from an 80-degree lens covers ~57 px, and the nearest backdrop
 * available below the sight line is the apron 2.5-4 m out. Driving this below
 * ~0.4 m would need the brass drawn in the viewmodel scene at the viewmodel FOV,
 * which is not this system's to change. It DOES decisively separate "brass against
 * the ground beside the shooter" from "brass on the skyline".
 */
const MAX_APPARENT_M = 0.45;
/**
 * Casings above the eye plane, on screen, over the whole sample. Must be zero.
 * Camera-space y > 0 is the exact condition for "silhouetted on the skyline
 * instead of the ground", independent of pitch, and it is the single geometric
 * fact that produced the last two reviews.
 */
const MAX_ABOVE_EYE_SAMPLES = 0;
/** Brass in frame simultaneously. Four in a row reads as a dispenser, not a gun. */
const MAX_ON_SCREEN = 3;
/** Live casings anywhere. 28 was a fan of brass 3.5 m wide beside the player. */
const MAX_LIVE = 14;
/** Nothing parked on the lens: the failing build had a case 0.017 m from it. */
const MIN_DEPTH_M = 0.28;
/**
 * Coarse sanity bound on the quad's projected length, 1080p. Not a style
 * judgement: the drawn ejection port sits ~0.51 m from the lens, where a 51 mm
 * quad genuinely covers 64 px, and real brass IS that big for a few frames. The
 * bound is set from geometry — a quad no larger than 51 mm, never closer than
 * ~0.40 m — so it still catches the 20-40x scale error it exists for, which
 * would read in the thousands.
 */
const MAX_ON_SCREEN_PX = 90;
/** Rendered silhouette aspect. True case 4.66:1; under 3.0 reads as a bottle. */
const MIN_ASPECT = 3.0;
/** A 5.56 case is 44.7 x 9.6 mm. These bracket the RENDERED brass, in mm. */
const LEN_MM = [30, 60];
const WIDTH_MM = [4, 15];
/**
 * Brass in sun should sit inside the exposure. A specular glint clipping a few
 * pixels is correct; most of the case clipping is a glowing bar that blooms into
 * a ball, which is what made a 4.67:1 silhouette read as 2:1 with the eye.
 */
const MAX_CLIPPED_SHARE = 0.08;
/** Ground under the muzzle must gain this much luminance from one flash. */
const MIN_GROUND_GAIN = 1.15;
/**
 * ...and mid-range geometry must move too. Round 9: "radius is about 8 m so the
 * wall, scaffold and the enemies at 15 m all read within noise". 1.05 is roughly
 * three times the frame-to-frame noise of this patch and is reachable only with a
 * softened falloff exponent — at a physical 1/r^2 a 15 m sample gets 1.1% of the
 * near-field gain and this line can never pass.
 */
const MIN_MID_GAIN = 1.05;
/** ...and a patch 40 m away must not move (proves it is a pool, not exposure). */
const MAX_CONTROL_GAIN = 1.04;
/** The source must sit ahead of the crown, not on it. Round 9: "no forward bias". */
const MIN_FORWARD_BIAS_M = 0.30;
/**
 * Share of frames during sustained fire in which the muzzle light is actually
 * contributing. A working light with a 45 ms decay against an 83 ms cyclic
 * interval is dark in most frames, so most screenshots show an unlit world and
 * the review says the flash does nothing. That is a real defect, not a sampling
 * accident, and it needs its own number.
 */
const MIN_DUTY_SHARE = 0.7;

const CASING_TILE = 7;   // SPRITE.CASING

const PROBE_CASINGS = `(async () => {
  const eng = window.__blacksite.engine;
  const P = eng.systems.get('particles');
  if (!P?.alpha) return { error: 'no particles system / alpha batch' };
  const vm = eng.systems.get('viewmodel');

  const cam = eng.camera;
  const H = eng.renderer.domElement.height;
  const W = eng.renderer.domElement.width;

  const port = { x: 0, y: 0, z: 0, ok: false, camY: 0, depth: 0 };
  const rig = vm?.rig;
  if (rig?.root && rig.ejectPort) {
    rig.root.updateWorldMatrix(true, false);
    const v = rig.ejectPort.clone().applyMatrix4(rig.root.matrixWorld);
    port.x = v.x; port.y = v.y; port.z = v.z; port.ok = true;
    // The port in the camera's own frame. Brass cannot influence these two
    // numbers, which is what makes them safe to derive a threshold from.
    const c = v.clone().applyMatrix4(cam.matrixWorldInverse);
    port.camY = c.y; port.depth = -c.z;
  }
  // Eye height above the floor the player is actually standing on, for the
  // port-geometry floor below. NOT level.heightAt: that casts down from y = 40
  // and returns the FIRST hit, which under a scaffold is the walkway overhead —
  // it reported the eye as 4.29 m BELOW ground here. Cast down from the eye.
  const lvl0 = eng.systems.get('level');
  let eyeToGround = 1.8;
  if (lvl0?.raycast) {
    const dn = new (P._muzzle.constructor)(0, -1, 0);
    const floor = lvl0.raycast(cam.position, dn, 12);
    if (floor) eyeToGround = cam.position.y - floor.point.y;
  }

  // proj[1][1] = 1/tan(vfov/2). The batch offsets the quad in VIEW space, so a
  // quad of "size" metres at view depth z covers size*proj11/z in NDC, i.e.
  // size*proj11/z * H/2 pixels. This is the number the reviewer measured with a
  // ruler on the PNG.
  const proj11 = cam.projectionMatrix.elements[5];

  // ── sample the whole flight, not one frame ────────────────────────────────
  const worst = {
    n: 0, samples: 0, maxSize: 0, minSize: 1e9,
    maxDist: 0, maxPx: 0, maxPxDepth: 0, inFrame: 0,
    // Added round 10 — see the header. These are the numbers that fail.
    maxApparent: 0, maxApparentBackdrop: 0, maxApparentPx: 0,
    aboveEye: 0, maxCamY: -1e9, maxOnScreen: 0, minDepth: 1e9, skyBackdrop: 0,
  };
  const b = P.alpha;
  const level = eng.systems.get('level');
  const V3 = P._muzzle.constructor;
  const rayDir = new V3();
  const rayPt = new V3();
  /**
   * How far away is whatever this case is drawn against? A tool may allocate;
   * only the game may not. A miss means open sky, which is the worst possible
   * backdrop and is counted separately rather than silently skipped.
   */
  const backdropOf = (x, y, z) => {
    if (!level?.raycast) return null;
    rayPt.set(x, y, z);
    rayDir.copy(rayPt).sub(cam.position).normalize();
    const hit = level.raycast(cam.position, rayDir, 320);
    return hit ? cam.position.distanceTo(hit.point) : null;
  };
  const sample = () => {
    let n = 0;
    let onScreen = 0;
    for (let i = 0; i < b.count; i++) {
      if (b.aP[i * 4] !== ${CASING_TILE}) continue;
      n++;
      const x = b.aPos[i * 3], y = b.aPos[i * 3 + 1], z = b.aPos[i * 3 + 2];
      const s = Math.max(b.aSize[i * 3], b.aSize[i * 3 + 1], b.aSize[i * 3 + 2]);
      if (s > worst.maxSize) worst.maxSize = s;
      if (s < worst.minSize) worst.minSize = s;
      if (port.ok) {
        const d = Math.hypot(x - port.x, y - port.y, z - port.z);
        if (d > worst.maxDist) worst.maxDist = d;
      }
      // view-space depth and NDC, by hand (no allocation concerns here)
      const e = cam.matrixWorldInverse.elements;
      const vx = e[0] * x + e[4] * y + e[8] * z + e[12];
      const vy = e[1] * x + e[5] * y + e[9] * z + e[13];
      const vz = e[2] * x + e[6] * y + e[10] * z + e[14];
      const depth = -vz;
      if (depth < 0.02) continue;
      const px = s * proj11 / depth * (H / 2);
      // Is the centre actually in frame? Off-screen brass is not a defect.
      const ndcX = (vx * cam.projectionMatrix.elements[0]) / depth;
      const ndcY = (vy * proj11) / depth;
      if (Math.abs(ndcX) < 1.05 && Math.abs(ndcY) < 1.05) {
        worst.inFrame++;
        onScreen++;
        if (px > worst.maxPx) { worst.maxPx = px; worst.maxPxDepth = depth; }
        if (depth < worst.minDepth) worst.minDepth = depth;
        // vy IS the camera-space height: above 0 the case is over the eye plane
        // and its backdrop becomes the skyline rather than the apron.
        if (vy > worst.maxCamY) worst.maxCamY = vy;
        if (vy > -0.02) worst.aboveEye++;
        const bd = backdropOf(x, y, z);
        if (bd === null) worst.skyBackdrop++;
        const useBd = bd === null ? 120 : bd;
        const apparent = px / (proj11 * H / 2) * useBd;
        if (apparent > worst.maxApparent) {
          worst.maxApparent = apparent;
          worst.maxApparentBackdrop = useBd;
          worst.maxApparentPx = px;
        }
      }
    }
    if (n > worst.n) worst.n = n;
    if (onScreen > worst.maxOnScreen) worst.maxOnScreen = onScreen;
    worst.samples++;
  };

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let k = 0; k < 45; k++) { sample(); await wait(40); }

  // ── image measurement ─────────────────────────────────────────────────────
  //
  // The obvious approach — hide the world, render the brass alone — is WRONG
  // here and produced a badly misleading first result: with a near-black frame
  // the post chain's auto-exposure opens all the way up, every casing clips to
  // 255 and blooms into a round orange ball. The isolated image said "aspect
  // 1.02, perfectly circular" about a sprite whose silhouette is authored at
  // 4.67:1. Isolation changed the thing being measured.
  //
  // So measure inside the REAL composite: two frames of the real scene at the
  // real exposure, identical except that ONE casing is suppressed in the first.
  // The difference is exactly that casing's contribution, bloom halo included —
  // which is what a reviewer's ruler lands on.
  //
  // One casing, not all of them: with 28 in the air the connected components
  // merge and the moments describe the cloud rather than a case.
  //
  // CANDIDATES, not one pick. The first version of this took the largest
  // on-screen case and measured it — and once the arc was fixed so brass leaves
  // the port downward and outward, the largest case is the freshest one, which
  // sits behind the receiver and the support hand. Suppressing it changed nothing
  // in the image, the diff was empty, and the harness reported "no blob" about a
  // system that was working better than before. An occluded case is not a
  // measurement failure, it is the wrong case to measure: walk candidates in
  // descending size until one actually contributes pixels.
  const cands = [];
  {
    const e = cam.matrixWorldInverse.elements;
    const pe = cam.projectionMatrix.elements;
    for (let i = 0; i < b.count; i++) {
      if (b.aP[i * 4] !== ${CASING_TILE}) continue;
      const x = b.aPos[i * 3], y = b.aPos[i * 3 + 1], z = b.aPos[i * 3 + 2];
      const vx = e[0] * x + e[4] * y + e[8] * z + e[12];
      const vy = e[1] * x + e[5] * y + e[9] * z + e[13];
      const vz = e[2] * x + e[6] * y + e[10] * z + e[14];
      const depth = -vz;
      if (depth < 0.05) continue;
      const ndcX = (vx * pe[0]) / depth;
      const ndcY = (vy * pe[5]) / depth;
      // Well inside the frame: a case clipped by the edge has no valid moments.
      if (Math.abs(ndcX) > 0.88 || Math.abs(ndcY) > 0.88) continue;
      const s = Math.max(b.aSize[i * 3], b.aSize[i * 3 + 1], b.aSize[i * 3 + 2]);
      cands.push({ i, depth, px: s * proj11 / depth * (H / 2) });
    }
    cands.sort((p, q) => q.px - p.px);
  }
  if (!cands.length) return { error: 'no casing fully inside the frame to measure' };
  let tgt = cands[0].i, tgtDepth = cands[0].depth, tgtPx = cands[0].px;

  eng.stop();
  const gl = eng.renderer.getContext();
  const sizeBackup = new Float32Array(3);

  const grab = () => {
    // Four passes: TAA and the exposure meter both carry history, and one frame
    // of a changed population is still half the previous one.
    for (let k = 0; k < 4; k++) eng._frame();
    const out = new Uint8Array(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, out);
    return out;
  };
  const show = (idx, on) => {
    b.aSize[idx * 3] = on ? sizeBackup[0] : 0;
    b.aSize[idx * 3 + 1] = on ? sizeBackup[1] : 0;
    b.aSize[idx * 3 + 2] = on ? sizeBackup[2] : 0;
    b._staticDirty = true; b.flush();
  };
  const dsum = (a, bb, i) => {
    const p = i * 4;
    return Math.abs(a[p] - bb[p]) + Math.abs(a[p + 1] - bb[p + 1]) + Math.abs(a[p + 2] - bb[p + 2]);
  };
  const diffCount = (on, offb) => {
    let c = 0;
    for (let i = 0; i < W * H; i++) if (dsum(on, offb, i) > 24) c++;
    return c;
  };

  eng.paused = true;            // dt = 0: no new shots, no decay, no drift
  const live = worst.n;

  // ── stage A: geometry, with the post chain OFF ────────────────────────────
  // Bloom is the reason the first version of this harness lied. A clipped sprite
  // grows a wide soft skirt, and any threshold on the composite measures the
  // skirt rather than the sprite: it reported a 4.67:1 silhouette as 1.05:1.
  // With PostFX disabled the engine falls back to a plain forward render, so
  // what is measured is the quad's own coverage.
  const post = eng.systems.get('postfx');
  const postWas = post ? post.enabled : false;
  if (post) post.enabled = false;
  cam.clearViewOffset();          // TAA may have left a sub-pixel offset behind
  let rawOff = null, rawOn = null, tried = 0, occluded = 0;
  for (const c of cands.slice(0, 6)) {
    tried++;
    sizeBackup[0] = b.aSize[c.i * 3];
    sizeBackup[1] = b.aSize[c.i * 3 + 1];
    sizeBackup[2] = b.aSize[c.i * 3 + 2];
    if (sizeBackup[0] <= 0) continue;
    show(c.i, false); const off = grab();
    show(c.i, true);  const on = grab();
    // 40 px is a fifth of a case at this depth: enough to have moments, small
    // enough that a case peeking past the receiver still qualifies.
    if (diffCount(on, off) >= 40) {
      rawOff = off; rawOn = on;
      tgt = c.i; tgtDepth = c.depth; tgtPx = c.px;
      break;
    }
    occluded++;
  }
  if (post) post.enabled = postWas;
  if (!rawOff) {
    eng.paused = false; eng.start();
    return { error: 'every on-screen casing is fully occluded (' + tried + ' tried)' };
  }
  sizeBackup[0] = b.aSize[tgt * 3];
  sizeBackup[1] = b.aSize[tgt * 3 + 1];
  sizeBackup[2] = b.aSize[tgt * 3 + 2];

  // ── stage B: exposure, with the post chain ON ─────────────────────────────
  // Clipping has to be judged in the image that ships, tonemap and grade
  // included — raw HDR clips by construction and would fail every time.
  show(tgt, false); const postOff = grab();
  show(tgt, true);  const postOn = grab();

  eng.paused = false;
  eng.start();
  const mask = new Uint8Array(W * H);
  let count = 0, peakDiff = 0, peak = 0, clipped = 0;
  for (let i = 0; i < W * H; i++) {
    const d = dsum(rawOn, rawOff, i);
    if (d > peakDiff) peakDiff = d;
    if (d > 24) {
      mask[i] = 1; count++;
      const p = i * 4;
      const m = Math.max(postOn[p], postOn[p + 1], postOn[p + 2]);
      if (m > peak) peak = m;
      if (m >= 252) clipped++;
    }
  }
  void postOff;

  // Largest connected blob, then its principal-axis aspect via the second
  // moments of the pixel cloud. A fat bottle scores ~2:1, a rifle case ~4.7:1.
  // The moments are sigma-based and scaled by 2, which for a filled rectangle
  // recovers the side lengths to within a few percent.
  let best = null;
  const seen = new Uint8Array(W * H);
  const stack = new Int32Array(count + 8);
  const xs = new Int32Array(count + 8);
  const ys = new Int32Array(count + 8);
  for (let i = 0; i < W * H; i++) {
    if (!mask[i] || seen[i]) continue;
    let sp = 0, np = 0;
    stack[sp++] = i; seen[i] = 1;
    while (sp > 0) {
      const q = stack[--sp];
      const qx = q % W, qy = (q / W) | 0;
      xs[np] = qx; ys[np] = qy; np++;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = qx + dx, ny = qy + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const ni = ny * W + nx;
          if (mask[ni] && !seen[ni]) { seen[ni] = 1; stack[sp++] = ni; }
        }
      }
    }
    if (!best || np > best.n) {
      let mx = 0, my = 0;
      for (let k = 0; k < np; k++) { mx += xs[k]; my += ys[k]; }
      mx /= np; my /= np;
      let sxx = 0, syy = 0, sxy = 0;
      for (let k = 0; k < np; k++) {
        const ax = xs[k] - mx, ay = ys[k] - my;
        sxx += ax * ax; syy += ay * ay; sxy += ax * ay;
      }
      sxx /= np; syy /= np; sxy /= np;
      // Principal axis from the second moments, then the true EXTENT along it —
      // sigma times a shape constant would need the shape assumed in advance,
      // and a tapered case is neither a rectangle nor an ellipse. Extents are
      // also what a ruler on the PNG returns, which is the claim under test.
      const th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
      const ex = Math.cos(th), ey = Math.sin(th);
      let a0 = 1e9, a1 = -1e9, b0 = 1e9, b1 = -1e9;
      for (let k = 0; k < np; k++) {
        const dx2 = xs[k] - mx, dy2 = ys[k] - my;
        const pa = dx2 * ex + dy2 * ey;
        const pb = -dx2 * ey + dy2 * ex;
        if (pa < a0) a0 = pa; if (pa > a1) a1 = pa;
        if (pb < b0) b0 = pb; if (pb > b1) b1 = pb;
      }
      const major = Math.max(a1 - a0, b1 - b0) + 1;
      const minor = Math.min(a1 - a0, b1 - b0) + 1;
      best = {
        n: np,
        cx: Math.round(mx), cy: Math.round(my),
        major: +major.toFixed(1),
        minor: +minor.toFixed(1),
        aspect: +(major / Math.max(1, minor)).toFixed(2),
      };
    }
  }

  return {
    resolution: W + 'x' + H,
    portFound: port.ok,
    samples: worst.samples,
    liveMax: worst.n,
    liveAtCapture: live,
    inFrameSamples: worst.inFrame,
    sizeM: [+worst.minSize.toFixed(4), +worst.maxSize.toFixed(4)],
    maxDistFromPortM: +worst.maxDist.toFixed(2),
    maxOnScreenPx: +worst.maxPx.toFixed(1),
    maxOnScreenDepthM: +worst.maxPxDepth.toFixed(2),
    // Round-10 additions. apparentM is the size a viewer reads off the image.
    apparentM: +worst.maxApparent.toFixed(3),
    apparentFrom: [+worst.maxApparentPx.toFixed(1), +worst.maxApparentBackdrop.toFixed(1)],
    aboveEyeSamples: worst.aboveEye,
    maxCamY: +worst.maxCamY.toFixed(3),
    occludedCandidates: occluded,
    /**
     * The smallest apparent length the PORT's own geometry allows. A case is born
     * at port.camY metres below the eye, port.depth out; the ray through it
     * meets the apron at eyeToGround * depth / -camY, and the case reads as
     * quad * that / depth = quad * eyeToGround / -camY. Brass cannot influence
     * any of those three numbers, so this is a safe floor rather than a number
     * that relaxes when the defect comes back.
     */
    apparentFloorM: port.ok && port.camY < -0.01
      ? +(worst.maxSize * eyeToGround / -port.camY).toFixed(3) : null,
    portCamY: +port.camY.toFixed(3),
    portDepthM: +port.depth.toFixed(3),
    eyeToGroundM: +eyeToGround.toFixed(2),
    maxOnScreen: worst.maxOnScreen,
    minDepthM: worst.minDepth === 1e9 ? null : +worst.minDepth.toFixed(3),
    skyBackdropSamples: worst.skyBackdrop,
    maskPixels: count,
    peakChannel: peak,
    clippedShare: count ? +(clipped / count).toFixed(3) : 0,
    peakDiff,
    target: { index: tgt, depthM: +tgtDepth.toFixed(3), predictedPx: +tgtPx.toFixed(1) },
    // The rendered brass, in millimetres, from pixels and a known depth. A 5.56
    // case is 44.7 x 9.6 mm; this is the number that can be argued with.
    mm: best ? {
      length: +(best.major * tgtDepth / (proj11 * H / 2) * 1000).toFixed(1),
      width: +(best.minor * tgtDepth / (proj11 * H / 2) * 1000).toFixed(1),
    } : null,
    blob: best,
  };
})()`;

/**
 * THE SECOND CASING SYSTEM — and the reason two rounds of casing fixes "did not
 * move at all".
 *
 * `ViewModel` keeps its OWN pool of eight real brass MESHES (`vm._shell`, built by
 * `_buildShellGeometry`, ejected by `_ejectShell`) parented to `ctx.viewCamera`.
 * They are ejected on the same `weapon:fire` that makes `WeaponSystem` emit
 * `shell:eject` for the particle system, so every single shot throws TWO casings:
 * one billboard in the world scene and one mesh in the viewmodel scene.
 *
 * The section above measures the billboards. It was fixed and it passes. The
 * meshes are the ones the reviews have been measuring, and they are worse:
 *
 *   · parented to the view camera and `frustumCulled = false`, drawn in the
 *     viewmodel scene, so they are NEVER depth-tested against the world — a case
 *     0.85 m from the lens draws on top of a building 47 m away;
 *   · their velocity carries them UP through the eye plane (camera-space y reaches
 *     +0.15 m), which is where the backdrop stops being the apron and becomes the
 *     skyline;
 *   · at the viewmodel's 65-degree FOV a correct 39 mm case covers 39 px at
 *     0.85 m, and against a 47 m backdrop that reads as 2.9 m of brass. Some
 *     frames have no backdrop at all — open sky.
 *
 * The geometry is the right size in metres (bounding box 9.8 x 9.4 x 36.6 mm), so
 * once again there is no unit error anywhere. This check exists so the harness can
 * no longer report PASS while four metre-long casings hang over the skyline, and
 * so the failure names the right file. FIX BELONGS TO src/weapons/ViewModel.js.
 */
const PROBE_VMSHELLS = `(async () => {
  const eng = window.__blacksite.engine;
  const vm = eng.systems.get('viewmodel');
  if (!vm) return { error: 'no viewmodel system' };
  if (!vm._shell) return { absent: true };

  const cam = eng.camera;
  const vcam = eng.viewCamera;
  const lvl = eng.systems.get('level');
  const W = eng.renderer.domElement.width;
  const H = eng.renderer.domElement.height;

  const geo = vm._shellGeo;
  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  const diag = Math.hypot(bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z);

  const proj11vm = vcam.projectionMatrix.elements[5];
  const pe0vm = vcam.projectionMatrix.elements[0];
  // Apparent size is what the VIEWER reads, so the conversion back to metres uses
  // the WORLD camera's projection — that is the frame the backdrop is measured in.
  const proj11w = cam.projectionMatrix.elements[5];

  const V3 = cam.position.constructor;
  const wp = new V3();
  const dir = new V3();
  const w = {
    samples: 0, maxLive: 0, maxApparent: 0, maxApparentBackdrop: 0,
    aboveEye: 0, maxCamY: -1e9, sky: 0, onScreen: 0, maxOnScreen: 0,
    maxPx: 0, minDepth: 1e9, occludedCorrectly: 0,
  };
  const wait = (ms) => new Promise((res) => setTimeout(res, ms));

  for (let k = 0; k < 30; k++) {
    let live = 0;
    let on = 0;
    for (const s of vm._shell) {
      if (!s.mesh.visible) continue;
      live++;
      // The pool is parented to viewCamera, so mesh.position IS camera space.
      const lp = s.mesh.position;
      const depth = -lp.z;
      if (depth < 0.02) continue;
      const ndcX = lp.x * pe0vm / depth;
      const ndcY = lp.y * proj11vm / depth;
      if (Math.abs(ndcX) > 1.02 || Math.abs(ndcY) > 1.02) continue;
      on++;
      const px = diag * proj11vm / depth * (H / 2);
      if (px > w.maxPx) w.maxPx = px;
      if (depth < w.minDepth) w.minDepth = depth;
      if (lp.y > w.maxCamY) w.maxCamY = lp.y;
      if (lp.y > -0.02) w.aboveEye++;
      s.mesh.updateWorldMatrix(true, false);
      wp.setFromMatrixPosition(s.mesh.matrixWorld);
      let bd = null;
      if (lvl?.raycast) {
        dir.copy(wp).sub(cam.position).normalize();
        const hit = lvl.raycast(cam.position, dir, 400);
        if (hit) bd = cam.position.distanceTo(hit.point);
      }
      if (bd === null) w.sky++;
      const useBd = bd === null ? 120 : bd;
      const apparent = px / (proj11w * H / 2) * useBd;
      if (apparent > w.maxApparent) {
        w.maxApparent = apparent;
        w.maxApparentBackdrop = useBd;
      }
    }
    if (live > w.maxLive) w.maxLive = live;
    if (on > w.maxOnScreen) w.maxOnScreen = on;
    w.onScreen += on;
    w.samples++;
    await wait(60);
  }

  return {
    resolution: W + 'x' + H,
    poolSize: vm._shell.length,
    parentedTo: vm.shellRoot?.parent?.type ?? null,
    frustumCulled: vm._shell[0] ? vm._shell[0].mesh.frustumCulled : null,
    geoBoxMm: [
      +((bb.max.x - bb.min.x) * 1000).toFixed(1),
      +((bb.max.y - bb.min.y) * 1000).toFixed(1),
      +((bb.max.z - bb.min.z) * 1000).toFixed(1),
    ],
    geoDiagM: +diag.toFixed(4),
    samples: w.samples,
    maxLive: w.maxLive,
    maxOnScreen: w.maxOnScreen,
    maxPx: +w.maxPx.toFixed(1),
    minDepthM: w.minDepth === 1e9 ? null : +w.minDepth.toFixed(3),
    apparentM: +w.maxApparent.toFixed(3),
    apparentBackdropM: +w.maxApparentBackdrop.toFixed(1),
    aboveEyeSamples: w.aboveEye,
    maxCamY: w.maxCamY === -1e9 ? null : +w.maxCamY.toFixed(3),
    skySamples: w.sky,
  };
})()`;

const PROBE_FLASH = `(async () => {
  const eng = window.__blacksite.engine;
  const P = eng.systems.get('particles');
  const L = eng.systems.get('lighting');
  if (!L?.flashes) return { error: 'no lighting.flashes pool' };

  const cam = eng.camera;
  const gl = eng.renderer.getContext();
  const W = eng.renderer.domElement.width;
  const H = eng.renderer.domElement.height;

  // The world-space muzzle Particles actually uses, via its own accessor, so a
  // regression in _muzzlePosition shows up here too.
  const muzzle = new (P._muzzle.constructor)();
  P._muzzlePosition(muzzle);

  const level = eng.systems.get('level');
  const gy = level?.heightAt ? level.heightAt(muzzle.x, muzzle.z) : 0;
  const groundY = Number.isFinite(gy) ? gy : 0;

  // The parameters Particles._onFire hands to lighting.flash(), read from the
  // system itself rather than duplicated here, so a change to either shows up.
  const M = P.constructor.MUZZLE_LIGHT
    ?? { peak: 42, decay: 0.045, radius: 6, falloff: 2, forward: 0 };

  // Sample points on the ground along the aim vector from the muzzle.
  //   near 1.6 m  "the concrete directly in front of the muzzle" (round-8 review)
  //   mid  15 m   where the round-9 review said the enemies were, and where it
  //               asked to see the flash register at all
  //   ctrl 40 m   locality control: this must NOT move. A gain here means the
  //               exposure meter shifted, which lifts everything and reads as a
  //               working local light while being nothing of the kind.
  const d = P._muzzleDir;
  const at = (t) => ({ x: muzzle.x + d.x * t, y: groundY + 0.01, z: muzzle.z + d.z * t });
  const hit = at(1.6);

  /**
   * THE LOCALITY CONTROL, AND WHY IT IS SEARCHED FOR RATHER THAN ASSUMED.
   *
   * This used to be "the ground 40 m along the aim vector". The aim hits a wall at
   * 17 m, so that point is BEHIND geometry and the pixel sampled there belongs to
   * the wall — inside the light's reach. The control measured 1.09x and failed a
   * light that contributes exactly zero at 40 m, because it was not a control.
   *
   * So find real, visible geometry beyond the cutoff: sweep a coarse grid of view
   * directions, raycast each, and take the first hit past 45 m. Its distance is
   * reported so the reader can check it is genuinely out of reach.
   */
  let far = at(40.0);
  let ctrlDist = 40;
  let ctrlFound = false;
  if (level?.raycast) {
    const m = cam.matrixWorld.elements;
    const tanV = Math.tan(cam.fov * Math.PI / 360);
    const tanH = tanV * cam.aspect;
    const dir = new (P._muzzle.constructor)();
    outer:
    for (let ny = 0.25; ny >= -0.25 && !ctrlFound; ny -= 0.1) {
      for (let nx = -0.8; nx <= 0.8; nx += 0.1) {
        dir.set(
          -m[8] + m[0] * nx * tanH + m[4] * ny * tanV,
          -m[9] + m[1] * nx * tanH + m[5] * ny * tanV,
          -m[10] + m[2] * nx * tanH + m[6] * ny * tanV,
        ).normalize();
        const h = level.raycast(cam.position, dir, 260);
        if (!h) continue;
        const dist = cam.position.distanceTo(h.point);
        if (dist > 45) {
          far = { x: h.point.x - dir.x * 0.05, y: h.point.y - dir.y * 0.05, z: h.point.z - dir.z * 0.05 };
          ctrlDist = +dist.toFixed(1);
          ctrlFound = true;
          break outer;
        }
      }
    }
  }

  /**
   * THE MID-RANGE SAMPLE, AND WHY IT IS NOT A POINT ON THE GROUND.
   *
   * The first version of this took the apron 15 m down the aim vector, and it
   * measured 0.84x — the flash made it DARKER. That reading is real but it is not
   * evidence about the light, for two reasons. The aim vector is nearly
   * horizontal, so it meets the ground at ~83 degrees from the normal and that
   * patch receives ~12% of the irradiance an enemy's chest at the same range
   * does; and a 2.2x pool at 1.6 m closes the auto-exposure meter, which takes
   * ~16% off every mid-tone in the frame. No reachable light wins that.
   *
   * The review's claim was about "the wall, scaffold and the enemies at 15 m" —
   * surfaces facing the shooter. So sample the first geometry down the bore past
   * 8 m, pulled 3 cm off the surface, and report its range and incidence so the
   * number can be argued with.
   */
  let mid = at(15.0);
  let midKind = 'ground fallback @15m';
  let midRange = 15;
  let midCos = 0;
  if (level?.raycast) {
    const h = level.raycast(muzzle, d, 70);
    if (h && h.point.distanceTo(muzzle) > 8) {
      mid = { x: h.point.x - d.x * 0.03, y: h.point.y - d.y * 0.03, z: h.point.z - d.z * 0.03 };
      midRange = +h.point.distanceTo(muzzle).toFixed(1);
      midCos = h.normal ? +Math.abs(h.normal.dot(d)).toFixed(2) : 0;
      midKind = 'first surface down the bore';
    }
  }

  const project = (p) => {
    const e = cam.matrixWorldInverse.elements;
    const vx = e[0] * p.x + e[4] * p.y + e[8] * p.z + e[12];
    const vy = e[1] * p.x + e[5] * p.y + e[9] * p.z + e[13];
    const vz = e[2] * p.x + e[6] * p.y + e[10] * p.z + e[14];
    const depth = -vz;
    const pe = cam.projectionMatrix.elements;
    const nx = (vx * pe[0]) / depth;
    const ny = (vy * pe[5]) / depth;
    return {
      x: Math.round((nx * 0.5 + 0.5) * W),
      y: Math.round((ny * 0.5 + 0.5) * H),   // gl readPixels is bottom-up
      depth: +depth.toFixed(2),
      onScreen: Math.abs(nx) < 0.95 && Math.abs(ny) < 0.95,
    };
  };
  const near = project(hit);
  const midp = project(mid);
  const ctrl = project(far);

  eng.stop();
  eng.paused = true;   // dt = 0 so FlashPool.update neither decays nor clears

  /**
   * Force the pool into a known state, then render.
   *
   * Re-applied before EVERY frame, and that is not paranoia: stepping a frame
   * runs update() on every system, and even at dt = 0 the weapon and the AI each
   * get one more shot off, which calls lighting.flash() and recycles the slot out
   * from under the measurement. The first version of this probe reported the
   * stolen AI light's 54 m cutoff as if it were the 6 m muzzle light it had asked
   * for, and the "on" frame it measured was not the light it thought.
   */
  const setPool = (on, peak, decay) => {
    const F = L.flashes;
    for (let i = 0; i < F.size; i++) {
      F.active[i] = 0;
      F.lights[i].intensity = 0;
    }
    if (!on) return null;
    const l = F.lights[0];
    l.color.set(M.colour ?? 0xffe9d2);
    // Exactly what _onFire does: sourced FORWARD of the crown, not at it.
    l.position.copy(muzzle).addScaledVector(d, M.forward ?? 0);
    l.intensity = peak;
    l.distance = M.radius ?? 6.0;
    l.decay = M.falloff ?? 2;
    F.active[0] = 1; F.peak[0] = peak; F.life[0] = decay; F.maxLife[0] = decay;
    return l;
  };
  const grab = (on, peak, decay) => {
    let l = null;
    for (let k = 0; k < 3; k++) { l = setPool(on, peak, decay); eng._frame(); }
    const out = new Uint8Array(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, out);
    // Snapshot NOW. Reading l.distance later returns whatever the live loop has
    // since recycled into the slot — which is how this probe first came to report
    // a stolen AI flash's 54 m cutoff as the muzzle light's 6 m.
    out.light = l ? {
      distance: l.distance, intensity: +l.intensity.toFixed(2), decay: l.decay,
      // Forward offset from the crown, along the aim vector: the round-9 review's
      // "camera-centred with no forward bias" is exactly this number being zero.
      forwardOfMuzzle: +(
        (l.position.x - muzzle.x) * d.x
        + (l.position.y - muzzle.y) * d.y
        + (l.position.z - muzzle.z) * d.z).toFixed(3),
      fromCameraM: +l.position.distanceTo(cam.position).toFixed(2),
    } : null;
    return out;
  };
  // Mean luminance of a patch, in display-referred sRGB bytes. Ratios of these
  // understate a linear gain, which makes the threshold conservative.
  const lum = (buf, cx, cy, r) => {
    let s = 0, n = 0;
    for (let y = cy - r; y <= cy + r; y++) {
      if (y < 0 || y >= H) continue;
      for (let x = cx - r; x <= cx + r; x++) {
        if (x < 0 || x >= W) continue;
        const p = (y * W + x) * 4;
        s += 0.2126 * buf[p] + 0.7152 * buf[p + 1] + 0.0722 * buf[p + 2];
        n++;
      }
    }
    return n ? s / n : 0;
  };

  // Baseline: nothing in the flash pool contributes. Also suppress the FX
  // sprites so an additive muzzle billboard drifting over the sample patch
  // cannot be mistaken for the light doing work.
  const fxA = P.alpha.mesh.visible, fxB = P.additive.mesh.visible;
  P.alpha.mesh.visible = false; P.additive.mesh.visible = false;
  grab(false);                  // let the composer settle on the new state
  const off = grab(false);

  grab(true, M.peak, M.decay);
  const on = grab(true, M.peak, M.decay);
  const light = on.light;

  setPool(false);
  P.alpha.mesh.visible = fxA; P.additive.mesh.visible = fxB;
  eng.paused = false;          // real dt again: the weapon fires, the light decays

  // ── duty cycle: is the light ever ON in a frame someone photographs? ──────
  // The forced test above answers "does the light reach the ground". It does not
  // answer "is it lit in the frame a reviewer looks at" — a 45 ms decay against
  // an 83 ms cyclic interval spends most of its life near zero, and a screenshot
  // that lands in the tail shows an unlit world with a working light. So step the
  // engine at real dt and count.
  const rafp = () => new Promise((r) => requestAnimationFrame(r));
  let lit = 0, frames = 0, minL = 1e9, maxL = 0;
  const patch = new Uint8Array((2 * 14 + 1) * (2 * 14 + 1) * 4);
  for (let k = 0; k < 60; k++) {
    await rafp();
    eng._frame();
    gl.readPixels(near.x - 14, near.y - 14, 29, 29, gl.RGBA, gl.UNSIGNED_BYTE, patch);
    let s = 0;
    for (let p = 0; p < patch.length; p += 4) {
      s += 0.2126 * patch[p] + 0.7152 * patch[p + 1] + 0.0722 * patch[p + 2];
    }
    s /= patch.length / 4;
    if (s < minL) minL = s;
    if (s > maxL) maxL = s;
    frames++;
    // A flash slot sitting on the muzzle and actually contributing.
    for (let i = 0; i < L.flashes.size; i++) {
      const l = L.flashes.lights[i];
      if (l.intensity > 2 && l.position.distanceTo(muzzle) < 1.5) { lit++; break; }
    }
  }
  eng.start();

  const R = 14;
  const nOff = lum(off, near.x, near.y, R);
  const nOn = lum(on, near.x, near.y, R);
  const mOff = lum(off, midp.x, midp.y, R);
  const mOn = lum(on, midp.x, midp.y, R);
  const cOff = lum(off, ctrl.x, ctrl.y, R);
  const cOn = lum(on, ctrl.x, ctrl.y, R);
  return {
    resolution: W + 'x' + H,
    muzzle: [+muzzle.x.toFixed(2), +muzzle.y.toFixed(2), +muzzle.z.toFixed(2)],
    groundY: +groundY.toFixed(2),
    lightAcquired: !!light,
    lightDistance: light ? light.distance : null,
    lightIntensity: light ? light.intensity : null,
    lightFalloff: light ? light.decay : null,
    lightForwardOfMuzzle: light ? light.forwardOfMuzzle : null,
    lightFromCameraM: light ? light.fromCameraM : null,
    nearPatch: near, midPatch: midp, ctrlPatch: ctrl,
    midKind, midRange, midCos, ctrlDist, ctrlFound,
    nearLum: [+nOff.toFixed(2), +nOn.toFixed(2)],
    midLum: [+mOff.toFixed(2), +mOn.toFixed(2)],
    ctrlLum: [+cOff.toFixed(2), +cOn.toFixed(2)],
    groundGain: +(nOn / Math.max(1e-3, nOff)).toFixed(3),
    midGain: +(mOn / Math.max(1e-3, mOff)).toFixed(3),
    controlGain: +(cOn / Math.max(1e-3, cOff)).toFixed(3),
    dutyFrames: frames,
    dutyShare: +(lit / Math.max(1, frames)).toFixed(3),
    naturalGroundRange: [+minL.toFixed(2), +maxL.toFixed(2)],
    naturalGroundSwing: +(maxL / Math.max(1e-3, minL)).toFixed(3),
  };
})()`;

const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=d3d11', '--disable-gpu-sandbox', '--ignore-gpu-blocklist'],
});
const url = opt('url', 'http://127.0.0.1:5180');
let failed = false;
const json = {};

async function open() {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)); });
  await page.goto(`${url}/?freeze=1&hud=0&quality=cinematic&${VIEW}`,
    { waitUntil: 'domcontentloaded', timeout: 300000 });
  await page.waitForFunction('window.__ready === true', null, { timeout: 300000 });
  await page.waitForTimeout(900);
  return { page, errs };
}
const line = (ok, label, value, note = '') =>
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${label.padEnd(26)} ${String(value).padEnd(26)} ${note}`);

/**
 * Suppresses every alpha particle that is not a casing and turns the post chain
 * off, leaving the brass in the real world at the real scale with no bloom skirt,
 * for `--shot`. The world stays visible on purpose: the useful crop is brass
 * against the geometry it is being compared to, and hiding the world sends
 * auto-exposure to maximum and turns every case into a round ball. Separate from
 * the measurement because page.screenshot cannot run inside page.evaluate.
 */
const ISOLATE = (on) => `(() => {
  const eng = window.__blacksite.engine;
  const P = eng.systems.get('particles');
  const post = eng.systems.get('postfx');
  const b = P.alpha;
  if (${on}) {
    window.__fxsave = {
      post: post ? post.enabled : false,
      add: P.additive.mesh.visible,
      size: Float32Array.from(b.aSize),
    };
    if (post) post.enabled = false;
    eng.camera.clearViewOffset();
    P.additive.mesh.visible = false;
    for (let i = 0; i < b.count; i++) {
      if (b.aP[i * 4] === ${CASING_TILE}) continue;
      b.aSize[i * 3] = 0; b.aSize[i * 3 + 1] = 0; b.aSize[i * 3 + 2] = 0;
    }
    b._staticDirty = true; b.flush();
    eng.paused = true;
    return true;
  }
  const s = window.__fxsave;
  if (!s) return false;
  b.aSize.set(s.size); b._staticDirty = true; b.flush();
  P.additive.mesh.visible = s.add;
  if (post) post.enabled = s.post;
  eng.paused = false;
  return true;
})()`;

if (runCasings) {
  const { page, errs } = await open();
  const r = await page.evaluate(PROBE_CASINGS);
  const shot = opt('shot', null);
  if (shot) {
    await page.evaluate(ISOLATE(true));
    await page.waitForTimeout(300);
    await page.screenshot({ path: shot });
    await page.evaluate(ISOLATE(false));
    console.log(`  isolated brass written to ${shot}`);
  }
  json.casings = r;
  console.log('\n=== CASINGS ===');
  if (r.error) { console.log('  ' + r.error); failed = true; }
  else {
    const okAny = r.liveMax > 0;
    const okSize = r.sizeM[0] >= SIZE_MIN_M && r.sizeM[1] <= SIZE_MAX_M;
    const okDist = r.portFound && r.maxDistFromPortM <= MAX_DIST_FROM_PORT_M;
    const okPx = r.maxOnScreenPx <= MAX_ON_SCREEN_PX;
    const okAsp = !!r.blob && r.blob.aspect >= MIN_ASPECT;
    const okPeak = r.clippedShare <= MAX_CLIPPED_SHARE;
    // ── the round-10 metrics ────────────────────────────────────────────────
    // The bound is whichever is looser: the target, or what the port's own
    // geometry forces on the frame a case is born. See `apparentFloorM`.
    const appBound = Math.max(MAX_APPARENT_M, r.apparentFloorM ?? 0);
    const okApp = r.apparentM <= appBound;
    const okEye = r.aboveEyeSamples <= MAX_ABOVE_EYE_SAMPLES;
    const okCrowd = r.maxOnScreen <= MAX_ON_SCREEN;
    const okLive = r.liveMax <= MAX_LIVE;
    const okNear = r.minDepthM === null || r.minDepthM >= MIN_DEPTH_M;
    const okSky = r.skyBackdropSamples === 0;
    if (!okAny || !okSize || !okDist || !okPx || !okAsp || !okPeak
      || !okApp || !okEye || !okCrowd || !okLive || !okNear || !okSky) failed = true;
    console.log(`  ${r.resolution}, ${r.samples} samples over ~1.8s, ${r.liveMax} casings live at peak,`
      + ` ${r.maskPixels} px covered at capture`);
    line(okAny, 'casings exist', r.liveMax, '(control — 0 means nothing was measured)');
    line(okSize, 'quad size m', `${r.sizeM[0]}..${r.sizeM[1]}`, `need ${SIZE_MIN_M}..${SIZE_MAX_M} (5.56 case = 0.045)`);
    line(okDist, 'max dist from port m', r.maxDistFromPortM, `need <= ${MAX_DIST_FROM_PORT_M}`);
    line(okPx, 'max on-screen length px', `${r.maxOnScreenPx} @ ${r.maxOnScreenDepthM}m`, `need <= ${MAX_ON_SCREEN_PX}`);
    line(okAsp, 'silhouette aspect', r.blob ? `${r.blob.aspect} (${r.blob.major}x${r.blob.minor}px, n=${r.blob.n})` : 'no blob',
      `need >= ${MIN_ASPECT} (true 5.56 = 4.66)`);
    // The rendered brass in millimetres, from measured pixels at a known depth —
    // the number a reviewer can argue with.
    const okW = !!r.mm
      && r.mm.length >= LEN_MM[0] && r.mm.length <= LEN_MM[1]
      && r.mm.width >= WIDTH_MM[0] && r.mm.width <= WIDTH_MM[1];
    if (!okW) failed = true;
    line(okW, 'rendered brass', r.mm ? `${r.mm.length} x ${r.mm.width} mm @ ${r.target.depthM}m` : 'no blob',
      `need ${LEN_MM[0]}..${LEN_MM[1]} x ${WIDTH_MM[0]}..${WIDTH_MM[1]} (true 44.7 x 9.6)`);
    line(okPeak, 'clipped share', `${r.clippedShare} (peak channel ${r.peakChannel})`,
      `need <= ${MAX_CLIPPED_SHARE} of the brass at 252+`);
    console.log('  --- as the eye reads it (round 10) ---');
    line(okApp, 'APPARENT length', `${r.apparentM} m  (${r.apparentFrom[0]}px vs ${r.apparentFrom[1]}m backdrop)`,
      `need <= ${appBound.toFixed(3)} - px / backdrop depth, not px / its own depth`);
    console.log(`       bound = max(target ${MAX_APPARENT_M}, port-geometry floor ${r.apparentFloorM})`
      + ` from port ${r.portCamY} m below the eye at ${r.portDepthM} m, eye ${r.eyeToGroundM} m up.`
      + (r.apparentFloorM > MAX_APPARENT_M
        ? ' FLOOR IS BINDING: the residual is the port height, which is Weapon.js/ViewModel.js.'
        : ''));
    line(okEye, 'samples above eye plane', `${r.aboveEyeSamples} (peak camY ${r.maxCamY} m)`,
      `need ${MAX_ABOVE_EYE_SAMPLES} - above the eye the backdrop becomes the skyline`);
    line(okSky, 'samples against open sky', r.skyBackdropSamples, 'need 0');
    line(okCrowd, 'casings on screen at once', r.maxOnScreen, `need <= ${MAX_ON_SCREEN}`);
    line(okLive, 'casings live at once', r.liveMax, `need <= ${MAX_LIVE}`);
    line(okNear, 'nearest to the lens', `${r.minDepthM} m`, `need >= ${MIN_DEPTH_M}`);
    if (!okApp || !okEye) console.log('  -> the brass is the right size in metres and still reads as'
      + ' metres long, because it is drawn ABOVE THE EYE PLANE against geometry ~17 m away and the'
      + ' viewer divides pixels by THAT depth. Fix the arc, not the scale:'
      + ' `WeaponData.ejectVelocity` launches +1.9 m/s up from a port 0.18 m below the eye, and'
      + ' 1.9^2 / (2 * 9.9) = 0.18 m of climb puts every case exactly on the horizon.');
    if (!okAsp && r.blob) console.log('  -> the quad is the right size in METRES and still wrong in PIXELS.'
      + ' Either the silhouette inside SpriteAtlas\'s CASING tile is too fat, or the batch is'
      + ' sampling a different tile than SPRITE.CASING — check AtlasCanvas.paint\'s row placement'
      + ' against ParticleBatch\'s (row + uv) / rows. A near-1.0 aspect means a round sprite,'
      + ' which is what a mirrored atlas row hands you (EMBER sits opposite CASING).');
  }
  if (errs.length) { console.log('  page errors: ' + errs.slice(0, 3).join(' | ')); failed = true; }
  await page.close();
}

if (runVm) {
  const { page, errs } = await open();
  const r = await page.evaluate(PROBE_VMSHELLS);
  json.vmshells = r;
  console.log('\n=== CASINGS, SECOND SYSTEM: ViewModel brass MESHES ===');
  console.log('  cross-system check. OWNER: src/weapons/ViewModel.js (_shell pool,');
  console.log('  _ejectShell, _buildShellGeometry) — NOT src/fx. A failure here is not');
  console.log('  an FX regression; see the note above PROBE_VMSHELLS.');
  if (r.error) { console.log('  ' + r.error); failed = true; }
  else if (r.absent) console.log('  no vm._shell pool — nothing to check (good: one brass system)');
  else {
    console.log(`  pool of ${r.poolSize} meshes parented to ${r.parentedTo},`
      + ` frustumCulled=${r.frustumCulled}, geometry ${r.geoBoxMm.join(' x ')} mm`
      + ` (diag ${r.geoDiagM} m — CORRECT, there is no unit error here either)`);
    const vApp = r.apparentM <= MAX_APPARENT_M;
    const vEye = r.aboveEyeSamples <= MAX_ABOVE_EYE_SAMPLES;
    const vSky = r.skySamples === 0;
    const vCrowd = r.maxOnScreen <= MAX_ON_SCREEN;
    if (!vApp || !vEye || !vSky || !vCrowd) failed = true;
    line(vApp, 'APPARENT length', `${r.apparentM} m  (${r.maxPx}px vs ${r.apparentBackdropM}m backdrop)`,
      `need <= ${MAX_APPARENT_M}`);
    line(vEye, 'samples above eye plane', `${r.aboveEyeSamples} (peak camY ${r.maxCamY} m)`,
      `need ${MAX_ABOVE_EYE_SAMPLES}`);
    line(vSky, 'samples against open sky', r.skySamples, 'need 0');
    line(vCrowd, 'meshes on screen at once', r.maxOnScreen, `need <= ${MAX_ON_SCREEN}`);
    console.log(`       ${r.maxLive} live of ${r.poolSize}, nearest ${r.minDepthM} m,`
      + ` over ${r.samples} samples`);
    if (!vApp || !vEye) console.log('  -> These are the casings the round-8 and round-9 reviews measured.'
      + ' They are drawn in the VIEWMODEL scene with frustumCulled off, so they are never'
      + ' depth-tested against the world: a case 0.85 m from the lens draws on top of a'
      + ' building 47 m away, and its velocity carries it up through the eye plane where'
      + ' the backdrop becomes the skyline. Note also that EVERY shot ejects two casings —'
      + ' this mesh AND a particle billboard from shell:eject — so the two systems'
      + ' duplicate each other and one should go.');
  }
  if (errs.length) { console.log('  page errors: ' + errs.slice(0, 3).join(' | ')); failed = true; }
  await page.close();
}

if (runFlash) {
  const { page, errs } = await open();
  const r = await page.evaluate(PROBE_FLASH);
  json.flash = r;
  console.log('\n=== MUZZLE FLASH → WORLD ===');
  if (r.error) { console.log('  ' + r.error); failed = true; }
  else {
    const okOn = r.nearPatch.onScreen;
    const okLight = r.lightAcquired;
    const okGain = r.groundGain >= MIN_GROUND_GAIN;
    const okMid = r.midGain >= MIN_MID_GAIN;
    const okCtrl = r.controlGain <= MAX_CONTROL_GAIN;
    const okFwd = (r.lightForwardOfMuzzle ?? 0) >= MIN_FORWARD_BIAS_M;
    if (!okOn || !okLight || !okGain || !okMid || !okCtrl || !okFwd) failed = true;
    console.log(`  muzzle ${JSON.stringify(r.muzzle)}, ground y ${r.groundY},`
      + ` patch at ${r.nearPatch.x},${r.nearPatch.y} (${r.nearPatch.depth}m)`);
    line(okLight, 'flash slot acquired', r.lightAcquired,
      `${r.lightIntensity} cd, cutoff ${r.lightDistance} m, falloff exp ${r.lightFalloff}`);
    line(okFwd, 'sourced ahead of crown', `${r.lightForwardOfMuzzle} m`,
      `need >= ${MIN_FORWARD_BIAS_M} (${r.lightFromCameraM} m from the camera)`);
    line(okOn, 'sample patch on screen', `${r.nearPatch.x},${r.nearPatch.y}`, '(control)');
    line(okGain, 'ground gain @1.6m', `${r.groundGain}x  (${r.nearLum[0]} -> ${r.nearLum[1]})`,
      `need >= ${MIN_GROUND_GAIN}`);
    line(okMid, `mid gain @${r.midRange}m`, `${r.midGain}x  (${r.midLum[0]} -> ${r.midLum[1]})`,
      `need >= ${MIN_MID_GAIN} - ${r.midKind}, incidence cos ${r.midCos}`);
    line(okCtrl, `control @${r.ctrlDist}m gain`, `${r.controlGain}x  (${r.ctrlLum[0]} -> ${r.ctrlLum[1]})`,
      `need <= ${MAX_CONTROL_GAIN} (${r.ctrlFound ? 'verified surface past 45m' : 'NO far surface found - not a control'})`);
    const okDuty = r.dutyShare >= MIN_DUTY_SHARE;
    if (!okDuty) failed = true;
    line(okDuty, 'lit frames while firing', `${r.dutyShare} of ${r.dutyFrames}`,
      `need >= ${MIN_DUTY_SHARE} - a light nobody's screenshot catches is not in the picture`);
    console.log(`       ground patch swings ${r.naturalGroundSwing}x across those frames`
      + ` (${r.naturalGroundRange[0]} .. ${r.naturalGroundRange[1]})`);
    if (!okGain) console.log('  -> the flash adds no light to the world. A PointLight existing in'
      + ' ctx.scene is not the same claim as the ground changing value.');
  }
  if (errs.length) { console.log('  page errors: ' + errs.slice(0, 3).join(' | ')); failed = true; }
  await page.close();
}

await browser.close();
if (has('json')) console.log('\n' + JSON.stringify(json, null, 1));
console.log(`\n${failed ? 'FAIL' : 'PASS'} — fx casings/flash`);
process.exitCode = failed ? 1 : 0;
