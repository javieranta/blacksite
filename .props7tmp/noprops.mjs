import { chromium } from 'playwright';

// Shoot a view with all prop: meshes hidden, to attribute floating geometry.
// usage: node noprops.mjs <name> <tod> <pos> <yaw> <pitch> <out.png> [keep]
const [name, tod, pos, yaw, pitch, out, keep] = process.argv.slice(2);
const W = 1920, H = 1080;
const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=d3d11', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox'],
});
const page = await browser.newPage({ viewport: { width: W, height: H } });
const url = `http://127.0.0.1:5180/?freeze=1&hud=0&vm=0&quality=cinematic&tod=${tod}`
  + `&pos=${pos}&yaw=${yaw}&pitch=${pitch}`;
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForFunction(() => window.__blacksite && window.__blacksite.engine, null, { timeout: 90000 });
await page.waitForTimeout(4000);
if (keep !== 'keep') {
  const n = await page.evaluate(() => {
    let n = 0;
    window.__blacksite.scene.traverse((o) => {
      if (o.name && o.name.startsWith('prop:')) { o.visible = false; n++; }
    });
    return n;
  });
  console.log('hidden prop meshes:', n);
}
await page.waitForTimeout(1200);
await page.screenshot({ path: out });
await browser.close();
console.log('wrote', out, name);
