#!/usr/bin/env node
/**
 * Photometric assertion on the optic's objective glass.
 *
 * WHY THIS EXISTS. Round 9 added a glass pane to the red dot and the round-9
 * review measured it as *brightening* the view: "the same wall measures
 * 100/80/104 RGB through the glass against 69/58/63 bare, so the glass adds a
 * bright bluish veil worth about +45 percent luminance instead of attenuating".
 * Real AR-coated optic glass transmits 90-95% and tints almost imperceptibly.
 * There was no automated check on the pane at all, so nothing caught it.
 *
 * ─── THREE INSTRUMENT BUGS THIS HARNESS IS BUILT TO AVOID ──────────────────
 *
 * 1. COMPARING DIFFERENT SURFACES. "Through the glass" and "beside the glass"
 *    are, in any real framing, two different patches of wall at two different
 *    distances and incidences, under a sun gradient, behind a lens vignette.
 *    A raw through/beside ratio therefore measures the WALL as much as the
 *    glass, and can be off by tens of percent before the glass does anything.
 *    So the primary metric here is an ABLATION: the same pixels are read twice,
 *    once with `lens.visible = true` and once false. Nothing else changes, so
 *    the ratio is the glass's transmittance and nothing but.
 *    The spatial through/beside ratio is still reported — it is what the
 *    reviewer measures by eye — but it is DEBIASED by dividing through by the
 *    same ratio taken with the glass hidden, which cancels the wall.
 *
 * 2. ASSERTING ON RAW 8-BIT CODE VALUES. The framebuffer is sRGB-encoded after
 *    an AgX tonemap. A code-value ratio is neither the scene-linear
 *    transmittance nor a perceptual one, and the encoding is steep in the
 *    shadows: a 6% linear cut reads as ~3% of code value on dark pixels and
 *    ~5% on bright ones. Every ratio below is therefore computed on
 *    sRGB-DECODED luminance, which is the quantity the reviewer's "+45 percent
 *    luminance" claim is about. Raw code means are printed alongside so the
 *    numbers can be tied back to a pixel probe, but they are not the gate.
 *
 * 3. FINDING THE APERTURE BY LOOKING FOR PIXELS THAT CHANGED. Tempting, and
 *    circular: a correctly neutral patch of glass changes those pixels least,
 *    so the mask shrinks exactly where the glass behaves best and the sample
 *    self-selects the worst pixels. The aperture is instead located
 *    GEOMETRICALLY, by projecting the lens mesh's own vertices through
 *    ctx.viewCamera — independent of what the shader does, and it works
 *    unchanged whether the lens is a rectangle or a circle.
 *
 * 4. ASSUMING TWO SUCCESSIVE FRAMES ARE COMPARABLE. They are not, and the first
 *    version of this file was wrong because of it. The chain ends in a temporally
 *    adapted auto-exposure, so hiding the lens and re-rendering changes the
 *    metered average and every pixel in the frame moves — the whole-rig ablation
 *    reported the weapon covering 85% of one view purely from the exposure step.
 *    Two defences, both mandatory:
 *      • a NULL TEST — two grabs with identical visibility. Any deviation from
 *        1.000 is instrument drift, and it is printed before anything else.
 *      • every ratio is normalised by a CONTROL region: the whole frame outside
 *        the weapon and away from the optic, which the lens cannot touch. A
 *        global exposure step cancels; a change in the glass does not.
 *    The null test then found a SECOND, larger drift the control could not
 *    cancel, because it is local rather than global: on the golden ADS framing
 *    two identical grabs disagreed by 7% inside the aperture, while the control
 *    region agreed to 0.2%. That is the temporal part of the chain — TAA history
 *    and the depth-of-field focus pull — still converging, right where the
 *    aperture sits on a depth discontinuity. Hence the WARM-UP frames below, and
 *    the A-B-A schedule: the glass is read twice, either side of the bare read,
 *    and the two are averaged so any residual linear drift subtracts out.
 *
 * 5. AVERAGING THE DEFECT AWAY. A mean over the aperture is not what a reviewer
 *    does — they find the worst patch and photograph it. The round-9 pane was a
 *    diagonal sheen band over part of the window, and a disc-wide mean diluted a
 *    local +40% into +4%. So the aperture is also tiled into small patches and
 *    the WORST patch is gated separately.
 *
 * WHAT IS ASSERTED
 *   transmit      control-normalised sRGB-decoded luminance through the glass /
 *                 the same pixels bare. Must be 0.90 .. 0.98. Below 0.90 the
 *                 sight is a dark hole; above 0.98 there is no glass; above 1.0
 *                 the pane is emitting.
 *   worstPatch    the same ratio over the brightest-offending tile of the
 *                 aperture. No part of the window may brighten: <= 1.02.
 *   cast          max per-channel spread of the transmittance. A "bluish veil"
 *                 shows up here even when the mean happens to look sane, so it
 *                 is a separate gate.
 *   contrast      std-dev of luminance inside the aperture, glass on / off.
 *                 The review's actual complaint was lost contrast, which a
 *                 veil causes and a mean-only test cannot see.
 *   spatialDebias the reviewer's own through/beside measurement, wall-cancelled.
 *                 Must agree with `transmit`; if the two disagree the framing
 *                 is unsuitable, not the glass.
 *
 * ALSO REPORTED (not gated here — framing, for the round-9 "26 percent of frame
 * width" note): the viewmodel's screen footprint, measured by ablating the whole
 * rig, and its share of the bottom 45% of the frame.
 *
 * Usage: node tools/opticcheck.mjs [--views optic-ads,optic-wall] [--dump]
 * Exits non-zero if any view fails.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const dump = args.includes('--dump');

/**
 * `autoexposure=0` is not optional. With metering live, hiding the lens changes
 * the frame's average and the exposure walks — and it does NOT cancel out of the
 * control-normalised ratio, because the exposure step is multiplicative in HDR
 * while the readback is after AgX and an sRGB encode, so the same stop moves a
 * mid-grey control region and a brighter aperture by different fractions. Pinning
 * exposure was worth more than every other stabilisation in this file: it took the
 * null drift on the golden framing from 0.945-1.271 down to under a percent.
 */
const PIN = 'autoexposure=0';

const VIEWS = {
  /**
   * Pinning exposure has a cost: the golden preset's nominal stop is well under
   * what metering adapts to, so the canonical golden framing came back with the
   * sample region at code 30 — where one 8-bit step is 7% of the decoded value and
   * the per-channel ratio is pure quantisation noise. It reported a 0.064 colour
   * cast that was not there. Both views therefore have to be framed and lit so the
   * measured surface lands in a properly exposed range, which the EXPOSURE FLOOR
   * check below enforces rather than trusts.
   */
  'optic-ads': `tod=midday&pos=6,1.7,14&yaw=200&pitch=0.00&vm=1&ads=1&${PIN}`,
  // Flat light on the same sightline. Overcast removes the sun's raking gradient
  // across the wall, which is what makes the SPATIAL through/beside comparison
  // meaningful rather than a measurement of where the sun happens to fall.
  'optic-wall': `tod=overcast&pos=6,1.7,14&yaw=200&pitch=0.02&vm=1&ads=1&${PIN}`,
};
const want = (opt('views', 'optic-ads,optic-wall')).split(',').map((s) => s.trim());

/** AR-coated glass transmits 90-95%; allow a little slack either side. */
const MIN_TRANSMIT = 0.90;
const MAX_TRANSMIT = 0.98;
/** No tile of the window may be brighter through the glass than beside it. */
const MAX_WORST_PATCH = 1.02;
/** Per-channel spread of the transmittance — a tint, not a colour filter. */
const MAX_CAST = 0.060;
/** Local contrast may soften slightly through glass; it may not collapse. */
const MIN_CONTRAST = 0.92;
/**
 * How far the debiased spatial reading may sit from the ablation.
 *
 * Not a fixed number: the spatial comparison's precision is set by its own
 * control patch, which is small and dark, so the tolerance is derived from that
 * patch's measured noise rather than guessed. Three sigma of the patch's own
 * on/off drift, floored so a quiet frame does not produce an impossibly tight
 * gate. If the two methods disagree by more than this, one of them is wrong and
 * the run should not be trusted.
 */
const METHOD_GAP_FLOOR = 0.030;
const METHOD_GAP_SIGMAS = 3;
/** Two identical grabs must agree this closely or every ratio is noise. */
const MAX_NULL_DRIFT = 0.010;
/**
 * Minimum mean code value of the BARE sample. Below this the sRGB encode's toe
 * makes one quantisation step a several-percent change in decoded luminance, and
 * every ratio — the per-channel ones worst of all — becomes noise. This is a
 * property of the measurement, not of the glass, so it is checked explicitly
 * instead of being discovered as a mystery failure.
 */
const MIN_SAMPLE_CODE = 45;

const PROBE = `(() => {
  const eng = window.__blacksite.engine;
  const vm = eng.systems.get('viewmodel');
  if (!vm) return { error: 'no viewmodel system' };
  const optic = vm.rig && vm.rig.optic;
  if (!optic || !optic.lens) return { error: 'viewmodel exposes no rig.optic.lens' };

  const lens = optic.lens;
  const reticle = optic.reticle;
  const cam = vm.ctx.viewCamera;
  const gl = eng.renderer.getContext();
  const W = eng.renderer.domElement.width;
  const H = eng.renderer.domElement.height;
  const N = W * H;
  /**
   * One full TAA jitter cycle. Every measured state is the mean of exactly this
   * many consecutive frames, which is what finally removed the residual null
   * drift: the resolved image is a function of the 8-sample Halton phase as much
   * as of the scene, so a single frame carries up to 1.4% of phase-dependent
   * error in a small region. Averaging one whole cycle cancels it by construction
   * rather than relying on two grabs happening to land on the same phase.
   * Averaging is done on DECODED values — decode then average, never the reverse.
   */
  const CYCLE = 8;

  const rigMeshes = (vm.rig.meshes || []).concat(vm.hands ? (vm.hands.meshes || []) : []);
  const saved = {
    lens: lens.visible,
    reticle: reticle ? reticle.visible : null,
    rig: rigMeshes.map((m) => m.visible),
  };

  const LUT = new Float64Array(256);
  for (let i = 0; i < 256; i++) {
    const u = i / 255;
    LUT[i] = u <= 0.04045 ? u / 12.92 : Math.pow((u + 0.055) / 1.055, 2.4);
  }
  const enc = (v) => {
    const u = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(Math.max(0, v), 1 / 2.4) - 0.055;
    return Math.round(Math.max(0, Math.min(1, u)) * 255);
  };

  const px = new Uint8Array(N * 4);
  const shot = () => {
    eng._frame();
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return px;
  };

  eng.stop();
  lens.visible = true;
  if (reticle) reticle.visible = false;
  // Warm-up: TAA history and the depth-of-field focus pull are both still moving
  // for the first few dozen frames after a visibility change.
  for (let i = 0; i < 48; i++) eng._frame();
  shot();

  /* ---- locate the aperture geometrically ------------------------------- */
  const v = lens.position.clone();
  const pos = lens.geometry.attributes.position;
  let nx0 = 1e9, ny0 = 1e9, nx1 = -1e9, ny1 = -1e9;
  for (let i = 0; i < pos.count; i++) {
    v.set(pos.getX(i), pos.getY(i), pos.getZ(i))
      .applyMatrix4(lens.matrixWorld).project(cam);
    if (v.x < nx0) nx0 = v.x; if (v.x > nx1) nx1 = v.x;
    if (v.y < ny0) ny0 = v.y; if (v.y > ny1) ny1 = v.y;
  }
  const ax0 = (nx0 * 0.5 + 0.5) * W, ax1 = (nx1 * 0.5 + 0.5) * W;
  const ay0 = (ny0 * 0.5 + 0.5) * H, ay1 = (ny1 * 0.5 + 0.5) * H;
  const cx = (ax0 + ax1) * 0.5, cy = (ay0 + ay1) * 0.5;
  const halfExtent = Math.min(ax1 - ax0, ay1 - ay0) * 0.5;
  const rad = halfExtent * 0.55;
  /**
   * The tile scan uses a WIDER disc than the mean does. The mean wants a region
   * that is unambiguously sight picture; the tile scan is hunting a localised veil
   * and has to cover as much of the window as it can without reaching the
   * element's own rim band, which legitimately darkens from 0.86 outward.
   */
  const radWide = halfExtent * 0.70;
  if (!(rad > 3)) return { error: 'aperture projects to ' + rad.toFixed(2) + ' px radius' };

  /* ---- rig mask, for the control region and the framing report ---------- */
  const withRig = px.slice();
  rigMeshes.forEach((m) => { m.visible = false; });
  for (let i = 0; i < CYCLE; i++) eng._frame();
  const noRig = shot().slice();
  rigMeshes.forEach((m, i) => { m.visible = saved.rig[i]; });
  for (let i = 0; i < CYCLE; i++) eng._frame();

  // Hiding the weapon shifts the frame's overall level even with metering pinned,
  // so estimate the global gain on a sparse grid with a MEDIAN — the weapon's own
  // pixels are a minority carrying the extreme ratios and must not drag it — then
  // diff against the corrected frame.
  const ratios = [];
  for (let y = 4; y < H; y += 11) {
    for (let x = 4; x < W; x += 11) {
      const p = (y * W + x) * 4;
      const a = LUT[withRig[p]] + LUT[withRig[p + 1]] + LUT[withRig[p + 2]];
      const b = LUT[noRig[p]] + LUT[noRig[p + 1]] + LUT[noRig[p + 2]];
      if (b > 1e-4) ratios.push(a / b);
    }
  }
  ratios.sort((p, q) => p - q);
  const gain = ratios.length ? ratios[ratios.length >> 1] : 1;

  const rigMask = new Uint8Array(N);
  let rigCount = 0, bottomCount = 0;
  const bandTop = Math.floor(H * 0.45);          // bottom 45% of the frame
  for (let i = 0, p = 0; i < N; i++, p += 4) {
    let d = 0;
    for (let c = 0; c < 3; c++) {
      const a = LUT[withRig[p + c]], b = LUT[noRig[p + c]] * gain;
      d += Math.abs(a - b) / Math.max(0.004, a + b);
    }
    if (d > 0.30) { rigMask[i] = 1; rigCount++; if ((i / W | 0) < bandTop) bottomCount++; }
  }

  /* ---- index sets ------------------------------------------------------- */
  const discOf = (r) => {
    const out = [];
    const r2 = r * r;
    for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(H - 1, Math.ceil(cy + r)); y++) {
      for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(W - 1, Math.ceil(cx + r)); x++) {
        const dx = x - cx, dy = y - cy;
        if (dx * dx + dy * dy <= r2) out.push(y * W + x);
      }
    }
    return out;
  };
  const disc = discOf(rad);

  // Tiles: a mean cannot see a localised veil. The round-9 pane's worst tile was
  // 1.37 while its disc mean read 0.99.
  const TILES = 6;
  const half = radWide * 0.98;
  const tiles = [];
  for (let ty = 0; ty < TILES; ty++) {
    for (let tx = 0; tx < TILES; tx++) {
      const bx0 = cx - half + (tx * 2 * half) / TILES, bx1 = bx0 + (2 * half) / TILES;
      const by0 = cy - half + (ty * 2 * half) / TILES, by1 = by0 + (2 * half) / TILES;
      const idx = [];
      for (let y = Math.ceil(by0); y < by1; y++) {
        for (let x = Math.ceil(bx0); x < bx1; x++) {
          if (x < 0 || x >= W || y < 0 || y >= H) continue;
          const dx = x - cx, dy = y - cy;
          if (dx * dx + dy * dy > radWide * radWide) continue;
          idx.push(y * W + x);
        }
      }
      if (idx.length >= 40) {
        tiles.push({ idx, at: [Math.round((bx0 + bx1) / 2), Math.round(H - (by0 + by1) / 2)] });
      }
    }
  }

  /**
   * Outer edge of the housing on the aperture's centre row, and from that the
   * 'beside' patches of clean world.
   *
   * THIS WAS WRONG AND IT MATTERED. The first version walked outward from the
   * aperture centre until it found six consecutive non-weapon pixels and called
   * that the edge — but the centre of the aperture IS non-weapon pixels: it is the
   * world, seen through the glass. So the walk terminated about 13 px from centre,
   * reported the housing as 26 px wide (1.35% of frame) when it is plainly ~300,
   * and — far worse — put both 'beside' patches INSIDE the window. Every spatial
   * reading before this fix was comparing through-glass against through-glass,
   * which is why spatialDebias sat at a reassuring 1.00 and told us nothing.
   *
   * The correct edge is the OUTERMOST weapon pixel on the row within a search
   * radius, not the first gap.
   */
  const row = Math.round(cy);
  const PATCH = 16;
  const SEARCH = 430;
  const outerEdge = (dir) => {
    let last = Math.round(cx);
    for (let k = 1; k <= SEARCH; k++) {
      const x = Math.round(cx) + dir * k;
      if (x < 1 || x > W - 2) break;
      if (rigMask[row * W + x]) last = x;
    }
    return last;
  };
  const edgeL = outerEdge(-1), edgeR = outerEdge(1);
  const beside = [];
  for (const edge of [edgeL - (PATCH + 8), edgeR + (PATCH + 8)]) {
    for (let y = row - PATCH; y <= row + PATCH; y++) {
      for (let x = edge - PATCH; x <= edge + PATCH; x++) {
        if (x < 0 || x >= W || y < 0 || y >= H) continue;
        if (rigMask[y * W + x]) continue;
        beside.push(y * W + x);
      }
    }
  }

  /**
   * THE CONTROL. Every pixel that is neither weapon nor near the aperture —
   * hundreds of thousands of them, none of which the lens can physically affect.
   * Its on/off ratio is the frame's global step, and dividing it out is what makes
   * the ablation a measurement of the glass rather than of the renderer.
   */
  const control = [];
  const guard = radWide + 90;
  for (let y = 0; y < H; y += 2) {
    for (let x = 0; x < W; x += 2) {
      const i = y * W + x;
      if (rigMask[i]) continue;
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy < guard * guard) continue;
      control.push(i);
    }
  }

  /* ---- averaged reads, on / off / on ------------------------------------ */
  const keepMap = new Int32Array(N).fill(-1);
  const keep = [];
  const addKeep = (list) => {
    for (const i of list) if (keepMap[i] === -1) { keepMap[i] = keep.length; keep.push(i); }
  };
  addKeep(disc); addKeep(beside); addKeep(control);
  for (const t of tiles) addKeep(t.idx);
  const K = keep.length;

  const accum = () => {
    const a = new Float64Array(K * 3);
    for (let f = 0; f < CYCLE; f++) {
      shot();
      for (let k = 0; k < K; k++) {
        const p = keep[k] * 4, q = k * 3;
        a[q] += LUT[px[p]]; a[q + 1] += LUT[px[p + 1]]; a[q + 2] += LUT[px[p + 2]];
      }
    }
    for (let i = 0; i < a.length; i++) a[i] /= CYCLE;
    return a;
  };

  // A-B-A: the glass is read either side of the bare read, so any drift that is
  // linear in frame index subtracts out of the average of the two.
  const A1 = accum();
  lens.visible = false;
  for (let i = 0; i < CYCLE * 2; i++) eng._frame();
  const B = accum();
  lens.visible = true;
  for (let i = 0; i < CYCLE * 2; i++) eng._frame();
  const A2 = accum();

  lens.visible = saved.lens;
  if (reticle) reticle.visible = saved.reticle;
  eng.start();

  const stats = (A, list) => {
    let r = 0, g = 0, b = 0, l = 0, l2 = 0;
    for (const i of list) {
      const q = keepMap[i] * 3;
      const lr = A[q], lg = A[q + 1], lb = A[q + 2];
      r += lr; g += lg; b += lb;
      const y = 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
      l += y; l2 += y * y;
    }
    const n = list.length || 1;
    const mean = l / n;
    return {
      r: r / n, g: g / n, b: b / n, y: mean,
      std: Math.sqrt(Math.max(0, l2 / n - mean * mean)),
      code: [enc(r / n), enc(g / n), enc(b / n)], n,
    };
  };
  const mid = (list) => {
    const a = stats(A1, list), b = stats(A2, list);
    return {
      r: (a.r + b.r) / 2, g: (a.g + b.g) / 2, b: (a.b + b.b) / 2,
      y: (a.y + b.y) / 2, std: (a.std + b.std) / 2, n: a.n,
      code: a.code.map((val, i) => Math.round((val + b.code[i]) / 2)),
    };
  };

  const div = (a, b) => (b > 1e-9 ? a / b : 0);
  const norm = (onV, offV, onC, offC) => div(div(onV, offV), div(onC, offC));

  const onDisc = mid(disc), offDisc = stats(B, disc);
  const onCtl = mid(control), offCtl = stats(B, control);
  const onBeside = mid(beside), offBeside = stats(B, beside);

  const tRr = norm(onDisc.r, offDisc.r, onCtl.r, offCtl.r);
  const tGg = norm(onDisc.g, offDisc.g, onCtl.g, offCtl.g);
  const tBb = norm(onDisc.b, offDisc.b, onCtl.b, offCtl.b);
  const transmit = norm(onDisc.y, offDisc.y, onCtl.y, offCtl.y);

  let worst = 0, worstAt = null, darkest = 9;
  for (const t of tiles) {
    const val = norm(mid(t.idx).y, stats(B, t.idx).y, onCtl.y, offCtl.y);
    if (val > worst) { worst = val; worstAt = t.at; }
    if (val < darkest) darkest = val;
  }

  const spatialOn = div(onDisc.y, onBeside.y);
  const spatialOff = div(offDisc.y, offBeside.y);

  return {
    resolution: W + 'x' + H,
    // Null test: two averaged glass-on states, 24 frames apart, same visibility.
    nullDrift: +norm(stats(A2, disc).y, stats(A1, disc).y,
      stats(A2, control).y, stats(A1, control).y).toFixed(5),
    nullRaw: +div(stats(A2, disc).y, stats(A1, disc).y).toFixed(5),
    exposureStep: +div(onCtl.y, offCtl.y).toFixed(5),
    rigGain: +gain.toFixed(4),
    framesPerState: CYCLE,
    aperture: {
      box: [Math.round(ax0), Math.round(H - ay1), Math.round(ax1), Math.round(H - ay0)],
      wPx: +(ax1 - ax0).toFixed(1), hPx: +(ay1 - ay0).toFixed(1),
      sampleR: +rad.toFixed(1), tileR: +radWide.toFixed(1),
      samplePx: onDisc.n, controlPx: control.length, tiles: tiles.length,
      aspect: +div(ax1 - ax0, ay1 - ay0).toFixed(3),
    },
    through: { code: onDisc.code, y: +onDisc.y.toFixed(5), std: +onDisc.std.toFixed(5) },
    bare: { code: offDisc.code, y: +offDisc.y.toFixed(5), std: +offDisc.std.toFixed(5) },
    besideThrough: { code: onBeside.code, n: onBeside.n },
    besideBare: { code: offBeside.code },
    besideNoise: +Math.abs(div(onBeside.y, offBeside.y) - 1).toFixed(4),
    transmitRaw: +div(onDisc.y, offDisc.y).toFixed(4),
    transmit: +transmit.toFixed(4),
    perChannel: [+tRr.toFixed(4), +tGg.toFixed(4), +tBb.toFixed(4)],
    cast: +(Math.max(tRr, tGg, tBb) - Math.min(tRr, tGg, tBb)).toFixed(4),
    worstPatch: +worst.toFixed(4),
    worstAt,
    darkestPatch: +darkest.toFixed(4),
    contrast: +div(onDisc.std, offDisc.std).toFixed(4),
    spatialRaw: +spatialOn.toFixed(4),
    spatialDebias: +div(spatialOn, spatialOff).toFixed(4),
    footprint: {
      /**
       * Extent of the ABLATION MASK on the aperture's centre row.
       *
       * Read this as an upper bound, not as the silhouette. The mask is built by
       * hiding the weapon and diffing, and bloom has a wide kernel — removing a
       * dark weapon in front of a bright world changes pixels for hundreds of px
       * around it, so the mask is systematically fatter than the object. It came
       * out at 643-785 px against an analytic silhouette of 306. The analytic
       * per-part figure in the pre-flight is the one to quote for framing; this
       * number is useful only for spotting a gross regression.
       */
      housingWidthPx: edgeR - edgeL,
      housingPct: +((edgeR - edgeL) / W * 100).toFixed(2),
      /** True if the mask ran to the search limit, i.e. the number is a floor. */
      housingClipped: (edgeR - Math.round(cx) >= SEARCH) || (Math.round(cx) - edgeL >= SEARCH),
      rigPct: +((rigCount / N) * 100).toFixed(2),
      bottom45Pct: +((bottomCount / (W * bandTop)) * 100).toFixed(2),
      apertureWidthPctOfFrame: +(((ax1 - ax0) / W) * 100).toFixed(2),
    },
  };
})()`;

const here = path.dirname(fileURLToPath(import.meta.url));

/* ==================================================================== part 1
 * ANALYTIC PRE-FLIGHT — no browser, no GPU.
 *
 * The photometric test below needs the page to boot, and it also cannot see the
 * defect that produced the round-8 "television set": a ring that quietly crops
 * the sight picture does not change the transmittance of the glass at all. That
 * is pure arithmetic, so it is checked here.
 *
 * The rule: the sight cone is anchored on the front aperture of the tube liner.
 * Every other annulus between eye and world must have a bore at least as wide as
 * that cone where it sits. Rings NEARER the eye pass trivially; the lens shade,
 * which is further from the eye than the limiting aperture, is the one that has to
 * be deliberately oversized — and the one that gets it wrong.
 */
const geom = await (async () => {
  const { buildOptic } = await import('../src/weapons/viewmodel/Rail.js');
  const { Mesher, RAIL_HEIGHT } = {
    ...(await import('../src/weapons/viewmodel/Shapes.js')),
    ...(await import('../src/weapons/viewmodel/Rail.js')),
  };
  const { LAYOUT } = await import('../src/weapons/viewmodel/Weapon.js');
  const m = new Mesher();
  const optic = buildOptic(m, {}, {
    railTop: LAYOUT.railTop, axisY: LAYOUT.opticAxisY, z: LAYOUT.opticZ,
  });
  const o = optic.optics;
  const camZ = o.pupilZ + o.eye;
  const cone = o.rIn / (camZ - o.zF);          // half-angle of the sight picture
  const rows = o.rings.map((r) => {
    const need = cone * (camZ - r.z);
    return { ...r, need, slack: r.rIn - need };
  });
  // The lens element itself must be round, and cover the bore.
  const posAttr = optic.lens.geometry.attributes.position;
  let rMin = 1e9, rMax = -1e9;
  for (let i = 0; i < posAttr.count; i++) {
    const rr = Math.hypot(posAttr.getX(i), posAttr.getY(i));
    if (rr > 1e-6) { rMin = Math.min(rMin, rr); rMax = Math.max(rMax, rr); }
  }
  return {
    cone, camZ, rows, optic, tris: m.triangleCount(),
    buckets: [...m.buckets.keys()],
    lensRimSpread: rMax - rMin,
    lensRadius: rMax,
    // Angular width of the widest part of the housing, and of the window, both as
    // a share of a 1920 px frame at the viewmodel's 65-degree vertical FOV.
    pxPerRad: (1920 / 2) / Math.tan(Math.atan(Math.tan((65 / 2) * Math.PI / 180) * 16 / 9)),
  };
})();

{
  const g = geom;
  /**
   * Screen footprint is the MAX over parts, not the tube's. Apparent size is
   * radius over distance, so the nearest part usually wins even when it is not the
   * largest — here the eyecup, 1.2 mm fatter than the tube and 6 mm closer to the
   * eye, subtends half again as much. Predicting from one part gave 12.3% against
   * a measured 18.1%.
   */
  const widest = g.optic.optics.parts
    .map((q) => ({ ...q, px: 2 * Math.atan(q.r / (g.camZ - q.z)) * g.pxPerRad }))
    .sort((p1, p2) => p2.px - p1.px);
  const bodyPx = widest[0].px;
  const winPx = 2 * g.cone * g.pxPerRad;
  const okRings = g.rows.every((r) => r.slack >= -1e-9);
  // A circle's vertices all sit on one radius apart from the centre vertex.
  const okRound = g.lensRimSpread < 1e-5;
  if (!okRings || !okRound) process.exitCode = 1;
  console.log('=== aperture arithmetic (no browser) ===');
  console.log(`  eye at weapon z ${g.camZ.toFixed(4)}; sight cone half-angle ${g.cone.toFixed(5)} rad`);
  for (const r of g.rows) {
    console.log(`  ${r.slack >= 0 ? 'ok  ' : 'FAIL'} ${r.name.padEnd(36)} bore ${(r.rIn * 1000).toFixed(2)} mm,`
      + ` cone needs ${(r.need * 1000).toFixed(2)} mm, slack ${(r.slack * 1000).toFixed(2)} mm`);
  }
  console.log(`  ${okRound ? 'ok  ' : 'FAIL'} objective is circular   rim radius ${(g.lensRadius * 1000).toFixed(2)} mm,`
    + ` spread ${(g.lensRimSpread * 1e6).toFixed(1)} um`);
  console.log(`  predicted at 1920x1080: window ${winPx.toFixed(0)} px across (${(winPx / 1920 * 100).toFixed(1)}% of frame)`);
  console.log('  widest silhouette, rotationally symmetric parts (apparent size = radius / distance):');
  for (const q of widest) {
    console.log(`    ${q.name.padEnd(18)} r ${(q.r * 1000).toFixed(1)} mm at ${((g.camZ - q.z) * 1000).toFixed(1)} mm`
      + ` -> ${q.px.toFixed(0)} px (${(q.px / 1920 * 100).toFixed(1)}% of frame width)`);
  }
  let reachL = bodyPx / 2, reachR = bodyPx / 2;
  for (const q of g.optic.optics.spurs) {
    const d = g.camZ - q.z;
    const reach = (Math.abs(q.off) + q.r) / d * g.pxPerRad;
    if (q.axis === 'x') { if (q.off < 0) reachL = Math.max(reachL, reach); else reachR = Math.max(reachR, reach); }
    console.log(`    ${q.name.padEnd(18)} reaches ${reach.toFixed(0)} px from centre along ${q.axis},`
      + ` ${(2 * q.r / d * g.pxPerRad).toFixed(0)} px thick`);
  }
  const totalPx = reachL + reachR;
  console.log(`  SOLID housing ${bodyPx.toFixed(0)} px = ${(bodyPx / 1920 * 100).toFixed(1)}% of frame width`
    + ` (round 9 review measured 26%)`);
  console.log(`  including the turrets and battery cap, total horizontal reach ${totalPx.toFixed(0)} px`
    + ` = ${(totalPx / 1920 * 100).toFixed(1)}%, of which the added hardware is thin drums, not housing`);
  console.log(`  optic geometry ${g.tris} triangles in zones [${g.buckets.join(', ')}]`);
  if (!okRings) console.log('  -> a ring crops the sight picture: that is how a red dot becomes a television set.');
}

const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=d3d11', '--disable-gpu-sandbox', '--ignore-gpu-blocklist'],
});

let failed = false;
for (const view of want) {
  const q = VIEWS[view];
  if (!q) { console.log(`${view}: unknown view`); failed = true; continue; }
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(m.text()); });
  try {
    await page.goto(`http://127.0.0.1:5180/?freeze=1&hud=0&quality=cinematic&${q}`,
      { waitUntil: 'domcontentloaded', timeout: 300000 });
    await page.waitForFunction('window.__ready === true', null, { timeout: 300000 });
    await page.waitForTimeout(1100);
    if (dump) {
      fs.mkdirSync(path.join(here, 'out', 'crops', 'optic10'), { recursive: true });
      await page.screenshot({ path: path.join(here, 'out', 'crops', 'optic10', `probe-${view}.png`) });
    }

    const r = await page.evaluate(PROBE);
    if (r.error) { console.log(`${view}: ${r.error}`); failed = true; await page.close(); continue; }

    const drift = Math.abs(r.nullDrift - 1);
    const okNull = drift <= MAX_NULL_DRIFT;
    const codeMean = r.bare.code.reduce((a, b) => a + b, 0) / 3;
    const okLevel = codeMean >= MIN_SAMPLE_CODE;
    const okT = r.transmit >= MIN_TRANSMIT && r.transmit <= MAX_TRANSMIT;
    const okWorst = r.worstPatch <= MAX_WORST_PATCH;
    const okCast = r.cast <= MAX_CAST;
    const okContrast = r.contrast >= MIN_CONTRAST;
    const gap = Math.abs(r.spatialDebias - r.transmit);
    const gapAllow = Math.max(METHOD_GAP_FLOOR, METHOD_GAP_SIGMAS * r.besideNoise);
    const okMethod = gap <= gapAllow;
    if (!okNull || !okLevel || !okT || !okWorst || !okCast || !okContrast || !okMethod) failed = true;

    const a = r.aperture;
    console.log(`\n=== ${view} (${r.resolution}) ===`);
    console.log(`  ${okNull ? 'ok  ' : 'FAIL'} null drift     ${r.nullDrift}   (two identical grabs; raw ${r.nullRaw},`
      + ` global exposure step on/off ${r.exposureStep}, rig-ablation gain ${r.rigGain})`);
    console.log(`  aperture ${a.wPx} x ${a.hPx} px  aspect ${a.aspect}  box ${JSON.stringify(a.box)}`);
    console.log(`  sample   mean disc r=${a.sampleR}px (${a.samplePx} px), ${a.tiles} tiles out to r=${a.tileR}px;`
      + ` control ${a.controlPx} px; ${r.framesPerState} frames averaged per state`);
    console.log(`  ${okLevel ? 'ok  ' : 'FAIL'} sample level   mean code ${codeMean.toFixed(1)}   (need >= ${MIN_SAMPLE_CODE} for the ratios to mean anything)`);
    console.log(`  through glass  RGB ${JSON.stringify(r.through.code)}   bare RGB ${JSON.stringify(r.bare.code)}   (same pixels)`);
    console.log(`  beside, on/off RGB ${JSON.stringify(r.besideThrough.code)} / ${JSON.stringify(r.besideBare.code)}`);
    console.log(`  ${okT ? 'PASS' : 'FAIL'} transmit       ${r.transmit}   (need ${MIN_TRANSMIT}..${MAX_TRANSMIT})`
      + `  per-channel ${JSON.stringify(r.perChannel)}   uncorrected ${r.transmitRaw}`);
    console.log(`  ${okWorst ? 'PASS' : 'FAIL'} worst tile     ${r.worstPatch}   (need <= ${MAX_WORST_PATCH})`
      + `  at ${JSON.stringify(r.worstAt)}; darkest tile ${r.darkestPatch}`);
    console.log(`  ${okCast ? 'PASS' : 'FAIL'} colour cast    ${r.cast}    (need <= ${MAX_CAST})`);
    console.log(`  ${okContrast ? 'PASS' : 'FAIL'} contrast keep  ${r.contrast}   (need >= ${MIN_CONTRAST})  std ${r.through.std} vs ${r.bare.std}`);
    console.log(`  ${okMethod ? 'ok  ' : 'FAIL'} spatial debias ${r.spatialDebias}   gap to ablation ${gap.toFixed(4)}`
      + ` vs allowance ${gapAllow.toFixed(4)} (3 x beside-patch noise ${r.besideNoise})`);
    console.log(`       raw through/beside ${r.spatialRaw} — this is the reviewer's own method, undebiased;`
      + ` it measures the wall, not the glass, and the same pane reads 2.53 on one framing and 0.85 on another`);
    console.log(`  framing: aperture element ${r.footprint.apertureWidthPctOfFrame}% of frame width;`
      + ` ablation mask on that row ${r.footprint.housingWidthPx} px`
      + `${r.footprint.housingClipped ? ' (at search limit)' : ''} — bloom-inflated, an upper bound only`);
    console.log(`           viewmodel covers ${r.footprint.rigPct}% of the frame and ${r.footprint.bottom45Pct}% of the bottom 45%`
      + ` (round 9: receiver plus housing filled it)`);
    if (!okNull) console.log('  -> INSTRUMENT UNSTABLE. Ratios below are noise until this reads 1.000.');
    if (!okLevel) console.log('  -> sample sits in the sRGB toe; reframe or relight the view, do not tune the glass to it.');
    if (r.transmit > 1.0) console.log('  -> the pane is EMITTING: it adds light instead of attenuating.');
    else if (!okT && r.transmit > MAX_TRANSMIT) console.log('  -> too transparent to be glass.');
    else if (!okT) console.log('  -> too dark: the sight reads as a hole, not a window.');
    if (!okWorst) console.log('  -> part of the window is brighter than the world beside it: a veil, localised.');
    if (!okCast) console.log('  -> a coloured veil, not a coating. Reflection is being added on axis.');
    if (!okContrast) console.log('  -> the pane is washing the target out; the world through it is flatter than beside it.');
    if (pageErrors.length) { console.log(`  ${pageErrors.length} page error(s): ${pageErrors[0].slice(0, 160)}`); failed = true; }
  } catch (err) {
    console.log(`${view}: ${String(err.message).slice(0, 200)}`);
    failed = true;
  }
  await page.close();
}

await browser.close();
console.log(`\n${failed ? 'FAIL' : 'PASS'} — optic glass ${failed ? 'is NOT behaving as glass' : 'attenuates like AR-coated glass'}`);
process.exitCode = failed ? 1 : 0;
