// What to do with the tickets that are ticked, in a sidebar pane.
//
// An ordinary row at the top of the panel, never a fixed overlay: on touch
// the bottom of the sidebar already belongs to the one-hand extension's
// strip, and a floating bar there would be covered by it and have its taps
// swallowed.
//
// Two rows rather than one: at sidebar width the count and two labelled
// buttons do not fit on a line, and letting them share one made the buttons
// paint over "1 selected". The count and Clear sit on top, and the two
// actions split the row beneath evenly, so neither can crowd the other out.
//
// It renders in every pane holding a selected ticket, so the actions are
// wherever you are looking. The count is the whole selection, which is why a
// ticket listed in both panes reads the same in each. The editor tab does not
// use this bar - it puts the same actions on the right of its scope bar.
import { anchorOf, type PopoverAnchor } from "./usePopoverPosition";

export interface SelectionBarProps {
  count: number;
  // How many rows this pane is showing, so "Select all" can say what it will
  // take and can hide itself once everything is already ticked.
  total: number;
  busy: boolean;
  onStart: (anchor: PopoverAnchor) => void;
  onAdd: (x: number, y: number) => void;
  onSelectAll: () => void;
  onPlanBatch: (anchor: PopoverAnchor, x: number, y: number) => void;
  onClear: () => void;
}

export default function SelectionBar({
  count,
  total,
  busy,
  onStart,
  onAdd,
  onSelectAll,
  onPlanBatch,
  onClear,
}: SelectionBarProps) {
  return (
    <div className="jira-selectionbar">
      <div className="jira-selhead">
        <span className="jira-selcount">{count} selected</span>
        {/* Two links rather than one toggle: "Select all" reads as an action,
            and a toggle would have to explain which of the two lists it
            meant. It disappears when there is nothing left to add. */}
        {count < total && (
          <button className="jira-linkish" onClick={onSelectAll} title={`Select the ${total} tickets in this list`}>
            Select all
          </button>
        )}
        {/* Offered even at zero, since the bar now appears with selection
            mode rather than with the first tick - but it cannot do anything
            yet, and a live-looking control that no-ops is worse than a
            dimmed one. */}
        <button className="jira-linkish" disabled={count === 0} onClick={onClear}>
          Deselect all
        </button>
      </div>
      <div className="jira-selactions">
        <button
          className="jira-selaction"
          disabled={busy || count === 0}
          title="Hand these tickets to a worktree that already exists"
          onClick={(e) => onAdd(e.clientX, e.clientY)}
        >
          Add to worktree
        </button>
        <button
          className="jira-selaction primary"
          disabled={busy || count === 0}
          title="Create one worktree for these tickets"
          onClick={(e) => onStart(anchorOf(e.currentTarget))}
        >
          Start work
        </button>
      </div>
      {/* Its own row: planning a batch is a different scale of action from
          the two above - several worktrees, several agents - and sharing
          their row would have read as a third way to start one worktree. */}
      <div className="jira-selactions">
        <button
          className="jira-selaction"
          disabled={busy || count === 0}
          title="Split these tickets into clusters and work them in parallel"
          onClick={(e) => onPlanBatch(anchorOf(e.currentTarget), e.clientX, e.clientY)}
        >
          Plan batch...
        </button>
      </div>
    </div>
  );
}
