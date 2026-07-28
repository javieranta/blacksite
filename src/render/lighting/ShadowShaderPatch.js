import * as THREE from 'three';

/**
 * OWNER: lighting agent.
 *
 * Replaces three's fixed 9/17-tap PCF shadow lookup with a PCSS-style,
 * low-discrepancy-disc filtered, cascade-aware lookup.
 *
 * How the cascade selection works
 * -------------------------------
 * The rig runs N *nested* directional lights (cascade 0 fitted to the nearest
 * slice of the view frustum, cascade N-1 to the whole shadow distance). Every
 * cascade lights the scene at full sun intensity, so without intervention the
 * scene would be N times too bright. Instead the shadow term returned for
 * cascade i is weighted so that exactly one cascade contributes per fragment:
 *
 *     w_i = f_i * prod_{k<i} (1 - f_k)
 *
 * where f_i is a smooth 0..1 "am I inside cascade i's shadow box" factor. Since
 * the boxes are nested, the tightest (highest resolution) box containing the
 * fragment always wins, the weights sum to 1 inside the outermost box, and a
 * fragment outside *every* cascade gets w = 0 → fully lit. That single property
 * is what kills cascade-boundary leakage: we never sample outside a valid map,
 * and there is no depth-split comparison to produce a seam.
 *
 * Filtering — and why the penumbra ceiling is PER CASCADE
 * ------------------------------------------------------
 * Per fragment: a blocker search estimates the average occluder depth, the
 * penumbra width is derived from the blocker/receiver separation (so the shadow
 * sharpens at the contact point and widens with distance from the caster), then
 * a second pass filters at that radius.
 *
 * The radius has to be *clamped*, and the clamp is the whole ballgame. A single
 * texel-space ceiling shared by all four cascades is meaningless, because a
 * texel is 6 mm on cascade 0 and 125 mm on cascade 3: one number is either a
 * hard edge up close or a two-metre smear in the distance. So the ceiling (and
 * the floor) arrive here as four separate compile-time constants, computed by
 * CascadedShadowMap from a world-metre penumbra budget divided by that
 * cascade's own texel size. Cascade index is a literal after three unrolls its
 * light loop, so the per-cascade branch folds away completely.
 *
 * Taps use a golden-angle (Vogel) disc rotated per pixel by interleaved
 * gradient noise. A Vogel disc is generated with two trig ops instead of a
 * 16-32 entry const table — which matters: the table version pushed the ANGLE
 * D3D11 backend over its dynamic-recompilation limit once the function was
 * inlined four times, and refused to compile at all. The distribution is
 * low-discrepancy with Poisson-like minimum spacing, and the per-pixel rotation
 * turns residual undersampling into blue-noise dither rather than rings.
 *
 * All lookups use textureLod(..., 0.0). Shadow maps have no mip chain, and an
 * implicit-gradient fetch inside a loop under divergent control flow is exactly
 * what HLSL warns X3595 about.
 *
 * Acne / peter-panning
 * --------------------
 * Instead of a large constant depth bias (which detaches shadows from their
 * casters) each tap uses a receiver-plane depth bias derived from the screen
 * space derivatives of the shadow coordinate. The constant bias can then be
 * ~6x smaller and contact points stay welded. A capped normal-offset bias on
 * the geometry side (CascadedShadowMap) covers the rest.
 *
 * The patch is applied to THREE.ShaderChunk so that *every* material in the
 * project — including materials authored by other systems — picks it up with no
 * per-material registration. `getShadow` itself is untouched; we only add
 * `getShadowCSM` and re-point the directional-light call site at it.
 *
 * Debug modes (`?csmdebug=N`)
 *   1  cascade ownership (owned fragments darken)
 *   2  unfiltered single tap — is the map content sharp?
 *   3  hard tap taken before the blocker search
 *   4  raw stored depth, contrast stretched
 *   5  blocker-search hit rate
 *   6  penumbra radius as a fraction of that cascade's ceiling
 *   7  filter result with shadowIntensity bypassed
 *   8  which cascade owns the fragment (4 distinct greys)
 *   9  handled by Lighting: leaves three's stock PCF in place entirely
 */

const ORIGINAL = { pars: null, begin: null };
let appliedSignature = null;
let patchOk = false;

const DIRECTIONAL_ANCHOR =
  'getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, ' +
  'directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, ' +
  'directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] )';

const DIRECTIONAL_REPLACEMENT =
  'getShadowCSM( UNROLLED_LOOP_INDEX, directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, ' +
  'directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, ' +
  'directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] )';

const f = (n) => Number(n).toFixed(4);

function buildGLSL(o) {
  const cmax = o.maxTexels;
  const cmin = o.minTexels;
  return /* glsl */`

// ---------------------------------------------------------------------------
// BLACKSITE cascaded PCSS shadows — src/render/lighting/ShadowShaderPatch.js
// ---------------------------------------------------------------------------
#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0

	#define CSM_BLOCKER_TAPS ${o.blockerTaps}
	#define CSM_FILTER_TAPS ${o.filterTaps}
	#define CSM_BORDER_FADE ${o.borderFade.toFixed(4)}
	#define CSM_RPDB_CLAMP ${o.rpdbClamp.toFixed(6)}
	#define CSM_SEARCH_SPAN ${o.searchSpan.toFixed(4)}
	#define CSM_GOLDEN_ANGLE 2.39996323
	#define CSM_DEBUG ${o.debug | 0}

	// Per-cascade penumbra ceiling / floor, in texels of THAT cascade's map.
	// Derived from a world-metre budget in CascadedShadowMap.filterTexels().
	#define CSM_MAXP_0 ${f(cmax[0])}
	#define CSM_MAXP_1 ${f(cmax[1])}
	#define CSM_MAXP_2 ${f(cmax[2])}
	#define CSM_MAXP_3 ${f(cmax[3])}
	#define CSM_MINP_0 ${f(cmin[0])}
	#define CSM_MINP_1 ${f(cmin[1])}
	#define CSM_MINP_2 ${f(cmin[2])}
	#define CSM_MINP_3 ${f(cmin[3])}

	// Jimenez interleaved gradient noise — spectrally blue, so the per-pixel
	// disc rotation reads as dither instead of banding.
	float csmIGN( const in vec2 pix ) {
		return fract( 52.9829189 * fract( dot( pix, vec2( 0.06711056, 0.00583715 ) ) ) );
	}

	// Smooth "inside this cascade" factor. Zero outside the depth range, faded
	// across a border band so adjacent cascades cross-blend instead of popping
	// and so filter taps never reach past the map edge.
	float csmBoxFactor( const in vec4 coord ) {
		vec3 p = coord.xyz / coord.w;
		if ( p.z <= 0.0 || p.z >= 1.0 ) return 0.0;
		vec2 d = min( p.xy, vec2( 1.0 ) - p.xy );
		return smoothstep( 0.0, CSM_BORDER_FADE, min( d.x, d.y ) );
	}

	float getShadowCSM(
		const in int csmIndex,
		sampler2D shadowMap,
		const in vec2 shadowMapSize,
		const in float shadowIntensity,
		const in float shadowBias,
		const in float penumbraScale,
		const in vec4 myCoord
	) {

		vec3 p = myCoord.xyz / myCoord.w;

		// Receiver-plane depth bias (Isidoro 2006). Derivatives are taken in
		// uniform control flow: every fragment in the quad is evaluating the
		// same cascade index at this point.
		vec3 ddxc = dFdx( p );
		vec3 ddyc = dFdy( p );
		float det = ddxc.x * ddyc.y - ddxc.y * ddyc.x;
		det = ( abs( det ) < 1e-8 ) ? 1e-8 : det;
		vec2 rpdb = vec2(
			ddyc.y * ddxc.z - ddxc.y * ddyc.z,
			ddxc.x * ddyc.z - ddyc.x * ddxc.z
		) / det;

		// Nested-cascade ownership. Unrolled with literal indices on purpose: a
		// varying array is part of the shader input signature and HLSL refuses
		// to index it dynamically (X4576).
		float f0 = csmBoxFactor( vDirectionalShadowCoord[ 0 ] );
		float f1 = 0.0;
		float f2 = 0.0;
		float f3 = 0.0;
		#if NUM_DIR_LIGHT_SHADOWS > 1
			f1 = csmBoxFactor( vDirectionalShadowCoord[ 1 ] );
		#endif
		#if NUM_DIR_LIGHT_SHADOWS > 2
			f2 = csmBoxFactor( vDirectionalShadowCoord[ 2 ] );
		#endif
		#if NUM_DIR_LIGHT_SHADOWS > 3
			f3 = csmBoxFactor( vDirectionalShadowCoord[ 3 ] );
		#endif

		// Every cascade lights the scene at full sun intensity, so a cascade
		// that does NOT own this fragment must return 0 — not 1 — or the sun is
		// multiplied by the cascade count. The fraction of the fragment that no
		// cascade covers (beyond the shadow distance) is redistributed equally
		// as "share", so those fragments still receive exactly one sun's worth
		// of unshadowed light. The weights plus the share always sum to 1.
		float outside = ( 1.0 - f0 ) * ( 1.0 - f1 ) * ( 1.0 - f2 ) * ( 1.0 - f3 );
		float share = outside / float( NUM_DIR_LIGHT_SHADOWS );

		float weight;
		float maxTexels;
		float minTexels;
		if ( csmIndex == 0 ) {
			weight = f0;
			maxTexels = CSM_MAXP_0; minTexels = CSM_MINP_0;
		} else if ( csmIndex == 1 ) {
			weight = f1 * ( 1.0 - f0 );
			maxTexels = CSM_MAXP_1; minTexels = CSM_MINP_1;
		} else if ( csmIndex == 2 ) {
			weight = f2 * ( 1.0 - f1 ) * ( 1.0 - f0 );
			maxTexels = CSM_MAXP_2; minTexels = CSM_MINP_2;
		} else {
			weight = f3 * ( 1.0 - f2 ) * ( 1.0 - f1 ) * ( 1.0 - f0 );
			maxTexels = CSM_MAXP_3; minTexels = CSM_MINP_3;
		}

		if ( weight < 0.002 ) return share;

		#if CSM_DEBUG == 1
			// cascade coverage: owned fragments go dark
			return share + weight * 0.12;
		#endif
		#if CSM_DEBUG == 8
			// which cascade owns this fragment
			return share + weight * ( 0.10 + 0.28 * float( csmIndex ) );
		#endif

		vec2 texel = vec2( 1.0 ) / shadowMapSize;
		float maxUV = maxTexels * texel.x;
		float minUV = minTexels * texel.x;
		float zReceiver = p.z + shadowBias;
		float base = csmIGN( gl_FragCoord.xy ) * 6.28318531;

		#if CSM_DEBUG == 3
			// hard single tap, before the blocker search: separates "is the map
			// readable at this coord" from "does the PCSS search find blockers"
			return weight * step( zReceiver, unpackRGBAToDepth( textureLod( shadowMap, p.xy, 0.0 ) ) ) + share;
		#endif

		// --- blocker search ---------------------------------------------------
		// The search radius is the light's apparent size, so it is bounded by the
		// same per-cascade ceiling as the filter: searching wider than the widest
		// penumbra we are willing to draw only finds irrelevant occluders and
		// smears the estimate.
		float searchUV = clamp( penumbraScale * CSM_SEARCH_SPAN, 1.5 * texel.x, maxUV );
		float blockerSum = 0.0;
		float blockerCount = 0.0;

		for ( int i = 0; i < CSM_BLOCKER_TAPS; i ++ ) {
			float fi = float( i ) + 0.5;
			float a = fi * CSM_GOLDEN_ANGLE + base;
			vec2 o = vec2( cos( a ), sin( a ) ) * sqrt( fi / float( CSM_BLOCKER_TAPS ) ) * searchUV;
			float d = unpackRGBAToDepth( textureLod( shadowMap, p.xy + o, 0.0 ) );
			float zc = zReceiver + clamp( dot( o, rpdb ), -CSM_RPDB_CLAMP, CSM_RPDB_CLAMP );
			#ifdef USE_REVERSED_DEPTH_BUFFER
				float occ = step( zc, d );
			#else
				float occ = step( d, zc );
			#endif
			blockerSum += d * occ;
			blockerCount += occ;
		}

		#if CSM_DEBUG == 4
			// raw stored depth, contrast-stretched around 0.5
			return weight * clamp( ( unpackRGBAToDepth( textureLod( shadowMap, p.xy, 0.0 ) ) - 0.5 ) * 4.0, 0.0, 1.0 ) + share;
		#endif
		#if CSM_DEBUG == 5
			// blocker-search hit rate
			return weight * ( 1.0 - blockerCount / float( CSM_BLOCKER_TAPS ) ) + share;
		#endif

		if ( blockerCount < 0.5 ) return weight + share;

		// Penumbra grows linearly with blocker/receiver separation — the point
		// of PCSS. penumbraScale folds in the cascade depth range, its world
		// extent and the source's angular size (see CascadedShadowMap.js).
		float sep = abs( zReceiver - blockerSum / blockerCount );
		float penumbraUV = clamp( sep * penumbraScale, minUV, maxUV );

		#if CSM_DEBUG == 2
			// unfiltered single tap — isolates map content from the filter
			float dc = unpackRGBAToDepth( textureLod( shadowMap, p.xy, 0.0 ) );
			return weight * step( zReceiver, dc ) + share;
		#endif

		#if CSM_DEBUG == 6
			// penumbra radius as a fraction of the ceiling
			return weight * clamp( penumbraUV / maxUV, 0.0, 1.0 ) + share;
		#endif

		// --- filtered lookup ---------------------------------------------------
		float lit = 0.0;
		for ( int i = 0; i < CSM_FILTER_TAPS; i ++ ) {
			float fi = float( i ) + 0.5;
			float a = fi * CSM_GOLDEN_ANGLE + base;
			vec2 o = vec2( cos( a ), sin( a ) ) * sqrt( fi / float( CSM_FILTER_TAPS ) ) * penumbraUV;
			float d = unpackRGBAToDepth( textureLod( shadowMap, p.xy + o, 0.0 ) );
			float zc = zReceiver + clamp( dot( o, rpdb ), -CSM_RPDB_CLAMP, CSM_RPDB_CLAMP );
			#ifdef USE_REVERSED_DEPTH_BUFFER
				lit += step( d, zc );
			#else
				lit += step( zc, d );
			#endif
		}
		lit /= float( CSM_FILTER_TAPS );

		#if CSM_DEBUG == 7
			// filter result with shadowIntensity bypassed
			return weight * lit + share;
		#endif

		return weight * mix( 1.0, lit, shadowIntensity ) + share;

	}

#endif
`;
}

/**
 * @param {{blockerTaps:number, filterTaps:number, maxTexels:number[],
 *          minTexels:number[], borderFade:number, rpdbClamp:number,
 *          searchSpan:number, debug:number}} opts
 * @returns {boolean} true if the chunks changed (callers must recompile materials)
 */
export function applyShadowPatch(opts) {
  const sig = [
    opts.blockerTaps, opts.filterTaps,
    opts.maxTexels.map(f).join(','), opts.minTexels.map(f).join(','),
    opts.borderFade, opts.rpdbClamp, opts.searchSpan, opts.debug | 0,
  ].join('|');
  if (appliedSignature === sig) return false;

  if (ORIGINAL.pars === null) {
    ORIGINAL.pars = THREE.ShaderChunk.shadowmap_pars_fragment;
    ORIGINAL.begin = THREE.ShaderChunk.lights_fragment_begin;
  }

  if (!ORIGINAL.begin.includes(DIRECTIONAL_ANCHOR)) {
    // three changed the chunk out from under us. Stay on stock shadows rather
    // than emitting a broken shader — the rig degrades, it does not break.
    console.warn('[lighting] shadow shader anchor not found; using stock PCF (three version drift?)');
    patchOk = false;
    appliedSignature = sig;
    return false;
  }

  THREE.ShaderChunk.shadowmap_pars_fragment = ORIGINAL.pars + buildGLSL(opts);
  THREE.ShaderChunk.lights_fragment_begin =
    ORIGINAL.begin.replace(DIRECTIONAL_ANCHOR, DIRECTIONAL_REPLACEMENT);

  appliedSignature = sig;
  patchOk = true;
  return true;
}

export function shadowPatchActive() {
  return patchOk;
}

export function revertShadowPatch() {
  if (ORIGINAL.pars === null) return;
  THREE.ShaderChunk.shadowmap_pars_fragment = ORIGINAL.pars;
  THREE.ShaderChunk.lights_fragment_begin = ORIGINAL.begin;
  appliedSignature = null;
  patchOk = false;
}
