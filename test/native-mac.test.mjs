import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { AXDiffTracker } from "../src/diff.mjs";
import { MacBridge } from "../src/mac-bridge.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_APP = path.join(__dirname, "fixtures", "TestCocoaApp.app");

function findElementIndex(treeText, pattern) {
  for (const line of treeText.split("\n")) {
    if (pattern.test(line)) {
      const m = /^\s*\[(\d+)\]/.exec(line);
      if (m) return Number(m[1]);
    }
  }
  return null;
}

test("Native macOS Bridge: multi-window enumeration, tiling layout, background AX click/setValue/selectText/paste with clipboard restore, screenshots, and error paths", async (t) => {
  const diffTracker = new AXDiffTracker();
  const bridge = new MacBridge({ diffTracker });
  let launchedPid = null;

  t.after(async () => {
    try {
      await bridge.manageWindows({
        operations: [
          { app: "com.antigravity.TestCocoaAppV2", action: "quit_app" },
          { app: "com.antigravity.TestCocoaApp", action: "quit_app" },
        ],
      });
    } catch {}
    bridge.close();
  });

  // 1. Permissions & Displays
  const perms = await bridge.checkPermissions();
  assert.equal(typeof perms.axTrusted, "boolean");
  assert.equal(perms.axTrusted, true, "Accessibility permission must be trusted for live AX tests");
  const displays = await bridge.getDisplays();
  assert.ok(displays.length >= 1, "At least one display must be reported");
  assert.ok(displays[0].visibleFrame.width > 200);

  // 2. Launch 2-window background AppKit fixture via LaunchServices (activate: false never steals user focus)
  const launched = await bridge.launchApp({ app: FIXTURE_APP, activate: false });
  launchedPid = launched.pid;
  assert.ok(launchedPid > 0, "Expected valid PID from launchApp");
  await new Promise((r) => setTimeout(r, 400));

  // 3. Verify listApps & listWindows discover both fixture windows
  const runningApps = await bridge.listApps({ runningOnly: true });
  assert.ok(runningApps.length > 0);

  const allWins = await bridge.listWindows({ includeMinimized: true });
  const alphaWin = allWins.find((w) => w.title === "AGTestWindow Alpha");
  const betaWin = allWins.find((w) => w.title === "AGTestWindow Beta");
  assert.ok(alphaWin, `Expected AGTestWindow Alpha in listWindows (got: ${allWins.map((w) => w.title).join(", ")})`);
  assert.ok(betaWin, "Expected AGTestWindow Beta in listWindows");
  assert.notEqual(alphaWin.id, betaWin.id, "Each window must have a distinct window ID");

  if (perms.screenLocked && !alphaWin.axBacked) {
    t.skip("macOS session screen is currently locked (CGSSessionScreenIsLocked=1); live AXUIElement window mutations require an unlocked session");
    return;
  }

  // 4. Multi-window layout in one call: tile_left_right across Alpha & Beta
  const layoutRes = await bridge.manageWindows({
    layout: "tile_left_right",
    targets: [alphaWin.id, betaWin.id],
    gap: 12,
    activate: false,
  });
  assert.equal(layoutRes.length, 2);
  assert.equal(layoutRes[0].ok, true);
  assert.equal(layoutRes[1].ok, true);
  assert.ok(
    layoutRes[0].bounds.x < layoutRes[1].bounds.x,
    `Left tiled window x (${layoutRes[0].bounds.x}) should be < right tiled window x (${layoutRes[1].bounds.x})`,
  );

  // 5. Minimize & unminimize Beta window in background
  const minRes = await bridge.manageWindows({
    operations: [{ windowId: betaWin.id, action: "minimize" }],
  });
  assert.equal(minRes[0].ok, true);
  const unminRes = await bridge.manageWindows({
    operations: [{ windowId: betaWin.id, action: "unminimize" }],
  });
  assert.equal(unminRes[0].ok, true);

  // 6. Inspect AX tree of Alpha window & test diffing + screenshot reset
  const st1 = await bridge.getWindowState({ windowId: alphaWin.id });
  assert.equal(st1.isDiff, false);
  assert.match(st1.stateText, /Counter: 0/);
  assert.match(st1.stateText, /Increment Counter/);

  // Second call with no UI change -> unchanged diff
  const st2 = await bridge.getWindowState({ windowId: alphaWin.id });
  assert.equal(st2.isDiff, true);
  assert.equal(st2.unchanged, true);

  // Screenshot-only call returns valid JPEG bytes (0xFF 0xD8 0xFF) and marks diff tracker
  const shotOnly = await bridge.getWindowScreenshot({ windowId: alphaWin.id });
  const jpegBuf = Buffer.from(shotOnly.screenshot.base64, "base64");
  assert.equal(jpegBuf[0], 0xff);
  assert.equal(jpegBuf[1], 0xd8);
  assert.equal(jpegBuf[2], 0xff);

  // Next getWindowState after screenshot-only must return full tree (isDiff: false)
  const st3 = await bridge.getWindowState({ windowId: alphaWin.id });
  assert.equal(st3.isDiff, false);

  // 7. Background AX element click on both Alpha and Beta windows concurrently!
  const incBtnIdx = findElementIndex(st3.fullTree, /Increment Counter/);
  const turboChkIdx = findElementIndex(st3.fullTree, /Enable Turbo/);
  const alphaInputIdx = findElementIndex(st3.fullTree, /AlphaInput|Initial Alpha Text/);
  assert.ok(incBtnIdx != null, "Increment Counter button must be indexed");
  assert.ok(turboChkIdx != null, "Enable Turbo checkbox must be indexed");
  assert.ok(alphaInputIdx != null, "AlphaInput text field must be indexed");

  const betaState1 = await bridge.getWindowState({ windowId: betaWin.id });
  const betaBtnIdx = findElementIndex(betaState1.fullTree, /Trigger Beta/);
  const betaInputIdx = findElementIndex(betaState1.fullTree, /BetaInput|Hello World Beta/);
  assert.ok(betaBtnIdx != null, "Trigger Beta button must be indexed");
  assert.ok(betaInputIdx != null, "BetaInput text field must be indexed");

  // Click buttons + set values on BOTH windows simultaneously in background!
  await Promise.all([
    bridge.performAction({ windowId: alphaWin.id, action: "click", elementIndex: incBtnIdx }),
    bridge.performAction({ windowId: alphaWin.id, action: "click", elementIndex: turboChkIdx }),
    bridge.performAction({
      windowId: alphaWin.id,
      action: "set_value",
      elementIndex: alphaInputIdx,
      value: "Updated Alpha Value!",
    }),
    bridge.performAction({ windowId: betaWin.id, action: "click", elementIndex: betaBtnIdx }),
  ]);

  const alphaAfter = await bridge.getWindowState({ windowId: alphaWin.id, disableDiff: true });
  const betaAfter = await bridge.getWindowState({ windowId: betaWin.id, disableDiff: true });
  assert.match(alphaAfter.fullTree, /Counter: 1/);
  assert.match(alphaAfter.fullTree, /Updated Alpha Value!/);
  assert.match(betaAfter.fullTree, /Beta: Fired/);

  // 8. select_text + background paste with complete NSPasteboard preservation
  let originalClipboard = "";
  try {
    originalClipboard = execFileSync("/usr/bin/pbpaste", { encoding: "utf8" });
  } catch {}

  const sentinel = `AG_CLIPBOARD_SENTINEL_${Date.now()}`;
  try {
    execFileSync("/usr/bin/pbcopy", { input: sentinel, encoding: "utf8" });

    // Select "World" inside "Hello World Beta" and paste "Antigravity" over it
    const freshBetaInputIdx = findElementIndex(betaAfter.fullTree, /Hello World Beta/);
    assert.ok(freshBetaInputIdx != null);

    await bridge.performAction({
      windowId: betaWin.id,
      action: "select_text",
      elementIndex: freshBetaInputIdx,
      text: "World",
      prefix: "Hello ",
      selectionType: "text",
    });

    await bridge.performAction({
      windowId: betaWin.id,
      action: "paste",
      elementIndex: freshBetaInputIdx,
      text: "Antigravity",
      format: "text",
    });

    const afterPasteClipboard = execFileSync("/usr/bin/pbpaste", { encoding: "utf8" });
    assert.equal(
      afterPasteClipboard,
      sentinel,
      "User clipboard must be 100% restored after background paste",
    );

    const betaAfterPaste = await bridge.getWindowState({ windowId: betaWin.id, disableDiff: true });
    assert.match(betaAfterPaste.fullTree, /Hello Antigravity Beta/);
  } finally {
    try {
      execFileSync("/usr/bin/pbcopy", { input: originalClipboard, encoding: "utf8" });
    } catch {}
  }

  // 9. Explicit edge-case & error-path verification
  await assert.rejects(
    () => bridge.getWindowState({ windowId: 99999999, autoLaunch: false }),
    /not found|No window/i,
  );
  await assert.rejects(
    () => bridge.performAction({ windowId: alphaWin.id, action: "click", elementIndex: 999999 }),
    /not found in cached AX state/i,
  );
  await assert.rejects(() => bridge.launchApp({ app: "   " }), TypeError);
  await assert.rejects(
    () => bridge.manageWindows({ layout: "nonexistent_layout", targets: [alphaWin.id] }),
    TypeError,
  );
  await assert.rejects(() => bridge.manageWindows({ operations: [] }), TypeError);
});
