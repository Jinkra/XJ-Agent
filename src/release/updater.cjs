const { app } = require('electron');
const { spawn } = require('node:child_process');
const { copyFile, lstat, mkdtemp, readFile, rm, rmdir } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

const { version } = require('../../package.json');
const { readLatest, readReleaseNotes, download } = require('./update-network.cjs');
const { installedExecutable } = require('./installed.cjs');

let latest;
let checking;
let downloading = false;
let releaseNotes;
const errorFile = () => path.join(app.getPath('userData'), 'update-error.txt');

async function checkUpdate() {
  checking ??= readLatest(version).then((result) => {
    latest = result;
    return result;
  }).finally(() => { checking = undefined; });
  const result = await checking;
  return result ? { version: result.version, canInstall: Boolean(installedExecutable()) } : null;
}

function getReleaseNotes(version) {
  if (version !== latest?.version || !latest) return '';
  if (releaseNotes?.version !== version) {
    const lookup = readReleaseNotes(version).then((notes) => {
      if (!notes && releaseNotes?.lookup === lookup) releaseNotes = undefined;
      return notes;
    });
    releaseNotes = { version, lookup };
  }
  return releaseNotes.lookup;
}

async function getUpdateError() {
  const file = errorFile();
  try {
    const error = await readFile(file, 'utf8');
    await rm(file, { force: true });
    return error;
  } catch {
    return '';
  }
}

async function handOff(folder, target, staged) {
  // NSIS replaces the installed program tree, so the running helper must live outside it.
  const worker = path.join(folder, 'update-helper.exe');
  await copyFile(path.join(process.resourcesPath, 'xj-agent-updater.exe'), worker);
  const ready = path.join(folder, 'ready');
  const helper = spawn(worker, [], {
    detached: true, windowsHide: true, stdio: 'ignore',
    env: { ...process.env, JINKRA_UPDATE_TARGET: target,
      JINKRA_UPDATE_STAGED: staged, JINKRA_UPDATE_ERROR: errorFile(), JINKRA_UPDATE_READY: ready,
      JINKRA_UPDATE_PARENT: String(process.pid),
      JINKRA_UPDATE_PROFILE: app.commandLine.hasSwitch('user-data-dir') ? path.resolve(app.getPath('userData')) : '' },
  });
  let helperError;
  helper.once('error', (error) => { helperError = error; });
  for (let retries = 0; retries < 35; retries++) {
    if (await lstat(ready).then(() => true, () => false)) {
      helper.unref();
      return;
    }
    if (helperError || helper.exitCode !== null) break;
    await delay(200);
  }
  helper.kill();
  throw new Error('无法启动 Windows 更新组件，请从发行页下载新版安装包。');
}

async function cleanCompletedUpdate() {
  const folder = process.env.JINKRA_UPDATE_CLEANUP;
  if (!folder || path.dirname(folder).toLowerCase() !== path.resolve(os.tmpdir()).toLowerCase() ||
      !/^\.jinkra-update-[a-z\d]+$/iu.test(path.basename(folder))) return;
  if (!(await lstat(folder).catch(() => null))?.isDirectory()) return;
  await delay(2000);
  await Promise.all(['update-helper.exe', 'installer.exe', 'ready'].map((name) =>
    rm(path.join(folder, name), { force: true, maxRetries: 4, retryDelay: 150 }).catch(() => {})));
  await rmdir(folder).catch(() => {});
}

async function installUpdate(report) {
  if (downloading) throw new Error('正在下载更新。');
  const update = latest;
  const target = installedExecutable();
  if (!update || !target) {
    throw new Error('请从已安装的小金同学执行更新。');
  }
  downloading = true;
  let folder;
  let handedOff = false;
  try {
    if (!(await lstat(target)).isFile()) throw new Error('无法定位小金同学的安装目录。');
    folder = await mkdtemp(path.join(os.tmpdir(), '.jinkra-update-'));
    const staged = path.join(folder, 'installer.exe');
    const size = await download(update, staged, report);
    await handOff(folder, target, staged);
    handedOff = true;
    report({ stage: 'restart', received: size, total: size, speed: 0 });
    setTimeout(() => app.quit(), 450);
  } finally {
    if (!handedOff) {
      downloading = false;
      if (folder) await rm(folder, { recursive: true, force: true }).catch(() => {});
    }
  }
}

module.exports = { checkUpdate, getReleaseNotes, getUpdateError, installUpdate, cleanCompletedUpdate };
