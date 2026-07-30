import { chromium } from 'playwright';

// usage: node shot.mjs <tod> <pos> <yawDeg> <pitch> <out.png> [w] [h]
const [tod, pos, yaw, pitch, out, w, h] = process.argv.slice(2);
const W = Number(w) || 1920, H = Number(h) || 1080;
const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=d3d11', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox'],
});
const page = await browser.newPage({ viewport: { width: W, height: H } });
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text().slice(0, 200)); });
const url = `http://127.0.0.1:5180/?freeze=1&hud=0&vm=0&quality=cinematic&tod=${tod}`
  + `&pos=${pos}&yaw=${yaw}&pitch=${pitch}`;
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForFunction(() => window.__blacksite && window.__blacksite.engine, null, { timeout: 180000 });
await page.waitForTimeout(4500);
await page.waitForFunction(() => {
  const el = document.querySelector('#loading, .loading, #boot');
  return !el || el.style.display === 'none' || el.hidden || getComputedStyle(el).opacity === '0';
}, null, { timeout: 60000 }).catch(() => {});
await page.waitForTimeout(1500);
await page.screenshot({ path: out });
await browser.close();
console.log('wrote', out, 'errors:', errs.length ? errs.slice(0, 4) : 'none');
