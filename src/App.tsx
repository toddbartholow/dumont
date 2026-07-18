import { useState, useEffect, useCallback, useRef, useMemo, lazy, Suspense } from "react";
import { invoke } from "@tauri-apps/api/core";
import { recentPathFromMenuId } from "./utils/menuActions";
import { open, save, ask } from "@tauri-apps/plugin-dialog";
import { listen, TauriEvent } from "@tauri-apps/api/event";
import { Window } from "@tauri-apps/api/window";

import { revealItemInDir } from "@tauri-apps/plugin-opener";

import { ThemeProvider, useTheme } from "./context/ThemeContext";
import { TitleBar } from "./components/TitleBar";
import { WelcomeScreen } from "./components/WelcomeScreen";
import { CodeEditor } from "./components/CodeEditor";
import { StatusBar } from "./components/StatusBar";
import { ModeToggle, type ViewMode } from "./components/ModeToggle";
import { ToastStack } from "./components/Toast";
import { SplitDivider } from "./components/SplitDivider";
import { usePaletteCommands } from "./hooks/usePaletteCommands";
import { useModals } from "./hooks/useModals";
import { useToast } from "./hooks/useToast";
import { useGlobalShortcuts } from "./hooks/useGlobalShortcuts";
import { useDebouncedValue } from "./hooks/useDebouncedValue";
import { usePersistedState } from "./hooks/usePersistedState";
import { useSetting, useSettings } from "./settings/SettingsProvider";
import { useFullscreen } from "./hooks/useFullscreen";
import { useScrollSync } from "./hooks/useScrollSync";
import { useAutosave } from "./hooks/useAutosave";
import { useExternalChangeWatcher } from "./hooks/useExternalChangeWatcher";

// === Lazy-loaded screens / dialogs ===
//
// Cold-start budget: the welcome screen is what the user sees first, and it
// doesn't need react-markdown, the export module, the settings modal, the
// command palette, or any sidebar panel to render. Importing them eagerly meant
// 300 kB+ of JS had to parse before the welcome screen could paint. Each of
// these is now its own chunk, fetched only when its surface is mounted.
//
// React.lazy expects a default export; our components are named exports, so
// we adapt with the `.then(m => ({ default: m.X }))` shim.
const MarkdownPreview = lazy(() =>
    import("./components/MarkdownPreview").then((m) => ({ default: m.MarkdownPreview }))
);
const FileExplorer = lazy(() =>
    import("./components/FileExplorer").then((m) => ({ default: m.FileExplorer }))
);
const TableOfContents = lazy(() =>
    import("./components/TableOfContents").then((m) => ({ default: m.TableOfContents }))
);
const BacklinksPanel = lazy(() =>
    import("./components/BacklinksPanel").then((m) => ({ default: m.BacklinksPanel }))
);
const SettingsModal = lazy(() =>
    import("./components/SettingsModal").then((m) => ({ default: m.SettingsModal }))
);
const StatsDialog = lazy(() =>
    import("./components/StatsDialog").then((m) => ({ default: m.StatsDialog }))
);
const CommandPalette = lazy(() =>
    import("./components/CommandPalette").then((m) => ({ default: m.CommandPalette }))
);
const GlobalSearch = lazy(() =>
    import("./components/GlobalSearch").then((m) => ({ default: m.GlobalSearch }))
);
const ShortcutCheatsheet = lazy(() =>
    import("./components/ShortcutCheatsheet").then((m) => ({ default: m.ShortcutCheatsheet }))
);
const UnsavedChangesDialog = lazy(() =>
    import("./components/UnsavedChangesDialog").then((m) => ({ default: m.UnsavedChangesDialog }))
);
const AIPanel = lazy(() =>
    import("./components/AIPanel").then((m) => ({ default: m.AIPanel }))
);
const HistoryPanel = lazy(() =>
    import("./components/HistoryPanel").then((m) => ({ default: m.HistoryPanel }))
);
// Update popup — mounts on every launch, renders nothing unless a newer
// signed release is found on GitHub (and the user hasn't skipped it).
const UpdateDialog = lazy(() =>
    import("./components/UpdateDialog").then((m) => ({ default: m.UpdateDialog }))
);
import { getRecentFiles } from "./utils/persistence";
import {
  addRecentFile,
  clearRecentFiles,
  aiKeyPresent,
  initAIKey,
  getLastFile,
  getSavedViewMode,
  getSession,
  setSession,
  getSplitRatio,
  setLastFile,
  setSavedViewMode,
  setSplitRatio,
} from "./utils/persistence";
import { resolveRelativePath } from "./utils/resolveRelativePath";
import { errMessage } from "./utils/errors";
import { revealMainWindow } from "./utils/appWindow";
// Every write to a document goes through saveDocument, which is also what records
// a version-history snapshot. See src/utils/saveDocument.ts for the one exception.
import { saveDocument } from "./utils/saveDocument";
import { saveThenClose } from "./utils/saveCloseTab";
import { setHistoryConfig } from "./utils/history";
import { TabBar, type TabBarItem } from "./components/TabBar";
import { TabContextMenu } from "./components/TabContextMenu";
import {
  findTabByPath,
  nextActiveAfterClose,
  nextUntitledName,
  findReusableUntitledTab,
  computeTabLabels,
  moveTab,
  closeTabDecision,
  resolveTab,
  backgroundTabsToAutosave,
  markTabSaved,
  externalChangeDecision,
  collectDirtyTabs as computeDirtyTabs,
  type TabState,
} from "./utils/tabsModel";
import { countSourceWords, countWords } from "./utils/documentStats";
import { PreviewFindBar } from "./components/PreviewFindBar";
// The interactive feature guide, shipped as raw markdown so it opens as a real,
// editable document (offered at the end of the welcome tour / from the palette).
import tutorialMarkdown from "./assets/tutorial.md?raw";

interface FileData {
  path: string;
  name: string;
  content: string;
  size: number;
  line_count: number;
  /** Last-modified time (ms since epoch) — used to detect external edits. */
  modified: number;
}

/** The left sidebar holds exactly one panel at a time, or none. */
type OpenLeftPanel = "explorer" | "toc" | "backlinks" | "history";
type LeftPanel = OpenLeftPanel | null;

// Platform-aware AI shortcut hint. Windows uses Alt+J because WebView2 reserves
// Ctrl+J for its Downloads UI before the page sees it; macOS shows ⌘J. (AI-02.)

// Width of the right-side AI panel; the editor/preview area reserves this much
// padding-right when it's open so content reflows beside it (not under it).
const AI_PANEL_WIDTH = 400;

// Width of whichever left panel is open, and the same reservation on the other
// side. Keep it in step with the `w-72` on the asides in FileExplorer,
// TableOfContents, BacklinksPanel and HistoryPanel; all four are 18rem.
//
// The left side went without this for a long time and looked fine, because reader
// mode centers its column inside margins wide enough to hide the overlap. It stops
// looking fine the moment anything is flush left: restoring a snapshot drops the
// editor into split mode, and the merge view's diff gutter and the opening words of
// every changed line end up underneath the panel.
const LEFT_PANEL_WIDTH = 288;

// What the review banner says when Agent mode is the one proposing the change. A
// version-history restore drives the same merge view and supplies its own label.
const AI_REVIEW_LABEL = "AI suggested changes";

// The launch-file resolution must run exactly once per webview load. React
// StrictMode double-invokes effects in dev: without this guard the second run
// would find the CLI file already consumed (the backend take()s it) and start
// a racing last-session restore that can overwrite the just-opened file.
// Module-level on purpose — StrictMode remounts share module state.
let bootResolved = false;

// The palette's theme commands come from the same list Settings renders, which is
// the registry (src/themes). This was a fifth hand-kept copy of the theme names.

function AppContent() {
  const { theme, setTheme } = useTheme();
  // File state
  const [filePath, setFilePath] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [content, setContent] = useState<string>("");
  const [originalContent, setOriginalContent] = useState<string>("");
  const [fileSize, setFileSize] = useState<number>(0);

  // UI state
  const [mode, setMode] = usePersistedState<ViewMode>(getSavedViewMode, setSavedViewMode);
  // Every dialog, as one thing. See useModals: it also hands out a STABLE onClose per
  // dialog, which is what stops the focus traps being torn down and re-attached on every
  // render of this component.
  const modals = useModals();
  // Depend on these, not on `modals`. The object itself is rebuilt whenever a dialog opens
  // or closes (it carries `open`), so a callback listing `modals` would churn on every
  // dialog toggle. `showModal`/`hideModal` are []-stable, and `modals.close` is memoised.
  const { settingsJson, openSettings, show: showModal, hide: hideModal, close: closeModal } = modals;
  const showCheatsheet = modals.open.cheatsheet;
  const showPalette = modals.open.palette;
  const showSettings = modals.open.settings;
  const showStats = modals.open.stats;
  const showSearch = modals.open.search;
  const showUnsavedBeforeClose = modals.open.unsavedBeforeClose;

  // Settings' close does one extra thing, so it cannot be the bare closer. Memoised for
  // the same reason the closers are: SettingsModal keys its focus trap on onClose, and
  // changing the theme from inside it re-renders App, so a fresh arrow here would tear the
  // trap down and throw the user's keyboard position away mid-dialog.
  const handleCloseSettings = useCallback(() => {
    closeModal.settings();
    // hasAiKey is not re-read here: the key changes only through the Settings
    // field, which reports its new presence via onAiKeyPresenceChange once the
    // write lands. Re-reading on close would race that write (Escape commits on
    // unmount, after this runs) and could show a just-saved key as absent.
  }, [closeModal]);
  // Open-file tabs. The live state above is always the ACTIVE tab; `tabs` holds
  // the snapshots of every open file (incl. the active one). TABS-01.
  const [tabs, setTabs] = useState<TabState[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  // Bumped on every genuine document swap (tab switch, file open, new file) so
  // the editor can reset its undo history and Ctrl+Z can't reach into the
  // previously-shown document. See CodeEditor's docSwapId effect. TABS-03.
  const [docSwapId, setDocSwapId] = useState(0);
  const bumpDocSwap = useCallback(() => setDocSwapId((n) => n + 1), []);
  const [splitRatio, setSplitRatioState] = usePersistedState<number>(getSplitRatio, setSplitRatio);
  // The endpoint and model come from settings.json. The API KEY stays in the OS
  // keychain and never enters the webview (SECURITY-01): Rust reads it itself when
  // it makes a request, so the config the AI surfaces receive carries no secret.
  // All the frontend keeps is whether a key EXISTS, to prompt the user when one
  // does not.
  const { values: settingValues } = useSettings();
  const [hasAiKey, setHasAiKey] = useState(false);
  const aiConfig = useMemo(() => ({
    endpoint: (settingValues["ai.endpoint"] as string) ?? "",
    model: (settingValues["ai.model"] as string) ?? "",
  }), [settingValues]);
  // Preferences, from settings.json. Every consumer reads the same context, so
  // a change made in the Settings window, from the command palette, or by
  // hand-editing the file arrives here the same way.
  const [aiEnabled] = useSetting<boolean>("ai.enabled");
  // The Alt+J listener below mounts once, so it reads the flag through a ref
  // rather than capturing a stale value.
  const aiEnabledRef = useRef(aiEnabled);
  aiEnabledRef.current = aiEnabled;

  // The same trick, for the same reason. loadFileDirect is deliberately a stable
  // callback (its identity is load-bearing: see the DRAG_DROP listener below), so it
  // captured settingValues from the FIRST render and kept them forever. Toggling
  // "open files in reader mode" therefore did nothing at all until the app was
  // restarted, while the comment at the read site promised it applied live.
  const settingsRef = useRef(settingValues);
  settingsRef.current = settingValues;
  useEffect(() => { if (!aiEnabled) setShowAIPanel(false); }, [aiEnabled]);
  const [typewriterModeEnabled, setTypewriterModeEnabled] = useSetting<boolean>("editor.typewriterMode");
  const [toolbarVisible, setToolbarVisible] = useSetting<boolean>("editor.toolbar");
  const [wordWrapEnabled] = useSetting<boolean>("editor.wordWrap");
  const [readerWidth] = useSetting<string>("appearance.readerWidth");
  const [spellCheckEnabled] = useSetting<boolean>("editor.spellCheck");
  const [minimapEnabled, setMinimapEnabled] = useSetting<boolean>("editor.minimap");
  const [autoSaveEnabled] = useSetting<boolean>("files.autoSave");
  const [historyEnabled, setHistoryEnabled] = useSetting<boolean>("files.history");
  const [historyLimit] = useSetting<number>("files.historyLimit");
  const [historyInterval] = useSetting<number>("files.historyInterval");

  // Push the history settings to the save path. saveDocument() is called from a
  // hook and from five callbacks, none of which should have to carry three
  // preferences to reach it, so the module holds them and this keeps them current.
  // Runs before any save can: an effect on mount beats the user's first keystroke.
  useEffect(() => {
    setHistoryConfig({
      enabled: historyEnabled,
      limit: historyLimit,
      intervalSecs: historyInterval,
    });
  }, [historyEnabled, historyLimit, historyInterval]);

  const [cursorPosition, setCursorPosition] = useState({ line: 1, col: 1 });
  // True while the launch-time file resolution (OS-opened CLI file, then
  // last-session restore) is still in flight. Shows a neutral splash instead
  // of flashing the WelcomeScreen for a frame. Starts true unconditionally:
  // whether a CLI file exists is only known after asking the backend, and the
  // no-file case resolves in a couple of milliseconds anyway.
  const [booting, setBooting] = useState<boolean>(true);
  // Editor selection range. Collapsed (start === end) means no selection;
  // when start < end we surface a "N words selected" chip in the status bar.
  const [selectionRange, setSelectionRange] = useState<{ start: number; end: number }>({ start: 0, end: 0 });
  const [isLoading, setIsLoading] = useState(false);

  // Unsaved-changes dialog for window close (Alt+F4, taskbar close, the title
  // bar X). The Tauri close-requested handler below intercepts ALL of them.
  // Pending dirty-tab close, awaiting the Save/Discard/Cancel dialog. TABS-05.
  const [closeTabPrompt, setCloseTabPrompt] = useState<{ id: string; fileName: string } | null>(null);
  // Find bar over the reader-mode preview (Ctrl+F when mode === "preview").
  const [previewFindOpen, setPreviewFindOpen] = useState(false);
  // Autosave: save a moment after the user stops typing (Settings → Editor).

  // Sidebar panel state.
  //
  // The LEFT panels share one strip of screen, so at most one is ever open. They
  // used to be independent booleans, with each toggle responsible for clearing
  // every other one by hand. That is fine for two and a liability at four: it is
  // twelve calls that all have to stay in step, and the one you forget does not
  // fail loudly, it just quietly draws two panels on top of each other. One slot
  // makes the exclusion structural, so a fifth panel cannot reintroduce the bug.
  const [leftPanel, setLeftPanel] = useState<LeftPanel>(null);
  const showFileExplorer = leftPanel === "explorer";
  const showTOC = leftPanel === "toc";
  const showBacklinks = leftPanel === "backlinks";
  const showHistory = leftPanel === "history";

  // The AI panel is on the RIGHT and coexists with any of the above.
  const [showAIPanel, setShowAIPanel] = useState(false);
  // Bumped when some OTHER document lands on disk, which is the only thing that can
  // change the open document's backlinks. Backlinks are links FROM other files TO
  // this one, so saving the file you are looking at cannot alter them, and bumping
  // on its autosave would make the panel re-walk the entire folder every 1.5 s while
  // you type, to render the identical list straight back. Save As needs no bump
  // either: it changes the path, which re-keys the panel's scan on its own.
  const [savedTick, setSavedTick] = useState(0);
  const bumpSaved = useCallback(() => setSavedTick((n) => n + 1), []);
  // Proposed document from Agent mode, shown as an inline diff for accept/reject.
  const [proposedDoc, setProposedDoc] = useState<string | null>(null);
  // What the review banner calls the proposal. The merge view is shared between
  // Agent mode and a version-history restore, and they are not the same claim: a
  // restore is the user's own older draft, and announcing it as "AI suggested
  // changes" would credit an AI with the writing and misdescribe what accepting a
  // chunk actually does.
  const [reviewLabel, setReviewLabel] = useState(AI_REVIEW_LABEL);

  // Preview scroll position
  const [previewLine, setPreviewLine] = useState(1);

  // Toast notifications (state + show/hide helpers live in a hook).
  const { toasts, showToast, dismissToast } = useToast();

  // Export HTML content ref - captures from visible preview
  const previewRef = useRef<HTMLDivElement>(null);
  const splitContainerRef = useRef<HTMLDivElement>(null);

  // Bidirectional scroll sync between editor and preview (split mode only).
  const { registerCodeScroller, registerPreviewScroller, onCodeScrollFraction, onPreviewScrollFraction } =
    useScrollSync(mode);

  // Reader-mode find only makes sense over the preview; close it (and drop
  // its highlights) when the user switches to code or split.
  useEffect(() => {
    if (mode !== "preview") setPreviewFindOpen(false);
  }, [mode]);

  // Reveal the window once the tree has mounted and painted the themed
  // background. The window is created hidden (visible:false) so the webview's
  // white pre-load surface never reaches the screen (#98). A failsafe timeout in
  // main.tsx and a fallback in the ErrorBoundary guarantee it still shows even
  // if a crash stops this effect from running.
  useEffect(() => {
    revealMainWindow();
  }, []);

  // Derived state
  const isDirty = content !== originalContent;
  // "Has a buffer" — true once a file is opened OR a blank Untitled buffer is started
  const hasFile = filePath !== null || fileName !== null;

  // Keep the native window title (taskbar / Alt-Tab) in step with the active
  // file and its dirty state, so two Dumont windows are distinguishable and
  // a leading bullet flags unsaved work. Keyed on the dirty BOOLEAN (not raw
  // content) so it doesn't fire an IPC call on every keystroke. TITLE-01.
  useEffect(() => {
    const title = fileName ? `${isDirty ? "• " : ""}${fileName} — Dumont` : "Dumont";
    Window.getCurrent().setTitle(title).catch(() => {/* browser dev mode */});
  }, [fileName, isDirty]);

  // PERF: Typing in the editor calls setContent on every keystroke, which would
  // synchronously re-render every consumer of `content` — including the markdown
  // preview, which runs remark-gfm + rehype-highlight + react-markdown over the
  // entire document. On a few-hundred-line file that's 50-200ms of work and the
  // textarea feels laggy because React can't commit the new value until the tree
  // is reconciled.
  //
  // We debounce the value passed to those heavy consumers by ~80ms — short
  // enough to feel real-time during a normal pause between keystrokes, long
  // enough that fast typing skips many intermediate re-renders. The editor
  // itself still uses live `content` so the glyph you typed appears immediately.
  // (We previously used useDeferredValue here, but under React StrictMode + the
  // bursty state churn at file-open it could starve and leave the preview
  // showing the empty initial value.)
  // Scale the debounce with document size: tiny docs feel instant at 80ms, but a
  // multi-thousand-line doc benefits from coalescing more keystrokes before the
  // (still heavy) full re-parse fires. Combined with the preview's startTransition
  // render, this keeps typing responsive on large files. PREVIEW-01.
  const previewDebounceMs = content.length > 40_000 ? 250 : content.length > 12_000 ? 160 : 80;
  const deferredContent = useDebouncedValue(content, previewDebounceMs);

  // Word/char counts feed the status bar — fine to lag a frame behind on huge
  // docs, so they read deferred too. countSourceWords is the SAME pipeline the
  // stats dialog uses (strips frontmatter/code, ignores markdown syntax), so
  // the status bar and the dialog always agree. STATS-01.
  const wordCount = useMemo(() => countSourceWords(deferredContent), [deferredContent]);
  const charCount = deferredContent.length;
  // Selection word count, when the user has a non-empty range highlighted.
  // Reads LIVE `content` (not deferredContent) since the selection range and
  // the underlying text must agree — sliding by 80ms would briefly count words
  // from a stale buffer right after a fast edit. The slice is cheap regardless.
  // Uses countWords (no frontmatter/code stripping): a selection inside a code
  // block should still report what's selected.
  const selectionLength = selectionRange.end - selectionRange.start;
  const selectionWordCount = useMemo(
    () => (selectionLength > 0 ? countWords(content.slice(selectionRange.start, selectionRange.end)) : 0),
    [content, selectionRange.start, selectionRange.end, selectionLength]
  );
  // Average adult reading speed for prose: ~200 wpm.
  const readingTimeMin = useMemo(() => wordCount / 200, [wordCount]);

  // Known on-disk modified time (ms). Compared against a fresh stat on window
  // focus to detect the file changing under us (sync tools, other editors).
  const knownMtimeRef = useRef<number>(0);

  // === Tabs (snapshot-swap) ===
  // The live state (filePath/content/…) IS the active tab. `tabsRef`/`liveRef`
  // mirror state synchronously so the open/switch/close helpers can read and
  // commit without waiting for a re-render. We snapshot the active tab before
  // leaving it and restore the target's snapshot into the live state — so every
  // single-file system (autosave, AI review, external-change) is untouched. TABS-01.
  const tabSeqRef = useRef(0);
  const tabsRef = useRef<TabState[]>([]);
  tabsRef.current = tabs;
  const activeTabIdRef = useRef<string | null>(null);
  activeTabIdRef.current = activeTabId;
  // Stack of recently-closed tabs (path + caret line) for Ctrl+Shift+T. Only
  // saved files are recoverable; untitled buffers aren't pushed. TABS-15.
  const closedTabsRef = useRef<{ path: string; cursorLine?: number }[]>([]);
  const liveRef = useRef({ filePath, fileName, content, originalContent, fileSize });
  liveRef.current = { filePath, fileName, content, originalContent, fileSize };
  // The line we'd return to when this file is re-activated: the caret line while
  // editing, or the top-visible line in reader mode. TABS-02.
  const currentLineRef = useRef(1);
  currentLineRef.current = mode === "preview" ? previewLine : cursorPosition.line;

  const commitTabs = useCallback((next: TabState[]) => {
    tabsRef.current = next;
    setTabs(next);
  }, []);
  const setActiveTab = useCallback((id: string | null) => {
    activeTabIdRef.current = id;
    setActiveTabId(id);
  }, []);
  const newTabId = useCallback(() => `tab-${++tabSeqRef.current}`, []);

  // Every open tab that has unsaved changes, reading the ACTIVE tab from live
  // state (its stored snapshot lags until the next switch) and the rest from
  // their snapshots. Used by the window-close guard so background tabs can't be
  // discarded silently. The dirty-collection logic itself is a pure helper so it
  // stays unit-testable; this wrapper just feeds it the current refs. TABS-04.
  const collectDirtyTabs = useCallback(
    () => computeDirtyTabs(tabsRef.current, activeTabIdRef.current, liveRef.current),
    []
  );

  // Write the live editor state back into the active tab's entry.
  const snapshotActiveTab = useCallback(() => {
    const id = activeTabIdRef.current;
    if (!id) return;
    const live = liveRef.current;
    commitTabs(tabsRef.current.map((t) => (t.id === id ? {
      ...t,
      filePath: live.filePath,
      fileName: live.fileName ?? "Untitled.md",
      content: live.content,
      originalContent: live.originalContent,
      fileSize: live.fileSize,
      knownMtime: knownMtimeRef.current,
      cursorLine: currentLineRef.current,
    } : t)));
  }, [commitTabs]);

  // Load a tab's stored snapshot into the live editor state.
  const applyTabToLive = useCallback((tab: TabState) => {
    setProposedDoc(null); // an AI review belongs to the file we're leaving
    bumpDocSwap(); // new document → editor resets undo history. TABS-03.
    setFilePath(tab.filePath);
    setFileName(tab.fileName);
    setContent(tab.content);
    setOriginalContent(tab.originalContent);
    setFileSize(tab.fileSize);
    knownMtimeRef.current = tab.knownMtime;
    if (tab.filePath) setLastFile(tab.filePath);
    // Restore where you were in this tab — jump to the remembered line, or fall
    // back to the top for a never-focused / line-1 tab. TABS-02.
    const line = tab.cursorLine ?? 1;
    requestAnimationFrame(() => {
      if (line > 1) window.dispatchEvent(new CustomEvent("dumont:goto-line", { detail: { line } }));
      else window.dispatchEvent(new CustomEvent("dumont:scroll-top"));
    });
  }, [bumpDocSwap]);

  // Switch to an already-open tab, snapshotting the current one first.
  const activateTab = useCallback((id: string) => {
    if (id === activeTabIdRef.current) return;
    snapshotActiveTab();
    const target = tabsRef.current.find((t) => t.id === id);
    if (!target) return;
    setActiveTab(id);
    applyTabToLive(target);
  }, [snapshotActiveTab, setActiveTab, applyTabToLive]);

  // Switch to the previous / next tab (Alt+Left / Alt+Right), wrapping around.
  const cycleTab = useCallback((delta: number) => {
    const list = tabsRef.current;
    if (list.length < 2) return;
    const idx = list.findIndex((t) => t.id === activeTabIdRef.current);
    if (idx === -1) return;
    const next = list[(idx + delta + list.length) % list.length];
    activateTab(next.id);
  }, [activateTab]);

  // Load file from path (with unsaved changes check)
  // Declared HERE, above loadFileDirect, because loadFileDirect calls it and therefore
  // has to list it as a dependency. It used to live 1000 lines further down, and the
  // forward reference worked only because the callback body does not run during render.
  // The moment the dependency is declared honestly, a `const` referenced above its own
  // declaration is a temporal-dead-zone ReferenceError at render, not a lint nit.
  const pushRecentsToMenu = useCallback(async () => {
    try {
      await invoke("set_recent_files", {
        files: getRecentFiles().map((f) => ({ path: f.path, name: f.name })),
      });
    } catch {
      // The command exists on every platform but only DOES anything on macOS, where
      // the menu lives (see src-tauri/src/menu.rs). Off macOS it stores the list and
      // installs nothing. A failure here costs the user an Open Recent submenu, which
      // is not worth a toast.
    }
  }, []);

  const loadFileDirect = useCallback(async (path: string) => {
    const outgoing = filePathRef.current;
    // Preserve the file we're leaving in its tab before overwriting live state.
    snapshotActiveTab();
    setIsLoading(true);
    try {
      const fileData = await invoke<FileData>("read_file", { path });
      bumpDocSwap(); // new document → editor resets undo history. TABS-03.
      setFilePath(fileData.path);
      setFileName(fileData.name);
      setContent(fileData.content);
      setOriginalContent(fileData.content);
      setFileSize(fileData.size);
      knownMtimeRef.current = fileData.modified ?? 0;
      // Track recents + last-opened for restore-on-launch
      addRecentFile(fileData.path, fileData.name);
      void pushRecentsToMenu();
      setLastFile(fileData.path);
      // Upsert the tab: reuse an existing tab for this path (e.g. a reload),
      // otherwise open a new one. Either way it becomes active. TABS-01.
      const loaded = {
        filePath: fileData.path, fileName: fileData.name,
        content: fileData.content, originalContent: fileData.content,
        fileSize: fileData.size, knownMtime: fileData.modified ?? 0,
      };
      const existing = findTabByPath(tabsRef.current, fileData.path);
      if (existing) {
        commitTabs(tabsRef.current.map((t) => (t.id === existing.id ? { ...t, ...loaded } : t)));
        setActiveTab(existing.id);
      } else {
        const id = newTabId();
        commitTabs([...tabsRef.current, { id, ...loaded }]);
        setActiveTab(id);
      }
      // Snap the new file to the top — but not on a same-path external reload,
      // which should keep the reader where they were. NAV-04.
      if (outgoing !== fileData.path) {
        requestAnimationFrame(() => window.dispatchEvent(new CustomEvent("dumont:scroll-top")));
      }
      // "Open files in reader" applies to every USER file open, read live so
      // a Settings change takes effect without a restart. Mode is global
      // across tabs, so opening a file mid-edit flips the view — that's the
      // setting's promise. Same-path reloads are excluded: the external-change
      // watcher reloads silently through here (EXT-01) and must not yank an
      // editing session back to preview. New files still force code mode
      // (handleNewFile). READ-01.
      if (outgoing !== fileData.path && settingsRef.current["files.openInReader"]) setMode("preview");
    } catch (err) {
      console.error("Failed to load file:", err);
      // Surface the actual error from Rust so "File too large" / "File not
      // found" reaches the user instead of a generic message — without this,
      // hitting the new 50 MB cap looked exactly like a permission error.
      const msg = errMessage(err);
      showToast(msg || "Failed to open file", "error");
    } finally {
      setIsLoading(false);
    }
  }, [showToast, snapshotActiveTab, commitTabs, setActiveTab, newTabId, bumpDocSwap, setMode, pushRecentsToMenu]);

  // Settings flags above persist themselves via usePersistedState; the matching
  // setters (setSavedViewMode, setSplitRatio, …) are passed into that hook.

  // Cross-component event listeners. The per-toggle events that used to live
  // here are gone: Settings and App both read settings.json through the same
  // context now, so there is nothing to notify. What remains are the events
  // that are genuinely commands, not state changes.
  useEffect(() => {
    const handlers: Array<[string, (e: Event) => void]> = [
      // Opened from the title-bar settings dropdown's "More settings…" entry.
      ["dumont:open-settings", () => openSettings()],
      // Alt+J with no selection opens the docked AI side panel. The editor's
      // ai-assist handler decides bubble (selection) vs panel (no selection).
      // Reads the persisted flag live (this effect mounts once) so the panel
      // can't be opened while AI is switched off in Settings.
      ["dumont:toggle-ai-panel", () => { if (aiEnabledRef.current) setShowAIPanel((v) => !v); }],
    ];
    handlers.forEach(([k, h]) => window.addEventListener(k, h));

    // Note: there used to be a `storage` event listener here that re-read the
    // AI config. It was dead code — the spec only fires `storage` events on
    // OTHER documents/tabs that mutate localStorage, never on the writing
    // document. The actual refresh path is the explicit `setAiConfigState(
    // getAIConfig())` call in SettingsModal's onClose, which works correctly.

    return () => {
      handlers.forEach(([k, h]) => window.removeEventListener(k, h));
    };
    // openSettings is a []-stable useCallback, so listing it honestly costs nothing:
    // the listeners are still attached exactly once.
  }, [openSettings]);

  // Prefetch the heaviest lazy chunks during browser idle so the first time
  // the user actually opens a file or a sidebar, the bundle is already in
  // cache. Without this we'd block the file-open click on a network fetch
  // for ~340 kB of react-markdown. The prefetch is fire-and-forget; if the
  // user never opens a file before closing the app, no harm done.
  useEffect(() => {
    type IdleApi = (cb: () => void, opts?: { timeout?: number }) => number;
    const ric: IdleApi = (typeof window !== "undefined" && (window as unknown as { requestIdleCallback?: IdleApi }).requestIdleCallback)
        ? (window as unknown as { requestIdleCallback: IdleApi }).requestIdleCallback
        : ((cb) => window.setTimeout(cb, 600) as unknown as number);
    const id = ric(() => {
      // Markdown rendering pipeline is the single biggest deferred chunk;
      // pull it in the moment the welcome screen has settled. The other
      // dialogs are tiny and aren't worth racing the network for.
      import("./components/MarkdownPreview").catch(() => {/* offline / cancelled */ });
    }, { timeout: 1500 });
    return () => {
      const cancel = (window as unknown as { cancelIdleCallback?: (id: number) => void }).cancelIdleCallback;
      if (cancel) cancel(id);
      else window.clearTimeout(id);
    };
  }, []);

  // Migrate any legacy plaintext key into the keychain, then record whether a key
  // is now saved so the AI surfaces can prompt for one when it is missing. The key
  // itself is never fetched into the webview (SECURITY-01).
  useEffect(() => {
    initAIKey().then(() => aiKeyPresent()).then(setHasAiKey);
  }, []);

  useEffect(() => {
    // Resolve the launch file once on app start. PULL model: ask the backend
    // for an OS-opened file (double-clicked .md → CLI arg) when WE are ready,
    // instead of the backend pushing an event after an arbitrary delay. The
    // old push design raced the webview: on slow cold starts the event fired
    // before the listener existed and was lost, so the last-session restore
    // won and the app reopened the previous file instead of the clicked one.
    if (bootResolved) return;
    bootResolved = true;
    (async () => {
      let cliFiles: string[] = [];
      try {
        // `?? []` guards the browser dev path and any backend that answers with
        // null instead of an empty list; the boot logic below assumes an array.
        cliFiles = (await invoke<string[] | null>("get_cli_files")) ?? [];
      } catch {
        // Browser dev mode / older backend without the command — restore only.
      }

      // Assemble the ordered list of paths to reopen and which one is active.
      // Prefer the full saved session (TABS-07); fall back to the single
      // lastFile for sessions saved before multi-tab restore existed.
      const session = getSession();
      const cursorByPath = new Map<string, number | undefined>();
      let paths: string[] = [];
      let activePath: string | null = null;
      if (session) {
        paths = session.tabs.map((t) => t.path);
        session.tabs.forEach((t) => cursorByPath.set(t.path, t.cursorLine));
        activePath = session.tabs[session.activeIndex]?.path ?? paths[0] ?? null;
      } else {
        const last = getLastFile();
        if (last) { paths = [last]; activePath = last; }
      }
      // CLI / double-clicked files are always opened, and several can arrive at
      // once (multiple files selected in Finder or Explorer, opened from cold).
      // Append each new one and make the first the active tab.
      if (cliFiles.length > 0) {
        for (const f of cliFiles) {
          if (!paths.includes(f)) paths.push(f);
        }
        activePath = cliFiles[0];
      }

      if (paths.length === 0) {
        setBooting(false);
        return;
      }

      // Read each file, skipping any that have gone missing / too large. The CLI
      // file's failure is always surfaced (the user explicitly asked for it).
      const loaded: TabState[] = [];
      let activeId: string | null = null;
      for (const p of paths) {
        try {
          const fd = await invoke<FileData>("read_file", { path: p });
          const id = newTabId();
          loaded.push({
            id, filePath: fd.path, fileName: fd.name,
            content: fd.content, originalContent: fd.content,
            fileSize: fd.size, knownMtime: fd.modified ?? 0,
            cursorLine: cursorByPath.get(p),
          });
          if (p === activePath) activeId = id;
        } catch (err) {
          const msg = errMessage(err);
          if (cliFiles.includes(p)) {
            showToast(`Could not open file: ${msg || p}`, "error");
          } else if (/too large/i.test(msg)) {
            showToast(`Could not restore "${p}": ${msg}`, "error");
          }
          // Otherwise a stale session entry — drop it quietly.
        }
      }

      if (loaded.length === 0) {
        setSession(null);
        setLastFile(null);
        setBooting(false);
        return;
      }
      if (!activeId) activeId = loaded[0].id;
      const activeTabData = loaded.find((t) => t.id === activeId)!;

      bumpDocSwap(); // restored document → editor starts with clean undo history
      commitTabs(loaded);
      setActiveTab(activeId);
      setFilePath(activeTabData.filePath);
      setFileName(activeTabData.fileName);
      setContent(activeTabData.content);
      setOriginalContent(activeTabData.content);
      setFileSize(activeTabData.fileSize);
      knownMtimeRef.current = activeTabData.knownMtime;
      addRecentFile(activeTabData.filePath!, activeTabData.fileName);
      setLastFile(activeTabData.filePath);
      // Restore the active tab's caret line once the editor has mounted.
      const line = activeTabData.cursorLine ?? 1;
      if (line > 1) {
        window.setTimeout(
          () => window.dispatchEvent(new CustomEvent("dumont:goto-line", { detail: { line } })),
          150
        );
      }
      // Applied once for the whole restored session, not per tab. READ-01.
      if (settingValues["files.openInReader"]) setMode("preview");
      setBooting(false);
    })();
    // Run only once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Latest content + originalContent are read via refs inside `loadFile` so
  // its identity stays stable across keystrokes. Without this, every typed
  // character would change `loadFile`'s reference, which would tear down and
  // re-register the Tauri DRAG_DROP listener, the file-open-from-cli listener,
  // and the global keydown handler — all of which depend on `loadFile` —
  // causing per-keystroke listener churn (and a small but real OS-level IPC
  // round-trip for the Tauri ones).
  const contentRef = useRef(content);
  contentRef.current = content;
  const originalContentRef = useRef(originalContent);
  originalContentRef.current = originalContent;
  const filePathRef = useRef(filePath);
  filePathRef.current = filePath;
  // Whether an AI review is pending, mirrored into a ref for the focus-time
  // external-change watcher (registered once, so it can't read state directly).
  // AI-01.
  const reviewActiveRef = useRef(false);
  reviewActiveRef.current = proposedDoc != null;

  // Intercept EVERY window-close path (Alt+F4, taskbar close, the title bar X,
  // OS shutdown) and route dirty buffers through the unsaved-changes dialog.
  // Previously only the custom X button checked isDirty, so Alt+F4 silently
  // discarded unsaved work. The title bar X calls Window.close(), which also
  // fires this event — one interception point for all of them. CLOSE-01.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let mounted = true;
    try {
      Window.getCurrent()
        .onCloseRequested((event) => {
          // Guard ALL tabs, not just the active one — a dirty background tab used
          // to be discarded silently on Alt+F4 / taskbar close. TABS-04.
          if (collectDirtyTabs().length > 0) {
            event.preventDefault();
            showModal("unsavedBeforeClose");
          }
        })
        .then((fn) => {
          if (mounted) unlisten = fn;
          else fn();
        })
        .catch(() => {/* browser dev mode — no Tauri window */});
    } catch {/* browser dev mode */}
    return () => {
      mounted = false;
      unlisten?.();
    };
    // Registered once; collectDirtyTabs is stable (reads refs).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Close-dialog handlers. destroy() skips the close-requested event, so we
  // don't loop back into the dialog we just answered.
  const forceCloseWindow = useCallback(() => {
    Window.getCurrent().destroy().catch(() => {/* browser dev mode */});
  }, []);

  // Save EVERY dirty tab, then close. An untitled tab prompts for a location;
  // cancelling that (or any failed save) aborts the close so nothing is lost. TABS-04.
  const handleSaveAndCloseWindow = useCallback(async () => {
    hideModal("unsavedBeforeClose");
    for (const t of collectDirtyTabs()) {
      let path = t.filePath;
      if (!path) {
        const selected = await save({
          filters: [{ name: "Markdown", extensions: ["md"] }],
          defaultPath: t.fileName,
        });
        if (!selected) return; // cancelled a save-as → keep the app open
        path = selected;
      }
      try {
        // Await the snapshot too, unlike every other save. `forceCloseWindow()` below
        // destroys the window, and a fire-and-forget snapshot still in flight when the
        // process dies is simply lost. That would make the version saved on the way
        // out, the last one the user ever wrote, the one version reliably absent from
        // its own history. Nothing is racing us for latency here; the app is quitting.
        await saveDocument(path, t.content, true);
      } catch (err) {
        const msg = errMessage(err);
        showToast(msg || `Failed to save ${t.fileName}`, "error");
        return; // don't close on a failed save — the user would lose the buffer
      }
    }
    forceCloseWindow();
  }, [collectDirtyTabs, forceCloseWindow, showToast, hideModal]);

  const handleDiscardAndCloseWindow = useCallback(() => {
    hideModal("unsavedBeforeClose");
    forceCloseWindow();
  }, [forceCloseWindow, hideModal]);

  // External-change detection: on window focus, stat the open file and reload
  // (clean buffer) or warn (dirty buffer). EXT-01. Callbacks are memoised so the
  // focus listener stays registered across renders.
  const handleExternalReloaded = useCallback(
    () => showToast("File changed on disk, reloaded the latest version", "info"),
    [showToast]
  );
  const handleExternalConflict = useCallback(
    () => showToast("This file changed on disk. Saving will overwrite those changes.", "error"),
    [showToast]
  );
  useExternalChangeWatcher({
    filePathRef, contentRef, originalContentRef, knownMtimeRef,
    isReviewActiveRef: reviewActiveRef,
    reload: loadFileDirect,
    onReloaded: handleExternalReloaded,
    onConflict: handleExternalConflict,
  });

  // Autosave 1.5s after the last edit. See useAutosave for the throttling and
  // the AI-review guard (AI-01). Callbacks are memoised so the debounce timer
  // isn't reset on every unrelated re-render.
  const handleAutosaved = useCallback((mtime: number, saved: string) => {
    knownMtimeRef.current = mtime;
    setOriginalContent(saved);
  }, []);
  const handleAutosaveError = useCallback((msg: string) => showToast(msg, "error"), [showToast]);
  useAutosave({
    enabled: autoSaveEnabled,
    filePath,
    content,
    originalContent,
    isReviewActive: proposedDoc != null,
    onSaved: handleAutosaved,
    onError: handleAutosaveError,
  });

  // Autosave dirty BACKGROUND tabs too (useAutosave above only covers the active
  // buffer). A background tab's content only changes when you switch away from
  // it, so this effect keys on `tabs` — it never re-runs on active-tab keystrokes
  // (those live in `content`, not the snapshot). Saved tabs get their
  // originalContent/knownMtime updated, which clears them from the dirty set so
  // the effect settles without looping. TABS-06.
  useEffect(() => {
    if (!autoSaveEnabled) return;
    const dirtyBg = backgroundTabsToAutosave(tabs, activeTabIdRef.current);
    if (dirtyBg.length === 0) return;
    const timer = window.setTimeout(async () => {
      let wrote = false;
      for (const t of dirtyBg) {
        try {
          const mtime = await saveDocument(t.filePath!, t.content);
          // markTabSaved refuses to mark it clean if its content moved while the write was in
          // flight: the user can switch to a background tab and type into it mid-save, and
          // calling that saved would quietly lose what they typed.
          commitTabs(markTabSaved(tabsRef.current, t.id, t.content, mtime));
          wrote = true;
        } catch {/* best-effort; the active-tab path surfaces disk errors */}
      }
      // A background tab that just landed on disk may be the thing that links
      // here, so the backlinks panel has to re-scan. Nothing else would tell it:
      // the folder did change, but the window never lost focus.
      if (wrote) bumpSaved();
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [tabs, autoSaveEnabled, commitTabs, bumpSaved]);

  // External-change detection for BACKGROUND tabs. The active tab is handled by
  // useExternalChangeWatcher; on window focus we also stat every other open
  // file. A clean background tab silently refreshes its snapshot; a dirty one
  // gets a one-time conflict warning (its knownMtime is advanced so it won't
  // re-toast every focus). TABS-06.
  useEffect(() => {
    const onFocus = async () => {
      const activeId = activeTabIdRef.current;
      const bg = tabsRef.current.filter((t) => t.id !== activeId && t.filePath);
      for (const t of bg) {
        try {
          const info = await invoke<{ modified: number }>("get_file_info", { path: t.filePath! });
          const decision = externalChangeDecision(t, info.modified);
          if (decision.action === "none") continue;
          if (decision.action === "reload") {
            const fd = await invoke<FileData>("read_file", { path: t.filePath! });
            commitTabs(
              tabsRef.current.map((x) =>
                x.id === t.id
                  ? { ...x, content: fd.content, originalContent: fd.content, fileSize: fd.size, knownMtime: fd.modified ?? 0 }
                  : x
              )
            );
          } else {
            commitTabs(tabsRef.current.map((x) => (x.id === t.id ? { ...x, knownMtime: info.modified } : x)));
            showToast(`"${t.fileName}" changed on disk in a background tab. Saving it will overwrite those changes.`, "error");
          }
        } catch {/* file gone / stat failed — surfaced when that tab is saved */}
      }
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [commitTabs, showToast]);

  // Persist the whole open-tab session (paths + which is active) so a relaunch
  // reopens everything, not just one file. Runs whenever the tab list or the
  // active tab changes. Untitled buffers have no path and are omitted. The
  // active tab's caret line comes from the live currentLineRef (its snapshot
  // lags until the next switch). TABS-07.
  useEffect(() => {
    const activeId = activeTabIdRef.current;
    const persistable = tabs.filter((t) => t.filePath);
    if (persistable.length === 0) {
      setSession(null);
      return;
    }
    const sessTabs = persistable.map((t) => ({
      path: t.filePath!,
      cursorLine: t.id === activeId ? currentLineRef.current : t.cursorLine,
    }));
    const activeIdx = persistable.findIndex((t) => t.id === activeId);
    setSession({ tabs: sessTabs, activeIndex: activeIdx < 0 ? 0 : activeIdx });
  }, [tabs, activeTabId]);

  // Open a file: if it's already in a tab, just switch to it (preserving any
  // unsaved edits there); otherwise load it into a new tab. With tabs there's no
  // need to prompt before opening — the current file stays open in its own tab.
  const loadFile = useCallback(async (path: string) => {
    const existing = findTabByPath(tabsRef.current, path);
    if (existing) { activateTab(existing.id); return; }
    await loadFileDirect(path);
  }, [activateTab, loadFileDirect]);

  // Reopen the most recently closed (saved) tab, restoring its caret line. TABS-15.
  const reopenClosedTab = useCallback(() => {
    const entry = closedTabsRef.current.pop();
    if (!entry) return;
    loadFile(entry.path);
    if (entry.cursorLine && entry.cursorLine > 1) {
      const line = entry.cursorLine;
      window.setTimeout(
        () => window.dispatchEvent(new CustomEvent("dumont:goto-line", { detail: { line } })),
        150
      );
    }
  }, [loadFile]);

  // Jump to a tab by position (Ctrl+1..8); index -1 means the last tab (Ctrl+9,
  // browser convention). TABS-16.
  const gotoTabByIndex = useCallback((index: number) => {
    const list = tabsRef.current;
    if (list.length === 0) return;
    const target = index === -1 ? list[list.length - 1] : list[index];
    if (target) activateTab(target.id);
  }, [activateTab]);

  // Remove a tab and refocus a neighbour (or fall back to the welcome screen).
  // No dirty check here — callers decide whether to prompt first. TABS-01.
  const finalizeCloseTab = useCallback((id: string) => {
    // Remember saved tabs so Ctrl+Shift+T can reopen them. TABS-15.
    const closing = tabsRef.current.find((t) => t.id === id);
    if (closing?.filePath) {
      const isActiveClosing = id === activeTabIdRef.current;
      closedTabsRef.current.push({
        path: closing.filePath,
        cursorLine: isActiveClosing ? currentLineRef.current : closing.cursorLine,
      });
      if (closedTabsRef.current.length > 25) closedTabsRef.current.shift();
    }
    const isActive = id === activeTabIdRef.current;
    const nextId = nextActiveAfterClose(tabsRef.current, id);
    const remaining = tabsRef.current.filter((t) => t.id !== id);
    commitTabs(remaining);
    if (!isActive) return;
    const target = nextId ? remaining.find((t) => t.id === nextId) : undefined;
    if (target) {
      setActiveTab(target.id);
      applyTabToLive(target);
    } else {
      // Last tab closed — return to the clean welcome state.
      setActiveTab(null);
      setProposedDoc(null);
      bumpDocSwap();
      setFilePath(null);
      setFileName(null);
      setContent("");
      setOriginalContent("");
      setFileSize(0);
      knownMtimeRef.current = 0;
      setLastFile(null);
    }
  }, [commitTabs, setActiveTab, applyTabToLive, bumpDocSwap]);

  // Close a tab. A clean tab closes immediately; a dirty one opens the
  // Save / Discard / Cancel dialog (TABS-05) rather than the old two-button
  // discard-or-cancel prompt.
  // The gate between Ctrl+W and a lost draft. The decision is a pure function now
  // (tabsModel.closeTabDecision) rather than a dirty check hand-rolled here, a few feet away
  // from the exported, TESTED isTabDirty that this code did not call. The tested function and
  // the running function were two different functions, which is the shape of a bug waiting.
  const closeTab = useCallback((id: string) => {
    const decision = closeTabDecision(tabsRef.current, id, activeTabIdRef.current, liveRef.current);
    if (decision.action === "gone") return;
    if (decision.action === "prompt") {
      setCloseTabPrompt({ id, fileName: decision.fileName });
      return;
    }
    finalizeCloseTab(id);
  }, [finalizeCloseTab]);

  // The effective save target for a tab. Reads through resolveTab so the active tab's LIVE
  // buffer is merged in: its snapshot in the array is stale by design.
  const getTabSaveData = useCallback((id: string) => {
    return resolveTab(tabsRef.current, id, activeTabIdRef.current, liveRef.current);
  }, []);

  // "Save" in the close-tab dialog: persist the tab (prompting a location for an
  // untitled buffer), then close it. Cancel/failure keeps the tab open. TABS-05.
  const handleSaveCloseTab = useCallback(async () => {
    const prompt = closeTabPrompt;
    if (!prompt) return;
    const data = getTabSaveData(prompt.id);
    if (!data) { setCloseTabPrompt(null); return; }

    // The tab survives unless its contents reached the disk. That guarantee used to be two
    // bare `return`s inline here; it is saveThenClose's whole job now, and it has tests.
    const outcome = await saveThenClose(data, {
      pickPath: (defaultName) =>
        save({ filters: [{ name: "Markdown", extensions: ["md"] }], defaultPath: defaultName }),
      save: (path, content) => saveDocument(path, content),
      onError: (msg) => showToast(msg || "Failed to save file", "error"),
    });
    if (outcome.action === "keep-open") return;
    // The tab we just wrote is usually NOT the one on screen, and it may be the file
    // that links here: close a tab holding an unsaved `[[Foo]]` while Foo.md is open
    // and the mention only now exists on disk. Nothing else would tell the panel, as
    // the window never lost focus.
    bumpSaved();
    setCloseTabPrompt(null);
    finalizeCloseTab(prompt.id);
  }, [closeTabPrompt, getTabSaveData, showToast, finalizeCloseTab, bumpSaved]);

  const handleDiscardCloseTab = useCallback(() => {
    const prompt = closeTabPrompt;
    setCloseTabPrompt(null);
    if (prompt) finalizeCloseTab(prompt.id);
  }, [closeTabPrompt, finalizeCloseTab]);

  // Listen for Tauri drag-drop events
  useEffect(() => {
    let mounted = true;
    let unlisten: (() => void) | undefined;

    listen<{ paths: string[] }>(TauriEvent.DRAG_DROP, async (event) => {
      // Open EVERY dropped markdown / text file in its own tab (the last one
      // wins focus), rather than only the first. TABS-11 / TXT-01.
      const paths = (event.payload.paths ?? []).filter((p) =>
        /\.(md|markdown|txt|text)$/i.test(p)
      );
      for (const p of paths) {
        await loadFile(p);
      }
    }).then((fn) => {
      if (mounted) {
        unlisten = fn;
      } else {
        fn(); // Component already unmounted, clean up immediately
      }
    });

    return () => {
      mounted = false;
      unlisten?.();
    };
  }, [loadFile]);

  // Offer to create a note that a link points at but doesn't exist yet, then
  // open it. Used by both wikilinks and relative links. NAV-07.
  const offerCreateNote = useCallback(async (path: string, displayName: string) => {
    const confirmed = await ask(`"${displayName}" doesn't exist yet. Create it?`, {
      title: "Create note",
      kind: "info",
    });
    if (!confirmed) return;
    try {
      // NOT saveDocument: this writes an empty brand-new file, and a snapshot of
      // nothing, taken before the note exists, is not history. It is a junk first
      // entry in the list of every note ever created this way.
      await invoke<number>("save_file", { path, content: "" });
      await loadFile(path);
    } catch (err) {
      const msg = errMessage(err);
      showToast(msg || "Could not create note", "error");
    }
  }, [loadFile, showToast]);

  // Wikilink click: resolve target relative to the current file's folder.
  // Tries `<target>.md` first, then `<target>` literal. Silently fails if neither exists.
  // SECURITY: rejects path-traversal and absolute paths so a crafted document
  // can't load arbitrary files outside the current folder.
  const handleWikilinkClick = useCallback(async (target: string) => {
    if (!filePath) return;
    const cleaned = target.trim();
    // Block traversal (`..`), path separators, drive letters, and absolute paths.
    // Wikilinks should only reference siblings in the same folder.
    if (
      !cleaned ||
      cleaned.includes("..") ||
      cleaned.includes("/") ||
      cleaned.includes("\\") ||
      cleaned.includes("\0") ||
      /^[a-zA-Z]:/.test(cleaned)
    ) {
      showToast(`Invalid wikilink target: [[${target}]]`, "error");
      return;
    }
    const lastSep = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
    const dir = lastSep > 0 ? filePath.slice(0, lastSep) : "";
    const sep = filePath.includes("\\") ? "\\" : "/";
    const candidates = [
      `${dir}${sep}${cleaned}.md`,
      `${dir}${sep}${cleaned}.markdown`,
      `${dir}${sep}${cleaned}`,
    ];
    for (const c of candidates) {
      try {
        // get_file_info errors when the file doesn't exist; use it as a probe
        await invoke("get_file_info", { path: c });
        loadFile(c);
        return;
      } catch {/* try next */}
    }
    // Nothing matched — offer to create the note next to the current file, the
    // way Obsidian turns a dangling [[link]] into a new file. NAV-07.
    offerCreateNote(`${dir}${sep}${cleaned}.md`, `${cleaned}.md`);
  }, [filePath, loadFile, showToast, offerCreateNote]);

  // Standard relative markdown links — `[text](note.md)`, `[x](sub/note.md)`,
  // `[y](../other.md)` — open in-app like wikilinks (the preview only routes
  // local .md/.markdown hrefs here). Resolve against the current file's folder,
  // normalizing `.`/`..` segments. A missing file surfaces via loadFile. NAV-05.
  const handleNavigateRelative = useCallback(async (href: string) => {
    if (!filePath) return;
    // Relative links follow browser semantics ON PURPOSE and are deliberately NOT
    // confined to the open file's folder: `[glossary](../shared/glossary.md)` is a
    // normal, wanted link across a multi-folder notes tree. resolveRelativePath
    // resolves `..` without confining to that folder (on POSIX it stops at the
    // filesystem root; a Windows drive path can be climbed to a bare relative
    // name), so a crafted link CAN resolve to a .md elsewhere on disk.
    // Security-audit Finding 4 accepted this:
    // the exposure is low (read-only, requires a click, the anchor renderer only
    // navigates .md/.markdown hrefs, and the target opens into the user's own
    // editor), and confining it would break legitimate cross-folder links.
    // Wikilinks take the opposite, also-deliberate stance, because they are a
    // vault-internal scheme: handleNavigateWikilink rejects `..`, separators, drive
    // letters, and absolute paths.
    const resolved = resolveRelativePath(filePath, href);
    if (!resolved) return;
    try {
      // Probe first so a link to a not-yet-created note offers creation rather
      // than flashing a "failed to open" error. NAV-07.
      await invoke("get_file_info", { path: resolved });
      loadFile(resolved);
    } catch {
      const name = resolved.replace(/\\/g, "/").split("/").pop() || resolved;
      offerCreateNote(resolved, name);
    }
  }, [filePath, loadFile, offerCreateNote]);

  // Open a cross-file search result: load the file (if not already open) and
  // jump to the matching line once it has rendered. The goto-line event is the
  // same one the TOC/palette use, so it lands correctly in any view mode. SEARCH-01.
  const handleOpenSearchResult = useCallback(async (path: string, line: number) => {
    // Wait for the file to actually load before jumping, instead of racing a
    // fixed timeout that a large document could lose (landing at the top). SEARCH-01.
    if (path !== filePathRef.current) {
      await loadFile(path);
    }
    requestAnimationFrame(() =>
      window.dispatchEvent(new CustomEvent("dumont:goto-line", { detail: { line } }))
    );
  }, [loadFile]);

  // Folder the cross-file search runs in: the open file's directory.
  const currentDirectory = useMemo(() => {
    if (!filePath) return null;
    const lastSep = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
    return lastSep > 0 ? filePath.slice(0, lastSep) : null;
  }, [filePath]);

  // New file: opens a fresh Untitled buffer in its own tab (the current file
  // stays open in its tab, so nothing is discarded). Reuses a pristine empty
  // untitled tab if one exists, and numbers new ones Untitled-N.md. TABS-01/08.
  const handleNewFile = useCallback(() => {
    const reusable = findReusableUntitledTab(tabsRef.current);
    if (reusable) {
      if (reusable.id !== activeTabIdRef.current) activateTab(reusable.id);
      setMode("code");
      return;
    }
    snapshotActiveTab();
    bumpDocSwap(); // fresh Untitled buffer → editor resets undo history. TABS-03.
    const id = newTabId();
    const name = nextUntitledName(tabsRef.current);
    commitTabs([...tabsRef.current, {
      id, filePath: null, fileName: name,
      content: "", originalContent: "", fileSize: 0, knownMtime: 0,
    }]);
    setActiveTab(id);
    setProposedDoc(null);
    setFilePath(null);
    setFileName(name);
    setContent("");
    setOriginalContent("");
    setFileSize(0);
    knownMtimeRef.current = 0;
    setLastFile(null);
    setMode("code");
  }, [snapshotActiveTab, commitTabs, setActiveTab, newTabId, bumpDocSwap, activateTab, setMode]);

  // Open the interactive feature guide (offered at the end of the tour and from
  // the command palette). It opens as a real, editable document so users can
  // poke at live math, diagrams and tables. Reuses a pristine empty untitled
  // buffer when one exists;
  // otherwise opens a new tab so the current file is left untouched. Split view
  // shows the markdown and the rendered result side by side.
  const handleOpenTutorial = useCallback(() => {
    const name = "Welcome to Dumont.md";
    const bytes = new TextEncoder().encode(tutorialMarkdown).length;

    // Snapshot first so the active tab's latest edits are preserved even when we
    // switch to (or reuse) a different tab. snapshotActiveTab updates tabsRef
    // synchronously, so the reuse lookup below sees the up-to-date list.
    snapshotActiveTab();
    bumpDocSwap(); // fresh document → reset the editor's undo history. TABS-03.

    const reusable = findReusableUntitledTab(tabsRef.current);
    const id = reusable ? reusable.id : newTabId();

    const entry: TabState = {
      id, filePath: null, fileName: name,
      content: tutorialMarkdown, originalContent: tutorialMarkdown,
      fileSize: bytes, knownMtime: 0,
    };
    commitTabs(
      reusable
        ? tabsRef.current.map((t) => (t.id === id ? entry : t))
        : [...tabsRef.current, entry]
    );
    setActiveTab(id);
    setProposedDoc(null);
    setFilePath(null);
    setFileName(name);
    setContent(tutorialMarkdown);
    setOriginalContent(tutorialMarkdown);
    setFileSize(bytes);
    knownMtimeRef.current = 0;
    setLastFile(null);
    setMode("split");
  }, [snapshotActiveTab, commitTabs, setActiveTab, newTabId, bumpDocSwap, setMode]);

  // Open file dialog
  const handleOpenFile = useCallback(async () => {
    try {
      // Allow selecting several files at once — each opens in its own tab. TABS-11.
      // Plain-text files open too (rendered as markdown, which degrades fine). TXT-01.
      const selected = await open({
        multiple: true,
        filters: [
          {
            name: "Markdown & text",
            extensions: ["md", "markdown", "txt", "text"],
          },
        ],
      });

      if (typeof selected === "string") {
        await loadFile(selected);
      } else if (Array.isArray(selected)) {
        for (const p of selected) await loadFile(p);
      }
    } catch (err) {
      console.error("Failed to open file dialog:", err);
    }
  }, [loadFile]);

  // Save As — always prompts for a new path, even if a path is already set.
  // Reads the live buffer through liveRef rather than closing over `content`.
  //
  // This is what makes the command palette's useMemo actually hold. That memo lists
  // handleSaveFile, which lists handleSaveAs, which listed `content`, so the whole chain
  // changed identity on every keystroke and the memo rebuilt its ~40 items every time a
  // character was typed. The comment on that memo has always said this must not happen; it
  // was happening anyway, and the linter is what finally made the chain visible. liveRef is
  // written during render (App.tsx, "the live state IS the active tab"), so it is never
  // staler than the closure it replaces.
  const handleSaveAs = useCallback(async () => {
    const { content: live, fileName: liveName } = liveRef.current;
    const selected = await save({
      filters: [{ name: "Markdown", extensions: ["md"] }],
      defaultPath: liveName ?? undefined,
    });
    if (!selected) return;
    try {
      knownMtimeRef.current = await saveDocument(selected, live);
      setFilePath(selected);
      const name = selected.replace(/\\/g, "/").split("/").pop() || "Untitled";
      setFileName(name);
      setOriginalContent(live);
      addRecentFile(selected, name);
      setLastFile(selected);
      // Keep the active tab's entry in step with the new path/name so reopening
      // the just-saved file switches to this tab instead of duplicating it. TABS-01.
      const activeId = activeTabIdRef.current;
      if (activeId) {
        commitTabs(tabsRef.current.map((t) => (t.id === activeId ? {
          ...t, filePath: selected, fileName: name, content: live, originalContent: live,
          knownMtime: knownMtimeRef.current,
        } : t)));
      }
      showToast("File saved", "success");
    } catch (err) {
      console.error("Failed to save file:", err);
      const msg = errMessage(err);
      showToast(msg || "Failed to save file", "error");
    }
  }, [showToast, commitTabs]);

  // Save file (Save As if no path yet). Reads the live buffer from liveRef for the same
  // reason handleSaveAs does: this callback is what the command palette's memo hangs off,
  // so closing over `content` made that memo rebuild on every keystroke.
  const handleSaveFile = useCallback(async () => {
    const { filePath: path, content: live } = liveRef.current;
    if (!path) {
      await handleSaveAs();
      return;
    }
    try {
      knownMtimeRef.current = await saveDocument(path, live);
      setOriginalContent(live);
      showToast("File saved", "success");
    } catch (err) {
      console.error("Failed to save file:", err);
      const msg = errMessage(err);
      showToast(msg || "Failed to save file", "error");
    }
  }, [showToast, handleSaveAs]);

  // Runtime file-open forwards. Cold-start CLI files are handled by the pull
  // in the boot effect above; this event now arrives only from the
  // single-instance plugin, when the user double-clicks another .md while
  // Dumont is already running and the second launch hands us its path.
  useEffect(() => {
    let mounted = true;
    let unlisten: (() => void) | undefined;

    listen<string>("file-open-from-cli", async (event) => {
      const filePath = event.payload;
      if (filePath) {
        await loadFile(filePath);
      }
    }).then((fn) => {
      if (mounted) {
        unlisten = fn;
      } else {
        fn();
      }
    });

    return () => {
      mounted = false;
      unlisten?.();
    };
  }, [loadFile]);

  // Toggle between preview and code (skips split — split has its own shortcut)
  const handleToggleMode = useCallback(() => {
    setMode((prev) => (prev === "code" ? "preview" : "code"));
  }, [setMode]);

  const handleToggleSplit = useCallback(() => {
    setMode((prev) => (prev === "split" ? "preview" : "split"));
  }, [setMode]);

  // Open the named left panel, or close it if it is the one already open. The
  // other three need no mention: holding a single slot is what closes them.
  const toggleLeftPanel = useCallback(
    (panel: OpenLeftPanel) => setLeftPanel((cur) => (cur === panel ? null : panel)),
    []
  );

  const handleToggleFileExplorer = useCallback(() => toggleLeftPanel("explorer"), [toggleLeftPanel]);
  const handleToggleTOC = useCallback(() => toggleLeftPanel("toc"), [toggleLeftPanel]);
  const handleToggleBacklinks = useCallback(() => toggleLeftPanel("backlinks"), [toggleLeftPanel]);
  const handleToggleHistory = useCallback(() => toggleLeftPanel("history"), [toggleLeftPanel]);

  // Toggle the right-side AI assistant panel.
  const handleToggleAI = useCallback(() => setShowAIPanel((v) => !v), []);

  // Agent proposed an edited document → show it as a diff to accept/reject.
  // Ensure the editor (where the diff renders) is visible.
  const handleProposeEdit = useCallback((doc: string) => {
    setProposedDoc(doc);
    setReviewLabel(AI_REVIEW_LABEL);
    setMode((m) => (m === "preview" ? "split" : m));
  }, [setMode]);

  // Review finished: commit the accepted document (or keep the original on reject).
  const handleReviewResolve = useCallback((finalDoc: string | null) => {
    if (finalDoc != null) setContent(finalDoc);
    setProposedDoc(null);
  }, []);

  // Close whichever left panel is open. This is what every left panel is handed as
  // its onClose, and what Escape reaches.
  const closeAllPanels = useCallback(() => setLeftPanel(null), []);

  // Restore a snapshot, by proposing it rather than performing it.
  //
  // This reuses the AI review flow exactly: the snapshot becomes the editor's doc
  // and the CURRENT document becomes the merge view's `original`, so the user gets
  // a per-chunk diff with accept/reject, autosave parks itself while it is up
  // (isReviewActive), and nothing reaches the disk until they press Ctrl+S. There
  // is deliberately no Rust command that overwrites the file with a snapshot: that
  // would be the single irreversible act in a feature whose entire purpose is
  // reversibility, and it would be the one that destroys the work the user did
  // since the snapshot was taken.
  const handleRestoreSnapshot = useCallback((text: string, label: string) => {
    setProposedDoc(text);
    setReviewLabel(label);
    setMode((m) => (m === "preview" ? "split" : m));
    showToast("Snapshot shown as a proposed change. Accept what you want, then save.", "info");
  }, [showToast, setMode]);

  // Handle file drop
  const handleFileDrop = useCallback(
    (path: string) => {
      loadFile(path);
    },
    [loadFile]
  );

// Handle content change
  const handleContentChange = useCallback((newContent: string) => {
    setContent(newContent);
  }, []);

  // Stable cursor + preview-line setters. Critical that these are useCallback
  // (not inline arrows): CodeEditor wires `onCursorChange` into a useEffect via
  // `updateCursorPosition`, and an unstable callback ref would re-run that
  // effect on every parent render, calling `updateCursorPosition()` again,
  // which itself calls `setCursorPosition({ line, col })` with a fresh object
  // — fresh object refs bypass React's bail-out and feed the cycle.
  // The functional-update form bails out (returns the previous state) when the
  // values haven't actually changed, breaking the loop on idle re-renders.
  const handleCursorChange = useCallback((line: number, col: number) => {
    setCursorPosition((prev) => (prev.line === line && prev.col === col ? prev : { line, col }));
  }, []);
  // Bail out via functional update when the range hasn't actually changed —
  // selectionchange fires constantly while typing even when caret is at the
  // same offset, and we don't want to mint a fresh `{ start, end }` object
  // (and trigger a status-bar re-render) on every keystroke.
  const handleSelectionChange = useCallback((start: number, end: number) => {
    setSelectionRange((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
  }, []);
  const handlePreviewLineChange = useCallback((line: number) => {
    setPreviewLine((prev) => (prev === line ? prev : line));
  }, []);

  // Handle image paste success
  const handleImagePaste = useCallback(() => {
    showToast('Image pasted successfully!', 'success');
  }, [showToast]);

  // Handle error messages from child components
  const handleError = useCallback((message: string) => {
    showToast(message, 'error');
  }, [showToast]);

  // Neutral info toast (distinct from error). Used e.g. when AI assist is
  // invoked before it's configured, so the action isn't a silent no-op.
  const handleNotice = useCallback((message: string) => {
    showToast(message, 'info');
  }, [showToast]);

  // Fullscreen (F11). The hook masks the resize behind a fade and works around
  // two Windows frameless-window footguns — see useFullscreen. The "press F11 to
  // exit" hint surfaces as an info toast via handleNotice. FULLSCREEN-01.
  const { isFullscreen, fsTransition, toggleFullscreen } = useFullscreen(handleNotice);

  // Stable export-result callbacks so TitleBar's props are reference-equal
  // across renders. Inline arrows here would re-create the closures on every
  // App render and defeat any downstream memoization.
  const handleExportSuccess = useCallback(
    (fmt: string) => showToast(`Exported as ${fmt}`, "success"),
    [showToast]
  );
  const handleExportError = useCallback(
    (fmt: string) => showToast(`Failed to export ${fmt}`, "error"),
    [showToast]
  );

  // Open Recent is drawn by the OS, but the list lives here (it is session state,
  // not settings), so Rust has to be told about it. Pushed on mount and after every
  // open, which is exactly when it changes.
  useEffect(() => { void pushRecentsToMenu(); }, [pushRecentsToMenu]);

  // The native menu bar (macOS).
  //
  // The menu implements nothing: Rust emits the id of whatever was chosen, and it
  // lands on the same handler the keyboard shortcut already calls. One place knows
  // how to open a file.
  //
  // The action table goes through a REF and the effect is mounted ONCE. Written the
  // obvious way (no dependency array, closing over the handlers) it tore down and
  // re-registered the Tauri listener on every render: App re-renders on every
  // keystroke, so that was two IPC round trips per character, each with a brief
  // window in which no menu handler was registered at all. The codebase already
  // guards the drag-drop and CLI-file listeners against exactly this.
  const menuActions = useRef<Record<string, () => void>>({});
  menuActions.current = {
    "file.new": handleNewFile,
    "file.open": () => { void handleOpenFile(); },
    "file.save": () => { void handleSaveFile(); },
    "file.saveAs": () => { void handleSaveAs(); },
    "file.closeTab": () => { if (activeTabIdRef.current) closeTab(activeTabIdRef.current); },
    // Clear Menu sat in the menu, enabled and clickable, and did nothing: there was
    // no entry here for its id, and `actions[id]?.()` swallowed it silently. The
    // optional call exists to tolerate an id from a NEWER build, not to excuse a
    // missing handler for one this build emits.
    "file.recent.clear": () => { clearRecentFiles(); void pushRecentsToMenu(); },
    "app.settings": () => openSettings(),
    "view.toggleMode": handleToggleMode,
    "view.split": handleToggleSplit,
    "view.explorer": handleToggleFileExplorer,
    "view.toc": handleToggleTOC,
    "view.backlinks": handleToggleBacklinks,
    "view.history": handleToggleHistory,
    "view.palette": () => showModal("palette"),
    "help.shortcuts": () => showModal("cheatsheet"),
  };

  const loadFileRef = useRef(loadFile);
  loadFileRef.current = loadFile;

  useEffect(() => {
    const un = listen<string>("menu", (e) => {
      const id = e.payload;
      // Open Recent carries the path in its id, so opening it needs no lookup.
      const recent = recentPathFromMenuId(id);
      if (recent) {
        void loadFileRef.current(recent);
        return;
      }
      menuActions.current[id]?.();
    });
    return () => { void un.then((f) => f()); };
  }, []);

  // App-wide keyboard shortcuts (window-level, mounted once). See the hook.
  useGlobalShortcuts({
    handleOpenFile, handleSaveFile, handleSaveAs, handleNewFile,
    handleToggleMode, handleToggleSplit, handleToggleFileExplorer, handleToggleTOC,
    handleToggleBacklinks,
    handleToggleHistory,
    toggleFullscreen,
    openCheatsheet: () => showModal("cheatsheet"),
    openPalette: () => showModal("palette"),
    // Through the helper, not setShowSettings: Ctrl+, must land on the grouped
    // panes even if the last open was the palette's JSON command.
    openSettings: () => openSettings(),
    // Ctrl+F in reader mode opens the preview find bar (the editor keymap
    // handles find in code/split mode, where the editor has focus). FIND-01.
    openPreviewFind: () => setPreviewFindOpen(true),
    openSearch: () => showModal("search"),
    closeActiveTab: () => { if (activeTabIdRef.current) closeTab(activeTabIdRef.current); },
    prevTab: () => cycleTab(-1),
    nextTab: () => cycleTab(1),
    reopenClosedTab,
    gotoTab: gotoTabByIndex,
    hasFile, content, mode,
  });

  // Get export HTML from the visible preview on demand (avoids duplicate rendering)
  const getExportHtml = useCallback((): string => {
    if (previewRef.current) {
      return previewRef.current.innerHTML;
    }
    return "";
  }, []);

  // The command palette's items. Lifted into a hook: it was 380 lines of pure projection
  // from state into a list, read by nothing else, sitting in the middle of this file.
  //
  // The long argument list is the coupling made countable, not coupling introduced. The
  // palette is the one surface that can reach every other feature, so it genuinely does
  // depend on every other feature's entry point.
  const fullPaletteItems = usePaletteCommands({
    handleNewFile, handleOpenFile, handleSaveFile, handleSaveAs, handleOpenTutorial,
    loadFile, closeTab, filePath, fileName, hasFile,
    handleToggleSplit, handleToggleFileExplorer, handleToggleTOC, handleToggleBacklinks,
    handleToggleHistory, toggleFullscreen, setMode,
    openSettings, showModal, showPalette,
    typewriterModeEnabled, setTypewriterModeEnabled,
    toolbarVisible, setToolbarVisible,
    minimapEnabled, setMinimapEnabled,
    aiEnabled, theme, setTheme,
    tabs, activeTabId, activateTab, deferredContent,
    showToast,
  });

  // Tab-bar items. The active tab's name/dirty come from live state (its stored
  // snapshot lags until the next switch); inactive tabs read their snapshot.
  // `label` disambiguates duplicate file names by folder (TABS-09); `name` is
  // the bare file name (title/aria). Keyed on `isDirty` (a boolean) so typing
  // within an already-dirty file doesn't churn this list. TABS-01.
  const tabBarItems = useMemo<TabBarItem[]>(() => {
    const resolved = tabs.map((t) => {
      const active = t.id === activeTabId;
      return {
        id: t.id,
        fileName: active ? (fileName ?? "Untitled.md") : t.fileName,
        filePath: active ? filePath : t.filePath,
        dirty: active ? isDirty : t.content !== t.originalContent,
      };
    });
    const labels = computeTabLabels(resolved);
    return resolved.map((t) => ({
      id: t.id,
      name: t.fileName,
      label: labels.get(t.id) ?? t.fileName,
      dirty: t.dirty,
    }));
  }, [tabs, activeTabId, fileName, filePath, isDirty]);

  // Drag-reorder: move a tab to a new index. TABS-10.
  const handleReorderTab = useCallback((fromIndex: number, toIndex: number) => {
    commitTabs(moveTab(tabsRef.current, fromIndex, toIndex));
  }, [commitTabs]);

  // Close a set of tabs, but only the CLEAN ones — dirty tabs are kept open
  // (never silently discarded) and reported. Used by the context-menu
  // "Close others / Close to the right" actions. TABS-12.
  const closeManyClean = useCallback((ids: string[]) => {
    let keptDirty = 0;
    for (const id of ids) {
      const t = tabsRef.current.find((x) => x.id === id);
      if (!t) continue;
      const dirty = id === activeTabIdRef.current
        ? liveRef.current.content !== liveRef.current.originalContent
        : t.content !== t.originalContent;
      if (dirty) { keptDirty++; continue; }
      finalizeCloseTab(id);
    }
    if (keptDirty > 0) {
      showToast(`Kept ${keptDirty} unsaved tab${keptDirty > 1 ? "s" : ""} open`, "info");
    }
  }, [finalizeCloseTab, showToast]);

  const handleTabMenuAction = useCallback((action: "closeOthers" | "closeRight", id: string) => {
    const list = tabsRef.current;
    if (action === "closeOthers") {
      closeManyClean(list.filter((t) => t.id !== id).map((t) => t.id));
    } else {
      const idx = list.findIndex((t) => t.id === id);
      if (idx >= 0) closeManyClean(list.slice(idx + 1).map((t) => t.id));
    }
    // Keep the anchor tab focused if it survived.
    if (tabsRef.current.some((t) => t.id === id) && id !== activeTabIdRef.current) {
      activateTab(id);
    }
  }, [closeManyClean, activateTab]);

  // Right-click menu on a tab: {id, x, y} while open. TABS-12.
  const [tabMenu, setTabMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const handleTabContextMenu = useCallback((id: string, x: number, y: number) => {
    setTabMenu({ id, x, y });
  }, []);

  return (
    <div className="h-screen flex flex-col bg-[var(--bg-primary)] overflow-hidden transition-colors">
      <TitleBar
        fileName={fileName ?? undefined}
        isDirty={isDirty}
        filePath={filePath ?? undefined}
        onOpenFile={handleOpenFile}
        onNewFile={handleNewFile}
        getExportHtml={getExportHtml}
        onExportSuccess={handleExportSuccess}
        onExportError={handleExportError}
        onToggleAI={aiEnabled ? handleToggleAI : undefined}
        aiActive={showAIPanel}
        isFullscreen={isFullscreen}
        onToggleFullscreen={toggleFullscreen}
      />

      {/* Tab bar — always shown once a file is open (even with one tab), with a
          + button, so it's clear more files can be opened in tabs. TABS-01. */}
      {hasFile && tabBarItems.length >= 1 && (
        <TabBar
          tabs={tabBarItems}
          activeId={activeTabId}
          onSelect={activateTab}
          onClose={closeTab}
          onNewTab={handleNewFile}
          onReorder={handleReorderTab}
          onContextMenu={handleTabContextMenu}
        />
      )}

      {/* Startup update check; invisible unless an update is actually available. */}
      <Suspense fallback={null}>
        <UpdateDialog />
      </Suspense>

      {!hasFile ? (
        booting ? (
          // Neutral splash while the last-opened file is being restored — avoids
          // a one-frame WelcomeScreen flash before the editor mounts.
          <div className="flex-1 flex items-center justify-center bg-[var(--bg-primary)]">
            <span className="material-symbols-outlined text-[28px] text-[var(--text-muted)] animate-spin">progress_activity</span>
          </div>
        ) : (
          <WelcomeScreen
            onRecentsChanged={() => { void pushRecentsToMenu(); }}
            onOpenFile={handleOpenFile}
            onNewFile={handleNewFile}
            // openSettings(), not showModal("settings"): the helper is what RESETS the
            // json flag. Going straight to showModal leaves it wherever the last opener put
            // it, so opening the JSON view from the palette, closing it, and then clicking
            // Settings on the welcome screen reopened the raw file rather than the panes.
            onOpenSettings={() => openSettings()}
            onFileDrop={handleFileDrop}
            onOpenRecent={loadFile}
          />
        )
      ) : (
        <>
          {/* Split-aware layout. Both views always mounted; CSS toggles their display
              and width so editor/preview state (scroll, selection) is preserved across
              mode switches. */}
          <div
            ref={splitContainerRef}
            className="flex-1 overflow-hidden flex flex-row"
            // Reserve space on BOTH sides for whichever panels are open, so the
            // editor and preview reflow beside them instead of being covered. The
            // panels are `fixed` (left-0 / right-0, above the status bar), which is
            // what keeps the window controls at the edge, and it is also why they
            // take no layout space of their own and this padding has to stand in for
            // them. min() mirrors each panel's own max width so a narrow window
            // reserves only as much as the panel actually takes.
            style={{
              paddingLeft: leftPanel ? `min(${LEFT_PANEL_WIDTH}px, 90vw)` : 0,
              paddingRight: showAIPanel ? `min(${AI_PANEL_WIDTH}px, 90vw)` : 0,
              transition: "padding-left 0.15s ease, padding-right 0.15s ease",
            }}
          >
            <div
              data-split-left
              className="overflow-hidden flex flex-col"
              style={{
                display: mode === "code" || mode === "split" ? "flex" : "none",
                flexBasis: mode === "split" ? `${splitRatio * 100}%` : "100%",
                flexGrow: mode === "split" ? 0 : 1,
                flexShrink: 0,
                minWidth: 0,
              }}
            >
              <CodeEditor
                content={content}
                docSwapId={docSwapId}
                onChange={handleContentChange}
                onCursorChange={handleCursorChange}
                onSelectionChange={handleSelectionChange}
                onImagePaste={handleImagePaste}
                onError={handleError}
                onNotice={handleNotice}
                filePath={filePath}
                onScrollFraction={onCodeScrollFraction}
                registerScroller={registerCodeScroller}
                typewriterMode={typewriterModeEnabled}
                showToolbar={toolbarVisible}
                wordWrap={wordWrapEnabled}
                minimap={minimapEnabled}
                spellCheck={spellCheckEnabled}
                aiConfig={aiConfig}
                reviewDoc={proposedDoc}
                reviewLabel={reviewLabel}
                onReviewResolve={handleReviewResolve}
              />
            </div>

            {mode === "split" && (
              <SplitDivider onDrag={setSplitRatioState} containerRef={splitContainerRef} />
            )}

            <div
              className="overflow-hidden flex flex-col relative"
              style={{
                display: mode === "preview" || mode === "split" ? "flex" : "none",
                flexBasis: mode === "split" ? `${(1 - splitRatio) * 100}%` : "100%",
                flexGrow: mode === "split" ? 0 : 1,
                flexShrink: 0,
                minWidth: 0,
              }}
            >
              {/* MarkdownPreview is lazy-loaded — its react-markdown +
                  remark-gfm + rehype-highlight stack is ~250 kB and
                  doesn't need to ship with the welcome screen. The
                  fallback is invisible since the parent column already
                  has a background; a brief flash on first render is
                  preferable to a spinner that pre-empts the layout. */}
              <Suspense fallback={null}>
                <MarkdownPreview
                  content={deferredContent}
                  fileName={fileName || ""}
                  fileSize={fileSize}
                  onEditClick={handleToggleMode}
                  onLineChange={handlePreviewLineChange}
                  filePath={filePath}
                  markdownBodyRef={previewRef}
                  onContentChange={handleContentChange}
                  onScrollFraction={onPreviewScrollFraction}
                  registerScroller={registerPreviewScroller}
                  onWikilinkClick={handleWikilinkClick}
                  onNavigateRelative={handleNavigateRelative}
                  readerWidth={readerWidth}
                />
              </Suspense>

              {/* Reader-mode find. Searches the rendered preview text and
                  highlights matches via the CSS Custom Highlight API. */}
              {previewFindOpen && (
                <PreviewFindBar
                  rootRef={previewRef}
                  onClose={() => setPreviewFindOpen(false)}
                />
              )}
            </div>
          </div>

          <ModeToggle mode={mode} onSetMode={setMode} aiPanelOpen={showAIPanel} />

          {/* Sidebar Panels — only mount when actually open so they don't
              load their module until first use. */}
          {showFileExplorer && (
            <Suspense fallback={null}>
              <FileExplorer
                isOpen={showFileExplorer}
                currentFilePath={filePath}
                onFileSelect={loadFile}
                onClose={closeAllPanels}
              />
            </Suspense>
          )}
          {showTOC && (
            <Suspense fallback={null}>
              <TableOfContents
                isOpen={showTOC}
                content={deferredContent}
                onClose={closeAllPanels}
                activeLine={mode === "preview" ? previewLine : cursorPosition.line}
              />
            </Suspense>
          )}
          {showBacklinks && (
            <Suspense fallback={null}>
              <BacklinksPanel
                isOpen={showBacklinks}
                currentFilePath={filePath}
                currentFileName={fileName}
                refreshKey={savedTick}
                onOpenResult={handleOpenSearchResult}
                onClose={closeAllPanels}
              />
            </Suspense>
          )}

          {showHistory && (
            <Suspense fallback={null}>
              <HistoryPanel
                isOpen={showHistory}
                filePath={filePath}
                enabled={historyEnabled}
                onEnable={() => setHistoryEnabled(true)}
                onPreview={handleRestoreSnapshot}
                onError={handleError}
                onClose={closeAllPanels}
              />
            </Suspense>
          )}

          {/* Right-side AI assistant panel. Reads the live document + current
              selection; chat is read-only for now (edit/agent flow is next). */}
          {aiEnabled && showAIPanel && (
            <Suspense fallback={null}>
              <AIPanel
                isOpen={showAIPanel}
                onClose={() => setShowAIPanel(false)}
                note={content}
                fileName={fileName || ""}
                selectionText={content.slice(selectionRange.start, selectionRange.end)}
                aiConfig={aiConfig}
                hasKey={hasAiKey}
                onProposeEdit={handleProposeEdit}
              />
            </Suspense>
          )}

<StatusBar
            isSaved={!isDirty}
            lineNumber={mode === "preview" ? previewLine : cursorPosition.line}
            columnNumber={cursorPosition.col}
            mode={mode}
            showFileExplorer={showFileExplorer}
            showTOC={showTOC}
            showBacklinks={showBacklinks}
            showHistory={showHistory}
            onToggleFileExplorer={handleToggleFileExplorer}
            onToggleTOC={handleToggleTOC}
            onToggleBacklinks={handleToggleBacklinks}
            onToggleHistory={handleToggleHistory}
            wordCount={wordCount}
            charCount={charCount}
            readingTimeMin={readingTimeMin}
            selectionLength={mode !== "preview" ? selectionLength : 0}
            selectionWordCount={selectionWordCount}
          />
        </>
      )}

      {/* Unsaved-changes dialog for window close — fed by the Tauri
          close-requested interception above, so it covers Alt+F4 and the
          taskbar close, not just the title bar X. */}
      {showUnsavedBeforeClose && (
        <Suspense fallback={null}>
          <UnsavedChangesDialog
            isOpen={showUnsavedBeforeClose}
            onClose={closeModal.unsavedBeforeClose}
            onDiscard={handleDiscardAndCloseWindow}
            onSave={handleSaveAndCloseWindow}
            dirtyNames={tabBarItems.filter((t) => t.dirty).map((t) => t.name)}
          />
        </Suspense>
      )}

      {/* Save/Discard/Cancel when closing a single dirty tab (Ctrl+W, the tab's
          × or middle-click). TABS-05. */}
      {closeTabPrompt && (
        <Suspense fallback={null}>
          <UnsavedChangesDialog
            isOpen={!!closeTabPrompt}
            onClose={() => setCloseTabPrompt(null)}
            onDiscard={handleDiscardCloseTab}
            onSave={handleSaveCloseTab}
            dirtyNames={[closeTabPrompt.fileName]}
          />
        </Suspense>
      )}

      {/* Fullscreen transition cover. Fades in over 150ms (we wait for that
          before resizing, so the mid-resize reflow is fully masked), then fades
          out over 300ms to reveal the settled layout — a smooth dip in and out.
          The 150ms fade-in duration is mirrored by FS_FADE_IN_MS. Sits above
          everything; pointer-events-none so it never eats a click. */}
      <div
        aria-hidden="true"
        className={`fixed inset-0 z-[200] bg-[var(--bg-primary)] pointer-events-none transition-[opacity,visibility] ease-out ${fsTransition ? "opacity-100 duration-150" : "opacity-0 invisible duration-300"}`}
      />

      {/* Loading overlay */}
      {isLoading && (
        <div className="fixed inset-0 z-[90] flex items-center justify-center bg-[var(--bg-primary)]/80 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-3">
            <span className="material-symbols-outlined text-[32px] text-[var(--accent)] animate-spin">progress_activity</span>
            <span className="text-sm text-[var(--text-secondary)]">Loading...</span>
          </div>
        </div>
      )}

      {/* Heavy modal surfaces — palette, settings, stats, cheatsheet — are
          off the cold-start critical path. They mount only when first
          opened so their bundles only download on demand. */}
      {showCheatsheet && (
        <Suspense fallback={null}>
          <ShortcutCheatsheet isOpen={showCheatsheet} onClose={closeModal.cheatsheet} />
        </Suspense>
      )}
      {/* Stats dialog reads LIVE `content`, not the debounced version. The
          dialog opens on a discrete user action (palette command), not while
          typing, so the typing-fast-path argument doesn't apply — and a user
          who opens "Show document statistics" expects the numbers to match
          what they just typed. */}
      {showStats && (
        <Suspense fallback={null}>
          <StatsDialog isOpen={showStats} content={content} onClose={closeModal.stats} />
        </Suspense>
      )}
      {showPalette && (
        <Suspense fallback={null}>
          <CommandPalette isOpen={showPalette} items={fullPaletteItems} onClose={closeModal.palette} />
        </Suspense>
      )}
      {showSearch && (
        <Suspense fallback={null}>
          <GlobalSearch
            isOpen={showSearch}
            directory={currentDirectory}
            onClose={closeModal.search}
            onOpenResult={handleOpenSearchResult}
          />
        </Suspense>
      )}
      {showSettings && (
        <Suspense fallback={null}>
          <SettingsModal
            isOpen={showSettings}
            initialJson={settingsJson}
            onClose={handleCloseSettings}
            onAiKeyPresenceChange={setHasAiKey}
          />
        </Suspense>
      )}

      {/* Tab right-click menu. TABS-12. */}
      {tabMenu && (() => {
        const menuTab = tabs.find((t) => t.id === tabMenu.id);
        const isActiveMenu = tabMenu.id === activeTabId;
        const menuPath = isActiveMenu ? filePath : (menuTab?.filePath ?? null);
        const idx = tabs.findIndex((t) => t.id === tabMenu.id);
        const hasRight = idx >= 0 && idx < tabs.length - 1;
        const others = tabs.length > 1;
        return (
          <TabContextMenu
            x={tabMenu.x}
            y={tabMenu.y}
            onClose={() => setTabMenu(null)}
            actions={[
              { label: "Close", icon: "close", onClick: () => closeTab(tabMenu.id) },
              { label: "Close others", icon: "close_fullscreen", disabled: !others, onClick: () => handleTabMenuAction("closeOthers", tabMenu.id) },
              { label: "Close to the right", icon: "keyboard_tab", disabled: !hasRight, onClick: () => handleTabMenuAction("closeRight", tabMenu.id) },
              {
                label: "Copy path", icon: "content_copy", dividerBefore: true, disabled: !menuPath,
                onClick: () => { if (menuPath) navigator.clipboard.writeText(menuPath).then(() => showToast("File path copied", "success"), () => showToast("Could not copy path", "error")); },
              },
              {
                label: "Reveal in folder", icon: "folder_open", disabled: !menuPath,
                onClick: () => { if (menuPath) revealItemInDir(menuPath).catch(() => showToast("Could not reveal file", "error")); },
              },
            ]}
          />
        );
      })()}

      {/* Toast notifications */}
      <ToastStack toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}

function App() {
  return (
    <ThemeProvider>
      <AppContent />
    </ThemeProvider>
  );
}

export default App;
