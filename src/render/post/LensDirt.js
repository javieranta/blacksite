import * as THREE from 'three';

/**
 * OWNER: postfx agent.
 *
 * Procedural lens-dirt mask, drawn with canvas 2D. Zero external assets.
 *
 * The mask is mostly black — dirt only becomes visible where the bloom buffer
 * is bright, which is how a real dirty front element behaves: you never notice
 * it until something blows out behind it. A dirt texture that is visible all
 * the time is the classic 2012 mistake and reads as a filter, not as glass.
 */

/** Deterministic PRNG so the same smudge pattern ships every run. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function buildLensDirt(size = 512, seed = 0x51ce) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const g = canvas.getContext('2d');
  const rnd = mulberry32(seed);

  g.fillStyle = '#000000';
  g.fillRect(0, 0, size, size);
  g.globalCompositeOperation = 'lighter';

  // --- Broad greasy smudges: low frequency, low amplitude, edge-biased -------
  for (let i = 0; i < 26; i++) {
    // Bias toward the frame edges — the centre of a lens gets wiped.
    const ang = rnd() * Math.PI * 2;
    const rad = (0.22 + rnd() * 0.78) * size * 0.5;
    const x = size * 0.5 + Math.cos(ang) * rad;
    const y = size * 0.5 + Math.sin(ang) * rad;
    const r = size * (0.035 + rnd() * 0.13);
    const grd = g.createRadialGradient(x, y, 0, x, y, r);
    const a = 0.05 + rnd() * 0.16;
    grd.addColorStop(0, `rgba(255,252,244,${a})`);
    grd.addColorStop(0.45, `rgba(220,228,255,${a * 0.42})`);
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd;
    g.beginPath();
    g.ellipse(x, y, r, r * (0.55 + rnd() * 0.9), rnd() * Math.PI, 0, Math.PI * 2);
    g.fill();
  }

  // --- Fine dust specks -----------------------------------------------------
  for (let i = 0; i < 900; i++) {
    const x = rnd() * size;
    const y = rnd() * size;
    const r = 0.5 + rnd() * 2.4;
    const a = 0.10 + rnd() * 0.55;
    const grd = g.createRadialGradient(x, y, 0, x, y, r * 2.6);
    grd.addColorStop(0, `rgba(255,255,255,${a})`);
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd;
    g.beginPath();
    g.arc(x, y, r * 2.6, 0, Math.PI * 2);
    g.fill();
  }

  // --- Cleaning-cloth scratches: thin arcs, faint, mildly iridescent ---------
  for (let i = 0; i < 34; i++) {
    const x0 = rnd() * size;
    const y0 = rnd() * size;
    const len = size * (0.06 + rnd() * 0.34);
    const ang = rnd() * Math.PI * 2;
    const bow = (rnd() - 0.5) * len * 0.5;
    const a = 0.035 + rnd() * 0.10;
    const hue = 190 + rnd() * 70;
    g.strokeStyle = `hsla(${hue}, 45%, 88%, ${a})`;
    g.lineWidth = 0.6 + rnd() * 1.7;
    g.beginPath();
    g.moveTo(x0, y0);
    g.quadraticCurveTo(
      x0 + Math.cos(ang) * len * 0.5 - Math.sin(ang) * bow,
      y0 + Math.sin(ang) * len * 0.5 + Math.cos(ang) * bow,
      x0 + Math.cos(ang) * len,
      y0 + Math.sin(ang) * len,
    );
    g.stroke();
  }

  // --- A handful of larger droplet rings ------------------------------------
  for (let i = 0; i < 9; i++) {
    const x = rnd() * size;
    const y = rnd() * size;
    const r = size * (0.012 + rnd() * 0.035);
    const a = 0.06 + rnd() * 0.14;
    g.strokeStyle = `rgba(238,244,255,${a})`;
    g.lineWidth = 1 + rnd() * 2.5;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.stroke();
    const grd = g.createRadialGradient(x, y, 0, x, y, r);
    grd.addColorStop(0, `rgba(255,255,255,${a * 0.35})`);
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  }

  g.globalCompositeOperation = 'source-over';

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.colorSpace = THREE.NoColorSpace;
  tex.anisotropy = 1;
  tex.name = 'PostFX.LensDirt';
  tex.needsUpdate = true;
  return tex;
}
