// Shapes of the server's /screen, /wait and /session responses (see
// ../screen.mjs and ../watcher.mjs).

export type PromptOption = {
  n: number;
  label: string;
  description: string | null;
  cursor: boolean;
  checked: boolean | null;
  current?: boolean;
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
