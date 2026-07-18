// Modified by IRQ Studio, LLC (2026) from an Apache-2.0 licensed original.
// See NOTICE for attribution and license terms.

/**
 * Reading and writing settings.json.
 *
 * Two properties matter more than anything else here.
 *
 * 1. WRITES ARE SURGICAL. Changing one setting from the UI applies a minimal text
 *    edit to the file with jsonc-parser (the library VS Code uses for exactly
 *    this) and leaves everything else byte for byte as it was: the user's
 *    comments, their key order, their indentation. The obvious implementation --
 *    parse to an object, mutate, JSON.stringify it back -- deletes every comment
 *    in the file the first time anyone clicks a checkbox, and quietly reorders
 *    their keys. Once is enough to lose someone's annotated config forever.
 *
 * 2. A BROKEN FILE IS NEVER OVERWRITTEN. If the JSON does not parse, the app runs
 *    on defaults IN MEMORY and reports the error. It does not "repair" the file by
 *    writing defaults over it, because the thing it would be destroying is the
 *    user's settings with one comma out of place, and they would rather fix the
 *    comma than retype the file.
 */
import { invoke } from "@tauri-apps/api/core";
import { applyEdits, modify, parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import {
    SETTING_BY_KEY,
    defaultSettings,
    normalize,
    type Settings,
    type SettingValue,
} from "./schema";

/** Two spaces, matching the rest of the project's JSON. */
const FORMAT = { insertSpaces: true, tabSize: 2, eol: "\n" } as const;

export interface LoadedSettings {
    /** What the app should use. Defaults applied, values coerced. */
    values: Settings;
    /** ONLY the keys actually present in the file. An absent key means "no
     *  opinion", which is not the same as the default: the theme follows the OS
     *  until the user picks one, and that is encoded by absence. */
    present: ReadonlySet<string>;
    /** The file's raw text, for the JSON editor. Empty when the file is absent. */
    text: string;
    /** Non-null when the file exists but does not parse. The app runs on defaults
     *  and MUST NOT write until this is resolved. */
    error: string | null;
}

/** Human-readable position for a jsonc parse error. */
function describe(errors: ParseError[], text: string): string {
    const e = errors[0];
    const before = text.slice(0, e.offset);
    const line = before.split("\n").length;
    const col = e.offset - before.lastIndexOf("\n");
    return `${printParseErrorCode(e.error)} at line ${line}, column ${col}`;
}

export async function readSettings(): Promise<LoadedSettings> {
    const text = (await invoke<string | null>("read_settings")) ?? "";
    if (!text.trim()) {
        return { values: defaultSettings(), present: new Set(), text: "", error: null };
    }

    const errors: ParseError[] = [];
    const parsed = parse(text, errors, { allowTrailingComma: true });

    if (errors.length > 0) {
        // Defaults in memory, file untouched. See the note at the top.
        return { values: defaultSettings(), present: new Set(), text, error: describe(errors, text) };
    }
    // Valid JSON is not necessarily valid SETTINGS. `[]`, `42` and `null` all parse
    // cleanly and are none of them a settings object. This used to fall through as
    // error: null, so the app showed no banner, and the first toggle then threw from
    // deep inside jsonc ("Can not add index to parent of type array"). Treat it as
    // what it is: a file the app cannot use, which is therefore never written over.
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return {
            values: defaultSettings(),
            present: new Set(),
            text,
            error: "settings must be a JSON object, for example { }",
        };
    }

    const present = new Set(
        Object.keys(parsed as Record<string, unknown>).filter((k) => SETTING_BY_KEY.has(k)),
    );
    return { values: normalize(parsed), present, text, error: null };
}

/**
 * Change one setting, preserving everything else in the file.
 *
 * Returns the new text so the caller can keep the JSON editor in step without a
 * re-read racing the file watcher.
 */
export function applySetting(currentText: string, key: string, value: SettingValue): string {
    // [key], NOT key.split("."). The dots in "editor.minimap" are part of the key
    // NAME, exactly as in VS Code's settings.json. Splitting them turns a flat key
    // into a nested object -- {"editor": {"minimap": true}} -- which then never
    // matches anything the schema looks up, so the setting silently does nothing.
    const edits = modify(currentText || "{}", [key], value, {
        formattingOptions: FORMAT,
    });
    return applyEdits(currentText || "{}", edits);
}

/** Persist raw text. No validation: the caller has already decided. */
export async function writeSettingsRaw(text: string): Promise<void> {
    await invoke("write_settings", { text });
}

/**
 * Compute the edit and persist it. Kept for callers that do one write at a time.
 *
 * The provider does NOT use this: it has to advance its own copy of the text
 * synchronously, before the write is awaited, or a second change made while this
 * one is still in flight is computed from text that predates it. See
 * SettingsProvider.set.
 */
export async function writeSetting(
    currentText: string,
    key: string,
    value: SettingValue,
): Promise<string> {
    const next = applySetting(currentText, key, value);
    await writeSettingsRaw(next);
    return next;
}

/** Write raw text, as typed into the JSON editor. Rejects invalid JSON rather
 *  than persisting a file the app cannot read back. */
export async function writeSettingsText(text: string): Promise<void> {
    const errors: ParseError[] = [];
    parse(text, errors, { allowTrailingComma: true });
    if (errors.length > 0) {
        throw new Error(describe(errors, text));
    }
    await invoke("write_settings", { text });
}

export async function settingsPath(): Promise<string> {
    return invoke<string>("get_settings_path");
}
