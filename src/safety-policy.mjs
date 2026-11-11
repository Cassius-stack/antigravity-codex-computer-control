/**
 * Browser Safety Policy & Anti-Bot / CAPTCHA Handoff Detector (`src/safety-policy.mjs`)
 *
 * Enforces two core guardrails:
 * 1. Blocks navigation to sensitive credential/password manager internal pages and sensitive system files.
 * 2. Detects anti-bot / CAPTCHA gates (Cloudflare Turnstile, Google reCAPTCHA, hCaptcha, Altcha) in AX snapshots
 *    and appends an explicit handoff directive so agents NEVER attempt to solve or bypass challenges.
 */

export const CAPTCHA_HANDOFF_BANNER =
  "[HANDOFF REQUIRED: Anti-bot/CAPTCHA challenge detected — do not attempt to solve; call mark_tab status='handoff' and ask the user]";

const BLOCKED_INTERNAL_URL_PATTERNS = [
  {
    pattern: /^(?:chrome|brave|edge|arc|vivaldi|opera):\/\/(?:settings\/passwords|password-manager|settings\/autofill|settings\/payments)/i,
    reason: "Browser password manager & payment autofill settings are blocked by safety policy.",
  },
  {
    pattern: /^chrome:\/\/inspect\b/i,
    reason: "Internal debugger inspection pages are blocked by safety policy.",
  },
];

const BLOCKED_FILE_PATH_PATTERNS = [
  /^\/etc\/(?:passwd|master\.passwd|shadow|sudoers|ssh\/)/i,
  /^\/(?:private\/)?var\/db\//i,
  /\/\.ssh\/(?:id_[a-z0-9_]+|authorized_keys|config)/i,
  /\/\.aws\/credentials/i,
  /\/\.gnupg\//i,
  /\/Library\/Keychains\//i,
  /\/Cookies(?:-journal)?$/i,
  /\/Login Data(?:-journal)?$/i,
];

/**
 * Validate whether a target URL is safe for automated agent navigation.
 * @param {string} rawUrl
 * @returns {{ safe: boolean, reason?: string }}
 */
export function checkBrowserUrlSafety(rawUrl) {
  const trimmed = String(rawUrl ?? "").trim();
  if (!trimmed || trimmed === "about:blank") {
    return { safe: true };
  }

  for (const rule of BLOCKED_INTERNAL_URL_PATTERNS) {
    if (rule.pattern.test(trimmed)) {
      return { safe: false, reason: rule.reason };
    }
  }

  if (/^file:/i.test(trimmed)) {
    let decodedPath = "";
    try {
      const u = new URL(trimmed);
      decodedPath = decodeURIComponent(u.pathname || "");
    } catch {
      decodedPath = trimmed.replace(/^file:\/\//i, "");
    }
    if (
      /^\/(?:private\/)?etc\//i.test(decodedPath) ||
      BLOCKED_FILE_PATH_PATTERNS.some((rx) => rx.test(decodedPath))
    ) {
      return {
        safe: false,
        reason: `Sensitive local filesystem URL blocked by safety policy: ${trimmed}`,
      };
    }
  }

  return { safe: true };
}

/**
 * Throw an explicit error if `rawUrl` violates browser safety policy.
 * @param {string} rawUrl
 */
export function assertSafeBrowserUrl(rawUrl) {
  const res = checkBrowserUrlSafety(rawUrl);
  if (!res.safe) {
    throw new Error(`Blocked unsafe URL (${rawUrl}): ${res.reason}`);
  }
}

/**
 * Detect whether a page snapshot exhibits an active anti-bot / CAPTCHA challenge.
 * @param {{
 *   url?: string,
 *   title?: string,
 *   lines?: string[],
 *   captchaSignals?: string[]
 * }} snap
 * @returns {{ detected: boolean, providers: string[], banner: string | null }}
 */
export function detectCaptchaChallenge(snap = {}) {
  const providers = new Set(Array.isArray(snap.captchaSignals) ? snap.captchaSignals : []);
  const url = String(snap.url || "");
  const title = String(snap.title || "");
  const joinedLines = Array.isArray(snap.lines) ? snap.lines.slice(0, 120).join("\n") : "";

  if (/challenges\.cloudflare\.com|\/cdn-cgi\/challenge-platform\//i.test(url)) {
    providers.add("cloudflare-turnstile");
  }
  if (/^Just a moment\.{3}$|^Attention Required! \| Cloudflare/i.test(title.trim())) {
    if (/verify you are human|checking if the site connection is secure|cloudflare/i.test(joinedLines) || url) {
      providers.add("cloudflare-turnstile");
    }
  }
  if (/verify you are human|complete the security check to access/i.test(joinedLines) && /cloudflare|turnstile/i.test(joinedLines)) {
    providers.add("cloudflare-turnstile");
  }
  if (/google\.com\/recaptcha|recaptcha\.net\/recaptcha/i.test(url) || /\breCAPTCHA\b/i.test(joinedLines) && /I'm not a robot/i.test(joinedLines)) {
    providers.add("recaptcha");
  }
  if (/hcaptcha\.com/i.test(url) || /\bhCaptcha\b/i.test(joinedLines) && /I am human/i.test(joinedLines)) {
    providers.add("hcaptcha");
  }

  const detected = providers.size > 0;
  return {
    detected,
    providers: Array.from(providers),
    banner: detected ? CAPTCHA_HANDOFF_BANNER : null,
  };
}
