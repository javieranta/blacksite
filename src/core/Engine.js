import * as THREE from 'three';
import { EventBus } from './EventBus.js';
import { WORLD, CAMERA, RENDER, QUALITY } from './Constants.js';

/**
 * Engine owns the renderer, the scene graph root, the clock and the system
 * registry. It knows nothing about gameplay.
 *
 * A "system" is any object with:
 *   name           : string (unique)
 *   init?(ctx)     : Promise<void> | void   — called once, in registration order
 *   fixedUpdate?(h, ctx) : void             — fixed 120Hz tick (physics/gameplay)
 *   update?(dt, ctx)     : void             — variable tick (visuals/interp)
 *   render?(dt, ctx)     : boolean          — if a system returns true from
 *                                             render(), Engine skips its own
 *                                             renderer.render() call (PostFX owns
 *                                             the frame in that case)
 *   resize?(w, h, ctx)   : void
 *   dispose?()           : void
 */
export class Engine {
  constructor(container) {
    this.container = container;

    this.renderer = new THREE.WebGLRenderer({
      antialias: false,          // handled in the post stack (SMAA/TAA)
      alpha: false,
      stencil: false,
      depth: true,
      powerPreference: 'high-performance',
      logarithmicDepthBuffer: false,
    });
    // Boot at 1:1. AdaptiveQuality raises this only if the measured frame time
    // proves the hardware can afford it. The previous min(devicePixelRatio, 2)
    // drove a ~9-pass post chain at 3840x2160 on a high-DPI display before
    // anything had measured whether that was survivable — it was not (600ms
    // frames on integrated graphics).
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.AgXToneMapping;
    this.renderer.toneMappingExposure = RENDER.exposure;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.shadowMap.autoUpdate = true;
    this.renderer.info.autoReset = false;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();

    const aspect = container.clientWidth / Math.max(1, container.clientHeight);
    this.camera = new THREE.PerspectiveCamera(CAMERA.fovBase, aspect, CAMERA.near, CAMERA.far);
    this.camera.position.set(0, 1.7, 0);

    // A second scene rendered on top with a dedicated near-plane camera keeps the
    // first-person viewmodel from clipping into world geometry — the standard
    // trick every FPS uses.
    this.viewScene = new THREE.Scene();
    this.viewCamera = new THREE.PerspectiveCamera(65, aspect, 0.005, 12);

    this.clock = new THREE.Clock();
    this.bus = new EventBus();

    /** @type {Map<string, any>} */
    this.systems = new Map();
    this._ordered = [];

    this.quality = QUALITY.high;
    this.paused = false;
    this.frozen = false;      // shoot-rig: run systems but hold simulation time
    this.elapsed = 0;
    this.frame = 0;
    this._accumulator = 0;

    this.stats = {
      fps: 0, ms: 0, frameMs: 0, worstMs: 0, cpuMs: 0,
      drawCalls: 0, triangles: 0, programs: 0,
    };
    this._fpsAccum = 0;
    this._fpsFrames = 0;
    this._worstInterval = 0;
    this._lastFrameStart = 0;

    /** Shared context handed to every system. */
    this.ctx = {
      engine: this,
      renderer: this.renderer,
      scene: this.scene,
      camera: this.camera,
      viewScene: this.viewScene,
      viewCamera: this.viewCamera,
      bus: this.bus,
      get: (name) => this.systems.get(name),
      require: (name) => {
        const s = this.systems.get(name);
        if (!s) throw new Error(`[engine] required system "${name}" is not registered`);
        return s;
      },
      quality: this.quality,
    };

    this._onResize = this._onResize.bind(this);
    window.addEventListener('resize', this._onResize);
  }

  register(system) {
    if (!system?.name) throw new Error('[engine] system needs a unique .name');
    if (this.systems.has(system.name)) throw new Error(`[engine] duplicate system "${system.name}"`);
    this.systems.set(system.name, system);
    this._ordered.push(system);
    return system;
  }

  async init(onProgress = () => {}) {
    const total = this._ordered.length;
    for (let i = 0; i < total; i++) {
      const s = this._ordered[i];
      onProgress(i / total, s.name);
      if (s.init) await s.init(this.ctx);
    }
    onProgress(1, 'ready');
    this._onResize();
  }

  start() {
    this.clock.start();
    const tick = () => {
      this._raf = requestAnimationFrame(tick);
      this._frame();
    };
    this._raf = requestAnimationFrame(tick);
  }

  stop() {
    cancelAnimationFrame(this._raf);
  }

  _frame() {
    const t0 = performance.now();
    let dt = Math.min(this.clock.getDelta(), 0.1);
    if (this.paused) dt = 0;

    if (!this.frozen) {
      this.elapsed += dt;
      this._accumulator += dt;
      let steps = 0;
      while (this._accumulator >= WORLD.fixedStep && steps < WORLD.maxSubSteps) {
        for (const s of this._ordered) s.fixedUpdate?.(WORLD.fixedStep, this.ctx);
        this._accumulator -= WORLD.fixedStep;
        steps++;
      }
      if (steps === WORLD.maxSubSteps) this._accumulator = 0; // spiral-of-death guard
    }

    for (const s of this._ordered) s.update?.(dt, this.ctx);

    // Whichever system claims the frame (PostFX) renders; otherwise fall back.
    let claimed = false;
    for (const s of this._ordered) {
      if (s.render && s.render(dt, this.ctx) === true) claimed = true;
    }
    if (!claimed) {
      this.renderer.render(this.scene, this.camera);
      this.renderer.autoClear = false;
      this.renderer.clearDepth();
      this.renderer.render(this.viewScene, this.viewCamera);
      this.renderer.autoClear = true;
    }

    this.frame++;

    // Frame timing must come from WALL CLOCK, not from `dt`.
    //
    // `dt` is clamped to 0.1s above and zeroed while paused, so deriving fps
    // from it puts a hard floor of 10fps on the counter — a real 5fps reported
    // as 10, and a stall reported as healthy. And `performance.now() - t0`
    // measures only the JavaScript spent inside this function; GPU work is
    // asynchronous, so on a GPU-bound frame it reads ~2ms while the display is
    // updating at 200ms. Both numbers flattered the engine badly enough to
    // hide a genuine unplayability problem.
    //
    // The interval between successive frame starts is the only figure that
    // reflects what the player actually sees. cpuMs is kept separately, and is
    // only meaningful next to frameMs: cpuMs ≈ frameMs means CPU-bound,
    // cpuMs << frameMs means GPU-bound.
    const now = performance.now();
    const interval = this._lastFrameStart ? now - this._lastFrameStart : 0;
    this._lastFrameStart = now;

    if (interval > 0) {
      this._fpsAccum += interval;
      this._fpsFrames++;
      // Track the worst frame in the window — a median of 16ms with a 120ms
      // spike is a stutter the average would hide entirely.
      if (interval > this._worstInterval) this._worstInterval = interval;
      if (this._fpsAccum >= 500) {
        this.stats.fps = Math.round((this._fpsFrames * 1000) / this._fpsAccum);
        this.stats.frameMs = +(this._fpsAccum / this._fpsFrames).toFixed(2);
        this.stats.worstMs = +this._worstInterval.toFixed(2);
        this._fpsAccum = 0;
        this._fpsFrames = 0;
        this._worstInterval = 0;
      }
    }
    this.stats.cpuMs = +(now - t0).toFixed(2);
    this.stats.ms = this.stats.frameMs;
    this.stats.drawCalls = this.renderer.info.render.calls;
    this.stats.triangles = this.renderer.info.render.triangles;
    this.stats.programs = this.renderer.info.programs?.length ?? 0;
    this.renderer.info.reset();
  }

  _onResize() {
    const w = this.container.clientWidth;
    const h = Math.max(1, this.container.clientHeight);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.viewCamera.aspect = w / h;
    this.viewCamera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    for (const s of this._ordered) s.resize?.(w, h, this.ctx);
  }

  dispose() {
    this.stop();
    window.removeEventListener('resize', this._onResize);
    for (const s of this._ordered) s.dispose?.();
    this.renderer.dispose();
  }
}
