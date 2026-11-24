// Electron check without showing any window: loads the pet renderer (file://, real CSP) in a hidden,
// transparent window, waits for the model, captures a frame. Usage: electron live2d/build/electron-check.cjs
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const OUT = path.join(__dirname, '..', '..', 'test-results', 'live2d', 'electron-check.png');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 300, height: 450, transparent: true, frame: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: false } });
  const logs = [];
  win.webContents.on('console-message', (event, level, message) => logs.push(message));
  await win.loadFile(path.join(__dirname, 'pet-harness.html'));
  let state = {};
  for (let i = 0; i < 100; i++) {
    state = await win.webContents.executeJavaScript('({ready: document.querySelector("#rig").dataset.modelReady, error: document.querySelector("#rig").dataset.modelError, params: document.querySelector("#rig").dataset.params})');
    if (state.ready || state.error) break;
    await new Promise(r => setTimeout(r, 100));
  }
  await new Promise(r => setTimeout(r, 500));
  state.paintedBottom = await win.webContents.executeJavaScript('window.__petRig.paintedBottom()');
  state.coverage = await win.webContents.executeJavaScript(`(() => {
    const c = document.querySelector('#rig'); const gl = c.getContext('webgl');
    window.__petRig.paintedBottom();
    const px = new Uint8Array(c.width * c.height * 4); gl.readPixels(0, 0, c.width, c.height, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let n = 0; for (let i = 3; i < px.length; i += 4) if (px[i] > 200) n++;
    return +(n / (c.width * c.height)).toFixed(3);
  })()`);
  const image = await win.webContents.capturePage();
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, image.toPNG());
  console.log(JSON.stringify({ state, logs: logs.slice(0, 5), size: image.getSize() }));
  app.quit();
});
