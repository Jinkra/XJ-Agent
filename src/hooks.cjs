const fs = require('node:fs/promises');
const path = require('node:path');

async function installHooks(home, scriptPath, nodePath) {
  const root = path.join(home, 'jinkra');
  await fs.mkdir(root, { recursive: true });
  const installedScript = path.join(root, 'hook-bridge.cjs');
  // The reviewed copy is stable across app packaging and moves.
  await fs.copyFile(path.join(path.dirname(scriptPath), 'pet-approvals.cjs'), path.join(root, 'pet-approvals.cjs'));
  await fs.copyFile(scriptPath, installedScript);
  const configFile = path.join(home, 'hooks.json');
  let config = {}, previous = null;
  try { previous = await fs.readFile(configFile, 'utf8'); config = JSON.parse(previous.replace(/^\uFEFF/, '')); }
  catch (err) { if (err.code !== 'ENOENT') throw new Error('现有 hooks.json 无法解析，未覆盖。请先修复该文件。'); }
  if (typeof config !== 'object' || !config || Array.isArray(config)) throw new Error('hooks.json 格式不正确，未覆盖。');
  config.hooks ||= {};
  const command = `"${nodePath}" "${installedScript}"`;
  for (const event of ['PermissionRequest', 'PostToolUse']) {
    const groups = config.hooks[event] || [];
    if (!Array.isArray(groups)) throw new Error(`${event} 配置格式不正确，未覆盖。`);
    // Only replace our exact managed script, preserving every unrelated hook.
    const clean = groups.map(g => ({ ...g, hooks: g.hooks?.filter(h => !h.command?.includes(installedScript)) })).filter(g => !Array.isArray(g.hooks) || g.hooks.length);
    const permission = event === 'PermissionRequest';
    clean.push({ hooks: [{ type: 'command', command: permission ? command + ' --interactive' : command,
      timeout: permission ? 48 : 3, statusMessage: permission ? '等待你在小金桌宠中处理审批' : '同步小金任务状态' }] });
    config.hooks[event] = clean;
  }
  const next = JSON.stringify(config, null, 2) + '\n';
  if (next !== previous) {
    if (previous !== null) await fs.writeFile(path.join(root, `hooks-backup-${Date.now()}.json`), previous, { flag: 'wx' });
    await fs.writeFile(configFile + '.jinkra.tmp', next);
    await fs.rename(configFile + '.jinkra.tmp', configFile);
  }
  return { path: configFile, script: installedScript, needsReview: true };
}
module.exports = { installHooks };
