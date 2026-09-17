// Reads a Claude Code terminal screen (plain text from host.sessions.capture)
// into what the tab needs: the permission mode, what Claude is doing, and any
// prompt waiting on the user, with its options.
//
// Layouts verified against captures from Claude Code 2.1.273 (the fixtures in
// src/fixtures). The shapes this relies on:
//
//   ────────────────────────────── (rule)      top of a prompt block
//    Bash command                               title
//      date > when.txt && cat when.txt          body
//    Do you want to proceed?                    question
//    ❯ 1. Yes                                   numbered options, ❯ = cursor,
//      2. Yes, and always allow access to …     wrapped text continues
//         dc76-… from this project              indented below its row
//      4. No
//    Esc to cancel · Tab to amend               footer
//
// The folder trust prompt is the one unnumbered list (❯ on one row, the others
// aligned with its text). AskUserQuestion adds a tab strip and [ ]/[✔] boxes,
// and its review screen has no footer at all. The plan approval prompt keeps
// the plan itself in the block above its rule, between ╌ lines.
//
// Anything with a footer but no readable options, or no input box and no
// prompt at all, is reported as unmodeled so the tab can show the raw screen.

// A full-width rule, which may carry a label at its right end (the session
// name Claude Code shows above the input box: "──── add-readme ─").
const RULE_RE = /^\s*[─━]{8,}(?:\s+\S.*\s+[─━]{1,3})?\s*$/;
const DASHED_RE = /^\s*╌{8,}\s*$/;
const FOOTER_RE =
  /(Esc to (cancel|clear|exit|close|go back)|Enter to (confirm|select|set|continue)|ctrl\+g to edit|to navigate)/;
// A numbered row: an optional cursor (❯) or scroll marker (↑/↓ on the first
// or last visible row of a list taller than the screen), the number, the text.
const NUMBERED_RE = /^(\s*)(❯)?(\s*)(?:[↑↓]\s+)?(\d+)\.\s+(.*)$/;
const CURSOR_RE = /^(\s*)❯\s+(\S.*)$/;
const CHECKBOX_RE = /^\[([ ✔✓x×])\]\s+(.*)$/;
const MODE_RE = /[⏵⏸]+\s+(.+?)\s+on\b/;
// ✻ ✶ ✳ ✢ · * ✽ are the spinner's frames; ● is an assistant message bullet
// and must never count.
const SPINNER = "[✻✶✳✢·*✽]";
const WORKING_RE = new RegExp(`^${SPINNER}\\s+([^\\s(][^(]*?)…\\s*(?:\\((.*)\\))?\\s*$`);
const DONE_RE = new RegExp(`^${SPINNER}\\s+(\\S+)\\s+for\\s+(.+?)(?:\\s+·\\s+(.*))?\\s*$`);

function lead(line) {
  return line.length - line.trimStart().length;
}

function isBlank(line) {
  return line.trim() === "";
}

// SGR escapes, as host.sessions.capture({ styles: true }) keeps them.
const SGR_RE = /\x1b\[[0-9;]*m/g;

export function stripStyles(text) {
  return String(text ?? "").replace(SGR_RE, "");
}

// A styled row as code points, each marked with whether it is highlighted: a
// background color or inverse video in effect, which is how a TUI marks the
// current item. Escapes apply cumulatively, as a terminal applies them: the
// daemon resets before every change, tmux sets one attribute at a time and
// clears with 49 and 27.
function styledChars(line) {
  const chars = [];
  let background = false;
  let inverse = false;
  let at = 0;
  const apply = (params) => {
    const p = params === "" ? [0] : params.split(";").map(Number);
    for (let i = 0; i < p.length; i++) {
      const n = p[i];
      if (n === 0) background = inverse = false;
      else if (n === 7) inverse = true;
      else if (n === 27) inverse = false;
      else if ((n >= 40 && n <= 47) || (n >= 100 && n <= 107)) background = true;
      else if (n === 49) background = false;
      else if (n === 38 || n === 48) {
        if (n === 48) background = true;
        i += p[i + 1] === 2 ? 4 : 2;
      }
    }
  };
  for (const m of line.matchAll(SGR_RE)) {
    for (const ch of line.slice(at, m.index)) chars.push({ ch, lit: background || inverse });
    apply(m[0].slice(2, -1));
    at = m.index + m[0].length;
  }
  for (const ch of line.slice(at)) chars.push({ ch, lit: background || inverse });
  return chars;
}

// AskUserQuestion's active tab, which the terminal tells apart by color alone:
// the one tab whose label is highlighted. Null without styles or when that
// isn't exactly one tab.
export function activeTabIn(styledLine, tabs) {
  if (!styledLine || !tabs || !styledLine.includes("\x1b[")) return null;
  const chars = styledChars(styledLine);
  const plain = chars.map((c) => c.ch);
  let from = 0;
  const lit = [];
  tabs.forEach((tab, i) => {
    const label = [...tab.label];
    for (let at = from; at + label.length <= plain.length; at++) {
      if (label.every((ch, k) => plain[at + k] === ch)) {
        if (chars[at].lit) lit.push(i);
        from = at + label.length;
        return;
      }
    }
  });
  return lit.length === 1 ? lit[0] : null;
}

export function toLines(text) {
  const lines = String(text ?? "")
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""));
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

// ---- mode ------------------------------------------------------------------

const MODE_IDS = {
  auto: "auto",
  "auto mode": "auto",
  manual: "manual",
  "manual mode": "manual",
  "accept edits": "acceptEdits",
  "plan mode": "plan",
  plan: "plan",
  "bypass permissions": "bypassPermissions",
  "bypassing permissions": "bypassPermissions",
};

// The footer's "⏸ manual mode on" / "⏵⏵ accept edits on", from the bottom
// lines. Unknown wording keeps its own label with id "other".
export function parseModeFooter(lines) {
  const tail = lines.slice(-8);
  for (let i = tail.length - 1; i >= 0; i--) {
    const m = MODE_RE.exec(tail[i]);
    if (!m) continue;
    const raw = m[1].trim().toLowerCase();
    const id = MODE_IDS[raw] ?? "other";
    const label = raw.replace(/\s+mode$/, "");
    return { id, label };
  }
  return null;
}

// ---- input box and activity --------------------------------------------------

// The input box: a ❯ line directly under the second-to-last rule, closed by
// the last rule. Null while a prompt has replaced it.
export function findInputBox(lines) {
  const rules = [];
  for (let i = 0; i < lines.length; i++) if (RULE_RE.test(lines[i])) rules.push(i);
  for (let r = rules.length - 1; r >= 1; r--) {
    const top = rules[r - 1];
    const bottom = rules[r];
    if (bottom - top < 2) continue;
    if (!/^❯(\s|$)/.test(lines[top + 1])) continue;
    // Only the box at the bottom of the screen counts, not one scrolled up.
    const below = lines.slice(bottom + 1).filter((l) => !isBlank(l));
    if (below.length > 6) return null;
    const text = lines
      .slice(top + 1, bottom)
      .map((l, i) => (i === 0 ? l.replace(/^❯\s?/, "") : l.replace(/^\s{2}/, "")))
      .join("\n")
      .trim();
    return { top, bottom, text };
  }
  return null;
}

// What the spinner line just above the input box says. `working` with its
// label and whatever the parenthesis holds, or `idle` with the "Worked for"
// summary, or null when neither is on screen.
export function parseActivity(lines, inputTop) {
  const end = inputTop ?? lines.length;
  let seen = 0;
  for (let i = end - 1; i >= 0 && seen < 4; i--) {
    const line = lines[i];
    if (isBlank(line)) continue;
    seen++;
    const text = line.trim();
    const done = DONE_RE.exec(text);
    if (done && !text.includes("…")) {
      return { state: "idle", verb: done[1], elapsed: done[2], note: done[3] ?? null };
    }
    const working = WORKING_RE.exec(text);
    if (working) {
      const parts = (working[2] ?? "").split(/\s+·\s+/).map((p) => p.trim()).filter(Boolean);
      let elapsed = null;
      let tokens = null;
      const notes = [];
      for (const part of parts) {
        const tok = /^[↓↑]\s*([\d.,]+k?)\s+tokens?$/.exec(part);
        if (tok) tokens = tok[1];
        else if (/^\d+[smh](\s+\d+[sm])?$/.test(part)) elapsed = part;
        else notes.push(part);
      }
      return { state: "working", label: working[1].trim(), elapsed, tokens, note: notes.join(" · ") || null };
    }
  }
  return null;
}

// ---- prompts ---------------------------------------------------------------

function findFooter(lines) {
  let checked = 0;
  for (let i = lines.length - 1; i >= 0 && checked < 6; i--) {
    if (isBlank(lines[i])) continue;
    checked++;
    if (FOOTER_RE.test(lines[i]) && !MODE_RE.test(lines[i])) return i;
  }
  return -1;
}

function topRuleAbove(lines, index) {
  for (let i = index; i >= 0; i--) if (RULE_RE.test(lines[i])) return i;
  return -1;
}

function cleanOption(text) {
  let label = text.trim();
  let checked = null;
  const box = CHECKBOX_RE.exec(label);
  if (box) {
    checked = box[1] !== " ";
    label = box[2].trim();
  }
  return { label, checked };
}

// Numbered options above the footer. Walks up from the footer taking rows
// numbered n, n-1, ... 1, so numbered lines in the prompt's own body (a plan's
// "1. Create README") are never mistaken for options.
// The terminal's width, from the longest horizontal rule (rules span the full
// width). A row that fills it was wrapped by the terminal, possibly mid-word.
function screenWidth(lines) {
  let width = 0;
  for (const l of lines) if (RULE_RE.test(l)) width = Math.max(width, [...l].length);
  return width;
}

function readNumbered(lines, footerIdx) {
  const width = screenWidth(lines);
  const rows = [];
  let expect = null;
  let gap = 0;
  for (let i = footerIdx - 1; i >= 0; i--) {
    const m = NUMBERED_RE.exec(lines[i]);
    if (m && (expect === null || Number(m[4]) === expect)) {
      const n = Number(m[4]);
      const textCol = lines[i].length - m[5].length;
      rows.unshift({ index: i, n, cursor: m[2] === "❯", text: m[5], textCol });
      expect = n - 1;
      gap = 0;
      if (n === 1) break;
      continue;
    }
    // Continuation and description lines and a rule may sit between rows;
    // anything longer than that is not an option list. Blank lines don't
    // count: a preview box lifted off the screen leaves a run of them.
    if (!isBlank(lines[i]) && ++gap > 8) break;
  }
  if (rows.length === 0) return null;
  // A multi-select AskUserQuestion ends its list with an unnumbered button
  // row ("Next", or "Submit" on the last question), reached with Tab.
  let action = null;
  const options = rows.map((row, k) => {
    const nextIndex = k + 1 < rows.length ? rows[k + 1].index : footerIdx;
    const { label, checked } = cleanOption(row.text);
    let full = label;
    let prevFull = width > 0 && [...lines[row.index]].length >= width;
    const description = [];
    for (let j = row.index + 1; j < nextIndex; j++) {
      const l = lines[j];
      if (isBlank(l) || RULE_RE.test(l)) continue;
      const t = l.trim();
      // Scroll hints of a list taller than the screen ("… +1 model",
      // "↓ 3 more below") are not part of any option.
      if (/^(…\s*\+\d+|[↑↓]\s*\d+\s+more)/.test(t)) continue;
      const button = /^(❯\s+)?(Next|Submit)$/.exec(t);
      if (button) {
        action = { label: button[2], cursor: Boolean(button[1]) };
        continue;
      }
      const hardWrap = prevFull;
      prevFull = width > 0 && [...l].length >= width;
      const continues =
        description.length === 0 &&
        lead(l) >= row.textCol &&
        !/[.?!:]$/.test(full) &&
        /^[a-z0-9(/~.\-]/.test(t) &&
        !/^(shift\+tab|ctrl\+)/.test(t);
      if (continues) full = full.endsWith("-") || hardWrap ? full + t : `${full} ${t}`;
      else description.push(t);
    }
    // Column-aligned pickers (/model) put the description on the row itself,
    // after a run of spaces; a ✔ after the name marks the current choice.
    const columns = /^(.*?\S)\s{2,}(\S.*)$/.exec(full);
    if (columns) {
      full = columns[1];
      description.unshift(columns[2]);
    }
    const current = /\s✔$/.test(full);
    if (current) full = full.replace(/\s✔$/, "");
    return { n: row.n, label: full, description: description.join(" ") || null, cursor: row.cursor, checked, current };
  });
  return { options, top: rows[0].index, numbered: true, action };
}

// The option that is a text field in the terminal: AskUserQuestion's "Type
// something" (the row just above "Chat about this") and a plan's "Tell Claude
// what to change" (its last row). With the cursor on it, keys type into it,
// digits included, and what is typed replaces its label on screen. So it is
// found by position, keeps its placeholder as its label (and in the
// signature), and carries the typed text separately.
const TEXT_PLACEHOLDER = { question: "Type something", plan: "Tell Claude what to change" };

function markTextEntry(kind, options) {
  let entry = null;
  if (kind === "question") {
    const chat = options.find((o) => /^Chat about this$/i.test(o.label));
    entry = chat ? options.find((o) => o.n === chat.n - 1) : options.find((o) => /^Type something/i.test(o.label));
  } else if (kind === "plan") {
    entry = options[options.length - 1];
  }
  if (!entry || entry.n === 1) return;
  const placeholder = TEXT_PLACEHOLDER[kind];
  const typed = entry.label.toLowerCase().startsWith(placeholder.toLowerCase()) ? "" : entry.label;
  if (typed) {
    // A long answer wraps into what the reader took as a description.
    entry.label = placeholder;
    entry.description = entry.description && kind === "question" ? null : entry.description;
  }
  entry.textEntry = true;
  entry.typed = typed;
}

// The trust prompt's shape: one ❯ row, sibling rows aligned with its text,
// no numbers.
function readUnnumbered(lines, footerIdx) {
  let cursorIdx = -1;
  let col = 0;
  for (let i = footerIdx - 1; i >= Math.max(0, footerIdx - 12); i--) {
    const m = CURSOR_RE.exec(lines[i]);
    if (m && !NUMBERED_RE.test(lines[i])) {
      cursorIdx = i;
      col = m[1].length + 2;
      break;
    }
  }
  if (cursorIdx === -1) return null;
  const sameColumn = (l) => !isBlank(l) && !RULE_RE.test(l) && lead(l) === col && !/^\s*❯/.test(l);
  let top = cursorIdx;
  while (top - 1 >= 0 && sameColumn(lines[top - 1])) top--;
  let bottom = cursorIdx;
  while (bottom + 1 < footerIdx && sameColumn(lines[bottom + 1])) bottom++;
  const options = [];
  for (let i = top; i <= bottom; i++) {
    const text = i === cursorIdx ? CURSOR_RE.exec(lines[i])[2] : lines[i].trim();
    options.push({ n: options.length + 1, label: text, description: null, cursor: i === cursorIdx, checked: null, current: false });
  }
  return { options, top, numbered: false };
}

function parseTabs(line) {
  if (!/[☐☒✔]/.test(line) || !/Submit/.test(line)) return null;
  const tabs = [];
  const re = /([☐☒✔])\s+(.+?)(?=\s{2,}[☐☒✔→]|\s*→|$)/g;
  let m;
  while ((m = re.exec(line.replace(/^\s*←\s*/, "")))) {
    tabs.push({ label: m[2].trim(), done: m[1] !== "☐", submit: m[2].trim() === "Submit" });
  }
  return tabs.length > 0 ? tabs : null;
}

// Plan text: the ╌-fenced block above the prompt's rule.
function planBodyAbove(lines, ruleIdx) {
  let end = -1;
  let start = -1;
  for (let i = ruleIdx - 1; i >= 0; i--) {
    if (DASHED_RE.test(lines[i])) {
      if (end === -1) end = i;
      else {
        start = i;
        break;
      }
    } else if (end === -1 && !isBlank(lines[i])) {
      return null;
    }
  }
  if (end === -1) return null;
  const body = lines.slice(start + 1, end);
  const text = body.map((l) => l.replace(/^ /, "")).join("\n").replace(/^\n+|\n+$/g, "");
  return { text, truncated: start === -1 };
}

function readReview(lines) {
  const readyIdx = lines.findIndex((l) => /Ready to submit your answers\?/.test(l));
  if (readyIdx === -1) return null;
  const numbered = [];
  for (let i = readyIdx + 1; i < lines.length; i++) {
    const m = NUMBERED_RE.exec(lines[i]);
    if (m) numbered.push({ n: Number(m[4]), label: m[5].trim(), description: null, cursor: m[2] === "❯", checked: null, current: false });
  }
  if (!numbered.some((o) => /Submit answers/.test(o.label))) return null;
  const reviewIdx = lines.findLastIndex((l, i) => i < readyIdx && /Review your answers/.test(l));
  const answers = [];
  for (let i = reviewIdx + 1; i < readyIdx; i++) {
    const q = /^\s*●\s+(.*)$/.exec(lines[i]);
    if (q) answers.push({ question: q[1].trim(), answer: "" });
    const a = /^\s*→\s+(.*)$/.exec(lines[i]);
    if (a && answers.length > 0) answers[answers.length - 1].answer = a[1].trim();
  }
  const rule = topRuleAbove(lines, reviewIdx);
  const tabs = rule >= 0 ? parseTabs(lines[rule + 1] ?? "") : null;
  return {
    kind: "question",
    review: true,
    tabRow: tabs ? rule + 1 : null,
    title: "Review your answers",
    question: "Ready to submit your answers?",
    body: [],
    plan: null,
    tabs,
    answers,
    options: numbered,
    numbered: true,
    multiSelect: false,
    footer: null,
    letterKeys: [],
  };
}

// Single-letter keys a picker's footer offers for the highlighted row, such as
// /model's "s to use this session only". Esc, Enter and Tab are words, so they
// never match.
export function parseLetterKeys(footer) {
  const keys = [];
  for (const part of String(footer ?? "").split("·")) {
    const m = /^\s*([a-z])\s+to\s+(.+?)\s*$/i.exec(part);
    if (m) keys.push({ key: m[1].toLowerCase(), label: m[2] });
  }
  return keys;
}

// Why a stable signature: a click is only honored when the screen still shows
// the prompt the user was looking at. Cursor position and checkbox state are
// left out on purpose, since those change as the user answers.
export function promptSignature(prompt) {
  if (!prompt) return "";
  return [prompt.kind, prompt.review ? "review" : "", prompt.title, prompt.question ?? "", ...prompt.options.map((o) => `${o.n}:${o.label}`)].join("");
}

function classify({ footer, title, question, body, options, tabs }) {
  const all = [title, question ?? "", ...body].join("\n");
  const labels = options.map((o) => o.label).join("\n");
  if (/trust this folder/i.test(labels) || /Is this a project you created or one you trust/i.test(all)) return "trust";
  if (/Would you like to proceed\?/.test(all) && /Tell Claude what to change|use auto mode|approve edits/i.test(labels)) return "plan";
  if (/Tab to amend/.test(footer) || /^Do you want to /m.test(question ?? "")) return "permission";
  if (tabs || (/Enter to select/.test(footer) && /Type something|Chat about this/i.test(labels))) return "question";
  return "generic";
}

// AskUserQuestion with previews draws the highlighted option's preview in a
// box to the right of the options, a "Notes:" line under the box, and an
// unnumbered "Chat about this" row. Each is lifted out of the screen (its
// cells blanked, so row numbers stay put) before the options are read, and
// returned on its own.
function extractPreviewLayout(lines, footerIdx) {
  let bottom = -1;
  let col = -1;
  for (let i = footerIdx - 1; i >= 0 && i >= footerIdx - 12; i--) {
    const m = /└─+┘$/.exec(lines[i]);
    if (m) {
      bottom = i;
      col = m.index;
      break;
    }
  }
  if (bottom === -1) return null;
  let top = -1;
  for (let i = bottom - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.indexOf("┌", col) === col && /^┌─+┐$/.test(line.slice(col))) {
      top = i;
      break;
    }
    if (!/^[│├]/.test(line.slice(col))) return null;
  }
  if (top === -1) return null;

  const out = lines.slice();
  const blankFrom = (i) => {
    out[i] = out[i].slice(0, col).replace(/\s+$/, "");
  };
  const previewLines = [];
  let hidden = 0;
  for (let i = top; i <= bottom; i++) {
    const cell = lines[i].slice(col);
    blankFrom(i);
    if (i === top || i === bottom) continue;
    const cut = /✂\D*(\d+)\s+lines? hidden/.exec(cell);
    if (cut) {
      hidden = Number(cut[1]);
      previewLines.push(null);
      continue;
    }
    previewLines.push(cell.replace(/^│ ?/, "").replace(/ ?│$/, "").replace(/\s+$/, ""));
  }
  const preview = { lines: previewLines.map((l) => l ?? `… ${hidden} more lines`), hidden };

  let notes = null;
  let chat = null;
  for (let i = bottom + 1; i < footerIdx; i++) {
    const m = /^Notes:\s*(.*)$/.exec(lines[i].slice(col).trim());
    if (m && lines[i].slice(0, col).trim() === "") {
      const text = m[1];
      notes = /^press n to add notes$/i.test(text) || /^Add notes on this design…?$/i.test(text) ? { text: "" } : { text };
      out[i] = "";
      continue;
    }
    const c = /^(❯)?\s*Chat about this$/.exec(lines[i].trim());
    if (c) {
      chat = { cursor: Boolean(c[1]) };
      out[i] = "";
    }
  }
  return { lines: out, preview, notes, chat };
}

export function parsePrompt(lines) {
  const review = readReview(lines);
  if (review) return review;
  const footerIdx = findFooter(lines);
  if (footerIdx === -1) return null;
  const footer = lines[footerIdx].trim();
  const layout = extractPreviewLayout(lines, footerIdx);
  if (layout) {
    lines = layout.lines;
    // In the Notes field, keys type; the footer then offers Nvim for it.
    if (layout.notes) layout.notes.editing = /ctrl\+g to edit/.test(footer);
  }
  // Unnumbered lists are only trusted in confirm dialogs (the folder trust
  // prompt). Anything else unnumbered, like /config's settings list, stays
  // unmodeled: choosing there means arrows plus Enter on a list whose rows
  // this parser can't reliably tell apart, and Enter changes a real setting.
  const read = readNumbered(lines, footerIdx) ?? (/Enter to confirm/.test(footer) ? readUnnumbered(lines, footerIdx) : null);
  if (!read || read.options.length === 0) return { unreadable: true, footer };

  // Title/body/question: the text between the block's top rule and the first
  // option. AskUserQuestion's tab strip is the first line there.
  const rule = topRuleAbove(lines, read.top - 1);
  const header = lines.slice(rule + 1, read.top).filter((l) => !isBlank(l) && !DASHED_RE.test(l));
  let tabs = null;
  let tabRow = null;
  if (header.length > 0) {
    tabs = parseTabs(header[0]);
    if (tabs) {
      tabRow = lines.indexOf(header[0], rule + 1);
      header.shift();
    }
  }
  // Rejoin text the terminal wrapped: a line that doesn't end a sentence,
  // followed by one that starts lowercase (or continues a word or path that
  // filled the width), is one line.
  const width = screenWidth(lines);
  const joined = [];
  for (const l of header) {
    const prev = joined[joined.length - 1];
    const t = l.trim();
    const prevLen = prev === undefined ? 0 : [...prev.raw].length;
    const filled = width > 0 && prevLen >= width - 1;
    // A word wrap leaves the line short by at most about one word.
    const nearlyFull = width > 0 && prevLen >= width - 20;
    if (prev !== undefined && !/^[☐☒]\s/.test(t) && !/[.?!:]$/.test(prev.text) && (filled || (nearlyFull && /^[a-z(]/.test(t)))) {
      prev.text = filled || prev.text.endsWith("-") ? prev.text + t : `${prev.text} ${t}`;
      prev.raw = l;
      prev.lines.push(l);
    } else {
      joined.push({ text: t, raw: l, lines: [l] });
    }
  }
  const texts = joined.map((j) => j.text);
  // AskUserQuestion's single-question chip ("☐ Color") is a header, not text.
  const chip = texts.length > 0 && /^[☐☒]\s+\S/.test(texts[0]) ? texts.shift().replace(/^[☐☒]\s+/, "") : null;
  const question = texts.length > 0 && /\?$/.test(texts[texts.length - 1]) ? texts.pop() : null;
  const title = texts.length > 0 ? texts.shift() : (chip ?? question ?? "");
  // Body keeps its relative indentation (a command, a file name) minus the
  // block's one-space margin, and leaves out the lines used as title, chip
  // and question.
  const bodyLines = [];
  let titleTaken = false;
  for (const j of joined) {
    const t = j.text;
    const l = j.lines.length === 1 ? j.raw : j.lines[0].replace(/\S.*$/, "") + t;
    if (chip && /^[☐☒]\s+\S/.test(t)) continue;
    if (!titleTaken && t === title) {
      titleTaken = true;
      continue;
    }
    if (question && t === question) continue;
    bodyLines.push(l.replace(/^ /, ""));
  }
  const kind = layout?.chat && /Enter to select/.test(footer) ? "question" : classify({ footer, title, question, body: bodyLines, options: read.options, tabs });
  markTextEntry(kind, read.options);
  const plan = kind === "plan" && rule >= 0 ? planBodyAbove(lines, rule) : null;
  return {
    kind,
    review: false,
    title: chip && kind === "question" ? chip : title,
    question,
    body: bodyLines,
    plan,
    tabs,
    answers: null,
    options: read.options,
    numbered: read.numbered,
    multiSelect: read.options.some((o) => o.checked !== null),
    action: read.action ?? null,
    preview: layout?.preview ?? null,
    notes: layout?.notes ?? null,
    chat: layout?.chat ?? null,
    tabRow,
    footer,
    letterKeys: parseLetterKeys(footer),
  };
}

// The whole screen. `stripLines` sets how many bottom lines `tail` carries for
// the screen strip.
// A capture taken with styles is read as plain text; the styles only pick out
// what color alone marks (the active question tab).
export function parseScreen(text, { stripLines = 12 } = {}) {
  const styled = String(text ?? "").includes("\x1b[") ? toLines(text) : null;
  const lines = toLines(stripStyles(text));
  const mode = parseModeFooter(lines);
  const input = findInputBox(lines);
  const activity = parseActivity(lines, input?.top);
  const parsed = input ? null : parsePrompt(lines);
  const prompt = parsed && !parsed.unreadable ? { ...parsed, signature: "" } : null;
  if (prompt) {
    prompt.signature = promptSignature(prompt);
    prompt.activeTab = prompt.tabRow !== null && prompt.tabRow !== undefined ? activeTabIn(styled?.[prompt.tabRow], prompt.tabs) : null;
    delete prompt.tabRow;
  }
  const unmodeled = !prompt && !input;
  // A fingerprint of the conversation above the input box. Claude Code shows
  // no spinner while it streams a text reply, so the watcher reads "that area
  // keeps changing" as working.
  const above = input ? lines.slice(0, input.top).join("\n") : "";
  let fingerprint = 5381;
  for (let i = 0; i < above.length; i++) fingerprint = ((fingerprint << 5) + fingerprint + above.charCodeAt(i)) | 0;
  return {
    conversationFingerprint: input ? `${above.length}:${fingerprint >>> 0}` : null,
    mode,
    activity: activity ?? (input ? { state: "idle", verb: null, elapsed: null, note: null } : null),
    prompt,
    input: input ? { text: input.text } : null,
    unmodeled,
    tail: lines.slice(-stripLines).join("\n"),
  };
}
