import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { AXDiffTracker } from "../src/diff.mjs";
import { parseCDPKeyChord } from "../src/keys.mjs";
import { extractTopLevelBindings } from "../src/cua-repl.mjs";
import { createFrameParser, MCPStdioServer, JSONRPC_ERRORS } from "../src/protocol.mjs";
import { planCodexCursorMotion, simulateCodexSpring } from "../src/browser-ax.mjs";

test("AXDiffTracker: initial tree, unchanged, compact diff, >75% fallback, disableDiffing, and screenshot reset", () => {
  const tracker = new AXDiffTracker();
  const baseTree = [
    'Window #101 "Test" app="com.test"',
    '  [1] Button "Save"',
    '  [2] TextField "Name" value="Alice"',
    '  [3] CheckBox "Agree" value="0"',
    '  [4] StaticText "Status: Idle"',
    '  [5] Button "Cancel"',
  ].join("\n");

  // 1. First call returns full tree
  const r1 = tracker.format("win:101", baseTree);
  assert.equal(r1.isDiff, false);
  assert.equal(r1.text, baseTree);

  // 2. Identical tree returns compact unchanged notice
  const r2 = tracker.format("win:101", baseTree);
  assert.equal(r2.isDiff, true);
  assert.equal(r2.unchanged, true);
  assert.match(r2.text, /No accessibility tree changes/);

  // 3. Small change emits compact unified-style diff
  const updatedTree = baseTree
    .replace('value="Alice"', 'value="Bob"')
    .replace('"Status: Idle"', '"Status: Saved"');
  const r3 = tracker.format("win:101", updatedTree);
  assert.equal(r3.isDiff, true);
  assert.equal(r3.unchanged, false);
  assert.match(r3.text, /-   \[2\] TextField "Name" value="Alice"/);
  assert.match(r3.text, /\+   \[2\] TextField "Name" value="Bob"/);

  // 4. disableDiffing forces full tree output
  const r4 = tracker.format("win:101", updatedTree, { disableDiffing: true });
  assert.equal(r4.isDiff, false);
  assert.equal(r4.text, updatedTree);

  // 5. markScreenshotOnly forces next getAXState to return full tree (Codex spec)
  tracker.markScreenshotOnly("win:101");
  const r5 = tracker.format("win:101", updatedTree);
  assert.equal(r5.isDiff, false);
  assert.equal(r5.text, updatedTree);

  // 6. >75% line changes on substantial tree (>8 lines) falls back to full tree instead of noisy diff
  const completelyDifferent = [
    'Window #101 "New Screen"',
    '  [1] Link "Home"',
    '  [2] Link "Settings"',
    '  [3] Link "Logout"',
    '  [4] Heading "Dashboard"',
    '  [5] Button "Refresh"',
    '  [6] TextField "Search"',
    '  [7] CheckBox "Dark Mode"',
    '  [8] Button "Export"',
    '  [9] StaticText "Footer"',
  ].join("\n");
  const r6 = tracker.format("win:101", completelyDifferent);
  assert.equal(r6.isDiff, false);
  assert.equal(r6.text, completelyDifferent);
});

test("parseCDPKeyChord: single keys, X11/xdotool keysyms, macOS chords, numpad, function keys, and error cases", () => {
  const ret = parseCDPKeyChord("Return");
  assert.equal(ret.key, "Enter");
  assert.equal(ret.code, "Enter");
  assert.equal(ret.windowsVirtualKeyCode, 13);
  assert.equal(ret.modifiers, 0);

  const copyChord = parseCDPKeyChord("super+c");
  assert.equal(copyChord.key, "c");
  assert.equal(copyChord.code, "KeyC");
  assert.equal(copyChord.modifiers, 4); // Meta = 4
  assert.deepEqual(copyChord.commands, ["copy"]);

  const x11Chord = parseCDPKeyChord("Control_L+Shift_L+period");
  assert.equal(x11Chord.key, ">");
  assert.equal(x11Chord.code, "Period");
  assert.equal(x11Chord.modifiers, 2 | 8); // Ctrl (2) | Shift (8)

  const kp = parseCDPKeyChord("KP_5");
  assert.equal(kp.code, "Numpad5");
  assert.equal(kp.location, 3);

  const f12 = parseCDPKeyChord("F12");
  assert.equal(f12.key, "F12");
  assert.equal(f12.windowsVirtualKeyCode, 123);

  const shiftedChar = parseCDPKeyChord("@");
  assert.equal(shiftedChar.key, "@");
  assert.equal(shiftedChar.code, "Digit2");
  assert.equal(shiftedChar.modifiers, 8);

  assert.throws(() => parseCDPKeyChord(""), TypeError);
  assert.throws(() => parseCDPKeyChord(null), TypeError);
  assert.throws(() => parseCDPKeyChord("super+NonExistentKeySym"), Error);
});

test("extractTopLevelBindings: let/const/var, destructuring, functions/classes, ignoring nested blocks and strings", () => {
  const sample = `
    // let ignoredInComment = 1;
    const str = "const alsoIgnored = 2; \`\${let innerTpl = 3}\`";
    let alpha = 10, beta = { nested: true };
    const { user: { id: userId, tags: [firstTag, ...restTags] = [] }, plainProp = 42 } = payload;
    var [head, , tail] = list;
    function helperFn(a, b) {
      let localInsideFn = 99;
      return a + b + localInsideFn;
    }
    async function* streamItems() {}
    class WindowController {
      method() { const insideClass = 1; }
    }
    for (let loopIdx = 0; loopIdx < 3; loopIdx++) {
      const insideLoop = loopIdx;
    }
    if (alpha > 0) {
      let insideIf = true;
    }
  `;
  const names = extractTopLevelBindings(sample).sort();
  assert.deepEqual(
    names,
    [
      "WindowController",
      "alpha",
      "beta",
      "firstTag",
      "head",
      "helperFn",
      "plainProp",
      "restTags",
      "str",
      "streamItems",
      "tail",
      "userId",
    ].sort(),
  );
});

test("createFrameParser: handles multi-byte UTF-8 split at every single byte in both NDJSON and Content-Length modes", () => {
  const payload = {
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: { text: "Xin chào 🚀 Café — 日本語テスト" },
  };
  const json = JSON.stringify(payload);

  // 1. NDJSON 1-byte-at-a-time streaming
  const ndReceived = [];
  const p1 = createFrameParser({
    onMessage: (m, framing) => ndReceived.push({ m, framing }),
  });
  const ndBytes = Buffer.from(`${json}\n`, "utf8");
  for (let i = 0; i < ndBytes.length; i++) {
    p1.push(ndBytes.subarray(i, i + 1));
  }
  assert.equal(ndReceived.length, 1);
  assert.equal(ndReceived[0].framing, "ndjson");
  assert.deepEqual(ndReceived[0].m, payload);

  // 2. Content-Length 1-byte-at-a-time streaming with multi-byte UTF-8 body
  const clReceived = [];
  const p2 = createFrameParser({
    onMessage: (m, framing) => clReceived.push({ m, framing }),
  });
  const bodyBuf = Buffer.from(json, "utf8");
  const clFrame = Buffer.concat([
    Buffer.from(`Content-Length: ${bodyBuf.length}\r\n\r\n`, "ascii"),
    bodyBuf,
  ]);
  for (let i = 0; i < clFrame.length; i++) {
    p2.push(clFrame.subarray(i, i + 1));
  }
  assert.equal(clReceived.length, 1);
  assert.equal(clReceived[0].framing, "content-length");
  assert.deepEqual(clReceived[0].m, payload);
});

test("MCPStdioServer: protocol negotiation, error handling, unknown tools, and tool error wrapping", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const responses = [];

  const outParser = createFrameParser({
    onMessage: (m) => responses.push(m),
  });
  output.on("data", (chunk) => outParser.push(chunk));

  const srv = new MCPStdioServer({
    name: "computer-use",
    version: "1.0.0",
    instructions: "Test instructions",
    input,
    output,
    tools: [
      {
        name: "echo_tool",
        description: "Echoes text",
        inputSchema: { type: "object", properties: { msg: { type: "string" } } },
        handler: async (args) => {
          if (args.throwErr) throw new Error("Simulated failure");
          return `Echo: ${args.msg}`;
        },
      },
    ],
  });
  srv.start();

  const send = (obj) => input.write(`${JSON.stringify(obj)}\n`);

  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } });
  send({ jsonrpc: "2.0", method: "notifications/initialized" }); // Notification -> no response
  send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "echo_tool", arguments: { msg: "hi" } } });
  send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "echo_tool", arguments: { throwErr: true } } });
  send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "missing_tool", arguments: {} } });
  send({ jsonrpc: "2.0", id: 6, method: "nonexistent/method" });
  input.write("{bad json\n");

  await new Promise((r) => setTimeout(r, 80));

  const byId = (id) => responses.find((r) => r.id === id);

  assert.equal(responses.length, 7);
  assert.equal(byId(1).result.protocolVersion, "2025-03-26");
  assert.equal(byId(1).result.serverInfo.name, "computer-use");
  assert.equal(byId(2).result.tools.length, 1);
  assert.equal(byId(3).result.content[0].text, "Echo: hi");
  assert.equal(byId(4).result.isError, true);
  assert.match(byId(4).result.content[0].text, /Simulated failure/);
  assert.equal(byId(5).error.code, JSONRPC_ERRORS.INVALID_PARAMS);
  assert.equal(byId(6).error.code, JSONRPC_ERRORS.METHOD_NOT_FOUND);
  assert.equal(byId(null).error.code, JSONRPC_ERRORS.PARSE_ERROR);

  input.end();
});

test("planCodexCursorMotion: Codex CursorMotionPath scoot (<=196px) vs curved Bezier (>196px), viewport bounds clamping, and awkward-angle arc selection", () => {
  // 1. Short move <= 196px selects Scoot mode with Codex (0.19, 0.90) spring
  const shortPlan = planCodexCursorMotion({ x: 200, y: 200 }, { x: 320, y: 270 }, { width: 1280, height: 800 });
  assert.equal(shortPlan.mode, "scoot");
  assert.ok(shortPlan.distance <= 196);
  assert.equal(shortPlan.springParams.response, 0.19);
  assert.equal(shortPlan.springParams.dampingFraction, 0.9);
  assert.ok(Math.abs(shortPlan.rotationTarget) <= 70);

  // Boundary at exact 196px stays in scoot mode; 197px switches to Bezier mode
  const exactBoundary = planCodexCursorMotion({ x: 100, y: 100 }, { x: 296, y: 100 }, { width: 1280, height: 800 });
  assert.equal(exactBoundary.mode, "scoot");
  const overBoundary = planCodexCursorMotion({ x: 100, y: 100 }, { x: 297, y: 100 }, { width: 1280, height: 800 });
  assert.equal(overBoundary.mode, "bezier");

  // 2. Long diagonal move (>196px) generates a genuinely curved Bezier trajectory (not a straight line)
  const start = { x: 90, y: 130 };
  const end = { x: 790, y: 540 };
  const bounds = { width: 1280, height: 800 };
  const longPlan = planCodexCursorMotion(start, end, bounds);
  assert.equal(longPlan.mode, "bezier");
  assert.ok(longPlan.path.segments.length === 1 || longPlan.path.segments.length === 2);
  assert.equal(longPlan.springParams.dampingFraction, 0.9);
  assert.ok(longPlan.springParams.response >= 0.12 && longPlan.springParams.response <= 2.2);

  // Check endpoints match exact start and end coordinates
  const firstSample = longPlan.samples[0];
  const lastSample = longPlan.samples[longPlan.samples.length - 1];
  assert.ok(Math.abs(firstSample.x - start.x) < 1e-6);
  assert.ok(Math.abs(firstSample.y - start.y) < 1e-6);
  assert.ok(Math.abs(lastSample.x - end.x) < 1e-6);
  assert.ok(Math.abs(lastSample.y - end.y) < 1e-6);

  // Verify non-zero arc deviation from straight chord and 20px viewport margin compliance
  const chordDx = end.x - start.x;
  const chordDy = end.y - start.y;
  const chordLen = Math.hypot(chordDx, chordDy);
  let maxPerpDeviation = 0;
  for (const s of longPlan.samples) {
    const perp = Math.abs((s.x - start.x) * chordDy - (s.y - start.y) * chordDx) / chordLen;
    if (perp > maxPerpDeviation) maxPerpDeviation = perp;
    assert.ok(s.x >= 20 && s.x <= bounds.width - 20, `Sample x=${s.x} violated 20px viewport margin`);
    assert.ok(s.y >= 20 && s.y <= bounds.height - 20, `Sample y=${s.y} violated 20px viewport margin`);
  }
  assert.ok(maxPerpDeviation > 12, `Expected curved Bezier arc deviation > 12px from straight chord, got ${maxPerpDeviation}`);

  // 3. Reverse-click-angle approach (top-right -> bottom-left against -44deg resting pointer) stays smooth and in-bounds
  const reversePlan = planCodexCursorMotion({ x: 960, y: 110 }, { x: 180, y: 660 }, bounds);
  assert.equal(reversePlan.mode, "bezier");
  for (const s of reversePlan.samples) {
    assert.ok(s.x >= 20 && s.x <= bounds.width - 20);
    assert.ok(s.y >= 20 && s.y <= bounds.height - 20);
    assert.ok(Number.isFinite(s.tangentDegrees));
  }

  // 4. Negative-origin secondary monitor bounds (e.g. macOS Retina left display x=-1440..0) & cross-display union bounds
  const negBounds = { x: -1440, y: 0, width: 1440, height: 900 };
  const negPlan = planCodexCursorMotion({ x: -1250, y: 180 }, { x: -340, y: 620 }, negBounds);
  assert.equal(negPlan.mode, "bezier");
  assert.ok(
    negPlan.path.startControl.x < -1250,
    `Negative-origin startControl.x (${negPlan.path.startControl.x}) must extend along -44deg click tangent instead of clamping to 0`,
  );
  for (const s of negPlan.samples) {
    assert.ok(
      s.x >= negBounds.x + 20 && s.x <= negBounds.x + negBounds.width - 20,
      `Negative-origin sample x=${s.x} violated [-1420, -20] margin`,
    );
    assert.ok(s.y >= 20 && s.y <= negBounds.height - 20);
  }

  // Cross-monitor glide from Display 1 (x=-500) to Display 0 (x=420) inside unioned bounds
  const crossBounds = { x: -1440, y: 0, width: 3360, height: 1080 };
  const crossPlan = planCodexCursorMotion({ x: -500, y: 260 }, { x: 420, y: 520 }, crossBounds);
  assert.equal(crossPlan.mode, "bezier");
  assert.ok(crossPlan.path.startControl.x < -500, "Cross-monitor startControl must not collapse onto start");
  for (const s of crossPlan.samples) {
    assert.ok(s.x >= crossBounds.x + 20 && s.x <= crossBounds.x + crossBounds.width - 20);
    assert.ok(s.y >= 20 && s.y <= crossBounds.height - 20);
  }
});

test("Codex 240Hz VelocityVerletSimulation: unit-range [0,1] springs converge smoothly without 5% premature snap jump", () => {
  // Visibility fade-in (0 -> 1, response=0.42, damping=0.86)
  const fadeIn = simulateCodexSpring({ from: 0, to: 1, response: 0.42, dampingFraction: 0.86, dt: 1 / 120, steps: 140 });
  assert.equal(fadeIn.final.value, 1);
  // Once past 0.90, no single 120Hz frame may jump by >= 0.02 (guards against 0.05 snap threshold regression)
  for (const frame of fadeIn.trace) {
    if (frame.prev >= 0.90) {
      assert.ok(
        frame.delta < 0.015,
        `Premature snap jump detected at step ${frame.step}: ${frame.prev} -> ${frame.value} (delta=${frame.delta})`,
      );
    }
  }

  // Visibility fade-out (1 -> 0, target === 0 edge case)
  const fadeOut = simulateCodexSpring({ from: 1, to: 0, response: 0.42, dampingFraction: 0.86, dt: 1 / 120, steps: 140 });
  assert.equal(fadeOut.final.value, 0);
  for (const frame of fadeOut.trace) {
    if (frame.prev <= 0.10) {
      assert.ok(
        frame.delta < 0.015,
        `Premature fade-out snap jump at step ${frame.step}: ${frame.prev} -> ${frame.value} (delta=${frame.delta})`,
      );
    }
  }

  // Press scale release (0.70 -> 1.0, response=0.20, damping=0.85)
  const pressRelease = simulateCodexSpring({ from: 0.7, to: 1.0, response: 0.2, dampingFraction: 0.85, dt: 1 / 120, steps: 100 });
  assert.equal(pressRelease.final.value, 1);
  for (const frame of pressRelease.trace) {
    if (frame.prev >= 0.94) {
      assert.ok(frame.delta < 0.015, `Premature press-scale snap jump: ${frame.prev} -> ${frame.value}`);
    }
  }
});
