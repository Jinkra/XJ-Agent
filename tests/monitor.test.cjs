const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { TaskMonitor } = require('../src/monitor.cjs');
const { installHooks } = require('../src/hooks.cjs');
const { getCosts } = require('../src/store.cjs');
const { spawn } = require('node:child_process');
const line = (type, payload, at = Date.now()) => JSON.stringify({ type, timestamp: new Date(at).toISOString(), payload }) + '\n';

test('历史结果不提醒；新增完整事件提醒一次；中文跨写入及不完整行不误报', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'jinkra-monitor-')); t.after(() => fs.rm(home, { recursive: true, force: true }));
  const file = path.join(home, 'session.jsonl'); const monitor = new TaskMonitor(home); const alerts = [];
  monitor.on('alert', e => alerts.push(e));
  await fs.writeFile(file, line('session_meta', { id: 'thread-a', cwd: '项目' }, Date.now() - 10000) + line('event_msg', { type: 'task_complete', turn_id: 'old' }, Date.now() - 9000));
  await monitor.readFile(file, true); assert.equal(alerts.length, 0);
  const event = Buffer.from(line('event_msg', { type: 'task_complete', turn_id: 'new', last_agent_message: '中文完成' }));
  const split = event.indexOf(Buffer.from('中文')) + 1;
  await fs.appendFile(file, event.subarray(0, split)); await monitor.readFile(file); assert.equal(alerts.length, 0);
  await fs.appendFile(file, event.subarray(split)); await monitor.readFile(file); await monitor.readFile(file);
  assert.equal(alerts.length, 1); assert.equal(alerts[0].kind, 'completed'); assert.equal(alerts[0].result, '中文完成');
  assert.equal(monitor.tasks.get('thread-a').result, '中文完成');
  await fs.appendFile(file, line('event_msg', { type: 'task_complete', turn_id: 'new' })); await monitor.readFile(file); assert.equal(alerts.length, 1);
  monitor.close();
});

test('批准请求分属不同任务，工具完成后清除等待状态；中断不冒充成功', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'jinkra-hooks-')); t.after(() => fs.rm(home, { recursive: true, force: true }));
  const dir = path.join(home, 'jinkra', 'events'); await fs.mkdir(dir, { recursive: true });
  const monitor = new TaskMonitor(home); const alerts = []; monitor.on('alert', e => alerts.push(e));
  const at = Date.now() + 10;
  for (const id of ['a', 'b']) await fs.writeFile(path.join(dir, `1-${id}.json`), JSON.stringify({ id, at, kind: 'PermissionRequest', threadId: id, turnId: 'turn', tool: 'Bash' }));
  await monitor.readHooks(); assert.equal(alerts.length, 2); assert.equal(monitor.tasks.get('a').state, 'approval');
  await fs.writeFile(path.join(dir, '2-a.json'), JSON.stringify({ id: 'clear', at: at + 1, kind: 'PostToolUse', threadId: 'a', turnId: 'turn', tool: 'Bash' }));
  await monitor.readHooks(); assert.equal(monitor.tasks.get('a').state, 'active'); assert.equal(monitor.tasks.get('b').state, 'approval');
  monitor.consume({ type: 'event_msg', timestamp: new Date().toISOString(), payload: { type: 'turn_aborted', thread_id: 'b', turn_id: 'turn' } }, {}, true);
  assert.equal(alerts.at(-1).kind, 'interrupted'); monitor.close();
});

test('钩子安装保留原有配置，重复安装不叠加，不写信任状态或审批决定', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'jinkra-install-')); t.after(() => fs.rm(home, { recursive: true, force: true }));
  const config = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'existing' }] }] }, description: 'original' };
  await fs.writeFile(path.join(home, 'hooks.json'), JSON.stringify(config));
  for (let i = 0; i < 2; i++) await installHooks(home, path.join(__dirname, '../src/hook-bridge.cjs'), 'C:\\node.exe');
  const result = JSON.parse(await fs.readFile(path.join(home, 'hooks.json')));
  assert.deepEqual(result.hooks.Stop, config.hooks.Stop); assert.equal(result.hooks.PermissionRequest.length, 1); assert.equal(result.description, 'original');
  assert.ok(!JSON.stringify(result).includes('bypass')); assert.ok(!JSON.stringify(result).includes('decision'));
});

test('费用分页正确合计，权限失败不返回伪造费用', async () => {
  let calls = 0;
  const result = await getCosts('secret', async (url, options) => {
    assert.equal(url.hostname, 'api.openai.com'); assert.equal(options.headers.Authorization, 'Bearer secret');
    calls++;
    return { ok: true, json: async () => ({ data: [{ start_time: 1, results: [{ amount: { value: calls === 1 ? .25 : .75, currency: 'usd' } }] }], has_more: calls === 1, next_page: calls === 1 ? 'page2' : null }) };
  });
  assert.equal(result.total, 1); assert.equal(calls, 2);
  await assert.rejects(() => getCosts('bad', async () => ({ ok: false, status: 403 })), /权限不足/);
});

test('真实运行桥接脚本仅落盘事件，不向 Codex 返回批准决定', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'jinkra-bridge-')); t.after(() => fs.rm(home, { recursive: true, force: true }));
  const output = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, '../src/hook-bridge.cjs')], { env: { ...process.env, CODEX_HOME: home }, windowsHide: true });
    let stdout = ''; child.stdout.on('data', d => stdout += d); child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(stdout) : reject(new Error('bridge failed')));
    child.stdin.end(JSON.stringify({ hook_event_name: 'PermissionRequest', session_id: 'one', turn_id: 'turn', tool_name: 'Bash', tool_input: { command: 'read-only test' } }));
  });
  assert.equal(output, '');
  const dir = path.join(home, 'jinkra', 'events'); const files = await fs.readdir(dir);
  assert.equal(files.length, 1); const event = JSON.parse(await fs.readFile(path.join(dir, files[0]), 'utf8'));
  assert.equal(event.kind, 'PermissionRequest'); assert.equal(event.threadId, 'one'); assert.equal(event.decision, undefined);
});
