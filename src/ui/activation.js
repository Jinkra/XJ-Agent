const api = window.activation;
const $ = (id) => document.getElementById(id);
const status = (text, error = false) => { $('status').textContent = text; $('status').hidden = !text; $('status').classList.toggle('error', error); };
api.state().then(({ version }) => { $('version').textContent = `版本号：${version}`; });
$('form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('submit').disabled = true; status('正在验证…');
  try { await api.activate($('code').value); status('激活成功，正在进入…'); }
  catch (error) { status(error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), true); $('code').select(); }
  finally { $('submit').disabled = false; }
});
$('code').focus();
