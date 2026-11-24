const { CodexClient } = require('../src/codex.cjs');
const path = require('node:path');
(async () => {
  const client = new CodexClient(); let timer, output = '';
  try {
    await client.connect();
    const { thread } = await client.call('thread/start', { cwd: path.join(__dirname, '..'), sandbox: 'workspace-write', approvalPolicy: 'on-request' });
    const completed = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('真实对话测试在 120 秒内未完成。')), 120000);
      client.on('notification', ({ method, params }) => {
        if (params?.threadId !== thread.id) return;
        if (method === 'item/agentMessage/delta') output += params.delta || '';
        if (method === 'turn/completed') params.turn.status === 'completed' ? resolve() : reject(new Error(params.turn.error?.message || params.turn.status));
      });
      client.on('request', req => reject(new Error(`此只读对话意外需要额外交互：${req.method}`)));
    });
    await client.call('turn/start', { threadId: thread.id, input: [{ type: 'text', text: '这是小金桌宠的连接测试。请只回复“小金连接成功”，不要调用工具，不要修改文件。', text_elements: [] }] });
    await completed;
    if (!output.includes('小金连接成功')) throw new Error('返回内容不符合连接测试预期。');
    console.log('通过：真实 Codex 会话创建、消息发送、增量回复与完成事件。');
    console.log('测试会话：', thread.id);
  } finally { clearTimeout(timer); client.close(); }
})().catch(err => { console.error(err.message); process.exitCode = 1; });
