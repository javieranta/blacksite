import * as THREE from 'three';

/**
 * OWNER: lighting agent.
 *
 * Raymarched single-scattering light shafts.
 *
 * Pipeline, all inside this system so no other module has to cooperate:
 *   1. a half-res depth-only prepass of the world scene (colour writes off,
 *      real depth attachment) — this is what terminates each view ray at the
 *      first opaque surface, so shafts do not bleed over foreground geometry;
 *   2. a quarter-res march along each view ray. Every step is tested against
 *      the cascaded shadow maps (tightest containing cascade wins, exactly the
 *      same containment rule the surface shading uses), so the shafts are
 *      genuinely occluded by world geometry — a doorway carves a real beam;
 *   3. an additive fullscreen composite in the world scene, so it survives
 *      whether Engine draws the frame directly or PostFX takes it over.
 *
 * Banding control: the march start offset is dithered with interleaved
 * gradient noise (spectrally blue, the standard replacement for a blue-noise
 * texture) plus a per-frame R2 low-discrepancy temporal offset, and the
 * quarter-res buffer is reconstructed with a 5-tap cross filter.
 *
 * Sample count comes from the active quality preset (`volumetricSteps`), and
 * zero steps disables the whole subsystem including its render targets.
 */

const R2_A = 0.7548776662466927;   // 1/phi2

export class VolumetricLight {
  /**
   * @param {object} ctx engine context
   * @param {import('./CascadedShadowMap.js').CascadedShadowMap} csm
   * @param {{steps:number, depthScale:number, marchScale:number}} opts
   */
  constructor(ctx, csm, opts) {
    this.ctx = ctx;
    this.csm = csm;
    this.steps = Math.max(0, opts.steps | 0);
    this.depthScale = opts.depthScale ?? 0.5;
    this.marchScale = opts.marchScale ?? 0.25;
    this.enabled = this.steps > 0;
    this.strength = 1.0;

    this._frame = 0;
    this._toneMapped = true;
    this._white = null;

    /**
     * How often the depth prepass re-renders, in frames.
     *
     * The prepass is a full scene traversal with an override material, and it
     * is by far the most expensive thing this class does: measured on the
     * combat framing at 1920x1080 it was 252 draw calls and 1.08M triangles —
     * roughly a third of the entire frame's draw budget, paid on top of the
     * main pass, every frame, to produce a half-resolution depth buffer that a
     * quarter-resolution raymarch reads.
     *
     * Distance-culling it does not help: the backdrop meshes have 800 m
     * bounding spheres, so shortening the prepass camera's far plane to the
     * medium's `maxDistance` culls literally nothing (measured: 252 calls at
     * far = 900 and 252 at far = 40).
     *
     * The right fix is to stop rendering depth twice and read the depth buffer
     * the main pass already produces — PostFX has one for AO, DoF and motion
     * blur. That needs a seam PostFX does not currently expose, so it is
     * reported rather than reached for. Until then the prepass runs on a
     * cadence: the scattering term is quarter-res, temporally jittered and
     * additive, and it is composited under TAA, so a one-frame-old occluder
     * boundary is not resolvable. Set to 1 to restore per-frame behaviour.
     */
    this.depthInterval = 2;
    /**
     * Below this the medium scatters too little to be worth a scene traversal.
     * `midday` outdoors sits at 0.30 x 0.009 and contributes nothing visible,
     * yet was paying full price for the prepass.
     */
    this.skipBelow = 0.0035;
    this._depthValid = false;

    if (!this.enabled) return;

    const size = ctx.renderer.getSize(new THREE.Vector2());

    // A real depth attachment, not an RGBA-packed colour buffer. Packed depth
    // puts its most significant bits in the alpha channel, which makes it
    // hostage to blend state and to alpha handling on the readback path; a
    // DepthTexture is exact, cheaper to write (colour writes off) and needs no
    // unpacking maths.
    const dw = Math.max(2, Math.floor(size.x * this.depthScale));
    const dh = Math.max(2, Math.floor(size.y * this.depthScale));
    const depthTexture = new THREE.DepthTexture(dw, dh);
    depthTexture.minFilter = THREE.NearestFilter;
    depthTexture.magFilter = THREE.NearestFilter;
    this.depthRT = this._makeRT(dw, dh, { type: THREE.UnsignedByteType, depthTexture });
    this.marchRT = this._makeRT(size.x * this.marchScale, size.y * this.marchScale, {
      type: THREE.HalfFloatType,
      depthBuffer: false,
    });

    // Depth-only prepass: no colour writes at all.
    this.depthMaterial = new THREE.MeshBasicMaterial({ colorWrite: false });

    this._white = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    this._white.needsUpdate = true;

    this.marchScene = new THREE.Scene();
    this.marchCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.marchMaterial = this._buildMarchMaterial();
    this.marchScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.marchMaterial));

    this.compositeMaterial = this._buildCompositeMaterial(true);
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.compositeMaterial);
    this.quad.name = 'volumetric-composite';
    this.quad.frustumCulled = false;
    this.quad.renderOrder = 1200;
    this.quad.matrixAutoUpdate = false;
    ctx.scene.add(this.quad);

    this._clearColour = new THREE.Color();
  }

  _makeRT(w, h, params) {
    return new THREE.WebGLRenderTarget(Math.max(2, Math.floor(w)), Math.max(2, Math.floor(h)), {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      depthBuffer: true,
      stencilBuffer: false,
      generateMipmaps: false,
      ...params,
    });
  }

  // --- shaders ---------------------------------------------------------------

  _buildMarchMaterial() {
    const u = {
      uDepth: { value: null },
      uShadow0: { value: null },
      uShadow1: { value: null },
      uShadow2: { value: null },
      uShadow3: { value: null },
      uShadowMat0: { value: new THREE.Matrix4() },
      uShadowMat1: { value: new THREE.Matrix4() },
      uShadowMat2: { value: new THREE.Matrix4() },
      uShadowMat3: { value: new THREE.Matrix4() },
      uCascades: { value: this.csm.count },
      uInvProjection: { value: new THREE.Matrix4() },
      uCamWorld: { value: new THREE.Matrix4() },
      uCamPos: { value: new THREE.Vector3() },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunColour: { value: new THREE.Color(1, 1, 1) },
      uNear: { value: 0.02 },
      uFar: { value: 900 },
      uDensity: { value: 0.02 },
      uIntensity: { value: 0.8 },
      uAniso: { value: 0.78 },
      uMaxDistance: { value: 110 },
      uHeightFalloff: { value: 0.03 },
      uGroundY: { value: 0.0 },
      uJitter: { value: 0.0 },
    };

    return new THREE.ShaderMaterial({
      uniforms: u,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4( position.xy, 0.0, 1.0 );
        }
      `,
      fragmentShader: /* glsl */`
        #include <common>
        #include <packing>

        #define VOL_STEPS ${this.steps}

        uniform sampler2D uDepth;
        uniform sampler2D uShadow0;
        uniform sampler2D uShadow1;
        uniform sampler2D uShadow2;
        uniform sampler2D uShadow3;
        uniform mat4 uShadowMat0;
        uniform mat4 uShadowMat1;
        uniform mat4 uShadowMat2;
        uniform mat4 uShadowMat3;
        uniform int uCascades;
        uniform mat4 uInvProjection;
        uniform mat4 uCamWorld;
        uniform vec3 uCamPos;
        uniform vec3 uSunDir;
        uniform vec3 uSunColour;
        uniform float uNear;
        uniform float uFar;
        uniform float uDensity;
        uniform float uIntensity;
        uniform float uAniso;
        uniform float uMaxDistance;
        uniform float uHeightFalloff;
        uniform float uGroundY;
        uniform float uJitter;

        varying vec2 vUv;

        float ign( vec2 pix ) {
          return fract( 52.9829189 * fract( dot( pix, vec2( 0.06711056, 0.00583715 ) ) ) );
        }

        float cascadeSample( sampler2D map, mat4 mtx, vec3 wp, out bool inside ) {
          vec4 c = mtx * vec4( wp, 1.0 );
          vec3 p = c.xyz / c.w;
          if ( p.x < 0.015 || p.x > 0.985 || p.y < 0.015 || p.y > 0.985 || p.z <= 0.0 || p.z >= 1.0 ) {
            inside = false;
            return 1.0;
          }
          inside = true;
          float d = unpackRGBAToDepth( textureLod( map, p.xy, 0.0 ) );
          // Guard against either shadow-map clear convention: a texel that is
          // fully far (1.0) or fully near (0.0) carries no occluder, so treat
          // it as open sky rather than as a blocker at the light.
          if ( d >= 0.9995 || d <= 0.0005 ) { return 1.0; }
          return step( p.z - 0.0022, d );
        }

        float sunVisibility( vec3 wp ) {
          bool inside;
          float v;
          v = cascadeSample( uShadow0, uShadowMat0, wp, inside ); if ( inside ) return v;
          if ( uCascades > 1 ) { v = cascadeSample( uShadow1, uShadowMat1, wp, inside ); if ( inside ) return v; }
          if ( uCascades > 2 ) { v = cascadeSample( uShadow2, uShadowMat2, wp, inside ); if ( inside ) return v; }
          if ( uCascades > 3 ) { v = cascadeSample( uShadow3, uShadowMat3, wp, inside ); if ( inside ) return v; }
          return 1.0;
        }

        void main() {
          vec4 ndc = vec4( vUv * 2.0 - 1.0, 1.0, 1.0 );
          vec4 vp = uInvProjection * ndc;
          vec3 viewDir = normalize( vp.xyz / vp.w );
          vec3 worldDir = normalize( ( uCamWorld * vec4( viewDir, 0.0 ) ).xyz );
          float cosA = max( -viewDir.z, 1e-4 );

          float packed = textureLod( uDepth, vUv, 0.0 ).r;
          float viewZ = perspectiveDepthToViewZ( packed, uNear, uFar );
          float dist = min( -viewZ / cosA, uMaxDistance );
          dist = max( dist, 0.25 );

          float stepLen = dist / float( VOL_STEPS );
          float offset = fract( ign( gl_FragCoord.xy ) + uJitter );
          float t = stepLen * offset;

          float g = uAniso;
          float cosT = dot( worldDir, uSunDir );
          float denom = max( 1.0 + g * g - 2.0 * g * cosT, 1e-4 );
          // Henyey-Greenstein forward peak plus an isotropic floor. The floor is
          // what gives the frame atmospheric depth when the sun is behind the
          // camera; the peak is what makes god rays when it is in front.
          float phase = 0.80 + min( ( 1.0 - g * g ) / ( denom * sqrt( denom ) ), 48.0 );

          float acc = 0.0;
          for ( int i = 0; i < VOL_STEPS; i ++ ) {
            vec3 wp = uCamPos + worldDir * t;
            float vis = sunVisibility( wp );
            if ( vis > 0.002 ) {
              float h = exp( -max( wp.y - uGroundY, 0.0 ) * uHeightFalloff );
              acc += vis * h * exp( -uDensity * t );
            }
            t += stepLen;
          }

          vec3 col = uSunColour * ( acc * uDensity * stepLen * phase * uIntensity * 0.035 );
          gl_FragColor = vec4( max( col, vec3( 0.0 ) ), 1.0 );
        }
      `,
    });
  }

  _buildCompositeMaterial(toneMapped) {
    return new THREE.ShaderMaterial({
      uniforms: {
        uShaft: { value: this.marchRT ? this.marchRT.texture : null },
        uTexel: { value: new THREE.Vector2(1 / 480, 1 / 270) },
        uStrength: { value: 1.0 },
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped,
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4( position.xy, 0.0, 1.0 );
        }
      `,
      fragmentShader: /* glsl */`
        uniform sampler2D uShaft;
        uniform vec2 uTexel;
        uniform float uStrength;
        varying vec2 vUv;
        void main() {
          // 5-tap cross reconstruction: the march buffer is quarter res, and a
          // straight bilinear stretch leaves faint stepping on long shafts.
          vec3 c = texture2D( uShaft, vUv ).rgb * 0.4;
          c += texture2D( uShaft, vUv + vec2( uTexel.x, 0.0 ) ).rgb * 0.15;
          c += texture2D( uShaft, vUv - vec2( uTexel.x, 0.0 ) ).rgb * 0.15;
          c += texture2D( uShaft, vUv + vec2( 0.0, uTexel.y ) ).rgb * 0.15;
          c += texture2D( uShaft, vUv - vec2( 0.0, uTexel.y ) ).rgb * 0.15;
          gl_FragColor = vec4( c * uStrength, 1.0 );
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
    });
  }

  // --- configuration ---------------------------------------------------------

  setMedium(vol) {
    if (!this.enabled) return;
    const u = this.marchMaterial.uniforms;
    u.uDensity.value = vol.density;
    u.uIntensity.value = vol.intensity;
    u.uAniso.value = vol.anisotropy;
    u.uMaxDistance.value = vol.maxDistance;
    u.uHeightFalloff.value = vol.heightFalloff;
  }

  setSun(direction, colour) {
    if (!this.enabled) return;
    this.marchMaterial.uniforms.uSunDir.value.copy(direction);
    this.marchMaterial.uniforms.uSunColour.value.copy(colour);
  }

  /** PostFX renders into an HDR buffer; drop our own tonemap when it does. */
  setHDRComposite(hdr) {
    if (!this.enabled) return;
    const want = !hdr;
    if (want === this._toneMapped) return;
    this._toneMapped = want;
    const old = this.compositeMaterial;
    this.compositeMaterial = this._buildCompositeMaterial(want);
    this.compositeMaterial.uniforms.uShaft.value = this.marchRT.texture;
    this.compositeMaterial.uniforms.uTexel.value.copy(old.uniforms.uTexel.value);
    this.compositeMaterial.uniforms.uStrength.value = old.uniforms.uStrength.value;
    this.quad.material = this.compositeMaterial;
    old.dispose();
  }

  resize(w, h) {
    if (!this.enabled) return;
    // The cached prepass is the wrong size now; force one next frame.
    this._depthValid = false;
    this.depthRT.setSize(Math.max(2, Math.floor(w * this.depthScale)), Math.max(2, Math.floor(h * this.depthScale)));
    this.marchRT.setSize(Math.max(2, Math.floor(w * this.marchScale)), Math.max(2, Math.floor(h * this.marchScale)));
    this.compositeMaterial.uniforms.uTexel.value.set(
      1 / this.marchRT.width, 1 / this.marchRT.height,
    );
  }

  // --- per-frame -------------------------------------------------------------

  render() {
    if (!this.enabled) return;
    const { renderer, scene, camera } = this.ctx;

    // Shadow maps do not exist until the first real render; sit out that frame.
    const map0 = this.csm.shadowTexture(0);
    if (!map0) return;

    // A medium this thin cannot produce a shaft anyone can see, and the prepass
    // below is far too expensive to run on spec.
    const u0 = this.marchMaterial.uniforms;
    if (u0.uIntensity.value * u0.uDensity.value * this.strength < this.skipBelow) {
      this.compositeMaterial.uniforms.uStrength.value = 0;
      return;
    }

    this._frame++;

    const prevTarget = renderer.getRenderTarget();
    const prevBackground = scene.background;
    const prevOverride = scene.overrideMaterial;
    const prevAutoClear = renderer.autoClear;
    renderer.getClearColor(this._clearColour);
    const prevAlpha = renderer.getClearAlpha();

    // ---- 1. packed depth prepass -------------------------------------------
    // The shadow map pass MUST be suppressed here. renderer.render() would
    // otherwise consume every cascade's `needsUpdate` inside this auxiliary
    // pass and leave the maps holding depths that do not match the projection
    // the surface shading samples with — shadows silently vanish. Skipping it
    // means the raymarch samples the previous frame's cascade maps, which is
    // exactly right: shadow.matrix is only rewritten when a map is rendered, so
    // map and matrix always agree, and a one-frame-old occluder set is
    // invisible in a quarter-res scattering term.
    if (!this._depthValid || (this._frame % this.depthInterval) === 0) {
      const prevShadows = renderer.shadowMap.enabled;
      this.quad.visible = false;
      scene.background = null;
      scene.overrideMaterial = this.depthMaterial;
      renderer.shadowMap.enabled = false;
      renderer.autoClear = true;
      renderer.setClearColor(0xffffff, 1);
      renderer.setRenderTarget(this.depthRT);
      renderer.clear(false, true, false);
      renderer.render(scene, camera);

      renderer.shadowMap.enabled = prevShadows;
      scene.overrideMaterial = prevOverride;
      scene.background = prevBackground;
      renderer.setClearColor(this._clearColour, prevAlpha);
      this.quad.visible = true;
      this._depthValid = true;
    }

    // ---- 2. raymarch --------------------------------------------------------
    const u = this.marchMaterial.uniforms;
    u.uDepth.value = this.depthRT.depthTexture;
    u.uShadow0.value = this.csm.shadowTexture(0) ?? this._white;
    u.uShadow1.value = this.csm.shadowTexture(1) ?? this._white;
    u.uShadow2.value = this.csm.shadowTexture(2) ?? this._white;
    u.uShadow3.value = this.csm.shadowTexture(3) ?? this._white;
    const mats = this.csm.shadowMatrices();
    if (mats[0]) u.uShadowMat0.value.copy(mats[0]);
    if (mats[1]) u.uShadowMat1.value.copy(mats[1]);
    if (mats[2]) u.uShadowMat2.value.copy(mats[2]);
    if (mats[3]) u.uShadowMat3.value.copy(mats[3]);
    u.uCascades.value = this.csm.count;
    u.uInvProjection.value.copy(camera.projectionMatrixInverse);
    u.uCamWorld.value.copy(camera.matrixWorld);
    camera.getWorldPosition(u.uCamPos.value);
    u.uNear.value = camera.near;
    u.uFar.value = camera.far;
    u.uJitter.value = (this._frame * R2_A) % 1;

    renderer.setRenderTarget(this.marchRT);
    renderer.clear(true, false, false);
    renderer.render(this.marchScene, this.marchCamera);

    // ---- restore -------------------------------------------------------------
    renderer.setRenderTarget(prevTarget);
    renderer.autoClear = prevAutoClear;
    this.compositeMaterial.uniforms.uStrength.value = this.strength;
  }

  dispose() {
    if (!this.enabled) return;
    this.depthRT.dispose();
    this.marchRT.dispose();
    this.depthMaterial.dispose();
    this.marchMaterial.dispose();
    this.compositeMaterial.dispose();
    this._white?.dispose();
    this.quad.geometry.dispose();
    this.quad.removeFromParent();
  }
}
