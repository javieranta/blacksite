import { LUT_W, LUT_H } from './Atmosphere.js';

/**
 * OWNER: sky-atmosphere agent.
 *
 * The GLSL half of the atmosphere. Two clients include the exact same source:
 * the sky dome (`SkyDome.js`) and the fog chunk that every opaque material in
 * the project runs (`AerialPerspective.js`). That is deliberate — the whole
 * reason distant geometry used to read as flat cardboard is that the fog colour
 * and the sky colour were computed by two different pieces of code. Here there
 * is only one, and it is a table lookup, so they cannot disagree.
 *
 * Uniform block (all shared singletons, see SharedUniforms.js):
 *   bsApSky        sampler2D  radiance LUT, (gamma, elevation)
 *   bsApSunDir     vec3       world-space sun direction
 *   bsApSunColour  vec3       key-light colour, matched to Lighting's sun
 *   bsApExt        vec3       per-channel extinction at ground level, 1/m
 *   bsApFalloff    vec4       x: haze scale height, y: mist scale height,
 *                             z: mist gain, w: transmittance floor
 *   bsApMie        vec4       x: HG asymmetry, y: forward-scatter strength,
 *                             z: inscatter gain, w: unused
 */

export const AP_UNIFORM_DECL = /* glsl */`
uniform sampler2D bsApSky;
uniform vec3 bsApSunDir;
uniform vec3 bsApSunColour;
uniform vec3 bsApExt;
uniform vec4 bsApFalloff;
uniform vec4 bsApMie;
`;

export const AP_FUNCTIONS = /* glsl */`
const vec2 BS_LUT_TEXEL = vec2( ${(1 / LUT_W).toFixed(8)}, ${(1 / LUT_H).toFixed(8)} );

/**
 * Sky radiance for a world direction. Mapping must stay in lockstep with
 * Atmosphere.radiance() on the CPU:
 *   u = sqrt( gamma / PI )                       gamma = angle to the sun
 *   v = 0.5 + 0.5 * sign(y) * sqrt(|y|)
 */
vec3 bsSkyRadiance( vec3 dir, float cosG ) {
	float gamma = acos( clamp( cosG, -1.0, 1.0 ) );
	float u = sqrt( clamp( gamma * 0.31830988618, 0.0, 1.0 ) );
	float sy = dir.y < 0.0 ? -1.0 : 1.0;
	float v = 0.5 + 0.5 * sy * sqrt( min( abs( dir.y ), 1.0 ) );
	vec2 uv = clamp( vec2( u, v ), BS_LUT_TEXEL * 0.5, 1.0 - BS_LUT_TEXEL * 0.5 );
	return texture2D( bsApSky, uv ).rgb;
}

/** Henyey-Greenstein, normalised. Drives the forward glow toward the sun. */
float bsHG( float cosG, float g ) {
	float gg = g * g;
	float d = max( 1.0 + gg - 2.0 * g * cosG, 1e-4 );
	return ( 1.0 - gg ) / ( 12.56637061 * d * sqrt( d ) );
}

/**
 * Closed-form integral of exp( -y / H ) along a ray. This is what makes the fog
 * height fog rather than a distance ramp: a 200 m chimney top sits in thinner
 * air than its base and desaturates less, and looking down a slope you pick up
 * the extra column.
 */
float bsAirMass( float y0, float dy, float dist, float H ) {
	float e0 = exp( - max( y0, 0.0 ) / H );
	if ( abs( dy ) < 1e-4 ) return dist * e0;
	float e1 = exp( - max( y0 + dy * dist, 0.0 ) / H );
	return max( ( H / dy ) * ( e0 - e1 ), 0.0 );
}

/** Total optical mass between two world points (camera implied by y0/dir). */
float bsOpticalMass( float y0, float dy, float dist ) {
	return bsAirMass( y0, dy, dist, bsApFalloff.x )
	     + bsAirMass( y0, dy, dist, bsApFalloff.y ) * bsApFalloff.z;
}

/**
 * Exponential aerial perspective. "colour" is linear scene radiance, "dir" the
 * normalised camera-to-fragment direction, "dist" the range in metres.
 *
 * Extinction is per channel (blue is scattered out fastest), and the in-scatter
 * is the sky radiance *in the view direction* plus a Mie forward lobe, so a
 * silhouette can never end up brighter than the sky it is standing against and
 * distances toward the sun glow.
 */
vec3 bsApplyScatter( vec3 colour, vec3 dir, float mass ) {
	vec3 trans = max( exp( - bsApExt * mass ), vec3( 1.0 - bsApFalloff.w ) );
	float cosG = dot( dir, bsApSunDir );
	vec3 inscatter = bsSkyRadiance( dir, cosG ) * bsApMie.z;
	inscatter += bsApSunColour * bsHG( cosG, bsApMie.x ) * bsApMie.y;
	return colour * trans + inscatter * ( 1.0 - trans );
}

vec3 bsAerialPerspective( vec3 colour, vec3 dir, float dist, float eyeY ) {
	return bsApplyScatter( colour, dir, bsOpticalMass( eyeY, dir.y, dist ) );
}

/**
 * Aerial perspective for the cloud decks.
 *
 * The ground haze is deliberately exaggerated: 0.003/m is a 1.3 km visual range,
 * roughly ten times the real clear-air value, chosen because that is what reads
 * as depth over the 100-800 m the level actually occupies. Applied unscaled to a
 * deck 1.5 km up it integrates to an optical depth of ~4 at any elevation below
 * the zenith, and every cloud dissolves into the sky — which is exactly what the
 * first build of this did. Clouds therefore see only a fraction of the near-
 * ground layer, which is also the honest reading: that layer is shallow, and a
 * cloud is above it.
 */
vec3 bsAerialPerspectiveCloud( vec3 colour, vec3 dir, float dist, float eyeY ) {
	return bsApplyScatter( colour, dir, bsOpticalMass( eyeY, dir.y, dist ) * bsApMie.w );
}
`;

/** Everything a shader needs, in the right order. */
export const AP_GLSL = AP_UNIFORM_DECL + AP_FUNCTIONS;
