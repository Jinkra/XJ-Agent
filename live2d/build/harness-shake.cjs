// Stress test: violent shaking while dragged. Every frame, the figure must stay inside the window
// (no opaque pixels on the left/right/bottom border of the WebGL canvas).
const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require('playwright');
const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'test-results', 'live2d', 'pet-shake');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.css': 'text/css' };
(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 300, height: 450 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.route('http://l2d.local/**', route => {
    const file = path.join(ROOT, decodeURIComponent(new URL(route.request().url()).pathname).replace(/^\/+/, ''));
    if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: 'missing' });
    return route.fulfill({ status: 200, body: fs.readFileSync(file), headers: { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' } });
  });
  await page.goto('http://l2d.local/live2d/build/pet-harness.html');
  await page.waitForFunction(() => document.querySelector('#rig').dataset.modelReady, null, { timeout: 20000 });
  await page.evaluate(() => {
    window.__border = () => {
      const c = document.querySelector('#rig'); const gl = c.getContext('webgl');
      const w = c.width, h = c.height, px = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
      let hits = 0;
      for (let y = 0; y < h; y++) for (const x of [0, 1, w - 2, w - 1]) if (px[(y * w + x) * 4 + 3] > 20) hits++;
      for (const y of [0, 1]) for (let x = 0; x < w; x++) if (px[(y * w + x) * 4 + 3] > 20) hits++; // bottom rows
      return hits;
    };
  });
  await page.evaluate(() => petGrab(150, 13));
  let worst = 0, frames = 0, worstName = '';
  const step = async (vx, vy, name) => {
    await page.evaluate(([vx, vy]) => updatePetPose({ edge: 'free', dragging: true, vx, vy, shakeSpeed: 0 }), [vx, vy]);
    await page.waitForTimeout(16);
    const hits = await page.evaluate(() => { window.__petRig.paintedBottom(); return window.__border(); });
    frames++;
    if (hits > worst) { worst = hits; worstName = name; await page.screenshot({ path: path.join(OUT, 'worst.png'), omitBackground: true }); }
  };
  // 1) violent left-right shaking at increasing speed
  for (const speed of [1500, 3000, 4000]) {
    for (let i = 0; i < 40; i++) await step(speed * Math.sign(Math.sin(i * .9)), 0, `shake${speed}`);
  }
  // 2) sudden full stops and reversals, plus vertical yanks
  for (let r = 0; r < 4; r++) {
    for (let i = 0; i < 10; i++) await step(4000 * (r % 2 ? -1 : 1), 0, 'dash');
    for (let i = 0; i < 20; i++) await step(0, 0, 'stop');
    for (let i = 0; i < 8; i++) await step(0, r % 2 ? 3000 : -3000, 'yank');
  }
  // 3) cursor pulled toward the window edge (as if the window lagged)
  await page.evaluate(() => petGrab(250, 40));
  for (let i = 0; i < 40; i++) await step(3000 * Math.sign(Math.sin(i)), 0, 'edge-grab');
  await page.screenshot({ path: path.join(OUT, 'last.png'), omitBackground: true });
  console.log(JSON.stringify({ frames, worstBorderPixels: worst, worstName, errors }));
  await browser.close();
})().catch(e => { console.error(e); process.exitCode = 1; });
