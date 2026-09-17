// Shapes of the server's /screen, /wait and /session responses (see
// ../screen.mjs and ../watcher.mjs).

export type PromptOption = {
  n: number;
  label: string;
  description: string | null;
  cursor: boolean;
  checked: boolean | null;
  current?: boolean;
  // A text field in the terminal ("Type something"), and what is typed in it.
  textEntry?: boolean;
  typed?: string;
};

export type Prompt = {
  kind: "permission" | "plan" | "trust" | "question" | "generic";
  review: boolean;
  title: string;
  question: string | null;
  body: string[];
  plan: { text: string; truncated: boolean } | null;
  tabs: { label: string; done: boolean; submit: boolean }[] | null;
  answers: { question: string; answer: string }[] | null;
  options: PromptOption[];
  numbered: boolean;
  multiSelect: boolean;
  // AskUserQuestion's active tab (index into tabs), from the screen's colors.
  activeTab?: number | null;
  // AskUserQuestion with previews: the highlighted option's preview, the
  // Notes field (editing: open in the terminal), and the unnumbered "Chat
  // about this" row.
  preview?: { lines: string[]; hidden: number } | null;
  notes?: { text: string; editing?: boolean } | null;
  chat?: { cursor: boolean } | null;
  // A multi-select list's Next or Submit button row.
  action?: { label: string; cursor: boolean } | null;
  footer: string | null;
  // Single-letter keys the footer offers for the highlighted row.
  letterKeys?: { key: string; label: string }[];
  signature: string;
};

export type Activity =
  | { state: "working"; label: string; elapsed: string | null; tokens: string | null; note: string | null }
  | { state: "idle"; verb: string | null; elapsed: string | null; note: string | null };

export type ScreenState = {
  windowId: string;
  sessionName?: string;
  windowIndex?: number;
  windowName?: string;
  cwd?: string;
  epoch: number;
  updatedAt?: number;
  stale?: boolean;
  error?: string | null;
  closed?: boolean;
  unsupported?: boolean;
  mode: { id: string; label: string } | null;
  activity: Activity | null;
  prompt: Prompt | null;
  input: { text: string } | null;
  unmodeled: boolean;
  tail: string;
};

export type SessionInfo = {
  window: { windowId: string; sessionName: string; windowIndex: number; cwd: string } | null;
  running: boolean;
  session: { sessionId: string; file: string | null; cwd: string; live: boolean } | null;
};
