// Modified by IRQ Studio, LLC (2026) from an Apache-2.0 licensed original.
// See NOTICE for attribution and license terms.

/**
 * settings.json, edited in the app.
 *
 * The grouped panes and this editor are two views of one file, not two stores. A
 * toggle flipped in the UI shows up here on the next open; a key typed here takes
 * effect the moment it saves. Neither is the "real" one.
 *
 * The hard part is not the editor, it is not fighting the file:
 *
 *  - What is on screen is a DRAFT. It is not written until you save, because
 *    saving every keystroke would mean a half-typed `"appearance.theme": "dr` is
 *    briefly the user's real theme, and the app would flicker through garbage
 *    while they type.
 *
 *  - If the file changes on disk while there are unsaved edits here, the draft is
 *    NOT replaced. Someone else's write does not get to silently discard what you
 *    typed; you are told, and you choose. That path is real: the grouped pane in
 *    this very modal writes the file.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { json } from "@codemirror/lang-json";
import { syntaxHighlighting, HighlightStyle, bracketMatching, indentOnInput } from "@codemirror/language";
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { linter, lintGutter, lintKeymap } from "@codemirror/lint";
import { tags as t } from "@lezer/highlight";
import { useSettings } from "../settings/SettingsProvider";
import { settingsCompletions, settingsLinter } from "../settings/jsonSupport";

/**
 * Every color comes from the theme's CSS variables, so the JSON editor changes
 * theme with everything else rather than pinning one palette.
 *
 * These are TEXT, on --bg-input, and on --bg-hover wherever the caret's line is.
 * That makes 4.5:1 the bar on every theme, which rules out most of the palette:
 * every --syntax-* token falls below it somewhere (--syntax-code bottoms out at
 * 3.48:1, and --accent at 2.37:1, which is the number this project already knows
 * by heart). So the tokens here are the ones the contrast validator guarantees:
 * --focus-ring is held to 4.5:1 on --bg-hover, and --text-primary and
 * --text-secondary are held to it everywhere.
 *
 * The first version of this reached for var(--syntax-heading), var(--syntax-string)
 * and var(--syntax-keyword). NONE of those tokens exists, in any theme, so the
 * fallback silently won every time and the property names, which are the actual
 * content of settings.json, were painted in --accent: 2.37:1 on the active line in
 * vs2017. A CSS variable that does not exist fails quietly, which is exactly why
 * jsonEditorTokens is asserted against the registry in the tests.
 *
 * The comment color is --text-muted on purpose, as in every code editor, and is
 * the one deliberate exception. It is also the token this project exempts from the
 * contrast floor by design.
 */
const highlight = HighlightStyle.define([
    { tag: t.propertyName, color: "var(--focus-ring)" },
    { tag: t.string, color: "var(--text-primary)" },
    { tag: t.number, color: "var(--text-secondary)" },
    { tag: t.bool, color: "var(--text-secondary)" },
    { tag: t.null, color: "var(--text-secondary)" },
    { tag: t.comment, color: "var(--text-muted)", fontStyle: "italic" },
    { tag: t.separator, color: "var(--text-muted)" },
]);

/** The tokens above that carry TEXT, so a test can hold them to the 4.5:1 bar. */
export const JSON_EDITOR_TEXT_TOKENS = [
    "--focus-ring",
    "--text-primary",
    "--text-secondary",
] as const;

const theme = EditorView.theme({
    "&": {
        height: "100%",
        fontSize: "13px",
        backgroundColor: "var(--bg-input)",
        color: "var(--text-primary)",
    },
    "&.cm-focused": { outline: "none" },
    ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.6" },
    ".cm-gutters": {
        backgroundColor: "var(--bg-input)",
        color: "var(--text-muted)",
        border: "none",
    },
    ".cm-activeLine": { backgroundColor: "var(--bg-hover)" },
    ".cm-activeLineGutter": { backgroundColor: "var(--bg-hover)", color: "var(--text-secondary)" },
    ".cm-cursor": { borderLeftColor: "var(--focus-ring)" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
        backgroundColor: "var(--accent)",
        opacity: 0.25,
    },
    ".cm-tooltip": {
        backgroundColor: "var(--bg-secondary)",
        border: "1px solid var(--border)",
        color: "var(--text-primary)",
    },
    ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
        backgroundColor: "var(--bg-hover)",
        color: "var(--text-primary)",
    },
});

interface Props {
    /** Leave the JSON view, back to the grouped panes. */
    onDone: () => void;
    /** So the modal can refuse to close on top of unsaved edits. */
    onDirtyChange?: (dirty: boolean) => void;
}

/** What the modal may do to the draft from outside. */
export interface SettingsJsonHandle {
    /** Save the draft. False when it does not parse, in which case the editor is
     *  showing the reason and the caller must not close over it. */
    save: () => Promise<boolean>;
}

export const SettingsJsonEditor = forwardRef<SettingsJsonHandle, Props>(function SettingsJsonEditor(
    { onDone, onDirtyChange }: Props,
    ref,
) {
    const { text, saveText } = useSettings();
    const host = useRef<HTMLDivElement>(null);
    const view = useRef<EditorView | null>(null);

    const [dirty, setDirty] = useState(false);
    const [saveError, setSaveError] = useState<string | null>(null);
    const [saved, setSaved] = useState(false);
    /** The file moved under us while we had unsaved edits. Holds the new text. */
    const [conflict, setConflict] = useState<string | null>(null);

    // Save is reached from a keymap that is built ONCE, so it must not close over
    // stale state. A ref keeps the handler current without rebuilding the editor.
    const saveRef = useRef<() => void>(() => { });

    // The document as last read from or written to disk. What "changed on disk"
    // and "dirty" are both measured against.
    const baseline = useRef(text);

    useEffect(() => {
        if (!host.current || view.current) return;

        const v = new EditorView({
            parent: host.current,
            state: EditorState.create({
                doc: text || "{\n  \n}\n",
                extensions: [
                    lineNumbers(),
                    highlightActiveLine(),
                    highlightActiveLineGutter(),
                    history(),
                    bracketMatching(),
                    closeBrackets(),
                    indentOnInput(),
                    json(),
                    syntaxHighlighting(highlight),
                    lintGutter(),
                    linter(settingsLinter),
                    autocompletion({ override: [settingsCompletions] }),
                    theme,
                    EditorView.lineWrapping,
                    keymap.of([
                        // Before defaultKeymap: on macOS Cmd+S is otherwise unbound
                        // here and would fall through to the browser/webview.
                        { key: "Mod-s", preventDefault: true, run: () => { saveRef.current(); return true; } },
                        ...closeBracketsKeymap,
                        ...defaultKeymap,
                        ...historyKeymap,
                        ...completionKeymap,
                        ...lintKeymap,
                        indentWithTab,
                    ]),
                    EditorView.updateListener.of((u) => {
                        if (!u.docChanged) return;
                        setDirty(u.state.doc.toString() !== baseline.current);
                        setSaved(false);
                        setSaveError(null);
                    }),
                ],
            }),
        });
        view.current = v;
        v.focus();

        return () => { v.destroy(); view.current = null; };
        // Mounted once. `text` is the seed, and after that the file and the draft
        // are reconciled deliberately, in the effect below.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // The file changed on disk (a grouped-pane toggle, another editor, another
    // machine). Take it only when there is nothing to lose.
    useEffect(() => {
        const v = view.current;
        if (!v || text === baseline.current) return;

        const draft = v.state.doc.toString();
        if (draft !== baseline.current) {
            // Unsaved edits. Do not touch the buffer: offer the choice instead.
            setConflict(text);
            return;
        }
        baseline.current = text;
        v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text } });
        setDirty(false);
    }, [text]);

    const takeTheirs = () => {
        const v = view.current;
        if (!v || conflict === null) return;
        baseline.current = conflict;
        v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: conflict } });
        setConflict(null);
        setDirty(false);
    };

    const save = async (): Promise<boolean> => {
        const v = view.current;
        if (!v) return false;
        const draft = v.state.doc.toString();
        try {
            await saveText(draft);

            baseline.current = draft;
            setSaveError(null);
            setSaved(true);
            // The conflicting write is moot once ours lands on top of it.
            setConflict(null);

            // Re-read the doc: it is not necessarily `draft` any more. A save is an
            // IPC round trip, and the user can keep typing through it. Clearing
            // `dirty` against the text we SENT would mark those new characters
            // clean, which disables the Save button and lets the modal close over
            // them without asking. So compare what is in the buffer NOW.
            const live = v.state.doc.toString();
            setDirty(live !== baseline.current);
            return true;
        } catch (e) {
            // Invalid JSON never reaches the disk. Say where, and keep the draft.
            setSaveError((e as Error).message);
            return false;
        }
    };
    saveRef.current = () => { void save(); };

    useImperativeHandle(ref, () => ({ save }));
    useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
    // The draft dies with this component, so a close that unmounts it while dirty
    // would lose work. Tell the modal we are clean on the way out only because it
    // has already decided (see requestClose) that it is safe to unmount us.
    useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

    return (
        <div className="flex flex-col h-full min-h-0">
            {conflict !== null && (
                <div role="status" className="flex items-center justify-between gap-3 px-3 py-2 text-[12px] border-b border-[var(--border)] bg-[var(--bg-secondary)]">
                    <span className="text-[var(--text-secondary)]">
                        settings.json changed on disk. Your unsaved edits are still here.
                    </span>
                    <span className="flex gap-2 shrink-0">
                        <button
                            type="button"
                            onClick={takeTheirs}
                            className="px-2 py-1 rounded-[var(--radius-sm)] border border-[var(--border)] text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
                        >
                            Discard mine, load the file
                        </button>
                        <button
                            type="button"
                            onClick={() => void save()}
                            className="px-2 py-1 rounded-[var(--radius-sm)] bg-[var(--accent)] text-[var(--accent-text)]"
                        >
                            Keep mine, overwrite
                        </button>
                    </span>
                </div>
            )}

            <div ref={host} className="flex-1 min-h-0 overflow-hidden border border-[var(--border)] rounded-[var(--radius-md)]" />

            <div className="flex items-center justify-between gap-3 pt-3 shrink-0">
                <span className="text-[11px] min-w-0 truncate" role={saveError ? "alert" : undefined}>
                    {saveError ? (
                        <span className="text-[var(--danger-text)]">Not saved: {saveError}</span>
                    ) : dirty ? (
                        <span className="text-[var(--text-secondary)]">Unsaved changes</span>
                    ) : saved ? (
                        <span className="text-[var(--status-saved)]">Saved</span>
                    ) : (
                        <span className="text-[var(--text-secondary)]">
                            Ctrl/Cmd+Space for the list of settings. Comments are kept.
                        </span>
                    )}
                </span>
                <span className="flex items-center gap-2 shrink-0">
                    <button
                        type="button"
                        onClick={onDone}
                        className="px-3 py-1.5 text-sm rounded-[var(--radius-md)] border border-[var(--border)] text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
                    >
                        Done
                    </button>
                    <button
                        type="button"
                        onClick={() => void save()}
                        disabled={!dirty}
                        className="px-3 py-1.5 text-sm rounded-[var(--radius-md)] bg-[var(--accent)] text-[var(--accent-text)] disabled:opacity-50 transition-opacity"
                    >
                        Save
                    </button>
                </span>
            </div>
        </div>
    );
});
