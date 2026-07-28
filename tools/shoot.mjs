#!/usr/bin/env node
/**
 * Screenshot rig. Drives the running dev server headlessly through
 * window.__blacksite and captures canonical framings into tools/out/shots/.
 * These PNGs are what the visual critic agents grade.
 *
 * Usage:
 *   node tools/shoot.mjs                       # all views
 *   node tools/shoot.mjs --views hero,ads      # a subset
 *   node tools/shoot.mjs --tag round3          # writes to out/shots/round3/
 *   node tools/shoot.mjs --list
 *
 * Uses real GPU rasterisation via ANGLE/D3D11 — SwiftShader softlights the
 * image and would make critique meaningless.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

/**
 * Each view is a deliberate composition, chosen to stress a different part of
 * the renderer. Keep them stable across rounds so critics can compare like for
 * like between iterations.
 */
export const VIEWS = [
  // pos = "x,y,z" (eye height ~1.62), yaw degrees (0 = -Z), pitch radians
  { name: 'hero-golden',      tod: 'golden',  pos: '6,1.7,14',    yaw: 200, pitch: -0.04, note: 'establishing shot, long sightline, sun in frame' },
  { name: 'hero-midday',      tod: 'midday',  pos: '6,1.7,14',    yaw: 200, pitch: -0.04, note: 'same framing, harsh light — shadow + AO quality' },
  { name: 'hero-dusk',        tod: 'dusk',    pos: '6,1.7,14',    yaw: 200, pitch: -0.04, note: 'same framing, low light — bloom + volumetrics' },
  { name: 'hero-overcast',    tod: 'overcast',pos: '6,1.7,14',    yaw: 200, pitch: -0.04, note: 'flat light — exposes weak albedo + missing AO' },
  { name: 'interior',         tod: 'midday',  pos: '-8,1.7,-4',   yaw: 90,  pitch: 0.0,   note: 'indoor, light shafts through openings' },
  { name: 'material-closeup', tod: 'golden',  pos: '2,1.4,3',     yaw: 180, pitch: -0.25, note: 'close surface detail — texel density + normals' },
  { name: 'viewmodel-hip',    tod: 'golden',  pos: '6,1.7,14',    yaw: 200, pitch: -0.02, vm: 1, note: 'weapon in hipfire pose' },
  { name: 'viewmodel-ads',    tod: 'golden',  pos: '6,1.7,14',    yaw: 200, pitch: -0.02, vm: 1, ads: 1, note: 'sight alignment + DoF' },
  { name: 'silhouette-dusk',  tod: 'dusk',    pos: '20,1.7,0',    yaw: 270, pitch: 0.02,  note: 'backlit — rim light + atmospheric depth' },
  { name: 'vertical',         tod: 'morning', pos: '0,6.5,0',     yaw: 45,  pitch: -0.55, note: 'elevated — level composition + LOD popping' },
  { name: 'night',            tod: 'night',   pos: '6,1.7,14',    yaw: 200, pitch: -0.04, note: 'night lighting, artificial sources, noise floor' },
  { name: 'combat',           tod: 'golden',  pos: '4,1.7,6',     yaw: 195, pitch: -0.02, vm: 1, fire: 1, note: 'mid-firefight — muzzle flash, FX, enemies' },
  // Every other view forces hud=0 for a clean render. Without this one, no
  // capture ever shows the HUD and a reviewer reasonably concludes there isn't
  // one — which is exactly what happened in the round-6 review.
  { name: 'hud',              tod: 'golden',  pos: '4,1.7,6',     yaw: 195, pitch: -0.02, vm: 1, hud: 1, note: 'HUD layout — reticle, vitals, ammo, compass' },
];

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };

if (args.includes('--list')) {
  for (const v of VIEWS) console.log(`${v.name.padEnd(20)} ${v.note}`);
  process.exit(0);
}

const url = opt('url', 'http://127.0.0.1:5180');
const only = opt('views', null)?.split(',').map((s) => s.trim());
const tag = opt('tag', null);
const quality = opt('quality', 'cinematic');
const width = parseInt(opt('width', '1920'), 10);
const height = parseInt(opt('height', '1080'), 10);

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, 'out', 'shots', tag ?? '');
fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  args: [
    '--use-gl=angle',
    '--use-angle=d3d11',
    '--enable-unsafe-swiftshader',
    '--disable-gpu-sandbox',
    '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization',
  ],
});
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });

const errors = [];
page.on('pageerror', (e) => { errors.push(e.message); console.error('[page error]', e.message); });
page.on('console', (m) => { if (m.type() === 'error') { errors.push(m.text()); console.error('[console]', m.text().slice(0, 400)); } });

const report = [];
for (const v of VIEWS) {
  if (only && !only.includes(v.name)) continue;
  const q = new URLSearchParams({ freeze: '1', hud: v.hud ? '1' : '0', quality });
  if (v.tod) q.set('tod', v.tod);
  if (v.pos) { q.set('pos', v.pos); q.set('yaw', String(v.yaw ?? 0)); q.set('pitch', String(v.pitch ?? 0)); }
  q.set('vm', v.vm ? '1' : '0');
  if (v.ads) q.set('ads', '1');
  if (v.fire) q.set('fire', '1');

  await page.goto(`${url}/?${q}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  try {
    // Headless ANGLE/D3D11 links every one of the ~115 shader programs from
    // cold on each navigation — Playwright's temp profile means there is no
    // program cache to hit — and a link is ~0.5s, so a view legitimately needs
    // ~55-65s to reach __ready. The old 60s budget sat exactly on that mean and
    // silently dropped whichever views landed on the wrong side of it.
    await page.waitForFunction('window.__ready === true', null, { timeout: 240000 });
  } catch {
    // A dropped view used to leave `errors` empty, so a run that photographed
    // 8 of 12 still reported itself clean. It is a build failure — say so.
    console.error(`[shoot] ${v.name}: app never became ready`);
    errors.push(`${v.name}: app never became ready`);
    continue;
  }
  // Let TAA history, AO and any streaming settle before the exposure.
  await page.waitForTimeout(1200);

  const file = path.join(outDir, `${v.name}.png`);
  await page.screenshot({ path: file });
  const stats = await page.evaluate('window.__blacksite.stats()').catch(() => ({}));
  report.push({ view: v.name, file, ...stats });
  console.log(`[shoot] ${v.name.padEnd(20)} fps=${stats.fps ?? '?'} draws=${stats.drawCalls ?? '?'} tris=${stats.triangles ?? '?'}`);
}

fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({ report, errors }, null, 2));
await browser.close();
console.log(`[shoot] ${report.length} shots -> ${outDir}`);
if (errors.length) {
  console.error(`[shoot] ${errors.length} page error(s) — the build is NOT clean`);
  process.exitCode = 1;
}
