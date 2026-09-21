// The graph's controls: the two filter menus in the graph's toolbar row, and
// the find bar that drops in under it.
//
// The menus portal into document.body and position themselves against their
// button's rect rather than hanging off it in the DOM. The host's editor
// area clips its overflow, and the toolbar row is only as tall as its
// buttons - an absolutely positioned panel inside it would be cut off.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import Icon from "./Icon";
import { authorSummary, branchSummary, type GraphFilter } from "./filterModel";

export interface RefList {
  current: string | null;
  local: string[];
  remotes: string[];
  tags: string[];
}

export interface AuthorEntry {
  name: string;
  email: string;
  commits: number;
}

const MENU_WIDTH = 260;
const MENU_MARGIN = 8;

// On a touch screen, focusing a menu's filter field the moment the menu
// opens raises the on-screen keyboard over half the list the finger was
// reaching for. A mouse user gets the focus (type to filter straight away);
// a finger taps the field when it wants it.
function wantsAutoFocus(): boolean {
  return typeof window.matchMedia !== "function" || !window.matchMedia("(pointer: coarse)").matches;
}

function Menu({
  label,
  title,
  icon,
  active,
  children,
  onOpen,
}: {
  label: string;
  title: string;
  icon: string;
  active: boolean;
  children: (close: () => void) => ReactNode;
  onOpen?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  // Measured after layout so the panel can be flipped back inside the window
  // before it is ever painted at the wrong place.
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    // Never wider than the window: on a narrow phone the panel takes the
    // whole width less its margins rather than running off the edge.
    const width = Math.min(MENU_WIDTH, window.innerWidth - MENU_MARGIN * 2);
    const left = Math.max(MENU_MARGIN, Math.min(rect.left, window.innerWidth - width - MENU_MARGIN));
    setPos({ left, top: rect.bottom + 2, width });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      // Not every event carries an element: contains() throws on anything
      // that isn't a Node, and a throw here would leave the menu stuck open.
      const target = e.target instanceof Node ? e.target : null;
      if (target && (panelRef.current?.contains(target) || buttonRef.current?.contains(target))) return;
      setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    // Capture: a click anywhere else closes the menu before that click does
    // whatever else it does, which is what every other menu in the app does.
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);

  return (
    <>
      <button
        ref={buttonRef}
        className={`gg-menu-button${active ? " active" : ""}${open ? " open" : ""}`}
        title={title}
        aria-expanded={open}
        onClick={() => {
          setOpen((was) => {
            if (!was) onOpen?.();
            return !was;
          });
        }}
      >
        <Icon name={icon} />
        <span className="gg-menu-label">{label}</span>
        <Icon name="chevron-down" className="gg-menu-caret" />
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={panelRef}
            className="gg-menu-panel"
            style={{ left: pos.left, top: pos.top, width: pos.width }}
            role="dialog"
          >
            {children(() => setOpen(false))}
          </div>,
          document.body,
        )}
    </>
  );
}

function CheckRow({
  checked,
  label,
  detail,
  disabled,
  title,
  onClick,
}: {
  checked: boolean;
  label: string;
  detail?: string;
  disabled?: boolean;
  title?: string;
  onClick: () => void;
}) {
  return (
    <button className="gg-menu-row" disabled={disabled} title={title ?? label} onClick={onClick}>
      <span className="gg-menu-check">{checked ? <Icon name="check" /> : null}</span>
      <span className="gg-menu-row-label">{label}</span>
      {detail && <span className="gg-menu-row-detail">{detail}</span>}
    </button>
  );
}

function useNeedle(): [string, (value: string) => void, (text: string) => boolean] {
  const [needle, setNeedle] = useState("");
  const matches = useMemo(() => {
    const q = needle.trim().toLowerCase();
    return (text: string) => !q || text.toLowerCase().includes(q);
  }, [needle]);
  return [needle, setNeedle, matches];
}

export function BranchFilterMenu({
  filter,
  refs,
  loading,
  error,
  onOpen,
  onChange,
}: {
  filter: GraphFilter;
  refs: RefList | null;
  loading: boolean;
  error: string | null;
  onOpen: () => void;
  onChange: (next: GraphFilter) => void;
}) {
  const [needle, setNeedle, matches] = useNeedle();
  const picked = new Set(filter.refs);

  const toggleRef = (name: string) => {
    const next = new Set(picked);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    onChange({ ...filter, refs: [...next] });
  };

  const group = (label: string, names: string[]) => {
    const shown = names.filter(matches);
    if (shown.length === 0) return null;
    return (
      <div key={label} className="gg-menu-group">
        <div className="gg-menu-group-label">{label}</div>
        {shown.map((name) => (
          <CheckRow
            key={name}
            checked={picked.has(name)}
            label={name}
            detail={name === refs?.current ? "current" : undefined}
            onClick={() => toggleRef(name)}
          />
        ))}
      </div>
    );
  };

  // The three kind toggles only decide what "every ref" means, so they have
  // nothing to do while specific refs are picked. Saying that beats letting
  // someone flip a switch that changes nothing.
  const kindsApply = filter.refs.length === 0;
  const kindTitle = kindsApply ? undefined : "Applies while no specific refs are picked";

  return (
    <Menu
      label={branchSummary(filter)}
      title="Choose which branches, remotes and tags the graph walks"
      icon="git-branch"
      active={filter.refs.length > 0 || !filter.showRemotes || !filter.showTags || !filter.showStashes}
      onOpen={onOpen}
    >
      {() => (
        <>
          <input
            className="gg-menu-search"
            type="search"
            placeholder="Filter refs…"
            value={needle}
            autoFocus={wantsAutoFocus()}
            onChange={(e) => setNeedle(e.target.value)}
          />
          <div className="gg-menu-list">
            <CheckRow
              checked={filter.refs.length === 0}
              label="All branches"
              onClick={() => onChange({ ...filter, refs: [] })}
            />
            {error && <div className="gg-menu-note">{error}</div>}
            {!refs && loading && <div className="gg-menu-note">Loading…</div>}
            {refs && (
              <>
                {group("Local", refs.local)}
                {group("Remotes", refs.remotes)}
                {group("Tags", refs.tags)}
              </>
            )}
          </div>
          <div className="gg-menu-footer">
            <CheckRow
              checked={filter.showRemotes}
              label="Show remote branches"
              disabled={!kindsApply}
              title={kindTitle}
              onClick={() => onChange({ ...filter, showRemotes: !filter.showRemotes })}
            />
            <CheckRow
              checked={filter.showTags}
              label="Show tags"
              disabled={!kindsApply}
              title={kindTitle}
              onClick={() => onChange({ ...filter, showTags: !filter.showTags })}
            />
            <CheckRow
              checked={filter.showStashes}
              label="Show stashes"
              disabled={!kindsApply}
              title={kindTitle}
              onClick={() => onChange({ ...filter, showStashes: !filter.showStashes })}
            />
          </div>
        </>
      )}
    </Menu>
  );
}

export function AuthorFilterMenu({
  filter,
  authors,
  loading,
  error,
  onOpen,
  onChange,
}: {
  filter: GraphFilter;
  authors: AuthorEntry[] | null;
  loading: boolean;
  error: string | null;
  onOpen: () => void;
  onChange: (next: GraphFilter) => void;
}) {
  const [needle, setNeedle, matches] = useNeedle();
  const picked = new Set(filter.authors);

  const toggleAuthor = (name: string) => {
    const next = new Set(picked);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    onChange({ ...filter, authors: [...next] });
  };

  const shown = (authors ?? []).filter((a) => matches(a.name) || matches(a.email));

  return (
    <Menu
      label={authorSummary(filter)}
      title="Show only commits by the authors you pick"
      icon="person"
      active={filter.authors.length > 0}
      onOpen={onOpen}
    >
      {() => (
        <>
          <input
            className="gg-menu-search"
            type="search"
            placeholder="Filter authors…"
            value={needle}
            autoFocus={wantsAutoFocus()}
            onChange={(e) => setNeedle(e.target.value)}
          />
          <div className="gg-menu-list">
            <CheckRow
              checked={filter.authors.length === 0}
              label="All authors"
              onClick={() => onChange({ ...filter, authors: [] })}
            />
            {error && <div className="gg-menu-note">{error}</div>}
            {!authors && loading && <div className="gg-menu-note">Loading…</div>}
            {authors && shown.length === 0 && <div className="gg-menu-note">No author matches.</div>}
            {shown.map((author) => (
              <CheckRow
                key={author.name}
                checked={picked.has(author.name)}
                label={author.name}
                detail={String(author.commits)}
                title={author.email ? `${author.name} <${author.email}>` : author.name}
                onClick={() => toggleAuthor(author.name)}
              />
            ))}
          </div>
          <div className="gg-menu-footer">
            <div className="gg-menu-note">
              Picking an author hides the commits in between, so the lanes are hidden with them.
            </div>
          </div>
        </>
      )}
    </Menu>
  );
}

export function FindBar({
  query,
  onQuery,
  matchCount,
  position,
  onStep,
  filterMode,
  onFilterMode,
  onClose,
}: {
  query: string;
  onQuery: (value: string) => void;
  matchCount: number;
  // 1-based position of the current hit, 0 when there is none.
  position: number;
  onStep: (delta: number) => void;
  filterMode: boolean;
  onFilterMode: (value: boolean) => void;
  onClose: () => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const status = !query.trim() ? "" : matchCount === 0 ? "No results" : `${position} of ${matchCount}`;

  return (
    <div className="gg-find">
      <Icon name="search" className="gg-find-icon" />
      <input
        ref={inputRef}
        className="gg-find-input"
        type="text"
        placeholder="Find commit, author, hash or ref"
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onStep(e.shiftKey ? -1 : 1);
          } else if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
      />
      <span className={`gg-find-status${query.trim() && matchCount === 0 ? " none" : ""}`}>{status}</span>
      <button
        className="icon-button"
        title="Previous match (Shift+Enter)"
        disabled={matchCount === 0}
        onClick={() => onStep(-1)}
      >
        <Icon name="arrow-up" />
      </button>
      <button className="icon-button" title="Next match (Enter)" disabled={matchCount === 0} onClick={() => onStep(1)}>
        <Icon name="arrow-down" />
      </button>
      <label className="gg-find-toggle" title="Show only the commits that match, and hide the lanes with them">
        <input type="checkbox" checked={filterMode} onChange={(e) => onFilterMode(e.target.checked)} />
        Filter
      </label>
      <button className="icon-button" title="Close (Escape)" onClick={onClose}>
        <Icon name="close" />
      </button>
    </div>
  );
}
