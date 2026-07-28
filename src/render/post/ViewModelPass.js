import { Pass } from 'postprocessing';

/**
 * OWNER: postfx agent.
 *
 * Composites ctx.viewScene (the first-person weapon rig) over the resolved
 * world image with a cleared depth buffer, so the gun can never intersect a
 * wall no matter how close the player stands to it. This is the standard FPS
 * two-camera trick and it is why ctx.viewCamera has a 5mm near plane.
 *
 * Placement in the chain is deliberate. It runs *after* AO, depth of field,
 * motion blur and the TAA resolve:
 *
 *   • DoF works off the world depth buffer, which contains no weapon. Drawing
 *     the weapon before DoF would blur it by whatever wall happens to be behind
 *     it. Drawing it after gives us exactly the ADS look we want — weapon
 *     razor-sharp, world softened — for free.
 *   • TAA reprojects with camera velocity only. The weapon moves *with* the
 *     camera (sway, bob, recoil), so its motion vectors would be wrong and it
 *     would ghost across the whole screen, which is far worse than the residual
 *     edge aliasing SMAA leaves on it.
 *
 * It still runs before bloom and the finishing pass, so the weapon picks up
 * bloom on its speculars, the grade, grain and vignette — it is part of the
 * photograph, not a sticker on top of it.
 */
export class ViewModelPass extends Pass {
  constructor(scene, camera) {
    super('ViewModelPass', scene, camera);
    // Draws straight into the current colour buffer; nothing to ping-pong.
    this.needsSwap = false;
  }

  set mainScene(value) {
    // The world scene is not ours — ignore composer.setMainScene.
  }

  set mainCamera(value) {
    // Likewise the world camera.
  }

  render(renderer, inputBuffer) {
    const scene = this.scene;
    if (!scene || scene.children.length === 0) return;

    const target = this.renderToScreen ? null : inputBuffer;
    const prevAutoClear = renderer.autoClear;

    renderer.setRenderTarget(target);
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.render(scene, this.camera);
    renderer.autoClear = prevAutoClear;
  }
}
