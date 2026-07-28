/**
 * OWNER: ui agent.
 * Kill feed, top-right. Five pooled rows recycled oldest-first; no DOM is
 * created after construction.
 *
 * Row anatomy:  KILLER ──▸ ◆ VICTIM
 * The accent border is amber for the player's own kills and red when the player
 * is the victim, which is the only place the HUD uses red outside of damage.
 */
const ROWS = 5;
const LIFE = 6.0;

export class KillFeed {
  constructor(root) {
    const wrap = document.createElement('div');
    wrap.className = 'bs-feed';
    root.appendChild(wrap);
    this.wrap = wrap;

    this.rows = [];
    for (let i = 0; i < ROWS; i++) {
      const el = document.createElement('div');
      el.className = 'bs-kill';
      el.innerHTML = '<b class="k"></b><em class="w"></em><span class="arrow"></span><span class="hs"></span><b class="v"></b>';
      el.style.display = 'none';
      wrap.appendChild(el);
      this.rows.push({
        el,
        killer: el.querySelector('.k'),
        weapon: el.querySelector('.w'),
        hs: el.querySelector('.hs'),
        victim: el.querySelector('.v'),
        life: 0,
      });
    }
    this._order = [];
  }

  /**
   * @param {object} o { killer, victim, weapon, headshot, byPlayer }
   */
  push(o) {
    // Recycle the oldest row and move it to the bottom of the stack so the
    // newest entry is always closest to the reticle.
    let row = null;
    for (const r of this.rows) if (r.life <= 0) { row = r; break; }
    if (!row) {
      let oldest = this.rows[0];
      for (const r of this.rows) if (r.life < oldest.life) oldest = r;
      row = oldest;
    }
    row.killer.textContent = o.killer ?? 'unknown';
    row.victim.textContent = o.victim ?? 'hostile';
    row.weapon.textContent = o.weapon ?? '';
    row.hs.style.display = o.headshot ? '' : 'none';
    row.el.classList.toggle('enemy', !o.byPlayer);
    row.el.style.display = '';
    row.life = LIFE;
    this.wrap.appendChild(row.el);   // reorder: newest last (bottom)
    // Force a style flush so the transition runs from the offset state.
    void row.el.offsetWidth;
    row.el.classList.add('on');
  }

  update(dt) {
    for (let i = 0; i < this.rows.length; i++) {
      const r = this.rows[i];
      if (r.life <= 0) continue;
      r.life -= dt;
      if (r.life <= 0) {
        r.el.classList.remove('on');
        r.el.style.display = 'none';
      } else if (r.life < 0.4) {
        r.el.classList.remove('on');
      }
    }
  }
}

/**
 * Heading tape, top-centre. Two full revolutions of ticks are laid out once and
 * translated; the modulo keeps the strip continuous without rebuilding anything.
 */
const PX_PER_DEG = 3.05;
const CARDINALS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

export class Compass {
  constructor(root) {
    const wrap = document.createElement('div');
    wrap.className = 'bs-compass';
    const tape = document.createElement('div');
    tape.className = 'bs-tape';
    tape.style.width = `${1080 * PX_PER_DEG}px`;
    wrap.appendChild(tape);
    root.appendChild(wrap);

    const mark = document.createElement('div');
    mark.className = 'bs-compass-mark';
    root.appendChild(mark);

    const bearing = document.createElement('div');
    bearing.className = 'bs-bearing';
    bearing.textContent = '000';
    root.appendChild(bearing);
    this.bearing = bearing;
    this._lastBearing = -1;

    // Three revolutions laid out end to end: the middle one is always what the
    // window is looking at, so the strip never runs out on either side.
    for (let deg = 0; deg < 1080; deg += 5) {
      const major = deg % 45 === 0;
      const t = document.createElement('div');
      t.className = `bs-tick${major ? ' maj' : ''}`;
      t.style.left = `${deg * PX_PER_DEG}px`;
      t.style.height = major ? '11px' : '4px';
      tape.appendChild(t);
      if (major) {
        const c = document.createElement('div');
        c.className = 'bs-card';
        c.style.left = `${deg * PX_PER_DEG}px`;
        c.textContent = CARDINALS[((deg / 45) | 0) % 8];
        tape.appendChild(c);
      }
    }
    this.tape = tape;
    this._last = -999;
  }

  /** yaw in radians, matching PlayerController's convention (0 = -Z = north). */
  update(yaw) {
    let deg = (-yaw * 180) / Math.PI;
    deg = ((deg % 360) + 360) % 360;
    if (Math.abs(deg - this._last) < 0.06) return;
    this._last = deg;
    // +360 lands us in the middle revolution, so the cardinal under the marker
    // is the true heading and there is a full turn of tape either side.
    const x = 210 - (deg + 360) * PX_PER_DEG;
    this.tape.style.transform = `translateX(${x.toFixed(1)}px)`;
    const b = Math.round(deg) % 360;
    if (b !== this._lastBearing) {
      this._lastBearing = b;
      this.bearing.textContent = String(b).padStart(3, '0');
    }
  }
}
