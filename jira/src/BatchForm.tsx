// Plan a batch: which tickets, how to split them, and whether the AI may read
// the repository before it answers.
//
// The tickets come from two places at once - what is ticked in the lists, and
// whatever was pasted into the keys field - because the ones you want are
// rarely all in the same place. Both end up in one reviewable list, so what
// Analyze will act on is never a guess.
import { useEffect, useRef } from "react";
import Icon from "./Icon";
import { usePopoverPosition, type PopoverAnchor } from "./usePopoverPosition";
import type { IssueRow } from "./types";
import Popover from "./Popover";

export interface BatchFormProps {
  anchor: PopoverAnchor;
  // The name of the batch being added to, or null when this makes a new one.
  addingTo: string | null;
  issues: IssueRow[];
  keysText: string;
  // Skip the AI and put everything in one cluster.
  single: boolean;
  // With `single`: the name for the cluster, and for a new batch.
  title: string;
  lookupNote: string | null;
  // Pasted keys being looked up right now.
  resolving: boolean;
  // Keys the batch being added to already holds; they are left where they are.
  already: Set<string>;
  criteria: string;
  readCodebase: boolean;
  canReadCodebase: boolean;
  aiHint: string | null;
  busy: boolean;
  error: string | null;
  fallback: boolean;
  onChange: (patch: { keysText?: string; criteria?: string; readCodebase?: boolean; single?: boolean; title?: string }) => void;
  onResolveKeys: () => void;
  onRemoveIssue: (key: string) => void;
  onSubmit: () => void;
  onSubmitWithoutCodebase: () => void;
  // The AI grouping failed: the ways that don't need it.
  aiFailed: boolean;
  onGroupByFields: () => void;
  onKeepTogether: () => void;
  onCancel: () => void;
}

export default function BatchForm({
  anchor,
  addingTo,
  issues,
  keysText,
  single,
  title,
  lookupNote,
  resolving,
  already,
  criteria,
  readCodebase,
  canReadCodebase,
  aiHint,
  busy,
  error,
  fallback,
  onChange,
  onResolveKeys,
  onRemoveIssue,
  onSubmit,
  onSubmitWithoutCodebase,
  aiFailed,
  onGroupByFields,
  onKeepTogether,
  onCancel,
}: BatchFormProps) {
  const { ref, style } = usePopoverPosition<HTMLDivElement>(anchor, [issues.length, error, lookupNote, busy]);
  const keysRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Not while a run is in flight: Cancel is disabled then, and a key that
      // quietly does what the button refuses is worse than neither.
      if (e.key === "Escape" && !busy) onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel, busy]);

  const count = `${issues.length} ${issues.length === 1 ? "ticket" : "tickets"}`;
  const busyLabel = readCodebase
    ? `Reading the codebase and grouping ${count}, this can take a few minutes...`
    : `Asking the AI to group ${count}...`;

  return (
    <Popover>
      <div ref={ref} className="jira-popover jira-batchform" role="dialog" style={style}>
        <div className="jira-pop-head">
          <span className="jira-facets-title">
            {addingTo ? `Add tickets to "${addingTo}"` : "Plan batch"}
          </span>
          <button className="icon-button" title="Close" onClick={onCancel}>
            <Icon name="close" />
          </button>
        </div>

        <div className="jira-batchform-body">
          <label className="jira-field-label" htmlFor="jira-batch-keys">
            Tickets
          </label>
          {issues.length === 0 ? (
            <div className="jira-batchform-empty">Nothing picked yet - paste some keys below.</div>
          ) : (
            <ul className="jira-batchform-tickets">
              {issues.map((issue) => (
                <li key={issue.key}>
                  <span className="jira-key">{issue.key}</span>
                  <span className="jira-batchform-summary">{issue.summary}</span>
                  {already.has(issue.key) && (
                    <span className="jira-batchform-already" title="It stays where it is; only the others are placed">
                      already in this batch
                    </span>
                  )}
                  <button
                    className="icon-button"
                    title={`Leave ${issue.key} out`}
                    onClick={() => onRemoveIssue(issue.key)}
                    disabled={busy}
                  >
                    <Icon name="close" />
                  </button>
                </li>
              ))}
            </ul>
          )}

          <textarea
            id="jira-batch-keys"
            ref={keysRef}
            className="jira-batchform-keys"
            rows={2}
            placeholder="Paste ticket keys or links: CAP-12, CAP-15, https://.../browse/OPS-41"
            value={keysText}
            disabled={busy}
            onChange={(e) => onChange({ keysText: e.target.value })}
            // Resolved when the field loses focus, so the list shows what was
            // pasted before Analyze is pressed rather than after.
            onBlur={() => onResolveKeys()}
          />
          {resolving && <div className="jira-batchform-note">Looking up the pasted keys...</div>}
          {lookupNote && <div className="jira-batchform-note">{lookupNote}</div>}

          <span className="jira-field-label">How should they be split?</span>

          {/* The first answer is "don't". A few tickets on one piece of work
              need no model to group them, and this is what "Start work"
              would do - one worktree, one agent - with the board, the
              reports and the QA pass that only a batch gets. */}
          <label className="jira-batchform-check">
            <input
              type="checkbox"
              id="jira-batch-single"
              checked={single}
              disabled={busy}
              onChange={(e) => onChange({ single: e.target.checked })}
            />
            <span>Keep them together in one cluster</span>
          </label>

          {single ? (
            <>
            <label className="jira-batchform-title">
              <span>{addingTo ? "Cluster title" : "Batch and cluster title"}</span>
              <input
                id="jira-batch-title"
                className="jira-input"
                value={title}
                disabled={busy}
                maxLength={60}
                placeholder={issues[0]?.summary ? `Default: ${issues[0].summary}` : "Default: the first ticket's summary"}
                onChange={(e) => onChange({ title: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !busy && (issues.length > 0 || keysText.trim() !== "")) onSubmit();
                }}
              />
            </label>
            <div className="jira-batchform-hint">
              One worktree and one agent for all {issues.length === 1 ? "1 ticket" : `${issues.length} tickets`}, worked in
              the order above. No AI call, so this is immediate - and you can still split it in the review.
            </div>
            </>
          ) : (
            <>
              <textarea
                id="jira-batch-criteria"
                className="jira-batchform-criteria"
                aria-label="How should they be split?"
                rows={4}
                value={criteria}
                disabled={busy}
                onChange={(e) => onChange({ criteria: e.target.value })}
              />

              <label className={`jira-batchform-check${canReadCodebase ? "" : " disabled"}`}>
                <input
                  type="checkbox"
                  id="jira-batch-readcode"
                  checked={readCodebase}
                  disabled={busy || !canReadCodebase}
                  onChange={(e) => onChange({ readCodebase: e.target.checked })}
                />
                <span>Read the codebase first</span>
              </label>
              <div className="jira-batchform-hint">
                {aiHint ??
                  (readCodebase
                    ? "The AI looks at the files each ticket would touch before grouping. Slower, and much better at spotting two tickets that would collide."
                    : "Groups from the ticket text alone.")}
              </div>
            </>
          )}

          {error && (
            <div className="jira-batchform-error">
              {error}
              {fallback && (
                <button className="jira-linkish" onClick={onSubmitWithoutCodebase} disabled={busy}>
                  Analyze without reading the codebase
                </button>
              )}
              {aiFailed && !single && (
                <>
                  <button className="jira-linkish" onClick={onGroupByFields} disabled={busy}>
                    Group by epic, component and label
                  </button>
                  <button className="jira-linkish" onClick={onKeepTogether} disabled={busy}>
                    Keep them together in one cluster
                  </button>
                </>
              )}
            </div>
          )}
          {busy && <div className="jira-batchform-busy">{busyLabel}</div>}
        </div>

        <div className="jira-pop-actions">
          {/* Enabled while analyzing too: a codebase read can run for minutes,
              and cancelling drops its answer rather than making a batch. */}
          <button className="jira-selaction" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="jira-selaction primary"
            onClick={onSubmit}
            // Pasted-but-not-yet-resolved text counts: submitting resolves it,
            // which is the whole point of resolving on submit as well as on
            // blur. Disabling here would make that path unreachable.
            disabled={busy || (issues.length === 0 && keysText.trim() === "")}
          >
            {busy ? (single ? "Creating..." : "Analyzing...") : single ? "Create batch" : "Analyze"}
          </button>
        </div>
      </div>
    </Popover>
  );
}
