const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { installHooks } = require('../src/hooks.cjs');
(async () => {
  const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const runtime = path.join(home, 'jinkra', 'node.exe');
  await fs.mkdir(path.dirname(runtime), { recursive: true });
  try { await fs.access(runtime); } catch { await fs.copyFile(process.execPath, runtime); }
  const result = await installHooks(home, path.join(__dirname, '../src/hook-bridge.cjs'), runtime);
  console.log('已安装小金批准提醒钩子：', result.path);
  console.log('请在 Codex 的设置 → Hooks 或 CLI /hooks 中审核信任两项小金钩子。未更改任何信任状态。');
})().catch(e => { console.error(e.message); process.exitCode = 1; });
