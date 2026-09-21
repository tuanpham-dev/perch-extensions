// The editor tab's board: tickets laid out in columns by status, and - with
// group by project on - in one swimlane per project.
//
// A picture of where tickets are, not a way to move them: cards can't be
// dragged, so no stray drag can transition a ticket in Jira. A card opens the
// ticket in the detail pane, and Ctrl/Cmd-click or its checkbox adds it to the
// same selection the table uses, so Start work and Add to worktree act on
// board picks too.
//
// On a phone there is no Ctrl key and no hover to reveal a checkbox, so the
// list's own touch idiom applies: a long-press starts a selection, and while
// anything is picked (or select mode is on) a tap toggles instead of opening.
//
// Props only - client.tsx imports this file, so reading the store from here
// would close a cycle.
import { useEffect, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import Icon from "./Icon";
import { initials } from "./format";
import { useLongPressMenu } from "./useLongPressMenu";
import type { ResolvedColumn } from "./boardModel";
import type { IssueGroup } from "./groupModel";
import type { IssueRow } from "./types";

export interface BoardProps {
  // Resolved from every ticket on the board, so each swimlane shows the same
  // columns in the same order.
  columns: ResolvedColumn[];
  lanes: IssueGroup[] | null;
  selection: ReadonlySet<string>;
  // Select mode on, or anything already picked: a tap selects rather than
  // opens, and every card shows its checkbox.
  picking: boolean;
  focusedKey: string | null;
  collapsedLanes: ReadonlySet<string>;
  onOpen: (issue: IssueRow) => void;
  onToggleSelected: (issue: IssueRow) => void;
  onToggleLane: (key: string) => void;
}

function Card({
  issue,
  picked,
  picking,
  showStatus,
  open,
  onOpen,
  onToggleSelected,
  bindLongPress,
}: {
  issue: IssueRow;
  picked: boolean;
  picking: boolean;
  // When the column gathers several statuses, the card says which one it is
  // in - the column title alone can't.
  showStatus: boolean;
  open: boolean;
  onOpen: (issue: IssueRow) => void;
  onToggleSelected: (issue: IssueRow) => void;
  bindLongPress: ReturnType<typeof useLongPressMenu>;
}) {
  const onClick = (e: ReactMouseEvent) => {
    if (e.ctrlKey || e.metaKey || picking) onToggleSelected(issue);
    else onOpen(issue);
  };
  return (
    <div
      className={`jira-card${picked ? " picked" : ""}${open ? " open" : ""}`}
      role="button"
      tabIndex={0}
      draggable={false}
      title={issue.summary}
      onClick={onClick}
      {...bindLongPress(() => onToggleSelected(issue))}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(issue);
        }
      }}
    >
      <div className="jira-card-top">
        <input
          type="checkbox"
          className="jira-check"
          checked={picked}
          aria-label={`Select ${issue.key}`}
          onClick={(e) => e.stopPropagation()}
          onChange={() => onToggleSelected(issue)}
        />
        <span className="jira-key">{issue.key}</span>
        {issue.assignee && (
          <span className="jira-avatar" title={issue.assignee}>
            {initials(issue.assignee)}
          </span>
        )}
      </div>
      <div className="jira-card-title">{issue.summary}</div>
      <div className="jira-card-meta">
        {showStatus && (
          <span className="jira-chip" data-cat={issue.statusCategory ?? "unknown"}>
            {issue.status}
          </span>
        )}
        {issue.type && <span>{issue.type}</span>}
        {issue.priority && <span>{issue.priority}</span>}
      </div>
    </div>
  );
}

// One column's cards. `issues` is that column's share of whichever tickets
// are being laid out - the whole board, or one lane.
// The pinned space a column's cards can use: from just under the headings to
// the bottom of the board's scroll box.
interface StickyFrame {
  top: number;
  bottom: number;
}

// A column's cards, pinned so every one of them can be reached without
// scrolling past this column's own length.
//
// Every cell in a board row is as tall as the row's longest column, so a
// shorter column's stack has room to stick inside its cell. Where it sticks
// is the point: a stack pinned to the TOP kept a column taller than the screen
// showing only its first cards until the longest column ran out, so reaching
// its last card meant scrolling to the very end of the board. Instead the
// stack scrolls normally until its last card is in view, then holds there
// while longer columns carry on - which is a sticky `top` of (visible height -
// stack height), negative for a tall stack. A stack that fits on screen just
// pins under the headings, as before.
function Stack({ frame, children }: { frame: StickyFrame; children: ReactNode }) {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [height, setHeight] = useState(0);
  useEffect(() => {
    if (!el) return;
    const measure = () => setHeight(el.getBoundingClientRect().height);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [el]);
  const top = Math.min(frame.top, frame.bottom - height);
  return (
    <div className="jira-col-stack" ref={setEl} style={{ top }}>
      {children}
    </div>
  );
}

function ColumnBody({
  column,
  issues,
  props,
  frame,
  bindLongPress,
}: {
  column: ResolvedColumn;
  issues: IssueRow[];
  props: BoardProps;
  frame: StickyFrame;
  bindLongPress: ReturnType<typeof useLongPressMenu>;
}) {
  const showStatus = column.statuses.length > 1;
  return (
    <div className="jira-col-body" data-color={column.color ?? undefined}>
      <Stack frame={frame}>
      {issues.map((issue) => (
        <Card
          key={issue.key}
          issue={issue}
          picked={props.selection.has(issue.key)}
          picking={props.picking}
          showStatus={showStatus}
          open={props.focusedKey === issue.key}
          onOpen={props.onOpen}
          onToggleSelected={props.onToggleSelected}
          bindLongPress={bindLongPress}
        />
      ))}
      </Stack>
    </div>
  );
}

function inColumn(column: ResolvedColumn, issues: readonly IssueRow[]): IssueRow[] {
  const statuses = new Set(column.statuses);
  return issues.filter((issue) => statuses.has(issue.status));
}

export default function Board(props: BoardProps) {
  const { columns, lanes, collapsedLanes, onToggleLane } = props;
  // One hook for every card: it runs once, and bind() is called per card.
  const bindLongPress = useLongPressMenu();

  // The sticky card stacks pin just under the column headings, so they need
  // the headings' real height - it changes with the theme's font size and
  // with colour bars. Measured through a callback ref: the board renders
  // after the tab's loading state, and a mount-time effect on a ref object
  // would never see it.
  const [head, setHead] = useState<HTMLDivElement | null>(null);
  const [headHeight, setHeadHeight] = useState(34);
  useEffect(() => {
    if (!head) return;
    const measure = () => setHeadHeight(Math.round(head.getBoundingClientRect().height));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(head);
    return () => observer.disconnect();
  }, [head]);

  // The scroll box's visible height, which is where a tall column's last
  // card is held once it comes into view.
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const [visibleHeight, setVisibleHeight] = useState(0);
  useEffect(() => {
    if (!scroller) return;
    const measure = () => setVisibleHeight(scroller.clientHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [scroller]);
  // 6px of breathing room at both ends, matching the column's own padding.
  const frame: StickyFrame = { top: headHeight + 6, bottom: visibleHeight - 6 };

  if (columns.length === 0) return <div className="jira-empty">No tickets on the board.</div>;

  return (
    <div
      ref={setScroller}
      className={`jira-board${props.picking ? " picking" : ""}`}
      style={{ ["--jira-cols" as string]: String(columns.length), ["--jira-board-head-h" as string]: `${headHeight}px` }}
    >
      <div className="jira-board-head" ref={setHead}>
        {columns.map((column) => (
          <div
            key={column.id}
            className={`jira-col-head${column.configured ? "" : " leftover"}`}
            data-color={column.color ?? undefined}
            title={column.configured ? column.statuses.join(", ") : "Not in any configured column"}
          >
            <span className="jira-col-name">{column.name}</span>
            <span className="jira-count">{lanes ? lanes.reduce((n, lane) => n + inColumn(column, lane.issues).length, 0) : column.issues.length}</span>
          </div>
        ))}
      </div>

      {lanes ? (
        lanes.map((lane) => {
          const shut = collapsedLanes.has(lane.key);
          return (
            <section key={lane.key} className="jira-lane">
              <button className="jira-group-head jira-lane-head" aria-expanded={!shut} onClick={() => onToggleLane(lane.key)}>
                <Icon name={shut ? "chevron-right" : "chevron-down"} />
                <span className="jira-key">{lane.key}</span>
                {lane.name !== lane.key && <span className="jira-group-name">{lane.name}</span>}
                <span className="jira-count">{lane.issues.length}</span>
              </button>
              {!shut && (
                <div className="jira-board-row">
                  {columns.map((column) => (
                    <ColumnBody
                      key={column.id}
                      column={column}
                      frame={frame}
                      issues={inColumn(column, lane.issues)}
                      props={props}
                      bindLongPress={bindLongPress}
                    />
                  ))}
                </div>
              )}
            </section>
          );
        })
      ) : (
        <div className="jira-board-row">
          {columns.map((column) => (
            <ColumnBody
              key={column.id}
              column={column}
              frame={frame}
              issues={column.issues}
              props={props}
              bindLongPress={bindLongPress}
            />
          ))}
        </div>
      )}
    </div>
  );
}
