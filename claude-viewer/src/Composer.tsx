// Message input: multi-line text, slash-command and @-file autocomplete, and
// files pasted, attached or dropped anywhere on the tab. Ported from the
// claude-web extension's Composer.tsx. Images show as thumbnails and go up
// when the message is sent; other files go up at once and their path is added
// to the text. Either way Claude Code gets paths typed into its input, which is
// how it takes files.
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { uploadFile } from "./bridge";

export type PendingImage = { file: File; url: string };
export type SlashCommand = { name: string; description: string; argumentHint: string; builtin?: boolean };
export type ComposerHandle = { addFiles(files: FileList | File[]): void };

// Below this width the full placeholder no longer fits on one line.
const NARROW_INPUT_PX = 460;
// The composer grows with what is typed up to this many lines, then scrolls.
const MAX_INPUT_LINES = 4;
const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

export const Composer = forwardRef<ComposerHandle, {
  commands: SlashCommand[];
  searchFiles: (q: string) => Promise<string[]>;
  onSend: (text: string, images: PendingImage[]) => Promise<boolean>;
  disabled?: boolean;
  disabledReason?: string;
  terminalInput?: string;
  // true: Enter sends, Shift+Enter starts a line. false: Enter starts a line,
  // Ctrl+Enter (Cmd+Enter on a Mac) sends.
  enterSends: boolean;
  // Claude is mid-turn: an empty composer's button becomes Stop.
  working?: boolean;
  onStop?: () => void;
  // The row under the text box: after the attach button, and at its far end.
  footerStart?: ReactNode;
  footerEnd?: ReactNode;
}>(function Composer({ commands, searchFiles, onSend, disabled, disabledReason, terminalInput, enterSends, working, onStop, footerStart, footerEnd }, ref) {
  const [input, setInput] = useState("");
  const [images, setImages] = useState<PendingImage[]>([]);
  const [fileMatches, setFileMatches] = useState<string[] | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Escape dismisses whichever popup is open without touching the input;
  // both popups are otherwise purely derived from `input`/`fileMatches`, so
  // "dismissed" is tracked against the input value that was on screen when
  // Escape was pressed — typing further changes that value, so the popup
  // (now for different, un-dismissed matches) can come back naturally.
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
  const [highlight, setHighlight] = useState(0);

  const slashMatches =
    input.startsWith("/") && !input.includes("\n") && !input.includes(" ") && dismissedFor !== input
      ? commands.filter((c) => c.name.startsWith(input.slice(1))).slice(0, 8)
      : [];

  const mentionMatch = /(^|\s)@([\w./-]*)$/.exec(input);
  const mentionQuery = mentionMatch?.[2] ?? null;
  const showFileMatches =
    fileMatches !== null && fileMatches.length > 0 && mentionMatch !== null && dismissedFor !== input;

  // Slash commands and @-file mentions can never both be showing at once
  // (slashMatches requires no space in the input; a mention match requires
  // one before the @ unless it's at position 0, and a bare "@..." doesn't
  // start with "/") — so one shared highlight index covers whichever popup
  // is actually on screen.
  const activeItems = slashMatches.length > 0
    ? slashMatches.map((cmd) => ({ key: cmd.name, onSelect: () => setInput(`/${cmd.name} `) }))
    : showFileMatches && mentionMatch
      ? (fileMatches as string[]).map((file) => ({
          key: file,
          onSelect: () => {
            setInput(input.slice(0, mentionMatch.index) + mentionMatch[1] + "@" + file + " ");
            setFileMatches(null);
          },
        }))
      : [];
  const activeKey = activeItems.map((i) => i.key).join("");
  useEffect(() => setHighlight(0), [activeKey]);

  useEffect(() => {
    if (mentionQuery === null) {
      setFileMatches(null);
      return;
    }
    const timer = setTimeout(() => {
      searchFiles(mentionQuery)
        .then((files) => setFileMatches(files.slice(0, 8)))
        .catch(() => setFileMatches(null));
    }, 150);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mentionQuery]);

  const [uploading, setUploading] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Grows with its content, wrapped lines included, up to MAX_INPUT_LINES,
  // and scrolls past that. Refit on every render (the text changed) and on a
  // width change (the same text wraps onto a different number of lines).
  const fitHeight = () => {
    const el = textareaRef.current;
    if (!el) return;
    const style = getComputedStyle(el);
    const borders = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
    const max = parseFloat(style.lineHeight) * MAX_INPUT_LINES + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) + borders;
    el.style.height = "auto";
    const wanted = el.scrollHeight + borders;
    el.style.height = `${Math.min(wanted, max)}px`;
    el.style.overflowY = wanted > max ? "auto" : "hidden";
  };
  useLayoutEffect(fitHeight);

  // The full hint wraps and gets cut off in a narrow box (a phone), so a
  // narrow box shows just "Message Claude".
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const el = textareaRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let width = el.clientWidth;
    const observer = new ResizeObserver(() => {
      setNarrow(el.clientWidth < NARROW_INPUT_PX);
      if (el.clientWidth !== width) {
        width = el.clientWidth;
        fitHeight();
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const addFiles = (files: FileList | File[]) => {
    const list = [...files];
    const imgs = list.filter((f) => f.type.startsWith("image/")).map((file) => ({ file, url: URL.createObjectURL(file) }));
    if (imgs.length > 0) setImages((prev) => [...prev, ...imgs]);
    const others = list.filter((f) => !f.type.startsWith("image/"));
    if (others.length === 0) return;
    setUploadError(null);
    setUploading((n) => n + others.length);
    for (const file of others) {
      uploadFile(file)
        .then((path) => setInput((prev) => (prev && !/\s$/.test(prev) ? `${prev} ${path} ` : `${prev}${path} `)))
        .catch((err: Error) => setUploadError(`${file.name} could not be uploaded: ${err.message}`))
        .finally(() => setUploading((n) => n - 1));
    }
    textareaRef.current?.focus();
  };
  useImperativeHandle(ref, () => ({ addFiles }));
  const [sending, setSending] = useState(false);

  const empty = input.trim() === "" && images.length === 0;
  const sendKeyHint = enterSends ? "Enter to send" : `${IS_MAC ? "Cmd" : "Ctrl"}+Enter to send`;
  // Text already in the terminal's own input box (a draft typed there, or the
  // prompt Claude Code puts back after an interrupt) shows as the placeholder
  // while this box is empty, and Tab takes it. Sending replaces it in the
  // terminal either way.
  const offered = terminalInput?.trim() ? terminalInput : "";
  const placeholder = disabled
    ? disabledReason
    : offered && input === ""
      ? offered
      : narrow
        ? "Message Claude"
        : `Message Claude. / for commands, @ for files, ${sendKeyHint}`;

  const send = async () => {
    const text = input.trim();
    if ((text === "" && images.length === 0) || sending || disabled) return;
    setSending(true);
    try {
      if (await onSend(text, images)) {
        for (const img of images) URL.revokeObjectURL(img.url);
        setInput("");
        setImages([]);
        setFileMatches(null);
      }
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="cv-composer">
      {slashMatches.length > 0 && (
        <div className="autocomplete">
          {slashMatches.map((cmd, idx) => (
            <button
              key={cmd.name}
              className={`autocomplete-item${idx === highlight ? " autocomplete-item-active" : ""}`}
              onMouseEnter={() => setHighlight(idx)}
              onClick={() => setInput(`/${cmd.name} `)}
            >
              <span className="autocomplete-label">
                /{cmd.name} <em>{cmd.argumentHint}</em>
              </span>
              <span className="autocomplete-desc">{cmd.description}</span>
            </button>
          ))}
        </div>
      )}
      {showFileMatches && mentionMatch && (
        <div className="autocomplete">
          {(fileMatches as string[]).map((file, idx) => (
            <button
              key={file}
              className={`autocomplete-item${idx === highlight ? " autocomplete-item-active" : ""}`}
              onMouseEnter={() => setHighlight(idx)}
              onClick={() => {
                setInput(input.slice(0, mentionMatch.index) + mentionMatch[1] + "@" + file + " ");
                setFileMatches(null);
              }}
            >
              <span className="autocomplete-label">@{file}</span>
            </button>
          ))}
        </div>
      )}
      {(uploading > 0 || uploadError) && (
        <div className={`cv-upload-status${uploadError ? " cv-upload-error" : ""}`} role="status">
          {uploadError ?? `Uploading ${uploading} file${uploading === 1 ? "" : "s"}`}
        </div>
      )}
      {images.length > 0 && (
        <div className="image-strip">
          {images.map((img, idx) => (
            <div key={idx} className="image-thumb">
              <img src={img.url} alt="Attached image" />
              <button
                className="image-remove"
                aria-label="Remove image"
                onClick={() => setImages(images.filter((_, i) => i !== idx))}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="composer">
        <div className="cv-input-box">
          <textarea
            ref={textareaRef}
            value={input}
            id="cv-composer-input"
            disabled={disabled}
            placeholder={placeholder}
            rows={1}
            onChange={(e) => setInput(e.target.value)}
            onPaste={(e) => {
              const files = [...e.clipboardData.items]
                .filter((item) => item.kind === "file")
                .map((item) => item.getAsFile())
                .filter((f): f is File => f !== null);
              if (files.length > 0) {
                e.preventDefault();
                addFiles(files);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Tab" && !e.shiftKey && input === "" && offered && activeItems.length === 0) {
                e.preventDefault();
                setInput(offered);
                return;
              }
              if (activeItems.length > 0) {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setHighlight((h) => (h + 1) % activeItems.length);
                  return;
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setHighlight((h) => (h - 1 + activeItems.length) % activeItems.length);
                  return;
                }
                if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
                  e.preventDefault();
                  activeItems[highlight]?.onSelect();
                  return;
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  setDismissedFor(input);
                  return;
                }
              }
              if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
              const modifier = e.ctrlKey || e.metaKey;
              if (enterSends ? !e.shiftKey : modifier) {
                e.preventDefault();
                void send();
              }
            }}
          />
          {/* One button, three jobs: Stop while Claude works and nothing is
              written, Use when the terminal's own input has text to take, Send
              otherwise. */}
          {empty && working && onStop ? (
            <button className="cv-input-action cv-input-stop" onClick={onStop} disabled={disabled} title="Interrupt Claude (Esc)" aria-label="Stop">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20M9 9h6v6H9" />
              </svg>
            </button>
          ) : empty && offered ? (
            <button
              className="cv-input-action cv-input-use"
              onClick={() => {
                setInput(offered);
                textareaRef.current?.focus();
              }}
              disabled={disabled}
              title="Use the text from the terminal's input (Tab)"
              aria-label="Use the terminal's input"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M20 18h2V6h-2M11.59 7.41 15.17 11H1v2h14.17l-3.58 3.58L13 18l6-6-6-6z" />
              </svg>
            </button>
          ) : (
            <button
              className="cv-input-action cv-input-send"
              onClick={() => void send()}
              disabled={empty || sending || disabled || uploading > 0}
              title={`Send (${sendKeyHint.replace(" to send", "")})`}
              aria-label="Send"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M8 5.14v14l11-7z" />
              </svg>
            </button>
          )}
        </div>
        <div className="cv-composer-foot">
          <div className="cv-composer-foot-start">
            <button
              className="cv-foot-btn cv-foot-icon"
              title="Attach files or images (or drop them anywhere on this tab)"
              aria-label="Attach files"
              onClick={() => fileInputRef.current?.click()}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
              </svg>
            </button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files) addFiles(e.target.files);
                e.target.value = "";
              }}
            />
            {footerStart}
          </div>
          <div className="cv-composer-foot-end">{footerEnd}</div>
        </div>
      </div>
    </div>
  );
});
