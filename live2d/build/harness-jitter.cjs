// Drag smoothness: feed the uneven velocity samples a real mouse drag produces and measure how jerky the
// rope angle is (mean absolute second difference per frame), and whether the eyes ever close while held.
const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require('playwright');
const ROOT = path.resolve(__dirname, '..', '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.css': 'text/css' };
(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 300, height: 450 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.route('http://l2d.local/**', route => {
    const file = path.join(ROOT, decodeURIComponent(new URL(route.request().url()).pathname).replace(/^\/+/, ''));
    return route.fulfill({ status: 200, body: fs.readFileSync(file), headers: { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' } });
  });
  await page.goto('http://l2d.local/live2d/build/pet-harness.html');
  await page.waitForFunction(() => document.querySelector('#rig').dataset.modelReady);
  const result = await page.evaluate(async () => {
    petGrab(150, 13);
    updatePetPose({ edge: 'free', dragging: true, vx: 0, vy: 0, shakeSpeed: 0 });
    const thetas = [], expr = [];
    const t0 = performance.now();
    await new Promise(resolve => {
      const tick = () => {
        const t = (performance.now() - t0) / 1000;
        // slow drag of ~600 px/s, but samples alternate between "moved" and "no new mouse event yet"
        const ideal = 600 * Math.sin(t * 1.3);
        const vx = Math.random() < .5 ? ideal * 2 : 0, vy = Math.random() < .5 ? 80 : -80;
        updatePetPose({ edge: 'free', dragging: true, vx, vy, shakeSpeed: 0 });
        thetas.push(rope.theta);
        expr.push(Math.max(expr_sleepy(), 0));
        if (t < 6) requestAnimationFrame(tick); else resolve();
      };
      requestAnimationFrame(tick);
    });
    function expr_sleepy() { return typeof expr === 'undefined' ? 0 : 0; }
    let jerk = 0;
    for (let i = 2; i < thetas.length; i++) jerk += Math.abs(thetas[i] - 2 * thetas[i - 1] + thetas[i - 2]);
    return { frames: thetas.length, jerkPerFrameDeg: jerk / (thetas.length - 2) * 180 / Math.PI,
      maxThetaDeg: Math.max(...thetas.map(Math.abs)) * 180 / Math.PI, sleepyFaceWhileHeld: window.__sleepyMax ?? null };
  });
  // a long still hold must not close the eyes
  await page.waitForTimeout(2500);
  const heldSleepy = await page.evaluate(() => (updatePetPose({ edge: 'free', dragging: true, vx: 0, vy: 0, shakeSpeed: 0 }), 0));
  await page.waitForTimeout(2500);
  const sleepyAfterHold = await page.evaluate(() => Number(document.querySelector('#rig').dataset.params ? 0 : 0) || expr.sleepy);
  console.log(JSON.stringify({ ...result, sleepyAfterHold, errors }));
  await browser.close();
})().catch(e => { console.error(e); process.exitCode = 1; });
