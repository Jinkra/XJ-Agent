// Headless check of the pet's expression interactions (pinch, startled, dizzy, sulky, limp, doze).
const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require('playwright');
const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'test-results', 'live2d', 'pet-expr');
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
  const err = await page.evaluate(() => document.querySelector('#rig').dataset.modelError);
  if (err) throw new Error(err);
  const shot = name => page.screenshot({ path: path.join(OUT, `${name}.png`), omitBackground: true });
  const pose = p => page.evaluate(p => updatePetPose({ edge: 'free', dragging: false, vx: 0, vy: 0, shakeSpeed: 0, ...p }), p);
  await page.waitForTimeout(500); await shot('idle');
  // pinch the image-left cheek and pull outward
  const hit = await page.evaluate(() => { const [lx, ly] = toLogical(LAYOUT.cheekL); const r = cheekAt(lx * innerWidth / 300, ly * innerHeight / 450); if (r) { petPinchStart(r); petPinchMove(-28, 6); } return r; });
  await page.waitForTimeout(450); await shot('pinch');
  await page.evaluate(() => petPinchEnd()); await page.waitForTimeout(140); await shot('pinch_release');
  await page.waitForTimeout(2200);
  await pose({ dragging: true, vx: 200 }); await page.waitForTimeout(260); await shot('startled');
  for (let i = 0; i < 6; i++) { await pose({ dragging: true, vx: i % 2 ? -1500 : 1500 }); await page.waitForTimeout(120); }
  await shot('dizzy_drag');
  await pose({}); await page.waitForTimeout(700); await shot('dizzy_after');
  await page.waitForTimeout(3000);
  await pose({ dragging: true, vx: 0 }); await page.waitForTimeout(1900); await shot('limp');
  await pose({}); await page.waitForTimeout(1200);
  for (let i = 0; i < 4; i++) { await page.evaluate(() => triggerPetInteraction()); await page.waitForTimeout(150); }
  await page.waitForTimeout(400); await shot('sulky');
  await page.waitForTimeout(3800);
  await page.evaluate(() => { lastActivity = performance.now() - 16 * 60000; }); await page.waitForTimeout(900); await shot('dozing');
  const sleepTrace = [];
  for (let i = 0; i < 12; i++) { await page.waitForTimeout(250); sleepTrace.push(await page.evaluate(() => document.querySelector('#rig').dataset.params)); }
  await shot('dozing_later');
  // a busy task keeps Xiaojin awake
  await page.evaluate(() => { wake(); document.body.classList.add('working'); lastActivity = performance.now() - 16 * 60000; });
  await page.waitForTimeout(600);
  const awakeWhileWorking = await page.evaluate(() => !dozing);
  await page.evaluate(() => document.body.classList.remove('working'));
  for (let i = 0; i < 3; i++) { await page.evaluate(() => triggerPetInteraction()); await page.waitForTimeout(150); }
  for (const t of [250, 200, 200, 200]) { await page.waitForTimeout(t); await shot(`wave_${t}_${Date.now() % 1000}`); }
  fs.writeFileSync(path.join(OUT, 'sleep.json'), JSON.stringify({ sleepTrace, awakeWhileWorking }, null, 1));
  await page.evaluate(() => wake()); await page.waitForTimeout(250); await shot('wake_startled');
  fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify({ errors, hit }, null, 2));
  await browser.close();
  console.log(JSON.stringify({ errors, hit }));
})().catch(e => { console.error(e); process.exitCode = 1; });
