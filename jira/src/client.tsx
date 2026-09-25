// jira: two JIRA sidebar panes - the issues assigned to you and the active
// repo's project - via the Jira Cloud REST API, with a "Start work" action
// per row that creates a worktree session for it (optionally priming an agent
// and moving the issue to In Progress), and a details popover that shows the
// description and comment thread without leaving the sidebar. Host hooks
// arrive via module-level bridge variables set once in activate() - same
// pattern every bundled-style extension uses.
//
// The two lists are separate registerSidebarPanel panes rather than two
// sections inside one component (git-scm's COMMITS/STASH do the same): the
// host's accordion then owns collapsing, resizing, reordering and moving them
// between tabs, and remembers all of it per user. Because they are separate
// React trees that need the same data, the fetching lives in one module-level
// store below instead of in either component.
import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import "./style.css";
import { injectStylesheet } from "./injectStylesheet";
import { apiGet, apiPost, setApiFetcher } from "./api";
import {
  addCluster,
  analyzeBatch,
  applyProposal,
  getBadge,
  getBatch,
  installBundledQaSkill,
  listAiProfiles,
  listBatches,
  listSkills,
  lookupIssues,
  moveTicket,
  removeCluster,
  renameBatch,
  renameCluster,
  setClusterBranch,
  startClusters,
  clusterAction,
  rebuildReport,
  saveFeedbackDraft as saveFeedback,
  acceptTicket,
  sendFeedback,
  archiveBatch,
  unarchiveBatch as unarchive,
  deleteBatch,
  subscribeBatchEvents,
} from "./batchApi";
import type { Batch, BatchSummary, ClusterAction, SkillsResponse } from "./batchTypes";
import Icon from "./Icon";
import {
  agentWindows,
  fetchAgents,
  fetchSessions,
  resolveAgentPresets,
  sendToAgent,
  type AgentLaunchPreset,
} from "./agentTarget";
import SettingsPanel, { ProjectMapSettings, onTokenChange, setFetcher, setSettingsBridge } from "./SettingsPanel";
import FilterBar from "./FilterBar";
import Markdown, { setMarkdownAssetUrl } from "./Markdown";
import SelectionBar from "./SelectionBar";
import StartWorkForm from "./StartWorkForm";
import BatchForm from "./BatchForm";
import KeyPasteForm from "./KeyPasteForm";
import BatchReview, { QA_DEFAULT_NOTE } from "./BatchReview";
import BatchBoard from "./BatchBoard";
import BatchDetail from "./BatchDetail";
import SkillPicker from "./SkillPicker";
import Lightbox, { type Shot } from "./Lightbox";
import ProjectPicker from "./ProjectPicker";
import { buildCombinedBrief } from "./brief";
import { buildBranch, sessionNameFor } from "./naming";
import { parseProjectMap, serializeProjectMap, upsertProjectMap } from "./projectMap";
import { anchorOf, usePopoverPosition, type PopoverAnchor } from "./usePopoverPosition";
import { useMarqueeSelection } from "./useMarqueeSelection";
import { useLongPressMenu } from "./useLongPressMenu";
import { useLayoutChoice, useSplitResize } from "./useSplitResize";
import {
  EMPTY_FILTERS,
  filterParams,
  isEmpty as filtersAreEmpty,
  parseFilterStore,
  readFilters,
  serializeFilterStore,
  writeFilters,
  type FilterStore,
  type IssueFilters,
  type ListId,
} from "./filterModel";
import { applyMarquee, orderedSelection, prune, selectRange, toggle, parseIssueKeys } from "./selectionModel";
import { TtlCache } from "./ttlCache";
import {
  DEFAULT_VIEW,
  parseViewStore,
  readView,
  serializeViewStore,
  sortParams,
  toggleSort,
  writeView,
  type ListView,
  type SortField,
  type ViewStore,
} from "./sortModel";
import { displayKeys, groupByProject } from "./groupModel";
import { initials } from "./format";
import Board from "./Board";
import ColumnEditor from "./ColumnEditor";
import {
  CATEGORY_ORDER,
  hidingUnassigned,
  parseBoardConfig,
  resolveColumns,
  serializeBoardConfig,
  unplacedIssues,
  type BoardConfig,
} from "./boardModel";
import type {
  MenuItem,
  Facets,
  IssueDetail,
  IssueRow,
  IssuesResponse,
  ProgressResponse,
  ProjectRow,
  StatusResponse,
  WorktreeResponse,
  WorktreeRow,
} from "./types";

// ---- Module-level host bridge ----

interface ActiveContext {
  sessionName: string | null;
  windowIndex: number | null;
  cwd: string | null;
}

interface SettingsApi {
  get(key: string): unknown;
  // The host has offered this all along (docs/EXTENSION_API.md's ctx.settings);
  // this structural copy just never declared it, because nothing here wrote a
  // setting. The filter memory and both project-mapping surfaces do.
  set(key: string, value: unknown): void;
  onDidChange(cb: () => void): () => void;
}

// MenuItem lives in types.ts, so the batch views can type their own
// showMenu prop without importing this module back.

// The subset of the host's SidebarPanelHostProps these panes use.
interface SidebarPanelHostProps {
  showMenu?: (x: number, y: number, items: MenuItem[]) => void;
}

let serverFetch: ((path: string, init?: RequestInit) => Promise<Response>) | null = null;
let getActiveContext: (() => ActiveContext) | null = null;
let onDidChangeContext: ((cb: (ctx: ActiveContext) => void) => () => void) | null = null;
let openSessionWindow: ((sessionName: string, opts?: { createCwd?: string }) => void) | null = null;
let hostConfirm: ((message: string, confirmLabel?: string) => Promise<boolean>) | null = null;
let hostPrompt: ((message: string, value?: string) => Promise<string | null>) | null = null;
let setHostBadge: ((panelId: string, badge: number | null) => void) | null = null;
let openFileTab: ((path: string, line?: number) => void) | null = null;

// The app's own dialog where there is one; the browser's where there is not.
// Never "just do it": every caller here is destructive.
function confirmDialog(message: string, confirmLabel?: string): Promise<boolean> {
  if (hostConfirm) return hostConfirm(message, confirmLabel);
  return Promise.resolve(window.confirm(message));
}

// The app's prompt where there is one. Not destructive, but the same
// reasoning: a rename belongs in the app's own dialog, not the browser's.
function promptDialog(message: string, value?: string): Promise<string | null> {
  if (hostPrompt) return hostPrompt(message, value);
  return Promise.resolve(window.prompt(message, value ?? ""));
}
let extSettings: SettingsApi | null = null;
let removeStylesheet: (() => void) | null = null;
let disposeBridge: (() => void)[] = [];

// The response shapes live in types.ts, so the tested models beside it can
// share them without importing this React tree.

// ---- Fetch helpers ----
//
// In api.ts, so the batch views can call the same hook without importing this
// panel (which imports them).

// ---- Helpers ----
//
// Branch and session naming live in naming.ts, and the agent's brief in
// brief.ts - the start-work form prefills a branch from the same function
// that creates one, so both have to be reachable from outside this file.

function relativeTime(iso: string | null): string {
  if (!iso) return "";
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 365) return `${days}d`;
  return `${Math.round(days / 365)}y`;
}

// ---- Agent launch presets ----
// Which agents "Start work" can offer comes from the app's own registry
// (Settings → AI Providers), shared with every other extension that needs to know
// what an agent is. This extension never shipped an agents setting of its
// own, so unlike github and agent-monitor there is no deprecated value to
// prefer and none is read. There are no built-in presets either: when the
// registry cannot be read (an older core without it), resolveAgentPresets
// rejects.
//
// The registry is a fetch, so unlike the old JSON setting it cannot be
// parsed inline during render. Cached at module level with a short TTL: the
// click path always awaits (so it is never wrong about which presets exist),
// while render reads whatever is cached, which only drives a tooltip.
const PRESETS_TTL_MS = 10_000;
let cachedPresets: AgentLaunchPreset[] = [];
let cachedPresetsAt = 0;
let presetsInFlight: Promise<AgentLaunchPreset[]> | null = null;

// Cached-or-fetched; a failed fetch rejects (resolveAgentPresets does not
// degrade) and is not cached. Concurrent callers share one request.
function agentPresets(): Promise<AgentLaunchPreset[]> {
  if (Date.now() - cachedPresetsAt < PRESETS_TTL_MS) return Promise.resolve(cachedPresets);
  if (presetsInFlight) return presetsInFlight;
  presetsInFlight = resolveAgentPresets()
    .then((presets) => {
      cachedPresets = presets;
      cachedPresetsAt = Date.now();
      return presets;
    })
    .finally(() => {
      presetsInFlight = null;
    });
  return presetsInFlight;
}

// The cached presets for render, kept current by the panel's own re-renders
// rather than read once at mount - so changing Settings → AI Providers shows up
// within the TTL instead of waiting for a remount, which is how the old
// inline parse behaved.
function useAgentPresets(): AgentLaunchPreset[] {
  const [presets, setPresets] = useState(cachedPresets);
  useEffect(() => {
    let alive = true;
    agentPresets().then(
      (next) => {
        // Same array reference when nothing was re-fetched, so this cannot
        // loop through the effect.
        if (alive) setPresets(next);
      },
      () => {
        // Tooltip wording only; Start work handles the failure itself.
      },
    );
    return () => {
      alive = false;
    };
  });
  return presets;
}

export function readSetting(key: string): string {
  const value = extSettings?.get(key);
  return typeof value === "string" ? value : "";
}

// Core types text literally, which puts the newlines on the
// wire raw - and a terminal program reads each one as Enter. So a multi-line
// brief submitted itself line by line (a shell ran every line as its own
// command; an agent TUI sent the first line as a whole message), and the
// trailing Enter that was meant to submit it landed on an empty prompt. That
// is why ticking jira.sendAutoSubmit appeared to do nothing.
//
// Bracketed-paste markers tell the receiving program "everything between
// these is one paste", so the block lands in its composer intact and only the
// explicit Enter submits it. Applied only to multi-line text: a program that
// never enabled bracketed-paste mode would otherwise render the markers as
// literal junk, and single-line sends (the agent's own launch command) never
// needed this.
function asPaste(text: string): string {
  return text.includes("\n") ? `[200~${text}[201~` : text;
}

// ---- Shared store ----
//
// Both panes need the same status and the same in-flight/error state, and the
// two lists come from one /status call plus one /issues call each. Keeping
// that in a module-level store means one fetch feeds both panes, a "Start
// work" error shows wherever you are looking, and only one details popover
// can be open at a time.

// ListId lives in filterModel.ts, which keys the saved filters by it.

interface PopoverState {
  key: string;
  // The same issue key can appear in BOTH lists, so the owning list is part
  // of the identity - otherwise opening it in one pane would also render it
  // in the other.
  list: ListId;
  anchor: PopoverAnchor;
  detail: IssueDetail | null;
  error: string | null;
}

// Where a floating form was opened from: one of the two sidebar panes, or
// the editor tab. Each form renders only in the host it was opened from - the
// panes and the tab all read one store, and a form drawn in a pane the user
// is not looking at (collapsed, or on another sidebar tab) is a form they
// never see.
export type Host = ListId | "tab";

// The start-work form, open only for a selection of more than one ticket -
// naming a three-ticket branch after one of them is wrong often enough to be
// worth a field. One ticket keeps the one-click path it always had.
interface StartFormState {
  origin: Host;
  issues: IssueRow[];
  anchor: PopoverAnchor;
  branch: string;
  presets: AgentLaunchPreset[];
  // An index into `presets`, or -1 for "no agent".
  presetIndex: number;
  busy: boolean;
  error: string | null;
}

interface PickerState {
  origin: Host;
  anchor: PopoverAnchor;
  error: string | null;
}

// The editor tab's detail pane: the ticket last clicked, and its full detail
// once /issue answers. The tab's counterpart to the sidebar's popover.
interface FocusedState {
  key: string;
  detail: IssueDetail | null;
  error: string | null;
}

interface JiraState {
  cwd: string | null;
  status: StatusResponse | null;
  mine: IssueRow[];
  project: IssuesResponse | null;
  loading: boolean;
  error: string | null;
  busyKey: string | null;
  startError: string | null;
  note: string | null;
  popover: PopoverState | null;
  // Per pane, because the two ask different questions of the same backlog.
  // Persisted per repo in jira.filters - see filterModel.ts.
  filters: Record<ListId, IssueFilters>;
  filterStore: FilterStore;
  // How each list is ordered and whether it is grouped, remembered per repo
  // in jira.listViews - apart from the filters, so Clear leaves it alone.
  views: Record<ListId, ListView>;
  viewStore: ViewStore;
  // Collapsed project sections, as "<list>:<project key>". Per session, like
  // the host's own tree chevrons.
  collapsedGroups: Set<string>;
  facets: Facets | null;
  // One set of issue keys for both panes: the same ticket listed twice is one
  // ticket, and selecting it in either place means the same thing.
  selection: Set<string>;
  selectMode: boolean;
  // The paste box, when it is open.
  keyPaste: KeyPasteState | null;
  // The shift-click anchor is per pane, since each has its own row order.
  anchor: Record<ListId, string | null>;
  startForm: StartFormState | null;
  // The site's projects, fetched once per cwd for the project picker.
  projects: ProjectRow[];
  projectPicker: PickerState | null;
  // The editor tab: which list it is showing, and which ticket is open in its
  // detail pane. Kept in the store rather than the tab component so closing
  // and reopening the tab lands where it was.
  tabList: ListId;
  focused: FocusedState | null;
  // Table or board, remembered per browser. The board has its own list -
  // larger, and with recently finished tickets - fetched only while the board
  // is on screen (boardActive, set by the tab) and only for the tab's list.
  tabView: TabView;
  boardActive: boolean;
  board: IssuesResponse | null;
  // The one global column configuration, from jira.board.
  boardConfig: BoardConfig;
  // The column editor, open from the board's toolbar.
  columnEditor: { anchor: PopoverAnchor } | null;
  // ---- Batches ----
  // The repo's batches, for the Plan batch menu and the picker. Summaries
  // only; the open batch below is the full document.
  batchSummaries: BatchSummary[];
  batchArchived: BatchSummary[];
  // The batch on screen, exactly as the server computed it. Replaced whole
  // on every change, never patched.
  batch: Batch | null;
  // Its clusters as a plan you are still editing, or as agents at work.
  batchView: BatchView;
  // Which clusters the board is showing. Empty means all of them, so a new
  // cluster is never hidden by a filter set before it existed.
  clusterFilter: Set<string>;
  batchForm: BatchFormState | null;
  batchBusy: boolean;
  batchError: string | null;
  batchNote: string | null;
  // Tickets that need you, across every batch - the sidebar tab's badge.
  batchBadge: number;
  // The open screenshot, if any. `shots` is every stored image in the batch
  // in board order, so the arrows walk the whole batch rather than the two on
  // one ticket - comparing across tickets is most of what reviewing is.
  lightbox: { shots: Shot[]; index: number } | null;
  // What the pickers offer for this repository, fetched with the batch list.
  skills: SkillsResponse | null;
  // The slots this run will use. They start from the stored settings and are
  // overridden per cluster in the review bar, for that run only.
  executionSkill: string;
  qaSkill: string;
}

type TabView = "table" | "board" | "batches";
type BatchView = "review" | "board";

// The Plan batch popover: which tickets, how to split them, and whether the
// AI may read the repository first.
interface KeyPasteState {
  origin: Host;
  anchor: PopoverAnchor;
  text: string;
  busy: boolean;
  note: string | null;
  error: string | null;
}

interface BatchFormState {
  origin: Host;
  anchor: PopoverAnchor;
  // null for a new batch; an id to add these tickets to that one.
  batchId: string | null;
  issues: IssueRow[];
  keysText: string;
  lookupNote: string | null;
  criteria: string;
  readCodebase: boolean;
  canReadCodebase: boolean;
  // Skip the AI and keep every ticket in one cluster.
  single: boolean;
  aiHint: string | null;
  busy: boolean;
  error: string | null;
  // The server refused a codebase read for a reason a plain retry fixes.
  fallback: boolean;
}

const TAB_VIEW_KEY = "perch.jira.tabView";

function readTabView(): TabView {
  try {
    const stored = localStorage.getItem(TAB_VIEW_KEY);
    // Batches is deliberately not restored: it needs a batch loaded, and a
    // tab that reopens on an empty third mode reads as broken.
    return stored === "board" ? "board" : "table";
  } catch {
    return "table";
  }
}

const NO_FILTERS: Record<ListId, IssueFilters> = { mine: EMPTY_FILTERS, project: EMPTY_FILTERS };

let state: JiraState = {
  cwd: null,
  status: null,
  mine: [],
  project: null,
  loading: false,
  error: null,
  busyKey: null,
  startError: null,
  note: null,
  popover: null,
  filters: NO_FILTERS,
  filterStore: {},
  views: { mine: DEFAULT_VIEW, project: DEFAULT_VIEW },
  viewStore: {},
  collapsedGroups: new Set(),
  facets: null,
  selection: new Set(),
  selectMode: false,
  keyPaste: null,
  anchor: { mine: null, project: null },
  startForm: null,
  projects: [],
  projectPicker: null,
  tabList: "mine",
  focused: null,
  tabView: readTabView(),
  boardActive: false,
  board: null,
  boardConfig: { columns: [] },
  columnEditor: null,
  batchSummaries: [],
  batchArchived: [],
  batch: null,
  batchView: "board",
  clusterFilter: new Set<string>(),
  batchForm: null,
  batchBusy: false,
  batchError: null,
  batchNote: null,
  batchBadge: 0,
  lightbox: null,
  skills: null,
  executionSkill: "",
  qaSkill: "",
};

const listeners = new Set<() => void>();

function setState(patch: Partial<JiraState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

function useJira(): JiraState {
  const [, force] = useState(0);
  useEffect(() => {
    const listener = () => force((n) => n + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return state;
}

// Guards against an in-flight response from a previous cwd overwriting a
// newer one - the /status call makes a real network round trip to Atlassian
// and can easily outlive a fast tab switch.
let refreshToken = 0;

// The pane's own filters ride along as repeated query params, so the server
// narrows the JQL rather than the client sifting the rows that came back -
// see server.js's "Filters -> JQL". `text` is already debounced by FilterBar
// before it reaches the store, so this fires once per settled search.
// The sort rides along too (only when it isn't the default, so an untouched
// list asks for exactly the query it always did), and `board` asks for the
// board's larger list with recently finished tickets.
function issuesUrl(cwd: string, list: ListId, board = false): string {
  const params = new URLSearchParams([
    ["cwd", cwd],
    ["scope", list],
    ...filterParams(state.filters[list]),
    ...sortParams(state.views[list].sort),
    ...(board ? [["board", "1"] as [string, string]] : []),
  ]);
  return `/issues?${params.toString()}`;
}

function refresh(): void {
  const cwd = state.cwd;
  if (!cwd) {
    setState({ status: null, mine: [], project: null, error: null, loading: false, facets: null, projects: [], batchSummaries: [], batchArchived: [] });
    return;
  }
  const token = ++refreshToken;
  const q = encodeURIComponent(cwd);
  setState({ loading: true });
  apiGet<StatusResponse>(`/status?cwd=${q}`)
    .then((status) => {
      if (token !== refreshToken) return;
      setState({ status, error: null });
      if (!status.configured || !status.authed) {
        setState({ mine: [], project: null, loading: false, facets: null, projects: [] });
        return;
      }
      // Facets and projects are metadata, not issues: a failure there must
      // leave the lists working, so they settle on their own rather than
      // joining the lists' request, whose failure becomes the pane's error.
      loadFacets(token, q);
      loadProjects(token);
      loadIssues(cwd);
      // Batches belong to the repository, not to Jira, but this is where the
      // repository is settled - and the Plan batch menu needs them before it
      // is ever opened.
      loadBatches(cwd);
      refreshBadge();
      loadSkills(cwd);
      if (state.boardActive) loadBoard(cwd, state.tabList);
    })
    .catch((err: Error) => {
      if (token !== refreshToken) return;
      setState({ error: err.message, loading: false });
    });
}

// The two lists on their own, for a filter change. A filter narrows the
// lists and nothing else, so it has no business re-asking /status (a round
// trip to Atlassian's /myself), /facets (four more) or /projects - which is
// what every tick of the funnel used to cost, twice over.
function refreshIssues(): void {
  if (!state.cwd || !state.status?.configured || !state.status.authed) {
    refresh();
    return;
  }
  loadIssues(state.cwd);
  if (state.boardActive) loadBoard(state.cwd, state.tabList);
}

// Its own counter rather than refreshToken's: a list-only reload must not
// strand the facets or projects a full refresh still has in flight, which
// check refreshToken to know they are current.
let issuesToken = 0;

function loadIssues(cwd: string): void {
  const token = ++issuesToken;
  setState({ loading: true });
  Promise.all([apiGet<IssuesResponse>(issuesUrl(cwd, "mine")), apiGet<IssuesResponse>(issuesUrl(cwd, "project"))])
    .then(([mine, project]) => {
      if (token !== issuesToken || state.cwd !== cwd) return;
      // A selected issue the new lists no longer carry drops out of the
      // selection too, so the count can never name tickets nothing shows.
      const known = [...mine.issues, ...project.issues, ...(state.board?.issues ?? [])].map((issue) => issue.key);
      setState({
        mine: mine.issues,
        project,
        loading: false,
        error: null,
        selection: prune(state.selection, known),
      });
    })
    .catch((err: Error) => {
      if (token !== issuesToken) return;
      setState({ error: err.message, loading: false });
    });
}

// The board's own list, for the tab's list only. A ticket picked on the board
// but outside the table's cap (or already Done) stays picked across a reload
// because the prune above counts board tickets too.
let boardToken = 0;

function loadBoard(cwd: string, list: ListId): void {
  const token = ++boardToken;
  apiGet<IssuesResponse>(issuesUrl(cwd, list, true))
    .then((board) => {
      if (token !== boardToken || state.cwd !== cwd || state.tabList !== list) return;
      setState({ board });
    })
    .catch((err: Error) => {
      if (token !== boardToken) return;
      setState({ error: err.message });
    });
}

export function setTabView(view: TabView): void {
  if (state.tabView === view) return;
  setState({ tabView: view });
  try {
    localStorage.setItem(TAB_VIEW_KEY, view);
  } catch {
    // Blocked storage: the choice holds for this session.
  }
}

// Called by the tab while the board is showing. Turning it on fetches the
// board list; turning it off keeps what was fetched, so going back to the
// board shows it at once while a fresh copy loads.
export function setBoardActive(on: boolean): void {
  if (state.boardActive === on) return;
  setState({ boardActive: on });
  if (on && state.cwd && state.status?.configured && state.status.authed) loadBoard(state.cwd, state.tabList);
}

// ---- Ticket details, cached ----
//
// Opening a ticket - in the popover, in the tab, or to build its brief for an
// agent - reuses details fetched within jira.detailCacheSeconds rather than
// asking Atlassian again (two requests each: the issue and its comments).
// Expired entries are dropped on read and swept on a timer, so the cache does
// not hold on to tickets nobody opens again. The refresh button on a ticket
// bypasses it, and anything that changes a ticket or which site is being
// asked invalidates it.
const DETAIL_CACHE_MAX = 200;
const DETAIL_SWEEP_MS = 60_000;

function detailTtlMs(): number {
  const raw = extSettings?.get("jira.detailCacheSeconds");
  const seconds = typeof raw === "number" && Number.isFinite(raw) ? raw : 300;
  return Math.min(3600, Math.max(0, seconds)) * 1000;
}

const detailCache = new TtlCache<IssueDetail>({ ttlMs: detailTtlMs, max: DETAIL_CACHE_MAX });
// Two callers asking for the same ticket at once - the popover and a brief,
// say - share one request rather than racing two.
const detailInFlight = new Map<string, Promise<IssueDetail>>();

function fetchIssueDetail(key: string, { fresh = false }: { fresh?: boolean } = {}): Promise<IssueDetail> {
  if (!fresh) {
    const cached = detailCache.get(key);
    if (cached) return Promise.resolve(cached);
    const pending = detailInFlight.get(key);
    if (pending) return pending;
  }
  const request = apiGet<IssueDetail>(`/issue?key=${encodeURIComponent(key)}`)
    .then((detail) => {
      detailCache.set(key, detail);
      return detail;
    })
    .finally(() => {
      if (detailInFlight.get(key) === request) detailInFlight.delete(key);
    });
  detailInFlight.set(key, request);
  return request;
}

function loadFacets(token: number, q: string): void {
  apiGet<Facets>(`/facets?cwd=${q}`)
    .then((facets) => {
      if (token === refreshToken) setState({ facets });
    })
    .catch(() => {
      // The funnel renders only the facets it has; an unreachable metadata
      // call simply leaves that section out.
      if (token === refreshToken) setState({ facets: null });
    });
}

function loadProjects(token: number): void {
  apiGet<{ projects: ProjectRow[] }>("/projects")
    .then((body) => {
      if (token === refreshToken) setState({ projects: body.projects });
    })
    .catch(() => {
      if (token === refreshToken) setState({ projects: [] });
    });
}

// ---- Filters ----

// Every filter change lands here: the pane refetches, and the choice is
// remembered against this repo so it is still there after a reload and on
// whichever device opens the project next (Perch syncs the settings
// document). jira.filters is written but NOT declared in the manifest - it is
// panel state rewritten on every tick, and a text field for it in Settings
// would only invite hand-editing. filterModel.writeFilters prunes an emptied
// pane, so the setting can't grow one dead repo path at a time.
export function applyFilters(list: ListId, filters: IssueFilters): void {
  const filterStore = state.cwd ? writeFilters(state.filterStore, state.cwd, list, filters) : state.filterStore;
  setState({ filters: { ...state.filters, [list]: filters }, filterStore });
  if (state.cwd) extSettings?.set("jira.filters", serializeFilterStore(filterStore));
  refreshIssues();
}

export function filtersFor(list: ListId): IssueFilters {
  return state.filters[list];
}

// Loaded whenever the active repo changes, so each project reopens with the
// filters it was left under rather than with the last repo's. Pure, and
// returns the whole store as well as this repo's slice: applyFilters writes
// back into that store, so losing it would clobber every other repo's saved
// filters on the next tick.
function loadFiltersFor(cwd: string | null): Pick<JiraState, "filters" | "filterStore" | "views" | "viewStore"> {
  const filterStore = parseFilterStore(extSettings?.get("jira.filters"));
  const viewStore = parseViewStore(extSettings?.get("jira.listViews"));
  return {
    filterStore,
    filters: { mine: readFilters(filterStore, cwd, "mine"), project: readFilters(filterStore, cwd, "project") },
    viewStore,
    views: { mine: readView(viewStore, cwd, "mine"), project: readView(viewStore, cwd, "project") },
  };
}

// ---- Sort and group ----

// A new sort asks Jira again - it decides which tickets come back, not only
// their order. Grouping only rearranges what is already here, so it fetches
// nothing.
export function applyView(list: ListId, view: ListView): void {
  const before = state.views[list];
  const viewStore = state.cwd ? writeView(state.viewStore, state.cwd, list, view) : state.viewStore;
  setState({ views: { ...state.views, [list]: view }, viewStore });
  if (state.cwd) extSettings?.set("jira.listViews", serializeViewStore(viewStore));
  if (before.sort.field !== view.sort.field || before.sort.dir !== view.sort.dir) refreshIssues();
}

export function sortBy(list: ListId, field: SortField): void {
  const view = state.views[list];
  applyView(list, { ...view, sort: toggleSort(view.sort, field) });
}

export function toggleGroup(list: ListId, project: string): void {
  const id = `${list}:${project}`;
  const next = new Set(state.collapsedGroups);
  if (!next.delete(id)) next.add(id);
  setState({ collapsedGroups: next });
}

function collapsedFor(list: ListId): Set<string> {
  const prefix = `${list}:`;
  return new Set([...state.collapsedGroups].filter((id) => id.startsWith(prefix)).map((id) => id.slice(prefix.length)));
}

// ---- Selection ----

export function toggleSelected(list: ListId, key: string): void {
  setState({ selection: toggle(state.selection, key), anchor: { ...state.anchor, [list]: key } });
}

export function selectRangeTo(list: ListId, keys: string[], key: string): void {
  setState({
    selection: selectRange(state.selection, keys, state.anchor[list], key),
    anchor: { ...state.anchor, [list]: key },
  });
}

export function setMarquee(base: ReadonlySet<string>, ids: string[], additive: boolean): void {
  setState({ selection: applyMarquee(base, ids, additive) });
}

// Turning select mode off clears the selection: leaving rows ticked behind a
// hidden checkbox would keep the action bar up with no way to see what it is
// about to act on.
export function setSelectMode(on: boolean): void {
  setState(on ? { selectMode: true } : { selectMode: false, selection: new Set<string>() });
}

export function clearSelection(): void {
  setState({ selection: new Set<string>(), anchor: { mine: null, project: null } });
}

// In the order the panes list them, which is the order the brief and the Jira
// transitions follow. A ticket listed in both panes is returned once.
function selectedIssues(): IssueRow[] {
  return orderedSelection([state.mine, state.project?.issues ?? [], state.board?.issues ?? []], state.selection);
}

// ---- Start work ----

function addNote(text: string | null): void {
  if (!text) return;
  setState({ note: state.note ? `${state.note} ${text}` : text });
}

// Never fatal: by the time this runs the worktree exists and the agent has
// its tickets, so a Jira-side failure must not read as "Start work failed".
// One call per ticket, since /progress transitions a single issue - and one
// ticket failing leaves the rest moved rather than abandoning the batch.
async function runProgress(issues: IssueRow[]): Promise<void> {
  if (extSettings?.get("jira.updateIssueOnStartWork") !== true) return;
  for (const issue of issues) {
    try {
      const progress = await apiPost<ProgressResponse>("/progress", { key: issue.key });
      // Its status (and maybe its assignee) just changed in Jira, so the
      // cached copy is wrong now whatever its age.
      detailCache.delete(issue.key);
      if (progress.note) addNote(`${issue.key}: ${progress.note}`);
    } catch (err) {
      addNote(`${issue.key}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

interface HandOverTarget {
  sessionName: string;
  // Set when an agent was found already running: a repo session can have
  // several windows and only one of them is the agent. Omitted for a session
  // just created, which has no window to aim at yet.
  windowIndex?: number;
  // Null when the agent is already running and only needs the tickets.
  launch: AgentLaunchPreset | null;
}

// The tickets reach the agent as ONE paste, whether there is one of them or
// five. Each send is a separate message into the composer, so five sends
// would be five prompts and the agent would start on the first before it had
// seen the rest.
async function handOver(target: HandOverTarget, issues: IssueRow[]): Promise<void> {
  const { sessionName, windowIndex, launch } = target;
  if (launch) {
    // Already carries the app's Yolo/Manual choice - see resolveAgentPresets.
    await sendToAgent(sessionName, launch.command, true, { retries: 12, retryDelayMs: 400, windowIndex });
  }
  const details = await Promise.all(issues.map((issue) => fetchIssueDetail(issue.key)));
  await sendToAgent(
    sessionName,
    asPaste(buildCombinedBrief(details)),
    extSettings?.get("jira.sendAutoSubmit") === true,
    { retries: 6, retryDelayMs: 400, windowIndex },
  );
}

// Returns null on success, or the message to show. The caller decides where
// that belongs: the panel's error line for the one-click path, the form's own
// line for the several-ticket one, which stays open so the branch can be
// edited after a 409.
async function createWorktreeAndHandOver(
  issues: IssueRow[],
  branch: string,
  preset: AgentLaunchPreset | null,
): Promise<string | null> {
  const cwd = state.cwd;
  if (!cwd || issues.length === 0) return null;
  try {
    const result = await apiPost<WorktreeResponse>("/worktree", { cwd, branch });
    const sessionName = sessionNameFor(branch);
    openSessionWindow?.(sessionName, { createCwd: result.path });
    // A fallback base is worth saying out loud - the worktree is real either
    // way, but it didn't start where the user expected.
    addNote(result.note);
    await runProgress(issues);
    if (preset) await handOver({ sessionName, launch: preset }, issues);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

// One ticket, one click - the row's play button, unchanged.
async function startWork(issue: IssueRow, preset: AgentLaunchPreset | null): Promise<void> {
  setState({ busyKey: issue.key, startError: null, note: null });
  const branch = buildBranch(readSetting("jira.branchTemplate"), issue);
  const error = await createWorktreeAndHandOver([issue], branch, preset);
  setState({ busyKey: null, startError: error });
}

// The one-ticket start as a row's play button and the tab's detail pane both
// offer it. With more than one agent in the registry it asks which to use
// instead of silently taking the first: offering only entry [0] made every
// agent after the first unreachable. One agent (or no showMenu from the host)
// keeps the direct, no-click-extra path.
//
// Whether to skip permission prompts is NOT asked here. It is one global
// choice - Settings → AI Providers' Yolo/Manual - and the app applies it to
// the command this extension is handed. Asking again per issue meant the same
// question in three places, and a local answer could silently contradict the
// global one.
export async function startWorkWithPicker(
  issue: IssueRow,
  showMenu: SidebarPanelHostProps["showMenu"],
  x: number,
  y: number,
): Promise<void> {
  let presets: AgentLaunchPreset[];
  try {
    presets = await agentPresets();
  } catch {
    // No agent list (an older core): the worktree is still worth making.
    void startWork(issue, null);
    return;
  }
  if (presets.length <= 1 || !showMenu) {
    void startWork(issue, presets[0] ?? null);
    return;
  }
  showMenu(x, y, [
    ...presets.map((preset) => ({
      label: preset.name,
      onClick: () => void startWork(issue, preset),
    })),
    { label: "No agent (worktree only)", onClick: () => void startWork(issue, null) },
  ]);
}

// ---- The editor tab ----

export function setTabList(list: ListId): void {
  if (state.tabList === list) return;
  // The board list belongs to one list; the other's is fetched fresh.
  setState({ tabList: list, board: null });
  if (state.boardActive && state.cwd && state.status?.authed) loadBoard(state.cwd, list);
}

// Opens a ticket in the tab's detail pane. A response that lands after the
// user has moved on to another ticket is dropped rather than painted over it.
// Closing the detail pane's ticket. Stacked on a phone, that also hands the
// pane's height back to the list - see JiraTab.
export function clearFocus(): void {
  if (state.focused) setState({ focused: null });
}

export function focusIssue(issue: IssueRow, { fresh = false }: { fresh?: boolean } = {}): void {
  if (!fresh && state.focused?.key === issue.key && state.focused.detail) return;
  // A cached ticket shows at once, with no "Loading…" flash in between; a
  // forced refresh keeps the old details on screen until the new ones land.
  const cached = fresh ? null : detailCache.get(issue.key);
  const shown = fresh && state.focused?.key === issue.key ? state.focused.detail : null;
  setState({ focused: { key: issue.key, detail: cached ?? shown, error: null } });
  if (cached) return;
  fetchIssueDetail(issue.key, { fresh })
    .then((detail) => {
      if (state.focused?.key !== issue.key) return;
      setState({ focused: { key: issue.key, detail, error: null } });
    })
    .catch((err: Error) => {
      if (state.focused?.key !== issue.key) return;
      setState({ focused: { key: issue.key, detail: null, error: err.message } });
    });
}

// ---- The several-ticket start form ----

export async function openStartForm(anchor: PopoverAnchor, origin: Host): Promise<void> {
  const issues = selectedIssues();
  if (issues.length === 0) return;
  let presets: AgentLaunchPreset[] = [];
  try {
    presets = await agentPresets();
  } catch {
    // No agent registry (an older core): the worktree is still worth making,
    // so the form opens with "No agent" as its only choice.
  }
  setState({
    startForm: {
      origin,
      issues,
      anchor,
      // Prefilled from the FIRST selected ticket and editable - naming a
      // three-ticket branch after one of them is wrong often enough to be
      // worth a field.
      branch: buildBranch(readSetting("jira.branchTemplate"), issues[0]),
      presets,
      presetIndex: presets.length > 0 ? 0 : -1,
      busy: false,
      error: null,
    },
  });
}

export function updateStartForm(patch: Partial<StartFormState>): void {
  if (state.startForm) setState({ startForm: { ...state.startForm, ...patch } });
}

export function closeStartForm(): void {
  setState({ startForm: null });
}

export async function submitStartForm(): Promise<void> {
  const form = state.startForm;
  if (!form) return;
  const branch = form.branch.trim();
  if (!branch) {
    setState({ startForm: { ...form, error: "Enter a branch name." } });
    return;
  }
  setState({ startForm: { ...form, busy: true, error: null }, note: null });
  const preset = form.presetIndex >= 0 ? (form.presets[form.presetIndex] ?? null) : null;
  const error = await createWorktreeAndHandOver(form.issues, branch, preset);
  if (!state.startForm) return;
  if (error) {
    setState({ startForm: { ...state.startForm, busy: false, error } });
    return;
  }
  setState({ startForm: null, selection: new Set<string>(), selectMode: false });
}

// ---- Adding tickets to a worktree that already exists ----

// A worktree's name: its branch, else a short detached head, else the
// checkout's folder name. Matches how core labels a worktree row.
function worktreeLabel(worktree: WorktreeRow): string {
  if (worktree.branch) return worktree.branch;
  if (worktree.detached) return `(detached ${worktree.head?.slice(0, 7) ?? "?"})`;
  return worktree.path.split("/").filter(Boolean).pop() ?? worktree.path;
}

interface WorktreeChoice {
  worktree: WorktreeRow;
  label: string;
  sessionName: string | null;
  agent: { sessionName: string; windowIndex: number } | null;
}

// Every checkout of the repo, each marked with what is already running in it:
// one with a live agent takes the tickets straight away, one with a session
// but no agent needs an agent started, one with neither needs both.
async function worktreeChoices(cwd: string): Promise<WorktreeChoice[]> {
  const [listing, sessions, registry] = await Promise.all([
    apiGet<{ worktrees: WorktreeRow[] }>(`/worktrees?cwd=${encodeURIComponent(cwd)}`),
    fetchSessions(),
    // An older core without the agent registry still gets the worktree list;
    // it just can't report which of them is running an agent.
    fetchAgents().catch(() => ({ agents: [], skipPermissions: false })),
  ]);

  // Synthetic window-tab sessions mirror a real session's windows and carry
  // the same path, so they would shadow the session actually rooted in the
  // worktree - and opening one by name is not a thing to do. Same prefix
  // agentWindows skips for the same reason (see agentTarget.ts).
  const real = sessions.filter((session) => !session.name.startsWith("perch-view-"));

  return listing.worktrees.map((worktree) => {
    // Core reports a session's path with $HOME shortened to "~", which is the
    // half to match on; the absolute path is what creates a session.
    const session =
      real.find((s) => s.path === worktree.displayPath || s.path === worktree.path) ?? null;
    const found = session ? (agentWindows([session], session.path, registry.agents)[0] ?? null) : null;
    const running = found ? "agent running" : session ? "session, no agent" : "no session";
    return {
      worktree,
      label: `${worktreeLabel(worktree)}  ${running}`,
      sessionName: session?.name ?? null,
      agent: found ? { sessionName: found.sessionName, windowIndex: found.windowIndex } : null,
    };
  });
}

async function runAdd(issues: IssueRow[], target: HandOverTarget | null): Promise<void> {
  setState({ busyKey: issues[0]?.key ?? null, startError: null, note: null });
  try {
    await runProgress(issues);
    if (target) await handOver(target, issues);
    setState({ selection: new Set<string>(), selectMode: false });
  } catch (err) {
    setState({ startError: err instanceof Error ? err.message : String(err) });
  } finally {
    setState({ busyKey: null });
  }
}

type ShowMenu = NonNullable<SidebarPanelHostProps["showMenu"]>;

function sendToWorktree(
  choice: WorktreeChoice,
  issues: IssueRow[],
  showMenu: ShowMenu,
  x: number,
  y: number,
): void {
  // Already running: the tickets go straight into that window, and nothing
  // is created.
  if (choice.agent) {
    void runAdd(issues, { sessionName: choice.agent.sessionName, windowIndex: choice.agent.windowIndex, launch: null });
    return;
  }

  const start = (preset: AgentLaunchPreset | null) => {
    const sessionName = choice.sessionName ?? sessionNameFor(worktreeLabel(choice.worktree));
    // Creates the session when the worktree has none; an existing name is
    // focused rather than recreated (core's openSessionWindow).
    openSessionWindow?.(sessionName, { createCwd: choice.worktree.path });
    // With no agent there is nothing to hand the tickets to, so the worktree
    // is simply opened - the same as "No agent" on Start work.
    void runAdd(issues, preset ? { sessionName, launch: preset } : null);
  };

  agentPresets().then(
    (presets) => {
      if (presets.length <= 1) {
        start(presets[0] ?? null);
        return;
      }
      showMenu(x, y, [
        ...presets.map((preset) => ({ label: preset.name, onClick: () => start(preset) })),
        { label: "No agent (open the worktree only)", onClick: () => start(null) },
      ]);
    },
    () => start(null),
  );
}

export async function addToWorktree(
  issues: IssueRow[],
  showMenu: SidebarPanelHostProps["showMenu"],
  x: number,
  y: number,
): Promise<void> {
  const cwd = state.cwd;
  if (!cwd || issues.length === 0 || !showMenu) return;
  setState({ startError: null, note: null });
  let choices: WorktreeChoice[];
  try {
    choices = await worktreeChoices(cwd);
  } catch (err) {
    setState({ startError: err instanceof Error ? err.message : String(err) });
    return;
  }
  if (choices.length === 0) {
    setState({ startError: "This repository has no worktrees to add to." });
    return;
  }
  showMenu(
    x,
    y,
    choices.map((choice) => ({
      label: choice.label,
      onClick: () => sendToWorktree(choice, issues, showMenu, x, y),
    })),
  );
}

export function addSelectionToWorktree(showMenu: SidebarPanelHostProps["showMenu"], x: number, y: number): void {
  void addToWorktree(selectedIssues(), showMenu, x, y);
}

// ---- Batches ----
//
// Planning several clusters of tickets and watching the agents work them.
// The server owns all of it - the store is on disk, the states are computed
// there, and a mutating call answers with the whole batch - so everything
// here is "ask, then replace what we hold". Nothing is derived twice.

// Every row this pane is showing, which is what Select all takes. Filters
// already narrowed the list server-side, and a collapsed project group is
// still part of the list, so this is the whole of what the user filtered to
// rather than only what is scrolled into view.
// The editor tab shows one list at a time, so "the rows in front of you"
// there means whichever it is showing.
function rowsOf(host: Host): IssueRow[] {
  const list: ListId = host === "tab" ? state.tabList : host;
  if (list === "mine") return state.mine;
  return state.project?.issues ?? [];
}

export function selectAll(host: Host): void {
  const next = new Set(state.selection);
  for (const issue of rowsOf(host)) next.add(issue.key);
  setState({ selection: next });
}

export async function renameClusterFromBoard(clusterId: string): Promise<void> {
  const batch = state.batch;
  const cluster = batch?.clusters.find((entry) => entry.id === clusterId);
  if (!batch || !cluster) return;
  const name = await promptDialog(`Rename "${cluster.name}" to:`, cluster.name);
  if (name === null || !name.trim() || name.trim() === cluster.name) return;
  setState({ batchBusy: true, batchError: null });
  void renameCluster(batch.id, clusterId, name.trim())
    .then((res) => setState({ batch: res.batch, batchBusy: false }))
    .catch((err) => setState({ batchBusy: false, batchError: message(err) }));
}

export function setClusterFilter(next: Set<string>): void {
  setState({ clusterFilter: next });
}

export function toggleClusterFilter(clusterId: string): void {
  const next = new Set(state.clusterFilter);
  if (next.has(clusterId)) next.delete(clusterId);
  else next.add(clusterId);
  setState({ clusterFilter: next });
}

function batchNote(text: string | null): void {
  if (!text) return;
  setState({ batchNote: state.batchNote ? `${state.batchNote} ${text}` : text });
}

export function clearBatchNote(): void {
  setState({ batchNote: null, batchError: null });
}

// The batches for this repo, for the Plan batch menu and the board's picker.
//
// Returns the refreshed list rather than only parking it in state, because
// whoever just deleted a batch has to choose what to show next and cannot read
// that decision out of `state` until this has landed.
function loadBatches(cwd: string | null): Promise<BatchSummary[]> {
  if (!cwd) {
    setState({ batchSummaries: [], batchArchived: [] });
    return Promise.resolve([]);
  }
  return listBatches(cwd)
    .then((res) => {
      setState({ batchSummaries: res.batches, batchArchived: res.archived });
      return res.batches;
    })
    .catch(() => {
      setState({ batchSummaries: [], batchArchived: [] });
      return [];
    });
}

function loadSkills(cwd: string | null): void {
  if (!cwd) {
    setState({ skills: null });
    return;
  }
  void listSkills(cwd)
    .then((skills) =>
      setState({
        skills,
        // The stored settings are where a run starts; the review bar can
        // override them for one cluster.
        executionSkill: readSetting("jira.executionSkill"),
        qaSkill: readSetting("jira.qaSkill"),
      }),
    )
    .catch(() => setState({ skills: null }));
}

// Copy the bundled QA skill into the user's own directory.
//
// The confirmation only appears when there is already a skill of that name:
// somebody who has edited theirs must not lose it to a command they ran to
// see what it does.
export async function installQaSkill(): Promise<void> {
  try {
    let result = await installBundledQaSkill(false);
    if (!result.ok && result.existed) {
      const ok = await confirmDialog(
        `A skill called jira-batch-qa is already installed at ${result.dir}. Replace it with the extension's copy? Any edits you made to it are lost.`,
        "Replace",
      );
      if (!ok) return;
      result = await installBundledQaSkill(true);
    }
    batchNote(
      result.existed
        ? `Replaced the skill at ${result.dir}. It is now yours to edit - pick it in the QA slot.`
        : `Installed the QA skill at ${result.dir}. It is now yours to edit - pick it in the QA slot.`,
    );
    loadSkills(state.cwd);
  } catch (err) {
    setState({ batchError: message(err) });
  }
}

export function setSkillSlot(slot: "execution" | "qa", value: string): void {
  setState(slot === "execution" ? { executionSkill: value } : { qaSkill: value });
}

export function refreshBadge(): void {
  void getBadge()
    .then((res) => {
      setState({ batchBadge: res.badge });
      // On the Project pane only: it is the one tied to a repository, and a
      // second copy of the same number on the other pane would just be noise.
      // null rather than 0 clears it instead of drawing an empty badge.
      setHostBadge?.("project", res.badge > 0 ? res.badge : null);
    })
    .catch(() => {});
}

// Replaces the open batch wholesale. Every mutating call answers with one,
// which is why there is no patching anywhere in this file.
function holdBatch(batch: Batch, warnings?: string[]): void {
  setState({ batch, batchBusy: false });
  if (warnings && warnings.length > 0) batchNote(warnings.join(" "));
  loadBatches(state.cwd);
  refreshBadge();
}

// `view` picks the screen; left out, a batch opens on the board unless none
// of its clusters has started, in which case there is nothing to watch yet
// and everything still to decide - so it opens in the review. Reloading used
// to land on an empty board with no way back to the clusters.
export function openBatch(id: string, view?: BatchView): void {
  setState({ batchBusy: true, batchError: null });
  void getBatch(id)
    .then((res) => {
      const untouched = res.batch.clusters.length > 0 && res.batch.clusters.every((cluster) => cluster.state === "pending");
      setState({
        batch: res.batch,
        batchView: view ?? (untouched ? "review" : "board"),
        batchBusy: false,
        clusterFilter: new Set<string>(),
      });
      setTabView("batches");
    })
    .catch((err) => setState({ batchBusy: false, batchError: message(err) }));
}

// Called from the event stream: only refetch what is actually on screen.
export function onBatchChanged(batchId: string): void {
  // The badge counts every batch, not just the open one, so it is refreshed
  // whichever changed.
  refreshBadge();
  if (state.batch?.id !== batchId) {
    loadBatches(state.cwd);
    return;
  }
  void getBatch(batchId)
    .then((res) => holdBatch(res.batch))
    .catch(() => {});
}

export function closeBatch(): void {
  setState({ batch: null, batchView: "board", clusterFilter: new Set<string>() });
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---- The planning form ----

const DEFAULT_CRITERIA =
  "Group tickets that touch the same area of the codebase so clusters can be worked in parallel without editing the same files. Keep a cluster to 2-5 tickets. Order tickets within a cluster so earlier ones unblock later ones.";

const CRITERIA_KEY = "jira.batchCriteria";

function savedCriteria(): string {
  const stored = extSettings?.get(CRITERIA_KEY);
  return typeof stored === "string" && stored.trim() ? stored : DEFAULT_CRITERIA;
}

export async function openBatchForm(anchor: PopoverAnchor, origin: Host, batchId: string | null): Promise<void> {
  const issues = selectedIssues();
  setState({
    batchForm: {
      origin,
      anchor,
      batchId,
      issues,
      keysText: "",
      lookupNote: null,
      criteria: savedCriteria(),
      // Only a CLI agent can read files; the checkbox is settled once the
      // profiles answer, and starts off rather than promising something the
      // configured AI may not be able to do.
      readCodebase: false,
      canReadCodebase: false,
      single: false,
      aiHint: null,
      busy: false,
      error: null,
      fallback: false,
    },
  });

  try {
    const res = await listAiProfiles();
    const profile = res.profiles.find((entry) => entry.isDefault) ?? res.profiles[0] ?? null;
    if (!state.batchForm) return;
    if (!profile) {
      updateBatchForm({ canReadCodebase: false, aiHint: "No AI is configured - the tickets will be grouped by epic, component and label." });
      return;
    }
    // A keyed API has no tools and no working directory; only an agent CLI
    // can look at the repository.
    const isCli = Boolean(profile.program);
    updateBatchForm({
      canReadCodebase: isCli,
      readCodebase: isCli,
      aiHint: isCli ? null : `${profile.label} is a keyed API and cannot read files.`,
    });
  } catch {
    // The route is this extension's own; if it cannot answer, the form still
    // works without the option.
  }
}

// With no batch for this repo there is one thing Plan batch can mean, so it
// opens the form. With batches already running there are two, and guessing
// wrong would either strand tickets in a new batch or hand them to agents
// nobody meant to disturb - so it asks.
export function planBatchWithPicker(
  anchor: PopoverAnchor,
  showMenu: SidebarPanelHostProps["showMenu"],
  x: number,
  y: number,
  origin: Host,
): void {
  const open = state.batchSummaries;
  if (open.length === 0 || !showMenu) {
    void openBatchForm(anchor, origin, null);
    return;
  }
  showMenu(x, y, [
    { label: "New batch...", onClick: () => void openBatchForm(anchor, origin, null) },
    { label: "", onClick: () => {}, separator: true },
    ...open.map((batch) => ({
      label: `Add to "${batch.name}"`,
      onClick: () => void openBatchForm(anchor, origin, batch.id),
    })),
  ]);
}

export function updateBatchForm(patch: Partial<BatchFormState>): void {
  if (!state.batchForm) return;
  setState({ batchForm: { ...state.batchForm, ...patch } });
}

export function closeBatchForm(): void {
  setState({ batchForm: null });
}

export function removeFormIssue(key: string): void {
  const form = state.batchForm;
  if (!form) return;
  updateBatchForm({ issues: form.issues.filter((issue) => issue.key !== key) });
}

// Resolving what was pasted. Run when the field loses focus and again on
// Analyze, so a paste followed straight by Enter is never lost.
// ---- Selecting by key ----
//
// Paste a list of keys and the rows they name are ticked, which is the same
// thing as having ticked them by hand - so the selection stays exactly what
// the list is showing, and every action reads it as it always did.
//
// Only what is on screen. A key naming a ticket in another project, or one
// this view filters out, has no row to tick, and is said so rather than
// quietly added to a count that nothing can act on. That also means no
// lookup: the keys are read here, and a paste is instant.
export function openKeyPaste(anchor: PopoverAnchor, origin: Host): void {
  setState({ keyPaste: { origin, anchor, text: "", busy: false, note: null, error: null } });
}

export function updateKeyPaste(patch: Partial<KeyPasteState>): void {
  if (!state.keyPaste) return;
  setState({ keyPaste: { ...state.keyPaste, ...patch } });
}

export function closeKeyPaste(): void {
  setState({ keyPaste: null });
}

export function submitKeyPaste(): void {
  const paste = state.keyPaste;
  if (!paste || !paste.text.trim()) return;
  const { keys, invalid } = parseIssueKeys(paste.text);
  const rows = new Set(rowsOf(paste.origin).map((issue) => issue.key));

  const selection = new Set(state.selection);
  const picked: string[] = [];
  const absent: string[] = [];
  for (const key of keys) {
    if (!rows.has(key)) {
      absent.push(key);
      continue;
    }
    picked.push(key);
    selection.add(key);
  }

  const notes: string[] = [];
  if (picked.length > 0) notes.push(`Selected ${picked.length === 1 ? "1 ticket" : `${picked.length} tickets`}.`);
  if (absent.length > 0) notes.push(`Not in this list: ${absent.join(", ")}.`);
  if (invalid.length > 0) notes.push(`Not ticket keys: ${invalid.join(", ")}.`);

  // Nothing matched: keep what was typed, so a typo can be corrected rather
  // than retyped.
  if (picked.length === 0) {
    updateKeyPaste({ note: notes.join(" ") || "Nothing to select." });
    return;
  }
  setState({ selection, selectMode: true });
  updateKeyPaste({ text: "", note: notes.join(" ") });
}

export async function resolvePastedKeys(): Promise<IssueRow[]> {
  const form = state.batchForm;
  if (!form || !form.keysText.trim()) return form?.issues ?? [];
  updateBatchForm({ busy: true });
  try {
    const res = await lookupIssues(form.keysText);
    const current = state.batchForm;
    if (!current) return [];
    const have = new Set(current.issues.map((issue) => issue.key));
    const added = res.found.filter((issue) => !have.has(issue.key));
    const notes: string[] = [];
    if (res.missing.length > 0) notes.push(`Not found: ${res.missing.join(", ")}.`);
    if (res.invalid.length > 0) notes.push(`Not ticket keys: ${res.invalid.join(", ")}.`);
    const issues = [...current.issues, ...added];
    updateBatchForm({
      issues,
      keysText: "",
      busy: false,
      lookupNote: notes.length > 0 ? notes.join(" ") : null,
    });
    return issues;
  } catch (err) {
    updateBatchForm({ busy: false, error: message(err) });
    return state.batchForm?.issues ?? [];
  }
}

export async function submitBatchForm(options: { readCodebase?: boolean } = {}): Promise<void> {
  const form = state.batchForm;
  const cwd = state.cwd;
  if (!form || !cwd) return;
  const issues = await resolvePastedKeys();
  if (issues.length === 0) {
    updateBatchForm({ error: "Pick or paste at least one ticket." });
    return;
  }
  const readCodebase = form.single ? false : (options.readCodebase ?? form.readCodebase);
  updateBatchForm({ busy: true, error: null, fallback: false, readCodebase });
  extSettings?.set(CRITERIA_KEY, form.criteria);
  try {
    const res = await analyzeBatch({
      cwd,
      keys: issues.map((issue) => issue.key),
      criteria: form.criteria,
      readCodebase,
      single: form.single,
      batchId: form.batchId,
    });
    setState({
      batchForm: null,
      batch: res.batch,
      // A brand-new batch opens in the review, where the clusters are still
      // yours to change; adding to one opens there too, to confirm the
      // placement before an agent is told about it.
      batchView: "review",
      batchBusy: false,
      clusterFilter: new Set<string>(),
    });
    setTabView("batches");
    if (res.heuristic) batchNote("No AI is configured, so these were grouped by epic, component and label.");
    if (res.warnings.length > 0) batchNote(res.warnings.join(" "));
    loadBatches(cwd);
  } catch (err) {
    const status = (err as { status?: number }).status;
    // 422 is the server saying "this specific approach will not work here" -
    // a codebase read on a core that stops at 60s, or a reply it could not
    // use. The first has an obvious next step, so the form offers it.
    updateBatchForm({ busy: false, error: message(err), fallback: status === 422 && readCodebase });
  }
}

// ---- Review-time edits ----
//
// Each one posts and takes the batch back. They are small enough that
// optimism would only buy a flicker, and a refusal (a cluster that started
// while you dragged) has to win anyway.

function batchEdit(run: () => Promise<{ batch: Batch; warnings?: string[] }>): void {
  setState({ batchBusy: true, batchError: null });
  void run()
    .then((res) => holdBatch(res.batch, res.warnings))
    .catch((err) => setState({ batchBusy: false, batchError: message(err) }));
}

export function renameOpenBatch(name: string): void {
  if (!state.batch) return;
  batchEdit(() => renameBatch(state.batch!.id, name));
}

// From the board, where the title is not an input: the app's prompt, the
// same as renaming a cluster there.
export async function renameBatchFromBoard(): Promise<void> {
  const batch = state.batch;
  if (!batch) return;
  const name = await promptDialog(`Rename "${batch.name}" to:`, batch.name);
  if (name === null || !name.trim() || name.trim() === batch.name) return;
  setState({ batchBusy: true, batchError: null });
  void renameBatch(batch.id, name.trim())
    .then((res) => setState({ batch: res.batch, batchBusy: false }))
    .catch((err) => setState({ batchBusy: false, batchError: message(err) }));
}

export function renameBatchCluster(clusterId: string, name: string): void {
  if (!state.batch) return;
  batchEdit(() => renameCluster(state.batch!.id, clusterId, name));
}

export function setBatchClusterBranch(clusterId: string, branch: string): void {
  if (!state.batch) return;
  batchEdit(() => setClusterBranch(state.batch!.id, clusterId, branch));
}

export function addBatchCluster(): void {
  if (!state.batch) return;
  batchEdit(() => addCluster(state.batch!.id, ""));
}

export function removeBatchCluster(clusterId: string): void {
  if (!state.batch) return;
  batchEdit(() => removeCluster(state.batch!.id, clusterId));
}

export function moveBatchTicket(key: string, clusterId: string | null, index: number): void {
  if (!state.batch) return;
  batchEdit(() => moveTicket(state.batch!.id, key, clusterId, index));
}

export function reanalyze(criteria: string, readCodebase: boolean): void {
  const batch = state.batch;
  const cwd = state.cwd;
  if (!batch || !cwd) return;
  const keys = Object.keys(batch.tickets).filter((key) => !batch.ticketStates[key]);
  if (keys.length === 0) {
    setState({ batchError: "Every ticket in this batch is already with an agent." });
    return;
  }
  setState({ batchBusy: true, batchError: null });
  extSettings?.set(CRITERIA_KEY, criteria);
  void analyzeBatch({ cwd, keys, criteria, readCodebase })
    .then((res) => {
      // Re-analyzing makes a NEW batch from the unstarted tickets rather than
      // rewriting this one: the started clusters here have agents in them,
      // and a second proposal must not be able to disturb that.
      setState({ batch: res.batch, batchView: "review", batchBusy: false });
      if (res.warnings.length > 0) batchNote(res.warnings.join(" "));
      loadBatches(cwd);
    })
    .catch((err) => setState({ batchBusy: false, batchError: message(err) }));
}

// Opening the mode from the tab's own switch: the batch already on screen,
// else the newest one for this repo, else an empty state that says how to
// make one.
export function openBatches(): void {
  setTabView("batches");
  if (state.batch) return;
  const newest = state.batchSummaries[0];
  if (newest) openBatch(newest.id);
}

// After a dropped stream: events that happened while it was down were never
// delivered, so the open batch is refetched rather than trusted.
export function refreshOpenBatch(): void {
  if (state.batch) onBatchChanged(state.batch.id);
  loadBatches(state.cwd);
}

// Clicking a card opens the ticket in the detail pane, fetching it the same
// way the table does - the batch knows the summary, not the description.
export function focusBatchTicket(key: string): void {
  const batch = state.batch;
  if (!batch) return;
  const row = batch.tickets[key];
  focusIssue({
    key,
    summary: row?.summary ?? "",
    status: "",
    statusCategory: null,
    type: row?.type ?? "",
    assignee: null,
    priority: row?.priority ?? null,
    projectKey: row?.projectKey ?? null,
    projectName: null,
    updated: null,
    url: row?.url ?? "",
  });
}

export function runClusterAction(clusterId: string, action: ClusterAction): void {
  const batch = state.batch;
  if (!batch) return;
  const cluster = batch.clusters.find((entry) => entry.id === clusterId);
  if (!cluster) return;

  if (action === "start") {
    startBatchClusters([clusterId], { [clusterId]: cluster.branch });
    return;
  }
  if (action === "open") {
    if (cluster.sessionName) openSessionWindow?.(cluster.sessionName, { createCwd: cluster.worktreePath });
    return;
  }

  // Stopping kills a live agent's session and removing a worktree can throw
  // work away, so both ask first - the server runs no confirmation of its own.
  const ask = async (): Promise<boolean> => {
    if (action === "stop") return confirmDialog(`Stop "${cluster.name}"? Its agent's session is closed, and whatever it was on goes back to the queue.`, "Stop");
    if (action === "close") return confirmDialog(`Close "${cluster.name}"? Its session is closed; the worktree and the branch stay.`, "Close");
    if (action === "remove-worktree") return confirmDialog(`Remove the worktree at ${cluster.worktreePath}? The branch is kept.`, "Remove");
    return true;
  };

  setState({ batchBusy: true, batchError: null });
  void ask()
    .then((go) => {
      if (!go) {
        setState({ batchBusy: false });
        return null;
      }
      return clusterAction(batch.id, clusterId, action);
    })
    .then(async (res) => {
      if (!res) return;
      // A worktree with uncommitted work is a question, not a failure.
      if (action === "remove-worktree" && res.result?.dirty) {
        const force = await confirmDialog(
          `${cluster.worktreePath} has uncommitted or untracked files. Remove it anyway and lose them?`,
          "Remove anyway",
        );
        if (force) {
          const forced = await clusterAction(batch.id, clusterId, action, { force: true });
          holdBatch(forced.batch);
          return;
        }
        setState({ batchBusy: false });
        batchNote(`"${cluster.name}" was left alone - its worktree has uncommitted files.`);
        return;
      }
      holdBatch(res.batch);
    })
    .catch((err) => setState({ batchBusy: false, batchError: message(err) }));
}

// Where the extension serves one stored screenshot from.
function shotSrc(batchId: string, key: string, which: string): string {
  return `/api/ext/perch.jira/qa/${encodeURIComponent(batchId)}/${encodeURIComponent(key)}/${which}`;
}

// One ticket's evidence, in the order it was reported: the pair first, then
// the extras.
//
// One ticket and not the whole batch, because stepping is for comparing -
// before against after, desktop against mobile, all of it about the same
// change. Walking off the end of CAP-110 into CAP-121's screenshots is not a
// comparison, and with extras in the list a batch of twenty tickets makes the
// arrows a way to get lost. The board is how you reach another ticket.
function ticketShots(batch: Batch, key: string): Shot[] {
  const qa = batch.ticketStates[key]?.qa;
  if (!qa) return [];
  const shots: Shot[] = [];
  for (const which of ["before", "after"] as const) {
    if (!qa[which]) continue;
    shots.push({ src: shotSrc(batch.id, key, which), key, label: which });
  }
  // A caption stands in for the label, because "shot-2" describes nothing a
  // reviewer is looking for.
  for (const shot of qa.shots ?? []) {
    shots.push({ src: shotSrc(batch.id, key, shot.label), key, label: shot.caption || shot.label });
  }
  return shots;
}

// The element that opened the viewer, so closing can hand focus back to it.
// Remembered rather than looked up by class: two Jira tabs can be open, and
// querying the document would find the hidden one's thumbnail.
let shotOpener: HTMLElement | null = null;

export function openShot(key: string, which: string, opener?: HTMLElement | null): void {
  const batch = state.batch;
  if (!batch) return;
  shotOpener = opener ?? null;
  const shots = ticketShots(batch, key);
  // Found by source, not by label: an extra shot shows its caption where the
  // pair shows "before"/"after", and a caption is not guaranteed unique. The
  // URL is the one thing that is.
  const src = shotSrc(batch.id, key, which);
  const index = shots.findIndex((shot) => shot.src === src);
  if (index < 0) return;
  setState({ lightbox: { shots, index } });
}

export function setShotIndex(index: number): void {
  if (!state.lightbox) return;
  setState({ lightbox: { ...state.lightbox, index } });
}

export function closeShot(): void {
  setState({ lightbox: null });
  // After React has taken the viewer away, so the focus is not stolen back.
  const opener = shotOpener;
  shotOpener = null;
  if (opener?.isConnected) requestAnimationFrame(() => opener.focus());
}

// Rebuilt from whatever has been reported so far - useful mid-run, and the
// way to pick up a report after a ticket was re-QA'd.
export function rebuildClusterReport(clusterId: string): void {
  const batch = state.batch;
  if (!batch) return;
  setState({ batchBusy: true, batchError: null });
  void rebuildReport(batch.id, clusterId)
    .then((res) => {
      holdBatch(res.batch);
      batchNote(res.result.reportPath ? `Report written to ${res.result.reportPath}` : `Spec written to ${res.result.specPath}`);
    })
    .catch((err) => setState({ batchBusy: false, batchError: message(err) }));
}

export function saveFeedbackDraft(key: string, text: string): void {
  if (!state.batch) return;
  batchEdit(() => saveFeedback(state.batch!.id, key, text));
}

export function acceptBatchTicket(key: string): void {
  if (!state.batch) return;
  batchEdit(() => acceptTicket(state.batch!.id, key));
}

export function sendBatchFeedback(): void {
  const batch = state.batch;
  if (!batch) return;
  setState({ batchBusy: true, batchError: null });
  void sendFeedback(batch.id)
    .then((res) => {
      holdBatch(res.batch);
      for (const sent of res.sent) {
        batchNote(`Sent ${sent.keys.join(", ")} back to "${sent.clusterName}".`);
      }
      // A cluster with no agent keeps its drafts rather than losing them to a
      // send that went nowhere, and the note says which and why.
      for (const skipped of res.skipped) {
        batchNote(`"${skipped.clusterName}" did not get ${skipped.keys.join(", ")}: ${skipped.reason}. The feedback is still saved.`);
      }
    })
    .catch((err) => setState({ batchBusy: false, batchError: message(err) }));
}

// What to show once the open batch is gone, whether it was deleted or
// archived.
//
// `batch: null` on its own is not enough. The batch picker and the archived
// list both live inside BatchBoard, so dropping the batch unmounts the only
// controls that could open another one, and what is left is one line of grey
// text telling you to pick from a list that is no longer on screen. Opening
// the next batch keeps the view somewhere you can act from; the empty state
// is then reserved for a repository that genuinely has no batches left.
//
// The view state goes with it, for the reason closeBatch resets the same
// fields: a cluster filter or a review view belonged to the batch that just
// went away.
function leaveBatch(): void {
  setState({ batch: null, batchView: "board", clusterFilter: new Set<string>(), focused: null });
  // Ordered after the refresh, not alongside it: the summaries still hold the
  // batch that was just removed until the list comes back, and picking a
  // successor out of a stale list reopens the dead one and 404s.
  void loadBatches(state.cwd).then((batches) => {
    const next = batches[0];
    if (next) openBatch(next.id);
  });
}

export function archiveOpenBatch(): void {
  const batch = state.batch;
  if (!batch) return;
  if (!batch.canArchive) {
    setState({ batchError: "Close every cluster before archiving this batch." });
    return;
  }
  void archiveBatch(batch.id)
    .then(() => leaveBatch())
    .catch((err) => setState({ batchError: message(err) }));
}

export function unarchiveBatch(id: string): void {
  void unarchive(id)
    .then((res) => {
      setState({ batch: res.batch, batchView: "board" });
      loadBatches(state.cwd);
    })
    .catch((err) => setState({ batchError: message(err) }));
}

export function deleteOpenBatch(): void {
  const batch = state.batch;
  if (!batch) return;
  // Asked before the dialog, the way archiving asks: the server refuses a
  // batch with a running cluster, and finding that out only after confirming
  // a delete reads as the delete having failed halfway.
  if (!batch.canDelete) {
    setState({ batchError: "A cluster is still running - close it before deleting this batch." });
    return;
  }
  void confirmDialog(`Delete the batch "${batch.name}"? Its worktrees and branches are left alone.`, "Delete")
    .then((go) => (go ? deleteBatch(batch.id) : null))
    .then((res) => {
      if (!res) return;
      leaveBatch();
    })
    .catch((err) => setState({ batchError: message(err) }));
}

export function startBatchClusters(clusterIds: string[], branches: Record<string, string>): void {
  const batch = state.batch;
  if (!batch) return;
  // The picker shows agents[0] when nothing has been chosen, so that is the
  // agent the user is looking at - reading batch.agentId alone refused to
  // start ("Pick an agent first") over a choice the screen said was made.
  const agentId = batch.agentId || cachedPresets[0]?.id || "";
  if (!agentId) {
    setState({ batchError: "No agent is enabled - add one in Settings, AI Providers." });
    return;
  }
  setState({ batchBusy: true, batchError: null });
  void startClusters(batch.id, clusterIds, agentId, branches, { execution: state.executionSkill, qa: state.qaSkill })
    .then((res) => {
      // Starting several is not all-or-nothing: a branch name that is taken
      // stops that one cluster, and the rest are already working.
      setState({ batch: res.batch, batchBusy: false, batchView: res.started.length > 0 ? "board" : "review" });
      for (const failure of res.failed) {
        const cluster = res.batch.clusters.find((entry) => entry.id === failure.clusterId);
        batchNote(`"${cluster?.name ?? "A cluster"}" did not start: ${failure.error}`);
      }
      for (const started of res.started) {
        if (started.note) batchNote(started.note);
      }
      loadBatches(state.cwd);
    })
    .catch((err) => setState({ batchBusy: false, batchError: message(err) }));
}

export function applyPendingProposal(): void {
  const batch = state.batch;
  if (!batch) return;
  setState({ batchBusy: true, batchError: null });
  void applyProposal(batch.id)
    .then((res) => {
      setState({ batch: res.batch, batchView: "board", batchBusy: false });
      if (res.warnings && res.warnings.length > 0) batchNote(res.warnings.join(" "));
      for (const handover of res.handovers) {
        const cluster = res.batch.clusters.find((entry) => entry.id === handover.clusterId);
        batchNote(`Sent ${handover.keys.join(", ")} to "${cluster?.name ?? "a cluster"}".`);
      }
    })
    .catch((err) => setState({ batchBusy: false, batchError: message(err) }));
}

// ---- Project mapping ----

export function openProjectPicker(anchor: PopoverAnchor, origin: Host): void {
  setState({ projectPicker: { origin, anchor, error: null } });
}

export function closeProjectPicker(): void {
  setState({ projectPicker: null });
}

// Writes a jira.projectMap entry for the repo root. The higher-priority
// sources (a .jira-project file, the environment variable) still win - the
// picker says so rather than refusing, so a mapping can be prepared before
// the file is removed.
export function chooseProject(key: string): void {
  const cwd = state.cwd;
  if (!cwd) return;
  const parsed = parseProjectMap(extSettings?.get("jira.projectMap"));
  if (parsed.malformed) {
    setState({
      projectPicker: state.projectPicker
        ? { ...state.projectPicker, error: "Could not read jira.projectMap - fix it in Settings first." }
        : null,
    });
    return;
  }
  extSettings?.set("jira.projectMap", serializeProjectMap(upsertProjectMap(parsed.entries, cwd, key)));
  setState({ projectPicker: null });
  refresh();
}

// ---- Details popover ----

function openPopover(issue: IssueRow, list: ListId, anchorEl: HTMLElement): void {
  const cached = detailCache.get(issue.key) ?? null;
  setState({
    popover: { key: issue.key, list, anchor: anchorOf(anchorEl), detail: cached, error: null },
  });
  if (cached) return;
  fetchIssueDetail(issue.key)
    .then((detail) => {
      // Ignore a response that lands after the popover was closed or moved on.
      if (state.popover?.key !== issue.key || state.popover.list !== list) return;
      setState({ popover: { ...state.popover, detail } });
    })
    .catch((err: Error) => {
      if (state.popover?.key !== issue.key || state.popover.list !== list) return;
      setState({ popover: { ...state.popover, error: err.message } });
    });
}

function closePopover(): void {
  if (state.popover) setState({ popover: null });
}

// The refresh button on an open ticket: past the cache, straight to Jira. The
// details already on screen stay there until the new ones arrive.
function reloadPopover(): void {
  const open = state.popover;
  if (!open) return;
  const same = () => state.popover?.key === open.key && state.popover.list === open.list;
  fetchIssueDetail(open.key, { fresh: true })
    .then((detail) => {
      if (same()) setState({ popover: { ...state.popover!, detail, error: null } });
    })
    .catch((err: Error) => {
      if (same()) setState({ popover: { ...state.popover!, error: err.message } });
    });
}

function reloadFocused(): void {
  if (state.focused) focusIssue({ key: state.focused.key } as IssueRow, { fresh: true });
}

function DetailPopover({ popover }: { popover: PopoverState }) {
  // Positioned after measuring, so a card taller than the space below the row
  // flips above it instead of running off the bottom of the sidebar. Shared
  // with the funnel, the start-work form and the project picker.
  const { ref, style } = usePopoverPosition<HTMLDivElement>(popover.anchor, [popover.detail, popover.error]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closePopover();
    };
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) closePopover();
    };
    document.addEventListener("keydown", onKey);
    // Capture phase: a row click elsewhere should close this one before it
    // opens its own.
    document.addEventListener("mousedown", onDown, true);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown, true);
    };
  }, []);

  const detail = popover.detail;
  return (
    <div
      ref={ref}
      className="jira-popover"
      role="dialog"
      // Hidden until measured, so it never paints at the wrong spot first.
      style={style}
    >
      <div className="jira-pop-head">
        <span className="jira-key">{popover.key}</span>
        {detail && (
          <button className="icon-button" title="Refresh from Jira" onClick={reloadPopover}>
            <Icon name="refresh" />
          </button>
        )}
        {detail && (
          <a
            className="icon-button"
            href={detail.url}
            target="_blank"
            rel="noopener noreferrer"
            title="Open in Jira"
          >
            <Icon name="link-external" />
          </a>
        )}
        <button className="icon-button" title="Close" onClick={closePopover}>
          <Icon name="close" />
        </button>
      </div>

      <DetailBody detail={detail} error={popover.error} />
    </div>
  );
}

// A ticket's summary, facts, description and comment thread. Shared by the
// sidebar's popover and the editor tab's detail pane, so a ticket reads the
// same wherever it is opened.
//
// The description and comments are Markdown - server.js renders Jira's rich
// text to it - so headings, lists, code, tables and links show as such rather
// than as the punctuation that used to stand in for them.
function formatDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function ago(iso: string | null): string {
  const age = relativeTime(iso);
  return !age || age === "just now" ? age : `${age} ago`;
}

function DetailBody({ detail, error }: { detail: IssueDetail | null; error: string | null }) {
  if (error) return <div className="jira-error">{error}</div>;
  if (!detail) return <div className="jira-empty">Loading…</div>;

  // A fact the server did not send (an older server, or a field Jira left
  // empty) is left out rather than shown as a blank row - except the
  // assignee, where "nobody" is itself worth saying.
  const candidates: [string, ReactNode][] = [
    [
      "Status",
      detail.status ? (
        <span className="jira-chip" data-cat={detail.statusCategory ?? "unknown"}>
          {detail.status}
        </span>
      ) : null,
    ],
    ["Type", detail.type || null],
    ["Priority", detail.priority],
    ["Assignee", detail.assignee === undefined ? null : (detail.assignee ?? "Unassigned")],
    ["Reporter", detail.reporter ?? null],
    ["Created", formatDate(detail.created)],
    ["Updated", formatDate(detail.updated)],
  ];
  const facts = candidates.filter(([, value]) => value !== null && value !== undefined);

  return (
    <div className="jira-detail">
      <h2 className="jira-detail-title">{detail.summary}</h2>

      {/* Each fact is a label over its value, flowed into as many columns as
          the pane fits - two on a phone or in a narrow pane, three when
          there's room - instead of one long label/value list. <div> around
          each dt/dd pair is valid inside a <dl>. */}
      <dl className="jira-facts">
        {facts.map(([name, value]) => (
          <div key={name} className="jira-fact">
            <dt>{name}</dt>
            <dd>{value}</dd>
          </div>
        ))}
        {detail.labels.length > 0 && (
          <div className="jira-fact wide">
            <dt>Labels</dt>
            <dd className="jira-labels">
              {detail.labels.map((label) => (
                <span key={label} className="jira-chip jira-chip-label">
                  {label}
                </span>
              ))}
            </dd>
          </div>
        )}
      </dl>

      <section className="jira-detail-section">
        <h3 className="jira-pop-section">Description</h3>
        {detail.description ? (
          <Markdown text={detail.description} />
        ) : (
          <div className="jira-muted">No description.</div>
        )}
      </section>

      {detail.comments.length > 0 && (
        <section className="jira-detail-section">
          <h3 className="jira-pop-section">
            Comments <span className="jira-count">{detail.comments.length}</span>
          </h3>
          <ol className="jira-comments">
            {detail.comments.map((comment, i) => (
              <li key={i} className="jira-comment">
                <div className="jira-comment-head">
                  <span className="jira-avatar" aria-hidden="true">
                    {initials(comment.author)}
                  </span>
                  <span className="jira-comment-author">{comment.author}</span>
                  {comment.created && (
                    <time
                      className="jira-comment-time"
                      dateTime={comment.created}
                      title={new Date(comment.created).toLocaleString()}
                    >
                      {ago(comment.created)}
                    </time>
                  )}
                </div>
                <Markdown text={comment.body} />
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}

// ---- Issue list (shared by both panes) ----

// A table column heading that sorts by its column.
function SortHead({
  list,
  field,
  label,
  view,
  optional = false,
}: {
  list: ListId;
  field: SortField;
  label: string;
  view: ListView;
  optional?: boolean;
}) {
  const active = view.sort.field === field;
  const dir = view.sort.dir === "asc" ? "ascending" : "descending";
  return (
    <span className={optional ? "jira-col-optional" : undefined}>
      <button
        className={`jira-sorthead${active ? " active" : ""}`}
        title={active ? `Sorted by ${label}, ${dir} - click to flip` : `Sort by ${label}`}
        aria-sort={active ? dir : "none"}
        onClick={() => sortBy(list, field)}
      >
        {label}
        {active && <span aria-hidden="true">{view.sort.dir === "asc" ? " \u2191" : " \u2193"}</span>}
      </button>
    </span>
  );
}

// "list" is the sidebar's compact two-line row; "table" is the editor tab's,
// with a column per field and a click that opens the ticket in the tab's
// detail pane instead of a popover. Selection and every gesture behave the
// same in both.
type IssueListVariant = "list" | "table";

function IssueList({
  issues,
  list,
  showMenu,
  variant = "list",
}: {
  issues: IssueRow[];
  list: ListId;
  showMenu?: SidebarPanelHostProps["showMenu"];
  variant?: IssueListVariant;
}) {
  const { busyKey, popover, selection, selectMode, focused, views, collapsedGroups } = useJira();
  const view = views[list];
  // Sections when grouping by project, in the order each project first shows
  // up in the sorted list.
  const groups = view.groupByProject ? groupByProject(issues) : null;
  const collapsed = groups ? collapsedFor(list) : new Set<string>();
  // The drag is anchored to the wrapper rather than the <ul>, so a press in
  // the empty space below the last row starts a marquee too, and so the
  // overlay is a sibling of the list rather than a stray <div> inside it.
  const listRef = useRef<HTMLDivElement | null>(null);
  const rowRefs = useRef(new Map<string, HTMLLIElement>());
  // The selection as it stood when a drag armed. A marquee recomputes every
  // frame against this snapshot rather than against live state, which is what
  // lets the band release rows it has already passed back over.
  const dragBase = useRef<ReadonlySet<string>>(new Set());
  // Shift-click ranges run over what is on screen, in on-screen order - so
  // across sections, and never into a collapsed one.
  const keys = groups ? displayKeys(groups, collapsed) : issues.map((issue) => issue.key);
  void collapsedGroups;

  const { marqueeRect, onMarqueeMouseDown } = useMarqueeSelection({
    containerRef: listRef,
    getRows: () =>
      issues
        .map((issue) => ({ id: issue.key, el: rowRefs.current.get(issue.key) }))
        .filter((row): row is { id: string; el: HTMLLIElement } => row.el !== undefined),
    onStart: () => {
      dragBase.current = new Set(state.selection);
    },
    onMarquee: (ids, additive) => setMarquee(dragBase.current, ids, additive),
    onEnd: (canceled) => {
      // Escape puts back exactly what was selected before the drag.
      if (canceled) setMarquee(dragBase.current, [], true);
    },
  });

  // Touch has no drag to spare - the list has to stay scrollable - so a hold
  // is what begins a selection there.
  const bindLongPress = useLongPressMenu();

  // Ctrl/Cmd toggles one row, Shift takes the run from this pane's anchor,
  // and once anything is selected a plain click selects rather than opening
  // the details popover. With nothing selected and no modifier held, the row
  // opens its details exactly as it always did.
  const onRowClick = (issue: IssueRow, e: React.MouseEvent<HTMLButtonElement>) => {
    if (e.ctrlKey || e.metaKey) {
      toggleSelected(list, issue.key);
      return;
    }
    if (e.shiftKey) {
      selectRangeTo(list, keys, issue.key);
      return;
    }
    if (selection.size > 0 || selectMode) {
      toggleSelected(list, issue.key);
      return;
    }
    if (variant === "table") focusIssue(issue);
    else openPopover(issue, list, e.currentTarget);
  };

  // With more than one agent in the registry, Start work asks which to use -
  // see startWorkWithPicker, which the tab's detail pane shares.
  const handleStartClick = useCallback(
    (issue: IssueRow, event: { clientX: number; clientY: number }) =>
      // Coordinates read here, synchronously: the menu is placed at the click,
      // and the event must not be touched after the picker's await.
      startWorkWithPicker(issue, showMenu, event.clientX, event.clientY),
    [showMenu],
  );

  // Tooltip only - the menu-or-direct decision above awaits the real answer,
  // so a first render before the registry has been read costs nothing worse
  // than the singular wording for a moment.
  const multiplePresets = useAgentPresets().length > 1;

  const renderRow = (issue: IssueRow) => {
      const open =
        variant === "table"
          ? focused?.key === issue.key
          : popover?.key === issue.key && popover.list === list;
      const picked = selection.has(issue.key);
      return (
        <li
          key={issue.key}
          className={`jira-row${open ? " open" : ""}${picked ? " picked" : ""}`}
          ref={(el) => {
            if (el) rowRefs.current.set(issue.key, el);
            else rowRefs.current.delete(issue.key);
          }}
          {...bindLongPress(() => toggleSelected(list, issue.key))}
        >
          <input
            type="checkbox"
            className="jira-check"
            checked={picked}
            // The row's own click handler covers ctrl and shift; this is
            // the plain tick, and it must not also reach the row.
            onClick={(e) => e.stopPropagation()}
            onChange={() => toggleSelected(list, issue.key)}
            aria-label={`Select ${issue.key}`}
          />
          {/* The row opens the details popover rather than linking straight
              out to Jira: reading the ticket is the common case, and the
              popover carries its own "Open in Jira" link for the other one.
              Summary on its own line, because a key plus a status chip plus
              an age leaves nothing readable beside it at sidebar width. */}
          {variant === "table" ? (
            // The row's cells sit inside one button so the whole row is a
            // single click target, as in the sidebar; display: contents
            // lets them take their own columns on the row's grid.
            <>
              {/* The key opens the ticket, in select mode too. Picking a
                  dozen rows and still wanting to read one of them is the
                  ordinary case, and once selection is on the row's own click
                  is spoken for. Its own element beside the row's button
                  rather than a span inside it: one tab stop with a name, and
                  no control nested in a control. The grid places it by
                  position, so the column order is unchanged.

                  A real <a href> to Jira, not a button: that is what makes
                  ctrl-click open the ticket in a new tab, and middle-click,
                  and "Copy link address" - all of it the browser's, none of
                  it ours to reimplement. A plain click is the only one we
                  take, for the detail pane beside the list. */}
              <a
                className="jira-key jira-keyopen"
                href={issue.url}
                target="_blank"
                rel="noopener noreferrer"
                title={`${issue.key} - click to read it here, ctrl-click to open it in Jira`}
                onClick={(e) => {
                  // Never the row's business, whichever way it was clicked.
                  e.stopPropagation();
                  // A modified click belongs to the browser: ctrl or cmd for
                  // a new tab, shift for a window. Middle-click never reaches
                  // onClick at all, and needs nothing from us.
                  if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
                  e.preventDefault();
                  focusIssue(issue);
                }}
              >
                {issue.key}
              </a>
              <button className="jira-row-main jira-cells" title={issue.summary} onClick={(e) => onRowClick(issue, e)}>
                <span className="jira-title">{issue.summary}</span>
                <span>
                  <span className="jira-chip" data-cat={issue.statusCategory ?? "unknown"}>
                    {issue.status}
                  </span>
                </span>
                <span className="jira-cell-muted jira-col-optional">{issue.assignee ?? "Unassigned"}</span>
                <span className="jira-cell-muted jira-col-optional">{issue.type}</span>
                <span className="jira-cell-muted jira-col-optional">{issue.priority ?? ""}</span>
                <span className="jira-age">{relativeTime(issue.updated)}</span>
              </button>
            </>
          ) : (
            <button className="jira-row-main" title={issue.summary} onClick={(e) => onRowClick(issue, e)}>
              <span className="jira-title">{issue.summary}</span>
              <span className="jira-sub">
                <span className="jira-key">{issue.key}</span>
                <span className="jira-chip" data-cat={issue.statusCategory ?? "unknown"}>
                  {issue.status}
                </span>
                <span className="jira-age">{relativeTime(issue.updated)}</span>
              </span>
            </button>
          )}
          <button
            className="icon-button jira-start"
            title={
              multiplePresets
                ? "Start work: create a worktree session and pick an agent"
                : "Start work: create a worktree session for this issue"
            }
            disabled={busyKey === issue.key}
            onClick={(e) => void handleStartClick(issue, e)}
            // Right-click reaches the other destination for one ticket:
            // a worktree that already exists.
            onContextMenu={(e) => {
              if (!showMenu) return;
              e.preventDefault();
              // Read before the menu's callback runs - the event must not
              // be touched from inside it.
              const { clientX, clientY } = e;
              showMenu(clientX, clientY, [
                {
                  label: "Add to worktree...",
                  onClick: () => void addToWorktree([issue], showMenu, clientX, clientY),
                },
              ]);
            }}
          >
            <Icon name={busyKey === issue.key ? "loading" : "play"} />
          </button>
        </li>
      );
  };

  // A checkbox is shown once anything is selected or select mode is on; the
  // rest of the time CSS reveals it on the pointed-at row only, so a list at
  // rest stays as quiet as it was.
  const showBoxes = selectMode || selection.size > 0;

  // How much of THIS list is ticked - the rows on screen, not the whole
  // selection, which can hold tickets from the other pane too.
  const allPicked = issues.length > 0 && issues.every((issue) => selection.has(issue.key));
  const somePicked = !allPicked && issues.some((issue) => selection.has(issue.key));

  return (
    <div className="jira-listwrap" ref={listRef} onMouseDown={onMarqueeMouseDown}>
    <ul className={`jira-list jira-list-${variant}${showBoxes ? " picking" : ""}`}>
      {variant === "table" && (
        // Column headings, as a row laid out on the same grid as the rows
        // below - a real <table> can't carry the <li> drag-selection wiring.
        // Each heading sorts by its column; clicking the sorted one again
        // flips the direction. The spans stay the grid cells (the narrow-list
        // rules hide cells by position), with the button inside.
        <li className="jira-row jira-thead">
          {/* The table's own select-all, where a table keeps it. It carries
              three states rather than two: none, some (indeterminate) and
              all, so it reports what is ticked as well as changing it -
              which the two links in the toolbar could never do. */}
          <span>
            <input
              type="checkbox"
              className="jira-check"
              checked={allPicked}
              ref={(el) => {
                // Indeterminate is a property, not an attribute: there is no
                // JSX prop for it, and it is what makes "some are ticked"
                // legible at a glance.
                if (el) el.indeterminate = somePicked && !allPicked;
              }}
              onChange={() => (allPicked ? clearSelection() : selectAll(list))}
              aria-label={allPicked ? `Deselect all ${issues.length}` : `Select all ${issues.length}`}
              title={allPicked ? "Deselect all" : `Select the ${issues.length} tickets in this list`}
            />
          </span>
          <SortHead list={list} field="key" label="Key" view={view} />
          <SortHead list={list} field="summary" label="Summary" view={view} />
          <SortHead list={list} field="status" label="Status" view={view} />
          <SortHead list={list} field="assignee" label="Assignee" view={view} optional />
          <SortHead list={list} field="type" label="Type" view={view} optional />
          <SortHead list={list} field="priority" label="Priority" view={view} optional />
          <SortHead list={list} field="updated" label="Updated" view={view} />
          <span />
        </li>
      )}
      {groups
        ? groups.map((group) => {
            const shut = collapsed.has(group.key);
            return (
              <Fragment key={`group:${group.key}`}>
                <li className="jira-group">
                  <button
                    className="jira-group-head"
                    aria-expanded={!shut}
                    onClick={() => toggleGroup(list, group.key)}
                  >
                    <Icon name={shut ? "chevron-right" : "chevron-down"} />
                    <span className="jira-key">{group.key}</span>
                    {group.name !== group.key && <span className="jira-group-name">{group.name}</span>}
                    <span className="jira-count">{group.issues.length}</span>
                  </button>
                </li>
                {!shut && group.issues.map(renderRow)}
              </Fragment>
            );
          })
        : issues.map(renderRow)}
    </ul>
    {marqueeRect && (
      <div
        className="jira-marquee"
        style={{
          left: marqueeRect.left,
          top: marqueeRect.top,
          width: marqueeRect.width,
          height: marqueeRect.height,
        }}
      />
    )}
    </div>
  );
}

// Every state that isn't "here is a list" is identical in both panes, so it
// is answered once here and each pane renders its own list underneath.
function gateMessage(s: JiraState): { kind: "error" | "empty"; text: string } | null {
  if (s.error) return { kind: "error", text: s.error };
  if (!s.cwd) return { kind: "empty", text: "No active window." };
  if (!s.status) return { kind: "empty", text: "Loading…" };
  if (!s.status.configured) {
    return {
      kind: "empty",
      text: s.status.hasToken
        ? "Not configured. Set jira.siteUrl and jira.email in Settings."
        : "Not configured. Set jira.siteUrl and jira.email in Settings, then add an API token there.",
    };
  }
  if (!s.status.authed) return { kind: "error", text: s.status.error ?? "Could not sign in to Jira." };
  return null;
}

function Gate({ message }: { message: { kind: "error" | "empty"; text: string } }) {
  return <div className={message.kind === "error" ? "jira-error" : "jira-empty"}>{message.text}</div>;
}

// ---- The two panes ----

// A filtered pane that found nothing is not the same as a pane with nothing
// in it: the way out is to clear the filter, so the message says so and
// carries the button.
function EmptyList({ list, filtered, text }: { list: ListId; filtered: boolean; text: string }) {
  if (!filtered) return <div className="jira-empty">{text}</div>;
  return (
    <div className="jira-empty">
      No issues match these filters.{" "}
      <button className="jira-linkish" onClick={() => applyFilters(list, EMPTY_FILTERS)}>
        Clear
      </button>
    </div>
  );
}

// Where the branch typed into the start form will land, so the field is not
// the only thing saying where this goes. Mirrors resolveLocation in
// server.js, against the repo root /status reports - the active folder may be
// inside a worktree, and a worktree of a worktree is exactly what the server
// takes care to avoid.
function worktreeLocationFor(branch: string): string {
  const repo = state.status?.repo ?? "";
  const template = readSetting("jira.worktreeLocation") || "{repo}/.worktrees/{branch}";
  return template.replaceAll("{repo}", repo).replaceAll("{branch}", branch.replace(/[/\\]/g, "-"));
}

// Thin hosts that hand the store's state and actions to the presentational
// components. Those take props only: client.tsx imports them, so importing
// the store back out of them would close a cycle.
function SelectionBarFor({ showMenu, origin }: SidebarPanelHostProps & { origin: Host }) {
  const s = useJira();
  return (
    <SelectionBar
      count={s.selection.size}
      total={(origin === "mine" ? s.mine : (s.project?.issues ?? [])).length}
      busy={s.busyKey !== null}
      onStart={(anchor) => void openStartForm(anchor, origin)}
      onAdd={(x, y) => addSelectionToWorktree(showMenu, x, y)}
      onSelectAll={() => selectAll(origin)}
      onPlanBatch={(anchor, x, y) => planBatchWithPicker(anchor, showMenu, x, y, origin)}
      onClear={clearSelection}
    />
  );
}

function BatchFormFor({ form }: { form: BatchFormState }) {
  const s = useJira();
  const addingTo = form.batchId ? (s.batchSummaries.find((batch) => batch.id === form.batchId)?.name ?? "this batch") : null;
  return (
    <BatchForm
      anchor={form.anchor}
      addingTo={addingTo}
      issues={form.issues}
      keysText={form.keysText}
      lookupNote={form.lookupNote}
      criteria={form.criteria}
      readCodebase={form.readCodebase}
      single={form.single}
      canReadCodebase={form.canReadCodebase}
      aiHint={form.aiHint}
      busy={form.busy}
      error={form.error}
      fallback={form.fallback}
      onChange={(patch) => updateBatchForm(patch)}
      onResolveKeys={() => void resolvePastedKeys()}
      onRemoveIssue={removeFormIssue}
      onSubmit={() => void submitBatchForm()}
      onSubmitWithoutCodebase={() => void submitBatchForm({ readCodebase: false })}
      onCancel={closeBatchForm}
    />
  );
}

function StartWorkFormFor({ form }: { form: StartFormState }) {
  return (
    <StartWorkForm
      issues={form.issues}
      anchor={form.anchor}
      branch={form.branch}
      presets={form.presets}
      presetIndex={form.presetIndex}
      busy={form.busy}
      error={form.error}
      location={worktreeLocationFor(form.branch)}
      onChange={updateStartForm}
      onSubmit={() => void submitStartForm()}
      onCancel={closeStartForm}
    />
  );
}

function ProjectPickerFor({ picker }: { picker: PickerState }) {
  const s = useJira();
  return (
    <ProjectPicker
      anchor={picker.anchor}
      projects={s.projects}
      repo={s.status?.repo ?? s.cwd}
      source={s.status?.projectSource ?? null}
      currentKey={s.status?.projectKey ?? null}
      error={picker.error}
      onChoose={chooseProject}
      onClose={closeProjectPicker}
    />
  );
}

// The floating forms, drawn only by the host that opened them. The two panes
// and the tab all read one store, so without the origin check a form would
// render in every one of them - or, worse, only in a pane that is collapsed
// or on another sidebar tab, where it can't be seen.
function Floating({ host }: { host: Host }) {
  const s = useJira();
  return (
    <>
      {s.startForm?.origin === host && <StartWorkFormFor form={s.startForm} />}
      {s.batchForm?.origin === host && <BatchFormFor form={s.batchForm} />}
      {s.projectPicker?.origin === host && <ProjectPickerFor picker={s.projectPicker} />}
      {s.keyPaste?.origin === host && (
        <KeyPasteForm
          anchor={s.keyPaste.anchor}
          text={s.keyPaste.text}
          busy={s.keyPaste.busy}
          note={s.keyPaste.note}
          error={s.keyPaste.error}
          onChange={(text) => updateKeyPaste({ text })}
          onSubmit={submitKeyPaste}
          onClose={closeKeyPaste}
        />
      )}
    </>
  );
}

// Which of the four sources supplied the key, in the words the settings use.
// The two above jira.projectMap win over it, so the picker says so rather
// than writing a mapping that would quietly do nothing.
const SOURCE_LABEL: Record<string, string> = {
  file: "from .jira-project",
  projectMap: "from the project mapping",
  env: "from the environment",
  setting: "from jira.projectKey",
};

// The project key and the control that changes it, as one button. Shared by
// the Project pane and the tab, which each open the picker in themselves.
function ProjectCaption({ host }: { host: Host }) {
  const s = useJira();
  // projectSource "projectJql" means the query replaced the key entirely, so
  // the caption says so rather than naming a key that no longer applies, and
  // there is no mapping to offer.
  if (s.project?.projectSource === "projectJql") return <div className="jira-caption">Custom query</div>;
  const key = s.status?.projectKey ?? null;
  const source = s.status?.projectSource ?? null;
  return (
    <button
      className="jira-caption jira-caption-button"
      title="Choose the Jira project for this repository"
      onClick={(e) => openProjectPicker(anchorOf(e.currentTarget), host)}
    >
      {key ? (
        <>
          <span className="jira-caption-key">{key}</span>
          {source && <span className="jira-caption-source">{SOURCE_LABEL[source] ?? source}</span>}
        </>
      ) : (
        <span className="jira-caption-key">Choose a project...</span>
      )}
    </button>
  );
}

function hasProject(s: JiraState): boolean {
  return Boolean(s.status?.projectKey) || s.project?.projectSource === "projectJql";
}

function AssignedPanel({ showMenu }: SidebarPanelHostProps) {
  const s = useJira();
  const gate = gateMessage(s);
  const filtered = !filtersAreEmpty(s.filters.mine);
  const picked = s.mine.some((issue) => s.selection.has(issue.key));
  return (
    <div className="jira-panel">
      {!gate && (
        <FilterBar
          filters={s.filters.mine}
          facets={s.facets}
          selectMode={s.selectMode}
          showAssignee={false}
          onApply={(filters) => applyFilters("mine", filters)}
          onToggleSelectMode={() => setSelectMode(!s.selectMode)}
          onPasteKeys={(anchor) => openKeyPaste(anchor, "mine")}
          onOpenTab={() => openJiraTab("mine")}
          view={s.views.mine}
          onView={(view) => applyView("mine", view)}
        />
      )}
      {/* Turning selection on is itself a request to act on several tickets,
          so the bar comes with it: "Select all" was otherwise unreachable
          until you had already ticked one by hand. */}
      {(s.selectMode || picked) && <SelectionBarFor showMenu={showMenu} origin="mine" />}
      {s.startError && <div className="jira-error">{s.startError}</div>}
      {s.note && <div className="jira-note">{s.note}</div>}
      {gate ? (
        <Gate message={gate} />
      ) : s.mine.length === 0 ? (
        <EmptyList list="mine" filtered={filtered} text="No issues assigned to you." />
      ) : (
        <IssueList issues={s.mine} list="mine" showMenu={showMenu} />
      )}
      {s.popover?.list === "mine" && <DetailPopover popover={s.popover} />}
      <Floating host="mine" />
    </div>
  );
}

function ProjectPanel({ showMenu }: SidebarPanelHostProps) {
  const s = useJira();
  const gate = gateMessage(s);
  const filtered = !filtersAreEmpty(s.filters.project);
  const picked = (s.project?.issues ?? []).some((issue) => s.selection.has(issue.key));

  return (
    <div className="jira-panel">
      {!gate && <ProjectCaption host="project" />}
      {!gate && hasProject(s) && (
        <FilterBar
          filters={s.filters.project}
          facets={s.facets}
          selectMode={s.selectMode}
          showAssignee
          onApply={(filters) => applyFilters("project", filters)}
          onToggleSelectMode={() => setSelectMode(!s.selectMode)}
          onPasteKeys={(anchor) => openKeyPaste(anchor, "project")}
          onOpenTab={() => openJiraTab("project")}
          view={s.views.project}
          onView={(view) => applyView("project", view)}
        />
      )}
      {/* Turning selection on is itself a request to act on several tickets,
          so the bar comes with it: "Select all" was otherwise unreachable
          until you had already ticked one by hand. */}
      {(s.selectMode || picked) && <SelectionBarFor showMenu={showMenu} origin="project" />}
      {gate ? (
        <Gate message={gate} />
      ) : !hasProject(s) ? (
        <div className="jira-empty">
          No project key for this repository. Choose one above, or add a .jira-project file.
        </div>
      ) : (s.project?.issues ?? []).length === 0 ? (
        <EmptyList list="project" filtered={filtered} text="No open issues." />
      ) : (
        <IssueList issues={s.project!.issues} list="project" showMenu={showMenu} />
      )}
      {s.popover?.list === "project" && <DetailPopover popover={s.popover} />}
      <Floating host="project" />
    </div>
  );
}

// ---- The editor tab ----
//
// The same two lists with room to read them: a table with a column per field,
// and the ticket you click open in a pane beside it rather than in a popover.
// It reads the same store as the sidebar panes - so a filter or a selection
// made in one is already there in the other - and like them it shows the
// active repository.
//
// One tab PER REPOSITORY, keyed by the repo root, rather than one tab for the
// whole app. Core pins a viewer tab to the session it was opened from, and the
// tab bar shows one project at a time; a single global tab would stay pinned
// to the first project, so reopening it from a second one would activate the
// first project's tab and flip the tab bar back to it, while its contents
// showed the second. Keyed per repo, a Jira tab is only ever visible while its
// own project is active - which is exactly when the store is showing that
// project - and reopening it inside a project still focuses the one there.
const TAB_VIEWER = "board";

function tabPathFor(s: JiraState): string {
  return s.status?.repo ?? s.cwd ?? "jira";
}

let openViewerTab: ((viewerId: string, path: string, opts?: { title?: string }) => void) | null = null;

function repoName(s: JiraState): string {
  const path = s.status?.repo ?? s.cwd ?? "";
  return path.split("/").filter(Boolean).pop() ?? "";
}

function tabTitle(s: JiraState): string {
  const name = repoName(s);
  return name ? `Jira · ${name}` : "Jira";
}

export function openJiraTab(list?: ListId): void {
  if (list) setTabList(list);
  openViewerTab?.(TAB_VIEWER, tabPathFor(state), { title: tabTitle(state) });
}

// The subset of the host's FileViewerHostProps the tab uses.
interface ViewerHostProps {
  filePath: string;
  active: boolean;
  showMenu?: SidebarPanelHostProps["showMenu"];
  setTitle?: (title: string) => void;
}

// A status's category (To Do / In Progress / Done), for placing columns: what
// Jira's status metadata says, else what any ticket carrying that status says.
function categoryLookup(s: JiraState, issues: readonly IssueRow[]): (status: string) => string | null {
  const known = new Map<string, string>();
  for (const status of s.facets?.statuses ?? []) if (status.category) known.set(status.name, status.category);
  for (const issue of issues) if (issue.statusCategory && !known.has(issue.status)) known.set(issue.status, issue.statusCategory);
  return (status) => known.get(status) ?? null;
}

// The board for the tab's list: columns from the global configuration, with a
// column for each leftover status, and swimlanes when grouping by project.
// The Batches mode. One batch at a time: its clusters as a plan you are
// still editing, or - once agents are on them - as a board. Which one is
// decided by the batch, not by a toggle: a proposal waiting to be applied,
// or nothing started yet, is a plan; anything else is work in progress.
function BatchArea({ showMenu }: { showMenu?: SidebarPanelHostProps["showMenu"] }) {
  const s = useJira();
  const agents = useAgentPresets();
  const [layout, chooseLayout] = useLayoutChoice();
  const split = useSplitResize(layout);

  useEffect(() => {
    refreshBadge();
  }, []);


  // With no batch open there is no board, and the board is where the picker
  // and the archived list live - so this has to carry its own, or deleting a
  // batch leaves a pane with nothing on it but an instruction to use a list
  // that went away with the board.
  if (!s.batch) {
    return (
      <div className="jira-empty jira-bempty">
        {s.batchBusy ? (
          "Loading..."
        ) : s.batchSummaries.length > 0 ? (
          <>
            <p>Pick a batch, or plan a new one from a ticket selection.</p>
            <div className="jira-bempty-list">
              {s.batchSummaries.map((entry) => (
                <button key={entry.id} className="jira-selaction" onClick={() => openBatch(entry.id)}>
                  {entry.name}
                </button>
              ))}
            </div>
          </>
        ) : (
          <>
            <p>No batches yet. Tick some tickets in the Table view and choose Plan batch.</p>
            {s.batchArchived.length > 0 && (
              <div className="jira-bempty-list">
                <span>Archived:</span>
                {s.batchArchived.map((entry) => (
                  <button key={entry.id} className="jira-linkish" onClick={() => unarchiveBatch(entry.id)}>
                    {entry.name}
                  </button>
                ))}
              </div>
            )}
          </>
        )}
        {s.batchError && <div className="jira-error">{s.batchError}</div>}
      </div>
    );
  }

  const batch = s.batch;
  const addOnly = Boolean(batch.pendingProposal);
  const review = s.batchView === "review" || addOnly;

  return (
    <div className="jira-batcharea">
      {s.batchNote && (
        <div className="jira-note">
          {s.batchNote}
          <button className="jira-linkish" onClick={clearBatchNote}>
            Dismiss
          </button>
        </div>
      )}
      {s.batchError && <div className="jira-error">{s.batchError}</div>}
      {review ? (
        <BatchReview
          batch={batch}
          busy={s.batchBusy}
          addOnly={addOnly}
          agents={agents.map((preset) => ({ id: preset.id, label: preset.name }))}
          agentId={batch.agentId || agents[0]?.id || ""}
          skills={s.skills}
          executionSkill={s.executionSkill}
          qaSkill={s.qaSkill}
          onSkill={setSkillSlot}
          branchTemplate={readSetting("jira.clusterBranchTemplate") || "{cluster}"}
          worktreeLocation={worktreeLocationFor}
          showMenu={showMenu}
          onRename={renameBatchCluster}
          onRenameBatch={renameOpenBatch}
          onBoard={
            batch.clusters.some((cluster) => cluster.state !== "pending")
              ? () => setState({ batchView: "board" })
              : null
          }
          onBranch={setBatchClusterBranch}
          onAddCluster={addBatchCluster}
          onRemoveCluster={removeBatchCluster}
          onMove={moveBatchTicket}
          onAgent={(agentId) => setState({ batch: { ...batch, agentId } })}
          onReanalyze={reanalyze}
          onStart={(clusterIds, branches) => startBatchClusters(clusterIds, branches)}
          onApply={applyPendingProposal}
        />
      ) : (
        <div className={`jira-split${layout ? ` layout-${layout}` : ""}`} ref={split.splitRef}>
          <div className="jira-split-list">
            <BatchBoard
              batch={batch}
              batches={s.batchSummaries}
              archived={s.batchArchived}
              busy={s.batchBusy}
              focusedKey={s.focused?.key ?? null}
              clusterFilter={s.clusterFilter}
              showMenu={showMenu}
              onPickBatch={(id) => openBatch(id)}
              onToggleCluster={toggleClusterFilter}
              onClearFilter={() => setClusterFilter(new Set<string>())}
              onFocus={(key) => focusBatchTicket(key)}
              onClusterAction={runClusterAction}
              onRenameCluster={(clusterId) => void renameClusterFromBoard(clusterId)}
              onRenameBatch={() => void renameBatchFromBoard()}
              onReview={
                batch.clusters.some((cluster) => cluster.state === "pending")
                  ? () => setState({ batchView: "review" })
                  : null
              }
              onSendFeedback={sendBatchFeedback}
              onArchive={archiveOpenBatch}
              onUnarchive={unarchiveBatch}
              onDelete={deleteOpenBatch}
              onPlanMore={() => void openBatchForm({ top: 96, bottom: 96, left: 300, right: 300 }, "tab", batch.id)}
              onOpenReport={(reportPath) => openFileTab?.(reportPath)}
              onRebuildReport={rebuildClusterReport}
            />
          </div>
          {/* Only with a ticket open. It used to render beside the board
              whatever was selected, so half the width of the main screen was
              a sentence telling you to click a card, while the board it was
              crowding had its columns cut off at the split. */}
          {s.focused && (
            <>
              <div className={`jira-splitter ${split.direction}`} {...split.handleProps} />
              <aside className="jira-split-detail" aria-label="Ticket details" style={split.detailStyle}>
                <>
                  <div className="jira-pop-head">
                    <span className="jira-key">{s.focused.key}</span>
                    <button className="icon-button" title="Close" onClick={clearFocus}>
                      <Icon name="close" />
                    </button>
                  </div>
                  <BatchDetail
                    batch={batch}
                    issueKey={s.focused.key}
                    busy={s.batchBusy}
                    onFeedback={saveFeedbackDraft}
                    onAccept={acceptBatchTicket}
                    onOpenTerminal={(clusterId) => runClusterAction(clusterId, "open")}
                    onOpenShot={(key, which, opener) => openShot(key, which, opener)}
                    onOpenReport={(reportPath) => openFileTab?.(reportPath)}
                  />
                  <DetailBody detail={s.focused.detail} error={s.focused.error} />
                </>
              </aside>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function BoardArea({ list }: { list: ListId }) {
  const s = useJira();
  if (!s.board) return <div className="jira-empty">Loading the board…</div>;
  const issues = s.board.issues;
  const columns = resolveColumns(s.boardConfig, issues, categoryLookup(s, issues));
  // With "hide statuses not in any column" on, those tickets are off the
  // board - said out loud here so they don't simply seem to be missing.
  const hidden = hidingUnassigned(s.boardConfig) ? unplacedIssues(s.boardConfig, issues) : [];
  const shown = hidden.length > 0 ? issues.filter((issue) => !hidden.includes(issue)) : issues;
  const lanes = s.views[list].groupByProject ? groupByProject(shown) : null;
  return (
    <>
      <div className="jira-board-toolbar">
        <span className="jira-board-summary">
          {shown.length} {shown.length === 1 ? "ticket" : "tickets"}
          {hidden.length > 0 && (
            <span title={[...new Set(hidden.map((issue) => issue.status))].join(", ")}>
              {" "}
              &middot; {hidden.length} hidden (not in any column)
            </span>
          )}
        </span>
        <button
          className="jira-selaction"
          title="Choose which statuses each column holds"
          onClick={(e) => openColumnEditor(anchorOf(e.currentTarget))}
        >
          Edit columns
        </button>
      </div>
      <Board
        columns={columns}
        lanes={lanes}
        selection={s.selection}
        picking={s.selectMode || s.selection.size > 0}
        focusedKey={s.focused?.key ?? null}
        collapsedLanes={collapsedFor(list)}
        onOpen={(issue) => focusIssue(issue)}
        onToggleSelected={(issue) => toggleSelected(list, issue.key)}
        onToggleLane={(key) => toggleGroup(list, key)}
      />
    </>
  );
}

function JiraTab({ showMenu, setTitle }: ViewerHostProps) {
  const s = useJira();
  const gate = gateMessage(s);
  const list = s.tabList;
  const issues = list === "mine" ? s.mine : (s.project?.issues ?? []);
  const filtered = !filtersAreEmpty(s.filters[list]);
  const title = tabTitle(s);

  // Renamed in place as the active repository changes, without re-activating
  // the tab - it follows the repo, it doesn't steal focus when you switch.
  useEffect(() => {
    setTitle?.(title);
  }, [title, setTitle]);

  const onBoard = s.tabView === "board";
  const onBatches = s.tabView === "batches";
  const boardIssues = s.board?.issues ?? null;
  // The open ticket may be one only the board holds (past the table's cap,
  // or already Done), so both lists are searched.
  const focusedIssue = s.focused
    ? (issues.find((issue) => issue.key === s.focused!.key) ??
      boardIssues?.find((issue) => issue.key === s.focused!.key) ??
      null)
    : null;

  // The board list is fetched only while the board is actually on screen.
  useEffect(() => {
    setBoardActive(onBoard);
    return () => setBoardActive(false);
  }, [onBoard]);

  const [layout, chooseLayout] = useLayoutChoice();
  const split = useSplitResize(layout);
  const busy = s.busyKey !== null;

  // The actions live on the right of the scope bar, always in the same place:
  // for the selection when anything is ticked, otherwise for the one ticket
  // open in the detail pane. Ticking rows turns this same slot into the
  // selection's actions, rather than stacking a second bar above the list.
  const nothingPicked = s.selection.size === 0;
  let actions: ReactNode = null;
  if (s.selectMode || s.selection.size > 0) {
    actions = (
      <>
        <span className="jira-head-target">{s.selection.size} selected</span>
        {/* Only where there is no table header to put them in. The table
            has its own tri-state checkbox in the first column, which is
            where anyone looks for it; the board's cards have no such row,
            so these stay for it. */}
        {onBoard && s.selection.size < issues.length && (
          <button className="jira-linkish" onClick={() => selectAll("tab")} title={`Select the ${issues.length} tickets in this list`}>
            Select all
          </button>
        )}
        {onBoard && (
          <button className="jira-linkish" disabled={nothingPicked} onClick={clearSelection}>
            Deselect all
          </button>
        )}
        <button
          className="jira-selaction"
          disabled={busy || nothingPicked}
          title="Hand these tickets to a worktree that already exists"
          onClick={(e) => addSelectionToWorktree(showMenu, e.clientX, e.clientY)}
        >
          Add to worktree
        </button>
        <button
          className="jira-selaction"
          disabled={busy || nothingPicked}
          title="Split these tickets into clusters and work them in parallel"
          onClick={(e) => planBatchWithPicker(anchorOf(e.currentTarget), showMenu, e.clientX, e.clientY, "tab")}
        >
          Plan batch...
        </button>
        <button
          className="jira-selaction primary"
          disabled={busy || nothingPicked}
          title="Create one worktree for these tickets"
          onClick={(e) => void openStartForm(anchorOf(e.currentTarget), "tab")}
        >
          Start work
        </button>
      </>
    );
  } else if (focusedIssue) {
    actions = (
      <>
        <span className="jira-head-target jira-key">{focusedIssue.key}</span>
        <button
          className="jira-selaction"
          disabled={busy}
          title="Hand this ticket to a worktree that already exists"
          onClick={(e) => void addToWorktree([focusedIssue], showMenu, e.clientX, e.clientY)}
        >
          Add to worktree
        </button>
        <button
          className="jira-selaction primary"
          disabled={busy}
          title="Create a worktree session for this ticket"
          onClick={(e) => void startWorkWithPicker(focusedIssue, showMenu, e.clientX, e.clientY)}
        >
          {s.busyKey === focusedIssue.key ? "Starting..." : "Start work"}
        </button>
      </>
    );
  }

  return (
    <div className={`jira-tab${split.dragging ? " resizing" : ""}`}>
      {/* At the TAB's root, not the batch area's: the viewer has to cover this
          tab's own toolbars as well as its content, or a click meant for the
          image's edge lands on "Table" and swaps the view out from under it. */}
      {s.lightbox && (
        <Lightbox
          shots={s.lightbox.shots}
          index={s.lightbox.index}
          onIndex={setShotIndex}
          onClose={closeShot}
        />
      )}
      <div className="jira-tab-head">
        {/* Everything up to the view switcher acts on the issue list, which
            the Batches view does not show: the scope tabs pick which list
            Table and Board read, and a batch reads neither. Left in place
            they are a choice that changes nothing on screen. */}
        {!onBatches && (
          <div className="jira-scope" role="tablist" aria-label="Which issues">
            <button
              role="tab"
              aria-selected={list === "mine"}
              className={`jira-scope-button${list === "mine" ? " active" : ""}`}
              onClick={() => setTabList("mine")}
            >
              Assigned to me
              <span className="jira-scope-count">{s.mine.length}</span>
            </button>
            <button
              role="tab"
              aria-selected={list === "project"}
              className={`jira-scope-button${list === "project" ? " active" : ""}`}
              onClick={() => setTabList("project")}
            >
              Project
              {s.project && <span className="jira-scope-count">{s.project.issues.length}</span>}
            </button>
          </div>
        )}
        <div className="jira-scope" role="group" aria-label="View">
          <button
            aria-pressed={!onBoard}
            className={`jira-scope-button${!onBoard ? " active" : ""}`}
            onClick={() => setTabView("table")}
          >
            <Icon name="list-flat" /> Table
          </button>
          <button
            aria-pressed={onBoard}
            className={`jira-scope-button${onBoard ? " active" : ""}`}
            onClick={() => setTabView("board")}
          >
            <Icon name="project" /> Board
          </button>
          <button
            aria-pressed={onBatches}
            className={`jira-scope-button${onBatches ? " active" : ""}`}
            title={s.batch ? `Batch: ${s.batch.name}` : "Tickets split into clusters, one agent each"}
            onClick={() => openBatches()}
          >
            <Icon name="layers" /> Batches
            {s.batchBadge > 0 && <span className="jira-scope-count">{s.batchBadge}</span>}
          </button>
        </div>
        {!gate && !onBatches && list === "project" && <ProjectCaption host="tab" />}
        {!gate && !onBatches && actions && <div className="jira-head-actions">{actions}</div>}
        {!gate && (
          // Side by side or top and bottom. Until one is picked the tab
          // decides by its width; the highlighted button is whichever layout
          // is showing now, chosen or not.
          <div className="jira-layout-toggle" role="group" aria-label="Layout">
            <button
              className={`icon-button${split.direction === "row" ? " active" : ""}`}
              aria-pressed={split.direction === "row"}
              title="Details beside the list"
              onClick={() => chooseLayout("row")}
            >
              <Icon name="layout-sidebar-right" />
            </button>
            <button
              className={`icon-button${split.direction === "column" ? " active" : ""}`}
              aria-pressed={split.direction === "column"}
              title="Details below the list"
              onClick={() => chooseLayout("column")}
            >
              <Icon name="layout-panel" />
            </button>
          </div>
        )}
      </div>

      {!gate && !onBatches && (list === "mine" || hasProject(s)) && (
        <FilterBar
          filters={s.filters[list]}
          facets={s.facets}
          selectMode={s.selectMode}
          showAssignee={list === "project"}
          onApply={(filters) => applyFilters(list, filters)}
          onToggleSelectMode={() => setSelectMode(!s.selectMode)}
          onPasteKeys={(anchor) => openKeyPaste(anchor, "tab")}
          view={s.views[list]}
          onView={(view) => applyView(list, view)}
          inlineView
        />
      )}
      {s.startError && <div className="jira-error">{s.startError}</div>}
      {s.note && <div className="jira-note">{s.note}</div>}

      {gate ? (
        <Gate message={gate} />
      ) : onBatches ? (
        <BatchArea showMenu={showMenu} />
      ) : list === "project" && !hasProject(s) ? (
        <div className="jira-empty">
          No project key for this repository. Choose one above, or add a .jira-project file.
        </div>
      ) : (
        <div className={`jira-split${layout ? ` layout-${layout}` : ""}`} ref={split.splitRef}>
          <div className="jira-split-list">
            {onBoard ? (
              <BoardArea list={list} />
            ) : issues.length === 0 ? (
              <EmptyList
                list={list}
                filtered={filtered}
                text={list === "mine" ? "No issues assigned to you." : "No open issues."}
              />
            ) : (
              <IssueList issues={issues} list={list} showMenu={showMenu} variant="table" />
            )}
          </div>
          {/* Only with a ticket open, whichever way the split runs. Side by
              side it used to stay for the sake of a hint telling you to
              select a ticket - and width is exactly what the table wants,
              since the summary column is the one that gets squeezed to pay
              for it. */}
          {s.focused && (
          <>
          <div className={`jira-splitter ${split.direction}`} {...split.handleProps} />
          <aside className="jira-split-detail" aria-label="Ticket details" style={split.detailStyle}>
            {s.focused ? (
              <>
                <div className="jira-pop-head">
                  <span className="jira-key">{s.focused.key}</span>
                  {s.focused.detail && (
                    <button className="icon-button" title="Refresh from Jira" onClick={reloadFocused}>
                      <Icon name="refresh" />
                    </button>
                  )}
                  {s.focused.detail && (
                    <a
                      className="icon-button"
                      href={s.focused.detail.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      title="Open in Jira"
                    >
                      <Icon name="link-external" />
                    </a>
                  )}
                  <button className="icon-button jira-detail-close" title="Close" onClick={clearFocus}>
                    <Icon name="close" />
                  </button>
                </div>
                <DetailBody detail={s.focused.detail} error={s.focused.error} />
              </>
            ) : null}
          </aside>
          </>
          )}
        </div>
      )}
      <Floating host="tab" />
      {s.columnEditor && (
        <ColumnEditor
          anchor={s.columnEditor.anchor}
          config={s.boardConfig}
          statuses={editorStatuses(s)}
          onSave={saveBoardConfig}
          onCancel={closeColumnEditor}
        />
      )}
    </div>
  );
}

// ---- Status bar ----

// The Jira mark in the status bar; a click opens the editor tab. The count of
// tickets assigned to you rides in the tooltip rather than on the bar, which
// keeps the item one glyph wide on a phone's compact bar.
// The two slots in Settings. They read the same list the review bar does and
// write the stored default, which every new cluster starts from.
function SkillSetting({ slot }: { slot: "execution" | "qa" }) {
  const s = useJira();
  const [, rerender] = useState(0);
  useEffect(() => extSettings?.onDidChange(() => rerender((n) => n + 1)), []);
  const key = slot === "execution" ? "jira.executionSkill" : "jira.qaSkill";
  if (!s.skills) return <div className="jira-skillpicker-note">Open a repository to list the skills it can see.</div>;
  return (
    <SkillPicker
      value={readSetting(key)}
      skills={s.skills.skills}
      defaultLabel={slot === "execution" ? s.skills.defaults.execution : s.skills.defaults.qa}
      defaultDescription={slot === "qa" ? QA_DEFAULT_NOTE : undefined}
      onChange={(value) => {
        extSettings?.set(key, value);
        setSkillSlot(slot, value);
      }}
    />
  );
}

function ExecutionSkillSetting() {
  return <SkillSetting slot="execution" />;
}

function QaSkillSetting() {
  return <SkillSetting slot="qa" />;
}

function JiraStatusItem() {
  const s = useJira();
  const [, rerender] = useState(0);
  useEffect(() => extSettings?.onDidChange(() => rerender((n) => n + 1)), []);
  if (extSettings?.get("jira.showStatusBarIcon") === false) return null;
  const assigned = s.status?.authed ? ` - ${s.mine.length} assigned to you` : "";
  // The batch count is what is back with YOU: an agent blocked on a prompt,
  // or work waiting to be reviewed. Worth the tooltip's second line, since a
  // batch runs whether or not this tab is open.
  const waiting =
    s.batchBadge > 0
      ? `\n${s.batchBadge} batch ${s.batchBadge === 1 ? "ticket needs you or is" : "tickets need you or are"} in review`
      : "";
  return (
    <button
      className={`status-bar-item jira-statusbar${s.batchBadge > 0 ? " attention" : ""}`}
      title={`Open Jira${assigned}${waiting}`}
      onClick={() => openJiraTab()}
    >
      <span className="codicon codicon-project jira-statusbar-icon" aria-hidden="true" />
      {s.batchBadge > 0 && <span className="jira-statusbar-count">{s.batchBadge}</span>}
    </button>
  );
}

// ---- Activation ----

// The settings whose change alters what the panes fetch, and those that
// alter a ticket's details. Anything else - jira.filters, the branch
// template, the cache TTL itself - needs no reload.
const REFRESH_KEYS = [
  "jira.siteUrl",
  "jira.email",
  "jira.projectKey",
  "jira.projectKeyFile",
  "jira.projectKeyEnv",
  "jira.projectMap",
  "jira.jql",
  "jira.projectJql",
  "jira.maxResults",
  "jira.boardMaxResults",
  "jira.boardDoneDays",
];
const DETAIL_KEYS = ["jira.siteUrl", "jira.email", "jira.commentLimit"];

function fingerprint(keys: readonly string[]): string {
  return JSON.stringify(keys.map((key) => extSettings?.get(key) ?? null));
}

let refreshPrint = "";
let detailsPrint = "";
let boardPrint = "";

// The column editor's Save: one global configuration, into the synced
// settings document, not declared in the manifest.
export function saveBoardConfig(config: BoardConfig): void {
  const serialized = serializeBoardConfig(config);
  boardPrint = JSON.stringify(serialized);
  setState({ boardConfig: config, columnEditor: null });
  extSettings?.set("jira.board", serialized);
}

export function openColumnEditor(anchor: PopoverAnchor): void {
  setState({ columnEditor: { anchor } });
}

export function closeColumnEditor(): void {
  setState({ columnEditor: null });
}

// The statuses the editor offers: every one Jira reports for the list, plus
// any a board ticket carries that the metadata missed - in category order,
// then by name, so To Do statuses come first as they do on the board.
function editorStatuses(s: JiraState): { name: string; category: string | null }[] {
  const known = new Map<string, string | null>();
  for (const status of s.facets?.statuses ?? []) known.set(status.name, status.category ?? null);
  for (const issue of s.board?.issues ?? []) if (!known.has(issue.status)) known.set(issue.status, issue.statusCategory);
  const rank = (category: string | null) => {
    const i = CATEGORY_ORDER.indexOf(category as (typeof CATEGORY_ORDER)[number]);
    return i === -1 ? CATEGORY_ORDER.length : i;
  };
  return [...known]
    .map(([name, category]) => ({ name, category }))
    .sort((a, b) => rank(a.category) - rank(b.category) || a.name.localeCompare(b.name));
}

interface ExtensionContext {
  registerSidebarPanel(panel: {
    id: string;
    title: string;
    icon?: string;
    location?: "tab" | "explorer" | "run" | "commands";
    defaultTab?: string;
    focusBinding?: string;
    component: (props: SidebarPanelHostProps) => ReturnType<typeof AssignedPanel>;
  }): void;
  // `after` places the component directly under that setting; a core older
  // than the option ignores it and renders the component at the bottom.
  registerSettingsComponent(entry: {
    id: string;
    component: () => ReturnType<typeof SettingsPanel> | null;
    after?: string;
  }): void;
  registerFileViewer(viewer: {
    id: string;
    extensions: string[];
    mode?: "default" | "preview";
    editorFallback?: boolean;
    component: (props: ViewerHostProps) => ReturnType<typeof JiraTab>;
  }): void;
  registerCommand(cmd: { id: string; label: string; defaultBinding?: string; run: () => void }): void;
  // Optional: an older core has no status bar API at all.
  registerStatusBarItem?(item: {
    id: string;
    title?: string;
    placement?: "left" | "right";
    order?: number;
    visibilitySetting?: string;
    component: () => ReturnType<typeof JiraStatusItem>;
  }): void;
  serverFetch(path: string, init?: RequestInit): Promise<Response>;
  assetUrl(relPath: string): string;
  settings: SettingsApi;
  app: {
    getActiveContext(): ActiveContext;
    onDidChangeContext(cb: (ctx: ActiveContext) => void): () => void;
    openSessionWindow(sessionName: string, opts?: { createCwd?: string }): void;
    openViewerTab(viewerId: string, path: string, opts?: { title?: string }): void;
    // Opens the cluster's rendered QA report - an ordinary file, opened the
    // way the FILES tree opens one.
    openFileTab?(path: string, line?: number): void;
    // Optional: an older core has no badges. Without it the count still shows
    // on the Batches button in the tab, which is where it matters most.
    setSidebarBadge?(panelId: string, badge: number | null): void;
    // Optional: an older core has no dialogs. Stopping a cluster and removing
    // a worktree both confirm first, and without this they fall back to
    // window.confirm rather than doing it unasked.
    confirmDialog?(message: string, confirmLabel?: string): Promise<boolean>;
    // Optional too, and for the same reason: renaming a cluster falls back to
    // window.prompt on a core that has none.
    promptDialog?(message: string, defaultValue?: string): Promise<string | null>;
  };
}

export function activate(ctx: ExtensionContext): void {
  serverFetch = ctx.serverFetch;
  setApiFetcher(ctx.serverFetch);
  getActiveContext = ctx.app.getActiveContext;
  onDidChangeContext = ctx.app.onDidChangeContext;
  openSessionWindow = ctx.app.openSessionWindow;
  hostConfirm = ctx.app.confirmDialog ? ctx.app.confirmDialog.bind(ctx.app) : null;
  hostPrompt = ctx.app.promptDialog ? ctx.app.promptDialog.bind(ctx.app) : null;
  setHostBadge = ctx.app.setSidebarBadge ? ctx.app.setSidebarBadge.bind(ctx.app) : null;
  openFileTab = ctx.app.openFileTab ? ctx.app.openFileTab.bind(ctx.app) : null;
  openViewerTab = ctx.app.openViewerTab.bind(ctx.app);
  extSettings = ctx.settings;
  refreshPrint = fingerprint(REFRESH_KEYS);
  detailsPrint = fingerprint(DETAIL_KEYS);
  setFetcher(ctx.serverFetch);
  // The settings component is registered on its own and gets no context from
  // the panes, so the project-mapping table is handed what it needs here.
  setSettingsBridge({
    getSetting: (key) => ctx.settings.get(key),
    setSetting: (key, value) => ctx.settings.set(key, value),
    getActiveRepo: () => state.status?.repo ?? null,
    subscribe: (cb) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
  });
  removeStylesheet = injectStylesheet(ctx.assetUrl, "dist/client.css");
  setMarkdownAssetUrl(ctx.assetUrl);

  // The store is driven from here, not from a component: two panes share it,
  // and either one may be collapsed or absent when the context changes.
  const initialCwd = getActiveContext?.().cwd ?? null;
  state = {
    ...state,
    cwd: initialCwd,
    ...loadFiltersFor(initialCwd),
    boardConfig: parseBoardConfig(ctx.settings.get("jira.board")),
  };
  boardPrint = JSON.stringify(ctx.settings.get("jira.board") ?? null);
  refresh();
  disposeBridge = [
    onDidChangeContext?.((active) => {
      if (active.cwd === state.cwd) return;
      // Each repo reopens under the filters it was left with, and a selection
      // made in one project has no meaning in the next.
      setState({
        cwd: active.cwd,
        popover: null,
        ...loadFiltersFor(active.cwd),
        facets: null,
        selection: new Set<string>(),
        anchor: { mine: null, project: null },
        startForm: null,
        projectPicker: null,
        // The ticket open in the tab belonged to the previous repo.
        focused: null,
        collapsedGroups: new Set<string>(),
        board: null,
      });
      refresh();
    }) ?? (() => {}),
    // A settings change reloads only when it changes what would be fetched.
    // Every filter tick writes jira.filters, and that used to count as a
    // change like any other - re-asking /status, /facets, /projects and both
    // lists on top of the reload the filter had already triggered.
    ctx.settings.onDidChange(() => {
      // The board's columns can be edited from another device (the setting
      // syncs), so they are re-read on any change - which costs no request.
      const nextBoard = JSON.stringify(ctx.settings.get("jira.board") ?? null);
      if (nextBoard !== boardPrint) {
        boardPrint = nextBoard;
        setState({ boardConfig: parseBoardConfig(ctx.settings.get("jira.board")) });
      }
      const nextDetails = fingerprint(DETAIL_KEYS);
      if (nextDetails !== detailsPrint) {
        detailsPrint = nextDetails;
        // A different site or account, or a different comment count, makes
        // every cached ticket wrong.
        detailCache.clear();
      }
      const nextRefresh = fingerprint(REFRESH_KEYS);
      if (nextRefresh !== refreshPrint) {
        refreshPrint = nextRefresh;
        refresh();
      }
    }),
    onTokenChange(() => {
      detailCache.clear();
      refresh();
    }),
    (() => {
      const timer = setInterval(() => detailCache.sweep(), DETAIL_SWEEP_MS);
      return () => clearInterval(timer);
    })(),
  ];

  // "project" is the codicon name; style.css replaces the glyph with the Jira
  // mark, scoped to this panel's own tab id.
  ctx.registerSidebarPanel({
    id: "jira",
    title: "Assigned to Me",
    icon: "project",
    component: AssignedPanel,
  });
  // Its own pane rather than a section inside the first: the host's accordion
  // then owns collapse, resize and reorder, and remembers them per user.
  // defaultTab puts it under the JIRA tab instead of standing up a second tab
  // (core namespaces the id - see client/src/extensions.ts).
  ctx.registerSidebarPanel({
    id: "project",
    title: "Project",
    icon: "folder",
    location: "tab",
    defaultTab: "jira",
    component: ProjectPanel,
  });

  // Each beside the field it belongs with: the token with the site URL and
  // email it authenticates, the mapping table under the JSON setting it
  // edits. Registered token first, so on a core without `after` - where both
  // land at the bottom - the credential still comes before the table.
  ctx.registerSettingsComponent({ id: "jira-token", component: SettingsPanel, after: "jira.email" });
  // The same picker as the review bar, writing the stored default instead of
  // a per-run override.
  ctx.registerSettingsComponent({ id: "jira-execution-skill", component: ExecutionSkillSetting, after: "jira.executionSkill" });
  ctx.registerSettingsComponent({ id: "jira-qa-skill", component: QaSkillSetting, after: "jira.qaSkill" });
  ctx.registerSettingsComponent({ id: "jira-project-map", component: ProjectMapSettings, after: "jira.projectMap" });

  // extensions: [] - the tab is never matched to a file; it is reached only
  // through openViewerTab, from the panes' open-in-tab button or the command
  // below. editorFallback: false, since there is no file to fall back to.
  ctx.registerFileViewer({ id: TAB_VIEWER, extensions: [], editorFallback: false, component: JiraTab });

  // One stream for the page, opened at activation rather than by the board:
  // the badge has to move while you are looking at something else - that is
  // the whole point of it - and a batch runs whether or not its view is open.
  // The board still only refetches the batch actually on screen.
  disposeBridge.push(subscribeBatchEvents(onBatchChanged, refreshOpenBatch));

  ctx.registerCommand({
    id: "open",
    label: "Jira: Open in Editor Tab",
    run: () => openJiraTab(),
  });

  // Reachable with nothing ticked, which is the point: a batch can be built
  // entirely from pasted keys, and the selection bar only exists once
  // something is selected.
  ctx.registerCommand({
    id: "plan-batch",
    label: "Jira: Plan Batch",
    run: () => {
      openJiraTab();
      // No button was pressed, so the popover is anchored to a thin strip
      // near the top of the window instead of to an element.
      const x = Math.round(window.innerWidth / 2);
      void openBatchForm({ top: 96, bottom: 96, left: x, right: x }, "tab", null);
    },
  });

  // Adopting the QA procedure rather than patching it. A copy in the user's
  // own skills directory is theirs: the picker lists it, editing it takes
  // effect on the next cluster, and an extension update cannot undo it.
  ctx.registerCommand({
    id: "install-qa-skill",
    label: "Jira: Install the batch QA skill",
    run: () => {
      void installQaSkill();
    },
  });

  ctx.registerCommand({
    id: "open-batches",
    label: "Jira: Open Batches",
    run: () => {
      openJiraTab();
      openBatches();
    },
  });

  // One click to the editor tab from anywhere. The host shows or hides it by
  // jira.showStatusBarIcon (and lists it under Settings -> UI's status bar
  // items); JiraStatusItem checks the setting too, for a core that predates
  // visibilitySetting.
  ctx.registerStatusBarItem?.({
    id: "open",
    title: "Jira",
    placement: "left",
    order: 2,
    visibilitySetting: "jira.showStatusBarIcon",
    component: JiraStatusItem,
  });
}

export function deactivate(): void {
  removeStylesheet?.();
  removeStylesheet = null;
  setSettingsBridge(null);
  setMarkdownAssetUrl(null);
  detailCache.clear();
  detailInFlight.clear();
  openViewerTab = null;
  for (const dispose of disposeBridge) dispose();
  disposeBridge = [];
  listeners.clear();
}
