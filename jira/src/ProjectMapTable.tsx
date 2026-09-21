// jira.projectMap as a table, directly under that setting's own JSON field.
//
// The same setting the pane's picker writes, shown here as one row per repo
// so every mapping can be reviewed and cleaned up in one place rather than
// read out of a JSON string. Rendered first by SettingsPanel, which is what
// puts it under the field - see the comment there.
import { useEffect, useState } from "react";
import {
  parseProjectMap,
  removeProjectMap,
  serializeProjectMap,
  upsertProjectMap,
  type ProjectMapEntry,
} from "./projectMap";
import type { ProjectRow } from "./types";

export interface ProjectMapTableProps {
  // The raw jira.projectMap value, straight from the settings document.
  raw: unknown;
  projects: ProjectRow[];
  // The repo the active window is in, for "Add this repository". Null when
  // there is no active window, or none inside a git repository.
  activeRepo: string | null;
  projectsError: string | null;
  onChange: (value: string) => void;
}

export default function ProjectMapTable({
  raw,
  projects,
  activeRepo,
  projectsError,
  onChange,
}: ProjectMapTableProps) {
  const parsed = parseProjectMap(raw);
  const [pendingRepo, setPendingRepo] = useState<string | null>(null);

  // A repo added here has no project yet; the row's picker is what sets one.
  // Cleared once the value catches up, so the row stops being pending.
  useEffect(() => {
    if (pendingRepo && parsed.entries.some((entry) => entry.repo === pendingRepo)) setPendingRepo(null);
  }, [parsed.entries, pendingRepo]);

  const write = (entries: ProjectMapEntry[]) => onChange(serializeProjectMap(entries));

  // Refusing to write is the point: replacing text the user typed by hand
  // with an empty object would lose it, and they cannot see it from here.
  if (parsed.malformed) {
    return (
      <div className="jira-settings-block">
        <div className="jira-error">
          Could not read the JSON above. Fix or clear it, and this table will pick it up.
        </div>
      </div>
    );
  }

  const rows: ProjectMapEntry[] = pendingRepo
    ? [...parsed.entries, { repo: pendingRepo, key: "" }]
    : parsed.entries;
  const alreadyMapped = activeRepo !== null && rows.some((row) => row.repo === activeRepo);

  return (
    <div className="jira-settings-block">
      <p className="jira-settings-hint">
        The same mapping as the JSON above, one row per repository - editing either updates the other. A
        .jira-project file in the repository is read first and wins over anything set here.
      </p>

      {projectsError && <div className="jira-error">{projectsError}</div>}

      {rows.length === 0 && <div className="jira-empty">No repositories mapped yet.</div>}

      {rows.map((row) => (
        <div key={row.repo} className="jira-maprow">
          <span className="jira-mappath" title={row.repo}>
            {row.repo}
          </span>
          <select
            className="jira-input"
            value={row.key}
            aria-label={`Jira project for ${row.repo}`}
            onChange={(e) => {
              if (!e.target.value) return;
              write(upsertProjectMap(parsed.entries, row.repo, e.target.value));
            }}
          >
            <option value="">Choose...</option>
            {/* A key already in the setting but no longer in the site's
                project list still shows, rather than the row reading blank
                and looking unset. */}
            {row.key && !projects.some((project) => project.key === row.key) && (
              <option value={row.key}>{row.key}</option>
            )}
            {projects.map((project) => (
              <option key={project.key} value={project.key}>
                {project.key} - {project.name}
              </option>
            ))}
          </select>
          <button
            className="jira-linkish"
            title={`Remove ${row.repo}`}
            onClick={() => {
              if (row.repo === pendingRepo) setPendingRepo(null);
              else write(removeProjectMap(parsed.entries, row.repo));
            }}
          >
            Remove
          </button>
        </div>
      ))}

      <button
        className="jira-selaction"
        disabled={activeRepo === null || alreadyMapped}
        title={
          activeRepo === null
            ? "No active window in a git repository"
            : alreadyMapped
              ? "This repository is already mapped"
              : `Add ${activeRepo}`
        }
        onClick={() => activeRepo && setPendingRepo(activeRepo)}
      >
        {activeRepo === null ? "No active repository" : `Add ${activeRepo}`}
      </button>
    </div>
  );
}
