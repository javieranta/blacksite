#!/usr/bin/env node
/**
 * Dump one tile of the particle sprite atlas as raw RGBA, so a sprite can be
 * inspected on its own instead of inferred from a composite that several systems
 * draw into.
 *
 * Written in round 10, after the muzzle-flash "eight-point asterisk" a review
 * called a placeholder turned out to be a quad from src/weapons/viewmodel/Flash.js
 * and not SPRITE.STAR at all. Judging a tile from the frame attributed it to the
 * wrong system, and rewriting STAR — which was also a symmetric asterisk and did
 * need replacing — changed the picture much less than expected. Reading the tile
 * off the atlas is the only way to know what a sprite actually looks like.
 *
 * The atlas is a DataTexture, so its bytes are still on the CPU in
 * `particles.atlas.image.data` and no readback from the GPU is needed.
 *
 * Usage: node tools/atlastile.mjs <tileIndex> <out.json>
 * Output: { size, px: [r,g,b,a, ...] } at 192x192. Render with Pillow, and
 * composite over a DARK background — a hot additive sprite with a soft alpha
 * skirt looks like a solid disc over white.
 */
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const tile = Number(process.argv[2] ?? 8);
const out = process.argv[3];
if (!out) {
  console.error('usage: node tools/atlastile.mjs <tileIndex> <out.json>');
  process.exit(2);
}

const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=d3d11', '--disable-gpu-sandbox', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
await page.goto('http://127.0.0.1:5180/?freeze=1&hud=0&quality=cinematic&pos=4,1.7,6&yaw=195&vm=1',
  { waitUntil: 'domcontentloaded', timeout: 300000 });
await page.waitForFunction('window.__ready === true', null, { timeout: 300000 });

const r = await page.evaluate(`(() => {
  const P = window.__blacksite.engine.systems.get('particles');
  if (!P?.atlas?.image?.data) return { error: 'no CPU-side atlas data' };
  const img = P.atlas.image;
  const S = img.width;
  const T = S / 4;
  const col = ${tile} % 4;
  const row = Math.floor(${tile} / 4);
  const ox = col * T;
  const oy = row * T;
  const outN = 192;
  const step = T / outN;
  const px = [];
  for (let y = 0; y < outN; y++) {
    for (let x = 0; x < outN; x++) {
      const sx = ox + Math.floor(x * step);
      const sy = oy + Math.floor(y * step);
      const o = (sy * S + sx) * 4;
      px.push(img.data[o], img.data[o + 1], img.data[o + 2], img.data[o + 3]);
    }
  }
  return { size: outN, tile: ${tile}, atlas: S, px };
})()`);

if (r.error) { console.error(r.error); process.exitCode = 1; } else {
  writeFileSync(out, JSON.stringify(r));
  console.log(`tile ${r.tile} of a ${r.atlas}px atlas -> ${out} (${r.size}x${r.size})`);
}
await browser.close();
