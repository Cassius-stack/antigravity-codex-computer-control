/**
 * Universal Key Chord Parser for both macOS native apps and CDP Browser Input.dispatchKeyEvent.
 * Supports xdotool / X11 keysym / Playwright / macOS syntax:
 * Examples: "a", "Return", "Tab", "Escape", "super+c", "Control_L+Shift_L+period", "cmd+a", "KP_0", "Up".
 */

const SPECIAL_CDP_KEYS = {
  return: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
  enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
  kp_enter: { key: "Enter", code: "NumpadEnter", windowsVirtualKeyCode: 13, text: "\r", location: 3 },
  tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
  escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  esc: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
  delete: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
  forwarddelete: { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 },
  space: { key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " " },
  " ": { key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " " },
  up: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
  arrowup: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
  down: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
  left: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
  right: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
  home: { key: "Home", code: "Home", windowsVirtualKeyCode: 36 },
  end: { key: "End", code: "End", windowsVirtualKeyCode: 35 },
  pageup: { key: "PageUp", code: "PageUp", windowsVirtualKeyCode: 33 },
  page_up: { key: "PageUp", code: "PageUp", windowsVirtualKeyCode: 33 },
  prior: { key: "PageUp", code: "PageUp", windowsVirtualKeyCode: 33 },
  pagedown: { key: "PageDown", code: "PageDown", windowsVirtualKeyCode: 34 },
  page_down: { key: "PageDown", code: "PageDown", windowsVirtualKeyCode: 34 },
  next: { key: "PageDown", code: "PageDown", windowsVirtualKeyCode: 34 },
  period: { key: ".", code: "Period", windowsVirtualKeyCode: 190, text: "." },
  ".": { key: ".", code: "Period", windowsVirtualKeyCode: 190, text: "." },
  greater: { key: ">", code: "Period", windowsVirtualKeyCode: 190, text: ">", shift: true },
  ">": { key: ">", code: "Period", windowsVirtualKeyCode: 190, text: ">", shift: true },
  comma: { key: ",", code: "Comma", windowsVirtualKeyCode: 188, text: "," },
  ",": { key: ",", code: "Comma", windowsVirtualKeyCode: 188, text: "," },
  less: { key: "<", code: "Comma", windowsVirtualKeyCode: 188, text: "<", shift: true },
  "<": { key: "<", code: "Comma", windowsVirtualKeyCode: 188, text: "<", shift: true },
  slash: { key: "/", code: "Slash", windowsVirtualKeyCode: 191, text: "/" },
  "/": { key: "/", code: "Slash", windowsVirtualKeyCode: 191, text: "/" },
  minus: { key: "-", code: "Minus", windowsVirtualKeyCode: 189, text: "-" },
  "-": { key: "-", code: "Minus", windowsVirtualKeyCode: 189, text: "-" },
  equal: { key: "=", code: "Equal", windowsVirtualKeyCode: 187, text: "=" },
  "=": { key: "=", code: "Equal", windowsVirtualKeyCode: 187, text: "=" },
  plus: { key: "+", code: "Equal", windowsVirtualKeyCode: 187, text: "+", shift: true },
  semicolon: { key: ";", code: "Semicolon", windowsVirtualKeyCode: 186, text: ";" },
  ";": { key: ";", code: "Semicolon", windowsVirtualKeyCode: 186, text: ";" },
  apostrophe: { key: "'", code: "Quote", windowsVirtualKeyCode: 222, text: "'" },
  "'": { key: "'", code: "Quote", windowsVirtualKeyCode: 222, text: "'" },
  bracketleft: { key: "[", code: "BracketLeft", windowsVirtualKeyCode: 219, text: "[" },
  "[": { key: "[", code: "BracketLeft", windowsVirtualKeyCode: 219, text: "[" },
  bracketright: { key: "]", code: "BracketRight", windowsVirtualKeyCode: 221, text: "]" },
  "]": { key: "]", code: "BracketRight", windowsVirtualKeyCode: 221, text: "]" },
  backslash: { key: "\\", code: "Backslash", windowsVirtualKeyCode: 220, text: "\\" },
  "\\": { key: "\\", code: "Backslash", windowsVirtualKeyCode: 220, text: "\\" },
  bar: { key: "|", code: "Backslash", windowsVirtualKeyCode: 220, text: "|", shift: true },
  "|": { key: "|", code: "Backslash", windowsVirtualKeyCode: 220, text: "|", shift: true },
  grave: { key: "`", code: "Backquote", windowsVirtualKeyCode: 192, text: "`" },
  "`": { key: "`", code: "Backquote", windowsVirtualKeyCode: 192, text: "`" },
  asciitilde: { key: "~", code: "Backquote", windowsVirtualKeyCode: 192, text: "~", shift: true },
  "~": { key: "~", code: "Backquote", windowsVirtualKeyCode: 192, text: "~", shift: true },
  underscore: { key: "_", code: "Minus", windowsVirtualKeyCode: 189, text: "_", shift: true },
  "_": { key: "_", code: "Minus", windowsVirtualKeyCode: 189, text: "_", shift: true },
  colon: { key: ":", code: "Semicolon", windowsVirtualKeyCode: 186, text: ":", shift: true },
  ":": { key: ":", code: "Semicolon", windowsVirtualKeyCode: 186, text: ":", shift: true },
  quotedbl: { key: '"', code: "Quote", windowsVirtualKeyCode: 222, text: '"', shift: true },
  '"': { key: '"', code: "Quote", windowsVirtualKeyCode: 222, text: '"', shift: true },
  braceleft: { key: "{", code: "BracketLeft", windowsVirtualKeyCode: 219, text: "{", shift: true },
  "{": { key: "{", code: "BracketLeft", windowsVirtualKeyCode: 219, text: "{", shift: true },
  braceright: { key: "}", code: "BracketRight", windowsVirtualKeyCode: 221, text: "}", shift: true },
  "}": { key: "}", code: "BracketRight", windowsVirtualKeyCode: 221, text: "}", shift: true },
  question: { key: "?", code: "Slash", windowsVirtualKeyCode: 191, text: "?", shift: true },
  "?": { key: "?", code: "Slash", windowsVirtualKeyCode: 191, text: "?", shift: true },
  "!": { key: "!", code: "Digit1", windowsVirtualKeyCode: 49, text: "!", shift: true },
  exclam: { key: "!", code: "Digit1", windowsVirtualKeyCode: 49, text: "!", shift: true },
  "@": { key: "@", code: "Digit2", windowsVirtualKeyCode: 50, text: "@", shift: true },
  at: { key: "@", code: "Digit2", windowsVirtualKeyCode: 50, text: "@", shift: true },
  "#": { key: "#", code: "Digit3", windowsVirtualKeyCode: 51, text: "#", shift: true },
  numbersign: { key: "#", code: "Digit3", windowsVirtualKeyCode: 51, text: "#", shift: true },
  "$": { key: "$", code: "Digit4", windowsVirtualKeyCode: 52, text: "$", shift: true },
  dollar: { key: "$", code: "Digit4", windowsVirtualKeyCode: 52, text: "$", shift: true },
  "%": { key: "%", code: "Digit5", windowsVirtualKeyCode: 53, text: "%", shift: true },
  percent: { key: "%", code: "Digit5", windowsVirtualKeyCode: 53, text: "%", shift: true },
  "^": { key: "^", code: "Digit6", windowsVirtualKeyCode: 54, text: "^", shift: true },
  asciicircum: { key: "^", code: "Digit6", windowsVirtualKeyCode: 54, text: "^", shift: true },
  "&": { key: "&", code: "Digit7", windowsVirtualKeyCode: 55, text: "&", shift: true },
  ampersand: { key: "&", code: "Digit7", windowsVirtualKeyCode: 55, text: "&", shift: true },
  "*": { key: "*", code: "Digit8", windowsVirtualKeyCode: 56, text: "*", shift: true },
  asterisk: { key: "*", code: "Digit8", windowsVirtualKeyCode: 56, text: "*", shift: true },
  "(": { key: "(", code: "Digit9", windowsVirtualKeyCode: 57, text: "(", shift: true },
  parenleft: { key: "(", code: "Digit9", windowsVirtualKeyCode: 57, text: "(", shift: true },
  ")": { key: ")", code: "Digit0", windowsVirtualKeyCode: 48, text: ")", shift: true },
  parenright: { key: ")", code: "Digit0", windowsVirtualKeyCode: 48, text: ")", shift: true },
  "+": { key: "+", code: "Equal", windowsVirtualKeyCode: 187, text: "+", shift: true },
};

const SHIFTED_PUNCTUATION_KEY = {
  ".": ">",
  ",": "<",
  "/": "?",
  ";": ":",
  "'": '"',
  "[": "{",
  "]": "}",
  "\\": "|",
  "`": "~",
  "-": "_",
  "=": "+",
};

for (let i = 1; i <= 12; i++) {
  SPECIAL_CDP_KEYS[`f${i}`] = {
    key: `F${i}`,
    code: `F${i}`,
    windowsVirtualKeyCode: 111 + i,
  };
}

for (let d = 0; d <= 9; d++) {
  const entry = {
    key: String(d),
    code: `Numpad${d}`,
    windowsVirtualKeyCode: 96 + d,
    text: String(d),
    location: 3,
  };
  SPECIAL_CDP_KEYS[`kp_${d}`] = entry;
  SPECIAL_CDP_KEYS[`numpad_${d}`] = entry;
}

const MODIFIER_ALIASES = {
  alt: "alt",
  alt_l: "alt",
  alt_r: "alt",
  option: "alt",
  option_l: "alt",
  option_r: "alt",
  ctrl: "ctrl",
  control: "ctrl",
  control_l: "ctrl",
  control_r: "ctrl",
  meta: "meta",
  meta_l: "meta",
  meta_r: "meta",
  super: "meta",
  super_l: "meta",
  super_r: "meta",
  cmd: "meta",
  command: "meta",
  gui: "meta",
  shift: "shift",
  shift_l: "shift",
  shift_r: "shift",
};

// CDP modifier bitmask: Alt=1, Ctrl=2, Meta/Command=4, Shift=8
export const CDP_MODIFIER_BITS = {
  alt: 1,
  ctrl: 2,
  meta: 4,
  shift: 8,
};

/**
 * Parse a key chord string into CDP Input.dispatchKeyEvent parameters.
 * @param {string} chord
 */
export function parseCDPKeyChord(chord) {
  if (typeof chord !== "string" || chord.trim() === "") {
    throw new TypeError("Key chord must be a non-empty string");
  }

  // Special case: literal "+" alone
  const rawParts =
    chord.trim() === "+"
      ? ["plus"]
      : chord
          .split("+")
          .map((t) => t.trim())
          .filter(Boolean);

  if (rawParts.length === 0) {
    throw new TypeError(`Invalid key chord: "${chord}"`);
  }

  const mods = new Set();
  let mainToken = null;

  for (const tok of rawParts) {
    const low = tok.toLowerCase();
    if (MODIFIER_ALIASES[low]) {
      mods.add(MODIFIER_ALIASES[low]);
    } else {
      if (mainToken !== null) {
        throw new TypeError(`Key chord "${chord}" specifies multiple non-modifier keys ("${mainToken}" and "${tok}")`);
      }
      mainToken = tok;
    }
  }

  let keySpec;
  if (mainToken === null) {
    // Modifier-only press (e.g. "shift")
    if (mods.has("shift")) keySpec = { key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16 };
    else if (mods.has("meta")) keySpec = { key: "Meta", code: "MetaLeft", windowsVirtualKeyCode: 91 };
    else if (mods.has("ctrl")) keySpec = { key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17 };
    else if (mods.has("alt")) keySpec = { key: "Alt", code: "AltLeft", windowsVirtualKeyCode: 18 };
  } else {
    const low = mainToken.toLowerCase();
    if (SPECIAL_CDP_KEYS[low]) {
      keySpec = { ...SPECIAL_CDP_KEYS[low] };
      if (keySpec.shift) mods.add("shift");
      if (mods.has("shift") && SHIFTED_PUNCTUATION_KEY[keySpec.key]) {
        keySpec.key = SHIFTED_PUNCTUATION_KEY[keySpec.key];
        keySpec.text = keySpec.key;
      }
    } else if (mainToken.length === 1) {
      const ch = mainToken;
      const upper = ch.toUpperCase();
      const isAlpha = ch >= "a" && ch <= "z" || ch >= "A" && ch <= "Z";
      const isDigit = ch >= "0" && ch <= "9";
      if (isAlpha && ch === upper) {
        mods.add("shift");
      }
      const vk = isAlpha ? upper.charCodeAt(0) : isDigit ? ch.charCodeAt(0) : ch.charCodeAt(0);
      const code = isAlpha ? `Key${upper}` : isDigit ? `Digit${ch}` : "";
      const outChar = mods.has("shift") && isAlpha ? upper : ch;
      keySpec = {
        key: outChar,
        code,
        windowsVirtualKeyCode: vk,
        text: mods.has("ctrl") || mods.has("meta") || mods.has("alt") ? undefined : outChar,
      };
    } else {
      throw new TypeError(`Unsupported key "${mainToken}" in chord "${chord}"`);
    }
  }

  let modifiers = 0;
  for (const m of mods) {
    modifiers |= CDP_MODIFIER_BITS[m] ?? 0;
  }

  // Commands like cmd+a, cmd+c, cmd+v on macOS Chromium need `commands` in CDP when headless/background
  const commands = [];
  if (mods.has("meta") && !mods.has("ctrl") && !mods.has("alt") && mainToken) {
    const k = mainToken.toLowerCase();
    if (k === "a" && !mods.has("shift")) commands.push("selectAll");
    else if (k === "c" && !mods.has("shift")) commands.push("copy");
    else if (k === "v" && !mods.has("shift")) commands.push("paste");
    else if (k === "x" && !mods.has("shift")) commands.push("cut");
    else if (k === "z" && !mods.has("shift")) commands.push("undo");
    else if (k === "z" && mods.has("shift")) commands.push("redo");
  }

  return {
    key: keySpec.key,
    code: keySpec.code,
    windowsVirtualKeyCode: keySpec.windowsVirtualKeyCode,
    nativeVirtualKeyCode: keySpec.windowsVirtualKeyCode,
    location: keySpec.location,
    text: mods.has("ctrl") || mods.has("meta") ? undefined : keySpec.text,
    modifiers,
    mods: Array.from(mods),
    commands: commands.length > 0 ? commands : undefined,
  };
}
