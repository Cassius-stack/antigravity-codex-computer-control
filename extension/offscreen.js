// Antigravity in Chrome — Offscreen MV3 Service Worker Keepalive (20s runtime port heartbeat)
let port = null;
let heartbeatTimer = null;

function connectKeepalive() {
  try {
    port = chrome.runtime.connect({ name: "ag-offscreen-keepalive" });
    port.onDisconnect.addListener(() => {
      port = null;
      setTimeout(connectKeepalive, 1500);
    });
    port.postMessage({ type: "heartbeat", ts: Date.now() });
  } catch {
    port = null;
    setTimeout(connectKeepalive, 2500);
  }
}

connectKeepalive();

heartbeatTimer = setInterval(() => {
  if (!port) {
    connectKeepalive();
    return;
  }
  try {
    port.postMessage({ type: "heartbeat", ts: Date.now() });
  } catch {
    port = null;
    connectKeepalive();
  }
}, 20_000);
