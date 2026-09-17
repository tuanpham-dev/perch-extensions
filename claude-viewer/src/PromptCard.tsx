// What the terminal is asking, answered with a click. One card for every kind
// of prompt the screen parser reads: tool permissions, plan approval, folder
// trust, AskUserQuestion (tabs, checkboxes, review) and any other numbered
// picker. Each click sends the prompt's signature along; the server only
// presses the key while the screen still shows that same prompt.
//
// The keyboard works as it does in the terminal: while the card is up, the
// tab passes arrows, Tab, Shift+Tab, Enter, Esc, digits and the letters the
// footer offers to handleKey, which sends them on in order. The terminal
// moves its own cursor, and the card follows the next screen read.
import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type KeyboardEvent } from "react";
import { postJson } from "./bridge";
import { Markdown } from "./Message";
import type { Prompt, PromptOption, ScreenState } from "./types";

const KIND_LABEL: Record<Prompt["kind"], string> = {
  permission: "Permission",
  plan: "Plan ready",
  trust: "Trust this folder?",
  question: "Claude asks",
  generic: "Choose",
};

// Options that are a text field in the terminal. The server marks them
// (textEntry); the label test covers a server that doesn't.
const TEXT_ENTRY = /^(Type something|Tell Claude what to change)/i;
const isTextEntry = (o: PromptOption | undefined) => Boolean(o && (o.textEntry ?? TEXT_ENTRY.test(o.label)));

type KeyResponse = { ok?: boolean; error?: string; state?: ScreenState };

const ARROWS: Record<string, string> = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" };

export type PromptCardHandle = {
  // A key pressed anywhere in the tab while the card is up. True when it was
  // sent to the terminal (the caller then prevents the browser's default).
  handleKey(e: KeyboardEvent): boolean;
};

export const PromptCard = forwardRef<PromptCardHandle, {
  windowId: string;
  prompt: Prompt;
  onState: (state: ScreenState) => void;
  enterSends: boolean;
}>(function PromptCard({ windowId, prompt, onState, enterSends }, ref) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [textFor, setTextFor] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // A preview prompt's notes as typed here, until sent with the choice (null:
  // untouched, showing the terminal's).
  const [notesDraft, setNotesDraft] = useState<string | null>(null);
  const notesRef = useRef<HTMLInputElement>(null);

  // A different prompt resets the text field.
  useEffect(() => {
    setError(null);
    setNotesDraft(null);
    if (textFor && textFor !== prompt.signature) {
      setTextFor(null);
      setDraft("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prompt.signature]);

  useEffect(() => {
    const field = inputRef.current;
    if (!textFor || !field) return;
    field.focus();
    // After what is already there (a draft, or the key that opened it).
    field.setSelectionRange(field.value.length, field.value.length);
  }, [textFor]);

  // Keys go out one at a time, in the order they were pressed, however fast
  // they come: each waits for the one before it.
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const promptRef = useRef(prompt);
  promptRef.current = prompt;

  function press(body: Record<string, unknown>): Promise<boolean> {
    const next = chain.current.then(() => pressNow(body));
    chain.current = next.catch(() => {});
    return next;
  }

  async function pressNow(body: Record<string, unknown>): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const { status, data } = await postJson<KeyResponse>("/key", { windowId, ...body });
      if (data?.state) onState(data.state);
      if (status === 409) {
        setError("The terminal moved on. This shows what it asks now.");
        return false;
      }
      if (status >= 400) {
        setError(data?.error ?? `The key could not be sent (${status}).`);
        return false;
      }
      return true;
    } catch {
      setError("The key could not be sent. Check the connection and try again.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  // A text-entry option opens the answer field, starting from what is already
  // typed in the terminal's (the server moves the terminal's cursor into it).
  async function choose(option: PromptOption, initial?: string) {
    const ok = await press({ action: { type: "option", n: option.n }, expect: { signature: prompt.signature } });
    if (ok && isTextEntry(option)) {
      setDraft(initial ?? option.typed ?? "");
      setTextFor(prompt.signature);
    }
  }

  async function chooseWithKey(option: PromptOption, letter: string) {
    await press({ action: { type: "option-key", n: option.n, key: letter }, expect: { signature: prompt.signature } });
  }

  // A preview prompt: choosing sends changed notes first, as the terminal
  // takes notes before Enter.
  async function chooseWithNotes(option: PromptOption) {
    if (notesDraft !== null && notesDraft !== (prompt.notes?.text ?? "")) {
      const ok = await press({ action: { type: "notes", text: notesDraft }, expect: { signature: prompt.signature } });
      if (!ok) return;
    }
    // The highlight first, then Enter: what the terminal does for a choice.
    if (!option.cursor || prompt.chat?.cursor) {
      const ok = await press({ action: { type: "cursor", n: option.n }, expect: { signature: prompt.signature } });
      if (!ok) return;
    }
    await press({ action: { type: "key", key: "enter" }, expect: { signature: prompt.signature } });
  }

  function highlight(option: PromptOption) {
    void press({ action: { type: "cursor", n: option.n }, expect: { signature: prompt.signature } });
  }

  async function key(name: string) {
    await press({ action: { type: "key", key: name } });
  }

  const textOpen = textFor === prompt.signature || Boolean(textFor && prompt.options.some((o) => o.cursor && isTextEntry(o)));

  useImperativeHandle(ref, () => ({
    handleKey(e) {
      if (e.ctrlKey || e.metaKey || e.altKey) return false;
      // The answer field takes its own typing.
      if (textOpen || (e.target as HTMLElement).closest?.("textarea, input")) return false;
      const current = promptRef.current;
      const cursor = current.options.find((o) => o.cursor);
      // n opens the Notes field, as in the terminal; here it is the card's.
      if (current.notes && e.key === "n" && !e.shiftKey) {
        notesRef.current?.focus();
        return true;
      }
      if (current.chat?.cursor && e.key === "Enter") {
        void press({ action: { type: "chat" }, expect: { signature: current.signature } });
        return true;
      }
      // With the terminal's cursor in a text field, typing goes into it there,
      // so here it opens the answer field with that character.
      if (isTextEntry(cursor) && e.key.length === 1 && !(e.key === " " && !cursor!.typed)) {
        void choose(cursor!, (cursor!.typed ?? "") + e.key);
        return true;
      }
      if (ARROWS[e.key]) {
        void key(ARROWS[e.key]);
      } else if (e.key === "Tab") {
        void key(e.shiftKey ? "shiftTab" : "tab");
      } else if (e.key === "Escape") {
        void key("esc");
      } else if (e.key === "Enter") {
        // A "Type something" row opens the answer field, as choosing it does.
        if (isTextEntry(cursor)) void choose(cursor!);
        else void press({ action: { type: "key", key: "enter" }, expect: { signature: current.signature } });
      } else if (/^[1-9]$/.test(e.key) && current.numbered && current.options.some((o) => o.n === Number(e.key))) {
        void choose(current.options.find((o) => o.n === Number(e.key))!);
      } else if (cursor && !e.shiftKey && (current.letterKeys ?? []).some((l) => l.key === e.key.toLowerCase())) {
        void chooseWithKey(cursor, e.key.toLowerCase());
      } else {
        return false;
      }
      return true;
    },
  }));

  // The server puts the terminal's cursor in the text field and replaces what
  // is typed there. A multi-select answer is typed without Enter (Enter would
  // untick it); the list's Next or Submit button sends it on.
  function sendText() {
    const text = draft.trim();
    if (!text) return;
    const multiSelect = prompt.multiSelect;
    const next = chain.current.then(async () => {
      setBusy(true);
      setError(null);
      try {
        const { status, data } = await postJson<KeyResponse>("/send", { windowId, text, clearInput: false, submit: !multiSelect });
        if (data?.state) onState(data.state);
        if (status >= 400) setError(data?.error ?? "The text could not be sent.");
        else {
          setDraft("");
          setTextFor(null);
        }
      } catch {
        setError("The text could not be sent. Check the connection and try again.");
      } finally {
        setBusy(false);
      }
    });
    chain.current = next.catch(() => {});
  }

  const showTabs = prompt.tabs && prompt.tabs.length > 1;
  // Which tab is active is read from the terminal's colors; null when this
  // Perch can't capture them.
  const activeTab = showTabs ? (prompt.activeTab ?? null) : null;
  // A tab click steps there with arrows, one question at a time.
  function goToTab(target: number) {
    if (activeTab === null) return;
    const step = target > activeTab ? "right" : "left";
    for (let k = 0; k < Math.abs(target - activeTab); k++) void key(step);
  }
  const heading = prompt.kind === "question" && prompt.question ? prompt.question : prompt.title;
  const sub = prompt.kind === "question" ? null : prompt.question && prompt.question !== prompt.title ? prompt.question : null;
  const body = prompt.body.filter((l) => l.trim() !== "");

  return (
    <section className={`cv-prompt cv-prompt-${prompt.kind}`} aria-label={KIND_LABEL[prompt.kind]}>
      <div className="cv-prompt-head">
        <span className="cv-prompt-kind">{KIND_LABEL[prompt.kind]}</span>
        {prompt.kind === "question" && prompt.title && prompt.title !== heading && <span className="cv-prompt-chip">{prompt.title}</span>}
      </div>

      {showTabs && (
        <div className="cv-prompt-tabs">
          <button className="cv-tab-nav" disabled={busy} onClick={() => key("left")} title="Previous question">
            ‹
          </button>
          {prompt.tabs!.map((t, i) => (
            <button
              key={i}
              className={`cv-tab${t.done ? " cv-tab-done" : ""}${t.submit ? " cv-tab-submit" : ""}${i === activeTab ? " cv-tab-active" : ""}`}
              aria-current={i === activeTab ? "step" : undefined}
              disabled={busy || activeTab === null || i === activeTab}
              title={activeTab === null ? undefined : i === activeTab ? "Current question" : t.submit ? "Review and submit" : `Go to ${t.label}`}
              onClick={() => goToTab(i)}
            >
              {t.done && !t.submit ? "✓ " : ""}
              {t.label}
            </button>
          ))}
          <button className="cv-tab-nav" disabled={busy} onClick={() => key("tab")} title="Next question">
            ›
          </button>
        </div>
      )}

      <div className="cv-prompt-title">{heading}</div>
      {sub && prompt.kind !== "plan" && <div className="cv-prompt-question">{sub}</div>}

      {prompt.kind !== "question" && body.length > 0 && (
        <pre className="cv-prompt-context">{body.join("\n")}</pre>
      )}

      {prompt.plan && (
        <div className="cv-prompt-plan">
          {prompt.plan.truncated && <div className="cv-prompt-note">The start of the plan is above what the terminal still shows.</div>}
          <Markdown text={prompt.plan.text} />
        </div>
      )}

      {prompt.review && prompt.answers && (
        <dl className="cv-prompt-answers">
          {prompt.answers.map((a, i) => (
            <div key={i}>
              <dt>{a.question}</dt>
              <dd>{a.answer || "No answer"}</dd>
            </div>
          ))}
        </dl>
      )}

      {textOpen ? (
        <div className="cv-prompt-text">
          <textarea
            ref={inputRef}
            id={`cv-prompt-text-${windowId}`}
            value={draft}
            rows={Math.min(6, Math.max(2, draft.split("\n").length))}
            placeholder={prompt.kind === "plan" ? "What should Claude change in the plan?" : "Type your answer"}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
              if (enterSends ? !e.shiftKey : e.ctrlKey || e.metaKey) {
                e.preventDefault();
                sendText();
              }
            }}
          />
          <div className="cv-prompt-actions">
            <button className="btn" disabled={busy} onClick={() => setTextFor(null)}>
              Back to options
            </button>
            <button className="btn btn-primary" disabled={busy || !draft.trim()} onClick={sendText}>
              {prompt.multiSelect ? "Add" : "Send"}
            </button>
          </div>
        </div>
      ) : prompt.preview ? (
        // Options on the left, the highlighted one's preview on the right. A
        // click highlights (and so previews); Choose, a double-click, a digit
        // or Enter chooses.
        <div className="cv-preview-layout">
          <div className="cv-preview-options" role="listbox" aria-label="Options">
            {prompt.options.map((o) => (
              <button
                key={o.n}
                role="option"
                aria-selected={o.cursor && !prompt.chat?.cursor}
                className={`cv-option cv-option-compact${o.cursor && !prompt.chat?.cursor ? " cv-option-cursor" : ""}`}
                disabled={busy}
                onClick={() => (o.cursor && !prompt.chat?.cursor ? void chooseWithNotes(o) : highlight(o))}
                onDoubleClick={() => void chooseWithNotes(o)}
                title={o.cursor ? "Click again to choose" : "Show its preview"}
              >
                <span className="cv-option-n">{o.n}</span>
                <span className="cv-option-text">
                  <span className="cv-option-label">{o.label}</span>
                  {o.description && <span className="cv-option-desc">{o.description}</span>}
                </span>
              </button>
            ))}
            {prompt.chat && (
              <button
                className={`cv-option cv-option-compact cv-option-chat${prompt.chat.cursor ? " cv-option-cursor" : ""}`}
                disabled={busy}
                onClick={() => void press({ action: { type: "chat" }, expect: { signature: prompt.signature } })}
              >
                <span className="cv-option-text">
                  <span className="cv-option-label">Chat about this</span>
                </span>
              </button>
            )}
          </div>
          {(() => {
            const shown = prompt.options.find((o) => o.cursor);
            return (
              <div className="cv-preview-pane">
                <div className="cv-preview-name">{shown ? shown.label : "Preview"}</div>
                <pre className="cv-preview-box">{prompt.preview.lines.join("\n")}</pre>
                {prompt.preview.hidden > 0 && (
                  <div className="cv-prompt-note">The terminal is too small to show all of it. A taller terminal window shows the rest.</div>
                )}
                {prompt.notes && (
                  <label className="cv-preview-notes">
                    <span>Notes</span>
                    <input
                      ref={notesRef}
                      value={notesDraft ?? prompt.notes.text}
                      placeholder="Add notes on this design"
                      disabled={busy}
                      onChange={(e) => setNotesDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.nativeEvent.isComposing && shown) {
                          e.preventDefault();
                          void chooseWithNotes(shown);
                        } else if (e.key === "Escape") {
                          e.preventDefault();
                          setNotesDraft(null);
                          (e.target as HTMLInputElement).blur();
                        }
                      }}
                    />
                  </label>
                )}
                {shown && (
                  <div className="cv-prompt-actions">
                    <button className="btn btn-primary" disabled={busy} onClick={() => void chooseWithNotes(shown)}>
                      Choose {shown.label}
                    </button>
                  </div>
                )}
              </div>
            );
          })()}
        </div>
      ) : (
        <div className={`cv-prompt-options${prompt.options.length > 6 ? " cv-prompt-options-many" : ""}`}>
          {prompt.options.map((o) => (
            <div key={o.n} className="cv-option-row">
            <button
              className={`cv-option${o.cursor ? " cv-option-cursor" : ""}${o.checked ? " cv-option-checked" : ""}${o.current ? " cv-option-current" : ""}`}
              disabled={busy}
              onClick={() => void choose(o)}
            >
              {prompt.numbered && <span className="cv-option-n">{o.n}</span>}
              {o.checked !== null && <span className="cv-option-box" aria-hidden="true">{o.checked ? "☑" : "☐"}</span>}
              <span className="cv-option-text">
                <span className="cv-option-label">
                  {o.label}
                  {o.current ? <span className="cv-option-mark"> (current)</span> : null}
                </span>
                {o.typed ? <span className="cv-option-desc cv-option-typed">{o.typed}</span> : o.description && <span className="cv-option-desc">{o.description}</span>}
              </span>
            </button>
            {(prompt.letterKeys ?? []).map((l) => (
              <button
                key={l.key}
                className="btn btn-small cv-option-alt"
                disabled={busy}
                title={`Highlight this option and press ${l.key}`}
                onClick={() => void chooseWithKey(o, l.key)}
              >
                {l.label.charAt(0).toUpperCase() + l.label.slice(1)}
              </button>
            ))}
            </div>
          ))}
        </div>
      )}

      <div className="cv-prompt-foot">
        {error ? <span className="cv-prompt-error" role="alert">{error}</span> : <span className="cv-prompt-footer-text">{prompt.footer ?? ""}</span>}
        <span className="cv-prompt-foot-actions">
          {prompt.multiSelect && (
            <button
              className={`btn btn-small${prompt.action?.cursor ? " btn-primary" : ""}`}
              disabled={busy}
              onClick={() => void (prompt.action ? press({ action: { type: "action" }, expect: { signature: prompt.signature } }) : key("tab"))}
            >
              {prompt.action?.label ?? "Next"}
            </button>
          )}
          <button className="btn btn-small" disabled={busy} onClick={() => key("esc")} title="Esc">
            Cancel
          </button>
        </span>
      </div>
    </section>
  );
});
