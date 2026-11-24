// Headless check of drag physics (pendulum from the grab point, dangling legs, cloth) and click waving.
const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require('playwright');
const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'test-results', 'live2d', 'pet-drag');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.css': 'text/css' };
(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 300, height: 450 }, deviceScaleFactor: 2 });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.route('http://l2d.local/**', route => {
    const file = path.join(ROOT, decodeURIComponent(new URL(route.request().url()).pathname).replace(/^\/+/, ''));
    if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: 'missing' });
    return route.fulfill({ status: 200, body: fs.readFileSync(file), headers: { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' } });
  });
  await page.goto('http://l2d.local/live2d/build/pet-harness.html');
  await page.waitForFunction(() => document.querySelector('#rig').dataset.modelReady || document.querySelector('#rig').dataset.modelError, null, { timeout: 20000 });
  const shot = name => page.screenshot({ path: path.join(OUT, `${name}.png`), omitBackground: true });
  const pose = p => page.evaluate(p => updatePetPose({ edge: 'free', dragging: false, vx: 0, vy: 0, shakeSpeed: 0, ...p }), p);
  await page.waitForTimeout(400); await shot('stand');
  await page.evaluate(() => petGrab(150 * innerWidth / 300, 135 * innerHeight / 450));
  await pose({ dragging: true, vx: 0 });
  // drag right fast then stop: body should swing back and forth under the hand
  for (let i = 0; i < 8; i++) { await pose({ dragging: true, vx: 1400 }); await page.waitForTimeout(30); }
  await shot('drag_right_moving');
  await pose({ dragging: true, vx: 0 }); await page.waitForTimeout(140); await shot('drag_stop_swing1');
  await page.waitForTimeout(200); await shot('drag_stop_swing2');
  await page.waitForTimeout(260); await shot('drag_stop_swing3');
  for (let i = 0; i < 8; i++) { await pose({ dragging: true, vx: -1400 }); await page.waitForTimeout(30); }
  await shot('drag_left_moving');
  await pose({ dragging: true, vx: 0 }); await page.waitForTimeout(1500); await shot('hang_rest');
  await pose({}); await page.waitForTimeout(90); await shot('land');
  await page.waitForTimeout(800); await shot('settled');
  await page.waitForTimeout(3000);
  for (let i = 0; i < 3; i++) { await page.evaluate(() => triggerPetInteraction()); await page.waitForTimeout(200); }
  await page.waitForTimeout(250); await shot('wave1');
  await page.waitForTimeout(170); await shot('wave2');
  const params = await page.evaluate(() => document.querySelector('#rig').dataset.params);
  await browser.close();
  console.log(JSON.stringify({ errors, params }));
})().catch(e => { console.error(e); process.exitCode = 1; });
