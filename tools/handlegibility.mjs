#!/usr/bin/env node
/**
 * Pixel assertion that the first-person hands are LEGIBLE — not merely present.
 *
 * ─── WHY A SECOND HAND HARNESS EXISTS ─────────────────────────────────────
 *
 * tools/handcheck.mjs settled the question "are the hands on screen?". It now
 * answers yes: 2.7% of the hip frame rasterises hand, 2.0% survives into the
 * composite, the fingers demonstrably wrap the grip. And the review still said
 * "the rifle is held by nothing", because presence is not the property a viewer
 * judges. A gloved hand rendered at the same value and the same hue as the
 * phosphate receiver it is gripping is, to the eye, more receiver. Two reviewers
 * and the orchestrator independently looked at the wide frame and wrote "no
 * hands" while 21 000 hand pixels were in it.
 *
 * So this harness measures the property that decides whether a shape is read as
 * a separate object: TONAL AND CHROMATIC SEPARATION FROM ITS SURROUNDINGS,
 * measured in the finished, tone-mapped, graded composite the player actually
 * sees.
 *
 * ─── THE FOUR NUMBERS ─────────────────────────────────────────────────────
 *
 *   lumRatio    mean displayed luminance of hand pixels / mean displayed
 *               luminance of the WEAPON pixels within 64 px of them. Local,
 *               because legibility is local: what matters is the value step
 *               across the boundary the eye is looking at, not the frame mean.
 *
 *   edgeWeber   mean Weber contrast |L1-L2|/max(L1,L2,eps) sampled across every
 *               hand/not-hand silhouette boundary pixel. This is the single
 *               number that predicts "can I see a hand shape here": a hand can
 *               have a healthy mean value and still vanish if it happens to sit
 *               against something of the same value everywhere along its edge.
 *
 *   warmDelta   difference in warmth (R-B)/(R+B) between hand and local weapon
 *               pixels. Value alone is not enough on a weapon lit by a low sun,
 *               where the key paints everything the same colour; a glove has to
 *               differ in ALBEDO hue to hold apart from the receiver under any
 *               key. Positive means the hand is warmer than the weapon.
 *
 *   visiblePct  share of frame covered by hand pixels that survive into the
 *               composite, so a "fix" that wins contrast by deleting geometry
 *               cannot pass.
 *
 * ─── FOUR MEASUREMENT TRAPS, ALL ALREADY PAID FOR ─────────────────────────
 *
 * 1. THE WORLD MUST BE VISIBLE. handcheck hides ctx.scene so its isolation is
 *    clean. That is right for coverage and wrong for contrast: roughly half the
 *    support hand's silhouette is against the level, not against the weapon, and
 *    hiding the world replaces that background with the post chain's black floor,
 *    which manufactures contrast that does not exist in the game. Every frame
 *    grabbed here is a full render.
 *
 * 2. LUMINANCE IS READ FROM THE DISPLAYED VALUES, NOT LINEARISED. The framebuffer
 *    is post-AgX, post-grade, post-vignette. What decides whether a viewer reads
 *    two adjacent regions as different objects is the difference in the numbers
 *    the monitor receives, so those are the numbers compared. Linearising first
 *    would report a 2.1x albedo ratio as a win at exactly the point on the tone
 *    curve where the display crushes it to nothing — which is precisely how the
 *    previous round's glove-albedo lift was believed to have landed.
 *
 * 3. AUTO-EXPOSURE MAKES THE MASK A LIE. The hands are 2% of the frame, close to
 *    the camera and (after this round) the brightest thing in the lower half of
 *    it — and AutoExposurePass meters a centre-weighted log-average. Hiding them
 *    therefore moves the stop for the WHOLE image, so a naive "which pixels
 *    changed" mask picks up every pixel in the frame: the first run of this tool
 *    reported 6.27% hand coverage against handcheck's independently-verified
 *    1.98%, and an ADS number 4.7x too high. The probe pins the metering
 *    authority to zero stops, which clamps the target to the per-time-of-day
 *    nominal and makes exposure independent of scene content, then restores it.
 *
 * 4. TAA REMEMBERS THE PREVIOUS ISOLATION. The temporal pass blends 16 jittered
 *    frames of history, so the frame captured immediately after toggling mesh
 *    visibility still contains the previous configuration. It is disabled for the
 *    duration of the probe, and two frames are driven per grab so nothing else in
 *    the chain is reading a stale target either.
 *
 * 5. FILM GRAIN RE-ROLLS 24 TIMES A SECOND. FinishEffect drifts its grain on
 *    floor(t*24) and adds up to ±4.5/255 to all three channels at once, which is
 *    ±13 on the sum-of-absolute-differences the mask thresholds at 24 — so the
 *    noisiest texels flip in and out of the mask purely from the clock. Grain is
 *    zeroed for the probe.
 *
 * 6. `?freeze=1` DOES NOT STOP THE VISUALS. It holds simulation time, but every
 *    system's `update(dt)` still runs, so cloud drift, dust motes and the weapon's
 *    own idle sway all advance between grabs — 3.4% of the frame differed between
 *    two renders that were supposed to be identical. `engine.paused = true` zeroes
 *    dt for update() as well, which is the only setting under which two
 *    consecutive frames are the same image.
 *
 * And because five of those six were found by being surprised at a number rather
 * than by reasoning ahead, the probe ends by measuring its own noise floor:
 * `nullDiffPx` diffs two grabs taken with IDENTICAL visibility. On a clean probe
 * that is zero. If it is not, every statistic above it is contaminated, and the
 * tool says so and fails instead of reporting a number.
 *
 * Usage: node tools/handlegibility.mjs [--views viewmodel-hip,viewmodel-ads]
 *                                     [--json out.json]
 * Exits non-zero if any view fails.
 */
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };

const VIEWS = {
  'viewmodel-hip': 'tod=golden&pos=6,1.7,14&yaw=200&pitch=-0.02&vm=1',
  'viewmodel-ads': 'tod=golden&pos=6,1.7,14&yaw=200&pitch=-0.02&vm=1&ads=1',
};
const want = (opt('views', 'viewmodel-hip,viewmodel-ads')).split(',').map((s) => s.trim());

/**
 * Thresholds.
 *
 * Calibrated against the measured build, not guessed. The pre-fix build reads
 * lumRatio 1.05 / edgeWeber 0.20 / warmDelta 0.006 in hipfire — a hand the same
 * value, the same edge contrast and the same colour as the gun, which is the
 * defect stated in prose by three reviews. The bars below sit above that and
 * below what a real light-tan glove on a dark weapon produces.
 *
 * edgeWeber is the weakest-looking number and the most important one: 0.30 means
 * the average silhouette pixel differs from what it sits against by 30% of the
 * brighter of the two, which is several times the ~5% a viewer needs to resolve
 * an edge, and is the margin that survives a dark time of day.
 */
const MIN_LUM_RATIO = 1.45;
const MIN_EDGE_WEBER = 0.30;
const MIN_WARM_DELTA = 0.030;
const MIN_VISIBLE_PCT = 0.6;

/**
 * Grab three full renders and reduce them to the four statistics.
 *
 * Isolation toggles `visible` on the hand meshes and the weapon-rig meshes and
 * drives one frame by hand. The engine's rAF loop is stopped first: headless
 * Chromium paces it on a virtual clock and would queue an ordinary frame over
 * the isolated one before readPixels sampled it.
 */
const PROBE = `(() => {
  const eng = window.__blacksite.engine;
  const vm = eng.systems.get('viewmodel');
  if (!vm) return { error: 'no viewmodel system' };
  if (!vm.hands || !vm.rig) return { error: 'viewmodel exposes no .hands/.rig handles' };

  const gl = eng.renderer.getContext();
  const W = eng.renderer.domElement.width;
  const H = eng.renderer.domElement.height;
  const N = W * H;

  const handMeshes = vm.hands.meshes || [];
  const rigMeshes = vm.rig.meshes || [];
  const loose = [vm.rig.optic?.lens, vm.rig.optic?.reticle].filter(Boolean);

  const post = eng.systems.get('postfx');
  const expUni = post?.autoExposure?._adaptMaterial?.uniforms ?? null;
  const grainU = post?.finish?.uniforms?.get?.('uGrain') ?? null;
  const saved = {
    hands: handMeshes.map((m) => m.visible),
    rig: rigMeshes.map((m) => m.visible),
    loose: loose.map((m) => m.visible),
    authority: expUni ? expUni.uAuthority.value : null,
    taa: post ? post.toggles.taa : null,
    grain: grainU ? grainU.value : null,
    paused: eng.paused,
  };
  if (!expUni) return { error: 'cannot reach the exposure pass — mask would be exposure noise' };

  eng.stop();
  // Trap 6: dt = 0, so nothing in any system's update() advances between grabs.
  eng.paused = true;
  // Trap 4: no temporal history across isolations.
  if (post) post.toggles.taa = false;
  // Trap 5: no per-frame grain re-roll.
  if (grainU) grainU.value = 0;
  /**
   * Trap 3: LOCK the stop, at the value the game is actually showing.
   *
   * Zeroing the authority alone pins metering to the per-time-of-day nominal,
   * which is content-independent but is NOT the exposure the player sees — the
   * meter is allowed 1.25 stops of trim and in this view it is using most of
   * them, so measuring at nominal reads the frame a stop dark and lands the
   * whole comparison lower on the tone curve than it belongs. So: settle the
   * meter with everything visible, read the stop it converged on, and make THAT
   * the nominal with zero authority. Content-independent and correct.
   */
  handMeshes.forEach((m) => { m.visible = true; });
  rigMeshes.forEach((m) => { m.visible = true; });
  loose.forEach((m) => { m.visible = true; });
  for (let i = 0; i < 24; i++) eng._frame();
  const settled = post.readExposure?.();
  const lockedStop = settled && settled.exposure > 1e-5 ? settled.exposure : null;
  if (lockedStop) expUni.uNominal.value = lockedStop;
  expUni.uAuthority.value = 0;

  const frameMeans = [];
  /** Full render — world included — with the given viewmodel visibility. */
  const grab = (showHands, showRig) => {
    handMeshes.forEach((m) => { m.visible = showHands; });
    rigMeshes.forEach((m) => { m.visible = showRig; });
    loose.forEach((m) => { m.visible = showRig; });
    eng._frame();
    eng._frame();
    const out = new Uint8Array(N * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, out);
    let s = 0;
    for (let p = 0; p < out.length; p += 4) s += out[p + 1];
    frameMeans.push(+(s / N).toFixed(2));
    return out;
  };
  // Warm-up: let anything that converges over frames converge BEFORE the first
  // capture. Without this the eighth grab is a measurably different image from
  // the first and the pair rule measures the drift instead of the hands.
  for (let i = 0; i < 40; i++) eng._frame();

  /**
   * TWO INDEPENDENT A/B PAIRS PER MASK.
   *
   * Even paused, ~0.27% of the frame still flickers between two renders that
   * should be identical — GTAO rotates its sample kernel on a frame counter, not
   * on dt, so it does not stop when time does. That is 5 700 pixels of false
   * positive against a 31 000-pixel hand mask, and it moved the measured value
   * separation by 37%.
   *
   * Rather than reach into another agent's pass, the mask requires a pixel to
   * change in BOTH of two independently captured A/B pairs. Genuine hand pixels
   * change in both by construction; frame-counter noise decorrelates, so its
   * survival probability is 0.0027² — about fifteen pixels frame-wide.
   */
  const fAllA = grab(true, true);
  const fNoHandsA = grab(false, true);
  const fWorldA = grab(false, false);
  const fAllB = grab(true, true);
  const fNoHandsB = grab(false, true);
  const fWorldB = grab(false, false);
  const fWorldC = grab(false, false);
  const fWorldD = grab(false, false);

  handMeshes.forEach((m, i) => { m.visible = saved.hands[i]; });
  rigMeshes.forEach((m, i) => { m.visible = saved.rig[i]; });
  loose.forEach((m, i) => { m.visible = saved.loose[i]; });
  expUni.uAuthority.value = saved.authority;
  if (post) post.toggles.taa = saved.taa;
  if (grainU) grainU.value = saved.grain;
  eng.paused = saved.paused;
  eng.start();

  /** Rec.709 luma of the *displayed* bytes. See trap 2 in the header. */
  const lum = (f, p) => 0.2126 * f[p] + 0.7152 * f[p + 1] + 0.0722 * f[p + 2];
  /** Mean of the two composite captures — halves whatever jitter is left. */
  const cLum = (p) => (lum(fAllA, p) + lum(fAllB, p)) * 0.5;
  const cCh = (p, k) => (fAllA[p + k] + fAllB[p + k]) * 0.5;
  const DIFF = 24;   // same detection threshold handcheck uses
  const differs = (a, b, p) => (Math.abs(a[p] - b[p]) + Math.abs(a[p + 1] - b[p + 1])
    + Math.abs(a[p + 2] - b[p + 2])) > DIFF;

  // Raw per-frame instability, and what survives the two-pair rule. The second
  // number is the one that can contaminate a mask.
  let rawNullN = 0, nullN = 0;
  for (let i = 0, p = 0; i < N; i++, p += 4) {
    const d1 = differs(fWorldA, fWorldB, p);
    if (d1) rawNullN++;
    if (d1 && differs(fWorldC, fWorldD, p)) nullN++;
  }

  const hand = new Uint8Array(N);
  const weap = new Uint8Array(N);
  let handN = 0, weapN = 0;
  let hx0 = W, hy0 = H, hx1 = -1, hy1 = -1;
  for (let i = 0, p = 0; i < N; i++, p += 4) {
    if (differs(fAllA, fNoHandsA, p) && differs(fAllB, fNoHandsB, p)) {
      hand[i] = 1; handN++;
      const x = i % W, y = (i / W) | 0;
      if (x < hx0) hx0 = x; if (x > hx1) hx1 = x;
      if (y < hy0) hy0 = y; if (y > hy1) hy1 = y;
    } else if (differs(fNoHandsA, fWorldA, p) && differs(fNoHandsB, fWorldB, p)) {
      weap[i] = 1; weapN++;
    }
  }

  // ---- local weapon reference: weapon pixels near the hands -----------------
  /**
   * Chebyshev dilation of a mask by R, as two separable passes, so a 64 px radius
   * costs 2N instead of N*R^2.
   */
  const dilate = (src, R) => {
    const rowTmp = new Uint8Array(N);
    const out = new Uint8Array(N);
    for (let y = 0; y < H; y++) {
      const row = y * W;
      let run = -1;
      for (let x = 0; x < W; x++) {
        if (src[row + x]) run = 0; else if (run >= 0) run++;
        rowTmp[row + x] = (run >= 0 && run <= R) ? 1 : 0;
      }
      run = -1;
      for (let x = W - 1; x >= 0; x--) {
        if (src[row + x]) run = 0; else if (run >= 0) run++;
        if (run >= 0 && run <= R) rowTmp[row + x] = 1;
      }
    }
    for (let x = 0; x < W; x++) {
      let run = -1;
      for (let y = 0; y < H; y++) {
        const i = y * W + x;
        if (rowTmp[i]) run = 0; else if (run >= 0) run++;
        out[i] = (run >= 0 && run <= R) ? 1 : 0;
      }
      run = -1;
      for (let y = H - 1; y >= 0; y--) {
        const i = y * W + x;
        if (rowTmp[i]) run = 0; else if (run >= 0) run++;
        if (run >= 0 && run <= R) out[i] = 1;
      }
    }
    return out;
  };
  const near = dilate(hand, 64);

  // ---- means over the composite --------------------------------------------
  const acc = () => ({ n: 0, l: 0, r: 0, g: 0, b: 0 });
  const add = (a, p) => {
    a.n++; a.l += cLum(p);
    a.r += cCh(p, 0); a.g += cCh(p, 1); a.b += cCh(p, 2);
  };
  const hA = acc(), wA = acc(), wAllA = acc();
  for (let i = 0, p = 0; i < N; i++, p += 4) {
    if (hand[i]) add(hA, p);
    else if (weap[i]) { add(wAllA, p); if (near[i]) add(wA, p); }
  }
  // If the hands sit nowhere near the weapon the local set can be empty; fall
  // back to the whole weapon rather than dividing by zero and reporting a pass.
  const ref = wA.n > 500 ? wA : wAllA;

  const warmth = (a) => (a.n ? (a.r - a.b) / Math.max(1, a.r + a.b) : 0);

  // ---- silhouette contrast -------------------------------------------------
  // Every hand pixel with a 4-neighbour that is not hand contributes the Weber
  // contrast between the two, whatever the neighbour is: weapon, level, or sky.
  // That is the edge the viewer's contour detector is actually working on.
  /**
   * SKIP THE ANTI-ALIASED RING, OR THE NUMBER IS HALF THE TRUTH.
   *
   * The naive version of this — every hand pixel with a non-hand 4-neighbour —
   * reported 0.226 on a build whose hand-against-weapon contrast measured 0.49,
   * and claimed 40% of the silhouette was below the resolvable floor. The reason
   * is that a mask built by thresholding a difference includes the partially
   * covered edge pixels, where the framebuffer already holds a BLEND of hand and
   * background. Comparing a blend against its own neighbouring blend measures the
   * MSAA gradient, not the contrast the eye sees, and it does so over a 2-3 px
   * ring that on a hand made of eight thin fingers is most of the perimeter.
   *
   * So both samples are taken from unambiguous pixels: the near sample from a
   * pixel whose whole 2 px neighbourhood is hand, the far sample from a pixel
   * 4 px out that is outside the hand's 2 px dilation. Nothing partially covered
   * enters the statistic, and the number becomes the step a viewer's contour
   * detector is actually given.
   */
  const dil2 = dilate(hand, 2);
  const core = new Uint8Array(N);
  for (let y = 2; y < H - 2; y++) {
    for (let x = 2; x < W - 2; x++) {
      const i = y * W + x;
      if (!hand[i]) continue;
      if (hand[i - 1] && hand[i + 1] && hand[i - 2] && hand[i + 2]
        && hand[i - W] && hand[i + W] && hand[i - 2 * W] && hand[i + 2 * W]) core[i] = 1;
    }
  }

  let edgeN = 0, edgeSum = 0, edgeLo = 0;
  // Split by what the hand is silhouetted AGAINST. Without this split the mean is
  // one number with no address: a 0.28 can be a uniformly marginal outline or a
  // strong outline with one dead stretch, and those want opposite fixes.
  const vsW = { n: 0, s: 0 }, vsL = { n: 0, s: 0 };
  /**
   * 6 px, not 4. The near sample sits at least 2 px inside the silhouette (that
   * is what the core mask means) and the far sample must land clear of a 2 px dilation,
   * so the step has to exceed 2 + 2 with a pixel to spare. At 4 px every
   * candidate far sample was still inside the dilation and the metric returned
   * zero samples — which is the failure mode a metric should have when it is
   * wrong, rather than a plausible number.
   */
  const D = 6;
  for (let y = D; y < H - D; y++) {
    for (let x = D; x < W - D; x++) {
      const i = y * W + x;
      if (!core[i]) continue;
      const li = cLum(i * 4);
      for (const j of [i - D, i + D, i - D * W, i + D * W]) {
        if (dil2[j]) continue;             // still inside the transition ring
        const lj = cLum(j * 4);
        const w = Math.abs(li - lj) / Math.max(li, lj, 1);
        edgeSum += w; edgeN++;
        if (w < 0.08) edgeLo++;   // boundary the eye cannot resolve at all
        const bucket = weap[j] ? vsW : vsL;
        bucket.n++; bucket.s += w;
      }
    }
  }

  return {
    resolution: W + 'x' + H,
    lockedStop: lockedStop ? +lockedStop.toFixed(4) : null,
    frameMeans,
    rawNullPct: +((rawNullN / N) * 100).toFixed(4),
    nullDiffPx: nullN,
    nullDiffPct: +((nullN / N) * 100).toFixed(4),
    handPx: handN,
    /** GL-space (origin bottom-left), so screen y = H - y. */
    handBox: handN ? [hx0, hy0, hx1, hy1] : null,
    weaponPx: weapN,
    localWeaponPx: wA.n,
    usedGlobalRef: wA.n <= 500,
    visiblePct: +((handN / N) * 100).toFixed(3),
    handLum: +(hA.n ? hA.l / hA.n : 0).toFixed(2),
    weaponLum: +(ref.n ? ref.l / ref.n : 0).toFixed(2),
    lumRatio: +(ref.n && ref.l > 0 ? (hA.l / hA.n) / (ref.l / ref.n) : 0).toFixed(3),
    handWarmth: +warmth(hA).toFixed(4),
    weaponWarmth: +warmth(ref).toFixed(4),
    warmDelta: +(warmth(hA) - warmth(ref)).toFixed(4),
    edgeWeber: +(edgeN ? edgeSum / edgeN : 0).toFixed(4),
    edgeInvisibleShare: +(edgeN ? edgeLo / edgeN : 1).toFixed(3),
    edgeSamples: edgeN,
    edgeVsWeapon: +(vsW.n ? vsW.s / vsW.n : 0).toFixed(4),
    edgeVsWeaponN: vsW.n,
    edgeVsWorld: +(vsL.n ? vsL.s / vsL.n : 0).toFixed(4),
    edgeVsWorldN: vsL.n,
  };
})()`;

const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=d3d11', '--disable-gpu-sandbox', '--ignore-gpu-blocklist'],
});

let failed = false;
const report = {};
for (const view of want) {
  const q = VIEWS[view];
  if (!q) { console.log(`${view}: unknown view`); continue; }
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 160)));
  try {
    await page.goto(`http://127.0.0.1:5180/?freeze=1&hud=0&quality=cinematic&${q}`,
      { waitUntil: 'domcontentloaded', timeout: 300000 });
    await page.waitForFunction('window.__ready === true', null, { timeout: 300000 });
    await page.waitForTimeout(900);

    const r = await page.evaluate(PROBE);
    if (r.error) { console.log(`${view}: ${r.error}`); failed = true; await page.close(); continue; }
    report[view] = r;

    const okVis = r.visiblePct >= MIN_VISIBLE_PCT;
    const okLum = r.lumRatio >= MIN_LUM_RATIO;
    const okEdge = r.edgeWeber >= MIN_EDGE_WEBER;
    const okWarm = r.warmDelta >= MIN_WARM_DELTA;
    // A contaminated mask can only produce numbers that mean nothing, so this is
    // a hard gate rather than a warning.
    const okNull = r.nullDiffPct <= 0.02;
    if (!okVis || !okLum || !okEdge || !okWarm || !okNull || errs.length) failed = true;

    const f = (ok) => (ok ? 'PASS' : 'FAIL');
    console.log(`\n=== ${view} (${r.resolution}) ===`);
    console.log(`  ${f(okNull)}  noise floor        ${r.nullDiffPct}% after the two-pair rule `
      + `(${r.nullDiffPx} px; ${r.rawNullPct}% raw; need <= 0.02%)`);
    console.log(`  ${r.handPx} hand px in GL box ${JSON.stringify(r.handBox)}, ${r.weaponPx} weapon px `
      + `(${r.localWeaponPx} within 64 px${r.usedGlobalRef ? ' — TOO FEW, using global ref' : ''})`);
    console.log(`  ${f(okVis)}  hands visible      ${r.visiblePct}%  (need >= ${MIN_VISIBLE_PCT})`);
    console.log(`  ${f(okLum)}  value separation   ${r.lumRatio}x   `
      + `hand ${r.handLum} vs local weapon ${r.weaponLum}  (need >= ${MIN_LUM_RATIO})`);
    console.log(`  ${f(okEdge)}  silhouette Weber   ${r.edgeWeber}   `
      + `over ${r.edgeSamples} boundary samples  (need >= ${MIN_EDGE_WEBER})`);
    console.log(`        against the WEAPON ${r.edgeVsWeapon} over ${r.edgeVsWeaponN} px; `
      + `against the WORLD ${r.edgeVsWorld} over ${r.edgeVsWorldN} px`);
    console.log(`        ${r.edgeInvisibleShare} of the silhouette is below the 0.08 resolvable floor`);
    console.log(`  ${f(okWarm)}  hue separation     ${r.warmDelta}   `
      + `hand warmth ${r.handWarmth} vs weapon ${r.weaponWarmth}  (need >= ${MIN_WARM_DELTA})`);
    if (errs.length) console.log(`  FAIL  ${errs.length} page error(s): ${errs[0]}`);
    if (!okLum) console.log('  -> the hands are the same VALUE as the gun. They will be read as gun.');
    if (!okWarm) console.log('  -> the hands are the same COLOUR as the gun, so no key light can separate them.');
  } catch (err) {
    console.log(`${view}: ${String(err.message).slice(0, 140)}`);
    failed = true;
  }
  await page.close();
}

await browser.close();
const jsonPath = opt('json', null);
if (jsonPath) writeFileSync(jsonPath, JSON.stringify(report, null, 2));
console.log(`\n${failed ? 'FAIL' : 'PASS'} — hands are ${failed ? 'NOT legible against the weapon' : 'legible against the weapon'}`);
process.exitCode = failed ? 1 : 0;
