#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const MAX_FRAME_BYTES = 32 * 1024 * 1024; // 32 MiB
const SOCK_DIR = process.env.AG_BRIDGE_SOCK_DIR || "/tmp/antigravity-browser-bridge";
const SOCK_PATH = path.join(SOCK_DIR, `bridge-${process.pid}.sock`);

const HOME_DIR = os.homedir();
const ACP_APP_DATA_DIR = process.env.AG_ACP_APP_DATA_DIR || "antigravity";
const DEFAULT_ACP_CWD =
  process.env.AG_ACP_DEFAULT_CWD || path.join(HOME_DIR, ".gemini", "antigravity", "scratch");
const CHROME_SESSIONS_FILE =
  process.env.AG_CHROME_SESSIONS_FILE ||
  path.join(HOME_DIR, ".gemini", "antigravity", "chrome-sidepanel-sessions.json");

const DEFAULT_CHROME_SYSTEM_PROMPT = `You are Antigravity in Chrome, running inside the user's docked browser Side Panel alongside their live tabs.
- When the prompt specifies [Interaction Mode: Chat / Read-Only], answer directly using the provided live page/tab context and screenshots without mutating browser tabs or clicking page elements unless explicitly asked to switch to Agent Mode.
- When the prompt specifies [Interaction Mode: Agent / Browser Control], invoke the "computer-use" MCP server directly via call_mcp_tool(ServerName: "computer-use", ToolName: "<tool>", Arguments: { ... }) using the exact Browser Tab ID provided in context (e.g. "ext-tab-<id>" or "<id>") — no need to read JSON schema files or call browser_list first when tab_id is already given:
  • browser_tab_state: { tab_id: string, include_screenshot?: boolean, disable_diff?: boolean } -> returns indexed interactive elements [1], [2], ...
  • browser_tab_action: { tab_id: string, action: "click"|"hover"|"set_value"|"type_text"|"press_key"|"paste"|"scroll"|"drag"|"goto"|"back"|"forward"|"reload"|"evaluate"|"wait_for", element_index?: number, selector?: string, x?: number, y?: number, value?: string, text?: string, key?: string, direction?: "up"|"down"|"left"|"right", pages?: number, url?: string, expression?: string, include_screenshot?: boolean }
  • browser_open_tab: { url?: string, urls?: string[], active?: boolean, group_title?: string, group_color?: "cyan"|"blue"|"purple"|"green"|"yellow"|"orange"|"pink"|"red"|"grey" }
  • browser_manage: { action: "status"|"claim_tab"|"mark_tab"|"finalize_session"|"group_tabs"|"name_session", tab_id?: string, status?: "deliverable"|"handoff"|"scratch", name?: string }
  • browser_list: {} (use only when discovering unattached tabs not already listed in context)
- Prefer acting on the provided tab_id in-place (auto-claimed) or opening new research tabs inside a clean color-coded Tab Group, and call browser_manage({ action: "finalize_session" }) when done with multi-tab research.
- Never attempt to solve or bypass CAPTCHAs or login/2FA walls; if encountered, mark the tab for handoff and ask the user.`;

const FALLBACK_MODELS = [
  { modelId: "gemini-4-carbon-medium", name: "Gemini 4 Carbon (Medium)" },
  { modelId: "gemini-4-carbon-high", name: "Gemini 4 Carbon (High)" },
  { modelId: "gemini-4-carbon-low", name: "Gemini 4 Carbon (Low)" },
  { modelId: "gemini-4-argon-medium", name: "Gemini 4 Argon (Medium)" },
  { modelId: "gemini-4-argon-high", name: "Gemini 4 Argon (High)" },
  { modelId: "gemini-4-argon-low", name: "Gemini 4 Argon (Low)" },
  { modelId: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)" },
  { modelId: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
  { modelId: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)" },
  { modelId: "claude-sonnet-4-6-thinking", name: "Claude Sonnet 4.6 (Thinking)" },
  { modelId: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
  { modelId: "claude-opus-4-6-thinking", name: "Claude Opus 4.6 (Thinking)" },
  { modelId: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
];

function parseCliModelsOutput(stdout) {
  if (!stdout || typeof stdout !== "string") return [];
  const cleanAnsi = stdout.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
  const parsed = [];
  const seen = new Set();
  for (const rawLine of cleanAnsi.split(/\n/)) {
    const segments = rawLine
      .split(/\r/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (segments.length === 0) continue;
    const line = segments[segments.length - 1];
    if (
      !line ||
      /^available models/i.test(line) ||
      /fetching available models/i.test(line) ||
      line.startsWith("-") ||
      line.startsWith("=")
    ) {
      continue;
    }
    const m = /^([a-z0-9][a-z0-9._-]*)(?:\s{2,}(.+?)|\s+\((.+)\)|\s+-\s+(.+))?$/i.exec(line);
    if (m) {
      const id = m[1].trim();
      const label = (m[2] || m[3] || m[4] || id).trim();
      if (id && !seen.has(id)) {
        seen.add(id);
        parsed.push({ modelId: id, name: label });
      }
    }
  }
  return parsed;
}

const FALLBACK_MODES = [
  { id: "auto", name: "Auto", description: "Approve safe actions; ask before irreversible actions." },
  { id: "default", name: "Ask", description: "Ask before running commands or edits." },
  { id: "plan", name: "Plan", description: "Plan step-by-step before executing." },
  { id: "accept-edits", name: "Accept Edits", description: "Approve workspace edits automatically." },
];

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

function buildEnrichedPath() {
  const dirs = [
    path.dirname(process.execPath),
    path.join(HOME_DIR, ".local", "bin"),
    path.join(HOME_DIR, ".antigravity", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    ...(process.env.PATH ? process.env.PATH.split(path.delimiter) : []),
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ];
  const seen = new Set();
  const out = [];
  for (const d of dirs) {
    if (d && !seen.has(d)) {
      seen.add(d);
      out.push(d);
    }
  }
  return out.join(path.delimiter);
}

function discoverAgyBinary() {
  if (process.env.AGY_BIN) {
    if (process.env.AGY_BIN === "__NONE__") return null;
    if (fs.existsSync(process.env.AGY_BIN)) return process.env.AGY_BIN;
  }
  const candidates = [
    path.join(HOME_DIR, ".local", "bin", "agy"),
    path.join(HOME_DIR, ".antigravity", "bin", "agy"),
    "/opt/homebrew/bin/agy",
    "/usr/local/bin/agy",
    "/Applications/Antigravity.app/Contents/Resources/app/bin/agy",
    path.join(HOME_DIR, "Applications", "Antigravity.app", "Contents", "Resources", "app", "bin", "agy"),
  ];
  for (const p of buildEnrichedPath().split(path.delimiter)) {
    if (p) candidates.push(path.join(p, "agy"));
  }
  for (const bin of candidates) {
    try {
      fs.accessSync(bin, fs.constants.X_OK);
      return bin;
    } catch {}
  }
  return null;
}

function detectDesktopAppPath() {
  const candidates = [
    "/Applications/Antigravity.app",
    path.join(HOME_DIR, "Applications", "Antigravity.app"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function loadChromeSessionRegistry() {
  const ids = new Set();
  try {
    if (fs.existsSync(CHROME_SESSIONS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(CHROME_SESSIONS_FILE, "utf8"));
      if (Array.isArray(raw?.sessionIds)) {
        for (const id of raw.sessionIds) {
          if (typeof id === "string" && id.trim()) ids.add(id.trim());
        }
      }
    }
  } catch {}
  return ids;
}

function saveChromeSessionRegistry(idsSet) {
  try {
    fs.mkdirSync(path.dirname(CHROME_SESSIONS_FILE), { recursive: true, mode: 0o700 });
    const tmp = `${CHROME_SESSIONS_FILE}.tmp.${process.pid}`;
    fs.writeFileSync(
      tmp,
      JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), sessionIds: Array.from(idsSet) }, null, 2) +
        "\n",
      { encoding: "utf8", mode: 0o600 },
    );
    fs.renameSync(tmp, CHROME_SESSIONS_FILE);
  } catch {}
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
let lastDesktopActivityNotifyTs = 0;

function writeToExtension(obj) {
  if (shuttingDown) return false;
  try {
    const frame = encodeFrame(obj);
    return process.stdout.write(frame);
  } catch {
    return false;
  }
}

function emitExtensionNotification(method, params) {
  writeToExtension({
    jsonrpc: "2.0",
    method,
    params,
  });
}

function notifyDesktopBridgeStatus(lastMethod = null) {
  const now = Date.now();
  if (lastMethod && now - lastDesktopActivityNotifyTs < 400) return;
  lastDesktopActivityNotifyTs = now;
  emitExtensionNotification("desktopBridgeStatus", {
    desktopMcpClients: clients.size,
    lastMethod,
    ts: now,
  });
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

const AUTO_READ_ONLY_TOOLS = new Set([
  "read_file",
  "view_file",
  "view_file_outline",
  "view_code_item",
  "find_by_name",
  "grep_search",
  "list_dir",
  "list_resources",
  "read_resource",
  "search_web",
  "read_url_content",
]);

const AUTO_SAFE_COMPUTER_USE_TOOLS = new Set([
  "browser_list",
  "browser_open_tab",
  "browser_tab_state",
  "browser_tab_action",
  "browser_manage",
  "cursor_control",
  "get_state",
  "list_apps",
  "list_windows",
  "get_window_state",
  "permissions",
]);

function parseMaybeJsonObject(val) {
  if (!val) return null;
  if (typeof val === "object") return val;
  if (typeof val === "string") {
    try {
      const parsed = JSON.parse(val);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

function normalizePermissionMode(permissionMode, autoApprovePermissions = false) {
  const raw = String(permissionMode || "").trim().toLowerCase();
  if (raw === "full") return "full";
  if (raw === "ask" || raw === "default") return "ask";
  if (raw === "auto") return "auto";
  return autoApprovePermissions ? "full" : "auto";
}

function pickAllowOption(options) {
  const opts = Array.isArray(options) ? options : [];
  return opts.find((o) => /allow/i.test(o.kind || o.optionId || "")) || opts[0] || { optionId: "allow" };
}

function shouldAutoApprovePermission({ permissionMode, autoApprovePermissions = false, toolCall = null } = {}) {
  const normMode = normalizePermissionMode(permissionMode, autoApprovePermissions);
  if (autoApprovePermissions === true || normMode === "full") {
    return true;
  }
  if (normMode === "ask") {
    return false;
  }

  // "auto" mode: auto-approve read-only tools + `computer-use` browser/inspection MCP tools
  // (per-domain Site Access Governance `Allow` / `Ask` / `Block` & CAPTCHA guards protect web access),
  // while still requiring explicit approval for shell execution, filesystem writes, and macOS desktop mutations.
  const rawName = String(toolCall?.name || "").trim();
  if (!rawName) return false;
  if (AUTO_READ_ONLY_TOOLS.has(rawName)) {
    return true;
  }

  const rawArgs =
    parseMaybeJsonObject(toolCall?.args) ||
    parseMaybeJsonObject(toolCall?.rawInput) ||
    parseMaybeJsonObject(toolCall?.input) ||
    parseMaybeJsonObject(toolCall?.arguments);

  if (rawName === "call_mcp_tool" || /^call_mcp_tool$/i.test(rawName)) {
    const serverName = String(rawArgs?.ServerName ?? rawArgs?.serverName ?? rawArgs?.server_name ?? "")
      .trim()
      .toLowerCase();
    const mcpToolName = String(rawArgs?.ToolName ?? rawArgs?.toolName ?? rawArgs?.tool_name ?? "").trim();
    if (serverName !== "computer-use" && serverName !== "computer_use") {
      return false;
    }
    if (AUTO_SAFE_COMPUTER_USE_TOOLS.has(mcpToolName)) {
      return true;
    }
    if (mcpToolName === "batch_execute") {
      const innerArgs = parseMaybeJsonObject(rawArgs?.Arguments ?? rawArgs?.arguments) || {};
      const steps = Array.isArray(innerArgs.steps) ? innerArgs.steps : [];
      return steps.length > 0 && steps.every((s) => s && typeof s === "object" && s.kind !== "mac_action");
    }
    return false;
  }

  const directMcpMatch = /^(?:mcp_computer[-_]use_)?([a-z0-9_]+)$/i.exec(rawName);
  if (directMcpMatch) {
    const directTool = directMcpMatch[1];
    if (AUTO_SAFE_COMPUTER_USE_TOOLS.has(directTool)) {
      return true;
    }
    if (directTool === "batch_execute") {
      const steps = Array.isArray(rawArgs?.steps) ? rawArgs.steps : [];
      return steps.length > 0 && steps.every((s) => s && typeof s === "object" && s.kind !== "mac_action");
    }
  }

  return false;
}

/**
 * Persistent Agent Client Protocol (ACP) Bridge for the "Antigravity in Chrome" Side Panel.
 * Runs `agy acp --app-data-dir antigravity` so chats started in the Chrome Side Panel are saved
 * directly into Antigravity Desktop's conversation store (viewable & continuable in Antigravity.app),
 * while strictly blocking Desktop-originated chats from being opened inside the Chrome Side Panel.
 */
class AcpSidePanelBridge {
  constructor() {
    this.proc = null;
    this.rl = null;
    this.initPromise = null;
    this.nextRpcId = 1;
    this.pendingRpc = new Map(); // id -> { resolve, reject, timer }
    this.loadedSessions = new Set();
    this.sessionPromptContext = new Map(); // sessionId -> { requestId, permissionMode, autoApprovePermissions, title, replayCollector }
    this.requestConfigOverrides = new Map(); // requestId -> { permissionMode, autoApprovePermissions }
    this.canceledRequests = new Set(); // requestIds canceled while cold-starting
    this.pendingPermissions = new Map(); // permRequestId -> { acpId, sessionId, requestId, toolCall, options }
    this.nextPermId = 1;
    this.chromeSessionIds = loadChromeSessionRegistry();

    this.agentInfo = null;
    this.capabilities = null;
    this.cachedModels = FALLBACK_MODELS;
    this.currentModelId = "gemini-4-carbon-medium";
    this.currentThoughtLevel = "medium";
    this.cachedModes = FALLBACK_MODES;
    this.currentModeId = "auto";
    this.currentPermissionMode = "auto";
    this.cachedConfigOptions = [];
    this.cachedCommands = [];
    this.cachedTier = null;
    this.cliModelsFetched = false;
  }

  assertChromeSessionAllowed(sessionId) {
    const sid = String(sessionId || "").trim();
    if (!sid || !this.chromeSessionIds.has(sid)) {
      const err = new Error(
        "Conversations created in the Antigravity Desktop App cannot be opened in Antigravity in Chrome. Start a chat in this Side Panel to view it in both Chrome and the Desktop App.",
      );
      err.code = -32010;
      throw err;
    }
    return sid;
  }

  registerChromeSession(sessionId) {
    const sid = String(sessionId || "").trim();
    if (!sid) return;
    if (!this.chromeSessionIds.has(sid)) {
      this.chromeSessionIds.add(sid);
      saveChromeSessionRegistry(this.chromeSessionIds);
    }
  }

  updateSessionCatalog(resultObj) {
    if (!resultObj || typeof resultObj !== "object") return;
    if (Array.isArray(resultObj.models?.availableModels) && resultObj.models.availableModels.length > 0) {
      this.cachedModels = resultObj.models.availableModels;
    }
    if (resultObj.models?.currentModelId) {
      this.currentModelId = resultObj.models.currentModelId;
    }
    if (Array.isArray(resultObj.modes?.availableModes) && resultObj.modes.availableModes.length > 0) {
      this.cachedModes = resultObj.modes.availableModes;
    }
    if (resultObj.modes?.currentModeId) {
      this.currentModeId = resultObj.modes.currentModeId;
    }
    if (Array.isArray(resultObj.configOptions)) {
      this.cachedConfigOptions = resultObj.configOptions;
      const thoughtOpt = resultObj.configOptions.find((o) => o && o.id === "thought_level");
      if (thoughtOpt?.currentValue) {
        this.currentThoughtLevel = String(thoughtOpt.currentValue).toLowerCase();
      }
    }
    if (resultObj._meta?.antigravity?.tier) {
      this.cachedTier = resultObj._meta.antigravity.tier;
    }
  }

  async fetchCliModelsOnce(agyPath) {
    if (this.cliModelsFetched || !agyPath) return;
    this.cliModelsFetched = true;
    await new Promise((resolve) => {
      execFile(
        agyPath,
        ["models"],
        { env: { ...process.env, PATH: buildEnrichedPath() }, timeout: 4000 },
        (err, stdout) => {
          if (!err && stdout) {
            const parsed = parseCliModelsOutput(stdout);
            if (parsed.length > 0 && this.cachedModels === FALLBACK_MODELS) {
              this.cachedModels = parsed;
            }
          }
          resolve();
        },
      );
    });
  }

  async ensureInitialized() {
    if (this.proc && this.initPromise) {
      return this.initPromise;
    }
    const agyPath = discoverAgyBinary();
    if (!agyPath) {
      const err = new Error(
        "Antigravity CLI ('agy') was not found on this Mac. Install it from Antigravity Settings → CLI (or ensure ~/.local/bin/agy is executable) to chat in the Side Panel.",
      );
      err.code = -32011;
      throw err;
    }

    this.initPromise = (async () => {
      try {
        fs.mkdirSync(DEFAULT_ACP_CWD, { recursive: true });
      } catch {}

      const acpArgs = ["acp", "--app-data-dir", ACP_APP_DATA_DIR];
      const child = spawn(agyPath, acpArgs, {
        cwd: fs.existsSync(DEFAULT_ACP_CWD) ? DEFAULT_ACP_CWD : HOME_DIR,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          PATH: buildEnrichedPath(),
        },
      });

      this.proc = child;
      this.loadedSessions.clear();
      this.rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });

      this.rl.on("line", (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let msg;
        try {
          msg = JSON.parse(trimmed);
        } catch {
          return;
        }
        this.handleAcpMessage(msg);
      });

      let stderrTail = "";
      child.stderr.on("data", (chunk) => {
        stderrTail = (stderrTail + chunk.toString("utf8")).slice(-2000);
      });

      const handleExit = (code, signal) => {
        if (this.proc === child) {
          this.proc = null;
          this.initPromise = null;
          this.loadedSessions.clear();
          const errMsg = `Antigravity ACP server exited (${signal || code || 0})${stderrTail ? `: ${stderrTail.trim()}` : ""}`;
          for (const [, pending] of this.pendingRpc.entries()) {
            clearTimeout(pending.timer);
            pending.reject(new Error(errMsg));
          }
          this.pendingRpc.clear();
          this.pendingPermissions.clear();
        }
      };

      child.on("exit", handleExit);
      child.on("error", (err) => handleExit(1, err.message));

      const initRes = await this.sendAcpRpc(
        "initialize",
        {
          protocolVersion: 1,
          clientCapabilities: {},
          clientInfo: {
            name: "antigravity-in-chrome",
            version: "3.0.0",
          },
        },
        15_000,
      );
      this.agentInfo = initRes?.agentInfo || { name: "Antigravity ACP Server" };
      this.capabilities = initRes?.agentCapabilities || {};
      return initRes;
    })();

    try {
      return await this.initPromise;
    } catch (err) {
      this.initPromise = null;
      throw err;
    }
  }

  sendAcpRpc(method, params = {}, timeoutMs = 0) {
    if (!this.proc || !this.proc.stdin.writable) {
      return Promise.reject(new Error("Antigravity ACP process is not running"));
    }
    const id = this.nextRpcId++;
    return new Promise((resolve, reject) => {
      let timer = null;
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          this.pendingRpc.delete(id);
          reject(new Error(`ACP request '${method}' timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }
      this.pendingRpc.set(id, { resolve, reject, timer });
      try {
        this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      } catch (err) {
        if (timer) clearTimeout(timer);
        this.pendingRpc.delete(id);
        reject(err);
      }
    });
  }

  sendAcpNotification(method, params = {}) {
    if (!this.proc || !this.proc.stdin.writable) return false;
    try {
      this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
      return true;
    } catch {
      return false;
    }
  }

  sendAcpResponse(id, result) {
    if (!this.proc || !this.proc.stdin.writable) return false;
    try {
      this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
      return true;
    } catch {
      return false;
    }
  }

  handleAcpMessage(msg) {
    if (!msg || typeof msg !== "object") return;

    // 1. Response to an ACP request we sent
    if (msg.id !== undefined && msg.id !== null && !msg.method) {
      const waiter = this.pendingRpc.get(msg.id);
      if (waiter) {
        this.pendingRpc.delete(msg.id);
        if (waiter.timer) clearTimeout(waiter.timer);
        if (msg.error) {
          const err = new Error(msg.error.message || JSON.stringify(msg.error));
          err.code = msg.error.code;
          waiter.reject(err);
        } else {
          waiter.resolve(msg.result);
        }
      }
      return;
    }

    // 2. Server-initiated Permission Request (`session/request_permission`)
    if (msg.method === "session/request_permission" && msg.id !== undefined) {
      const sessionId = msg.params?.sessionId || "";
      const ctx = this.sessionPromptContext.get(sessionId);
      const options = Array.isArray(msg.params?.options) ? msg.params.options : [];
      const toolCall = msg.params?.toolCall || null;
      const effectivePermMode = ctx?.permissionMode || this.currentPermissionMode || "auto";
      const effectiveAutoApprove = Boolean(ctx?.autoApprovePermissions);
      if (
        shouldAutoApprovePermission({
          permissionMode: effectivePermMode,
          autoApprovePermissions: effectiveAutoApprove,
          toolCall,
        })
      ) {
        const allowOpt = pickAllowOption(options);
        this.sendAcpResponse(msg.id, {
          outcome: { outcome: "selected", optionId: allowOpt.optionId },
        });
        return;
      }

      const permRequestId = `perm-${this.nextPermId++}`;
      this.pendingPermissions.set(permRequestId, {
        acpId: msg.id,
        sessionId,
        requestId: ctx?.requestId || null,
        toolCall,
        options,
      });
      emitExtensionNotification("agentEvent", {
        event: "permission_request",
        requestId: ctx?.requestId || null,
        permRequestId,
        sessionId,
        toolCall,
        options,
      });
      return;
    }

    // 3. Streaming Session Updates (`session/update`)
    if (msg.method === "session/update" && msg.params) {
      const sessionId = msg.params.sessionId || "";
      const update = msg.params.update || {};
      const ctx = this.sessionPromptContext.get(sessionId);

      if (update.sessionUpdate === "available_commands_update" && Array.isArray(update.availableCommands)) {
        this.cachedCommands = update.availableCommands;
      }
      if (update.sessionUpdate === "config_option_update" && Array.isArray(update.configOptions)) {
        this.cachedConfigOptions = update.configOptions;
      }
      if (update.sessionUpdate === "current_mode_update" && update.currentModeId) {
        this.currentModeId = update.currentModeId;
      }
      if (update.sessionUpdate === "session_info_update" && update.title && ctx) {
        ctx.title = update.title;
      }

      if (ctx?.replayCollector) {
        ctx.replayCollector.push(update);
        return;
      }

      emitExtensionNotification("agentEvent", {
        event: "session_update",
        requestId: ctx?.requestId || null,
        sessionId,
        update,
      });
    }
  }

  async getStatus({ warm = false } = {}) {
    const agyPath = discoverAgyBinary();
    const desktopAppPath = detectDesktopAppPath();
    if (warm && agyPath) {
      await Promise.allSettled([this.ensureInitialized(), this.fetchCliModelsOnce(agyPath)]);
    }
    return {
      ok: true,
      agyFound: Boolean(agyPath),
      agyPath,
      desktopAppFound: Boolean(desktopAppPath),
      desktopAppPath,
      acpReady: Boolean(this.proc),
      agentInfo: this.agentInfo,
      models: this.cachedModels,
      currentModelId: this.currentModelId,
      currentThoughtLevel: this.currentThoughtLevel,
      modes: this.cachedModes,
      currentModeId: this.currentModeId,
      configOptions: this.cachedConfigOptions,
      availableCommands: this.cachedCommands,
      tier: this.cachedTier,
      desktopMcpClients: clients.size,
    };
  }

  resolveTargetCwd(rawCwd) {
    const isDir = (dirPath) => {
      try {
        return Boolean(dirPath) && fs.statSync(dirPath).isDirectory();
      } catch {
        return false;
      }
    };
    if (rawCwd && typeof rawCwd === "string") {
      let candidate = rawCwd.trim();
      if (candidate === "~") {
        candidate = HOME_DIR;
      } else if (candidate.startsWith("~/")) {
        candidate = path.join(HOME_DIR, candidate.slice(2));
      }
      if (candidate) {
        const resolved = path.resolve(candidate);
        if (isDir(resolved)) {
          return resolved;
        }
      }
    }
    return isDir(DEFAULT_ACP_CWD) ? DEFAULT_ACP_CWD : HOME_DIR;
  }

  async createSession({ cwd, systemPromptAppend, modeId, modelId, thoughtLevel } = {}) {
    await this.ensureInitialized();
    const targetCwd = this.resolveTargetCwd(cwd);
    const appendText = [DEFAULT_CHROME_SYSTEM_PROMPT, systemPromptAppend].filter(Boolean).join("\n\n");
    const res = await this.sendAcpRpc(
      "session/new",
      {
        cwd: targetCwd,
        mcpServers: [],
        _meta: {
          antigravity: {
            systemPrompt: {
              append: appendText,
            },
          },
        },
      },
      20_000,
    );
    const sessionId = res?.sessionId;
    if (!sessionId) {
      throw new Error("ACP session/new did not return a sessionId");
    }
    this.registerChromeSession(sessionId);
    this.loadedSessions.add(sessionId);
    this.updateSessionCatalog(res);

    if (modeId) {
      await this.sendAcpRpc("session/set_mode", { sessionId, modeId }, 10_000).catch(() => {});
      this.currentModeId = modeId;
    }
    if (modelId) {
      await this.sendAcpRpc("session/set_model", { sessionId, modelId }, 10_000).catch(() => {});
      this.currentModelId = modelId;
    }
    const normThought = ["low", "medium", "high"].includes(String(thoughtLevel || "").toLowerCase())
      ? String(thoughtLevel).toLowerCase()
      : null;
    if (normThought) {
      await this.sendAcpRpc(
        "session/set_config_option",
        { sessionId, configId: "thought_level", value: normThought },
        10_000,
      ).catch(() => {});
      this.currentThoughtLevel = normThought;
    }

    return {
      ok: true,
      sessionId,
      models: this.cachedModels,
      currentModelId: modelId || res?.models?.currentModelId || this.currentModelId,
      currentThoughtLevel: this.currentThoughtLevel,
      modes: this.cachedModes,
      currentModeId: modeId || res?.modes?.currentModeId || this.currentModeId,
      configOptions: this.cachedConfigOptions,
      tier: this.cachedTier,
    };
  }

  async loadSession({ sessionId, cwd } = {}) {
    const sid = this.assertChromeSessionAllowed(sessionId);
    await this.ensureInitialized();
    const targetCwd = this.resolveTargetCwd(cwd);

    // Close first if already active in memory so `session/load` cleanly replays latest transcript
    if (this.loadedSessions.has(sid)) {
      await this.sendAcpRpc("session/close", { sessionId: sid }, 5_000).catch(() => {});
      this.loadedSessions.delete(sid);
    }

    const replayCollector = [];
    this.sessionPromptContext.set(sid, {
      requestId: null,
      autoApprovePermissions: false,
      title: null,
      replayCollector,
    });

    let loadRes;
    try {
      loadRes = await this.sendAcpRpc(
        "session/load",
        {
          sessionId: sid,
          cwd: targetCwd,
          mcpServers: [],
        },
        20_000,
      );
      this.loadedSessions.add(sid);
      this.updateSessionCatalog(loadRes);
    } finally {
      this.sessionPromptContext.delete(sid);
    }

    // Reconstruct clean turn-by-turn messages from replayed ACP updates
    const messages = [];
    let title = null;
    for (const u of replayCollector) {
      if (u.sessionUpdate === "session_info_update" && u.title) {
        title = u.title;
      } else if (u.sessionUpdate === "user_message_chunk") {
        const text = u.content?.text || "";
        const prev = messages[messages.length - 1];
        if (prev && prev.role === "user") {
          prev.text += text;
        } else if (text) {
          messages.push({ role: "user", text });
        }
      } else if (u.sessionUpdate === "agent_message_chunk") {
        const text = u.content?.text || "";
        const prev = messages[messages.length - 1];
        if (prev && prev.role === "assistant") {
          prev.text += text;
        } else if (text) {
          messages.push({ role: "assistant", text, thoughts: "", toolCalls: [] });
        }
      } else if (u.sessionUpdate === "agent_thought_chunk") {
        const thought = u.content?.text || "";
        let prev = messages[messages.length - 1];
        if (!prev || prev.role !== "assistant") {
          prev = { role: "assistant", text: "", thoughts: "", toolCalls: [] };
          messages.push(prev);
        }
        prev.thoughts = (prev.thoughts || "") + thought;
      } else if (u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update") {
        let prev = messages[messages.length - 1];
        if (!prev || prev.role !== "assistant") {
          prev = { role: "assistant", text: "", thoughts: "", toolCalls: [] };
          messages.push(prev);
        }
        if (!Array.isArray(prev.toolCalls)) prev.toolCalls = [];
        const existing = prev.toolCalls.find((tc) => tc.toolCallId === u.toolCallId);
        if (existing) {
          Object.assign(existing, {
            status: u.status || existing.status,
            title: u.title || existing.title,
          });
        } else {
          prev.toolCalls.push({
            toolCallId: u.toolCallId,
            name: u.name || "tool",
            title: u.title || u.name || "Tool",
            status: u.status || "completed",
            kind: u.kind || "other",
          });
        }
      }
    }

    return {
      ok: true,
      sessionId: sid,
      title,
      messages,
      models: this.cachedModels,
      currentModelId: loadRes?.models?.currentModelId || this.currentModelId,
      modes: this.cachedModes,
      currentModeId: loadRes?.modes?.currentModeId || this.currentModeId,
    };
  }

  async ensureSessionResumed(sessionId, cwd) {
    const sid = this.assertChromeSessionAllowed(sessionId);
    await this.ensureInitialized();
    if (this.loadedSessions.has(sid)) return sid;
    const targetCwd = this.resolveTargetCwd(cwd);
    const res = await this.sendAcpRpc(
      "session/resume",
      {
        sessionId: sid,
        cwd: targetCwd,
      },
      15_000,
    );
    this.loadedSessions.add(sid);
    this.updateSessionCatalog(res);
    return sid;
  }

  resolveNewlyAllowedPendingPermissions(filterSessionId = null) {
    const resolvedIds = [];
    for (const [permRequestId, perm] of Array.from(this.pendingPermissions.entries())) {
      if (filterSessionId && perm.sessionId && perm.sessionId !== filterSessionId) continue;
      const ctx = this.sessionPromptContext.get(perm.sessionId);
      const effectivePermMode = ctx?.permissionMode || this.currentPermissionMode || "auto";
      const effectiveAutoApprove = Boolean(ctx?.autoApprovePermissions);
      if (
        shouldAutoApprovePermission({
          permissionMode: effectivePermMode,
          autoApprovePermissions: effectiveAutoApprove,
          toolCall: perm.toolCall,
        })
      ) {
        this.pendingPermissions.delete(permRequestId);
        const allowOpt = pickAllowOption(perm.options);
        this.sendAcpResponse(perm.acpId, {
          outcome: { outcome: "selected", optionId: allowOpt.optionId },
        });
        resolvedIds.push(permRequestId);
        emitExtensionNotification("agentEvent", {
          event: "permission_resolved",
          requestId: perm.requestId || ctx?.requestId || null,
          permRequestId,
          sessionId: perm.sessionId,
          optionId: allowOpt.optionId,
        });
      }
    }
    return resolvedIds;
  }

  async prompt({
    requestId = null,
    sessionId = null,
    promptBlocks = [],
    text = "",
    modeId = null,
    permissionMode = null,
    modelId = null,
    thoughtLevel = null,
    autoApprovePermissions = false,
    systemPromptAppend = "",
    cwd = null,
  } = {}) {
    const reqKey = requestId ? String(requestId) : "";
    if (reqKey && this.canceledRequests.has(reqKey)) {
      this.canceledRequests.delete(reqKey);
      this.requestConfigOverrides.delete(reqKey);
      return {
        ok: true,
        sessionId: sessionId ? String(sessionId).trim() : null,
        title: null,
        stopReason: "cancelled",
        usage: null,
      };
    }

    const initialPermMode = normalizePermissionMode(
      permissionMode ?? (modeId === "default" ? "ask" : null),
      autoApprovePermissions,
    );
    this.currentPermissionMode = initialPermMode;

    let sid = sessionId ? String(sessionId).trim() : "";
    if (!sid) {
      const created = await this.createSession({ cwd, systemPromptAppend, modeId, modelId, thoughtLevel });
      sid = created.sessionId;
      emitExtensionNotification("agentEvent", {
        event: "session_created",
        requestId,
        sessionId: sid,
        models: created.models,
        currentModelId: created.currentModelId,
        currentThoughtLevel: created.currentThoughtLevel,
        modes: created.modes,
        currentModeId: created.currentModeId,
      });
    } else {
      await this.ensureSessionResumed(sid, cwd);
      if (modeId) {
        await this.sendAcpRpc("session/set_mode", { sessionId: sid, modeId }, 10_000).catch(() => {});
        this.currentModeId = modeId;
      }
      if (modelId) {
        await this.sendAcpRpc("session/set_model", { sessionId: sid, modelId }, 10_000).catch(() => {});
        this.currentModelId = modelId;
      }
      const normThought = ["low", "medium", "high"].includes(String(thoughtLevel || "").toLowerCase())
        ? String(thoughtLevel).toLowerCase()
        : null;
      if (normThought) {
        await this.sendAcpRpc(
          "session/set_config_option",
          { sessionId: sid, configId: "thought_level", value: normThought },
          10_000,
        ).catch(() => {});
        this.currentThoughtLevel = normThought;
      }
    }

    if (reqKey && this.canceledRequests.has(reqKey)) {
      this.canceledRequests.delete(reqKey);
      this.requestConfigOverrides.delete(reqKey);
      return {
        ok: true,
        sessionId: sid,
        title: null,
        stopReason: "cancelled",
        usage: null,
      };
    }

    const blocks =
      Array.isArray(promptBlocks) && promptBlocks.length > 0
        ? promptBlocks
        : [{ type: "text", text: String(text || "") }];

    const override = reqKey ? this.requestConfigOverrides.get(reqKey) : null;
    if (reqKey) this.requestConfigOverrides.delete(reqKey);
    const resolvedAutoApprove =
      override?.autoApprovePermissions !== undefined
        ? Boolean(override.autoApprovePermissions)
        : Boolean(autoApprovePermissions);
    const resolvedPermMode = normalizePermissionMode(
      override?.permissionMode ?? initialPermMode,
      resolvedAutoApprove,
    );
    this.currentPermissionMode = resolvedPermMode;

    const ctx = {
      requestId,
      permissionMode: resolvedPermMode,
      autoApprovePermissions: resolvedAutoApprove || resolvedPermMode === "full",
      title: null,
      replayCollector: null,
    };
    this.sessionPromptContext.set(sid, ctx);

    try {
      const promptRes = await this.sendAcpRpc(
        "session/prompt",
        {
          sessionId: sid,
          prompt: blocks,
        },
        0,
      );
      return {
        ok: true,
        sessionId: sid,
        title: ctx.title || null,
        stopReason: promptRes?.stopReason || "end_turn",
        usage: promptRes?.usage || null,
      };
    } finally {
      if (reqKey) {
        this.canceledRequests.delete(reqKey);
        this.requestConfigOverrides.delete(reqKey);
      }
      this.sessionPromptContext.delete(sid);
      for (const [permId, permInfo] of Array.from(this.pendingPermissions.entries())) {
        if (permInfo.sessionId === sid) {
          this.pendingPermissions.delete(permId);
        }
      }
    }
  }

  async cancel({ sessionId, requestId } = {}) {
    const reqKey = requestId ? String(requestId).trim() : "";
    if (reqKey) {
      if (this.canceledRequests.size >= 200) {
        const oldest = this.canceledRequests.values().next().value;
        if (oldest) this.canceledRequests.delete(oldest);
      }
      this.canceledRequests.add(reqKey);
      this.requestConfigOverrides.delete(reqKey);
    }

    let rawSid = sessionId ? String(sessionId).trim() : "";
    if (!rawSid && reqKey) {
      for (const [activeSid, ctx] of this.sessionPromptContext.entries()) {
        if (ctx && String(ctx.requestId || "") === reqKey) {
          rawSid = activeSid;
          break;
        }
      }
    }

    if (!rawSid) {
      if (reqKey) {
        return { ok: true, sessionId: null, deferredCancel: true, requestId: reqKey };
      }
      throw Object.assign(new Error("Missing sessionId"), { code: -32602 });
    }

    const sid = this.assertChromeSessionAllowed(rawSid);
    for (const [permId, permInfo] of Array.from(this.pendingPermissions.entries())) {
      if (permInfo.sessionId === sid) {
        this.pendingPermissions.delete(permId);
        this.sendAcpResponse(permInfo.acpId, {
          outcome: { outcome: "cancelled" },
        });
      }
    }
    this.sendAcpNotification("session/cancel", { sessionId: sid });
    return { ok: true, sessionId: sid };
  }

  async respondPermission({ permRequestId, optionId } = {}) {
    const pending = this.pendingPermissions.get(String(permRequestId || ""));
    if (!pending) {
      return { ok: false, expired: true };
    }
    this.pendingPermissions.delete(String(permRequestId));
    if (!optionId || optionId === "__cancel__") {
      this.sendAcpResponse(pending.acpId, {
        outcome: { outcome: "cancelled" },
      });
    } else {
      this.sendAcpResponse(pending.acpId, {
        outcome: { outcome: "selected", optionId: String(optionId) },
      });
    }
    return { ok: true, sessionId: pending.sessionId };
  }

  async setConfig({
    sessionId,
    requestId,
    modeId,
    modelId,
    thoughtLevel,
    permissionMode,
    autoApprovePermissions,
    configId,
    value,
  } = {}) {
    const normThought = ["low", "medium", "high"].includes(String(thoughtLevel || "").toLowerCase())
      ? String(thoughtLevel).toLowerCase()
      : null;

    const hasPermUpdate = permissionMode !== undefined || autoApprovePermissions !== undefined;
    let resolvedPermissions = [];
    let derivedModeId = modeId || null;

    if (hasPermUpdate) {
      const nextPermMode = normalizePermissionMode(permissionMode ?? this.currentPermissionMode, autoApprovePermissions);
      const nextAutoApprove =
        autoApprovePermissions !== undefined ? Boolean(autoApprovePermissions) : nextPermMode === "full";
      this.currentPermissionMode = nextPermMode;
      if (!derivedModeId) {
        derivedModeId = nextPermMode === "ask" ? "default" : "auto";
      }

      const targetSid = sessionId ? String(sessionId).trim() : "";
      const reqKey = requestId ? String(requestId).trim() : "";
      let matchedActiveCtx = false;

      for (const [activeSid, ctx] of this.sessionPromptContext.entries()) {
        if (!ctx || ctx.replayCollector) continue;
        if (
          (targetSid && activeSid === targetSid) ||
          (reqKey && String(ctx.requestId || "") === reqKey) ||
          (!targetSid && !reqKey)
        ) {
          ctx.permissionMode = nextPermMode;
          ctx.autoApprovePermissions = nextAutoApprove;
          matchedActiveCtx = true;
        }
      }

      if (reqKey && !matchedActiveCtx) {
        if (this.requestConfigOverrides.size >= 200) {
          const oldest = this.requestConfigOverrides.values().next().value;
          if (oldest) this.requestConfigOverrides.delete(oldest);
        }
        this.requestConfigOverrides.set(reqKey, {
          permissionMode: nextPermMode,
          autoApprovePermissions: nextAutoApprove,
        });
      }

      // Immediately resolve any waiting permission prompts that are now permitted!
      resolvedPermissions = this.resolveNewlyAllowedPendingPermissions(targetSid || null);
    }

    const rawSid = sessionId ? String(sessionId).trim() : "";
    if (!rawSid) {
      if (derivedModeId) this.currentModeId = derivedModeId;
      if (modelId) this.currentModelId = modelId;
      if (normThought) this.currentThoughtLevel = normThought;
      return { ok: true, deferred: true, resolvedPermissions };
    }

    // If a turn is actively running on this session and only permissionMode changed,
    // do not block on ensureSessionResumed / session/set_mode while session/prompt is in flight.
    if (this.sessionPromptContext.has(rawSid) && hasPermUpdate && !modeId && !modelId && !normThought && !configId) {
      if (derivedModeId) {
        this.currentModeId = derivedModeId;
        this.sendAcpRpc("session/set_mode", { sessionId: rawSid, modeId: derivedModeId }, 5_000).catch(() => {});
      }
      return { ok: true, sessionId: rawSid, permissionMode: this.currentPermissionMode, resolvedPermissions };
    }

    const sid = await this.ensureSessionResumed(rawSid);
    if (derivedModeId) {
      await this.sendAcpRpc("session/set_mode", { sessionId: sid, modeId: derivedModeId }, 10_000).catch(() => {});
      this.currentModeId = derivedModeId;
    }
    if (modelId) {
      await this.sendAcpRpc("session/set_model", { sessionId: sid, modelId }, 10_000);
      this.currentModelId = modelId;
    }
    if (normThought) {
      await this.sendAcpRpc(
        "session/set_config_option",
        { sessionId: sid, configId: "thought_level", value: normThought },
        10_000,
      ).catch(() => {});
      this.currentThoughtLevel = normThought;
    }
    if (configId && value !== undefined) {
      await this.sendAcpRpc("session/set_config_option", { sessionId: sid, configId, value }, 10_000);
    }
    return { ok: true, sessionId: sid, resolvedPermissions };
  }

  async openInDesktopApp({ sessionId } = {}) {
    if (sessionId) {
      this.assertChromeSessionAllowed(sessionId);
    }
    const appPath = detectDesktopAppPath();
    if (process.env.AG_MOCK_OPEN_DESKTOP === "1") {
      return { ok: true, launched: true, mock: true, sessionId: sessionId || null };
    }
    if (!appPath) {
      throw new Error("Antigravity.app was not found in /Applications.");
    }
    await new Promise((resolve, reject) => {
      const child = spawn("open", ["-a", appPath], {
        detached: true,
        stdio: "ignore",
      });
      child.on("error", reject);
      child.on("spawn", () => {
        child.unref();
        resolve();
      });
    });
    return {
      ok: true,
      launched: true,
      appPath,
      sessionId: sessionId || null,
    };
  }

  shutdown() {
    if (!this.proc) return;
    try {
      for (const sid of this.loadedSessions) {
        this.sendAcpNotification("session/close", { sessionId: sid });
      }
    } catch {}
    try {
      this.rl?.close();
    } catch {}
    try {
      this.proc.kill("SIGTERM");
    } catch {}
    this.proc = null;
    this.initPromise = null;
    this.canceledRequests.clear();
  }
}

const acpBridge = new AcpSidePanelBridge();

const extensionAgentRpcHandlers = {
  "agent.getStatus": (params) => acpBridge.getStatus(params),
  "agent.createSession": (params) => acpBridge.createSession(params),
  "agent.loadSession": (params) => acpBridge.loadSession(params),
  "agent.prompt": (params) => acpBridge.prompt(params),
  "agent.cancel": (params) => acpBridge.cancel(params),
  "agent.respondPermission": (params) => acpBridge.respondPermission(params),
  "agent.setConfig": (params) => acpBridge.setConfig(params),
  "agent.openInDesktopApp": (params) => acpBridge.openInDesktopApp(params),
};

const server = net.createServer((sock) => {
  const connId = String(nextConnId++);
  clients.set(connId, sock);
  notifyDesktopBridgeStatus("connected");

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
      if (msg.method && msg.method !== "ping" && msg.method !== "getInfo" && msg.method !== "listAllTabs") {
        notifyDesktopBridgeStatus(msg.method);
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
    const had = clients.delete(connId);
    for (const [muxId, entry] of inflightToClient.entries()) {
      if (entry.connId === connId) {
        inflightToClient.delete(muxId);
      }
    }
    if (had) {
      notifyDesktopBridgeStatus("disconnected");
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

    // 1. Extension Side Panel -> Native Host Agent RPC Request
    if (typeof msg.method === "string" && Object.hasOwn(extensionAgentRpcHandlers, msg.method)) {
      const reqId = msg.id;
      const handler = extensionAgentRpcHandlers[msg.method];
      Promise.resolve()
        .then(() => handler(msg.params || {}))
        .then((result) => {
          if (reqId !== undefined && reqId !== null) {
            writeToExtension({
              jsonrpc: "2.0",
              id: reqId,
              result,
            });
          }
        })
        .catch((err) => {
          if (reqId !== undefined && reqId !== null) {
            writeToExtension({
              jsonrpc: "2.0",
              id: reqId,
              error: {
                code: typeof err?.code === "number" ? err.code : -32000,
                message: err?.message || String(err),
              },
            });
          }
        });
      return;
    }

    // 2. Response from Extension to a multiplexed Unix socket MCP client request
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

    // 3. Extension-originated notification for Unix socket MCP clients
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
  acpBridge.shutdown();
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
