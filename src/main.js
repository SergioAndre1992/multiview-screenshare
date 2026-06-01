/**
 * main.js — Electron main process
 *
 * Responsibilities:
 *  - Creates a frameless BrowserWindow running app.html
 *  - Runs an HTTP + WebSocket server on WS_PORT
 *      HTTP  → serves viewer.html to any browser
 *      WS    → streams JPEG frames; receives normalized mouse/keyboard events
 *  - Converts normalized (0–1000) viewer coords to content pixels via getContentSize()
 *  - Injects input into the renderer using webContents.sendInputEvent()
 *  - Re-broadcasts window dimensions on resize/maximize so the viewer stays in sync
 */

const { app, BrowserWindow, ipcMain, screen, desktopCapturer, webContents } = require('electron');
const { WebSocketServer } = require('ws');
const http = require('http');
const fs   = require('fs');
const path = require('path');

// ── Sites config ───────────────────────────────────────────────────────────
const prodConfigDir = path.join(path.dirname(process.execPath), 'config');
const devConfigDir  = path.join(__dirname, '..', 'assets');
const configDir = fs.existsSync(path.join(prodConfigDir, 'sites.json'))
  ? prodConfigDir
  : devConfigDir;

let sitesConfig = { pages: [] };
try {
  sitesConfig = JSON.parse(fs.readFileSync(path.join(configDir, 'sites.json'), 'utf8'));
} catch (e) {
  console.warn('[config] Could not read sites.json:', e.message);
}

const ssCfg      = sitesConfig.screenshare || {};
const SS_ENABLED = ssCfg.enabled !== false;
const SS_DEBUG   = ssCfg.debug   === true;
const WS_PORT    = ssCfg.port    || 9000;
const SECRET     = ssCfg.token   || process.env.SCREEN_TOKEN || 'changeme';
const TARGET_FPS = ssCfg.fps     || 20;

let mainWindow  = null;
let wss         = null;
let captureW    = 1280;
let captureH    = 800;
let webviewMap  = [];   // [{id, x, y, width, height}] — updated by renderer
const browsers  = new Set();

// ── Window ─────────────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width:  1280,
    height: 800,
    frame:  false,
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
      webviewTag:       true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'app.html'));
  mainWindow.on('closed', () => { mainWindow = null; });

  // Push updated dimensions to all viewers on resize/maximize
  const sendDims = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const { width, height } = mainWindow.getBounds();
    const msg = JSON.stringify({ type: 'init', width, height, contentW: width, contentH: height });
    for (const client of browsers) {
      if (client.readyState === 1) client.send(msg);
    }
  };
  const sendDimsAndMap = () => {
    sendDims();
    if (mainWindow && !mainWindow.isDestroyed())
      mainWindow.webContents.send('request-webview-map');
  };
  mainWindow.on('resize',     sendDimsAndMap);
  mainWindow.on('maximize',   sendDimsAndMap);
  mainWindow.on('unmaximize', sendDimsAndMap);
}

// ── Input injection ────────────────────────────────────────────────────────
function sendInputToWindow(msg) {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  const [cW, cH] = mainWindow.getContentSize();
  const appX = Math.round(msg.x / 1000 * cW);
  const appY = Math.round(msg.y / 1000 * cH);

  if (appX < 0 || appY < 0 || appX > cW || appY > cH) return;

  // Update the red cursor dot (only rendered when debug: true in config)
  if (msg.type === 'mousemove') {
    mainWindow.webContents.send('remote-cursor', { x: appX, y: appY, debug: SS_DEBUG });
  }

  // Route to the webview under the cursor, or fall back to the main window
  const hit = webviewMap.find(wv =>
    appX >= wv.x && appX <= wv.x + wv.width &&
    appY >= wv.y && appY <= wv.y + wv.height
  );

  let wc;
  let x, y;

  if (hit) {
    const wvWc = webContents.fromId(hit.id);
    if (!wvWc || wvWc.isDestroyed()) return;
    wc = wvWc;
    x  = appX - Math.round(hit.x);
    y  = appY - Math.round(hit.y);
  } else {
    wc = mainWindow.webContents;
    x  = appX;
    y  = appY;
  }

  wc.focus();

  const btn = msg.button === 1 ? 'middle' : msg.button === 2 ? 'right' : 'left';

  switch (msg.type) {
    case 'mousemove':
      wc.sendInputEvent({ type: 'mouseMove', x, y });
      break;
    case 'mousedown':
      wc.sendInputEvent({ type: 'mouseDown', x, y, button: btn, clickCount: 1 });
      break;
    case 'mouseup':
      wc.sendInputEvent({ type: 'mouseUp', x, y, button: btn, clickCount: 1 });
      break;
    case 'dblclick':
      wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 2 });
      wc.sendInputEvent({ type: 'mouseUp',   x, y, button: 'left', clickCount: 2 });
      break;
    case 'scroll':
      wc.sendInputEvent({ type: 'mouseWheel', x, y, deltaX: 0, deltaY: -Math.round(msg.deltaY), canScroll: true });
      break;
    case 'keydown':
      wc.sendInputEvent({ type: 'keyDown', keyCode: msg.key });
      break;
    case 'keyup':
      wc.sendInputEvent({ type: 'keyUp', keyCode: msg.key });
      break;
  }
}

// ── HTTP + WebSocket server ────────────────────────────────────────────────
function startWsServer() {
  const viewerFile = path.join(__dirname, 'viewer.html');

  const httpServer = http.createServer((req, res) => {
    fs.readFile(viewerFile, (err, data) => {
      if (err) { res.writeHead(500); res.end('Error'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
  });

  wss = new WebSocketServer({ server: httpServer });

  httpServer.listen(WS_PORT, () => {
    console.log(`[HTTP] Viewer → http://localhost:${WS_PORT}`);
    console.log(`[WS]  Server  → ws://localhost:${WS_PORT}`);
  });

  wss.on('connection', (ws, req) => {
    const url   = new URL(req.url, 'http://localhost');
    const token = url.searchParams.get('token') || '';

    if (token !== SECRET) {
      ws.close(4001, 'Unauthorized');
      console.warn('[WS] Rejected — bad token');
      return;
    }

    console.log('[WS] Browser client connected');
    browsers.add(ws);

    // Send current window dimensions so the viewer calibrates its aspect ratio
    const { width, height } = mainWindow
      ? mainWindow.getBounds()
      : { width: 1280, height: 800 };

    ws.send(JSON.stringify({ type: 'init', width, height, contentW: width, contentH: height }));

    ws.on('message', (data) => {
      try { sendInputToWindow(JSON.parse(data.toString())); } catch (_) {}
    });

    ws.on('close', () => {
      browsers.delete(ws);
      console.log('[WS] Browser client disconnected');
    });

    ws.on('error', () => browsers.delete(ws));
  });
}

// ── IPC handlers ───────────────────────────────────────────────────────────

ipcMain.on('frame', (_event, jpegBase64) => {
  if (browsers.size === 0) return;
  const msg = JSON.stringify({ type: 'frame', data: jpegBase64 });
  for (const client of browsers) {
    if (client.readyState === 1) client.send(msg, { binary: false });
  }
});

ipcMain.handle('viewer-count', () => browsers.size);

ipcMain.on('win-minimize', () => mainWindow?.minimize());
ipcMain.on('win-maximize', () => mainWindow?.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize());
ipcMain.on('win-close',    () => mainWindow?.close());

ipcMain.on('webview-map', (_event, map) => {
  webviewMap = map;
});

ipcMain.on('capture-dims', (_event, w, h) => {
  captureW = w;
  captureH = h;
  // Send actual video resolution to viewers for display (not used for coord mapping)
  const info = JSON.stringify({ type: 'video-dims', width: w, height: h });
  for (const client of browsers) {
    if (client.readyState === 1) client.send(info);
  }
});

ipcMain.handle('get-window-source', async () => {
  const sources = await desktopCapturer.getSources({ types: ['window'] });
  const win = sources.find(s => s.name === 'My Electron App') || sources[0];
  return win ? win.id : null;
});

ipcMain.handle('get-config', () => ({
  wsPort:    WS_PORT,
  targetFps: TARGET_FPS,
  token:     SECRET,
  quality:   ssCfg.quality ?? 0.6,
}));

ipcMain.handle('get-sites', () => ({
  ...sitesConfig,
  _logosPath: configDir.replace(/\\/g, '/'),
}));

// ── Lifecycle ──────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  createWindow();
  if (SS_ENABLED) {
    startWsServer();
  } else {
    console.log('[screenshare] disabled via config');
  }
});

app.on('window-all-closed', () => {
  if (wss) { wss.clients.forEach(c => c.terminate()); wss.close(); }
  app.quit();
});
