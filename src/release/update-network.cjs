const { createHash } = require('node:crypto');
const { createWriteStream } = require('node:fs');
const { rm } = require('node:fs/promises');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { manifestName, validUpdate, verifiedManifest, releaseFilename, notesName, notesLimit, verifiedNotes } = require('./update-manifest.cjs');

const repo = 'Jinkra/XJ-Agent';
const releases = 'https://github.com/' + repo + '/releases';
const releaseApi = 'https://api.github.com/repos/' + repo + '/releases';
const lines = [
  { name: 'GitHub 直连', prefix: '' },
  { name: 'GHFast', prefix: 'https://ghfast.top/' },
  { name: 'GH-Proxy', prefix: 'https://gh-proxy.org/' },
  { name: 'GH-Proxy CDN', prefix: 'https://cdn.gh-proxy.org/' },
  { name: 'Dpik 加速', prefix: 'https://gh.dpik.top/' },
];
const officialHosts = ['github.com', 'api.github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'];
const hosts = new Set([
  ...officialHosts,
  ...lines.filter((line) => line.prefix).map((line) => new URL(line.prefix).hostname),
]);
const redirects = new Set([301, 302, 303, 307, 308]);
const probeBytes = 128 * 1024;
const surveyTimeout = 7000;
const stalledTimeout = 15_000;

function compareVersions(a, b) {
  const right = b.split('.').map(Number);
  for (const [index, part] of a.split('.').entries()) {
    const delta = Number(part) - right[index];
    if (delta) return delta;
  }
  return 0;
}

async function request(url, signal, headers = {}, official = false) {
  for (let remaining = 4; remaining >= 0; remaining--) {
    const destination = new URL(url);
    if (destination.protocol !== 'https:' || destination.username || destination.password ||
        destination.port || !hosts.has(destination.hostname) ||
        (official && !officialHosts.includes(destination.hostname))) throw new Error('更新下载地址无效。');
    const response = await fetch(destination, {
      signal, redirect: 'manual', headers: { 'User-Agent': 'XJ-Agent', ...headers },
    });
    if (!redirects.has(response.status)) return response;
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location) break;
    url = new URL(location, destination).href;
  }
  throw new Error('无法访问更新下载地址。');
}

async function readJson(url, limit, official = false) {
  const response = await request(url, AbortSignal.timeout(surveyTimeout), { Accept: 'application/json' }, official);
  if (!response.ok || !response.body || Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel();
    throw new Error('更新信息暂不可用。');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > limit) throw new Error('更新信息超过大小限制。');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
}

async function officialRelease() {
  const release = await readJson(releaseApi + '/latest', 256 * 1024, true);
  const version = typeof release?.tag_name === 'string' && release.tag_name.startsWith('v') ? release.tag_name.slice(1) : '';
  const asset = Array.isArray(release?.assets) && release.assets.find((item) => item?.name === releaseFilename(version));
  const sha256 = typeof asset?.digest === 'string' && asset.digest.startsWith('sha256:') ? asset.digest.slice(7) : '';
  const result = { version, size: asset?.size, sha256 };
  if (release?.draft || release?.prerelease || !validUpdate(result)) throw new Error('GitHub 正式发行包暂不可用。');
  return result;
}

async function readReleaseNotes(version) {
  return Promise.any([
    readJson(releaseApi + '/tags/v' + version, 256 * 1024, true).then((release) => {
      if (release?.tag_name !== 'v' + version || typeof release?.body !== 'string' || !release.body.trim()) {
        throw new Error('GitHub 未提供发布备注。');
      }
      return release.body.slice(0, notesLimit);
    }),
    ...lines.map(async ({ prefix }) => {
      const notes = await readJson(`${prefix}${releases}/download/v${version}/${notesName}`, notesLimit * 6 + 1024);
      return verifiedNotes(notes, version);
    }),
  ]).catch(() => '');
}

async function readLatest(currentVersion) {
  const results = await Promise.allSettled([
    officialRelease(),
    ...lines.map(async (line) =>
      verifiedManifest(await readJson(line.prefix + releases + '/latest/download/' + manifestName, 4096))),
  ]);
  const [official, ...signed] = results;
  const updates = signed.filter((result) => result.status === 'fulfilled').map((result) => result.value);
  updates.sort((a, b) => compareVersions(b.version, a.version));
  let [update] = updates;
  if (official.status === 'fulfilled' && compareVersions(official.value.version, currentVersion) > 0 &&
      (!update || compareVersions(official.value.version, update.version) > 0)) {
    // Some accelerators cache /latest even after the new versioned assets are available.
    const { version } = official.value;
    update = await Promise.any(lines.map(async (line) => {
      const manifest = verifiedManifest(await readJson(`${line.prefix}${releases}/download/v${version}/${manifestName}`, 4096));
      if (manifest.version !== version) throw new Error('更新清单版本不符。');
      return manifest;
    })).catch(() => { throw new Error('新版签名清单暂不可用，请稍后重试。'); });
  }
  if (update && compareVersions(update.version, currentVersion) > 0) return update;
  if ((update && compareVersions(update.version, currentVersion) === 0) ||
      (official.status === 'fulfilled' && compareVersions(official.value.version, currentVersion) === 0)) return null;
  throw new Error('暂时无法确认最新版本，请稍后重试。');
}

async function probe(line, url, total) {
  const started = performance.now();
  const limit = Math.min(probeBytes, total);
  const response = await request(line.prefix + url, AbortSignal.timeout(surveyTimeout), { Range: `bytes=0-${limit - 1}` });
  const range = response.headers.get('content-range')?.match(/^bytes 0-(\d+)\/(\d+)$/u);
  const length = Number(response.headers.get('content-length')) || 0;
  if (!response.body || ![200, 206].includes(response.status) ||
      (response.status === 206 && (!range || Number(range[2]) !== total || Number(range[1]) + 1 < limit)) ||
      (response.status === 200 && length && length !== total)) {
    await response.body?.cancel();
    throw new Error('线路返回的文件与发行包不符。');
  }
  let bytes = 0;
  const first = [];
  for await (const chunk of response.body) {
    if (first.length < 2) first.push(...chunk.subarray(0, 2 - first.length));
    if (first.length === 2 && (first[0] !== 0x4d || first[1] !== 0x5a)) throw new Error('线路未返回 EXE 文件。');
    bytes += chunk.length;
    if (bytes >= limit) break;
  }
  if (bytes < limit) throw new Error('线路返回的文件不完整。');
  return limit * 1000 / Math.max(1, performance.now() - started);
}

async function receive(line, url, update, staged, report) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), stalledTimeout);
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(2_700_000)]);
  const total = update.size;
  try {
    const response = await request(line.prefix + url, signal);
    const length = Number(response.headers.get('content-length')) || 0;
    if (response.status !== 200 || !response.body || (length && length !== total)) {
      await response.body?.cancel();
      throw new Error('线路返回的文件与发行包不符。');
    }
    const hash = createHash('sha256');
    let size = 0;
    let speed = 0;
    let sampleBytes = 0;
    let sampleTime = performance.now();
    report({ stage: 'download', line: line.name, received: 0, total, speed });
    await pipeline(response.body, new Transform({
      transform(chunk, _encoding, callback) {
        size += chunk.length;
        if (size > total) return callback(new Error('下载大小与更新清单不符。'));
        timeout.refresh();
        hash.update(chunk);
        const now = performance.now();
        if (now - sampleTime >= 330) {
          const rate = (size - sampleBytes) * 1000 / (now - sampleTime);
          speed = speed ? .65 * speed + .35 * rate : rate;
          sampleBytes = size;
          sampleTime = now;
          report({ stage: 'download', line: line.name, received: size, total, speed });
        }
        callback(null, chunk);
      },
    }), createWriteStream(staged, { flags: 'wx' }), { signal });
    report({ stage: 'verify', line: line.name, received: size, total, speed: 0 });
    if (size !== total || hash.digest('hex') !== update.sha256) throw new Error('更新包的 SHA-256 校验未通过。');
    return size;
  } finally {
    clearTimeout(timeout);
  }
}

async function download(update, staged, report) {
  const url = `${releases}/download/v${update.version}/${releaseFilename(update.version)}`;
  report({ stage: 'probe', received: 0, total: update.size, speed: 0 });
  const tests = await Promise.all(lines.map(async (line) => ({
    line, speed: await probe(line, url, update.size).catch(() => 0),
  })));
  tests.sort((a, b) => b.speed - a.speed);
  for (const [index, { line }] of tests.entries()) {
    if (index) report({ stage: 'switch', line: line.name, received: 0, total: update.size, speed: 0 });
    try {
      return await receive(line, url, update, staged, report);
    } catch (error) {
      await rm(staged, { force: true });
      if (['ENOSPC', 'EPERM', 'EACCES', 'EROFS'].includes(error.code)) {
        throw new Error('无法写入更新文件，请检查剩余磁盘空间和程序目录权限。');
      }
    }
  }
  throw new Error('所有更新线路均未完成下载或校验，请稍后重试。');
}

module.exports = { readLatest, readReleaseNotes, download };
