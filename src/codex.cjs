const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function findCodex() {
  if (process.env.JINKRA_CODEX_BIN) return process.env.JINKRA_CODEX_BIN;
  const base = path.join(process.env.LOCALAPPDATA || '', 'OpenAI', 'Codex', 'bin');
  if (fs.existsSync(base)) {
    const bins = fs.readdirSync(base).map(d => path.join(base, d, 'codex.exe')).filter(p => fs.existsSync(p));
    bins.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    if (bins[0]) return bins[0];
  }
  const baseNpm = path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@openai');
  for (const pkg of ['codex', 'codex-win32-x64']) {
    const root = path.join(baseNpm, pkg);
    if (!fs.existsSync(root)) continue;
    const search = dir => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isFile() && e.name === 'codex.exe') return p;
        if (e.isDirectory()) { const found = search(p); if (found) return found; }
      }
    };
    const found = search(root); if (found) return found;
  }
  throw new Error('没有找到 Codex。请先安装并登录 Codex 桌面应用或 CLI。');
}

class CodexClient extends EventEmitter {
  constructor() { super(); this.seq = 0; this.pending = new Map(); this.requests = new Map(); this.ready = false; }
  async connect() {
    if (this.ready) return;
    if (this.connecting) return this.connecting;
    this.connecting = this._connect().finally(() => { this.connecting = null; });
    return this.connecting;
  }
  async _connect() {
    const bin = findCodex();
    const child = this.child = spawn(bin, ['app-server', '--listen', 'stdio://'], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], cwd: os.homedir(), env: { ...process.env, JINKRA_APP_SERVER: '1' },
    });
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 32 * 1024 * 1024) { child.kill(); return; }
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx); buffer = buffer.slice(idx + 1);
        try { this.receive(JSON.parse(line)); } catch { /* Ignore non-protocol lines. */ }
      }
    });
    // Drain diagnostics; never forward potentially sensitive server logs to the renderer.
    child.stderr.on('data', () => {});
    child.on('error', () => this.disconnected('Codex 进程启动失败，请检查安装。', child));
    child.on('exit', () => this.disconnected('与 Codex 的连接已断开。', child));
    try {
      await this.call('initialize', {
        clientInfo: { name: 'jinkra_companion', title: '小金同学', version: '0.1.0' },
        capabilities: { experimentalApi: true, requestAttestation: false },
      });
      this.notify('initialized', {});
      this.ready = true; this.emit('connection', { connected: true });
    } catch (error) { child.kill(); throw error; }
  }
  disconnected(message, child) {
    if (child !== this.child) return;
    this.ready = false; this.child = null;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error(message)); }
    this.pending.clear(); this.requests.clear();
    this.emit('connection', { connected: false, error: message });
  }
  send(message) {
    if (!this.child?.stdin.writable) throw new Error('Codex 尚未连接。');
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }
  notify(method, params) { this.send({ method, params }); }
  call(method, params, timeout = 45000) {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} 请求超时，请重试连接。`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); } catch (err) { clearTimeout(timer); this.pending.delete(id); reject(err); }
    });
  }
  receive(message) {
    if (message.id !== undefined && !message.method) {
      const p = this.pending.get(message.id); if (!p) return;
      clearTimeout(p.timer); this.pending.delete(message.id);
      if (message.error) p.reject(new Error(message.error.message || 'Codex 请求失败。'));
      else p.resolve(message.result);
    } else if (message.method && message.id !== undefined) {
      this.requests.set(String(message.id), message);
      this.emit('request', message);
    } else if (message.method) this.emit('notification', message);
  }
  reply(id, result) {
    const request = this.requests.get(String(id));
    if (!request) throw new Error('这个请求已处理或连接已经变化。');
    this.send({ id: request.id, result }); this.requests.delete(String(id));
  }
  close() { this.child?.kill(); }
}
module.exports = { CodexClient, findCodex };
