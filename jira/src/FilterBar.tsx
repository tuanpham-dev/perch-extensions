// The row above each issue list: a search box, a funnel carrying the count of
// what is ticked, and the select-mode toggle.
//
// One row, because the sidebar is narrow - four separate dropdowns would cost
// two lines before a single ticket showed. The facets live in a popover
// instead, and whatever is active reads back as chips under the row, so the
// filter stays visible without opening anything.
//
// Nothing here is position: fixed. The bar scrolls with the panel and the
// popover is the only floating part - the sidebar's bottom edge already
// belongs to the one-hand extension's strip on touch.
//
// State comes in as props rather than being read from the store: client.tsx
// imports this file, so importing the store back out of it would make a
// cycle.
import { useEffect, useRef, useState } from "react";
import Icon from "./Icon";
import { usePopoverPosition, anchorOf, type PopoverAnchor } from "./usePopoverPosition";
import {
  EMPTY_FILTERS,
  FACET_KEYS,
  UNASSIGNED,
  activeCount,
  chipsOf,
  removeValue,
  setText,
  toggleValue,
  type FacetKey,
  type IssueFilters,
} from "./filterModel";
import { SORT_FIELDS, sortLabel, type ListView, type SortField } from "./sortModel";
import type { Facets } from "./types";
import Popover from "./Popover";

export interface FilterBarProps {
  filters: IssueFilters;
  facets: Facets | null;
  selectMode: boolean;
  // The Assigned to Me pane hides the assignee facet: that list is one person
  // by definition, so filtering it by assignee only ever narrows to nothing.
  showAssignee: boolean;
  onApply: (filters: IssueFilters) => void;
  onToggleSelectMode: () => void;
  // Sort and group: how the list is ordered and split, apart from which
  // tickets it holds. In the funnel popover everywhere; `inlineView` also puts
  // them in the row itself, where the editor tab has the width for them.
  view: ListView;
  onView: (view: ListView) => void;
  inlineView?: boolean;
  // Opens the editor tab. Passed by the sidebar panes only - the tab's own
  // filter row has nowhere bigger to go.
  onOpenTab?: () => void;
}

const FACET_TITLES: Record<FacetKey, string> = {
  status: "Status",
  assignee: "Assignee",
  type: "Type",
  priority: "Priority",
};

// Typing reaches the server once it settles. Every keystroke would be a JQL
// search against Atlassian, and a half-typed word matches nothing anyway.
const DEBOUNCE_MS = 250;

interface FacetOption {
  value: string;
  label: string;
}

function optionsFor(facet: FacetKey, facets: Facets | null, showAssignee: boolean): FacetOption[] {
  if (!facets) return [];
  switch (facet) {
    case "status":
      return facets.statuses.map((status) => ({ value: status.name, label: status.name }));
    case "type":
      return facets.types.map((type) => ({ value: type.name, label: type.name }));
    case "priority":
      return facets.priorities.map((priority) => ({ value: priority.name, label: priority.name }));
    case "assignee":
      if (!showAssignee) return [];
      // "Unassigned" leads because it is the one people reach for, and it is
      // a sentinel rather than an accountId - see filterModel.
      return [
        { value: UNASSIGNED, label: "Unassigned" },
        ...facets.assignees.map((user) => ({ value: user.accountId, label: user.displayName })),
      ];
  }
}

// The sort field, its direction and the grouping, as one small cluster used
// both in the popover and inline in the editor tab's filter row.
function ViewControls({ view, onView, compact }: { view: ListView; onView: (view: ListView) => void; compact: boolean }) {
  const arrow = view.sort.dir === "asc" ? "\u2191" : "\u2193";
  return (
    <div className={`jira-viewcontrols${compact ? " compact" : ""}`}>
      <label className="jira-viewcontrol">
        <span>Sort</span>
        <select
          className="jira-input"
          value={view.sort.field}
          onChange={(e) => onView({ ...view, sort: { ...view.sort, field: e.target.value as SortField } })}
        >
          {SORT_FIELDS.map((f) => (
            <option key={f.field} value={f.field}>
              {f.label}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        className="jira-selaction jira-sortdir"
        title={`${sortLabel(view.sort.field)}, ${view.sort.dir === "asc" ? "ascending" : "descending"} - click to flip`}
        onClick={() => onView({ ...view, sort: { ...view.sort, dir: view.sort.dir === "asc" ? "desc" : "asc" } })}
      >
        {compact ? arrow : `${arrow} ${view.sort.dir === "asc" ? "Ascending" : "Descending"}`}
      </button>
      <label className="jira-viewcontrol">
        <span>Group</span>
        <select
          className="jira-input"
          value={view.groupByProject ? "project" : "none"}
          onChange={(e) => onView({ ...view, groupByProject: e.target.value === "project" })}
        >
          <option value="none">None</option>
          <option value="project">Project</option>
        </select>
      </label>
    </div>
  );
}

function FacetPopover({
  anchor,
  filters,
  facets,
  showAssignee,
  onApply,
  onClose,
  view,
  onView,
}: {
  anchor: PopoverAnchor;
  filters: IssueFilters;
  facets: Facets | null;
  showAssignee: boolean;
  onApply: (filters: IssueFilters) => void;
  onClose: () => void;
  view: ListView;
  onView: (view: ListView) => void;
}) {
  const groups = FACET_KEYS.map((facet) => ({ facet, options: optionsFor(facet, facets, showAssignee) })).filter(
    // A facet whose Jira metadata call failed arrives empty, and is left out
    // rather than shown as a heading with nothing under it.
    (group) => group.options.length > 0,
  );
  const { ref, style } = usePopoverPosition<HTMLDivElement>(anchor, [groups.length, filters, view]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("keydown", onKey);
    // Capture phase, so a click elsewhere closes this before opening its own.
    document.addEventListener("mousedown", onDown, true);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown, true);
    };
  }, [onClose, ref]);

  return (
    <Popover>
      <div ref={ref} className="jira-popover jira-facets" role="dialog" style={style}>
        <div className="jira-pop-head">
          <span className="jira-facets-title">Filters</span>
          <button className="jira-linkish" onClick={() => onApply(EMPTY_FILTERS)}>
            Clear all
          </button>
          <button className="icon-button" title="Close" onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
        <div className="jira-facet-group">
          <div className="jira-pop-section">Order</div>
          <ViewControls view={view} onView={onView} compact={false} />
        </div>
        {groups.length === 0 && <div className="jira-empty">No filter values available.</div>}
        {groups.map(({ facet, options }) => (
          <div key={facet} className="jira-facet-group">
            <div className="jira-pop-section">{FACET_TITLES[facet]}</div>
            {options.map((option) => (
              <label key={option.value} className="jira-facet-row">
                <input
                  type="checkbox"
                  checked={filters[facet].includes(option.value)}
                  onChange={() => onApply(toggleValue(filters, facet, option.value))}
                />
                <span>{option.label}</span>
              </label>
            ))}
          </div>
        ))}
      </div>
    </Popover>
  );
}

export default function FilterBar({
  filters,
  facets,
  selectMode,
  showAssignee,
  onApply,
  onToggleSelectMode,
  onOpenTab,
  view,
  onView,
  inlineView = false,
}: FilterBarProps) {
  const [anchor, setAnchor] = useState<PopoverAnchor | null>(null);
  // Held locally between keystrokes so typing never waits on a round trip;
  // the store catches up once the typing settles.
  const [draft, setDraft] = useState(filters.text);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Read inside the debounce so the pending write sees the filters as they
  // are when it fires, not as they were when the key was pressed - a chip
  // removed mid-type would otherwise come back.
  const latest = useRef(filters);
  latest.current = filters;

  // Keeps the box in step when the text changes from somewhere else: the
  // chip's x, Clear all, or moving to a repo with its own saved filters.
  useEffect(() => {
    setDraft(filters.text);
  }, [filters.text]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const onType = (text: string) => {
    setDraft(text);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => onApply(setText(latest.current, text.trim())), DEBOUNCE_MS);
  };

  const count = activeCount(filters);
  const chips = chipsOf(filters, facets);

  return (
    <div className="jira-filterbar">
      <div className="jira-filter-row">
        <input
          className="jira-search"
          type="search"
          value={draft}
          placeholder="Search"
          aria-label="Search issues"
          onChange={(e) => onType(e.target.value)}
        />
        {inlineView && <ViewControls view={view} onView={onView} compact />}
        <button
          className={`icon-button jira-funnel${count > 0 ? " active" : ""}`}
          title={count > 0 ? `Filters (${count} active)` : "Filters"}
          aria-label="Filters"
          onClick={(e) => setAnchor(anchor ? null : anchorOf(e.currentTarget))}
        >
          <Icon name="filter" />
          {count > 0 && <span className="jira-badge">{count}</span>}
        </button>
        <button
          className={`icon-button jira-selecttoggle${selectMode ? " active" : ""}`}
          title={selectMode ? "Stop selecting" : "Select several tickets"}
          aria-label="Select several tickets"
          aria-pressed={selectMode}
          onClick={onToggleSelectMode}
        >
          <Icon name="checklist" />
        </button>
        {onOpenTab && (
          <button
            className="icon-button jira-opentab"
            title="Open in an editor tab"
            aria-label="Open in an editor tab"
            onClick={onOpenTab}
          >
            <Icon name="screen-full" />
          </button>
        )}
      </div>
      {chips.length > 0 && (
        <div className="jira-chips">
          {chips.map((chip) => (
            <button
              key={`${chip.facet}:${chip.value}`}
              className="jira-filter-chip"
              title={`Remove ${chip.label}`}
              onClick={() =>
                onApply(
                  chip.facet === "text" ? setText(filters, "") : removeValue(filters, chip.facet, chip.value),
                )
              }
            >
              {chip.label}
              <span aria-hidden="true">&times;</span>
            </button>
          ))}
          <button className="jira-linkish" onClick={() => onApply(EMPTY_FILTERS)}>
            Clear
          </button>
        </div>
      )}
      {anchor && (
        <FacetPopover
          anchor={anchor}
          filters={filters}
          facets={facets}
          showAssignee={showAssignee}
          onApply={onApply}
          onClose={() => setAnchor(null)}
          view={view}
          onView={onView}
        />
      )}
    </div>
  );
}
