#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const SERVER_ENTRY = path.join(PROJECT_ROOT, "src", "server.mjs");
const DEFAULT_CONFIG_PATH = path.join(os.homedir(), ".gemini", "config", "mcp_config.json");

const args = new Set(process.argv.slice(2));
const isUninstall = args.has("--uninstall");
const isDryRun = args.has("--dry-run");
const isCheckOnly = args.has("--check");
const promptPermissions = !args.has("--no-prompt-permissions") && !isDryRun && !isCheckOnly;

const configFlagIdx = process.argv.indexOf("--config");
const configPath =
  configFlagIdx !== -1 && process.argv[configFlagIdx + 1]
    ? path.resolve(process.argv[configFlagIdx + 1])
    : DEFAULT_CONFIG_PATH;

function checkPlatformAndNode() {
  if (process.platform !== "darwin") {
    throw new Error(`This MCP server requires macOS (detected platform: ${process.platform}).`);
  }
  const major = Number(process.versions.node.split(".")[0]);
  if (!Number.isFinite(major) || major < 22) {
    throw new Error(
      `Node.js >= 22.0.0 is required (current: v${process.versions.node} at ${process.execPath}). Install Node 22+ via Homebrew ('brew install node') or nvm ('nvm install 22').`,
    );
  }
  if (typeof globalThis.WebSocket !== "function" || typeof globalThis.fetch !== "function") {
    throw new Error(`Node.js runtime at ${process.execPath} is missing global WebSocket or fetch.`);
  }
}

function buildEnvPath(nodeBinPath) {
  const nodeDir = path.dirname(nodeBinPath);
  const stdDirs = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  const seen = new Set();
  const ordered = [];
  for (const d of [nodeDir, ...stdDirs]) {
    if (d && !seen.has(d)) {
      seen.add(d);
      ordered.push(d);
    }
  }
  return ordered.join(":");
}

function readMcpConfig(filePath) {
  if (!fs.existsSync(filePath)) {
    return { mcpServers: {} };
  }
  const raw = fs.readFileSync(filePath, "utf8").trim();
  if (!raw) {
    return { mcpServers: {} };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Existing ${filePath} is not valid JSON: ${err.message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Existing ${filePath} root must be a JSON object.`);
  }
  if (!parsed.mcpServers || typeof parsed.mcpServers !== "object" || Array.isArray(parsed.mcpServers)) {
    parsed.mcpServers = {};
  }
  return parsed;
}

function writeJsonAtomic(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp.${process.pid}`;
  fs.writeFileSync(tmpPath, JSON.stringify(obj, null, 2) + "\n", "utf8");
  fs.renameSync(tmpPath, filePath);
}

async function verifyServerAndPermissions({ requestPrompt = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER_ENTRY], {
      cwd: PROJECT_ROOT,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        PATH: buildEnvPath(process.execPath),
      },
    });

    let stderrBuf = "";
    child.stderr.on("data", (chunk) => {
      stderrBuf += chunk.toString("utf8");
    });

    const pending = new Map();
    let nextId = 1;
    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });

    const cleanup = () => {
      try {
        rl.close();
      } catch {}
      try {
        child.kill("SIGTERM");
      } catch {}
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out verifying MCP server over stdio. Stderr: ${stderrBuf}`));
    }, 20000);

    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let msg;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        return;
      }
      if (msg.id != null && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message || JSON.stringify(msg.error)));
        else res(msg.result);
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      cleanup();
      reject(err);
    });

    const rpc = (method, params = {}) =>
      new Promise((res, rej) => {
        const id = nextId++;
        pending.set(id, { res, rej });
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });

    (async () => {
      try {
        const initRes = await rpc("initialize", {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "antigravity-setup-verifier", version: "1.0.0" },
        });
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

        const toolsRes = await rpc("tools/list", {});
        const toolNames = (toolsRes?.tools ?? []).map((t) => t.name);

        const permRes = await rpc("tools/call", {
          name: "permissions",
          arguments: requestPrompt
            ? { request: true, prompt_accessibility: true, prompt_screen_capture: false }
            : { request: false },
        });
        let permData = {};
        const txt = permRes?.content?.[0]?.text;
        if (txt) {
          try {
            permData = JSON.parse(txt);
          } catch {}
        }

        clearTimeout(timer);
        cleanup();
        resolve({
          serverInfo: initRes?.serverInfo,
          toolCount: toolNames.length,
          toolNames,
          permissions: permData,
        });
      } catch (err) {
        clearTimeout(timer);
        cleanup();
        reject(err);
      }
    })();
  });
}

async function main() {
  checkPlatformAndNode();

  const nodePath = fs.realpathSync(process.execPath);
  const envPath = buildEnvPath(nodePath);

  if (isUninstall) {
    if (!fs.existsSync(configPath)) {
      console.log(`Nothing to remove (${configPath} does not exist).`);
      return;
    }
    const cfg = readMcpConfig(configPath);
    if (cfg.mcpServers["computer-use"]) {
      delete cfg.mcpServers["computer-use"];
      if (!isDryRun) {
        writeJsonAtomic(configPath, cfg);
      }
      console.log(`${isDryRun ? "[Dry Run] Would remove" : "Removed"} 'computer-use' from ${configPath}`);
    } else {
      console.log(`'computer-use' was not present in ${configPath}`);
    }
    return;
  }

  const entryBlock = {
    args: [SERVER_ENTRY],
    command: nodePath,
    env: {
      PATH: envPath,
    },
    disabled: false,
  };

  if (!isCheckOnly) {
    const cfg = readMcpConfig(configPath);
    cfg.mcpServers["computer-use"] = entryBlock;

    if (isDryRun) {
      console.log("[Dry Run] Would register 'computer-use' in", configPath);
      console.log(JSON.stringify({ "computer-use": entryBlock }, null, 2));
    } else {
      writeJsonAtomic(configPath, cfg);
      console.log(`✅ Registered 'computer-use' in Antigravity MCP config:`);
      console.log(`   ${configPath}`);
    }
  }

  console.log("🔍 Verifying MCP stdio server & native macOS bridge...");
  const check = await verifyServerAndPermissions({ requestPrompt: promptPermissions });
  console.log(`✅ MCP server verified (${check.toolCount} tools active, Node v${process.versions.node} [${process.arch}])`);

  const axOk = Boolean(check.permissions?.axTrusted);
  const screenOk = Boolean(check.permissions?.screenCaptureAccess);

  console.log("");
  console.log("🔐 macOS Permissions Status (for Antigravity):");
  console.log(`   • Accessibility:    ${axOk ? "✅ Granted" : "⚠️  Needs toggle in System Settings → Privacy & Security → Accessibility"}`);
  console.log(
    `   • Screen Recording: ${screenOk ? "✅ Granted" : "⚠️  Needs toggle in System Settings → Privacy & Security → Screen & System Audio Recording"}`,
  );

  console.log("");
  console.log("🚀 Final Step in Antigravity:");
  console.log("   1. In System Settings → Privacy & Security, ensure 'Antigravity' is enabled under BOTH:");
  console.log("      - Accessibility");
  console.log("      - Screen & System Audio Recording");
  console.log("   2. Restart Antigravity (or click Reload MCP Servers) so every chat loads 'computer-use'!");
}

main().catch((err) => {
  console.error(`❌ Setup failed: ${err.message}`);
  process.exit(1);
});
