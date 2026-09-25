// Start work on several tickets at once: one branch, one worktree, one agent
// holding all of them.
//
// Only ever shown for more than one ticket. A single ticket keeps its
// one-click path, because there the branch template has exactly one answer
// and nothing to disambiguate; with three tickets the template can only be
// applied to one of them, which is wrong often enough to be worth a field.
import { useEffect } from "react";
import Icon from "./Icon";
import { usePopoverPosition, type PopoverAnchor } from "./usePopoverPosition";
import type { AgentLaunchPreset } from "./agentTarget";
import type { IssueRow } from "./types";
import Popover from "./Popover";

export interface StartWorkFormProps {
  issues: IssueRow[];
  anchor: PopoverAnchor;
  branch: string;
  presets: AgentLaunchPreset[];
  // An index into `presets`, or -1 for "no agent".
  presetIndex: number;
  busy: boolean;
  error: string | null;
  // The resolved worktree path for the branch as typed, so the field is not
  // the only thing telling you where this will land.
  location: string;
  onChange: (patch: { branch?: string; presetIndex?: number }) => void;
  onSubmit: () => void;
  onCancel: () => void;
}

export default function StartWorkForm({
  issues,
  anchor,
  branch,
  presets,
  presetIndex,
  busy,
  error,
  location,
  onChange,
  onSubmit,
  onCancel,
}: StartWorkFormProps) {
  const { ref, style } = usePopoverPosition<HTMLDivElement>(anchor, [error, presets.length]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <Popover>
      <div ref={ref} className="jira-popover jira-startform" role="dialog" style={style}>
        <div className="jira-pop-head">
          <span className="jira-facets-title">
            Start work &middot; {issues.length} tickets
          </span>
          <button className="icon-button" title="Close" onClick={onCancel}>
            <Icon name="close" />
          </button>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit();
          }}
        >
          <label className="jira-field">
            <span className="jira-pop-section">Branch</span>
            <input
              className="jira-input"
              value={branch}
              autoFocus
              spellCheck={false}
              onChange={(e) => onChange({ branch: e.target.value })}
            />
          </label>
          <div className="jira-location" title={location}>
            {location}
          </div>

          <label className="jira-field">
            <span className="jira-pop-section">Agent</span>
            <select
              className="jira-input"
              value={presetIndex}
              onChange={(e) => onChange({ presetIndex: Number(e.target.value) })}
            >
              {presets.map((preset, i) => (
                <option key={preset.name} value={i}>
                  {preset.name}
                </option>
              ))}
              <option value={-1}>No agent (worktree only)</option>
            </select>
          </label>

          <div className="jira-startkeys">
            {issues.map((issue) => (
              <span key={issue.key} className="jira-key">
                {issue.key}
              </span>
            ))}
          </div>

          {/* A 409 means the branch is taken, and the field holding it is right
              there - so the form stays open rather than closing on the error. */}
          {error && <div className="jira-error">{error}</div>}

          <div className="jira-formactions">
            <button type="button" className="jira-selaction" onClick={onCancel}>
              Cancel
            </button>
            <button type="submit" className="jira-selaction primary" disabled={busy || !branch.trim()}>
              {busy ? "Starting..." : "Start"}
            </button>
          </div>
        </form>
      </div>
    </Popover>
  );
}
