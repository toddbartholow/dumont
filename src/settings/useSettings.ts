// Modified by IRQ Studio, LLC (2026) from an Apache-2.0 licensed original.
// See NOTICE for attribution and license terms.

import { createContext, useCallback, useContext, useRef } from "react";
import { defaultSettings, type Settings, type SettingValue } from "./schema";

export interface SettingsContextValue {
    values: Settings;
    /** Keys actually written in the file. Absent is NOT the same as default: the
     *  theme follows the OS until the user picks one, and absence is how that is
     *  recorded. */
    present: ReadonlySet<string>;
    /** Change one setting. Writes settings.json surgically. */
    set: (key: string, value: SettingValue) => Promise<void>;
    /** The file's raw text, for the JSON editor. */
    text: string;
    /** Replace the whole file, as typed in the JSON editor. Rejects text that does
     *  not parse rather than writing a file the app cannot read back. */
    saveText: (text: string) => Promise<void>;
    /** Non-null when settings.json exists but does not parse. The app is running
     *  on defaults and will not write until this clears. */
    error: string | null;
    /** Non-null when the last write FAILED (a full disk, a read-only config
     *  directory). Distinct from `error`: the file is fine, we could not write it.
     *  Does not gate future writes, because the next one may well succeed. */
    writeError: string | null;
    /** Re-read from disk. */
    reload: () => Promise<void>;
}

export const SettingsContext = createContext<SettingsContextValue | undefined>(undefined);

export function useSettings(): SettingsContextValue {
    const ctx = useContext(SettingsContext);
    if (!ctx) throw new Error("useSettings must be used within a SettingsProvider");
    return ctx;
}

/**
 * One setting, typed, with a setter that behaves like useState's: it accepts a
 * value or an updater. The updater form matters because the command palette
 * toggles settings with `set(v => !v)`, and a setter that silently accepted a
 * function would write the function itself into settings.json.
 */
export function useSetting<T extends SettingValue>(
    key: string,
): [T, (v: T | ((prev: T) => T)) => void] {
    const { values, set } = useSettings();
    const value = (values[key] ?? defaultSettings()[key]) as T;

    // The setter is STABLE. It used to be a fresh arrow on every render, and because
    // App reads nine settings through this hook and threads their setters into callbacks
    // and memos, that one line churned identities right across the component. The clearest
    // casualty was the command palette's useMemo, which listed `setMinimapEnabled` and so
    // rebuilt its whole item list on every keystroke, while the comment above it explained
    // in detail why that must never happen. The optimisation had been silently dead and
    // nothing in the project could tell anyone, because nothing ran the lint rule.
    //
    // The current value is read through a ref rather than closed over, so the updater form
    // still sees the latest value without the setter's identity depending on it.
    const valueRef = useRef(value);
    valueRef.current = value;

    const update = useCallback(
        (v: T | ((prev: T) => T)) => {
            const next = typeof v === "function" ? (v as (p: T) => T)(valueRef.current) : v;
            // set() rejects when the file cannot be written or does not parse. The
            // provider has already re-read the disk and recorded the reason in
            // writeError; swallowing it here keeps a failed toggle from surfacing as an
            // unhandled promise rejection in the console.
            void set(key, next).catch(() => { });
        },
        [key, set],
    );

    return [value, update];
}
