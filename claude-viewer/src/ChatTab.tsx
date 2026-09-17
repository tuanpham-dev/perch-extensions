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
import { getJson, host, postJson, setting, uploadFile, type ShowMenu } from "./bridge";
import { applyMessages, collectImages, createChatModel, type ChatModel, type TranscriptMessage } from "./chatModel";
import { createFileLinks, FileLinksContext } from "./FileLinks";
import { Composer, type ComposerHandle, type PendingImage, type SlashCommand } from "./Composer";
import { Lightbox, LightboxContext } from "./Lightbox";
import { MessageList } from "./MessageList";
import { PromptCard, type PromptCardHandle } from "./PromptCard";
import { ScreenStrip, ScreenStripHeading, ScreenStripToggle, useScreenStrip } from "./ScreenStrip";
import { ActivityStatus, MODE_HINT, UsageStats } from "./Status";
import { useOverlayInset } from "./useOverlayInset";
import type { ScreenState, SessionInfo } from "./types";
import { addToTally, createTally, currentModelLabel, type UsageTally } from "./usage";

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
  showMenu,
}: {
  filePath: string;
  active: boolean;
  setTitle?: (title: string) => void;
  // The tab bar's action area, where viewers put their own buttons.
  toolbarTarget?: HTMLDivElement | null;
  showMenu?: ShowMenu;
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

  const showMenuRef = useRef(showMenu);
  showMenuRef.current = showMenu;
  const fileLinks = useMemo(() => createFileLinks(windowId, cwd, () => showMenuRef.current), [windowId, cwd]);

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
  // The height of an app overlay band (one-hand's gesture strip) over the
  // tab's bottom edge. The terminal screen heading grows to it so the band
  // covers the heading, not the composer; with no heading the tab pads itself.
  const rootRef = useRef<HTMLDivElement>(null);
  const strip = useScreenStrip(screen);
  const showStrip = running && screen !== null && !screen.unsupported;
  const mode = running ? screen?.mode ?? null : null;
  const modelLabel = currentModelLabel(tally);
  const overlayInset = useOverlayInset(rootRef);

  // Keys work as in the terminal. While a prompt is up they go to its card
  // (and the composer is locked, as the terminal's input is); otherwise Esc
  // stops a working Claude and Shift+Tab cycles the mode. Keys a focused
  // control already used (the composer's autocomplete) are left alone.
  const promptCardRef = useRef<PromptCardHandle>(null);
  const working = running && screen?.activity?.state === "working" && !prompt;
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.defaultPrevented || e.nativeEvent.isComposing || !running) return;
    // Portalled children (the lightbox, the tab bar button) bubble here too.
    if (!rootRef.current?.contains(e.target as Node)) return;
    if (prompt) {
      if (promptCardRef.current?.handleKey(e)) e.preventDefault();
      return;
    }
    const plain = !e.ctrlKey && !e.metaKey && !e.altKey;
    if (plain && e.key === "Tab" && e.shiftKey && mode) {
      e.preventDefault();
      void post("/cycle-mode");
    } else if (plain && e.key === "Escape" && !e.shiftKey && working) {
      e.preventDefault();
      void post("/stop");
    }
  };

  // A prompt takes the keyboard: focus moves from the composer (or nowhere)
  // to the tab itself, where onKeyDown hears it, and back to the composer
  // once the prompt is answered. Focus elsewhere in the app is left alone.
  const hasPrompt = Boolean(prompt);
  // Whether focus was last in the composer. Kept from focus events rather than
  // read when the prompt arrives: locking the composer has already moved
  // focus to <body> by then.
  const composerHadFocus = useRef(false);
  const onFocus = (e: React.FocusEvent) => {
    composerHadFocus.current = (e.target as HTMLElement).matches(".cv-input-box textarea");
  };
  useEffect(() => {
    const root = rootRef.current;
    if (!root || !active) return;
    const focused = document.activeElement;
    const composerInput = root.querySelector<HTMLTextAreaElement>(".cv-input-box textarea");
    if (hasPrompt) {
      if (focused && focused !== document.body && !root.contains(focused)) return;
      if (focused && root.querySelector(".cv-prompt-text")?.contains(focused)) return;
      const hadFocus = composerHadFocus.current;
      root.focus({ preventScroll: true });
      composerHadFocus.current = hadFocus;
    } else if (composerHadFocus.current) {
      composerHadFocus.current = false;
      if (!focused || focused === document.body || focused === root) composerInput?.focus({ preventScroll: true });
    }
  }, [hasPrompt, active]);

  const hasFiles = (e: React.DragEvent) => [...e.dataTransfer.types].includes("Files");

  const openTerminal =
    info?.window && host.app?.openSessionWindow
      ? () => host.app?.openSessionWindow?.(info.window!.sessionName, { windowIndex: info.window!.windowIndex })
      : null;

  return (
    <LightboxContext.Provider value={lightbox}>
    <FileLinksContext.Provider value={fileLinks}>
    <div
      ref={rootRef}
      className="claude-viewer cv-root"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onFocus={onFocus}
      style={{ "--cv-font-size": `${settings.fontSize}px`, paddingBottom: (!showStrip && overlayInset) || undefined } as CSSProperties}
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
      {prompt && <PromptCard ref={promptCardRef} windowId={windowId} prompt={prompt} onState={acceptScreen} enterSends={settings.enterSends} />}
      {sendError && (
        <div className="cv-banner cv-banner-error" role="alert">
          {sendError}
        </div>
      )}
      <Composer
        ref={composerRef}
        enterSends={settings.enterSends}
        working={working}
        onStop={() => void post("/stop")}
        terminalInput={running && !prompt ? screen?.input?.text ?? "" : ""}
        commands={commands}
        searchFiles={searchFiles}
        onSend={send}
        disabled={!running || hasPrompt}
        disabledReason={
          hasPrompt
            ? "Answer the prompt above first. Its keys work here as in the terminal."
            : info && !info.running
              ? "This window isn't running Claude any more."
              : "Waiting for the terminal"
        }
        footerStart={
          mode && (
            <button className={`cv-foot-btn cv-foot-mode cv-foot-mode-${mode.id}`} onClick={() => void post("/cycle-mode")} title={`${MODE_HINT[mode.id] ?? mode.label}. Click to cycle (Shift+Tab).`}>
              {mode.label.charAt(0).toUpperCase() + mode.label.slice(1)}
            </button>
          )
        }
        footerEnd={
          <>
            <UsageStats tally={tally} showContext={settings.showContext} showMeters={settings.showMeters} />
            {modelLabel && (
              <span className="cv-foot-model" title={tally.switchedTo ? `Switched with /model: ${tally.switchedTo}` : (tally.model ?? undefined)}>
                {modelLabel}
              </span>
            )}
            {showStrip && <ScreenStripToggle strip={strip} />}
          </>
        }
      />
      {showStrip && <ScreenStrip windowId={windowId} screen={screen} strip={strip} onState={acceptScreen} />}
      {showStrip && <ScreenStripHeading strip={strip} minHeight={overlayInset} status={<ActivityStatus screen={screen} running={running} />} />}
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
    </FileLinksContext.Provider>
    </LightboxContext.Provider>
  );
}
