/**
 * Smart Accessibility Tree Diff Engine
 * Mirrors Codex's getAXState() diffing behavior:
 * - First observation (or disableDiffing: true, or after screenshot-only observation) returns full tree.
 * - Subsequent observations return compact +/- line diffs when < 65% of lines changed,
 *   or full tree when UI changed substantially, keeping token usage minimal while preserving fresh indices.
 */

export class AXDiffTracker {
  constructor() {
    /** @type {Map<string, { tree: string, lines: string[], needsFull: boolean }>} */
    this.snapshots = new Map();
  }

  /**
   * Mark that a screenshot-only observation occurred on `key`,
   * forcing the next AX observation to emit a full tree per Codex spec.
   * @param {string} key
   */
  markScreenshotOnly(key) {
    const prev = this.snapshots.get(key);
    if (prev) {
      prev.needsFull = true;
    }
  }

  /**
   * Clear stored snapshot(s).
   * @param {string} [key]
   */
  reset(key) {
    if (key) {
      this.snapshots.delete(key);
    } else {
      this.snapshots.clear();
    }
  }

  /**
   * Compute full or diffed AX state string and update snapshot.
   * @param {string} key
   * @param {string} fullTree
   * @param {{ disableDiffing?: boolean }} [options]
   * @returns {{ text: string, isDiff: boolean, unchanged: boolean }}
   */
  format(key, fullTree, options = {}) {
    const normalized = String(fullTree ?? "").trimEnd();
    const newLines = normalized.split("\n");
    const prev = this.snapshots.get(key);
    const disableDiff = Boolean(options.disableDiffing);

    this.snapshots.set(key, {
      tree: normalized,
      lines: newLines,
      needsFull: false,
    });

    if (!prev || disableDiff || prev.needsFull) {
      return { text: normalized, isDiff: false, unchanged: false };
    }

    if (prev.tree === normalized) {
      const header = newLines[0] ?? "";
      return {
        text: `${header}\n(No accessibility tree changes since previous observation)`,
        isDiff: true,
        unchanged: true,
      };
    }

    const oldLines = prev.lines;
    const oldSet = new Set(oldLines.slice(1));
    const newSet = new Set(newLines.slice(1));

    const removed = [];
    for (const line of oldLines.slice(1)) {
      if (!newSet.has(line)) removed.push(line);
    }
    const added = [];
    for (const line of newLines.slice(1)) {
      if (!oldSet.has(line)) added.push(line);
    }

    const totalBaseline = Math.max(1, newLines.length - 1);
    if (removed.length + added.length > totalBaseline * 0.75 && newLines.length > 8) {
      return { text: normalized, isDiff: false, unchanged: false };
    }

    const out = [
      newLines[0] ?? "",
      `[AX Diff: +${added.length} added/updated, -${removed.length} removed — pass disableDiffing: true for full tree]`,
    ];
    for (const r of removed.slice(0, 120)) {
      out.push(`- ${r}`);
    }
    if (removed.length > 120) {
      out.push(`- ... (${removed.length - 120} more removed)`);
    }
    for (const a of added) {
      out.push(`+ ${a}`);
    }
    return { text: out.join("\n"), isDiff: true, unchanged: false };
  }
}
