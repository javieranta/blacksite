/**
 * Performance readout.
 *
 * Deliberately shows more than a bare FPS number, because a single averaged
 * figure is what let this project believe it was running at 60fps while frames
 * took 167ms. The four values here each answer a different question:
 *
 *   FPS      frames per second, from wall-clock intervals between frame starts
 *   ms       mean frame interval — the honest one; 16.7 is 60fps
 *   worst    slowest frame in the last window. A 16ms mean with a 40ms worst is
 *            a stutter the mean hides completely, and that is exactly what this
 *            build has.
 *   cpu      JavaScript time inside the frame. GPU work is asynchronous, so
 *            cpu ≈ ms means CPU-bound and cpu << ms means GPU-bound. A sudden
 *            cpu spike is almost always a shader link or a GC pause.
 *
 * Colour tracks the frame interval against a 60fps budget: green under 20ms,
 * amber to 33ms (still playable), red beyond.
 *
 * Toggle with F3, or ?perf=1 to have it up from the first frame.
 */
export class PerfPanel {
  constructor(root) {
    const el = document.createElement('div');
    el.className = 'hud-perf';
    el.innerHTML = `
      <span class="v" data-k="fps">--</span><span class="u">fps</span>
      <span class="v" data-k="ms">--</span><span class="u">ms</span>
      <span class="v dim" data-k="worst">--</span><span class="u dim">worst</span>
      <span class="v dim" data-k="cpu">--</span><span class="u dim">cpu</span>`;
    root.appendChild(el);
    this.el = el;
    this.fields = {
      fps: el.querySelector('[data-k="fps"]'),
      ms: el.querySelector('[data-k="ms"]'),
      worst: el.querySelector('[data-k="worst"]'),
      cpu: el.querySelector('[data-k="cpu"]'),
    };

    const params = new URLSearchParams(location.search);
    this.visible = params.get('perf') === '1';
    el.style.display = this.visible ? '' : 'none';

    this._onKey = (e) => {
      if (e.code !== 'F3') return;
      e.preventDefault();
      this.toggle();
    };
    addEventListener('keydown', this._onKey);

    this._accum = 0;
  }

  toggle(on) {
    this.visible = on === undefined ? !this.visible : !!on;
    this.el.style.display = this.visible ? '' : 'none';
  }

  /** Refreshed at 5Hz — a number changing 60 times a second is unreadable. */
  update(dt, stats) {
    if (!this.visible || !stats) return;
    this._accum += dt;
    if (this._accum < 0.2) return;
    this._accum = 0;

    const ms = stats.frameMs || 0;
    this.fields.fps.textContent = String(stats.fps ?? 0);
    this.fields.ms.textContent = ms ? ms.toFixed(1) : '--';
    this.fields.worst.textContent = stats.worstMs ? stats.worstMs.toFixed(0) : '--';
    this.fields.cpu.textContent = stats.cpuMs ? stats.cpuMs.toFixed(1) : '--';

    const cls = ms > 33 ? 'bad' : ms > 20 ? 'warn' : 'good';
    if (cls !== this._cls) {
      this.el.classList.remove('good', 'warn', 'bad');
      this.el.classList.add(cls);
      this._cls = cls;
    }
  }

  dispose() {
    removeEventListener('keydown', this._onKey);
    this.el.remove();
  }
}
