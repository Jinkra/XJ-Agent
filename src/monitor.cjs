const fs = require('node:fs/promises');
const { watch } = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const textOf = item => (item?.content || []).map(c => c.text || '').join('\n');
class TaskMonitor extends EventEmitter {
  constructor(home) {
    super(); this.home = home; this.startedAt = Date.now(); this.files = new Map(); this.tasks = new Map();
    this.seen = new Set(); this.hookSeen = new Set(); this.closed = false; this.pendingFiles = new Set();
    this.coverage = { watching: false, discovered: 0, error: null };
  }
  snapshot() { return [...this.tasks.values()].sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)).slice(0, 200); }
  task(id, fields) {
    if (!id) return null;
    const t = { id, title: 'Codex 任务', state: 'unknown', updatedAt: 0, ...this.tasks.get(id), ...fields };
    this.tasks.set(id, t); this.emit('changed'); return t;
  }
  alert(event) {
    const key = `${event.threadId}:${event.turnId || ''}:${event.kind}:${event.requestId || ''}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    if (this.seen.size > 10000) this.seen.delete(this.seen.values().next().value);
    const task = this.tasks.get(event.threadId);
    this.emit('alert', { ...event, id: key, title: task?.title || 'Codex 任务', result: event.result || task?.result || '', at: Date.now() });
  }
  consume(record, state, live) {
    const p = record.payload || {};
    const at = Date.parse(record.timestamp) || Date.now();
    if (record.type === 'session_meta') {
      state.threadId = p.id; this.task(p.id, { cwd: p.cwd, source: p.source, path: state.path }); return;
    }
    if (record.type !== 'event_msg') return;
    const threadId = p.thread_id || state.threadId;
    if (!threadId) return;
    if (p.type === 'task_started') this.task(threadId, { state: 'active', turnId: p.turn_id, updatedAt: at, pending: null });
    if (p.type === 'item_completed' && p.item?.type === 'UserMessage') {
      const text = textOf(p.item).replace(/<environment_context>[\s\S]*?<\/environment_context>/g, '').trim();
      if (text) this.task(threadId, { title: text.replace(/\s+/g, ' ').slice(0, 90), updatedAt: at });
    }
    if (p.type === 'user_message' && p.message) this.task(threadId, { title: String(p.message).replace(/\s+/g, ' ').slice(0, 90), updatedAt: at });
    if (p.type === 'token_count' && p.rate_limits) {
      this.emit('quota', { data: p.rate_limits, at, source: '本机 Codex 用量快照' });
    }
    if (p.type === 'task_complete' || p.type === 'turn_aborted' || p.type === 'task_failed') {
      const kind = p.type === 'task_complete' ? 'completed' : p.type === 'turn_aborted' ? 'interrupted' : 'failed';
      this.task(threadId, { state: kind, turnId: p.turn_id, updatedAt: at, pending: null,
        result: String(p.last_agent_message || p.reason || p.message || '').slice(0, 5000) });
      if (live) this.alert({ threadId, turnId: p.turn_id, kind, detail: p.reason || '' });
    }
  }
  async readFile(file, initial = false) {
    if (this.closed) return;
    if (this.files.get(file)?.busy) { this.pendingFiles.add(file); return; }
    let state = this.files.get(file);
    if (!state) { initial = true; state = { path: file, offset: 0, partial: Buffer.alloc(0), busy: false, dropping: false }; this.files.set(file, state); }
    state.busy = true;
    let handle;
    try {
      handle = await fs.open(file, 'r'); const stat = await handle.stat();
      if (state.offset > stat.size) { state.offset = 0; state.partial = Buffer.alloc(0); state.dropping = false; }
      if (!state.threadId) {
        const header = Buffer.alloc(65536); const { bytesRead } = await handle.read(header, 0, header.length, 0);
        const first = header.subarray(0, bytesRead).toString('utf8').split('\n')[0];
        try { this.consume(JSON.parse(first), state, false); } catch { /* File can still be initializing. */ }
      }
      if (initial && stat.size > 512 * 1024) { state.offset = stat.size - 512 * 1024; state.dropping = true; }
      // Read in bounded chunks. Appends arriving later are picked up by watch/periodic scan.
      const end = stat.size;
      while (state.offset < end && !this.closed) {
        const chunk = Buffer.alloc(Math.min(256 * 1024, end - state.offset));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, state.offset);
        if (!bytesRead) break;
        state.offset += bytesRead;
        let data = Buffer.concat([state.partial, chunk.subarray(0, bytesRead)]); let start = 0, idx;
        while ((idx = data.indexOf(10, start)) >= 0) {
          if (!state.dropping) {
            try {
              const record = JSON.parse(data.subarray(start, idx).toString('utf8'));
              const at = Date.parse(record.timestamp);
              this.consume(record, state, !initial || at >= this.startedAt);
            } catch { /* Only complete structured events are authoritative. */ }
          }
          state.dropping = false; start = idx + 1;
        }
        state.partial = data.subarray(start);
        if (state.partial.length > 8 * 1024 * 1024) { state.partial = Buffer.alloc(0); state.dropping = true; }
      }
    } catch (err) { if (err.code !== 'ENOENT') { this.coverage.error = '部分会话记录暂时无法读取，将自动重试。'; this.emit('changed'); } }
    finally {
      await handle?.close(); state.busy = false;
      if (this.pendingFiles.delete(file)) this.readFile(file).catch(() => {});
    }
  }
  async discover(dir, initial = false) {
    let entries; try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (this.closed) return;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await this.discover(p, initial);
      else if (e.name.endsWith('.jsonl')) {
        const stat = await fs.stat(p).catch(() => null);
        // Historical inactive sessions need no replay; an append is discovered by recursive watch.
        if (stat && (stat.mtimeMs >= this.startedAt - 86400000 || this.files.has(p))) await this.readFile(p, !this.files.has(p) && initial);
      }
    }
  }
  async readHooks() {
    if (this.hookBusy || this.closed) return;
    this.hookBusy = true;
    try {
      const dir = path.join(this.home, 'jinkra', 'events');
      const names = (await fs.readdir(dir).catch(() => [])).filter(n => n.endsWith('.json')).sort();
      for (const name of names) {
        if (this.hookSeen.has(name)) continue;
        let event; try { event = JSON.parse(await fs.readFile(path.join(dir, name), 'utf8')); } catch { continue; }
        this.hookSeen.add(name);
        // Remove only bridge-owned old spool entries, never Codex files.
        if (event.at < Date.now() - 7 * 86400000) { await fs.unlink(path.join(dir, name)).catch(() => {}); continue; }
        if (!event.threadId || event.at < this.startedAt) continue;
        const prior = this.tasks.get(event.threadId);
        if (event.kind === 'PermissionRequest') {
          this.task(event.threadId, { state: 'approval', turnId: event.turnId, cwd: event.cwd, updatedAt: event.at, pending: event });
          this.alert({ threadId: event.threadId, turnId: event.turnId, kind: 'approval', detail: event.detail, requestId: event.id });
        } else if (event.kind === 'PostToolUse' && prior?.pending && prior.turnId === event.turnId && prior.pending.tool === event.tool) {
          this.task(event.threadId, { state: 'active', pending: null, updatedAt: event.at });
        }
      }
    } finally { this.hookBusy = false; }
  }
  async start() {
    const root = path.join(this.home, 'sessions'); await fs.mkdir(root, { recursive: true });
    try {
      this.watcher = watch(root, { recursive: true }, (_, name) => {
        if (!name?.endsWith('.jsonl')) return;
        const file = path.join(root, name);
        clearTimeout(this.watchTimers?.get(file)); this.watchTimers ||= new Map();
        this.watchTimers.set(file, setTimeout(() => { this.watchTimers.delete(file); this.readFile(file).catch(() => {}); }, 120));
      });
      this.watcher.on('error', () => { this.coverage.error = '实时文件监听断开，正在使用定时扫描。'; this.emit('changed'); });
      this.coverage.watching = true;
    } catch { this.coverage.error = '当前环境使用定时扫描，提醒可能稍有延迟。'; }
    await this.discover(root, true); await this.readHooks();
    this.coverage.discovered = this.files.size; this.emit('changed');
    this.scanTimer = setInterval(async () => {
      if (this.scanning) return; this.scanning = true;
      try { await this.discover(root); this.coverage.discovered = this.files.size; await this.readHooks(); }
      finally { this.scanning = false; this.emit('changed'); }
    }, 15000);
    this.hookTimer = setInterval(() => this.readHooks().catch(() => {}), 750);
  }
  close() { this.closed = true; this.watcher?.close(); clearInterval(this.scanTimer); clearInterval(this.hookTimer); for (const t of this.watchTimers?.values() || []) clearTimeout(t); }
}
module.exports = { TaskMonitor };
