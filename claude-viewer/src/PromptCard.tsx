// What the terminal is asking, answered with a click. One card for every kind
// of prompt the screen parser reads: tool permissions, plan approval, folder
// trust, AskUserQuestion (tabs, checkboxes, review) and any other numbered
// picker. Each click sends the prompt's signature along; the server only
// presses the key while the screen still shows that same prompt.
import { useEffect, useRef, useState } from "react";
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

// Options that turn the row into a text field in the terminal.
const TEXT_ENTRY = /^(Type something|Tell Claude what to change)/i;

type KeyResponse = { ok?: boolean; error?: string; state?: ScreenState };

export function PromptCard({
  windowId,
  prompt,
  onState,
  enterSends,
}: {
  windowId: string;
  prompt: Prompt;
  onState: (state: ScreenState) => void;
  enterSends: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [textFor, setTextFor] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // A different prompt resets the text field.
  useEffect(() => {
    setError(null);
    if (textFor && textFor !== prompt.signature) {
      setTextFor(null);
      setDraft("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prompt.signature]);

  useEffect(() => {
    if (textFor) inputRef.current?.focus();
  }, [textFor]);

  async function press(body: Record<string, unknown>): Promise<boolean> {
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

  async function choose(option: PromptOption) {
    const ok = await press({ action: { type: "option", n: option.n }, expect: { signature: prompt.signature } });
    if (ok && TEXT_ENTRY.test(option.label)) setTextFor(prompt.signature);
  }

  async function chooseWithKey(option: PromptOption, letter: string) {
    await press({ action: { type: "option-key", n: option.n, key: letter }, expect: { signature: prompt.signature } });
  }

  async function key(name: string) {
    await press({ action: { type: "key", key: name } });
  }

  async function sendText() {
    const text = draft.trim();
    if (!text) return;
    setBusy(true);
    try {
      const { status, data } = await postJson<KeyResponse>("/send", { windowId, text, clearInput: false });
      if (data?.state) onState(data.state);
      if (status >= 400) setError(data?.error ?? "The text could not be sent.");
      else {
        setDraft("");
        setTextFor(null);
      }
    } finally {
      setBusy(false);
    }
  }

  const showTabs = prompt.tabs && prompt.tabs.length > 1;
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
            <span key={i} className={`cv-tab${t.done ? " cv-tab-done" : ""}${t.submit ? " cv-tab-submit" : ""}`}>
              {t.done && !t.submit ? "✓ " : ""}
              {t.label}
            </span>
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

      {textFor === prompt.signature || (textFor && prompt.options.some((o) => o.cursor && TEXT_ENTRY.test(o.label))) ? (
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
                void sendText();
              }
            }}
          />
          <div className="cv-prompt-actions">
            <button className="btn" disabled={busy} onClick={() => setTextFor(null)}>
              Back to options
            </button>
            <button className="btn btn-primary" disabled={busy || !draft.trim()} onClick={() => void sendText()}>
              Send
            </button>
          </div>
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
                {o.description && <span className="cv-option-desc">{o.description}</span>}
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
            <button className="btn btn-small" disabled={busy} onClick={() => key("tab")}>
              Next
            </button>
          )}
          <button className="btn btn-small" disabled={busy} onClick={() => key("esc")} title="Esc">
            Cancel
          </button>
        </span>
      </div>
    </section>
  );
}
