const { mkdirSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'vendor', 'updater');
mkdirSync(output, { recursive: true });
const compiler = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const result = spawnSync(compiler, ['/nologo', '/codepage:65001', '/target:winexe', '/optimize+', '/platform:x64',
  '/out:' + path.join(output, 'xj-agent-updater.exe'), path.join(root, 'src', 'release', 'windows-updater.cs')],
{ stdio: 'inherit', windowsHide: true });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status || 1);
