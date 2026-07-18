// Modified by IRQ Studio, LLC (2026) from an Apache-2.0 licensed original.
// See NOTICE for attribution and license terms.

import { lazy, Suspense, useCallback, useEffect, useId, useRef, useState } from "react";
import type { SettingsJsonHandle } from "./SettingsJsonEditor";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useTheme } from "../context/ThemeContext";
import { useSetting, useSettings } from "../settings/SettingsProvider";
import { SETTING_BY_KEY } from "../settings/schema";
import { settingsPath } from "../settings/store";

// Pulls in CodeMirror and the JSON grammar. Most people never open the JSON view,
// and the ones who do can wait a frame for it.
const SettingsJsonEditor = lazy(() =>
    import("./SettingsJsonEditor").then((m) => ({ default: m.SettingsJsonEditor })),
);
// The API key, and only the key. It lives in the OS keychain, not in settings.json,
// because a config file is plaintext and a credential is not a preference. The
// endpoint and the model ARE settings and are read through useSetting below. The
// stored key is never read back into the webview (SECURITY-01); the field can only
// SET a new one or report, via aiKeyPresent(), that one exists.
import { setAIKey, aiKeyPresent } from "../utils/persistence";
import { AI_PROVIDERS, matchProvider, type AIProvider } from "../utils/aiProviders";
import { attachFocusTrap } from "../utils/focusTrap";
import { isValidEndpoint, runAIAction } from "../utils/aiAssist";
import { THEMES, FONTS, fontStack, isBundledFont } from "../utils/appearanceOptions";
import { resolveTheme } from "../themes";
import { themesDir } from "../themes/userThemes";
import { FontSizeField } from "./FontSizeField";
import { Select, type SelectOption } from "./Select";
import { READER_WIDTH_TIERS, readerWidthHint } from "../utils/readerWidth";
import { getAppVersion, BUILD_VERSION } from "../utils/appVersion";

// Platform-aware AI shortcut hint (Windows/Linux: Alt+J; macOS: ⌘J). Windows
// can't use Ctrl+J because WebView2 reserves it for its Downloads UI.
const IS_MAC = typeof navigator !== "undefined" && /mac/i.test(navigator.platform || navigator.userAgent || "");
const AI_SHORTCUT = IS_MAC ? "⌘J" : "Alt+J";

interface SettingsModalProps {
    isOpen: boolean;
    onClose: () => void;
    /** Open straight into the raw JSON view. The command palette's "Open Settings
     *  (JSON)" lands here, as in VS Code. */
    initialJson?: boolean;
    /** Called after the AI key field is committed, with whether a key is now saved.
     *  Lets the parent keep its "a key exists" state accurate without ever reading
     *  the value, and without racing the write (SECURITY-01). */
    onAiKeyPresenceChange?: (present: boolean) => void;
}

type Section = "appearance" | "editor" | "ai" | "about";

const sections: Array<{ id: Section; label: string; icon: string }> = [
    { id: "appearance", label: "Appearance", icon: "palette" },
    { id: "editor", label: "Editor", icon: "edit" },
    { id: "ai", label: "AI", icon: "auto_awesome" },
    { id: "about", label: "About", icon: "info" },
];

// Reader-width dropdown options, derived from the shared tier list so labels,
// hints and order can't drift from the schema and the preview.
const READER_WIDTH_OPTIONS: readonly SelectOption<string>[] = READER_WIDTH_TIERS.map((t) => ({
    value: t.id,
    label: t.label,
    hint: readerWidthHint(t),
}));

// Themes and fonts come from utils/appearanceOptions.ts — the same list the gear
// dropdown renders, so the two surfaces can't drift apart again.
const themes = THEMES;
const fonts = FONTS;

interface ToggleRowProps {
    label: string;
    description: string;
    checked: boolean;
    onChange: (v: boolean) => void;
}

function ToggleRow({ label, description, checked, onChange }: ToggleRowProps) {
    return (
        <button
            type="button"
            role="switch"
            aria-checked={checked}
            onClick={() => onChange(!checked)}
            className="group w-full flex items-center justify-between gap-4 px-3.5 py-3 hover:bg-[var(--bg-hover)] transition-colors text-left"
        >
            <div className="flex flex-col items-start min-w-0">
                <span className="text-sm font-medium text-[var(--text-primary)]">{label}</span>
                <span className="text-[11px] text-[var(--text-secondary)] mt-0.5">{description}</span>
            </div>
            <span
                className={`relative inline-block w-[42px] h-[24px] rounded-full shrink-0 transition-colors duration-200 ${checked ? "bg-[var(--accent)]" : "bg-[var(--text-muted)]/45 group-hover:bg-[var(--text-muted)]/60"}`}
            >
                <span
                    className={`absolute top-[3px] left-[3px] w-[18px] h-[18px] rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,0.3)] transition-transform duration-200 ease-out ${checked ? "translate-x-[18px]" : "translate-x-0"}`}
                />
            </span>
        </button>
    );
}

interface NumberRowProps {
    settingKey: string;
    label: string;
    description: string;
    value: number;
    onChange: (v: number) => void;
    /** Rendered after the field: "snapshots", "seconds". */
    suffix: string;
}

/**
 * A bounded number, edited as text.
 *
 * The bounds are read from the schema by key, not passed in: they are declared
 * once in schema.ts, where the linter and `coerce` also read them, and a second
 * copy typed into a JSX prop is a second copy to forget to update.
 *
 * The field holds a DRAFT string rather than writing on every keystroke. Typing
 * "120" over "60" passes through "1", and a straight-through write would clamp
 * that to the minimum, land it in settings.json, and leave the user fighting their
 * own text box. The value is committed (and clamped) on blur and on Enter.
 */
function NumberRow({ settingKey, label, description, value, onChange, suffix }: NumberRowProps) {
    const def = SETTING_BY_KEY.get(settingKey);
    const min = def?.min ?? 0;
    const max = def?.max ?? Number.MAX_SAFE_INTEGER;
    const id = useId();
    const [draft, setDraft] = useState(String(value));

    useEffect(() => { setDraft(String(value)); }, [value]);

    const commit = () => {
        const parsed = Number(draft);
        if (!Number.isFinite(parsed)) {
            setDraft(String(value));
            return;
        }
        const clamped = Math.min(max, Math.max(min, Math.round(parsed)));
        setDraft(String(clamped));
        if (clamped !== value) onChange(clamped);
    };

    return (
        <div className="w-full flex items-center justify-between gap-4 px-3.5 py-3">
            <div className="flex flex-col items-start min-w-0">
                <label htmlFor={id} className="text-sm font-medium text-[var(--text-primary)]">{label}</label>
                <span className="text-[11px] text-[var(--text-secondary)] mt-0.5">{description}</span>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
                <input
                    id={id}
                    type="number"
                    inputMode="numeric"
                    min={min}
                    max={max}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={commit}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } }}
                    className="w-[72px] px-2 py-1 text-sm text-right bg-[var(--bg-input)] border border-[var(--border)] rounded-[var(--radius-sm)] text-[var(--text-primary)] outline-none focus:border-[var(--focus-ring)]"
                />
                <span className="text-[11px] text-[var(--text-secondary)] w-[62px]">{suffix}</span>
            </div>
        </div>
    );
}

export function SettingsModal({ isOpen, onClose, initialJson = false, onAiKeyPresenceChange }: SettingsModalProps) {
    const dialogRef = useRef<HTMLDivElement>(null);
    const [section, setSection] = useState<Section>("appearance");
    const [filter, setFilter] = useState("");
    const [jsonMode, setJsonMode] = useState(initialJson);
    const { theme, setTheme, font, setFont, fontSize, setFontSize, userThemes, themeProblems } = useTheme();
    const [readerWidth, setReaderWidth] = useSetting<string>("appearance.readerWidth");
    const { error: settingsError } = useSettings();

    // Reopening from the palette's JSON command must land in the JSON view even if
    // the modal was last left on a grouped pane.
    useEffect(() => { if (isOpen) setJsonMode(initialJson); }, [isOpen, initialJson]);

    // The theme grid scrolls (see below), so the active theme can sit below its fold:
    // with ten built-ins plus the user's own, opening Settings on Catppuccin Latte
    // showed a grid with nothing selected in it. Pull it into view when the pane
    // appears. `block: "nearest"` scrolls the grid the minimum needed and leaves the
    // panel behind it alone when the grid is already in frame.
    const selectedThemeRef = useRef<HTMLButtonElement>(null);
    useEffect(() => {
        if (!isOpen || jsonMode || section !== "appearance") return;
        selectedThemeRef.current?.scrollIntoView({ block: "nearest" });
    }, [isOpen, jsonMode, section, theme]);

    // Escape, the backdrop and the close button all unmount the JSON editor, and
    // its draft lives inside it. Closing over unsaved edits would destroy them with
    // no warning, so a dirty draft makes the modal ask first.
    const jsonRef = useRef<SettingsJsonHandle>(null);
    const [jsonDirty, setJsonDirty] = useState(false);
    const [confirmClose, setConfirmClose] = useState(false);
    const onJsonDirty = useCallback((d: boolean) => setJsonDirty(d), []);

    // Every exit that unmounts the JSON editor has to come through here, because the
    // draft lives INSIDE that component and dies with it. Escape, the backdrop and
    // the X were guarded; "Done" and the { } toggle were not, and both simply
    // flipped jsonMode, which unmounts the editor exactly as hard as closing the
    // modal does. Typing an unsaved key and clicking Done, the button right next to
    // Save, silently threw it away.
    //
    // `after` is what to do once it is safe: close the modal, or go back to the
    // grouped panes.
    const [pendingExit, setPendingExit] = useState<null | (() => void)>(null);

    const guardExit = useCallback((after: () => void) => {
        if (jsonDirty) { setPendingExit(() => after); setConfirmClose(true); return; }
        after();
    }, [jsonDirty]);

    const requestClose = useCallback(() => guardExit(onClose), [guardExit, onClose]);
    const leaveJsonMode = useCallback(() => guardExit(() => setJsonMode(false)), [guardExit]);

    const finishExit = () => {
        const after = pendingExit ?? onClose;
        setConfirmClose(false);
        setPendingExit(null);
        after();
    };

    const saveAndClose = async () => {
        // A draft that does not parse cannot be saved, and the editor is already
        // saying why. Stay put rather than exiting over the error.
        if (await jsonRef.current?.save()) finishExit();
        else { setConfirmClose(false); setPendingExit(null); }
    };
    const discardAndClose = () => { setJsonDirty(false); finishExit(); };

    const revealThemes = async () => {
        try {
            await revealItemInDir(await themesDir());
        } catch {
            // The directory is created on launch, so this only fails if the config
            // directory itself is unreachable. Nothing useful to say.
        }
    };

    const reveal = async () => {
        try {
            await revealItemInDir(await settingsPath());
        } catch {
            // The file may not exist yet (nothing has been changed from the
            // defaults). Nothing useful to say, and nothing broken.
        }
    };

    // Straight through to settings.json. These used to be three things at once: a
    // local copy of the value, a localStorage write, and a window CustomEvent so
    // App would hear about it. One context replaces all of it, and the value can
    // no longer drift between the two windows that show it.
    const [typewriter, setTypewriter] = useSetting<boolean>("editor.typewriterMode");
    const [toolbar, setToolbar] = useSetting<boolean>("editor.toolbar");
    const [wordWrap, setWordWrap] = useSetting<boolean>("editor.wordWrap");
    const [spellCheck, setSpellCheck] = useSetting<boolean>("editor.spellCheck");
    const [autoSave, setAutoSave] = useSetting<boolean>("files.autoSave");
    const [openInReader, setOpenInReader] = useSetting<boolean>("files.openInReader");
    const [minimap, setMinimap] = useSetting<boolean>("editor.minimap");
    const [history, setHistory] = useSetting<boolean>("files.history");
    const [historyLimit, setHistoryLimit] = useSetting<number>("files.historyLimit");
    const [historyInterval, setHistoryInterval] = useSetting<number>("files.historyInterval");

    // Seeded with the build-time constant so the About pane never flashes empty;
    // the async call only confirms it (or corrects it after an auto-update).
    const [version, setVersion] = useState(BUILD_VERSION);
    useEffect(() => {
        let alive = true;
        getAppVersion().then((v) => { if (alive) setVersion(v); });
        return () => { alive = false; };
    }, []);

    // The endpoint and the model are SETTINGS, and now actually read as such. The
    // API key is not: it stays in the OS keychain, because settings.json is
    // plaintext. They used to travel together through localStorage, which is how
    // the schema came to declare ai.endpoint (with completion, and linting, and a
    // description) while nothing in the app ever read the value.
    const [endpoint, setEndpoint] = useSetting<string>("ai.endpoint");
    const [model, setModel] = useSetting<string>("ai.model");
    const [aiEnabled, setAiEnabled] = useSetting<boolean>("ai.enabled");

    // A DRAFT of the text fields, committed on blur.
    //
    // Writing through useSetting on every keystroke would rewrite settings.json
    // once per character, each write firing the file watcher, for a value that is
    // meaningless until it is finished being typed. The draft is seeded from the
    // setting and re-seeded whenever the setting changes underneath it, so an edit
    // made in the JSON view shows up here.
    //
    // The API key draft starts EMPTY and stays a write-only field: the stored key
    // is unreadable from the webview (SECURITY-01), so it cannot be pre-filled.
    const [ai, setAi] = useState({ endpoint, model, apiKey: "" });

    // Whether a key is already saved, so the field can say so and mask it, without
    // ever showing the value. Re-checked after a save.
    const [keySaved, setKeySaved] = useState(false);
    useEffect(() => { void aiKeyPresent().then(setKeySaved); }, []);
    // The key field is only persisted when the user actually edits it, so opening
    // Settings and leaving without touching the key never clears a saved one.
    const keyTouchedRef = useRef(false);

    // Adopt a setting that changed underneath us (the JSON view, or an edit made in
    // another editor), but ONLY for a field the user is not currently editing.
    //
    // The naive version re-seeded both fields whenever either changed, so an external
    // change to ai.model wiped an endpoint the user had typed and not yet committed.
    // A field is "being edited" when the draft has drifted from the setting we last
    // saw, so that is what is compared against.
    const seen = useRef({ endpoint, model });
    useEffect(() => {
        setAi((prev) => {
            const next = { ...prev };
            if (prev.endpoint === seen.current.endpoint) next.endpoint = endpoint;
            if (prev.model === seen.current.model) next.model = model;
            seen.current = { endpoint, model };
            return next;
        });
    }, [endpoint, model]);

    const aiEndpointInvalid = ai.endpoint.length > 0 && !isValidEndpoint(ai.endpoint);
    const aiConfigured = !!ai.endpoint && !aiEndpointInvalid && !!ai.model;

    // Connection-test state for the "Test connection" button (AI-04).
    const [aiTest, setAiTest] = useState<{ state: "idle" | "testing" | "ok" | "error"; msg?: string }>({ state: "idle" });

    /** Type into a field. Nothing is persisted yet; commitAi (on blur/unmount)
     *  writes the endpoint, model, and (if edited) the key. */
    const updateAi = (patch: Partial<typeof ai>) => {
        setAi((prev) => ({ ...prev, ...patch }));
        setAiTest({ state: "idle" });
        if (patch.apiKey !== undefined) keyTouchedRef.current = true;
    };

    // The draft, readable from callbacks that were created before the latest render.
    const aiRef = useRef(ai);
    aiRef.current = ai;

    /** Commit the draft. An invalid endpoint is left unsaved so it can be fixed.
     *  The key is written only if the user edited it (empty clears the stored key),
     *  so an untouched field never disturbs a saved key. */
    const commitAi = useCallback(() => {
        const draft = aiRef.current;
        if (draft.endpoint !== endpoint && (!draft.endpoint || isValidEndpoint(draft.endpoint))) {
            setEndpoint(draft.endpoint);
        }
        if (draft.model !== model) setModel(draft.model);
        if (keyTouchedRef.current) {
            keyTouchedRef.current = false;
            // Write (empty clears), THEN read presence back, so the "a key is saved"
            // state here and in the parent reflects the write that just landed
            // rather than racing it. The keychain, not the file.
            void setAIKey(draft.apiKey).then(aiKeyPresent).then((present) => {
                setKeySaved(present);
                onAiKeyPresenceChange?.(present);
            });
        }
    }, [endpoint, model, setEndpoint, setModel, onAiKeyPresenceChange]);

    // Derived, not stored: the provider pill is whichever preset the current
    // endpoint equals, so hand-edited endpoints simply select nothing.
    const activeProvider = matchProvider(ai.endpoint);
    // Fills endpoint + default model; the key is deliberately left alone so
    // re-picking a provider never wipes a pasted key.
    const applyProvider = (p: AIProvider) => {
        updateAi({ endpoint: p.endpoint, model: p.defaultModel });
        setEndpoint(p.endpoint);
        setModel(p.defaultModel);
    };

    const testAIConnection = async () => {
        // Persist a freshly typed endpoint/model/key first: the request reads the
        // key from the keychain (Rust side), so an uncommitted one would be tested
        // against the previously saved value.
        commitAi();
        setAiTest({ state: "testing" });
        try {
            await runAIAction("continue", "Reply with: OK", { endpoint: ai.endpoint, model: ai.model });
            setAiTest({ state: "ok" });
        } catch (e) {
            setAiTest({ state: "error", msg: (e as Error).message });
        }
    };


    useEffect(() => {
        if (!isOpen) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                e.preventDefault();
                requestClose();
            }
        };
        document.addEventListener("keydown", onKey);
        const detach = attachFocusTrap(dialogRef.current);
        return () => {
            document.removeEventListener("keydown", onKey);
            detach();
        };
    }, [isOpen, requestClose]);

    // Commit the AI fields when this component goes away.
    //
    // On UNMOUNT, not on an isOpen transition. App renders the modal as
    // `{showSettings && <SettingsModal isOpen={showSettings} .../>}`, so isOpen is
    // true for the whole life of the component and false never renders: it unmounts
    // instead. The old effect guarded with `if (isOpen) return`, which therefore
    // returned every single time and committed nothing, ever.
    //
    // That mattered on the keyboard path. Escape is a document-level keydown, so it
    // never blurs the focused input, and React does not fire blur on unmount: type an
    // endpoint, press Escape, and the edit was silently gone. (The X and the backdrop
    // got away with it, because a mousedown moves focus and fires blur first.)
    const commitRef = useRef(commitAi);
    commitRef.current = commitAi;
    useEffect(() => () => { commitRef.current(); }, []);

    if (!isOpen) return null;

    const matches = (text: string) => !filter || text.toLowerCase().includes(filter.toLowerCase());

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center" role="dialog" aria-modal="true" aria-label="Settings">
            <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={requestClose} aria-hidden="true" />

            <div
                ref={dialogRef}
                className="relative z-10 w-[820px] max-w-[95vw] h-[600px] max-h-[90vh] flex bg-[var(--bg-primary)] border border-[var(--border)] rounded-[var(--radius-lg)] shadow-2xl overflow-hidden animate-fade-in"
            >
                {confirmClose && (
                    <div role="alertdialog" aria-label="Unsaved settings" className="absolute inset-x-0 bottom-0 z-20 flex items-center justify-between gap-3 px-4 py-3 border-t border-[var(--border)] bg-[var(--bg-secondary)]">
                        <span className="text-[12px] text-[var(--text-primary)]">
                            settings.json has unsaved changes.
                        </span>
                        <span className="flex gap-2 shrink-0">
                            <button type="button" onClick={() => setConfirmClose(false)}
                                className="px-2.5 py-1 text-[12px] rounded-[var(--radius-sm)] border border-[var(--border)] text-[var(--text-primary)] hover:bg-[var(--bg-hover)]">
                                Cancel
                            </button>
                            <button type="button" onClick={discardAndClose}
                                className="px-2.5 py-1 text-[12px] rounded-[var(--radius-sm)] border border-[var(--border)] text-[var(--danger-text)] hover:bg-[var(--bg-hover)]">
                                Discard
                            </button>
                            <button type="button" onClick={() => void saveAndClose()}
                                className="px-2.5 py-1 text-[12px] rounded-[var(--radius-sm)] bg-[var(--accent)] text-[var(--accent-text)]">
                                Save
                            </button>
                        </span>
                    </div>
                )}

                {/* Sidebar — narrower below `sm` so the content pane keeps a
                    usable width when the 95vw modal shrinks on small screens. */}
                {!jsonMode && (
                <aside className="w-36 sm:w-48 shrink-0 bg-[var(--bg-secondary)] border-r border-[var(--border)] flex flex-col">
                    <div className="px-4 py-3 border-b border-[var(--border)]">
                        <input
                            type="text"
                            value={filter}
                            onChange={(e) => setFilter(e.target.value)}
                            placeholder="Search…"
                            aria-label="Search settings"
                            className="w-full px-2 py-1 text-sm bg-[var(--bg-input)] border border-[var(--border)] rounded-[var(--radius-md)] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
                        />
                    </div>
                    <nav className="flex-1 py-2">
                        {sections.map((s) => (
                            <button
                                key={s.id}
                                onClick={() => setSection(s.id)}
                                className={`w-full flex items-center gap-2 px-4 py-2 text-sm text-left transition-colors ${section === s.id
                                    ? "bg-[var(--bg-hover)] text-[var(--text-primary)] font-medium"
                                    : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                                    }`}
                            >
                                <span className="material-symbols-outlined text-[18px]">{s.icon}</span>
                                {s.label}
                            </button>
                        ))}
                    </nav>
                </aside>
                )}

                {/* Body */}
                <div className="flex-1 flex flex-col min-w-0">
                    <header className="flex items-center justify-between px-6 py-3 border-b border-[var(--border)]">
                        <h2 className="text-base font-semibold text-[var(--text-primary)]">
                            {jsonMode ? "settings.json" : sections.find((s) => s.id === section)?.label ?? "Settings"}
                        </h2>
                        <div className="flex items-center gap-1">
                            <button
                                onClick={() => void reveal()}
                                aria-label="Show settings.json in the file manager"
                                title="Show settings.json in the file manager"
                                className="w-7 h-7 rounded-[var(--radius-sm)] hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] flex items-center justify-center transition-colors"
                            >
                                <span className="material-symbols-outlined text-[18px]">folder_open</span>
                            </button>
                            <button
                                onClick={() => (jsonMode ? leaveJsonMode() : setJsonMode(true))}
                                aria-pressed={jsonMode}
                                aria-label={jsonMode ? "Edit settings in the grouped view" : "Edit settings.json directly"}
                                title={jsonMode ? "Back to the grouped settings" : "Edit settings.json directly"}
                                className={`w-7 h-7 rounded-[var(--radius-sm)] flex items-center justify-center transition-colors font-mono text-[13px] ${jsonMode
                                    ? "bg-[var(--bg-hover)] text-[var(--text-primary)] ring-1 ring-[var(--focus-ring)]"
                                    : "hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                                    }`}
                            >
                                {"{ }"}
                            </button>
                            <button onClick={requestClose} aria-label="Close settings" className="w-7 h-7 rounded-[var(--radius-sm)] hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] flex items-center justify-center transition-colors">
                                <span className="material-symbols-outlined text-[18px]">close</span>
                            </button>
                        </div>
                    </header>

                    {/* A file that does not parse is the one thing the grouped panes
                        cannot tell you about: they would just show defaults and look
                        fine, while the app quietly ignored the user's real file. */}
                    {settingsError && !jsonMode && (
                        <div role="alert" className="flex items-center justify-between gap-3 px-6 py-2 text-[12px] border-b border-[var(--border)] bg-[var(--bg-secondary)]">
                            <span className="text-[var(--danger-text)] min-w-0 truncate">
                                settings.json has an error ({settingsError}), so these are the defaults. Your file has not been changed.
                            </span>
                            <button
                                type="button"
                                onClick={() => setJsonMode(true)}
                                className="shrink-0 px-2 py-1 rounded-[var(--radius-sm)] border border-[var(--border)] text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
                            >
                                Fix it
                            </button>
                        </div>
                    )}

                    {jsonMode ? (
                        <div className="flex-1 min-h-0 px-6 py-4">
                            <Suspense fallback={<div className="text-sm text-[var(--text-secondary)]">Loading…</div>}>
                                <SettingsJsonEditor ref={jsonRef} onDone={leaveJsonMode} onDirtyChange={onJsonDirty} />
                            </Suspense>
                        </div>
                    ) : (
                    <div className="flex-1 overflow-y-auto px-6 py-4 space-y-6">
                        {section === "appearance" && (
                            <>
                                {matches("theme") && (
                                    <section>
                                        <h3 className="text-xs font-semibold text-[var(--text-secondary)] uppercase tracking-wider mb-2">Theme</h3>
                                        {/* The grid SCROLLS, and the height is capped rather
                                            than left to the content: the list is ten built-ins
                                            plus however many themes the user has written, which
                                            is unbounded. Uncapped, it pushed Font and Font size
                                            off the bottom of the pane and the Appearance
                                            settings below it became unreachable without a long
                                            scroll past a wall of swatches.

                                            p-1 is not decoration: the selected swatch wears a
                                            ring-2 drawn OUTSIDE its border box, and an
                                            overflow container clips it flush at the edges. The
                                            padding gives the ring somewhere to land.

                                            auto-fill, not a fixed column count: a fixed
                                            grid-cols-4 left the 5th theme stranded alone
                                            on its own row. */}
                                        <div className="max-h-[min(268px,38vh)] overflow-y-auto p-1 -m-1">
                                        <div className="grid [grid-template-columns:repeat(auto-fill,minmax(96px,1fr))] gap-2">
                                            {[
                                                ...themes,
                                                // The user's own, with a swatch built from the theme
                                                // itself. A literal could not have done that, which is
                                                // why the built-ins' swatches are derived too. Same pair
                                                // as THEMES uses (page, accent), or a user's theme would
                                                // be the one swatch in the grid drawn to a different rule.
                                                ...userThemes.map((u) => {
                                                    const tokens = resolveTheme(u.id, userThemes);
                                                    return {
                                                        id: u.id,
                                                        name: u.name,
                                                        colors: [tokens["--bg-primary"], tokens["--accent"]] as [string, string],
                                                    };
                                                }),
                                            ].map((t) => (
                                                <button
                                                    key={t.id}
                                                    ref={theme === t.id ? selectedThemeRef : undefined}
                                                    onClick={() => setTheme(t.id)}
                                                    className={`flex flex-col items-center gap-2 p-3 rounded-[var(--radius-md)] transition-all ${theme === t.id
                                                        ? "ring-2 ring-[var(--focus-ring)] bg-[var(--bg-hover)]"
                                                        : "hover:bg-[var(--bg-hover)]"
                                                        }`}
                                                    title={t.name}
                                                >
                                                    <div className="w-12 h-12 rounded-[var(--radius-md)] overflow-hidden border border-[var(--border)] flex items-center justify-center" style={{ backgroundColor: t.colors[0] }}>
                                                        <div className="w-1/2 h-full" style={{ backgroundColor: t.colors[0] }}></div>
                                                        <div className="w-1/2 h-full" style={{ backgroundColor: t.colors[1] }}></div>
                                                    </div>
                                                    <span className="text-[11px] text-[var(--text-primary)] text-center leading-tight">{t.name}</span>
                                                </button>
                                            ))}
                                        </div>
                                        </div>
                                    </section>
                                )}
                                {themeProblems.length > 0 && (
                                    <div role="status" className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-[11px] text-[var(--text-secondary)] space-y-0.5">
                                        {themeProblems.map((p, i) => (
                                            <div key={i}>
                                                <span className="font-mono text-[var(--text-primary)]">{p.id}</span>: {p.message}
                                            </div>
                                        ))}
                                    </div>
                                )}
                                {matches("theme") && (
                                    <button
                                        type="button"
                                        onClick={() => void revealThemes()}
                                        className="text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] underline underline-offset-2"
                                    >
                                        Open the themes folder
                                    </button>
                                )}
                                {matches("font") && (
                                    <section>
                                        <h3 className="text-xs font-semibold text-[var(--text-secondary)] uppercase tracking-wider mb-2">Font</h3>
                                        <div className="grid grid-cols-2 gap-2">
                                            {fonts.map((f) => {
                                                const active = font === f.id;
                                                return (
                                                    <button
                                                        key={f.id}
                                                        onClick={() => setFont(f.id)}
                                                        aria-pressed={active}
                                                        className={`flex items-center justify-between gap-2 px-3 py-2.5 rounded-[var(--radius-md)] border text-left transition-all ${active
                                                            ? "border-[var(--focus-ring)] bg-[var(--bg-hover)] ring-1 ring-[var(--focus-ring)]"
                                                            : "border-[var(--border)] hover:border-[var(--text-muted)] hover:bg-[var(--bg-hover)]"
                                                            }`}
                                                    >
                                                        <span className="min-w-0">
                                                            <span className="block text-[15px] leading-tight text-[var(--text-primary)] truncate" style={{ fontFamily: f.stack }}>{f.name}</span>
                                                            <span className="block text-[10px] text-[var(--text-secondary)] mt-0.5">{f.kind}</span>
                                                        </span>
                                                        {active && <span className="material-symbols-outlined text-[18px] text-[var(--accent)] shrink-0">check</span>}
                                                    </button>
                                                );
                                            })}
                                        </div>
                                    </section>
                                )}
                                {matches("custom font") && (
                                    <section>
                                        <h3 className="text-xs font-semibold text-[var(--text-secondary)] uppercase tracking-wider mb-2">Custom font</h3>
                                        <input
                                            type="text"
                                            value={isBundledFont(font) ? "" : font}
                                            onChange={(e) => setFont(e.target.value.trim() || FONTS[0].id)}
                                            placeholder="Iosevka, monospace"
                                            aria-label="Custom font family"
                                            spellCheck={false}
                                            // Previews itself in the face being named, which is the
                                            // only feedback that tells you whether the font is
                                            // actually installed: a name the system cannot resolve
                                            // simply renders in the fallback.
                                            style={{ fontFamily: isBundledFont(font) ? undefined : fontStack(font) }}
                                            className="w-full max-w-[420px] px-3 py-2 text-sm bg-[var(--bg-input)] border border-[var(--border)] rounded-[var(--radius-md)] text-[var(--text-primary)] outline-none focus:border-[var(--focus-ring)]"
                                        />
                                        <p className="mt-2 text-[11px] text-[var(--text-secondary)]">
                                            Any font installed on this machine, named as a CSS font
                                            family. If it renders in the fallback face, the name did
                                            not resolve. Clearing this returns to the fonts above.
                                        </p>
                                    </section>
                                )}
                                {matches("size") && (
                                    <section>
                                        <h3 className="text-xs font-semibold text-[var(--text-secondary)] uppercase tracking-wider mb-2">Font size</h3>
                                        <div className="max-w-[280px]">
                                            <FontSizeField value={fontSize} onChange={setFontSize} />
                                        </div>
                                        <p className="mt-2 text-[11px] text-[var(--text-secondary)]">
                                            Pick a preset or type any size. The editor scales with it.
                                        </p>
                                    </section>
                                )}
                                {matches("reader width") && (
                                    <section>
                                        <h3 className="text-xs font-semibold text-[var(--text-secondary)] uppercase tracking-wider mb-2">Reader width</h3>
                                        <div className="max-w-[280px]">
                                            <Select
                                                label="Reader width"
                                                value={readerWidth}
                                                options={READER_WIDTH_OPTIONS}
                                                onChange={setReaderWidth}
                                            />
                                        </div>
                                        <p className="mt-2 text-[11px] text-[var(--text-secondary)]">
                                            How wide the reading column is. Code blocks and tables extend wider so long lines and tables are not clipped.
                                        </p>
                                    </section>
                                )}
                            </>
                        )}

                        {section === "editor" && (
                            <div className="rounded-[var(--radius-lg)] border border-[var(--border)] divide-y divide-[var(--border-subtle)] overflow-hidden">
                                {matches("typewriter") && (
                                    <ToggleRow label="Typewriter mode" description="Keep caret vertically centered" checked={typewriter}
                                        onChange={setTypewriter} />
                                )}
                                {matches("toolbar") && (
                                    <ToggleRow label="Show formatting toolbar" description="Toolbar above the editor" checked={toolbar}
                                        onChange={setToolbar} />
                                )}
                                {matches("word wrap") && (
                                    <ToggleRow label="Word wrap" description="Wrap long lines instead of horizontal scroll" checked={wordWrap}
                                        onChange={setWordWrap} />
                                )}
                                {matches("minimap") && (
                                    <ToggleRow label="Minimap" description="Show a document overview in the editor's right margin" checked={minimap}
                                        onChange={setMinimap} />
                                )}
                                {matches("spell check") && (
                                    <ToggleRow label="Spell check" description="Underline misspelled words while you type" checked={spellCheck}
                                        onChange={setSpellCheck} />
                                )}
                                {matches("autosave") && (
                                    <ToggleRow label="Autosave" description="Save automatically a moment after you stop typing" checked={autoSave}
                                        onChange={setAutoSave} />
                                )}
                                {matches("open files in reader mode") && (
                                    // No window event: App reads the flag live at each
                                    // file open (same pattern as toggle-ai-panel).
                                    <ToggleRow label="Open files in reader mode" description="Every file opens read-first; editing stays one click away" checked={openInReader}
                                        onChange={setOpenInReader} />
                                )}
                                {matches("version history snapshots") && (
                                    <ToggleRow label="Version history" description="Snapshot each file as you save it (Ctrl+Shift+H to browse)" checked={history}
                                        onChange={setHistory} />
                                )}
                                {history && matches("version history snapshots limit") && (
                                    <NumberRow
                                        settingKey="files.historyLimit"
                                        label="Snapshots kept"
                                        description="Per file. The oldest are dropped past this."
                                        value={historyLimit}
                                        onChange={setHistoryLimit}
                                        suffix="snapshots"
                                    />
                                )}
                                {history && matches("version history snapshots interval") && (
                                    <NumberRow
                                        settingKey="files.historyInterval"
                                        label="Snapshot interval"
                                        description="A save within this window replaces the last snapshot instead of adding one."
                                        value={historyInterval}
                                        onChange={setHistoryInterval}
                                        suffix="seconds"
                                    />
                                )}
                            </div>
                        )}

                        {section === "ai" && (
                            <>
                                <div className="rounded-[var(--radius-lg)] border border-[var(--border)] overflow-hidden">
                                    <ToggleRow label="Enable AI" description="Show the AI button and assistant in the editor" checked={aiEnabled}
                                        onChange={setAiEnabled} />
                                </div>
                                <div className="flex items-start justify-between gap-3">
                                    <p className="text-sm text-[var(--text-secondary)]">
                                        Configure an OpenAI-compatible endpoint to enable inline AI assist
                                        (Rewrite / Shorten / Expand / Continue / Translate). Open it in the editor
                                        with <kbd className="px-1 font-mono rounded border border-[var(--border)] bg-[var(--bg-input)]">{AI_SHORTCUT}</kbd>,
                                        the <span className="material-symbols-outlined text-[14px] align-middle">auto_awesome</span> toolbar button,
                                        or the command palette.
                                    </p>
                                    <span
                                        className={`shrink-0 px-2 py-0.5 rounded-[var(--radius-pill)] text-[11px] font-medium border ${aiEndpointInvalid
                                            ? "text-[var(--danger)] border-[var(--danger)]"
                                            : aiConfigured
                                                ? "text-[var(--status-saved)] border-[var(--status-saved)]"
                                                : "text-[var(--status-unsaved)] border-[var(--status-unsaved)]"
                                            }`}
                                    >
                                        {aiEndpointInvalid ? "Invalid endpoint" : aiConfigured ? "Ready" : "Not configured"}
                                    </span>
                                </div>
                                <div className="space-y-3">
                                    <div>
                                        <span className="text-xs font-semibold text-[var(--text-secondary)] uppercase tracking-wider">Provider</span>
                                        <div className="mt-1 flex flex-wrap gap-2" role="group" aria-label="AI provider presets">
                                            {AI_PROVIDERS.map((p) => {
                                                const active = activeProvider?.id === p.id;
                                                return (
                                                    <button
                                                        key={p.id}
                                                        type="button"
                                                        onClick={() => applyProvider(p)}
                                                        aria-pressed={active}
                                                        className={`px-3 py-1.5 text-sm rounded-[var(--radius-md)] border transition-colors ${active
                                                            ? "bg-[var(--accent)] text-[var(--accent-text)] border-[var(--accent)]"
                                                            : "border-[var(--border)] text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"}`}
                                                    >
                                                        {p.name}
                                                    </button>
                                                );
                                            })}
                                        </div>
                                        <span className="block mt-1 text-[11px] text-[var(--text-secondary)]">
                                            Pick a provider to fill in the endpoint and model; then just paste your API key.
                                            Any other OpenAI-compatible endpoint works too, entered below.
                                        </span>
                                    </div>
                                    <label className="block">
                                        <span className="text-xs font-semibold text-[var(--text-secondary)] uppercase tracking-wider">Endpoint URL</span>
                                        <input
                                            type="url"
                                            value={ai.endpoint}
                                            onChange={(e) => updateAi({ endpoint: e.target.value })}
                                            onBlur={commitAi}
                                            placeholder="https://api.openai.com/v1/chat/completions"
                                            aria-invalid={aiEndpointInvalid}
                                            className={`mt-1 w-full px-3 py-2 text-sm bg-[var(--bg-input)] border rounded-[var(--radius-md)] text-[var(--text-primary)] outline-none font-mono ${aiEndpointInvalid ? "border-[var(--danger)] focus:border-[var(--danger)]" : "border-[var(--border)] focus:border-[var(--accent)]"}`}
                                        />
                                        {aiEndpointInvalid && (
                                            <span className="block mt-1 text-[11px] text-[var(--danger)]">Must be a valid http:// or https:// URL.</span>
                                        )}
                                    </label>
                                    <label className="block">
                                        <span className="text-xs font-semibold text-[var(--text-secondary)] uppercase tracking-wider">Model</span>
                                        <input
                                            type="text"
                                            value={ai.model}
                                            onChange={(e) => updateAi({ model: e.target.value })}
                                            onBlur={commitAi}
                                            placeholder="gpt-4o-mini, claude-haiku-4-5, llama3, …"
                                            className="mt-1 w-full px-3 py-2 text-sm bg-[var(--bg-input)] border border-[var(--border)] rounded-[var(--radius-md)] text-[var(--text-primary)] outline-none focus:border-[var(--accent)] font-mono"
                                        />
                                    </label>
                                    <label className="block">
                                        <span className="flex items-center justify-between">
                                            <span className="text-xs font-semibold text-[var(--text-secondary)] uppercase tracking-wider">API key</span>
                                            <span className={`text-[11px] ${keySaved ? "text-[var(--status-saved)]" : "text-[var(--text-secondary)]"}`}>
                                                {keySaved ? "A key is saved" : "No key saved"}
                                            </span>
                                        </span>
                                        {/* Write-only: the stored key is unreadable from the webview, so the
                                            field starts empty. When one is saved it shows a masked placeholder;
                                            typing replaces it, and leaving it blank clears it. */}
                                        <input
                                            type="password"
                                            value={ai.apiKey}
                                            onChange={(e) => updateAi({ apiKey: e.target.value })}
                                            onBlur={commitAi}
                                            placeholder={keySaved ? "••••••••" : activeProvider?.keyOptional ? "(not needed for this provider)" : activeProvider ? `paste your ${activeProvider.name} API key` : "(optional for local providers)"}
                                            className="mt-1 w-full px-3 py-2 text-sm bg-[var(--bg-input)] border border-[var(--border)] rounded-[var(--radius-md)] text-[var(--text-primary)] outline-none focus:border-[var(--accent)] font-mono"
                                        />
                                        {activeProvider && (
                                            <span className="block mt-1 text-[11px] text-[var(--text-secondary)]">{activeProvider.keyHint}</span>
                                        )}
                                    </label>
                                    <div className="flex items-center gap-3">
                                        <button
                                            type="button"
                                            onClick={testAIConnection}
                                            disabled={!aiConfigured || aiTest.state === "testing"}
                                            className="px-3 py-1.5 text-sm rounded-[var(--radius-md)] border border-[var(--border)] text-[var(--text-primary)] hover:bg-[var(--bg-hover)] disabled:opacity-50 transition-colors"
                                        >
                                            {aiTest.state === "testing" ? "Testing…" : "Test connection"}
                                        </button>
                                        {aiTest.state === "ok" && (
                                            <span className="text-[12px] text-[var(--status-saved)]">✓ Connection OK</span>
                                        )}
                                        {aiTest.state === "error" && (
                                            <span className="text-[12px] text-[var(--danger)] truncate" title={aiTest.msg}>{aiTest.msg}</span>
                                        )}
                                    </div>
                                    <p className="text-[11px] text-[var(--text-secondary)] leading-relaxed">
                                        <strong>Privacy:</strong> your selected text is sent <strong>unencrypted</strong> to the endpoint you configure above.
                                        For private notes, use a local provider (e.g. Ollama at <code>http://localhost:11434/v1/chat/completions</code>) so nothing leaves your machine.
                                        The API key is stored in your operating system's keychain (Windows Credential Manager, macOS Keychain, or Linux Secret Service), not in plaintext.
                                    </p>
                                </div>
                            </>
                        )}

                        {section === "about" && (
                            <div className="text-sm text-[var(--text-secondary)] space-y-2">
                                <div className="flex items-center gap-3">
                                    <img src="/icon.svg" alt="Dumont" className="w-10 h-10" />
                                    <div>
                                        <div className="text-[var(--text-primary)] font-semibold">Dumont</div>
                                        <div className="text-[11px]">A minimal markdown editor</div>
                                        <div className="text-[11px] font-mono text-[var(--text-secondary)] mt-0.5">
                                            Version {version}
                                        </div>
                                    </div>
                                </div>
                                <p>Built with Tauri + React + TypeScript.</p>
                                <p>Press <kbd className="px-1 font-mono rounded border border-[var(--border)] bg-[var(--bg-input)]">?</kbd> to view all keyboard shortcuts.</p>
                            </div>
                        )}
                    </div>
                    )}
                </div>
            </div>
        </div>
    );
}
