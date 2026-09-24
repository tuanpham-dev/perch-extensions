// Choosing which skill fills a slot.
//
// It lists what the extension found, wherever it found it, and takes a typed
// path for anything else - a skill does not have to live in ~/.claude/skills
// to be usable, and making that a first-class choice beats telling someone to
// symlink one into position.
//
// A stored value that matches nothing is shown as-is and marked, never
// silently replaced by the default: quietly running something other than what
// the setting says is the worst outcome available here.
import { useEffect, useState } from "react";
import type { SkillSummary } from "./batchTypes";

export interface SkillPickerProps {
  value: string;
  skills: SkillSummary[];
  // What answers when nothing is chosen, named so "Default" is not a mystery.
  // A plain skill name: it is rendered inside "Default (...)", so anything
  // parenthesised here nests a second bracket and overflows the select.
  defaultLabel: string;
  // What to say about that default beyond its name, when there is something
  // worth saying - the QA slot's default is the extension's own skill, which
  // is a fact about where it came from, not part of its name.
  defaultDescription?: string;
  disabled?: boolean;
  // The review bar is a single crowded row, so its note is clipped to one
  // line; Settings has a column to itself and lets the description wrap,
  // where a skill's own words are the whole reason to read it.
  compact?: boolean;
  onChange: (value: string) => void;
}

const DEFAULT = "";
const NONE = "none";
const OTHER = "__other__";

export default function SkillPicker({ value, skills, defaultLabel, defaultDescription, disabled, compact, onChange }: SkillPickerProps) {
  const known = skills.some((skill) => skill.dir === value);
  const isSpecial = value === DEFAULT || value === NONE;
  // A path that is not among the found skills: keep showing it, and say it
  // was not found rather than dropping the choice.
  const [typed, setTyped] = useState(isSpecial || known ? "" : value);
  // Asked for the path box, as opposed to having one because the stored value
  // is a path nothing matched. Held separately so that choosing "Another
  // path..." keeps the select on that option while the box is still empty -
  // a dropdown that snaps back to "Default" the moment you pick the last
  // entry reads as a control that refused the click.
  const [wantsPath, setWantsPath] = useState(false);

  useEffect(() => {
    if (!isSpecial && !known) setTyped(value);
  }, [value, known, isSpecial]);

  const showPath = wantsPath || (!isSpecial && !known);
  const selected = showPath ? OTHER : value;

  // Leaving the box empty is a way of saying Default, so the box goes with it;
  // committing a real path lets `showPath` fall back to whether it was found.
  const commit = () => {
    setWantsPath(false);
    onChange(typed.trim());
  };

  return (
    <div className={`jira-skillpicker${compact ? " compact" : ""}`}>
      <select
        value={selected}
        disabled={disabled}
        onChange={(e) => {
          const next = e.target.value;
          if (next === OTHER) {
            // Nothing changes until a path is actually typed - switching to
            // "Another path" must not clear the slot in the meantime.
            setWantsPath(true);
            return;
          }
          setWantsPath(false);
          setTyped("");
          onChange(next);
        }}
      >
        <option value={DEFAULT}>Default ({defaultLabel})</option>
        <option value={NONE}>None - leave it to the agent</option>
        {skills.map((skill) => (
          <option key={skill.dir} value={skill.dir}>
            {skill.name} ({skill.origin})
          </option>
        ))}
        <option value={OTHER}>Another path...</option>
      </select>

      {showPath && (
        <input
          className="jira-skillpicker-path"
          value={typed}
          disabled={disabled}
          placeholder="/path/to/a/skill"
          spellCheck={false}
          autoFocus={wantsPath && !typed}
          onChange={(e) => setTyped(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
          }}
        />
      )}

      <p className="jira-skillpicker-note">
        {showPath && !typed.trim() ? (
          "Type the path to a skill directory."
        ) : showPath ? (
          <span className="warn">Not found where the extension looks. It will be used as given.</span>
        ) : (
          skills.find((skill) => skill.dir === value)?.description ||
          (value === NONE
            ? "The agent decides this half for itself. The rules in its brief still apply."
            : defaultDescription || `Whatever ${defaultLabel} says.`)
        )}
      </p>
    </div>
  );
}
