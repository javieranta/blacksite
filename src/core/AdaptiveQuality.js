import { QUALITY } from './Constants.js';

/**
 * Adaptive quality governor.
 *
 * WHY THIS EXISTS. The project shipped with a fixed `high` preset, a full-
 * resolution post chain of roughly nine screen passes, and
 * `setPixelRatio(min(devicePixelRatio, 2))` — so on a high-DPI display it drove
 * 3840x2160 through every one of those passes. On integrated graphics that is
 * not a slow frame, it is a slideshow. Nothing measured it either: the old FPS
 * counter derived its number from a `dt` clamped to 0.1s, so it could not read
 * below 10fps, and headless Chromium has no swap chain, so rAF ran on a virtual
 * 60Hz clock and reported a flat 60 regardless of GPU load.
 *
 * The lesson is that a fixed quality target is a bet on hardware you cannot see.
 * This system makes no such bet: it measures the frame interval the player is
 * actually getting and moves the preset until the frame budget is met.
 *
 * LADDER. Steps down fast (two bad windows) and up slowly (four good ones), and
 * refuses to climb back to a level that has already failed twice — an
 * oscillating resolution is more objectionable than a permanently lower one.
 *
 * Registered early in main.js, but only acts once the first window closes, so
 * shader-compilation hitches on the opening frames never trigger a downgrade.
 */

/** Coarsest first — index 0 is the floor, so a step down is `index - 1`. */
export const LADDER = ['low', 'medium', 'high', 'cinematic'];

const TARGET_MS = 16.7;        // 60fps
const BAD_MS = 22.0;           // below ~45fps: step down
const GOOD_MS = 12.5;          // above ~80fps: room to step up
const WINDOW_MS = 1000;
const BAD_WINDOWS = 2;
const GOOD_WINDOWS = 4;
const MAX_DEMOTIONS = 2;       // failures per level before it is locked out

/**
 * Below the lowest preset there is still headroom in the pixel ratio itself.
 * These multiply the device pixel ratio, floored at 0.5 — beyond that the image
 * degrades more than the frame rate improves.
 */
const PIXEL_STEPS = [1.0, 0.85, 0.7, 0.6, 0.5];

export class AdaptiveQuality {
  constructor() {
    this.name = 'quality';
    this.enabled = true;
    this.index = LADDER.indexOf('high');
    this.pixelStep = 0;

    this._samples = [];
    this._windowStart = 0;
    this._bad = 0;
    this._good = 0;
    this._failures = new Map();
    this._last = 0;
    this.locked = false;

    /** Populated by init() and surfaced to the HUD + the shoot rig. */
    this.info = { gpu: 'unknown', integrated: false, preset: 'high', pixelRatio: 1, medianMs: 0, fps: 0 };

    /**
     * Set when the browser is rendering on integrated graphics. On a hybrid
     * laptop that is usually not a hardware limit but a browser GPU-preference
     * default — and the difference is enormous: this project measured 45.8ms
     * (22fps) on an Intel iGPU and 4.2ms (238fps, refresh-capped) on the
     * discrete GPU in the same machine, at the same preset.
     *
     * Worth surfacing rather than silently degrading quality, because the user
     * can fix it in about thirty seconds and no amount of optimisation buys back
     * a 10x factor. Note that a page-side `powerPreference: 'high-performance'`
     * does NOT override it — Chrome picks the adapter per process at startup.
     */
    this.warning = null;
  }

  init(ctx) {
    this.ctx = ctx;
    const params = new URLSearchParams(location.search);

    this.info.gpu = this._detectGpu(ctx.renderer);
    this.info.integrated = /intel|uhd|iris|adreno|mali|apple gpu|swiftshader|llvmpipe|microsoft basic/i
      .test(this.info.gpu);

    // An explicit ?quality= is a deliberate instruction — honour it and stop
    // governing, otherwise the screenshot rig could never hold a preset still.
    if (params.has('quality') && QUALITY[params.get('quality')]) {
      this.index = Math.max(0, LADDER.indexOf(params.get('quality')));
      this.locked = true;
      this.enabled = false;
    } else {
      // Integrated graphics start two rungs down. Climbing is cheap and
      // invisible; opening on a slideshow is not.
      this.index = LADDER.indexOf(this.info.integrated ? 'low' : 'high');
    }
    if (params.get('adaptive') === '0') this.enabled = false;

    if (this.info.integrated && params.get('gpuwarn') !== '0') {
      this.warning = {
        gpu: this.info.gpu.replace(/^ANGLE \(/, '').replace(/\)$/, ''),
        title: 'Running on integrated graphics',
        detail: 'If this machine also has a discrete GPU, the browser is not using it. '
          + 'A page cannot choose the adapter — it is set per browser process by the OS.',
        fix: 'Windows: Settings → System → Display → Graphics → add your browser '
          + '→ Options → High performance. Then fully quit and reopen the browser.',
      };
      console.warn(`[quality] ${this.warning.title}: ${this.warning.gpu}\n${this.warning.fix}`);
      this._showBanner();
    }

    this._apply(true);
  }

  /**
   * Raised here rather than from main.js so it cannot race the point at which
   * `warning` is assigned — the two used to live in different modules and the
   * banner silently never appeared.
   */
  _showBanner() {
    if (typeof document === 'undefined' || document.getElementById('gpu-warning')) return;
    const w = this.warning;
    const el = document.createElement('div');
    el.id = 'gpu-warning';
    el.innerHTML = `
      <strong>${w.title}</strong>
      <span class="gpu">${w.gpu}</span>
      <span>${w.detail}</span>
      <span class="fix">${w.fix}</span>
      <button type="button">Dismiss</button>`;
    el.querySelector('button').addEventListener('click', () => el.remove());
    const attach = () => document.body?.appendChild(el);
    if (document.body) attach();
    else addEventListener('DOMContentLoaded', attach, { once: true });
    setTimeout(() => el.remove(), 30000);
  }

  _detectGpu(renderer) {
    try {
      const gl = renderer.getContext();
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      return dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : 'unknown';
    } catch {
      return 'unknown';
    }
  }

  /** Push the current rung to the renderer and the post chain. */
  _apply(initial = false) {
    const key = LADDER[this.index];
    const preset = QUALITY[key];
    const ctx = this.ctx;

    // The world renders at this pixel ratio; the HUD is DOM and stays native, so
    // dropping it costs no text or hairline crispness.
    const base = Math.min(window.devicePixelRatio || 1, 2);
    const ratio = Math.max(0.5, base * PIXEL_STEPS[this.pixelStep]);
    ctx.renderer.setPixelRatio(ratio);

    Object.assign(ctx.quality, preset);
    Object.assign(ctx.engine.quality, preset);
    ctx.bus.emit('render:quality', { key, preset });

    this.info.preset = key;
    this.info.pixelRatio = +ratio.toFixed(2);
    if (!initial) {
      console.info(`[quality] -> ${key} @ ${ratio.toFixed(2)}x  (${this.info.medianMs.toFixed(1)}ms median)`);
    }
    ctx.bus.emit('quality:changed', { ...this.info });
  }

  _stepDown() {
    const key = LADDER[this.index];
    this._failures.set(key, (this._failures.get(key) ?? 0) + 1);
    if (this.index > 0) {
      this.index--;
    } else if (this.pixelStep < PIXEL_STEPS.length - 1) {
      this.pixelStep++;            // already at 'low': shrink the buffer instead
    } else {
      return false;                // nothing left to give
    }
    this._apply();
    return true;
  }

  _stepUp() {
    if (this.pixelStep > 0) {
      this.pixelStep--;
    } else if (this.index < LADDER.length - 1) {
      const next = LADDER[this.index + 1];
      if ((this._failures.get(next) ?? 0) >= MAX_DEMOTIONS) return false;
      this.index++;
    } else {
      return false;
    }
    this._apply();
    return true;
  }

  update() {
    if (!this.enabled) return;
    const now = performance.now();
    if (!this._last) { this._last = now; this._windowStart = now; return; }

    const interval = now - this._last;
    this._last = now;
    // Ignore absurd intervals: tab-switch, shader compile stall, GC pause. They
    // are real but they are not the steady state we are governing.
    if (interval > 0 && interval < 500) this._samples.push(interval);

    if (now - this._windowStart < WINDOW_MS) return;
    this._windowStart = now;
    if (this._samples.length < 8) { this._samples.length = 0; return; }

    this._samples.sort((a, b) => a - b);
    const median = this._samples[this._samples.length >> 1];
    this._samples.length = 0;
    this.info.medianMs = median;
    this.info.fps = Math.round(1000 / median);

    if (median > BAD_MS) {
      this._good = 0;
      if (++this._bad >= BAD_WINDOWS) { this._bad = 0; this._stepDown(); }
    } else if (median < GOOD_MS) {
      this._bad = 0;
      if (++this._good >= GOOD_WINDOWS) { this._good = 0; this._stepUp(); }
    } else {
      this._bad = 0;
      this._good = 0;
    }
    void TARGET_MS;
  }
}
