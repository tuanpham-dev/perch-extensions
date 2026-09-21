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
  busy: boolean;
  onStart: (anchor: PopoverAnchor) => void;
  onAdd: (x: number, y: number) => void;
  onClear: () => void;
}

export default function SelectionBar({ count, busy, onStart, onAdd, onClear }: SelectionBarProps) {
  return (
    <div className="jira-selectionbar">
      <div className="jira-selhead">
        <span className="jira-selcount">{count} selected</span>
        <button className="jira-linkish" onClick={onClear}>
          Clear
        </button>
      </div>
      <div className="jira-selactions">
        <button
          className="jira-selaction"
          disabled={busy}
          title="Hand these tickets to a worktree that already exists"
          onClick={(e) => onAdd(e.clientX, e.clientY)}
        >
          Add to worktree
        </button>
        <button
          className="jira-selaction primary"
          disabled={busy}
          title="Create one worktree for these tickets"
          onClick={(e) => onStart(anchorOf(e.currentTarget))}
        >
          Start work
        </button>
      </div>
    </div>
  );
}
