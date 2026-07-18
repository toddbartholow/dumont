// Modified by IRQ Studio, LLC (2026) from an Apache-2.0 licensed original.
// See NOTICE for attribution and license terms.

import { useRef, useCallback, useEffect, useState, memo } from "react";
import { EditorState as CMEditorState, Compartment, Prec } from "@codemirror/state";
import {
    EditorView,
    keymap,
    lineNumbers,
    highlightActiveLine,
    highlightActiveLineGutter,
    drawSelection,
    dropCursor,
    type ViewUpdate,
} from "@codemirror/view";
import { history, defaultKeymap, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { syntaxHighlighting, HighlightStyle } from "@codemirror/language";
import { autocompletion, closeBrackets, closeBracketsKeymap, type CompletionContext, type CompletionResult, type Completion } from "@codemirror/autocomplete";
import { unifiedMergeView, getChunks, getOriginalDoc } from "@codemirror/merge";
import { tags as t } from "@lezer/highlight";
import { getImageFromClipboard, saveImageToFile, createMarkdownImage } from "../utils/imageUtils";
import {
    handleTab,
    handleEnter,
    wrapSelection,
    insertLink,
    type EditorResult,
    type EditorState,
} from "../utils/editorActions";
import { useSetting } from "../settings/SettingsProvider";
import { FindReplaceBar } from "./FindReplaceBar";
import { FormatToolbar } from "./FormatToolbar";
import { SlashMenu, type SlashCommand } from "./SlashMenu";
import { AIBubble } from "./AIBubble";
import { TableToolbar } from "./TableToolbar";
import { pasteUrlOnSelection, pasteUrlAutolink, pasteTsvAsTable, htmlToMarkdown } from "../utils/smartPaste";
import { invoke } from "@tauri-apps/api/core";
import { matchWikilinkPrefix, rankFileNames, toWikiName } from "../utils/wikilinkComplete";
import { applyTableOp, findTableAt, locateCell, type Align } from "../utils/tableModel";
import type { Scroller } from "../utils/scrollSync";
import { useTheme } from "../context/ThemeContext";
import { ensureFontLoaded } from "../fonts";
import { fontStack } from "../utils/appearanceOptions";
import { Minimap, MINIMAP_WIDTH } from "./Minimap";

/** Below this editor-pane width the minimap is suppressed — it would take too
 *  big a bite out of the text column. Sized so the default 1000px window still
 *  shows it in split view (~470px per pane); the split can be dragged to 15%,
 *  which is where hiding it genuinely helps. */
const MINIMAP_MIN_PANE_WIDTH = 360;

interface CodeEditorProps {
    content: string;
    onChange: (content: string) => void;
    onCursorChange?: (line: number, column: number) => void;
    onSelectionChange?: (start: number, end: number) => void;
    onImagePaste?: () => void;
    onError?: (message: string) => void;
    onNotice?: (message: string) => void;
    filePath?: string | null;
    onScrollFraction?: (fraction: number) => void;
    registerScroller?: (scroller: Scroller | null) => void;
    typewriterMode?: boolean;
    showToolbar?: boolean;
    wordWrap?: boolean;
    spellCheck?: boolean;
    /** Show the VS Code-style document overview in the right margin. */
    minimap?: boolean;
    aiConfig?: { endpoint: string; model: string };
    /** When non-null, show this proposed document as an inline diff (CodeMirror
     *  merge view) for the user to accept/reject. Null = no review in progress. */
    reviewDoc?: string | null;
    /**
     * What the review banner calls this proposal. The merge view serves both Agent
     * mode and a version-history restore, and the restore is the user's own earlier
     * draft, so a hard-coded "AI suggested changes" would be a false claim about
     * where the text came from.
     */
    reviewLabel?: string;
    /** Called when the user finishes a review: the final document (accept) or
     *  null (rejected everything — keep the original). */
    onReviewResolve?: (finalDoc: string | null) => void;
    /** Bumped by App on every genuine document SWAP (tab switch, file open, new
     *  file) — as opposed to an in-document edit. On each bump the editor clears
     *  its undo history so Ctrl+Z can't reach back into the previous document (a
     *  data-loss bug: undo used to "un-swap" the file). TABS-03. */
    docSwapId?: number;
}

// Markdown syntax colors, driven by the same CSS variables the rest of the app
// themes with — so every theme "just works" in the editor too.
//
// Code spans and fences pin themselves to --font-mono rather than inheriting the
// chosen body font: indentation and table pipes only line up in a monospace
// face, and that has to hold even when the reader has picked a proportional one.
const markdownHighlight = HighlightStyle.define([
    { tag: t.heading1, color: "var(--syntax-h1)", fontWeight: "bold" },
    { tag: t.heading2, color: "var(--syntax-h2)", fontWeight: "bold" },
    { tag: [t.heading3, t.heading4, t.heading5, t.heading6], color: "var(--syntax-h3)", fontWeight: "600" },
    { tag: t.strong, color: "var(--syntax-bold)", fontWeight: "bold" },
    { tag: t.emphasis, fontStyle: "italic" },
    { tag: t.strikethrough, textDecoration: "line-through" },
    { tag: t.link, color: "var(--syntax-link)" },
    { tag: t.url, color: "var(--syntax-link)" },
    { tag: t.monospace, color: "var(--syntax-code)", fontFamily: "var(--font-mono)" },
    { tag: t.quote, color: "var(--syntax-quote)", fontStyle: "italic" },
    { tag: t.list, color: "var(--syntax-list)" },
    { tag: t.processingInstruction, color: "var(--syntax-list)" },
]);

const editorTheme = EditorView.theme({
    "&": {
        height: "100%",
        color: "var(--text-primary)",
        backgroundColor: "var(--bg-editor)",
        fontSize: "var(--font-size-editor)",
    },
    ".cm-scroller": {
        // The font picked in Settings, same as the preview. Was hard-coded to
        // JetBrains Mono, so the setting silently did nothing here.
        fontFamily: "var(--font-body)",
        lineHeight: "var(--line-height-editor)",
        overflow: "auto",
    },
    ".cm-content": {
        caretColor: "var(--accent)",
        padding: "16px 0",
    },
    ".cm-gutters": {
        backgroundColor: "var(--bg-gutter)",
        color: "var(--text-muted)",
        border: "none",
        borderRight: "1px solid var(--border-subtle)",
    },
    ".cm-activeLine": { backgroundColor: "var(--bg-hover)" },
    ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--text-primary)" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
        backgroundColor: "var(--selection-bg)",
    },
    // CodeMirror's base theme paints the FOCUSED selection through a
    // higher-specificity selector (&light.cm-focused > .cm-scroller > ...), so
    // without this mirror rule every theme showed the CM default lavender —
    // near-invisible against light-theme text. Selected-text color comes from
    // the global ::selection rule in index.css.
    "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground": {
        backgroundColor: "var(--selection-bg)",
    },
    ".cm-foldPlaceholder": { backgroundColor: "var(--bg-hover)", color: "var(--text-secondary)", border: "none" },
});

/** Build the EditorState shape the (tested) editorActions helpers expect. */
function toEdState(view: EditorView): EditorState {
    const s = view.state.selection.main;
    return { text: view.state.doc.toString(), selStart: s.from, selEnd: s.to };
}

/** Apply an EditorResult (full new text + selection) as a MINIMAL change — diff
 *  the common prefix/suffix so CodeMirror only touches what actually changed
 *  (keeps undo granular and avoids full-doc churn). Selection is set atomically,
 *  so there's no one-frame caret flicker (fixes the old rAF restore). */
function applyResultToView(view: EditorView, r: EditorResult) {
    const old = view.state.doc.toString();
    const next = r.text;
    let p = 0;
    const maxP = Math.min(old.length, next.length);
    while (p < maxP && old.charCodeAt(p) === next.charCodeAt(p)) p++;
    let s = 0;
    const maxS = Math.min(old.length - p, next.length - p);
    while (s < maxS && old.charCodeAt(old.length - 1 - s) === next.charCodeAt(next.length - 1 - s)) s++;
    view.dispatch({
        changes: { from: p, to: old.length - s, insert: next.slice(p, next.length - s) },
        selection: { anchor: r.selStart, head: r.selEnd },
        scrollIntoView: true,
    });
}

function CodeEditorImpl({
    content,
    onChange,
    onCursorChange,
    onSelectionChange,
    onImagePaste,
    onError,
    onNotice,
    filePath,
    onScrollFraction,
    registerScroller,
    typewriterMode,
    showToolbar,
    wordWrap = true,
    spellCheck = false,
    minimap = false,
    aiConfig,
    reviewDoc,
    reviewLabel = "AI suggested changes",
    onReviewResolve,
    docSwapId,
}: CodeEditorProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<EditorView | null>(null);
    // The same view as viewRef, as state — the Minimap is a child that renders
    // from it, and a ref mutation wouldn't trigger that render.
    const [editorView, setEditorView] = useState<EditorView | null>(null);

    // The editor's typeface and size come from the --font-body /
    // --font-size-editor / --line-height-editor CSS vars, i.e. the same Settings
    // choices the preview follows. CodeMirror caches measured character metrics,
    // so it has to be told to re-measure when either changes — otherwise the
    // caret and gutter stay aligned to the OLD font until the next resize.
    //
    // Alternate fonts are fetched lazily (see fonts.ts), so the swap lands one
    // or more frames after the class changes: re-measure again once the face has
    // actually loaded, or the metrics would be those of the fallback.
    const { font, fontSize } = useTheme();

    // A size change moves the line height, which changes the content box — that
    // alone is enough for CodeMirror to refresh its metrics on the next measure.
    useEffect(() => {
        viewRef.current?.requestMeasure();
    }, [fontSize]);

    // A FAMILY change is the hard case, and needs both halves of this.
    //
    // Timing: React runs child effects before parent ones, and ThemeProvider is
    // the parent — so at this point `ensureFontLoaded` has not been called yet.
    // Reading `document.fonts.ready` here would hand back the ALREADY-RESOLVED
    // promise of an idle font set and measure the fallback face a microtask
    // later, long before the woff2 lands. So await the actual load instead.
    //
    // Depth: even then, a bare requestMeasure() does not re-read glyph widths.
    // CodeMirror only calls measureTextSize() when it decides a full refresh is
    // due, and on a family swap nothing it watches changes — the line height is a
    // fixed px and the content box keeps its size. So charWidth stays the old
    // font's, and with word wrap on (the default) every wrap point and
    // click-to-position is computed from it. Re-applying the state rebuilds the
    // height map from freshly measured metrics; scroll and focus are restored
    // because setState resets both.
    useEffect(() => {
        let cancelled = false;
        // Resolves a bundled id or a custom stack. The primary family is what
        // document.fonts.load() below waits on before re-measuring.
        const primary = fontStack(font).split(",")[0].trim();

        const refresh = () => {
            const view = viewRef.current;
            if (!view || cancelled) return;
            const scrollTop = view.scrollDOM.scrollTop;
            const hadFocus = view.hasFocus;
            view.setState(view.state);
            view.scrollDOM.scrollTop = scrollTop;
            if (hadFocus) view.focus();
        };

        ensureFontLoaded(font)
            .then(() => (primary && document.fonts?.load
                ? document.fonts.load(`1em ${primary}`)
                : undefined))
            .then(refresh)
            .catch(() => { /* font failed to load; the fallback metrics stand */ });

        return () => { cancelled = true; };
    }, [font]);

    // Hide the minimap when the editor pane is too narrow to spare 80px for it.
    // The split can be dragged to 15%, which on a 1200px window leaves a 180px
    // pane — a minimap would eat nearly half of it.
    const [paneTooNarrow, setPaneTooNarrow] = useState(false);
    useEffect(() => {
        const el = containerRef.current?.parentElement;
        if (!el || typeof ResizeObserver === "undefined") return;
        const ro = new ResizeObserver(([entry]) => {
            setPaneTooNarrow(entry.contentRect.width < MINIMAP_MIN_PANE_WIDTH);
        });
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    const [findOpen, setFindOpen] = useState(false);
    const [findMode, setFindMode] = useState<"find" | "replace">("find");
    const [selStartForFind, setSelStartForFind] = useState(0);
    const [slashState, setSlashState] = useState<{ from: number; pos: { x: number; y: number } } | null>(null);
    const [slashQuery, setSlashQuery] = useState("");
    const [aiBubble, setAIBubble] = useState<{ x: number; y: number; selStart: number; selEnd: number; text: string } | null>(null);
    const [reviewActive, setReviewActive] = useState(false);
    // Floating table toolbar: set when the caret is inside a markdown table.
    const [tableUI, setTableUI] = useState<{ x: number; y: number; align: Align } | null>(null);

    // Suppressed during an AI diff review: the merge view injects deleted-chunk
    // widgets into the height map that the overview can't represent honestly.
    const showMinimap = minimap && !paneTooNarrow && !reviewActive;

    // Latest props read by the once-created CodeMirror extensions, kept in refs so
    // the view never has to be torn down and rebuilt on a callback/flag change.
    const onChangeRef = useRef(onChange); onChangeRef.current = onChange;
    const onCursorChangeRef = useRef(onCursorChange); onCursorChangeRef.current = onCursorChange;
    const onSelectionChangeRef = useRef(onSelectionChange); onSelectionChangeRef.current = onSelectionChange;
    const onScrollFractionRef = useRef(onScrollFraction); onScrollFractionRef.current = onScrollFraction;
    const onImagePasteRef = useRef(onImagePaste); onImagePasteRef.current = onImagePaste;
    const onErrorRef = useRef(onError); onErrorRef.current = onError;
    const onNoticeRef = useRef(onNotice); onNoticeRef.current = onNotice;
    const filePathRef = useRef(filePath); filePathRef.current = filePath;
    // Base names (without .md) of the sibling files, for `[[` autocomplete. Kept
    // in a ref so the once-created completion source always sees the latest list.
    const wikiNamesRef = useRef<string[]>([]);
    const aiConfigRef = useRef(aiConfig); aiConfigRef.current = aiConfig;
    const typewriterRef = useRef(typewriterMode); typewriterRef.current = typewriterMode;
    const slashStateRef = useRef(slashState); slashStateRef.current = slashState;

    // The last value WE emitted via onChange — lets the external-content sync
    // effect below skip the O(n) doc.toString() comparison on the common case
    // (the prop change is just our own keystroke echoing back through App state).
    const lastEmittedRef = useRef(content);
    // Live mirror of the `content` prop, read by the doc-swap effect without
    // making `content` one of its deps (it must fire ONLY on docSwapId).
    const contentPropRef = useRef(content);
    contentPropRef.current = content;

    // Reconfigurable extensions.
    const wrapCompRef = useRef(new Compartment());
    const spellCompRef = useRef(new Compartment());
    // history() lives in a compartment so a document swap can reset undo state
    // (reconfigure to [] then back) without rebuilding the whole editor. TABS-03.
    const historyCompRef = useRef(new Compartment());
    // AI review (merge view) state.
    const mergeCompRef = useRef(new Compartment());
    const reviewingRef = useRef(false);
    const reviewOriginalRef = useRef("");
    const lastReviewRef = useRef<string | null>(null);

    // `[[` autocomplete: when the caret is inside an open wikilink target, offer
    // the folder's other markdown files. Reads wikiNamesRef (refreshed below) so
    // the once-created editor always sees the current list. NAV-06.
    const wikiCompletionSource = useCallback((context: CompletionContext): CompletionResult | null => {
        const line = context.state.doc.lineAt(context.pos);
        const textBefore = line.text.slice(0, context.pos - line.from);
        const m = matchWikilinkPrefix(textBefore);
        if (!m) return null;
        const names = rankFileNames(wikiNamesRef.current, m.query);
        if (names.length === 0) return null;
        const from = line.from + m.from;
        // closeBrackets usually inserts `]]` already; only add it if it's missing.
        const hasClose = context.state.doc.sliceString(context.pos, context.pos + 2) === "]]";
        const options: Completion[] = names.map((name) => ({
            label: name,
            type: "text",
            apply: (view: EditorView, _c: Completion, fromPos: number, toPos: number) => {
                const insert = hasClose ? name : `${name}]]`;
                view.dispatch({
                    changes: { from: fromPos, to: toPos, insert },
                    // Land the caret just past the closing `]]`.
                    selection: { anchor: fromPos + name.length + 2 },
                });
            },
        }));
        return { from, options, validFor: /^[^\]\n|]*$/ };
    }, []);

    // Refresh the sibling-file list for `[[` autocomplete when the open file (and
    // thus its folder) changes, and when the window regains focus (files may have
    // been added/removed elsewhere). Excludes the open file itself.
    useEffect(() => {
        let cancelled = false;
        const fp = filePath;
        const norm = fp ? fp.replace(/\\/g, "/") : "";
        const lastSlash = norm.lastIndexOf("/");
        const dir = fp && lastSlash > 0 ? fp.slice(0, lastSlash) : null;
        if (!dir) { wikiNamesRef.current = []; return; }
        const load = () => {
            invoke<{ name: string; path: string }[]>("list_directory_files", { directory: dir })
                .then((entries) => {
                    if (cancelled) return;
                    wikiNamesRef.current = entries
                        .filter((e) => e.path !== fp)
                        .map((e) => toWikiName(e.name))
                        .filter(Boolean);
                })
                .catch(() => { if (!cancelled) wikiNamesRef.current = []; });
        };
        load();
        window.addEventListener("focus", load);
        return () => { cancelled = true; window.removeEventListener("focus", load); };
    }, [filePath]);

    const openAIBubble = useCallback(() => {
        const view = viewRef.current;
        if (!view) return;
        if (!aiConfigRef.current?.endpoint) {
            onNoticeRef.current?.("AI isn't set up yet — add an endpoint in Settings → AI to enable AI assist.");
            return;
        }
        const sel = view.state.selection.main;
        const coords = view.coordsAtPos(sel.head);
        const rect = view.scrollDOM.getBoundingClientRect();
        const x = coords ? coords.left : rect.left + 28;
        const y = (coords ? coords.bottom : rect.top + 24) + 6;
        setAIBubble({ x, y, selStart: sel.from, selEnd: sel.to, text: view.state.doc.sliceString(sel.from, sel.to) });
    }, []);

    // === One-time CodeMirror setup ===
    useEffect(() => {
        if (!containerRef.current) return;

        const wrapComp = wrapCompRef.current;
        const spellComp = spellCompRef.current;
        const mergeComp = mergeCompRef.current;
        const historyComp = historyCompRef.current;

        const editingKeymap = Prec.highest(keymap.of([
            { key: "Tab", run: (v) => runAction(v, (st) => handleTab(st, false)), shift: (v) => runAction(v, (st) => handleTab(st, true)) },
            { key: "Enter", run: (v) => runAction(v, handleEnter) },
            { key: "Mod-b", run: (v) => { applyResultToView(v, wrapSelection(toEdState(v), "**", "**", "bold")); return true; } },
            { key: "Mod-i", run: (v) => { applyResultToView(v, wrapSelection(toEdState(v), "*", "*", "italic")); return true; } },
            { key: "Mod-k", run: (v) => { applyResultToView(v, insertLink(toEdState(v))); return true; } },
            {
                key: "Mod-/", run: (v) => {
                    const st = toEdState(v);
                    const ls = st.text.lastIndexOf("\n", st.selStart - 1) + 1;
                    const lineEnd = st.text.indexOf("\n", st.selStart);
                    const end = lineEnd === -1 ? st.text.length : lineEnd;
                    const line = st.text.slice(ls, end);
                    const quoted = line.startsWith("> ");
                    const newLine = quoted ? line.slice(2) : "> " + line;
                    const delta = newLine.length - line.length;
                    applyResultToView(v, { text: st.text.slice(0, ls) + newLine + st.text.slice(end), selStart: st.selStart + delta, selEnd: st.selEnd + delta });
                    return true;
                }
            },
            { key: "Mod-f", run: (v) => { setSelStartForFind(v.state.selection.main.from); setFindMode("find"); setFindOpen(true); return true; } },
            // Replace. Mod-h is Ctrl+H on Windows and Linux, which is standard there.
            // On macOS Mod-h is Cmd+H, and Cmd+H is Hide: the OS matches a main-menu
            // key equivalent before the key ever reaches the webview, so the editor
            // never sees it and never has. Option+Cmd+F is where mac editors put
            // replace (VS Code included), so it is bound as well. Both are listed;
            // each platform reaches the one that is not spoken for.
            { key: "Mod-h", run: (v) => { setSelStartForFind(v.state.selection.main.from); setFindMode("replace"); setFindOpen(true); return true; } },
            { key: "Mod-Alt-f", run: (v) => { setSelStartForFind(v.state.selection.main.from); setFindMode("replace"); setFindOpen(true); return true; } },
            // NB: the AI shortcut (Alt+J / ⌘J) is handled at the App window level
            // so it fires regardless of editor focus — see App.tsx. The editor
            // opens the bubble via the dumont:ai-assist event listener below.
        ]));

        const updateListener = EditorView.updateListener.of((update: ViewUpdate) => {
            if (reviewingRef.current) {
                // During an AI review the editor shows the full PROPOSED text, but
                // the preview should show "original + the changes accepted so far".
                // @codemirror/merge's acceptChunk folds an accepted change into its
                // original document (rejectChunk reverts the editor doc instead), so
                // getOriginalDoc() IS exactly that running result — sync it to the
                // preview so accepting/rejecting a single change updates it live.
                let accepted: string | null = null;
                try { accepted = getOriginalDoc(update.state).toString(); } catch { /* merge field not ready */ }
                if (accepted !== null && accepted !== lastEmittedRef.current) {
                    lastEmittedRef.current = accepted;
                    onChangeRef.current?.(accepted);
                }
            } else if (update.docChanged) {
                const value = update.state.doc.toString();
                lastEmittedRef.current = value;
                onChangeRef.current?.(value);
            }
            if (update.selectionSet || update.docChanged) {
                const head = update.state.selection.main.head;
                const line = update.state.doc.lineAt(head);
                onCursorChangeRef.current?.(line.number, head - line.from + 1);
                const sel = update.state.selection.main;
                onSelectionChangeRef.current?.(sel.from, sel.to);
                detectSlash(update.view);
                detectTable(update.view);
                // Typewriter mode: recenter only while TYPING (docChanged), not on
                // mouse clicks / arrow navigation — clicking shouldn't yank the
                // viewport around.
                if (typewriterRef.current && update.docChanged) {
                    const pos = head;
                    requestAnimationFrame(() => {
                        const v = viewRef.current;
                        if (v) v.dispatch({ effects: EditorView.scrollIntoView(pos, { y: "center" }) });
                    });
                }
            }
        });

        const pasteHandler = EditorView.domEventHandlers({
            paste: (event, view) => handlePaste(event, view),
        });

        const view = new EditorView({
            parent: containerRef.current,
            state: CMEditorState.create({
                doc: content,
                extensions: [
                    lineNumbers(),
                    highlightActiveLineGutter(),
                    highlightActiveLine(),
                    historyComp.of(history()),
                    drawSelection(),
                    dropCursor(),
                    closeBrackets(),
                    autocompletion({ override: [wikiCompletionSource], icons: false, aboveCursor: false }),
                    markdown(),
                    syntaxHighlighting(markdownHighlight),
                    editorTheme,
                    wrapComp.of(wordWrap ? EditorView.lineWrapping : []),
                    spellComp.of(EditorView.contentAttributes.of(spellAttrs(spellCheck))),
                    mergeComp.of([]),
                    editingKeymap,
                    keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap]),
                    updateListener,
                    pasteHandler,
                    EditorView.theme({ "&": { outline: "none" } }),
                ],
            }),
        });
        viewRef.current = view;
        // Also as state: the Minimap renders from the view, and a ref assignment
        // doesn't re-render.
        setEditorView(view);
        lastEmittedRef.current = content;
        view.focus();

        return () => {
            view.destroy();
            viewRef.current = null;
            setEditorView(null);
        };
        // Created once; prop changes flow in via the effects + refs below.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Helper used by the editing keymap: run a (tested) editorActions function and
    // apply its result, or fall through to CodeMirror's default if it returns null.
    function runAction(view: EditorView, fn: (st: EditorState) => EditorResult | null): boolean {
        const r = fn(toEdState(view));
        if (!r) return false;
        applyResultToView(view, r);
        return true;
    }

    // Slash-command lifecycle, mirroring the previous textarea behavior but
    // reading only the current line (no full-doc scans).
    function detectSlash(view: EditorView) {
        const head = view.state.selection.main.head;
        const doc = view.state.doc;
        const cur = slashStateRef.current;
        if (cur) {
            if (head < cur.from + 1) { setSlashState(null); setSlashQuery(""); return; }
            const between = doc.sliceString(cur.from + 1, head);
            if (between.includes("\n") || between.includes(" ")) { setSlashState(null); setSlashQuery(""); return; }
            setSlashQuery(between);
            return;
        }
        if (head > 0 && doc.sliceString(head - 1, head) === "/") {
            const line = doc.lineAt(head);
            const lineHead = doc.sliceString(line.from, head - 1);
            if (lineHead === "" || /^\s*$/.test(lineHead) || /\s$/.test(lineHead)) {
                const coords = view.coordsAtPos(head - 1);
                if (coords) {
                    setSlashState({ from: head - 1, pos: { x: coords.left, y: coords.bottom + 4 } });
                    setSlashQuery("");
                }
            }
        }
    }

    // Show the floating table toolbar when the caret is inside a markdown table.
    // Cheap guard first (current line has a pipe), then scan only the contiguous
    // run of pipe-containing lines around the caret. The old version called
    // doc.toString() here — a full-document copy on EVERY cursor move that
    // landed on a pipe line, which is megabytes per keystroke on a huge doc.
    function detectTable(view: EditorView) {
        if (reviewingRef.current) { setTableUI(null); return; }
        const head = view.state.selection.main.head;
        const doc = view.state.doc;
        const curLine = doc.lineAt(head);
        if (!curLine.text.includes("|")) { setTableUI(null); return; }

        // Expand to the surrounding block of pipe lines (capped — no real
        // markdown table is anywhere near 500 rows).
        const CAP = 500;
        let first = curLine.number;
        while (first > 1 && curLine.number - first < CAP && doc.line(first - 1).text.includes("|")) first--;
        let last = curLine.number;
        while (last < doc.lines && last - curLine.number < CAP && doc.line(last + 1).text.includes("|")) last++;

        const sliceFrom = doc.line(first).from;
        const slice = doc.sliceString(sliceFrom, doc.line(last).to);

        const region = findTableAt(slice, head - sliceFrom);
        if (!region) { setTableUI(null); return; }
        const { colIndex } = locateCell(region, head - sliceFrom);
        const coords = view.coordsAtPos(region.from + sliceFrom);
        if (!coords) { setTableUI(null); return; }
        setTableUI({ x: coords.left, y: coords.top, align: region.model.aligns[colIndex] ?? "none" });
    }

    function handlePaste(event: ClipboardEvent, view: EditorView): boolean {
        const imageFile = getImageFromClipboard(event);
        if (imageFile) {
            event.preventDefault();
            if (!filePathRef.current) { onErrorRef.current?.("Please save your file first before pasting images."); return true; }
            (async () => {
                try {
                    const imagePath = await saveImageToFile(imageFile, filePathRef.current!);
                    const md = createMarkdownImage(imagePath, `image-${Date.now()}`);
                    const sel = view.state.selection.main;
                    view.dispatch({ changes: { from: sel.from, to: sel.to, insert: md }, selection: { anchor: sel.from + md.length } });
                    onImagePasteRef.current?.();
                } catch (error) {
                    const msg = typeof error === "string" ? error : (error as { message?: string })?.message;
                    onErrorRef.current?.(msg || "Failed to save image. Please try again.");
                }
            })();
            return true;
        }
        const cd = event.clipboardData;
        if (!cd) return false;
        const html = cd.getData("text/html");
        const text = cd.getData("text/plain");
        const state = toEdState(view);

        const urlOnSel = pasteUrlOnSelection(state, text);
        if (urlOnSel) { event.preventDefault(); applyResultToView(view, urlOnSel); return true; }
        const autolink = pasteUrlAutolink(state, text);
        if (autolink) { event.preventDefault(); applyResultToView(view, autolink); return true; }
        if (!html) {
            const tsv = pasteTsvAsTable(state, text);
            if (tsv) { event.preventDefault(); applyResultToView(view, tsv); return true; }
        }
        if (html && /<\w+/.test(html)) {
            event.preventDefault();
            (async () => {
                let insert = text;
                try { const md = (await htmlToMarkdown(html)).trim(); if (md) insert = md; } catch {/* fall back to plain text */ }
                const sel = view.state.selection.main;
                view.dispatch({ changes: { from: sel.from, to: sel.to, insert }, selection: { anchor: sel.from + insert.length } });
            })();
            return true;
        }
        return false; // let CodeMirror insert plain text
    }

    // Sync external content changes (file open, AI replace via App, frontmatter
    // edits) into the editor — skipping our own keystroke echoes cheaply.
    useEffect(() => {
        if (content === lastEmittedRef.current) return;
        const view = viewRef.current;
        if (!view) return;
        if (content !== view.state.doc.toString()) {
            view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: content } });
        }
        lastEmittedRef.current = content;
    }, [content]);

    // Reset undo history whenever App swaps the whole document for a different
    // file (tab switch, file open, new file). Without this, Ctrl+Z would undo
    // the swap itself and restore the PREVIOUS file's text into the current tab —
    // which autosave could then write to the wrong path. In-document edits
    // (checkbox toggles, AI, frontmatter) don't bump docSwapId, so they stay
    // undoable. Robust to effect order: if the content-sync effect above ran
    // first it recorded the swap in the OLD history, which we then discard; if it
    // hasn't run yet, `content` already equals the new doc so we set it here.
    // TABS-03.
    useEffect(() => {
        const view = viewRef.current;
        if (!view) return;
        const doc = contentPropRef.current;
        if (doc !== view.state.doc.toString()) {
            view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: doc } });
        }
        lastEmittedRef.current = doc;
        // Reconfigure the history compartment to a fresh instance — this is the
        // documented way to clear CodeMirror's undo/redo stacks.
        view.dispatch({ effects: historyCompRef.current.reconfigure([]) });
        view.dispatch({ effects: historyCompRef.current.reconfigure(history()) });
    }, [docSwapId]);

    // Reconfigure word-wrap / spellcheck when their props change.
    useEffect(() => {
        viewRef.current?.dispatch({ effects: wrapCompRef.current.reconfigure(wordWrap ? EditorView.lineWrapping : []) });
    }, [wordWrap]);
    useEffect(() => {
        viewRef.current?.dispatch({ effects: spellCompRef.current.reconfigure(EditorView.contentAttributes.of(spellAttrs(spellCheck))) });
    }, [spellCheck]);

    // Enter / refresh / exit the AI review (CodeMirror unified merge view). The
    // original side is the document as it was BEFORE the proposal; the editor doc
    // becomes the proposed text, and the merge view shows per-change ✓/✗ controls.
    useEffect(() => {
        const view = viewRef.current;
        if (!view) return;
        if (reviewDoc != null) {
            if (reviewingRef.current && reviewDoc === lastReviewRef.current) return;
            if (!reviewingRef.current) reviewOriginalRef.current = view.state.doc.toString();
            reviewingRef.current = true;
            lastReviewRef.current = reviewDoc;
            setReviewActive(true);
            view.dispatch({
                changes: { from: 0, to: view.state.doc.length, insert: reviewDoc },
                effects: mergeCompRef.current.reconfigure(unifiedMergeView({ original: reviewOriginalRef.current })),
            });
            // Bring the first proposed change into view so the user sees the diff
            // immediately instead of having to hunt for it (the change may be far
            // down a long document). Runs after the merge field computes chunks.
            requestAnimationFrame(() => {
                const v = viewRef.current;
                if (!v) return;
                const chunks = getChunks(v.state)?.chunks;
                if (chunks && chunks.length) {
                    v.dispatch({ effects: EditorView.scrollIntoView(chunks[0].fromB, { y: "center" }) });
                }
            });
        } else if (reviewingRef.current) {
            reviewingRef.current = false;
            lastReviewRef.current = null;
            setReviewActive(false);
            view.dispatch({ effects: mergeCompRef.current.reconfigure([]) });
        }
    }, [reviewDoc]);

    const acceptAllChanges = useCallback(() => {
        const view = viewRef.current;
        if (!view) return;
        const final = view.state.doc.toString();
        reviewingRef.current = false;
        lastReviewRef.current = null;
        setReviewActive(false);
        view.dispatch({ effects: mergeCompRef.current.reconfigure([]) });
        lastEmittedRef.current = final; // keep the App content-sync from re-dispatching
        onReviewResolve?.(final);
    }, [onReviewResolve]);

    const rejectAllChanges = useCallback(() => {
        const view = viewRef.current;
        if (!view) return;
        const orig = reviewOriginalRef.current;
        reviewingRef.current = false;
        lastReviewRef.current = null;
        setReviewActive(false);
        view.dispatch({
            changes: { from: 0, to: view.state.doc.length, insert: orig },
            effects: mergeCompRef.current.reconfigure([]),
        });
        lastEmittedRef.current = orig;
        // Pass the original explicitly (not null): the preview was live-tracking the
        // accepted-so-far document during review, so we must reset it all the way
        // back, not leave it on a partially-accepted state.
        onReviewResolve?.(orig);
    }, [onReviewResolve]);

    // Scroll-fraction sync (rAF-throttled — PREVIEW-04) + imperative scroller.
    const scrollRafRef = useRef(0);
    useEffect(() => {
        const view = viewRef.current;
        if (!view) return;
        const scroller = view.scrollDOM;
        const onScroll = () => {
            if (scrollRafRef.current) return;
            scrollRafRef.current = requestAnimationFrame(() => {
                scrollRafRef.current = 0;
                const max = scroller.scrollHeight - scroller.clientHeight;
                onScrollFractionRef.current?.(max > 0 ? scroller.scrollTop / max : 0);
            });
        };
        scroller.addEventListener("scroll", onScroll, { passive: true });
        return () => {
            scroller.removeEventListener("scroll", onScroll);
            if (scrollRafRef.current) cancelAnimationFrame(scrollRafRef.current);
        };
    }, []);

    useEffect(() => {
        if (!registerScroller) return;
        registerScroller({
            setFraction: (f: number) => {
                const view = viewRef.current;
                if (!view) return;
                const s = view.scrollDOM;
                const max = s.scrollHeight - s.clientHeight;
                if (max > 0) s.scrollTop = max * f;
            },
        });
        return () => registerScroller(null);
    }, [registerScroller]);

    // Jump-to-line requests from the TOC / command palette (NAV-01). The editor
    // moves its caret and scrolls the line to the top; in preview-only mode this
    // pane is display:none so the scroll is a harmless no-op.
    useEffect(() => {
        const handler = (e: Event) => {
            const line = Number((e as CustomEvent).detail?.line);
            const v = viewRef.current;
            if (!v || !Number.isFinite(line) || line < 1) return;
            const docLine = v.state.doc.line(Math.min(Math.floor(line), v.state.doc.lines));
            v.dispatch({
                selection: { anchor: docLine.from },
                effects: EditorView.scrollIntoView(docLine.from, { y: "start", yMargin: 8 }),
            });
        };
        window.addEventListener("dumont:goto-line", handler);
        return () => window.removeEventListener("dumont:goto-line", handler);
    }, []);

    // Snap the caret and viewport to the start when a different file opens, so
    // you don't begin a new file at the previous file's cursor/scroll. NAV-04.
    useEffect(() => {
        const toTop = () => {
            const v = viewRef.current;
            if (!v) return;
            v.dispatch({
                selection: { anchor: 0 },
                effects: EditorView.scrollIntoView(0, { y: "start" }),
            });
            v.scrollDOM.scrollTop = 0;
        };
        window.addEventListener("dumont:scroll-top", toTop);
        return () => window.removeEventListener("dumont:scroll-top", toTop);
    }, []);

    // The Settings "Enable AI" switch, straight from settings.json. It drives
    // whether the format toolbar shows its AI sparkle.
    //
    // This used to be a useState seeded from localStorage and kept in step by a
    // "dumont:ai-enabled-toggle" window event. The settings move deleted the
    // dispatcher, leaving a listener nobody fires and a value read from the OLD
    // store, so the sparkle stopped tracking the setting entirely. Reading the
    // setting is what the event bus was always approximating.
    const [aiEnabled] = useSetting<boolean>("ai.enabled");
    // The handler below is mounted once, so it cannot close over aiEnabled: it
    // would read whatever the flag was when the editor mounted, forever.
    const aiEnabledRef = useRef(aiEnabled);
    aiEnabledRef.current = aiEnabled;

    // Alt+J (and the command palette's "AI assist") is selection-aware, matching
    // the docs: with text selected it opens the inline selection-assist bubble;
    // with no selection it opens the docked AI side panel (chat about the doc).
    // App owns the panel's open state, so we ask it to toggle via an event.
    useEffect(() => {
        const handler = () => {
            // AI can be switched off entirely in Settings. Alt+J and the command
            // palette dispatch this event regardless, so gate here.
            if (!aiEnabledRef.current) return;
            const view = viewRef.current;
            if (!view) return;
            const sel = view.state.selection.main;
            if (sel.from !== sel.to) {
                view.focus();
                openAIBubble();
            } else {
                window.dispatchEvent(new CustomEvent("dumont:toggle-ai-panel"));
            }
        };
        window.addEventListener("dumont:ai-assist", handler);
        return () => window.removeEventListener("dumont:ai-assist", handler);
    }, [openAIBubble]);


    // === Imperative helpers for child UI (toolbar, find/replace, slash, AI) ===
    const getState = useCallback((): EditorState | null => {
        const v = viewRef.current;
        return v ? toEdState(v) : null;
    }, []);
    const applyResult = useCallback((r: EditorResult) => {
        const v = viewRef.current;
        if (v) { applyResultToView(v, r); v.focus(); }
    }, []);
    const insertAtCaret = useCallback((text: string) => {
        const v = viewRef.current;
        if (!v) return;
        const sel = v.state.selection.main;
        v.dispatch({ changes: { from: sel.from, to: sel.to, insert: text }, selection: { anchor: sel.from + text.length } });
        v.focus();
    }, []);

    const handleFindJump = useCallback((start: number, end: number) => {
        const v = viewRef.current;
        if (!v) return;
        // No v.focus() here: the find bar owns focus while open. Focusing the
        // editor on every auto-jump meant the keystroke after the 100ms match
        // debounce landed IN THE DOCUMENT, overwriting the matched text.
        // drawSelection keeps the match visible while the editor is unfocused;
        // onClose below hands focus back.
        v.dispatch({ selection: { anchor: start, head: end }, scrollIntoView: true });
    }, []);
    const handleFindReplace = useCallback((newContent: string, newCursor: number) => {
        const v = viewRef.current;
        if (!v) return;
        applyResultToView(v, { text: newContent, selStart: newCursor, selEnd: newCursor });
    }, []);

    const handleSlashSelect = useCallback((cmd: SlashCommand) => {
        const v = viewRef.current;
        const cur = slashStateRef.current;
        if (!v || !cur) return;
        const head = v.state.selection.main.head;
        const caretAt = cur.from + (cmd.caretOffset ?? cmd.snippet.length);
        v.dispatch({ changes: { from: cur.from, to: head, insert: cmd.snippet }, selection: { anchor: caretAt } });
        setSlashState(null);
        setSlashQuery("");
        v.focus();
    }, []);

    return (
        <main className="flex-1 flex flex-col overflow-hidden relative">
            {reviewActive && (
                <div className="flex items-center gap-2 px-3 h-9 shrink-0 bg-[var(--bg-secondary)] border-b border-[var(--accent)] text-xs no-select">
                    <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] animate-pulse"></span>
                    <span className="text-[var(--text-primary)] font-medium">{reviewLabel}</span>
                    <span className="text-[var(--text-secondary)] hidden sm:inline">accept or reject each below, or all at once:</span>
                    <div className="ml-auto flex items-center gap-1.5">
                        <button onClick={rejectAllChanges} className="px-2.5 py-1 rounded-[var(--radius-sm)] font-medium text-[var(--danger)] hover:bg-[var(--danger)]/10 transition-colors">Reject all</button>
                        <button onClick={acceptAllChanges} className="px-2.5 py-1 rounded-[var(--radius-sm)] font-medium bg-[var(--accent)] text-[var(--accent-text)] hover:opacity-90 transition-colors">Accept all</button>
                    </div>
                </div>
            )}
            {showToolbar && (
                <FormatToolbar getState={getState} apply={applyResult} insert={insertAtCaret} onAIAssist={aiEnabled ? openAIBubble : undefined} />
            )}
            <div className="flex-1 overflow-hidden relative">
                {/* The minimap is inline, not an overlay: the editor's right edge is
                    pulled in by exactly its width so it never covers text or the
                    scrollbar. Suppressed during an AI diff review — the merge view
                    injects widgets the overview can't meaningfully represent. */}
                <div
                    ref={containerRef}
                    style={{ right: showMinimap ? MINIMAP_WIDTH : 0 }}
                    className="absolute inset-y-0 left-0 [&_.cm-editor]:h-full [&_.cm-editor]:outline-none"
                />
                {showMinimap && editorView && (
                    <Minimap view={editorView} content={content} wordWrap={wordWrap} />
                )}

                <FindReplaceBar
                    isOpen={findOpen}
                    initialMode={findMode}
                    content={content}
                    selectionStart={selStartForFind}
                    onClose={() => { setFindOpen(false); viewRef.current?.focus(); }}
                    onJumpTo={handleFindJump}
                    onReplace={handleFindReplace}
                />

                <SlashMenu
                    isOpen={!!slashState}
                    position={slashState?.pos ?? null}
                    query={slashQuery}
                    onSelect={handleSlashSelect}
                    onClose={() => { setSlashState(null); setSlashQuery(""); }}
                />

                {aiConfig && aiBubble && (
                    <AIBubble
                        anchor={{ x: aiBubble.x, y: aiBubble.y }}
                        selectedText={aiBubble.text}
                        config={aiConfig}
                        onReplace={(out) => {
                            const v = viewRef.current;
                            if (v) v.dispatch({ changes: { from: aiBubble.selStart, to: aiBubble.selEnd, insert: out }, selection: { anchor: aiBubble.selStart + out.length } });
                            setAIBubble(null);
                            v?.focus();
                        }}
                        onInsert={(out) => {
                            const v = viewRef.current;
                            const ins = "\n\n" + out;
                            if (v) v.dispatch({ changes: { from: aiBubble.selEnd, to: aiBubble.selEnd, insert: ins }, selection: { anchor: aiBubble.selEnd + ins.length } });
                            setAIBubble(null);
                            v?.focus();
                        }}
                        onClose={() => setAIBubble(null)}
                    />
                )}

                {tableUI && (
                    <TableToolbar
                        anchor={{ x: tableUI.x, y: tableUI.y }}
                        activeAlign={tableUI.align}
                        onOp={(op) => {
                            const v = viewRef.current;
                            if (!v) return;
                            const r = applyTableOp(toEdState(v), op);
                            if (r) applyResultToView(v, r);
                            v.focus();
                        }}
                    />
                )}
            </div>
        </main>
    );
}

function spellAttrs(spellCheck: boolean): Record<string, string> {
    return {
        spellcheck: spellCheck ? "true" : "false",
        autocorrect: spellCheck ? "on" : "off",
        autocapitalize: "off",
    };
}

export const CodeEditor = memo(CodeEditorImpl);
