const {
  app,
  BrowserWindow,
  ipcMain
} = require('electron');
const path = require('path');
const { spawn } = require('child_process');

let win;
let bridgeProcess = null;

function createWindow() {
  win = new BrowserWindow({
    width: 580,
    height: 640,
    resizable: true,
    minimizable: true,
    maximizable: true,
    title: 'Codex Bridge',
    backgroundColor: '#1a1a2e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.loadFile('index.html');
  win.on('closed', () => { win = null; });
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => {
  stopBridge();
  app.quit();
});

// ── resolve node path ──
function getNodePath() {
  return process.execPath.includes('electron')
    ? 'node'
    : process.execPath;
}

// ── resolve bridge src path ──
function getBridgeSrc() {
  const dev = path.join(__dirname, '..', 'src', 'server.js');
  const prod = path.join(process.resourcesPath, 'src', 'server.js');
  try { require('fs').accessSync(dev); return dev; } catch { return prod; }
}

// ── IPC: start ──
ipcMain.handle('bridge:start', (_e, url) => {
  if (bridgeProcess) return { ok: false, error: 'already running' };

  const env = Object.assign({}, process.env, {
    UPSTREAM_BASE_URL: url,
    PORT: '8787'
  });

  const nodeBin = getNodePath();
  const serverJs = getBridgeSrc();

  bridgeProcess = spawn(nodeBin, [serverJs], { env, stdio: ['pipe', 'pipe', 'pipe'] });

  bridgeProcess.stdout.on('data', d => {
    if (win) win.webContents.send('bridge:log', d.toString());
  });
  bridgeProcess.stderr.on('data', d => {
    if (win) win.webContents.send('bridge:log', d.toString());
  });
  bridgeProcess.on('close', code => {
    bridgeProcess = null;
    if (win) win.webContents.send('bridge:stopped', code);
  });

  return { ok: true };
});

// ── IPC: stop ──
ipcMain.handle('bridge:stop', () => {
  stopBridge();
  return { ok: true };
});

function stopBridge() {
  if (bridgeProcess) {
    bridgeProcess.kill();
    bridgeProcess = null;
  }
}
