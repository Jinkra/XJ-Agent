const { _electron: electron } = require('playwright');
const path = require('node:path');
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const ROOT = path.join(__dirname, '..');
(async () => {
  await fs.mkdir(path.join(ROOT, 'test-results'), { recursive: true });
  const codexHome = path.join(ROOT, 'test-results', 'codex-home');
  await fs.rm(path.join(codexHome, 'jinkra', 'approval-endpoint'), { force: true });
  // Start every run standing free: a docked edge saved by an earlier run would change what is measured.
  const settingsFile = path.join(ROOT, 'test-results', 'user-data', 'settings.json');
  try {
    const saved = JSON.parse(await fs.readFile(settingsFile, 'utf8'));
    delete saved.petEdge; delete saved.petX; delete saved.petY;
    await fs.writeFile(settingsFile, JSON.stringify(saved, null, 2));
  } catch { /* first run: no settings yet */ }
  const application = await electron.launch({ executablePath: require('electron'), args: [ROOT, '--jinkra-test'] });
  try {
    let workbench;
    for (let i = 0; i < 100; i++) {
      workbench = application.windows().find(p => p.url().endsWith('panel.html'));
      if (workbench) break;
      await new Promise(r => setTimeout(r, 100));
    }
    assert.ok(workbench, '工作台窗口存在'); await workbench.waitForLoadState('domcontentloaded');
    assert.ok(await workbench.evaluate(() => navigator.windowControlsOverlay.visible && !document.querySelector('.brand')));
    await workbench.getByText('小金同学工作台', { exact: true }).waitFor();
    const errors = []; workbench.on('pageerror', e => errors.push(e.message));
    await workbench.getByRole('button', { name: '所有任务' }).click();
    await workbench.getByRole('button', { name: '额度与费用' }).click();
    await workbench.getByText('用量小账本', { exact: true }).waitFor();
    await workbench.getByRole('button', { name: '偏好设置' }).click();
    await workbench.getByRole('heading', { name: '所有任务的批准提醒' }).waitFor();
    await workbench.getByLabel('勿扰模式', { exact: false }).check();
    await workbench.waitForTimeout(100);
    await workbench.getByLabel('勿扰模式', { exact: false }).uncheck();
    await workbench.getByRole('button', { name: '跟小金说' }).click();
    await workbench.getByRole('button', { name: '交给小金' }).click();
    const pet = application.windows().find(p => p.url().endsWith('pet.html')); assert.ok(pet);
    await pet.waitForLoadState('domcontentloaded');
    const image = await pet.locator('#character').evaluate(img => ({ loaded: img.complete && img.naturalWidth > 0 })); assert.ok(image.loaded);
    await pet.locator('#rig[data-rig="live2d"][data-model-ready="true"]').waitFor();
    await fs.access(path.join(ROOT, 'src', 'ui', 'live2d', 'xiaojin', 'xiaojin.moc3'));
    await pet.waitForFunction(() => document.querySelector('#rig').dataset.params);
    const firstParams = await pet.locator('#rig').getAttribute('data-params');
    await pet.waitForTimeout(500);
    const secondParams = await pet.locator('#rig').getAttribute('data-params');
    assert.notEqual(firstParams, secondParams, '站立待机由 Live2D 参数持续驱动');
    await pet.waitForFunction(() => document.body.dataset.edge === 'free' && document.querySelector('#rig').dataset.state === 'free');
    await pet.waitForTimeout(400); // let the placement blend finish
    const footClearance = await pet.evaluate(() => {
      const plate = document.querySelector('#nameplate').getBoundingClientRect();
      return plate.top - window.__petRig.paintedBottom();
    });
    assert.ok(footClearance >= 2, `脚底与姓名标签保留间距: ${footClearance}`);
    const errorsInPet = [];
    pet.on('pageerror', error => errorsInPet.push(error.message));
    for (let i = 0; i < 100; i++) {
      try { await fs.access(path.join(codexHome, 'jinkra', 'approval-endpoint')); break; }
      catch { await new Promise(resolve => setTimeout(resolve, 50)); }
    }
    const externalDecision = new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(ROOT, 'src/hook-bridge.cjs'), '--interactive'], {
        env: { ...process.env, CODEX_HOME: codexHome, JINKRA_APP_SERVER: '' }, windowsHide: true,
      });
      let output = '';
      child.stdout.on('data', chunk => { output += chunk; });
      child.on('error', reject);
      child.on('close', () => resolve(output));
      child.stdin.end(JSON.stringify({ hook_event_name: 'PermissionRequest', session_id: '00000000-0000-0000-0000-000000000001',
        turn_id: 'test-approval', tool_name: 'Bash', tool_input: { description: '检查测试目录', command: 'Get-ChildItem' } }));
    });
    await pet.getByText('这里有操作请求批准。', { exact: true }).waitFor();
    await pet.locator('#bubble-open').click();
    await pet.getByText('Get-ChildItem', { exact: false }).waitFor();
    await pet.screenshot({ path: path.join(ROOT, 'test-results', '小金审批弹窗.png'), omitBackground: true });
    await pet.getByRole('button', { name: '批准本次' }).click();
    assert.equal(JSON.parse(await externalDecision).hookSpecificOutput.decision.behavior, 'allow');
    await application.evaluate(({ ipcMain, BrowserWindow, shell }) => {
      shell.openExternal = async url => { globalThis.openedCodexUrl = url; };
      const win = BrowserWindow.getAllWindows().find(w => !w.isDestroyed() && !w.webContents.isDestroyed() && w.webContents.getURL().endsWith('pet.html'));
      ipcMain._invokeHandlers.get('test:alert')({ sender: win.webContents }, {
        kind: 'completed', title: '修复登录页面', result: '已修复登录页跳转并补充错误提示。', turnId: 'test-complete'
      });
    });
    await pet.getByText('这个任务完成啦！', { exact: true }).waitFor();
    await pet.getByText('已修复登录页跳转并补充错误提示。', { exact: true }).waitFor();
    assert.equal(await pet.locator('#bubble-task').textContent(), '已修复登录页跳转并补充错误提示。');
    await pet.locator('#bubble-open').click();
    assert.equal(await application.evaluate(() => globalThis.openedCodexUrl), 'codex://threads/00000000-0000-0000-0000-000000000000');
    await workbench.getByRole('button', { name: '所有任务', exact: false }).click();
    const task = workbench.locator('.task').first();
    await task.click();
    await workbench.locator('.task-row .task-detail').waitFor();
    await task.click();
    await workbench.locator('.task-detail').waitFor({ state: 'detached' });
    await workbench.screenshot({ path: path.join(ROOT, 'test-results', '小金工作台.png') });
    assert.equal(await pet.locator('#bubble-label').textContent(), '小金有话说');
    const gesture = (operation, edge) => application.evaluate(({ ipcMain, BrowserWindow, screen }, { operation, edge }) => {
      const win = BrowserWindow.getAllWindows().find(w => !w.isDestroyed() && !w.webContents.isDestroyed() && w.webContents.getURL().endsWith('pet.html'));
      const bounds = win.getBounds();
      const area = screen.getDisplayMatching(bounds).workArea;
      const point = { x: area.x + Math.floor(area.width / 2), y: area.y + Math.floor(area.height / 2) };
      if (edge.endsWith('left')) point.x = area.x + 2;
      if (edge.endsWith('right')) point.x = area.x + area.width - 2;
      if (edge.startsWith('top')) point.y = area.y + 2;
      if (edge.startsWith('bottom')) point.y = area.y + area.height - 2;
      const sender = { sender: win.webContents };
      ipcMain._invokeHandlers.get('test:cursor')(sender, point);
      if (operation === 'test:cursor') return;
      return ipcMain._invokeHandlers.get(operation)(sender);
    }, { operation, edge });
    for (const edge of ['left', 'right', 'top', 'bottom', 'bottom-left', 'bottom-right', 'free']) {
      await gesture('pet:drag-start', 'free');
      await gesture('pet:drag-end', edge);
      const [direction, corner = ''] = edge.split('-');
      await pet.locator(`body[data-edge="${direction}"][data-corner="${corner}"]`).waitFor({ state: 'attached' });
      await pet.waitForTimeout(380); // Wait for the rendered pose and native position to settle.
      if (edge !== 'free') {
        const dockResult = await application.evaluate(({ BrowserWindow, screen }, edge) => {
          const b = BrowserWindow.getAllWindows().find(w => !w.isDestroyed() && !w.webContents.isDestroyed() && w.webContents.getURL().endsWith('pet.html')).getBounds();
          const displays = screen.getAllDisplays();
          const attached = displays.some(display => {
            const area = display.workArea;
            const near = (a, expected) => Math.abs(a - expected) <= 12;
            return { left: near(b.x, area.x), right: near(b.x + b.width, area.x + area.width),
              top: near(b.y, area.y), bottom: near(b.y + b.height, area.y + area.height),
              'bottom-left': near(b.x, area.x) && near(b.y + b.height, area.y + area.height),
              'bottom-right': near(b.x + b.width, area.x + area.width) && near(b.y + b.height, area.y + area.height) }[edge];
          });
          return { attached, bounds: b, workAreas: displays.map(display => display.workArea) };
        }, edge);
        assert.ok(dockResult.attached, `窗口贴住 ${edge}: ${JSON.stringify(dockResult)}`);
        await pet.screenshot({ path: path.join(ROOT, 'test-results', `小金贴边-${edge}.png`), omitBackground: true });
        if (edge === 'bottom') {
          const first = createHash('sha256').update(await pet.screenshot({ omitBackground: true })).digest('hex');
          await pet.waitForTimeout(500);
          const second = createHash('sha256').update(await pet.screenshot({ omitBackground: true })).digest('hex');
          assert.notEqual(first, second, '贴底状态保持待机动画');
        }
      }
    }
    await gesture('pet:drag-start', 'free');
    for (const edge of ['left', 'right', 'left']) {
      await gesture('test:cursor', edge);
      await pet.waitForTimeout(145);
    }
    await pet.screenshot({ path: path.join(ROOT, 'test-results', '小金拖拽关节.png'), omitBackground: true });
    await gesture('pet:drag-end', 'free');
    await pet.waitForTimeout(320);
    await pet.locator('#character').hover();
    await pet.getByRole('button', { name: '给 Codex 发任务' }).waitFor();
    await pet.waitForTimeout(350); // the three buttons open with staggered transitions
    const freeMenu = await pet.locator('#pet-actions button').evaluateAll(buttons => buttons.map(button => {
      const rect = button.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
    }));
    const freeCharacter = await pet.locator('#character').evaluate(node => {
      const rect = node.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top };
    });
    assert.ok(freeMenu.every(button => button.bottom < freeCharacter.top), '站立状态的三个按钮位于人物头顶上方');
    assert.ok(Math.abs((freeMenu[0].left + freeMenu[2].right) / 2 - (freeCharacter.left + freeCharacter.right) / 2) < 2, '站立菜单绑定人物水平中心');
    assert.ok(new Set(freeMenu.map(button => button.top)).size === 1, '站立菜单三个按钮严格同高');
    await pet.screenshot({ path: path.join(ROOT, 'test-results', '小金站立悬浮菜单.png'), omitBackground: true });
    await pet.mouse.move(299, 1);
    await pet.waitForTimeout(650);
    await workbench.close();
    await gesture('pet:drag-start', 'free');
    await gesture('pet:drag-end', 'bottom');
    await pet.locator('body[data-edge="bottom"]').waitFor({ state: 'attached' });
    await pet.waitForTimeout(380);
    await pet.locator('#character').hover();
    await pet.getByRole('button', { name: '给 Codex 发任务' }).waitFor();
    await pet.waitForTimeout(280);
    const circles = await pet.locator('#pet-actions button').evaluateAll(buttons => buttons.map(button => {
      const style = getComputedStyle(button);
      const rect = button.getBoundingClientRect();
      return { radius: style.borderRadius, width: rect.width, height: rect.height, left: rect.left, top: rect.top };
    }));
    assert.ok(circles.every(circle => circle.radius === '50%' && Math.abs(circle.width - circle.height) < 1), `悬浮菜单是三个独立圆形按钮: ${JSON.stringify(circles)}`);
    assert.equal(new Set(circles.map(circle => `${circle.left},${circle.top}`)).size, 3, '三个圆分别围绕人物排列');
    assert.ok(Math.abs(circles[0].top - circles[2].top) < 1, '左右两个按钮严格同高');
    assert.ok(Math.abs((circles[1].left - circles[0].left) - (circles[2].left - circles[1].left)) < 1, '三个按钮水平中心间距一致');
    assert.ok(await pet.locator('#pet-actions').evaluate(menu => menu.classList.contains('is-open') && [...menu.children].every(button => Number(getComputedStyle(button).opacity) > .98)), '三个按钮带动画展开');
    await pet.screenshot({ path: path.join(ROOT, 'test-results', '小金悬浮圆形菜单.png'), omitBackground: true });
    await pet.mouse.move(299, 1);
    await pet.waitForTimeout(650);
    assert.ok(await pet.locator('#pet-actions').evaluate(menu => menu.hidden), '三个按钮带动画收起');
    await pet.locator('#character').hover();
    await pet.getByRole('button', { name: '给 Codex 发任务' }).waitFor();
    const pin = pet.locator('#pet-pin');
    assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => !w.isDestroyed() && !w.webContents.isDestroyed() && w.webContents.getURL().endsWith('pet.html')).isAlwaysOnTop()), true);
    await pin.click();
    await pet.waitForFunction(() => document.querySelector('#pet-pin').getAttribute('aria-pressed') === 'false');
    assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => !w.isDestroyed() && !w.webContents.isDestroyed() && w.webContents.getURL().endsWith('pet.html')).isAlwaysOnTop()), false);
    await pin.click();
    await pet.waitForFunction(() => document.querySelector('#pet-pin').getAttribute('aria-pressed') === 'true');
    assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => !w.isDestroyed() && !w.webContents.isDestroyed() && w.webContents.getURL().endsWith('pet.html')).isAlwaysOnTop()), true);
    await pet.getByRole('button', { name: '给 Codex 发任务' }).click();
    await pet.getByRole('textbox', { name: '给 Codex 的任务' }).waitFor();
    await pet.getByRole('button', { name: '关闭弹窗' }).click();
    await gesture('pet:drag-start', 'free');
    await gesture('pet:drag-end', 'free');
    await pet.locator('body[data-edge="free"]').waitFor({ state: 'attached' });
    await pet.waitForTimeout(380);
    await pet.locator('#character').click();
    await pet.waitForTimeout(260);
    await pet.screenshot({ path: path.join(ROOT, 'test-results', '小金点击互动.png'), omitBackground: true });
    assert.equal(application.windows().length, 1);
    await pet.locator('#character').hover();
    await pet.getByRole('button', { name: '打开工作台' }).click();
    await application.windows().find(window => window !== pet)?.getByText('小金同学工作台', {exact:true}).waitFor();
    assert.deepEqual(errorsInPet, []); assert.deepEqual(errors, []); console.log('通过：审批往返、完成直达 Codex、列表原位展开、悬浮菜单置顶、四边和底角吸附。');
  } finally { await application.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
