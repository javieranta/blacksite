import * as THREE from 'three';
import { Engine } from './core/Engine.js';
import { Input } from './core/Input.js';
import { QUALITY, TIME_OF_DAY } from './core/Constants.js';
import { AdaptiveQuality } from './core/AdaptiveQuality.js';
import { Warmup } from './core/Warmup.js';

import { MaterialForge } from './render/MaterialForge.js';
import { Sky } from './render/Sky.js';
import { Lighting } from './render/Lighting.js';
import { PostFX } from './render/PostFX.js';

import { Level } from './world/Level.js';
import { Props } from './world/Props.js';

import { Particles } from './fx/Particles.js';
import { Impacts } from './fx/Impacts.js';

import { Ballistics } from './weapons/Ballistics.js';
import { WeaponSystem } from './weapons/WeaponSystem.js';
import { ViewModel } from './weapons/ViewModel.js';

import { PlayerController } from './player/PlayerController.js';
import { CameraRig } from './player/CameraRig.js';

import { EnemyAI } from './ai/EnemyAI.js';
import { AudioEngine } from './audio/AudioEngine.js';
import { HUD } from './ui/HUD.js';

const params = new URLSearchParams(location.search);
const num = (k, d) => (params.has(k) ? parseFloat(params.get(k)) : d);
const flag = (k, d = false) => (params.has(k) ? params.get(k) !== '0' : d);

const container = document.getElementById('app');
const engine = new Engine(container);

const input = new Input();

// --- Registration order IS execution order. Producers before consumers. -------
engine.register(input);
engine.register(new MaterialForge());   // procedural PBR texture atlas
engine.register(new Sky());             // sky dome + atmospheric scattering
engine.register(new Lighting());        // sun, CSM shadows, IBL, volumetrics
engine.register(new Level());           // static world geometry + colliders
engine.register(new Props());           // modular set dressing
engine.register(new Particles());       // GPU particle pools
engine.register(new Impacts());         // decals + surface response
engine.register(new Ballistics());      // raycasting, penetration, damage
engine.register(new PlayerController()); // capsule movement
engine.register(new CameraRig());       // camera feel: bob/sway/recoil/FOV
engine.register(new WeaponSystem());    // fire control, ammo, recoil pattern
engine.register(new ViewModel());       // first-person arms + gun rig
engine.register(new EnemyAI());         // combatants
engine.register(new AudioEngine());     // spatial audio
engine.register(new HUD());             // reticle, health, ammo
engine.register(new PostFX());          // owns the frame — must be last renderer
// After PostFX: it emits 'render:quality' from init(), and PostFX must already
// be subscribed for the opening preset to land.
engine.register(new AdaptiveQuality());  // measures real frame time, moves the preset
// LAST in the init order, and after AdaptiveQuality specifically: presets toggle
// effects on and off, which changes the shader permutations, so the preset must
// be settled before anything is pre-linked. This is what stops the first minute
// of play being a series of 700ms compile stalls. See src/core/Warmup.js.
engine.register(new Warmup());

// Clears per-frame input edges after every system has observed them.
engine.register({
  name: 'input:flush',
  update() { input.lateUpdate(); },
});

const bootEl = document.getElementById('boot');
const barEl = document.getElementById('boot-bar');
const msgEl = document.getElementById('boot-msg');

if (params.has('quality')) {
  const q = QUALITY[params.get('quality')];
  if (q) Object.assign(engine.quality, q), Object.assign(engine.ctx.quality, q);
}

await engine.init((p, name) => {
  barEl.style.width = `${Math.round(p * 100)}%`;
  msgEl.textContent = name;
});

// --- Shoot-rig / debug surface ------------------------------------------------
window.__blacksite = {
  engine,
  scene: engine.scene,
  camera: engine.camera,
  stats: () => ({ ...engine.stats }),
  freeze: (on = true) => { engine.frozen = on; },
  pause: (on = true) => { engine.paused = on; },
  setTOD: (key) => engine.bus.emit('sky:tod', { key, preset: TIME_OF_DAY[key] }),
  setWeather: (key) => engine.bus.emit('sky:weather', { key }),
  setQuality: (key) => engine.bus.emit('render:quality', { key, preset: QUALITY[key] }),
  /** Teleport + aim the player/camera. Used by the screenshot rig. */
  place: (x, y, z, yaw = 0, pitch = 0) => {
    engine.bus.emit('player:teleport', { position: new THREE.Vector3(x, y, z), yaw, pitch });
  },
  setViewmodel: (on) => engine.bus.emit('viewmodel:visible', { visible: on }),
  setHUD: (on) => engine.bus.emit('hud:visible', { visible: on }),
};

// Apply URL params before the first frame so screenshots are deterministic.
if (params.has('tod')) window.__blacksite.setTOD(params.get('tod'));
if (params.has('weather')) window.__blacksite.setWeather(params.get('weather'));
if (params.has('pos')) {
  const [x, y, z] = params.get('pos').split(',').map(Number);
  window.__blacksite.place(x, y, z, num('yaw', 0), num('pitch', 0));
}
if (params.has('hud')) window.__blacksite.setHUD(flag('hud', true));
if (params.has('vm')) window.__blacksite.setViewmodel(flag('vm', true));
// Force poses for the screenshot rig — weapons/viewmodel systems honour these.
if (flag('ads')) engine.bus.emit('weapon:force', { ads: true });
if (flag('fire')) engine.bus.emit('weapon:force', { firing: true });
if (flag('freeze')) engine.frozen = true;

// The integrated-graphics banner is raised by AdaptiveQuality itself, at the
// moment it detects the adapter — see src/core/AdaptiveQuality.js.

engine.start();

bootEl.classList.add('hidden');
setTimeout(() => bootEl.remove(), 700);

// The rig waits on this. Give the renderer a few frames to compile shaders and
// let TAA/AO history converge before declaring the frame photographable.
let warm = 0;
const warmup = () => {
  if (++warm > 12) { window.__ready = true; return; }
  requestAnimationFrame(warmup);
};
requestAnimationFrame(warmup);
