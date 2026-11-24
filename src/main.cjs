const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, screen, dialog, shell, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { CodexClient } = require('./codex.cjs');
const { TaskMonitor } = require('./monitor.cjs');
const { Store, getCosts } = require('./store.cjs');
const { createPetMotion } = require('./pet-motion.cjs');
const { installHooks } = require('./hooks.cjs');
const { listenForApprovals } = require('./pet-approvals.cjs');
const { ClaudeAgent, listSessions, MODELS, PERMISSION_MODES } = require('./claude.cjs');
const { activate, activationState, loadActivation } = require('./release/activation.cjs');
const { checkUpdate, getReleaseNotes, getUpdateError, installUpdate, cleanCompletedUpdate } = require('./release/updater.cjs');

const ROOT = path.join(__dirname, '..');
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const TEST = process.argv.includes('--jinkra-test');
const AUTOSTARTED = process.argv.includes('--autostart');
// Login item: the packaged exe (or, in development, Electron with this project) started with --autostart.
const LOGIN_ARGS = app.isPackaged ? ['--autostart'] : [path.join(__dirname, '..'), '--autostart'];
const loginItem = () => { try { return app.getLoginItemSettings({ path: process.execPath, args: LOGIN_ARGS }).openAtLogin; } catch { return false; } };
const BRAND = path.join(__dirname, 'ui', 'brand');
const APP_ICON = path.join(BRAND, 'icon.ico');
if (TEST) app.setPath('userData', path.join(ROOT, 'test-results', 'user-data'));
let testCursor;
let pet, petMotion, panel, tray, monitor, store, client, approvalBridge, quitting = false, stateTimer, refreshTimer;
let connection = { connected: false }, quota = null, costs = null, hookStatus = { installed: false, trusted: false };
let ownThread = null, ownTurn = null, busy = false, messages = [], alerts = [], chatRequests = [], selectedTask = null, selectedPage = null, navigationVersion = 0;
// Claude mode (Claude Agent SDK): its own conversation, activity and usage, shown when settings.agentMode === 'claude'.
const claude = new ClaudeAgent();
let claudeView = { messages: [], busy: false, sessionId: null, model: '', title: '', error: '', lastResult: null, startedAt: 0 };
let claudeSessions = [], claudeSessionsAt = 0;
let codexModels = []; // from the app-server's model/list

function snapshot() {
  return { settings: { ...store.public(), autostart: TEST ? Boolean(store.data.autostart) : loginItem() }, connection, quota, costs, hookStatus, ownThread, ownTurn, busy,
    messages: messages.slice(-100), alerts, chatRequests, externalRequests: approvalBridge?.list() || [], selectedTask, selectedPage, navigationVersion,
    tasks: monitor.snapshot(), coverage: monitor.coverage, version: app.getVersion(),
    mode: store.data.agentMode === 'claude' ? 'claude' : 'codex',
    claude: { ...claudeView, messages: claudeView.messages.slice(-160) }, claudeSessions,
    claudeOptions: { models: MODELS, permissionModes: PERMISSION_MODES }, claudeUsage: store.data.claudeUsage || null, codexModels };
}
function publish() {
  clearTimeout(stateTimer); stateTimer = setTimeout(() => {
    alerts = alerts.filter(event => {
      if (!['approval', 'input'].includes(event.kind)) return true;
      if (approvalBridge?.list().some(request => request.id === event.requestId)
        || chatRequests.some(request => String(request.id) === event.requestId)) return true;
      const task = monitor.tasks.get(event.threadId);
      return !task || ['approval', 'input', 'unknown'].includes(task.state);
    });
    const data = snapshot();
    tray?.setToolTip(`小金同学 · ${data.mode === 'claude' ? 'Claude' : 'Codex'} 模式${busy || claudeView.busy ? ' · 正在处理任务' : ''}`);
    for (const win of [pet, panel]) if (win && !win.isDestroyed()) win.webContents.send('state', data);
  }, 60);
}
function addAlert(event) {
  if (alerts.some(a => a.id === event.id)) return;
  alerts.push(event); alerts = alerts.slice(-100);
  if (!store.data.muted) {
    pet?.showInactive();
  }
  publish();
}
function message(role, text) {
  messages.push({ id: `${Date.now()}-${Math.random()}`, role, text }); messages = messages.slice(-100); publish();
}
async function refreshCosts() {
  costs = await getCosts(store.key());
  const budget = Number(store.data.budget);
  const day = new Date().toLocaleDateString('sv-SE');
  if (budget > 0 && costs.currency === 'usd' && costs.total >= budget && store.data.budgetAlertDay !== day) {
    addAlert({ id: `budget-${day}`, title: `最近 30 天 USD ${costs.total.toFixed(2)}`, message: 'API 费用达到你设定的阈值了。', kind: 'budget', at: Date.now() });
    store.save({ budgetAlertDay: day });
  }
  publish(); return costs;
}
function checkRenewal() {
  if (!store.data.renewalDate) return;
  const day = new Date().toLocaleDateString('sv-SE');
  if (day === store.data.renewalDate && store.data.renewalAlertDate !== day) {
    addAlert({ id: `renewal-${day}`, title: store.data.subscriptionAmount || '你记录的 ChatGPT 订阅', message: '今天是你记录的订阅续费日。', kind: 'renewal', at: Date.now() });
    store.save({ renewalAlertDate: day });
  }
}
function clampBounds(bounds) {
  const displays = screen.getAllDisplays();
  const fits = displays.some(d => bounds.x + bounds.width > d.workArea.x + 40 && bounds.x < d.workArea.x + d.workArea.width - 40 && bounds.y + bounds.height > d.workArea.y + 40 && bounds.y < d.workArea.y + d.workArea.height - 40);
  const area = screen.getDisplayMatching(bounds).workArea;
  return { ...bounds, x: fits ? Math.max(area.x - bounds.width + 60, Math.min(area.x + area.width - 60, bounds.x)) : area.x + area.width - bounds.width - 20,
    y: fits ? Math.max(area.y, Math.min(area.y + area.height - 60, bounds.y)) : area.y + area.height - bounds.height - 20 };
}
function petSize() { const s = store.data.petScale || 1; return { width: Math.round(300 * s), height: Math.round(450 * s) }; }
function secureWindow(win) {
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', e => e.preventDefault());
  win.webContents.session.setPermissionRequestHandler((_, __, callback) => callback(false));
}
function createPet() {
  const size = petSize(), area = screen.getPrimaryDisplay().workArea;
  const bounds = clampBounds({ ...size, x: store.data.petX ?? area.x + area.width - size.width - 30, y: store.data.petY ?? area.y + area.height - size.height - 15 });
  pet = new BrowserWindow({ ...bounds, frame: false, transparent: true, resizable: false, skipTaskbar: true, alwaysOnTop: store.data.alwaysOnTop !== false,
    hasShadow: false, show: false, backgroundColor: '#00000000', title: '小金同学', icon: APP_ICON,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, devTools: !app.isPackaged } });
  petMotion = createPetMotion(pet, screen, patch => store.save(patch),
    () => testCursor || screen.getCursorScreenPoint());
  petMotion.restore(store.data.petEdge || 'free');
  secureWindow(pet); pet.loadFile(path.join(__dirname, 'ui', 'pet.html'));
  pet.once('ready-to-show', () => pet.showInactive());
  pet.on('close', e => { if (!quitting) { e.preventDefault(); pet.hide(); } });
}
function showPanel(threadId) {
  if (threadId) {
    selectedPage = threadId === 'usage' ? 'usage' : null;
    selectedTask = selectedPage ? null : threadId; navigationVersion++;
  }
  if (!panel || panel.isDestroyed()) {
    panel = new BrowserWindow({ width: 1020, height: 760, minWidth: 760, minHeight: 600, show: false, title: '小金同学 · 工作台', backgroundColor: '#edf5f9', autoHideMenuBar: true, icon: APP_ICON,
      titleBarStyle: 'hidden', titleBarOverlay: { color: '#edf5f9', symbolColor: '#395c72', height: 38 },
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, devTools: !app.isPackaged } });
    secureWindow(panel); panel.loadFile(path.join(__dirname, 'ui', 'panel.html'));
    panel.once('ready-to-show', () => { panel.show(); panel.focus(); });
    panel.on('closed', () => { panel = null; });
  } else { panel.show(); panel.focus(); }
  publish();
}
// Every version needs its activation code before the pet or workbench starts.
function requireActivation() {
  return new Promise((resolve) => {
    const win = new BrowserWindow({ width: 1000, height: 700, minWidth: 560, minHeight: 560, title: '小金同学', icon: APP_ICON,
      backgroundColor: '#f0f5fc', autoHideMenuBar: true, show: false,
      webPreferences: { preload: path.join(__dirname, 'activation-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, devTools: !app.isPackaged } });
    win.removeMenu();
    secureWindow(win);
    const owns = event => event.sender === win.webContents;
    ipcMain.handle('activation:state', event => { if (!owns(event)) throw new Error('请求来源无效。'); return activationState(); });
    ipcMain.handle('activation:submit', async (event, code) => {
      if (!owns(event)) throw new Error('请求来源无效。');
      const result = await activate(code);
      setTimeout(() => { if (!win.isDestroyed()) win.destroy(); }, 500);
      return result;
    });
    win.on('closed', () => {
      ipcMain.removeHandler('activation:state'); ipcMain.removeHandler('activation:submit');
      if (activationState().active) resolve(); else { quitting = true; app.quit(); }
    });
    win.loadFile(path.join(__dirname, 'ui', 'activation.html'));
    win.once('ready-to-show', () => { win.show(); win.focus(); });
  });
}
function openCodex(id) {
  if (id && !/^[a-f\d-]{36}$/i.test(id)) throw new Error('任务 ID 无效。');
  return shell.openExternal(id ? `codex://threads/${id}` : 'codex://');
}
function showMenu() {
  Menu.buildFromTemplate([
    { label: '小金同学', enabled: false, icon: nativeImage.createFromPath(path.join(BRAND, 'tray-16.png')) },
    { type: 'separator' },
    { label: '打开小金工作台', click: () => showPanel() },
    { label: store.data.muted ? '恢复气泡提醒' : '勿扰模式', click: () => { store.save({ muted: !store.data.muted }); publish(); } },
    { label: '把小金移回屏幕右下角', click: () => { const a = screen.getPrimaryDisplay().workArea; const s = petSize(); pet.setBounds({ ...s, x: a.x + a.width - s.width - 30, y: a.y + a.height - s.height - 15 }); petMotion.restore('free'); pet.showInactive(); } },
    { type: 'separator' }, { label: '退出小金同学', click: () => { quitting = true; app.quit(); } },
  ]).popup();
}
async function refreshAccount() {
  await client.connect();
  const results = await Promise.allSettled([
    client.call('account/rateLimits/read', {}), client.call('hooks/list', { cwds: [store.data.cwd || os.homedir()] }),
    client.call('model/list', {}),
  ]);
  if (results[2].status === 'fulfilled') {
    codexModels = (results[2].value.data || []).filter(m => !m.hidden).map(m => ({
      id: m.model || m.id, label: m.displayName || m.model || m.id, description: m.description || '', isDefault: Boolean(m.isDefault),
      efforts: (m.supportedReasoningEfforts || []).map(e => e.reasoningEffort).filter(Boolean), defaultEffort: m.defaultReasoningEffort || '',
    }));
  }
  if (results[0].status === 'fulfilled') quota = { data: results[0].value, source: 'Codex 实时额度', at: Date.now() };
  else connection.quotaError = results[0].reason.message;
  if (results[1].status === 'fulfilled') {
    const entries = results[1].value.data.flatMap(e => e.hooks || []).filter(h => h.command?.includes('jinkra') && h.eventName.toLowerCase() === 'permissionrequest');
    hookStatus = { installed: entries.length > 0, trusted: entries.length > 0 && entries.every(h => h.enabled && ['trusted', 'managed'].includes(h.trustStatus)),
      states: entries.map(h => h.trustStatus), path: path.join(CODEX_HOME, 'hooks.json') };
  }
  publish(); return snapshot();
}
function setupClient() {
  client = new CodexClient();
  client.on('connection', data => { connection = data; if (!data.connected) { busy = false; ownTurn = null; chatRequests = []; } publish(); });
  client.on('notification', ({ method, params: p }) => {
    if (method === 'account/rateLimits/updated') { quota = { data: p, at: Date.now(), source: 'Codex 实时额度' }; }
    if (method === 'item/agentMessage/delta' && p.threadId === ownThread) {
      let last = messages.at(-1);
      if (!last || last.itemId !== p.itemId) { last = { id: p.itemId, itemId: p.itemId, role: 'assistant', text: '' }; messages.push(last); }
      last.text += p.delta || '';
    }
    if (method === 'turn/started' && p.threadId === ownThread) { busy = true; ownTurn = p.turn.id; monitor.task(ownThread, { state: 'active', turnId: ownTurn, updatedAt: Date.now() }); }
    if (method === 'turn/completed') {
      const kind = p.turn.status === 'completed' ? 'completed' : p.turn.status === 'interrupted' ? 'interrupted' : 'failed';
      const result = p.threadId === ownThread ? messages.filter(item => item.role === 'assistant').at(-1)?.text || '' : '';
      if (p.threadId === ownThread) { busy = false; ownTurn = null; chatRequests = []; }
      monitor.task(p.threadId, { state: kind, turnId: p.turn.id, updatedAt: Date.now(), pending: null, result });
      monitor.alert({ threadId: p.threadId, turnId: p.turn.id, kind, detail: p.turn.error?.message || '', result });
    }
    if (method === 'serverRequest/resolved') {
      chatRequests = chatRequests.filter(r => String(r.id) !== String(p.requestId));
      alerts = alerts.filter(event => event.requestId !== String(p.requestId));
    }
    if (method === 'error' && p.threadId === ownThread && p.willRetry === false) message('system', p.error?.message || '任务执行出现错误。');
    publish();
  });
  client.on('request', request => {
    const p = request.params || {};
    const supported = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval', 'item/tool/requestUserInput'];
    if (!supported.includes(request.method)) {
      // Unsupported client-owned tools fail explicitly instead of leaving a task waiting forever.
      client.send({ id: request.id, error: { code: -32601, message: '小金暂不支持此交互，请在 Codex 原生客户端执行该任务。' } });
      client.requests.delete(String(request.id)); return;
    }
    chatRequests.push(request);
    monitor.task(p.threadId || ownThread, { state: request.method.includes('requestUserInput') ? 'input' : 'approval', turnId: p.turnId, updatedAt: Date.now(), pending: { detail: p.reason || p.command || '需要你确认' } });
    monitor.alert({ threadId: p.threadId || ownThread, turnId: p.turnId, kind: request.method.includes('requestUserInput') ? 'input' : 'approval', requestId: String(request.id), detail: p.reason || p.command || '' });
    publish();
  });
}
function claudeMessage(patch) {
  const index = claudeView.messages.findIndex(m => m.id === patch.id);
  if (index >= 0) claudeView.messages[index] = { ...claudeView.messages[index], ...patch };
  else { claudeView.messages.push(patch); claudeView.messages = claudeView.messages.slice(-240); }
}
function recordClaudeUsage(cost) {
  const usage = store.data.claudeUsage || { total: 0, turns: 0, days: {} };
  const day = new Date().toLocaleDateString('sv-SE');
  usage.total = (usage.total || 0) + cost; usage.turns = (usage.turns || 0) + 1;
  usage.days = { ...(usage.days || {}), [day]: ((usage.days || {})[day] || 0) + cost };
  const keep = Object.keys(usage.days).sort().slice(-60);
  usage.days = Object.fromEntries(keep.map(key => [key, usage.days[key]]));
  store.save({ claudeUsage: usage });
}
function setupClaude() {
  claude.on('init', info => { claudeView.sessionId = info.sessionId; claudeView.model = info.model; claudeView.error = ''; publish(); });
  claude.on('text', ({ id, text }) => { claudeMessage({ id: `a-${id}`, role: 'assistant', text }); publish(); });
  claude.on('tool', tool => { claudeMessage({ id: `t-${tool.id}`, role: 'tool', ...tool, status: 'running' }); publish(); });
  claude.on('tool-done', ({ id, error }) => { claudeMessage({ id: `t-${id}`, status: error ? 'error' : 'done' }); publish(); });
  claude.on('permission', request => {
    chatRequests.push({ id: request.id, method: 'claude/requestApproval', params: { reason: request.reason || `${request.label}：${request.detail}`, command: request.detail, tool: request.toolName, cwd: store.data.cwd } });
    claudeMessage({ id: `p-${request.id}`, role: 'approval', label: request.label, detail: request.detail, icon: request.icon, status: 'pending' });
    addAlert({ id: `alert-${request.id}`, kind: 'approval', requestId: request.id, title: claudeView.title || 'Claude 任务', message: 'Claude 想执行一个操作，需要你批准。', at: Date.now() });
    publish();
  });
  claude.on('question', request => {
    chatRequests.push({ id: request.id, method: 'claude/requestUserInput', params: { questions: request.questions, cwd: store.data.cwd } });
    claudeMessage({ id: `p-${request.id}`, role: 'approval', label: 'Claude 想问你', detail: request.questions.map(q => q.question).join(' / '), icon: 'message-circle-question', status: 'pending' });
    addAlert({ id: `alert-${request.id}`, kind: 'input', requestId: request.id, title: claudeView.title || 'Claude 任务', message: 'Claude 有问题想问你。', at: Date.now() });
    publish();
  });
  claude.on('request-closed', id => {
    chatRequests = chatRequests.filter(r => String(r.id) !== String(id));
    alerts = alerts.filter(a => a.requestId !== id);
    const card = claudeView.messages.find(m => m.id === `p-${id}`);
    if (card && card.status === 'pending') card.status = 'closed';
    publish();
  });
  claude.on('result', result => {
    claudeView.busy = false; claudeView.lastResult = { ...result, at: Date.now() };
    claudeMessage({ id: `r-${Date.now()}`, role: 'result', ...result, at: Date.now() });
    if (result.cost) recordClaudeUsage(result.cost);
    addAlert({ id: `claude-done-${Date.now()}`, kind: result.error ? 'failed' : 'completed', title: claudeView.title || 'Claude 任务', result: result.text, at: Date.now() });
    claudeSessionsAt = 0; publish();
  });
  claude.on('failure', error => { claudeView.busy = false; claudeView.error = error.message; claudeMessage({ id: `s-${Date.now()}`, role: 'system', text: `Claude 出错：${error.message}` }); publish(); });
  claude.on('closed', () => { claudeView.busy = false; publish(); });
}
async function sendClaude(text, resume) {
  if (claudeView.busy) throw new Error('Claude 正在处理，请先等待完成或点击中断。');
  if (!store.data.cwd || !fs.statSync(store.data.cwd, { throwIfNoEntry: false })?.isDirectory()) throw new Error('请先选择任务工作目录。');
  claudeView.busy = true; claudeView.error = ''; claudeView.startedAt = Date.now();
  if (!claudeView.title) claudeView.title = text.replace(/\s+/g, ' ').slice(0, 90);
  claudeMessage({ id: `u-${Date.now()}`, role: 'user', text });
  publish();
  try {
    await claude.ensure({ cwd: store.data.cwd, model: store.data.claudeModel || '', permissionMode: store.data.claudePermission || 'default', resume });
    claudeView.resumeId = null; // resumed once; later turns continue the live session
    claude.send(text);
  } catch (error) {
    claudeView.busy = false;
    const hint = /not found|ENOENT|binary/i.test(error.message) ? '（找不到 Claude Code 运行文件，请确认已安装并登录 Claude Code）' : '';
    claudeMessage({ id: `s-${Date.now()}`, role: 'system', text: `无法启动 Claude：${error.message}${hint}` });
    publish(); throw error;
  }
}
async function sendChat(text) {
  if (typeof text !== 'string' || !text.trim() || text.length > 50000) throw new Error('请输入 1 至 50000 个字符的任务。');
  if (store.data.agentMode === 'claude') return sendClaude(text.trim(), claudeView.resumeId);
  if (busy) throw new Error('当前任务仍在执行，请先等待完成或点击中断。');
  if (!store.data.cwd || !fs.statSync(store.data.cwd, { throwIfNoEntry: false })?.isDirectory()) throw new Error('请先选择任务工作目录。');
  busy = true; publish();
  try {
    await client.connect();
    if (!ownThread) {
      const result = await client.call('thread/start', { cwd: store.data.cwd, sandbox: 'workspace-write', approvalPolicy: 'on-request', ...(store.data.codexModel ? { model: store.data.codexModel } : {}) });
      ownThread = result.thread.id;
    }
    message('user', text);
    monitor.task(ownThread, { title: text.replace(/\s+/g, ' ').slice(0, 90), cwd: store.data.cwd, updatedAt: Date.now() });
    const result = await client.call('turn/start', { threadId: ownThread, input: [{ type: 'text', text, text_elements: [] }],
      ...(store.data.codexModel ? { model: store.data.codexModel } : {}), ...(store.data.codexEffort ? { effort: store.data.codexEffort } : {}) });
    ownTurn = result.turn.id;
  } catch (err) { busy = false; message('system', err.message); throw err; }
  finally { publish(); }
}
function installIpc() {
  const handlers = {
    state: () => snapshot(),
    'panel:open': (_, id) => showPanel(typeof id === 'string' ? id : undefined),
    'pet:menu': () => showMenu(),
    'pet:reveal': () => pet.show(),
    'pet:always-on-top': (event, value) => {
      if (event.sender !== pet.webContents) throw new Error('请在小金的悬浮菜单中切换置顶。');
      const enabled = value !== false;
      pet.setAlwaysOnTop(enabled);
      store.save({ alwaysOnTop: enabled });
      publish();
      return enabled;
    },
    'pet:interactive': (event, value) => { if (event.sender === pet?.webContents) pet.setIgnoreMouseEvents(!value, { forward: true }); },
    'pet:pose': () => petMotion.pose(),
    'pet:drag-start': event => { if (event.sender === pet.webContents) petMotion.start(); },
    'pet:drag-end': event => { if (event.sender === pet.webContents) petMotion.end(); },
    'alerts:dismiss': (_, id) => { alerts = alerts.filter(a => a.id !== id); publish(); },
    'alerts:clear': () => { alerts = alerts.filter(event => ['approval', 'input'].includes(event.kind)); publish(); },
    'chat:send': (_, text) => sendChat(text),
    'pet:approval-reply': (event, data) => {
      if (event.sender !== pet.webContents) throw new Error('请在小金的审批卡中处理。');
      approvalBridge.reply(data?.id, data?.decision);
    },
    'chat:new': async () => {
      if (store.data.agentMode === 'claude') {
        if (claudeView.busy) throw new Error('请先结束当前任务。');
        await claude.close(); claudeView = { messages: [], busy: false, sessionId: null, model: '', title: '', error: '', lastResult: null, startedAt: 0 }; publish(); return;
      }
      if (busy) throw new Error('请先结束当前任务。'); ownThread = null; ownTurn = null; messages = []; publish();
    },
    'chat:interrupt': async () => {
      if (store.data.agentMode === 'claude') { await claude.interrupt(); claudeView.busy = false; publish(); return; }
      if (ownThread && ownTurn) await client.call('turn/interrupt', { threadId: ownThread, turnId: ownTurn });
    },
    'mode:set': (_, mode) => { store.save({ agentMode: mode === 'claude' ? 'claude' : 'codex' }); publish(); return store.public(); },
    'claude:options': async (_, data) => {
      const patch = {};
      if (typeof data?.model === 'string' && MODELS.some(m => m.id === data.model)) patch.claudeModel = data.model;
      if (typeof data?.permissionMode === 'string' && PERMISSION_MODES.some(m => m.id === data.permissionMode)) patch.claudePermission = data.permissionMode;
      store.save(patch);
      if (claude.query) await claude.ensure({ cwd: claude.cwd, model: store.data.claudeModel || '', permissionMode: store.data.claudePermission || 'default' }).catch(() => {});
      publish(); return store.public();
    },
    'codex:options': (_, data) => {
      const patch = {};
      if (typeof data?.model === 'string' && (data.model === '' || codexModels.some(m => m.id === data.model))) {
        patch.codexModel = data.model;
        const model = codexModels.find(m => m.id === data.model);
        if (model && store.data.codexEffort && !model.efforts.includes(store.data.codexEffort)) patch.codexEffort = '';
      }
      if (typeof data?.effort === 'string' && /^[a-z]{0,16}$/.test(data.effort)) patch.codexEffort = data.effort;
      store.save(patch); publish(); return store.public();
    },
    'claude:sessions': (_, force) => { if (force === true || Date.now() - claudeSessionsAt > 15000) { claudeSessions = listSessions(40); claudeSessionsAt = Date.now(); } publish(); return claudeSessions; },
    'claude:resume': async (_, id) => {
      const session = claudeSessions.find(s => s.id === id);
      if (!session) throw new Error('找不到这个 Claude 会话。');
      if (claudeView.busy) throw new Error('请先结束当前任务。');
      await claude.close();
      if (session.cwd && fs.statSync(session.cwd, { throwIfNoEntry: false })?.isDirectory()) store.save({ cwd: session.cwd });
      store.save({ agentMode: 'claude' });
      claudeView = { messages: [{ id: `s-${Date.now()}`, role: 'system', text: `已接上会话「${session.title}」。发送消息即可继续。` }], busy: false, sessionId: session.id, model: '', title: session.title, error: '', lastResult: null, startedAt: 0, resumeId: session.id };
      selectedPage = null; selectedTask = null; navigationVersion++;
      publish();
    },
    'folder:open': () => { if (store.data.cwd) return shell.openPath(store.data.cwd); },
    'chat:reply': async (_, data) => {
      const req = chatRequests.find(r => String(r.id) === String(data?.id)); if (!req) throw new Error('请求已失效。');
      if (req.method.startsWith('claude/')) {
        if (req.method === 'claude/requestUserInput') {
          for (const q of req.params.questions || []) {
            const answer = data.answers?.[q.id];
            if (typeof answer !== 'string' || !answer.trim()) throw new Error('请回答所有问题。');
          }
          claude.reply(req.id, { answers: data.answers });
        } else claude.reply(req.id, { accept: Boolean(data.accept) });
        const card = claudeView.messages.find(m => m.id === `p-${req.id}`);
        if (card) card.status = data.accept || data.answers ? 'allowed' : 'denied';
        publish(); return;
      }
      let result;
      if (req.method === 'item/tool/requestUserInput') {
        result = { answers: {} };
        for (const q of req.params.questions || []) {
          const answer = data.answers?.[q.id]; if (typeof answer !== 'string' || !answer.trim()) throw new Error('请回答所有问题。');
          result.answers[q.id] = { answers: [answer.slice(0, 10000)] };
        }
      } else if (req.method === 'item/permissions/requestApproval') {
        result = { permissions: data.accept ? req.params.permissions : {}, scope: 'turn' };
      } else result = { decision: data.accept ? 'accept' : 'decline' };
      client.reply(req.id, result); chatRequests = chatRequests.filter(r => r !== req);
      alerts = alerts.filter(event => event.requestId !== String(req.id));
      monitor.task(req.params.threadId || ownThread, { state: 'active', pending: null, updatedAt: Date.now() }); publish();
    },
    'folder:choose': async event => { if (busy || claudeView.busy) throw new Error('请先结束当前任务再切换工作区。');
      const parent = event.sender === pet.webContents ? pet : panel;
      const result = await dialog.showOpenDialog(parent, { properties: ['openDirectory'], title: '选择 Codex 工作目录' });
      if (!result.canceled) { store.save({ cwd: result.filePaths[0] }); ownThread = null; messages = []; if (!claudeView.busy) { await claude.close(); claudeView = { ...claudeView, sessionId: null, resumeId: null }; } publish(); } return store.public(); },
    'account:refresh': () => refreshAccount(),
    'costs:refresh': () => refreshCosts(),
    'key:save': (_, value) => { if (typeof value !== 'string' || value.length > 2000) throw new Error('密钥格式不正确。'); store.saveKey(value.trim()); if (!value.trim()) costs = null; publish(); },
    'settings:save': (_, data) => {
      const patch = {};
      if (typeof data?.muted === 'boolean') patch.muted = data.muted;
      if (Number.isFinite(data?.petScale)) patch.petScale = Math.max(.7, Math.min(1.5, data.petScale));
      for (const key of ['petSleep', 'petWave', 'petPinch', 'petDizzy', 'petSulky', 'petFollow']) if (typeof data?.[key] === 'boolean') patch[key] = data[key];
      if (Number.isFinite(data?.petSleepMinutes)) patch.petSleepMinutes = Math.round(Math.max(1, Math.min(240, data.petSleepMinutes)));
      if (Number.isFinite(data?.petSwing)) patch.petSwing = Math.max(.3, Math.min(1.5, data.petSwing));
      if (typeof data?.renewalDate === 'string' && (!data.renewalDate || /^\d{4}-\d{2}-\d{2}$/.test(data.renewalDate))) patch.renewalDate = data.renewalDate;
      for (const key of ['subscriptionAmount', 'budget']) if (typeof data?.[key] === 'string' && data[key].length < 40) patch[key] = data[key];
      if (['codex', 'claude', 'last'].includes(data?.startupMode)) patch.startupMode = data.startupMode;
      if (typeof data?.agentMode === 'string') patch.agentMode = data.agentMode === 'claude' ? 'claude' : 'codex';
      if (typeof data?.autostart === 'boolean') {
        if (!TEST) app.setLoginItemSettings({ openAtLogin: data.autostart, path: process.execPath, args: LOGIN_ARGS });
        patch.autostart = data.autostart;
      }
      store.save(patch); if (patch.petScale) { pet.setBounds({ ...pet.getBounds(), ...petSize() }); petMotion.restore(); } checkRenewal(); publish(); return store.public();
    },
    'hooks:install': async () => {
      let nodePath;
      for (const dir of (process.env.PATH || '').split(path.delimiter)) { const p = path.join(dir.replace(/^"|"$/g, ''), process.platform === 'win32' ? 'node.exe' : 'node'); if (fs.existsSync(p)) { nodePath = p; break; } }
      if (!nodePath) throw new Error('启用全局批准提醒需要 Node.js，请先安装 Node.js。');
      const runtime = path.join(CODEX_HOME, 'jinkra', 'node.exe'); fs.mkdirSync(path.dirname(runtime), { recursive: true });
      if (!fs.existsSync(runtime)) fs.copyFileSync(nodePath, runtime);
      const result = await installHooks(CODEX_HOME, path.join(__dirname, 'hook-bridge.cjs'), runtime);
      hookStatus = { installed: true, trusted: false, path: result.path, states: ['untrusted'] }; publish(); return result;
    },
    'codex:open': (_, id) => openCodex(id),
    'billing:open': () => shell.openExternal('https://platform.openai.com/settings/organization/billing/overview'),
    'hooks:folder': () => shell.openPath(CODEX_HOME),
    'app:quit': () => { quitting = true; app.quit(); },
    'update:check': () => checkUpdate(),
    'update:notes': (_, version) => getReleaseNotes(version),
    'update:error': () => getUpdateError(),
    'update:install': event => installUpdate(progress => { if (!event.sender.isDestroyed()) event.sender.send('update-progress', progress); }),
  };
  if (TEST) {
    handlers['test:alert'] = (_, event) => addAlert({ id: `test-${Date.now()}`, title: '界面测试任务', threadId: '00000000-0000-0000-0000-000000000000', at: Date.now(), ...event });
    handlers['test:cursor'] = (_, cursor) => { testCursor = cursor; };
  }
  for (const [name, handler] of Object.entries(handlers)) ipcMain.handle(name, (event, ...args) => {
    const allowedWindows = [pet, panel].filter(win => win && !win.isDestroyed());
    if (!allowedWindows.some(win => win.webContents === event.sender)) throw new Error('请求来源无效。');
    return handler(event, ...args);
  });
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (!store) return; pet?.showInactive(); showPanel(); });
  app.whenReady().then(async () => {
    app.setAppUserModelId('com.jinkra.companion');
    // Windows takes the taskbar icon from the Start Menu shortcut that carries this app id. Keep the
    // packaged app's own shortcut pointing at itself (and its icon) so a stale one cannot show another icon.
    if (app.isPackaged && process.platform === 'win32') {
      const link = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', '小金同学.lnk');
      if (fs.existsSync(link)) {
        try {
          const current = shell.readShortcutLink(link);
          if (current.target !== process.execPath || current.icon !== process.execPath || current.appUserModelId !== 'com.jinkra.companion') {
            shell.writeShortcutLink(link, 'replace', { target: process.execPath, cwd: path.dirname(process.execPath), icon: process.execPath,
              iconIndex: 0, appUserModelId: 'com.jinkra.companion', description: '小金同学 · AI 编程桌面伙伴' });
          }
        } catch { /* shortcut unreadable; leave it */ }
      }
    }
    await loadActivation();
    if (!TEST && !activationState().active) await requireActivation();
    void cleanCompletedUpdate().catch(() => {});
    store = new Store(app.getPath('userData'), safeStorage);
    if (store.data.startupMode === 'codex' || store.data.startupMode === 'claude') store.save({ agentMode: store.data.startupMode });
    monitor = new TaskMonitor(TEST ? path.join(ROOT, 'test-results', 'codex-home') : CODEX_HOME);
    monitor.on('changed', publish); monitor.on('alert', addAlert);
    monitor.on('quota', value => { if (!quota || value.at > quota.at) { quota = value; publish(); } });
    setupClient(); setupClaude(); createPet(); installIpc();
    approvalBridge = listenForApprovals(monitor.home, {
      canPrompt: () => !store.data.muted && !quitting,
      onRequest(request) {
        monitor.task(request.threadId, { state: 'approval', turnId: request.turnId, cwd: request.cwd,
          updatedAt: Date.now(), pending: request });
        monitor.alert({ threadId: request.threadId, turnId: request.turnId, kind: 'approval', requestId: request.id, detail: request.detail });
        publish();
      },
      onClose(id) {
        alerts = alerts.filter(event => event.requestId !== id);
        for (const task of monitor.tasks.values()) {
          if (task.pending?.id === id) monitor.task(task.id, { state: 'active', pending: null, updatedAt: Date.now() });
        }
        publish();
      },
    });
    const icon = nativeImage.createFromPath(APP_ICON);
    tray = new Tray(icon); tray.setToolTip('小金同学'); tray.on('click', () => showPanel()); tray.on('right-click', showMenu);
    await monitor.start();
    // Started with Windows: stay quietly on the desktop; only a manual first launch opens the workbench.
    if (TEST || (!store.data.welcomed && !AUTOSTARTED)) { showPanel(); store.save({ welcomed: true }); }
    if (!TEST) {
      refreshAccount().catch(err => { connection = { connected: false, error: err.message }; publish(); });
      if (store.public().hasApiKey) refreshCosts().catch(() => {});
      checkRenewal();
      refreshTimer = setInterval(() => {
        refreshAccount().catch(() => {});
        if (store.public().hasApiKey) refreshCosts().catch(() => {});
        checkRenewal();
      }, 5 * 60 * 1000);
    }
    screen.on('display-removed', () => petMotion.restore());
    screen.on('display-metrics-changed', () => petMotion.restore());
  }).catch(err => { dialog.showErrorBox('小金启动失败', err.message); quitting = true; app.quit(); });
  app.on('window-all-closed', () => {});
  app.on('before-quit', () => { quitting = true; approvalBridge?.close(); clearTimeout(stateTimer); clearInterval(refreshTimer); petMotion?.stop(); monitor?.close(); client?.close(); claude.close(); tray?.destroy(); });
}
