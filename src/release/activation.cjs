const { app, safeStorage } = require('electron');
const { scrypt, timingSafeEqual } = require('node:crypto');
const { promisify } = require('node:util');
const { mkdir, readFile, rename, rm, writeFile } = require('node:fs/promises');
const path = require('node:path');

const { version } = require('../../package.json');
const keyDigest = Buffer.from('03eff1d8b2ed11ce79a501d89f80f38d0ced70786a9cb986972230451ca0f13b', 'hex');
const derive = promisify(scrypt);
const receipt = 'Jinkra/activation/' + version;
let active = false;
let attempt;
let failures = 0;
let waitUntil = 0;
const marker = () => path.join(app.getPath('userData'), 'activation.dat');
const attemptsFile = () => path.join(app.getPath('userData'), 'activation-attempts.dat');
const cooldown = 30_000;

async function loadActivation() {
  const decrypt = (filename) => readFile(filename).then((data) => safeStorage.decryptStringAsync(data))
    .then(({ result }) => result).catch(() => '');
  const [saved, attempts] = await Promise.all([decrypt(marker()), decrypt(attemptsFile())]);
  active = saved === receipt;
  if (active || !attempts) return;
  try {
    const previous = JSON.parse(attempts);
    if (previous.version !== version) return;
    if (Number.isInteger(previous.failures) && previous.failures >= 0 && previous.failures < 5) failures = previous.failures;
    if (Number.isFinite(previous.waitUntil)) waitUntil = Math.min(previous.waitUntil, Date.now() + cooldown);
  } catch {}
}

function activationState() {
  return { version, active };
}

async function activate(code) {
  if (active) return activationState();
  const seconds = Math.ceil((waitUntil - Date.now()) / 1000);
  if (seconds > 0) throw new Error(`尝试次数过多，请在 ${seconds} 秒后重试。`);
  if (attempt) throw new Error('正在验证激活码。');
  if (typeof code !== 'string' || code.length < 1 || code.length > 128) throw new Error('请输入有效的激活码。');
  attempt = (async () => {
    const supplied = await derive(code.trim(), 'Jinkra local activation v2', keyDigest.length);
    if (!timingSafeEqual(supplied, keyDigest)) {
      if (++failures === 5) { waitUntil = Date.now() + cooldown; failures = 0; }
      await saveProtected(attemptsFile(), JSON.stringify({ version, failures, waitUntil })).catch(() => {});
      throw new Error('激活码不正确，请检查后重试。');
    }
    await saveProtected(marker(), receipt);
    active = true;
    await rm(attemptsFile(), { force: true }).catch(() => {});
    return activationState();
  })().finally(() => { attempt = undefined; });
  return attempt;
}

async function saveProtected(file, value) {
  const encrypted = await safeStorage.encryptStringAsync(value);
  await mkdir(path.dirname(file), { recursive: true });
  const temp = file + '.' + process.pid + '.tmp';
  await writeFile(temp, encrypted);
  await rename(temp, file).catch(async (error) => { await rm(temp, { force: true }); throw error; });
}

module.exports = { activate, activationState, loadActivation };
