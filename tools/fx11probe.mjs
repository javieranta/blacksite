#!/usr/bin/env node
/**
 * FX11 PROBE — attribution by ablation. Owner: fx agent (tag fx11).
 *
 * Three of the four defects handed to this round name a symptom, not a file, and
 * this project has a long history of the named file being the wrong one: the
 * "eight-point asterisk muzzle flash" attributed to SPRITE.STAR was a quad in
 * src/weapons/viewmodel/Flash.js; the "metre-long casings" attributed to the
 * particle billboards were meshes in src/weapons/ViewModel.js. Rewriting the
 * innocent system is indistinguishable, from the outside, from doing nothing.
 *
 * So before touching anything: turn each candidate OFF at runtime, re-render the
 * identical frame, and diff. Whatever survives the ablation is not the cause.
 *
 * Subcommands (default: all)
 *   --shadow   are the hard dark quads under debris decals, particles, or world
 *              geometry? Renders the same framing with fx:decals off, then with
 *              fx:particles off, and reports the pixel delta inside the region
 *              where the quads are.
 *   --flash    which system draws the muzzle bloom? Captures the brightest frame
 *              of a burst with everything on, then with the viewmodel's flash
 *              cards hidden, then with the particle additive batch hidden.
 *   --light    does the muzzle light reach past the shooter's feet? Samples
 *              rendered luminance at a near-ground patch, a mid-range wall and a
 *              far control, with the discharge light forced on and forced off.
 *   --perf     is the particle batch responsible for the 2x worst-frame spike?
 *              Frame-interval distribution with the batches emitting and with
 *              them muted, measured with a forced GPU flush per frame.
 *
 * Output PNGs land in tools/out/shots/fx11/.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const has = (n) => args.includes('--' + n);
const all = !(has('shadow') || has('flash') || has('light') || has('perf'));

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, 'out', 'shots', 'fx11');
fs.mkdirSync(outDir, { recursive: true });

const COMBAT = 'freeze=1&hud=0&quality=cinematic&tod=golden&pos=4,1.7,6&yaw=195&pitch=-0.02&vm=1';

const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=d3d11', '--disable-gpu-sandbox', '--ignore-gpu-blocklist'],
});

async function open(query) {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on('pageerror', (e) => console.error('[page error]', e.message));
  await page.goto(`http://127.0.0.1:5180/?${query}`, { waitUntil: 'domcontentloaded', timeout: 300000 });
  await page.waitForFunction('window.__ready === true', null, { timeout: 300000 });
  await page.waitForTimeout(1400);
  return page;
}

/** Toggle a named scene group's visibility, in either scene. */
const SET_VISIBLE = (name, on) => `(() => {
  const eng = window.__blacksite.engine;
  let n = 0;
  for (const s of [eng.scene, eng.viewScene]) {
    s.traverse((o) => { if (o.name === ${JSON.stringify(name)}) { o.visible = ${on}; n++; } });
  }
  return n;
})()`;

// ────────────────────────────────────────────────────────────────── shadow ──
if (all || has('shadow')) {
  console.log('\n=== SHADOW QUADS UNDER DEBRIS — who draws them? ===');
  const page = await open(COMBAT);
  const shots = [];
  const grab = async (label) => {
    const f = path.join(outDir, `shadow-${label}.png`);
    await page.screenshot({ path: f, clip: { x: 600, y: 760, width: 520, height: 270 } });
    shots.push([label, f]);
  };
  await grab('all');

  const nDec = await page.evaluate(SET_VISIBLE('fx:decals', false));
  await page.waitForTimeout(350);
  await grab('no-decals');
  await page.evaluate(SET_VISIBLE('fx:decals', true));

  const nPar = await page.evaluate(SET_VISIBLE('fx:particles', false));
  await page.waitForTimeout(350);
  await grab('no-particles');
  await page.evaluate(SET_VISIBLE('fx:particles', true));

  // With the sun's shadow map switched off, anything still dark is not a shadow.
  const nShadow = await page.evaluate(`(() => {
    const eng = window.__blacksite.engine;
    eng.renderer.shadowMap.enabled = false;
    eng.scene.traverse((o) => { if (o.material) o.material.needsUpdate = true; });
    return 1;
  })()`);
  await page.waitForTimeout(700);
  await grab('no-sun-shadow');

  console.log(`  toggled ${nDec} decal group(s), ${nPar} particle group(s), shadowMap=${nShadow}`);
  for (const [l, f] of shots) console.log(`  ${l.padEnd(16)} ${f}`);
  console.log('  Compare shadow-all vs shadow-no-decals: identical => the quads are NOT decals.');
  console.log('  Compare shadow-all vs shadow-no-sun-shadow: quads gone => they are real CSM shadows.');
  await page.close();
}

// ─────────────────────────────────────────────────────────────────── flash ──
if (all || has('flash')) {
  console.log('\n=== MUZZLE BLOOM — which system draws the shape? ===');
  const page = await open(`${COMBAT}&fire=1`);

  /**
   * The rig fires every 85 ms and the bloom lives 30-75 ms, so a single
   * screenshot lands on the flash roughly one frame in three. Sample the
   * additive batch's live count and only expose when a discharge is on screen.
   */
  const WAIT_FOR_FLASH = `(async () => {
    const eng = window.__blacksite.engine;
    const P = eng.systems.get('particles');
    eng.paused = false;
    for (let i = 0; i < 400; i++) {
      // GLOW core (tile 2) only exists for 30 ms after a shot. PAUSE the engine
      // the instant one is young: Engine zeroes dt while paused, so nothing ages
      // and the screenshot round-trip — tens of milliseconds, i.e. most of the
      // flash — can no longer eat the event. Polling and then exposing without
      // pausing caught the trailing sparks every single time and made this
      // effect look like a dying firework rather than a discharge.
      const b = P.additive;
      for (let k = 0; k < b.count; k++) {
        if (b.aP[k * 4] === 2 && b.aT[k] < 0.35) { eng.paused = true; return true; }
      }
      await new Promise((r) => setTimeout(r, 2));
    }
    return false;
  })()`;

  const clip = { x: 940, y: 590, width: 260, height: 200 };
  const grab = async (label) => {
    const hit = await page.evaluate(WAIT_FOR_FLASH);
    const f = path.join(outDir, `flash-${label}.png`);
    await page.screenshot({ path: f, clip });
    await page.evaluate('window.__blacksite.engine.paused = false');
    console.log(`  ${label.padEnd(18)} onFlash=${hit}  ${f}`);
  };

  await grab('all');

  // Hiding the group is NOT enough: ViewModel._updateFlash writes
  // `flash.group.visible` every frame, so a probe that only clears the flag
  // measures nothing and reports the innocent system guilty. DETACH it instead —
  // nothing re-parents it.
  await page.evaluate(SET_VISIBLE('fx:particles:additive', false));
  await grab('no-particle-additive');
  await page.evaluate(SET_VISIBLE('fx:particles:additive', true));

  const nVm = await page.evaluate(`(() => {
    const vm = window.__blacksite.engine.systems.get('viewmodel');
    if (!vm?.flash?.group) return 0;
    vm.flash.group.removeFromParent();
    return 1;
  })()`);
  await grab('no-vm-cards');
  console.log(`  viewmodel flash group detached: ${nVm}`);
  console.log('  flash-no-particle-additive keeps the star  -> the star is NOT SPRITE.STAR.');
  console.log('  flash-no-vm-cards loses the star           -> the star is viewmodel/Flash.js.');
  await page.close();
}

// ─────────────────────────────────────────────────────────────────── light ──
if (all || has('light')) {
  console.log('\n=== MUZZLE LIGHT — does the pool reach past the shooter\'s feet? ===');
  const page = await open(COMBAT);

  /**
   * Re-arm the discharge light with the exact numbers `Particles` uses, on a
   * timer, so it is continuously lit while the engine's own loop runs — and then
   * expose a normal SCREENSHOT. An earlier version stopped the engine, drove
   * `_frame()` by hand and called `readPixels`; the drawing buffer is not
   * preserved between rAF callbacks, so every "light off" sample came back as
   * pure black and every gain figure was a division by zero. Screenshots are the
   * same pixels the reviewer grades, so they cannot lie in that direction.
   */
  const ARM = `(() => {
    const eng = window.__blacksite.engine;
    const P = eng.systems.get('particles');
    const L = eng.systems.get('lighting');
    const cfg = P.constructor.MUZZLE_LIGHT;
    clearInterval(window.__fx11arm);
    window.__fx11arm = setInterval(() => {
      P._muzzleDir.set(0, 0, -1).applyQuaternion(eng.camera.quaternion).normalize();
      P._muzzlePosition(P._muzzle);
      P._flashPos.copy(P._muzzle).addScaledVector(P._muzzleDir, cfg.forward);
      const l = L.flash(P._flashPos, cfg.colour, cfg.peak, cfg.decay);
      if (l) { l.distance = cfg.radius; l.decay = cfg.falloff; }
    }, 20);
    const lp = P._flashPos;
    return {
      lightWorld: [+lp.x.toFixed(2), +lp.y.toFixed(2), +lp.z.toFixed(2)],
      camWorld: [+eng.camera.position.x.toFixed(2), +eng.camera.position.y.toFixed(2),
        +eng.camera.position.z.toFixed(2)],
      offsetFromCamera: +lp.distanceTo(eng.camera.position).toFixed(3),
      cfg: { peak: cfg.peak, radius: cfg.radius, falloff: cfg.falloff, forward: cfg.forward },
    };
  })()`;

  const offFile = path.join(outDir, 'light-off.png');
  await page.screenshot({ path: offFile });
  const info = await page.evaluate(ARM);
  await page.waitForTimeout(900);
  const onFile = path.join(outDir, 'light-on.png');
  await page.screenshot({ path: onFile });
  await page.evaluate('clearInterval(window.__fx11arm)');

  /**
   * Numeric version of the same thing, so the tuning has a pass/fail rather than
   * an opinion. `readPixels` must run in the SAME task as the render that filled
   * the buffer — the drawing buffer is not preserved across a yield, and an
   * earlier revision awaited a timeout in between and read pure black for every
   * "off" sample, which made every gain figure a division by zero.
   */
  const SAMPLE = `(async () => {
    const eng = window.__blacksite.engine;
    const P = eng.systems.get('particles');
    const L = eng.systems.get('lighting');
    const lvl = eng.systems.get('level');
    const gl = eng.renderer.getContext();
    const W = eng.renderer.domElement.width;
    const H = eng.renderer.domElement.height;

    // PICK THE SAMPLE POINTS BY MEASURED DEPTH, NOT BY EYE.
    //
    // The first version of this check hand-placed a patch it called "wall_15m".
    // Raycasting through it showed the pixel is a facade 39.1 m away — outside
    // the light's 34 m cutoff, so the assertion was demanding a brightening that
    // is impossible by construction and could never have passed. Scan a grid,
    // raycast every point, and bucket by the distance that comes back.
    const V3 = eng.camera.position.constructor;
    const rd = new V3();
    const bucket = { near: [], mid: [], far: [] };
    for (let y = 200; y < H - 60; y += 40) {
      for (let x = 120; x < W - 120; x += 40) {
        rd.set((x / W) * 2 - 1, -((y / H) * 2 - 1), 0.5).unproject(eng.camera)
          .sub(eng.camera.position).normalize();
        const hit = lvl?.raycast ? lvl.raycast(eng.camera.position, rd, 400) : null;
        if (!hit) continue;
        const d = eng.camera.position.distanceTo(hit.point);
        if (d >= 1.8 && d <= 5) bucket.near.push([x, y, d]);
        else if (d >= 8 && d <= 22) bucket.mid.push([x, y, d]);
        else if (d >= 45) bucket.far.push([x, y, d]);
      }
    }
    const cap = (a, n) => { const st = Math.max(1, Math.floor(a.length / n)); const o = [];
      for (let i = 0; i < a.length && o.length < n; i += st) o.push(a[i]); return o; };
    bucket.near = cap(bucket.near, 40);
    bucket.mid = cap(bucket.mid, 60);
    bucket.far = cap(bucket.far, 60);

    const px = new Uint8Array(4);
    const read = () => {
      const o = {};
      for (const k of Object.keys(bucket)) {
        let s = 0; let hot = 0;
        for (const [x, y] of bucket[k]) {
          gl.readPixels(x, H - y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
          const v = (px[0] * 0.2126 + px[1] * 0.7152 + px[2] * 0.0722) / 255;
          s += v; if (v > 0.965) hot++;
        }
        const n = Math.max(1, bucket[k].length);
        o[k] = s / n; o[k + '_clip'] = hot / n;
      }
      return o;
    };

    const cfg = P.constructor.MUZZLE_LIGHT;
    const arm = () => {
      // _muzzleDir is only written by a real weapon:fire, and this framing never
      // pulls a trigger — leaving it at its world-space (0,0,-1) default. An
      // earlier revision pushed the light 0.55m along THAT, which at yaw 195 is
      // very nearly backwards, and put the source 0.45m from the lens instead of
      // 1.5m ahead of it. Every near-field number that produced was measuring a
      // light in the shooter's own face.
      P._muzzleDir.set(0, 0, -1).applyQuaternion(eng.camera.quaternion).normalize();
      P._muzzlePosition(P._muzzle);
      P._flashPos.copy(P._muzzle).addScaledVector(P._muzzleDir, cfg.forward);
      const l = L.flash(P._flashPos, cfg.colour, cfg.peak, cfg.decay);
      if (l) { l.distance = cfg.radius; l.decay = cfg.falloff; }
    };
    clearInterval(window.__fx11arm);
    eng.stop();
    try {
      // ONE armed frame, not a held light.
      //
      // An earlier revision re-armed the light on every frame for 24 frames and
      // then sampled. That lets the auto-exposure fully adapt to a light that in
      // the game exists for 90 ms, and it measured the far bucket — geometry
      // outside the light's cutoff, which the light cannot touch — moving to
      // 0.79x. All of that 21% was the meter, and detuning the light to satisfy
      // it would have been tuning against the instrument rather than the game.
      // Settle the exposure on the UNLIT scene, then arm once and expose the very
      // next frame: that is what a screenshot of a discharge actually catches.
      for (let i = 0; i < 30; i++) { eng._frame(); await new Promise((r) => setTimeout(r, 0)); }
      eng._frame();
      const off = read();
      // FIVE armed frames. A 90 ms flash at 60 Hz is 5.4 frames, and TAA blends
      // roughly an eighth of the new frame into its history each time, so ONE
      // armed frame measured 1.01x — the light was there and the temporal filter
      // had swallowed it. Five frames is the real dwell; the exposure meter has a
      // ~1 s time constant and barely moves over that span, which is why the far
      // bucket stays at 1.00x here and sat at 0.79x when the light was held.
      for (let i = 0; i < 4; i++) { arm(); eng._frame(); await new Promise((r) => setTimeout(r, 0)); }
      arm(); eng._frame();
      const on = read();
      const lp = P._flashPos;
      const span = (a) => (a.length
        ? [+Math.min(...a.map((q) => q[2])).toFixed(1), +Math.max(...a.map((q) => q[2])).toFixed(1)]
        : null);
      return {
        off, on,
        counts: { near: bucket.near.length, mid: bucket.mid.length, far: bucket.far.length },
        spans: { near: span(bucket.near), mid: span(bucket.mid), far: span(bucket.far) },
        lightWorld: [+lp.x.toFixed(2), +lp.y.toFixed(2), +lp.z.toFixed(2)],
        fromLens: +lp.distanceTo(eng.camera.position).toFixed(3),
        cfg: { peak: cfg.peak, radius: cfg.radius, falloff: cfg.falloff, forward: cfg.forward },
      };
    } finally { eng.start(); }
  })()`;

  const s = await page.evaluate(SAMPLE);
  console.log(`  light at ${JSON.stringify(s.lightWorld)} -> ${s.fromLens}m from the lens`);
  console.log(`  cfg ${JSON.stringify(s.cfg)}`);
  console.log('  bucket   n   depth span      off      on     gain    rel   clipped');
  const gain = {};
  for (const k of ['near', 'mid', 'far']) {
    gain[k] = s.on[k] / Math.max(1e-4, s.off[k]);
  }
  for (const k of ['near', 'mid', 'far']) {
    console.log(`  ${k.padEnd(7)} ${String(s.counts[k]).padStart(3)}  ${JSON.stringify(s.spans[k]).padEnd(13)}`
      + ` ${s.off[k].toFixed(4)}  ${s.on[k].toFixed(4)}  ${gain[k].toFixed(3)}x`
      + ` ${(gain[k] / gain.far).toFixed(3)}x  ${(s.on[k + '_clip'] * 100).toFixed(0)}%`);
  }
  /**
   * RELATIVE gain — each bucket divided by the far bucket — is the honest
   * instrument. The far bucket sits outside the light's cutoff and cannot be lit
   * by it, so whatever happens to the far bucket is purely the auto-exposure
   * moving; dividing by it cancels the meter and leaves the light's own
   * contribution. Absolute gain conflates the two, which is how a light that
   * genuinely brightened the mid ground could still be measured at 0.85x.
   *
   *   POOL   the near ground must genuinely brighten;
   *   CLIP   without blowing to white — a clipped near field closes the meter
   *          and takes every mid-tone down with it;
   *   REACH  the mid ground (8-22 m, where the fight is) must brighten too;
   *   METER  the far field must not be dragged around: this is a light, not an
   *          exposure pump.
   */
  const rel = (k) => gain[k] / gain.far;
  const okNear = rel('near') >= 1.8;
  const okClip = s.on.near_clip <= 0.12;
  // NET, not relative. Any light large enough to reach 20 m adds enough energy to
  // the frame to move the meter — demanding the meter hold still is demanding a
  // light with no reach, and the two cannot both be satisfied. The condition that
  // actually matters is that the mid ground ends up BRIGHTER than it was once the
  // meter has had its say. In round 10 it did not: mid measured 0.85x, i.e. firing
  // the rifle dimmed the ground the enemies stand on.
  const okReach = gain.mid >= 1.05 && rel('mid') >= 1.10;
  const okCtrl = gain.far >= 0.80 && gain.far <= 1.12;
  const L = (ok, l, v, n) => console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${l.padEnd(28)} ${String(v).padStart(7)}   ${n}`);
  L(okNear, 'near ground is a pool', rel('near').toFixed(2) + 'x', 'relative to the far control, need >= 1.8x');
  L(okClip, 'near pool does not clip', (s.on.near_clip * 100).toFixed(0) + '%', 'need <= 12% above 0.965');
  L(okReach, 'mid ground NET brighter', gain.mid.toFixed(2) + 'x abs / ' + rel('mid').toFixed(2) + 'x rel',
    'need >= 1.05x absolute and >= 1.10x relative, 8-22m');
  L(okCtrl, 'meter dip is bounded', gain.far.toFixed(2) + 'x', 'far bucket absolute, need 0.80-1.12x');
  console.log(`  ${offFile}\n  ${onFile}`);
  if (!(okNear && okClip && okReach && okCtrl)) {
    console.log('  A relative gain at or below 1 in the mid bucket means the discharge does not');
    console.log('  light the ground the enemies are standing on — the pool is a puddle.');
  }
  await page.close();
}

// ──────────────────────────────────────────────────────────────────── perf ──
if (all || has('perf')) {
  console.log('\n=== WORST-FRAME SPIKE — is it the particle batch? ===');
  const MEASURE = (mute) => `(async () => {
    const eng = window.__blacksite.engine;
    const P = eng.systems.get('particles');
    const gl = eng.renderer.getContext();
    const px = new Uint8Array(4);
    eng.stop();
    // Mute: keep the simulation running but push nothing new, so the difference
    // is exactly the cost of live particles + their buffer uploads.
    const realSpawn = P.spawn;
    if (${mute}) { P.spawn = () => {}; P.alpha.clear(); P.additive.clear(); }
    const s = [];
    for (let i = 0; i < 70; i++) {
      const t0 = performance.now();
      eng._frame();
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      s.push(performance.now() - t0);
      await new Promise((r) => setTimeout(r, 0));
    }
    P.spawn = realSpawn;
    eng.start();
    const a = s.slice(10).sort((x, y) => x - y);
    return {
      median: +a[a.length >> 1].toFixed(2),
      p95: +a[Math.floor(a.length * 0.95)].toFixed(2),
      worst: +a[a.length - 1].toFixed(2),
      live: P.live,
    };
  })()`;

  const page = await open(`${COMBAT}&fire=1`);
  const on = await page.evaluate(MEASURE(false));
  const off = await page.evaluate(MEASURE(true));
  console.log(`  particles LIVE   median ${on.median}ms  p95 ${on.p95}ms  worst ${on.worst}ms  (${on.live} particles)`);
  console.log(`  particles MUTED  median ${off.median}ms  p95 ${off.p95}ms  worst ${off.worst}ms`);
  console.log(`  delta            median ${(on.median - off.median).toFixed(2)}ms`
    + `  worst ${(on.worst - off.worst).toFixed(2)}ms`);
  console.log('  If the worst frame barely moves, the 2x spike is not the particle system.');
  await page.close();
}

await browser.close();
