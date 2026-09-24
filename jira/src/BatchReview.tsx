// The clusters, before agents are on them: rename, drag a ticket somewhere
// better, add or drop a cluster, then tick the ones to start.
//
// Two ways to move a card, deliberately. Dragging is what a mouse expects;
// the card's own menu is what a finger and a keyboard get, and it is the one
// that works everywhere. The drag is plain HTML5 drag-and-drop for that
// reason - it never has to carry the feature on its own.
import { useEffect, useRef, useState } from "react";
import Icon from "./Icon";
import SkillPicker from "./SkillPicker";

// Said wherever the QA slot is chosen, so the two pickers agree.
export const QA_DEFAULT_NOTE =
  "The extension's own QA skill. Install it from the command palette to make it yours and edit it.";
import { skillsLabel } from "./batchViewModel";
import type { Batch, Cluster, ClusterStateName, SkillsResponse } from "./batchTypes";
import type { MenuItem } from "./types";

export interface BatchReviewProps {
  batch: Batch;
  busy: boolean;
  // Adding to a batch that exists: the started clusters are shown with their
  // state and the new cards are marked, and the action is Apply, not Start.
  addOnly: boolean;
  agents: { id: string; label: string }[];
  agentId: string;
  // What the pickers offer, and what this run will use. The stored setting is
  // the starting point; a change here applies to this cluster's run only.
  skills: SkillsResponse | null;
  executionSkill: string;
  qaSkill: string;
  onSkill: (slot: "execution" | "qa", value: string) => void;
  branchTemplate: string;
  worktreeLocation: (branch: string) => string;
  showMenu?: (x: number, y: number, items: MenuItem[]) => void;
  onRename: (clusterId: string, name: string) => void;
  onBranch: (clusterId: string, branch: string) => void;
  onAddCluster: () => void;
  onRemoveCluster: (clusterId: string) => void;
  onMove: (key: string, clusterId: string | null, index: number) => void;
  onAgent: (agentId: string) => void;
  onReanalyze: (criteria: string, readCodebase: boolean) => void;
  onStart: (clusterIds: string[], branches: Record<string, string>) => void;
  onApply: () => void;
}

// Slugged the same way branches are named elsewhere in the extension, so a
// cluster called "Checkout fixes" prefills as "checkout-fixes".
function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "cluster"
  );
}

function branchFor(template: string, cluster: Cluster): string {
  if (cluster.branch) return cluster.branch;
  return (template.trim() || "{cluster}").replaceAll("{cluster}", slug(cluster.name));
}

const STATE_LABEL: Record<ClusterStateName, string> = {
  pending: "Not started",
  running: "Running",
  waiting: "Waiting on you",
  idle: "Idle",
  stopped: "Stopped",
  closed: "Closed",
};

export default function BatchReview({
  batch,
  busy,
  addOnly,
  agents,
  agentId,
  skills,
  executionSkill,
  qaSkill,
  onSkill,
  branchTemplate,
  worktreeLocation,
  showMenu,
  onRename,
  onBranch,
  onAddCluster,
  onRemoveCluster,
  onMove,
  onAgent,
  onReanalyze,
  onStart,
  onApply,
}: BatchReviewProps) {
  const proposal = batch.pendingProposal;
  const newKeys = new Set(proposal?.keys ?? []);
  const plannable = batch.clusters.filter((cluster) => cluster.state === "pending");

  const [ticked, setTicked] = useState<Set<string>>(() => new Set(plannable.map((c) => c.id)));
  const [branches, setBranches] = useState<Record<string, string>>({});
  const [criteriaOpen, setCriteriaOpen] = useState(false);
  const [criteria, setCriteria] = useState(batch.criteria);
  const [readCodebase, setReadCodebase] = useState(batch.readCodebase);
  const [dragging, setDragging] = useState<string | null>(null);

  // A cluster that appears (added by hand, or by a re-analysis) starts ticked
  // like the rest; one that is started drops out of the selection entirely.
  //
  // "Appears" has to be judged against the ids seen last time, not against
  // whether anything is ticked: a re-analysis replaces every pending cluster
  // with a new id, so a rule like "tick them only when nothing is ticked"
  // leaves the whole board unticked and the Start button dead.
  const seenClusters = useRef<Set<string>>(new Set(batch.clusters.map((c) => c.id)));
  useEffect(() => {
    setTicked((current) => {
      const seen = seenClusters.current;
      const next = new Set<string>();
      for (const cluster of batch.clusters) {
        if (cluster.state !== "pending") continue;
        if (!seen.has(cluster.id) || current.has(cluster.id)) next.add(cluster.id);
      }
      seenClusters.current = new Set(batch.clusters.map((c) => c.id));
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batch.clusters.map((c) => `${c.id}:${c.state}`).join(",")]);

  const branchOf = (cluster: Cluster) => branches[cluster.id] ?? branchFor(branchTemplate, cluster);

  const toggle = (id: string) => {
    const next = new Set(ticked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setTicked(next);
  };

  const moveMenu = (key: string, x: number, y: number) => {
    if (!showMenu) return;
    const targets = batch.clusters.filter((cluster) => cluster.state === "pending" || (addOnly && cluster.state !== "stopped" && cluster.state !== "closed"));
    showMenu(x, y, [
      ...targets.map((cluster) => ({
        label: `Move to "${cluster.name}"`,
        onClick: () => onMove(key, cluster.id, cluster.keys.length),
      })),
      { label: "Move to Unclustered", onClick: () => onMove(key, null, 0) },
    ]);
  };

  const card = (key: string, clusterId: string | null, index: number, cluster: Cluster | null) => {
    const ticket = batch.tickets[key];
    const frozen = Boolean(batch.ticketStates[key]);
    return (
      <li
        key={key}
        className={`jira-bcard${frozen ? " frozen" : ""}${newKeys.has(key) ? " fresh" : ""}${dragging === key ? " dragging" : ""}`}
        draggable={!frozen && !busy}
        onDragStart={(e) => {
          setDragging(key);
          e.dataTransfer.setData("text/plain", key);
          e.dataTransfer.effectAllowed = "move";
        }}
        onDragEnd={() => setDragging(null)}
        onDragOver={(e) => {
          if (dragging && dragging !== key) e.preventDefault();
        }}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          const moved = e.dataTransfer.getData("text/plain");
          if (moved && moved !== key) onMove(moved, clusterId, index);
          setDragging(null);
        }}
        onContextMenu={(e) => {
          if (frozen || !showMenu) return;
          e.preventDefault();
          moveMenu(key, e.clientX, e.clientY);
        }}
      >
        <span className="jira-key">{key}</span>
        <span className="jira-bcard-summary">{ticket?.summary ?? ""}</span>
        {frozen ? (
          <span className="jira-bcard-mark" title="Already with an agent">
            <Icon name="lock" />
          </span>
        ) : (
          <button
            className="icon-button jira-bcard-menu"
            title="Move this ticket"
            disabled={busy}
            onClick={(e) => {
              // Enter or Space gives a click at 0,0, which would open the
              // menu in the corner of the window; fall back to the button.
              const box = e.currentTarget.getBoundingClientRect();
              moveMenu(key, e.clientX || box.left, e.clientY || box.bottom);
            }}
          >
            <Icon name="ellipsis" />
          </button>
        )}
      </li>
    );
  };

  const column = (cluster: Cluster) => {
    const editable = cluster.state === "pending";
    return (
      <section
        key={cluster.id}
        className={`jira-bcol jira-bcol-c${cluster.color % 8}`}
        onDragOver={(e) => {
          if (dragging) e.preventDefault();
        }}
        onDrop={(e) => {
          e.preventDefault();
          const moved = e.dataTransfer.getData("text/plain");
          if (moved) onMove(moved, cluster.id, cluster.keys.length);
          setDragging(null);
        }}
      >
        <header className="jira-bcol-head">
          {editable && (
            <input
              type="checkbox"
              id={`jira-cluster-${cluster.id}`}
              checked={ticked.has(cluster.id)}
              disabled={busy}
              onChange={() => toggle(cluster.id)}
              title="Start this cluster"
            />
          )}
          <input
            className="jira-bcol-name"
            value={cluster.name}
            disabled={!editable || busy}
            aria-label="Cluster name"
            onChange={(e) => onRename(cluster.id, e.target.value)}
          />
          {!editable && <span className={`jira-bstate jira-bstate-${cluster.state}`}>{STATE_LABEL[cluster.state]}</span>}
          {editable && (
            <button
              className="icon-button"
              title="Delete this cluster - its tickets go back to Unclustered"
              disabled={busy}
              onClick={() => onRemoveCluster(cluster.id)}
            >
              <Icon name="trash" />
            </button>
          )}
        </header>
        {cluster.rationale && <p className="jira-bcol-why">{cluster.rationale}</p>}
        {cluster.files.length > 0 && (
          <p className="jira-bcol-files" title={cluster.files.join("\n")}>
            Touches: {cluster.files.slice(0, 3).join(", ")}
            {cluster.files.length > 3 ? ` +${cluster.files.length - 3}` : ""}
          </p>
        )}
        {editable && (
          <label className="jira-bcol-branch">
            <span>Branch</span>
            <input
              value={branchOf(cluster)}
              disabled={busy}
              title={worktreeLocation(branchOf(cluster))}
              onChange={(e) => setBranches({ ...branches, [cluster.id]: e.target.value })}
              onBlur={(e) => onBranch(cluster.id, e.target.value)}
            />
          </label>
        )}
        {!editable && skillsLabel(cluster.skills) && (
          // A started cluster cannot be re-pointed at another skill, so what it
          // ran with is shown rather than offered: the pickers in the bar above
          // belong to the clusters that have not started yet.
          <p className="jira-bcol-skills">{skillsLabel(cluster.skills)}</p>
        )}
        {cluster.lastError && <p className="jira-bcol-error">{cluster.lastError}</p>}
        <ul className="jira-bcards">{cluster.keys.map((key, i) => card(key, cluster.id, i, cluster))}</ul>
      </section>
    );
  };

  const tickedIds = [...ticked].filter((id) => batch.clusters.some((c) => c.id === id && c.state === "pending"));

  // What the server would refuse, said here instead: an empty branch name
  // reaches `git worktree add -b ""` and surfaces a raw git error, and a
  // cluster with no tickets is refused by name after the worktree exists.
  const blocked = tickedIds
    .map((id) => batch.clusters.find((c) => c.id === id)!)
    .map((cluster) =>
      !branchOf(cluster).trim()
        ? `"${cluster.name}" needs a branch name.`
        : cluster.keys.length === 0
          ? `"${cluster.name}" has no tickets.`
          : "",
    )
    .filter(Boolean);

  return (
    <div className="jira-batchreview">
      <div className="jira-breview-bar">
        <span className="jira-breview-title">{batch.name}</span>
        <button className="jira-selaction" disabled={busy} onClick={() => setCriteriaOpen(!criteriaOpen)}>
          Criteria
          <Icon name={criteriaOpen ? "chevron-up" : "chevron-down"} />
        </button>
        {!addOnly && (
          <button className="jira-selaction" disabled={busy} onClick={onAddCluster}>
            + Cluster
          </button>
        )}
        <span className="jira-breview-spacer" />
        {/* The three choices that decide HOW a cluster runs, kept together on
            their own row. Strung along the end of the title row they pushed
            the primary action onto a second line of its own, which read as
            two half-finished toolbars. */}
        <div className="jira-breview-choices">
          {skills && (
            <>
              <label className="jira-breview-agent">
                <span>Implements with</span>
              <SkillPicker
                value={executionSkill}
                skills={skills.skills}
                defaultLabel={skills.defaults.execution}
                disabled={busy}
                compact
                  onChange={(value) => onSkill("execution", value)}
                />
              </label>
              <label className="jira-breview-agent">
                <span>QA with</span>
              <SkillPicker
                value={qaSkill}
                skills={skills.skills}
                defaultLabel={skills.defaults.qa}
                defaultDescription={QA_DEFAULT_NOTE}
                disabled={busy}
                compact
                  onChange={(value) => onSkill("qa", value)}
                />
              </label>
            </>
          )}
          {agents.length > 1 && (
            <label className="jira-breview-agent">
              <span>Agent</span>
              <select value={agentId} disabled={busy} onChange={(e) => onAgent(e.target.value)}>
                {agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.label}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        {addOnly ? (
          <button className="jira-selaction primary" disabled={busy} onClick={onApply}>
            Apply
          </button>
        ) : (
          <button
            className="jira-selaction primary"
            disabled={busy || tickedIds.length === 0 || agents.length === 0 || blocked.length > 0}
            title={blocked.join(" ")}
            onClick={() => onStart(tickedIds, Object.fromEntries(tickedIds.map((id) => [id, branchOf(batch.clusters.find((c) => c.id === id)!)])))}
          >
            {tickedIds.length === 1 ? "Start 1 cluster" : `Start ${tickedIds.length} clusters`}
          </button>
        )}
      </div>

      {criteriaOpen && (
        <div className="jira-breview-criteria">
          <textarea
            rows={3}
            aria-label="How should they be split?"
            value={criteria}
            disabled={busy}
            onChange={(e) => setCriteria(e.target.value)}
          />
          <label className="jira-batchform-check">
            <input type="checkbox" checked={readCodebase} disabled={busy} onChange={(e) => setReadCodebase(e.target.checked)} />
            <span>Read the codebase first</span>
          </label>
          <button className="jira-selaction" disabled={busy} onClick={() => onReanalyze(criteria, readCodebase)}>
            Re-analyze the tickets nobody has started
          </button>
        </div>
      )}

      {agents.length === 0 && (
        <div className="jira-breview-hint">No agent is enabled - add one in Settings, AI Providers, before starting a cluster.</div>
      )}

      {blocked.length > 0 && <div className="jira-breview-hint">{blocked.join(" ")}</div>}

      <div className="jira-bcols">
        {batch.clusters.map(column)}
        <section
          className="jira-bcol jira-bcol-none"
          onDragOver={(e) => {
            if (dragging) e.preventDefault();
          }}
          onDrop={(e) => {
            e.preventDefault();
            const moved = e.dataTransfer.getData("text/plain");
            if (moved) onMove(moved, null, 0);
            setDragging(null);
          }}
        >
          <header className="jira-bcol-head">
            <span className="jira-bcol-name plain">Unclustered</span>
          </header>
          <p className="jira-bcol-why">Not started. Drag into a cluster to include.</p>
          <ul className="jira-bcards">{batch.unclustered.map((key, i) => card(key, null, i, null))}</ul>
        </section>
      </div>
    </div>
  );
}
