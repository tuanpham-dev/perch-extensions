// jira.projectSettings as a form, directly under that setting's own JSON
// field: pick a project, and every setting that can differ per project is a
// row whose empty state shows the global value it inherits.
//
// The field list comes from the manifest, so a setting added there is
// offered here without a second list to keep in step. Text and numbers are
// written when you leave the field or press Enter, not per keystroke: the
// settings document is server-synced, and a half-typed branch name is not a
// value anyone wants saved.
import { useEffect, useRef, useState } from "react";
import manifest from "../package.json";
import { isOverridable, parseProjectSettings, removeProjectOverrides, setProjectOverride } from "../projectSettings.mjs";
import type { ProjectRow } from "./types";

interface Field {
  key: string;
  type: "string" | "integer" | "boolean";
  description: string;
  // Long-form text such as skill paths, one per line.
  multiline: boolean;
}

const FIELDS: Field[] = Object.entries(manifest.contributes.configuration.properties)
  .filter(([key]) => isOverridable(key))
  .map(([key, prop]) => ({
    key,
    type: prop.type === "integer" ? "integer" : prop.type === "boolean" ? "boolean" : "string",
    description: prop.description,
    multiline: /one per line/i.test(prop.description),
  }));

export interface ProjectSettingsEditorProps {
  // The raw jira.projectSettings value, straight from the settings document.
  raw: unknown;
  // The global value of each overridable setting, for the placeholders.
  globals: (key: string) => unknown;
  projects: ProjectRow[];
  projectsError: string | null;
  // The project the active window's repository belongs to, if known.
  activeProject: string | null;
  onChange: (value: string) => void;
}

function label(key: string): string {
  return key.replace(/^jira\./, "");
}

function shown(value: unknown): string {
  if (value === undefined || value === null || value === "") return "empty";
  if (typeof value === "boolean") return value ? "on" : "off";
  return String(value);
}

export default function ProjectSettingsEditor({ raw, globals, projects, projectsError, activeProject, onChange }: ProjectSettingsEditorProps) {
  const parsed = parseProjectSettings(raw);
  const withOverrides = Object.keys(parsed.projects);
  // Every project this can speak of: the site's, the ones already overridden
  // (still editable after leaving the site's list), and the active one.
  const known = new Map<string, string>();
  for (const project of projects) known.set(project.key, project.name);
  for (const key of withOverrides) if (!known.has(key)) known.set(key, "");
  if (activeProject && !known.has(activeProject)) known.set(activeProject, "");
  const options = [...known.keys()].sort();

  const [picked, setPicked] = useState<string>(activeProject ?? withOverrides[0] ?? "");
  // Follow the active window's project until the user picks one themselves.
  const [pinned, setPinned] = useState(false);
  useEffect(() => {
    if (!pinned && activeProject) setPicked(activeProject);
  }, [activeProject, pinned]);

  if (parsed.malformed) {
    return (
      <div className="jira-settings-block">
        <div className="jira-error">Could not read the JSON above. Fix or clear it, and this form will pick it up.</div>
      </div>
    );
  }

  const project = options.includes(picked) ? picked : (options[0] ?? "");
  const overrides = project ? (parsed.projects[project] ?? {}) : {};
  const count = Object.keys(overrides).length;

  return (
    <div className="jira-settings-block jira-pset">
      <p className="jira-settings-hint">
        The same overrides as the JSON above, one project at a time - editing either updates the other. A field left
        empty inherits the global setting shown in it; the site, account and project lookup cannot differ per project.
      </p>

      {projectsError && <div className="jira-error">{projectsError}</div>}

      <div className="jira-pset-pick">
        <label>
          <span>Project</span>
          <select
            className="jira-input"
            value={project}
            onChange={(e) => {
              setPinned(true);
              setPicked(e.target.value);
            }}
          >
            {options.length === 0 && <option value="">No projects yet</option>}
            {options.map((key) => {
              const n = Object.keys(parsed.projects[key] ?? {}).length;
              const name = known.get(key);
              return (
                <option key={key} value={key}>
                  {key}
                  {name ? ` - ${name}` : ""}
                  {n > 0 ? ` (${n} override${n === 1 ? "" : "s"})` : ""}
                </option>
              );
            })}
          </select>
        </label>
        {count > 0 && (
          <button className="jira-linkish" title={`Remove every override for ${project}`} onClick={() => onChange(removeProjectOverrides(raw, project))}>
            Clear {project}
          </button>
        )}
      </div>

      {project &&
        FIELDS.map((field) => (
          <FieldRow
            key={`${project}:${field.key}`}
            field={field}
            value={overrides[field.key]}
            global={globals(field.key)}
            onCommit={(value) => onChange(setProjectOverride(raw, project, field.key, value))}
          />
        ))}
    </div>
  );
}

function FieldRow({ field, value, global, onCommit }: { field: Field; value: unknown; global: unknown; onCommit: (value: unknown) => void }) {
  const set = value !== undefined;
  const id = `jira-pset-${field.key.replace(/\./g, "-")}`;
  return (
    <div className={`jira-pset-row${set ? " set" : ""}`}>
      <label htmlFor={id} className="jira-pset-label" title={field.description}>
        {label(field.key)}
      </label>
      {field.type === "boolean" ? (
        <select
          id={id}
          className="jira-input"
          value={set ? (value ? "on" : "off") : ""}
          onChange={(e) => onCommit(e.target.value === "" ? undefined : e.target.value === "on")}
        >
          <option value="">Inherit ({shown(global)})</option>
          <option value="on">On</option>
          <option value="off">Off</option>
        </select>
      ) : (
        <TextField id={id} field={field} value={set ? String(value) : ""} placeholder={shown(global)} onCommit={onCommit} />
      )}
      <span className="jira-pset-desc">{field.description}</span>
    </div>
  );
}

// Commits on blur or Enter; Escape puts back what is saved. A number that is
// not one is not written - the field goes back to inheriting.
function TextField({ id, field, value, placeholder, onCommit }: { id: string; field: Field; value: string; placeholder: string; onCommit: (value: unknown) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  // Escape blurs the field, and the blur would commit the draft it just
  // threw away: the state update has not landed when focusout fires. So the
  // abandonment is remembered where the blur can see it.
  const abandoned = useRef(false);
  const commit = () => {
    if (abandoned.current) {
      abandoned.current = false;
      return;
    }
    if (draft === value) return;
    if (field.type === "integer") {
      const n = Number(draft.trim());
      onCommit(draft.trim() !== "" && Number.isInteger(n) ? n : undefined);
    } else {
      onCommit(draft === "" ? undefined : draft);
    }
  };
  const shared = {
    id,
    className: "jira-input",
    value: draft,
    placeholder,
    onBlur: commit,
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !(field.multiline && !e.ctrlKey && !e.metaKey)) {
        e.preventDefault();
        (e.currentTarget as HTMLElement).blur();
      } else if (e.key === "Escape") {
        abandoned.current = true;
        setDraft(value);
        (e.currentTarget as HTMLElement).blur();
      }
    },
  };
  return field.multiline ? (
    <textarea {...shared} rows={2} onChange={(e) => setDraft(e.target.value)} />
  ) : (
    <input {...shared} type="text" inputMode={field.type === "integer" ? "numeric" : undefined} onChange={(e) => setDraft(e.target.value)} />
  );
}
