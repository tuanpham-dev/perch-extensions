// File paths in the conversation as links, the way the terminal makes them:
// the host's own detector (findCandidates, so both agree on what looks like a
// path) finds the candidates, the server says which are real files under the
// session's cwd, and a click opens one through the app's usual file dispatch
// (ctx.app.openFileTab), at its ":line" when it has one. URLs the detector
// finds in plain text and code link too. The gestures match the terminal's,
// except that a plain click opens (there is no terminal input here for a
// click to mean something else): Shift+click opens the rendered preview when
// a viewer has one, and the context menu offers Open, Preview and Copy Path.
import { Children, createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { findCandidates, type Candidate } from "@perch/engine-support";
import { host, postJson, type MenuItem, type ShowMenu } from "./bridge";
import { copyText } from "./clipboard";

// A found file is reused for a while; a miss only briefly, so a file Claude
// is about to write links soon after it appears.
const FOUND_TTL_MS = 60_000;
const MISSING_TTL_MS = 5_000;
// Batches the lookups of every row that mounts in one render pass.
const BATCH_MS = 30;
// Must not exceed the server's MAX_PATHS.
const MAX_BATCH = 200;
// Past this the text is shown as is: a huge tool result isn't worth scanning.
const MAX_TEXT_CHARS = 20_000;

export type FileLinks = {
  peek(path: string): string | null | undefined;
  resolve(path: string): Promise<string | null>;
  open(path: string, line?: number): void;
  // Shift+click: the preview viewer when one claims the path, else open.
  openSecondary(path: string, line?: number): void;
  canPreview(path: string): boolean;
  preview(path: string): void;
  showMenu: ShowMenu | null;
};

export const FileLinksContext = createContext<FileLinks | null>(null);

// showMenu is read through a getter: the host passes a fresh one per render,
// and the cache must outlive that.
export function createFileLinks(windowId: string, cwd: string, getShowMenu: () => ShowMenu | undefined): FileLinks | null {
  const openFileTab = host.app?.openFileTab;
  if (!openFileTab) return null;
  const cache = new Map<string, { value: string | null; expires: number }>();
  const inflight = new Map<string, Promise<string | null>>();
  let queue = new Map<string, (value: string | null) => void>();
  let timer: number | null = null;

  const flush = async () => {
    timer = null;
    const batch = queue;
    queue = new Map();
    const paths = [...batch.keys()];
    for (let i = 0; i < paths.length; i += MAX_BATCH) {
      const chunk = paths.slice(i, i + MAX_BATCH);
      let results: (string | null)[] | null = null;
      try {
        const { status, data } = await postJson<{ results?: (string | null)[] }>("/resolve-paths", { windowId, cwd, paths: chunk });
        if (status < 400 && Array.isArray(data?.results)) results = data.results;
      } catch {
        // Not cached: the next mount asks again.
      }
      const stamp = Date.now();
      chunk.forEach((p, j) => {
        const value = results?.[j] ?? null;
        if (results) cache.set(p, { value, expires: stamp + (value ? FOUND_TTL_MS : MISSING_TTL_MS) });
        inflight.delete(p);
        batch.get(p)?.(value);
      });
    }
  };

  const peek = (p: string) => {
    const hit = cache.get(p);
    return hit && hit.expires > Date.now() ? hit.value : undefined;
  };

  return {
    peek,
    resolve(p) {
      const known = peek(p);
      if (known !== undefined) return Promise.resolve(known);
      let pending = inflight.get(p);
      if (!pending) {
        pending = new Promise((done) => queue.set(p, done));
        inflight.set(p, pending);
        timer ??= window.setTimeout(() => void flush(), BATCH_MS);
      }
      return pending;
    },
    open: (p, line) => openFileTab(p, line),
    openSecondary(p, line) {
      if (host.app?.canPreview?.(p)) host.app.openPreview?.(p);
      else openFileTab(p, line);
    },
    canPreview: (p) => host.app?.canPreview?.(p) ?? false,
    preview: (p) => host.app?.openPreview?.(p),
    get showMenu() {
      return getShowMenu() ?? null;
    },
  };
}

type Piece = { start: number; end: number; text: string } & ({ kind: "url"; href: string } | { kind: "file"; path: string; line?: number });

function linkPieces(candidates: Candidate[], links: FileLinks): Piece[] {
  const usable: Piece[] = [];
  for (const c of candidates) {
    if (c.kind === "url") {
      usable.push({ kind: "url", start: c.startIdx, end: c.endIdx, text: c.text, href: c.target });
    } else {
      const path = links.peek(c.target);
      if (path) usable.push({ kind: "file", start: c.startIdx, end: c.endIdx, text: c.text, path, line: c.line });
    }
  }
  // Earliest first, a URL ahead of a path starting at the same place; a
  // piece overlapping one already taken (the path part of a URL) is dropped.
  usable.sort((a, b) => a.start - b.start || (a.kind === "url" ? -1 : 1));
  const pieces: Piece[] = [];
  let end = 0;
  for (const piece of usable) {
    if (piece.start < end) continue;
    pieces.push(piece);
    end = piece.end;
  }
  return pieces;
}

export function LinkedText({ text }: { text: string }) {
  const links = useContext(FileLinksContext);
  const candidates = useMemo(() => (links && text.length <= MAX_TEXT_CHARS ? findCandidates(text) : []), [text, links]);
  const [, setResolved] = useState(0);

  useEffect(() => {
    if (!links) return;
    const unknown = candidates.filter((c) => c.kind === "path" && links.peek(c.target) === undefined);
    if (unknown.length === 0) return;
    let cancelled = false;
    void Promise.all(unknown.map((c) => links.resolve(c.target))).then((results) => {
      if (!cancelled && results.some(Boolean)) setResolved((n) => n + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [candidates, links]);

  if (!links || candidates.length === 0) return <>{text}</>;
  const pieces = linkPieces(candidates, links);
  if (pieces.length === 0) return <>{text}</>;

  const out: ReactNode[] = [];
  let at = 0;
  for (const piece of pieces) {
    if (piece.start > at) out.push(text.slice(at, piece.start));
    out.push(
      piece.kind === "url" ? (
        <a
          key={piece.start}
          className="cv-link"
          href={piece.href}
          target="_blank"
          rel="noreferrer noopener"
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => showLinkMenu(e, links, [
            { label: "Open Link", onClick: () => window.open(piece.href, "_blank", "noopener,noreferrer") },
            { label: "Copy Link", onClick: () => void copyText(piece.href).catch(() => {}) },
          ])}
        >
          {piece.text}
        </a>
      ) : (
        <a
          key={piece.start}
          className="cv-link"
          href="#"
          title={`Open ${piece.path}${piece.line ? `:${piece.line}` : ""}`}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            if (e.shiftKey) links.openSecondary(piece.path, piece.line);
            else links.open(piece.path, piece.line);
          }}
          onContextMenu={(e) => {
            const items: MenuItem[] = [{ label: "Open File", onClick: () => links.open(piece.path, piece.line) }];
            if (links.canPreview(piece.path)) items.push({ label: "Preview", onClick: () => links.preview(piece.path) });
            items.push({ label: "Copy Path", onClick: () => void copyText(piece.path).catch(() => {}) });
            showLinkMenu(e, links, items);
          }}
        >
          {piece.text}
        </a>
      ),
    );
    at = piece.end;
  }
  if (at < text.length) out.push(text.slice(at));
  return <>{out}</>;
}

// The app's own context menu in place of the browser's, when the host gave
// the tab one.
function showLinkMenu(e: React.MouseEvent, links: FileLinks, items: MenuItem[]) {
  const showMenu = links.showMenu;
  if (!showMenu) return;
  e.preventDefault();
  e.stopPropagation();
  showMenu(e.clientX, e.clientY, items);
}

/** Element children with each plain string run through LinkedText. */
export function linkChildren(children: ReactNode): ReactNode {
  return Children.map(children, (child) => (typeof child === "string" ? <LinkedText text={child} /> : child));
}
