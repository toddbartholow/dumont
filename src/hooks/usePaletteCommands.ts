import { useMemo, useRef } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { settingsPath } from "../settings/store";
import { type PaletteCommand } from "../components/CommandPalette";
import type { ModalName } from "./useModals";
import { computeTabLabels, type TabState } from "../utils/tabsModel";
import { getRecentFiles } from "../utils/persistence";
import { THEMES } from "../utils/appearanceOptions";
import type { Theme } from "../context/ThemeContext";
import type { ViewMode } from "../components/ModeToggle";

const THEME_CHOICES = THEMES;

const IS_MAC =
    typeof navigator !== "undefined" && /mac/i.test(navigator.platform || navigator.userAgent || "");
const AI_SHORTCUT = IS_MAC ? "\u2318J" : "Alt+J";

/**
 * Everything the palette needs in order to describe itself.
 *
 * It is a long list, and that length is the honest measurement rather than a smell to be
 * hidden: the command palette IS the surface that can reach every other feature, so it
 * genuinely depends on every other feature's entry point. Extracting it did not create the
 * coupling, it made it countable.
 *
 * The object this arrives in is a fresh literal on every render, and that is fine. Nothing
 * memoises on the object; the hook destructures it and the memos inside depend on the
 * individual fields, which is what decides whether they hold.
 */
export interface PaletteCommandsInput {
    // Files
    handleNewFile: () => void;
    handleOpenFile: () => void;
    handleSaveFile: () => void;
    handleSaveAs: () => void;
    handleOpenTutorial: () => void;
    loadFile: (path: string) => void;
    closeTab: (id: string) => void;
    filePath: string | null;
    fileName: string | null;
    hasFile: boolean;

    // View
    handleToggleSplit: () => void;
    handleToggleFileExplorer: () => void;
    handleToggleTOC: () => void;
    handleToggleBacklinks: () => void;
    handleToggleHistory: () => void;
    toggleFullscreen: () => void;
    setMode: (m: ViewMode | ((prev: ViewMode) => ViewMode)) => void;

    // Overlays. ONE stable function, not three per-dialog setters.
    //
    // It was three, and that was a live bug for one commit: App passed
    // `() => showModal("stats")` and friends, which are fresh arrows on every render, and
    // these are dependencies of the paletteItems memo below, so the memo rebuilt on every
    // render of App. That is exactly the regression the two commits before this one existed
    // to kill, walked straight back in through the extraction's own parameter list.
    //
    // The extraction is what hid it. Inside App these were useState setters, which
    // exhaustive-deps knows are stable and never asks you to declare. As hook PARAMETERS the
    // rule cannot reason about what the caller passes, so it demands them as deps and then
    // has no way to see they are unstable. Lint, typecheck and the whole suite stay green
    // while the memo quietly dies. Taking `showModal` itself, which useModals memoises, means
    // there is one dep and it cannot go unstable.
    openSettings: (json?: boolean) => void;
    showModal: (name: ModalName) => void;
    showPalette: boolean;

    // Settings the palette can toggle
    typewriterModeEnabled: boolean;
    setTypewriterModeEnabled: (v: boolean | ((prev: boolean) => boolean)) => void;
    toolbarVisible: boolean;
    setToolbarVisible: (v: boolean | ((prev: boolean) => boolean)) => void;
    minimapEnabled: boolean;
    setMinimapEnabled: (v: boolean | ((prev: boolean) => boolean)) => void;
    aiEnabled: boolean;
    theme: Theme;
    setTheme: (t: Theme) => void;

    // Tabs and headings
    tabs: TabState[];
    activeTabId: string | null;
    activateTab: (id: string) => void;
    deferredContent: string;

    showToast: (message: string, type?: "success" | "error" | "info") => void;
}

/**
 * The command palette's item list.
 *
 * Lifted out of App.tsx, where it was 380 lines, 15% of a 2400-line component, and a pure
 * projection of state into a list that nothing else read. It moves as one piece because it
 * is one piece.
 *
 * The memo boundaries below are load-bearing and were hard-won; see the comments on each.
 * The short version: `paletteItems` must not depend on the document text, and it took a
 * linter and a measurement to make that true rather than merely intended.
 */
export function usePaletteCommands(input: PaletteCommandsInput): PaletteCommand[] {
    const {
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
    } = input;

        // Mirrored into a ref, exactly as App did, and for the reason App did it: the "Close
        // tab" command needs the CURRENT active tab when it runs, but `paletteItems` must not
        // list `activeTabId` as a dependency, or the whole item list would rebuild on every
        // tab switch. Reading it through a ref at run time keeps the memo held and the command
        // correct. (`activeTabId` is still passed in, because the Open-tabs section genuinely
        // does need to re-render when it changes.)
        const activeTabIdRef = useRef(activeTabId);
        activeTabIdRef.current = activeTabId;

    // Build the command palette item list. Rebuilds on relevant state changes —
    // recent files, current file, current view mode, toggles.
    const paletteItems = useMemo<PaletteCommand[]>(() => {
      const items: PaletteCommand[] = [];

      // === File ===
      items.push({
        id: "file.new",
        label: "New file",
        hint: "Ctrl+N",
        section: "File",
        icon: "edit_note",
        run: handleNewFile,
      });
      items.push({
        id: "file.open",
        label: "Open file…",
        hint: "Ctrl+O",
        section: "File",
        icon: "folder_open",
        run: handleOpenFile,
      });
      // Save / Save As only make sense when a buffer is open
      if (hasFile) {
        items.push({
          id: "file.save",
          label: "Save",
          hint: "Ctrl+S",
          section: "File",
          icon: "save",
          run: handleSaveFile,
        });
        items.push({
          id: "file.saveas",
          label: "Save As…",
          hint: "Ctrl+Shift+S",
          section: "File",
          icon: "save_as",
          run: handleSaveAs,
        });
      }
      if (filePath) {
        items.push({
          id: "file.reveal",
          label: "Reveal in folder",
          section: "File",
          icon: "folder_open",
          keywords: "show finder explorer locate",
          run: () => {
            revealItemInDir(filePath).catch((err) => {
              console.error("Reveal failed:", err);
              showToast("Could not reveal file", "error");
            });
          },
        });
        items.push({
          id: "file.copypath",
          label: "Copy file path",
          section: "File",
          icon: "content_copy",
          keywords: "clipboard absolute",
          run: () => {
            navigator.clipboard.writeText(filePath).then(
              () => showToast("File path copied", "success"),
              () => showToast("Could not copy path", "error"),
            );
          },
        });
      }
      if (hasFile) {
        items.push({
          id: "doc.stats",
          label: "Show document statistics",
          section: "File",
          icon: "analytics",
          keywords: "words count reading time",
          run: () => showModal("stats"),
        });
        items.push({
          id: "tab.close",
          label: "Close tab",
          hint: "Ctrl+W",
          section: "File",
          icon: "tab_close",
          keywords: "close current tab",
          run: () => { if (activeTabIdRef.current) closeTab(activeTabIdRef.current); },
        });
      }

      // === View === only when a buffer exists
      if (hasFile) {
        items.push({
          id: "view.preview",
          label: "Switch to Reader mode",
          hint: "Ctrl+E",
          section: "View",
          icon: "visibility",
          run: () => setMode("preview"),
        });
        items.push({
          id: "view.code",
          label: "Switch to Code editor",
          section: "View",
          icon: "code",
          run: () => setMode("code"),
        });
        items.push({
          id: "view.split",
          label: "Toggle Split view",
          hint: "Ctrl+\\",
          section: "View",
          icon: "vertical_split",
          run: handleToggleSplit,
        });
        items.push({
          id: "view.explorer",
          label: "Toggle file explorer",
          hint: "Ctrl+Shift+E",
          section: "View",
          icon: "folder",
          run: handleToggleFileExplorer,
        });
        items.push({
          id: "view.minimap",
          label: minimapEnabled ? "Hide minimap" : "Show minimap",
          section: "View",
          icon: "map",
          keywords: "minimap overview map editor margin",
          run: () => setMinimapEnabled((v) => !v),
        });
        items.push({
          id: "search.files",
          label: "Search in files…",
          hint: "Ctrl+Shift+F",
          section: "View",
          icon: "search",
          keywords: "find across folder grep global content",
          run: () => showModal("search"),
        });
        items.push({
          id: "view.toc",
          label: "Toggle outline",
          hint: "Ctrl+Shift+O",
          section: "View",
          icon: "format_list_bulleted",
          run: handleToggleTOC,
        });
        items.push({
          id: "view.backlinks",
          label: "Toggle backlinks",
          hint: "Ctrl+Shift+B",
          section: "View",
          icon: "link",
          keywords: "backlinks linked mentions wikilink references incoming links",
          run: handleToggleBacklinks,
        });
        items.push({
          id: "view.history",
          label: "Toggle version history",
          hint: "Ctrl+Shift+H",
          section: "View",
          icon: "history",
          keywords: "history versions snapshots restore revert undo previous older backup",
          run: handleToggleHistory,
        });
      }

      // Fullscreen works anywhere (including the welcome screen), so unlike the
      // other View entries it isn't gated on a file being open.
      items.push({
        id: "view.fullscreen",
        label: "Toggle fullscreen",
        hint: "F11",
        section: "View",
        icon: "fullscreen",
        keywords: "full screen distraction free f11 immersive",
        run: toggleFullscreen,
      });

      // === AI === only when a buffer exists and AI is enabled in Settings.
      // The command palette is the always-reachable entry point for AI assist
      // (the toolbar AI button is hidden when the toolbar is off). Dispatches a
      // window event the editor listens for; if AI isn't configured the editor
      // shows a guiding notice.
      if (hasFile && aiEnabled) {
        items.push({
          id: "ai.assist",
          label: "AI assist on selection",
          hint: AI_SHORTCUT,
          section: "AI",
          icon: "auto_awesome",
          keywords: "ai rewrite shorten expand continue translate assistant gpt llm",
          run: () => window.dispatchEvent(new CustomEvent("dumont:ai-assist")),
        });
      }

      // === Toggles ===
      items.push({
        id: "toggle.typewriter",
        label: typewriterModeEnabled ? "Disable Typewriter mode" : "Enable Typewriter mode",
        section: "Toggles",
        icon: "keyboard",
        keywords: "scroll caret center",
        run: () => setTypewriterModeEnabled((v) => !v),
      });
      items.push({
        id: "toggle.toolbar",
        label: toolbarVisible ? "Hide formatting toolbar" : "Show formatting toolbar",
        section: "Toggles",
        icon: "format_paint",
        run: () => setToolbarVisible((v) => !v),
      });

      // === Theme === switch directly from the palette. The welcome tour tells
      // users themes live here, and it makes the themes discoverable without
      // opening Settings. The active theme is marked and skipped as a no-op.
      for (const t of THEME_CHOICES) {
        items.push({
          id: `theme.${t.id}`,
          label: theme === t.id ? `Theme: ${t.name} (current)` : `Change theme to ${t.name}`,
          section: "Theme",
          icon: "palette",
          keywords: "theme color appearance dark light paper dracula vs 2017 visual studio",
          run: () => setTheme(t.id),
        });
      }

      items.push({
        id: "settings.open",
        label: "Preferences: Open Settings",
        hint: "Ctrl+,",
        section: "Toggles",
        icon: "settings",
        keywords: "preferences settings options configure",
        run: () => openSettings(),
      });

      items.push({
        id: "settings.json",
        label: "Preferences: Open Settings (JSON)",
        section: "Toggles",
        icon: "data_object",
        keywords: "preferences settings json file edit raw configure",
        run: () => openSettings(true),
      });

      items.push({
        id: "settings.reveal",
        label: "Preferences: Show settings.json in the file manager",
        section: "Toggles",
        icon: "folder_open",
        keywords: "settings json reveal finder explorer folder locate",
        // Nothing to reveal until something has been changed from the defaults.
        run: () => { void settingsPath().then(revealItemInDir).catch(() => { }); },
      });

      // === Help ===
      items.push({
        id: "help.cheatsheet",
        label: "Show keyboard shortcuts",
        hint: "?",
        section: "Help",
        icon: "keyboard",
        run: () => showModal("cheatsheet"),
      });    items.push({
        id: "help.guide",
        label: "Open the interactive guide",
        section: "Help",
        icon: "menu_book",
        keywords: "tutorial guide features demo sample example math diagram mermaid learn",
        run: handleOpenTutorial,
      });

      // === Recent files ===
      const recents = getRecentFiles();
      for (const r of recents) {
        if (r.path === filePath) continue; // current file
        items.push({
          id: `recent.${r.path}`,
          label: r.name,
          hint: r.path,
          section: "Recent files",
          icon: "description",
          keywords: r.path,
          run: () => loadFile(r.path),
        });
      }

      return items;
    }, [
      // NB: deferredContent is intentionally NOT a dep here. Building static
      // file/view/toggle/recent items doesn't depend on the document text, so
      // letting `content` flow into this useMemo would rebuild every keystroke
      // (post-debounce) for no reason. Headings are computed below in a
      // separate hook that's gated on the palette actually being open.
      //
      // That was the intent, and it was not what happened. The list was INCOMPLETE
      // (openSettings, setMode, setToolbarVisible and setTypewriterModeEnabled were all used
      // in the body and none were declared), and it was poisoned from two directions:
      // useSetting handed back a new setter on every render, and handleSaveFile/handleSaveAs
      // closed over `content`, which changes on every keystroke. Note that `content` is the
      // UNDEBOUNCED stream: the comment above worries about deferredContent leaking in, and
      // what actually leaked in was worse than the thing it feared.
      //
      // Both are fixed (useSetting's setter is memoised; the save callbacks read liveRef), and
      // this was MEASURED rather than assumed, because the previous version of this comment
      // was confidently wrong. Instrumenting the memo body and driving three content changes
      // through the running app: 6 rebuilds before, 0 after.
      handleNewFile, handleOpenFile, handleSaveFile, handleSaveAs, handleOpenTutorial,
      handleToggleSplit, handleToggleFileExplorer, handleToggleTOC, handleToggleBacklinks,
      handleToggleHistory,
      toggleFullscreen, openSettings, setMode,
      // ONE stable function, where three unstable arrows used to be, and this dependency list
      // is exactly where the regression landed. See the note on `showModal` in the input
      // interface. There is nothing left to pass here that could be unstable.
      showModal,
      loadFile, filePath, hasFile, showToast, closeTab,
      typewriterModeEnabled, setTypewriterModeEnabled,
      toolbarVisible, setToolbarVisible,
      aiEnabled, minimapEnabled, setMinimapEnabled,
      theme, setTheme,
    ]);

    // Heading items are recomputed only while the palette is actually open.
    // Scanning every line of the document for `#`-prefixed headings on every
    // typing pause used to be cheap on small docs and noticeable on large
    // ones — and 100 % of that work was discarded if the user wasn't looking
    // at the palette.
    const headingPaletteItems = useMemo<PaletteCommand[]>(() => {
      if (!showPalette || !deferredContent) return [];
      const items: PaletteCommand[] = [];
      const lines = deferredContent.split("\n");
      lines.forEach((line, idx) => {
        const m = line.match(/^(#{1,6})\s+(.+)$/);
        if (m) {
          const level = m[1].length;
          const text = m[2].trim();
          items.push({
            id: `head.${idx}`,
            label: text,
            hint: `H${level}`,
            section: "Headings",
            icon: level === 1 ? "title" : level === 2 ? "format_h2" : "format_h3",
            keywords: "jump heading",
            run: () => {
              // Jump both panes to the heading's source line. The editor and the
              // preview each listen for this event and scroll themselves (hidden
              // panes scroll harmlessly), so this works in every view mode and
              // lands on the RIGHT heading even when titles repeat. NAV-01.
              window.dispatchEvent(new CustomEvent("dumont:goto-line", { detail: { line: idx + 1 } }));
            },
          });
        }
      });
      return items;
    }, [showPalette, deferredContent]);

    // "Open tabs" palette section — jump to any open tab by name (only worthwhile
    // with more than one open). Uses the same folder disambiguation as the bar. TABS-11.
    const tabPaletteItems = useMemo<PaletteCommand[]>(() => {
      if (tabs.length < 2) return [];
      const resolved = tabs.map((t) => ({
        id: t.id,
        fileName: t.id === activeTabId ? (fileName ?? "Untitled.md") : t.fileName,
        filePath: t.id === activeTabId ? filePath : t.filePath,
      }));
      const labels = computeTabLabels(resolved);
      return tabs.map((t) => ({
        id: `opentab.${t.id}`,
        label: `${labels.get(t.id) ?? t.fileName}${t.id === activeTabId ? " (current)" : ""}`,
        section: "Open tabs",
        icon: "tab",
        keywords: "switch tab open file",
        run: () => activateTab(t.id),
      }));
    }, [tabs, activeTabId, fileName, filePath, activateTab]);

    // Concatenated list passed to the palette. Same `paletteItems` shape as
    // before so the CommandPalette component sees no API change. Reference
    // changes only when one of the sources changes — typically rare.
    const fullPaletteItems = useMemo<PaletteCommand[]>(
        () => [...paletteItems, ...tabPaletteItems, ...headingPaletteItems],
        [paletteItems, tabPaletteItems, headingPaletteItems]
      );

      return fullPaletteItems;
}
