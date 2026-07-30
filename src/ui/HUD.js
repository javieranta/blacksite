import { PLAYER } from '../core/Constants.js';
import { injectStyle } from './Style.js';
import { Reticle } from './Reticle.js';
import { AmmoPanel, VitalsPanel } from './AmmoPanel.js';
import { GrenadePanel } from './GrenadePanel.js';
import { Feedback } from './Feedback.js';
import { KillFeed, Compass } from './KillFeed.js';
import { PauseMenu } from './PauseMenu.js';

/**
 * OWNER: ui agent.
 * CONTRACT:
 *   Owns a single DOM overlay above the canvas.
 *   listens: 'hud:visible', 'weapon:fire', 'hit:actor', 'player:damage',
 *            'weapon:reload', 'actor:death'
 *   Reads:   ctx.get('weapons').ammo / .state / .current, ctx.get('player').health
 *   Emits:   'render:quality', 'settings:sensitivity', 'settings:volume',
 *            'game:pause'  (all from the pause menu)
 *
 * The overlay is DOM rather than an ortho scene on purpose: it stays at native
 * resolution while the world renders at `RENDER.resolutionScale`, so hairlines
 * and small type are never resampled — the single biggest thing separating a
 * shipped HUD from an in-engine one.
 *
 * Layout (1920x1080):
 *   centre        reticle, hitmarkers, directional damage arcs
 *   top centre    heading tape
 *   top right     kill feed
 *   bottom left   vitals (numeric + segmented strip, armour plates)
 *   bottom right  ammunition (stencil magazine count, reserve, weapon, mode)
 *   full screen   damage vignette / desaturation / hit flash
 */
export class HUD {
  constructor() {
    this.name = 'hud';
    this.visible = true;
    this._hadLock = false;
    this._lastHead = { actor: null, t: -1 };
    this._t = 0;
  }

  init(ctx) {
    this.ctx = ctx;
    injectStyle();

    const root = document.createElement('div');
    root.id = 'hud';
    root.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:50;overflow:hidden;';
    document.body.appendChild(root);
    this.root = root;

    this.feedback = new Feedback(root);
    this.reticle = new Reticle(root);
    this.ammo = new AmmoPanel(root);
    this.ordnance = new GrenadePanel(root);
    this.vitals = new VitalsPanel(root);
    this.feed = new KillFeed(root);
    this.compass = new Compass(root);
    this.menu = new PauseMenu(root, ctx);

    this._h = Math.max(1, ctx.renderer.domElement.clientHeight || window.innerHeight);

    const bus = ctx.bus;

    // Handlers never destructure their payload: EventBus turns a throw into a
    // console.error, and a console.error fails the screenshot build.
    bus.on('hud:visible', (e) => {
      const visible = e?.visible !== false;
      this.visible = visible;
      root.style.display = visible ? '' : 'none';
      if (!visible && this.menu.open) this.menu.close();
    });

    bus.on('weapon:fire', (e) => this.reticle.onShot(e?.weapon));

    bus.on('weapon:reload', (e) => {
      this.ammo.onReload(e?.phase, e?.weapon, e?.empty);
    });

    bus.on('hit:actor', (e) => {
      this.feedback.hitmarker(e?.headshot ? 'head' : 'hit');
      if (e?.headshot) this._lastHead = { actor: e.actor, t: this._t };
    });

    // Blast damage is resolved by the grenade system, not by Ballistics, so it
    // never raises 'hit:actor'. Without this the player gets no confirmation
    // that a frag connected — and a grenade with no feedback feels broken even
    // when it is killing things.
    bus.on('grenade:hit', (e) => {
      if (!e?.killed) this.feedback.hitmarker('hit');
    });

    bus.on('actor:death', (e) => {
      this.feedback.hitmarker('kill');
      const w = this.ctx.get('weapons');
      const headshot = this._lastHead.actor === e?.actor && this._t - this._lastHead.t < 0.35;
      this.feed.push({
        killer: e?.killer ?? 'operator',
        victim: e?.actor?.name ?? e?.actor?.displayName ?? 'hostile',
        // A kill carries the thing that made it; only fall back to whatever is
        // in the player's hands when the payload does not say. Otherwise a
        // grenade kill is credited to the rifle you happen to be holding.
        weapon: e?.weapon?.displayName ?? w?.current?.displayName ?? '',
        headshot,
        byPlayer: e?.byPlayer ?? true,
      });
    });

    bus.on('player:damage', (e) => {
      const angle = this._bearingTo(e?.from);
      this.feedback.damage(angle, e?.amount ?? 10);
    });

    // Escape reaches us only when the pointer is not locked; when it is, the
    // browser eats it to release the lock, so we also watch the lock state.
    this._onKey = (ev) => {
      if (ev.code !== 'Escape' || !this.visible) return;
      this.menu.toggle();
    };
    addEventListener('keydown', this._onKey);
    bus.on('input:lock', (e) => {
      if (e?.locked) { this._hadLock = true; if (this.menu.open) this.menu.close(); }
      else if (this._hadLock && this.visible) this.menu.show();
    });
  }

  /**
   * Bearing of a world position relative to where the player is looking, in
   * degrees clockwise from screen-up. 0 = dead ahead, 90 = to the right.
   */
  _bearingTo(from) {
    if (!from) return 0;
    const cam = this.ctx.camera;
    const dx = from.x - cam.position.x;
    const dz = from.z - cam.position.z;
    // Camera forward on the ground plane, from the view matrix's third column.
    const e = cam.matrixWorld.elements;
    const fx = -e[8];
    const fz = -e[10];
    const rx = e[0];
    const rz = e[2];
    const f = dx * fx + dz * fz;
    const r = dx * rx + dz * rz;
    return (Math.atan2(r, f) * 180) / Math.PI;
  }

  resize(w, h) {
    this._h = Math.max(1, h);
  }

  update(dt, ctx) {
    if (!this.visible) return;
    // Engine zeroes dt while paused; keep a small floor so fades still resolve
    // instead of freezing mid-animation behind the menu.
    const d = dt > 0 ? dt : 0;
    this._t += d;

    const weapons = ctx.get('weapons');
    const player = ctx.get('player');

    this.reticle.update(Math.max(d, 1 / 240), weapons, player, ctx.camera.fov, this._h);
    this.ammo.update(d, weapons);
    this.ordnance.update(d, weapons?.grenades);
    this.vitals.update(player, PLAYER.maxHealth);
    this.feedback.update(Math.max(d, 1 / 240), player, PLAYER.maxHealth);
    this.feed.update(d);
    this.compass.update(player?.yaw ?? 0);
  }

  dispose() {
    removeEventListener('keydown', this._onKey);
    this.root?.remove();
  }
}
