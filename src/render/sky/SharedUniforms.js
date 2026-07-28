import * as THREE from 'three';

/**
 * OWNER: sky-atmosphere agent.
 *
 * Aerial perspective has to reach *every* material in the project — level
 * geometry, props, the backdrop, whatever another agent adds next week — without
 * any of those systems knowing we exist. The only global seam three offers for
 * that is `THREE.ShaderChunk`, and a chunk needs uniforms.
 *
 * The obstacle: when three instantiates the program for a built-in material it
 * runs `UniformsUtils.cloneUniforms` over `ShaderLib[type].uniforms`, and that
 * helper deep-copies anything that looks like a Color / Vector / Matrix /
 * Texture. Every material would therefore get a private copy of our uniforms and
 * we would have to hunt down and write all of them on every sky change.
 *
 * `cloneUniforms` copies by calling `property.clone()`. Overriding `clone()` to
 * return `this` makes the value a *singleton*: three hands the same object to
 * every program it builds, so one write updates the whole scene and there is
 * nothing to enumerate. These subclasses exist for that single reason.
 *
 * They are only ever used for uniforms this module owns, so the usual contract
 * of `clone()` (return an independent copy) is never relied upon elsewhere.
 */

export class SharedVector3 extends THREE.Vector3 {
  clone() { return this; }
}

export class SharedVector4 extends THREE.Vector4 {
  clone() { return this; }
}

export class SharedColor extends THREE.Color {
  clone() { return this; }
}

export class SharedMatrix4 extends THREE.Matrix4 {
  clone() { return this; }
}

/**
 * NB: must be a DataTexture and never a render-target texture — `cloneUniforms`
 * refuses to clone those and substitutes `null`, which would leave the sampler
 * unbound in every material. That is precisely why the sky LUT is built on the
 * CPU instead of rendered into an FBO.
 */
export class SharedDataTexture extends THREE.DataTexture {
  clone() { return this; }
}
