# Electron ScreenShare

Stream a multi-webview dashboard to any browser with full mouse and keyboard control.  
No Python, no VNC, no extra servers — the Electron app **is** the server.

## How it works

```
app.html (Electron renderer)
  └─ desktopCapturer → JPEG frames via IPC
       └─ main.js — HTTP + WebSocket server
            ├─ serves viewer.html at http://localhost:<port>
            ├─ broadcasts JPEG frames to connected browsers
            └─ receives normalised mouse/keyboard events
                 ├─ routes to webview webContents when cursor is inside a tile
                 └─ routes to main webContents otherwise (title bar, tab bar)
```

- Mouse coordinates are **normalised to 0–1000** in the viewer and converted to content pixels in `main.js` via `getContentSize()` — resolution-independent across resize and maximise.
- Input is routed to the correct webview using a position map that the renderer reports after each webview loads and on every window resize.
- The viewer is served over HTTP from the same port as the WebSocket — open `http://localhost:9000` in any browser.

## File structure

```
screenshare_base/
├── package.json
├── assets/
│   ├── sites.json      — layout, pages, screenshare config
│   ├── logos/          — logo images (logo1.png … logo5.png)
│   └── viewer.html     — remote viewer page served over HTTP
└── src/
    ├── main.js         — Electron main process, HTTP+WS server, input routing
    ├── preload.js      — contextBridge IPC API
    └── app.html        — Electron app UI (webview grid + capture loop)
```

## Quick start

```cmd
npm install
npm start
```

Open `http://localhost:9000` in any browser, enter the token, and click **INPUT ON** to enable remote control.

## Configuration — `assets/sites.json`

All settings live in `assets/sites.json`. In production, place the file in a `config/` folder next to the executable.

### `screenshare` block

```json
"screenshare": {
  "enabled": true,
  "port":    9000,
  "token":   "changeme",
  "fps":     20,
  "quality": 0.9,
  "debug":   false
}
```

| Field | Default | Description |
|---|---|---|
| `enabled` | `true` | `false` = app runs as a display only, no server starts |
| `port` | `9000` | HTTP + WebSocket port |
| `token` | `"changeme"` | Auth token for viewer connections |
| `fps` | `20` | Capture frame rate |
| `quality` | `0.6` | JPEG quality `0.0`–`1.0` |
| `debug` | `false` | `true` = show red remote-cursor dot in the app window |

### `title` block

```json
"title": {
  "text":  "MY APP",
  "color": "#ffffff",
  "size":  20,
  "font":  "system-ui, sans-serif"
}
```

### `logoBar` block

```json
"logoBar": {
  "position":   "bottom",
  "plateColor": "rgb(238, 241, 245)",
  "height":     64
}
```

Drop `logo1.png` … `logo5.png` into `assets/logos/`. Missing images are silently ignored.

### `pages` array

Each page defines a CSS grid and a list of sites:

```json
"pages": [
  {
    "name":     "Page 1",
    "gridCols": 2,
    "gridRows": 2,
    "sites": [
      {
        "title":         "My Site",
        "url":           "https://example.com",
        "grid":          { "col": 1, "row": 1, "colSpan": 1, "rowSpan": 1 },
        "zoom":          1.0,
        "hideScrollbars": true
      }
    ]
  }
]
```

## Internet access

```cmd
ngrok http 9000
```

Connect the viewer to `wss://abc123.ngrok-free.app`.

## Security

- Set a strong token in `sites.json` (`screenshare.token`)
- For production, put a TLS reverse proxy (nginx / caddy) in front of the port
- Remote input is **off by default** in the viewer — the user must enable it explicitly
