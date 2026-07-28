/**
 * Minimal synchronous event bus. This is the ONLY sanctioned way for systems to
 * talk to each other — no system may import another system directly.
 *
 * Canonical events (payload shapes are part of the build contract, see CONTRACT.md):
 *   'weapon:fire'    { origin:Vector3, dir:Vector3, weapon, seed:number }
 *   'weapon:reload'  { weapon, phase:'start'|'end' }
 *   'weapon:switch'  { from, to }
 *   'hit:surface'    { point:Vector3, normal:Vector3, surface:string, incoming:Vector3 }
 *   'hit:actor'      { actor, point:Vector3, normal:Vector3, damage:number, headshot:boolean }
 *   'actor:death'    { actor, point:Vector3 }
 *   'player:damage'  { amount:number, from:Vector3 }
 *   'explosion'      { point:Vector3, radius:number, damage:number }
 *   'shell:eject'    { point:Vector3, velocity:Vector3, calibre:string }
 */
export class EventBus {
  constructor() {
    /** @type {Map<string, Set<Function>>} */
    this._handlers = new Map();
  }

  on(type, fn) {
    let set = this._handlers.get(type);
    if (!set) this._handlers.set(type, (set = new Set()));
    set.add(fn);
    return () => this.off(type, fn);
  }

  off(type, fn) {
    this._handlers.get(type)?.delete(fn);
  }

  emit(type, payload) {
    const set = this._handlers.get(type);
    if (!set) return;
    // Copy so handlers may subscribe/unsubscribe during dispatch.
    for (const fn of [...set]) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`[bus] handler for "${type}" threw:`, err);
      }
    }
  }
}
