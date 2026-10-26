// Modified by IRQ Studio, LLC (2026) from an Apache-2.0 licensed original.
// See NOTICE for attribution and license terms.

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import { applySetting, readSettings, writeSettingsRaw, writeSettingsText } from "./store";
import { type Settings, type SettingValue } from "./schema";
import { SettingsContext } from "./useSettings";

interface Props {
    children: ReactNode;
    /** Settings read before the tree mounted. Passed in rather than fetched here,
     *  so nothing renders against defaults and then jumps. See main.tsx. */
    initial: { values: Settings; present: ReadonlySet<string>; text: string; error: string | null };
}

export function SettingsProvider({ children, initial }: Props) {
    const [values, setValues] = useState<Settings>(initial.values);
    const [present, setPresent] = useState<ReadonlySet<string>>(initial.present);
    const [text, setText] = useState(initial.text);
    const [error, setError] = useState<string | null>(initial.error);
    const [writeError, setWriteError] = useState<string | null>(null);

    // The file's text, mirrored outside React state.
    //
    // `set` must apply its edit to the LATEST text, and setText only takes effect on
    // the next render, so a ref carries the current value between them.
    const textRef = useRef(initial.text);
    const applyText = useCallback((next: string) => {
        textRef.current = next;
        setText(next);
    }, []);

    // Whether the file on disk parses. Read inside `set`, which is a stable
    // callback and would otherwise close over the value from the render that
    // created it.
    const errorRef = useRef(initial.error);
    errorRef.current = error;

    // Writes are serialised. Two toggles clicked in quick succession produce two
    // edits, and they must reach the disk in the order they were computed, or the
    // later text (which contains both changes) can be overtaken by the earlier one
    // (which contains only the first) and the second change is lost on disk even
    // though it is correct in memory.
    const writeQueue = useRef<Promise<unknown>>(Promise.resolve());

    const reload = useCallback(async () => {
        const next = await readSettings();
        setValues(next.values);
        setPresent(next.present);
        applyText(next.text);
        setError(next.error);
    }, [applyText]);

    const set = useCallback(async (key: string, value: SettingValue) => {
        // A file that does not parse is the user's settings with a typo in it. The
        // app runs on defaults and SAYS SO, in a banner that promises the file has
        // not been touched. Writing here would make that banner a lie one click
        // later: jsonc's modify() does not throw on a broken document, it computes
        // edits against a partial tree and cheerfully returns them, so the write
        // went through and the file stayed broken.
        if (errorRef.current) {
            throw new Error(`settings.json does not parse (${errorRef.current}); refusing to write over it`);
        }

        // Optimistic: the UI must not wait on a disk write to show a toggle moving.
        setValues((prev) => ({ ...prev, [key]: value }));
        setPresent((prev) => (prev.has(key) ? prev : new Set(prev).add(key)));

        // Compute the edit and adopt it NOW, before the await. The write is an IPC
        // round trip plus a create_dir_all, a write and a rename: milliseconds, and
        // far more on a network home directory or behind an antivirus filter. A
        // second `set` inside that window used to read textRef.current and find the
        // text from BEFORE this edit, so its write landed on a file that never had
        // this one, and this setting silently reverted on the next launch while the
        // UI went on showing it as applied.
        const next = applySetting(textRef.current, key, value);
        applyText(next);

        const write = writeQueue.current.then(() => writeSettingsRaw(next));
        writeQueue.current = write.catch(() => { /* keep the queue alive for the next write */ });

        try {
            await write;
            setWriteError(null);
        } catch (e) {
            // The write did not happen, so the optimistic state is a lie. Do NOT undo
            // it from a snapshot: the first version of this restored `values`,
            // `present` and `text` to what they were before this call, which is wrong
            // the moment two writes overlap. The snapshot predates the OTHER write's
            // edit, so rolling back one failed toggle silently discarded a second,
            // successful one, and left memory, `text` and the actual file in three
            // different states.
            //
            // The disk is the truth. Re-read it, but only once everything already in
            // the queue has landed: a write queued behind this one is still going to
            // run (it carries a different setting and may well succeed), and reading
            // the file before it lands would resync memory to a state the disk is
            // about to leave. Chain the re-read onto the queue so it sees the end.
            const resync = writeQueue.current.then(() => reload());
            writeQueue.current = resync.catch(() => { /* keep the queue alive */ });
            await resync;

            // And this is NOT `error`. That means "the file exists and does not
            // parse", and it gates every future write; a transient EPERM would have
            // latched it on and put up a banner claiming the file could not be read
            // and had not been changed, both false. A write failure is its own thing.
            setWriteError((e as Error).message);
            throw e;
        }
        // `values` and `present` are NOT dependencies, and that is the point: the body
        // never reads either of them. Both updates above go through the functional form
        // (`setValues(prev => ...)`), precisely so that a `set` racing another one cannot
        // compute its next state from a snapshot it took before the other landed. Listing
        // them anyway made `set` a NEW FUNCTION on every settings change, which churned
        // every callback and memo downstream that depends on it: useSetting's setter is
        // built from it, and App's command-palette memo lists that setter, so a memo whose
        // own comment explains at length why it must not rebuild on every keystroke was
        // rebuilding on every keystroke. `reload` is a dependency because it is genuinely
        // called, in the failure path below.
    }, [applyText, reload]);

    // Writing raw text needs an explicit re-read. Rust suppresses the watcher echo
    // of our own writes (otherwise every click would round-trip through the disk),
    // so nothing else would tell the app what it just saved.
    const saveText = useCallback(async (next: string) => {
        // Through the same queue as `set`, so a Save in the JSON editor cannot
        // overtake a toggle whose write is still in flight and be overwritten by it.
        const write = writeQueue.current.then(() => writeSettingsText(next));
        writeQueue.current = write.catch(() => { /* keep the queue alive */ });
        await write;
        await reload();
    }, [reload]);

    // An edit made in another editor takes effect immediately, which is the whole
    // point of having a file. Rust watches the config directory and emits this;
    // it suppresses the echo of our own writes, so this cannot fight the UI.
    useEffect(() => {
        const un = listen("settings-file-changed", () => { void reload(); });
        return () => { void un.then((f) => f()); };
    }, [reload]);

    return (
        <SettingsContext.Provider value={{ values, present, set, text, saveText, error, writeError, reload }}>
            {children}
        </SettingsContext.Provider>
    );
}
