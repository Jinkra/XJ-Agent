const { CodexClient } = require('../src/codex.cjs');
(async () => {
  const c = new CodexClient();
  try {
    await c.connect();
    const account = await c.call('account/read', {});
    console.log('Codex 连接成功；账户类型：', account.account?.type || '未登录');
    const usage = await c.call('account/rateLimits/read', {});
    console.log('额度接口成功；可用字段：', Object.keys(usage).join(', '));
    const hooks = await c.call('hooks/list', { cwds: [process.cwd()] });
    const ours = hooks.data.flatMap(d => d.hooks || []).filter(h => h.command?.includes('jinkra'));
    console.log('小金钩子：', ours.map(h => ({ event: h.eventName, trust: h.trustStatus })));
  } finally { c.close(); }
})().catch(e => { console.error(e.message); process.exitCode = 1; });
