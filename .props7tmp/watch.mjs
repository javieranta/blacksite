import { chromium } from 'playwright';

const secs = Number(process.argv[2] ?? 60);
const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=d3d11', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
page.on('console', (m) => {
  const t = m.text();
  if (m.type() === 'error' || t.startsWith('[props]') || t.startsWith('[level]') || t.startsWith('[boot]')) {
    console.log(m.type().toUpperCase(), t.slice(0, 400));
  }
});
const t0 = Date.now();
await page.goto('http://127.0.0.1:5180/?freeze=1&hud=0&vm=0&quality=low', { waitUntil: 'domcontentloaded', timeout: 120000 });
try {
  await page.waitForFunction(() => window.__blacksite, null, { timeout: secs * 1000 });
  console.log('READY after', ((Date.now() - t0) / 1000).toFixed(1), 's');
  await page.waitForTimeout(2500);
  const st = await page.evaluate(() => {
    try {
      const p = window.__blacksite.engine.ctx?.get?.('props');
      if (!p) return { err: 'no props system' };
      const keys = ['drawMeshes', 'instances', 'triangles', 'placed', 'contactDropped',
        'floatChecked', 'floatReseated', 'floatDeleted', 'floatMergedChecked',
        'floatMergedDeleted', 'floatAnchored', 'floatGrounded', 'floatHung',
        'floatWorst', 'floatWorstLeft'];
      const o = p.stats ? Object.fromEntries(keys.map((k) => [k, p.stats[k]])) : {};
      o.buildMs = Math.round(p.buildMs ?? -1);
      return o;
    } catch (e) { return { err: String(e) }; }
  });
  console.log('STATS', JSON.stringify(st));
} catch (e) {
  console.log('NOT READY after', secs, 's');
  const txt = await page.evaluate(() => document.body?.innerText?.slice(0, 300) ?? '');
  console.log('DOM:', txt.replace(/\n/g, ' | '));
}
await browser.close();
