const api = window.jinkra;
const $ = id => document.getElementById(id);
window.lucide?.createIcons();
let current, timer, pointer = null, appState, menuTimer, menuAnimationTimer, cardRequest;
const labels = { completed: '这个任务完成啦！', approval: '这里有操作请求批准。', input: '这里需要你回答一下。', failed: '任务遇到了问题。', interrupted: '这个任务已中断。' };
function render(state) {
  appState = state;
  if (typeof petConfigure === 'function') petConfigure(state.settings);
  updatePin(state.settings.alwaysOnTop !== false);
  const requests = [...state.chatRequests, ...state.externalRequests];
  if (cardRequest && !requests.some(request => String(request.id) === cardRequest)) closeCard();
  const pending = state.alerts;
  $('unread').textContent = pending.length ? String(pending.length) : '';
  document.body.classList.toggle('working', state.tasks.some(t => t.state === 'active') || Boolean(state.claude?.busy));
  document.body.classList.toggle('approval', state.tasks.some(t => t.state === 'approval'));
  const event = !state.settings.muted ? pending.find(e => e.kind === 'approval' || e.kind === 'input') || pending[0] : null;
  if (!event) { $('bubble').hidden = true; current = null; clearTimeout(timer); return; }
  if (current?.id === event.id) { $('queue-count').textContent = pending.length > 1 ? `还有 ${pending.length - 1} 条提醒` : ''; return; }
  current = event; if (typeof petReact === 'function') petReact(event.kind); $('dismiss').hidden = ['approval', 'input'].includes(event.kind); $('bubble').hidden = false; $('bubble').classList.toggle('approval', ['approval', 'input'].includes(event.kind));
  $('bubble-text').textContent = event.message || labels[event.kind] || '任务有新进展。';
  const result = String(event.result || '').replace(/\s+/g, ' ').trim();
  $('bubble-task').textContent = event.kind === 'completed' && result
    ? `${result.slice(0, 90)}${result.length > 90 ? '…' : ''}`
    : event.title;
  $('bubble-footer').lastElementChild.textContent = event.kind === 'completed' ? '打开 Codex ↗' : '点击查看 ↗';
  $('queue-count').textContent = pending.length > 1 ? `还有 ${pending.length - 1} 条提醒` : '';
  clearTimeout(timer);
  if (!['approval', 'input'].includes(event.kind)) timer = setTimeout(() => api.call('alerts:dismiss', event.id), 18000);
}
function showCard(title, requestId) {
  cardRequest = requestId;
  $('pet-card-title').textContent = title;
  $('pet-card-content').replaceChildren();
  $('pet-error').hidden = true;
  $('pet-card').hidden = false;
  hideMenu();
  return $('pet-card-content');
}
function closeCard() {
  cardRequest = null;
  $('pet-card').hidden = true;
}
function makeButton(label, action, primary = false) {
  const button = document.createElement('button');
  button.textContent = label;
  if (primary) button.className = 'pet-primary';
  button.onclick = async () => {
    button.disabled = true;
    try { await action(); }
    catch (error) {
      $('pet-error').textContent = error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
      $('pet-error').hidden = false;
    } finally { button.disabled = false; }
  };
  return button;
}
function showApproval(request, event, external) {
  const isQuestion = request.method?.endsWith('requestUserInput');
  const content = showCard(isQuestion ? '小金需要你回答' : '审批请求', String(request.id));
  const params = request.params || request;
  const context = document.createElement('small');
  context.textContent = [event.title, params.cwd, params.tool].filter(Boolean).join(' · ');
  content.append(context);
  if (isQuestion) {
    const fields = new Map();
    for (const question of params.questions || []) {
      const label = document.createElement('label');
      label.textContent = question.question || question.header;
      if (question.options?.length) {
        const options = document.createElement('select');
        options.append(new Option('请选择…', ''));
        for (const option of question.options) options.append(new Option(option.label, option.label));
        options.append(new Option('自己填写…', '__custom'));
        const custom = document.createElement('input');
        custom.hidden = true;
        custom.placeholder = '输入回答';
        options.onchange = () => custom.hidden = options.value !== '__custom';
        label.append(options, custom);
        fields.set(question.id, () => options.value === '__custom' ? custom.value : options.value);
      } else {
        const input = document.createElement('input');
        label.append(input);
        fields.set(question.id, () => input.value);
      }
      content.append(label);
    }
    content.append(makeButton('提交回答', async () => {
      await api.call('chat:reply', { id: request.id, answers: Object.fromEntries([...fields].map(([id, value]) => [id, value()])) });
      closeCard();
    }, true));
    return;
  }
  const detail = document.createElement('pre');
  detail.tabIndex = 0;
  detail.textContent = external ? request.detail : [
    params.reason, params.command, params.grantRoot && `写入范围：${params.grantRoot}`,
    params.permissions && JSON.stringify(params.permissions, null, 2),
    params.networkApprovalContext && JSON.stringify(params.networkApprovalContext, null, 2),
  ].filter(Boolean).join('\n') || 'Codex 请求执行操作。请在原会话查看操作内容。';
  content.append(detail);
  const controls = document.createElement('div');
  controls.className = 'pet-card-buttons';
  const reply = async (accept) => {
    if (external) await api.call('pet:approval-reply', { id: request.id, decision: accept ? 'allow' : 'deny' });
    else await api.call('chat:reply', { id: request.id, accept });
    closeCard();
  };
  controls.append(makeButton('拒绝', () => reply(false)), makeButton('批准本次', () => reply(true), true));
  if (external) controls.append(makeButton('去 Codex 处理', async () => {
    await api.call('pet:approval-reply', { id: request.id, decision: 'defer' });
    await api.call('codex:open', event.threadId);
  }));
  content.append(controls);
}
$('bubble-open').onclick = async () => {
  const event = current;
  if (!event) return;
  try {
    if (event.kind === 'completed' && event.threadId) await api.call('codex:open', event.threadId);
    else if (event.kind === 'approval' || event.kind === 'input') {
      const own = appState.chatRequests.find(request => String(request.id) === event.requestId);
      const external = appState.externalRequests.find(request => request.id === event.requestId);
      if (own || external) { showApproval(own || external, event, Boolean(external)); return; }
      await api.call('codex:open', event.threadId);
    } else await api.call('panel:open', ['budget', 'renewal'].includes(event.kind) ? 'usage' : event.threadId);
    await api.call('alerts:dismiss', event.id);
  } catch (error) {
    showCard('无法打开 Codex').textContent = error.message;
  }
};
$('dismiss').onclick = () => current && !['approval', 'input'].includes(current.kind) && api.call('alerts:dismiss', current.id);
$('pet-card-close').onclick = closeCard;
function showMenu() {
  clearTimeout(menuTimer); clearTimeout(menuAnimationTimer);
  if (!$('pet-card').hidden || pointer?.dragging) return;
  const menu = $('pet-actions');
  menu.hidden = false;
  menu.getBoundingClientRect();
  menu.classList.add('is-open');
}
function hideMenu() {
  clearTimeout(menuAnimationTimer);
  const menu = $('pet-actions');
  menu.classList.remove('is-open');
  menuAnimationTimer = setTimeout(() => {
    if (!menu.classList.contains('is-open')) menu.hidden = true;
  }, 230);
}
function hideMenuSoon() {
  clearTimeout(menuTimer);
  menuTimer = setTimeout(hideMenu, 350);
}
$('nameplate').onclick = showMenu;
for (const node of [$('character'), $('nameplate'), $('pet-actions')]) {
  node.addEventListener('pointerenter', showMenu);
  node.addEventListener('pointerleave', hideMenuSoon);
  node.addEventListener('focusin', showMenu);
  node.addEventListener('focusout', hideMenuSoon);
}
$('pet-workbench').onclick = () => { hideMenu(); api.call('panel:open'); };
$('pet-pin').onclick = async () => {
  const enabled = await api.call('pet:always-on-top', $('pet-pin').getAttribute('aria-pressed') !== 'true');
  updatePin(enabled);
};
function updatePin(enabled) {
  const button = $('pet-pin');
  button.setAttribute('aria-pressed', String(enabled));
  button.setAttribute('aria-label', enabled ? '关闭置顶' : '开启置顶');
  button.dataset.tip = enabled ? '关闭置顶' : '开启置顶';
}
$('pet-send').onclick = () => {
  if (!appState) return;
  const content = showCard('给 Codex 发任务');
  const path = document.createElement('small');
  path.textContent = appState.settings.cwd || '请先选择工作目录';
  const input = document.createElement('textarea');
  input.placeholder = '告诉小金，你想完成什么…';
  input.setAttribute('aria-label', '给 Codex 的任务');
  const controls = document.createElement('div');
  controls.className = 'pet-card-buttons';
  controls.append(makeButton('选择目录', async () => {
    const settings = await api.call('folder:choose');
    path.textContent = settings.cwd || '请先选择工作目录';
  }), makeButton('发送任务', async () => {
    if (!input.value.trim()) throw new Error('请先输入任务。');
    await api.call('chat:send', input.value.trim());
    closeCard();
  }, true));
  content.append(path, input, controls);
  input.focus();
};
document.addEventListener('contextmenu', event => {
  if (event.target.closest('.pet-card')) return;
  event.preventDefault();
  api.call('pet:menu');
});
$('character').addEventListener('keydown', event => {
  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); reactToClick(); showMenu(); }
});
function reactToClick() {
  triggerPetInteraction();
}
const character = $('character');
character.addEventListener('pointerdown', event => {
  if (event.button !== 0) return;
  pointer = { id: event.pointerId, x: event.screenX, y: event.screenY, cx: event.clientX, cy: event.clientY, dragging: false,
    pinch: typeof cheekAt === 'function' ? cheekAt(event.clientX, event.clientY) : null };
  if (pointer.pinch) petPinchStart(pointer.pinch);
  character.setPointerCapture(event.pointerId);
});
character.addEventListener('pointermove', event => {
  if (!pointer || pointer.id !== event.pointerId || pointer.dragging) return;
  if (pointer.pinch) { pointer.moved = pointer.moved || Math.hypot(event.clientX - pointer.cx, event.clientY - pointer.cy) > 3; petPinchMove(event.clientX - pointer.cx, event.clientY - pointer.cy); return; }
  if (Math.hypot(event.screenX - pointer.x, event.screenY - pointer.y) < 5) return;
  pointer.dragging = true;
  if (typeof petGrab === 'function') petGrab(pointer.cx, pointer.cy);
  hideMenu();
  api.call('pet:drag-start');
});
function release(event) {
  if (!pointer || pointer.id !== event.pointerId) return;
  const dragging = pointer.dragging;
  const pinched = pointer.pinch, moved = pointer.moved;
  pointer = null;
  if (pinched) { petPinchEnd(); if (!moved && event.type === 'pointerup') reactToClick(); return; }
  if (dragging) api.call('pet:drag-end');
  else if (event.type === 'pointerup') {
    reactToClick();
  }
}
for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) character.addEventListener(type, release);
api.motion(updatePetPose);
api.call('pet:pose').then(updatePetPose);
let interactive = true;
document.addEventListener('mousemove', e => {
  const next = !!pointer || !!e.target.closest('button, .bubble, .pet-card, #pet-actions, #character');
  if (interactive !== next) { interactive = next; api.call('pet:interactive', next); }
});
api.subscribe(render); api.call('state').then(render);
