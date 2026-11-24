// Claude mode: drives Claude Code through the official Claude Agent SDK (@anthropic-ai/claude-agent-sdk).
// One long-lived query in streaming-input mode per conversation, so follow-up messages, interrupts and
// model/permission changes go to the same session. Every tool call that needs permission (and every
// question Claude asks) is routed to the app through canUseTool, and stays pending until the user decides.
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

let sdkPromise;
function loadSdk() {
  sdkPromise ??= import('@anthropic-ai/claude-agent-sdk');
  return sdkPromise;
}

const MODELS = [
  { id: '', label: '跟随 Claude Code 设置' },
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5' },
  { id: 'claude-fable-5-2', label: 'Claude Fable 5.2' },
];
const PERMISSION_MODES = [
  { id: 'default', label: '逐项审批', hint: '需要权限的操作都由你在小金弹窗里批准' },
  { id: 'acceptEdits', label: '自动接受编辑', hint: '文件修改自动通过，命令等仍需批准' },
  { id: 'plan', label: '只规划不执行', hint: 'Claude 只读代码并给出方案，不做修改' },
];

function summarizeTool(name, input = {}) {
  const pick = (...keys) => keys.map(key => input[key]).find(value => typeof value === 'string' && value.trim());
  const short = (text, max = 160) => { const value = String(text || '').replace(/\s+/g, ' ').trim(); return value.length > max ? `${value.slice(0, max)}…` : value; };
  switch (name) {
    case 'Bash': return { icon: 'terminal', label: '运行命令', detail: short(pick('command'), 220) };
    case 'Read': return { icon: 'file-text', label: '读取文件', detail: short(pick('file_path', 'path')) };
    case 'Write': return { icon: 'file-plus', label: '写入文件', detail: short(pick('file_path', 'path')) };
    case 'Edit': case 'MultiEdit': return { icon: 'file-pen', label: '修改文件', detail: short(pick('file_path', 'path')) };
    case 'Glob': return { icon: 'folder-search', label: '查找文件', detail: short(pick('pattern')) };
    case 'Grep': return { icon: 'search', label: '搜索内容', detail: short(pick('pattern')) };
    case 'WebFetch': return { icon: 'globe', label: '读取网页', detail: short(pick('url')) };
    case 'WebSearch': return { icon: 'globe', label: '网络搜索', detail: short(pick('query')) };
    case 'TodoWrite': return { icon: 'list-checks', label: '更新待办', detail: '' };
    case 'Task': case 'Agent': return { icon: 'bot', label: '子任务', detail: short(pick('description', 'prompt')) };
    default: return { icon: 'wrench', label: name, detail: short(JSON.stringify(input), 160) };
  }
}

class ClaudeAgent extends EventEmitter {
  constructor() {
    super();
    this.query = null; this.queue = []; this.wake = null; this.closed = true;
    this.pending = new Map(); this.sessionId = null; this.model = ''; this.cwd = ''; this.busy = false;
    this.nextRequest = 1; this.options = { model: '', permissionMode: 'default' };
  }

  async ensure({ cwd, model, permissionMode, resume }) {
    if (this.query && !this.closed && this.cwd === cwd && !resume) {
      if ((model || '') !== (this.options.model || '')) await this.query.setModel(model || undefined).catch(() => {});
      if (permissionMode !== this.options.permissionMode) await this.query.setPermissionMode(permissionMode).catch(() => {});
      this.options = { model, permissionMode };
      return;
    }
    await this.close();
    const { query } = await loadSdk();
    this.cwd = cwd; this.options = { model, permissionMode }; this.closed = false; this.queue = [];
    const self = this;
    async function* input() {
      while (!self.closed) {
        if (self.queue.length) yield self.queue.shift();
        else await new Promise(resolve => { self.wake = resolve; });
      }
    }
    const options = {
      cwd, permissionMode, includePartialMessages: true,
      canUseTool: (toolName, toolInput, context) => this.askPermission(toolName, toolInput, context),
    };
    if (model) options.model = model;
    if (resume) options.resume = resume;
    this.query = query({ prompt: input(), options });
    this.pump(this.query);
  }

  async pump(q) {
    const texts = new Map(); // assistant message id -> streamed text
    try {
      for await (const message of q) {
        if (q !== this.query) break;
        if (message.type === 'system' && message.subtype === 'init') {
          this.sessionId = message.session_id; this.model = message.model;
          this.emit('init', { sessionId: message.session_id, model: message.model, cwd: message.cwd, permissionMode: message.permissionMode });
        } else if (message.type === 'stream_event' && !message.parent_tool_use_id) {
          const event = message.event;
          if (event?.type === 'message_start') { texts.set('current', event.message?.id); }
          if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
            const id = texts.get('current') || 'stream';
            texts.set(id, (texts.get(id) || '') + event.delta.text);
            this.emit('text', { id, text: texts.get(id) });
          }
        } else if (message.type === 'assistant') {
          const blocks = message.message?.content || [];
          const text = blocks.filter(block => block.type === 'text').map(block => block.text).join('');
          if (text && !message.parent_tool_use_id) this.emit('text', { id: message.message.id, text, final: true });
          for (const block of blocks) {
            if (block.type === 'tool_use') this.emit('tool', { id: block.id, name: block.name, sub: Boolean(message.parent_tool_use_id), ...summarizeTool(block.name, block.input) });
          }
        } else if (message.type === 'user') {
          const blocks = Array.isArray(message.message?.content) ? message.message.content : [];
          for (const block of blocks) {
            if (block.type === 'tool_result') this.emit('tool-done', { id: block.tool_use_id, error: Boolean(block.is_error) });
          }
        } else if (message.type === 'result') {
          this.busy = false;
          this.emit('result', {
            subtype: message.subtype, error: Boolean(message.is_error), text: typeof message.result === 'string' ? message.result : '',
            cost: Number(message.total_cost_usd) || 0, usage: message.usage || {}, durationMs: message.duration_ms || 0, turns: message.num_turns || 0,
          });
        }
      }
    } catch (error) {
      if (q === this.query) { this.busy = false; this.emit('failure', error); }
    } finally {
      if (q === this.query) { this.closed = true; this.query = null; this.denyAll('会话已结束。'); this.busy = false; this.emit('closed'); }
    }
  }

  askPermission(toolName, toolInput, context = {}) {
    const id = `claude-${this.nextRequest++}`;
    return new Promise(resolve => {
      const entry = { id, toolName, input: toolInput, resolve };
      this.pending.set(id, entry);
      context.signal?.addEventListener?.('abort', () => {
        if (this.pending.delete(id)) { resolve({ behavior: 'deny', message: '请求已取消。' }); this.emit('request-closed', id); }
      });
      if (toolName === 'AskUserQuestion') {
        const questions = (toolInput.questions || []).map((question, index) => ({
          id: `q${index}`, question: question.question, header: question.header,
          options: (question.options || []).map(option => ({ label: option.label, description: option.description })),
          multiSelect: Boolean(question.multiSelect),
        }));
        this.emit('question', { id, questions });
      } else {
        this.emit('permission', { id, toolName, reason: context.decisionReason || '', ...summarizeTool(toolName, toolInput) });
      }
    });
  }

  reply(id, decision) {
    const entry = this.pending.get(id);
    if (!entry) throw new Error('请求已失效。');
    this.pending.delete(id);
    if (entry.toolName === 'AskUserQuestion') {
      if (!decision.answers) entry.resolve({ behavior: 'deny', message: '用户没有回答这个问题。' });
      else {
        const answers = {};
        (entry.input.questions || []).forEach((question, index) => { answers[question.question] = decision.answers[`q${index}`] || ''; });
        entry.resolve({ behavior: 'allow', updatedInput: { ...entry.input, answers } });
      }
    } else if (decision.accept) entry.resolve({ behavior: 'allow', updatedInput: entry.input });
    else entry.resolve({ behavior: 'deny', message: decision.message || '用户拒绝了这个操作。' });
    this.emit('request-closed', id);
  }

  denyAll(message) {
    for (const [id, entry] of this.pending) { entry.resolve({ behavior: 'deny', message }); this.emit('request-closed', id); }
    this.pending.clear();
  }

  send(text) {
    if (!this.query || this.closed) throw new Error('Claude 会话尚未启动。');
    this.busy = true;
    this.queue.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: this.sessionId || '' });
    this.wake?.(); this.wake = null;
  }

  async interrupt() {
    this.denyAll('任务已中断。');
    if (this.query) await this.query.interrupt().catch(() => {});
  }

  async close() {
    this.denyAll('会话已关闭。');
    const q = this.query;
    this.query = null; this.closed = true; this.busy = false; this.sessionId = null;
    this.wake?.(); this.wake = null;
    if (q) { try { q.close(); } catch { /* already finished */ } }
  }
}

// Recent Claude Code sessions on this machine (~/.claude/projects/<project>/<session>.jsonl).
function listSessions(limit = 40, home = path.join(os.homedir(), '.claude')) {
  const root = path.join(home, 'projects');
  let files = [];
  try {
    for (const dir of fs.readdirSync(root, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      for (const name of fs.readdirSync(path.join(root, dir.name))) {
        if (!name.endsWith('.jsonl')) continue;
        const file = path.join(root, dir.name, name);
        try { files.push({ file, mtime: fs.statSync(file).mtimeMs }); } catch { /* raced with deletion */ }
      }
    }
  } catch { return []; }
  files.sort((a, b) => b.mtime - a.mtime);
  const sessions = [];
  for (const { file, mtime } of files.slice(0, limit * 2)) {
    let fd;
    try {
      fd = fs.openSync(file, 'r');
      const buffer = Buffer.alloc(96 * 1024);
      const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
      let title = '', cwd = '', sessionId = path.basename(file, '.jsonl');
      for (const line of buffer.subarray(0, read).toString('utf8').split('\n')) {
        if (!line.trim()) continue;
        let entry; try { entry = JSON.parse(line); } catch { continue; }
        cwd ||= entry.cwd || '';
        if (entry.sessionId) sessionId = entry.sessionId;
        if (!title && entry.type === 'user' && !entry.isMeta) {
          const content = entry.message?.content;
          const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter(b => b.type === 'text').map(b => b.text).join(' ') : '';
          if (text && !/^(<(command|local-command|system)|Unknown skill|Caveat:)/.test(text.trim())) title = text.replace(/\s+/g, ' ').trim().slice(0, 120);
        }
        if (title && cwd) break;
      }
      if (title) sessions.push({ id: sessionId, title, cwd, updatedAt: mtime });
    } catch { /* unreadable session file */ } finally { if (fd !== undefined) fs.closeSync(fd); }
    if (sessions.length >= limit) break;
  }
  return sessions;
}

module.exports = { ClaudeAgent, listSessions, summarizeTool, loadSdk, MODELS, PERMISSION_MODES };
