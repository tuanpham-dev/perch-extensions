// Selecting tickets by pasting their keys.
//
// A standup note, a Slack message, a spreadsheet column - the keys arrive as
// text far more often than as rows you can tick. Resolving them here rather
// than in the batch form means the result is a SELECTION, which every action
// already takes: Start work, Add to worktree, Plan batch.
//
// Keys that name nothing are reported rather than dropped, and the text is
// kept when none of it resolved, so a typo can be corrected instead of
// retyped.
import { useEffect, useRef } from "react";
import Icon from "./Icon";
import Popover from "./Popover";
import { usePopoverPosition, type PopoverAnchor } from "./usePopoverPosition";

export interface KeyPasteFormProps {
  anchor: PopoverAnchor;
  text: string;
  busy: boolean;
  note: string | null;
  error: string | null;
  onChange: (text: string) => void;
  onSubmit: () => void;
  onClose: () => void;
}

export default function KeyPasteForm({ anchor, text, busy, note, error, onChange, onSubmit, onClose }: KeyPasteFormProps) {
  const { ref, style } = usePopoverPosition<HTMLDivElement>(anchor, [note, error, busy]);
  const box = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    box.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown, true);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown, true);
    };
  }, [onClose, ref, busy]);

  return (
    <Popover>
      <div ref={ref} className="jira-popover jira-keypaste" role="dialog" aria-label="Select tickets by key" style={style}>
        <div className="jira-pop-head">
          <span className="jira-facets-title">Select by key</span>
          <button className="icon-button" title="Close" onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>

        <textarea
          ref={box}
          className="jira-batchform-keys"
          rows={3}
          value={text}
          disabled={busy}
          placeholder="Paste keys from this list: CAP-12, CAP-15, or a browse link"
          aria-label="Ticket keys"
          onChange={(e) => onChange(e.target.value)}
          // Enter submits, since this is one field and a newline is just
          // another separator; shift-Enter still breaks a line.
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              onSubmit();
            }
          }}
        />

        {note && <div className="jira-batchform-note">{note}</div>}
        {error && <div className="jira-batchform-error">{error}</div>}

        <div className="jira-pop-actions">
          <button className="jira-selaction" disabled={busy} onClick={onClose}>
            Done
          </button>
          <button className="jira-selaction primary" disabled={busy || !text.trim()} onClick={onSubmit}>
            {busy ? "Selecting..." : "Select these"}
          </button>
        </div>
      </div>
    </Popover>
  );
}
