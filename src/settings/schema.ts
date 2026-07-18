// Modified by IRQ Studio, LLC (2026) from an Apache-2.0 licensed original.
// See NOTICE for attribution and license terms.

/**
 * Every setting Dumont has, in one place.
 *
 * The grouped Settings UI, the validation, the defaults, the migration off
 * localStorage, and (later) the JSON editor's completions all read from this
 * table. Add a setting here and it exists everywhere; there is no second list to
 * keep in step, which is how the theme list ended up defined in three places.
 *
 * WHAT DOES NOT BELONG HERE: open tabs, recent files, the last file, the view
 * mode, the split ratio, the window geometry. Those are STATE, not preferences.
 * Putting them in settings.json would rewrite the user's settings file every time
 * they opened a document, and would drag their tab history along to any machine
 * they synced it to. They stay in localStorage.
 *
 * The AI key does not belong here either. It lives in the OS keychain; a
 * plaintext config file is the wrong home for a credential. Only the endpoint and
 * the model are settings.
 */
import { THEMES, FONTS } from "../utils/appearanceOptions";
import { READER_WIDTH_TIERS, DEFAULT_READER_WIDTH } from "../utils/readerWidth";
import { DEFAULT_FONT_SIZE, MIN_FONT_SIZE, MAX_FONT_SIZE } from "../utils/typeScale";

export type SettingValue = string | number | boolean;

export interface SettingDef<T extends SettingValue = SettingValue> {
    /** Dotted key, exactly as it appears in settings.json. */
    key: string;
    /** Which pane of the Settings UI it appears in. */
    group: "appearance" | "editor" | "files" | "ai";
    type: "string" | "number" | "boolean" | "enum";
    default: T;
    /** Shown in the UI and, later, as a comment in the generated settings.json. */
    description: string;
    /** For "enum": the values it may take. */
    options?: readonly string[];
    /**
     * For "enum": the options are SUGGESTIONS, not the whole world.
     *
     * A closed enum is right for the theme, which has to exist in the CSS to mean
     * anything. It is wrong for the font, where any face installed on the machine
     * is a legitimate value we cannot enumerate. An open enum still completes the
     * bundled names and still lints a wrong TYPE, it just does not reject a value
     * for the crime of being unfamiliar.
     */
    open?: boolean;
    /**
     * For an open enum whose legal values are only known at RUNTIME.
     *
     * The theme is the case: its options are the built-ins plus whatever the user
     * has dropped into their themes directory, which cannot be a compile-time
     * constant. The value is still validated (a typo'd theme id is a real error, it
     * paints nothing), just against a list that is discovered rather than declared.
     */
    known?: () => readonly string[];
    /** For "number": the inclusive bounds. */
    min?: number;
    max?: number;
    /**
     * For "number": whole numbers only, so `coerce` rounds.
     *
     * Set it on any value that is handed to Rust as an integer parameter. serde
     * rejects a float for a `usize` or a `u64`, and it does so while deserializing
     * the command's arguments, which means the command never runs and the failure
     * arrives as a rejected promise rather than anything the code can spot. A
     * best-effort `.catch()` on the caller then makes it invisible. Rounding here
     * is what stops a plausible `0.5` in the JSON editor from quietly disabling a
     * whole feature.
     */
    integer?: boolean;
}

export const SETTINGS: readonly SettingDef[] = [
    // --- appearance ---
    {
        key: "appearance.theme",
        group: "appearance",
        type: "enum",
        // Open, and it has to be. A theme id can be the filename of a theme the user
        // wrote, which no compile-time list can contain.
        //
        // This entry used to say "deliberately NOT open: a theme the app cannot
        // resolve is a typo, and coercing it back to the default is right". That is
        // true of a typo and false of a user theme, and the two are indistinguishable
        // AT BOOT, because coerce runs before the themes directory has been read.
        // The result was that a settings.json naming a perfectly good user theme was
        // rewritten to "dark" in memory on every launch, and the theme, which loaded
        // correctly a moment later, could never be selected.
        //
        // A typo is still caught, just not by silently discarding it: `known` is the
        // list of themes that actually loaded, the JSON editor lints against it, and
        // an id that resolves to nothing falls back to the base theme's colors.
        open: true,
        known: () => knownThemeIds,
        default: "dark",
        options: THEMES.map((t) => t.id),
        description: "Color theme. A built-in, or a theme in your themes folder.",
    },
    {
        key: "appearance.font",
        group: "appearance",
        type: "enum",
        open: true,
        default: "inter",
        options: FONTS.map((f) => f.id),
        description:
            "Body font, for the preview and the editor. One of the bundled names, or any font installed on this machine (a CSS font-family list, e.g. \"Iosevka, monospace\").",
    },
    {
        key: "appearance.fontSize",
        group: "appearance",
        type: "number",
        default: DEFAULT_FONT_SIZE,
        min: MIN_FONT_SIZE,
        max: MAX_FONT_SIZE,
        description: `Body font size in pixels (${MIN_FONT_SIZE}-${MAX_FONT_SIZE}). Headings, line height and the editor scale with it.`,
    },
    {
        key: "appearance.readerWidth",
        group: "appearance",
        // Closed, unlike the theme: the four tiers are the whole world, and a value
        // that is not one of them is a typo, so coercing it back to the default is
        // right. Each tier sets the prose reading column; code blocks and tables are
        // always allowed a wider bound so long lines and many-column tables are not
        // clipped inside the measure while the window has room (MarkdownPreview reads
        // this and writes --reader-measure / --reader-wide; index.css spends them).
        type: "enum",
        options: READER_WIDTH_TIERS.map((t) => t.id),
        default: DEFAULT_READER_WIDTH,
        description:
            "Reading column width in the reader view: narrow, medium, wide, or full. Code blocks and tables extend wider than the prose column so they are not clipped.",
    },

    // --- editor ---
    {
        key: "editor.wordWrap",
        group: "editor",
        type: "boolean",
        default: true,
        description: "Wrap long lines instead of scrolling horizontally.",
    },
    {
        key: "editor.spellCheck",
        group: "editor",
        type: "boolean",
        default: false,
        description: "Underline misspelled words while you type.",
    },
    {
        key: "editor.typewriterMode",
        group: "editor",
        type: "boolean",
        default: false,
        description: "Keep the caret vertically centered.",
    },
    {
        key: "editor.toolbar",
        group: "editor",
        type: "boolean",
        default: false,
        description: "Show the formatting toolbar above the editor.",
    },
    {
        key: "editor.minimap",
        group: "editor",
        type: "boolean",
        default: false,
        description: "Show a document overview in the editor's right margin.",
    },

    // --- files ---
    {
        key: "files.autoSave",
        group: "files",
        type: "boolean",
        default: false,
        description: "Save automatically a moment after you stop typing.",
    },
    {
        key: "files.openInReader",
        group: "files",
        type: "boolean",
        default: false,
        description: "Open every file in the reading view rather than the editor.",
    },
    {
        key: "files.history",
        group: "files",
        // OFF by default. It is the only setting that would write to the user's disk
        // on its own, silently, without them having asked for anything: a second copy
        // of every document they save, in a directory they have never heard of. That
        // is a decision to hand to the user rather than to make on their behalf, and
        // it stays consistent with every other files.* toggle being off.
        //
        // The cost is real and worth being honest about: the moment history is useful
        // is the moment it is too late to switch on. The History panel therefore has a
        // first-class OFF state that explains what the feature is and turns it on in a
        // click, rather than looking like an empty list.
        type: "boolean",
        default: false,
        description: "Keep a local history of each file, snapshotting it as you save.",
    },
    {
        key: "files.historyLimit",
        group: "files",
        type: "number",
        default: 50,
        min: 5,
        max: 500,
        // Crosses IPC into a Rust `usize`. See `integer` on SettingDef.
        integer: true,
        description: "How many snapshots to keep per file. The oldest are dropped past this.",
    },
    {
        key: "files.historyInterval",
        group: "files",
        type: "number",
        default: 60,
        min: 0,
        max: 3600,
        // Crosses IPC into a Rust `u64`. See `integer` on SettingDef.
        integer: true,
        // The number that stops autosave from shredding the history. See
        // src-tauri/src/history.rs: a save inside this window is not recorded at
        // all, so the snapshot rate is bounded no matter how often the file is
        // written, and the newest snapshot always predates the edits made since it.
        // 0 records every single save, which with autosave on will churn through
        // the limit above in minutes.
        description:
            "Seconds between snapshots. Saves made within this window of the newest snapshot are not recorded, which keeps autosave from filling the history with near-identical versions.",
    },

    // --- ai ---
    {
        key: "ai.enabled",
        group: "ai",
        // OFF by default. Dumont is a prose editor first, and an AI assistant is not
        // the thing a writer opening a Markdown file has asked for. It gates the
        // titlebar button, the panel, the palette entries and Alt+J, so off means the
        // app simply has no AI surface in it rather than a dormant one, and the writer
        // who wants it turns it on in Settings > AI, where the endpoint and model it
        // needs are configured anyway.
        type: "boolean",
        default: false,
        description: "Show the AI assistant.",
    },
    {
        key: "ai.endpoint",
        group: "ai",
        type: "string",
        default: "",
        description: "OpenAI-compatible chat completions endpoint.",
    },
    {
        key: "ai.model",
        group: "ai",
        type: "string",
        default: "",
        description: "Model name to send to the endpoint.",
    },
] as const;

/** Typed lookup of every key to its definition. */
export const SETTING_BY_KEY: ReadonlyMap<string, SettingDef> = new Map(
    SETTINGS.map((s) => [s.key, s]),
);

/**
 * Every theme that actually exists right now: the built-ins, plus the user's.
 *
 * A module-level registry rather than a parameter because the linter, the
 * completions and `coerce` all need it and none of them is a React component.
 * ThemeProvider updates it whenever the themes directory changes.
 */
let knownThemeIds: readonly string[] = THEMES.map((t) => t.id);

export function setKnownThemeIds(ids: readonly string[]): void {
    knownThemeIds = ids;
}

export type Settings = Record<string, SettingValue>;

/** Every default, as the object the app falls back to. */
export function defaultSettings(): Settings {
    const out: Settings = {};
    for (const s of SETTINGS) out[s.key] = s.default;
    return out;
}

/**
 * Coerce one value against its definition, falling back to the default.
 *
 * Hand-edited files contain hand-made mistakes: a string where a number belongs,
 * a theme that does not exist, a font size of 900. None of those may crash the
 * app or be silently written back; each falls back to the default for that one
 * key and leaves every other key alone.
 */
export function coerce(def: SettingDef, raw: unknown): SettingValue {
    switch (def.type) {
        case "boolean":
            return typeof raw === "boolean" ? raw : def.default;
        case "number": {
            if (typeof raw !== "number" || !Number.isFinite(raw)) return def.default;
            const lo = def.min ?? -Infinity;
            const hi = def.max ?? Infinity;
            const clamped = Math.min(hi, Math.max(lo, raw));
            // An `integer` setting is rounded, and that is a correctness rule rather
            // than tidiness. These values cross the IPC boundary into Rust integer
            // parameters (`usize`, `u64`), and serde REJECTS a float for an integer
            // type: the command fails while deserializing its arguments, before any
            // of our code runs. `files.historyInterval: 0.5` is a plausible thing to
            // type into the JSON editor, it is inside the 0-3600 bounds so the linter
            // says nothing, and the failure it causes is swallowed by a best-effort
            // catch. The result is version history that is switched on, reports no
            // error, and silently never records anything again.
            return def.integer ? Math.round(clamped) : clamped;
        }
        case "enum": {
            if (typeof raw !== "string") return def.default;
            // An open enum keeps any non-empty string, INCLUDING one whose runtime
            // list we cannot check yet.
            //
            // The theme's list is discovered by reading a directory, and coerce runs
            // during boot, before that read has necessarily answered. Validating
            // here meant a settings.json naming a perfectly good user theme was
            // "corrected" to dark whenever the check lost the race, and the value in
            // memory was then dark for the rest of the session even though the theme
            // loaded a moment later. Never silently rewrite a value because we have
            // not finished looking it up.
            //
            // An id that names nothing is not lost: it resolves to the base theme's
            // colors, and the JSON editor's linter reports it against `known`, which
            // by then is complete. That is where a typo should be reported anyway,
            // next to the typo.
            if (def.open) return raw.trim() ? raw : def.default;
            return def.options?.includes(raw) ? raw : def.default;
        }
        case "string":
            return typeof raw === "string" ? raw : def.default;
    }
}

/** Apply defaults and coercion to a parsed settings object. Unknown keys are the
 *  caller's business: this only reports what the app understands. */
export function normalize(parsed: unknown): Settings {
    const out = defaultSettings();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return out;
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        const def = SETTING_BY_KEY.get(key);
        if (def) out[key] = coerce(def, value);
    }
    return out;
}
