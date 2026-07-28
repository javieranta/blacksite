/**
 * OWNER: sky-atmosphere agent.
 *
 * Two analytic cloud decks: a cumulus base and a cirrus veil. GLSL only — the
 * dome concatenates this after AtmosphereGLSL and supplies the uniforms.
 *
 * NOISE BASIS
 * -----------
 * Deliberately *not* the basis any surface material uses. The routed defect was
 * that the only clouds in the build "are the same low-frequency blotch noise
 * used on the concrete", and it is true: value noise over a 2D lattice looks
 * identical whether you call it rust or weather. This uses 3D **gradient**
 * noise (random unit gradients per lattice point, quintic-free smoothstep
 * interpolation) with:
 *   - a two-channel **domain warp** applied before the fBm, which shears the
 *     lattice and is what turns round blobs into billows with fibrous edges;
 *   - an irrational, rotated lacunarity per octave so no octave lines up with
 *     any other or with the world axes;
 *   - a separate finer basis used only to **erode** the silhouette, which
 *     produces the cauliflower rim a threshold on fBm can never produce;
 *   - ridged (1 - |n|) accumulation for the cirrus, which is a completely
 *     different visual grammar again: filaments, not lumps.
 *
 * LIGHTING
 * --------
 * Not a raymarch — at 1080p a 24x6 march would cost more than the entire rest of
 * the frame. Instead the density field is treated as a heightfield-with-depth:
 *   - three taps stepped along the sun's *horizontal* bearing, at a stride that
 *     scales with 1/tan(elevation), give a Beer's-law self-shadow that correctly
 *     lengthens as the sun drops;
 *   - the analytic gradient of the field gives a normal for billow relief;
 *   - a powder term (1 - exp(-k*d)) darkens the thin edges the way in-scattering
 *     really does, which is what stops flat alpha-blended clouds looking like
 *     decals;
 *   - a Henyey-Greenstein lobe through the deck gives the silver lining.
 * Finally each deck is pushed through `bsAerialPerspective` at its *real*
 * distance, so a cumulus 40 km away at the horizon sits in the same haze as the
 * ridge line under it.
 */

export const CLOUD_UNIFORM_DECL = /* glsl */`
uniform vec4 bsCumulus;      // coverage, softness, absorption, detail
uniform vec4 bsCumulusGeo;   // altitude, feature scale (m), drift (m/s), thickness
uniform vec4 bsCirrus;       // coverage, altitude, feature scale (m), drift (m/s)
uniform vec3 bsCloudSun;     // direct radiance reaching the deck
uniform vec3 bsCloudAmb;     // sky fill on the deck
uniform float bsCloudTime;
`;

export const CLOUD_GLSL = /* glsl */`
/* ------------------------------------------------------------------ noise -- */

vec3 bsHash3( vec3 p ) {
	p = fract( p * vec3( 0.1031, 0.1030, 0.0973 ) );
	p += dot( p, p.yxz + 33.33 );
	return fract( ( p.xxy + p.yzz ) * p.zyx ) * 2.0 - 1.0;
}

/** 3D gradient noise, roughly [-1, 1]. */
float bsGN( vec3 x ) {
	vec3 i = floor( x );
	vec3 f = x - i;
	vec3 u = f * f * ( 3.0 - 2.0 * f );
	float n000 = dot( bsHash3( i + vec3( 0.0, 0.0, 0.0 ) ), f - vec3( 0.0, 0.0, 0.0 ) );
	float n100 = dot( bsHash3( i + vec3( 1.0, 0.0, 0.0 ) ), f - vec3( 1.0, 0.0, 0.0 ) );
	float n010 = dot( bsHash3( i + vec3( 0.0, 1.0, 0.0 ) ), f - vec3( 0.0, 1.0, 0.0 ) );
	float n110 = dot( bsHash3( i + vec3( 1.0, 1.0, 0.0 ) ), f - vec3( 1.0, 1.0, 0.0 ) );
	float n001 = dot( bsHash3( i + vec3( 0.0, 0.0, 1.0 ) ), f - vec3( 0.0, 0.0, 1.0 ) );
	float n101 = dot( bsHash3( i + vec3( 1.0, 0.0, 1.0 ) ), f - vec3( 1.0, 0.0, 1.0 ) );
	float n011 = dot( bsHash3( i + vec3( 0.0, 1.0, 1.0 ) ), f - vec3( 0.0, 1.0, 1.0 ) );
	float n111 = dot( bsHash3( i + vec3( 1.0, 1.0, 1.0 ) ), f - vec3( 1.0, 1.0, 1.0 ) );
	return mix( mix( mix( n000, n100, u.x ), mix( n010, n110, u.x ), u.y ),
	            mix( mix( n001, n101, u.x ), mix( n011, n111, u.x ), u.y ), u.z ) * 1.16;
}

// Rotation between octaves: kills the axis-aligned grid that plain lacunarity
// leaves behind and is visible as a plaid in any large fBm field.
const mat3 BS_OCT = mat3( 0.00, 0.80, 0.60, -0.80, 0.36, -0.48, -0.60, -0.48, 0.64 );

/**
 * Cheap two-octave field, matched in variance to the full one below so a
 * threshold means the same thing in both. Used for the shadow taps and the
 * gradient, where five extra noise fetches per tap would not survive the budget.
 * It takes an *already warped* coordinate: the warp is low frequency, so
 * offsetting after it is a good approximation of warping the offset — and it
 * keeps the shadow registered with the cloud that casts it, which sampling an
 * unwarped field does not.
 */
float bsCloudLow( vec2 qw, float t ) {
	vec3 s = vec3( qw.x, t * 0.055, qw.y );
	float d = 0.46 * bsGN( s );
	s = BS_OCT * s * 2.03;
	d += 0.27 * bsGN( s );
	return d * 1.35 + 0.5;
}

/** Full warped four-octave cumulus field, 0..1. Also returns the warped coord. */
float bsCloudField( vec2 q, float t, float lod, out vec2 qw ) {
	vec3 p = vec3( q.x, t * 0.055, q.y );
	// Domain warp. Two independent low-frequency channels shear the lattice —
	// this single step is the difference between billows and blobs.
	vec2 w = vec2( bsGN( p * 0.52 + 17.3 ), bsGN( p * 0.52 - 41.7 ) );
	p.x += w.x * 1.25;
	p.z += w.y * 1.25;
	qw = vec2( p.x, p.z );

	// Weighted toward the finer octaves on purpose. A textbook 0.5 falloff makes
	// a deck seen at 10 degrees elevation — which is where a first-person hero
	// framing actually puts the sky — read as one flat lump, because the base
	// octave subtends 20+ degrees at that range and you only see two of them.
	float d = 0.46 * bsGN( p );
	vec3 s = BS_OCT * p * 2.03;
	d += 0.27 * bsGN( s );
	s = BS_OCT * s * 2.19;
	d += 0.17 * bsGN( s ) * mix( 1.0, 0.30, lod );
	s = BS_OCT * s * 2.07;
	d += 0.11 * bsGN( s ) * mix( 1.0, 0.08, lod );
	return d * 1.02 + 0.5;
}

/* --------------------------------------------------------------- cumulus --- */

/**
 * @return rgb = deck radiance, a = coverage.
 */
vec4 bsCumulusLayer( vec3 dir, vec3 eye ) {
	if ( bsCumulus.x < 0.004 ) return vec4( 0.0 );
	// Fade into the horizon haze instead of terminating in a hard line. Kept
	// shallow on purpose: a deck that stops at 4 degrees leaves a bald band
	// exactly where a hero framing puts the sky. Aerial perspective is what
	// dissolves it down there, not an alpha ramp.
	float fade = smoothstep( 0.0015, 0.028, dir.y );
	if ( fade <= 0.0 ) return vec4( 0.0 );

	float alt = bsCumulusGeo.x;
	float scale = bsCumulusGeo.y;
	float dist = min( ( alt - eye.y ) / max( dir.y, 0.006 ), 240000.0 );
	// Detail has to die off with range or the horizon turns into noise.
	float lod = clamp( ( dist - 5000.0 ) / 55000.0, 0.0, 1.0 );

	vec2 q = ( eye.xz + dir.xz * dist ) / scale;
	q += vec2( bsCloudTime * bsCumulusGeo.z / scale * 1.0,
	           bsCloudTime * bsCumulusGeo.z / scale * 0.32 );

	vec2 qw;
	float base = bsCloudField( q, bsCloudTime, lod, qw );
	float thr = mix( 0.74, 0.17, bsCumulus.x );
	float soft = mix( 0.05, 0.36, bsCumulus.y ) + lod * 0.12;
	float d = smoothstep( thr, thr + soft, base );
	if ( d <= 0.002 ) return vec4( 0.0 );

	// Edge erosion on a finer, independent basis: cauliflower rim.
	float ero = bsGN( vec3( qw * 5.3, bsCloudTime * 0.09 ) ) * 0.5 + 0.5;
	d = clamp( d - ( 1.0 - d ) * ero * bsCumulus.w * 0.7 * ( 1.0 - lod ), 0.0, 1.0 );
	if ( d <= 0.002 ) return vec4( 0.0 );

	// --- self shadow: step along the sun's horizontal bearing -----------------
	vec2 sunXZ = bsApSunDir.xz;
	float sunLen = max( length( sunXZ ), 1e-3 );
	vec2 sdir = sunXZ / sunLen;
	// The light travels dy/tan(elevation) horizontally per unit of rise, so the
	// shadow stride grows as the sun sinks. Clamped so it stays sane at sunset.
	float stride = clamp( 0.30 / max( abs( bsApSunDir.y ), 0.14 ), 0.22, 2.4 );
	float sh = 0.42 * bsCloudLow( qw + sdir * stride * 0.45, bsCloudTime )
	         + 0.34 * bsCloudLow( qw + sdir * stride * 1.15, bsCloudTime )
	         + 0.24 * bsCloudLow( qw + sdir * stride * 2.30, bsCloudTime );
	float occ = exp( - bsCumulus.z * 3.7 * max( sh - thr * 0.84, 0.0 ) );

	// --- billow relief from the analytic gradient ------------------------------
	float e = 0.055;
	float gx = bsCloudLow( qw + vec2( e, 0.0 ), bsCloudTime ) - bsCloudLow( qw - vec2( e, 0.0 ), bsCloudTime );
	float gz = bsCloudLow( qw + vec2( 0.0, e ), bsCloudTime ) - bsCloudLow( qw - vec2( 0.0, e ), bsCloudTime );
	vec3 n = normalize( vec3( -gx * 7.0, 0.85, -gz * 7.0 ) );
	float ndl = clamp( dot( n, bsApSunDir ) * 0.5 + 0.5, 0.0, 1.0 );

	// Powder: thin edges are darker than Beer's law alone predicts.
	float powder = 1.0 - exp( -5.5 * d );
	float cosG = dot( dir, bsApSunDir );
	float silver = bsHG( cosG, 0.66 ) * 2.5;

	vec3 lit = bsCloudSun * occ * ( 0.22 + 0.78 * ndl ) * mix( 0.45, 1.0, powder );
	lit += bsCloudSun * silver * ( 1.0 - d * 0.55 ) * occ * 0.55;
	// Bases are lit from below by the ground and from the sides by the sky.
	vec3 amb = bsCloudAmb * ( 0.40 + 0.50 * ( 1.0 - d ) );
	vec3 col = lit + amb;

	// Same haze as everything else, at the deck's real distance.
	col = bsAerialPerspectiveCloud( col, dir, dist, eye.y );
	return vec4( col, d * fade );
}

/* ---------------------------------------------------------------- cirrus --- */

vec4 bsCirrusLayer( vec3 dir, vec3 eye ) {
	if ( bsCirrus.x < 0.004 ) return vec4( 0.0 );
	float fade = smoothstep( 0.010, 0.060, dir.y );
	if ( fade <= 0.0 ) return vec4( 0.0 );

	float scale = bsCirrus.z;
	float dist = min( ( bsCirrus.y - eye.y ) / max( dir.y, 0.020 ), 320000.0 );
	vec2 q = ( eye.xz + dir.xz * dist ) / scale;
	q.x *= 0.26;                                   // stretch into wind streaks
	q.x += bsCloudTime * bsCirrus.w / scale;

	// Ridged accumulation — filaments rather than lumps.
	vec3 s = vec3( q, bsCloudTime * 0.018 );
	float r = 0.52 * ( 1.0 - abs( bsGN( s ) ) );
	s = BS_OCT * s * 2.63;
	r += 0.29 * ( 1.0 - abs( bsGN( s ) ) );
	s = BS_OCT * s * 2.91;
	r += 0.16 * ( 1.0 - abs( bsGN( s ) ) );

	float a = clamp( ( r - mix( 0.86, 0.42, bsCirrus.x ) ) * 3.4, 0.0, 1.0 );
	a = pow( a, 1.45 ) * 0.78 * fade;
	if ( a <= 0.002 ) return vec4( 0.0 );

	float cosG = dot( dir, bsApSunDir );
	// Ice crystals forward-scatter hard, which is why cirrus glows near the sun.
	vec3 col = bsCloudSun * ( 0.62 + bsHG( cosG, 0.72 ) * 3.0 ) + bsCloudAmb * 0.9;
	col = bsAerialPerspectiveCloud( col, dir, dist, eye.y );
	return vec4( col, a );
}
`;
