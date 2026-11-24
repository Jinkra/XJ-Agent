const { packager } = require('@electron/packager');
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

// Package from the Electron already installed in node_modules instead of downloading it again
// (keeps packaging working offline / when GitHub is unreachable).
function localElectronZip() {
  const version = require('electron/package.json').version;
  const dir = path.join(__dirname, '..', 'dist', '.electron-cache');
  const zip = path.join(dir, `electron-v${version}-win32-x64.zip`);
  if (!fs.existsSync(zip)) {
    fs.mkdirSync(dir, { recursive: true });
    const dist = path.join(path.dirname(require.resolve('electron/package.json')), 'dist');
    execFileSync('tar', ['-a', '-c', '-f', zip, '-C', dist, '.'], { stdio: 'inherit' });
  }
  return dir;
}

(async () => {
  const paths = await packager({
    electronZipDir: localElectronZip(),
    dir: path.join(__dirname, '..'), out: process.env.JINKRA_PACKAGE_OUT || path.join(__dirname, '..', 'dist'),
    name: '小金同学', executableName: 'Jinkra', platform: 'win32', arch: 'x64', overwrite: true,
    icon: path.join(__dirname, '..', 'src', 'ui', 'brand', 'icon.ico'),
    asar: false, prune: true,
    ignore: [/^\/test-results($|\/)/, /^\/tests($|\/)/, /^\/scripts($|\/)/, /^\/dist($|\/)/, /^\/live2d($|\/)/, /^\/\.git($|\/)/, /^\/小金同学-交互预览\.html$/, /\.lnk$/, /\.bak$/, /__pycache__/, /^\/\.gitignore$/],
    win32metadata: { CompanyName: 'Jinkra', FileDescription: '小金同学 · AI 编程桌面伙伴', ProductName: '小金同学' },
  });
  console.log(paths.join('\n'));
})().catch(e => { console.error(e); process.exitCode = 1; });
