import { chromium } from 'playwright';
import fs from 'node:fs';

const [src, x, y, w, h, scale, out] = process.argv.slice(2);
const S = Number(scale) || 2;
const W = Number(w), H = Number(h);
const b64 = fs.readFileSync(src).toString('base64');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: Math.round(W * S), height: Math.round(H * S) } });
await page.setContent(`<body style="margin:0;overflow:hidden;background:#111">
<canvas id=c width=${Math.round(W * S)} height=${Math.round(H * S)}></canvas>
<script>
const i = new Image();
i.onload = () => {
  const g = document.getElementById('c').getContext('2d');
  g.imageSmoothingEnabled = false;
  g.drawImage(i, ${Number(x)}, ${Number(y)}, ${W}, ${H}, 0, 0, ${Math.round(W * S)}, ${Math.round(H * S)});
  document.title = 'READY';
};
i.onerror = () => { document.title = 'ERR'; };
i.src = 'data:image/png;base64,${b64}';
</script></body>`);
await page.waitForFunction(() => document.title === 'READY' || document.title === 'ERR', null, { timeout: 20000 });
await page.screenshot({ path: out });
await browser.close();
console.log('ok', out, await Promise.resolve('done'));
