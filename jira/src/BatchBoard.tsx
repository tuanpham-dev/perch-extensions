// The batch at work: every ticket as a card in the column of whatever its
// agent last reported, and a chip per cluster that both says how that agent
// is doing and filters the board down to it.
//
// The chips carry two jobs on purpose. "Which cluster is waiting on me" and
// "show me only that cluster" are the same question asked twice, and a
// separate filter control beside a separate status row would have said the
// same thing in two places.
import { useEffect, useState } from "react";
import Icon from "./Icon";
import { clusterChips, columns, feedbackPending, missingQa, sinceLabel, skillsLabel } from "./batchViewModel";
import type { Batch, BatchSummary, ClusterAction, ClusterStateName } from "./batchTypes";
import type { MenuItem } from "./types";

export interface BatchBoardProps {
  batch: Batch;
  batches: BatchSummary[];
  archived: BatchSummary[];
  busy: boolean;
  focusedKey: string | null;
  clusterFilter: ReadonlySet<string>;
  showMenu?: (x: number, y: number, items: MenuItem[]) => void;
  onPickBatch: (id: string) => void;
  onToggleCluster: (clusterId: string) => void;
  onClearFilter: () => void;
  onFocus: (key: string) => void;
  onClusterAction: (clusterId: string, action: ClusterAction) => void;
  onSendFeedback: () => void;
  onArchive: () => void;
  onUnarchive: (id: string) => void;
  onDelete: () => void;
  onPlanMore: () => void;
  onOpenReport: (path: string) => void;
  onRebuildReport: (clusterId: string) => void;
}

const STATE_LABEL: Record<ClusterStateName, string> = {
  pending: "not started",
  running: "running",
  waiting: "waiting on you",
  idle: "idle",
  stopped: "stopped",
  closed: "closed",
};

const ACTION_LABEL: Record<ClusterAction, string> = {
  start: "Start this cluster",
  open: "Open terminal",
  stop: "Stop the agent",
  resume: "Resume the agent",
  close: "Close and keep the worktree",
  "remove-worktree": "Remove the worktree",
};

export default function BatchBoard({
  batch,
  batches,
  archived,
  busy,
  focusedKey,
  clusterFilter,
  showMenu,
  onPickBatch,
  onToggleCluster,
  onClearFilter,
  onFocus,
  onClusterAction,
  onSendFeedback,
  onArchive,
  onUnarchive,
  onDelete,
  onPlanMore,
  onOpenReport,
  onRebuildReport,
}: BatchBoardProps) {
  // Only so the "6 min" on a card keeps up; every real change arrives on the
  // event stream, so this ticks slowly and never fetches anything.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 20_000);
    return () => clearInterval(timer);
  }, []);

  const [showArchived, setShowArchived] = useState(false);
  const chips = clusterChips(batch);
  const board = columns(batch, clusterFilter);
  const pending = feedbackPending(batch);

  const clusterMenu = (id: string, actions: ClusterAction[], x: number, y: number) => {
    if (!showMenu) return;
    const cluster = batch.clusters.find((entry) => entry.id === id);
    const items: MenuItem[] = actions.map((action) => ({
      label: ACTION_LABEL[action],
      danger: action === "stop" || action === "remove-worktree",
      onClick: () => onClusterAction(id, action),
    }));
    // The report outlives the worktree and the session, so these are offered
    // whatever state the cluster is in - a closed cluster is exactly when you
    // want to read what it produced.
    if (cluster?.qaReportPath) {
      items.push({ label: "Open QA report", onClick: () => onOpenReport(cluster.qaReportPath) });
    }
    items.push({ label: "Rebuild QA report", onClick: () => onRebuildReport(id) });
    if (items.length === 0) return;
    showMenu(x, y, items);
  };

  return (
    <div className="jira-batchboard">
      <div className="jira-bboard-bar">
        <label className="jira-bboard-pick">
          <span>Batch</span>
          <select value={batch.id} disabled={busy} onChange={(e) => onPickBatch(e.target.value)}>
            {batches.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
            {/* The open batch may itself be archived (reopened from the list
                below), and a select whose value is not among its options
                shows blank. */}
            {!batches.some((entry) => entry.id === batch.id) && <option value={batch.id}>{batch.name}</option>}
          </select>
        </label>

        <div className="jira-bchips" role="group" aria-label="Filter by cluster">
          {chips.map((chip) => {
            const on = clusterFilter.size === 0 || clusterFilter.has(chip.id);
            const cluster = batch.clusters.find((entry) => entry.id === chip.id)!;
            return (
              <button
                key={chip.id}
                className={`jira-bchip jira-bcol-c${chip.color % 8} state-${chip.state}${on ? "" : " off"}`}
                aria-pressed={clusterFilter.has(chip.id)}
                title={[
                  `${chip.name} - ${chip.awaiting ?? STATE_LABEL[chip.state]}${cluster.branch ? ` (${cluster.branch})` : ""}`,
                  // What it actually started with, so a report that reads
                  // oddly can be traced to the procedure that produced it.
                  skillsLabel(cluster.skills),
                  "Click to show only this cluster; right-click for what you can do with it.",
                ]
                  .filter(Boolean)
                  .join("\n")}
                onClick={() => onToggleCluster(chip.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  clusterMenu(chip.id, cluster.actions, e.clientX, e.clientY);
                }}
              >
                <span className="jira-bchip-dot" />
                <span className="jira-bchip-name">{chip.name}</span>
                <span className="jira-bchip-state">{STATE_LABEL[chip.state]}</span>
                {cluster.actions.includes("start") ? (
                  <span
                    className="jira-bchip-go"
                    role="button"
                    tabIndex={0}
                    title="Start this cluster"
                    onClick={(e) => {
                      e.stopPropagation();
                      onClusterAction(chip.id, "start");
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        // Space scrolls the board unless it is claimed here.
                        e.preventDefault();
                        e.stopPropagation();
                        onClusterAction(chip.id, "start");
                      }
                    }}
                  >
                    Start
                  </span>
                ) : (
                  <span
                    className="jira-bchip-go"
                    role="button"
                    tabIndex={0}
                    title="What you can do with this cluster"
                    onClick={(e) => {
                      e.stopPropagation();
                      clusterMenu(chip.id, cluster.actions, e.clientX, e.clientY);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        e.stopPropagation();
                        const rect = (e.target as HTMLElement).getBoundingClientRect();
                        clusterMenu(chip.id, cluster.actions, rect.left, rect.bottom);
                      }
                    }}
                  >
                    <Icon name="ellipsis" />
                  </span>
                )}
              </button>
            );
          })}
          {clusterFilter.size > 0 && (
            <button className="jira-linkish" onClick={onClearFilter}>
              Show all
            </button>
          )}
        </div>

        <span className="jira-bboard-spacer" />

        <button className="jira-selaction" disabled={busy} onClick={onPlanMore} title="Add more tickets to this batch">
          Add tickets...
        </button>
        <button
          className="jira-selaction primary"
          disabled={busy || pending.tickets === 0}
          title={
            pending.tickets === 0
              ? "Write feedback on a reviewed ticket first"
              : `Send ${pending.tickets} ticket${pending.tickets === 1 ? "" : "s"} back to ${pending.clusters} agent${pending.clusters === 1 ? "" : "s"}`
          }
          onClick={onSendFeedback}
        >
          Send feedback{pending.tickets > 0 ? ` (${pending.tickets})` : ""}
        </button>
        <button
          className="icon-button"
          title="More"
          disabled={busy}
          onClick={(e) => {
            if (!showMenu) return;
            // Enter or Space gives a click at 0,0, which would open the
            // menu in the corner of the window; fall back to the button.
            const box = e.currentTarget.getBoundingClientRect();
            const x = e.clientX || box.left;
            const y = e.clientY || box.bottom;
            showMenu(x, y, [
              { label: "Archive this batch", onClick: onArchive },
              // Only when there is something to show: an item whose click
              // does nothing reads as a bug, and saying which way it will go
              // beats a label that never changes.
              ...(archived.length > 0
                ? [
                    {
                      label: showArchived ? `Hide archived batches (${archived.length})` : `Show archived batches (${archived.length})`,
                      onClick: () => setShowArchived(!showArchived),
                    },
                  ]
                : []),
              { label: "", onClick: () => {}, separator: true },
              { label: "Delete this batch", danger: true, onClick: onDelete },
            ]);
          }}
        >
          <Icon name="ellipsis" />
        </button>
      </div>

      {showArchived && archived.length > 0 && (
        <div className="jira-bboard-archived">
          <span>Archived:</span>
          {archived.map((entry) => (
            <button key={entry.id} className="jira-linkish" onClick={() => onUnarchive(entry.id)}>
              {entry.name}
            </button>
          ))}
        </div>
      )}

      <div className="jira-bboard-cols">
        {board.map((column) => (
          <section
            key={column.state}
            className={`jira-bbcol state-${column.state}${column.cards.length === 0 ? " is-empty" : ""}`}
          >
            <header className="jira-bbcol-head">
              <span className="jira-bbcol-title">{column.label}</span>
              <span className="jira-bbcol-count">{column.cards.length}</span>
            </header>
            <ul className="jira-bbcards">
              {column.cards.map((card) => (
                <li key={card.key}>
                  <button
                    className={`jira-bbcard jira-bcol-c${card.color < 0 ? "none" : card.color % 8}${focusedKey === card.key ? " focused" : ""}`}
                    onClick={() => onFocus(card.key)}
                  >
                    <span className="jira-bbcard-top">
                      <span className="jira-key">{card.key}</span>
                      <span className="jira-bbcard-age">{sinceLabel(card.since, now)}</span>
                    </span>
                    <span className="jira-bbcard-summary">{card.summary}</span>
                    <span className="jira-bbcard-foot">
                      {/* Only when there is more than one: on a single-cluster
                          batch the same long name on every card is noise, and
                          the colour bar already says which cluster it is. */}
                      {batch.clusters.length > 1 && <span className="jira-bbcard-cluster">{card.clusterName}</span>}
                      {card.feedbackPending && (
                        <span className="jira-bbcard-flag" title="Feedback written, not sent yet">
                          feedback ready
                        </span>
                      )}
                      {card.qa && (
                        <span className={`jira-bbcard-qa qa-${card.qa}`} title={`QA: ${card.qa}`}>
                          QA {card.qa}
                        </span>
                      )}
                      {missingQa(card) && (
                        <span className="jira-bbcard-qa qa-none" title="Finished without a QA report">
                          no QA report
                        </span>
                      )}
                    </span>
                    {card.note && <span className="jira-bbcard-note">{card.note}</span>}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
