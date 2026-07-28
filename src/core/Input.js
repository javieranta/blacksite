/**
 * Pointer-lock mouse + keyboard input with a stable action map.
 * Systems read `input.actions` / `input.axis` — never raw key codes.
 */
const DEFAULT_BINDS = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  jump: ['Space'],
  crouch: ['ControlLeft', 'KeyC'],
  sprint: ['ShiftLeft'],
  reload: ['KeyR'],
  use: ['KeyF', 'KeyE'],
  melee: ['KeyV'],
  grenade: ['KeyG'],
  leanLeft: ['KeyQ'],
  leanRight: ['KeyE'],
  next: ['Digit2'],
  prev: ['Digit1'],
  pause: ['Escape'],
};

export class Input {
  constructor() {
    this.name = 'input';
    this.binds = { ...DEFAULT_BINDS };
    this.down = new Set();
    this.pressed = new Set();   // edge: this frame only
    this.released = new Set();
    this.mouse = { dx: 0, dy: 0, left: false, right: false, leftPressed: false, rightPressed: false, wheel: 0 };
    this.locked = false;
    this.enabled = true;
  }

  init(ctx) {
    const el = ctx.renderer.domElement;
    this._el = el;

    addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.down.add(e.code);
      this.pressed.add(e.code);
      if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
    });
    addEventListener('keyup', (e) => {
      this.down.delete(e.code);
      this.released.add(e.code);
    });
    addEventListener('blur', () => { this.down.clear(); this.mouse.left = this.mouse.right = false; });

    el.addEventListener('mousedown', (e) => {
      if (!this.locked) { el.requestPointerLock?.(); return; }
      if (e.button === 0) { this.mouse.left = true; this.mouse.leftPressed = true; }
      if (e.button === 2) { this.mouse.right = true; this.mouse.rightPressed = true; }
    });
    addEventListener('mouseup', (e) => {
      if (e.button === 0) this.mouse.left = false;
      if (e.button === 2) this.mouse.right = false;
    });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    addEventListener('wheel', (e) => { this.mouse.wheel += Math.sign(e.deltaY); }, { passive: true });

    addEventListener('mousemove', (e) => {
      if (!this.locked || !this.enabled) return;
      this.mouse.dx += e.movementX || 0;
      this.mouse.dy += e.movementY || 0;
    });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === el;
      ctx.bus.emit('input:lock', { locked: this.locked });
    });
  }

  /** True while held. */
  action(name) {
    const codes = this.binds[name];
    if (!codes) return false;
    for (const c of codes) if (this.down.has(c)) return true;
    return false;
  }

  /** True only on the frame the key went down. */
  actionPressed(name) {
    const codes = this.binds[name];
    if (!codes) return false;
    for (const c of codes) if (this.pressed.has(c)) return true;
    return false;
  }

  /** -1..1 movement axes in local space. */
  get moveAxis() {
    const x = (this.action('right') ? 1 : 0) - (this.action('left') ? 1 : 0);
    const y = (this.action('forward') ? 1 : 0) - (this.action('back') ? 1 : 0);
    const len = Math.hypot(x, y);
    return len > 1 ? { x: x / len, y: y / len } : { x, y };
  }

  /** Consumes per-frame edges. Registered LAST so every system sees them first. */
  lateUpdate() {
    this.pressed.clear();
    this.released.clear();
    this.mouse.dx = 0;
    this.mouse.dy = 0;
    this.mouse.wheel = 0;
    this.mouse.leftPressed = false;
    this.mouse.rightPressed = false;
  }
}
