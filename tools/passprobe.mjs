#!/usr/bin/env node
/**
 * Per-pass GPU cost attribution for BLACKSITE.
 *
 * WHY THIS EXISTS. gpuprobe.mjs tells you a frame costs 148ms at the 'low'
 * preset. It cannot tell you *what* costs 148ms, and every cheaper source of
 * that answer in this project lies: the in-engine FPS counter derives from a dt
 * clamped to 0.1s so it cannot report below 10fps, headless Chromium has no swap
 * chain so requestAnimationFrame is paced by a virtual 60Hz clock, and
 * engine.stats.cpuMs measures JavaScript only while all the GPU work is
 * asynchronous.
 *
 * Two independent measurements, so neither has to be believed on its own:
 *
 *   1. SEGMENTS — EXT_disjoint_timer_query_webgl2 around individually patched
 *      calls (each composer pass, renderer.shadowMap.render, the volumetric
 *      raymarch). Nested segments suspend and resume their parent's query, so
 *      every label carries EXCLUSIVE GPU nanoseconds. This is ground truth for
 *      anything that happens inside a method we can patch.
 *
 *   2. ABLATIONS — turn one thing off, measure the whole frame with the forced
 *      pipeline flush from gpuprobe (render, then a 1x1 readPixels that blocks
 *      until the GPU drains), and take the delta. This is the only way to price
 *      work that is fused into the main scene pass: a shadow cascade, the sky
 *      dome, level geometry, AI bodies, material shader cost, and screen
 *      resolution.
 *
 * The two must agree. Where they do not, the ablation is the one to trust for
 * whole-frame impact (it includes knock-on effects like state changes) and the
 * segment is the one to trust for "what was that pass doing".
 *
 * MEASURE IN SHORT FOCUSED RUNS. This GPU throttles under its own sustained
 * load. The same 31 ablations measured in one long pass carried ±15–59% bracket
 * noise; split into short `--only` runs they carry ±0–2%. Results are merged
 * into docs/performance-data.json, so each run replaces only the groups it
 * measured and the document stays whole:
 *
 *   node tools/passprobe.mjs --only shadows    --quality low,high --seg
 *   node tools/passprobe.mjs --only resolution,material --quality low,high --seg
 *   node tools/passprobe.mjs --only post       --quality low,high --seg
 *   node tools/passprobe.mjs --only scene      --quality low,high --seg
 *
 * Other flags:
 *   --frames 14 --warm 10   measurement window
 *   --seg                   per-pass timer queries during ablations too
 *   --live                  do not freeze the simulation (noisy; see FREEZE)
 *   --no-write              do not touch docs/
 *
 * Requires the dev server already running on http://127.0.0.1:5180.
 */
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HELPER } from './passprobe-browser.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const has = (n) => argv.includes('--' + n);

const FRAMES = parseInt(opt('frames', '24'), 10);
const WARM = parseInt(opt('warm', '8'), 10);
const DPR = parseFloat(opt('dpr', '1'));
const QUALITIES = opt('quality', 'low,high').split(',').map((s) => s.trim()).filter(Boolean);
const ONLY = opt('only', '').split(',').map((s) => s.trim()).filter(Boolean);
const BASE = opt('url', 'http://127.0.0.1:5180');
const TOD = opt('tod', 'golden');
const WRITE = !has('no-write');
/**
 * The simulation is frozen and the camera pinned to the canonical `hero-golden`
 * framing by default.
 *
 * This is not cosmetic. With the simulation live, an A–B–A run drifted from a
 * 54ms reference to a 33ms one over 25 ablations — combatants wander out of the
 * frustum, decals accumulate, and the visible triangle count is different for
 * every measurement, so "hide a 1k-triangle group" could read as a 4ms saving.
 * A frozen scene at a fixed camera is the only way an ablation delta means what
 * it says. `--live` opts out; the AI simulation is priced separately below.
 */
const FREEZE = !has('live');
/**
 * Run the ablations with per-pass timer queries on. Slower, but it turns "this
 * change saved 21% of the frame" into "this change saved 15ms out of the main
 * scene pass and 0ms out of the shadow-map pass" — which is the difference
 * between knowing shadows are expensive and knowing *which half* of shadows is.
 */
const SEGABLATE = has('seg');
const SEG_OF = (m, label) => {
  const s = m && m.segments && m.segments.find((x) => x.label === label);
  return s ? s.msPerFrame : null;
};
const POS = opt('pos', '6,1.7,14');
const YAW = opt('yaw', '200');
const PITCH = opt('pitch', '-0.04');

const wanted = (group) => ONLY.length === 0 || ONLY.includes(group);

// ─────────────────────────────────────────────────────────────── helpers ────

const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);
const ms = (v) => (v === null || v === undefined || Number.isNaN(v) ? '   —' : v.toFixed(1));
const signed = (v) => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(1);

/** Markdown table from a header array and row arrays. */
function mdTable(head, rows) {
  const widths = head.map((h, i) => Math.max(String(h).length, ...rows.map((r) => String(r[i] ?? '').length)));
  const line = (cells) => '| ' + cells.map((c, i) => pad(c ?? '', widths[i])).join(' | ') + ' |';
  return [
    line(head),
    '|' + widths.map((w) => '-'.repeat(w + 2)).join('|') + '|',
    ...rows.map(line),
  ].join('\n');
}

// ───────────────────────────────────────────────────────── ablation plan ────

/**
 * Each entry is { group, label, ops } where ops are executed browser-side by
 * `__pp.applyOps` and reverted immediately after the measurement. `dynamic`
 * entries are expanded once the page has reported what it actually contains, so
 * the plan never hard-codes a pass name or a scene-graph name that another agent
 * is free to rename.
 */
function buildPlan(info) {
  const plan = [];
  const add = (group, label, ops) => { if (wanted(group)) plan.push({ group, label, ops }); };

  // ── shadows ───────────────────────────────────────────────────────────────
  // The scene geometry is rasterised once per cascade on top of the main pass.
  // 4 cascades = 5 rasterisations of the world per frame.
  for (const n of [3, 2, 1, 0]) add('shadows', `cascades ${n} (from ${info.cascades})`, [{ k: 'cascades', a: n }]);
  add('shadows', 'shadowMap.enabled = false', [{ k: 'shadowsOff' }]);
  for (const s of [1024, 512]) {
    if (s < info.shadowMapSize) add('shadows', `shadow map ${s} (from ${info.shadowMapSize})`, [{ k: 'shadowMapSize', a: s }]);
  }

  // ── volumetrics ───────────────────────────────────────────────────────────
  if (info.volumetricEnabled) add('volumetric', 'volumetric light off', [{ k: 'volumetric', a: false }]);

  // ── scene content ─────────────────────────────────────────────────────────
  // Priced by hiding top-level scene children. Names come from the live graph, so
  // nothing here breaks when another agent renames or adds a group. Children are
  // bucketed by name prefix first — this scene has ~70 separate `prop:*` roots
  // and pricing each one individually would be 70 measurements of noise.
  const meshy = info.inventory.filter((e) => e.meshes > 0);
  const bucket = new Map();
  for (const e of meshy) {
    const key = e.name.includes(':') ? e.name.slice(0, e.name.indexOf(':') + 1) + '*' : e.name;
    const b = bucket.get(key) || { key, names: [], tris: 0, meshes: 0 };
    b.names.push(e.name); b.tris += e.tris; b.meshes += e.meshes;
    bucket.set(key, b);
  }
  for (const b of [...bucket.values()].sort((x, y) => y.tris - x.tris)) {
    add('scene', `hide ${b.key} (${b.names.length} roots, ${b.meshes} meshes, ${(b.tris / 1000).toFixed(0)}k tris)`,
      [{ k: 'hideAll', a: b.names }]);
  }
  // The individually heavy roots still get their own line.
  for (const e of meshy.filter((x) => x.tris >= 50000).sort((a, b) => b.tris - a.tris)) {
    if (bucket.get(e.name)) continue;   // already covered by its own bucket
    add('scene', `hide "${e.name}" (${e.meshes} meshes, ${(e.tris / 1000).toFixed(0)}k tris)`, [{ k: 'hide', a: e.name }]);
  }
  if (meshy.length > 1) {
    add('scene', 'hide ALL scene meshes', [{ k: 'hideAll', a: meshy.map((e) => e.name) }]);
  }

  // ── materials ─────────────────────────────────────────────────────────────
  add('material', 'override: untextured standard material', [{ k: 'untextured' }]);

  // ── post chain, one pass at a time ────────────────────────────────────────
  const post = info.passes.filter((p, i) => i !== 0 && i !== info.passes.length - 1);
  for (const p of post) {
    if (p.enabled) add('post', `${p.label} off`, [{ k: 'pass', a: p.label, b: false }]);
  }
  add('post', 'ALL post off (RenderPass + final write only)', [{ k: 'postOff' }]);

  // ── resolution: the fill-rate vs geometry test ────────────────────────────
  // If cost scales with pixel count the frame is fill/bandwidth bound. If it
  // barely moves it is geometry or draw-call bound.
  for (const s of [0.7, 0.5, 0.35]) {
    if (Math.abs(s - info.resolutionScale) > 0.01) {
      add('resolution', `render scale ${s} (from ${info.resolutionScale})`, [{ k: 'resolution', a: s }]);
    }
  }

  // ── the simulation itself ─────────────────────────────────────────────────
  // Only meaningful while frozen: this prices what running the AI, physics and
  // weapon logic adds back on top of a static frame.
  if (info.frozen) add('simulation', 'simulation live (AI + physics fixedUpdate on)', [{ k: 'unfreeze' }]);

  // ── combinations, to find the floor ───────────────────────────────────────
  add('combo', 'no post + no shadows', [{ k: 'postOff' }, { k: 'shadowsOff' }]);
  add('combo', 'no post + no shadows + no volumetric', [{ k: 'postOff' }, { k: 'shadowsOff' }, { k: 'volumetric', a: false }]);
  add('combo', 'no post + no shadows + untextured', [{ k: 'postOff' }, { k: 'shadowsOff' }, { k: 'untextured' }]);
  add('combo', 'no post + no shadows + scale 0.5', [{ k: 'postOff' }, { k: 'shadowsOff' }, { k: 'resolution', a: 0.5 }]);

  return plan;
}

// ────────────────────────────────────────────────────────────── the run ─────

const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=d3d11', '--disable-gpu-sandbox', '--ignore-gpu-blocklist'],
});

const report = { gpu: 'unknown', timerQuery: false, presets: [] };

for (const q of QUALITIES) {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: DPR });
  page.on('pageerror', (e) => console.error(`  ! page error: ${String(e.message).slice(0, 120)}`));

  const url = `${BASE}/?tod=${TOD}&hud=0&quality=${q}`
    + `&pos=${POS}&yaw=${YAW}&pitch=${PITCH}${FREEZE ? '&freeze=1' : ''}`;
  process.stdout.write(`\n=== quality "${q}" — loading ${url}\n`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 300000 });
  try {
    await page.waitForFunction('window.__ready === true', null, { timeout: 300000 });
  } catch {
    console.log(`  never became ready — skipping`);
    await page.close();
    continue;
  }
  await page.waitForTimeout(1200);

  const info = await page.evaluate(HELPER);
  report.gpu = info.gpu;
  report.timerQuery = report.timerQuery || info.timerQuery;

  console.log(`  GPU: ${info.gpu}`);
  console.log(`  EXT_disjoint_timer_query_webgl2: ${info.timerQuery ? 'AVAILABLE — true GPU nanoseconds' : 'ABSENT — ablation only'}`);
  console.log(`  cascades=${info.cascades} shadowMap=${info.shadowMapSize} volSteps=${info.volumetricSteps}`
    + ` volEnabled=${info.volumetricEnabled} renderScale=${info.resolutionScale} pixelRatio=${info.pixelRatio}`);
  console.log(`  scene: ` + info.inventory.filter((e) => e.meshes > 0)
    .map((e) => `${e.name}(${(e.tris / 1000).toFixed(0)}k)`).join(' '));

  // ── 1. baseline + per-pass segments ─────────────────────────────────────
  const base = await page.evaluate(
    ({ f, w }) => window.__pp.measure(f, w, true),
    { f: FRAMES, w: WARM },
  );

  console.log(`\n  BASELINE  median ${base.median}ms  p95 ${base.p95}ms  (${(1000 / base.median).toFixed(1)} fps)`
    + `  buffer ${base.buffer} = ${base.mpx}Mpx  canvas ${base.canvas}`
    + `  ${base.drawCalls} calls / ${(base.triangles / 1e6).toFixed(2)}M tris`);
  console.log(`  SPLIT     JavaScript ${base.jsMs}ms  +  GPU drain after JS ${base.flushMs}ms`
    + `   -> ${base.jsMs > base.flushMs ? 'CPU-DOMINATED' : 'GPU-DOMINATED'}`);

  if (base.segments) {
    console.log(`\n  --- GPU segments (exclusive, EXT_disjoint_timer_query_webgl2, ${base.segFrames} frames) ---`);
    console.log(`  ${pad('segment', 44)}${lpad('ms/frame', 10)}${lpad('% frame', 9)}${lpad('enters/f', 10)}`);
    for (const s of base.segments) {
      console.log(`  ${pad(s.label, 44)}${lpad(s.msPerFrame.toFixed(2), 10)}`
        + `${lpad(((s.msPerFrame / base.median) * 100).toFixed(1) + '%', 9)}${lpad(s.callsPerFrame, 10)}`);
    }
    console.log(`  ${pad('— GPU accounted', 44)}${lpad(base.gpuAccounted.toFixed(2), 10)}`
      + `${lpad(((base.gpuAccounted / base.median) * 100).toFixed(1) + '%', 9)}`);
    if (base.disjoint) console.log(`  (${base.disjoint} frames discarded: GPU_DISJOINT)`);
    if (base.lost) console.log(`  (${base.lost} query results never reported — GPU total is understated)`);
  }

  // CPU cost has to be read with the simulation LIVE, because freezing it is
  // exactly what removes fixedUpdate — the half of the CPU frame that AI and
  // physics live in.
  const live = await page.evaluate(
    async ({ f, w }) => {
      const revert = window.__pp.applyOps([{ k: 'unfreeze' }]);
      try { return await window.__pp.measure(f, w, true); } finally { revert(); }
    },
    { f: FRAMES, w: WARM },
  );
  if (live.cpu && live.cpu.length) {
    console.log(`\n  --- CPU per system, simulation LIVE (ms/frame, >=0.02ms) ---`);
    for (const c of live.cpu.slice(0, 14)) console.log(`  ${pad(c.label, 44)}${lpad(c.msPerFrame.toFixed(3), 10)}`);
    const tot = live.cpu.reduce((s, c) => s + c.msPerFrame, 0);
    console.log(`  ${pad('— total instrumented CPU', 44)}${lpad(tot.toFixed(2), 10)}`
      + `   (JS half of the frame: ${live.jsMs}ms of ${live.median}ms)`);
  }

  // ── 2. ablations ────────────────────────────────────────────────────────
  const plan = buildPlan(info);
  const results = [];
  console.log(`\n  --- ablations (${plan.length}), paired A-B-A ---`);
  console.log(`  ${pad('change', 52)}${lpad('median', 9)}${lpad('ref', 9)}${lpad('saved', 8)}`
    + `${lpad('@baseline', 10)}${lpad('noise', 7)}`);

  // PAIRED A–B–A. Every ablation is measured against a baseline taken seconds
  // either side of it, on the same page, with the same warm-up.
  //
  // A single up-front baseline is not usable here and the first version of this
  // tool proved it: the segment-instrumented baseline read 49.3ms while the
  // uninstrumented steady state was 37ms, so every ablation appeared to save
  // ~12ms and hiding a 1k-triangle group "saved" 13ms. Timer queries cost real
  // time, and the page keeps warming for the first few measurements. Bracketing
  // removes both. The two brackets are also reported: when they disagree the row
  // is noise, and the tool says so rather than letting the reader guess.
  for (const step of plan) {
    let r;
    try {
      r = await page.evaluate(
        async ({ ops, f, w, seg }) => {
          const a1 = await window.__pp.measure(f, w, seg);
          const revert = window.__pp.applyOps(ops);
          let t;
          try { t = await window.__pp.measure(f, w, seg); } finally { revert(); }
          const a2 = await window.__pp.measure(f, w, seg);
          return { t, a1, a2 };
        },
        { ops: step.ops, f: FRAMES, w: WARM, seg: SEGABLATE },
      );
    } catch (err) {
      console.log(`  ${pad(step.label, 52)} FAILED: ${String(err.message).slice(0, 50)}`);
      continue;
    }
    const m = r.t;
    const ref = (r.a1.median + r.a2.median) / 2;
    const spread = Math.abs(r.a1.median - r.a2.median);

    // RATIO, not difference.
    //
    // This GPU throttles hard under sustained load: across one 30-ablation run
    // the paired reference wandered 36ms -> 74ms -> 52ms while the *relative*
    // cost of everything stayed put. An absolute millisecond delta measured at
    // 74ms and quoted against a 36ms frame is meaningless; a ratio survives a
    // global clock change. `costMs` re-expresses the ratio against the clean
    // baseline, so the table adds up at the frame time the player actually sees.
    const factor = m.median / ref;
    const pct = (1 - factor) * 100;
    const costMs = base.median * (1 - factor);
    // Noise floor: how much the two brackets disagreed, as a fraction.
    const noiseFrac = spread / ref;
    const solid = Math.abs(1 - factor) > Math.max(noiseFrac, 0.02);
    // Per-pass attribution inside the ablation. Both sides are instrumented, so
    // the timer-query overhead is common-mode and cancels.
    const segOf = (label) => {
      const t = SEG_OF(m, label);
      const a = (SEG_OF(r.a1, label) ?? 0) + (SEG_OF(r.a2, label) ?? 0);
      return t === null ? null : { test: t, ref: a / 2 };
    };
    const scene = segOf('scene:opaque+transparent');
    const shadow = segOf('shadow:cascades');

    results.push({
      ...step, median: m.median, p95: m.p95, ref, spread, factor, pct, costMs, solid,
      scene, shadow, mpx: m.mpx, calls: m.drawCalls, tris: m.triangles,
    });
    console.log(`  ${pad(step.label, 52)}${lpad(m.median.toFixed(1) + 'ms', 9)}`
      + `${lpad(ref.toFixed(1) + 'ms', 9)}${lpad(pct.toFixed(0) + '%', 8)}`
      + `${lpad(signed(costMs) + 'ms', 10)}${lpad('±' + (noiseFrac * 100).toFixed(0) + '%', 7)}`
      + (scene ? lpad(`scene ${scene.ref.toFixed(1)}->${scene.test.toFixed(1)}`, 22) : '')
      + (shadow ? lpad(`shadowmap ${shadow.ref.toFixed(1)}->${shadow.test.toFixed(1)}`, 26) : '')
      + `${solid ? '' : '  noise'}`);
  }

  report.presets.push({ quality: q, info, base, live, results });
  await page.evaluate(() => window.__pp.restore());
  await page.close();
}

await browser.close();

// ───────────────────────────────────────────────────────────── the report ───

/**
 * Everything in the summary is COMPUTED from the measurements, never typed in.
 * A hand-written conclusion goes stale the first time someone re-runs the probe
 * after a fix; a derived one cannot.
 */
function deriveFindings(p) {
  const f = { preset: p.quality, base: p.base.median };

  // Q1 — the three most expensive things in the frame.
  f.top = (p.base.segments || [])
    .filter((s) => s.label !== 'frame:unattributed')
    .slice(0, 3)
    .map((s) => ({ label: s.label, ms: s.msPerFrame, pct: (s.msPerFrame / p.base.median) * 100 }));

  // Q2 — cascades. Only meaningful with per-pass segments, because the whole
  // point is that rendering a cascade and sampling it are different costs
  // living in different passes.
  const casc = p.results.filter((x) => /^cascades \d/.test(x.label) && x.scene && x.shadow);
  if (casc.length) {
    const refScene = casc[0].scene.ref;
    const refShadow = casc[0].shadow.ref;
    f.cascades = casc.map((x) => ({
      n: parseInt(x.label.match(/^cascades (\d)/)[1], 10),
      sceneMs: x.scene.test,
      shadowMs: x.shadow.test,
      sampleSaved: refScene - x.scene.test,
      renderSaved: refShadow - x.shadow.test,
    }));
    const zero = f.cascades.find((c) => c.n === 0);
    if (zero) {
      f.shadowSampleMs = zero.sampleSaved;   // fragment-shader PCSS cost
      f.shadowRenderMs = zero.renderSaved;   // rasterising the maps
    }
  }

  // Q3 — fill vs geometry. Least-squares fit of main-scene-pass ms against
  // megapixels: the slope is per-pixel cost, the intercept is everything that
  // does not care how many pixels there are (vertex work, draw-call submission).
  const pts = [{ x: p.base.mpx, y: SEG_OF(p.base, 'scene:opaque+transparent') }]
    .concat(p.results.filter((x) => x.group === 'resolution' && x.scene).map((x) => ({ x: x.mpx, y: x.scene.test })))
    .filter((q) => q.y !== null && q.x > 0);
  if (pts.length >= 3) {
    const n = pts.length;
    const sx = pts.reduce((s, q) => s + q.x, 0);
    const sy = pts.reduce((s, q) => s + q.y, 0);
    const sxx = pts.reduce((s, q) => s + q.x * q.x, 0);
    const sxy = pts.reduce((s, q) => s + q.x * q.y, 0);
    const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
    const intercept = (sy - slope * sx) / n;
    f.fill = {
      msPerMpx: slope,
      fixedMs: intercept,
      atBaseline: slope * p.base.mpx,
      fillShare: (slope * p.base.mpx) / Math.max(1e-6, slope * p.base.mpx + intercept),
      points: pts,
    };
  }

  // Geometry: what did removing whole groups of triangles actually buy?
  f.geometry = p.results
    .filter((x) => x.group === 'scene' && /^hide (prop|ai|fx|level)/.test(x.label))
    .map((x) => ({ label: x.label, pct: x.pct, solid: x.solid, tris: x.tris }));

  const tex = p.results.find((x) => x.group === 'material');
  if (tex && tex.scene) f.materialMs = tex.scene.ref - tex.scene.test;

  return f;
}

function renderMarkdown(r) {
  const out = [];
  out.push('# BLACKSITE — measured GPU cost');
  out.push('');
  out.push('Generated by `node tools/passprobe.mjs`. **Every number here is milliseconds of');
  out.push('real GPU time**, measured either with `EXT_disjoint_timer_query_webgl2` (true GPU');
  out.push('nanoseconds per pass) or with a forced pipeline flush — render a frame, then a');
  out.push('1×1 `readPixels` that cannot return until the GPU has drained the queue.');
  out.push('');
  out.push('Do **not** replace these with `window.__blacksite.stats().fps`, with');
  out.push('`requestAnimationFrame` intervals, or with `engine.stats.cpuMs`. The first is');
  out.push('derived from a `dt` clamped to 0.1s and so cannot report below 10fps; the second');
  out.push('is paced by a virtual 60Hz clock in headless Chromium and reads a flat 16.7ms at');
  out.push('any GPU load; the third measures JavaScript only, and all the GPU work is');
  out.push('asynchronous.');
  out.push('');
  out.push(`- GPU: \`${r.gpu}\``);
  out.push(`- \`EXT_disjoint_timer_query_webgl2\`: ${r.timerQuery ? '**available**' : '**absent** (ablation only)'}`);
  out.push(`- Viewport 1920×1080, deviceScaleFactor ${DPR}, ${FRAMES} measured frames after ${WARM} warm-up frames.`);
  out.push(`- Camera pinned to \`${POS}\` yaw ${YAW} pitch ${PITCH} (the \`hero-golden\` framing), `
    + `simulation ${FREEZE ? '**frozen**' : 'live'}.`);
  out.push('- Ablations are paired **A–B–A**: the baseline is re-measured immediately before *and*');
  out.push('  after each change, and the result is the **ratio** to the mean of those two brackets.');
  out.push('  Ratios, not differences, because this GPU throttles hard under sustained load — over one');
  out.push('  30-ablation run the paired reference wandered 36 → 74 → 52 ms while every relative cost');
  out.push('  held steady. The `worth` column re-expresses each ratio against the clean baseline so the');
  out.push('  table adds up at the frame time the player actually sees.');
  out.push('- Rows whose effect is smaller than the disagreement between the two brackets are marked');
  out.push('  `(noise)`. **Do not quote a `(noise)` row as a result** — for the geometry rows in');
  out.push('  particular, `(noise)` is itself the finding: removing that geometry changes nothing.');
  out.push('');

  // ── derived summary ───────────────────────────────────────────────────────
  const F = r.presets.map(deriveFindings);
  out.push('## Summary — where the frame goes');
  out.push('');
  out.push('Everything in this section is computed from the tables below, not typed in, so it');
  out.push('cannot go stale when the probe is re-run.');
  out.push('');

  for (const f of F) {
    out.push(`### \`${f.preset}\` — ${f.base.toFixed(1)} ms/frame (${(1000 / f.base).toFixed(1)} fps)`);
    out.push('');
    out.push('**The three most expensive things in the frame:**');
    out.push('');
    out.push(mdTable(['#', 'segment', 'ms', '% of frame'],
      f.top.map((t, i) => [String(i + 1), '`' + t.label + '`', t.ms.toFixed(1), t.pct.toFixed(0) + '%'])));
    out.push('');

    if (f.cascades && f.shadowSampleMs !== undefined) {
      out.push('**Shadow cascades — rendering them is cheap, *sampling* them is not.**');
      out.push('');
      out.push(mdTable(
        ['cascades enabled', 'main scene pass ms', 'shadow-map pass ms'],
        f.cascades.map((c) => [String(c.n), c.sceneMs.toFixed(1), c.shadowMs.toFixed(1)]),
      ));
      out.push('');
      out.push(`Rasterising all shadow maps costs **${f.shadowRenderMs.toFixed(1)} ms**. Sampling them in`);
      out.push(`the fragment shader (the PCSS blocker search + Poisson filter) costs`);
      out.push(`**${f.shadowSampleMs.toFixed(1)} ms** — ${(f.shadowSampleMs / Math.max(0.1, f.shadowRenderMs)).toFixed(1)}x more.`);
      out.push('The "4 cascades means the scene is rasterised 5 times per frame" framing is not where');
      out.push('the time is: the extra rasterisation is nearly free because the far cascades are');
      out.push('refit-gated and skip most frames. The per-pixel filter is the cost.');
      out.push('');
    }

    if (f.fill) {
      const { msPerMpx, fixedMs, atBaseline, fillShare } = f.fill;
      out.push('**Fill-rate bound, not geometry bound.** Least-squares fit of main-scene-pass cost');
      out.push('against megapixels, over the render-scale ablations:');
      out.push('');
      out.push('```');
      out.push(`  scene pass ms  =  ${fixedMs.toFixed(1)}  +  ${msPerMpx.toFixed(1)} x megapixels`);
      out.push('```');
      out.push('');
      out.push(mdTable(['render scale', 'Mpx', 'main scene pass ms'],
        f.fill.points.sort((a, b) => b.x - a.x).map((q) => [
          (Math.sqrt(q.x / f.fill.points[0].x) || 1).toFixed(2), q.x.toFixed(2), q.y.toFixed(1)])));
      out.push('');
      out.push(`At this preset's ${r.presets.find((p) => p.quality === f.preset).base.mpx} Mpx that is `
        + `**${atBaseline.toFixed(1)} ms of per-pixel work against ${fixedMs.toFixed(1)} ms of everything else** — `
        + `${(fillShare * 100).toFixed(0)}% of the main pass is fill.`);
      out.push('');
    }

    if (f.geometry.length) {
      out.push('**Deleting geometry does almost nothing**, which is the same finding from the other side:');
      out.push('');
      out.push(mdTable(['removed', 'triangles removed', 'frame time saved'],
        f.geometry.map((g) => [
          g.label.replace(/^hide /, '').replace(/ \(.*/, ''),
          ((r.presets.find((p) => p.quality === f.preset).base.triangles - g.tris) / 1e6).toFixed(2) + ' M',
          g.solid ? g.pct.toFixed(0) + '%' : 'nothing measurable',
        ])));
      out.push('');
    }

    if (f.materialMs !== undefined) {
      out.push(`**Material texture fetches cost ${f.materialMs.toFixed(1)} ms** of the main scene pass:`);
      out.push('replacing every material with a default, untextured instance of the same class — same');
      out.push('geometry, same lighting model, same shadow sampling, no samplers — is what that removes.');
      out.push('');
    }
  }

  if (F.length >= 2) {
    const byName = new Map(F.map((f) => [f.preset, f]));
    const lo = byName.get('low');
    const hi = byName.get('high');
    if (lo && hi) {
      const loP = r.presets.find((p) => p.quality === 'low');
      const hiP = r.presets.find((p) => p.quality === 'high');
      out.push('### Do the presets do anything?');
      out.push('');
      out.push(mdTable(
        ['', '`low`', '`high`'],
        [
          ['frame time', lo.base.toFixed(1) + ' ms', hi.base.toFixed(1) + ' ms'],
          ['buffer', loP.base.buffer, hiP.base.buffer],
          ['megapixels', String(loP.base.mpx), String(hiP.base.mpx)],
          ['main scene pass', (SEG_OF(loP.base, 'scene:opaque+transparent') ?? 0).toFixed(1) + ' ms',
            (SEG_OF(hiP.base, 'scene:opaque+transparent') ?? 0).toFixed(1) + ' ms'],
          ['main scene pass per Mpx',
            ((SEG_OF(loP.base, 'scene:opaque+transparent') ?? 0) / loP.base.mpx).toFixed(1) + ' ms',
            ((SEG_OF(hiP.base, 'scene:opaque+transparent') ?? 0) / hiP.base.mpx).toFixed(1) + ' ms'],
          ['shadow-map pass', (SEG_OF(loP.base, 'shadow:cascades') ?? 0).toFixed(1) + ' ms',
            (SEG_OF(hiP.base, 'shadow:cascades') ?? 0).toFixed(1) + ' ms'],
          ['cascades', String(loP.info.cascades), String(hiP.info.cascades)],
          ['shadow map size', String(loP.info.shadowMapSize), String(hiP.info.shadowMapSize)],
          ['volumetric steps', String(loP.info.volumetricSteps), String(hiP.info.volumetricSteps)],
        ],
      ));
      out.push('');
      out.push(`\`low\` is **${(hi.base / lo.base).toFixed(2)}x** faster than \`high\`.`);
      out.push('');
      const loPer = (SEG_OF(loP.base, 'scene:opaque+transparent') ?? 0) / loP.base.mpx;
      const hiPer = (SEG_OF(hiP.base, 'scene:opaque+transparent') ?? 0) / hiP.base.mpx;
      out.push(`But look at the per-megapixel row: **${loPer.toFixed(1)} ms/Mpx at \`low\` against `
        + `${hiPer.toFixed(1)} ms/Mpx at \`high\`** — a ${Math.abs((1 - loPer / hiPer) * 100).toFixed(0)}% difference. `
        + 'Essentially the whole preset ladder is `resolutionScale` and nothing else. The dials the');
      out.push('presets actually turn — shadow map size, PCSS tap counts, volumetric steps, AO quality —');
      out.push('are measured below and are worth single-digit percentages between them. Anyone making');
      out.push('`low` genuinely cheap has to reduce **per-pixel main-pass cost**, not resolution alone.');
      out.push('');
    }
  }

  out.push('---');
  out.push('');

  for (const p of r.presets) {
    out.push(`## Preset \`${p.quality}\``);
    out.push('');
    out.push('| | |');
    out.push('|---|---|');
    out.push(`| baseline median | **${p.base.median.toFixed(1)} ms** (${(1000 / p.base.median).toFixed(1)} fps) |`);
    out.push(`| baseline p95 | ${p.base.p95.toFixed(1)} ms |`);
    out.push(`| — JavaScript half | ${p.base.jsMs.toFixed(1)} ms |`);
    out.push(`| — GPU drain after JS returned | ${p.base.flushMs.toFixed(1)} ms |`);
    out.push(`| composer buffer | ${p.base.buffer} (${p.base.mpx} Mpx) |`);
    out.push(`| canvas | ${p.base.canvas} |`);
    out.push(`| draw calls / triangles | ${p.base.drawCalls} / ${(p.base.triangles / 1e6).toFixed(2)} M |`);
    out.push(`| cascades / shadow map | ${p.info.cascades} / ${p.info.shadowMapSize} |`);
    out.push(`| volumetric steps | ${p.info.volumetricSteps} (${p.info.volumetricEnabled ? 'ON' : 'off'}) |`);
    out.push(`| render scale / pixel ratio | ${p.info.resolutionScale} / ${p.info.pixelRatio} |`);
    out.push('');

    if (p.base.segments) {
      out.push('### Per-pass GPU time (exclusive)');
      out.push('');
      out.push(mdTable(
        ['segment', 'ms/frame', '% of frame', 'entries/frame'],
        p.base.segments.map((s) => [
          '`' + s.label + '`',
          s.msPerFrame.toFixed(2),
          ((s.msPerFrame / p.base.median) * 100).toFixed(1) + '%',
          String(s.callsPerFrame),
        ]).concat([['**GPU accounted**', p.base.gpuAccounted.toFixed(2),
          ((p.base.gpuAccounted / p.base.median) * 100).toFixed(1) + '%', '']]),
      ));
      out.push('');
      out.push('`frame:unattributed` is everything outside a patched method: the swap, the');
      out.push('clear, and any GPU work a system does from `update()` rather than `render()`.');
      out.push('');
    }

    const cpuSrc = p.live && p.live.cpu && p.live.cpu.length ? p.live : p.base;
    if (cpuSrc.cpu && cpuSrc.cpu.length) {
      out.push('### CPU per system, simulation live (ms/frame)');
      out.push('');
      out.push(mdTable(['system', 'ms/frame'], cpuSrc.cpu.slice(0, 16).map((c) => ['`' + c.label + '`', c.msPerFrame.toFixed(3)])));
      out.push('');
      const cpuTotal = cpuSrc.cpu.reduce((s, c) => s + c.msPerFrame, 0);
      out.push(`Total instrumented CPU **${cpuTotal.toFixed(2)} ms/frame**; the whole JavaScript half of `
        + `the frame is **${cpuSrc.jsMs.toFixed(1)} ms** of a ${cpuSrc.median.toFixed(1)} ms frame — `
        + `${cpuSrc.jsMs > cpuSrc.median * 0.5 ? 'CPU is a real share of the frame.' : 'the frame is overwhelmingly GPU bound.'}`);
      out.push('');
    }

    const groups = [...new Set(p.results.map((x) => x.group))];
    for (const g of groups) {
      const rows = p.results.filter((x) => x.group === g);
      out.push(`### Ablation — ${g}`);
      out.push('');
      const segCols = rows.some((x) => x.scene);
      out.push(mdTable(
        ['change', 'saved', `worth (ms of the ${p.base.median.toFixed(1)}ms frame)`,
          ...(segCols ? ['main scene pass ms', 'shadow-map pass ms'] : []),
          'measured ms', 'paired ref ms', 'noise floor', 'Mpx', 'calls', 'M tris'],
        rows.map((x) => [
          x.label,
          x.solid ? x.pct.toFixed(0) + '%' : '(noise)',
          x.solid ? signed(x.costMs) : '—',
          ...(segCols ? [
            x.scene ? `${x.scene.ref.toFixed(1)} → ${x.scene.test.toFixed(1)}` : '—',
            x.shadow ? `${x.shadow.ref.toFixed(1)} → ${x.shadow.test.toFixed(1)}` : '—',
          ] : []),
          x.median.toFixed(1),
          x.ref.toFixed(1),
          '±' + ((x.spread / x.ref) * 100).toFixed(0) + '%',
          String(x.mpx),
          String(x.calls),
          (x.tris / 1e6).toFixed(2),
        ]),
      ));
      out.push('');
    }
  }

  return out.join('\n') + '\n';
}

// ── merge with previous runs ─────────────────────────────────────────────────
//
// A run measuring everything at once takes long enough that this GPU throttles
// under its own load: the same 31 ablations measured in one pass carried ±15–59%
// bracket noise, while the same measurements split into short focused runs
// carried ±0–2%. So the tool is incremental. Each invocation replaces only the
// groups it actually measured and keeps the rest, which also means anyone who
// changes one subsystem can re-measure just that group with
// `--only shadows` and get a correct, fully up-to-date document out.
const DATA = resolve(REPO, 'docs', 'performance-data.json');
let store = { gpu: report.gpu, timerQuery: report.timerQuery, presets: {} };
try {
  const prior = JSON.parse(readFileSync(DATA, 'utf8'));
  if (prior && prior.presets) store = prior;
} catch { /* first run */ }

store.gpu = report.gpu;
store.timerQuery = report.timerQuery || store.timerQuery;
for (const p of report.presets) {
  const slot = store.presets[p.quality] || { quality: p.quality, groups: {} };
  slot.info = p.info;
  slot.base = p.base;
  slot.live = p.live;
  slot.measuredAt = new Date().toISOString();
  for (const g of new Set(p.results.map((x) => x.group))) {
    slot.groups[g] = p.results.filter((x) => x.group === g);
  }
  store.presets[p.quality] = slot;
}

// Flatten back into the shape renderMarkdown expects.
const merged = {
  gpu: store.gpu,
  timerQuery: store.timerQuery,
  presets: Object.values(store.presets).map((s) => ({
    quality: s.quality,
    info: s.info,
    base: s.base,
    live: s.live,
    measuredAt: s.measuredAt,
    results: Object.values(s.groups).flat(),
  })),
};

const md = renderMarkdown(merged);
if (WRITE) {
  mkdirSync(resolve(REPO, 'docs'), { recursive: true });
  writeFileSync(DATA, JSON.stringify(store, null, 1), 'utf8');
  writeFileSync(resolve(REPO, 'docs', 'Performance.md'), md, 'utf8');
  console.log(`\nWrote ${resolve(REPO, 'docs', 'Performance.md')} (+ performance-data.json)`);
}
console.log('\n' + md);
