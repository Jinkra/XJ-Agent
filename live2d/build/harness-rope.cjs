// Headless check: rope dragging physics and Live2D dock poses at all edges.
const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require('playwright');
const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'test-results', 'live2d', 'pet-rope');
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
  // a drag: window accelerates right, cruises, stops; cursor stays at the rope top
  const run = async (profile, every = 16) => { for (const [vx, vy] of profile) { await pose({ dragging: true, vx, vy }); await page.waitForTimeout(every); } };
  await page.waitForTimeout(400); await shot('a_stand');
  await page.evaluate(() => petGrab(150 * innerWidth / 300, 13 * innerHeight / 450));
  await pose({ dragging: true }); await page.waitForTimeout(250); await shot('b_lifted');
  await run(Array.from({ length: 10 }, (_, i) => [i * 160, 0])); await shot('c_accel_right');
  await run(Array.from({ length: 10 }, () => [1600, 0])); await shot('d_cruise_right');
  await run(Array.from({ length: 6 }, (_, i) => [1600 - i * 300, 0])); await shot('e_stop');
  await run(Array.from({ length: 8 }, () => [0, 0])); await shot('f_swing1');
  await run(Array.from({ length: 10 }, () => [0, 0])); await shot('g_swing2');
  await run(Array.from({ length: 10 }, (_, i) => [0, -i * 150])); await shot('h_lift_up');
  await run(Array.from({ length: 8 }, () => [0, 1200])); await shot('i_drop_down');
  await run(Array.from({ length: 60 }, () => [0, 0]), 25); await shot('j_hang_still');
  await pose({}); await page.waitForTimeout(120); await shot('k_land');
  await page.waitForTimeout(700); await shot('l_settled');
  for (const edge of ['bottom', 'top', 'left', 'right', 'bottom-left']) {
    await pose({ edge }); await page.waitForTimeout(700); await shot(`m_dock_${edge}`);
  }
  await pose({ edge: 'bottom' }); await page.waitForTimeout(600);
  await page.mouse.move(150, 330); await page.waitForTimeout(450); await shot('n_bottom_hover');
  await page.evaluate(() => triggerPetInteraction()); await page.waitForTimeout(300); await shot('o_bottom_tap');
  for (let i = 0; i < 3; i++) { await page.evaluate(() => triggerPetInteraction()); await page.waitForTimeout(150); }
  await page.waitForTimeout(300); await shot('p_bottom_wave');
  await pose({ edge: 'left' }); await page.waitForTimeout(800);
  await page.mouse.move(200, 200); await page.waitForTimeout(450); await shot('q_left_hover');
  fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify({ errors }, null, 2));
  await browser.close();
  console.log(JSON.stringify({ errors }));
})().catch(e => { console.error(e); process.exitCode = 1; });
