/**
 * In-page DOM + Accessibility Snapshot & Element Action Scripts for CDP Tabs.
 * Zero mutation of page DOM attributes or styles — stores live Element references
 * in a non-enumerable WeakMap/Map on window for exact index-based interaction.
 */

export const BUILD_AX_SNAPSHOT_EXPR = (maxElements = 600) => `(() => {
  const MAX = ${Number(maxElements) || 600};
  const store = new Map();
  Object.defineProperty(window, "__agCuaMap", {
    value: store,
    configurable: true,
    writable: true,
    enumerable: false
  });

  const IMPLICIT_ROLES = {
    A: (el) => (el.hasAttribute("href") ? "link" : null),
    BUTTON: () => "button",
    SUMMARY: () => "button",
    INPUT: (el) => {
      const t = (el.getAttribute("type") || "text").toLowerCase();
      if (t === "button" || t === "submit" || t === "reset" || t === "image") return "button";
      if (t === "checkbox") return "checkbox";
      if (t === "radio") return "radio";
      if (t === "range") return "slider";
      if (t === "number") return "spinbutton";
      if (t === "search") return "searchbox";
      if (t === "file") return "file_input";
      if (t === "hidden") return null;
      return "textbox";
    },
    TEXTAREA: () => "textbox",
    SELECT: (el) => (el.hasAttribute("multiple") || el.size > 1 ? "listbox" : "combobox"),
    OPTION: () => "option",
    IMG: () => "img",
    H1: () => "heading",
    H2: () => "heading",
    H3: () => "heading",
    H4: () => "heading",
    H5: () => "heading",
    H6: () => "heading",
    NAV: () => "navigation",
    MAIN: () => "main",
    DIALOG: () => "dialog",
    DETAILS: () => "group",
    TABLE: () => "table",
    TR: () => "row",
    TH: () => "columnheader",
    TD: () => "cell",
    FORM: () => "form"
  };

  const INTERACTIVE_ROLES = new Set([
    "button", "link", "textbox", "searchbox", "combobox", "listbox", "option",
    "checkbox", "radio", "switch", "slider", "spinbutton", "tab", "menuitem",
    "menuitemcheckbox", "menuitemradio", "treeitem", "file_input"
  ]);

  function getRole(el) {
    const explicit = el.getAttribute?.("role")?.trim().split(/\\s+/)[0];
    if (explicit) return explicit.toLowerCase();
    if (el.isContentEditable && el.parentElement && !el.parentElement.isContentEditable) {
      return "textbox";
    }
    const mapper = IMPLICIT_ROLES[el.tagName];
    return mapper ? mapper(el) : null;
  }

  function isVisible(el, style, rect) {
    if (!style) return false;
    if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return false;
    const ownerDoc = el.ownerDocument || document;
    if (parseFloat(style.opacity || "1") === 0 && ownerDoc.activeElement !== el) return false;
    if (el.hasAttribute?.("hidden") || el.getAttribute?.("aria-hidden") === "true") return false;
    if (rect.width < 1 && rect.height < 1 && el.tagName !== "OPTION") return false;
    return true;
  }

  function getDirectText(el) {
    let acc = "";
    for (const child of el.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        acc += child.textContent || "";
      }
    }
    return acc.replace(/\\s+/g, " ").trim();
  }

  function getAccessibleName(el, role) {
    const ownerDoc = el.ownerDocument || document;
    const ariaLabel = el.getAttribute?.("aria-label")?.trim();
    if (ariaLabel) return ariaLabel;

    const labelledBy = el.getAttribute?.("aria-labelledby")?.trim();
    if (labelledBy) {
      const parts = labelledBy.split(/\\s+/).map((id) => ownerDoc.getElementById(id)?.innerText?.trim()).filter(Boolean);
      if (parts.length) return parts.join(" ");
    }

    if (el.id) {
      try {
        const lbl = ownerDoc.querySelector(\`label[for="\${CSS.escape(el.id)}"]\`);
        if (lbl) {
          const t = lbl.innerText?.replace(/\\s+/g, " ").trim();
          if (t) return t;
        }
      } catch {}
    }

    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT") {
      const parentLabel = el.closest("label");
      if (parentLabel) {
        const clone = parentLabel.cloneNode(true);
        clone.querySelectorAll("input,textarea,select").forEach((n) => n.remove());
        const t = clone.textContent?.replace(/\\s+/g, " ").trim();
        if (t) return t;
      }
      const ph = el.getAttribute("placeholder")?.trim();
      if (ph) return ph;
      const nameAttr = el.getAttribute("name")?.trim();
      if (nameAttr) return nameAttr;
    }

    if (el.tagName === "IMG") {
      return el.getAttribute("alt")?.trim() || el.getAttribute("title")?.trim() || "";
    }

    if (INTERACTIVE_ROLES.has(role) || role === "heading" || role === "columnheader") {
      const txt = (el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim();
      if (txt) return txt.slice(0, 140);
    }

    return el.getAttribute?.("title")?.trim() || "";
  }

  const lines = [];
  let nextIdx = 1;
  const vw = window.innerWidth || document.documentElement.clientWidth || 1280;
  const vh = window.innerHeight || document.documentElement.clientHeight || 800;
  const captchaSignalSet = new Set();

  function detectCaptchaInDoc(doc) {
    if (!doc || typeof doc.querySelector !== "function") return;
    try {
      if (
        doc.querySelector(".cf-turnstile, [data-turnstile-callback], iframe[src*='challenges.cloudflare.com'], #challenge-running, #cf-challenge-running, form#challenge-form")
      ) {
        captchaSignalSet.add("cloudflare-turnstile");
      }
      if (
        doc.querySelector(".g-recaptcha, iframe[src*='google.com/recaptcha'], iframe[src*='recaptcha.net/recaptcha']")
      ) {
        captchaSignalSet.add("recaptcha");
      }
      if (
        doc.querySelector(".h-captcha, iframe[src*='hcaptcha.com']")
      ) {
        captchaSignalSet.add("hcaptcha");
      }
      if (doc.querySelector("altcha-widget")) {
        captchaSignalSet.add("altcha");
      }
    } catch {}
  }

  detectCaptchaInDoc(document);

  function walk(node, depth, offsetX = 0, offsetY = 0) {
    if (nextIdx > MAX || !node || node.nodeType !== Node.ELEMENT_NODE) return;
    if (node.id === "__ag_cua_cursor_host__" || node.hasAttribute?.("data-ag-cua-ignore")) return;
    const tag = node.tagName;
    if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT" || tag === "TEMPLATE" || tag === "SVG" && !node.getAttribute("aria-label")) {
      return;
    }

    const ownerWin = node.ownerDocument?.defaultView || window;
    const ownerDoc = node.ownerDocument || document;
    const style = ownerWin.getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    if (!isVisible(node, style, rect)) return;

    const rx = Math.round(rect.left + offsetX);
    const ry = Math.round(rect.top + offsetY);
    const rw = Math.round(rect.width);
    const rh = Math.round(rect.height);

    const role = getRole(node);
    const hasClickAttr = node.hasAttribute("onclick") || style.cursor === "pointer" && (node.tabIndex >= 0 || node.getAttribute("tabindex") !== null);
    const effectiveRole = role || (hasClickAttr ? "button" : null);
    const directText = !effectiveRole ? getDirectText(node) : "";

    let emitted = false;
    if (effectiveRole && effectiveRole !== "option") {
      const name = getAccessibleName(node, effectiveRole);
      const isLandmark = effectiveRole === "navigation" || effectiveRole === "main" || effectiveRole === "dialog" || effectiveRole === "form" || effectiveRole === "table";
      const isMeaningful = INTERACTIVE_ROLES.has(effectiveRole) || effectiveRole === "heading" || Boolean(name) || isLandmark;

      if (isMeaningful) {
        const idx = nextIdx++;
        store.set(idx, node);
        emitted = true;

        const indent = "  ".repeat(Math.min(8, depth));
        const parts = [\`\${indent}[\${idx}] \${effectiveRole}\`];

        if (name) {
          parts.push(\`"\${name.replace(/"/g, '\\\\"').slice(0, 120)}"\`);
        }
        if (effectiveRole === "heading" && /^H[1-6]$/.test(tag)) {
          parts.push(\`level=\${tag[1]}\`);
        }
        if (effectiveRole === "link" && node.href) {
          const hrefStr = String(node.href);
          parts.push(\`href="\${hrefStr.length > 90 ? hrefStr.slice(0, 87) + "..." : hrefStr}"\`);
        }

        // Value
        if (tag === "INPUT" || tag === "TEXTAREA") {
          const t = (node.getAttribute("type") || "text").toLowerCase();
          if (t === "checkbox" || t === "radio") {
            parts.push(node.checked ? "checked" : "unchecked");
          } else if (t === "password") {
            parts.push(\`value="\${"*".repeat((node.value || "").length)}"\`);
          } else {
            const v = String(node.value ?? "");
            parts.push(\`value="\${v.replace(/\\n/g, "\\\\n").replace(/"/g, '\\\\"').slice(0, 120)}"\`);
          }
        } else if (tag === "SELECT") {
          const selText = node.selectedOptions?.[0]?.text?.trim() ?? node.value ?? "";
          parts.push(\`value="\${String(selText).replace(/"/g, '\\\\"').slice(0, 80)}"\`);
        } else if (node.isContentEditable) {
          const v = (node.innerText || "").trim();
          parts.push(\`value="\${v.replace(/\\n/g, "\\\\n").replace(/"/g, '\\\\"').slice(0, 120)}"\`);
          parts.push("editable");
        }

        if (node.disabled || node.getAttribute("aria-disabled") === "true") parts.push("disabled");
        if (node.readOnly) parts.push("readonly");
        if (ownerDoc.activeElement === node) parts.push("focused");
        if (node.getAttribute("aria-expanded") === "true" || (tag === "DETAILS" && node.open)) parts.push("expanded");
        else if (node.getAttribute("aria-expanded") === "false") parts.push("collapsed");
        if (node.getAttribute("aria-selected") === "true") parts.push("selected");
        if (node.getAttribute("aria-checked") === "true" && tag !== "INPUT") parts.push("checked");

        parts.push(\`@(\${rx},\${ry} \${rw}x\${rh})\`);
        if (ry + rh < 0 || ry > vh || rx + rw < 0 || rx > vw) {
          parts.push("offscreen");
        }

        lines.push(parts.join(" "));
      }
    } else if (directText.length > 0) {
      const idx = nextIdx++;
      store.set(idx, node);
      const indent = "  ".repeat(Math.min(8, depth));
      lines.push(\`\${indent}[\${idx}] text "\${directText.replace(/"/g, '\\\\"').slice(0, 160)}" @(\${rx},\${ry} \${rw}x\${rh})\`);
      emitted = true;
    }

    // Do not recurse inside leaf-like buttons/links/headings that already captured full innerText unless they contain nested inputs/buttons
    if (emitted && (effectiveRole === "heading" || effectiveRole === "textbox")) {
      return;
    }

    const nextDepth = emitted ? depth + 1 : depth;
    if (node.shadowRoot) {
      for (const sc of node.shadowRoot.children) {
        walk(sc, nextDepth, offsetX, offsetY);
      }
    }
    for (const child of node.children) {
      if (nextIdx > MAX) break;
      walk(child, nextDepth, offsetX, offsetY);
    }
    if (tag === "IFRAME") {
      try {
        const srcAttr = String(node.getAttribute("src") || "").toLowerCase();
        if (srcAttr.includes("challenges.cloudflare.com")) captchaSignalSet.add("cloudflare-turnstile");
        if (srcAttr.includes("recaptcha")) captchaSignalSet.add("recaptcha");
        if (srcAttr.includes("hcaptcha.com")) captchaSignalSet.add("hcaptcha");
        if (node.contentDocument?.body) {
          detectCaptchaInDoc(node.contentDocument);
          const childOffsetX = offsetX + rect.left + (node.clientLeft || 0);
          const childOffsetY = offsetY + rect.top + (node.clientTop || 0);
          walk(node.contentDocument.body, nextDepth + 1, childOffsetX, childOffsetY);
        }
      } catch {}
    }
  }

  if (document.body) {
    walk(document.body, 1, 0, 0);
  } else if (document.documentElement) {
    walk(document.documentElement, 1, 0, 0);
  }

  return {
    title: document.title || "",
    url: location.href,
    viewport: { width: vw, height: vh },
    scroll: { x: Math.round(window.scrollX || 0), y: Math.round(window.scrollY || 0) },
    elementCount: nextIdx - 1,
    captchaSignals: Array.from(captchaSignalSet),
    lines
  };
})()`;

const QUERY_SMART_FN_SOURCE = `
  function getTopLevelRect(el) {
    const r = el.getBoundingClientRect ? el.getBoundingClientRect() : { left: 200, top: 200, width: 40, height: 24 };
    let offX = 0;
    let offY = 0;
    try {
      let curWin = el.ownerDocument?.defaultView;
      while (curWin && curWin !== window && curWin.frameElement) {
        const fr = curWin.frameElement.getBoundingClientRect();
        offX += fr.left + (curWin.frameElement.clientLeft || 0);
        offY += fr.top + (curWin.frameElement.clientTop || 0);
        curWin = curWin.parent;
      }
    } catch {}
    return {
      left: r.left + offX,
      top: r.top + offY,
      width: r.width,
      height: r.height
    };
  }

  function queryAcrossSameOriginFrames(fn) {
    const rootMatch = fn(document);
    if (rootMatch) return rootMatch;
    const iframes = document.querySelectorAll("iframe");
    for (const ifr of iframes) {
      try {
        if (ifr.contentDocument) {
          const m = fn(ifr.contentDocument);
          if (m) return m;
        }
      } catch {}
    }
    return null;
  }

  function resolveTargetElement(spec) {
    if (typeof spec === "number") {
      const mapped = window.__agCuaMap?.get(spec) || null;
      if (!mapped || !mapped.isConnected) {
        return { el: null, error: \`Element [\${spec}] is missing or detached from DOM. Call getAXState / browser_tab_state to refresh indices.\` };
      }
      return { el: mapped, error: null };
    }
    if (typeof spec === "string" && spec.trim()) {
      const sel = spec.trim();
      let found = null;
      if (sel.startsWith("text=")) {
        const needle = sel.slice(5).trim().toLowerCase();
        found = queryAcrossSameOriginFrames((doc) => {
          const all = doc.querySelectorAll("button,a,input,textarea,select,label,span,div,h1,h2,h3,h4,li,[role]");
          for (const cand of all) {
            if (cand.id === "__ag_cua_cursor_host__" || cand.closest?.("[data-ag-cua-ignore]")) continue;
            if ((cand.innerText || cand.value || "").trim().toLowerCase().includes(needle)) {
              return cand;
            }
          }
          return null;
        });
      } else if (sel.startsWith("role=")) {
        const r = sel.slice(5).trim();
        found = queryAcrossSameOriginFrames((doc) => doc.querySelector(\`[role="\${CSS.escape(r)}"]:not([data-ag-cua-ignore])\`));
      } else {
        found = queryAcrossSameOriginFrames((doc) => doc.querySelector(sel));
      }
      if (!found || !found.isConnected) {
        return { el: null, error: \`No element matched selector: \${sel}\` };
      }
      return { el: found, error: null };
    }
    return { el: null, error: "Invalid element target specification" };
  }
`;

/**
 * Generate JS expression to resolve an element by index or selector, scroll into view, and return geometry + metadata.
 */
export function buildPrepareElementExpr(targetSpec, { focus = false } = {}) {
  const payload = JSON.stringify({ targetSpec, focus });
  return `(() => {
    const { targetSpec, focus } = ${payload};
    ${QUERY_SMART_FN_SOURCE}
    const { el, error } = resolveTargetElement(targetSpec);
    if (!el) {
      return { ok: false, error };
    }

    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    if (focus && typeof el.focus === "function") {
      el.focus({ preventScroll: true });
    }
    const r = getTopLevelRect(el);
    return {
      ok: true,
      tag: el.tagName,
      type: el.getAttribute?.("type") || "",
      x: r.left + r.width / 2,
      y: r.top + r.height / 2,
      rect: { x: r.left, y: r.top, width: r.width, height: r.height }
    };
  })()`;
}

/**
 * Generate JS expression to inspect the active element or viewport center for keyboard/scroll cursor anchoring.
 */
export function buildGetActiveElementAnchorExpr() {
  return `(() => {
    const vw = window.innerWidth || 1280;
    const vh = window.innerHeight || 800;
    const active = document.activeElement;
    if (
      active &&
      active !== document.body &&
      active !== document.documentElement &&
      active.id !== "__ag_cua_cursor_host__" &&
      !active.closest?.("[data-ag-cua-ignore]") &&
      typeof active.getBoundingClientRect === "function"
    ) {
      const r = active.getBoundingClientRect();
      if (r.width >= 2 && r.height >= 2) {
        return {
          hasActiveElement: true,
          x: r.left + r.width / 2,
          y: r.top + r.height / 2,
          rect: { x: r.left, y: r.top, width: r.width, height: r.height },
          viewportWidth: vw,
          viewportHeight: vh
        };
      }
    }
    return {
      hasActiveElement: false,
      x: vw / 2,
      y: vh / 2,
      rect: null,
      viewportWidth: vw,
      viewportHeight: vh
    };
  })()`;
}

/**
 * Generate JS expression to set the value of an indexed or selector-targeted element (React/Vue/DOM safe).
 */
export function buildSetValueExpr(targetSpec, value) {
  const payload = JSON.stringify({ targetSpec, value: String(value ?? "") });
  return `(() => {
    const { targetSpec, value } = ${payload};
    ${QUERY_SMART_FN_SOURCE}
    const { el, error } = resolveTargetElement(targetSpec);
    if (!el) {
      return { ok: false, error };
    }
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    if (typeof el.focus === "function") el.focus({ preventScroll: true });
    const r = getTopLevelRect(el);
    const geom = {
      x: r.left + r.width / 2,
      y: r.top + r.height / 2,
      rect: { x: r.left, y: r.top, width: r.width, height: r.height }
    };

    if (el.tagName === "SELECT") {
      let matched = false;
      for (const opt of el.options) {
        if (opt.value === value || opt.text.trim() === value || opt.text.trim().toLowerCase() === value.toLowerCase()) {
          el.value = opt.value;
          matched = true;
          break;
        }
      }
      if (!matched) {
        return { ok: false, error: \`No <option> matching "\${value}" in <select>\` };
      }
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true, value: el.value, ...geom };
    }

    if (el.isContentEditable) {
      el.innerText = value;
      const inputEv = typeof InputEvent === "function"
        ? new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" })
        : new Event("input", { bubbles: true });
      el.dispatchEvent(inputEv);
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true, value, ...geom };
    }

    const ownerWin = el.ownerDocument?.defaultView || window;
    const proto = el.tagName === "TEXTAREA" ? ownerWin.HTMLTextAreaElement?.prototype : ownerWin.HTMLInputElement?.prototype;
    const setter = proto ? Object.getOwnPropertyDescriptor(proto, "value")?.set : null;
    if (setter) {
      setter.call(el, value);
    } else {
      el.value = value;
    }
    const replaceInputEv = typeof InputEvent === "function"
      ? new InputEvent("input", { bubbles: true, data: value, inputType: "insertReplacementText" })
      : new Event("input", { bubbles: true });
    el.dispatchEvent(replaceInputEv);
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, value: el.value, ...geom };
  })()`;
}

/**
 * Generate JS expression to select matching text inside an indexed or selector-targeted element.
 */
export function buildSelectTextExpr(targetSpec, text, options = {}) {
  const payload = JSON.stringify({
    targetSpec,
    text: String(text ?? ""),
    prefix: String(options.prefix ?? ""),
    suffix: String(options.suffix ?? ""),
    selectionType: options.selectionType ?? "text",
  });
  return `(() => {
    const { targetSpec, text, prefix, suffix, selectionType } = ${payload};
    ${QUERY_SMART_FN_SOURCE}
    const { el, error } = resolveTargetElement(targetSpec);
    if (!el) {
      return { ok: false, error };
    }
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    if (typeof el.focus === "function") el.focus({ preventScroll: true });
    const r = getTopLevelRect(el);
    const geom = {
      x: r.left + r.width / 2,
      y: r.top + r.height / 2,
      rect: { x: r.left, y: r.top, width: r.width, height: r.height }
    };

    const needle = prefix + text + suffix;
    if (typeof el.setSelectionRange === "function" && typeof el.value === "string") {
      const pos = el.value.indexOf(needle);
      if (pos === -1) {
        return { ok: false, error: \`Text "\${text}" (with prefix/suffix) not found in element \${JSON.stringify(targetSpec)}\` };
      }
      const start = pos + prefix.length;
      const end = start + text.length;
      if (selectionType === "cursor_before") el.setSelectionRange(start, start);
      else if (selectionType === "cursor_after") el.setSelectionRange(end, end);
      else el.setSelectionRange(start, end);
      el.dispatchEvent(new Event("select", { bubbles: true }));
      return { ok: true, start, end, ...geom };
    }

    // ContentEditable / general DOM node selection via Range
    const full = el.textContent || "";
    const pos = full.indexOf(needle);
    if (pos === -1) {
      return { ok: false, error: \`Text "\${text}" not found in element \${JSON.stringify(targetSpec)}\` };
    }
    const targetStart = pos + prefix.length;
    const targetEnd = targetStart + text.length;

    const ownerDoc = el.ownerDocument || document;
    const ownerWin = ownerDoc.defaultView || window;
    const walker = ownerDoc.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let offset = 0;
    let startNode = null, startOffset = 0, endNode = null, endOffset = 0;
    let current;
    while ((current = walker.nextNode())) {
      const len = current.nodeValue.length;
      if (!startNode && targetStart <= offset + len) {
        startNode = current;
        startOffset = targetStart - offset;
      }
      if (!endNode && targetEnd <= offset + len) {
        endNode = current;
        endOffset = targetEnd - offset;
        break;
      }
      offset += len;
    }
    if (!startNode || !endNode) {
      return { ok: false, error: "Could not resolve DOM text nodes for selection" };
    }
    const range = ownerDoc.createRange();
    if (selectionType === "cursor_before") {
      range.setStart(startNode, startOffset);
      range.setEnd(startNode, startOffset);
    } else if (selectionType === "cursor_after") {
      range.setStart(endNode, endOffset);
      range.setEnd(endNode, endOffset);
    } else {
      range.setStart(startNode, startOffset);
      range.setEnd(endNode, endOffset);
    }
    const sel = ownerWin.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    return { ok: true, start: targetStart, end: targetEnd, ...geom };
  })()`;
}

/**
 * Generate JS expression to paste plain text, Markdown, or HTML into a tab without touching OS clipboard.
 * Trusted-Types CSP safe (no raw innerHTML assignments required).
 */
export function buildPasteExpr(targetSpec, text, format = "text") {
  const payload = JSON.stringify({
    targetSpec,
    text: String(text ?? ""),
    format: String(format ?? "text").toLowerCase(),
  });
  return `(() => {
    const { targetSpec, text, format } = ${payload};
    ${QUERY_SMART_FN_SOURCE}
    let el = null;
    if (targetSpec != null) {
      const resolved = resolveTargetElement(targetSpec);
      if (!resolved.el) {
        return { ok: false, error: resolved.error };
      }
      el = resolved.el;
    } else {
      el = document.activeElement;
    }
    if (!el) el = document.body;
    if (typeof el.focus === "function") el.focus({ preventScroll: true });
    const r = getTopLevelRect(el);
    const geom = {
      x: r.left + r.width / 2,
      y: r.top + r.height / 2,
      rect: { x: r.left, y: r.top, width: r.width, height: r.height }
    };

    function htmlToPlainTextSafe(html) {
      if (typeof DOMParser === "function") {
        try {
          const doc = new DOMParser().parseFromString(String(html), "text/html");
          if (doc && doc.body && typeof doc.body.textContent === "string") {
            return doc.body.textContent;
          }
        } catch {}
      }
      return String(html)
        .replace(/<br\\s*\\/?>/gi, "\\n")
        .replace(/<\\/p>/gi, "\\n")
        .replace(/<[^>]+>/g, "")
        .replace(/&nbsp;/gi, " ")
        .replace(/&amp;/gi, "&")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'");
    }

    const plainFallback = format === "html" ? htmlToPlainTextSafe(text) : text;
    let notCancelled = true;
    if (typeof DataTransfer === "function" && typeof ClipboardEvent === "function") {
      try {
        const dt = new DataTransfer();
        if (format === "html") {
          try { dt.setData("text/html", text); } catch {}
          dt.setData("text/plain", plainFallback);
        } else {
          dt.setData("text/plain", text);
        }
        const ev = new ClipboardEvent("paste", {
          clipboardData: dt,
          bubbles: true,
          cancelable: true
        });
        notCancelled = el.dispatchEvent(ev);
      } catch {}
    }

    if (notCancelled) {
      const ownerDoc = el.ownerDocument || document;
      const ownerWin = ownerDoc.defaultView || window;
      if (el.isContentEditable) {
        if (format === "html") {
          try {
            ownerDoc.execCommand("insertHTML", false, text);
          } catch {
            ownerDoc.execCommand("insertText", false, plainFallback);
          }
        } else {
          ownerDoc.execCommand("insertText", false, text);
        }
      } else if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
        const insertStr = format === "html" ? plainFallback : text;
        const start = typeof el.selectionStart === "number" ? el.selectionStart : el.value.length;
        const end = typeof el.selectionEnd === "number" ? el.selectionEnd : el.value.length;
        const nextVal = el.value.slice(0, start) + insertStr + el.value.slice(end);
        const proto = el.tagName === "TEXTAREA" ? ownerWin.HTMLTextAreaElement?.prototype : ownerWin.HTMLInputElement?.prototype;
        const setter = proto ? Object.getOwnPropertyDescriptor(proto, "value")?.set : null;
        if (setter) setter.call(el, nextVal);
        else el.value = nextVal;
        if (typeof el.setSelectionRange === "function") {
          const caret = start + insertStr.length;
          el.setSelectionRange(caret, caret);
        }
        const pasteInputEv = typeof InputEvent === "function"
          ? new InputEvent("input", { bubbles: true, data: insertStr, inputType: "insertFromPaste" })
          : new Event("input", { bubbles: true });
        el.dispatchEvent(pasteInputEv);
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }
    return { ok: true, ...geom };
  })()`;
}

/**
 * Secondary accessibility / DOM actions on an indexed or selector-targeted element.
 */
export function buildSecondaryActionExpr(targetSpec, action) {
  const payload = JSON.stringify({ targetSpec, action: String(action ?? "").trim() });
  return `(() => {
    const { targetSpec, action } = ${payload};
    ${QUERY_SMART_FN_SOURCE}
    const { el, error } = resolveTargetElement(targetSpec);
    if (!el) {
      return { ok: false, error };
    }
    const r = getTopLevelRect(el);
    const geom = {
      x: r.left + r.width / 2,
      y: r.top + r.height / 2,
      rect: { x: r.left, y: r.top, width: r.width, height: r.height }
    };
    const norm = action.toLowerCase().replace(/\\s+/g, "");
    if (norm === "focus") {
      el.focus();
      return { ok: true, ...geom };
    }
    if (norm === "blur") {
      el.blur();
      return { ok: true, ...geom };
    }
    if (norm === "check") {
      if ("checked" in el && !el.checked) el.click();
      return { ok: true, ...geom };
    }
    if (norm === "uncheck") {
      if ("checked" in el && el.checked) el.click();
      return { ok: true, ...geom };
    }
    if (norm === "expand") {
      if (el.tagName === "DETAILS") { el.open = true; return { ok: true, ...geom }; }
      if (el.getAttribute("aria-expanded") === "false") { el.click(); return { ok: true, ...geom }; }
      return { ok: true, ...geom };
    }
    if (norm === "collapse") {
      if (el.tagName === "DETAILS") { el.open = false; return { ok: true, ...geom }; }
      if (el.getAttribute("aria-expanded") === "true") { el.click(); return { ok: true, ...geom }; }
      return { ok: true, ...geom };
    }
    if (norm === "showmenu" || norm === "contextmenu") {
      const ctxEv = typeof MouseEvent === "function"
        ? new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: geom.x, clientY: geom.y, button: 2 })
        : new Event("contextmenu", { bubbles: true, cancelable: true });
      el.dispatchEvent(ctxEv);
      return { ok: true, ...geom };
    }
    if (norm === "submit") {
      const form = el.tagName === "FORM" ? el : el.closest("form");
      if (!form) return { ok: false, error: "Element is not inside a <form>" };
      if (typeof form.requestSubmit === "function") form.requestSubmit();
      else form.submit();
      return { ok: true, ...geom };
    }
    if (norm === "press" || norm === "click") {
      el.click();
      return { ok: true, ...geom };
    }
    return { ok: false, error: \`Unsupported secondary action "\${action}". Supported: Focus, Blur, Check, Uncheck, Expand, Collapse, ShowMenu, Submit, Press\` };
  })()`;
}

/**
 * Tier-2 Zero-Config File Upload Helpers:
 * Stage chunked base64 file buffers in window.__agCuaUploadStaging and construct real File + DataTransfer objects
 * to assign onto <input type="file"> OR dispatch dragenter/dragover/drop onto custom dropzones!
 */
export function buildInitUploadStagingExpr(uploadId) {
  return `(() => {
    if (!window.__agCuaUploadStaging) {
      Object.defineProperty(window, "__agCuaUploadStaging", {
        value: new Map(),
        configurable: true,
        writable: true,
        enumerable: false
      });
    }
    window.__agCuaUploadStaging.set(${JSON.stringify(uploadId)}, []);
    return { ok: true };
  })()`;
}

export function buildAppendUploadChunkExpr(uploadId, fileIndex, chunkBase64) {
  return `(() => {
    const list = window.__agCuaUploadStaging?.get(${JSON.stringify(uploadId)});
    if (!list) return { ok: false, error: "Upload staging session missing" };
    if (!list[${Number(fileIndex)}]) list[${Number(fileIndex)}] = [];
    list[${Number(fileIndex)}].push(${JSON.stringify(chunkBase64)});
    return { ok: true };
  })()`;
}

export function buildCommitDataTransferUploadExpr({ uploadId, targetSpec = null, fileMetas = [] }) {
  const payload = JSON.stringify({ uploadId, targetSpec, fileMetas });
  return `(() => {
    const { uploadId, targetSpec, fileMetas } = ${payload};
    ${QUERY_SMART_FN_SOURCE}
    const staged = window.__agCuaUploadStaging?.get(uploadId);
    window.__agCuaUploadStaging?.delete(uploadId);
    if (!staged) {
      return { ok: false, error: "Upload staging buffers expired or missing" };
    }

    let el = null;
    if (targetSpec != null) {
      const resolved = resolveTargetElement(targetSpec);
      if (!resolved.el) {
        return { ok: false, error: resolved.error };
      }
      el = resolved.el;
    } else {
      el = queryAcrossSameOriginFrames((doc) => doc.querySelector('input[type="file"]'));
    }
    if (!el) {
      return { ok: false, error: "No <input type=\\"file\\"> or dropzone target found" };
    }

    // If target is a wrapper/label/button containing a hidden <input type="file">, check inside or associated label first
    let fileInput = null;
    if (el.tagName === "INPUT" && String(el.type || "").toLowerCase() === "file") {
      fileInput = el;
    } else if (el.tagName === "LABEL") {
      if (el.htmlFor) {
        const linked = (el.ownerDocument || document).getElementById(el.htmlFor);
        if (linked && linked.tagName === "INPUT" && String(linked.type || "").toLowerCase() === "file") {
          fileInput = linked;
        }
      }
      if (!fileInput) {
        fileInput = el.querySelector?.('input[type="file"]') || null;
      }
    } else if (typeof el.querySelector === "function") {
      fileInput = el.querySelector('input[type="file"]') || null;
    }

    const ownerWin = (fileInput || el).ownerDocument?.defaultView || window;
    const DT = ownerWin.DataTransfer || DataTransfer;
    const FileCtor = ownerWin.File || File;
    const dt = new DT();

    for (let i = 0; i < fileMetas.length; i++) {
      const meta = fileMetas[i];
      const b64 = (staged[i] || []).join("");
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let j = 0; j < bin.length; j++) {
        bytes[j] = bin.charCodeAt(j);
      }
      const f = new FileCtor([bytes], meta.name, {
        type: meta.type || "application/octet-stream",
        lastModified: meta.lastModified || Date.now()
      });
      dt.items.add(f);
    }

    const r = getTopLevelRect(el);
    const geom = {
      x: r.left + r.width / 2,
      y: r.top + r.height / 2,
      rect: { x: r.left, y: r.top, width: r.width, height: r.height }
    };

    if (fileInput) {
      const proto = ownerWin.HTMLInputElement?.prototype;
      const filesSetter = proto ? Object.getOwnPropertyDescriptor(proto, "files")?.set : null;
      if (filesSetter) {
        filesSetter.call(fileInput, dt.files);
      } else {
        fileInput.files = dt.files;
      }
      fileInput.dispatchEvent(new Event("input", { bubbles: true }));
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
      return {
        ok: true,
        mechanism: "datatransfer_input",
        fileCount: dt.files.length,
        names: Array.from(dt.files).map((f) => f.name),
        ...geom
      };
    }

    // Custom dropzone fallback: dispatch dragenter -> dragover -> drop with populated DataTransfer!
    const DragEv = ownerWin.DragEvent || (typeof DragEvent === "function" ? DragEvent : Event);
    for (const evType of ["dragenter", "dragover", "drop"]) {
      let ev;
      try {
        ev = new DragEv(evType, {
          bubbles: true,
          cancelable: true,
          dataTransfer: dt,
          clientX: geom.x,
          clientY: geom.y
        });
      } catch {
        ev = new Event(evType, { bubbles: true, cancelable: true });
        Object.defineProperty(ev, "dataTransfer", { value: dt });
      }
      el.dispatchEvent(ev);
    }
    return {
      ok: true,
      mechanism: "datatransfer_dropzone",
      fileCount: dt.files.length,
      names: Array.from(dt.files).map((f) => f.name),
      ...geom
    };
  })()`;
}

/**
 * Pure Codex CursorMotionPath + 240Hz Velocity-Verlet helper source (shared between Node unit tests and in-page ShadowRoot overlay).
 */
export const CODEX_CURSOR_PHYSICS_SOURCE = `
  const CODEX_MOTION_CONFIG = {
    arcFlow: 0.5783555327868779,
    arcSize: 0.2765523188064277,
    boundsMargin: 20,
    candidateCount: 20,
    clickAngleDegrees: -44,
    endpointHandle: 0.15,
    startHandle: 0.41960295031576633,
    scootDistanceThreshold: 196,
    dampingFraction: 0.9,
    responseMin: 0.12,
    responseMax: 2.2,
    responseScaler: 0.7
  };

  const CODEX_SPRINGS = {
    stretch: { dampingFraction: 0.85, response: 0.20 },
    press: { dampingFraction: 0.85, response: 0.20 },
    visibility: { dampingFraction: 0.86, response: 0.42 },
    scootProgress: { dampingFraction: 0.94, response: 0.19 },
    scootPosition: { dampingFraction: 0.90, response: 0.19 },
    rotation: { dampingFraction: 0.90, response: 0.12 },
    scootTilt: { dampingFraction: 0.82, response: 0.055 },
    scootStretch: { dampingFraction: 0.86, response: 0.12 }
  };

  function codexClamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  function codexLerp(a, b, t) {
    return a + (b - a) * t;
  }

  function codexNormDeg(deg) {
    const r = deg % 360;
    return r < 0 ? r + 360 : r;
  }

  function codexShortestDegDelta(fromDeg, toDeg) {
    let d = toDeg - fromDeg;
    while (d > 180) d -= 360;
    while (d < -180) d += 360;
    return d;
  }

  function codexDist(a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function codexUnit(v) {
    const len = Math.sqrt(v.x * v.x + v.y * v.y);
    return len < 0.001 ? { x: 1, y: 0 } : { x: v.x / len, y: v.y / len };
  }

  function codexClickDir(angleDeg) {
    const rad = angleDeg * (Math.PI / 180);
    return { x: Math.sin(rad), y: -Math.cos(rad) };
  }

  function codexTangentDegrees(tangent) {
    if (Math.sqrt(tangent.x * tangent.x + tangent.y * tangent.y) < 0.001) {
      return codexNormDeg(CODEX_MOTION_CONFIG.clickAngleDegrees);
    }
    const u = codexUnit(tangent);
    return codexNormDeg(Math.atan2(u.y, u.x) * (180 / Math.PI) + 90);
  }

  function codexCubicPt(p0, c1, c2, p3, t) {
    const u = 1 - t;
    const b0 = u * u * u;
    const b1 = 3 * u * u * t;
    const b2 = 3 * u * t * t;
    const b3 = t * t * t;
    return {
      x: p0.x * b0 + c1.x * b1 + c2.x * b2 + p3.x * b3,
      y: p0.y * b0 + c1.y * b1 + c2.y * b2 + p3.y * b3
    };
  }

  function codexCubicTan(p0, c1, c2, p3, t) {
    const u = 1 - t;
    return {
      x: 3 * u * u * (c1.x - p0.x) + 6 * u * t * (c2.x - c1.x) + 3 * t * t * (p3.x - c2.x),
      y: 3 * u * u * (c1.y - p0.y) + 6 * u * t * (c2.y - c1.y) + 3 * t * t * (p3.y - c2.y)
    };
  }

  function codexEvalPath(path, progress) {
    const p = codexClamp(progress, 0, 1);
    const n = path.segments.length;
    const scaled = p === 1 ? n - 1 : p * n;
    const idx = Math.min(n - 1, Math.max(0, Math.floor(scaled)));
    const seg = path.segments[idx];
    const segStart = idx === 0 ? path.start : path.segments[idx - 1].end;
    const localT = p === 1 ? 1 : scaled - idx;
    return {
      point: codexCubicPt(segStart, seg.control1, seg.control2, seg.end, localT),
      tangent: codexCubicTan(segStart, seg.control1, seg.control2, seg.end, localT)
    };
  }

  function codexClampControl(bounds, origin, dir, dist) {
    const minX = bounds.minX ?? 0;
    const maxX = bounds.maxX ?? bounds.width;
    const minY = bounds.minY ?? 0;
    const maxY = bounds.maxY ?? bounds.height;
    let allowed = dist;
    if (dir.x < 0) allowed = Math.min(allowed, (origin.x - minX) / -dir.x);
    if (dir.x > 0) allowed = Math.min(allowed, (maxX - origin.x) / dir.x);
    if (dir.y < 0) allowed = Math.min(allowed, (origin.y - minY) / -dir.y);
    if (dir.y > 0) allowed = Math.min(allowed, (maxY - origin.y) / dir.y);
    const d = Math.max(0, allowed);
    return { x: origin.x + dir.x * d, y: origin.y + dir.y * d };
  }

  function codexInBounds(pt, bounds, margin) {
    const minX = bounds.minX ?? 0;
    const maxX = bounds.maxX ?? bounds.width;
    const minY = bounds.minY ?? 0;
    const maxY = bounds.maxY ?? bounds.height;
    return pt.x >= minX + margin && pt.x <= maxX - margin && pt.y >= minY + margin && pt.y <= maxY - margin;
  }

  function codexWrapRad(a, b) {
    let d = b - a;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return d;
  }

  function codexMeasurePath(path, bounds, cfg) {
    let length = 0;
    let angleChangeEnergy = 0;
    let maxAngleChange = 0;
    let totalTurn = 0;
    let prevAngle = null;
    let staysInBounds = bounds == null || cfg == null ? true : codexInBounds(path.start, bounds, cfg.boundsMargin);
    let segStart = path.start;
    let prev = path.start;
    for (const seg of path.segments) {
      for (let s = 1; s <= 24; s += 1) {
        const t = s / 24;
        const pt = codexCubicPt(segStart, seg.control1, seg.control2, seg.end, t);
        const stepLen = codexDist(prev, pt);
        length += stepLen;
        if (bounds != null && cfg != null && staysInBounds) {
          staysInBounds = codexInBounds(pt, bounds, cfg.boundsMargin);
        }
        if (stepLen > 0.01) {
          const ang = Math.atan2(pt.y - prev.y, pt.x - prev.x);
          if (prevAngle != null) {
            const delta = codexWrapRad(prevAngle, ang);
            angleChangeEnergy += delta * delta;
            maxAngleChange = Math.max(maxAngleChange, Math.abs(delta));
            totalTurn += Math.abs(delta);
          }
          prevAngle = ang;
        }
        prev = pt;
      }
      segStart = seg.end;
    }
    return { angleChangeEnergy, length, maxAngleChange, staysInBounds, totalTurn };
  }

  function codexAwkwardFactor(path) {
    const clickVec = codexClickDir(-44);
    const chord = codexUnit({ x: path.end.x - path.start.x, y: path.end.y - path.start.y });
    return codexClamp((-(chord.x * clickVec.x + chord.y * clickVec.y) - 0.08) / 0.92, 0, 1);
  }

  function codexPathCost(path, m) {
    const chord = Math.max(1, codexDist(path.start, path.end));
    const excess = Math.max(0, m.length / chord - 1);
    const arcPen = path.arc == null ? 0 : 45;
    const awkward = codexAwkwardFactor(path);
    return m.length + excess * 320 + m.angleChangeEnergy * 140 + m.maxAngleChange * 180 + m.totalTurn * 18 + awkward * 90 + arcPen;
  }

  function codexPathResponse(path) {
    const m = codexMeasurePath(path, null, null);
    const chord = Math.max(1, codexDist(path.start, path.end));
    const excess = Math.max(0, m.length / chord - 1);
    const lenN = codexClamp((m.length - 180) / 760, 0, 1);
    const exN = codexClamp(excess / 0.55, 0, 1);
    const turnN = codexClamp(m.totalTurn / (Math.PI * 1.4), 0, 1);
    const enN = codexClamp(m.angleChangeEnergy / 1.25, 0, 1);
    const curveN = codexClamp(exN * 0.42 + turnN * 0.38 + enN * 0.2, 0, 1);
    const awkward = codexAwkwardFactor(path);
    const arcAdd = path.arc == null ? 0 : 0.04;
    const arcMul = path.arc == null ? 1 : 0.9;
    return codexClamp(
      (0.42 + lenN * 0.22 + curveN * 0.12 + awkward * 0.28 + arcAdd) * CODEX_MOTION_CONFIG.responseScaler * arcMul,
      CODEX_MOTION_CONFIG.responseMin,
      CODEX_MOTION_CONFIG.responseMax
    );
  }

  function codexPlanMotionPath(start, end, bounds) {
    const cfg = CODEX_MOTION_CONFIG;
    const minX = Number.isFinite(Number(bounds?.x)) ? Number(bounds.x) : (Number.isFinite(Number(bounds?.minX)) ? Number(bounds.minX) : 0);
    const minY = Number.isFinite(Number(bounds?.y)) ? Number(bounds.y) : (Number.isFinite(Number(bounds?.minY)) ? Number(bounds.minY) : 0);
    const w = Math.max(200, Number(bounds?.width) || 1280);
    const h = Math.max(200, Number(bounds?.height) || 800);
    const safeBounds = {
      x: minX,
      y: minY,
      minX,
      minY,
      maxX: minX + w,
      maxY: minY + h,
      width: w,
      height: h
    };
    const clickTan = codexClickDir(cfg.clickAngleDegrees);
    const dist = codexDist(start, end);
    const delta = { x: end.x - start.x, y: end.y - start.y };
    const chordDir = codexUnit(delta);
    const startDist = Math.max(48, Math.min(640, dist * cfg.startHandle, dist * 0.9));
    const endDist = Math.max(48, Math.min(640, dist * cfg.endpointHandle, dist * 0.9));
    const oppTan = { x: -clickTan.x, y: -clickTan.y };
    const cStart = codexClampControl(safeBounds, start, clickTan, startDist);
    const cEnd = codexClampControl(safeBounds, end, oppTan, endDist);
    const cStartTight = codexClampControl(safeBounds, start, clickTan, startDist * 0.65);
    const cEndTight = codexClampControl(safeBounds, end, oppTan, endDist * 0.65);
    const perp = { x: -chordDir.y, y: chordDir.x };
    const sign = perp.x * clickTan.x + perp.y * clickTan.y >= 0 ? 1 : -1;
    const naturalNormal = { x: perp.x * sign, y: perp.y * sign };
    const mid = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
    const arcDistBase = Math.max(50, Math.min(520, dist * cfg.arcSize));
    const arcHandleBase = Math.max(38, Math.min(440, dist * cfg.arcFlow));

    const candidates = [
      {
        arc: null, arcIn: null, arcOut: null,
        start, end, startControl: cStart, endControl: cEnd,
        segments: [{ control1: cStart, control2: cEnd, end }]
      },
      {
        arc: null, arcIn: null, arcOut: null,
        start, end, startControl: cStartTight, endControl: cEndTight,
        segments: [{ control1: cStartTight, control2: cEndTight, end }]
      }
    ];

    for (const ds of [0.55, 0.8, 1.05]) {
      for (const hs of [0.65, 1.0, 1.35]) {
        for (const ns of [1, -1]) {
          const n = { x: naturalNormal.x * ns, y: naturalNormal.y * ns };
          const m = arcDistBase * ds;
          const h = arcHandleBase * hs;
          const arc = {
            x: mid.x + n.x * m + clickTan.x * startDist * 0.16,
            y: mid.y + n.y * m + clickTan.y * startDist * 0.16
          };
          const arcIn = { x: arc.x - chordDir.x * h, y: arc.y - chordDir.y * h };
          const arcOut = { x: arc.x + chordDir.x * h, y: arc.y + chordDir.y * h };
          candidates.push({
            arc, arcIn, arcOut,
            start, end, startControl: cStart, endControl: cEnd,
            segments: [
              { control1: cStart, control2: arcIn, end: arc },
              { control1: arcOut, control2: cEnd, end }
            ]
          });
        }
      }
    }

    const limited = candidates.slice(0, cfg.candidateCount);
    let bestIn = limited[0];
    let bestInCost = Infinity;
    let bestAny = limited[0];
    let bestAnyCost = Infinity;
    for (const cand of limited) {
      const m = codexMeasurePath(cand, safeBounds, cfg);
      const cost = codexPathCost(cand, m);
      if (cost < bestAnyCost) {
        bestAny = cand;
        bestAnyCost = cost;
      }
      if (m.staysInBounds && cost < bestInCost) {
        bestIn = cand;
        bestInCost = cost;
      }
    }
    const chosen = bestInCost === Infinity ? bestAny : bestIn;
    const response = codexPathResponse(chosen);
    return {
      path: chosen,
      springParams: { dampingFraction: cfg.dampingFraction, response }
    };
  }

  function codexCreateSpring(value, target, params) {
    return {
      dampingFraction: params.dampingFraction,
      force: 0,
      response: params.response,
      simulationTime: 0,
      scriptTime: 0,
      target,
      value,
      velocity: 0
    };
  }

  function codexSnapSpring(s, val) {
    s.force = 0;
    s.simulationTime = 0;
    s.scriptTime = 0;
    s.target = val;
    s.value = val;
    s.velocity = 0;
  }

  function codexSpringAtRest(s) {
    if (s.simulationTime === 0 && s.value !== s.target) return false;
    const restEps = 0.06;
    if (Math.max(s.velocity * s.velocity, s.force * s.force) > restEps * restEps) return false;
    const tol = s.target * 0.01;
    const diff = s.target - s.value;
    if (tol === 0) return Math.abs(diff) <= 1e-4;
    return diff * diff <= tol * tol;
  }

  function codexStepSpring(s, dt) {
    const stepDt = 1 / 240;
    const resp = Math.max(0.001, s.response);
    const maxStiff = 1 / (2 * stepDt * stepDt);
    const stiff = Math.min(Math.pow(Math.PI * 2, 2) / Math.pow(resp, 2), maxStiff);
    const drag = Math.sqrt(stiff) * 2 * s.dampingFraction;
    s.scriptTime += Math.max(0, dt);
    if (s.scriptTime - s.simulationTime > 1) {
      s.simulationTime = s.scriptTime - 1 / 60;
    }
    const half = stepDt / 2;
    while (s.simulationTime < s.scriptTime) {
      const vHalf = s.velocity + s.force * half;
      s.value += vHalf * stepDt;
      s.force = -vHalf * drag + (s.target - s.value) * stiff;
      s.velocity = vHalf + s.force * half;
      s.simulationTime += stepDt;
    }
    if (codexSpringAtRest(s)) {
      s.value = s.target;
    }
  }
`;

/**
 * Node-accessible helper to plan & sample a Codex CursorMotionPath for deterministic unit testing.
 */
export function planCodexCursorMotion(start, end, bounds = { width: 1280, height: 800 }) {
  const fn = new Function(
    "start",
    "end",
    "bounds",
    `${CODEX_CURSOR_PHYSICS_SOURCE}
     const dist = codexDist(start, end);
     if (dist <= CODEX_MOTION_CONFIG.scootDistanceThreshold) {
       const dir = codexUnit({ x: end.x - start.x, y: end.y - start.y });
       return {
         mode: "scoot",
         distance: dist,
         axisRotation: dist < 0.001 ? 0 : Math.atan2(dir.y, dir.x) * (180 / Math.PI),
         rotationTarget: codexClamp(dir.x * 0.75 - dir.y * 0.62, -1, 1) * 70,
         springParams: CODEX_SPRINGS.scootPosition
       };
     }
     const planned = codexPlanMotionPath(start, end, bounds);
     const samples = [];
     for (let i = 0; i <= 16; i += 1) {
       const p = i / 16;
       const ev = codexEvalPath(planned.path, p);
       samples.push({
         progress: p,
         x: ev.point.x,
         y: ev.point.y,
         tangentDegrees: codexTangentDegrees(ev.tangent)
       });
     }
     return {
       mode: "bezier",
       distance: dist,
       path: planned.path,
       springParams: planned.springParams,
       samples
     };`,
  );
  return fn(start, end, bounds);
}

/**
 * Node-accessible helper to step a Codex 240Hz Velocity-Verlet 1D spring for deterministic unit testing.
 */
export function simulateCodexSpring({
  from = 0,
  to = 1,
  response = 0.42,
  dampingFraction = 0.86,
  dt = 1 / 120,
  steps = 120,
} = {}) {
  const fn = new Function(
    "from",
    "to",
    "response",
    "dampingFraction",
    "dt",
    "steps",
    `${CODEX_CURSOR_PHYSICS_SOURCE}
     const s = codexCreateSpring(from, to, { response, dampingFraction });
     const trace = [];
     for (let i = 0; i < steps; i += 1) {
       const prev = s.value;
       codexStepSpring(s, dt);
       trace.push({
         step: i + 1,
         prev,
         value: s.value,
         delta: Math.abs(s.value - prev),
         velocity: s.velocity,
         force: s.force,
         atRest: codexSpringAtRest(s)
       });
     }
     return { final: s, trace };`,
  );
  return fn(from, to, response, dampingFraction, dt, steps);
}

/**
 * Inject or update the 1:1 Codex-style click-through ShadowRoot virtual cursor overlay inside a browser tab.
 * Attached to document.documentElement with data-ag-cua-ignore="true" so it never pollutes page DOM or AX snapshots.
 * Uses pure createElement + createElementNS SVG DOM construction (zero innerHTML) so strict Trusted-Types CSP pages work identically.
 */
export function buildBrowserCursorOverlayExpr(spec = {}) {
  const payload = JSON.stringify(spec);
  return `(() => {
    const spec = ${payload};
    const rootDoc = document.documentElement;
    if (!rootDoc) return { ok: false };
    ${CODEX_CURSOR_PHYSICS_SOURCE}

    const nowPerf = () => (typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now());
    const restDeg = codexNormDeg(CODEX_MOTION_CONFIG.clickAngleDegrees);

    let ctrl = window.__agCuaCursorCtrl;
    if (!ctrl || !ctrl.host || !ctrl.host.isConnected) {
      const existing = document.getElementById("__ag_cua_cursor_host__");
      if (existing) existing.remove();

      const host = document.createElement("div");
      host.id = "__ag_cua_cursor_host__";
      host.setAttribute("data-ag-cua-ignore", "true");
      host.setAttribute("aria-hidden", "true");
      host.style.cssText = "position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none !important;z-index:2147483647;overflow:hidden;contain:layout style paint;margin:0;padding:0;border:0;background:transparent;";
      const shadow = host.attachShadow({ mode: "open" });

      const style = document.createElement("style");
      style.textContent = \`
        :host { pointer-events: none !important; user-select: none !important; }
        *:not(.ag-takeover-btn) { pointer-events: none !important; user-select: none !important; box-sizing: border-box; }
        .ag-session-chrome {
          position: fixed;
          inset: 0;
          width: 100%;
          height: 100%;
          z-index: 2147483645;
          display: none;
        }
        .ag-viewport-glow {
          position: fixed;
          inset: 0;
          border: 2px solid rgba(56, 189, 248, 0.50);
          box-shadow: inset 0 0 12px rgba(14, 165, 233, 0.18);
        }
        .ag-takeover-btn {
          pointer-events: auto !important;
          cursor: pointer !important;
          user-select: none !important;
          box-sizing: border-box;
          position: fixed;
          top: 10px;
          right: 12px;
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 4px 10px 4px 8px;
          border-radius: 999px;
          border: 1px solid rgba(56, 189, 248, 0.42);
          background: rgba(11, 15, 25, 0.86);
          backdrop-filter: blur(8px);
          -webkit-backdrop-filter: blur(8px);
          box-shadow: 0 2px 10px rgba(0, 0, 0, 0.32);
          color: #f8fafc;
          font: 600 11px/14px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          letter-spacing: 0.01em;
          white-space: nowrap;
          transition: background 120ms ease, border-color 120ms ease, transform 90ms ease;
        }
        .ag-takeover-btn:hover {
          background: rgba(15, 23, 42, 0.96);
          border-color: rgba(56, 189, 248, 0.82);
        }
        .ag-takeover-btn:active {
          transform: scale(0.97);
        }
        .ag-takeover-dot {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          background: #38bdf8;
          box-shadow: 0 0 6px rgba(56, 189, 248, 0.85);
          flex-shrink: 0;
        }
        .ag-layer { position: fixed; inset: 0; width: 100%; height: 100%; overflow: hidden; opacity: 0; transition: opacity 220ms ease; z-index: 2147483646; }
        .ag-layer.visible { opacity: 1; transition: none; }
        .ag-highlight {
          position: fixed;
          left: 0; top: 0; width: 0; height: 0;
          border-radius: 8px;
          border: 1.8px solid rgba(56, 189, 248, 0.90);
          background: rgba(56, 189, 248, 0.08);
          box-shadow: 0 0 10px rgba(14, 165, 233, 0.42);
          opacity: 0;
          transition: transform 110ms cubic-bezier(0.22, 1, 0.36, 1), width 110ms cubic-bezier(0.22, 1, 0.36, 1), height 110ms cubic-bezier(0.22, 1, 0.36, 1);
          will-change: transform, width, height, opacity;
        }
        .ag-highlight.instant {
          transition: none !important;
        }
        .ag-cursor {
          position: fixed;
          left: 0; top: 0;
          width: 0; height: 0;
          transform: translate3d(-100px, -100px, 0);
          transition-property: none;
          transition-duration: 0ms;
          will-change: transform, opacity, filter;
        }
        .ag-cursor.instant {
          transition: none !important;
        }
        .ag-pointer-wrap {
          position: absolute;
          left: 0; top: 0;
          transform-origin: 0px 0px;
          will-change: transform;
        }
        .ag-glow {
          position: absolute;
          left: -13.5px; top: -13.5px;
          width: 27px; height: 27px;
          border-radius: 50%;
          transform-origin: 50% 50%;
          background: radial-gradient(circle, rgba(11, 158, 255, 0.34) 0%, rgba(62, 192, 255, 0.18) 52%, rgba(188, 233, 252, 0) 76%);
          will-change: transform, opacity;
        }
        @keyframes agRippleExpand {
          0% { transform: translate(-50%, -50%) scale(0.36); opacity: 0.88; border-width: 1.7px; }
          45% { transform: translate(-50%, -50%) scale(0.76); opacity: 0.75; border-width: 1.5px; }
          100% { transform: translate(-50%, -50%) scale(1.06); opacity: 0; border-width: 0.9px; }
        }
        .ag-ripple {
          position: fixed;
          width: 38px; height: 38px;
          border-radius: 50%;
          border: 1.6px solid #38bdf8;
          box-shadow: 0 0 5px rgba(56, 189, 248, 0.32);
          transform: translate(-50%, -50%) scale(0.36);
          animation: agRippleExpand 740ms cubic-bezier(0.16, 1, 0.3, 1) forwards;
        }
        .ag-shot-ripple {
          position: fixed;
          border-radius: 50%;
          transform: translate(-50%, -50%);
          animation: none !important;
          transition: none !important;
        }
        @keyframes agScrollPulse {
          0% { opacity: 0; transform: translate(-50%, -50%) scale(0.85); }
          35% { opacity: 0.92; transform: translate(-50%, -50%) scale(1); }
          100% { opacity: 0; transform: translate(-50%, -50%) scale(1.08); }
        }
        .ag-scroll-ind {
          position: fixed;
          color: #ffffff;
          font: 700 11.5px/1 -apple-system, sans-serif;
          text-shadow: 0 1px 4px rgba(0, 0, 0, 0.65);
          animation: agScrollPulse 480ms ease-out forwards;
        }
      \`;

      const sessionChrome = document.createElement("div");
      sessionChrome.className = "ag-session-chrome";
      const viewportGlow = document.createElement("div");
      viewportGlow.className = "ag-viewport-glow";
      const takeoverBtn = document.createElement("button");
      takeoverBtn.type = "button";
      takeoverBtn.className = "ag-takeover-btn";
      takeoverBtn.setAttribute("data-ag-cua-ignore", "true");
      const takeoverDot = document.createElement("span");
      takeoverDot.className = "ag-takeover-dot";
      const takeoverLabel = document.createElement("span");
      takeoverLabel.textContent = "Antigravity · Take Over";
      takeoverBtn.appendChild(takeoverDot);
      takeoverBtn.appendChild(takeoverLabel);
      sessionChrome.appendChild(viewportGlow);
      sessionChrome.appendChild(takeoverBtn);

      const layer = document.createElement("div");
      layer.className = "ag-layer";

      const highlight = document.createElement("div");
      highlight.className = "ag-highlight";

      const fxContainer = document.createElement("div");

      const cursor = document.createElement("div");
      cursor.className = "ag-cursor instant";

      const glow = document.createElement("div");
      glow.className = "ag-glow";

      const ptrWrap = document.createElement("div");
      ptrWrap.className = "ag-pointer-wrap";

      const svgNS = "http://www.w3.org/2000/svg";
      const svg = document.createElementNS(svgNS, "svg");
      svg.setAttribute("width", "26");
      svg.setAttribute("height", "26");
      svg.setAttribute("viewBox", "-13 -3 26 24");
      svg.setAttribute("fill", "none");
      svg.style.cssText = "position:absolute;left:-13px;top:-3px;overflow:visible;filter:drop-shadow(0px 1.5px 3.4px rgba(0,0,0,0.36));";

      const defs = document.createElementNS(svgNS, "defs");
      const grad = document.createElementNS(svgNS, "linearGradient");
      grad.setAttribute("id", "agBodyGrad");
      grad.setAttribute("x1", "0");
      grad.setAttribute("y1", "0");
      grad.setAttribute("x2", "0");
      grad.setAttribute("y2", "23");
      grad.setAttribute("gradientUnits", "userSpaceOnUse");

      const stop1 = document.createElementNS(svgNS, "stop");
      stop1.setAttribute("offset", "0%");
      stop1.setAttribute("stop-color", "#000000");
      const stop2 = document.createElementNS(svgNS, "stop");
      stop2.setAttribute("offset", "100%");
      stop2.setAttribute("stop-color", "#0d0d11");
      grad.appendChild(stop1);
      grad.appendChild(stop2);
      defs.appendChild(grad);

      // Exact Codex AgentCursor rounded cubic Bezier path in canonical up-frame with tip apex at (0, 0), scaled by 0.72x (~16.5px tall)
      const agentCursorD = "M -2.691 1.684 C -1.613 -0.414 1.287 -0.592 2.258 1.379 L 10.077 17.279 C 11.15 19.465 8.864 22.079 6.527 21.339 L -0.682 19.053 L -8.035 22.234 C -10.421 23.266 -12.576 20.925 -11.381 18.599 Z";

      const geomGroup = document.createElementNS(svgNS, "g");
      geomGroup.setAttribute("class", "ag-pointer-geom");
      geomGroup.setAttribute("transform", "scale(0.72)");

      const pathBorder = document.createElementNS(svgNS, "path");
      pathBorder.setAttribute("d", agentCursorD);
      pathBorder.setAttribute("stroke", "#FFFFFF");
      // 2.78 * 0.72 = 2.00px effective screen border width (~1.9px-2.1px sleek outline)
      pathBorder.setAttribute("stroke-width", "2.78");
      pathBorder.setAttribute("stroke-linejoin", "round");
      pathBorder.setAttribute("stroke-linecap", "round");
      pathBorder.setAttribute("fill", "#FFFFFF");

      const pathBody = document.createElementNS(svgNS, "path");
      pathBody.setAttribute("d", agentCursorD);
      pathBody.setAttribute("fill", "url(#agBodyGrad)");
      pathBody.setAttribute("stroke", "none");

      geomGroup.appendChild(pathBorder);
      geomGroup.appendChild(pathBody);
      svg.appendChild(defs);
      svg.appendChild(geomGroup);
      ptrWrap.appendChild(svg);

      cursor.appendChild(glow);
      cursor.appendChild(ptrWrap);
      layer.appendChild(highlight);
      layer.appendChild(fxContainer);
      layer.appendChild(cursor);
      shadow.appendChild(style);
      shadow.appendChild(sessionChrome);
      shadow.appendChild(layer);
      rootDoc.appendChild(host);

      ctrl = {
        host,
        shadow,
        sessionChrome,
        viewportGlow,
        takeoverBtn,
        layer,
        highlight,
        fxContainer,
        cursor,
        glow,
        ptrWrap,
        geomGroup,
        baseScale: 0.72,
        sessionChromeActive: false,
        takenOver: false,
        x: null,
        y: null,
        visible: false,
        destroyed: false,
        badgeText: null,
        showBadgePill: false,
        badgeAccent: "#38bdf8",
        highlightedRect: null,
        lastRipple: null,
        idleTimer: null,
        pressTimer: null,
        rafId: null,
        rafIsTimeout: false,
        firstFrame: false,
        lastFrameAt: 0,
        sim: null,
      };

      const onTakeOverClick = (ev) => {
        try {
          ev?.preventDefault?.();
          ev?.stopPropagation?.();
        } catch {}
        ctrl.takenOver = true;
        ctrl.sessionChromeActive = false;
        ctrl.visible = false;
        sessionChrome.style.display = "none";
        layer.classList.remove("visible");
        layer.style.opacity = "0";
        if (typeof window.__agCuaControl === "function") {
          try {
            window.__agCuaControl(JSON.stringify({ action: "take_over", ts: Date.now() }));
          } catch {}
        }
      };
      if (typeof takeoverBtn.addEventListener === "function") {
        takeoverBtn.addEventListener("click", onTakeOverClick);
      } else {
        takeoverBtn.onclick = onTakeOverClick;
      }

      Object.defineProperty(window, "__agCuaCursorCtrl", {
        value: ctrl,
        configurable: true,
        writable: true,
        enumerable: false,
      });
    }

    const createSimState = (pt, visibleNow) => {
      const vis = visibleNow ? 1 : 0;
      return {
        motion: null,
        mode: "idle",
        point: { x: pt.x, y: pt.y },
        positionXSpring: codexCreateSpring(pt.x, pt.x, CODEX_SPRINGS.scootPosition),
        positionYSpring: codexCreateSpring(pt.y, pt.y, CODEX_SPRINGS.scootPosition),
        rotation: restDeg,
        rotationSpring: codexCreateSpring(restDeg, restDeg, CODEX_SPRINGS.rotation),
        scootAxisRotation: 0,
        scootAxisSpring: codexCreateSpring(0, 0, CODEX_SPRINGS.rotation),
        scootRotationSpring: codexCreateSpring(0, 0, CODEX_SPRINGS.scootTilt),
        scootStretchSpring: codexCreateSpring(1, 1, CODEX_SPRINGS.scootStretch),
        stretchSpring: codexCreateSpring(1, 1, CODEX_SPRINGS.stretch),
        pressScaleSpring: codexCreateSpring(1, 1, CODEX_SPRINGS.press),
        visibilitySpring: codexCreateSpring(vis, vis, CODEX_SPRINGS.visibility),
      };
    };

    const snapSim = (sim, tx, ty) => {
      sim.motion = null;
      sim.mode = "idle";
      sim.point = { x: tx, y: ty };
      codexSnapSpring(sim.positionXSpring, tx);
      codexSnapSpring(sim.positionYSpring, ty);
      codexSnapSpring(sim.rotationSpring, restDeg);
      sim.rotation = restDeg;
      codexSnapSpring(sim.scootAxisSpring, 0);
      codexSnapSpring(sim.scootRotationSpring, 0);
      codexSnapSpring(sim.scootStretchSpring, 1);
      codexSnapSpring(sim.stretchSpring, 1);
      sim.scootAxisRotation = 0;
    };

    const startSimMotion = (sim, target, viewport) => {
      const start = { x: sim.point.x, y: sim.point.y };
      const dist = codexDist(start, target);
      if (dist < 0.5) {
        snapSim(sim, target.x, target.y);
        return 0;
      }
      if (dist <= CODEX_MOTION_CONFIG.scootDistanceThreshold) {
        const dir = codexUnit({ x: target.x - start.x, y: target.y - start.y });
        const axisRotation = Math.atan2(dir.y, dir.x) * (180 / Math.PI);
        const rotationTarget = codexClamp(dir.x * 0.75 - dir.y * 0.62, -1, 1) * 70;
        sim.positionXSpring.response = CODEX_SPRINGS.scootPosition.response;
        sim.positionXSpring.dampingFraction = CODEX_SPRINGS.scootPosition.dampingFraction;
        sim.positionYSpring.response = CODEX_SPRINGS.scootPosition.response;
        sim.positionYSpring.dampingFraction = CODEX_SPRINGS.scootPosition.dampingFraction;
        sim.positionXSpring.target = target.x;
        sim.positionYSpring.target = target.y;
        sim.rotationSpring.target = sim.rotationSpring.value + codexShortestDegDelta(sim.rotationSpring.value, restDeg);
        sim.scootAxisSpring.target = sim.scootAxisSpring.value + codexShortestDegDelta(sim.scootAxisSpring.value, axisRotation);
        sim.mode = "scoot";
        sim.motion = {
          mode: "scoot",
          start,
          end: target,
          axisRotation,
          rotationTarget,
          progressSpring: codexCreateSpring(0, 1, CODEX_SPRINGS.scootProgress),
        };
        return Math.min(185, Math.max(75, Math.round(70 + dist * 0.42)));
      }
      const planned = codexPlanMotionPath(start, target, viewport);
      const followerResp = codexClamp(planned.springParams.response * 0.18, 0.035, 0.12);
      sim.positionXSpring.response = followerResp;
      sim.positionXSpring.dampingFraction = planned.springParams.dampingFraction;
      sim.positionYSpring.response = followerResp;
      sim.positionYSpring.dampingFraction = planned.springParams.dampingFraction;
      sim.mode = "bezier";
      sim.motion = {
        mode: "bezier",
        path: planned.path,
        progressSpring: codexCreateSpring(0, 1, planned.springParams),
      };
      return Math.min(420, Math.max(125, Math.round(planned.springParams.response * 820)));
    };

    const stepSim = (sim, dt) => {
      if (sim.motion != null) {
        if (sim.motion.mode === "bezier") {
          const m = sim.motion;
          sim.scootStretchSpring.target = 1;
          sim.scootRotationSpring.target = 0;
          codexStepSpring(m.progressSpring, dt);
          const p = codexClamp(m.progressSpring.value, 0, 1);
          const ev = codexEvalPath(m.path, p);
          let tanDeg = codexTangentDegrees(ev.tangent);
          if (p > 0.96) {
            const blend = codexClamp((p - 0.96) / 0.04, 0, 1);
            tanDeg = codexNormDeg(tanDeg + codexShortestDegDelta(tanDeg, restDeg) * blend);
          }
          sim.positionXSpring.target = ev.point.x;
          sim.positionYSpring.target = ev.point.y;
          sim.rotationSpring.target = sim.rotationSpring.value + codexShortestDegDelta(sim.rotationSpring.value, tanDeg);
          sim.scootAxisSpring.target = sim.scootAxisSpring.value + codexShortestDegDelta(sim.scootAxisSpring.value, 0);

          const prev = sim.point;
          codexStepSpring(sim.positionXSpring, dt);
          codexStepSpring(sim.positionYSpring, dt);
          codexStepSpring(sim.rotationSpring, dt);
          codexStepSpring(sim.scootAxisSpring, dt);
          const cur = { x: sim.positionXSpring.value, y: sim.positionYSpring.value };
          const speed = codexDist(prev, cur) / Math.max(dt, 1 / 240);
          sim.point = cur;
          sim.rotation = sim.rotationSpring.value;
          sim.scootAxisRotation = sim.scootAxisSpring.value;
          sim.stretchSpring.target = codexClamp(1 - speed / 5500, 0.65, 1);

          const closePos =
            codexDist(cur, m.path.end) <= 0.85 &&
            Math.abs(sim.positionXSpring.velocity) <= 12 &&
            Math.abs(sim.positionYSpring.velocity) <= 12;
          if (p >= 0.999 && Math.abs(m.progressSpring.velocity) < 0.01 && closePos) {
            snapSim(sim, m.path.end.x, m.path.end.y);
          }
        } else {
          const m = sim.motion;
          codexStepSpring(m.progressSpring, dt);
          sim.positionXSpring.target = m.end.x;
          sim.positionYSpring.target = m.end.y;
          sim.scootAxisSpring.target = sim.scootAxisSpring.value + codexShortestDegDelta(sim.scootAxisSpring.value, m.axisRotation);
          sim.rotationSpring.target = sim.rotationSpring.value + codexShortestDegDelta(sim.rotationSpring.value, restDeg);

          codexStepSpring(sim.positionXSpring, dt);
          codexStepSpring(sim.positionYSpring, dt);
          codexStepSpring(sim.rotationSpring, dt);
          codexStepSpring(sim.scootAxisSpring, dt);
          const cur = { x: sim.positionXSpring.value, y: sim.positionYSpring.value };
          sim.point = cur;
          sim.rotation = sim.rotationSpring.value;
          sim.scootAxisRotation = sim.scootAxisSpring.value;

          const dx = m.end.x - m.start.x;
          const dy = m.end.y - m.start.y;
          const sq = dx * dx + dy * dy;
          const proj = sq < 0.001 ? 1 : codexClamp(((cur.x - m.start.x) * dx + (cur.y - m.start.y) * dy) / sq, 0, 1);
          const bell = Math.sin(Math.min(1, proj) * Math.PI);
          sim.stretchSpring.target = 1;
          sim.scootStretchSpring.target = codexLerp(1, 1 - bell, 0.15);
          sim.scootRotationSpring.target = m.rotationTarget * bell;

          const closePos =
            codexDist(cur, m.end) <= 0.85 &&
            Math.abs(sim.positionXSpring.velocity) <= 12 &&
            Math.abs(sim.positionYSpring.velocity) <= 12;
          if (proj >= 0.999 && Math.abs(m.progressSpring.velocity) < 0.01 && closePos) {
            snapSim(sim, m.end.x, m.end.y);
          }
        }
      } else {
        sim.stretchSpring.target = 1;
        sim.scootStretchSpring.target = 1;
        sim.scootRotationSpring.target = 0;
        sim.rotationSpring.target = sim.rotationSpring.value + codexShortestDegDelta(sim.rotationSpring.value, restDeg);
        codexStepSpring(sim.rotationSpring, dt);
        sim.rotation = sim.rotationSpring.value;
      }

      codexStepSpring(sim.visibilitySpring, dt);
      codexStepSpring(sim.stretchSpring, dt);
      codexStepSpring(sim.scootStretchSpring, dt);
      codexStepSpring(sim.scootRotationSpring, dt);
      codexStepSpring(sim.pressScaleSpring, dt);
    };

    const simNeedsMoreFrames = (sim) => {
      const springActive = (s) => !(s.value === s.target && codexSpringAtRest(s));
      return (
        sim.motion != null ||
        springActive(sim.positionXSpring) ||
        springActive(sim.positionYSpring) ||
        springActive(sim.rotationSpring) ||
        springActive(sim.scootAxisSpring) ||
        springActive(sim.scootRotationSpring) ||
        springActive(sim.scootStretchSpring) ||
        springActive(sim.stretchSpring) ||
        springActive(sim.pressScaleSpring) ||
        springActive(sim.visibilitySpring)
      );
    };

    const renderSimToDom = () => {
      const sim = ctrl.sim;
      if (!sim) return;
      const vis = codexClamp(sim.visibilitySpring.value, 0, 1);
      const visScale = codexLerp(0.4, 1.0, vis);
      const visBlur = codexLerp(5.0, 0.0, vis);
      const press = codexClamp(sim.pressScaleSpring.value, 0.5, 1.2);
      const scootS = codexClamp(sim.scootStretchSpring.value, 0.2, 1.0);
      const dartS = codexClamp(sim.stretchSpring.value, 0.65, 1.0);
      const px = Math.round(sim.point.x * 1000) / 1000;
      const py = Math.round(sim.point.y * 1000) / 1000;

      ctrl.cursor.style.transform = \`translate3d(\${px}px, \${py}px, 0)\`;
      ctrl.cursor.style.opacity = \`\${Math.round(vis * 1000) / 1000}\`;
      ctrl.cursor.style.filter = visBlur > 0.05 ? \`blur(\${Math.round(visBlur * 100) / 100}px)\` : "none";

      const parts = [];
      if (Math.abs(scootS - 1) > 0.001) {
        const ax = Math.round(sim.scootAxisRotation * 100) / 100;
        parts.push(\`rotate(\${ax}deg)\`, \`scale(1, \${Math.round(scootS * 1000) / 1000})\`, \`rotate(\${-ax}deg)\`);
      }
      const totalRot = Math.round(codexNormDeg(sim.rotation + sim.scootRotationSpring.value) * 100) / 100;
      const combScale = Math.round(visScale * press * 1000) / 1000;
      const widthScale = Math.round(dartS * visScale * press * 1000) / 1000;
      parts.push(\`rotate(\${totalRot}deg)\`, \`scale(\${widthScale}, \${combScale})\`);
      ctrl.ptrWrap.style.transform = parts.join(" ");

      const velNorm = codexClamp((Math.abs(sim.positionXSpring.velocity) + Math.abs(sim.positionYSpring.velocity)) * 0.5 / 3000, 0, 1);
      const fogScale = Math.round((1 + velNorm * 1.5) * 1000) / 1000;
      const rotRad = totalRot * (Math.PI / 180);
      const bodyOff = 7.5 * press;
      const gx = Math.round(-Math.sin(rotRad) * bodyOff * 10) / 10;
      const gy = Math.round(Math.cos(rotRad) * bodyOff * 10) / 10;
      ctrl.glow.style.transform = \`translate3d(\${gx}px, \${gy}px, 0) scale(\${fogScale})\`;
    };

    const cancelScheduledFrame = () => {
      if (ctrl.rafId == null) return;
      if (ctrl.rafIsTimeout) {
        clearTimeout(ctrl.rafId);
      } else if (typeof window !== "undefined" && typeof window.cancelAnimationFrame === "function") {
        window.cancelAnimationFrame(ctrl.rafId);
      } else {
        clearTimeout(ctrl.rafId);
      }
      ctrl.rafId = null;
      ctrl.rafIsTimeout = false;
    };

    const scheduleFrame = () => {
      if (ctrl.rafId != null || ctrl.destroyed || !ctrl.sim) return;
      let syncInvoked = false;
      let scheduling = true;
      const tick = (ts) => {
        ctrl.rafId = null;
        ctrl.rafIsTimeout = false;
        if (ctrl.destroyed || !ctrl.sim) return;
        const now = typeof ts === "number" && Number.isFinite(ts) ? ts : nowPerf();
        const dt = ctrl.firstFrame ? 1 / 60 : Math.max(1 / 240, Math.min(0.05, (now - ctrl.lastFrameAt) / 1000));
        ctrl.firstFrame = false;
        ctrl.lastFrameAt = now;
        stepSim(ctrl.sim, dt);
        renderSimToDom();
        if (!ctrl.visible && ctrl.sim.visibilitySpring.value <= 0.01) {
          ctrl.layer.classList.remove("visible");
          ctrl.layer.style.opacity = "";
          return;
        }
        if (simNeedsMoreFrames(ctrl.sim)) {
          if (scheduling) {
            syncInvoked = true;
          } else {
            scheduleFrame();
          }
        }
      };

      if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
        ctrl.rafIsTimeout = false;
        ctrl.rafId = window.requestAnimationFrame(tick);
      } else {
        ctrl.rafIsTimeout = true;
        ctrl.rafId = setTimeout(() => tick(nowPerf()), 16);
      }
      scheduling = false;
      // Guard against synchronous test stubs like requestAnimationFrame: (fn) => fn()
      if (syncInvoked && ctrl.rafId == null && !ctrl.destroyed) {
        ctrl.rafIsTimeout = true;
        ctrl.rafId = setTimeout(() => tick(nowPerf()), 16);
      }
    };

    ctrl.renderSimToDom = renderSimToDom;
    ctrl.scheduleFrame = scheduleFrame;
    ctrl.cancelScheduledFrame = cancelScheduledFrame;

    const accentFor = (kind) => {
      const k = String(kind || "left").toLowerCase();
      if (k === "right" || k === "r" || k === "secondary") return "#a855f7";
      if (k === "middle" || k === "m") return "#f59e0b";
      return "#38bdf8";
    };

    const vw = window.innerWidth || 1280;
    const vh = window.innerHeight || 800;
    const tx = Number.isFinite(spec.x) ? spec.x : (ctrl.x ?? vw * 0.58);
    const ty = Number.isFinite(spec.y) ? spec.y : (ctrl.y ?? vh * 0.55);
    const accent = accentFor(spec.button || spec.colorKind);
    const idleMs = Number(spec.idleTimeoutMs) > 0 ? Number(spec.idleTimeoutMs) : 8000;
    const isInstant = Boolean(spec.instant);
    const isEffectOnly = Boolean(spec.effectOnly);

    const wasVisible = ctrl.visible && ctrl.sim != null && ctrl.x !== null && ctrl.y !== null;
    if (!ctrl.sim) {
      ctrl.sim = createSimState({ x: tx, y: ty }, true);
    }

    ctrl.visible = true;
    ctrl.layer.classList.add("visible");
    ctrl.layer.style.opacity = "1";
    ctrl.sim.visibilitySpring.target = 1;

    let glideDurationMs = 0;
    if (isEffectOnly) {
      if (wasVisible && Math.hypot((ctrl.x ?? tx) - tx, (ctrl.y ?? ty) - ty) < 2) {
        // Preserve active Velocity-Verlet glide & momentum when triggering click/press effect at CloseEnough handoff
        glideDurationMs = 0;
      } else {
        codexSnapSpring(ctrl.sim.visibilitySpring, 1);
        snapSim(ctrl.sim, tx, ty);
        glideDurationMs = 0;
      }
    } else if (isInstant) {
      ctrl.cursor.classList.add("instant");
      ctrl.highlight.classList.add("instant");
      ctrl.cursor.style.transitionDuration = "0ms";
      codexSnapSpring(ctrl.sim.visibilitySpring, 1);
      snapSim(ctrl.sim, tx, ty);
      glideDurationMs = 0;
    } else if (!wasVisible) {
      const entryX = tx - 28;
      const entryY = ty + 22;
      ctrl.sim.visibilitySpring.value = 0.4;
      ctrl.sim.visibilitySpring.target = 1;
      snapSim(ctrl.sim, entryX, entryY);
      ctrl.cursor.classList.remove("instant");
      ctrl.highlight.classList.remove("instant");
      glideDurationMs = startSimMotion(ctrl.sim, { x: tx, y: ty }, { width: vw, height: vh }) || 95;
      ctrl.cursor.style.transitionDuration = \`\${glideDurationMs}ms\`;
      ctrl.firstFrame = true;
    } else {
      const liveDist = codexDist(ctrl.sim.point, { x: tx, y: ty });
      if (liveDist < 2 && ctrl.sim.motion == null) {
        ctrl.cursor.classList.add("instant");
        ctrl.highlight.classList.add("instant");
        ctrl.cursor.style.transitionDuration = "0ms";
        snapSim(ctrl.sim, tx, ty);
        glideDurationMs = 0;
      } else {
        ctrl.cursor.classList.remove("instant");
        ctrl.highlight.classList.remove("instant");
        glideDurationMs = startSimMotion(ctrl.sim, { x: tx, y: ty }, { width: vw, height: vh });
        ctrl.cursor.style.transitionDuration = \`\${glideDurationMs}ms\`;
        ctrl.firstFrame = true;
      }
    }

    ctrl.x = tx;
    ctrl.y = ty;

    const isPressing = Boolean(spec.ripple || spec.pressed || spec.dragging);
    if (isPressing) {
      ctrl.sim.pressScaleSpring.target = 0.70;
      if (ctrl.pressTimer) clearTimeout(ctrl.pressTimer);
      if (!spec.dragging) {
        const holdMs = Math.max(90, Math.min(2000, Number(spec.holdDurationMs) || 120));
        ctrl.pressTimer = setTimeout(() => {
          if (ctrl.sim) {
            ctrl.sim.pressScaleSpring.target = 1.0;
            scheduleFrame();
          }
        }, holdMs);
      }
    } else if (spec.dragging === false) {
      ctrl.sim.pressScaleSpring.target = 1.0;
    }

    if (spec.rect && spec.rect.width >= 2 && spec.rect.height >= 2) {
      const pad = 4;
      const hx = spec.rect.x - pad;
      const hy = spec.rect.y - pad;
      const hw = spec.rect.width + pad * 2;
      const hh = spec.rect.height + pad * 2;
      ctrl.highlight.style.transform = \`translate3d(\${hx}px, \${hy}px, 0)\`;
      ctrl.highlight.style.width = \`\${hw}px\`;
      ctrl.highlight.style.height = \`\${hh}px\`;
      ctrl.highlight.style.opacity = "1";
      ctrl.highlightedRect = {
        x: Math.round(spec.rect.x),
        y: Math.round(spec.rect.y),
        width: Math.round(spec.rect.width),
        height: Math.round(spec.rect.height),
      };
    } else if (spec.clearHighlight || (spec.rect === null && Number.isFinite(spec.x))) {
      ctrl.highlight.style.opacity = "0";
      ctrl.highlightedRect = null;
    }

    // Mouse pill next to cursor is permanently suppressed (always null / hidden)
    ctrl.badgeText = null;
    ctrl.showBadgePill = false;

    if (spec.sessionChrome !== undefined) {
      ctrl.sessionChromeActive = Boolean(spec.sessionChrome);
    } else if (!ctrl.takenOver) {
      ctrl.sessionChromeActive = true;
    }
    if (ctrl.sessionChrome) {
      ctrl.sessionChrome.style.display = ctrl.sessionChromeActive ? "block" : "none";
    }

    if (spec.cursorOnlyChrome) {
      return {
        ok: true,
        visible: Boolean(ctrl.visible),
        active: Boolean(ctrl.sessionChromeActive),
        sessionChromeActive: Boolean(ctrl.sessionChromeActive),
        takenOver: Boolean(ctrl.takenOver),
        baseScale: 0.72,
        badge: null,
        showBadge: false
      };
    }

    if (spec.ripple) {
      const nowMs = Date.now();
      const count = Math.max(1, Math.min(3, Number(spec.clickCount) || 1));
      const recentlySpawned =
        ctrl.lastRipple &&
        nowMs - ctrl.lastRipple.at < 220 &&
        Math.hypot((ctrl.lastRipple.x ?? 0) - tx, (ctrl.lastRipple.y ?? 0) - ty) < 6 &&
        Boolean(ctrl.fxContainer.querySelector?.(".ag-ripple"));
      ctrl.lastRipple = { x: tx, y: ty, accent, count, at: nowMs };
      if (!recentlySpawned) {
        const spawnRing = () => {
          const ring = document.createElement("div");
          ring.className = "ag-ripple";
          ring.style.left = \`\${tx}px\`;
          ring.style.top = \`\${ty}px\`;
          ring.style.borderColor = accent;
          ctrl.fxContainer.appendChild(ring);
          setTimeout(() => ring.remove(), 780);
        };
        spawnRing();
        for (let r = 1; r < count; r++) {
          setTimeout(spawnRing, r * 110);
        }
      }
    }

    if (spec.scrollDirection) {
      const ind = document.createElement("div");
      ind.className = "ag-scroll-ind";
      const d = String(spec.scrollDirection).toLowerCase();
      ind.textContent = d.startsWith("u") ? "↑↑" : d.startsWith("l") ? "←←" : d.startsWith("r") ? "→→" : "↓↓";
      ind.style.left = \`\${tx + 15}px\`;
      ind.style.top = \`\${ty - 5}px\`;
      ctrl.fxContainer.appendChild(ind);
      setTimeout(() => ind.remove(), 500);
    }

    renderSimToDom();
    if (simNeedsMoreFrames(ctrl.sim)) {
      scheduleFrame();
    }

    if (ctrl.idleTimer) clearTimeout(ctrl.idleTimer);
    ctrl.idleTimer = setTimeout(() => {
      ctrl.visible = false;
      if (ctrl.sim) {
        ctrl.sim.visibilitySpring.target = 0;
      }
      ctrl.highlight.style.opacity = "0";
      ctrl.highlightedRect = null;
      ctrl.badgeText = null;
      ctrl.showBadgePill = false;
      scheduleFrame();
    }, idleMs);

    return {
      ok: true,
      visible: true,
      instant: isInstant,
      mode: ctrl.sim.mode,
      glideDurationMs,
      x: Math.round(tx),
      y: Math.round(ty),
      liveX: Math.round(ctrl.sim.point.x),
      liveY: Math.round(ctrl.sim.point.y),
      baseScale: 0.72,
      badge: null,
      showBadge: false,
      highlightedRect: ctrl.highlightedRect
    };
  })()`;
}

/**
 * Enable or disable the subtle active-tab sky-blue viewport border + top-right [Antigravity · Take Over] pill
 * without moving or showing the virtual pointer itself.
 */
export function buildSetActiveTabIndicatorExpr(active = true) {
  if (!active) {
    return `(() => {
      const ctrl = window.__agCuaCursorCtrl;
      if (ctrl) {
        ctrl.sessionChromeActive = false;
        if (ctrl.sessionChrome) ctrl.sessionChrome.style.display = "none";
      }
      return { ok: true, sessionChromeActive: false };
    })()`;
  }
  const initExpr = buildBrowserCursorOverlayExpr({ sessionChrome: true, cursorOnlyChrome: true });
  return `(() => {
    const existing = window.__agCuaCursorCtrl;
    if (existing && existing.host && existing.host.isConnected) {
      existing.takenOver = false;
      existing.sessionChromeActive = true;
      if (existing.sessionChrome) existing.sessionChrome.style.display = "block";
      return { ok: true, sessionChromeActive: true };
    }
    const res = ${initExpr};
    const ctrl = window.__agCuaCursorCtrl;
    if (ctrl) {
      ctrl.visible = false;
      ctrl.layer.classList.remove("visible");
      ctrl.layer.style.opacity = "0";
      ctrl.takenOver = false;
      ctrl.sessionChromeActive = true;
      if (ctrl.sessionChrome) ctrl.sessionChrome.style.display = "block";
    }
    return res;
  })()`;
}

/**
 * Snap active browser cursor, highlight, and recent ripple ring to deterministic full-visibility
 * computed styles right before `Page.captureScreenshot` (while hiding `.ag-session-chrome` so screenshots
 * never show the active-tab border or Take Over button), and restore cleanly afterward.
 */
export function buildPrepareBrowserCursorForScreenshotExpr(prepare = true, { awaitFrame = false } = {}) {
  const prepBool = Boolean(prepare);
  if (!prepBool) {
    return `(() => {
      const ctrl = window.__agCuaCursorCtrl;
      if (!ctrl) return { ok: true };
      if (ctrl.sessionChrome) {
        ctrl.sessionChrome.style.display = ctrl.sessionChromeActive ? "block" : "none";
      }
      if (!ctrl.fxContainer) return { ok: true };
      for (const sr of ctrl.fxContainer.querySelectorAll(".ag-shot-ripple")) {
        sr.remove();
      }
      for (const ar of ctrl.fxContainer.querySelectorAll(".ag-ripple")) {
        ar.style.visibility = "";
      }
      if (typeof ctrl.renderSimToDom === "function") {
        ctrl.renderSimToDom();
      }
      if (typeof ctrl.scheduleFrame === "function") {
        ctrl.scheduleFrame();
      }
      return { ok: true };
    })()`;
  }
  const syncBody = `
    const ctrl = window.__agCuaCursorCtrl;
    if (!ctrl || !ctrl.host || !ctrl.host.isConnected) {
      return { ok: true, didPrep: false };
    }
    // Always hide active-tab viewport border & Take Over pill during screenshots!
    if (ctrl.sessionChrome) {
      ctrl.sessionChrome.style.display = "none";
    }
    if (!ctrl.visible) {
      void ctrl.host.offsetWidth;
      return { ok: true, didPrep: false, hidSessionChrome: true };
    }
    if (typeof ctrl.cancelScheduledFrame === "function") {
      ctrl.cancelScheduledFrame();
    }
    ctrl.host.style.display = "";
    ctrl.layer.classList.add("visible");
    ctrl.layer.style.opacity = "1";
    if (ctrl.x != null && ctrl.y != null) {
      if (ctrl.sim) {
        ctrl.sim.motion = null;
        ctrl.sim.mode = "idle";
        ctrl.sim.point = { x: ctrl.x, y: ctrl.y };
        ctrl.sim.rotation = 316;
        ctrl.sim.positionXSpring.value = ctrl.x;
        ctrl.sim.positionXSpring.target = ctrl.x;
        ctrl.sim.positionXSpring.velocity = 0;
        ctrl.sim.positionXSpring.force = 0;
        ctrl.sim.positionYSpring.value = ctrl.y;
        ctrl.sim.positionYSpring.target = ctrl.y;
        ctrl.sim.positionYSpring.velocity = 0;
        ctrl.sim.positionYSpring.force = 0;
        ctrl.sim.rotationSpring.value = 316;
        ctrl.sim.rotationSpring.target = 316;
        ctrl.sim.rotationSpring.velocity = 0;
        ctrl.sim.rotationSpring.force = 0;
        ctrl.sim.scootRotationSpring.value = 0;
        ctrl.sim.scootRotationSpring.target = 0;
        ctrl.sim.scootStretchSpring.value = 1;
        ctrl.sim.scootStretchSpring.target = 1;
        ctrl.sim.stretchSpring.value = 1;
        ctrl.sim.stretchSpring.target = 1;
        ctrl.sim.visibilitySpring.value = 1;
        ctrl.sim.visibilitySpring.target = 1;
      }
      ctrl.cursor.classList.add("instant");
      ctrl.cursor.style.transitionDuration = "0ms";
      ctrl.cursor.style.opacity = "1";
      ctrl.cursor.style.filter = "none";
      ctrl.cursor.style.transform = \`translate3d(\${ctrl.x}px, \${ctrl.y}px, 0)\`;
      const pScale = ctrl.sim ? Math.max(0.7, Math.min(1, ctrl.sim.pressScaleSpring?.value ?? 1)) : 1;
      ctrl.ptrWrap.style.transform = \`rotate(316deg) scale(\${pScale}, \${pScale})\`;
      if (ctrl.glow) {
        ctrl.glow.style.transform = "translate3d(5.2px, 5.4px, 0) scale(1)";
      }
    }
    if (ctrl.highlightedRect) {
      ctrl.highlight.classList.add("instant");
      ctrl.highlight.style.opacity = "1";
    }
    for (const old of ctrl.fxContainer.querySelectorAll(".ag-shot-ripple")) {
      old.remove();
    }
    const nowMs = Date.now();
    const liveRipples = ctrl.fxContainer.querySelectorAll(".ag-ripple");
    const hasRecentRipple =
      (ctrl.lastRipple && nowMs - ctrl.lastRipple.at <= 2500) || liveRipples.length > 0;
    if (hasRecentRipple) {
      for (const ar of liveRipples) {
        ar.style.visibility = "hidden";
      }
      const rx = ctrl.lastRipple?.x ?? ctrl.x ?? 0;
      const ry = ctrl.lastRipple?.y ?? ctrl.y ?? 0;
      const rAccent = ctrl.lastRipple?.accent || ctrl.badgeAccent || "#38bdf8";
      const rCount = Math.max(1, Math.min(3, Number(ctrl.lastRipple?.count) || 1));
      for (let i = 0; i < rCount; i++) {
        const size = 30 + i * 10;
        const ring = document.createElement("div");
        ring.className = "ag-shot-ripple";
        ring.style.left = \`\${rx}px\`;
        ring.style.top = \`\${ry}px\`;
        ring.style.width = \`\${size}px\`;
        ring.style.height = \`\${size}px\`;
        ring.style.border = \`1.6px solid \${rAccent}\`;
        ring.style.boxShadow = "0 0 5px rgba(56, 189, 248, 0.34)";
        ring.style.opacity = i === 0 ? "0.88" : "0.62";
        ctrl.fxContainer.appendChild(ring);
      }
    }
    void ctrl.host.offsetWidth;
  `;
  if (awaitFrame) {
    return `(async () => {
      ${syncBody}
      await new Promise((resolve) => {
        let done = false;
        const finish = () => {
          if (!done) {
            done = true;
            resolve();
          }
        };
        if (typeof requestAnimationFrame === "function") {
          requestAnimationFrame(() => finish());
        }
        setTimeout(finish, 24);
      });
      return { ok: true, didPrep: true };
    })()`;
  }
  return `(() => {
    ${syncBody}
    return { ok: true, didPrep: true };
  })()`;
}

export function buildSetBrowserCursorTemporarilyHiddenExpr(hidden) {
  return `(() => {
    const hide = ${Boolean(hidden)};
    const host = document.getElementById("__ag_cua_cursor_host__");
    if (!host) return { ok: true, wasPresent: false };
    host.style.display = hide ? "none" : "";
    return { ok: true, wasPresent: true };
  })()`;
}

export function buildRemoveBrowserCursorExpr() {
  return `(() => {
    const ctrl = window.__agCuaCursorCtrl;
    if (ctrl) {
      ctrl.destroyed = true;
      if (typeof ctrl.cancelScheduledFrame === "function") ctrl.cancelScheduledFrame();
      if (ctrl.idleTimer) clearTimeout(ctrl.idleTimer);
      if (ctrl.pressTimer) clearTimeout(ctrl.pressTimer);
      delete window.__agCuaCursorCtrl;
    }
    const host = document.getElementById("__ag_cua_cursor_host__");
    if (host) host.remove();
    return { ok: true };
  })()`;
}

export function buildGetBrowserCursorStateExpr() {
  return `(() => {
    const ctrl = window.__agCuaCursorCtrl;
    if (!ctrl || !ctrl.host || !ctrl.host.isConnected) {
      return { visible: false, badge: null, showBadge: false, baseScale: 0.72 };
    }
    return {
      visible: Boolean(ctrl.visible),
      x: ctrl.x != null ? Math.round(ctrl.x) : null,
      y: ctrl.y != null ? Math.round(ctrl.y) : null,
      liveX: ctrl.sim?.point ? Math.round(ctrl.sim.point.x) : (ctrl.x != null ? Math.round(ctrl.x) : null),
      liveY: ctrl.sim?.point ? Math.round(ctrl.sim.point.y) : (ctrl.y != null ? Math.round(ctrl.y) : null),
      mode: ctrl.sim?.mode ?? "idle",
      rotation: ctrl.sim ? Math.round(ctrl.sim.rotation * 10) / 10 : 316,
      pressScale: ctrl.sim?.pressScaleSpring ? Math.round(ctrl.sim.pressScaleSpring.value * 1000) / 1000 : 1,
      baseScale: 0.72,
      sessionChromeActive: Boolean(ctrl.sessionChromeActive),
      takenOver: Boolean(ctrl.takenOver),
      badge: null,
      showBadge: false,
      highlightedRect: ctrl.highlightedRect ?? null
    };
  })()`;
}
