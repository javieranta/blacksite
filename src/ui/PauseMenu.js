/**
 * OWNER: ui agent.
 * Pause / settings overlay.
 *
 * Opens on Escape, or when pointer lock is lost after having been held (the
 * browser takes the pointer away on Escape before any key event reaches us, so
 * both paths are needed). Never opens in the screenshot rig, which never locks
 * the pointer in the first place.
 *
 * Emits, and owns no state that belongs to anyone else:
 *   'render:quality'       { key, preset }   — PostFX/Lighting consume
 *   'settings:sensitivity' { value }         — camera/player consume
 *   'settings:volume'      { master, sfx }   — AudioEngine consumes
 *   'game:pause'           { paused }
 */
import { QUALITY, CAMERA } from '../core/Constants.js';

const QUALITY_KEYS = ['low', 'medium', 'high', 'cinematic'];

export class PauseMenu {
  constructor(root, ctx) {
    this.ctx = ctx;
    this.open = false;
    this.quality = 'high';
    this.sensitivity = CAMERA.sensitivity;
    this.master = 0.85;
    this.sfx = 1.0;

    const el = document.createElement('div');
    el.className = 'bs-menu';
    el.innerHTML = `
      <div class="bs-menu-inner">
        <div>
          <h1>BLACK<span>SITE</span></h1>
          <div class="sub">operation suspended</div>
        </div>
        <div class="bs-rule"></div>

        <div class="bs-block">
          <div class="bs-label">render quality</div>
          <div class="bs-seg" data-seg="quality">
            ${QUALITY_KEYS.map((k) => `<button data-q="${k}">${k}</button>`).join('')}
          </div>
        </div>

        <div class="bs-block">
          <div class="bs-label">look sensitivity</div>
          <div class="bs-slider">
            <input type="range" min="20" max="400" step="1" data-s="sens" />
            <span class="val" data-v="sens">1.00</span>
          </div>
        </div>

        <div class="bs-block">
          <div class="bs-label">master volume</div>
          <div class="bs-slider">
            <input type="range" min="0" max="100" step="1" data-s="master" />
            <span class="val" data-v="master">85</span>
          </div>
        </div>

        <div class="bs-block">
          <div class="bs-label">weapons &amp; world</div>
          <div class="bs-slider">
            <input type="range" min="0" max="120" step="1" data-s="sfx" />
            <span class="val" data-v="sfx">100</span>
          </div>
        </div>

        <div class="bs-rule"></div>
        <button class="bs-resume">resume</button>
        <div class="bs-menu-hint">esc &nbsp;·&nbsp; click to recapture cursor</div>
      </div>
      <div class="bs-menu-diag">
        <span data-d="res">—</span><i></i><span data-d="fps">—</span><i></i><span data-d="draw">—</span>
      </div>`;
    root.appendChild(el);
    this.el = el;

    this.segButtons = Array.from(el.querySelectorAll('[data-q]'));
    for (const b of this.segButtons) {
      b.addEventListener('click', () => this.setQuality(b.dataset.q));
    }

    this.sens = el.querySelector('[data-s="sens"]');
    this.sensVal = el.querySelector('[data-v="sens"]');
    this.masterIn = el.querySelector('[data-s="master"]');
    this.masterVal = el.querySelector('[data-v="master"]');
    this.sfxIn = el.querySelector('[data-s="sfx"]');
    this.sfxVal = el.querySelector('[data-v="sfx"]');

    this.sens.value = String(Math.round((this.sensitivity / CAMERA.sensitivity) * 100));
    this.masterIn.value = String(Math.round(this.master * 100));
    this.sfxIn.value = String(Math.round(this.sfx * 100));
    this._syncLabels();

    this.sens.addEventListener('input', () => {
      this.sensitivity = CAMERA.sensitivity * (parseFloat(this.sens.value) / 100);
      this._syncLabels();
      ctx.bus.emit('settings:sensitivity', { value: this.sensitivity, scale: parseFloat(this.sens.value) / 100 });
    });
    const volChanged = () => {
      this.master = parseFloat(this.masterIn.value) / 100;
      this.sfx = parseFloat(this.sfxIn.value) / 100;
      this._syncLabels();
      ctx.bus.emit('settings:volume', { master: this.master, sfx: this.sfx });
    };
    this.masterIn.addEventListener('input', volChanged);
    this.sfxIn.addEventListener('input', volChanged);

    el.querySelector('.bs-resume').addEventListener('click', () => this.close());

    this.diag = {
      res: el.querySelector('[data-d="res"]'),
      fps: el.querySelector('[data-d="fps"]'),
      draw: el.querySelector('[data-d="draw"]'),
    };

    this._applyQualityButtons();
  }

  /** Live render diagnostics, refreshed only while the menu is actually open. */
  _refreshDiag() {
    const s = this.ctx.engine?.stats;
    const c = this.ctx.renderer?.domElement;
    if (c) this.diag.res.textContent = `${c.width} × ${c.height}`;
    if (s) {
      this.diag.fps.textContent = `${s.fps} fps`;
      this.diag.draw.textContent = `${s.drawCalls} draws · ${(s.triangles / 1e6).toFixed(2)} m tris`;
    }
  }

  _syncLabels() {
    this.sensVal.textContent = (parseFloat(this.sens.value) / 100).toFixed(2);
    this.masterVal.textContent = this.masterIn.value;
    this.sfxVal.textContent = this.sfxIn.value;
  }

  _applyQualityButtons() {
    for (const b of this.segButtons) b.classList.toggle('on', b.dataset.q === this.quality);
  }

  setQuality(key) {
    if (!QUALITY[key]) return;
    this.quality = key;
    this._applyQualityButtons();
    this.ctx.bus.emit('render:quality', { key, preset: QUALITY[key] });
  }

  toggle() { this.open ? this.close() : this.show(); }

  show() {
    if (this.open) return;
    this.open = true;
    this._refreshDiag();
    this.el.classList.add('on');
    document.body.style.cursor = 'default';
    const engine = this.ctx.engine;
    if (engine) engine.paused = true;
    this.ctx.bus.emit('game:pause', { paused: true });
  }

  close() {
    if (!this.open) return;
    this.open = false;
    this.el.classList.remove('on');
    document.body.style.cursor = 'none';
    const engine = this.ctx.engine;
    if (engine) engine.paused = false;
    this.ctx.bus.emit('game:pause', { paused: false });
    // The click that closed the menu is a user gesture, so re-locking here is
    // allowed; if the browser refuses, the next canvas click does it anyway.
    this.ctx.renderer?.domElement?.requestPointerLock?.();
  }
}
