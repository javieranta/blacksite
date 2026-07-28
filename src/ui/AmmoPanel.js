/**
 * OWNER: ui agent.
 * Bottom-right ammunition block and bottom-left vitals block.
 *
 * Typographic hierarchy, largest to smallest:
 *   1. magazine count  — 52px hand-drawn stencil numerals, the only large
 *                        element on screen; readable in peripheral vision.
 *   2. reserve         — 17px tabular mono, steel, behind a hairline divider.
 *   3. weapon name     — 11px, 0.34em tracking, bone.
 *   4. fire mode /     — 9px, 0.28em tracking, steel.
 *      calibre
 * State: `warn` under 40% of a magazine, `crit` under 15% or at 3 rounds,
 * plus a blinking RELOAD prompt with a progress hairline during the reload.
 */
import { makeDigit, setDigit } from './Glyphs.js';

export class AmmoPanel {
  constructor(root) {
    const wrap = document.createElement('div');
    wrap.className = 'bs-ammo';
    wrap.innerHTML = `
      <div class="bs-reload">reload</div>
      <div class="bs-reload-arc"><i></i></div>
      <div class="bs-ammo-row">
        <div class="bs-mag"></div>
        <div class="bs-res-wrap">
          <div class="bs-res-bar"></div>
          <div class="bs-res"><span class="bs-num">000</span><i>reserve</i></div>
        </div>
      </div>
      <div class="bs-ammo-underline"></div>
      <div class="bs-ammo-meta">
        <div class="bs-wmode">auto · 5.56</div>
        <div class="bs-sep"></div>
        <div class="bs-wname">—</div>
      </div>`;
    root.appendChild(wrap);

    this.wrap = wrap;
    this.magEl = wrap.querySelector('.bs-mag');
    this.resEl = wrap.querySelector('.bs-res .bs-num');
    this.nameEl = wrap.querySelector('.bs-wname');
    this.modeEl = wrap.querySelector('.bs-wmode');
    this.reloadEl = wrap.querySelector('.bs-reload');
    this.arcEl = wrap.querySelector('.bs-reload-arc i');

    // Three fixed digit slots, leading zeros drawn dim rather than hidden so the
    // block never changes width and the eye can lock onto a stable position.
    this.slots = [];
    for (let i = 0; i < 3; i++) {
      const slot = makeDigit();
      this.magEl.appendChild(slot.svg);
      this.slots.push(slot);
    }

    this._mag = -1;
    this._res = -1;
    this._state = '';
    this._name = '';
    this._mode = '';
    this._reloading = false;
    this._reloadT = 0;
    this._reloadLen = 1;
  }

  onReload(phase, weapon, empty) {
    if (phase === 'start') {
      this._reloading = true;
      this._reloadT = 0;
      this._reloadLen = (empty ? weapon?.reloadEmptyTime : weapon?.reloadTime) ?? 2.1;
    } else {
      this._reloading = false;
      this.arcEl.style.transform = 'scaleX(0)';
    }
  }

  update(dt, weapons) {
    const w = weapons?.current;
    const ammo = weapons?.ammo;
    const mag = ammo?.mag ?? 0;
    const res = ammo?.reserve ?? 0;
    const size = w?.magSize ?? 30;

    if (mag !== this._mag) {
      this._mag = mag;
      const clamped = Math.max(0, Math.min(999, mag | 0));
      const hundreds = Math.floor(clamped / 100);
      const tens = Math.floor(clamped / 10) % 10;
      setDigit(this.slots[0], hundreds);
      setDigit(this.slots[1], tens);
      setDigit(this.slots[2], clamped % 10);
      // Dim the digits that are only there to hold the column width.
      this.slots[0].svg.classList.toggle('lead', clamped < 100);
      this.slots[1].svg.classList.toggle('lead', clamped < 10);

      const frac = mag / Math.max(1, size);
      const state = mag <= 3 || frac <= 0.15 ? 'crit' : frac <= 0.4 ? 'warn' : '';
      if (state !== this._state) {
        this._state = state;
        this.magEl.className = `bs-mag${state ? ' ' + state : ''}`;
      }
    }

    if (res !== this._res) {
      this._res = res;
      this.resEl.textContent = String(Math.max(0, res | 0)).padStart(3, '0');
    }

    const name = w?.displayName ?? '—';
    if (name !== this._name) { this._name = name; this.nameEl.textContent = name; }

    // The weapon system publishes the live fire mode; fall back to the weapon's
    // first declared mode if it does not.
    const mode = `${weapons?.state?.mode ?? w?.fireModes?.[0] ?? 'auto'} · ${w?.calibre ?? '—'}`;
    if (mode !== this._mode) { this._mode = mode; this.modeEl.textContent = mode; }

    // Reload prompt: shown while reloading, and as a nag when the magazine is
    // empty but there is still reserve to feed it.
    const nag = !this._reloading && mag === 0 && res > 0;
    const showPrompt = this._reloading || nag;
    if (this.reloadEl.classList.contains('on') !== showPrompt) {
      this.reloadEl.classList.toggle('on', showPrompt);
    }
    if (this._reloading) {
      // Prefer the weapon system's own reload progress when it publishes one —
      // that way an interrupted or cancelled reload is reflected exactly.
      this._reloadT = Math.min(this._reloadLen, this._reloadT + dt);
      const live = weapons?.state?.reloadProgress;
      const p = typeof live === 'number' ? live : this._reloadT / this._reloadLen;
      this.arcEl.style.transform = `scaleX(${Math.max(0, Math.min(1, p)).toFixed(3)})`;
      this.arcEl.style.transformOrigin = 'left';
      // A cancelled reload never emits phase 'end'; watch the flag as well.
      if (weapons?.state && weapons.state.reloading === false) {
        this._reloading = false;
        this.arcEl.style.transform = 'scaleX(0)';
      }
    }
  }
}

/**
 * Health and armour. Deliberately quiet: the primary channel for "you are hurt"
 * is the screen effect in Feedback.js, so this block is a confirmation, not an
 * alarm — a numeric plus a segmented strip that reads at a glance without
 * demanding attention.
 */
export class VitalsPanel {
  constructor(root, segments = 12) {
    const wrap = document.createElement('div');
    wrap.className = 'bs-vitals';
    wrap.innerHTML = `
      <div class="bs-armour"></div>
      <div class="bs-hp-row">
        <div class="bs-hp-glyph"></div>
        <div class="bs-hp-seg"></div>
      </div>
      <div class="bs-vitals-underline"></div>
      <div class="bs-vitals-meta">
        <div class="bs-label">vitals</div>
        <div class="bs-sep"></div>
        <div class="bs-label" data-armour-label>unarmoured</div>
      </div>`;
    root.appendChild(wrap);

    this.segEl = wrap.querySelector('.bs-hp-seg');
    this.numEl = wrap.querySelector('.bs-hp-glyph');
    this.armEl = wrap.querySelector('.bs-armour');
    this.armLabel = wrap.querySelector('[data-armour-label]');

    this.slots = [];
    for (let i = 0; i < 3; i++) {
      const slot = makeDigit();
      this.numEl.appendChild(slot.svg);
      this.slots.push(slot);
    }

    this.segs = [];
    for (let i = 0; i < segments; i++) {
      const s = document.createElement('span');
      this.segEl.appendChild(s);
      this.segs.push(s);
    }
    this.plates = [];
    for (let i = 0; i < 4; i++) {
      const s = document.createElement('span');
      this.armEl.appendChild(s);
      this.plates.push(s);
    }

    this._hp = -1;
    this._armour = -1;
    this._state = '';
  }

  update(player, maxHealth) {
    const hp = Math.max(0, Math.round(player?.health ?? maxHealth));
    if (hp !== this._hp) {
      this._hp = hp;
      const c = Math.min(999, hp);
      setDigit(this.slots[0], Math.floor(c / 100));
      setDigit(this.slots[1], Math.floor(c / 10) % 10);
      setDigit(this.slots[2], c % 10);
      this.slots[0].svg.classList.toggle('lead', c < 100);
      this.slots[1].svg.classList.toggle('lead', c < 10);
      const frac = hp / maxHealth;
      const lit = Math.ceil(frac * this.segs.length);
      for (let i = 0; i < this.segs.length; i++) {
        const on = i < lit;
        if (this.segs[i].classList.contains('off') === on) this.segs[i].classList.toggle('off', !on);
      }
      const state = frac <= 0.25 ? 'crit' : frac <= 0.55 ? 'warn' : '';
      if (state !== this._state) {
        this._state = state;
        this.segEl.className = `bs-hp-seg${state ? ' ' + state : ''}`;
        this.numEl.className = `bs-hp-glyph${state ? ' ' + state : ''}`;
      }
    }

    // Armour plates appear only when the player system tracks them; four plates,
    // 25 points each, matching how carrier plates are usually modelled.
    const armour = Math.max(0, Math.round(player?.armour ?? 0));
    if (armour !== this._armour) {
      this._armour = armour;
      const lit = Math.ceil(armour / 25);
      this.armEl.style.display = armour > 0 ? '' : 'none';
      for (let i = 0; i < this.plates.length; i++) {
        this.plates[i].classList.toggle('on', i < lit);
      }
      this.armLabel.textContent = armour > 0 ? `plate ${lit}/4` : 'unarmoured';
    }
  }
}
