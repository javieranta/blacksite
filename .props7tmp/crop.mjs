import { chromium } from 'playwright';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [src, x, y, w, h, scale, out] = process.argv.slice(2);
const S = Number(scale) || 2;
const W = Number(w), H = Number(h);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: W * S, height: H * S } });
const url = pathToFileURL(path.resolve(src)).href;
await page.setContent(`<body style="margin:0;overflow:hidden;background:#000">
<img src="${url}" style="position:absolute;left:${-Number(x) * S}px;top:${-Number(y) * S}px;width:${1920 * S}px">
</body>`);
await page.waitForTimeout(700);
await page.screenshot({ path: out });
await browser.close();
console.log('ok', out);
