import { useCallback, useMemo, useState } from "react";

/** The app's dialogs. Exactly one concern each; none of them owns document state. */
export type ModalName =
    | "cheatsheet"
    | "palette"
    | "settings"
    | "stats"
    | "search"
    | "unsavedBeforeClose";

const CLOSED: Record<ModalName, boolean> = {
    cheatsheet: false,
    palette: false,
    settings: false,
    stats: false,
    search: false,
    unsavedBeforeClose: false,
};

export interface Modals {
    /** Which dialogs are open. */
    open: Record<ModalName, boolean>;
    /** Settings has two faces: the grouped panes, or settings.json itself. */
    settingsJson: boolean;

    show: (name: ModalName) => void;
    hide: (name: ModalName) => void;
    /** The gear and Ctrl+, land on the panes; the palette's JSON command opens the file. */
    openSettings: (json?: boolean) => void;

    /**
     * A STABLE `onClose` for each dialog, and the stability is the point.
     *
     * Every dialog attaches a focus trap in an effect keyed on `onClose`
     * (CommandPalette, ShortcutCheatsheet, StatsDialog, Modal, SettingsModal all do), and
     * App used to pass a fresh `() => setShowX(false)` arrow on every render. So any
     * re-render of App while a dialog was open tore the trap down and put it back: the
     * teardown restores focus to whatever was focused before the dialog opened, which is
     * a control BEHIND the backdrop, and the re-attach then drops focus on the dialog's
     * first field. A keyboard user's position was thrown away mid-dialog, and there was no
     * visible cause. Changing the theme inside Settings re-renders App, so this was not
     * hypothetical.
     *
     * Handing out one memoised closer per dialog means the traps mount once and stay.
     */
    close: Record<ModalName, () => void>;
}

/**
 * The dialogs, as one thing.
 *
 * These were six `useState` booleans and a seventh for the settings view, scattered through
 * App's state block and closed over by ~15 inline arrows in its JSX. None of that is
 * interesting, and all of it sat in the way of the state that is: the document, the tabs,
 * the review. Pulling it out is mostly noise removal, and it takes a real focus bug with it.
 */
export function useModals(): Modals {
    const [open, setOpen] = useState<Record<ModalName, boolean>>(CLOSED);
    const [settingsJson, setSettingsJson] = useState(false);

    const show = useCallback((name: ModalName) => {
        setOpen((prev) => (prev[name] ? prev : { ...prev, [name]: true }));
    }, []);

    const hide = useCallback((name: ModalName) => {
        setOpen((prev) => (prev[name] ? { ...prev, [name]: false } : prev));
    }, []);

    const openSettings = useCallback(
        (json = false) => {
            setSettingsJson(json);
            show("settings");
        },
        [show],
    );

    const close = useMemo(
        () =>
            (Object.keys(CLOSED) as ModalName[]).reduce(
                (acc, name) => {
                    acc[name] = () => hide(name);
                    return acc;
                },
                {} as Record<ModalName, () => void>,
            ),
        [hide],
    );

    return { open, settingsJson, show, hide, openSettings, close };
}
