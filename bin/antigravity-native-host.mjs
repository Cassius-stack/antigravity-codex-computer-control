#!/usr/bin/env node
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

const MAX_FRAME_BYTES = 32 * 1024 * 1024; // 32 MiB
const SOCK_DIR = process.env.AG_BRIDGE_SOCK_DIR || "/tmp/antigravity-browser-bridge";
const SOCK_PATH = path.join(SOCK_DIR, `bridge-${process.pid}.sock`);

class LengthPrefixedFrameParser {
  constructor(onMessage, onError) {
    this.buf = Buffer.alloc(0);
    this.onMessage = onMessage;
    this.onError = onError;
  }

  push(chunk) {
    if (!chunk || chunk.length === 0) return;
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    while (this.buf.length >= 4) {
      const frameLen = this.buf.readUInt32LE(0);
      if (frameLen > MAX_FRAME_BYTES) {
        this.buf = Buffer.alloc(0);
        this.onError?.(new Error(`Frame length ${frameLen} exceeds 32 MiB limit`));
        return;
      }
      if (this.buf.length < 4 + frameLen) {
        break;
      }
      const jsonSlice = this.buf.subarray(4, 4 + frameLen);
      this.buf = this.buf.subarray(4 + frameLen);
      let parsed;
      try {
        parsed = JSON.parse(jsonSlice.toString("utf8"));
      } catch (err) {
        this.onError?.(err);
        continue;
      }
      this.onMessage(parsed);
    }
  }
}

function encodeFrame(obj) {
  const payload = Buffer.from(JSON.stringify(obj), "utf8");
  if (payload.length > MAX_FRAME_BYTES) {
    throw new Error(`Outbound frame length ${payload.length} exceeds 32 MiB limit`);
  }
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32LE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

function pruneStaleSockets() {
  try {
    const entries = fs.readdirSync(SOCK_DIR);
    for (const name of entries) {
      const m = /^bridge-(\d+)\.sock$/.exec(name);
      if (!m) continue;
      const pid = Number(m[1]);
      if (!Number.isInteger(pid) || pid === process.pid) continue;
      let alive = true;
      try {
        process.kill(pid, 0);
      } catch (err) {
        if (err && err.code === "ESRCH") {
          alive = false;
        }
      }
      if (!alive) {
        try {
          fs.unlinkSync(path.join(SOCK_DIR, name));
        } catch {}
      }
    }
  } catch {}
}

fs.mkdirSync(SOCK_DIR, { recursive: true, mode: 0o700 });
try {
  fs.chmodSync(SOCK_DIR, 0o700);
} catch {}
pruneStaleSockets();
try {
  fs.unlinkSync(SOCK_PATH);
} catch {}

let shuttingDown = false;
let nextConnId = 1;
const clients = new Map(); // connId -> net.Socket
const inflightToClient = new Map(); // muxId ("<connId>:<rawId>") -> { connId, rawId }
let cachedBridgeHello = null;

function writeToExtension(obj) {
  if (shuttingDown) return false;
  try {
    const frame = encodeFrame(obj);
    return process.stdout.write(frame);
  } catch {
    return false;
  }
}

function writeToClient(sock, obj) {
  if (!sock || sock.destroyed) return false;
  try {
    sock.write(encodeFrame(obj));
    return true;
  } catch {
    return false;
  }
}

function broadcastNotification(msg) {
  let encoded;
  try {
    encoded = encodeFrame(msg);
  } catch {
    return;
  }
  for (const sock of clients.values()) {
    if (!sock.destroyed) {
      try {
        sock.write(encoded);
      } catch {}
    }
  }
}

const server = net.createServer((sock) => {
  const connId = String(nextConnId++);
  clients.set(connId, sock);

  if (cachedBridgeHello) {
    writeToClient(sock, {
      jsonrpc: "2.0",
      method: "bridgeHello",
      params: { ...cachedBridgeHello, hostPid: process.pid, sockPath: SOCK_PATH },
    });
  }

  const parser = new LengthPrefixedFrameParser(
    (msg) => {
      if (!msg || typeof msg !== "object") return;
      if (msg.method === "host.ping") {
        writeToClient(sock, {
          jsonrpc: "2.0",
          id: msg.id ?? null,
          result: {
            pong: true,
            hostPid: process.pid,
            sockPath: SOCK_PATH,
            hello: cachedBridgeHello,
          },
        });
        return;
      }
      if (msg.id !== undefined && msg.id !== null) {
        const rawId = msg.id;
        const muxId = `${connId}:${String(rawId)}`;
        inflightToClient.set(muxId, { connId, rawId });
        const ok = writeToExtension({
          ...msg,
          id: muxId,
        });
        if (!ok) {
          inflightToClient.delete(muxId);
          writeToClient(sock, {
            jsonrpc: "2.0",
            id: rawId,
            error: { code: -32001, message: "Extension Native Messaging stdout closed" },
          });
        }
      } else {
        writeToExtension(msg);
      }
    },
    () => {
      try {
        sock.destroy();
      } catch {}
    },
  );

  sock.on("data", (chunk) => parser.push(chunk));

  const cleanupClient = () => {
    clients.delete(connId);
    for (const [muxId, entry] of inflightToClient.entries()) {
      if (entry.connId === connId) {
        inflightToClient.delete(muxId);
      }
    }
  };

  sock.on("close", cleanupClient);
  sock.on("error", cleanupClient);
});

const prevUmask = process.umask(0o177);
try {
  server.listen(SOCK_PATH, () => {
    try {
      fs.chmodSync(SOCK_PATH, 0o600);
    } catch {}
  });
} finally {
  process.umask(prevUmask);
}

const stdinParser = new LengthPrefixedFrameParser(
  (msg) => {
    if (!msg || typeof msg !== "object") return;
    if (msg.method === "bridgeHello" && msg.params && typeof msg.params === "object") {
      cachedBridgeHello = { ...msg.params };
    }

    // Response to a multiplexed client request
    if (msg.id !== undefined && msg.id !== null && !msg.method) {
      const muxKey = String(msg.id);
      const route = inflightToClient.get(muxKey);
      if (route) {
        inflightToClient.delete(muxKey);
        const sock = clients.get(route.connId);
        if (sock) {
          writeToClient(sock, {
            ...msg,
            id: route.rawId,
          });
        }
      }
      return;
    }

    // Extension-originated notification
    if (msg.method) {
      broadcastNotification(msg);
    }
  },
  () => {
    shutdown(1);
  },
);

process.stdin.on("data", (chunk) => stdinParser.push(chunk));
process.stdin.on("end", () => shutdown(0));
process.stdin.on("close", () => shutdown(0));
process.stdin.on("error", () => shutdown(0));
process.stdout.on("error", () => shutdown(0));

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const [, entry] of inflightToClient.entries()) {
    const sock = clients.get(entry.connId);
    if (sock && !sock.destroyed) {
      writeToClient(sock, {
        jsonrpc: "2.0",
        id: entry.rawId,
        error: { code: -32002, message: "Native Messaging host shutting down" },
      });
    }
  }
  inflightToClient.clear();
  for (const sock of clients.values()) {
    try {
      sock.destroy();
    } catch {}
  }
  clients.clear();
  try {
    server.close();
  } catch {}
  try {
    fs.unlinkSync(SOCK_PATH);
  } catch {}
  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
process.on("SIGHUP", () => shutdown(0));
process.on("exit", () => {
  try {
    fs.unlinkSync(SOCK_PATH);
  } catch {}
});
