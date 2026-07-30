import * as THREE from 'three';

/**
 * WORLD SCAN for the seat pass. OWNER: props agent.
 *
 * Split out of LevelSeat.js when that file crossed 700 lines. The reasoning for
 * the pass itself lives there and should be read first; this file holds the two
 * pieces that are pure geometry and have no policy in them:
 *
 *   sceneMeshes()   which meshes in the finished scene graph are world geometry
 *   triangleWalker() a deterministic walk over every world-space triangle inside
 *                    the play envelope, instances expanded
 *   closestOnTri()  point-to-triangle closest point, the primitive the whole
 *                   measurement rests on
 *
 * The walk order is deterministic — meshes in scene order, instances in index
 * order, faces in index order — and every pass relies on that: it is what lets
 * the first sweep memoise each triangle's island by ordinal and the later ones
 * skip the cell lookup entirely.
 */

/**
 * Camera-locked shells and per-frame effects. A muzzle-flash card IS a
 * panel-shaped quad hanging in mid-air with daylight all round it, and round 9's
 * audit duly ranked one as its worst offender. Tested against the whole ancestor
 * chain because FX cards are anonymous children of a named group.
 */
/*
 * `prop:decal`, `prop:grime` and `prop:wet` are the three merged GROUND-MARK
 * batches, and they must never be seated. Each is a single mesh holding two to
 * four thousand independent quads that were already judged one at a time,
 * against the world BVH, before they were welded (GroundDress.seatQuads and
 * Grime.seatSoft). This pass sees a connected island of two triangles lying flat
 * with air beside it — a mark that legitimately overhangs a 15 cm kerb — decides
 * it is floating, and sinks it BELOW the floor, where depth test removes it.
 * Measured: it moved a 3.3 m mottle quad down 0.39 m on the first build after
 * the grime layer landed. The colon in the old `decal:` alternative never
 * matched these names, so they had been in scope all along.
 */
const SKIP = /sky|cloud|star|moon|sun|aurora|volumetric|debug|helper|gizmo|impact|tracer|muzzle|decal:|particle|prop:(decal|grime|wet)/i;

const _v = new THREE.Vector3();

/** Closest point on a triangle to a point. Ericson, RTCD 5.1.5. No allocation. */
export function closestOnTri(px, py, pz, v, out) {
  const ax = v[0], ay = v[1], az = v[2];
  const bx = v[3], by = v[4], bz = v[5];
  const cx = v[6], cy = v[7], cz = v[8];
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  let qx, qy, qz;
  if (d1 <= 0 && d2 <= 0) { qx = ax; qy = ay; qz = az; } else {
    const bpx = px - bx, bpy = py - by, bpz = pz - bz;
    const d3 = abx * bpx + aby * bpy + abz * bpz;
    const d4 = acx * bpx + acy * bpy + acz * bpz;
    if (d3 >= 0 && d4 <= d3) { qx = bx; qy = by; qz = bz; } else {
      const vc = d1 * d4 - d3 * d2;
      if (vc <= 0 && d1 >= 0 && d3 <= 0) {
        const t = d1 / (d1 - d3);
        qx = ax + abx * t; qy = ay + aby * t; qz = az + abz * t;
      } else {
        const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
        const d5 = abx * cpx + aby * cpy + abz * cpz;
        const d6 = acx * cpx + acy * cpy + acz * cpz;
        if (d6 >= 0 && d5 <= d6) { qx = cx; qy = cy; qz = cz; } else {
          const vb = d5 * d2 - d1 * d6;
          if (vb <= 0 && d2 >= 0 && d6 <= 0) {
            const t = d2 / (d2 - d6);
            qx = ax + acx * t; qy = ay + acy * t; qz = az + acz * t;
          } else {
            const va = d3 * d6 - d5 * d4;
            if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
              const t = (d4 - d3) / ((d4 - d3) + (d5 - d6));
              qx = bx + (cx - bx) * t; qy = by + (cy - by) * t; qz = bz + (cz - bz) * t;
            } else {
              const den = 1 / (va + vb + vc);
              const vv = vb * den, ww = vc * den;
              qx = ax + abx * vv + acx * ww;
              qy = ay + aby * vv + acy * ww;
              qz = az + abz * vv + acz * ww;
            }
          }
        }
      }
    }
  }
  out.set(qx, qy, qz);
  const dx = px - qx, dy = py - qy, dz = pz - qz;
  return dx * dx + dy * dy + dz * dz;
}

/** Every mesh in the finished scene that is world geometry. */
export function sceneMeshes(scene) {
  const out = [];
  scene.traverseVisible((n) => {
    if (!(n.isMesh || n.isInstancedMesh)) return;
    if (!n.geometry?.attributes?.position) return;
    for (let p = n; p; p = p.parent) if (SKIP.test(p.name || '')) return;
    out.push(n);
  });
  return out;
}

/**
 * Walk every world-space triangle inside the envelope.
 *
 * The visit order is deterministic — meshes in scene order, instances in index
 * order, faces in index order — which is what lets pass A memoise each
 * triangle's island by ordinal and the later passes skip the cell lookup.
 */
export function triangleWalker(meshes, envelope) {
  const V = new Float64Array(9);
  return (fn) => {
    for (let mi = 0; mi < meshes.length; mi++) {
      const mesh = meshes[mi];
      mesh.updateMatrixWorld(true);
      const geo = mesh.geometry;
      const pos = geo.attributes.position;
      const idx = geo.index;
      const count = idx ? idx.count : pos.count;
      const insts = mesh.isInstancedMesh ? mesh.count : 1;
      const im = new THREE.Matrix4();
      for (let ni = 0; ni < insts; ni++) {
        if (mesh.isInstancedMesh) {
          mesh.getMatrixAt(ni, im);
          im.premultiply(mesh.matrixWorld);
        } else im.copy(mesh.matrixWorld);
        for (let f = 0; f + 2 < count; f += 3) {
          let loY = Infinity, hiY = -Infinity, loX = Infinity, hiX = -Infinity;
          let loZ = Infinity, hiZ = -Infinity;
          for (let k = 0; k < 3; k++) {
            const vi = idx ? idx.getX(f + k) : f + k;
            _v.fromBufferAttribute(pos, vi).applyMatrix4(im);
            V[k * 3] = _v.x; V[k * 3 + 1] = _v.y; V[k * 3 + 2] = _v.z;
            if (_v.y < loY) loY = _v.y; if (_v.y > hiY) hiY = _v.y;
            if (_v.x < loX) loX = _v.x; if (_v.x > hiX) hiX = _v.x;
            if (_v.z < loZ) loZ = _v.z; if (_v.z > hiZ) hiZ = _v.z;
          }
          if (hiY < -2 || loY > envelope.yMax + 4) continue;
          if (loX > envelope.xz || hiX < -envelope.xz) continue;
          if (loZ > envelope.xz || hiZ < -envelope.xz) continue;
          fn(V, mi, ni, f, loX, hiX, loY, hiY, loZ, hiZ);
        }
      }
    }
  };
}

