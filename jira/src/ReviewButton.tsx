// The Review split button in the ticket pane's head: the main part runs the
// remembered choice, the arrow opens the three. Its own small menu rather than
// the host's, because the host menu has no disabled state and an item this
// ticket's links cannot serve should be seen and refused, not missing.
import { useEffect, useRef, useState } from "react";
import { ACTIONS, effectiveAction, enabledActions, tasksFor } from "../reviewModel.mjs";
import Icon from "./Icon";
import type { ReviewAction, ReviewTaskName, TicketLinks } from "./reviewTypes";

const LABEL: Record<ReviewAction, string> = { code: "Code review", qa: "Visual QA", both: "Both" };
const WHY_NOT: Record<ReviewAction, string> = {
  code: "No pull request link in this ticket",
  qa: "No preview theme link in this ticket",
  both: "Needs a pull request link and a preview link",
};

export interface ReviewButtonProps {
  links: TicketLinks | null | undefined;
  saved: unknown;
  busy: boolean;
  running: Set<ReviewTaskName>;
  // x/y of the click, for the agent menu that may follow.
  onRun: (action: ReviewAction, x: number, y: number) => void;
  onSave: (action: ReviewAction) => void;
}

export default function ReviewButton({ links, saved, busy, running, onRun, onSave }: ReviewButtonProps) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const action = effectiveAction(links, saved);
  const enabled = enabledActions(links);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!action) return null;
  const isRunning = (a: ReviewAction) => tasksFor(a).some((task) => running.has(task));

  return (
    <span className="jira-split" ref={root}>
      <button
        className="jira-selaction jira-split-main"
        disabled={busy || isRunning(action)}
        title={isRunning(action) ? "Already running - see the Review section" : `Run ${LABEL[action].toLowerCase()} for this ticket`}
        onClick={(e) => onRun(action, e.clientX, e.clientY)}
      >
        Review: {LABEL[action]}
      </button>
      <button
        className="jira-selaction jira-split-arrow"
        disabled={busy}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Choose what Review runs"
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="chevron-down" />
      </button>
      {open && (
        <div className="jira-split-menu" role="menu">
          {ACTIONS.map((item) => {
            const off = !enabled[item] || isRunning(item);
            return (
              <button
                key={item}
                role="menuitemradio"
                aria-checked={item === action}
                className={`jira-split-item${item === action ? " current" : ""}`}
                disabled={off}
                title={!enabled[item] ? WHY_NOT[item] : isRunning(item) ? "Already running" : undefined}
                onClick={(e) => {
                  setOpen(false);
                  onSave(item);
                  onRun(item, e.clientX, e.clientY);
                }}
              >
                <span className="jira-split-check">{item === action ? <Icon name="check" /> : null}</span>
                {LABEL[item]}
              </button>
            );
          })}
        </div>
      )}
    </span>
  );
}
