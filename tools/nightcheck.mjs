#!/usr/bin/env node
/**
 * NIGHTCHECK — is the night preset actually a NIGHT lighting model, or is it a
 * sunset with a starfield pasted on?
 *
 * WHY THIS EXISTS
 *   The round-10 review scored `night` 44/100, the lowest frame in the set by
 *   eight points, and described it exactly:
 *
 *     "A warm directional key rakes hard, parallel, sharp-edged shadows across
 *      the entire ground plane under a deep-blue starfield, with no falloff from
 *      foreground to 20 m and only one small practical that cannot account for
 *      it. Sandbags and concrete render at daytime albedo."
 *
 *   Nothing in the codebase disagreed with that, because nothing in the codebase
 *   was measuring it. `LIGHT_RIGS.night` reads like a moon rig — a cool
 *   `sunColour`, a small `sunFactor` — so an author reading the source concludes
 *   the preset is fine. The image is the authority, and the image said otherwise.
 *
 * THE INSTRUMENT
 *   Eyeballing a dark frame is exactly the kind of judgement this project has got
 *   wrong four times, so nothing here is judged from the composite. The key
 *   light's contribution is ISOLATED by ablation — render the frame, zero the
 *   four cascade directionals, render again, subtract — and every number about
 *   the directional key is computed on that difference image, which contains the
 *   key and nothing else. That is the only way to answer "is a directional key
 *   drawing the shadows I can see" rather than "does the frame contain edges".
 *
 *   On the ground band it reports:
 *
 *     key/pract/sky % of ground luminance delivered by the directional key, by
 *                   the point-light fixtures, and by the sky fill (environment
 *                   map + SH irradiance + hemisphere + ambient floor), each
 *                   isolated by its own ablation. This triple is the headline:
 *                   a night preset in which the sky out-lights the fixtures is
 *                   a day preset wearing a night sky.
 *     keyEdgeP995   99.5th-percentile Sobel gradient of the KEY'S OWN
 *                   contribution, in 0-255 codes, measured on a 4x box-reduced
 *                   copy so that per-texel normal-map sparkle on gravel and
 *                   grating cannot pass for a shadow boundary. A cast shadow is
 *                   a coherent multi-pixel step and survives the reduction.
 *                   Compare against midday, where hard shadows are correct.
 *     keyWarmth     chroma of the key, (R-B)/(R+G+B) over the difference image.
 *                   Positive = warm. A sun below the horizon has no warm key.
 *     lightCV       std/mean of per-block (composite / sky-fill-only) ratios.
 *                   Dividing by the ambient-only render cancels albedo, so this
 *                   is illumination structure and nothing else: pools under
 *                   fixtures with darkness between them push it up, a flat wash
 *                   holds it near zero.
 *     blockCV       the same statistic on raw luminance. Reported, NOT gated —
 *                   a dark prop in the foreground scores well on it under
 *                   perfectly flat light, which is exactly what the pre-fix
 *                   build did.
 *     nearFar       mean luminance of the nearest ground rows over the farthest.
 *                   A night scene has a strong distance gradient; a flat plate
 *                   from foreground to 20 m is the giveaway.
 *
 *   It also times the frame with and without the practical light cones, because
 *   gpuprobe only ever loads the golden view and the cones only exist at night.
 *
 * TWO THINGS THAT MUST BE TRUE FOR ANY OF THIS TO MEAN ANYTHING, both learned by
 * getting them wrong here first:
 *   - the simulation is PAUSED, not merely frozen. freeze=1 still runs update(),
 *     and Props flickers every wall fixture from an accumulating clock, so two
 *     consecutive renders catch different lamp states and the difference image
 *     contains a blown-out warm fixture that has nothing to do with the ablated
 *     light. That artefact reported a deep-blue moon key as WARM.
 *   - each state is rendered to convergence before it is read. One frame after a
 *     lighting change is a TAA blend with the history of the state before it.
 *
 * GATES
 *   night    keyEdgeP995 low in absolute codes AND far below midday's;
 *            keyWarmth <= 0; lightCV, nearFar and skyShare inside their bounds.
 *   overcast keyEdgeP995 low — under a stratus deck the sky IS the light and
 *            there is no cast shadow to have.
 *   midday   keyEdgeP995 HIGH. This is a regression guard: the sun presets'
 *            cast shadows are the project's biggest recent win and a fix to
 *            night must not be a global softening.
 *
 * Usage:
 *   node tools/nightcheck.mjs                       # night + midday + overcast
 *   node tools/nightcheck.mjs --presets night
 *   node tools/nightcheck.mjs --json out.json --dump tools/out/nightcheck
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };

const url = opt('url', 'http://127.0.0.1:5180');
const presets = opt('presets', 'night,midday,overcast').split(',').map((s) => s.trim());
const dump = opt('dump', null);
const jsonOut = opt('json', null);
const W = parseInt(opt('width', '1920'), 10);
const H = parseInt(opt('height', '1080'), 10);

/** The `night` view's framing from tools/shoot.mjs, used for every preset so the
 *  comparison against midday is like for like. */
const FRAMING = 'pos=6,1.7,14&yaw=200&pitch=-0.04';

/**
 * Per-preset gates. `null` means "not asserted for this preset".
 *   maxKeyEdge     absolute ceiling on the key's own shadow-edge gradient
 *   maxEdgeVsMidday ceiling as a fraction of the midday measurement
 *   maxKeyWarmth   ceiling on key chroma (positive = warm)
 *   minBlockCV     floor on large-scale ground luminance structure
 *   minNearFar     floor on the foreground/distance luminance ratio
 *   minKeyEdge     floor — the regression guard on the sun presets
 */
const GATES = {
  night: {
    maxKeyEdge: 12, maxEdgeVsMidday: 0.18, maxKeyWarmth: 0.0,
    minLightCV: 0.34, minNearFar: 1.35, maxSkyShare: 26, minKeyEdge: null,
  },
  overcast: {
    maxKeyEdge: 9, maxEdgeVsMidday: 0.10, maxKeyWarmth: null,
    minLightCV: null, minNearFar: null, maxSkyShare: null, minKeyEdge: null,
  },
  midday: {
    maxKeyEdge: null, maxEdgeVsMidday: null, maxKeyWarmth: null,
    minLightCV: null, minNearFar: null, maxSkyShare: null, minKeyEdge: 30,
  },
};

/**
 * Runs in the page.
 *
 * Ablation targets:
 *   key         `lighting.csm.lights` — the four cascade directionals, which ARE
 *               the key light (Lighting reserves shadow-casting directionals to
 *               itself, so nothing else in the scene can be confused with them)
 *   practicals  every point light in the scene
 *
 * AUTO-EXPOSURE IS FROZEN FIRST, and this is not a detail. PostFX meters the
 * composite, so removing the key makes the meter open up, which brightens every
 * pixel in the "key off" render — including pixels the key never touched. The
 * first version of this tool did not freeze it and reported the night key
 * getting WARMER after it had been made bluer, because `lit - dark` was picking
 * up the exposure shift over the warm sodium pools rather than the key. That is
 * the same class of instrument error this file exists to catch, and it caught it
 * on itself. Zeroing the adapt rates holds the meter at whatever it had settled
 * to, so the difference between the two renders is the light and only the light.
 */
const PROBE = `(band) => {
  const eng = window.__blacksite.engine;
  const lighting = eng.ctx.get('lighting');
  const gl = eng.renderer.getContext();
  const W = eng.renderer.domElement.width, H = eng.renderer.domElement.height;

  // PAUSE THE SIMULATION, not just freeze it. freeze=1 only skips fixedUpdate;
  // update() still runs with a real dt, and Props drives a tired-ballast flicker
  // on every wall fixture from an accumulating clock — two incommensurate sines
  // plus a rare dip to 35%. So two consecutive renders catch different lamp
  // states, and the difference image contains a blown-out warm fixture that has
  // nothing to do with the light being ablated. That artefact is what made this
  // tool report a 0x86aeff moon key as WARM (+0.103 chroma) and put its share of
  // the ground at 10.4% when a settled measurement says 4%. Engine.paused zeroes
  // dt, which stops the flicker clock — and, for free, stops the exposure meter
  // adapting as well.
  const wasPaused = eng.paused;
  eng.paused = true;
  const postfx = eng.ctx.get('postfx');
  const ae = postfx?.autoExposure?._adaptMaterial?.uniforms;
  const aeSaved = ae ? { up: ae.uAdaptUp.value, down: ae.uAdaptDown.value } : null;
  if (ae) { ae.uAdaptUp.value = 0; ae.uAdaptDown.value = 0; }

  eng.stop();

  /**
   * Render a state to convergence, then read it back.
   *
   * SETTLE FRAMES ARE NOT OPTIONAL, and this cost a measurement cycle to learn.
   * One frame after a lighting change is a TAA blend of the new lighting and the
   * history of the old one, so a single-frame ablation measures some unknown
   * fraction of the real difference — a fraction that depends on how many frames
   * happened to be rendered earlier in the probe. Two consecutive runs of this
   * tool, on identical code, reported the night key at 3.0% and then 10.4% of
   * ground luminance, and its chroma at -0.091 and then +0.103: the sign of the
   * headline number flipped because a later edit added two more grabs upstream.
   * Invalidating the history and running the pass to convergence before each
   * read makes the difference between two renders the light and only the light.
   */
  const grab = () => {
    postfx?.taa?.invalidate?.();
    postfx?.gtao?.invalidate?.();
    for (let f = 0; f < 8; f++) eng._frame();
    const out = new Uint8Array(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, out);
    return out;
  };
  const lit = grab();
  const saved = lighting.csm.lights.map((l) => l.intensity);
  lighting.csm.lights.forEach((l) => { l.intensity = 0; });
  const dark = grab();
  lighting.csm.lights.forEach((l, i) => { l.intensity = saved[i]; });

  // Practicals off, key still on.
  const pts = [];
  eng.scene.traverse((o) => { if (o.isPointLight) pts.push([o, o.intensity]); });
  pts.forEach((p) => { p[0].intensity = 0; });
  const noPract = grab();
  // ...and now key off too: what is left is the sky fill, which is the term that
  // was flattening this preset.
  lighting.csm.lights.forEach((l) => { l.intensity = 0; });
  const amb = grab();
  lighting.csm.lights.forEach((l, i) => { l.intensity = saved[i]; });
  pts.forEach((p) => { p[0].intensity = p[1]; });

  // Sky fill only. The environment map, the SH irradiance injected into every
  // material (which three scales by the same environmentIntensity uniform), the
  // hemisphere and the ambient floor — the four terms that together ARE "the sky
  // is lighting this scene". Everything else, including the emissive luminaire
  // lenses, the additive light cones and the aerial-perspective in-scatter,
  // stays, which is why this is measured separately from "whatever is left after
  // the two lights" — that residual is not all sky and gating on it would be
  // gating on bloom.
  const envSaved = [
    eng.scene.environmentIntensity,
    eng.ctx.viewScene ? eng.ctx.viewScene.environmentIntensity : 0,
    lighting.hemi.intensity, lighting.ambient.intensity,
  ];
  eng.scene.environmentIntensity = 0;
  if (eng.ctx.viewScene) eng.ctx.viewScene.environmentIntensity = 0;
  lighting.hemi.intensity = 0;
  lighting.ambient.intensity = 0;
  const noSky = grab();
  eng.scene.environmentIntensity = envSaved[0];
  if (eng.ctx.viewScene) eng.ctx.viewScene.environmentIntensity = envSaved[1];
  lighting.hemi.intensity = envSaved[2];
  lighting.ambient.intensity = envSaved[3];

  // ---- GPU cost of the added light cones ----------------------------------
  // gpuprobe only ever loads the golden view and the cones only exist at
  // night, so it cannot see them. Forced-flush timing, same technique: render,
  // then a 1x1 readPixels, which blocks the CPU until the GPU has finished.
  const cones = eng.scene.getObjectByName('practical-cones');
  const timeFrames = (nF) => {
    const px = new Uint8Array(4);
    const ms = [];
    for (let f = 0; f < nF; f++) {
      const t0 = performance.now();
      eng._frame();
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      ms.push(performance.now() - t0);
    }
    ms.sort((a, b) => a - b);
    return { median: ms[ms.length >> 1], p95: ms[Math.min(ms.length - 1, Math.floor(ms.length * 0.95))] };
  };
  timeFrames(6);                                  // warm up
  const withCones = timeFrames(24);
  let withoutCones = null;
  if (cones) {
    const wasVisible = cones.visible;
    cones.visible = false;
    timeFrames(4);
    withoutCones = timeFrames(24);
    cones.visible = wasVisible;
  }

  // One more lit frame so the page is not left showing an ablated state and TAA
  // history is not poisoned for whatever runs next.
  grab();
  if (ae) { ae.uAdaptUp.value = aeSaved.up; ae.uAdaptDown.value = aeSaved.down; }
  eng.paused = wasPaused;
  eng.start();

  // readPixels is bottom-up: the on-screen LOWER band is the LOW y rows here.
  const y0 = Math.floor(H * band[0]), y1 = Math.floor(H * band[1]);
  const x0 = Math.floor(W * 0.06), x1 = Math.floor(W * 0.94);
  const bw = x1 - x0, bh = y1 - y0;
  const lum = (b, i) => 0.2126 * b[i] + 0.7152 * b[i + 1] + 0.0722 * b[i + 2];

  // ---- the key light's own contribution, as an image -----------------------
  const key = new Float32Array(bw * bh);
  let keySum = 0, litSum = 0, kr = 0, kg = 0, kb = 0;
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const i = ((y + y0) * W + (x + x0)) * 4;
      const d = lum(lit, i) - lum(dark, i);
      key[y * bw + x] = d;
      keySum += Math.max(0, d);
      litSum += lum(lit, i);
      kr += Math.max(0, lit[i] - dark[i]);
      kg += Math.max(0, lit[i + 1] - dark[i + 1]);
      kb += Math.max(0, lit[i + 2] - dark[i + 2]);
    }
  }
  const n = bw * bh;
  const keyShare = litSum > 0 ? (keySum / litSum) * 100 : 0;
  const keyWarmth = (kr + kg + kb) > 1e-3 ? (kr - kb) / (kr + kg + kb) : 0;

  // ---- who is actually lighting the ground --------------------------------
  let practSum = 0, ambSum = 0, skySum = 0;
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const i = ((y + y0) * W + (x + x0)) * 4;
      practSum += Math.max(0, lum(lit, i) - lum(noPract, i));
      ambSum += lum(amb, i);
      skySum += Math.max(0, lum(lit, i) - lum(noSky, i));
    }
  }
  const practShare = litSum > 0 ? (practSum / litSum) * 100 : 0;
  const ambShare = litSum > 0 ? (ambSum / litSum) * 100 : 0;
  const skyShare = litSum > 0 ? (skySum / litSum) * 100 : 0;

  // ---- Sobel over the key's contribution, AT SHADOW SCALE ------------------
  // A cast shadow boundary is a STEP in this image, and nothing else in the
  // renderer can write a step into the difference between "key on" and "key
  // off". But a step is not the only thing in there: running the Sobel at full
  // resolution measures mostly per-texel normal-map and specular response, which
  // on gravel and on catwalk grating is violent. The first version of this tool
  // did exactly that and reported the night key's edge gradient going UP after
  // the key had been made six times softer and half as strong — because what it
  // was reading was speckle on the gravel, and cutting the flat sky fill had
  // made that speckle a larger fraction of a now-darker frame. Cropping and
  // magnifying the isolated key layer is what settled it: no boundaries, just
  // sparkle.
  //
  // So the key image is box-averaged 4x first. A cast shadow edge at 1080p is
  // tens to hundreds of pixels long and steps over two to six of them; it
  // survives a 4x reduction essentially intact. Single-texel sparkle does not.
  const kw = (bw >> 2), kh = (bh >> 2);
  const keyLo = new Float32Array(kw * kh);
  for (let y = 0; y < kh; y++) {
    for (let x = 0; x < kw; x++) {
      let s = 0;
      for (let dy = 0; dy < 4; dy++) for (let dx = 0; dx < 4; dx++) s += key[(y * 4 + dy) * bw + x * 4 + dx];
      keyLo[y * kw + x] = s / 16;
    }
  }
  const grads = new Float32Array((kw - 2) * (kh - 2));
  let gi = 0;
  for (let y = 1; y < kh - 1; y++) {
    for (let x = 1; x < kw - 1; x++) {
      const p = (yy, xx) => keyLo[yy * kw + xx];
      const gx = (p(y - 1, x + 1) + 2 * p(y, x + 1) + p(y + 1, x + 1))
               - (p(y - 1, x - 1) + 2 * p(y, x - 1) + p(y + 1, x - 1));
      const gy = (p(y + 1, x - 1) + 2 * p(y + 1, x) + p(y + 1, x + 1))
               - (p(y - 1, x - 1) + 2 * p(y - 1, x) + p(y - 1, x + 1));
      grads[gi++] = Math.hypot(gx, gy) * 0.25;
    }
  }
  const sorted = Float32Array.from(grads).sort();
  const pct = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
  const keyEdgeP995 = pct(0.995);
  const keyEdgeP99 = pct(0.99);

  // ---- large-scale luminance structure of the composite -------------------
  // 48-px block means. Albedo speckle, normal detail and film grain average out
  // inside a block, so what survives is pools, falloff and cast shading.
  //
  // blockCV alone is NOT a lighting measurement and must not be gated on: a
  // courtyard with a dark timber bundle in the foreground and a pale wall behind
  // scores well on it under perfectly flat light, which is exactly what the
  // pre-fix build did (0.455, comfortably over any threshold, on a frame the
  // review called flat). It is reported for continuity and nothing else.
  //
  // lightCV is the one that means something. Dividing the composite by the
  // ambient-only render cancels albedo — both renders see the same surface, so
  // the ratio is illumination over illumination — and leaves a per-block map of
  // how much MORE light each patch of ground receives than the uniform sky fill
  // alone would give it. Flat lighting makes that ratio constant everywhere;
  // pools under fixtures with darkness between them make it vary by several
  // times. This is the number that says "there are lamps here", and it cannot be
  // faked by a dark prop in the foreground.
  const B = 48;
  const means = [];
  const ratios = [];
  for (let by = 0; by + B <= bh; by += B) {
    for (let bx = 0; bx + B <= bw; bx += B) {
      let s = 0, sa = 0;
      for (let y = by; y < by + B; y++) {
        for (let x = bx; x < bx + B; x++) {
          const i = ((y + y0) * W + (x + x0)) * 4;
          s += lum(lit, i); sa += lum(amb, i);
        }
      }
      means.push(s / (B * B));
      // +2 codes on both sides so a block that is black in BOTH renders reports
      // a ratio of 1 rather than a noise-driven excursion.
      ratios.push((s / (B * B) + 2) / (sa / (B * B) + 2));
    }
  }
  const cv = (arr) => {
    let s = 0; for (const v of arr) s += v;
    const m = s / Math.max(1, arr.length);
    if (m <= 1e-3) return 0;
    let q = 0; for (const v of arr) q += (v - m) * (v - m);
    return Math.sqrt(q / Math.max(1, arr.length)) / m;
  };
  let ms = 0; for (const m of means) ms += m;
  const mu = ms / Math.max(1, means.length);
  const blockCV = cv(means);
  const lightCV = cv(ratios);

  // ---- foreground vs distance ---------------------------------------------
  // Nearest ground rows (bottom of frame) against the farthest rows of the band.
  const rowMean = (ya, yb) => {
    let s = 0, c = 0;
    for (let y = ya; y < yb; y++) {
      for (let x = x0; x < x1; x++) { s += lum(lit, (y * W + x) * 4); c++; }
    }
    return c ? s / c : 0;
  };
  const nearL = rowMean(y0, y0 + Math.floor(bh * 0.22));
  const farL = rowMean(y1 - Math.floor(bh * 0.22), y1);
  const nearFar = farL > 1e-3 ? nearL / farL : 0;

  // ---- overall ground chroma (is it rendering at daytime warmth?) ---------
  let gr = 0, gg = 0, gb = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * W + x) * 4;
      gr += lit[i]; gg += lit[i + 1]; gb += lit[i + 2];
    }
  }
  const groundWarmth = (gr + gg + gb) > 1e-3 ? (gr - gb) / (gr + gg + gb) : 0;

  return {
    keyShare, practShare, ambShare, skyShare, keyWarmth, keyEdgeP99, keyEdgeP995,
    blockCV, lightCV, nearFar, nearL, farL, groundWarmth,
    groundMean: mu, samples: n,
    gpu: { withCones, withoutCones, coneInstances: cones ? cones.count : 0 },
    // Reported so a run can never quietly be an unfrozen-meter run again.
    meterFrozen: !!ae,
    keyIntensity: saved.length ? saved[0] : 0,
    practicals: (() => {
      let c = 0, lit2 = 0;
      eng.scene.traverse((o) => {
        if (o.isPointLight) { c++; if (o.intensity * Math.max(o.color.r, o.color.g, o.color.b) > 0.5) lit2++; }
      });
      return { total: c, lit: lit2 };
    })(),
  };
}`;

/** The ground band, in fractions of frame height measured from the BOTTOM. */
const BAND = [0.03, 0.40];

const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=d3d11', '--enable-unsafe-swiftshader',
    '--disable-gpu-sandbox', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

if (dump) fs.mkdirSync(dump, { recursive: true });

const results = {};
for (const key of presets) {
  const q = `freeze=1&hud=0&vm=0&quality=cinematic&tod=${key}&${FRAMING}`;
  await page.goto(`${url}/?${q}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  try {
    await page.waitForFunction('window.__ready === true', null, { timeout: 240000 });
  } catch {
    console.error(`[nightcheck] ${key}: app never became ready`);
    errors.push(`${key}: never ready`);
    continue;
  }
  await page.waitForTimeout(1400);
  if (dump) await page.screenshot({ path: path.join(dump, `${key}.png`) });
  results[key] = await page.evaluate(`(${PROBE})(${JSON.stringify(BAND)})`).catch((e) => {
    console.error(`[nightcheck] ${key}: probe threw:`, e.message);
    errors.push(`${key}: probe threw ${e.message}`);
    return null;
  });
  const r = results[key];
  if (!r) { delete results[key]; continue; }
  console.log(
    `[nightcheck] ${key.padEnd(9)} ` +
    `key/pract/sky=${r.keyShare.toFixed(1)}/${r.practShare.toFixed(1)}/${r.skyShare.toFixed(1)}% ` +
    `keyEdgeP995=${r.keyEdgeP995.toFixed(2)} keyWarmth=${r.keyWarmth.toFixed(3)} ` +
    `lightCV=${r.lightCV.toFixed(3)} blockCV=${r.blockCV.toFixed(3)} ` +
    `nearFar=${r.nearFar.toFixed(2)} groundWarmth=${r.groundWarmth.toFixed(3)} ` +
    `lamps=${r.practicals.lit}/${r.practicals.total}` +
    (r.meterFrozen ? '' : '  [WARNING: exposure meter could NOT be frozen]'),
  );
  if (r.gpu.coneInstances) {
    console.log(
      `[nightcheck] ${' '.repeat(9)} gpu ${r.gpu.coneInstances} cones: ` +
      `median ${r.gpu.withCones.median.toFixed(2)}ms / p95 ${r.gpu.withCones.p95.toFixed(2)}ms  ` +
      `without: median ${r.gpu.withoutCones.median.toFixed(2)}ms / p95 ${r.gpu.withoutCones.p95.toFixed(2)}ms`,
    );
  }
}
await browser.close();

// ---- gates -----------------------------------------------------------------
const midday = results.midday?.keyEdgeP995 ?? null;
const fails = [];
const pass = [];
for (const key of Object.keys(results)) {
  const g = GATES[key];
  if (!g) continue;
  const r = results[key];
  const check = (ok, label) => (ok ? pass : fails).push(`${key}: ${label}`);
  if (g.maxKeyEdge !== null) {
    check(r.keyEdgeP995 <= g.maxKeyEdge,
      `keyEdgeP995 ${r.keyEdgeP995.toFixed(2)} <= ${g.maxKeyEdge}  (hard key shadow edges on ground)`);
  }
  if (g.maxEdgeVsMidday !== null && midday) {
    const ratio = r.keyEdgeP995 / midday;
    check(ratio <= g.maxEdgeVsMidday,
      `keyEdge vs midday ${ratio.toFixed(2)} <= ${g.maxEdgeVsMidday}`);
  }
  if (g.maxKeyWarmth !== null) {
    check(r.keyWarmth <= g.maxKeyWarmth,
      `keyWarmth ${r.keyWarmth.toFixed(3)} <= ${g.maxKeyWarmth}  (key must be cool below the horizon)`);
  }
  if (g.minLightCV !== null) {
    check(r.lightCV >= g.minLightCV,
      `lightCV ${r.lightCV.toFixed(3)} >= ${g.minLightCV}  (albedo-cancelled: pools + darkness, not a flat plate)`);
  }
  if (g.maxSkyShare !== null) {
    check(r.skyShare <= g.maxSkyShare,
      `skyShare ${r.skyShare.toFixed(1)}% <= ${g.maxSkyShare}%  (the fixtures light this scene, not the sky)`);
  }
  if (g.minNearFar !== null) {
    check(r.nearFar >= g.minNearFar,
      `nearFar ${r.nearFar.toFixed(2)} >= ${g.minNearFar}  (falloff foreground -> 20 m)`);
  }
  if (g.minKeyEdge !== null) {
    check(r.keyEdgeP995 >= g.minKeyEdge,
      `keyEdgeP995 ${r.keyEdgeP995.toFixed(2)} >= ${g.minKeyEdge}  (sun presets keep their cast shadows)`);
  }
}

for (const p of pass) console.log(`  PASS  ${p}`);
for (const f of fails) console.log(`  FAIL  ${f}`);
if (errors.length) console.error(`[nightcheck] ${errors.length} page error(s):`, errors.slice(0, 5));

if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ results, pass, fails, errors }, null, 2));
console.log(`[nightcheck] ${pass.length} pass, ${fails.length} fail`);
process.exitCode = fails.length || errors.length ? 1 : 0;
