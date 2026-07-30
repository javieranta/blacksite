import { chromium } from 'playwright';

// Pick objects under given screen pixels for a given view.
// usage: node pick.mjs "<tod>" "<pos>" <yaw> <pitch> "x1,y1;x2,y2;..."
const [tod, pos, yaw, pitch, pts] = process.argv.slice(2);
const W = 1920, H = 1080;

const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=d3d11', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox'],
});
const page = await browser.newPage({ viewport: { width: W, height: H } });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
const url = `http://127.0.0.1:5180/?freeze=1&hud=0&vm=0&quality=cinematic&tod=${tod}`
  + `&pos=${pos}&yaw=${yaw}&pitch=${pitch}`;
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForFunction(() => window.__blacksite && window.__blacksite.engine, null, { timeout: 90000 });
await page.waitForTimeout(4000);

const res = await page.evaluate(async ({ pts, W, H }) => {
  const THREE = window.__blacksite.engine.THREE ?? (await import('/node_modules/three/build/three.module.js'));
  const cam = window.__blacksite.camera;
  const scene = window.__blacksite.scene;
  cam.updateMatrixWorld(true);
  const rc = new THREE.Raycaster();
  rc.far = 400;
  const out = [];
  for (const p of pts.split(';')) {
    const [px, py] = p.split(',').map(Number);
    const ndc = new THREE.Vector2((px / W) * 2 - 1, -(py / H) * 2 + 1);
    rc.setFromCamera(ndc, cam);
    const hits = rc.intersectObject(scene, true).filter((h) => h.object.visible);
    const first = hits.slice(0, 4).map((h) => ({
      name: h.object.name || h.object.type,
      inst: h.instanceId ?? null,
      dist: +h.distance.toFixed(2),
      pt: [+h.point.x.toFixed(2), +h.point.y.toFixed(2), +h.point.z.toFixed(2)],
    }));
    out.push({ px, py, first });
  }
  return out;
}, { pts, W, H });

console.log(JSON.stringify(res, null, 1));
console.log('errors', errs.slice(0, 3));
await browser.close();
