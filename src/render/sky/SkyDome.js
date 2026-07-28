import * as THREE from 'three';
import { AP_GLSL } from './AtmosphereGLSL.js';
import { CLOUD_GLSL, CLOUD_UNIFORM_DECL } from './Clouds.js';
import { apUniforms } from './AerialPerspective.js';

/**
 * OWNER: sky-atmosphere agent.
 *
 * The visible sky. Everything smooth comes out of the radiance LUT that
 * Atmosphere builds; everything sharp is analytic on top of it:
 *
 *   1. LUT lookup — Rayleigh/Mie/ozone single scattering plus a multiple-
 *      scattering term, integrated on the CPU. This is the *same* table the fog
 *      chunk samples, which is what guarantees the horizon and the haze agree.
 *   2. Sun disc at its real angular size with the standard quadratic visible-
 *      band limb-darkening law, plus a circumsolar aureole.
 *   3. Moon disc with a phase-free Lambert sphere shade and its own glow.
 *   4. A jittered-cell star field.
 *   5. Cirrus, then cumulus, composited over all of it — both pushed through the
 *      shared aerial-perspective function at their real distance.
 *
 * The dome is drawn first with depth test and depth write off and the view
 * translation stripped from the model-view matrix, so it is always centred on
 * the camera and can never clip against the 900 m far plane. Because the same
 * material (and the same uniform objects) is instanced into a second scene for
 * the PMREM bake, the image-based lighting is literally the sky you can see —
 * clouds, sun aureole and all.
 */

const VERT = /* glsl */`
varying vec3 vDir;
void main() {
	vDir = position;
	vec4 p = projectionMatrix * mat4( mat3( modelViewMatrix ) ) * vec4( position, 1.0 );
	p.z = p.w;                 // pin to the far plane; never clips
	gl_Position = p;
}
`;

const FRAG = /* glsl */`
precision highp float;
varying vec3 vDir;

${AP_GLSL}
${CLOUD_UNIFORM_DECL}
${CLOUD_GLSL}

uniform vec3  bsEye;
uniform vec4  bsDisc;       // sun disc intensity, moon intensity, stars, exposure
uniform vec3  bsDiscColour;
uniform vec3  bsMoonDir;

/* ------------------------------------------------------------------ stars -- */

/**
 * A 3D hash. A 2D hash of (cell.xy + cell.z * k) correlates along diagonals,
 * which lights up whole neighbourhoods at once and reads as grid-aligned clumps
 * rather than a star field.
 */
float bsHash31( vec3 p ) {
	p = fract( p * 0.3183099 + vec3( 0.71, 0.113, 0.419 ) );
	p *= 17.0;
	return fract( p.x * p.y * p.z * ( p.x + p.y + p.z ) );
}

vec3 bsStars( vec3 d, float t ) {
	vec3 q = d * 240.0;
	vec3 c = floor( q );
	float h = bsHash31( c );
	if ( h < 0.9934 ) return vec3( 0.0 );
	vec3 j = vec3( bsHash31( c + 3.1 ), bsHash31( c + 7.7 ), bsHash31( c + 11.3 ) );
	float dist = length( q - ( c + 0.15 + j * 0.70 ) );
	float mag = bsHash31( c + 19.5 );
	float radius = 0.40 + mag * 0.48;
	// Slow scintillation. Fast twinkle reads as sensor noise, not sky.
	float tw = 0.80 + 0.20 * sin( t * ( 0.6 + mag ) + mag * 43.0 );
	// Spectral class: hot blue-white through cool orange.
	vec3 tint = mix( vec3( 1.0, 0.78, 0.58 ), vec3( 0.74, 0.84, 1.0 ),
	                 bsHash31( c + 31.7 ) );
	return tint * smoothstep( radius, 0.0, dist ) * ( 0.18 + mag * mag * 1.05 ) * tw;
}

/* -------------------------------------------------------------------- main - */

void main() {
	vec3 dir = normalize( vDir );
	float cosG = dot( dir, bsApSunDir );

	// 1. the atmosphere itself
	vec3 L = bsSkyRadiance( dir, cosG );

	// 2. stars, well above the horizon only
	if ( bsDisc.z > 0.001 && dir.y > 0.0 ) {
		L += bsStars( dir, bsCloudTime ) * bsDisc.z * smoothstep( 0.0, 0.10, dir.y );
	}

	// 3. moon: disc plus a tight forward halo
	if ( bsDisc.y > 0.001 ) {
		float mAng = acos( clamp( dot( dir, bsMoonDir ), -1.0, 1.0 ) );
		float mR = 0.0056;
		float mDisc = 1.0 - smoothstep( mR * 0.90, mR * 1.10, mAng );
		// Fake a lit sphere: brighter toward the centre, subtle mare mottling.
		float mu = sqrt( max( 1.0 - pow( clamp( mAng / mR, 0.0, 1.0 ), 2.0 ), 0.0 ) );
		float mare = 0.86 + 0.14 * bsGN( dir * 340.0 );
		float halo = exp( - mAng * 11.0 ) * 0.07 + exp( - mAng * 2.2 ) * 0.012;
		L += vec3( 0.94, 0.95, 1.0 ) * bsDisc.y *
		     ( mDisc * ( 0.55 + 0.45 * mu ) * mare * 2.4 + halo );
	}

	// 4. sun disc: real angular size, quadratic visible-band limb darkening
	if ( bsDisc.x > 0.001 ) {
		float ang = acos( clamp( cosG, -1.0, 1.0 ) );
		float sR = 0.0055;
		float disc = 1.0 - smoothstep( sR * 0.93, sR * 1.07, ang );
		float mu = sqrt( max( 1.0 - pow( clamp( ang / sR, 0.0, 1.0 ), 2.0 ), 0.0 ) );
		float limb = 0.30 + 0.93 * mu - 0.23 * mu * mu;
		// Circumsolar aureole — aerosol scattering just outside the photosphere.
		float aureole = exp( - ang * 130.0 ) * 0.22 + exp( - ang * 26.0 ) * 0.045;
		L += bsDiscColour * bsDisc.x * ( disc * limb + aureole );
	}

	// 5. cloud decks, high first
	vec4 ci = bsCirrusLayer( dir, bsEye );
	L = mix( L, ci.rgb, ci.a );
	vec4 cu = bsCumulusLayer( dir, bsEye );
	L = mix( L, cu.rgb, cu.a );

	L *= bsDisc.w;

	// A sub-LSB dither. The gradient is smooth enough that 8-bit quantisation is
	// the only thing that can band it, and TAA turns this into invisible noise.
	float dth = fract( dot( gl_FragCoord.xy, vec2( 0.0947, 0.1284 ) ) ) - 0.5;
	gl_FragColor = vec4( max( L + dth * 0.0016, 0.0 ), 1.0 );
}
`;

export class SkyDome {
  constructor() {
    this.uniforms = {
      // shared with every fogged material in the scene — same objects
      bsApSky: apUniforms.bsApSky,
      bsApSunDir: apUniforms.bsApSunDir,
      bsApSunColour: apUniforms.bsApSunColour,
      bsApExt: apUniforms.bsApExt,
      bsApFalloff: apUniforms.bsApFalloff,
      bsApMie: apUniforms.bsApMie,

      bsCumulus: { value: new THREE.Vector4(0.35, 0.3, 2.2, 0.9) },
      bsCumulusGeo: { value: new THREE.Vector4(1500, 1200, 6, 1) },
      bsCirrus: { value: new THREE.Vector4(0.25, 6000, 4500, 18) },
      bsCloudSun: { value: new THREE.Vector3(1, 0.95, 0.88) },
      bsCloudAmb: { value: new THREE.Vector3(0.1, 0.13, 0.2) },
      bsCloudTime: { value: 0 },

      bsEye: { value: new THREE.Vector3(0, 1.7, 0) },
      bsDisc: { value: new THREE.Vector4(24, 0, 0, 1) },
      bsDiscColour: { value: new THREE.Vector3(1, 0.92, 0.82) },
      bsMoonDir: { value: new THREE.Vector3(0, -1, 0) },
    };

    this.material = new THREE.ShaderMaterial({
      name: 'sky-dome',
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: this.uniforms,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
      toneMapped: false,     // PostFX tone maps the composite; don't double up
    });

    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 32), this.material);
    this.mesh.name = 'sky-dome';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
    this.mesh.matrixAutoUpdate = false;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
