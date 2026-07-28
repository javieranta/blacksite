import * as THREE from 'three';
import { AP_GLSL } from './AtmosphereGLSL.js';
import { SharedVector3, SharedVector4, SharedMatrix4 } from './SharedUniforms.js';

/**
 * OWNER: sky-atmosphere agent.
 *
 * Replaces three's `mix( colour, fogColor, factor )` with a real aerial
 * perspective term, for every material in the project, by rewriting the four
 * fog `ShaderChunk`s.
 *
 * WHY A CHUNK PATCH
 * -----------------
 * The routed defect was "distant geometry does not desaturate or lose contrast
 * with range; the far cooling towers are flat pure-white cutouts *brighter than
 * the sky behind them*". That is not a backdrop bug — the backdrop meshes are
 * ordinary fogged `MeshStandardMaterial`s and were being washed toward a single
 * constant `fogColor` that had no idea which way the camera was looking. Any fix
 * has to be evaluated per fragment against the view direction, and it has to
 * reach geometry owned by other systems (level, props, backdrop, vehicles,
 * anything added later) without those systems opting in. `THREE.ShaderChunk` is
 * the only seam with that reach, and the lighting agent's cascaded-shadow patch
 * already establishes the pattern in this codebase.
 *
 * WHAT IT COMPUTES
 * ----------------
 *   T   = exp( -extinction * opticalMass )    per channel, height-integrated
 *   L   = skyLUT( viewDir ) + sunColour * HG( cosGamma )
 *   out = colour * T + L * (1 - T)
 *
 * `skyLUT` is literally the table the sky dome samples, so the fog converges on
 * the sky exactly at the far plane and the ridge silhouettes at 800 m dissolve
 * into it seamlessly instead of stopping against a mismatched band.
 *
 * ORDERING
 * --------
 * `install()` must run before the first frame, because three resolves
 * `#include`s when it compiles a program and caches the result by material
 * parameters — a later text change would not invalidate the cache. Sky.init()
 * runs before Level/Props/ViewModel build anything and long before the first
 * render, so calling it there is safe. `scene.fog` must still be assigned by the
 * caller: it is what makes three define `USE_FOG` at all.
 */

/* ------------------------------------------------------------- uniforms ---- */

/**
 * One object per uniform, shared by every program (see SharedUniforms.js). These
 * are the live values; Sky writes them and the whole scene follows.
 */
export const apUniforms = {
  bsApSky: { value: null },
  bsApSunDir: { value: new SharedVector3(0, 1, 0) },
  bsApSunColour: { value: new SharedVector3(1, 0.95, 0.9) },
  bsApExt: { value: new SharedVector3(0.0026, 0.0028, 0.003) },
  bsApFalloff: { value: new SharedVector4(500, 30, 0.8, 0.995) },
  bsApMie: { value: new SharedVector4(0.78, 0.15, 1.0, 0.0) },
  bsApViewInv: { value: new SharedMatrix4() },
};

/* ---------------------------------------------------------------- chunks --- */

const CHUNK_KEYS = ['fog_pars_vertex', 'fog_vertex', 'fog_pars_fragment', 'fog_fragment'];
const ORIGINAL = {};
let installed = false;

/**
 * `mvPosition` is guaranteed in scope wherever `fog_vertex` is included (the
 * stock chunk itself reads it), and `bsApViewInv` is the camera's world matrix —
 * so this reconstructs a world position without depending on `worldPosition`,
 * which three only declares under a specific set of defines.
 */
const FOG_PARS_VERTEX = /* glsl */`
#ifdef USE_FOG
	varying float vFogDepth;
	varying vec3 vBsWorld;
	uniform mat4 bsApViewInv;
#endif
`;

const FOG_VERTEX = /* glsl */`
#ifdef USE_FOG
	vFogDepth = - mvPosition.z;
	vBsWorld = ( bsApViewInv * vec4( mvPosition.xyz, 1.0 ) ).xyz;
#endif
`;

const FOG_PARS_FRAGMENT = /* glsl */`
#ifdef USE_FOG

	uniform vec3 fogColor;
	varying float vFogDepth;

	#ifdef FOG_EXP2
		uniform float fogDensity;
	#else
		uniform float fogNear;
		uniform float fogFar;
	#endif

	varying vec3 vBsWorld;
${AP_GLSL}
#endif
`;

/**
 * Runs after `tonemapping_fragment` and `colorspace_fragment`, which are both
 * no-ops when rendering into PostFX's HDR target — so `gl_FragColor` is still
 * linear scene radiance here, the same space the LUT is authored in.
 */
const FOG_FRAGMENT = /* glsl */`
#ifdef USE_FOG
	vec3 bsToEye = vBsWorld - cameraPosition;
	float bsDist = length( bsToEye );
	if ( bsDist > 1e-3 ) {
		gl_FragColor.rgb = bsAerialPerspective(
			gl_FragColor.rgb, bsToEye / bsDist, bsDist, cameraPosition.y );
	}
#endif
`;

/* --------------------------------------------------------------- install --- */

/** Add the shared uniforms to every built-in shader that already has fog. */
function registerUniforms() {
  const add = (target) => {
    for (const name in apUniforms) {
      if (!target[name]) target[name] = apUniforms[name];
    }
  };

  // Custom ShaderMaterials that merge UniformsLib.fog pick them up from here.
  if (THREE.UniformsLib?.fog) add(THREE.UniformsLib.fog);

  // Built-in materials get their uniforms cloned out of ShaderLib, which was
  // already merged at three's module-load time — so patch each entry directly.
  for (const id in THREE.ShaderLib) {
    const u = THREE.ShaderLib[id].uniforms;
    if (u && u.fogColor) add(u);
  }
}

/**
 * @param {THREE.Texture} lut the sky radiance table. Must be a DataTexture —
 *        `cloneUniforms` substitutes null for render-target textures, which
 *        would leave the sampler unbound in every material in the scene.
 * @returns {boolean} true if the patch is live.
 */
export function installAerialPerspective(lut) {
  if (installed) {
    apUniforms.bsApSky.value = lut;
    return true;
  }
  try {
    for (const k of CHUNK_KEYS) {
      if (typeof THREE.ShaderChunk[k] !== 'string') {
        throw new Error(`three has no ShaderChunk.${k}`);
      }
      ORIGINAL[k] = THREE.ShaderChunk[k];
    }
    // Sanity-check the chunks we are replacing still look like we expect. If
    // three's internals have moved we bail out and leave stock fog in place
    // rather than emitting a shader that will not compile.
    if (!ORIGINAL.fog_vertex.includes('mvPosition') ||
        !ORIGINAL.fog_fragment.includes('fogColor') ||
        !ORIGINAL.fog_pars_fragment.includes('vFogDepth')) {
      throw new Error('unexpected fog chunk contents');
    }

    apUniforms.bsApSky.value = lut;
    registerUniforms();

    THREE.ShaderChunk.fog_pars_vertex = FOG_PARS_VERTEX;
    THREE.ShaderChunk.fog_vertex = FOG_VERTEX;
    THREE.ShaderChunk.fog_pars_fragment = FOG_PARS_FRAGMENT;
    THREE.ShaderChunk.fog_fragment = FOG_FRAGMENT;

    installed = true;
    return true;
  } catch (err) {
    console.warn('[sky] aerial perspective patch not applied, falling back to ' +
      'three\'s exponential fog:', err.message);
    for (const k of CHUNK_KEYS) {
      if (ORIGINAL[k] !== undefined) THREE.ShaderChunk[k] = ORIGINAL[k];
    }
    installed = false;
    return false;
  }
}

export function isAerialPerspectiveInstalled() {
  return installed;
}

export function uninstallAerialPerspective() {
  if (!installed) return;
  for (const k of CHUNK_KEYS) THREE.ShaderChunk[k] = ORIGINAL[k];
  installed = false;
}
