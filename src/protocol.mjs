/**
 * Spec-compliant MCP JSON-RPC 2.0 Stdio Transport.
 * Supports standard MCP newline-delimited JSON (NDJSON) and auto-detects
 * Content-Length header framing if used by a client.
 */

export const JSONRPC_ERRORS = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
};

/**
 * Stateful binary stream parser supporting both NDJSON and Content-Length framing.
 * Operates on raw Buffers so multi-byte UTF-8 payloads never corrupt byte offsets.
 *
 * @param {{
 *   onMessage: (msg: any, framing: "ndjson" | "content-length") => void,
 *   onParseError?: (err: Error, framing: "ndjson" | "content-length") => void
 * }} handlers
 */
export function createFrameParser({ onMessage, onParseError }) {
  let buf = Buffer.alloc(0);
  /** @type {"ndjson" | "content-length"} */
  let detectedFraming = "ndjson";

  function push(chunk) {
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (incoming.length === 0) return;
    buf = buf.length === 0 ? incoming : Buffer.concat([buf, incoming]);

    while (buf.length > 0) {
      // Skip leading CR/LF whitespace between frames
      let trimIdx = 0;
      while (trimIdx < buf.length && (buf[trimIdx] === 0x0d || buf[trimIdx] === 0x0a)) {
        trimIdx++;
      }
      if (trimIdx > 0) {
        buf = buf.subarray(trimIdx);
      }
      if (buf.length === 0) break;

      // Check if frame begins with "Content-Length:" (case-insensitive ASCII)
      const prefix = buf.subarray(0, Math.min(buf.length, 15)).toString("ascii").toLowerCase();
      if (prefix.startsWith("content-length:") || ("content-length:".startsWith(prefix) && buf[0] !== 0x7b && buf[0] !== 0x5b)) {
        if (buf.length < 15 && !prefix.startsWith("content-length:")) {
          // Wait for more bytes to disambiguate header
          break;
        }
        const headerEnd = findHeaderEnd(buf);
        if (headerEnd === -1) {
          // Incomplete header block
          break;
        }
        const headerBlock = buf.subarray(0, headerEnd.headerBytes).toString("ascii");
        const match = /content-length\s*:\s*(\d+)/i.exec(headerBlock);
        if (!match) {
          buf = buf.subarray(headerEnd.bodyStart);
          onParseError?.(new Error("Missing Content-Length value in header"), "content-length");
          continue;
        }
        const byteLength = Number(match[1]);
        const totalNeeded = headerEnd.bodyStart + byteLength;
        if (buf.length < totalNeeded) {
          // Wait for full payload bytes
          break;
        }
        detectedFraming = "content-length";
        const bodyStr = buf.subarray(headerEnd.bodyStart, totalNeeded).toString("utf8");
        buf = buf.subarray(totalNeeded);
        try {
          const parsed = JSON.parse(bodyStr);
          onMessage(parsed, "content-length");
        } catch (err) {
          onParseError?.(err, "content-length");
        }
        continue;
      }

      // Standard MCP NDJSON mode: read until '\n'
      const nlIdx = buf.indexOf(0x0a);
      if (nlIdx === -1) {
        break;
      }
      const lineStr = buf.subarray(0, nlIdx).toString("utf8").trim();
      buf = buf.subarray(nlIdx + 1);
      if (!lineStr) continue;
      detectedFraming = "ndjson";
      try {
        const parsed = JSON.parse(lineStr);
        onMessage(parsed, "ndjson");
      } catch (err) {
        onParseError?.(err, "ndjson");
      }
    }
  }

  function flush() {
    const rem = buf.toString("utf8").trim();
    buf = Buffer.alloc(0);
    if (!rem) return;
    try {
      const parsed = JSON.parse(rem);
      onMessage(parsed, detectedFraming);
    } catch (err) {
      onParseError?.(err, detectedFraming);
    }
  }

  return { push, flush };
}

function findHeaderEnd(buf) {
  for (let i = 0; i + 1 < buf.length; i++) {
    if (buf[i] === 0x0d && buf[i + 1] === 0x0a && i + 3 < buf.length && buf[i + 2] === 0x0d && buf[i + 3] === 0x0a) {
      return { headerBytes: i, bodyStart: i + 4 };
    }
    if (buf[i] === 0x0a && buf[i + 1] === 0x0a) {
      return { headerBytes: i, bodyStart: i + 2 };
    }
  }
  return -1;
}

export class MCPStdioServer {
  /**
   * @param {{
   *   name: string,
   *   version: string,
   *   instructions?: string,
   *   tools: Array<{ name: string, description: string, inputSchema: object, annotations?: object, handler: (args: any) => Promise<any> }>,
   *   onClose?: () => Promise<void> | void,
   *   input?: NodeJS.ReadableStream,
   *   output?: NodeJS.WritableStream
   * }} options
   */
  constructor({ name, version, instructions = "", tools = [], onClose, input = process.stdin, output = process.stdout }) {
    this.name = name;
    this.version = version;
    this.instructions = instructions;
    this.toolMap = new Map();
    for (const t of tools) {
      this.toolMap.set(t.name, t);
    }
    this.onClose = onClose;
    this.input = input;
    this.output = output;
    /** @type {"ndjson" | "content-length"} */
    this.framing = "ndjson";
    this.closed = false;
  }

  writeMessage(payload) {
    if (this.closed) return;
    const json = JSON.stringify(payload);
    if (this.framing === "content-length") {
      const byteLen = Buffer.byteLength(json, "utf8");
      this.output.write(`Content-Length: ${byteLen}\r\n\r\n${json}`);
    } else {
      this.output.write(`${json}\n`);
    }
  }

  sendResult(id, result) {
    this.writeMessage({
      jsonrpc: "2.0",
      id,
      result,
    });
  }

  sendError(id, code, message, data = undefined) {
    this.writeMessage({
      jsonrpc: "2.0",
      id: id ?? null,
      error: {
        code,
        message,
        ...(data !== undefined ? { data } : {}),
      },
    });
  }

  async handleSingleMessage(msg) {
    if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0") {
      const id = msg && typeof msg === "object" && "id" in msg ? msg.id : null;
      this.sendError(id, JSONRPC_ERRORS.INVALID_REQUEST, "Invalid JSON-RPC 2.0 message");
      return;
    }

    // Ignore notifications (no 'id' property)
    if (!("id" in msg) || msg.id === undefined) {
      return;
    }

    const { id, method, params } = msg;
    if (typeof method !== "string") {
      this.sendError(id, JSONRPC_ERRORS.INVALID_REQUEST, "Missing JSON-RPC 'method'");
      return;
    }

    try {
      switch (method) {
        case "ping": {
          this.sendResult(id, {});
          return;
        }

        case "initialize": {
          const clientVersion = params?.protocolVersion;
          const negotiatedVersion =
            typeof clientVersion === "string" && /^\d{4}-\d{2}-\d{2}$/.test(clientVersion)
              ? clientVersion
              : "2024-11-05";
          this.sendResult(id, {
            protocolVersion: negotiatedVersion,
            capabilities: {
              tools: { listChanged: false },
            },
            serverInfo: {
              name: this.name,
              version: this.version,
            },
            ...(this.instructions ? { instructions: this.instructions } : {}),
          });
          return;
        }

        case "tools/list": {
          const tools = Array.from(this.toolMap.values()).map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
            ...(t.annotations ? { annotations: t.annotations } : {}),
          }));
          this.sendResult(id, { tools });
          return;
        }

        case "resources/list": {
          this.sendResult(id, { resources: [] });
          return;
        }

        case "resources/templates/list": {
          this.sendResult(id, { resourceTemplates: [] });
          return;
        }

        case "prompts/list": {
          this.sendResult(id, { prompts: [] });
          return;
        }

        case "logging/setLevel": {
          this.sendResult(id, {});
          return;
        }

        case "tools/call": {
          const toolName = params?.name;
          if (typeof toolName !== "string" || !this.toolMap.has(toolName)) {
            this.sendError(
              id,
              JSONRPC_ERRORS.INVALID_PARAMS,
              `Unknown tool '${toolName}'. Available tools: ${Array.from(this.toolMap.keys()).join(", ")}`,
            );
            return;
          }
          const tool = this.toolMap.get(toolName);
          const args = params?.arguments ?? {};
          try {
            const out = await tool.handler(args);
            const normalized = normalizeToolOutput(out);
            this.sendResult(id, normalized);
          } catch (toolErr) {
            this.sendResult(id, {
              isError: true,
              content: [
                {
                  type: "text",
                  text: `Error in ${toolName}: ${toolErr?.message || String(toolErr)}`,
                },
              ],
            });
          }
          return;
        }

        default: {
          this.sendError(id, JSONRPC_ERRORS.METHOD_NOT_FOUND, `Method not found: ${method}`);
          return;
        }
      }
    } catch (err) {
      this.sendError(id, JSONRPC_ERRORS.INTERNAL_ERROR, err?.message || "Internal server error");
    }
  }

  start() {
    const parser = createFrameParser({
      onMessage: (parsed, framing) => {
        this.framing = framing;
        if (Array.isArray(parsed)) {
          if (parsed.length === 0) {
            this.sendError(null, JSONRPC_ERRORS.INVALID_REQUEST, "Empty JSON-RPC batch");
            return;
          }
          for (const item of parsed) {
            void this.handleSingleMessage(item);
          }
        } else {
          void this.handleSingleMessage(parsed);
        }
      },
      onParseError: (err, framing) => {
        this.framing = framing;
        this.sendError(null, JSONRPC_ERRORS.PARSE_ERROR, `Parse error: ${err.message}`);
      },
    });

    this.input.on("data", (chunk) => parser.push(chunk));
    this.input.on("end", () => {
      parser.flush();
      void this.shutdown();
    });
  }

  async shutdown() {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.onClose?.();
    } catch {}
  }
}

function normalizeToolOutput(out) {
  if (out && typeof out === "object" && Array.isArray(out.content)) {
    return out;
  }
  if (Array.isArray(out)) {
    return { content: out };
  }
  if (typeof out === "string") {
    return { content: [{ type: "text", text: out }] };
  }
  return {
    content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
  };
}
