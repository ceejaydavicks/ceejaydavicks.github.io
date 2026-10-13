---
name: Headless Chromium debugging
description: Chromium's DevTools WebSocket origin restriction when running browser automation inside this container.
---

When connecting to the DevTools Protocol WebSocket from an in-container test client, launch Chromium with `--remote-allow-origins=*`; otherwise the handshake can be rejected with HTTP 403 even though the app and screenshot preview work normally.

**Why:** The bundled headless browser enforces an origin allowlist on its debugging socket.

**How to apply:** Use this flag only for direct DevTools Protocol test sessions; the site's server and Replit Preview do not need it.
