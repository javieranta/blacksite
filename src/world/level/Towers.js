import * as THREE from 'three';
import { lathe, tube, rng } from './GeoKit.js';

/**
 * OWNER: level agent.
 *
 * Natural-draught hyperbolic cooling towers.
 *
 * ROOT CAUSE this file exists to fix: the compound's cooling tower — the single
 * largest object in five of the twelve canonical captures — was one 17-point
 * `lathe` of `concrete` at `tile: 3.0`, plus 22 identical sticks at the base and
 * one torus at the rim. Three separate things were wrong with that:
 *
 *   1. WRONG MATERIAL. `concrete` is the *precast cladding* recipe: a 2 m panel
 *      grid authored to be read from 5-20 m, whose shader class fades its detail
 *      out over `far: [18, 62]`. The tower is first read at 44 m and last read at
 *      180 m, so by the time you see it the surface has already dissolved to
 *      flat grey. The forge has shipped `concrete_tower` — family `poured`,
 *      class `shell`, 6 m form panels, distance band `[26, 130]` — since the
 *      material round, with a docstring that literally says "cooling towers".
 *      Nothing in the level had ever asked for it.
 *   2. WRONG UV. `projectUV` is triplanar, and on a surface of revolution the
 *      major-axis test flips every 45 degrees, mirroring the texture eight times
 *      around the circumference and compressing it toward each seam. Vertical
 *      form seams cannot survive that. Shells here use `uvCyl`, which unwraps
 *      the angle per triangle so the wrap is continuous and seamless.
 *   3. NO RELIEF. A slipformed shell is not a smooth mathematical surface. It is
 *      built in ~1.5 m lifts, each one leaving a proud cold joint and each one
 *      set a few centimetres off its neighbour, so the silhouette is a stack of
 *      slightly mismatched rings — which is the read this file restores.
 *
 * What a real tower has and what is modelled here: the raker column colonnade
 * and ring beam at the air inlet, the recessed inlet throat behind it, slipform
 * lift lines, vertical form-panel seams, water staining running down from the
 * rim, algae at the damp base, patch repairs, a caged maintenance ladder up the
 * full height, and a rim cornice with a walkway and railing.
 */

/* ------------------------------------------------------------- materials --- */

/**
 * Staining materials, derived from the tower bake so they inherit its grain.
 * These are level-local (registered through `Builder.material`) because nothing
 * outside this file wants them and they would be dead weight in the forge.
 */
export function towerMaterials(forge) {
  const t = forge.texture('concrete_tower');
  const mk = (hex, rough, nScale) => {
    const m = new THREE.MeshStandardMaterial({
      color: new THREE.Color(hex),
      map: t.map,
      normalMap: t.normalMap,
      roughnessMap: t.roughnessMap,
      aoMap: t.aoMap,
      roughness: rough,
      metalness: 0.0,
      normalScale: new THREE.Vector2(nScale, nScale),
    });
    m.userData.surface = 'concrete';
    return m;
  };
  return {
    // Rain washing off a rim carries the shell's own dust down with it: the
    // streak is a desaturated grey-green, never black.
    tower_stain: mk(0x6c7065, 0.94, 0.80),
    // The air inlet is a 3 m deep recess under a ring beam. It never sees sky.
    tower_shade: mk(0x2b2d27, 0.96, 0.70),
    // Permanently damp concrete at the pond kerb — biological, not mineral.
    tower_algae: mk(0x47513c, 0.90, 0.90),
  };
}

/* -------------------------------------------------------------- profile ---- */

/**
 * Shell radius at height `y`. A cooling tower is a genuine hyperboloid of one
 * sheet: r(y) = rThroat * sqrt(1 + ((y - yThroat) / k)^2). Solving k from the
 * base radius makes the whole curve fall out of three readable numbers.
 */
function makeRadius(o) {
  const yShell = o.yShell, h = o.h;
  const yThroat = yShell + (h - yShell) * o.throatT;
  const ratio = o.rBase / o.rThroat;
  const k = (yThroat - yShell) / Math.sqrt(Math.max(0.04, ratio * ratio - 1));
  return (y) => o.rThroat * Math.sqrt(1 + ((y - yThroat) / k) ** 2);
}

/**
 * The lathe profile: plinth, recessed inlet throat, ring beam, then the shell
 * built lift by lift. Every lift leaves a proud cold joint and is offset by a
 * few centimetres of its own, so neither the surface nor the silhouette is a
 * clean curve.
 */
function shellProfile(o, radiusAt) {
  const r = rng(o.seed ?? 7717);
  const p = [];
  const rB = o.rBase;
  p.push([rB + 0.62, 0]);
  p.push([rB + 0.62, 0.42]);
  p.push([rB + 0.44, 0.58]);              // plinth chamfer
  p.push([rB - 0.42, 0.86]);              // step back into the inlet throat
  p.push([rB - 0.42, o.yBeam - 0.42]);
  p.push([rB + 0.26, o.yBeam - 0.06]);    // ring-beam soffit flare
  p.push([rB + 0.26, o.yBeam + 0.34]);
  p.push([rB, o.yShell]);

  const lifts = o.lifts;
  const span = o.h - o.yShell;
  for (let i = 1; i <= lifts; i++) {
    const y = o.yShell + (span * i) / lifts;
    const wob = (r() - 0.5) * 2 * (o.wobble ?? 0.055);
    const rr = radiusAt(y) + wob;
    // cold joint: the lift below finishes on a 90 mm proud kicker
    p.push([rr + o.ledge, y - 0.14]);
    p.push([rr + o.ledge, y - 0.02]);
    p.push([rr, y + 0.03]);
  }
  return p;
}

/* --------------------------------------------------------------- pieces ---- */

/** Vertical form-panel seams: a proud grout fin every form width. */
function formSeams(b, o, radiusAt, opt) {
  const n = o.seams ?? 30;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + 0.11;
    const ca = Math.cos(a), sa = Math.sin(a);
    const pts = [];
    const steps = 8;
    for (let k = 0; k <= steps; k++) {
      const y = o.yShell + ((o.h - o.yShell) * k) / steps;
      const rr = radiusAt(y) + 0.035;
      pts.push([o.x + ca * rr, y, o.z + sa * rr]);
    }
    b.geo(o.matShell, tube(pts, 0.038, 4, { segLen: 3.2, caps: false }), null,
      { ...opt, tile: 1.4 });
  }
}

/**
 * Water staining. A curved sheet hugging the shell, 40 mm proud, running down
 * from just under the rim. Six triangles each and it is the single loudest
 * signal on the whole structure that this is concrete standing in weather.
 */
function rimStains(b, o, radiusAt, opt) {
  const r = rng((o.seed ?? 7717) + 991);
  const n = o.stains ?? 34;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + r() * 0.16;
    const wide = 0.035 + r() * 0.075;                 // radians of arc
    const drop = (o.h - o.yShell) * (0.12 + r() * r() * 0.72);
    const y1 = o.h - 0.35 - r() * 1.6;
    const y0 = y1 - drop;
    const r1 = radiusAt(y1) + 0.045, r0 = radiusAt(y0) + 0.045;
    const g = new THREE.CylinderGeometry(r1, r0, y1 - y0, 3, 1, true, a, wide);
    b.geo(r() < 0.24 ? 'tower_algae' : 'tower_stain', g,
      b.xform(o.x, (y0 + y1) / 2, o.z, {}), { ...opt, tile: 2.4, cast: false });
  }
  // efflorescence: shorter, paler runs immediately below the cornice
  const ef = Math.round(n * 0.36);
  for (let i = 0; i < ef; i++) {
    const a = (i / ef) * Math.PI * 2 + 0.4 + r() * 0.2;
    const y1 = o.h - 0.2, y0 = y1 - 0.9 - r() * 2.2;
    const g = new THREE.CylinderGeometry(radiusAt(y1) + 0.05, radiusAt(y0) + 0.05,
      y1 - y0, 3, 1, true, a, 0.03 + r() * 0.04);
    b.geo(o.matShell, g, b.xform(o.x, (y0 + y1) / 2, o.z, {}),
      { ...opt, tile: 2.0, cast: false });
  }
}

/** Patch repairs: a shotcrete patch cast proud of the original face. */
function patches(b, o, radiusAt, opt) {
  const r = rng((o.seed ?? 7717) + 4243);
  for (let i = 0; i < (o.patches ?? 7); i++) {
    const a = r() * Math.PI * 2;
    const yc = o.yShell + (o.h - o.yShell) * (0.08 + r() * 0.78);
    const hh = 1.1 + r() * 2.6;
    const y0 = yc - hh / 2, y1 = yc + hh / 2;
    const g = new THREE.CylinderGeometry(radiusAt(y1) + 0.055, radiusAt(y0) + 0.055,
      hh, 4, 1, true, a, 0.06 + r() * 0.11);
    b.geo('tower_stain', g, b.xform(o.x, yc, o.z, {}), { ...opt, tile: 2.6, cast: false });
  }
}

/** The raker colonnade: V-pairs of inclined columns carrying the ring beam. */
function rakers(b, o, opt) {
  const n = o.rakers ?? 26;
  const rFoot = o.rBase + 0.34;
  const rHead = o.rBase - 0.06;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const spread = (Math.PI / n) * 0.82;
    for (const s of [-1, 1]) {
      const af = a + s * spread;
      b.geo(o.matShell, tube([
        [o.x + Math.cos(af) * rFoot, 0.34, o.z + Math.sin(af) * rFoot],
        [o.x + Math.cos(a) * rHead, o.yBeam + 0.1, o.z + Math.sin(a) * rHead],
      ], o.rakerR ?? 0.34, 6, { segLen: 8 }), null, { ...opt, tile: 1.6 });
    }
    // pad foundation under each pair
    b.box(o.matShell, o.x + Math.cos(a) * rFoot, 0.16, o.z + Math.sin(a) * rFoot,
      1.5, 0.32, 1.5, { ...opt, bevel: 0.05, ry: -a, cast: false });
  }
}

/** Rim cornice, walkway ring and railing. */
function rim(b, o, radiusAt, opt) {
  const rT = radiusAt(o.h);
  b.geo(o.matShell, lathe([
    [rT, -0.15], [rT + 0.46, 0.02], [rT + 0.46, 0.44], [rT + 0.1, 0.62], [rT - 0.16, 0.6],
  ], o.seg), b.xform(o.x, o.h, o.z, {}), { ...opt, tile: 1.6 });
  // grating walkway just inside the cornice
  b.geo('metal_rusted', lathe([
    [rT + 0.5, 0.44], [rT + 1.55, 0.44], [rT + 1.55, 0.52], [rT + 0.5, 0.52],
  ], o.seg), b.xform(o.x, o.h, o.z, {}), { ...opt, tile: 0.9, cast: false });
  const posts = Math.max(12, Math.round((2 * Math.PI * (rT + 1.4)) / 1.7));
  for (let i = 0; i < posts; i++) {
    const a = (i / posts) * Math.PI * 2;
    b.box('metal_painted', o.x + Math.cos(a) * (rT + 1.42), o.h + 1.06,
      o.z + Math.sin(a) * (rT + 1.42), 0.06, 1.1, 0.06, { ...opt, bevel: 0.012, ry: -a });
  }
  for (const yo of [1.6, 1.05]) {
    b.geo('metal_painted', new THREE.TorusGeometry(rT + 1.42, 0.028, 4, o.seg),
      b.xform(o.x, o.h + yo, o.z, { rx: Math.PI / 2 }), { ...opt, tile: 1.0, cast: false });
  }
  // lightning finials and an obstruction light mast
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.3;
    b.geo('metal_rusted', tube([
      [o.x + Math.cos(a) * (rT + 0.2), o.h + 0.6, o.z + Math.sin(a) * (rT + 0.2)],
      [o.x + Math.cos(a) * (rT + 0.2), o.h + 2.3, o.z + Math.sin(a) * (rT + 0.2)],
    ], 0.035, 4, { segLen: 4 }), null, { ...opt, tile: 1.0, solid: false });
  }
}

/** Caged maintenance ladder following the shell curve for the full height. */
function ladderRun(b, o, radiusAt, opt) {
  const a = o.ladderA ?? -0.65;
  const ca = Math.cos(a), sa = Math.sin(a);
  const top = o.h + 0.4;
  const at = (y, off) => {
    const rr = radiusAt(Math.max(o.yShell, y)) + off;
    return [o.x + ca * rr, y, o.z + sa * rr];
  };
  const stiles = [];
  for (const s of [-1, 1]) {
    const pts = [];
    for (let k = 0; k <= 10; k++) {
      const y = o.yBeam + ((top - o.yBeam) * k) / 10;
      const rr = radiusAt(Math.max(o.yShell, y)) + 0.42;
      const t = s * 0.24 / rr;
      pts.push([o.x + Math.cos(a + t) * rr, y, o.z + Math.sin(a + t) * rr]);
    }
    stiles.push(pts);
    b.geo('metal_painted', tube(pts, 0.032, 5, { segLen: 3.0, caps: false }), null,
      { ...opt, tile: 1.0, solid: false });
  }
  const rungs = Math.floor((top - o.yBeam) / 0.42);
  for (let i = 1; i < rungs; i++) {
    const y = o.yBeam + i * 0.42;
    const p = at(y, 0.42);
    b.box('metal_painted', p[0], p[1], p[2], 0.5, 0.028, 0.028,
      { ...opt, bevel: 0.008, ry: -a, cast: false, solid: false });
  }
  const hoops = Math.floor((top - o.yBeam - 2.4) / 0.9);
  for (let i = 0; i < hoops; i++) {
    const y = o.yBeam + 2.4 + i * 0.9;
    const p = at(y, 0.74);
    b.geo('metal_rusted', new THREE.TorusGeometry(0.38, 0.018, 4, 8, Math.PI * 1.3),
      b.xform(p[0], p[1], p[2], { rx: Math.PI / 2, ry: -a + Math.PI * 0.15 }),
      { ...opt, tile: 1.0, cast: false, solid: false });
  }
}

/* ----------------------------------------------------------------- towers -- */

/**
 * A fully detailed cooling tower.
 * o = { x, z, h, rBase, rThroat, throatT, seg, lifts, zone, seed, pond }
 */
export function coolingTower(b, o) {
  const s = {
    x: o.x, z: o.z, h: o.h,
    rBase: o.rBase ?? o.h * 0.37,
    rThroat: o.rThroat ?? o.h * 0.235,
    throatT: o.throatT ?? 0.76,
    seg: o.seg ?? 44,
    lifts: o.lifts ?? Math.max(6, Math.round(o.h / 1.55)),
    ledge: o.ledge ?? 0.085,
    wobble: o.wobble ?? 0.055,
    yBeam: o.yBeam ?? Math.max(3.0, o.h * 0.145),
    seed: o.seed ?? 7717,
    matShell: 'concrete_tower',
    stains: o.stains,
    patches: o.patches,
    rakers: o.rakers,
    seams: o.seams,
    ladderA: o.ladderA,
    rakerR: o.rakerR,
  };
  s.yShell = s.yBeam + 0.85;
  const radiusAt = makeRadius(s);
  const zone = o.zone ?? 'core';
  const opt = { zone, cast: o.cast, recv: o.recv, solid: o.solid };
  const shellOpt = { ...opt, uvCyl: [s.x, s.z, s.rBase] };

  // ---- shell
  b.geo(s.matShell, lathe(shellProfile(s, radiusAt), s.seg),
    b.xform(s.x, 0, s.z, {}), { ...shellOpt, tile: 2.0 });

  // ---- recessed air inlet: the throat behind the colonnade never sees sky, so
  // it is painted, not left to an ambient term that may or may not exist.
  b.geo('tower_shade',
    new THREE.CylinderGeometry(s.rBase - 0.4, s.rBase - 0.4, s.yBeam - 1.3, s.seg, 1, true),
    b.xform(s.x, 0.9 + (s.yBeam - 1.3) / 2, s.z, {}), { ...opt, tile: 2.4, cast: false });

  formSeams(b, s, radiusAt, opt);
  rakers(b, s, opt);
  rimStains(b, s, radiusAt, opt);
  patches(b, s, radiusAt, opt);
  rim(b, s, radiusAt, opt);
  ladderRun(b, s, radiusAt, opt);

  // ---- damp band and algae at the base, plus the pond kerb
  b.geo('tower_algae',
    new THREE.CylinderGeometry(s.rBase + 0.65, s.rBase + 0.67, 1.15, s.seg, 1, true),
    b.xform(s.x, 0.55, s.z, {}), { ...opt, tile: 2.2, cast: false });
  if (o.pond !== false) {
    b.geo('concrete', lathe([
      [s.rBase + 3.4, 0], [s.rBase + 4.2, 0], [s.rBase + 4.2, 0.52],
      [s.rBase + 3.98, 0.62], [s.rBase + 3.4, 0.62],
    ], Math.round(s.seg * 0.7)), b.xform(s.x, 0, s.z, {}), { ...opt, tile: 1.6 });
    b.box('concrete', s.x, 0.14, s.z, (s.rBase + 4.4) * 2, 0.28, (s.rBase + 4.4) * 2,
      { ...opt, bevel: 0.08, seg: 4, cast: false });
  }

  // ---- inlet duct and valve house on one flank: breaks the plan symmetry
  const da = o.ductA ?? 2.3;
  const dx = s.x + Math.cos(da) * (s.rBase + 3.0), dz = s.z + Math.sin(da) * (s.rBase + 3.0);
  b.box('concrete', dx, 1.5, dz, 3.2, 3.0, 6.4, { ...opt, bevel: 0.06, seg: 3, ry: -da });
  b.geo('metal_rusted', tube([
    [s.x + Math.cos(da) * (s.rBase - 0.2), 2.2, s.z + Math.sin(da) * (s.rBase - 0.2)],
    [dx, 2.2, dz],
  ], 0.62, 10, { segLen: 4 }), null, { ...opt, tile: 1.4 });
}

/**
 * The cheap version, for the 60-180 m outfield band. Same silhouette language —
 * hyperbolic curve, lift lines, colonnade, cornice — at a fifth of the cost and
 * with no shadow, no collider and no interior.
 */
export function coolingShell(b, o) {
  const s = {
    x: o.x, z: o.z, h: o.h,
    rBase: o.rBase ?? o.h * 0.35,
    rThroat: o.rThroat ?? o.h * 0.222,
    throatT: 0.76,
    seg: o.seg ?? 22,
    lifts: Math.max(5, Math.round(o.h / 3.4)),
    ledge: 0.11,
    wobble: 0.07,
    yBeam: o.h * 0.13,
    seed: o.seed ?? 331,
    matShell: 'concrete_tower',
  };
  s.yShell = s.yBeam + 1.0;
  const radiusAt = makeRadius(s);
  const opt = { zone: o.zone ?? 'far_mid', cast: false, recv: false, solid: false };

  b.geo(s.matShell, lathe(shellProfile(s, radiusAt), s.seg), b.xform(s.x, 0, s.z, {}),
    { ...opt, tile: 2.0, uvCyl: [s.x, s.z, s.rBase] });
  b.geo('tower_shade',
    new THREE.CylinderGeometry(s.rBase - 0.5, s.rBase - 0.5, s.yBeam - 1.0, s.seg, 1, true),
    b.xform(s.x, 0.7 + (s.yBeam - 1.0) / 2, s.z, {}), { ...opt, tile: 3.0 });
  // colonnade — 14 single columns is enough to read as a colonnade at 120 m
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2;
    b.geo(s.matShell, tube([
      [s.x + Math.cos(a) * (s.rBase + 0.5), 0.2, s.z + Math.sin(a) * (s.rBase + 0.5)],
      [s.x + Math.cos(a) * (s.rBase - 0.1), s.yBeam, s.z + Math.sin(a) * (s.rBase - 0.1)],
    ], 0.42, 5, { segLen: 20 }), null, { ...opt, tile: 2.0 });
  }
  const rT = radiusAt(s.h);
  b.geo(s.matShell, lathe([[rT, -0.2], [rT + 0.5, 0.05], [rT + 0.5, 0.5], [rT, 0.66]], s.seg),
    b.xform(s.x, s.h, s.z, {}), { ...opt, tile: 1.8 });
  // staining, in one merged pass — the outfield towers are read as tone, not form
  const r = rng(s.seed + 17);
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2 + r() * 0.3;
    const y1 = s.h - 0.4, y0 = y1 - (s.h - s.yShell) * (0.2 + r() * 0.5);
    b.geo('tower_stain',
      new THREE.CylinderGeometry(radiusAt(y1) + 0.07, radiusAt(y0) + 0.07, y1 - y0, 3, 1, true,
        a, 0.05 + r() * 0.1),
      b.xform(s.x, (y0 + y1) / 2, s.z, {}), { ...opt, tile: 3.0 });
  }
  b.geo('tower_algae',
    new THREE.CylinderGeometry(s.rBase + 0.9, s.rBase + 0.95, 1.8, s.seg, 1, true),
    b.xform(s.x, 0.9, s.z, {}), { ...opt, tile: 3.0 });
}
