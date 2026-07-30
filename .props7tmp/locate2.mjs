import { chromium } from 'playwright';

const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=d3d11', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
await page.goto('http://127.0.0.1:5180/?freeze=1&hud=0&vm=0&quality=low', { waitUntil: 'domcontentloaded', timeout: 180000 });
await page.waitForFunction(() => window.__blacksite, null, { timeout: 180000 });
await page.waitForTimeout(2500);
const out = await page.evaluate(() => {
  const pts = [];
  window.__blacksite.scene.traverse((o) => {
    if (!o.isInstancedMesh || !o.name.startsWith('prop:sandbag')) return;
    const m = new (window.__blacksite.camera.matrixWorld.constructor)();
    for (let i = 0; i < o.count; i++) {
      o.getMatrixAt(i, m);
      pts.push([m.elements[12], m.elements[13], m.elements[14]]);
    }
  });
  // grid-bucket by 2m cells, report densest buckets
  const g = new Map();
  for (const p of pts) {
    const k = `${Math.round(p[0] / 2)},${Math.round(p[2] / 2)}`;
    const c = g.get(k) ?? { n: 0, x: 0, y: 0, z: 0 };
    c.n++; c.x += p[0]; c.y += p[1]; c.z += p[2];
    g.set(k, c);
  }
  return [...g.values()].map((c) => ({
    n: c.n, x: +(c.x / c.n).toFixed(2), y: +(c.y / c.n).toFixed(2), z: +(c.z / c.n).toFixed(2),
  })).sort((a, b) => b.n - a.n).slice(0, 10);
});
console.log(JSON.stringify(out));
await browser.close();
