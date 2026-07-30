import * as THREE from 'three';
import { buildWeapon, LAYOUT } from './viewmodel/Weapon.js';
import { buildHands } from './viewmodel/Hands.js';
import { buildWeaponMaterials, disposeWeaponMaterials } from './viewmodel/Materials.js';
import { MuzzleFlash } from './viewmodel/Flash.js';
import { cylG, Mesher } from './viewmodel/Shapes.js';

/**
 * OWNER: viewmodel agent. This is the single most-looked-at object in the game —
 * a quarter of every gameplay pixel, for an entire session.
 *
 * CONTRACT
 *   Builds geometry into ctx.viewScene (rendered with ctx.viewCamera, near 0.005).
 *   listens: 'weapon:fire', 'weapon:reload', 'weapon:switch', 'viewmodel:visible',
 *            'weapon:force'
 *   reads:   ctx.get('weapons').state, ctx.get('player').state / .velocity,
 *            ctx.get('sky').sunDirection / sunColour / preset
 *   calls:   ctx.get('lighting').flash(pos, colour, intensity, life)
 *
 * WHAT IS HERE
 *   viewmodel/Shapes.js     chamfered primitive kit + swept prisms with real
 *                           recessed pockets, tagged with a curvature proxy
 *   viewmodel/Textures.js   procedural PBR bakery (albedo / normal / ORM)
 *   viewmodel/Materials.js  material zones + the edge-wear shader
 *   viewmodel/Rail.js       one-mesh Picatinny with a real cross-section
 *   viewmodel/Weapon.js     the carbine assembly
 *   viewmodel/Optic.js      open-emitter reflex sight, one glass plate, additive dot
 *   viewmodel/Hands.js      gloved hands on a nested matrix skeleton
 *   viewmodel/Flash.js      four-layer additive muzzle flash + discharge light
 *
 * ADS ALIGNMENT
 *   The rig exposes a `sight` anchor at the optic's exit pupil, and the ADS pose
 *   is *computed* from it: adsPos = -sightLocal - (0, 0, EYE_RELIEF). The reticle
 *   therefore lands exactly on the view axis no matter how the optic geometry is
 *   edited. Hand-tuning that offset is how ADS ends up subtly off-centre.
 *
 *   EYE_RELIEF also decides how much of the weapon is *behind* the camera in
 *   ADS. At 82 mm the whole stock, the receiver's rear 90 mm and the firing hand
 *   are all past the near plane, so they are clipped rather than smeared across
 *   the lower half of the frame at grazing incidence.
 */

/**
 * Poses are in camera space: -Z forward, +X right, +Y up. The weapon is authored
 * with its origin at the magwell, so the hip pose pushes it down and right far
 * enough that the rail sits below the crosshair, and yaws the muzzle *inward* so
 * the weapon reads as a diagonal from the bottom-right corner toward the centre.
 * That inward yaw is what makes a hipfire pose look aimed rather than parked.
 *
 * SCREEN FOOTPRINT
 *   Solved against measured screen-space extents rather than by eye. The round-6
 *   pose put the weapon's bounding box at x 1016..1434, y 678..1234 at 1080p —
 *   154 px of it below the bottom edge, with the magazine, the pistol grip and
 *   the entire firing hand outside the frame. That is what "the rifle floats
 *   detached" actually meant: the half of the weapon a hand could be holding was
 *   not being photographed.
 *
 *   This pose measures 1040..1468 x 624..1079 — the whole weapon inside the
 *   frame with the magazine floorplate just kissing the bottom edge, the muzzle
 *   at (1049, 652) and the buttpad at (1440, 871), which is a 29-degree diagonal
 *   running up and left out of the lower-right corner. Only the forearms leave
 *   the frame, which is what forearms are supposed to do.
 *
 *   Positive yaw swings the rear of the weapon toward +X and the muzzle toward
 *   -X, so a larger yaw walks the stock right while bringing the muzzle to the
 *   centre — it strengthens the diagonal and costs image area at the same time.
 */
const HIP_POS = new THREE.Vector3(0.1850, -0.1790, -0.6150);
const HIP_ROT = new THREE.Euler(0.0450, 0.2450, 0.0900, 'YXZ');
const ADS_ROT = new THREE.Euler(0, 0, 0, 'YXZ');

/**
 * How far in front of the camera the exit pupil is parked in ADS.
 *
 * This number and the optic's own depth are the two halves of the same problem.
 * A sight 115 mm from the eye reads *small*, and the instinct when the sight
 * picture looks wrong is to push it further away — but distance shrinks the
 * clear window and the housing together, so a housing that was too heavy stays
 * too heavy and simply gets smaller. What actually fixes the sight picture is
 * making the housing thin (see Optic.js), and once it is thin the optic wants to
 * come closer, not further. 82 mm opens the 26.8 x 23.2 mm window to about
 * 245 x 212 px at 1080p inside a 293 x 261 px frame — a 24 px surround, thin
 * enough to read as a hood rather than as a housing, with every pixel inside it
 * showing the same world at the same exposure as the pixels outside.
 *
 * It is not smaller than that because eye relief is a shared control: the same
 * number that shrinks the optic shrinks the receiver ramp under it, and pulling
 * the eye in to 62 mm — which gave a superb sight picture on its own — put the
 * top of the receiver across the entire bottom third of the frame as one smooth
 * grey wedge. 82 mm is where both halves of the composition are right.
 */
const ADS_EYE_RELIEF = 0.0820;

/** Lowered carry used while sprinting. */
const SPRINT_POS = new THREE.Vector3(0.1520, -0.2680, -0.3300);
const SPRINT_ROT = new THREE.Euler(-0.1600, -0.5200, 0.2900, 'YXZ');

/** Reload: the gun rolls in toward the support hand while the mag drops. */
const RELOAD_TIME = 2.15;

/**
 * `?vmpose=<yaw>` holds the weapon broadside at a fixed distance so the asset
 * itself can be reviewed rather than the composition. Yaw is in radians; the
 * default 1.15 is a three-quarter view of the ejection-port side.
 */
const INSPECT_POS = new THREE.Vector3(0.010, -0.020, -0.640);

export class ViewModel {
  constructor() {
    this.name = 'viewmodel';
    this.visible = true;

    this._t = 0;
    this._recoil = 0;          // 0..1 impulse envelope
    this._recoilVel = 0;       // settle spring
    this._boltT = 1;           // 1 = closed
    this._reloadT = -1;        // <0 = not reloading
    this._forced = { ads: false, firing: false };
    this._shell = [];
    this._breath = 0;

    /**
     * Live copies of the hip pose. Held on the instance rather than read from
     * the module constants so the composition can be swept from the debug rig
     * inside a single page load — a pose is a *screen-space* result of six
     * coupled numbers, and converging it one edit-and-reload at a time is how
     * it stayed cropped against two frame edges for six rounds.
     */
    this.hipPos = HIP_POS.clone();
    this.hipRot = HIP_ROT.clone();

    // Scratch — update() must not allocate.
    this._pos = new THREE.Vector3();
    this._rot = new THREE.Euler(0, 0, 0, 'YXZ');
    this._adsPos = new THREE.Vector3();
    this._sightLocal = new THREE.Vector3();
    this._v = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._q2 = new THREE.Quaternion();
    this._eye = new THREE.Vector3();
    this._camInv = new THREE.Matrix4();
  }

  init(ctx) {
    this.ctx = ctx;
    this.weapons = ctx.get('weapons');
    this.player = ctx.get('player');
    this.lighting = ctx.get('lighting');

    const built = buildWeaponMaterials();
    this.materials = built.mats;
    this._texSets = built.sets;

    this.root = new THREE.Group();
    this.root.name = 'viewmodel';
    // The viewmodel is authored in *camera* space, but CameraRig copies the world
    // camera transform onto ctx.viewCamera every frame — so a root parented
    // straight to viewScene ends up at the world origin, far outside the 12 m
    // view far-plane, and silently culls. Parent to the camera instead (and put
    // the camera in the scene so traversal reaches us).
    if (!ctx.viewCamera.parent) ctx.viewScene.add(ctx.viewCamera);
    ctx.viewCamera.add(this.root);

    const rig = buildWeapon(this.materials);
    this.rig = rig;
    this.root.add(rig.root);

    const hands = buildHands(this.materials);
    this.hands = hands;
    rig.root.add(hands.group);

    this.triangles = rig.triangles + hands.triangles;

    // ---- computed ADS pose --------------------------------------------------
    this._sightLocal.copy(rig.sight.position);
    this._adsPos.set(
      -this._sightLocal.x,
      -this._sightLocal.y,
      -this._sightLocal.z - ADS_EYE_RELIEF,
    );

    // ---- muzzle flash ------------------------------------------------------
    this.flash = new MuzzleFlash(ctx.viewCamera);

    // ---- view-scene light rig ----------------------------------------------
    // Lighting hands viewScene an environment map but no key light, so the gun
    // would arrive lit by ambient only — flat, with no specular to catch the
    // chamfers. viewScene *is* camera space, so a directional light's direction
    // is simply the world sun rotated into the camera's frame; that keeps the
    // weapon's highlight consistent with the world key at every time of day.
    this.vmKey = new THREE.DirectionalLight(0xfff0d8, 2.4);
    this.vmKey.name = 'vm:key';
    this.vmFill = new THREE.DirectionalLight(0x9fb4cc, 0.55);
    this.vmFill.name = 'vm:fill';
    // A rim from behind-right separates the receiver from the background.
    this.vmRim = new THREE.DirectionalLight(0xbcd0e8, 0.85);
    this.vmRim.name = 'vm:rim';
    this.vmRim.position.set(-0.55, 0.62, 1.0);
    // A dim wrap from below stops the underside going solid black.
    this.vmBounce = new THREE.DirectionalLight(0x6a5a44, 0.30);
    this.vmBounce.name = 'vm:bounce';
    this.vmBounce.position.set(0.2, -1, 0.35);
    ctx.viewScene.add(this.vmKey, this.vmFill, this.vmRim, this.vmBounce);

    // ---- shell casing pool -------------------------------------------------
    // Cases live in camera space, not weapon space: parented to the gun they
    // would sway along with it instead of tumbling away.
    this.shellRoot = new THREE.Group();
    this.shellRoot.name = 'vm:shells';
    ctx.viewCamera.add(this.shellRoot);
    const shellGeo = this._buildShellGeometry();
    for (let i = 0; i < 8; i++) {
      const mesh = new THREE.Mesh(shellGeo, this.materials.brass);
      mesh.visible = false;
      mesh.frustumCulled = false;
      this.shellRoot.add(mesh);
      this._shell.push({
        mesh, life: 0,
        vel: new THREE.Vector3(),
        spin: new THREE.Vector3(),
      });
    }
    this._shellGeo = shellGeo;

    // Sit at rest before the first frame so a frozen page is already posed.
    this.root.position.copy(this.hipPos);
    this.root.rotation.copy(this.hipRot);
    this._applyPose(0, null, 0);

    ctx.bus.on('viewmodel:visible', ({ visible }) => { this.visible = visible; });
    ctx.bus.on('weapon:fire', () => this._onFire());
    ctx.bus.on('weapon:reload', () => { this._reloadT = 0; });
    ctx.bus.on('weapon:switch', () => { this._reloadT = 0; });
    ctx.bus.on('weapon:force', ({ ads, firing }) => {
      if (ads !== undefined) this._forced.ads = !!ads;
      if (firing !== undefined) this._forced.firing = !!firing;
    });

    // Asset-review pose. Reading the query string directly keeps the shared
    // screenshot rig untouched; it is inert unless the parameter is present.
    if (typeof location !== 'undefined') {
      const q = new URLSearchParams(location.search);
      const p = q.get('vmpose');
      if (p !== null) this._inspect = p === '' ? 1.15 : parseFloat(p);
      if (Number.isNaN(this._inspect)) this._inspect = 1.15;
      /**
       * `?vmstate=sprint|reload|walk` forces a pose the rig cannot otherwise
       * reach. `?ads` and `?fire` already exist; sprint and reload did not, which
       * means the hands were only ever reviewed in the one frozen hipfire frame
       * and "do they hold in every pose?" was answered by argument rather than by
       * a photograph. Reload also needs a phase, so `vmphase=0..1` picks a point
       * in the 2.15 s animation (default 0.38, where the magazine is clear of the
       * well and the weapon is at maximum roll).
       */
      this._state = q.get('vmstate');
      const ph = parseFloat(q.get('vmphase'));
      this._phase = Number.isNaN(ph) ? 0.38 : ph;
    }
  }

  /** A 5.56 case: rim, tapered body, shoulder, neck. */
  _buildShellGeometry() {
    const m = new Mesher();
    m.use('brass');
    cylG(m, { z: 0.0000, r0: 0.0049, len: 0.0016, seg: 10, c: 0.0003 });
    cylG(m, { z: 0.0125, r0: 0.0046, r1: 0.0042, len: 0.0240, seg: 10, c: 0.0004 });
    cylG(m, { z: 0.0272, r0: 0.0042, r1: 0.0030, len: 0.0056, seg: 10, c: 0.0003 });
    cylG(m, { z: 0.0328, r0: 0.0030, len: 0.0060, seg: 10, c: 0.0003, capB: false });
    const geos = m.geometries();
    const geo = geos.get('brass');
    geo.translate(0, 0, -0.0180);
    return geo;
  }

  // -------------------------------------------------------------------------

  _onFire() {
    this._recoil = 1;
    this._recoilVel = 0;
    this._boltT = 0;
    this.flash.trigger();
    this._ejectShell();
    // A muzzle flash is a light, not just a sprite — let the world see it.
    if (this.lighting?.flash) {
      this.rig.muzzle.updateWorldMatrix(true, false);
      this._v.setFromMatrixPosition(this.rig.muzzle.matrixWorld);
      this.lighting.flash(this._v, 0xffd2a0, 8, 0.055);
    }
  }

  /**
   * Rotate the world sun into camera space so the weapon's key light tracks the
   * scene's. Allocation-free: reuses `_q` and `_v`.
   */
  _syncLights(ctx) {
    const sky = ctx.get('sky');
    if (!sky?.sunDirection) return;
    this._q.copy(ctx.camera.quaternion).invert();
    this._v.copy(sky.sunDirection).applyQuaternion(this._q);
    this.vmKey.position.copy(this._v).multiplyScalar(4);
    if (sky.sunColour) this.vmKey.color.copy(sky.sunColour);
    // Track the preset's own intensity but compress it hard — a viewmodel lit at
    // full sun intensity blows out long before the world does.
    const lit = Math.max(0, sky.sunDirection.y);
    this.vmKey.intensity = 0.55 + Math.min(2.6, (sky.preset?.intensity ?? 3) * 0.55) * (0.35 + lit * 0.65);
    // Fill from the opposite side, tinted by the sky.
    this.vmFill.position.set(-this._v.x, Math.abs(this._v.y) * 0.5 + 0.5, -this._v.z).multiplyScalar(4);
    if (sky.skyColour) {
      this.vmFill.color.copy(sky.skyColour);
      this.vmRim.color.copy(sky.skyColour);
    }
    const amb = sky.preset?.ambient ?? 0.4;
    this.vmFill.intensity = 0.35 + amb * 0.55;
    this.vmRim.intensity = 0.45 + amb * 0.85;
  }

  _ejectShell() {
    let s = null;
    for (const c of this._shell) if (c.life <= 0) { s = c; break; }
    if (!s) return;
    s.life = 1;
    s.mesh.visible = true;
    // The port is in weapon space; the shell lives in camera space.
    this._v.copy(this.rig.ejectPort).applyQuaternion(this._q2.setFromEuler(this._rot));
    s.mesh.position.copy(this._v).add(this._pos);
    s.mesh.quaternion.copy(this._q2);
    // Right, up and a little forward, the way a real ejection pattern throws.
    this._v.set(1.9 + Math.random() * 0.7, 1.15 + Math.random() * 0.5, -0.30 - Math.random() * 0.35);
    s.vel.copy(this._v).applyQuaternion(this._q2);
    s.spin.set(16 + Math.random() * 10, 7 + Math.random() * 5, 12 + Math.random() * 8);
  }

  update(dt, ctx) {
    this.root.visible = this.visible;
    this.shellRoot.visible = this.visible;
    if (!this.visible) {
      this.flash.group.visible = false;
      return;
    }

    this._t += dt;
    this._syncLights(ctx);

    const st = this.weapons?.state;
    const pst = this.player?.state;

    // ---- ADS ---------------------------------------------------------------
    let ads = st?.adsProgress ?? 0;
    if (this._forced.ads) ads = 1;

    // ---- recoil / bolt -----------------------------------------------------
    if (this._forced.firing) {
      // Hold a readable mid-event pose instead of letting it decay away.
      this._recoil = 0.62;
      this._boltT = 0.45;
      this.flash.hold(0.74);
    } else {
      // Critically damped settle: a hard impulse then a soft return, which reads
      // as mass. A plain linear decay reads as an animation curve.
      const k = 128, c = 20;
      this._recoilVel += (-k * this._recoil - c * this._recoilVel) * dt;
      this._recoil += this._recoilVel * dt;
      if (Math.abs(this._recoil) < 0.0008 && Math.abs(this._recoilVel) < 0.01) {
        this._recoil = 0; this._recoilVel = 0;
      }
      this._boltT = Math.min(1, this._boltT + dt * 17.0);
    }

    if (this._reloadT >= 0) {
      this._reloadT += dt;
      if (this._reloadT > RELOAD_TIME) this._reloadT = -1;
    }

    this._applyPose(ads, pst, dt);
    this._updateFlash(dt, ads);
    this._updateShells(dt);
  }

  _applyPose(ads, pst = null, dt = 0) {
    const rig = this.rig;
    const sway = 1 - ads * 0.86;          // ADS damps the idle motion right down
    const t = this._t;

    if (this._inspect !== undefined) {
      this._pos.copy(INSPECT_POS);
      this._rot.set(0.10, this._inspect, 0.04);
      this.root.position.copy(this._pos);
      this.root.rotation.copy(this._rot);
      rig.bolt.position.z = 0;
      rig.mag.position.set(0, 0, 0);
      rig.mag.rotation.set(0, 0, 0);
      this.rig.optic.reticleMat.uniforms.uInt.value = 5.4;
      return;
    }

    // ---- base pose: hip <-> ADS, with a sprint carry on top ----------------
    const forcedSprint = this._state === 'sprint';
    if (this._state === 'reload') this._reloadT = this._phase * RELOAD_TIME;
    const sprint = forcedSprint || (pst?.sprinting && ads < 0.05) ? 1 : 0;
    this._pos.copy(this.hipPos).lerp(this._adsPos, ads);
    this._rot.set(
      THREE.MathUtils.lerp(this.hipRot.x, ADS_ROT.x, ads),
      THREE.MathUtils.lerp(this.hipRot.y, ADS_ROT.y, ads),
      THREE.MathUtils.lerp(this.hipRot.z, ADS_ROT.z, ads),
    );
    if (sprint) {
      this._pos.lerp(SPRINT_POS, 0.85);
      this._rot.x = THREE.MathUtils.lerp(this._rot.x, SPRINT_ROT.x, 0.85);
      this._rot.y = THREE.MathUtils.lerp(this._rot.y, SPRINT_ROT.y, 0.85);
      this._rot.z = THREE.MathUtils.lerp(this._rot.z, SPRINT_ROT.z, 0.85);
    }

    // ---- breathing ---------------------------------------------------------
    // A slow 0.22 Hz cycle with a held top: the weapon rises on the inhale and
    // settles a touch faster than it rose. Damped hard but never fully off in
    // ADS, because a perfectly still weapon reads as a static mesh.
    this._breath = Math.sin(t * 1.38);
    const br = this._breath * (0.28 + 0.72 * sway);
    this._pos.y += br * 0.0026;
    this._pos.z += Math.cos(t * 1.38) * 0.0012 * (0.25 + 0.75 * sway);
    this._rot.x += br * 0.0055;

    // ---- idle sway (two incommensurate frequencies so it never loops) ------
    this._pos.x += (Math.sin(t * 0.83) * 0.0040 + Math.sin(t * 1.71) * 0.0015) * sway;
    this._pos.y += (Math.cos(t * 1.13) * 0.0032 + Math.sin(t * 2.31) * 0.0011) * sway;
    this._rot.z += Math.sin(t * 0.67) * 0.0115 * sway;
    this._rot.y += Math.cos(t * 0.51) * 0.0090 * sway;

    // ---- walk cycle --------------------------------------------------------
    const speed = pst ? Math.min(1, (this.player?.velocity?.length?.() ?? 0) / 5.2) : 0;
    if (speed > 0.02) {
      const w = t * (sprint ? 13.0 : 9.0);
      // A figure-eight, not a circle: the vertical runs at twice the lateral
      // frequency because each stride has two footfalls.
      this._pos.x += Math.sin(w) * 0.0100 * speed * sway;
      this._pos.y += Math.abs(Math.cos(w)) * -0.0086 * speed * sway;
      this._rot.z += Math.sin(w) * 0.0290 * speed * sway;
      this._rot.x += Math.cos(w * 2) * 0.0075 * speed * sway;
    }

    // ---- recoil: straight back, muzzle up, slight roll ---------------------
    const r = Math.max(0, this._recoil);
    const rr = r * r;
    this._pos.z += r * 0.0290 * (1 - ads * 0.48);
    this._pos.y += rr * 0.0055;
    this._pos.x += r * 0.0042 * (1 - ads * 0.6);
    this._rot.x -= r * 0.1150 * (1 - ads * 0.42);
    this._rot.z += r * 0.0230;
    this._rot.y -= r * 0.0140 * (1 - ads * 0.7);

    // ---- reload: drop the mag, tilt the gun in -----------------------------
    if (this._reloadT >= 0) {
      const p = this._reloadT / RELOAD_TIME;
      const tilt = Math.sin(Math.min(1, p * 1.6) * Math.PI);
      this._rot.z += tilt * 0.5200;
      this._rot.x += tilt * 0.2600;
      this._rot.y += tilt * 0.1800;
      this._pos.y -= tilt * 0.0520;
      this._pos.x += tilt * 0.0180;
      // Magazine out for the middle half of the animation, and it falls away
      // rather than sinking straight down.
      const out = THREE.MathUtils.smoothstep(p, 0.12, 0.34)
        * (1 - THREE.MathUtils.smoothstep(p, 0.58, 0.82));
      rig.mag.position.y = -out * 0.1750;
      rig.mag.position.z = out * 0.0180;
      rig.mag.rotation.z = out * 0.3200;
      rig.mag.rotation.x = out * 0.1400;
      rig.mag.visible = out < 0.97;
      // The bolt is locked back for the first half of a dry reload.
      if (p < 0.62) this._boltT = Math.min(this._boltT, 0.15);
    } else {
      rig.mag.position.set(0, 0, 0);
      rig.mag.rotation.set(0, 0, 0);
      rig.mag.visible = true;
    }

    this.root.position.copy(this._pos);
    this.root.rotation.copy(this._rot);

    // ---- bolt travel -------------------------------------------------------
    // 0 = fully rearward. Back fast, forward a touch slower.
    rig.bolt.position.z = (1 - this._boltT) * 0.0420;

    // ---- reticle parallax --------------------------------------------------
    // A collimated dot does not walk with eye position the way a magnified
    // reticle does, but it *does* drift toward the edge of the window as the eye
    // moves off axis — which is exactly what you want visible in hipfire, and
    // exactly zero in ADS because the ADS pose puts the eye on the axis.
    const ret = this.rig.optic.reticleMat.uniforms;
    this._q2.setFromEuler(this._rot).invert();
    this._eye.copy(this._pos).negate().applyQuaternion(this._q2);
    const win = this.rig.optic.window;
    const k = 0.058;
    ret.uOff.value.set(
      THREE.MathUtils.clamp(this._eye.x * k, -win.w * 0.40, win.w * 0.40),
      THREE.MathUtils.clamp((this._eye.y - LAYOUT.opticAxisY) * k, -win.h * 0.40, win.h * 0.40),
    );
    ret.uInt.value = 5.4 + ads * 1.2;
  }

  /** Position the flash at the muzzle, expressed in camera space. */
  _updateFlash(dt, ads) {
    this._q2.setFromEuler(this._rot);
    this._v.copy(this.rig.muzzle.position).applyQuaternion(this._q2).add(this._pos);
    this._v2.set(0, 0, -1).applyQuaternion(this._q2);
    this.flash.update(dt, this._v, this._v2);
    // Down the barrel in ADS the flash sits dead centre; pull it back a little
    // so the plume does not wash the reticle out completely.
    this.flash.group.scale.setScalar(1 - ads * 0.18);
  }

  _updateShells(dt) {
    if (dt <= 0) return;
    for (const s of this._shell) {
      if (s.life <= 0) continue;
      s.life -= dt * 1.15;
      if (s.life <= 0) { s.mesh.visible = false; continue; }
      s.vel.y -= 9.8 * dt * 0.55;
      s.mesh.position.addScaledVector(s.vel, dt);
      s.mesh.rotateX(s.spin.x * dt);
      s.mesh.rotateY(s.spin.y * dt);
      s.mesh.rotateZ(s.spin.z * dt);
    }
  }

  resize(w, h, ctx) {
    // The viewmodel FOV is deliberately narrower than the world FOV so the gun
    // keeps its proportions on ultrawide displays.
    ctx.viewCamera.fov = 65;
    ctx.viewCamera.updateProjectionMatrix();
  }

  dispose() {
    this.root.removeFromParent();
    this.shellRoot.removeFromParent();
    for (const mesh of [...this.rig.meshes, ...this.hands.meshes]) mesh.geometry.dispose();
    this._shellGeo.dispose();
    this.rig.optic.lens.geometry.dispose();
    this.rig.optic.reticle.geometry.dispose();
    this.rig.optic.lensMat.dispose();
    this.rig.optic.reticleMat.dispose();
    this.flash.dispose();
    disposeWeaponMaterials(this.materials, this._texSets);
  }
}
