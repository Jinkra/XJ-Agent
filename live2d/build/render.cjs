// Render a Live2D model at fixed parameter poses with the real Cubism Core (Edge via Playwright).
// usage: node render.cjs <model3.json, relative to project root> <poses.json> <outDir> [width] [height] [physics]
const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..', '..');
const [modelRel, posesFile, outDir, width = '512', height = '768', physics = '0'] = process.argv.slice(2);
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png' };

(async () => {
  const poses = JSON.parse(fs.readFileSync(posesFile, 'utf8'));
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: Number(width), height: Number(height) }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.route('http://l2d.local/**', route => {
    const rel = decodeURIComponent(new URL(route.request().url()).pathname).replace(/^\/+/, '');
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: 'missing ' + rel });
    return route.fulfill({ status: 200, body: fs.readFileSync(file),
      headers: { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' } });
  });
  const url = `http://l2d.local/live2d/build/render.html?model=${encodeURIComponent('/' + modelRel.replace(/\\/g, '/'))}&physics=${physics}`;
  await page.goto(url);
  await page.waitForFunction(() => window.__ready || window.__error, null, { timeout: 30000 });
  const err = await page.evaluate(() => window.__error);
  if (err) throw new Error(err);
  for (const [name, values] of Object.entries(poses)) {
    await page.evaluate(v => window.setPose(v), values);
    await page.waitForTimeout(150);
    await page.screenshot({ path: path.join(outDir, `${name}.png`), omitBackground: true });
  }
  fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify({ poses: Object.keys(poses), errors }, null, 2));
  await browser.close();
  console.log(errors.length ? 'ERRORS ' + JSON.stringify(errors) : `rendered ${Object.keys(poses).length} poses`);
})().catch(e => { console.error(e); process.exitCode = 1; });
