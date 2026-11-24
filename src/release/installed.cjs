const { app } = require('electron');
const { existsSync } = require('node:fs');
const path = require('node:path');

// Only an installer-managed copy (with its uninstaller beside it) can update itself in place.
function installedExecutable() {
  if (process.platform !== 'win32' || !app.isPackaged) return null;
  const executable = app.getPath('exe');
  return existsSync(path.join(path.dirname(executable), 'Uninstall 小金同学.exe')) ? executable : null;
}

module.exports = { installedExecutable };
