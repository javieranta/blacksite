/**
 * Browser-side half of tools/passprobe.mjs.
 *
 * Exported as a template string that is injected with page.evaluate(). It never
 * ships to the game and it is never imported by src/ — it exists only so the
 * probe's page code can be linted, `node --check`ed and read as real source
 * instead of as one enormous escaped literal inside the driver.
 *
 * Everything it installs is additive and reversible: it patches methods on live
 * objects, keeps the originals, and `__pp.restore()` puts them all back.
 */

/* eslint-disable */
export const HELPER = String.raw`
(() => {
if (window.__pp) return window.__pp.info();

const eng = window.__blacksite.engine;
const ctx = eng.ctx;
const renderer = eng.renderer;
const gl = renderer.getContext();
const scene = eng.scene;

const postfx = eng.systems.get('postfx');
const lighting = eng.systems.get('lighting');
const composer = postfx && postfx.composer;
const csm = lighting && lighting.csm;

// ── GPU timer queries ──────────────────────────────────────────────────────
// EXT_disjoint_timer_query_webgl2 gives true GPU nanoseconds per segment. Under
// ANGLE/D3D11 it is usually present. If it is not, every number below falls back
// to the forced-flush wall clock, which can only time whole frames — so the
// per-pass table degrades to the ablation table.
const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2')
         || gl.getExtension('EXT_disjoint_timer_query');
const TIME_ELAPSED = ext ? (ext.TIME_ELAPSED_EXT !== undefined ? ext.TIME_ELAPSED_EXT : 0x88BF) : 0;
const GPU_DISJOINT = ext ? (ext.GPU_DISJOINT_EXT !== undefined ? ext.GPU_DISJOINT_EXT : 0x8FBB) : 0;
const timerOk = !!(ext && gl.createQuery);

const px = new Uint8Array(4);

// ── segment recorder ───────────────────────────────────────────────────────
// Segments nest (RenderPass contains the shadow-map render, which contains
// nothing). A TIME_ELAPSED query cannot nest, so a nested begin() suspends its
// parent by ending the parent's query and starting a fresh one for it on the way
// back out. Each label therefore accumulates EXCLUSIVE GPU time, which is what
// attribution actually wants.
const seg = {
  on: false,
  keep: false,        // are the queries being issued part of the measured window
  stack: [],          // label stack
  active: null,       // { label, q, keep }
  pending: [],        // { label, q, keep } — results are NOT ready immediately
  pool: [],
  totals: new Map(),  // label -> { ms, n, samples }
  entries: new Map(), // label -> real method-entry count
  frames: 0,
  disjoint: 0,
  lost: 0,
};

function getQuery() { return seg.pool.pop() || gl.createQuery(); }

function segBegin(label) {
  if (!seg.on || !timerOk) return;
  if (seg.active) { gl.endQuery(TIME_ELAPSED); seg.pending.push(seg.active); seg.active = null; }
  seg.stack.push(label);
  // Counted here and nowhere else, so it is the number of times the method was
  // really entered — not the number of GPU spans it was chopped into by a
  // nested segment suspending it.
  if (seg.keep) seg.entries.set(label, (seg.entries.get(label) || 0) + 1);
  const q = getQuery();
  gl.beginQuery(TIME_ELAPSED, q);
  seg.active = { label, q, keep: seg.keep };
}

function segEnd() {
  if (!seg.on || !timerOk) return;
  if (seg.active) { gl.endQuery(TIME_ELAPSED); seg.pending.push(seg.active); seg.active = null; }
  seg.stack.pop();
  const parent = seg.stack[seg.stack.length - 1];
  if (parent !== undefined) {
    const q = getQuery();
    gl.beginQuery(TIME_ELAPSED, q);
    seg.active = { label: parent, q, keep: seg.keep };
  }
}

/**
 * Harvest whatever is ready and leave the rest pending.
 *
 * A TIME_ELAPSED result is NOT available immediately after the readPixels that
 * drained the frame — under ANGLE/D3D11 it lands one or two host ticks later.
 * Draining eagerly and treating "not ready" as zero is how the first version of
 * this file reported a 37ms frame with 0.00ms of GPU work in it.
 */
function segHarvest() {
  const disjoint = ext ? gl.getParameter(GPU_DISJOINT) : false;
  if (disjoint) seg.disjoint++;
  let w = 0;
  for (let i = 0; i < seg.pending.length; i++) {
    const rec = seg.pending[i];
    if (!gl.getQueryParameter(rec.q, gl.QUERY_RESULT_AVAILABLE)) { seg.pending[w++] = rec; continue; }
    const ms = gl.getQueryParameter(rec.q, gl.QUERY_RESULT) / 1e6;
    if (rec.keep && !disjoint) {
      const t = seg.totals.get(rec.label) || { ms: 0, n: 0, samples: [] };
      t.ms += ms; t.n++; t.samples.push(ms);
      seg.totals.set(rec.label, t);
    }
    seg.pool.push(rec.q);
  }
  seg.pending.length = w;
  return w;
}

/** Poll until every issued query has reported, or give up and say so. */
async function segSettle() {
  gl.flush();
  for (let i = 0; i < 400 && segHarvest() > 0; i++) {
    await new Promise((r) => setTimeout(r, 2));
  }
  if (seg.pending.length) {
    seg.lost += seg.pending.filter((r) => r.keep).length;
    for (const r of seg.pending) seg.pool.push(r.q);
    seg.pending.length = 0;
  }
}

// ── CPU system timing ──────────────────────────────────────────────────────
const cpu = { on: false, totals: new Map(), frames: 0 };
function cpuAdd(label, ms) {
  if (!cpu.on) return;
  const t = cpu.totals.get(label) || { ms: 0, n: 0 };
  t.ms += ms; t.n++;
  cpu.totals.set(label, t);
}

// ── patching ───────────────────────────────────────────────────────────────
const undo = [];
function patch(obj, key, make) {
  if (!obj || typeof obj[key] !== 'function') return false;
  const orig = obj[key];
  obj[key] = make(orig);
  undo.push(() => { obj[key] = orig; });
  return true;
}

function passLabel(p, i) {
  const eff = p.effects;
  if (eff && eff.length) {
    return 'post:' + eff.map((e) => (e.name || e.constructor.name).replace(/Effect$/, '')).join('+');
  }
  const base = (p.constructor.name || p.name || ('pass' + i)).replace(/Pass$/, '');
  return (base === 'Render' ? 'scene:opaque+transparent' : 'post:' + base);
}

const passes = [];
if (composer) {
  composer.passes.forEach((p, i) => {
    const label = passLabel(p, i);
    passes.push({ label, pass: p, index: i, wasEnabled: p.enabled });
    patch(p, 'render', (orig) => function (...a) {
      segBegin(label);
      try { return orig.apply(this, a); } finally { segEnd(); }
    });
  });
}

// three renders every shadow map from inside renderer.render(), i.e. nested
// inside the RenderPass segment. Suspend/resume peels it back out.
patch(renderer.shadowMap, 'render', (orig) => function (...a) {
  segBegin('shadow:cascades');
  try { return orig.apply(this, a); } finally { segEnd(); }
});

if (lighting && lighting.volumetrics) {
  patch(lighting.volumetrics, 'render', (orig) => function (...a) {
    segBegin('volumetric:raymarch+depthprepass');
    try { return orig.apply(this, a); } finally { segEnd(); }
  });
}

// Sky owns a dome mesh inside the main scene, so it cannot be peeled out with a
// segment — it is measured by ablation instead. Same for level/props/AI bodies.

for (const s of eng._ordered) {
  const nm = s.name || s.constructor.name;
  if (typeof s.update === 'function') {
    patch(s, 'update', (orig) => function (...a) {
      const t = performance.now();
      try { return orig.apply(this, a); } finally { cpuAdd('update:' + nm, performance.now() - t); }
    });
  }
  if (typeof s.fixedUpdate === 'function') {
    patch(s, 'fixedUpdate', (orig) => function (...a) {
      const t = performance.now();
      try { return orig.apply(this, a); } finally { cpuAdd('fixed:' + nm, performance.now() - t); }
    });
  }
}

// ── scene inventory ────────────────────────────────────────────────────────
function triCount(obj) {
  let tris = 0, meshes = 0;
  obj.traverse((o) => {
    if (!o.isMesh && !o.isInstancedMesh && !o.isSkinnedMesh) return;
    const g = o.geometry;
    if (!g) return;
    const n = g.index ? g.index.count / 3 : (g.attributes.position ? g.attributes.position.count / 3 : 0);
    tris += n * (o.isInstancedMesh ? o.count : 1);
    meshes++;
  });
  return { tris: Math.round(tris), meshes };
}

function inventory() {
  return scene.children.map((c, i) => {
    const t = triCount(c);
    return { i, name: c.name || c.type, type: c.type, visible: c.visible, tris: t.tris, meshes: t.meshes };
  }).filter((e) => e.meshes > 0 || /light|group/i.test(e.type));
}

// ── ablation ops ───────────────────────────────────────────────────────────
// Every op returns a thunk that reverts it, so a run is: apply, warm, measure,
// revert. Nothing here edits a file; it moves live state and puts it back.
const childByName = (n) => scene.children.find((c) => (c.name || c.type) === n);

let sharedBasic = null;
function makeUntextured() {
  // Default-constructed instance of whatever material class the level uses:
  // same lighting model, zero texture fetches. Isolates sampler bandwidth from
  // shader ALU.
  let src = null;
  scene.traverse((o) => { if (!src && o.isMesh && o.material && !Array.isArray(o.material) && o.material.isMeshStandardMaterial) src = o.material; });
  if (!src) return null;
  try { return new src.constructor(); } catch { return null; }
}

const OPS = {
  none: () => () => {},

  cascades: (n) => {
    const prev = csm.lights.map((l) => l.castShadow);
    csm.lights.forEach((l, i) => { l.castShadow = i < n; });
    csm._forceAll = true;
    return () => { csm.lights.forEach((l, i) => { l.castShadow = prev[i]; }); csm._forceAll = true; };
  },

  shadowsOff: () => {
    const prev = renderer.shadowMap.enabled;
    renderer.shadowMap.enabled = false;
    return () => { renderer.shadowMap.enabled = prev; };
  },

  shadowMapSize: (size) => {
    const prev = csm.mapSize;
    csm.setMapSize(size);
    return () => { csm.setMapSize(prev); };
  },

  volumetric: (on) => {
    const v = lighting.volumetrics;
    const prev = v.enabled;
    v.enabled = !!on;
    return () => { v.enabled = prev; };
  },

  pass: (label, on) => {
    const e = passes.find((p) => p.label === label);
    if (!e) return () => {};
    const prev = e.pass.enabled;
    e.pass.enabled = !!on;
    return () => { e.pass.enabled = prev; };
  },

  hide: (name) => {
    const c = childByName(name);
    if (!c) return () => {};
    const prev = c.visible;
    c.visible = false;
    return () => { c.visible = prev; };
  },

  hideAll: (names) => {
    const reverts = names.map((n) => OPS.hide(n));
    return () => reverts.forEach((r) => r());
  },

  resolution: (scale) => {
    const prev = postfx._resolutionScale;
    postfx._resolutionScale = scale;
    postfx._applyResolution(true);
    postfx.taa && postfx.taa.invalidate();
    postfx.gtao && postfx.gtao.invalidate();
    return () => {
      postfx._resolutionScale = prev;
      postfx._applyResolution(true);
      postfx.taa && postfx.taa.invalidate();
      postfx.gtao && postfx.gtao.invalidate();
    };
  },

  untextured: () => {
    if (!sharedBasic) sharedBasic = makeUntextured();
    if (!sharedBasic) return () => {};
    const prev = scene.overrideMaterial;
    // scene.overrideMaterial is honoured by the main pass but NOT by the shadow
    // pass (which builds its own depth materials), so this isolates main-pass
    // material cost and leaves shadow cost untouched. That is the intent.
    scene.overrideMaterial = sharedBasic;
    return () => { scene.overrideMaterial = prev; };
  },

  // Lets the simulation run again for one measurement, so the CPU cost of AI
  // pathing/animation can be priced against an otherwise frozen frame.
  unfreeze: () => {
    const prev = eng.frozen;
    eng.frozen = false;
    return () => { eng.frozen = prev; };
  },

  postOff: () => {
    const prev = passes.map((p) => p.pass.enabled);
    // Everything except the RenderPass and the final write.
    passes.forEach((p, i) => {
      if (i === 0 || i === passes.length - 1) return;
      p.pass.enabled = false;
    });
    return () => { passes.forEach((p, i) => { p.pass.enabled = prev[i]; }); };
  },
};

function applyOps(ops) {
  const reverts = [];
  for (const o of ops) {
    const fn = OPS[o.k];
    if (!fn) continue;
    reverts.push(fn(o.a, o.b));
  }
  return () => { for (let i = reverts.length - 1; i >= 0; i--) reverts[i](); };
}

// ── the measurement primitive ──────────────────────────────────────────────
// Render one frame, then block on a 1x1 readPixels. readPixels cannot return
// until the GPU has drained the command queue for this frame, which is what
// converts asynchronous GPU work into wall time we can actually read.
// acc.js is the JavaScript half: everything eng._frame() does on the CPU,
// including three's per-draw-call state and uniform submission. acc.flush is
// what is left of the GPU queue once the CPU stopped feeding it. A frame that is
// GPU bound shows a small js and a large flush; a frame that is CPU bound shows
// the reverse, and no amount of turning graphics features off will fix it.
function flushFrame(acc) {
  const t0 = performance.now();
  eng._frame();
  const t1 = performance.now();
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const t2 = performance.now();
  if (acc) { acc.js.push(t1 - t0); acc.flush.push(t2 - t1); acc.glCalls.push(eng.stats.drawCalls); }
  return t2 - t0;
}

const yieldToLoop = () => new Promise((r) => setTimeout(r, 0));

// THE ENGINE'S OWN rAF LOOP MUST BE STOPPED WHILE WE MEASURE.
//
// Driving eng._frame() by hand does not stop Engine.start()'s requestAnimationFrame
// loop, and in headless Chromium that loop is paced by a virtual 60Hz clock that
// never blocks on the GPU — so it keeps queueing whole extra frames in the gaps
// between our manual ones. Measured directly, this scene rendered its composer
// chain 2.4 times per "frame" we thought we were timing: the wall clock, the
// timer queries and the query-availability all reflected that, and ~54% of the
// frame was unattributable as a result. Stopping the loop is the difference
// between measuring one frame and measuring an unknown number of them.
let loopStopped = false;
function stopLoop() {
  if (loopStopped) return;
  eng.stop();
  loopStopped = true;
}
function startLoop() {
  if (!loopStopped) return;
  eng.start();
  loopStopped = false;
}
stopLoop();
undo.push(startLoop);

async function measure(frames, warm, segments) {
  stopLoop();
  seg.on = !!segments && timerOk;
  cpu.on = !!segments;
  if (segments) {
    seg.totals.clear(); seg.entries.clear();
    seg.frames = 0; seg.disjoint = 0; seg.lost = 0;
    cpu.totals.clear(); cpu.frames = 0;
  }

  seg.keep = false;
  for (let i = 0; i < warm; i++) {
    if (seg.on) segBegin('frame:unattributed');
    flushFrame(null);
    if (seg.on) { segEnd(); segHarvest(); }
    await yieldToLoop();
  }
  if (seg.on) await segSettle();

  seg.keep = true;
  const wall = [];
  const acc = { js: [], flush: [], glCalls: [] };
  for (let i = 0; i < frames; i++) {
    if (seg.on) segBegin('frame:unattributed');
    const t = flushFrame(acc);
    if (seg.on) { segEnd(); segHarvest(); seg.frames++; }
    wall.push(t);
    if (cpu.on) cpu.frames++;
    await yieldToLoop();
  }
  if (seg.on) await segSettle();

  seg.on = false;
  seg.keep = false;
  cpu.on = false;

  const med = (arr) => { const s = arr.slice().sort((a, b) => a - b); return s[s.length >> 1]; };
  wall.sort((a, b) => a - b);
  const pick = (p) => wall[Math.min(wall.length - 1, Math.floor(wall.length * p))];
  const canvas = renderer.domElement;
  const out = {
    median: +pick(0.5).toFixed(2),
    p95: +pick(0.95).toFixed(2),
    best: +wall[0].toFixed(2),
    jsMs: +med(acc.js).toFixed(2),
    flushMs: +med(acc.flush).toFixed(2),
    canvas: canvas.width + 'x' + canvas.height,
    buffer: postfx ? postfx._bufW + 'x' + postfx._bufH : canvas.width + 'x' + canvas.height,
    mpx: postfx ? +((postfx._bufW * postfx._bufH) / 1e6).toFixed(2) : 0,
    drawCalls: eng.stats.drawCalls,
    triangles: eng.stats.triangles,
  };

  if (segments) {
    const rows = [];
    for (const [label, t] of seg.totals) {
      const s = t.samples.slice().sort((a, b) => a - b);
      rows.push({
        label,
        msPerFrame: +(t.ms / Math.max(1, seg.frames)).toFixed(2),
        callsPerFrame: +((seg.entries.get(label) || 0) / Math.max(1, seg.frames)).toFixed(2),
        spansPerFrame: +(t.n / Math.max(1, seg.frames)).toFixed(2),
        median: +s[s.length >> 1].toFixed(2),
      });
    }
    rows.sort((a, b) => b.msPerFrame - a.msPerFrame);
    out.segments = rows;
    out.segFrames = seg.frames;
    out.disjoint = seg.disjoint;
    out.lost = seg.lost;
    out.gpuAccounted = +rows.reduce((s, r) => s + r.msPerFrame, 0).toFixed(2);

    const crows = [];
    for (const [label, t] of cpu.totals) {
      const per = t.ms / Math.max(1, cpu.frames);
      if (per >= 0.02) crows.push({ label, msPerFrame: +per.toFixed(3) });
    }
    crows.sort((a, b) => b.msPerFrame - a.msPerFrame);
    out.cpu = crows;
  }
  return out;
}

window.__pp = {
  measure,
  applyOps,
  passes: () => passes.map((p) => ({ label: p.label, enabled: p.pass.enabled })),
  inventory,
  restore: () => { for (const u of undo) u(); undo.length = 0; },
  info: () => ({
    timerQuery: timerOk,
    frozen: !!eng.frozen,
    gpu: (() => {
      const d = gl.getExtension('WEBGL_debug_renderer_info');
      return d ? String(gl.getParameter(d.UNMASKED_RENDERER_WEBGL)) : 'unknown';
    })(),
    cascades: csm ? csm.count : 0,
    shadowMapSize: csm ? csm.mapSize : 0,
    volumetricSteps: lighting && lighting.volumetrics ? lighting.volumetrics.steps : 0,
    volumetricEnabled: !!(lighting && lighting.volumetrics && lighting.volumetrics.enabled),
    resolutionScale: postfx ? postfx._resolutionScale : 1,
    pixelRatio: renderer.getPixelRatio(),
    passes: passes.map((p) => ({ label: p.label, enabled: p.pass.enabled })),
    quality: JSON.parse(JSON.stringify(ctx.quality || {})),
    inventory: inventory(),
  }),
};

return window.__pp.info();
})()
`;
