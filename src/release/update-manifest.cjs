const { verify } = require('node:crypto');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const manifestName = 'xj-agent-install-update.json';
const notesName = 'xj-agent-release-notes.json';
const notesLimit = 24_000;
const maxBytes = 900 * 1024 * 1024;
const releaseVersion = /^\d{1,7}\.\d{1,7}\.\d{1,7}$/u;
const releaseFilename = (version) => `XJ-Agent-Setup-${version}-x64.exe`;

function validUpdate({ version, size, sha256 }) {
  return typeof version === 'string' && releaseVersion.test(version) &&
    Number.isSafeInteger(size) && size >= 4096 && size <= maxBytes &&
    typeof sha256 === 'string' && /^[a-f0-9]{64}$/u.test(sha256);
}

function manifestMessage({ version, size, sha256 }) {
  return Buffer.from('xj-agent/windows-x64/install-update-v1\n' + JSON.stringify([version, size, sha256]));
}

function notesMessage({ version, notes }) {
  return Buffer.from('xj-agent/windows-x64/notes-v1\n' + JSON.stringify([version, notes]));
}

function verifySignature(message, signature) {
  if (typeof signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/u.test(signature)) return false;
  const key = readFileSync(path.join(__dirname, 'update-public-key.pem'));
  return verify(null, message, key, Buffer.from(signature, 'base64'));
}

function verifiedManifest(manifest) {
  if (!manifest || !validUpdate(manifest)) throw new Error('更新清单格式无效。');
  if (!verifySignature(manifestMessage(manifest), manifest.signature)) {
    throw new Error('更新清单签名校验失败。');
  }
  const { version, size, sha256 } = manifest;
  return { version, size, sha256 };
}

function verifiedNotes(release, version) {
  if (!release || !releaseVersion.test(version) || release.version !== version || typeof release.notes !== 'string' ||
      release.notes.length > notesLimit || !verifySignature(notesMessage(release), release.signature)) {
    throw new Error('发布备注签名校验失败。');
  }
  return release.notes;
}

module.exports = { manifestName, validUpdate, manifestMessage, verifiedManifest, releaseFilename,
  notesName, notesLimit, notesMessage, verifiedNotes };
