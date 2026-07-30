#!/usr/bin/env node
/**
 * GROUNDCHECK — how much AUTHORED content is on the floor, measured by ablation.
 *
 * WHY THIS EXISTS
 *   "Featureless expanses" has been raised in three reviews. Each time the props
 *   agent added another ground pass and each time the console reported hundreds of
 *   new marks, and the reviewer kept saying the floor is bare. Round 9's review
 *   made the disagreement precise:
 *
 *     "combat and hud floors carry speckle noise, joint lines and four props over
 *      roughly 100 square metres with no decals, cracks, stains, puddles or
 *      litter... Measured 32-px block variance of 10-33 comes from normal maps
 *      and shadow stripes, not authored content."
 *
 *   Both sides were right. The passes ran; the passes were invisible. A count of
 *   quads placed cannot tell those apart, and that is the entire problem: the
 *   props system's own instrument measures INTENT, and the reviewer measures the
 *   IMAGE.
 *
 * WHAT IT MEASURES
 *   Block variance alone cannot attribute anything — a normal map and a shadow
 *   stripe raise it just as well as an oil stain. So this ABLATES: it renders the
 *   floor with the authored ground content, hides exactly that content, renders
 *   again, and diffs.
 *
 *     coverage%   share of floor pixels the authored content actually changes
 *     meanDelta   how far it moves them, in 0-255 luminance
 *     blockStd    the reviewer's own number, before and after ablation, so the
 *                 share of it that is authored rather than texture is explicit
 *
 *   A pass that places 500 quads and moves 3% of floor pixels by 1.5/255 is doing
 *   nothing, and this is the number that says so.
 *
 * THE FLOOR REGION is the lower band of the frame, stated rather than detected:
 * with vm=0 and these two framings it is floor, and a detected region would be
 * one more thing that can be quietly wrong.
 *
 * Usage: node tools/groundcheck.mjs [--views combat,hud] [--json out.json]
 * Exits non-zero when authored coverage or strength is below the gate.
 */
import fs from 'node:fs';
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };

/** The two framings the review called out, plus the establishing shot. */
const VIEWS = {
  combat: 'tod=golden&pos=4,1.7,6&yaw=195&pitch=-0.02',
  hud: 'tod=golden&pos=4,1.7,6&yaw=195&pitch=-0.02',
  'hero-golden': 'tod=golden&pos=6,1.7,14&yaw=200&pitch=-0.04',
};
const want = opt('views', 'combat,hero-golden').split(',').map((s) => s.trim());

/** Gates. Authored content has to be present AND strong enough to read. */
const MIN_COVERAGE = 18;      // % of floor pixels moved by the authored content
const MIN_DELTA = 6;          // mean luminance shift over those pixels, 0-255

/**
 * Names of the meshes that carry authored ground content.
 *
 * `prop:decal` is the merged decal batch — every stain, crack, puddle ring, tyre
 * track, wash and contact patch. The grit/chip/rubble/litter prototypes are the
 * three-dimensional half of the same job. Everything else in the scene stays
 * exactly as it was, so the diff can only be the authored content.
 */
const PROBE = `(band) => {
  const eng = window.__blacksite.engine;
  const gl = eng.renderer.getContext();
  const W = eng.renderer.domElement.width, H = eng.renderer.domElement.height;
  const GROUND = /^prop:(decal|wet|grit|chip|brickbit|drift|rubble|litter|leaf|paper|shard|gravel|puddle)/i;

  const targets = [];
  eng.scene.traverse((n) => { if ((n.isMesh || n.isInstancedMesh) && GROUND.test(n.name || '')) targets.push(n); });
  const saved = targets.map((m) => m.visible);

  eng.stop();
  const grab = () => {
    eng._frame();
    const out = new Uint8Array(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, out);
    return out;
  };
  const withIt = grab();
  targets.forEach((m) => { m.visible = false; });
  const without = grab();
  targets.forEach((m, i) => { m.visible = saved[i]; });
  eng.start();

  // readPixels is bottom-up, so the on-screen lower band is the LOW y rows here.
  const y0 = Math.floor(H * band[0]), y1 = Math.floor(H * band[1]);
  const x0 = Math.floor(W * 0.05), x1 = Math.floor(W * 0.95);
  const lum = (b, i) => 0.2126 * b[i] + 0.7152 * b[i + 1] + 0.0722 * b[i + 2];

  let n = 0, moved = 0, sum = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * W + x) * 4;
      n++;
      const d = Math.abs(lum(withIt, i) - lum(without, i));
      if (d > 2) { moved++; sum += d; }
    }
  }

  /** Mean per-block standard deviation of luminance over 32 px blocks. */
  const blockStd = (buf) => {
    let acc = 0, blocks = 0;
    for (let by = y0; by + 32 <= y1; by += 32) {
      for (let bx = x0; bx + 32 <= x1; bx += 32) {
        let s = 0, s2 = 0;
        for (let y = by; y < by + 32; y++) {
          for (let x = bx; x < bx + 32; x++) {
            const v = lum(buf, (y * W + x) * 4);
            s += v; s2 += v * v;
          }
        }
        const m = s / 1024;
        acc += Math.sqrt(Math.max(0, s2 / 1024 - m * m));
        blocks++;
      }
    }
    return blocks ? acc / blocks : 0;
  };

  return {
    resolution: W + 'x' + H,
    meshes: targets.length,
    pixels: n,
    coverage: +((moved / Math.max(1, n)) * 100).toFixed(2),
    meanDelta: +(sum / Math.max(1, moved)).toFixed(2),
    blockStdWith: +blockStd(withIt).toFixed(2),
    blockStdWithout: +blockStd(without).toFixed(2),
  };
}`;

const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=d3d11', '--disable-gpu-sandbox', '--ignore-gpu-blocklist'],
});

let failed = false;
const out = {};
for (const view of want) {
  const q = VIEWS[view];
  if (!q) { console.log(`${view}: unknown view`); continue; }
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  try {
    await page.goto(`http://127.0.0.1:5180/?freeze=1&hud=0&vm=0&quality=cinematic&${q}`,
      { waitUntil: 'domcontentloaded', timeout: 600000 });
    await page.waitForFunction('window.__ready === true', null, { timeout: 600000 });
    await page.waitForTimeout(900);
    const r = await page.evaluate(`(${PROBE})([0.02, 0.45])`);
    out[view] = r;
    const okCov = r.coverage >= MIN_COVERAGE;
    const okDelta = r.meanDelta >= MIN_DELTA;
    if (!okCov || !okDelta) failed = true;
    console.log(`\n=== ${view} (${r.resolution}) — floor band, ${r.meshes} ground meshes ablated ===`);
    console.log(`  ${okCov ? 'PASS' : 'FAIL'} authored coverage  ${r.coverage}%  of `
      + `${r.pixels.toLocaleString()} floor px  (need >= ${MIN_COVERAGE}%)`);
    console.log(`  ${okDelta ? 'PASS' : 'FAIL'} authored strength  ${r.meanDelta} /255 mean shift `
      + `where it lands  (need >= ${MIN_DELTA})`);
    console.log(`       32-px block variance ${r.blockStdWith} with the content, `
      + `${r.blockStdWithout} without — ${(r.blockStdWith - r.blockStdWithout).toFixed(2)} of it is authored`);
    if (!okCov) console.log('  -> the passes are placing marks somewhere the camera is not looking');
    else if (!okDelta) console.log('  -> the marks are there and too weak to read: alpha, not count');
  } catch (err) {
    console.log(`${view}: ${String(err.message).slice(0, 160)}`);
    failed = true;
  }
  await page.close();
}
await browser.close();

const jsonOut = opt('json', null);
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(out, null, 1));
console.log(`\n${failed ? 'FAIL' : 'PASS'} — the floor ${failed
  ? 'does not carry enough authored content to read as anything but a slab'
  : 'carries authored content that measurably changes the image'}`);
process.exitCode = failed ? 1 : 0;
