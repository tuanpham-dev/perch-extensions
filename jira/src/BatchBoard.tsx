// The batch at work: every ticket as a card in the column of whatever its
// agent last reported, and a chip per cluster that both says how that agent
// is doing and filters the board down to it.
//
// The chips carry two jobs on purpose. "Which cluster is waiting on me" and
// "show me only that cluster" are the same question asked twice, and a
// separate filter control beside a separate status row would have said the
// same thing in two places.
import HandoffPanel from "./HandoffPanel";
import KeyLink from "./KeyLink";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import Icon from "./Icon";
import { clusterChips, columns, feedbackPending, missingQa, sinceLabel, skillsLabel, qaColumns, qaQueue, shipBlockers, handoffPending } from "./batchViewModel";
import type { Batch, BatchSummary, ClusterAction, ClusterStateName, HandoffConfig } from "./batchTypes";
import type { Facets, MenuItem } from "./types";

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
  onRenameCluster: (clusterId: string) => void;
  onRenameBatch: () => void;
  // Back to the review, where clusters are named, moved and split. Null when
  // nothing is still pending - there is nothing left to arrange.
  onReview: (() => void) | null;
  onSendFeedback: () => void;
  onArchive: () => void;
  onUnarchive: (id: string) => void;
  onDelete: () => void;
  onPlanMore: () => void;
  onOpenReport: (path: string) => void;
  onRebuildReport: (clusterId: string) => void;
  // The QA branch: start its agent, merge one ticket onto it, ship it, hand
  // the batch to Jira, and reach the agent's terminal.
  onStartQa: () => void;
  onMergeTicket: (key: string) => void;
  onShipQa: () => void;
  onHandoff: () => void;
  // Saves this batch's hand-off status, assignee or preview URL.
  onHandoffConfig: (config: Partial<HandoffConfig>) => void;
  // Jira's statuses and people, offered as suggestions in the hand-off form.
  facets: Facets | null;
  onOpenQaTerminal: () => void;
}

const STATE_LABEL: Record<ClusterStateName, string> = {
  pending: "not started",
  starting: "starting",
  running: "running",
  waiting: "waiting on you",
  idle: "idle",
  stopped: "stopped",
  closed: "closed",
};

// What a starting cluster is doing, on its chip in every open tab.
const START_STEP: Record<string, string> = {
  worktree: "creating worktree",
  session: "starting agent",
};

// Why Merge to production is disabled: tickets not approved yet, and ones
// approved or excluded whose amend or drop the QA agent hasn't confirmed.
function shipBlockMessage(batch: Batch, blockers: string[]): string {
  const waiting = blockers.filter((key) => batch.ticketStates[key].integration?.pending);
  const open = blockers.filter((key) => !waiting.includes(key));
  const parts: string[] = [];
  if (open.length > 0) parts.push(`Not everything is approved: ${open.join(", ")}`);
  if (waiting.length > 0) parts.push(`Waiting for the QA agent to confirm the git work on ${waiting.join(", ")}`);
  return parts.join(". ");
}

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
  onRenameCluster,
  onRenameBatch,
  onReview,
  onSendFeedback,
  onArchive,
  onUnarchive,
  onDelete,
  onPlanMore,
  onOpenReport,
  onRebuildReport,
  onStartQa,
  onMergeTicket,
  onShipQa,
  onHandoff,
  onHandoffConfig,
  facets,
  onOpenQaTerminal,
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
  // Once QA is running the board shows the queue instead of the cluster
  // columns: by then every ticket is reviewed or nearly so, and the question
  // is no longer "what is each agent on" but "what have I looked at".
  const qa = batch.qa ?? null;
  const qaLive = qa !== null && qa.state !== "idle";
  const queue = qaQueue(batch);
  const blockers = shipBlockers(batch);
  const approvedCount = Object.values(batch.ticketStates).filter((t) => t.integration?.state === "approved").length;
  const owed = handoffPending(batch);
  const rounds = batch.qaRounds ?? [];
  const qaBoard = qaLive ? qaColumns(batch).filter((column) => column.cards.length > 0 || ["queue", "verifying", "approved"].includes(column.id)) : [];
  const pending = feedbackPending(batch);
  const notices = batch.clusters.flatMap((cluster) => {
    const out: { clusterId: string; name: string; color: number; kind: "error" | "stopped" | "note"; text: string }[] = [];
    const base = { clusterId: cluster.id, name: cluster.name, color: cluster.color };
    if (cluster.lastError) out.push({ ...base, kind: "error", text: cluster.lastError });
    if (cluster.state === "stopped" && cluster.stoppedReason) out.push({ ...base, kind: "stopped", text: `stopped: ${cluster.stoppedReason}` });
    const note = cluster.notes?.[cluster.notes.length - 1];
    if (note && cluster.state !== "closed") out.push({ ...base, kind: "note", text: `said: ${note.text}` });
    return out;
  });

  // The row's lesser actions. They sit on the bar while it has room; once
  // the buttons would run past its edge (the detail pane open beside a
  // narrow board, say) they move into the More menu instead, so nothing is
  // cut off and the bar stays one row.
  const secondary: { key: string; label: string; title: string; disabled: boolean; onClick: () => void }[] = [];
  if (onReview) {
    secondary.push({ key: "clusters", label: "Clusters", title: "Name, move and split the clusters that have not started yet", disabled: busy, onClick: onReview });
  }
  secondary.push({ key: "add", label: "Add tickets...", title: "Add more tickets to this batch", disabled: busy, onClick: onPlanMore });
  if (!qaLive) {
    secondary.push({
      key: "start-qa",
      label: qa ? "Start QA again" : "Start QA",
      // A run that exists can always be started again: its agent may have
      // died with every reviewed ticket already on the branch.
      disabled: busy || (queue.length === 0 && !qa),
      title:
        qa && queue.length === 0
          ? `Start the QA agent again on ${qa.branch}${qa.lastError ? ` (last time: ${qa.lastError})` : ""}`
          : queue.length === 0
            ? "Nothing is in review yet - there would be nothing to merge"
            : qa?.lastError
              ? `Start the QA agent again (last time: ${qa.lastError})`
              : `Cut a QA branch and start an agent to merge the ${queue.length} reviewed ticket${queue.length === 1 ? "" : "s"} onto it`,
      onClick: onStartQa,
    });
  }
  if (qaLive) {
    secondary.push({ key: "qa-terminal", label: "QA terminal", title: `Open the QA agent's terminal (${qa.branch})`, disabled: busy || !qa.sessionName, onClick: onOpenQaTerminal });
  }
  if (qaLive && qa.state === "shipped") {
    secondary.push({
      key: "next-round",
      label: "Start another QA round",
      disabled: busy || queue.length === 0,
      title:
        queue.length === 0
          ? "Nothing new is reviewed - another round would have nothing to merge"
          : `Cut a fresh QA branch from production for the ${queue.length} ticket${queue.length === 1 ? "" : "s"} reviewed since`,
      onClick: onStartQa,
    });
  }

  // The main actions, which leave the row only when even without the lesser
  // ones it would not fit.
  const primary: typeof secondary = [];
  if (qaLive && qa.state === "running") {
    primary.push({
      key: "ship",
      label: qa.shipping ? "Merging to production..." : "Merge to production",
      disabled: busy || Boolean(qa.shipping) || blockers.length > 0 || approvedCount === 0,
      title: qa.shipping
        ? "The QA agent is merging into production - this clears when it reports shipped or stops with a note"
        : blockers.length > 0
          ? shipBlockMessage(batch, blockers)
          : approvedCount === 0
            ? "Nothing has been approved yet"
            : `Merge ${qa.branch} into ${qa.productionBranch}. Nothing is pushed.`,
      onClick: onShipQa,
    });
  }
  if (qa?.state === "shipped" || rounds.length > 0) {
    primary.push({
      key: "handoff",
      label: `Hand off to Jira${owed.length > 0 ? ` (${owed.length})` : ""}`,
      disabled: busy || owed.length === 0,
      title: owed.length === 0 ? "Every approved ticket has been handed off" : `Move ${owed.length} ticket${owed.length === 1 ? "" : "s"} to QA in Jira, assign and comment`,
      onClick: onHandoff,
    });
  }
  primary.push({
    key: "feedback",
    label: `Send feedback${pending.tickets > 0 ? ` (${pending.tickets})` : ""}`,
    disabled: busy || pending.tickets === 0,
    title:
      pending.tickets === 0
        ? "Write feedback on a reviewed ticket first"
        : `Send ${pending.tickets} ticket${pending.tickets === 1 ? "" : "s"} back to ${pending.clusters} agent${pending.clusters === 1 ? "" : "s"}`,
    onClick: onSendFeedback,
  });

  // How much of the row has moved into the More menu: 0 nothing, 1 the
  // lesser actions, 2 every action. One step at a time, as the row overflows.
  const barRef = useRef<HTMLDivElement>(null);
  const [folded, setFolded] = useState(0);
  // The bar's width at which each step last overflowed: a step comes back
  // only once the bar is at least that wide again, so it doesn't flip back
  // and forth at the edge.
  const neededWidth = useRef<number[]>([]);
  const rowKey = [...secondary, ...primary].map((entry) => entry.label).join("|");
  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const check = () => {
      if (folded < 2 && bar.scrollWidth > bar.clientWidth + 1) {
        neededWidth.current[folded] = bar.scrollWidth;
        setFolded(folded + 1);
      } else if (folded > 0 && bar.clientWidth >= (neededWidth.current[folded - 1] ?? Infinity)) {
        setFolded(folded - 1);
      }
    };
    check();
    const observer = new ResizeObserver(check);
    observer.observe(bar);
    return () => observer.disconnect();
  }, [folded, rowKey, chips.length]);
  // A different set of buttons needs measuring afresh.
  useEffect(() => {
    neededWidth.current = [];
    setFolded(0);
  }, [rowKey]);
  const compact = folded > 0;

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
    // Whatever state it is in: the name is a label for whoever reads the
    // board, and the branch it started on is shown beside it either way.
    items.push({ label: "Rename cluster...", onClick: () => onRenameCluster(id) });
    if (items.length === 0) return;
    showMenu(x, y, items);
  };

  return (
    <div className="jira-batchboard">
      <div className="jira-bboard-bar" ref={barRef}>
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
                <span className="jira-bchip-state">
                  {chip.state === "starting" ? `starting: ${START_STEP[cluster.startStep ?? ""] ?? "preparing"}` : STATE_LABEL[chip.state]}
                  {cluster.held && cluster.held.length > 0 ? " - message waiting to send" : ""}
                </span>
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

        {!compact &&
          secondary.map((entry) => (
            <button key={entry.key} className="jira-selaction" disabled={entry.disabled} title={entry.title} onClick={entry.onClick}>
              {entry.label}
            </button>
          ))}
        {folded < 2 &&
          primary.map((entry) => (
            <button key={entry.key} className="jira-selaction primary" disabled={entry.disabled} title={entry.title} onClick={entry.onClick}>
              {entry.label}
            </button>
          ))}
        <button
          className="icon-button"
          title={compact ? "More - the actions that don't fit on this row are here" : "More"}
          disabled={busy}
          onClick={(e) => {
            if (!showMenu) return;
            // Enter or Space gives a click at 0,0, which would open the
            // menu in the corner of the window; fall back to the button.
            const box = e.currentTarget.getBoundingClientRect();
            const x = e.clientX || box.left;
            const y = e.clientY || box.bottom;
            const moved: MenuItem[] = [...(folded >= 2 ? primary : []), ...(folded >= 1 ? secondary : [])]
              .filter((entry) => !entry.disabled)
              .map((entry) => ({ label: entry.label, onClick: entry.onClick }));
            showMenu(x, y, [
              ...moved,
              ...(moved.length > 0 ? [{ label: "", onClick: () => {}, separator: true }] : []),
              { label: "Rename this batch...", onClick: onRenameBatch },
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

      {/* What each cluster's agent said last, why it stopped, and what went
          wrong: stored on the server all along, and never shown before, so
          a stopped cluster only explained itself in its terminal. */}
      {notices.length > 0 && (
        <ul className="jira-bnotices">
          {notices.map((notice) => (
            <li key={`${notice.clusterId}-${notice.kind}`} className={`is-${notice.kind}`} title={notice.text}>
              <span className={`jira-bchip-dot jira-bcol-c${notice.color % 8}`} />
              <b>{notice.name}</b>
              <span className="jira-bnotice-text">{notice.text}</span>
            </li>
          ))}
        </ul>
      )}

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

      {(qa?.state === "shipped" || rounds.length > 0) && <HandoffPanel batch={batch} busy={busy} facets={facets} onSave={onHandoffConfig} />}
      {qaLive && (
        <div className="jira-bqa-strip" title={qa.awaiting ?? undefined}>
          <span className="jira-key">{qa.branch}</span>
          <span className="jira-bqa-sep">from {qa.productionBranch}</span>
          {qa.previewUrl && (
            <a className="jira-bqa-preview" href={qa.previewUrl} target="_blank" rel="noreferrer">
              {qa.previewUrl.replace(/^https?:\/\//, "")}
            </a>
          )}
          {qa.awaiting && <span className="jira-bqa-awaiting">QA agent: {qa.awaiting}</span>}
          {!qa.awaiting && qa.notes?.length > 0 && (
            <span className="jira-bqa-note" title={qa.notes.map((n) => n.text).join("\n\n")}>
              QA agent: {qa.notes[qa.notes.length - 1].text}
            </span>
          )}
          {qa.state === "shipped" && <span className="jira-bqa-shipped">merged into {qa.shippedInto}</span>}
          {rounds.length > 0 && (
            <span
              className="jira-bqa-rounds"
              title={rounds.map((round, i) => `Round ${i + 1}: ${round.branch} into ${round.shippedInto} - ${round.keys.join(", ") || "nothing approved"}`).join("\n")}
            >
              round {rounds.length + 1} - {rounds.length} earlier round{rounds.length === 1 ? "" : "s"} shipped
            </span>
          )}
        </div>
      )}
      <div className="jira-bboard-cols">
        {qaLive &&
          qaBoard.map((column) => (
            <section key={column.id} className={`jira-bbcol qa-${column.id}${column.cards.length === 0 ? " is-empty" : ""}`}>
              <header className="jira-bbcol-head">
                <span className="jira-bbcol-title">{column.label}</span>
                <span className="jira-bbcol-count">{column.cards.length}</span>
              </header>
              <ul className="jira-bbcards">
                {column.cards.map((card, i) => {
                  const color = `jira-bcol-c${card.color < 0 ? "none" : card.color % 8}`;
                  const canMerge = column.id === "queue" && qa.state === "running";
                  return (
                  // A card is a button, and a button cannot hold another one, so a
                  // card with a Merge action lends its frame to the list item and
                  // the action sits inside that frame, under the card's text.
                  <li key={card.key} className={canMerge ? `jira-bbcard-framed ${color}` : undefined}>
                    <KeyLink issueKey={card.key} url={batch.tickets[card.key]?.url} className="jira-bbcard-key" />
                    <button
                      className={`jira-bbcard ${color}${focusedKey === card.key ? " focused" : ""}`}
                      onClick={() => onFocus(card.key)}
                    >
                      <span className="jira-bbcard-top">
                        <span className="jira-key jira-bbcard-keyph">{card.key}</span>
                        {card.priority && <span className="jira-bbcard-age">{card.priority}</span>}
                      </span>
                      <span className="jira-bbcard-summary">{card.summary}</span>
                      {card.detail && <span className="jira-bbcard-detail">{card.detail}</span>}
                      <span className="jira-bbcard-foot">
                        {batch.clusters.length > 1 && <span className="jira-bbcard-cluster">{card.clusterName}</span>}
                        {card.integration === "fixing" && (
                          <span className="jira-bbcard-flag" title="A change was made in the QA worktree and is not committed until you approve">
                            fix uncommitted
                          </span>
                        )}
                        {card.integration === "merging" && <span className="jira-bbcard-flag">merging...</span>}
                        {card.integration === "approved" && <span className="jira-bbcard-qa qa-pass">done</span>}
                        {card.integration === "conflicted" && <span className="jira-bbcard-qa qa-fail">conflict</span>}
                      </span>
                    </button>
                    {canMerge && (
                      <button
                        className={`jira-selaction jira-bqa-merge${i === 0 ? " primary" : ""}`}
                        disabled={busy}
                        title={`Cherry-pick ${card.key} onto ${qa.branch} and serve it`}
                        onClick={() => onMergeTicket(card.key)}
                      >
                        Merge
                      </button>
                    )}
                  </li>
                  );
                })}
              </ul>
            </section>
          ))}
        {!qaLive && board.map((column) => (
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
                  {/* Beside the button, not inside it: no control nested in a
                      control. It sits over the placeholder span the button
                      keeps for the row's layout, so the card reads as before
                      and the key alone is the link. */}
                  <KeyLink issueKey={card.key} url={batch.tickets[card.key]?.url} className="jira-bbcard-key" />
                  <button
                    className={`jira-bbcard jira-bcol-c${card.color < 0 ? "none" : card.color % 8}${focusedKey === card.key ? " focused" : ""}`}
                    onClick={() => onFocus(card.key)}
                  >
                    <span className="jira-bbcard-top">
                      <span className="jira-key jira-bbcard-keyph">{card.key}</span>
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
