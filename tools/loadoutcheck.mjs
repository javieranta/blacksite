#!/usr/bin/env node
/**
 * Pixel-level assertion that the three weapons in the loadout are three
 * DIFFERENT OBJECTS on screen.
 *
 * ─── WHY THIS EXISTS ───────────────────────────────────────────────────────
 *
 * `WeaponData.js` has carried three weapons since round 5, `WeaponSystem` has
 * switched between them on keys 1/2/3 since then, and every check anyone ran on
 * that feature was a check on the DATA: current.id changes, the ammo counter
 * changes, the RPM changes, the recoil pattern changes. All of it passed. The
 * player's report was still "there is no alternative gun", because
 * `ViewModel.init` called `buildWeapon()` exactly once and the `weapon:switch`
 * handler was `() => { this._reloadT = 0; }`. Three weapons, one silhouette.
 *
 * Every one of those data checks was about the scene graph and the state object.
 * None of them was about the image. So this harness asserts on the IMAGE: it
 * isolates the weapon meshes for each slot in turn, renders them alone against a
 * hidden world, and compares the silhouettes.
 *
 * ─── WHAT IT MEASURES, AND WHY THESE NUMBERS ──────────────────────────────
 *
 *   areaPct    share of frame the weapon covers, rendered alone. This is the
 *              number the player means by "smaller". It is not the same as
 *              overall length: most of a viewmodel's screen area is the receiver
 *              and magazine near the eye, so a 200 mm barrel that points away
 *              from the camera contributes very little and a 3 mm fatter eyecup
 *              contributes a lot.
 *   aspect     bounding-box width / height. A folded stock and a 130 mm barrel
 *              move this in opposite directions, so it catches "different length"
 *              even where two weapons happen to cover the same area.
 *   IoU        intersection-over-union of the two silhouettes on a 192 x 108
 *              grid. This is the assertion that cannot be passed by scaling one
 *              weapon: two builds of the same mesh score 1.000, and nothing else
 *              does. It is measured on a coarse grid on purpose — a full-res IoU
 *              would fail on antialiasing noise and would have to be given a
 *              threshold so loose it stopped meaning anything.
 *
 * ─── PROVING THE INSTRUMENT ───────────────────────────────────────────────
 *
 * `--legacy` reproduces the pre-fix code path exactly: it calls
 * `WeaponSystem._applySlot(i)` directly, which changes every piece of weapon DATA
 * without emitting `weapon:switch`, so the viewmodel never rebuilds — which is
 * what the shipped build did. Run it that way and every pair scores IoU 1.000 and
 * an area ratio of 1.000, and the tool exits non-zero. That is the failing run
 * this assertion was written against; without it, "the silhouettes differ" is an
 * opinion with a number stapled to it.
 *
 * Usage:
 *   node tools/loadoutcheck.mjs             # assert the three differ
 *   node tools/loadoutcheck.mjs --legacy    # must FAIL: the pre-fix behaviour
 *   node tools/loadoutcheck.mjs --shots     # also write composite PNGs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const has = (n) => args.includes('--' + n);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };

const LEGACY = has('legacy');
const SHOTS = has('shots');
const URL = opt('url', 'http://127.0.0.1:5180');
const TAG = opt('tag', 'loadout11');
const FRAME = 'tod=golden&pos=6,1.7,14&yaw=200&pitch=-0.02&vm=1';

const SLOTS = [
  { i: 0, id: 'ar_vector', name: 'VK-7 VECTOR', calibre: '5.56' },
  { i: 1, id: 'smg_wraith', name: 'WRAITH-9', calibre: '9mm' },
  { i: 2, id: 'dmr_lancet', name: 'LANCET MK4', calibre: '7.62' },
];

/* ------------------------------------------------------------- thresholds */

/**
 * Two silhouettes may overlap this much and no more. The three weapons share a
 * lower receiver, a pistol grip and a handguard section by design (the gloved
 * hands are solved against those and Hands.js is another agent's file), so a
 * floor well above zero is correct — what is being asserted is that the parts
 * which are allowed to differ actually do.
 */
const MAX_IOU = 0.86;
/** Smallest relative area gap between any two weapons. */
const MIN_AREA_DIFF = 0.08;
/** The SMG must be measurably smaller, the marksman rifle measurably larger. */
const MAX_SMG_RATIO = 0.90;
const MIN_DMR_RATIO = 1.05;
/** Bounding-box aspect must move too, so "smaller" is not merely "scaled". */
const MIN_ASPECT_DIFF = 0.040;
/** Geometry left behind by a switch. Zero is the intent; 2 is measurement slack. */
const MAX_LEAK = 2;

const GW = 192, GH = 108;

/* ------------------------------------------------------------------ probe */

/**
 * Isolate the weapon and return its silhouette.
 *
 * Same method as tools/handcheck.mjs, and for the same reason: an absolute
 * "brighter than black" test does not work, because the post chain's grade lift,
 * grain and vignette put every pixel above zero even with the world hidden. So
 * coverage is a DIFFERENCE against a baseline frame with nothing visible. The
 * engine's rAF loop is stopped first — in headless Chromium it is paced by a
 * virtual clock and would queue a normal frame over the isolated one before
 * readPixels sampled it — and each grab settles for several frames, because one
 * frame after a visibility change is a cross-fade of the two states.
 */
const PROBE = `(() => {
  const eng = window.__blacksite.engine;
  const vm = eng.systems.get('viewmodel');
  const ws = eng.systems.get('weapons');
  if (!vm || !ws) return { error: 'viewmodel/weapons system missing' };
  if (!vm.rig || !vm.hands) return { error: 'viewmodel exposes no .rig/.hands handles' };

  const gl = eng.renderer.getContext();
  const W = eng.renderer.domElement.width;
  const H = eng.renderer.domElement.height;

  const hands = vm.hands.meshes || [];
  const rig = vm.rig.meshes || [];
  const saved = {
    sceneVisible: eng.scene.visible,
    background: eng.scene.background,
    hands: hands.map((m) => m.visible),
    rig: rig.map((m) => m.visible),
  };
  eng.stop();

  const grab = (showRig) => {
    eng.scene.visible = false;
    eng.scene.background = null;
    hands.forEach((m) => { m.visible = false; });
    rig.forEach((m) => { m.visible = showRig; });
    for (let k = 0; k < 12; k++) eng._frame();
    const out = new Uint8Array(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, out);
    return out;
  };

  const baseline = grab(false);
  const frame = grab(true);

  const GW = ${GW}, GH = ${GH};
  const cw = W / GW, ch = H / GH;
  const cell = new Int32Array(GW * GH);
  let count = 0, minX = W, maxX = -1, minY = H, maxY = -1;
  for (let i = 0, p = 0; i < W * H; i++, p += 4) {
    const d = Math.abs(frame[p] - baseline[p])
      + Math.abs(frame[p + 1] - baseline[p + 1])
      + Math.abs(frame[p + 2] - baseline[p + 2]);
    if (d <= 24) continue;
    count++;
    const x = i % W, y = (i / W) | 0;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    cell[((y / ch) | 0) * GW + ((x / cw) | 0)]++;
  }
  // A grid cell counts as covered at 25% fill: high enough that a single
  // antialiased barrel edge grazing a cell does not claim it, low enough that a
  // 2 mm sling loop crossing one still does.
  const need = cw * ch * 0.25;
  const grid = [];
  for (let i = 0; i < cell.length; i++) grid.push(cell[i] >= need ? 1 : 0);

  eng.scene.visible = saved.sceneVisible;
  eng.scene.background = saved.background;
  hands.forEach((m, i) => { m.visible = saved.hands[i]; });
  rig.forEach((m, i) => { m.visible = saved.rig[i]; });
  eng.start();

  const bw = maxX - minX + 1, bh = maxY - minY + 1;
  return {
    resolution: W + 'x' + H,
    areaPct: +((count / (W * H)) * 100).toFixed(3),
    box: count ? [minX, minY, maxX, maxY] : null,
    aspect: count ? +(bw / bh).toFixed(4) : 0,
    grid,
    // What the viewmodel thinks it is holding, and what the HUD reads.
    vmWeaponId: vm.weaponId ?? null,
    rigId: vm.rig.id ?? null,
    rigTriangles: vm.rig.triangles,
    rigMeshes: rig.length,
    curId: ws.current.id,
    curName: ws.current.displayName,
    curCalibre: ws.current.calibre,
    mode: ws.state.mode,
    slot: ws.state.slot,
    magSize: ws.current.magSize,
    magLoaded: ws.ammo.mag,
    adsRelief: +(-vm._adsPos.z - vm._sightLocal.z).toFixed(5),
    sightY: +vm._sightLocal.y.toFixed(5),
    adsY: +vm._adsPos.y.toFixed(5),
  };
})()`;

/**
 * CAN THE PLAYER SEE THROUGH THIS SIGHT?
 *
 * ─── WHY THIS BLOCK EXISTS ────────────────────────────────────────────────
 *
 * The silhouette test above passed on all three weapons at a moment when the
 * LANCET's scope was COMPLETELY OPAQUE — a black disc where the world should be,
 * with no reticle either. An outline measurement cannot see a plugged bore, and
 * neither can the aperture arithmetic, because a plugged bore is not a narrow
 * one. It was found by cropping the ADS frame and looking at it, which is the one
 * step no number replaces; this is that observation turned into a number.
 *
 * (The cause is worth recording: `knurlG` wraps `cylG`, which is a SOLID capped
 * cylinder. Correct for a turret drum. Two 20 mm discs across the optical axis
 * when it is used for a ring around the tube.)
 *
 * The measurement is an A/B on an ANNULUS at frame centre, 25 to 55 px, which is
 * inside the narrowest of the three windows: grab the ADS frame with the RETICLE
 * hidden but the housing and glass present, then grab it again with the whole
 * weapon hidden, and compare.
 *
 * ─── TWO INSTRUMENT BUGS FOUND WHILE WRITING IT, BOTH WORTH KEEPING ───────
 *
 * 1. EXPOSURE. The first version compared the two annulus means directly and
 *    reported the CARBINE — the one sight nobody had touched, and the round-10
 *    clean win — at ratio 1.166. The glass was innocent.
 *    `src/render/post/AutoExposurePass.js` is in the chain: hiding a large dark
 *    weapon that fills the lower third of the frame raises the scene's average
 *    luminance, the aperture closes, and every pixel of the reference frame comes
 *    back darker. So both grabs are normalised against a REFERENCE PATCH of world
 *    in the same frame and the gate is on the ratio of ratios. Whatever exposure
 *    does, it does to both regions equally and it cancels.
 *
 * 2. THE RETICLE. The second version then failed the WRAITH and the LANCET at
 *    ~1.19 while the carbine passed, which read as "those two sights leak light".
 *    tools/_lo11_seediag.mjs measures the same annulus in four states, and the
 *    answer is unambiguous: with the reticle hidden the three sights read 0.94,
 *    0.89 and 0.98 of bare, and with it shown they read 1.15-1.20. The lift is the
 *    EMITTER — an illuminated reticle is emitted light, its halo is spread across
 *    the whole window by the bloom pass, and gating on it means gating on how
 *    bright the dot is. Hiding the reticle for this grab leaves exactly the
 *    question this block asks: does the housing let the world through, and does
 *    the glass transmit? (Its ~2% cost is visible in the numbers and is what
 *    tools/opticcheck.mjs gates properly.)
 */
const SEE_PROBE = `(() => {
  const eng = window.__blacksite.engine;
  const vm = eng.systems.get('viewmodel');
  const gl = eng.renderer.getContext();
  const W = eng.renderer.domElement.width, H = eng.renderer.domElement.height;
  const rig = vm.rig.meshes || [];
  const loose = [vm.rig.optic.lens, vm.rig.optic.reticle, vm.rig.optic.vignette];
  const hands = vm.hands.meshes || [];
  const all = [...rig, ...loose, ...hands];
  const saved = all.map((m) => m.visible);
  eng.stop();
  // 16 frames, not one: the post chain accumulates temporally and a single frame
  // after a visibility change is a cross-fade of the two states.
  const grab = (fn) => {
    all.forEach(fn);
    for (let k = 0; k < 16; k++) eng._frame();
    const out = new Uint8Array(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, out);
    return out;
  };
  // Housing and glass present, emitter hidden. See the header for why.
  const through = grab((m) => { m.visible = m !== vm.rig.optic.reticle; });
  const lit = grab((m) => { m.visible = true; });
  const bare = grab((m) => { m.visible = false; });
  all.forEach((m, i) => { m.visible = saved[i]; });
  eng.start();

  const lum = (b, p) => 0.299 * b[p] + 0.587 * b[p + 1] + 0.114 * b[p + 2];

  const cx = W / 2, cy = H / 2, r0 = 25, r1 = 55;
  let sumT = 0, sumB = 0, sumL = 0, n = 0, differ = 0;
  for (let y = cy - r1; y <= cy + r1; y++) {
    for (let x = cx - r1; x <= cx + r1; x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d < r0 || d > r1) continue;
      const p = ((y | 0) * W + (x | 0)) * 4;
      sumT += lum(through, p); sumB += lum(bare, p); sumL += lum(lit, p); n++;
    }
  }
  // Reference patch: world in the upper left, clear of the weapon in both grabs.
  let refT = 0, refB = 0, rn = 0;
  for (let y = (H * 0.62) | 0; y < (H * 0.82) | 0; y += 2) {
    for (let x = (W * 0.08) | 0; x < (W * 0.26) | 0; x += 2) {
      const p = (y * W + x) * 4;
      refT += lum(through, p); refB += lum(bare, p); rn++;
    }
  }
  // Structural difference is judged on EXPOSURE-CORRECTED pixels for the same
  // reason the mean is.
  const k = (refB / rn) / (refT / rn);
  for (let y = cy - r1; y <= cy + r1; y++) {
    for (let x = cx - r1; x <= cx + r1; x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d < r0 || d > r1) continue;
      const p = ((y | 0) * W + (x | 0)) * 4;
      if (Math.abs(lum(through, p) * k - lum(bare, p)) > 40) differ++;
    }
  }
  return {
    samples: n,
    through: +(sumT / n).toFixed(1),
    bare: +(sumB / n).toFixed(1),
    refT: +(refT / rn).toFixed(1),
    refB: +(refB / rn).toFixed(1),
    raw: +(sumT / Math.max(1, sumB)).toFixed(3),
    ratio: +((sumT / sumB) * k).toFixed(3),
    /** Reported, not gated: how much the emitter adds to its own sight picture. */
    reticleLift: +(sumL / Math.max(1, sumT)).toFixed(3),
    differPct: +((differ / n) * 100).toFixed(1),
  };
})()`;

/** Drive a switch through the real event path and watch the geometry follow. */
const SWITCH_PROBE = (slot) => `(async () => {
  const eng = window.__blacksite.engine;
  const vm = eng.systems.get('viewmodel');
  const ws = eng.systems.get('weapons');
  const before = {
    id: vm.weaponId,
    geos: eng.renderer.info.memory.geometries,
    tris: vm.rig.triangles,
  };
  ws._requestSwitch(${slot});
  const t0 = performance.now();
  while (ws.state.switching && performance.now() - t0 < 4000) {
    await new Promise((r) => requestAnimationFrame(r));
  }
  await new Promise((r) => setTimeout(r, 120));
  return {
    before,
    after: {
      id: vm.weaponId,
      geos: eng.renderer.info.memory.geometries,
      tris: vm.rig.triangles,
      curId: ws.current.id,
      curName: ws.current.displayName,
      switching: ws.state.switching,
      handsParented: vm.hands.group.parent === vm.rig.root,
    },
  };
})()`;

/* ------------------------------------------------------------------- main */

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, 'out', 'shots', TAG);
if (SHOTS) fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=d3d11', '--disable-gpu-sandbox', '--ignore-gpu-blocklist'],
});

const errors = [];
const results = [];
let failed = false;

for (const s of SLOTS) {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => errors.push(`${s.id}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${s.id}: ${m.text().slice(0, 200)}`); });
  try {
    // In legacy mode the URL carries no weapon at all and the slot is applied
    // in-page through the data-only path, which is precisely the old behaviour.
    const q = LEGACY ? FRAME : `${FRAME}&weapon=${s.i}`;
    await page.goto(`${URL}/?freeze=1&hud=0&quality=cinematic&${q}`,
      { waitUntil: 'domcontentloaded', timeout: 300000 });
    await page.waitForFunction('window.__ready === true', null, { timeout: 300000 });
    if (LEGACY && s.i > 0) {
      await page.evaluate(`window.__blacksite.engine.systems.get('weapons')._applySlot(${s.i})`);
    }
    await page.waitForTimeout(900);

    if (SHOTS) {
      await page.screenshot({ path: path.join(outDir, `${s.id}-hip.png`) });
    }

    const r = await page.evaluate(PROBE);
    if (r.error) { console.log(`${s.id}: ${r.error}`); failed = true; await page.close(); continue; }
    results.push({ ...s, ...r });
  } catch (err) {
    console.log(`${s.id}: ${String(err.message).slice(0, 200)}`);
    failed = true;
  }
  await page.close();
}

/* ---- ADS: is the sight picture actually a picture? ------------------------ */

const see = {};
for (const s of SLOTS) {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => errors.push(`${s.id}-ads: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${s.id}-ads: ${m.text().slice(0, 200)}`); });
  try {
    const q = LEGACY ? FRAME : `${FRAME}&weapon=${s.i}`;
    await page.goto(`${URL}/?freeze=1&hud=0&quality=cinematic&${q}&ads=1`,
      { waitUntil: 'domcontentloaded', timeout: 300000 });
    await page.waitForFunction('window.__ready === true', null, { timeout: 300000 });
    if (LEGACY && s.i > 0) {
      await page.evaluate(`window.__blacksite.engine.systems.get('weapons')._applySlot(${s.i})`);
    }
    await page.waitForTimeout(900);
    if (SHOTS) await page.screenshot({ path: path.join(outDir, `${s.id}-ads.png`) });
    see[s.id] = await page.evaluate(SEE_PROBE);
  } catch (err) {
    console.log(`${s.id}-ads: ${String(err.message).slice(0, 200)}`);
    failed = true;
  }
  await page.close();
}

console.log('\n=== ADS: the world must be visible THROUGH each sight ===');
for (const s of SLOTS) {
  const v = see[s.id];
  if (!v) { failed = true; continue; }
  /**
   * The band is 0.80-1.15, and it is wide ON PURPOSE — it is set to this
   * instrument's demonstrated precision, not to what would look impressive.
   * Repeat runs of the same build move this figure by up to 10 points, because
   * the level is live behind the sight: enemies fire, particles spawn, and the
   * temporal passes are still settling after a visibility toggle. A gate tighter
   * than the noise is a gate that fails at random, which is worse than no gate.
   *
   * It still has all the discriminating power it needs: the LANCET's plugged bore
   * — the defect this block was written for — measured 0.15.
   */
  const okR = v.ratio >= 0.80 && v.ratio <= 1.15;
  const okD = v.differPct <= 35;
  if (!okR || !okD) failed = true;
  console.log(`  ${s.id.padEnd(11)} ${okR && okD ? 'PASS' : 'FAIL'}  window ${v.through} vs bare ${v.bare},`
    + ` reference patch ${v.refT} vs ${v.refB} (exposure)`);
  console.log(`              exposure-corrected ratio ${v.ratio} (raw ${v.raw}, need 0.80-1.15),`
    + ` ${v.differPct}% of the window differs (need <= 35%)`);
  console.log(`              reticle adds ${((v.reticleLift - 1) * 100).toFixed(0)}% to its own sight picture (reported, not gated)`);
  if (!okR) console.log('    -> the sight picture is not the world. A solid part is across the bore,'
    + ' or the glass is not transmitting. Crop the ADS frame and look at it.');
}

/* ---- per-weapon report ---------------------------------------------------- */

console.log(`\n=== loadout silhouettes ${LEGACY ? '(LEGACY data-only switch)' : ''} ===`);
for (const r of results) {
  const okId = LEGACY ? true : r.vmWeaponId === r.id;
  const okHud = r.curId === r.id && r.curName === r.name && r.curCalibre === r.calibre;
  if (!okId || !okHud) failed = true;
  console.log(`\n  ${r.id.padEnd(11)} ${r.resolution}`);
  console.log(`    ${okId ? 'ok  ' : 'FAIL'} viewmodel built    ${r.vmWeaponId} (${r.rigTriangles} tris, ${r.rigMeshes} meshes)`);
  console.log(`    ${okHud ? 'ok  ' : 'FAIL'} HUD source         "${r.curName}" · ${r.mode} · ${r.curCalibre}`
    + ` · ${r.magLoaded}/${r.magSize} · slot ${r.slot}`);
  console.log(`         silhouette         ${r.areaPct}% of frame, box ${JSON.stringify(r.box)}, aspect ${r.aspect}`);
  console.log(`         ADS alignment      eye relief ${r.adsRelief} m, sight y ${r.sightY} -> pose y ${r.adsY}`);
  // The ADS pose is derived, so this is an identity: the sight anchor must be
  // cancelled exactly. A mismatch means somebody hand-tuned an offset.
  if (Math.abs(r.sightY + r.adsY) > 1e-6) {
    failed = true;
    console.log('         FAIL ADS pose does not cancel the sight anchor — the alignment was hand-tuned');
  }
}

/* ---- pairwise comparison -------------------------------------------------- */

const iou = (a, b) => {
  let inter = 0, uni = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] || b[i]) uni++;
    if (a[i] && b[i]) inter++;
  }
  return uni ? inter / uni : 1;
};

console.log('\n=== pairwise: the three must be genuinely different objects ===');
for (let i = 0; i < results.length; i++) {
  for (let j = i + 1; j < results.length; j++) {
    const A = results[i], B = results[j];
    const ov = iou(A.grid, B.grid);
    const ar = Math.abs(A.areaPct - B.areaPct) / Math.max(A.areaPct, B.areaPct);
    const asp = Math.abs(A.aspect - B.aspect);
    const okI = ov <= MAX_IOU, okA = ar >= MIN_AREA_DIFF, okS = asp >= MIN_ASPECT_DIFF;
    if (!okI || !okA || !okS) failed = true;
    console.log(`  ${A.id} vs ${B.id}`);
    console.log(`    ${okI ? 'PASS' : 'FAIL'} silhouette IoU     ${ov.toFixed(3)}  (need <= ${MAX_IOU})`);
    console.log(`    ${okA ? 'PASS' : 'FAIL'} area difference    ${(ar * 100).toFixed(1)}%  (need >= ${MIN_AREA_DIFF * 100}%)`
      + `   ${A.areaPct}% vs ${B.areaPct}%`);
    console.log(`    ${okS ? 'PASS' : 'FAIL'} aspect difference  ${asp.toFixed(3)}  (need >= ${MIN_ASPECT_DIFF})`
      + `   ${A.aspect} vs ${B.aspect}`);
  }
}

const byId = Object.fromEntries(results.map((r) => [r.id, r]));
if (byId.ar_vector && byId.smg_wraith && byId.dmr_lancet) {
  const base = byId.ar_vector.areaPct;
  const smg = byId.smg_wraith.areaPct / base;
  const dmr = byId.dmr_lancet.areaPct / base;
  const okS = smg <= MAX_SMG_RATIO, okD = dmr >= MIN_DMR_RATIO;
  if (!okS || !okD) failed = true;
  console.log('\n=== the player asked for a SMALLER gun ===');
  console.log(`  ${okS ? 'PASS' : 'FAIL'} WRAITH-9 is smaller   ${(smg * 100).toFixed(1)}% of the carbine's screen area`
    + ` (need <= ${MAX_SMG_RATIO * 100}%)`);
  console.log(`  ${okD ? 'PASS' : 'FAIL'} LANCET is larger      ${(dmr * 100).toFixed(1)}% of the carbine's screen area`
    + ` (need >= ${MIN_DMR_RATIO * 100}%)`);
}

/* ---- the runtime path ------------------------------------------------------ */

if (!LEGACY) {
  console.log('\n=== runtime switch: key 2, through the real event path ===');
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => errors.push(`switch: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`switch: ${m.text().slice(0, 200)}`); });
  try {
    await page.goto(`${URL}/?hud=0&quality=medium&${FRAME}`,
      { waitUntil: 'domcontentloaded', timeout: 300000 });
    await page.waitForFunction('window.__ready === true', null, { timeout: 300000 });
    await page.waitForTimeout(600);
    const sw = await page.evaluate(SWITCH_PROBE(1));
    const okSwap = sw.after.id === 'smg_wraith' && sw.before.id === 'ar_vector';
    const okData = sw.after.curId === 'smg_wraith' && sw.after.curName === 'WRAITH-9';
    const okDone = sw.after.switching === false;
    const okHands = sw.after.handsParented === true;
    const leak = sw.after.geos - sw.before.geos;
    const okLeak = leak <= MAX_LEAK;
    if (!okSwap || !okData || !okDone || !okHands || !okLeak) failed = true;
    console.log(`  ${okSwap ? 'PASS' : 'FAIL'} geometry followed    ${sw.before.id} -> ${sw.after.id}`
      + `   (${sw.before.tris} -> ${sw.after.tris} tris)`);
    console.log(`  ${okData ? 'PASS' : 'FAIL'} HUD source followed  "${sw.after.curName}"`);
    console.log(`  ${okDone ? 'PASS' : 'FAIL'} animation completed  switching=${sw.after.switching}`);
    console.log(`  ${okHands ? 'PASS' : 'FAIL'} hands re-parented    onto the new rig root`);
    console.log(`  ${okLeak ? 'PASS' : 'FAIL'} no geometry leak     ${sw.before.geos} -> ${sw.after.geos}`
      + ` live geometries (delta ${leak >= 0 ? '+' : ''}${leak}, need <= ${MAX_LEAK})`);
  } catch (err) {
    console.log(`  switch: ${String(err.message).slice(0, 200)}`);
    failed = true;
  }
  await page.close();
}

await browser.close();

if (errors.length) {
  failed = true;
  console.log(`\n${errors.length} page error(s):`);
  for (const e of errors.slice(0, 12)) console.log('  ' + e);
}
console.log(`\n${failed ? 'FAIL' : 'PASS'} — the loadout ${failed ? 'does NOT read as three weapons' : 'reads as three distinct weapons'}`);
if (SHOTS) console.log(`shots -> ${outDir}`);
process.exitCode = failed ? 1 : 0;
