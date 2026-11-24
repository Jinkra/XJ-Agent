// Codex lifecycle hook. A decision is returned only after an explicit click in the desktop app.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const net = require('node:net');
const { endpoint } = require('./pet-approvals.cjs');
let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { data += chunk; if (data.length > 2 * 1024 * 1024) process.exit(0); });
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(data);
    if (!['PermissionRequest', 'PostToolUse'].includes(input.hook_event_name)) return;
    const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
    const root = path.join(home, 'jinkra', 'events');
    fs.mkdirSync(root, { recursive: true });
    const event = {
      id: randomUUID(), at: Date.now(), kind: input.hook_event_name,
      threadId: input.session_id, turnId: input.turn_id,
      cwd: input.cwd, tool: input.tool_name,
      detail: input.hook_event_name === 'PermissionRequest'
        ? String(input.tool_input?.description || input.tool_input?.command || input.tool_name || '操作请求批准').slice(0, 2000) : '',
    };
    if (input.hook_event_name === 'PermissionRequest' && process.argv.includes('--interactive')) {
      if (process.env.JINKRA_APP_SERVER === '1') return;
      // Show the complete operation, including tool arguments, before accepting a decision.
      event.detail = typeof input.tool_input?.command === 'string'
        ? [input.tool_input.description, input.tool_input.command].filter(Boolean).join('\n\n')
        : JSON.stringify(input.tool_input || {}, null, 2);
      const socket = net.createConnection(endpoint(home));
      const expiry = setTimeout(() => socket.destroy(), 42000);
      let reply = '';
      socket.setEncoding('utf8');
      socket.on('connect', () => socket.write(JSON.stringify(event) + '\n'));
      socket.on('error', () => socket.destroy());
      socket.on('close', () => clearTimeout(expiry));
      socket.on('data', chunk => {
        reply += chunk;
        if (reply.length > 32) { socket.destroy(); return; }
        if (!reply.includes('\n')) return;
        const behavior = reply.trim();
        if (behavior === 'allow' || behavior === 'deny') {
          process.stdout.write(JSON.stringify({ hookSpecificOutput: {
            hookEventName: 'PermissionRequest', decision: { behavior },
          } }) + '\n');
        }
        socket.destroy();
      });
      return;
    }
    const dest = path.join(root, `${event.at}-${event.id}.json`);
    fs.writeFileSync(dest + '.tmp', JSON.stringify(event), { mode: 0o600 });
    fs.renameSync(dest + '.tmp', dest);
  } catch { /* Monitoring must never block the user's task. */ }
});
