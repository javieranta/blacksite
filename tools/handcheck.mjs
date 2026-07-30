#!/usr/bin/env node
/**
 * Pixel-level assertion that the first-person hands are actually on screen.
 *
 * WHY THIS EXISTS. Three consecutive rounds "fixed" the missing hands and three
 * consecutive reviews found the rifle still floating with nothing gripping it.
 * One of those rounds verified, correctly, that the hand geometry existed, had
 * 4808 triangles, carried the right materials, was `visible === true` and
 * projected to pixel (1166, 908) — and the hands were still not in the picture,
 * because the fingers were 18 mm clear of the grip in empty air and the support
 * hand was buried inside the handguard rail.
 *
 * Every one of those checks was about the scene graph. None of them was about
 * the image. So this harness asserts on the image: it isolates the hand meshes,
 * renders them alone, and counts the pixels they actually cover.
 *
 * It reports three numbers per view:
 *   handsPct   share of frame the hands cover when rendered alone
 *   weaponPct  same for the weapon, as a control — if this is also 0 the
 *              isolation itself is broken rather than the hands being absent
 *   gripOverlap share of the hands' pixels that fall inside the weapon's
 *              silhouette. Hands floating in space next to the gun score a high
 *              handsPct and a near-zero overlap, which is exactly the failure
 *              mode that shipped twice.
 *
 * Usage: node tools/handcheck.mjs [--views viewmodel-hip,viewmodel-ads]
 * Exits non-zero if any view fails the thresholds.
 */
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };

const VIEWS = {
  'viewmodel-hip': 'tod=golden&pos=6,1.7,14&yaw=200&pitch=-0.02&vm=1',
  'viewmodel-ads': 'tod=golden&pos=6,1.7,14&yaw=200&pitch=-0.02&vm=1&ads=1',
};
const want = (opt('views', 'viewmodel-hip,viewmodel-ads')).split(',').map((s) => s.trim());

/** Hands must cover at least this share of frame, and mostly sit on the weapon. */
const MIN_HANDS_PCT = 0.8;
const MIN_GRIP_OVERLAP = 0.25;
/** Hand pixels that survive into the composite — the metric that matters. */
const MIN_VISIBLE_PCT = 0.6;

/**
 * Renders three isolations and returns pixel coverage for each.
 *
 * Isolation works by walking the two scenes and toggling `visible`, then driving
 * one frame by hand. The engine's own rAF loop is stopped first: in headless
 * Chromium it is paced by a virtual clock and would otherwise queue a normal
 * frame over the isolated one before readPixels sampled it.
 */
const PROBE = `(() => {
  const eng = window.__blacksite.engine;
  const vm = eng.systems.get('viewmodel');
  if (!vm) return { error: 'no viewmodel system' };
  if (!vm.hands || !vm.rig) return { error: 'viewmodel exposes no .hands/.rig handles' };

  const gl = eng.renderer.getContext();
  const W = eng.renderer.domElement.width;
  const H = eng.renderer.domElement.height;
  const buf = new Uint8Array(W * H * 4);

  const handMeshes = vm.hands.meshes || [];
  const rigMeshes = vm.rig.meshes || [];

  // Save state we are about to trample.
  const saved = {
    sceneVisible: eng.scene.visible,
    background: eng.scene.background,
    hands: handMeshes.map((m) => m.visible),
    rig: rigMeshes.map((m) => m.visible),
  };

  eng.stop();

  /**
   * Grab the raw framebuffer with the given visibility.
   *
   * An absolute "brighter than black" test does not work here: even with the
   * world hidden, the post chain's grade lift, film grain and vignette put every
   * pixel above zero, so a naive threshold reported 63% coverage and a
   * full-frame bounding box for BOTH hands and weapon. Coverage is therefore
   * measured as a DIFFERENCE against a baseline frame with nothing visible,
   * which cancels any constant floor the chain adds.
   */
  const grab = (showHands, showRig) => {
    eng.scene.visible = false;          // hide the world
    eng.scene.background = null;        // and the sky fill
    handMeshes.forEach((m) => { m.visible = showHands; });
    rigMeshes.forEach((m) => { m.visible = showRig; });
    eng._frame();
    const out = new Uint8Array(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, out);
    return out;
  };

  const baseline = grab(false, false);

  /** Mask of pixels that differ from the empty baseline. */
  const maskOf = (frame) => {
    const mask = new Uint8Array(W * H);
    let count = 0, minX = W, maxX = -1, minY = H, maxY = -1;
    for (let i = 0, p = 0; i < mask.length; i++, p += 4) {
      const d = Math.abs(frame[p] - baseline[p])
        + Math.abs(frame[p + 1] - baseline[p + 1])
        + Math.abs(frame[p + 2] - baseline[p + 2]);
      if (d > 24) {
        mask[i] = 1; count++;
        const x = i % W, y = (i / W) | 0;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
    return { mask, count, box: count ? [minX, minY, maxX, maxY] : null };
  };

  const handsOnly = maskOf(grab(true, false));
  const weaponOnly = maskOf(grab(false, true));

  /**
   * THE METRIC THAT ACTUALLY MATTERS.
   *
   * Isolated coverage only proves the hands rasterise somewhere. It does not
   * prove the player can SEE them: hands drawn behind the receiver, or buried
   * inside the handguard, occupy pixels in isolation and contribute nothing to
   * the composite. That is precisely how two rebuilds passed their authors'
   * checks and failed the review.
   *
   * So diff the real composite (hands + weapon) against weapon-only. Whatever
   * changes is hand actually visible to the player.
   */
  const bothFrame = grab(true, true);
  const weaponFrame = grab(false, true);
  let visible = 0, vMinX = W, vMaxX = -1, vMinY = H, vMaxY = -1;
  for (let i = 0, p = 0; i < W * H; i++, p += 4) {
    const d = Math.abs(bothFrame[p] - weaponFrame[p])
      + Math.abs(bothFrame[p + 1] - weaponFrame[p + 1])
      + Math.abs(bothFrame[p + 2] - weaponFrame[p + 2]);
    if (d > 24) {
      visible++;
      const x = i % W, y = (i / W) | 0;
      if (x < vMinX) vMinX = x; if (x > vMaxX) vMaxX = x;
      if (y < vMinY) vMinY = y; if (y > vMaxY) vMaxY = y;
    }
  }

  // How much of the hands lands on the weapon's silhouette. Low overlap with a
  // healthy handsPct means hands rendering somewhere other than on the grip.
  let overlap = 0;
  for (let i = 0; i < handsOnly.mask.length; i++) {
    if (handsOnly.mask[i] && weaponOnly.mask[i]) overlap++;
  }

  // Restore.
  eng.scene.visible = saved.sceneVisible;
  eng.scene.background = saved.background;
  handMeshes.forEach((m, i) => { m.visible = saved.hands[i]; });
  rigMeshes.forEach((m, i) => { m.visible = saved.rig[i]; });
  eng.start();

  const total = W * H;
  return {
    resolution: W + 'x' + H,
    handMeshCount: handMeshes.length,
    rigMeshCount: rigMeshes.length,
    handTriangles: vm.hands.triangles ?? null,
    handsPct: +((handsOnly.count / total) * 100).toFixed(3),
    weaponPct: +((weaponOnly.count / total) * 100).toFixed(3),
    handsBox: handsOnly.box,
    weaponBox: weaponOnly.box,
    gripOverlap: handsOnly.count ? +(overlap / handsOnly.count).toFixed(3) : 0,
    visiblePct: +((visible / total) * 100).toFixed(3),
    visibleBox: visible ? [vMinX, vMinY, vMaxX, vMaxY] : null,
    occludedShare: handsOnly.count ? +(1 - visible / handsOnly.count).toFixed(3) : 1,
  };
})()`;

const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=d3d11', '--disable-gpu-sandbox', '--ignore-gpu-blocklist'],
});

let failed = false;
for (const view of want) {
  const q = VIEWS[view];
  if (!q) { console.log(`${view}: unknown view`); continue; }
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  try {
    await page.goto(`http://127.0.0.1:5180/?freeze=1&hud=0&quality=cinematic&${q}`,
      { waitUntil: 'domcontentloaded', timeout: 300000 });
    await page.waitForFunction('window.__ready === true', null, { timeout: 300000 });
    await page.waitForTimeout(900);

    const r = await page.evaluate(PROBE);
    if (r.error) { console.log(`${view}: ${r.error}`); failed = true; await page.close(); continue; }

    const okCtl = r.weaponPct > 0.1;
    const okHands = r.handsPct >= MIN_HANDS_PCT;
    const okVisible = r.visiblePct >= MIN_VISIBLE_PCT;
    if (!okHands || !okVisible || !okCtl) failed = true;

    console.log(`\n=== ${view} (${r.resolution}) ===`);
    console.log(`  hand meshes ${r.handMeshCount}, ${r.handTriangles} tris; weapon meshes ${r.rigMeshCount}`);
    console.log(`  ${okCtl ? 'ok  ' : 'FAIL'} weapon coverage    ${r.weaponPct}%  box ${JSON.stringify(r.weaponBox)}   (control)`);
    console.log(`  ${okHands ? 'ok  ' : 'FAIL'} hands rasterise    ${r.handsPct}%  box ${JSON.stringify(r.handsBox)}   (isolated)`);
    console.log(`  ${okVisible ? 'PASS' : 'FAIL'} hands VISIBLE      ${r.visiblePct}%  box ${JSON.stringify(r.visibleBox)}   (need >= ${MIN_VISIBLE_PCT}% in the composite)`);
    console.log(`       occluded share ${r.occludedShare} of hand pixels hidden behind the weapon`);
    if (!okCtl) console.log('  -> the isolation itself is broken; every number below it is meaningless');
    else if (!okHands) console.log('  -> hands do not rasterise at all');
    else if (!okVisible) console.log('  -> hands rasterise but are OCCLUDED — drawn behind or inside the weapon.'
      + ' This is why two "rebuilds" passed their authors\' checks and failed review.');
  } catch (err) {
    console.log(`${view}: ${String(err.message).slice(0, 140)}`);
    failed = true;
  }
  await page.close();
}

await browser.close();
console.log(`\n${failed ? 'FAIL' : 'PASS'} — hands ${failed ? 'are NOT correctly on screen' : 'are on screen and on the weapon'}`);
process.exitCode = failed ? 1 : 0;
