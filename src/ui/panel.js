const PET_TOGGLES = [['pet-sleep', 'petSleep'], ['pet-follow', 'petFollow'], ['pet-wave', 'petWave'], ['pet-pinch', 'petPinch'], ['pet-dizzy', 'petDizzy'], ['pet-sulky', 'petSulky']];
const api = window.jinkra;
const $ = id => document.getElementById(id);
let state, currentPage = 'chat', currentTab = 'codex', chosenTask = null, initialized = false, toastTimer, sending = false, iconTimer;
const names = { active: '执行中', approval: '请求批准', input: '等待回答', completed: '已完成', interrupted: '已中断', failed: '失败', unknown: '状态未知' };
const fmt = ms => ms ? new Date(ms).toLocaleString('zh-CN', { hour12: false }) : '暂不可用';
const ago = ms => {
  if (!ms) return '';
  const s = Math.round((Date.now() - ms) / 1000);
  return s < 60 ? '刚刚' : s < 3600 ? `${Math.round(s / 60)} 分钟前` : s < 86400 ? `${Math.round(s / 3600)} 小时前` : `${Math.round(s / 86400)} 天前`;
};
const usd = value => `$${(Number(value) || 0).toFixed((Number(value) || 0) < 1 ? 4 : 2)}`;
const SUGGESTIONS = {
  codex: ['梳理这个项目的结构', '跑一下测试并修复失败', '帮我写一份 README', '检查最近的改动有没有问题'],
  claude: ['先读一遍项目，告诉我它是做什么的', '找出并修复一个 bug', '为改动补上测试', '规划一下下一步怎么做'],
};
const TITLES = {
  chat: { codex: ['交代想法，接下来交给 Codex', '今天一起做点什么？'], claude: ['交代想法，接下来交给 Claude', '今天一起做点什么？'] },
  tasks: ['每个任务的进展，都在这里', '小金正在关注'], usage: ['看清额度，也看清花费', '用量小账本'], settings: ['让小金按你的习惯陪伴', '小金的偏好'],
};

function el(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; }
function icon(name) { const i = document.createElement('i'); i.dataset.lucide = name; i.setAttribute('aria-hidden', 'true'); return i; }
function refreshIcons() { clearTimeout(iconTimer); iconTimer = setTimeout(() => window.lucide?.createIcons(), 0); }
function toast(text, error = false) { $('toast').textContent = text; $('toast').classList.toggle('error', error); $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, error ? 11000 : 5000); }
async function call(name, data) { try { return await api.call(name, data); } catch (err) { toast(err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), true); throw err; } }
function button(text, action, style = 'ghost', iconName) { const b = el('button', style); b.type = 'button'; if (iconName) b.append(icon(iconName)); b.append(text); b.onclick = () => Promise.resolve(action()).catch(() => {}); return b; }
const mode = () => state?.mode || 'codex';

// ------------------------------------------------------------------ navigation
function page(name) {
  if (currentPage !== name) { $(`page-${name}`).scrollTop = 0; currentPage = name; }
  for (const p of document.querySelectorAll('.page')) p.classList.toggle('active', p.id === `page-${name}`);
  for (const b of document.querySelectorAll('nav button')) b.classList.toggle('active', b.dataset.page === name);
  const title = name === 'chat' ? TITLES.chat[mode()] : TITLES[name];
  $('page-caption').textContent = title[0]; $('page-title').textContent = title[1];
  if (name === 'tasks' && currentTab === 'claude') call('claude:sessions').catch(() => {});
}
document.querySelectorAll('nav button').forEach(b => b.onclick = () => page(b.dataset.page));
function tab(name) {
  currentTab = name;
  for (const b of document.querySelectorAll('.tabs button')) b.classList.toggle('active', b.dataset.tab === name);
  for (const p of document.querySelectorAll('.tab-panel')) p.hidden = p.dataset.panel !== name;
  if (name === 'claude') call('claude:sessions').catch(() => {});
}
document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => tab(b.dataset.tab));
document.querySelectorAll('.mode-switch button').forEach(b => b.onclick = () => call('mode:set', b.dataset.mode).catch(() => {}));

// ------------------------------------------------------------------ markdown-lite (DOM only, never innerHTML)
function inline(parent, text) {
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let last = 0, match;
  while ((match = pattern.exec(text))) {
    if (match.index > last) parent.append(text.slice(last, match.index));
    const token = match[0];
    parent.append(token.startsWith('`') ? el('code', '', token.slice(1, -1)) : el('strong', '', token.slice(2, -2)));
    last = match.index + token.length;
  }
  if (last < text.length) parent.append(text.slice(last));
}
function renderRich(container, text) {
  container.replaceChildren();
  const parts = text.split(/```/);
  parts.forEach((part, index) => {
    if (index % 2 === 1) {
      const newline = part.indexOf('\n');
      const lang = newline > -1 ? part.slice(0, newline).trim() : '';
      const code = newline > -1 ? part.slice(newline + 1) : part;
      const block = el('div', 'code');
      const head = el('header'); head.append(el('span', '', lang || '代码'));
      const copy = el('button'); copy.type = 'button'; copy.append(icon('copy'), '复制');
      copy.onclick = () => { navigator.clipboard.writeText(code.replace(/\n$/, '')); copy.lastChild.textContent = '已复制'; setTimeout(() => { copy.lastChild.textContent = '复制'; }, 1400); };
      head.append(copy); block.append(head, el('pre', '', code.replace(/\n$/, '')));
      container.append(block);
      return;
    }
    let list = null;
    for (const raw of part.split('\n')) {
      const line = raw.trimEnd();
      const bullet = line.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)$/);
      if (bullet) {
        const ordered = /^\s*\d/.test(line);
        if (!list || list.tagName !== (ordered ? 'OL' : 'UL')) { list = el(ordered ? 'ol' : 'ul'); container.append(list); }
        const item = el('li'); inline(item, bullet[1]); list.append(item); continue;
      }
      list = null;
      if (!line.trim()) continue;
      const heading = line.match(/^(#{1,4})\s+(.*)$/);
      if (heading) { const h = el(heading[1].length <= 2 ? 'h3' : 'h4'); inline(h, heading[2]); container.append(h); continue; }
      const p = el('p'); inline(p, line); container.append(p);
    }
  });
}

// ------------------------------------------------------------------ chat
function chatMessages() {
  if (mode() === 'claude') return state.claude.messages;
  return state.messages.map(m => ({ ...m, role: m.role }));
}
function renderEmpty(container) {
  const empty = el('div', 'empty-chat');
  const hero = el('div', 'hero'); const img = el('img'); img.src = '../../小金同学-初版立绘.png'; img.alt = ''; hero.append(img);
  const who = mode() === 'claude' ? 'Claude' : 'Codex';
  empty.append(hero, el('div', 'greeting', '嗨，我是小金，把今天的想法交给我吧。'),
    el('p', '', `选好工作目录，告诉我任务。我会交给 ${who} 执行，需要你决定的事情会在桌面上提醒你。`));
  const overview = el('div', 'overview');
  const active = state.tasks.filter(t => ['active', 'approval', 'input'].includes(t.state)).length + (state.claude.busy ? 1 : 0);
  const today = state.claudeUsage?.days?.[new Date().toLocaleDateString('sv-SE')] || 0;
  const quota = quotaRemaining();
  const cards = mode() === 'claude'
    ? [['进行中的任务', String(active)], ['当前模型', claudeModelLabel()], ['今日 Claude 花费', usd(today)]]
    : [['进行中的任务', String(active)], ['当前模型', codexModelLabel()], ['Codex 剩余额度', quota == null ? '—' : `${quota}%`]];
  for (const [label, value] of cards) {
    const card = el('div'); card.append(el('small', '', label), el('strong', '', value)); overview.append(card);
  }
  empty.append(overview);
  container.replaceChildren(empty);
}
function renderMessages() {
  const container = $('messages');
  const list = chatMessages();
  const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 80;
  if (container.dataset.mode !== mode()) { container.replaceChildren(); container.dataset.mode = mode(); }
  if (!list.length) { renderEmpty(container); refreshIcons(); return; }
  container.querySelector('.empty-chat')?.remove();
  const existing = new Map([...container.children].map(node => [node.dataset.id, node]));
  const keep = new Set();
  const busy = mode() === 'claude' ? state.claude.busy : state.busy;
  const lastAssistant = [...list].reverse().find(m => m.role === 'assistant')?.id;
  let added = false;
  for (const m of list) {
    keep.add(m.id);
    let node = existing.get(m.id);
    const signature = JSON.stringify([m.text, m.status, m.detail, m.cost, busy && m.id === lastAssistant]);
    if (node && node.dataset.sig === signature) { container.append(node); continue; }
    const fresh = buildMessage(m, busy && m.id === lastAssistant);
    fresh.dataset.id = m.id; fresh.dataset.sig = signature;
    if (node) node.replaceWith(fresh); else { added = true; }
    container.append(fresh);
  }
  for (const [id, node] of existing) if (!keep.has(id)) node.remove();
  if (atBottom || added) container.scrollTop = container.scrollHeight;
  refreshIcons();
}
function buildMessage(m, typing) {
  const agent = mode() === 'claude' ? 'CLAUDE' : 'CODEX';
  if (m.role === 'tool' || m.role === 'approval') {
    const row = el('div', `tool-row ${m.role === 'approval' ? 'approval' : ''} ${m.status || ''}`);
    row.append(icon(m.icon || 'wrench'), el('b', '', m.label || m.name || '工具'), el('span', '', m.detail || ''));
    const status = { running: '进行中', done: '完成', error: '出错', pending: '等你批准', allowed: '已批准', denied: '已拒绝', closed: '已结束' }[m.status] || '';
    row.append(el('em', '', status));
    if (m.status === 'pending') row.append(button('查看', () => call('pet:reveal'), 'ghost small', 'bell-ring'));
    return row;
  }
  if (m.role === 'result') {
    const row = el('div', 'result-row');
    const u = m.usage || {};
    const tokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    const items = [
      m.error ? `未完成 · ${m.subtype || '出错'}` : '已完成',
      m.durationMs ? `用时 ${(m.durationMs / 1000).toFixed(1)}s` : '',
      m.turns ? `${m.turns} 轮` : '',
      tokens || u.output_tokens ? `输入 ${tokens.toLocaleString()} · 输出 ${(u.output_tokens || 0).toLocaleString()} tokens` : '',
      m.cost ? usd(m.cost) : '',
    ].filter(Boolean);
    items.forEach((text, i) => row.append(el('span', i === 0 && m.error ? 'bad' : '', text)));
    return row;
  }
  const msg = el('article', `msg ${m.role}`);
  const badge = { user: '你', assistant: '金', system: '!' }[m.role] || '·';
  msg.append(el('div', 'who', badge));
  const body = el('div', 'body');
  body.append(el('div', 'role', { user: '你', assistant: `小金 · ${agent}`, system: '提示' }[m.role] || m.role));
  const text = el('div', 'bubble-text');
  if (m.role === 'assistant') renderRich(text, m.text || ''); else text.textContent = m.text || '';
  if (typing) text.classList.add('typing');
  body.append(text); msg.append(body);
  return msg;
}
function renderComposer() {
  const claudeMode = mode() === 'claude';
  const busy = claudeMode ? state.claude.busy : state.busy;
  $('send').disabled = busy || sending;
  $('interrupt').hidden = !busy;
  $('chat-state').textContent = busy ? `${claudeMode ? 'Claude' : 'Codex'} 正在处理，完成后小金会提醒你`
    : claudeMode ? `发送后，由 Claude 在所选目录执行 · ${permissionLabel()}` : `发送后，由 Codex 在所选目录执行${state.settings.codexModel ? ` · ${codexModelItems().find(m => m.id === state.settings.codexModel)?.label || state.settings.codexModel}` : ''}`;
  const box = $('suggestions');
  if (box.dataset.mode !== mode() || box.dataset.empty !== String(!chatMessages().length)) {
    box.dataset.mode = mode(); box.dataset.empty = String(!chatMessages().length);
    box.replaceChildren(...(chatMessages().length ? [] : SUGGESTIONS[mode()]).map(text => {
      const b = el('button', '', text); b.type = 'button';
      b.onclick = () => { $('prompt').value = text; $('prompt').focus(); };
      return b;
    }));
  }
  const bar = $('session-bar');
  const s = state.claude;
  bar.hidden = !(claudeMode && (s.sessionId || s.title));
  if (!bar.hidden) {
    bar.replaceChildren(icon('history'), el('span', '', `${s.title || '当前会话'}${s.model ? ` · ${s.model}` : ''}${s.sessionId ? ` · ${s.sessionId.slice(0, 8)}` : ''}`));
  }
}
function claudeModelLabel() {
  const id = state.settings.claudeModel || '';
  return id ? state.claudeOptions.models.find(m => m.id === id)?.label || id : '跟随设置';
}
function codexModelLabel() {
  const id = state.settings.codexModel || '';
  const models = state.codexModels || [];
  return (id ? models.find(m => m.id === id) : models.find(m => m.isDefault))?.label || (id || '跟随设置');
}
function permissionLabel() {
  const id = state.settings.claudePermission || 'default';
  return state.claudeOptions.permissionModes.find(m => m.id === id)?.label || id;
}
function renderRequests() {
  const requests = $('requests');
  const count = state.chatRequests.length;
  if (requests.dataset.count === String(count)) return;
  requests.dataset.count = String(count);
  requests.replaceChildren();
  if (!count) return;
  const notice = el('div', 'notice warning');
  notice.append(icon('bell-ring'), `有 ${count} 个请求等你处理，审批卡片在小金的气泡里。`, button('查看桌宠', () => call('pet:reveal'), 'ghost small'));
  requests.append(notice);
  refreshIcons();
}
function fillSelect(select, items, value) {
  const key = JSON.stringify(items.map(item => [item.id, item.label]));
  if (select.dataset.items !== key) {
    select.replaceChildren(...items.map(item => new Option(item.label, item.id)));
    select.dataset.items = key;
  }
  if (document.activeElement !== select) select.value = value;
}
const EFFORT_LABELS = { none: '不推理', minimal: '极简', low: '低', medium: '中', high: '高', xhigh: '超高', max: '最高', ultra: '极致' };
function codexModelItems() {
  const models = state.codexModels || [];
  const def = models.find(m => m.isDefault);
  return [{ id: '', label: def ? `默认（${def.label}）` : '跟随 Codex 设置' }, ...models.map(m => ({ id: m.id, label: m.label }))];
}
function codexEffortItems() {
  const models = state.codexModels || [];
  const model = models.find(m => m.id === state.settings.codexModel) || models.find(m => m.isDefault);
  const efforts = model?.efforts?.length ? model.efforts : ['low', 'medium', 'high'];
  const def = model?.defaultEffort;
  return [{ id: '', label: `推理：默认${def ? `（${EFFORT_LABELS[def] || def}）` : ''}` }, ...efforts.map(e => ({ id: e, label: `推理：${EFFORT_LABELS[e] || e}` }))];
}

// ------------------------------------------------------------------ tasks
function renderTasks() {
  const query = $('task-search').value.toLowerCase(), filter = $('task-filter').value;
  const tasks = state.tasks.filter(task => {
    const matchesText = !query || `${task.title} ${task.cwd || ''}`.toLowerCase().includes(query);
    const matchesStatus = filter === 'all' || task.state === filter || (filter === 'failed' && task.state === 'interrupted');
    return matchesText && matchesStatus;
  });
  const list = $('tasks');
  const key = JSON.stringify([chosenTask, tasks.map(({ id, title, cwd, state, updatedAt, result, pending }) => [id, title, cwd, state, updatedAt, result, pending?.detail])]);
  if (list.dataset.key === key) return;
  list.dataset.key = key;
  const focused = document.activeElement?.dataset.taskId;
  list.replaceChildren();
  if (!tasks.length) list.append(el('div', 'empty', '还没有符合条件的任务。Codex 有新活动时会自动显示。'));
  for (const task of tasks) {
    const expanded = task.id === chosenTask;
    const row = el('article', 'task-row');
    const card = el('button', 'task');
    card.type = 'button'; card.dataset.taskId = task.id;
    card.setAttribute('aria-expanded', expanded);
    const glyph = el('span', 'task-icon'); glyph.append(icon('code-xml'));
    const info = el('span', 'task-info');
    info.append(el('span', 'task-title', task.title), el('span', 'task-meta', `${task.cwd || 'Codex'} · ${fmt(task.updatedAt)}`));
    card.append(glyph, info, el('span', `pill ${task.state}`, names[task.state] || task.state), el('span', 'task-chevron', expanded ? '⌃' : '⌄'));
    card.onclick = () => { chosenTask = expanded ? null : task.id; renderTasks(); };
    row.append(card);
    if (expanded) {
      const detail = el('div', 'task-detail');
      detail.append(el('pre', '', task.pending?.detail || task.result || '暂无任务详情。'));
      detail.append(button('在 Codex 中打开', () => call('codex:open', task.id), 'ghost', 'arrow-up-right'));
      row.append(detail);
    }
    list.append(row);
    if (focused === task.id) card.focus({ preventScroll: true });
  }
  refreshIcons();
}
function renderSessions() {
  const query = $('session-search').value.toLowerCase();
  const sessions = (state.claudeSessions || []).filter(s => !query || `${s.title} ${s.cwd}`.toLowerCase().includes(query));
  const list = $('sessions');
  const key = JSON.stringify([query, sessions.map(s => [s.id, s.updatedAt])]);
  if (list.dataset.key === key) return;
  list.dataset.key = key;
  list.replaceChildren();
  if (!sessions.length) { list.append(el('div', 'empty', '还没有读到 Claude Code 会话。用 Claude 做过任务后会出现在这里。')); return; }
  for (const s of sessions) {
    const row = el('article', 'task-row');
    const card = el('div', 'task');
    const glyph = el('span', 'task-icon'); glyph.append(icon('sparkles'));
    const info = el('span', 'task-info');
    info.append(el('span', 'task-title', s.title), el('span', 'task-meta', `${s.cwd || '未知目录'} · ${ago(s.updatedAt)}`));
    card.append(glyph, info, button('在小金里继续', async () => { await call('claude:resume', s.id); page('chat'); }, 'ghost small', 'play'));
    row.append(card); list.append(row);
  }
  refreshIcons();
}

// ------------------------------------------------------------------ usage
function quotaRemaining() {
  const data = state.quota?.data;
  const buckets = data?.rateLimitsByLimitId ? Object.values(data.rateLimitsByLimitId).filter(Boolean) : [data?.rateLimits || data].filter(Boolean);
  const used = buckets.flatMap(b => [b.primary, b.secondary]).filter(Boolean).map(w => Number(w.usedPercent ?? w.used_percent)).filter(Number.isFinite);
  return used.length ? Math.round(Math.max(0, 100 - Math.max(...used))) : null;
}
function renderQuota() {
  const q = state.quota, root = $('quota'); root.replaceChildren();
  $('quota-source').textContent = q ? `${q.source} · 更新于 ${fmt(q.at)}` : state.connection.quotaError || '暂未获取额度，点击刷新连接 Codex。';
  const data = q?.data;
  const buckets = data?.rateLimitsByLimitId ? Object.values(data.rateLimitsByLimitId).filter(Boolean) : [data?.rateLimits || data].filter(Boolean);
  const grid = el('div', 'quota-grid');
  for (const bucket of buckets) {
    for (const [name, window] of [['primary', bucket.primary], ['secondary', bucket.secondary]]) {
      if (!window) continue;
      const used = Number(window.usedPercent ?? window.used_percent); if (!Number.isFinite(used)) continue;
      const duration = window.windowDurationMins ?? window.window_minutes;
      const title = `${bucket.limitName || bucket.limit_name || bucket.limitId || bucket.limit_id || 'Codex'} · ${duration ? duration >= 1440 ? `${Math.round(duration / 1440)} 天窗口` : `${duration / 60} 小时窗口` : name === 'primary' ? '主要窗口' : '次要窗口'}`;
      const card = el('div', 'quota-card'); card.append(el('small', '', title));
      const value = el('strong', '', `${Math.round(Math.max(0, 100 - used))}%`); value.append(el('span', '', '剩余')); card.append(value);
      const track = el('div', 'track'), fill = el('div', `fill ${used >= 85 ? 'warn' : ''}`); fill.style.width = `${Math.max(0, Math.min(100, 100 - used))}%`; track.append(fill); card.append(track);
      const resets = window.resetsAt ?? window.resets_at; card.append(el('p', '', resets ? `${fmt(resets * 1000)} 重置` : '重置时间暂不可用')); grid.append(card);
    }
  }
  if (grid.children.length) root.append(grid); else root.append(el('div', 'notice', '当前账户未返回可显示的额度窗口。请在 Codex 中确认登录状态。'));
  if (state.costs) {
    $('cost-total').textContent = `${state.costs.currency.toUpperCase()} ${state.costs.total.toFixed(2)}`;
    const budget = Number(state.settings.budget);
    $('cost-updated').textContent = `更新于 ${fmt(state.costs.at)}${budget > 0 ? ` · 提醒阈值 USD ${budget}${state.costs.currency === 'usd' && state.costs.total >= budget ? '，已达到阈值' : ''}` : ''}`;
  } else { $('cost-total').textContent = '尚未连接'; $('cost-updated').textContent = '在设置中配置有费用读取权限的 Admin API key'; }
  $('subscription-record').textContent = [state.settings.renewalDate ? `下次续费：${state.settings.renewalDate}` : '', state.settings.subscriptionAmount].filter(Boolean).join(' · ') || '可在设置中手动记录续费日期与金额。';
  renderClaudeUsage(); renderStats();
}
function lastDays(n) {
  const days = [];
  for (let i = n - 1; i >= 0; i--) { const d = new Date(Date.now() - i * 86400000); days.push(d.toLocaleDateString('sv-SE')); }
  return days;
}
function renderClaudeUsage() {
  const u = state.claudeUsage || { total: 0, turns: 0, days: {} };
  const root = $('claude-usage');
  const key = JSON.stringify(u); if (root.dataset.key === key) return; root.dataset.key = key;
  const days = lastDays(7), values = days.map(d => u.days?.[d] || 0), max = Math.max(...values, .0001);
  const summary = el('div', 'claude-summary');
  for (const [label, value] of [['今天', usd(values.at(-1))], ['近 7 天', usd(values.reduce((a, b) => a + b, 0))], ['累计', usd(u.total)], ['任务轮数', String(u.turns || 0)]]) {
    const item = el('div'); item.append(el('small', '', label), el('strong', '', value)); summary.append(item);
  }
  const bars = el('div', 'bars');
  days.forEach((day, i) => {
    const col = el('div'); const bar = el('i'); bar.style.height = `${Math.max(3, values[i] / max * 80)}px`;
    col.append(el('em', '', values[i] ? usd(values[i]) : ''), bar, el('small', '', day.slice(5)));
    bars.append(col);
  });
  root.replaceChildren(summary, bars);
}
function renderStats() {
  const row = $('stat-row');
  const today = state.claudeUsage?.days?.[new Date().toLocaleDateString('sv-SE')] || 0;
  const active = state.tasks.filter(t => ['active', 'approval', 'input'].includes(t.state)).length + (state.claude.busy ? 1 : 0);
  const quota = quotaRemaining();
  const u = state.claudeUsage || {};
  const week = lastDays(7).reduce((sum, d) => sum + (u.days?.[d] || 0), 0);
  const stats = mode() === 'claude' ? [
    ['sparkles', '今日 Claude 花费', usd(today), `累计 ${usd(u.total)}`],
    ['calendar-days', '近 7 天花费', usd(week), `${u.turns || 0} 轮任务`],
    ['cpu', '当前模型', claudeModelLabel(), permissionLabel()],
    ['activity', '进行中的任务', String(active), `${state.chatRequests.length} 个等你批准`],
  ] : [
    ['gauge', 'Codex 剩余额度', quota == null ? '—' : `${quota}%`, state.quota ? `更新于 ${ago(state.quota.at)}` : '等待数据'],
    ['cpu', '当前模型', codexModelLabel(), state.settings.codexEffort ? `推理：${EFFORT_LABELS[state.settings.codexEffort] || state.settings.codexEffort}` : '推理：默认'],
    ['activity', '进行中的任务', String(active), `${state.chatRequests.length} 个等你批准`],
    ['receipt', 'API 费用（30 天）', state.costs ? `${state.costs.currency.toUpperCase()} ${state.costs.total.toFixed(2)}` : '—', state.costs ? `更新于 ${ago(state.costs.at)}` : '未配置'],
  ];
  const key = JSON.stringify(stats); if (row.dataset.key === key) return; row.dataset.key = key;
  row.replaceChildren(...stats.map(([iconName, label, value, sub]) => {
    const card = el('div', 'stat'); const small = el('small'); small.append(icon(iconName), label);
    card.append(small, el('strong', '', value), el('span', '', sub)); return card;
  }));
  refreshIcons();
}

// ------------------------------------------------------------------ main render
function render(next) {
  state = next;
  if (document.body.dataset.mode !== mode()) { document.body.dataset.mode = mode(); tab(mode()); }
  $('reconnect-label').textContent = mode() === 'claude' ? '刷新 Claude 会话' : '重新连接 Codex';
  for (const b of document.querySelectorAll('.mode-switch button')) b.setAttribute('aria-checked', String(b.dataset.mode === mode()));
  $('identity-mode').textContent = mode() === 'claude' ? 'Claude 伙伴' : 'Codex 伙伴';
  $('connection').textContent = state.connection.connected ? '已连接' : state.connection.error ? '未连接' : '正在连接…';
  $('status-codex').classList.toggle('online', state.connection.connected);
  $('status-claude').classList.toggle('busy', state.claude.busy);
  $('status-claude').classList.toggle('online', !state.claude.busy && Boolean(state.claude.sessionId));
  $('claude-status').textContent = state.claude.busy ? '处理中' : state.claude.sessionId ? '会话进行中' : '待命';
  $('cwd').textContent = state.settings.cwd || '先选择一个项目文件夹';
  $('cwd').title = state.settings.cwd || '';
  for (const id of ['codex-model', 'settings-codex-model']) fillSelect($(id), codexModelItems(), state.settings.codexModel || '');
  for (const id of ['codex-effort', 'settings-codex-effort']) fillSelect($(id), codexEffortItems(), state.settings.codexEffort || '');
  fillSelect($('claude-model'), state.claudeOptions.models, state.settings.claudeModel || '');
  fillSelect($('claude-permission'), state.claudeOptions.permissionModes, state.settings.claudePermission || 'default');
  fillSelect($('settings-claude-model'), state.claudeOptions.models, state.settings.claudeModel || '');
  fillSelect($('settings-claude-permission'), state.claudeOptions.permissionModes, state.settings.claudePermission || 'default');
  $('permission-hint').textContent = state.claudeOptions.permissionModes.find(m => m.id === (state.settings.claudePermission || 'default'))?.hint || '';
  $('active-count').textContent = state.tasks.filter(t => ['active', 'approval', 'input'].includes(t.state)).length + (state.claude.busy ? 1 : 0) || '';
  $('coverage').textContent = state.coverage.error || `监听本机当前 CODEX_HOME 的新活动 · 已发现 ${state.coverage.discovered} 份近期会话记录`;
  const trusted = state.hookStatus.trusted;
  const hookText = trusted ? '审批钩子已信任。加载新钩子的会话可以在小金弹窗中处理审批。' : state.hookStatus.installed ? '批准提醒钩子已安装，等待你在 Codex → 设置 → Hooks 中审核信任。完成提醒已经启用。' : '任务完成提醒已经启用。要收到各会话的批准提醒，请在偏好设置中启用全局钩子。';
  for (const id of ['hook-banner', 'hooks-status']) { $(id).textContent = hookText; $(id).classList.toggle('warning', !trusted); }
  if (document.activeElement !== $('autostart')) $('autostart').checked = Boolean(state.settings.autostart);
  $('key-status').textContent = state.settings.hasApiKey ? '密钥已加密保存' : '尚未保存密钥';
  $('version').textContent = `小金同学 v${state.version}`;
  if (!initialized) {
    initialized = true; $('muted').checked = state.settings.muted;
    $('pet-scale').value = state.settings.petScale;
    $('startup-mode').value = state.settings.startupMode || 'codex';
    for (const [id, key] of PET_TOGGLES) $(id).checked = state.settings[key] !== false;
    $('pet-sleep-minutes').value = state.settings.petSleepMinutes ?? 15; $('pet-swing').value = state.settings.petSwing ?? 1;
    $('renewal').value = state.settings.renewalDate; $('subscription').value = state.settings.subscriptionAmount; $('budget').value = state.settings.budget;
  }
  if (state.navigationVersion && state.navigationVersion !== render.lastNavigation) {
    render.lastNavigation = state.navigationVersion;
    if (state.selectedPage) page(state.selectedPage);
    else if (state.selectedTask) { chosenTask = state.selectedTask; page(state.selectedTask === state.ownThread ? 'chat' : 'tasks'); }
    else page('chat');
  }
  if (currentPage === 'chat') page('chat');
  renderMessages(); renderComposer(); renderRequests(); renderTasks(); renderSessions(); renderQuota();
}

// ------------------------------------------------------------------ actions
$('chat-form').onsubmit = async e => {
  e.preventDefault();
  const text = $('prompt').value.trim();
  const busy = mode() === 'claude' ? state.claude.busy : state.busy;
  if (!text || busy || sending) return;
  sending = true; $('send').disabled = true;
  try { await call('chat:send', text); $('prompt').value = ''; } catch {} finally { sending = false; renderComposer(); }
};
$('prompt').onkeydown = e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); $('chat-form').requestSubmit(); } };
$('prompt').oninput = () => { const t = $('prompt'); t.style.height = 'auto'; t.style.height = `${Math.min(200, t.scrollHeight)}px`; };
const actions = {
  'choose-folder': () => call('folder:choose'), 'open-folder': () => call('folder:open'), 'new-chat': () => call('chat:new'), interrupt: () => call('chat:interrupt'),
  reconnect: async () => { if (mode() === 'claude') { await call('claude:sessions', true); toast('Claude 会话列表已刷新。'); } else await call('account:refresh'); }, 'refresh-quota': () => call('account:refresh'), 'refresh-sessions': () => call('claude:sessions'),
  'open-codex': () => call('codex:open'), 'open-billing': () => call('billing:open'), 'clear-alerts': () => call('alerts:clear'),
  'refresh-costs': () => call('costs:refresh'), 'check-hooks': () => call('account:refresh'),
  'install-hooks': async () => { await call('hooks:install'); toast('钩子已安装。请到 Codex 设置 → Hooks 审核信任小金的两项钩子。'); },
  'save-key': async () => { if (!$('api-key').value.trim()) return toast('请先输入 Admin API key。', true); await call('key:save', $('api-key').value); $('api-key').value = ''; toast('密钥已使用 Windows 加密保存。'); },
  'delete-key': async () => { await call('key:save', ''); $('api-key').value = ''; toast('密钥已移除。'); },
  'save-settings': async () => { await call('settings:save', { renewalDate: $('renewal').value, subscriptionAmount: $('subscription').value, budget: $('budget').value }); toast('费用与订阅已保存。'); },
  quit: () => call('app:quit'),
};
for (const [id, action] of Object.entries(actions)) $(id).onclick = async () => { $(id).disabled = true; try { await action(); } catch {} finally { $(id).disabled = false; } };
for (const [select, key] of [['claude-model', 'model'], ['settings-claude-model', 'model'], ['claude-permission', 'permissionMode'], ['settings-claude-permission', 'permissionMode']]) {
  $(select).onchange = () => call('claude:options', { [key]: $(select).value }).then(() => toast(key === 'model' ? 'Claude 模型已切换。' : 'Claude 权限模式已切换。')).catch(() => {});
}
for (const [select, key] of [['codex-model', 'model'], ['settings-codex-model', 'model'], ['codex-effort', 'effort'], ['settings-codex-effort', 'effort']]) {
  $(select).onchange = () => call('codex:options', { [key]: $(select).value }).then(() => toast(key === 'model' ? 'Codex 模型已切换，下一轮生效。' : 'Codex 推理强度已切换。')).catch(() => {});
}
$('startup-mode').onchange = () => call('settings:save', { startupMode: $('startup-mode').value }).then(() => toast('下次启动时生效。')).catch(() => {});
$('autostart').onchange = () => call('settings:save', { autostart: $('autostart').checked }).then(s => toast(s.autostart ? '已开启开机自启。' : '已关闭开机自启。')).catch(() => {});
$('muted').onchange = () => call('settings:save', { muted: $('muted').checked }).catch(() => {});
$('pet-scale').onchange = () => call('settings:save', { petScale: Number($('pet-scale').value) }).catch(() => {});
for (const [id, key] of PET_TOGGLES) $(id).onchange = () => call('settings:save', { [key]: $(id).checked }).catch(() => {});
$('pet-sleep-minutes').onchange = () => call('settings:save', { petSleepMinutes: Number($('pet-sleep-minutes').value) }).catch(() => {});
$('pet-swing').onchange = () => call('settings:save', { petSwing: Number($('pet-swing').value) }).catch(() => {});
$('task-search').oninput = renderTasks; $('task-filter').onchange = renderTasks; $('session-search').oninput = renderSessions;
window.lucide?.createIcons();
api.subscribe(render); api.call('state').then(render);
