import * as THREE from 'three';
import {
  bevelBox, box, cyl, xf, mergeAll, boxUV, boxUV01, warp, seatGroup, atlasRemap,
} from '../GeoUtil.js';
import { CRATE } from '../Atlas.js';

/**
 * Derelict vehicles. OWNER: props agent.
 *
 * Two silhouettes — a flatbed pickup and a box van — assembled from chamfered
 * volumes so the light breaks across the panels. They are stripped, sagging and
 * missing glass, which is both cheaper and more honest than trying to model a
 * showroom car in code.
 *
 * Each returns geometry grouped by material:
 *   { body, dark, glass, rubber }
 */

function wheel(rng, R = 0.36, W = 0.24, flat = false) {
  const rubber = [];
  const dark = [];
  const tread = new THREE.TorusGeometry(R * 0.8, R * 0.28, 8, 16);
  if (flat) {
    const p = tread.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const y = p.getY(i);
      if (y < -R * 0.6) p.setY(i, -R * 0.6);
    }
    p.needsUpdate = true;
    tread.computeVertexNormals();
  }
  // The torus already lies in XY with its axle along Z, which is the axis the
  // vehicle wants (bodies run along X), so nothing needs rotating but the
  // cylinders, which are born pointing up.
  boxUV(tread, 2.2);
  rubber.push(tread);
  const hub = cyl(R * 0.52, R * 0.52, W * 0.9, 12);
  xf(hub, 0, 0, 0, Math.PI / 2, 0, 0);
  boxUV(hub, 2);
  dark.push(hub);
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    const nut = cyl(0.02, 0.02, W * 1.02, 6);
    xf(nut, Math.cos(a) * R * 0.3, Math.sin(a) * R * 0.3, 0, Math.PI / 2, 0, 0);
    boxUV(nut, 3);
    dark.push(nut);
  }
  void rng;
  return { rubber: mergeAll(rubber), dark: mergeAll(dark) };
}

/** Flatbed / utility pickup, doors gone, one wheel flat. */
export function derelictPickup(rng) {
  const body = [];
  const dark = [];
  const glass = [];
  const rubber = [];
  const L = 5.0, W = 1.95, wheelR = 0.37;
  const chassisY = wheelR * 0.95;

  // chassis rails
  for (const s of [-1, 1]) {
    const rail = box(L * 0.92, 0.12, 0.11);
    xf(rail, 0, chassisY - 0.18, s * W * 0.3);
    boxUV(rail, 1.6);
    dark.push(rail);
  }
  // cab
  const cabL = 1.5;
  const cab = bevelBox(cabL, 1.0, W * 0.94, 0.05, 2);
  xf(cab, -L * 0.1, chassisY + 0.62, 0);
  boxUV(cab, 0.75);
  body.push(cab);
  // roof, slightly caved
  const roof = bevelBox(cabL * 0.98, 0.07, W * 0.9, 0.03);
  xf(roof, -L * 0.1, chassisY + 1.11, 0, 0.015, 0, 0.02);
  boxUV(roof, 0.9);
  body.push(roof);
  // bonnet + wing
  const bonnet = bevelBox(1.5, 0.42, W * 0.92, 0.05, 2);
  xf(bonnet, -L * 0.1 - cabL / 2 - 0.75, chassisY + 0.34, 0, -0.03, 0, 0);
  boxUV(bonnet, 0.8);
  body.push(bonnet);
  // grille + bumper
  const grille = box(0.09, 0.34, W * 0.8);
  xf(grille, -L * 0.1 - cabL / 2 - 1.5, chassisY + 0.3, 0);
  boxUV(grille, 2.2);
  dark.push(grille);
  const bumper = bevelBox(0.16, 0.2, W * 1.0, 0.04);
  xf(bumper, -L * 0.1 - cabL / 2 - 1.55, chassisY - 0.02, 0);
  boxUV(bumper, 1.8);
  dark.push(bumper);
  // flat bed
  const bedL = 2.3;
  const bedX = -L * 0.1 + cabL / 2 + bedL / 2 - 0.05;
  const bedFloor = bevelBox(bedL, 0.1, W * 0.96, 0.02);
  xf(bedFloor, bedX, chassisY + 0.16, 0);
  boxUV(bedFloor, 1.0);
  body.push(bedFloor);
  for (const s of [-1, 1]) {
    const side = bevelBox(bedL, 0.46, 0.08, 0.02);
    xf(side, bedX, chassisY + 0.42, s * W * 0.46);
    boxUV(side, 1.2);
    body.push(side);
  }
  const tail = bevelBox(0.08, 0.44, W * 0.94, 0.02);
  xf(tail, bedX + bedL / 2, chassisY + 0.4, 0, 0, 0, rng.bool(0.5) ? 0 : -1.1);
  boxUV(tail, 1.4);
  body.push(tail);
  // roll bar
  if (rng.bool(0.6)) {
    for (const s of [-1, 1]) {
      const up = cyl(0.035, 0.035, 0.8, 8);
      xf(up, bedX - bedL * 0.42, chassisY + 0.75, s * W * 0.36);
      boxUV(up, 2);
      dark.push(up);
    }
    const cross = cyl(0.035, 0.035, W * 0.74, 8);
    xf(cross, bedX - bedL * 0.42, chassisY + 1.14, 0, Math.PI / 2, 0, 0);
    boxUV(cross, 2);
    dark.push(cross);
  }
  // wheel arches
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const arch = new THREE.TorusGeometry(wheelR * 1.15, 0.05, 5, 12, Math.PI);
      xf(arch, sx > 0 ? bedX - bedL * 0.1 : -L * 0.1 - cabL / 2 - 0.6, chassisY + 0.06, sz * W * 0.47);
      boxUV(arch, 2);
      body.push(arch);
    }
  }
  // windscreen frame + shattered glass remnant
  const wsF = box(0.07, 0.72, W * 0.9);
  xf(wsF, -L * 0.1 - cabL / 2 + 0.05, chassisY + 0.78, 0, 0, 0, 0.28);
  boxUV(wsF, 1.6);
  dark.push(wsF);
  if (rng.bool(0.5)) {
    const ws = new THREE.PlaneGeometry(W * 0.82, 0.62);
    xf(ws, -L * 0.1 - cabL / 2 + 0.08, chassisY + 0.78, 0, 0, Math.PI / 2, 0.28);
    boxUV01(ws);
    glass.push(ws);
  }
  // side window openings framed by pillars
  for (const s of [-1, 1]) {
    const pillar = box(0.08, 0.5, 0.09);
    xf(pillar, -L * 0.1 + cabL * 0.42, chassisY + 0.85, s * W * 0.46);
    boxUV(pillar, 2);
    body.push(pillar);
  }
  // wheels (one flat)
  const flatIndex = rng.int(0, 3);
  let wi = 0;
  for (const ax of [-L * 0.1 - cabL / 2 - 0.6, bedX - bedL * 0.1]) {
    for (const sz of [-1, 1]) {
      const w = wheel(rng, wheelR, 0.26, wi === flatIndex);
      const dy = wi === flatIndex ? -0.06 : 0;
      xf(w.rubber, ax, wheelR + dy, sz * W * 0.5);
      xf(w.dark, ax, wheelR + dy, sz * W * 0.5);
      rubber.push(w.rubber);
      dark.push(w.dark);
      wi++;
    }
  }

  const b = mergeAll(body);
  warp(b, 0.012, 1.6, rng.int(1, 9999));
  return seatGroup({
    body: b, dark: mergeAll(dark), glass: mergeAll(glass), rubber: mergeAll(rubber),
  });
}

/** Box van / light truck. Big flat sides are a gift for signage and graffiti. */
export function derelictVan(rng) {
  const body = [];
  const dark = [];
  const glass = [];
  const rubber = [];
  const L = 5.8, W = 2.1, H = 2.5, wheelR = 0.40;
  const chassisY = wheelR * 0.95;

  const cabL = 1.6;
  const cab = bevelBox(cabL, 1.45, W * 0.96, 0.055, 2);
  xf(cab, -L / 2 + cabL / 2, chassisY + 0.78, 0);
  boxUV(cab, 0.7);
  body.push(cab);

  const boxL = L - cabL - 0.1;
  const cargo = bevelBox(boxL, H - 0.5, W, 0.05, 2);
  xf(cargo, -L / 2 + cabL + boxL / 2 + 0.05, chassisY + (H - 0.5) / 2 + 0.25, 0);
  boxUV(cargo, 0.55);
  body.push(cargo);

  // corrugation ribs on the box sides
  const ribs = Math.round(boxL / 0.42);
  for (let i = 0; i < ribs; i++) {
    const t = -L / 2 + cabL + 0.2 + i * (boxL / ribs);
    for (const s of [-1, 1]) {
      const r = box(0.05, H - 0.7, 0.03);
      xf(r, t, chassisY + (H - 0.5) / 2 + 0.25, s * (W / 2 + 0.014));
      boxUV(r, 2.2);
      body.push(r);
    }
  }
  // roof cap + rain gutter
  const roof = bevelBox(boxL * 1.01, 0.08, W * 1.02, 0.025);
  xf(roof, -L / 2 + cabL + boxL / 2 + 0.05, chassisY + H - 0.21, 0);
  boxUV(roof, 0.8);
  body.push(roof);
  // rear doors + hinges
  const rearX = -L / 2 + cabL + boxL + 0.05;
  for (const s of [-1, 1]) {
    const openAngle = s > 0 ? rng.range(0, 1.1) : rng.range(-0.2, 0.1);
    const door = bevelBox(0.07, H - 0.62, W * 0.48, 0.02);
    xf(door, rearX, chassisY + (H - 0.5) / 2 + 0.25, s * W * 0.25);
    if (openAngle !== 0) {
      const pivot = new THREE.Matrix4()
        .makeTranslation(rearX, 0, s * W * 0.5)
        .multiply(new THREE.Matrix4().makeRotationY(-s * openAngle))
        .multiply(new THREE.Matrix4().makeTranslation(-rearX, 0, -s * W * 0.5));
      door.applyMatrix4(pivot);
    }
    boxUV(door, 1.1);
    body.push(door);
    const hinge = cyl(0.028, 0.028, H - 0.8, 6);
    xf(hinge, rearX + 0.03, chassisY + (H - 0.5) / 2 + 0.25, s * W * 0.49);
    boxUV(hinge, 2);
    dark.push(hinge);
  }
  // bonnet, grille, bumper
  const bonnet = bevelBox(0.75, 0.4, W * 0.92, 0.05, 2);
  xf(bonnet, -L / 2 - 0.25, chassisY + 0.42, 0, -0.06, 0, 0);
  boxUV(bonnet, 0.9);
  body.push(bonnet);
  const grille = box(0.08, 0.42, W * 0.78);
  xf(grille, -L / 2 - 0.6, chassisY + 0.38, 0);
  boxUV(grille, 2.2);
  dark.push(grille);
  const bumper = bevelBox(0.18, 0.22, W * 1.02, 0.04);
  xf(bumper, -L / 2 - 0.62, chassisY + 0.02, 0);
  boxUV(bumper, 1.8);
  dark.push(bumper);
  // windscreen + door windows (mostly gone)
  const wsFrame = box(0.08, 0.8, W * 0.92);
  xf(wsFrame, -L / 2 + 0.1, chassisY + 1.12, 0, 0, 0, 0.22);
  boxUV(wsFrame, 1.6);
  dark.push(wsFrame);
  if (rng.bool(0.45)) {
    const ws = new THREE.PlaneGeometry(W * 0.84, 0.7);
    xf(ws, -L / 2 + 0.13, chassisY + 1.12, 0, 0, Math.PI / 2, 0.22);
    boxUV01(ws);
    glass.push(ws);
  }
  // mirror arms
  for (const s of [-1, 1]) {
    const arm = cyl(0.018, 0.018, 0.26, 6);
    xf(arm, -L / 2 + 0.35, chassisY + 1.25, s * (W / 2 + 0.1), 0, 0, Math.PI / 2);
    boxUV(arm, 3);
    dark.push(arm);
    const face = box(0.03, 0.2, 0.12);
    xf(face, -L / 2 + 0.35, chassisY + 1.2, s * (W / 2 + 0.22));
    boxUV(face, 3);
    dark.push(face);
  }
  // stencil panel on the box side (uses the container atlas white-plastic cell)
  for (const s of [-1, 1]) {
    const plate = new THREE.PlaneGeometry(boxL * 0.34, (H - 0.5) * 0.3);
    xf(plate, -L / 2 + cabL + boxL * 0.4, chassisY + (H - 0.5) * 0.62, s * (W / 2 + 0.03), 0, s > 0 ? 0 : Math.PI, 0);
    atlasRemap(boxUV01(plate), CRATE.whitePlastic[0], CRATE.whitePlastic[1], 4, 4);
    body.push(plate);
  }
  // wheels — rear axle doubled
  const axles = [-L / 2 + 0.9, -L / 2 + cabL + boxL * 0.62];
  let wi = 0;
  const flatIndex = rng.int(0, 5);
  for (let a = 0; a < axles.length; a++) {
    for (const sz of [-1, 1]) {
      const twin = a === 1 ? [0, 0.24] : [0];
      for (const off of twin) {
        const w = wheel(rng, wheelR, 0.24, wi === flatIndex);
        const dy = wi === flatIndex ? -0.07 : 0;
        xf(w.rubber, axles[a], wheelR + dy, sz * (W * 0.45 - off));
        xf(w.dark, axles[a], wheelR + dy, sz * (W * 0.45 - off));
        rubber.push(w.rubber);
        dark.push(w.dark);
        wi++;
      }
    }
  }

  const b = mergeAll(body);
  warp(b, 0.014, 1.4, rng.int(1, 9999));
  return seatGroup({
    body: b, dark: mergeAll(dark), glass: mergeAll(glass), rubber: mergeAll(rubber),
  });
}
