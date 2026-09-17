// The Claude Viewer tab for one terminal window. filePath is
// "claude-viewer/<windowId>": the tab follows the window, and through it
// whichever Claude session that window is running (a /clear or /resume moves
// it to the new session).
//
// Three loops, each with its own cadence:
//   - session: which session the window runs, every few seconds
//   - transcript: new messages while the tab is focused
//   - screen: a long poll the server answers as soon as the screen changes
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { getJson, host, postJson, setting, uploadFile } from "./bridge";
import { applyMessages, collectImages, createChatModel, type ChatModel, type TranscriptMessage } from "./chatModel";
import { Composer, type ComposerHandle, type PendingImage, type SlashCommand } from "./Composer";
import { Lightbox, LightboxContext } from "./Lightbox";
import { MessageList } from "./MessageList";
import { PromptCard } from "./PromptCard";
import { ScreenStrip } from "./ScreenStrip";
import { Toolbar } from "./Toolbar";
import type { ScreenState, SessionInfo } from "./types";
import { addToTally, createTally, type UsageTally } from "./usage";

const SESSION_POLL_MS = 3000;

export function windowIdFromPath(filePath: string): string {
  return filePath.split("/").pop() ?? filePath;
}

function subscribeSettings(cb: () => void): () => void {
  return host.settings?.onDidChange(cb) ?? (() => {});
}

function useSettings() {
  const read = () => ({
    pollInterval: Math.max(250, Number(setting("claudeViewer.pollInterval", 1000)) || 1000),
    fontSize: Number(setting("claudeViewer.fontSize", 14)) || 14,
    showMeters: setting<boolean>("claudeViewer.showUsageMeters", false) === true,
    showContext: setting<boolean>("claudeViewer.showContext", true) !== false,
    enterSends: setting<string>("claudeViewer.enterKey", "send") !== "newline",
  });
  const [value, setValue] = useState(read);
  useEffect(() => subscribeSettings(() => setValue(read())), []);
  return value;
}

function useSession(windowId: string): SessionInfo | null {
  const [info, setInfo] = useState<SessionInfo | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      getJson<SessionInfo>(`/session?windowId=${encodeURIComponent(windowId)}`)
        .then((next) => {
          if (cancelled) return;
          setInfo((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
        })
        .catch(() => {});
    void load();
    const t = window.setInterval(load, SESSION_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, [windowId]);
  return info;
}

// Long-polls the server's screen state. Returns the latest state and a setter
// for states that arrive with a key press response.
function useScreen(windowId: string): [ScreenState | null, (s: ScreenState) => void] {
  const [screen, setScreen] = useState<ScreenState | null>(null);
  const epochRef = useRef(0);
  const closedRef = useRef(false);
  const accept = useCallback((s: ScreenState) => {
    if (!s) return;
    // A window going away or coming back always counts, whatever its epoch.
    if (s.epoch >= epochRef.current || Boolean(s.closed) !== closedRef.current) {
      epochRef.current = s.epoch;
      closedRef.current = Boolean(s.closed);
      setScreen(s);
    }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    let stopped = false;
    epochRef.current = 0;
    (async () => {
      try {
        accept(await getJson<ScreenState>(`/screen?windowId=${encodeURIComponent(windowId)}`, controller.signal));
      } catch {
        // Retried by the loop.
      }
      let failures = 0;
      while (!stopped) {
        try {
          const s = await getJson<ScreenState>(`/wait?windowId=${encodeURIComponent(windowId)}&epoch=${epochRef.current}`, controller.signal);
          failures = 0;
          if (s.unsupported) {
            accept(s);
            return;
          }
          accept(s);
          // A closed window has nothing to wait for; check again slowly.
          if (s.closed) await new Promise((r) => setTimeout(r, 3000));
        } catch {
          if (stopped) return;
          failures++;
          await new Promise((r) => setTimeout(r, Math.min(10_000, 500 * 2 ** failures)));
        }
      }
    })();
    return () => {
      stopped = true;
      controller.abort();
    };
  }, [windowId, accept]);
  return [screen, accept];
}

function useCommands(windowId: string): SlashCommand[] {
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  useEffect(() => {
    getJson<{ commands: SlashCommand[] }>(`/commands?windowId=${encodeURIComponent(windowId)}`)
      .then((d) => setCommands(d.commands))
      .catch(() => {});
  }, [windowId]);
  return commands;
}

export function ChatTab({
  filePath,
  active,
  setTitle,
  toolbarTarget,
}: {
  filePath: string;
  active: boolean;
  setTitle?: (title: string) => void;
  // The tab bar's action area, where viewers put their own buttons.
  toolbarTarget?: HTMLDivElement | null;
}) {
  const windowId = windowIdFromPath(filePath);
  const settings = useSettings();
  const info = useSession(windowId);
  const [screen, acceptScreen] = useScreen(windowId);
  const commands = useCommands(windowId);
  const sessionId = info?.session?.file ? info.session.sessionId : null;
  const cwd = info?.session?.cwd ?? info?.window?.cwd ?? "";

  const modelRef = useRef<ChatModel>(createChatModel());
  const tallyRef = useRef<UsageTally>(createTally());
  const cursorRef = useRef<string | null>(null);
  const [version, setVersion] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const userScrolled = useRef(false);
  const activeRef = useRef(active);
  activeRef.current = active;
  const pollRef = useRef<(() => Promise<void>) | null>(null);

  // Transcript: reset on a session change, then tail it.
  useEffect(() => {
    modelRef.current = createChatModel();
    tallyRef.current = createTally();
    cursorRef.current = null;
    stickToBottom.current = true;
    userScrolled.current = false;
    setLoaded(false);
    setVersion((v) => v + 1);
    if (!sessionId) return;
    let cancelled = false;
    let inFlight = false;
    const poll = async () => {
      if (cancelled || inFlight) return;
      inFlight = true;
      try {
        const qs = new URLSearchParams({ sessionId, cwd });
        if (cursorRef.current) qs.set("cursor", cursorRef.current);
        const data = await getJson<{ messages: TranscriptMessage[]; cursor: string }>(`/transcript?${qs}`);
        if (cancelled) return;
        cursorRef.current = data.cursor;
        if (data.messages.length > 0) {
          applyMessages(modelRef.current, data.messages);
          addToTally(tallyRef.current, data.messages as Parameters<typeof addToTally>[1]);
          setVersion((v) => v + 1);
        }
        setLoaded(true);
      } catch {
        // Retried next tick.
      } finally {
        inFlight = false;
      }
    };
    pollRef.current = poll;
    void poll();
    const t = window.setInterval(() => {
      if (activeRef.current) void poll();
    }, settings.pollInterval);
    return () => {
      cancelled = true;
      pollRef.current = null;
      window.clearInterval(t);
    };
  }, [sessionId, cwd, settings.pollInterval]);

  // A screen change usually means new transcript lines: read now rather than
  // on the next tick. The in-flight guard keeps the two from overlapping.
  const epoch = screen?.epoch ?? 0;
  useEffect(() => {
    if (activeRef.current) void pollRef.current?.();
  }, [epoch, active]);

  const running = Boolean(info?.running) && !screen?.closed;
  const prompt = running ? screen?.prompt ?? null : null;

  const baseTitle = info?.window ? `${info.window.sessionName} · Claude` : "Claude";
  useEffect(() => {
    setTitle?.(prompt ? `● ${baseTitle}` : baseTitle);
  }, [setTitle, baseTitle, Boolean(prompt)]);

  const post = useCallback(
    async (path: string, body: Record<string, unknown> = {}) => {
      const { data } = await postJson<{ state?: ScreenState; error?: string }>(path, { windowId, ...body });
      if (data?.state) acceptScreen(data.state);
      return data;
    },
    [windowId, acceptScreen],
  );

  const send = async (text: string, images: PendingImage[]): Promise<boolean> => {
    setSendError(null);
    try {
      const paths = await Promise.all(images.map((i) => uploadFile(i.file)));
      const { status, data } = await postJson<{ state?: ScreenState; error?: string }>("/send", { windowId, text, paths, clearInput: true });
      if (data?.state) acceptScreen(data.state);
      if (status >= 400) {
        setSendError(data?.error ?? "The message could not be sent.");
        return false;
      }
      stickToBottom.current = true;
      return true;
    } catch (err) {
      setSendError(`The message could not be sent: ${(err as Error).message}`);
      return false;
    }
  };

  const searchFiles = useCallback(
    async (q: string) => (await getJson<{ files: string[] }>(`/files?windowId=${encodeURIComponent(windowId)}&q=${encodeURIComponent(q)}`)).files,
    [windowId],
  );

  const tally = useMemo(() => tallyRef.current, [version]);
  const model = modelRef.current;
  const empty = model.items.length === 0;

  // The lightbox steps through every image in the conversation, collected
  // when it opens so it starts on the one that was clicked.
  const [gallery, setGallery] = useState<{ images: string[]; index: number } | null>(null);
  const lightbox = useMemo(
    () => ({
      open(src: string) {
        const images = collectImages(modelRef.current);
        const index = images.indexOf(src);
        setGallery(index === -1 ? { images: [src], index: 0 } : { images, index });
      },
    }),
    [],
  );

  // Files dropped anywhere on the tab go to the composer. Counting enter and
  // leave events keeps the overlay from flickering over child elements.
  const composerRef = useRef<ComposerHandle>(null);
  const [dragDepth, setDragDepth] = useState(0);
  const hasFiles = (e: React.DragEvent) => [...e.dataTransfer.types].includes("Files");

  const openTerminal =
    info?.window && host.app?.openSessionWindow
      ? () => host.app?.openSessionWindow?.(info.window!.sessionName, { windowIndex: info.window!.windowIndex })
      : null;

  return (
    <LightboxContext.Provider value={lightbox}>
    <div
      className="claude-viewer cv-root"
      style={{ "--cv-font-size": `${settings.fontSize}px` } as CSSProperties}
      onDragEnter={(e) => {
        if (!hasFiles(e) || !running) return;
        e.preventDefault();
        setDragDepth((d) => d + 1);
      }}
      onDragOver={(e) => {
        if (!hasFiles(e) || !running) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={(e) => {
        if (!hasFiles(e)) return;
        setDragDepth((d) => Math.max(0, d - 1));
      }}
      onDrop={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        setDragDepth(0);
        if (running && e.dataTransfer.files.length > 0) composerRef.current?.addFiles(e.dataTransfer.files);
      }}
    >
      {dragDepth > 0 && (
        <div className="cv-drop-overlay" aria-hidden="true">
          <div className="cv-drop-overlay-box">Drop files to attach them to your message</div>
        </div>
      )}
      <Toolbar
        screen={screen}
        tally={tally}
        running={running}
        showMeters={settings.showMeters}
        showContext={settings.showContext}
        onCycleMode={() => void post("/cycle-mode")}
      />
      {active &&
        toolbarTarget &&
        openTerminal &&
        createPortal(
          <button className="icon-button" title="Open this window's terminal" aria-label="Open terminal" onClick={openTerminal}>
            <span className="codicon codicon-terminal" aria-hidden="true" />
          </button>,
          toolbarTarget,
        )}
      <div
        className="chat-scroll"
        ref={scrollRef}
        onWheel={() => (userScrolled.current = true)}
        onTouchMove={() => (userScrolled.current = true)}
        onKeyDown={() => (userScrolled.current = true)}
        onScroll={(e) => {
          if (!userScrolled.current) return;
          const el = e.currentTarget;
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {empty && (
          <div className="cv-empty">
            {!info
              ? "Loading"
              : !info.session
                ? "No conversation in this window yet. It appears here as soon as Claude writes its first message."
                : !info.session.file
                  ? "Claude has started. The conversation appears here once its first message is written."
                  : loaded
                    ? "This conversation has no messages yet."
                    : "Loading the conversation"}
          </div>
        )}
        <MessageList model={model} version={version} scrollRef={scrollRef} stickToBottom={stickToBottom} />
      </div>
      {prompt && <PromptCard windowId={windowId} prompt={prompt} onState={acceptScreen} enterSends={settings.enterSends} />}
      {sendError && (
        <div className="cv-banner cv-banner-error" role="alert">
          {sendError}
        </div>
      )}
      <Composer
        ref={composerRef}
        enterSends={settings.enterSends}
        working={running && screen?.activity?.state === "working" && !prompt}
        onStop={() => void post("/stop")}
        terminalInput={running && !prompt ? screen?.input?.text ?? "" : ""}
        commands={commands}
        searchFiles={searchFiles}
        onSend={send}
        disabled={!running}
        disabledReason={info && !info.running ? "This window isn't running Claude any more." : "Waiting for the terminal"}
      />
      {running && screen && !screen.unsupported && <ScreenStrip windowId={windowId} screen={screen} onState={acceptScreen} />}
      {screen?.unsupported && (
        <div className="cv-banner">This Perch can't read terminal screens, so prompts and the mode aren't shown. Update Perch to answer prompts here.</div>
      )}
      {gallery && (
        <Lightbox
          images={gallery.images}
          index={gallery.index}
          onIndex={(index) => setGallery((g) => (g ? { ...g, index } : g))}
          onClose={() => setGallery(null)}
        />
      )}
    </div>
    </LightboxContext.Provider>
  );
}
