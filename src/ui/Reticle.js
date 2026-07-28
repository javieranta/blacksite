/**
 * OWNER: ui agent.
 * The dynamic reticle.
 *
 * The blade gap is not an arbitrary animation — it is the weapon's real cone of
 * fire projected onto the screen. Given a spread half-angle `s` and the camera's
 * vertical FOV, the radius in pixels of that cone at the crosshair is
 *
 *     r = tan(s) / tan(fov/2) * (viewportHeight / 2)
 *
 * so what the player sees is literally where their bullets can go. Bloom from
 * firing, the movement penalty and the crouch bonus all feed the same angle, and
 * in ADS with an optic the reticle collapses and fades out because the optic's
 * own reticle takes over as the aiming reference.
 */
const BLOOM_DECAY = 5.4;      // 1/s, exponential
const BLOOM_MAX = 0.055;      // radians of extra half-angle
const MIN_GAP = 4;            // px — never let the blades touch the centre dot
const MAX_GAP = 84;           // px — clamp so the reticle stays a reticle
/**
 * A settled weapon's cone is genuinely tiny — the weapon system collapses it to
 * about a tenth of a degree for the first shot — and a cross 12px across reads
 * as a rendering artefact rather than a sight. So the projection sits on a fixed
 * pedestal: the reticle always has presence, and everything above the pedestal
 * is honest cone.
 */
const PEDESTAL = 6.5;         // px
const SPUR_RADIUS = 19;       // px, fixed — frames the reticle and gives it scale

export class Reticle {
  constructor(root) {
    this.el = document.createElement('div');
    this.el.className = 'bs-reticle';
    root.appendChild(this.el);

    this.blades = [];
    for (let i = 0; i < 4; i++) {
      const b = document.createElement('div');
      b.className = `bs-blade ${i < 2 ? 'v' : 'h'}`;
      this.el.appendChild(b);
      this.blades.push(b);
    }
    // Four short diagonal spurs at a fixed radius. They never move, so they act
    // as a scale reference for how far the blades have bloomed, and they give
    // the reticle a recognisable silhouette instead of four anonymous ticks.
    this.spurs = [];
    for (let i = 0; i < 4; i++) {
      const s = document.createElement('div');
      s.className = 'bs-spur';
      s.style.transform = `rotate(${45 + i * 90}deg) translate(${SPUR_RADIUS}px, 0px)`;
      this.el.appendChild(s);
      this.spurs.push(s);
    }

    this.centre = document.createElement('div');
    this.centre.className = 'bs-centre';
    this.el.appendChild(this.centre);

    this.bloom = 0;
    this._gap = 8;
    this._opacity = 1;
    this._lastGap = -1;
    this._lastOpacity = -1;
    this._lastLen = -1;
  }

  /** Called from the fire event; magnitude comes from the weapon's own recoil. */
  onShot(weapon) {
    const kick = weapon?.recoilKick ?? 0.02;
    this.bloom = Math.min(BLOOM_MAX, this.bloom + kick * 0.62 + 0.004);
  }

  /**
   * ctx-free so it can be unit-reasoned about:
   *   weapons  — the weapon system (may be undefined)
   *   player   — the player controller (may be undefined)
   *   fovDeg   — camera vertical FOV
   *   height   — viewport height in px
   */
  update(dt, weapons, player, fovDeg, height) {
    this.bloom *= Math.exp(-BLOOM_DECAY * dt);

    const w = weapons?.current;
    const st = weapons?.state;
    const ads = st?.adsProgress ?? 0;

    // Prefer a live spread value if the weapon system publishes one; otherwise
    // reconstruct it from the weapon's own data the same way firing does.
    let spread = st?.spread;
    if (typeof spread !== 'number') {
      const hip = w?.spreadHip ?? 0.045;
      const aim = w?.spreadAds ?? 0.002;
      spread = hip + (aim - hip) * ads;
      // Movement penalty applies to the hip cone only.
      const v = player?.velocity;
      if (v && ads < 0.999) {
        const speed = Math.hypot(v.x, v.z);
        const moveScale = w?.spreadMoveScale ?? 2.0;
        const k = Math.min(1, speed / 6.7) * (1 - ads);
        spread *= 1 + (moveScale - 1) * k * 0.55;
      }
    }
    if (player?.state?.crouching) spread *= 0.74;
    spread += this.bloom * (1 - ads * 0.85);

    // Project the cone onto the screen.
    const halfFov = (fovDeg * Math.PI) / 360;
    const cone = (Math.tan(spread) / Math.tan(halfFov)) * (height * 0.5);
    let gap = Math.max(MIN_GAP, Math.min(MAX_GAP, PEDESTAL + cone));

    // Blades get shorter as the cone tightens so the shape stays in proportion.
    const len = Math.max(6.5, Math.min(15, 6.5 + cone * 0.2));

    // ADS with an optic: hand over to the optic reticle. Irons keep the blades.
    const optic = w ? (w.optic ?? w.class !== 'smg') : true;
    const fade = optic ? 1 - Math.min(1, ads * 1.25) : 1 - ads * 0.35;
    const target = optic ? gap * (1 - ads) : gap;

    this._gap += (target - this._gap) * Math.min(1, dt * 22);
    this._opacity += (fade - this._opacity) * Math.min(1, dt * 16);

    if (Math.abs(this._opacity - this._lastOpacity) > 0.004) {
      this._lastOpacity = this._opacity;
      this.el.style.opacity = this._opacity.toFixed(3);
      this.centre.style.opacity = (0.62 * this._opacity).toFixed(3);
    }
    // The spurs never move. That is the whole point of them: when the cone
    // blooms the blades travel out past a fixed frame, so how much accuracy has
    // been lost is legible at a glance instead of having to be remembered.
    if (Math.abs(this._gap - this._lastGap) > 0.15 || Math.abs(len - this._lastLen) > 0.2) {
      this._lastGap = this._gap;
      this._lastLen = len;
      const d = this._gap;
      const b = this.blades;
      // Blades are anchored at the centre point; each is pushed out by the gap
      // and then by its own length so the inner tip sits exactly on the cone.
      b[0].style.height = `${len}px`;
      b[1].style.height = `${len}px`;
      b[2].style.width = `${len}px`;
      b[3].style.width = `${len}px`;
      const far = (-(d + len)).toFixed(2);
      const near = d.toFixed(2);
      b[0].style.transform = `translate(0px, ${far}px)`;
      b[1].style.transform = `translate(0px, ${near}px)`;
      b[2].style.transform = `translate(${far}px, 0px)`;
      b[3].style.transform = `translate(${near}px, 0px)`;
    }
  }
}
