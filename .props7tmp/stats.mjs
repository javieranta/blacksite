import { chromium } from 'playwright';

const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=d3d11', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
const errs = [];
const info = [];
page.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));
page.on('console', (m) => {
  const t = m.text();
  if (m.type() === 'error') errs.push('CONSOLE ' + t.slice(0, 300));
  if (t.startsWith('[props]')) info.push(t);
});
await page.goto('http://127.0.0.1:5180/?freeze=1&hud=0&vm=0&quality=low', { waitUntil: 'domcontentloaded', timeout: 180000 });
await page.waitForFunction(() => window.__blacksite && window.__blacksite.engine, null, { timeout: 180000 });
await page.waitForTimeout(3000);
const st = await page.evaluate(() => {
  const e = window.__blacksite.engine;
  const p = e.ctx?.get?.('props');
  return p?.stats ?? null;
});
console.log('--- props console ---');
for (const l of info) console.log(l);
console.log('--- errors ---');
console.log(errs.length ? errs.slice(0, 6).join('\n') : 'none');
console.log('--- stats subset ---');
if (st) {
  const keys = ['drawMeshes', 'instances', 'triangles', 'placed', 'contactDropped',
    'floatChecked', 'floatReseated', 'floatDeleted', 'floatMergedChecked',
    'floatMergedDeleted', 'floatAnchored', 'floatGrounded', 'floatHung',
    'floatWorst', 'floatWorstLeft'];
  console.log(JSON.stringify(Object.fromEntries(keys.map((k) => [k, st[k]]))));
}
await browser.close();
