import * as THREE from 'three';

/**
 * OWNER: lighting agent.
 *
 * Replaces the flat ambient term with a directional one, for every material in
 * the project, without any per-material registration.
 *
 * The problem
 * -----------
 * Three's indirect diffuse for a physical material is a single call:
 *
 *     iblIrradiance += getIBLIrradiance( geometryNormal );
 *
 * which reads the diffuse-convolved mip of the environment cube. That is
 * correct as far as it goes, but the environment we have is a sky dome: it
 * carries an altitude gradient and almost no azimuthal structure, and its lower
 * hemisphere is a single averaged ground colour. The result is that a surface
 * facing away from the sun receives the same fill whichever way it faces, and
 * the underside of a beam receives the same fill as its top. That is precisely
 * the "one constant ambient with no directionality and no colour transfer"
 * failure.
 *
 * The fix
 * -------
 * SkyRadianceModel projects a properly azimuthal sky-plus-lit-ground sphere
 * onto 9 spherical harmonics per channel, with the Lambertian convolution
 * constants folded in, so evaluating it against a normal *is* irradiance. This
 * patch bakes those 27 numbers into the shader as literal constants and adds the
 * result to the existing environment term:
 *
 *     iblIrradiance += max( getIBLIrradiance( n ) + blacksiteSkySH( n ), 0 );
 *
 * The DC band is scaled down (see `dcGain`) because the environment map already
 * supplies the overall ambient level; what this term is *for* is the bands 1
 * and 2 — the warm sunward lobe, the cool anti-sun lobe and the ground-bounce
 * lobe from below. Those integrate to nothing over all normals, so adding them
 * changes the shape of the ambient without changing how much of it there is.
 *
 * Specular reflections are deliberately left alone: `getIBLRadiance` still
 * samples Sky's real dome, so a polished surface reflects the sky you can
 * actually see while its diffuse term uses the model. That split is standard
 * practice and it is what lets this be a drop-in.
 *
 * Constants, not uniforms: a uniform would have to be declared and fed on every
 * material in the scene, which means either touching modules this agent does not
 * own or maintaining a registry. Literals cost one shader rebuild per
 * time-of-day change (a scripted, non-per-frame event) and then fold into the
 * arithmetic. `Lighting._recompileMaterials()` drives the rebuild.
 */

const ANCHOR = 'iblIrradiance += getIBLIrradiance( geometryNormal );';
const REPLACEMENT =
  'iblIrradiance += max( getIBLIrradiance( geometryNormal ) + blacksiteSkySH( geometryNormal ), vec3( 0.0 ) );';

const ORIGINAL = { pars: null, maps: null };
let appliedSignature = null;
let patchOk = false;

const v3 = (a, i) => `vec3( ${a[i * 3].toFixed(5)}, ${a[i * 3 + 1].toFixed(5)}, ${a[i * 3 + 2].toFixed(5)} )`;

function buildGLSL(coeff) {
  return /* glsl */`

// ---------------------------------------------------------------------------
// BLACKSITE directional sky irradiance — src/render/lighting/IrradiancePatch.js
// 9-band SH, Lambertian-convolved. See SkyRadianceModel.projectSH().
//
// Guarded on USE_ENVMAP because that is the only configuration in which
// envMapIntensity is declared (envmap_common_pars_fragment) and the only one in
// which the call site below exists. A material with no environment falls back to
// the hemisphere/ambient insurance lights.
// ---------------------------------------------------------------------------
#ifdef USE_ENVMAP

vec3 blacksiteSkySH( const in vec3 normal ) {

	vec3 n = inverseTransformDirection( normal, viewMatrix );

	vec3 e = ${v3(coeff, 0)}
		+ ${v3(coeff, 1)} * n.y
		+ ${v3(coeff, 2)} * n.z
		+ ${v3(coeff, 3)} * n.x
		+ ${v3(coeff, 4)} * ( n.x * n.y )
		+ ${v3(coeff, 5)} * ( n.y * n.z )
		+ ${v3(coeff, 6)} * ( 3.0 * n.z * n.z - 1.0 )
		+ ${v3(coeff, 7)} * ( n.x * n.z )
		+ ${v3(coeff, 8)} * ( n.x * n.x - n.y * n.y );

	return e * envMapIntensity;

}

#endif
`;
}

/**
 * @param {Float32Array} coeff 27 packed SH coefficients (9 bands x rgb)
 * @param {{acGain:number, dcGain:number}} gains
 * @returns {boolean} true if the chunks changed (callers must recompile materials)
 */
export function applyIrradiancePatch(coeff, gains) {
  const ac = gains.acGain;
  const dc = gains.dcGain;
  const scaled = new Float32Array(27);
  for (let k = 0; k < 9; k++) {
    const s = k === 0 ? dc : ac;
    scaled[k * 3] = coeff[k * 3] * s;
    scaled[k * 3 + 1] = coeff[k * 3 + 1] * s;
    scaled[k * 3 + 2] = coeff[k * 3 + 2] * s;
  }

  let sig = '';
  for (let i = 0; i < 27; i++) sig += scaled[i].toFixed(5) + ',';
  if (appliedSignature === sig) return false;

  if (ORIGINAL.pars === null) {
    ORIGINAL.pars = THREE.ShaderChunk.envmap_physical_pars_fragment;
    ORIGINAL.maps = THREE.ShaderChunk.lights_fragment_maps;
  }

  if (!ORIGINAL.maps.includes(ANCHOR) || !ORIGINAL.pars.includes('getIBLIrradiance')) {
    console.warn('[lighting] irradiance anchor not found; keeping stock ambient (three version drift?)');
    patchOk = false;
    appliedSignature = sig;
    return false;
  }

  THREE.ShaderChunk.envmap_physical_pars_fragment = ORIGINAL.pars + buildGLSL(scaled);
  THREE.ShaderChunk.lights_fragment_maps = ORIGINAL.maps.replace(ANCHOR, REPLACEMENT);

  appliedSignature = sig;
  patchOk = true;
  return true;
}

export function irradiancePatchActive() {
  return patchOk;
}

export function revertIrradiancePatch() {
  if (ORIGINAL.pars === null) return;
  THREE.ShaderChunk.envmap_physical_pars_fragment = ORIGINAL.pars;
  THREE.ShaderChunk.lights_fragment_maps = ORIGINAL.maps;
  appliedSignature = null;
  patchOk = false;
}
