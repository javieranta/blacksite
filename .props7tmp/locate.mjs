import { chromium } from 'playwright';

// Report clusters of a given prop key so a camera can be aimed at them.
const key = process.argv[2] ?? 'sandbag';
const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=d3d11', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
await page.goto('http://127.0.0.1:5180/?freeze=1&hud=0&vm=0&quality=low', { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForFunction(() => window.__blacksite && window.__blacksite.engine, null, { timeout: 90000 });
await page.waitForTimeout(3000);
const out = await page.evaluate((key) => {
  const pts = [];
  window.__blacksite.scene.traverse((o) => {
    if (!o.isInstancedMesh || !o.name.startsWith(`prop:${key}`)) return;
    const m = new (o.matrixWorld.constructor)();
    for (let i = 0; i < o.count; i++) {
      o.getMatrixAt(i, m);
      pts.push([+m.elements[12].toFixed(2), +m.elements[13].toFixed(2), +m.elements[14].toFixed(2)]);
    }
  });
  // crude clustering
  const cl = [];
  for (const p of pts) {
    let f = null;
    for (const c of cl) if (Math.hypot(c.x / c.n - p[0], c.z / c.n - p[2]) < 3.2) { f = c; break; }
    if (!f) { f = { x: 0, y: 0, z: 0, n: 0 }; cl.push(f); }
    f.x += p[0]; f.y += p[1]; f.z += p[2]; f.n++;
  }
  return cl.map((c) => ({ n: c.n, x: +(c.x / c.n).toFixed(2), y: +(c.y / c.n).toFixed(2), z: +(c.z / c.n).toFixed(2) }))
    .sort((a, b) => b.n - a.n).slice(0, 12);
}, key);
console.log(JSON.stringify(out));
await browser.close();
