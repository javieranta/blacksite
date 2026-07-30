/**
 * OWNER: ui agent.
 * Ordnance block — hand-grenade stock and the cook clock. Sits directly above
 * the ammunition block in the bottom-right corner, sharing its column width,
 * its hairline underline and its meta row, so the corner reads as one panel
 * with two rows rather than two competing widgets.
 *
 * Hierarchy, largest to smallest:
 *   1. stock pips      — one skewed segment per grenade, the same segment
 *                        language as the health strip; spent pips drop to 9%.
 *   2. count numeral   — 15px tabular mono, one step below the reserve figure.
 *   3. FRAG / [G]      — 9px 0.28em label, steel.
 * The cook clock only exists while the pin is out: an amber COOK caption over a
 * draining hairline, exactly mirroring the reload arc, going red for the last
 * second. Nothing about the block moves or animates when it is idle — the HUD
 * is quiet until it has something to say.
 */
export class GrenadePanel {
  constructor(root) {
    const wrap = document.createElement('div');
    wrap.className = 'bs-ord';
    wrap.innerHTML = `
      <div class="bs-ord-cook">cook</div>
      <div class="bs-ord-fuse"><i></i></div>
      <div class="bs-ord-row">
        <div class="bs-ord-pips"></div>
        <div class="bs-ord-count bs-num">0</div>
      </div>
      <div class="bs-ord-underline"></div>
      <div class="bs-ord-meta">
        <div class="bs-label">frag</div>
        <div class="bs-sep"></div>
        <div class="bs-label">[g]</div>
      </div>`;
    root.appendChild(wrap);

    this.wrap = wrap;
    this.pipsEl = wrap.querySelector('.bs-ord-pips');
    this.countEl = wrap.querySelector('.bs-ord-count');
    this.cookEl = wrap.querySelector('.bs-ord-cook');
    this.fuseEl = wrap.querySelector('.bs-ord-fuse');
    this.fuseBar = wrap.querySelector('.bs-ord-fuse i');

    this.pips = [];
    this._stock = 0;
    this._count = -1;
    this._cooking = null;
    this._crit = null;
    this._fuseW = -1;
  }

  _buildPips(n) {
    this._stock = n;
    this.pipsEl.textContent = '';
    this.pips.length = 0;
    for (let i = 0; i < n; i++) {
      const s = document.createElement('span');
      this.pipsEl.appendChild(s);
      this.pips.push(s);
    }
  }

  /** @param {object} g the grenade system, or undefined before it exists */
  update(dt, g) {
    if (!g) {
      if (this.wrap.style.display !== 'none') this.wrap.style.display = 'none';
      return;
    }
    if (this.wrap.style.display === 'none') this.wrap.style.display = '';

    const stock = g.constants?.stock ?? 3;
    if (stock !== this._stock) this._buildPips(stock);

    // A cooked grenade is out of the pouch but not yet in the world: show it as
    // spent immediately, because that is what it is. `count` only decrements on
    // release, so the display subtracts the one in your hand.
    const count = Math.max(0, (g.count | 0) - (g.cooking ? 1 : 0));
    if (count !== this._count) {
      this._count = count;
      this.countEl.textContent = String(count);
      for (let i = 0; i < this.pips.length; i++) {
        const on = i < count;
        if (this.pips[i].classList.contains('off') === on) this.pips[i].classList.toggle('off', !on);
      }
      this.wrap.classList.toggle('out', count === 0);
    }

    const cooking = !!g.cooking;
    if (cooking !== this._cooking) {
      this._cooking = cooking;
      this.cookEl.classList.toggle('on', cooking);
      this.fuseEl.classList.toggle('on', cooking);
      if (!cooking) {
        this.fuseBar.style.transform = 'scaleX(0)';
        this._fuseW = -1;
      }
    }

    if (!cooking) return;
    const fuse = Math.max(0.01, g.constants?.fuse ?? 3.4);
    const left = Math.max(0, Math.min(1, (g.fuseLeft ?? 0) / fuse));
    // Quantised to 1% so the transform is not rewritten on identical frames.
    const q = Math.round(left * 100);
    if (q !== this._fuseW) {
      this._fuseW = q;
      this.fuseBar.style.transform = `scaleX(${(q / 100).toFixed(2)})`;
    }
    const crit = (g.fuseLeft ?? 0) < 1.0;
    if (crit !== this._crit) {
      this._crit = crit;
      this.cookEl.classList.toggle('crit', crit);
      this.fuseEl.classList.toggle('crit', crit);
    }
  }
}
