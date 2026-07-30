#!/usr/bin/env node
/**
 * BRASSCHECK — the spent-case assertion. Owner: fx agent (tag fx11).
 *
 * ── why this file exists rather than another pass over tools/fxcheck.mjs ──────
 * Three consecutive reviews reported "metre-long shell casings hanging 25-40 m
 * downrange", and three consecutive rounds of casing work did not move the
 * picture. The reason is that every one of those reports derived a PHYSICAL size
 * from an ANGULAR size times an ASSUMED depth — the depth of whatever the case
 * happened to be drawn against. That inference is only valid if the case really
 * is at the backdrop's depth, and it never was.
 *
 * So this harness refuses to infer anything. It reads the simulation arrays
 * directly out of `ParticleBatch` — the only place a batched particle's world
 * position exists, since the instances are not scene-graph nodes — and prints,
 * for every live casing:
 *
 *     world position · distance from the camera · distance from the muzzle
 *     · world-space quad size · camera-space height relative to the eye plane
 *     · what is behind it, and the size it would be misread as against that.
 *
 * Only after those numbers exist is a verdict about (a) "the cases really are
 * downrange and really are huge" versus (b) "the cases are 5 cm at arm's length
 * and are merely SILHOUETTED against something 25 m away" possible at all.
 *
 * It also enumerates every OTHER system capable of putting brass on screen, so a
 * PASS here can never again mean "the casings I own are fine" while a different
 * pool throws the ones the reviewer is actually looking at. That is the exact
 * failure mode of the previous three rounds: `ViewModel` kept its own pool of
 * eight brass MESHES parented to the viewmodel camera with `frustumCulled=false`,
 * which drew on top of the world with no shared depth buffer. The particle
 * billboards were measured, found correct, and reported PASS, while the meshes
 * — a different system, a different file — were what every review was seeing.
 *
 * ── the assertions ───────────────────────────────────────────────────────────
 *   NEAR   every live casing is within MAX_MUZZLE_DIST of the muzzle
 *   SIZE   every live casing's world-space quad is under MAX_SIZE metres
 *   EYE    no casing sample sits above the eye plane (above it the backdrop is
 *          the skyline, and that is where the misreading is manufactured)
 *   SOLE   no second system is drawing spent cases
 *
 * Usage: node tools/brasscheck.mjs [--json] [--samples 40] [--dump]
 */
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const has = (n) => args.includes('--' + n);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const SAMPLES = parseInt(opt('samples', '40'), 10);

/** A case that has left the port travels ~4 m/s for 1.7 s against heavy drag. */
const MAX_MUZZLE_DIST = 4.0;
/** A 5.56x45 is 44.7 mm long; the sprite fills 88% of a 51 mm quad. */
const MAX_SIZE = 0.06;
/** Above the eye plane the backdrop becomes the skyline. Must never happen. */
const MAX_ABOVE_EYE = 0;
/** More than this in the air at once reads as a dispenser rather than a rifle. */
const MAX_LIVE = 14;
/**
 * Median nearest-neighbour spacing among cases at rest. Brass that has come to
 * rest in a heap is the visible signature of a launch velocity whose randomness
 * was clamped away — see the note on the floors in `Particles._shapeEject`.
 */
const MIN_REST_SPACING = 0.15;

const CASING_TILE = 7;   // SPRITE.CASING

const PROBE = `(async () => {
  const eng = window.__blacksite.engine;
  const P = eng.systems.get('particles');
  if (!P) return { error: 'no particles system' };
  const cam = eng.camera;
  const lvl = eng.systems.get('level');
  const vm = eng.systems.get('viewmodel');
  const H = eng.renderer.domElement.height;
  const proj11 = cam.projectionMatrix.elements[5];
  const pe0 = cam.projectionMatrix.elements[0];

  const V3 = cam.position.constructor;
  const tmp = new V3();
  const dir = new V3();

  const rows = [];
  const w = {
    samples: 0, seen: 0, liveMax: 0, onScreenMax: 0,
    maxMuzzle: 0, maxSize: 0, maxCam: 0, aboveEye: 0, maxCamY: -1e9,
    maxApparent: 0, apparentBackdrop: 0, minDepth: 1e9, maxPx: 0, sky: 0,
    restSamples: 0, restMedianSum: 0, restMaxCount: 0, restMinNN: 1e9,
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  for (let k = 0; k < ${SAMPLES}; k++) {
    const b = P.alpha;
    let live = 0;
    let on = 0;
    // The muzzle the system itself last computed — the honest reference point,
    // rather than a re-derivation that could drift from what spawned the case.
    const mz = P._muzzle;
    const m = cam.matrixWorld.elements;
    for (let i = 0; i < b.count; i++) {
      if (b.aP[i * 4] !== ${CASING_TILE}) continue;
      live++;
      const i3 = i * 3;
      const x = b.aPos[i3]; const y = b.aPos[i3 + 1]; const z = b.aPos[i3 + 2];

      // The quad edge the vertex shader will actually build: a quadratic Bezier
      // over the 3-key size curve at the particle's normalised age.
      const t = Math.min(1, Math.max(0, b.aT[i]));
      const o = 1 - t;
      const size = b.aSize[i3] * o * o + b.aSize[i3 + 1] * 2 * o * t + b.aSize[i3 + 2] * t * t;

      const dxc = x - cam.position.x;
      const dyc = y - cam.position.y;
      const dzc = z - cam.position.z;
      const distCam = Math.hypot(dxc, dyc, dzc);
      const distMuz = Math.hypot(x - mz.x, y - mz.y, z - mz.z);
      // Height above the eye PLANE, in the camera's own up axis.
      const camY = dxc * m[4] + dyc * m[5] + dzc * m[6];
      // View depth: -(camera-space z); column 2 of matrixWorld is BEHIND.
      const depth = -(dxc * -m[8] + dyc * -m[9] + dzc * -m[10]) * -1;

      if (distMuz > w.maxMuzzle) w.maxMuzzle = distMuz;
      if (size > w.maxSize) w.maxSize = size;
      if (distCam > w.maxCam) w.maxCam = distCam;
      if (camY > w.maxCamY) w.maxCamY = camY;
      if (camY > 0) w.aboveEye++;
      w.seen++;

      let px = 0;
      let ndcX = 9; let ndcY = 9;
      if (depth > 0.02) {
        px = size * proj11 / depth * (H / 2);
        const camX = dxc * m[0] + dyc * m[1] + dzc * m[2];
        ndcX = camX * pe0 / depth;
        ndcY = camY * proj11 / depth;
        if (depth < w.minDepth) w.minDepth = depth;
        if (px > w.maxPx) w.maxPx = px;
      }
      const onScreen = Math.abs(ndcX) <= 1.02 && Math.abs(ndcY) <= 1.02 && depth > 0.02;
      if (onScreen) on++;

      // What a viewer would read the case AGAINST. This is the whole of the
      // reviewers' inference, reproduced honestly so it can be compared with the
      // real geometry sitting next to it in the same row.
      let backdrop = null;
      if (onScreen && lvl?.raycast) {
        dir.set(dxc, dyc, dzc).normalize();
        const hit = lvl.raycast(cam.position, dir, 400);
        if (hit) backdrop = cam.position.distanceTo(hit.point);
      }
      if (onScreen && backdrop === null) w.sky++;
      const bd = backdrop === null ? 120 : backdrop;
      const apparent = onScreen ? px / (proj11 * H / 2) * bd : 0;
      if (apparent > w.maxApparent) { w.maxApparent = apparent; w.apparentBackdrop = bd; }

      if (rows.length < 240) {
        rows.push({
          s: k,
          pos: [+x.toFixed(3), +y.toFixed(3), +z.toFixed(3)],
          distCam: +distCam.toFixed(3),
          distMuzzle: +distMuz.toFixed(3),
          sizeM: +size.toFixed(4),
          camY: +camY.toFixed(3),
          depth: +depth.toFixed(3),
          px: +px.toFixed(1),
          onScreen,
          backdrop: backdrop === null ? null : +backdrop.toFixed(1),
          apparentM: +apparent.toFixed(3),
        });
      }
    }
    if (live > w.liveMax) w.liveMax = live;
    if (on > w.onScreenMax) w.onScreenMax = on;
    w.samples++;

    // Nearest-neighbour spacing among cases that have COME TO REST. The settle
    // branch in ParticleBatch.simulate zeroes gravity when a bouncing particle
    // stops, so grav === 0 identifies exactly the population lying on the
    // concrete. Spacing is the tell for whether the launch velocity still has any
    // variance left in it after the floors and clamps have had their say: three
    // cases inside 3 cm is not a scatter, it is one trajectory drawn N times.
    {
      const rest = [];
      for (let i = 0; i < b.count; i++) {
        if (b.aP[i * 4] !== ${CASING_TILE} || b.grav[i] !== 0) continue;
        rest.push(b.aPos[i * 3], b.aPos[i * 3 + 1], b.aPos[i * 3 + 2]);
      }
      const n = rest.length / 3;
      if (n >= 3) {
        const nn = [];
        for (let i = 0; i < n; i++) {
          let best = 1e9;
          for (let j = 0; j < n; j++) {
            if (i === j) continue;
            const d = Math.hypot(rest[i * 3] - rest[j * 3], rest[i * 3 + 1] - rest[j * 3 + 1],
              rest[i * 3 + 2] - rest[j * 3 + 2]);
            if (d < best) best = d;
          }
          nn.push(best);
        }
        nn.sort((p, q) => p - q);
        w.restSamples++;
        w.restMedianSum += nn[nn.length >> 1];
        w.restMaxCount = Math.max(w.restMaxCount, n);
        if (nn[0] < w.restMinNN) w.restMinNN = nn[0];
      }
    }
    await wait(55);
  }

  // Any OTHER pool that can put brass on screen. A PASS above is worthless if a
  // second system is throwing the cases the reviewer is looking at.
  const others = [];
  if (vm) {
    for (const k of Object.keys(vm)) {
      if (/shell|brass|case/i.test(k) && vm[k]) others.push('viewmodel.' + k);
    }
  }
  let sceneBrass = 0;
  eng.scene.traverse((n) => { if (/shell|brass|casing/i.test(n.name ?? '')) sceneBrass++; });
  eng.viewScene.traverse((n) => { if (/shell|brass|casing/i.test(n.name ?? '')) sceneBrass++; });

  return {
    resolution: eng.renderer.domElement.width + 'x' + H,
    samples: w.samples,
    observations: w.seen,
    liveMax: w.liveMax,
    onScreenMax: w.onScreenMax,
    maxMuzzleDistM: +w.maxMuzzle.toFixed(3),
    maxCameraDistM: +w.maxCam.toFixed(3),
    maxSizeM: +w.maxSize.toFixed(4),
    maxCamY: w.maxCamY === -1e9 ? null : +w.maxCamY.toFixed(3),
    aboveEyeSamples: w.aboveEye,
    minDepthM: w.minDepth === 1e9 ? null : +w.minDepth.toFixed(3),
    maxPx: +w.maxPx.toFixed(1),
    apparentM: +w.maxApparent.toFixed(3),
    apparentBackdropM: +w.apparentBackdrop.toFixed(1),
    skySamples: w.sky,
    restMaxCount: w.restMaxCount,
    restMedianNN: w.restSamples ? +(w.restMedianSum / w.restSamples).toFixed(3) : null,
    restMinNN: w.restMinNN === 1e9 ? null : +w.restMinNN.toFixed(3),
    otherBrassSystems: others,
    sceneBrassNodes: sceneBrass,
    rows,
  };
})()`;

const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=d3d11', '--disable-gpu-sandbox', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

// The `combat` view exactly: this is the framing the reviews measured.
await page.goto('http://127.0.0.1:5180/?freeze=1&hud=0&quality=cinematic&tod=golden'
  + '&pos=4,1.7,6&yaw=195&pitch=-0.02&vm=1&fire=1',
{ waitUntil: 'domcontentloaded', timeout: 300000 });
await page.waitForFunction('window.__ready === true', null, { timeout: 300000 });
await page.waitForTimeout(1500);

const r = await page.evaluate(PROBE);
await browser.close();

if (r.error) { console.error(r.error); process.exit(2); }

if (has('json')) { console.log(JSON.stringify(r, null, 2)); process.exit(0); }

const okNear = r.maxMuzzleDistM <= MAX_MUZZLE_DIST;
const okSize = r.maxSizeM <= MAX_SIZE;
const okEye = r.aboveEyeSamples <= MAX_ABOVE_EYE;
const okLive = r.liveMax <= MAX_LIVE;
const okSole = r.otherBrassSystems.length === 0 && r.sceneBrassNodes === 0;
const okRest = r.restMedianNN === null || r.restMedianNN >= MIN_REST_SPACING;
const okAny = r.observations > 0;

const line = (ok, label, val, note) =>
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${String(label).padEnd(34)} ${String(val).padStart(10)}   ${note}`);

console.log('\n=== BRASSCHECK — live spent cases, read out of the batch pool ===');
console.log(`  ${r.resolution}, ${r.samples} samples over ~${(r.samples * 0.055).toFixed(1)}s,`
  + ` ${r.observations} casing observations, ${r.liveMax} live at peak.`);
line(okAny, 'casings observed at all', r.observations, '(control — 0 means nothing was measured)');
line(okNear, 'max distance from the muzzle', r.maxMuzzleDistM + 'm', `need <= ${MAX_MUZZLE_DIST}m`);
line(okSize, 'max world-space quad size', r.maxSizeM + 'm', `need <= ${MAX_SIZE}m (5.56 case = 0.0447m)`);
line(okEye, 'samples above the eye plane', r.aboveEyeSamples, `need <= ${MAX_ABOVE_EYE} (max camY ${r.maxCamY}m)`);
line(okLive, 'live at once', r.liveMax, `need <= ${MAX_LIVE}`);
line(okRest, 'settled brass is scattered', (r.restMedianNN ?? 'n/a') + 'm',
  `median nearest neighbour, need >= ${MIN_REST_SPACING}m (${r.restMaxCount} at rest, min ${r.restMinNN ?? 'n/a'}m)`);
line(okSole, 'no second brass system', `${r.otherBrassSystems.length}/${r.sceneBrassNodes}`,
  r.otherBrassSystems.length ? r.otherBrassSystems.join(',') : 'viewmodel props / scene nodes');

console.log('\n  --- what a viewer would MISREAD, for comparison ---');
console.log(`  nearest casing sits ${r.minDepthM}m from the lens and covers ${r.maxPx}px.`);
console.log(`  largest on-screen case is drawn against a backdrop ${r.apparentBackdropM}m away,`);
console.log(`  so an observer who assumes the backdrop's depth reads it as ${r.apparentM}m long.`);
console.log(`  ${r.skySamples} sample(s) had open sky behind them (unbounded misread).`);

if (has('dump')) {
  console.log('\n  --- per-casing rows (first 40) ---');
  console.log('   s  pos                      dCam   dMuzz   sizeM   camY   depth    px  back  apparent');
  for (const q of r.rows.slice(0, 40)) {
    console.log(`  ${String(q.s).padStart(2)}  [${q.pos.map((v) => String(v).padStart(7)).join(',')}]`
      + ` ${String(q.distCam).padStart(6)} ${String(q.distMuzzle).padStart(7)}`
      + ` ${String(q.sizeM).padStart(7)} ${String(q.camY).padStart(6)}`
      + ` ${String(q.depth).padStart(7)} ${String(q.px).padStart(5)}`
      + ` ${String(q.backdrop ?? 'sky').padStart(5)} ${String(q.apparentM).padStart(8)}`);
  }
}

if (errors.length) console.log(`\n  ${errors.length} page error(s): ${errors[0]?.slice(0, 160)}`);

const failed = !(okNear && okSize && okEye && okLive && okSole && okAny && okRest);
if (failed) {
  console.log('\n  A failure here is NOT automatically a size bug. Read the rows:');
  console.log('   · dMuzz large + sizeM correct  -> the case is genuinely flying too far.');
  console.log('   · dMuzz small + camY positive  -> the case is at arm\'s length but above the');
  console.log('     eye plane, so its backdrop is the skyline and the apparent size is a');
  console.log('     misread. Fix the ARC, not the scale.');
  console.log('   · a non-empty second brass system -> fix that one first; it is the one on screen.');
}
console.log(`\n${failed ? 'FAIL' : 'PASS'} — brasscheck`);
process.exitCode = failed ? 1 : 0;
