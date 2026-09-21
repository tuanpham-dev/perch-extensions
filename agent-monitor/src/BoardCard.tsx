// One agent window on the AGENTS board. Presentational: the board owns the
// drag, the menu and the poll; a card reports a press, an open and a
// menu request, and draws whatever drag state it is handed.
import type { PointerEvent as ReactPointerEvent, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from "react";
import Icon from "./Icon";
import { labelOf, markOf, relativeTime, summaryOf, type BoardAgent } from "./boardModel";
import type { PressSource } from "./BoardView";

interface Props {
  row: BoardAgent;
  now: number;
  // In status grouping a card has to say which project it is from; in
  // project grouping its column already does.
  showProject: boolean;
  dragOffset: { x: number; y: number } | null;
  // Dragged somewhere it cannot be dropped: outside its own column.
  refused: boolean;
  returning: boolean;
  dropBefore: boolean;
  onPointerDown: (event: ReactPointerEvent<HTMLElement>, row: BoardAgent, source: PressSource) => void;
  onOpen: (row: BoardAgent) => void;
  // fromPointer: a right-click (or a touch's native long-press menu), as
  // opposed to the keyboard's menu key.
  onMenu: (row: BoardAgent, x: number, y: number, fromPointer: boolean) => void;
}

function AgentMark({ row }: { row: BoardAgent }) {
  const mark = markOf(row);
  // The PROJECTS-row badge classes, so the board and the tree draw a state
  // the same way and a theme's --agent-monitor-* overrides reach both.
  return (
    <span className={`agent-board-mark agent-monitor-badge-${mark}`} aria-hidden="true">
      {mark === "waiting" ? "?" : "●"}
    </span>
  );
}

function AgentIcon({ row }: { row: BoardAgent }) {
  if (row.iconUrl) return <img className="agent-board-agent-icon" src={row.iconUrl} alt="" draggable={false} />;
  return <Icon name={row.icon || "hubot"} className="agent-board-agent-icon" />;
}

export default function BoardCard({
  row,
  now,
  showProject,
  dragOffset,
  refused,
  returning,
  dropBefore,
  onPointerDown,
  onOpen,
  onMenu,
}: Props) {
  const mark = markOf(row);
  const label = labelOf(row, mark);
  const summary = summaryOf(row);
  const time = relativeTime(row.lastActivityAt, now);

  const onContextMenu = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    onMenu(row, event.clientX, event.clientY, true);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    // The menu key and Shift+F10: the keyboard's right-click, opened at the
    // card since there is no pointer to open it at.
    if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      event.preventDefault();
      const rect = event.currentTarget.getBoundingClientRect();
      onMenu(row, rect.left + 12, rect.top + rect.height / 2, false);
    }
  };

  const classes = [
    "agent-board-card",
    `agent-board-card-${mark}`,
    dragOffset ? "agent-board-card-dragging" : "",
    dragOffset && refused ? "agent-board-card-refused" : "",
    returning ? "agent-board-card-returning" : "",
    dropBefore ? "agent-board-card-drop-before" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const where = [showProject ? row.project : "", row.branch ?? ""].filter(Boolean);

  return (
    <button
      type="button"
      className={classes}
      data-pane-id={row.paneId}
      style={dragOffset ? { transform: `translate(${dragOffset.x}px, ${dragOffset.y}px)` } : undefined}
      title={[label, summary, row.cwd].filter(Boolean).join("\n")}
      aria-label={`${row.agentLabel}, ${row.project}${row.branch ? ` ${row.branch}` : ""}, ${label}${summary ? `, ${summary}` : ""}`}
      onPointerDown={(event) => onPointerDown(event, row, "card")}
      onClick={() => onOpen(row)}
      onContextMenu={onContextMenu}
      onKeyDown={onKeyDown}
    >
      <span className="agent-board-card-top">
        <AgentIcon row={row} />
        <span className="agent-board-agent">{row.agentLabel}</span>
        {time && <span className="agent-board-time">{time}</span>}
        {/* A finger drags from here and only here - see BoardView's drag
            notes. A mouse can drag from anywhere, so this is also just a
            visible hint that cards move. */}
        <span
          className="agent-board-grip"
          aria-hidden="true"
          onPointerDown={(event) => {
            event.stopPropagation();
            onPointerDown(event, row, "grip");
          }}
        >
          <Icon name="gripper" />
        </span>
      </span>
      {where.length > 0 && (
        <span className="agent-board-where">
          {showProject && <span className="agent-board-project">{row.project}</span>}
          {showProject && row.branch && <span className="agent-board-sep"> · </span>}
          {row.branch && (
            <span className={row.linked ? "agent-board-branch agent-board-branch-linked" : "agent-board-branch"}>
              {row.branch}
            </span>
          )}
        </span>
      )}
      <span className="agent-board-status">
        <AgentMark row={row} />
        <span className="agent-board-summary">{summary || label}</span>
      </span>
      <span className="agent-board-window">
        {row.sessionName} · {row.windowName}
      </span>
    </button>
  );
}
