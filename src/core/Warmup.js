import * as THREE from 'three';

/**
 * Shader and resource pre-warm.
 *
 * WHY. A player reported the game being "super sluggish for the first minute,
 * then it stabilises". Profiling with tools/warmup.mjs found the cause: WebGL
 * links a shader program the first time a given material/light/shadow
 * permutation is actually DRAWN, and under ANGLE/D3D11 a link is a synchronous
 * main-thread stall. One late link measured **717 ms in a single frame**, six
 * seconds after the loading screen had already gone away.
 *
 * The cost is therefore not paid at load. It is paid one hitch at a time, as the
 * player walks somewhere new, fires the first shot, hits the first metal surface,
 * throws the first grenade — each of which is a permutation nothing has drawn
 * yet. That is exactly the "sluggish for a minute, then fine" shape: it settles
 * when you have finally triggered everything once.
 *
 * WHAT THIS DOES. Runs last in the init order, while the boot screen is still up,
 * and forces every permutation to link before the player ever sees a frame:
 *
 *   1. renderer.compileAsync on both scenes — the bulk of world and viewmodel
 *      material/light combinations.
 *   2. Every particle effect spawned once, far below the world, so the FX
 *      materials link. These are the ones a compile pass cannot reach, because
 *      nothing has spawned them yet and they are not in the graph.
 *   3. Every weapon viewmodel built once, so switching weapons mid-fight does not
 *      stall — only the equipped weapon is built at boot.
 *   4. A few frames rendered to flush anything left.
 *
 * The work is real either way; this moves it behind the progress bar where it is
 * expected, instead of into gameplay where it reads as the game being broken.
 */

/** Far below the map, outside every cascade and frustum. Nothing can see it. */
const LIMBO = new THREE.Vector3(0, -500, 0);

/**
 * Every named effect in the FX contract. Missing names are ignored, so this list
 * failing to keep up with Particles costs a hitch, never an error.
 */
const EFFECTS = [
  'muzzle', 'smoke_puff', 'sparks', 'dust', 'debris', 'blood', 'shell',
  'tracer', 'explosion', 'glass', 'water_splash', 'ember',
];

/** Surfaces whose impact response has its own decal/particle materials. */
const SURFACES = [
  'concrete', 'metal', 'wood', 'dirt', 'sand', 'glass', 'fabric', 'flesh', 'water',
];

export class Warmup {
  constructor() {
    this.name = 'warmup';
    this.stats = { programsBefore: 0, programsAfter: 0, ms: 0 };
  }

  async init(ctx) {
    const t0 = performance.now();
    const { renderer, scene, camera, viewScene, viewCamera } = ctx;
    this.stats.programsBefore = renderer.info.programs?.length ?? 0;

    // --- 1. the scene graphs ------------------------------------------------
    // compileAsync walks the graph and links every material against the lights
    // actually present, which is the majority of the cost and the part a
    // synchronous compile() would stall on.
    try {
      if (renderer.compileAsync) {
        await renderer.compileAsync(scene, camera);
        await renderer.compileAsync(viewScene, viewCamera);
      } else {
        renderer.compile(scene, camera);
        renderer.compile(viewScene, viewCamera);
      }
    } catch (err) {
      console.warn('[warmup] scene compile failed, continuing:', err?.message);
    }

    // --- 2. the effects -----------------------------------------------------
    // Particle and decal materials are not in the graph until something spawns
    // them, so no compile pass can reach them. Spawn each once in limbo.
    const particles = ctx.get('particles');
    if (particles?.spawn) {
      for (const name of EFFECTS) {
        try {
          particles.spawn(name, {
            position: LIMBO,
            normal: new THREE.Vector3(0, 1, 0),
            direction: new THREE.Vector3(0, 1, 0),
          });
        } catch { /* an effect this build does not define — not worth a hitch */ }
      }
    }

    // Impact responses carry their own per-surface decal materials.
    for (const surface of SURFACES) {
      ctx.bus.emit('hit:surface', {
        point: LIMBO.clone(),
        normal: new THREE.Vector3(0, 1, 0),
        incoming: new THREE.Vector3(0, -1, 0),
        surface,
        energy: 1,
        warmup: true,
      });
    }

    // --- 3. the other weapons ----------------------------------------------
    // Only the equipped weapon's viewmodel is built at boot, so the first switch
    // mid-fight builds geometry AND links its materials in one frame.
    const viewmodel = ctx.get('viewmodel');
    if (viewmodel?.prewarmAll) {
      try { await viewmodel.prewarmAll(); } catch { /* optional seam */ }
    }

    // --- 4. sweep the view --------------------------------------------------
    // THE ONE THAT ACTUALLY MATTERED. compileAsync links a material's *colour*
    // program, but a shadow-casting object also needs a DEPTH variant, and that
    // is only linked when the object first enters a cascade. Profiling showed
    // the stall did not reproduce at all while the camera was still, and cost
    // ~750 ms the moment the view turned — the player rounds a corner, a hundred
    // new casters enter the cascades, and the frame stops dead.
    //
    // So spin the camera through a full circle and render, which walks every
    // caster through every cascade while the boot screen is still up. Pitch is
    // varied too: the near cascade sees the ground, the far one the skyline.
    // It must be driven through the REAL frame loop, not renderer.render(). The
    // shadow cascades are refitted inside Lighting.update(), so rotating the
    // camera object and calling render() directly re-renders the SAME cascade
    // contents every time and links nothing new — which is exactly what a first
    // attempt at this did, leaving the 750ms stall completely intact.
    //
    // Driving player.yaw and calling engine._frame() reproduces what actually
    // happens when the player turns: CameraRig moves the camera, Lighting
    // refits the cascades, and every caster gets walked through them.
    const engine = ctx.engine;
    const player = ctx.get('player');
    const wasFrozen = engine.frozen;
    engine.frozen = true;               // visuals update, simulation does not
    const savedYaw = player?.yaw ?? 0;
    const savedPitch = player?.pitch ?? 0;

    const STEPS = 12;
    for (let i = 0; i < STEPS; i++) {
      if (player) {
        player.yaw = savedYaw + (i / STEPS) * Math.PI * 2;
        player.pitch = i % 3 === 0 ? -0.4 : i % 3 === 1 ? 0 : 0.28;
      }
      try {
        engine._frame();
      } catch { /* a system mid-construction — the next frame will cover it */ }
      // Yield so a long sweep cannot trip the browser's slow-script guard.
      if (i % 3 === 2) await new Promise((r) => setTimeout(r, 0));
    }

    if (player) { player.yaw = savedYaw; player.pitch = savedPitch; }
    engine.frozen = wasFrozen;
    try { engine._frame(); } catch { /* restored pose */ }

    this.stats.programsAfter = renderer.info.programs?.length ?? 0;
    this.stats.ms = Math.round(performance.now() - t0);
    console.info(
      `[warmup] ${this.stats.ms}ms, programs `
      + `${this.stats.programsBefore} -> ${this.stats.programsAfter}`,
    );
  }
}
