/**
 * preload.js
 * Exposes a safe API to the renderer via contextBridge.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Send a captured JPEG frame (base64 string) to main
  sendFrame: (jpegBase64) => ipcRenderer.send('frame', jpegBase64),

  // Get server config (port, fps, token)
  getConfig: () => ipcRenderer.invoke('get-config'),

  // Get number of connected browser viewers
  getViewerCount: () => ipcRenderer.invoke('viewer-count'),

  // Get the desktopCapturer source ID for this window
  getWindowSource: () => ipcRenderer.invoke('get-window-source'),

  // Report actual captured video dimensions to main so coord mapping is accurate
  reportCaptureDims: (w, h) => ipcRenderer.send('capture-dims', w, h),

  // Remote cursor position from viewer
  onRemoteCursor: (cb) => ipcRenderer.on('remote-cursor', (_e, pos) => cb(pos)),

  // Custom title bar window controls
  windowMinimize: () => ipcRenderer.send('win-minimize'),
  windowMaximize: () => ipcRenderer.send('win-maximize'),
  windowClose:    () => ipcRenderer.send('win-close'),

  // Sites/grid config
  getSites: () => ipcRenderer.invoke('get-sites'),

  // Webview position map for input routing
  reportWebviewMap:    (map) => ipcRenderer.send('webview-map', map),
  onRequestWebviewMap: (cb)  => ipcRenderer.on('request-webview-map', () => cb()),
});
