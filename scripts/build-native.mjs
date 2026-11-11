#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 120000,
    ...opts,
  });
}

function stripQuarantineAndSign(binPath) {
  try {
    fs.chmodSync(binPath, 0o755);
  } catch {}
  run("xattr", ["-dr", "com.apple.quarantine", binPath]);
  run("codesign", ["--force", "--sign", "-", binPath]);
}

function buildUniversalOrNative(srcRel, outRel) {
  const srcPath = path.join(ROOT, srcRel);
  const outPath = path.join(ROOT, outRel);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const swiftc = "swiftc";

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cua-swift-build-"));
  const armOut = path.join(tmpDir, "bin-arm64");
  const x64Out = path.join(tmpDir, "bin-x86_64");

  try {
    const commonFlags = ["-O", "-swift-version", "5", "-parse-as-library", srcPath];
    const armRes = run(swiftc, [...commonFlags, "-target", "arm64-apple-macosx13.0", "-o", armOut]);
    const x64Res = run(swiftc, [...commonFlags, "-target", "x86_64-apple-macosx13.0", "-o", x64Out]);

    if (armRes.status === 0 && x64Res.status === 0) {
      const lipoRes = run("lipo", ["-create", "-output", outPath, armOut, x64Out]);
      if (lipoRes.status === 0) {
        stripQuarantineAndSign(outPath);
        console.log(`Built universal (arm64 + x86_64) binary: ${outRel}`);
        return;
      }
    }

    // Fallback: compile for host architecture
    const hostRes = run(swiftc, [...commonFlags, "-o", outPath]);
    if (hostRes.status !== 0) {
      throw new Error(
        `Failed to compile ${srcRel}:\n${hostRes.stderr || armRes.stderr || hostRes.error?.message || "swiftc not found (install Xcode Command Line Tools: xcode-select --install)"}`,
      );
    }
    stripQuarantineAndSign(outPath);
    console.log(`Built native (${process.arch}) binary: ${outRel}`);
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
}

buildUniversalOrNative("native/MacCUAHelper.swift", "bin/mac-cua-helper");

if (fs.existsSync(path.join(ROOT, "test/fixtures/TestCocoaApp.swift"))) {
  buildUniversalOrNative(
    "test/fixtures/TestCocoaApp.swift",
    "test/fixtures/TestCocoaApp.app/Contents/MacOS/TestCocoaApp",
  );
  stripQuarantineAndSign(path.join(ROOT, "test/fixtures/TestCocoaApp.app"));
}
