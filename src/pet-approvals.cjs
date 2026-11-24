const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const endpointFile = home => path.join(home, 'jinkra', 'approval-endpoint');
function endpoint(home) {
  const id = fs.readFileSync(endpointFile(home), 'utf8');
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('无效的审批连接。');
  return pipeName(id);
}
const pipeName = id => '\\\\.\\pipe\\jinkra-permission-' + id;

function listenForApprovals(home, { onRequest, onClose, canPrompt }) {
  const pipeId = randomUUID();
  const requests = new Map();
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    let data = '', id;
    socket.setEncoding('utf8');
    socket.setTimeout(50000, () => socket.destroy());
    socket.on('error', () => socket.destroy());
    socket.on('close', () => {
      sockets.delete(socket);
      if (requests.delete(id)) onClose(id);
    });
    socket.on('data', chunk => {
      if (id) return;
      data += chunk;
      if (data.length > 256000) { socket.end(); return; }
      const end = data.indexOf('\n');
      if (end < 0) return;
      try {
        const info = JSON.parse(data.slice(0, end));
        if (!canPrompt() || !info.threadId || !info.tool || !info.detail) { socket.end(); return; }
        id = randomUUID();
        const request = { id, threadId: info.threadId, turnId: info.turnId, cwd: info.cwd, tool: info.tool, detail: info.detail };
        requests.set(id, { request, socket });
        onRequest(request);
      } catch { socket.end(); }
    });
  });
  server.on('error', () => {});
  server.listen(pipeName(pipeId), () => {
    const file = endpointFile(home);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file + '.tmp', pipeId, { mode: 0o600 });
      fs.renameSync(file + '.tmp', file);
    } catch { server.close(); }
  });
  return {
    list: () => [...requests.values()].map(entry => entry.request),
    reply(id, decision) {
      const entry = requests.get(id);
      if (!entry || !entry.socket.writable) throw new Error('这个请求已经结束，请回到 Codex 查看。');
      if (!['allow', 'deny', 'defer'].includes(decision)) throw new Error('无效的审批决定。');
      requests.delete(id);
      entry.socket.end(decision + '\n');
      onClose(id);
    },
    close() {
      for (const socket of sockets) socket.destroy();
      server.close();
      try {
        const file = endpointFile(home);
        if (fs.readFileSync(file, 'utf8') === pipeId) fs.unlinkSync(file);
      } catch { /* A stale endpoint cannot grant approval. */ }
    },
  };
}

module.exports = { endpoint, listenForApprovals };
