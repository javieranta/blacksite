import { chromium } from 'playwright';
import fs from 'node:fs';

const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=d3d11', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
await page.goto('http://127.0.0.1:5180/?freeze=1&hud=0&vm=0&quality=low', { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForFunction(() => window.__blacksite && window.__blacksite.engine, null, { timeout: 60000 });
await page.waitForTimeout(3000);

const out = await page.evaluate(() => {
  const e = window.__blacksite.engine;
  const props = e.ctx?.get?.('props') ?? e.systems?.get?.('props');
  if (!props) return { err: 'no props', keys: Object.keys(e) };
  const log = props.floats?.log ?? [];
  return { n: log.length, log, stats: props.stats };
});
fs.writeFileSync('.props7tmp/floatdump.json', JSON.stringify(out, null, 1));
console.log('errors:', errs.slice(0, 5));
console.log('entries:', out.n ?? out.err);
await browser.close();
