const { _electron: electron } = require('playwright');
const { spawn } = require('node:child_process');
const path = require('node:path');
const assert = require('node:assert/strict');
const ROOT = path.join(__dirname, '..');
(async () => {
  const application = await electron.launch({ executablePath: path.join(ROOT, 'dist', '小金同学-win32-x64', 'Jinkra.exe') });
  try {
    let panel;
    for (let i = 0; i < 100; i++) {
      panel = application.windows().find(p => p.url().endsWith('panel.html'));
      if (panel) break;
      await new Promise(r => setTimeout(r, 100));
    }
    if (!panel) {
      const pet = application.windows().find(p => p.url().endsWith('pet.html'));
      await pet.locator('#nameplate').click();
      panel = await application.waitForEvent('window'); await panel.waitForLoadState('domcontentloaded');
    }
    await panel.getByText('● Codex 已连接', { exact: true }).waitFor({ timeout: 60000 });
    await panel.getByRole('button', { name: '额度与费用' }).click();
    await panel.locator('.quota-card').first().waitFor({ timeout: 15000 });
    await panel.screenshot({ path: path.join(ROOT, 'test-results', '真实额度面板.png') });
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(__dirname, 'live-chat-smoke.cjs')], { windowsHide: true });
      let output = ''; child.stdout.on('data', d => output += d); child.stderr.on('data', d => output += d);
      child.on('error', reject); child.on('close', code => code === 0 ? resolve(output) : reject(new Error(output)));
    });
    console.log(result.trim());
    const pet = application.windows().find(p => p.url().endsWith('pet.html'));
    await pet.getByText('这个任务完成啦！', { exact: true }).waitFor({ timeout: 30000 });
    await pet.screenshot({ path: path.join(ROOT, 'test-results', '真实任务完成气泡.png'), omitBackground: true });
    await pet.locator('#bubble-open').click();
    await panel.getByText('小金正在关注', { exact: true }).waitFor();
    assert.ok(await panel.locator('.task').count() > 0);
    await panel.screenshot({ path: path.join(ROOT, 'test-results', '真实任务列表.png') });
    console.log('通过：打包程序连接真实 Codex、显示真实额度，并监听另一个 Codex 进程完成任务后弹出气泡。');
  } finally { await application.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
