const api = window.activation;
const $ = (id) => document.getElementById(id);
const clean = (message) => message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
function status(text, kind = '') { $('status').textContent = text; $('status').className = kind; }
api.state().then(({ version }) => { $('version').textContent = 'v' + version; document.title = `小金同学 ${version}`; });
$('toggle').addEventListener('click', () => {
  const show = $('code').type === 'password';
  $('code').type = show ? 'text' : 'password';
  $('toggle').setAttribute('aria-label', show ? '隐藏激活码' : '显示激活码');
  $('code').focus();
});
$('code').addEventListener('input', () => { $('code').parentElement.classList.remove('invalid'); if ($('status').className === 'error') status(''); });
$('form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const field = $('code').parentElement, submit = $('submit');
  if (!$('code').value.trim()) { field.classList.remove('invalid'); void field.offsetWidth; field.classList.add('invalid'); status('请输入激活码。', 'error'); return; }
  submit.disabled = true; submit.classList.add('busy'); status('正在验证激活码…');
  try {
    await api.activate($('code').value);
    submit.classList.replace('busy', 'done'); submit.querySelector('span').textContent = '激活成功';
    status('欢迎使用小金同学，正在进入…', 'ok');
  } catch (error) {
    submit.disabled = false; submit.classList.remove('busy');
    field.classList.remove('invalid'); void field.offsetWidth; field.classList.add('invalid');
    status(clean(error.message), 'error'); $('code').select();
  }
});
$('code').focus();
