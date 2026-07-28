/**
 * OWNER: ui agent.
 * Combat feedback: hitmarkers, directional damage indicators, and the screen
 * state that communicates how hurt the player is.
 *
 * Health is deliberately NOT primarily a bar. It is: desaturation of the whole
 * frame, a red pressure vignette that breathes at roughly a fast pulse rate, and
 * a hit flash on each impact. The numeric in the corner exists to confirm what
 * the screen already told you.
 *
 * Every element here is pooled and reused — nothing is created per event.
 */
import { SVG_NS } from './Glyphs.js';

const HM_POOL = 6;
const DMG_POOL = 6;

function hitmarkerSvg(kind) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 64 64');
  svg.setAttribute('width', '64');
  svg.setAttribute('height', '64');
  const g = document.createElementNS(SVG_NS, 'g');
  const near = kind === 'kill' ? 7 : 6;
  const far = kind === 'kill' ? 20 : kind === 'head' ? 16 : 14;
  const colour = kind === 'kill' ? '#d2452c' : kind === 'head' ? '#d8a24a' : '#dde5ee';
  const w = kind === 'kill' ? 2 : 1.4;
  for (let i = 0; i < 4; i++) {
    const sx = i & 1 ? 1 : -1;
    const sy = i & 2 ? 1 : -1;
    const l = document.createElementNS(SVG_NS, 'line');
    l.setAttribute('x1', String(32 + sx * near));
    l.setAttribute('y1', String(32 + sy * near));
    l.setAttribute('x2', String(32 + sx * far));
    l.setAttribute('y2', String(32 + sy * far));
    l.setAttribute('stroke', colour);
    l.setAttribute('stroke-width', String(w));
    l.setAttribute('stroke-linecap', 'butt');
    g.appendChild(l);
  }
  if (kind === 'head') {
    // A ring says "that one counted double".
    const c = document.createElementNS(SVG_NS, 'circle');
    c.setAttribute('cx', '32'); c.setAttribute('cy', '32'); c.setAttribute('r', '10.5');
    c.setAttribute('fill', 'none'); c.setAttribute('stroke', colour);
    c.setAttribute('stroke-width', '1'); c.setAttribute('opacity', '0.75');
    g.appendChild(c);
  }
  if (kind === 'kill') {
    // Corner brackets — heavier, unmistakable, reads even mid-recoil.
    for (let i = 0; i < 4; i++) {
      const sx = i & 1 ? 1 : -1;
      const sy = i & 2 ? 1 : -1;
      const p = document.createElementNS(SVG_NS, 'path');
      p.setAttribute('d',
        `M ${32 + sx * 24} ${32 + sy * 17} L ${32 + sx * 24} ${32 + sy * 24} L ${32 + sx * 17} ${32 + sy * 24}`);
      p.setAttribute('fill', 'none');
      p.setAttribute('stroke', '#d8a24a');
      p.setAttribute('stroke-width', '1.2');
      g.appendChild(p);
    }
  }
  svg.appendChild(g);
  return { svg, g };
}

function damageSvg() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 480 480');
  svg.setAttribute('width', '480');
  svg.setAttribute('height', '480');
  const g = document.createElementNS(SVG_NS, 'g');
  const inner = document.createElementNS(SVG_NS, 'path');
  inner.setAttribute('d', 'M179 103 A150 150 0 0 1 301 103');
  inner.setAttribute('fill', 'none');
  inner.setAttribute('stroke', '#d2452c');
  inner.setAttribute('stroke-width', '4');
  const outer = document.createElementNS(SVG_NS, 'path');
  outer.setAttribute('d', 'M203 80 A164 164 0 0 1 277 80');
  outer.setAttribute('fill', 'none');
  outer.setAttribute('stroke', '#d2452c');
  outer.setAttribute('stroke-width', '1.5');
  outer.setAttribute('opacity', '0.55');
  g.appendChild(inner);
  g.appendChild(outer);
  svg.appendChild(g);
  return { svg, g };
}

export class Feedback {
  constructor(root) {
    // --- screen state layers, back to front -------------------------------
    this.desat = document.createElement('div');
    this.desat.className = 'bs-desat';
    root.appendChild(this.desat);

    this.vig = document.createElement('div');
    this.vig.className = 'bs-fx';
    root.appendChild(this.vig);

    this.flash = document.createElement('div');
    this.flash.className = 'bs-flash';
    root.appendChild(this.flash);

    // --- directional damage arcs ------------------------------------------
    this.dmgWrap = document.createElement('div');
    this.dmgWrap.className = 'bs-dmg';
    root.appendChild(this.dmgWrap);
    this.dmg = [];
    for (let i = 0; i < DMG_POOL; i++) {
      const d = damageSvg();
      d.svg.style.position = 'absolute';
      d.svg.style.left = '0';
      d.svg.style.top = '0';
      d.svg.style.opacity = '0';
      this.dmgWrap.appendChild(d.svg);
      this.dmg.push({ ...d, life: 0, max: 1, angle: 0 });
    }

    // --- hitmarkers -------------------------------------------------------
    this.hmWrap = document.createElement('div');
    this.hmWrap.className = 'bs-hm';
    this.hmWrap.style.opacity = '1';
    root.appendChild(this.hmWrap);
    this.hm = [];
    for (let i = 0; i < HM_POOL; i++) {
      const kind = i < 3 ? 'hit' : i < 5 ? 'head' : 'kill';
      const m = hitmarkerSvg(kind);
      m.svg.style.position = 'absolute';
      m.svg.style.left = '0';
      m.svg.style.top = '0';
      m.svg.style.opacity = '0';
      this.hmWrap.appendChild(m.svg);
      this.hm.push({ ...m, kind, life: 0, max: 1 });
    }

    this._flash = 0;
    this._pulse = 0;
    this._lastVig = -1;
    this._lastDesat = -1;
    this._lastFlash = -1;
  }

  /** kind: 'hit' | 'head' | 'kill' */
  hitmarker(kind = 'hit') {
    // Reuse the least-recently-active marker of the requested kind.
    let best = null;
    for (let i = 0; i < this.hm.length; i++) {
      const m = this.hm[i];
      if (m.kind !== kind) continue;
      if (!best || m.life < best.life) best = m;
    }
    if (!best) best = this.hm[0];
    best.max = kind === 'kill' ? 0.52 : 0.24;
    best.life = best.max;
  }

  /**
   * `angleDeg` is measured clockwise from screen-up, i.e. 0 means the shot came
   * from straight ahead and 90 means it came from the player's right.
   */
  damage(angleDeg, severity = 1) {
    let best = null;
    // Reinforce a live indicator already pointing roughly the same way, so
    // sustained fire from one direction reads as one arc, not six.
    for (let i = 0; i < this.dmg.length; i++) {
      const d = this.dmg[i];
      if (d.life <= 0) continue;
      const delta = Math.abs(((d.angle - angleDeg + 540) % 360) - 180);
      if (delta > 155) { best = d; break; }   // within 25 degrees
    }
    if (!best) {
      for (let i = 0; i < this.dmg.length; i++) {
        const d = this.dmg[i];
        if (!best || d.life < best.life) best = d;
      }
    }
    best.angle = angleDeg;
    best.max = 1.05;
    best.life = best.max;
    best.g.setAttribute('transform', `rotate(${angleDeg.toFixed(1)} 240 240)`);
    this._flash = Math.min(1, this._flash + 0.35 + severity * 0.006);
  }

  update(dt, player, maxHealth) {
    // ---- hitmarkers: fast pop, fast fade, slight outward scale -----------
    for (let i = 0; i < this.hm.length; i++) {
      const m = this.hm[i];
      if (m.life <= 0) continue;
      m.life -= dt;
      const t = Math.max(0, m.life / m.max);
      const scale = 1.28 - 0.28 * t;
      m.svg.style.opacity = t > 0 ? Math.min(1, t * 2.4).toFixed(3) : '0';
      m.g.setAttribute('transform', `translate(32 32) scale(${scale.toFixed(3)}) translate(-32 -32)`);
      if (m.life <= 0) m.svg.style.opacity = '0';
    }

    // ---- damage arcs: hold, then fade ------------------------------------
    for (let i = 0; i < this.dmg.length; i++) {
      const d = this.dmg[i];
      if (d.life <= 0) continue;
      d.life -= dt;
      const t = Math.max(0, d.life / d.max);
      d.svg.style.opacity = (t > 0.75 ? 1 : t / 0.75).toFixed(3);
      if (d.life <= 0) d.svg.style.opacity = '0';
    }

    // ---- health as screen state ------------------------------------------
    const hp = Math.max(0, player?.health ?? maxHealth);
    const hurt = 1 - hp / maxHealth;                  // 0 fine, 1 dead
    this._pulse += dt * (2.1 + hurt * 3.4);
    const breathe = 0.5 + 0.5 * Math.sin(this._pulse);
    // Nothing at all until a quarter of health is gone, then it ramps hard.
    const pressure = Math.max(0, (hurt - 0.22) / 0.78);
    const vig = Math.pow(pressure, 1.35) * (0.72 + 0.28 * breathe);
    const desat = Math.pow(pressure, 1.9) * 0.9;

    if (Math.abs(vig - this._lastVig) > 0.004) {
      this._lastVig = vig;
      this.vig.style.opacity = vig.toFixed(3);
    }
    if (Math.abs(desat - this._lastDesat) > 0.006) {
      this._lastDesat = desat;
      // backdrop-filter is not free; keep the layer entirely out of the
      // compositor until the player is actually in trouble.
      this.desat.style.display = desat > 0.01 ? '' : 'none';
      this.desat.style.opacity = desat.toFixed(3);
    }

    this._flash *= Math.exp(-7.5 * dt);
    if (Math.abs(this._flash - this._lastFlash) > 0.004) {
      this._lastFlash = this._flash;
      this.flash.style.opacity = this._flash.toFixed(3);
    }
  }
}
