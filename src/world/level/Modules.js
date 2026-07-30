import * as THREE from 'three';
import {
  chamferBox, profileExtrude, wallPanel, corrugated, gratingPanel,
  tube, cyl, lathe, rng,
} from './GeoKit.js';

/**
 * OWNER: level agent.
 * The modular architectural kit. Every function here emits real, correctly
 * proportioned building geometry into a Builder: 3.0-3.6m floor heights,
 * 2.1m door openings, 1.1m railings, 0.18m risers, 0.3-0.4m wall thickness.
 *
 * Nothing here emits a bare box. Walls get a plinth, a string course, pilasters
 * and chamfered reveals. Slabs get a drip edge. Stairs get stringers, nosings
 * and real risers. Catwalks get bar grating, kick plates and brackets.
 */

const HALF_PI = Math.PI / 2;

/** Local(u along panel width, w = wall normal) -> world helpers. */
function axisFrame(axis) {
  // returns { ry, uDir, nDir } where uDir/nDir are world unit vectors
  if (axis === 'x') return { ry: 0, u: new THREE.Vector3(1, 0, 0), n: new THREE.Vector3(0, 0, 1) };
  return { ry: HALF_PI, u: new THREE.Vector3(0, 0, -1), n: new THREE.Vector3(1, 0, 0) };
}

/* -------------------------------------------------------------------- walls - */

/**
 * A wall run with real thickness, chamfered opening reveals and applied trim.
 * o = { cx, cz, y0, len, height, thick, axis, mat, zone,
 *       openings:[{u,y,w,h,kind}], plinth, course, pilasterEvery, tile }
 * `u` is measured from the wall's left end (0..len).
 */
export function wall(b, o) {
  const { cx, cz, len, height, axis = 'x' } = o;
  const y0 = o.y0 ?? 0;
  const t = o.thick ?? 0.36;
  const mat = o.mat ?? 'concrete';
  const zone = o.zone ?? 'core';
  const f = axisFrame(axis);
  // Panel space origin is bottom-left: x = u along the run, y = height above y0.
  // Holes are inset off the panel boundary — a hole touching the outline makes
  // the triangulator produce degenerate caps, which is how "walls with windows"
  // usually turns into a mess.
  const EPS = 0.07;
  const holes = (o.openings ?? []).map((op) => {
    const x = Math.min(Math.max(op.u, EPS), len - EPS - Math.min(op.w, len - 2 * EPS));
    const yy = Math.min(Math.max(op.y - y0, EPS), height - EPS - Math.min(op.h, height - 2 * EPS));
    return {
      x, y: yy,
      w: Math.min(op.w, len - 2 * EPS - 0.001),
      h: Math.min(op.h, height - 2 * EPS - 0.001),
    };
  });

  const panel = wallPanel(len, height, t, holes, { bevel: o.bevel ?? 0.03 });
  const m = b.xform(cx, y0 + height / 2, cz, { ry: f.ry });
  b.geo(mat, panel, m, { zone, tile: o.tile ?? 2.0, cast: o.cast, recv: o.recv, solid: o.solid });

  // plinth — a slightly proud base course, kills the "floating plane" read
  if (o.plinth !== false) {
    const ph = o.plinthH ?? 0.55;
    b.box(o.plinthMat ?? mat, cx, y0 + ph / 2, cz, len, ph, t + 0.1,
      { ry: f.ry, zone, bevel: 0.035, tile: o.tile ?? 2.0 });
  }
  // string course / drip at the head
  if (o.course !== false) {
    b.box(o.courseMat ?? mat, cx, y0 + height - 0.12, cz, len, 0.24, t + 0.14,
      { ry: f.ry, zone, bevel: 0.03, tile: o.tile ?? 2.0 });
  }
  // pilasters break the face into bays
  const pe = o.pilasterEvery ?? 0;
  if (pe > 0) {
    const n = Math.max(1, Math.round(len / pe));
    for (let i = 0; i <= n; i++) {
      const u = (i / n) * len - len / 2;
      const p = new THREE.Vector3().copy(f.u).multiplyScalar(u);
      if (_clashes(holes, u + len / 2, 0.45)) continue;
      b.box(mat, cx + p.x, y0 + (height - 0.1) / 2, cz + p.z, 0.5, height - 0.1, t + 0.22,
        { ry: f.ry, zone, bevel: 0.035, seg: 2, tile: o.tile ?? 2.0 });
    }
  }
  // record apertures so the lighting agent can hang shafts off them
  if (o.apertures) {
    for (const h of holes) {
      const u = h.x + h.w / 2 - len / 2;
      const p = new THREE.Vector3().copy(f.u).multiplyScalar(u);
      o.apertures.push({
        position: new THREE.Vector3(cx + p.x, y0 + h.y + h.h / 2, cz + p.z),
        normal: f.n.clone(),
        width: h.w, height: h.h,
      });
    }
  }
  return holes;
}

function _clashes(holes, u, pad) {
  for (const h of holes) if (u > h.x - pad && u < h.x + h.w + pad) return true;
  return false;
}

/** Corrugated steel cladding stretched over a wall face. */
export function cladding(b, o) {
  const f = axisFrame(o.axis ?? 'x');
  const panels = Math.max(1, Math.round(o.len / (o.panelW ?? 3.0)));
  const pw = o.len / panels;
  for (let i = 0; i < panels; i++) {
    const u = (i + 0.5) * pw - o.len / 2;
    const p = new THREE.Vector3().copy(f.u).multiplyScalar(u);
    const off = new THREE.Vector3().copy(f.n).multiplyScalar(o.offset ?? 0);
    const g = corrugated(pw, o.height, { backFace: o.backFace, pitch: o.pitch ?? 0.082 });
    b.geo(o.mat ?? 'metal_painted', g,
      b.xform(o.cx + p.x + off.x, o.cy, o.cz + p.z + off.z, { ry: f.ry + (o.flip ? Math.PI : 0) }),
      { zone: o.zone, tile: o.tile ?? 1.6, cast: o.cast, recv: o.recv, solid: o.solid });
  }
  // girts / fixing rails so the sheet has structure behind it
  const rails = o.rails ?? 3;
  for (let i = 0; i < rails; i++) {
    const y = o.cy - o.height / 2 + (i + 0.5) * (o.height / rails);
    const off = new THREE.Vector3().copy(f.n).multiplyScalar((o.offset ?? 0) - 0.07);
    b.box('metal_rusted', o.cx + off.x, y, o.cz + off.z, o.len, 0.1, 0.07,
      { ry: f.ry, zone: o.zone, bevel: 0.012 });
  }
}

/* ------------------------------------------------------------- openings ----- */

/** Steel window: frame, mullions, transom, glass, sill, and a reveal shadow. */
export function windowUnit(b, o) {
  const f = axisFrame(o.axis ?? 'x');
  const mat = o.mat ?? 'metal_painted';
  const zone = o.zone;
  const { w, h } = o;
  const ry = f.ry;
  const px = o.x, py = o.y, pz = o.z;
  const d = o.depth ?? 0.1;
  // outer frame
  for (const [ow, oh, oy, ox] of [[w, 0.09, h / 2 - 0.045, 0], [w, 0.09, -h / 2 + 0.045, 0]]) {
    b.box(mat, px, py + oy, pz, ow, oh, d, { ry, zone, bevel: 0.015 });
  }
  for (const s of [-1, 1]) {
    const p = new THREE.Vector3().copy(f.u).multiplyScalar(s * (w / 2 - 0.045));
    b.box(mat, px + p.x, py, pz + p.z, 0.09, h, d, { ry, zone, bevel: 0.015 });
  }
  // mullions + transoms
  const cols = o.cols ?? Math.max(1, Math.round(w / 1.1));
  const rows = o.rows ?? Math.max(1, Math.round(h / 1.2));
  for (let i = 1; i < cols; i++) {
    const p = new THREE.Vector3().copy(f.u).multiplyScalar((i / cols) * w - w / 2);
    b.box(mat, px + p.x, py, pz + p.z, 0.055, h - 0.09, d * 0.85, { ry, zone, bevel: 0.01 });
  }
  for (let j = 1; j < rows; j++) {
    b.box(mat, px, py + (j / rows) * h - h / 2, pz, w - 0.09, 0.05, d * 0.85, { ry, zone, bevel: 0.01 });
  }
  // glazing
  if (o.glass !== false) {
    b.box('glass', px, py, pz, w - 0.1, h - 0.1, 0.018,
      { ry, zone, bevel: 0.004, cast: false, tile: 2.4 });
  }
  // sill, sloped and proud
  if (o.sill !== false) {
    const n = new THREE.Vector3().copy(f.n).multiplyScalar(o.sillOut ?? 0.11);
    b.box('concrete', px + n.x, py - h / 2 - 0.09, pz + n.z, w + 0.34, 0.13, 0.42,
      { ry, zone, bevel: 0.028, rx: 0 });
  }
  if (o.apertures) {
    o.apertures.push({
      position: new THREE.Vector3(px, py, pz), normal: f.n.clone(), width: w, height: h,
    });
  }
}

/** Door surround: jambs, head, threshold, and an optional steel leaf. */
export function doorUnit(b, o) {
  const f = axisFrame(o.axis ?? 'x');
  const zone = o.zone;
  const w = o.w ?? 1.15, h = o.h ?? 2.1;
  const { x, y, z } = o; // y = threshold level
  const d = o.depth ?? 0.16;
  for (const s of [-1, 1]) {
    const p = new THREE.Vector3().copy(f.u).multiplyScalar(s * (w / 2 + 0.07));
    b.box('metal_painted', x + p.x, y + h / 2, z + p.z, 0.14, h + 0.16, d, { ry: f.ry, zone, bevel: 0.02 });
  }
  b.box('metal_painted', x, y + h + 0.07, z, w + 0.28, 0.14, d, { ry: f.ry, zone, bevel: 0.02 });
  b.box('metal_painted', x, y + 0.03, z, w + 0.28, 0.06, d + 0.06, { ry: f.ry, zone, bevel: 0.014 });
  if (o.leaf) {
    const p = new THREE.Vector3().copy(f.u).multiplyScalar(o.open ? w * 0.85 : 0);
    const n = new THREE.Vector3().copy(f.n).multiplyScalar(o.open ? w * 0.5 : 0);
    b.box(o.leafMat ?? 'metal_rusted', x + p.x + n.x, y + h / 2, z + p.z + n.z,
      w - 0.04, h - 0.05, 0.06,
      { ry: f.ry + (o.open ? 1.15 : 0), zone, bevel: 0.014, seg: 2 });
  }
}

/** Roller shutter door — big industrial opening with slat geometry. */
export function shutter(b, o) {
  const f = axisFrame(o.axis ?? 'x');
  const slats = Math.round((o.h * (o.closed ?? 0.28)) / 0.16);
  for (let i = 0; i < slats; i++) {
    const y = o.y + o.h - 0.08 - i * 0.16;
    b.box('metal_painted', o.x, y, o.z, o.w - 0.1, 0.15, 0.05,
      { ry: f.ry, zone: o.zone, bevel: 0.014 });
  }
  // guide rails + head box
  for (const s of [-1, 1]) {
    const p = new THREE.Vector3().copy(f.u).multiplyScalar(s * (o.w / 2 - 0.02));
    b.box('metal_rusted', o.x + p.x, o.y + o.h / 2, o.z + p.z, 0.14, o.h, 0.2,
      { ry: f.ry, zone: o.zone, bevel: 0.02 });
  }
  b.box('metal_painted', o.x, o.y + o.h + 0.24, o.z, o.w + 0.3, 0.46, 0.42,
    { ry: f.ry, zone: o.zone, bevel: 0.03, seg: 2 });
}

/* --------------------------------------------------------------- structure -- */

/** Floor / roof slab with a chamfered drip edge and optional voids. */
export function slab(b, o) {
  // hole {x,z} is the void centre relative to the slab centre, in world axes.
  const holes = (o.holes ?? []).map((h) => ({
    x: h.x + o.w / 2 - h.w / 2, y: -h.z + o.d / 2 - h.d / 2, w: h.w, h: h.d,
  }));
  const g = wallPanel(o.w, o.d, o.thick ?? 0.32, holes, { bevel: 0.035 });
  b.geo(o.mat ?? 'concrete', g, b.xform(o.x, o.y, o.z, { rx: -HALF_PI }),
    { zone: o.zone, tile: o.tile ?? 2.0, cast: o.cast, recv: o.recv, solid: o.solid });
  if (o.edge !== false) {
    const t = o.thick ?? 0.32;
    for (const [w, d, dx, dz] of [[o.w + 0.2, 0.22, 0, o.d / 2], [o.w + 0.2, 0.22, 0, -o.d / 2],
      [0.22, o.d + 0.2, o.w / 2, 0], [0.22, o.d + 0.2, -o.w / 2, 0]]) {
      b.box(o.edgeMat ?? o.mat ?? 'concrete', o.x + dx, o.y - t * 0.1, o.z + dz, w, t + 0.12, d,
        { zone: o.zone, bevel: 0.035, tile: o.tile ?? 2.0 });
    }
  }
}

/**
 * A stair landing: a slab whose walking surface is genuinely flat.
 *
 * `slab()` wraps its deck in an edge frame that is 120 mm DEEPER than the deck
 * and centred 10% of the thickness low, so the frame's top sits ~36 mm PROUD of
 * the walking surface with a 35 mm chamfer on its arris. That is fine for a roof
 * you never stand on and fatal at the head of a flight: the chamfer is a 45
 * degree face, cos 45 = 0.7071, and PLAYER.maxSlope is 0.72 — so a 45 degree
 * arris is 1.1 degrees TOO STEEP TO STAND ON. Arriving at the top tread the
 * player's only contact was that arris, the controller read it as an unwalkable
 * slope, refused to accelerate and pushed him back down the flight. Measured on
 * the real controller: horizontal velocity pinned at 0.00 with +0.59 m/s of
 * upward push, at the top tread of every flight in the map.
 *
 * So the fascia hangs BELOW the deck here, which is also where a downstand edge
 * beam belongs in a real building, and the walking surface has no lip at all.
 */
export function landing(b, o) {
  const t = o.thick ?? 0.24;
  const mat = o.mat ?? 'concrete';
  const top = o.y + t / 2;
  slab(b, { ...o, thick: t, mat, edge: false });
  // Fascia sits INSIDE the plan and hangs below the deck, so nothing it carries
  // — not its face, not its chamfered arris — is ever above the walking surface.
  const fd = o.fascia ?? 0.34;
  for (const [fw, fdp, dx, dz] of [
    [o.w, 0.18, 0, o.d / 2 - 0.09], [o.w, 0.18, 0, -(o.d / 2 - 0.09)],
    [0.18, o.d - 0.36, o.w / 2 - 0.09, 0], [0.18, o.d - 0.36, -(o.w / 2 - 0.09), 0],
  ]) {
    if (fw <= 0.02 || fdp <= 0.02) continue;
    b.box(o.edgeMat ?? mat, o.x + dx, top - 0.02 - fd / 2, o.z + dz, fw, fd, fdp,
      { zone: o.zone, bevel: 0.03, tile: o.tile ?? 2.0 });
  }
}

/** Pillar with base, shaft and capital — reads as structure, not a stretched cube. */
export function pillar(b, o) {
  const w = o.w ?? 0.62, h = o.h ?? 3.6, mat = o.mat ?? 'concrete';
  b.box(mat, o.x, 0.11 + o.y, o.z, w + 0.34, 0.22, w + 0.34, { zone: o.zone, bevel: 0.03 });
  b.box(mat, o.x, o.y + h / 2, o.z, w, h, w, { zone: o.zone, bevel: 0.035, seg: o.seg ?? 3 });
  b.box(mat, o.x, o.y + h - 0.16, o.z, w + 0.3, 0.32, w + 0.3, { zone: o.zone, bevel: 0.035 });
  if (o.corbel) {
    for (const s of [-1, 1]) {
      b.box(mat, o.x + s * (w / 2 + 0.2), o.y + h - 0.55, o.z, 0.4, 0.5, w,
        { zone: o.zone, bevel: 0.03, rz: s * 0.18 });
    }
  }
}

/** Steel I-section run — gantries, portal frames, lintels. */
export function ibeam(b, o) {
  const h = o.h ?? 0.42, fw = o.fw ?? 0.24, tf = 0.028, tw = 0.02;
  const p = [
    [-fw / 2, -h / 2], [fw / 2, -h / 2], [fw / 2, -h / 2 + tf], [tw / 2, -h / 2 + tf],
    [tw / 2, h / 2 - tf], [fw / 2, h / 2 - tf], [fw / 2, h / 2], [-fw / 2, h / 2],
    [-fw / 2, h / 2 - tf], [-tw / 2, h / 2 - tf], [-tw / 2, -h / 2 + tf], [-fw / 2, -h / 2 + tf],
  ];
  const g = profileExtrude(p, o.len, { bevel: 0.008, bevelSegments: 1 });
  b.geo(o.mat ?? 'metal_painted', g, b.xform(o.x, o.y, o.z, { ry: o.ry ?? 0, rz: o.rz ?? 0, rx: o.rx ?? 0 }),
    { zone: o.zone, tile: o.tile ?? 1.2 });
}

/** Stair flight with stringers, real risers, nosed treads and railings. */
export function stair(b, o) {
  const steps = o.steps ?? 12;
  const rise = o.rise ?? 0.185, run = o.run ?? 0.29, wdt = o.width ?? 1.5;
  const dir = o.dir ?? new THREE.Vector3(0, 0, 1);
  const side = new THREE.Vector3(dir.z, 0, -dir.x);
  const ry = Math.atan2(dir.x, dir.z);
  const mat = o.mat ?? 'concrete';
  for (let i = 0; i < steps; i++) {
    const along = (i + 0.5) * run;
    const y = o.y + (i + 1) * rise;
    const cx = o.x + dir.x * along, cz = o.z + dir.z * along;
    // tread with a proud nosing
    b.box(mat, cx, y - 0.035, cz, wdt, 0.07, run + 0.045, { ry, zone: o.zone, bevel: 0.016 });
    // riser
    b.box(o.riserMat ?? mat, cx - dir.x * (run / 2 - 0.02), y - rise / 2 - 0.03,
      cz - dir.z * (run / 2 - 0.02), wdt - 0.04, rise - 0.06, 0.05,
      { ry, zone: o.zone, bevel: 0.01 });
  }
  // stringers
  const total = steps * run, climb = steps * rise;
  const ang = Math.atan2(climb, total);
  const len = Math.hypot(total, climb) + 0.4;
  for (const s of [-1, 1]) {
    const px = o.x + dir.x * total / 2 + side.x * s * (wdt / 2 + 0.09);
    const pz = o.z + dir.z * total / 2 + side.z * s * (wdt / 2 + 0.09);
    const g = chamferBox(0.14, 0.4, len, 0.02, 1);
    b.geo(o.stringerMat ?? 'metal_painted', g,
      b.xform(px, o.y + climb / 2 - 0.06, pz, { ry, rx: -ang }), { zone: o.zone, tile: 1.4 });
  }
  if (o.rail !== false) {
    for (const s of (o.railSides ?? [-1, 1])) {
      railingRun(b, {
        from: new THREE.Vector3(o.x + side.x * s * (wdt / 2 + 0.09), o.y, o.z + side.z * s * (wdt / 2 + 0.09)),
        to: new THREE.Vector3(o.x + dir.x * total + side.x * s * (wdt / 2 + 0.09), o.y + climb,
          o.z + dir.z * total + side.z * s * (wdt / 2 + 0.09)),
        zone: o.zone, height: 1.05, toe: false,
      });
    }
  }
  return new THREE.Vector3(o.x + dir.x * total, o.y + climb, o.z + dir.z * total);
}

/** Tube railing: posts, top rail, mid rail, kick plate. 1.1m to code. */
export function railingRun(b, o) {
  const from = o.from, to = o.to;
  const h = o.height ?? 1.1;
  const d = new THREE.Vector3().subVectors(to, from);
  const len = d.length();
  if (len < 0.2) return;
  const n = Math.max(2, Math.round(len / (o.postEvery ?? 1.35)) + 1);
  const zone = o.zone;
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const p = new THREE.Vector3().copy(from).addScaledVector(d, t);
    b.box('metal_painted', p.x, p.y + h / 2, p.z, 0.055, h, 0.055, { zone, bevel: 0.012 });
  }
  for (const yo of [h, h * 0.55]) {
    b.geo('metal_painted', tube([
      [from.x, from.y + yo, from.z], [to.x, to.y + yo, to.z],
    ], 0.028, 8, { segLen: 2.5 }), null, { zone, tile: 1.0 });
  }
  if (o.toe !== false) {
    const mid = new THREE.Vector3().addVectors(from, to).multiplyScalar(0.5);
    const ry = Math.atan2(d.x, d.z);
    b.box('metal_rusted', mid.x, mid.y + 0.06, mid.z, 0.02, 0.12, len, { ry, zone, bevel: 0.006 });
  }
}

/** Catwalk: grating deck, edge channels, railings and support brackets. */
export function catwalk(b, o) {
  const from = o.from, to = o.to, w = o.width ?? 1.5;
  const d = new THREE.Vector3().subVectors(to, from);
  const len = d.length();
  const ry = Math.atan2(d.x, d.z);
  const mid = new THREE.Vector3().addVectors(from, to).multiplyScalar(0.5);
  const zone = o.zone;
  const g = gratingPanel(w, len, { pitch: o.pitch ?? 0.1 });
  b.geo('metal_rusted', g, b.xform(mid.x, mid.y - 0.02, mid.z, { ry }), { zone, tile: 0.9 });
  // edge channels
  for (const s of [-1, 1]) {
    const side = new THREE.Vector3(d.z, 0, -d.x).normalize().multiplyScalar(s * (w / 2 + 0.04));
    b.box('metal_painted', mid.x + side.x, mid.y - 0.09, mid.z + side.z, 0.08, 0.2, len,
      { ry, zone, bevel: 0.012 });
    if (o.rail !== false) {
      railingRun(b, {
        from: new THREE.Vector3(from.x + side.x, from.y, from.z + side.z),
        to: new THREE.Vector3(to.x + side.x, to.y, to.z + side.z), zone, height: 1.1,
      });
    }
  }
  // brackets every 3m
  const nb = Math.max(2, Math.round(len / 3));
  for (let i = 0; i <= nb; i++) {
    const p = new THREE.Vector3().copy(from).addScaledVector(d, i / nb);
    if (o.brackets === false) break;
    for (const s of [-1, 1]) {
      const side = new THREE.Vector3(d.z, 0, -d.x).normalize().multiplyScalar(s * (w / 2 - 0.1));
      b.box('metal_painted', p.x + side.x * 0.8, p.y - 0.42, p.z + side.z * 0.8, 0.09, 0.09, 0.9,
        { zone, bevel: 0.01, rx: s * 0.7, ry: ry + HALF_PI });
    }
  }
}

/** Pipe run with flanges, hangers and a couple of valves. */
export function pipeRun(b, o) {
  const pts = o.points;
  const r = o.radius ?? 0.16;
  b.geo(o.mat ?? 'metal_rusted', tube(pts, r, o.seg ?? 12, { segLen: o.segLen ?? 1.6 }), null,
    { zone: o.zone, tile: 1.0 });
  if (o.flanges !== false) {
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const g = cyl(r * 1.7, r * 1.7, 0.07, 14);
      const nxt = pts[Math.min(i + 1, pts.length - 1)];
      const prv = pts[Math.max(i - 1, 0)];
      const dir = new THREE.Vector3(nxt[0] - prv[0], nxt[1] - prv[1], nxt[2] - prv[2]).normalize();
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
      const m = new THREE.Matrix4().compose(new THREE.Vector3(p[0], p[1], p[2]), q, new THREE.Vector3(1, 1, 1));
      b.geo('metal_painted', g, m, { zone: o.zone, tile: 0.8 });
    }
  }
}

/** Open-web truss between two points — pipe bridges, roof frames, gantries. */
export function truss(b, o) {
  const from = o.from, to = o.to, depth = o.depth ?? 1.6, wdt = o.width ?? 1.4;
  const d = new THREE.Vector3().subVectors(to, from);
  const len = d.length();
  const dir = d.clone().normalize();
  const side = new THREE.Vector3(dir.z, 0, -dir.x).normalize();
  const bays = o.bays ?? Math.max(3, Math.round(len / 2.4));
  const mat = o.mat ?? 'metal_painted';
  const zone = o.zone;
  // Flags pass through so a truss used as distant scenery can opt out of the
  // shadow map and the collider set. A 60m gantry at 200m has no business
  // costing a shadow pass or a BVH node.
  const fl = { zone, tile: o.tile ?? 1.0, cast: o.cast, recv: o.recv, solid: o.solid };
  const node = (t, s, up) => new THREE.Vector3()
    .copy(from).addScaledVector(d, t)
    .addScaledVector(side, s * wdt / 2)
    .setY(from.y + (to.y - from.y) * t + (up ? depth : 0));
  for (const s of [-1, 1]) {
    for (const up of [false, true]) {
      b.geo(mat, tube([node(0, s, up), node(1, s, up)], o.chord ?? 0.075, 8, { segLen: 3 }), null, fl);
    }
    for (let i = 0; i < bays; i++) {
      const t0 = i / bays, t1 = (i + 1) / bays;
      b.geo(mat, tube([node(t0, s, false), node(t1, s, true)], 0.04, 6, { segLen: 3 }), null, fl);
      b.geo(mat, tube([node(t0, s, true), node(t0, s, false)], 0.04, 6, { segLen: 3 }), null, fl);
    }
  }
  for (let i = 0; i <= bays; i++) {
    const t = i / bays;
    for (const up of [false, true]) {
      b.geo(mat, tube([node(t, -1, up), node(t, 1, up)], 0.04, 6, { segLen: 3 }), null, fl);
    }
  }
}

/* ------------------------------------------------------------- groundworks -- */

/**
 * Jersey barrier — the classic hard-cover silhouette, extruded profile.
 *
 * Every arris along the length carries an explicit 22mm chamfer. A cast barrier
 * has one in reality (the mould is drafted and the arris is tooled so it does
 * not spall), and without it the top edge renders as a one-pixel razor line
 * that reads as untextured CG. With it, the chamfer picks up its own specular
 * band and the barrier reads as a heavy cast object at 40m.
 */
export function jersey(b, o) {
  const c = 0.022;
  const p = [
    [-0.45 + c, 0], [0.45 - c, 0],                     // base, chamfered toes
    [0.45, c], [0.45, 0.09 - c * 0.5], [0.45 - c * 0.6, 0.09 + c * 0.4],
    [0.19 + c * 0.4, 0.42 - c * 0.9], [0.19 - c * 0.2, 0.42 + c * 0.6],
    [0.14, 1.02 - c], [0.14 - c, 1.02],                // top arris
    [-0.14 + c, 1.02], [-0.14, 1.02 - c],
    [-0.19 + c * 0.2, 0.42 + c * 0.6], [-0.19 - c * 0.4, 0.42 - c * 0.9],
    [-0.45 + c * 0.6, 0.09 + c * 0.4], [-0.45, 0.09 - c * 0.5], [-0.45, c],
  ];
  const g = profileExtrude(p, o.len ?? 3.0, { bevel: 0.02 });
  b.geo(o.mat ?? 'concrete', g,
    b.xform(o.x, o.y ?? 0, o.z, { ry: o.ry ?? 0, rx: o.rx ?? 0, rz: o.rz ?? 0 }),
    { zone: o.zone, tile: 1.4, cast: o.cast, solid: o.solid });
  // cast-in lifting eyes — two per unit, the detail that says "precast"
  if (o.eyes !== false) {
    const len = o.len ?? 3.0;
    for (const s of [-1, 1]) {
      const g2 = new THREE.TorusGeometry(0.062, 0.016, 5, 12, Math.PI);
      b.geo('metal_rusted', g2,
        b.xform(o.x, o.y ?? 0, o.z, { ry: o.ry ?? 0, rx: o.rx ?? 0, rz: o.rz ?? 0 })
          .multiply(new THREE.Matrix4().makeTranslation(0, 1.0, s * len * 0.28)),
        { zone: o.zone, tile: 0.5, cast: false });
    }
  }
}

/**
 * A haunch / gusset filling the re-entrant corner where a beam lands on a
 * column. Structurally this is where the moment is, so real buildings always
 * thicken here — and visually it is what stops a portal frame reading as two
 * loose boxes that happen to touch.
 *
 * At ry = 0 the vertical leg sits at the origin, the triangle reaches `reach`
 * along +X, rises `rise` along +Y and is `width` thick along Z. Rotate with ry
 * to aim it. `flip: true` mirrors it in Y so the wedge hangs down from a soffit
 * instead of sitting on a slab — that is the head-of-column case.
 */
export function haunch(b, o) {
  const reach = o.reach ?? 0.75, rise = o.rise ?? 0.6, wdt = o.width ?? 0.34;
  const c = 0.035, sy = o.flip ? -1 : 1;
  const p = [
    [0, c * sy], [0, (rise - c) * sy], [c * 0.7, rise * sy],
    [reach - c, c * 0.7 * sy], [reach, 0], [c, 0],
  ];
  const g = profileExtrude(p, wdt, { bevel: 0.022 });
  b.geo(o.mat ?? 'concrete', g, b.xform(o.x, o.y, o.z, { ry: o.ry ?? 0 }),
    { zone: o.zone, tile: o.tile ?? 1.6 });
}

/**
 * Steel column base: grout plinth, chamfered base plate, four bolt heads and a
 * pair of stiffener ribs. Two hundred triangles that make every stanchion in
 * the level stop looking like it was pushed into the floor.
 */
export function basePlate(b, o) {
  const s = o.size ?? 0.44, zone = o.zone;
  b.box('concrete', o.x, o.y + 0.05, o.z, s + 0.5, 0.1, s + 0.5,
    { zone, bevel: 0.05, cast: false, tile: 1.2 });
  b.box('metal_painted', o.x, o.y + 0.125, o.z, s, 0.05, s, { zone, bevel: 0.012, tile: 0.8 });
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      b.box('metal_rusted', o.x + sx * s * 0.34, o.y + 0.17, o.z + sz * s * 0.34,
        0.05, 0.045, 0.05, { zone, bevel: 0.008, tile: 0.4 });
    }
  }
  const rib = o.ribAxis === 'z' ? { w: 0.03, d: s * 0.9 } : { w: s * 0.9, d: 0.03 };
  for (const sgn of [-1, 1]) {
    const off = o.ribAxis === 'z' ? { x: sgn * (o.stem ?? 0.11), z: 0 } : { x: 0, z: sgn * (o.stem ?? 0.11) };
    b.box('metal_painted', o.x + off.x, o.y + 0.29, o.z + off.z, rib.w, 0.28, rib.d,
      { zone, bevel: 0.008, tile: 0.6 });
  }
}

/**
 * A throated drip nib under a coping or slab overhang. Water breaks off at the
 * throat instead of tracking back, so real concrete has one — and it draws a
 * hard shadow line right under the eaves, which is what separates a parapet
 * from a painted-on edge.
 */
export function dripEdge(b, o) {
  const len = o.len, zone = o.zone;
  b.box(o.mat ?? 'concrete', o.x, o.y, o.z, o.axis === 'z' ? 0.11 : len, 0.075,
    o.axis === 'z' ? len : 0.11, { zone, bevel: 0.016, tile: 1.2, cast: false });
  b.box(o.mat ?? 'concrete', o.x, o.y - 0.055, o.z, o.axis === 'z' ? 0.055 : len, 0.05,
    o.axis === 'z' ? len : 0.055, { zone, bevel: 0.012, tile: 1.0, cast: false });
}

/** Kerb with a chamfered top arris. */
export function kerb(b, o) {
  const p = [[-0.16, 0], [0.16, 0], [0.16, 0.13], [0.1, 0.16], [-0.16, 0.16]];
  const g = profileExtrude(p, o.len, { bevel: 0.014 });
  b.geo(o.mat ?? 'concrete', g, b.xform(o.x, o.y ?? 0, o.z, { ry: o.ry ?? 0 }),
    { zone: o.zone, tile: 1.2 });
}

/** Vehicle ramp with side kerbs. */
export function ramp(b, o) {
  const rise = o.rise, len = o.len, w = o.width;
  const ang = Math.atan2(rise, len);
  const g = chamferBox(w, 0.28, Math.hypot(len, rise), 0.03, 3);
  b.geo(o.mat ?? 'concrete', g,
    b.xform(o.x, (o.y ?? 0) + rise / 2 - 0.1, o.z, { ry: o.ry ?? 0, rx: -ang }),
    { zone: o.zone, tile: 2.0 });
}

/** Coping stone run along a parapet. */
export function coping(b, o) {
  const p = [[-o.w / 2, 0], [o.w / 2, 0], [o.w / 2, 0.07], [o.w / 2 - 0.05, 0.12],
    [-o.w / 2 + 0.05, 0.12], [-o.w / 2, 0.07]];
  const g = profileExtrude(p, o.len, { bevel: 0.014 });
  b.geo(o.mat ?? 'concrete', g, b.xform(o.x, o.y, o.z, { ry: o.ry ?? 0 }), { zone: o.zone, tile: 1.6 });
}

/** Caged ladder — vertical circulation that reads at 40m. */
export function ladder(b, o) {
  const h = o.h, zone = o.zone;
  for (const s of [-1, 1]) {
    b.geo('metal_painted', tube([[o.x + s * 0.22, o.y, o.z], [o.x + s * 0.22, o.y + h, o.z]], 0.028, 8,
      { segLen: 4 }), null, { zone, tile: 1.0 });
  }
  const rungs = Math.floor(h / 0.3);
  for (let i = 1; i < rungs; i++) {
    b.geo('metal_painted', tube([[o.x - 0.22, o.y + i * 0.3, o.z], [o.x + 0.22, o.y + i * 0.3, o.z]],
      0.016, 5, { segLen: 2, caps: false }), null, { zone, tile: 1.0, solid: false });
  }
  // Hoop rings at 4x10 rather than 6x18. A 36mm tube seen from two metres does
  // not resolve its own cross-section, and the caged ladders in this map are the
  // single most repeated element in it — the saving pays for a guard tower.
  const hoops = Math.floor((h - 2.2) / 0.85);
  for (let i = 0; i < hoops; i++) {
    const y = o.y + 2.2 + i * 0.85;
    const g = new THREE.TorusGeometry(0.38, 0.018, 4, 10, Math.PI * 1.25);
    b.geo('metal_rusted', g, b.xform(o.x, y, o.z + 0.16, { rx: HALF_PI, ry: Math.PI * 0.125 }),
      { zone, tile: 1.0, solid: false });
  }
}

/** Tapered concrete stack — the compound's landmark on the skyline. */
export function stack(b, o) {
  const h = o.h, r0 = o.rBase, r1 = o.rTop, zone = o.zone;
  const rings = 10;
  for (let i = 0; i < rings; i++) {
    const t0 = i / rings, t1 = (i + 1) / rings;
    const g = cyl(r0 + (r1 - r0) * t1, r0 + (r1 - r0) * t0, h / rings, o.seg ?? 26, { open: true });
    b.geo(o.mat ?? 'concrete', g, b.xform(o.x, o.y + h * (t0 + t1) / 2, o.z, {}), { zone, tile: 2.4 });
    // banding
    if (i % 2 === 1) {
      const rr = r0 + (r1 - r0) * t1;
      const g2 = cyl(rr + 0.09, rr + 0.09, 0.22, o.seg ?? 26, { open: true });
      b.geo('metal_rusted', g2, b.xform(o.x, o.y + h * t1, o.z, {}), { zone, tile: 1.0 });
    }
  }
  const cap = lathe([[r1, 0], [r1 + 0.35, 0.12], [r1 + 0.35, 0.5], [r1 + 0.1, 0.62], [r1 - 0.1, 0.62]], 26);
  b.geo('metal_rusted', cap, b.xform(o.x, o.y + h, o.z, {}), { zone, tile: 1.2 });
}

/** Elevated water/process tank on braced legs. */
export function tank(b, o) {
  const zone = o.zone, r = o.r, legH = o.legH;
  const body = lathe([
    [0, 0], [r * 0.72, -0.34], [r, 0.1], [r, o.h - 0.1], [r * 0.72, o.h + 0.34], [0, o.h + 0.42],
  ], o.seg ?? 24);
  b.geo(o.mat ?? 'metal_painted', body, b.xform(o.x, o.y + legH, o.z, {}), { zone, tile: 2.2 });
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const lx = o.x + Math.cos(a) * r * 0.72, lz = o.z + Math.sin(a) * r * 0.72;
    b.geo('metal_rusted', tube([[lx, o.y, lz], [lx, o.y + legH + 0.1, lz]], 0.15, 10, { segLen: 4 }),
      null, { zone, tile: 1.2 });
    const a2 = ((i + 1) / 4) * Math.PI * 2 + Math.PI / 4;
    const nx = o.x + Math.cos(a2) * r * 0.72, nz = o.z + Math.sin(a2) * r * 0.72;
    for (const t of [0.32, 0.72]) {
      b.geo('metal_rusted', tube([[lx, o.y + legH * t, lz], [nx, o.y + legH * (t + 0.28), nz]], 0.05, 6,
        { segLen: 4 }), null, { zone, tile: 1.0 });
    }
  }
  // hoop bands + ring walkway
  for (const t of [0.28, 0.62]) {
    const g = new THREE.TorusGeometry(r + 0.03, 0.035, 6, o.seg ?? 24);
    b.geo('metal_rusted', g, b.xform(o.x, o.y + legH + o.h * t, o.z, { rx: HALF_PI }), { zone, tile: 1.0 });
  }
}

export { rng };
