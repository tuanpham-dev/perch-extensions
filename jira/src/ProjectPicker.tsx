// Which Jira project this repository belongs to, picked from a list rather
// than typed into a JSON setting.
//
// Choosing one writes a jira.projectMap entry. That is the SECOND of the four
// sources server.js consults, so when the first (a .jira-project file) or a
// later environment variable already answered, the choice is still written
// but cannot take effect yet - the picker says which source won rather than
// greying itself out, so a mapping can be prepared before the file goes.
import { useEffect, useState } from "react";
import Icon from "./Icon";
import { usePopoverPosition, type PopoverAnchor } from "./usePopoverPosition";
import type { ProjectRow } from "./types";
import Popover from "./Popover";

export interface ProjectPickerProps {
  anchor: PopoverAnchor;
  projects: ProjectRow[];
  // The repo whose mapping is being set, for the heading.
  repo: string | null;
  // Which source currently supplies the key, if any.
  source: string | null;
  currentKey: string | null;
  error: string | null;
  onChoose: (key: string) => void;
  onClose: () => void;
}

// The sources that are read BEFORE jira.projectMap, in the words the README
// uses for them. A key from either of these wins over anything picked here.
const WINS_OVER_MAPPING: Record<string, string> = {
  file: "A .jira-project file in this repository",
  env: "The environment variable named by jira.projectKeyEnv",
};

export default function ProjectPicker({
  anchor,
  projects,
  repo,
  source,
  currentKey,
  error,
  onChoose,
  onClose,
}: ProjectPickerProps) {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const matches = needle
    ? projects.filter(
        (project) =>
          project.key.toLowerCase().includes(needle) || project.name.toLowerCase().includes(needle),
      )
    : projects;
  const { ref, style } = usePopoverPosition<HTMLDivElement>(anchor, [matches.length, error]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown, true);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown, true);
    };
  }, [onClose, ref]);

  const overridden = source ? WINS_OVER_MAPPING[source] : undefined;

  return (
    <Popover>
      <div ref={ref} className="jira-popover jira-projectpicker" role="dialog" style={style}>
        <div className="jira-pop-head">
          <span className="jira-facets-title">Jira project</span>
          <button className="icon-button" title="Close" onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
        {repo && <div className="jira-location">{repo}</div>}

        {overridden && (
          <div className="jira-note">
            {overridden} already sets {currentKey ?? "the project key"} and is read first. Your choice is saved,
            but takes effect only once that is removed.
          </div>
        )}
        {error && <div className="jira-error">{error}</div>}

        <input
          className="jira-input"
          type="search"
          value={query}
          autoFocus
          placeholder="Find a project"
          aria-label="Find a project"
          onChange={(e) => setQuery(e.target.value)}
        />

        <div className="jira-projectlist">
          {projects.length === 0 && <div className="jira-empty">No projects to choose from.</div>}
          {projects.length > 0 && matches.length === 0 && <div className="jira-empty">No project matches.</div>}
          {matches.map((project) => (
            <button
              key={project.key}
              className={`jira-projectrow${project.key === currentKey ? " current" : ""}`}
              onClick={() => onChoose(project.key)}
            >
              <span className="jira-key">{project.key}</span>
              <span className="jira-projectname">{project.name}</span>
            </button>
          ))}
        </div>
      </div>
    </Popover>
  );
}
