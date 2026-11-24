const { createHash, createPrivateKey, sign } = require('node:crypto');
const { createReadStream } = require('node:fs');
const { readFile, writeFile } = require('node:fs/promises');
const path = require('node:path');
const { version } = require('../package.json');
const { manifestName, manifestMessage, verifiedManifest, releaseFilename,
  notesName, notesLimit, notesMessage, verifiedNotes } = require('../src/release/update-manifest.cjs');

async function createReleaseFiles() {
  const encoded = process.env.XJ_AGENT_UPDATE_SIGNING_KEY;
  if (!encoded) throw new Error('缺少发布签名密钥。');
  const key = createPrivateKey({ key: Buffer.from(encoded, 'base64'), format: 'der', type: 'pkcs8' });
  const directory = path.resolve(__dirname, '../release');
  const filename = releaseFilename(version);
  const hash = createHash('sha256');
  let size = 0;
  for await (const bytes of createReadStream(path.join(directory, filename))) {
    size += bytes.length;
    hash.update(bytes);
  }
  const manifest = { version, size, sha256: hash.digest('hex') };
  manifest.signature = sign(null, manifestMessage(manifest), key).toString('base64');
  verifiedManifest(manifest);
  const notesPath = process.argv[2];
  const outputs = [
    writeFile(path.join(directory, filename + '.sha256'), manifest.sha256 + '  ' + filename + '\n'),
    writeFile(path.join(directory, manifestName), JSON.stringify(manifest) + '\n'),
  ];
  if (notesPath) {
    const notes = (await readFile(notesPath, 'utf8')).trim().slice(0, notesLimit);
    const release = { version, notes };
    release.signature = sign(null, notesMessage(release), key).toString('base64');
    verifiedNotes(release, version);
    outputs.push(writeFile(path.join(directory, notesName), JSON.stringify(release) + '\n'));
  }
  await Promise.all(outputs);
}

createReleaseFiles().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
