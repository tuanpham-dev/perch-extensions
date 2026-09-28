// A ticket's changes on the QA branch, in its QA section: its commit against
// the one before it, and - while a requested change is being made - the QA
// worktree's uncommitted edits with it. The server works out which is which
// (see qaDiff.mjs); this reads the patch and lays it out.
//
// Closed until asked for, since it is one git call per look and most
// verdicts are made from the page, not the code. Once opened it stays open
// for the next ticket too, and it reloads by itself whenever the ticket's
// QA record moves (a new commit, a fix reported), which is when the diff
// underneath has changed.
import { useEffect, useMemo, useState } from "react";
import { diffTotals, parseUnifiedDiff } from "../diffModel.mjs";
import type { DiffFile } from "../diffModel.mjs";
import { getQaDiff } from "./batchApi";
import type { QaDiffResponse } from "./batchTypes";
import Icon from "./Icon";

// A file this long starts folded, so one generated file cannot push every
// other one out of reach.
const FOLD_LINES = 400;

let rememberedOpen = false;

const STATUS_MARK: Record<DiffFile["status"], string> = { added: "A", deleted: "D", modified: "M", renamed: "R" };

function FileDiff({ file }: { file: DiffFile }) {
  const lineCount = file.hunks.reduce((n, h) => n + h.lines.length, 0);
  const [open, setOpen] = useState(lineCount <= FOLD_LINES);
  const name = file.status === "renamed" ? `${file.oldPath} → ${file.path}` : file.path;
  return (
    <div className="jira-diff-file">
      <button className="jira-diff-file-head" onClick={() => setOpen((v) => !v)} aria-expanded={open} title={name}>
        <Icon name={open ? "chevron-down" : "chevron-right"} />
        <span className={`jira-diff-status s-${file.status}`}>{STATUS_MARK[file.status]}</span>
        <span className="jira-diff-path mono">{name}</span>
        <span className="jira-diff-counts mono">
          {file.additions > 0 && <span className="add">+{file.additions}</span>}
          {file.deletions > 0 && <span className="del">-{file.deletions}</span>}
        </span>
      </button>
      {open &&
        (file.binary ? (
          <div className="jira-diff-empty">Binary file</div>
        ) : file.hunks.length === 0 ? (
          <div className="jira-diff-empty">{file.status === "renamed" ? "Renamed without changes" : "No text changes"}</div>
        ) : (
          <div className="jira-diff-body">
            <table className="jira-diff-table mono">
              <tbody>
                {file.hunks.map((hunk, h) => [
                  <tr key={`h${h}`} className="jira-diff-hunk">
                    <td colSpan={3}>{hunk.header}</td>
                  </tr>,
                  ...hunk.lines.map((line, i) => (
                    <tr key={`h${h}-${i}`} className={`jira-diff-line k-${line.kind}`}>
                      <td className="jira-diff-no">{line.oldNo ?? ""}</td>
                      <td className="jira-diff-no">{line.newNo ?? ""}</td>
                      <td className="jira-diff-text">
                        <span className="jira-diff-mark">{line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}</span>
                        {line.text}
                      </td>
                    </tr>
                  )),
                ])}
              </tbody>
            </table>
          </div>
        ))}
    </div>
  );
}

export interface QaDiffProps {
  batchId: string;
  issueKey: string;
  // Changes whenever the diff underneath could have: the commit, the state,
  // what the agent reported fixing, and when the record last moved.
  version: string;
}

export default function QaDiff({ batchId, issueKey, version }: QaDiffProps) {
  const [open, setOpen] = useState(rememberedOpen);
  const [data, setData] = useState<QaDiffResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    setData(null);
    setError(null);
  }, [issueKey]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    getQaDiff(batchId, issueKey)
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, batchId, issueKey, version, reload]);

  const sections = useMemo(
    () => (data?.key === issueKey ? data.sections.map((s) => ({ label: s.label, files: parseUnifiedDiff(s.patch) })) : []),
    [data, issueKey],
  );
  const totals = diffTotals(sections.flatMap((s) => s.files));

  const toggle = () => {
    rememberedOpen = !open;
    setOpen(!open);
  };

  return (
    <div className="jira-diff">
      <div className="jira-diff-bar">
        <button className="jira-diff-toggle" onClick={toggle} aria-expanded={open}>
          <Icon name={open ? "chevron-down" : "chevron-right"} />
          <b>Changes</b>
        </button>
        {open && data && data.key === issueKey && (
          <>
            <span className="jira-diff-range mono" title={data.combined ? "The commit before this ticket's, against the worktree" : undefined}>
              {data.base || "root"}..{data.commit}
              {data.withUncommitted ? " + uncommitted" : ""}
            </span>
            <span className="jira-diff-counts mono">
              {totals.files} {totals.files === 1 ? "file" : "files"}
              <span className="add">+{totals.additions}</span>
              <span className="del">-{totals.deletions}</span>
            </span>
          </>
        )}
        <span className="jira-qav-spacer" />
        {open && (
          <button className="icon-button" title="Reload the diff" disabled={loading} onClick={() => setReload((n) => n + 1)}>
            <Icon name={loading ? "loading" : "refresh"} className={loading ? "codicon-modifier-spin" : undefined} />
          </button>
        )}
      </div>

      {open && error && <div className="jira-error">{error}</div>}
      {open && !data && !error && loading && <div className="jira-qav-hint">Reading the QA worktree...</div>}
      {open &&
        sections.map((section, s) => (
          <div key={s} className="jira-diff-section">
            {section.label && <div className="jira-diff-label">{section.label}</div>}
            {section.files.length === 0 ? (
              <div className="jira-qav-hint">No changes.</div>
            ) : (
              section.files.map((file) => <FileDiff key={`${s}:${file.oldPath}:${file.path}`} file={file} />)
            )}
          </div>
        ))}
      {open && data?.truncated && <div className="jira-qav-hint">The diff was too long to show in full, so it stops at a file boundary.</div>}
      {open && data && data.untrackedSkipped > 0 && (
        <div className="jira-qav-hint">{data.untrackedSkipped} more new files are not shown.</div>
      )}
    </div>
  );
}
