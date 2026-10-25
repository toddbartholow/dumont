import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, act, within } from "@testing-library/react";
import { installCodeMirrorDomPolyfills } from "./test/codemirrorDom";
import { TestProviders } from "./test/providers";

/**
 * The REAL App, driven against a fake disk.
 *
 * App.tsx had zero tests, and every path that can lose a user's work runs through it. The pure
 * helpers it calls are well covered, and that is worse than no coverage, because it reads like
 * the real thing: `isTabDirty` was tested and was not the function `closeTab` actually ran.
 */
const disk = new Map<string, string>();
const mtimes = new Map<string, number>();
let saveGate: Promise<void> | null = null;
/** Paths whose writes fail, and the error each one fails with. */
const failSaves = new Map<string, string>();

/** Hold every save_file until the returned function is called. */
function holdSaves(): () => Promise<void> {
    let open!: () => void;
    saveGate = new Promise<void>((r) => { open = r; });
    return async () => {
        saveGate = null;
        await act(async () => open());
    };
}

let readGate: Promise<void> | null = null;

/** Hold every read_file until the returned function is called. */
function holdReads(): () => Promise<void> {
    let open!: () => void;
    readGate = new Promise<void>((r) => { open = r; });
    return async () => {
        readGate = null;
        await act(async () => open());
    };
}

const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    const path = args?.path as string;
    switch (cmd) {
        case "read_file": {
            if (readGate) await readGate;
            if (!disk.has(path)) throw new Error(`File not found: ${path}`);
            const content = disk.get(path)!;
            return {
                path,
                name: path.split("/").pop(),
                content,
                size: content.length,
                line_count: content.split("\n").length,
                modified: mtimes.get(path) ?? 1,
            };
        }
        case "save_file":
            // A test can hold every write open here, to act while it is in flight.
            if (saveGate) await saveGate;
            if (failSaves.has(path)) throw failSaves.get(path);
            // As save_file does: refuse when the file is not at the mtime the caller last saw.
            // Rejected with the bare message, which is how a CommandError crosses the bridge.
            if (args?.expectedMtime !== undefined && disk.has(path) && args.expectedMtime !== (mtimes.get(path) ?? 1)) {
                throw `File changed on disk: ${path}`;
            }
            disk.set(path, args?.content as string);
            mtimes.set(path, (mtimes.get(path) ?? 1) + 1);
            return mtimes.get(path)!;
        case "get_file_info":
            if (!disk.has(path)) throw new Error("not found");
            return { modified: mtimes.get(path) ?? 1, size: 0 };
        case "read_themes":
            return [];
        case "ai_key_present":
            return false;
        // The file explorer reads this when it opens, and a null crashes it.
        case "list_directory_files":
            return [];
        default:
            return null;
    }
});

/** What the OS file picker answers next. */
let nextOpenPath: string | null = null;
let nextSavePath: string | null = null;

vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...(a as [string])) }));
/** The app's Tauri event listeners by event name, so a test can play the native menu. */
const tauriListeners = new Map<string, (e: { payload: unknown }) => void>();
vi.mock("@tauri-apps/api/event", () => ({
    listen: vi.fn(async (name: string, cb: (e: { payload: unknown }) => void) => {
        tauriListeners.set(name, cb);
        return () => {};
    }),
    TauriEvent: { DRAG_DROP: "drag-drop", WINDOW_CLOSE_REQUESTED: "close" },
}));
const win = {
    setTitle: vi.fn(async () => {}),
    destroy: vi.fn(async () => {}),
    onCloseRequested: vi.fn(async () => () => {}),
    isFullscreen: vi.fn(async () => false),
    onResized: vi.fn(async () => () => {}),
    setFullscreen: vi.fn(async () => {}),
    show: vi.fn(async () => {}),
    setFocus: vi.fn(async () => {}),
};
vi.mock("@tauri-apps/api/window", () => ({ Window: { getCurrent: () => win } }));
vi.mock("./utils/appWindow", () => ({ revealMainWindow: vi.fn(async () => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({
    open: vi.fn(async () => nextOpenPath),
    save: vi.fn(async () => nextSavePath),
    ask: vi.fn(async () => false),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: vi.fn(async () => {}) }));
vi.mock("@tauri-apps/plugin-fs", () => ({ writeTextFile: vi.fn(), writeFile: vi.fn() }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: vi.fn(async () => null) }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn() }));

const { default: App } = await import("./App");
const dialog = await import("@tauri-apps/plugin-dialog");
const updater = await import("@tauri-apps/plugin-updater");
const { getSavedViewMode } = await import("./utils/persistence");

beforeAll(installCodeMirrorDomPolyfills);

// The real App with CodeMirror under jsdom is heavy: one of these tests takes ~0.5 s alone and
// several seconds when the whole suite runs in parallel, which is too close to vitest's 5 s
// default for the ones that open two tabs and type into both.
vi.setConfig({ testTimeout: 20_000 });

beforeEach(() => {
    disk.clear();
    mtimes.clear();
    localStorage.clear();
    invoke.mockClear();
    nextOpenPath = null;
    nextSavePath = null;
    saveGate = null;
    readGate = null;
    failSaves.clear();
    vi.mocked(dialog.save).mockClear();
});

// The format toolbar is off by default; the tests that need a genuinely dirty buffer use it to
// make one, because that is a real edit through the app's own UI rather than a poke at state.
const boot = () =>
    render(
        <TestProviders settings={{ "editor.toolbar": true }}>
            <App />
        </TestProviders>,
    );

const press = (init: KeyboardEventInit) =>
    act(async () => {
        window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
    });

/** Open a file through the app's real Ctrl+O path: the picker answers, App loads it. */
async function openViaDialog(path: string, content: string) {
    disk.set(path, content);
    mtimes.set(path, 1);
    nextOpenPath = path;
    await press({ key: "o", ctrlKey: true });
    await waitFor(() => expect(document.querySelector(".cm-content")).toBeTruthy());
}

/**
 * Make the buffer genuinely dirty, through the app's own UI rather than by poking state.
 *
 * Ctrl+E first: reading is the default view, and in it the editor pane is `display: none`, so
 * its toolbar is not in the accessibility tree and a user could not click it either.
 */
async function makeDirty() {
    await press({ key: "e", ctrlKey: true });
    const bold = await screen.findByRole("button", { name: /bold/i });
    await act(async () => {
        fireEvent.click(bold);
    });
    await waitFor(() => expect(document.body.textContent).toMatch(/Unsaved/i), { timeout: 5000 });
}

describe("App", () => {
    it("boots without crashing, which is the floor everything else stands on", async () => {
        boot();

        await waitFor(() => expect(document.body.textContent).toBeTruthy());
        expect(document.body.textContent).not.toMatch(/Something went wrong/i);
    });

    it("opens a file and shows it", async () => {
        boot();

        await openViaDialog("/notes/a.md", "# Hello\n\nbody\n");

        await waitFor(() => expect(document.body.textContent).toMatch(/a\.md/));
    });

    /**
     * THE test. Ctrl+W on a tab with unsaved work must ASK, not act.
     *
     * The check that decides this lived inline in App with a hand-rolled dirty comparison, a
     * few feet from an exported, tested `isTabDirty` that it did not call. Have it read the
     * active tab's SNAPSHOT instead of the live buffer and it sees "clean" (the snapshot lags
     * by design), closes the tab, and everything typed since the last save is gone with no
     * dialog at all. Nothing in the suite could have caught that.
     */
    it("asks before closing a tab with unsaved work, and does not close it", async () => {
        boot();
        await openViaDialog("/notes/a.md", "# Hello\n");
        await makeDirty();

        await press({ key: "w", ctrlKey: true });

        // The dialog is up...
        await waitFor(() => expect(document.body.textContent).toMatch(/unsaved|discard/i));
        // ...and the document is still here.
        expect(document.querySelector(".cm-content")).toBeTruthy();
    });

    it("closes a clean tab immediately, with no dialog", async () => {
        boot();
        await openViaDialog("/notes/a.md", "# Hello\n");

        await press({ key: "w", ctrlKey: true });

        await waitFor(() => expect(document.querySelector(".cm-content")).toBeNull());
        expect(document.body.textContent).not.toMatch(/unsaved changes/i);
    });

    /**
     * Ctrl+S must write the LIVE buffer. It reads through liveRef rather than closing over
     * `content` (that is what stops the command palette rebuilding on every keystroke), and a
     * stale ref there would mean the app confidently saves yesterday's text over today's.
     */
    it("Ctrl+S writes what is in the buffer right now", async () => {
        boot();
        await openViaDialog("/notes/a.md", "# Hello\n");
        await makeDirty();

        await press({ key: "s", ctrlKey: true });

        await waitFor(() => expect(disk.get("/notes/a.md")).toMatch(/\*\*/));
    });
});

/**
 * Installing an update ends the process (on Windows, inside install() itself, with no close
 * event), so it has to clear the same unsaved-changes dialog a window close does. It did not:
 * "Update now" went straight to downloadAndInstall, and an untitled buffer, which autosave
 * cannot rescue because it has nowhere to write, was simply gone. UPD-02.
 */
describe("App update restart", () => {
    async function untitledDirtyWithUpdate() {
        const upd = {
            version: "9.9.9",
            currentVersion: "1.0.0",
            body: "",
            download: vi.fn(async () => {}),
            install: vi.fn(async () => {}),
        };
        vi.mocked(updater.check).mockResolvedValueOnce(upd as never);
        boot();
        await press({ key: "n", ctrlKey: true });
        // New File lands in the editor already, so no Ctrl+E here: makeDirty's toggle
        // would flip it back to the reader and hide the toolbar.
        const bold = await screen.findByRole("button", { name: /bold/i });
        await act(async () => {
            fireEvent.click(bold);
        });
        await waitFor(() => expect(document.body.textContent).toMatch(/Unsaved/i));
        fireEvent.click(await screen.findByRole("button", { name: "Update now" }));
        await screen.findByText(/save them before restarting to update/i);
        return upd;
    }

    it("asks about unsaved work first, and Cancel installs nothing", async () => {
        const upd = await untitledDirtyWithUpdate();

        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

        expect(await screen.findByRole("button", { name: "Restart now" })).toBeTruthy();
        expect(upd.install).not.toHaveBeenCalled();
        expect(document.querySelector(".cm-content")).toBeTruthy();
    });

    it("saves the untitled buffer where the user picks, then installs", async () => {
        const upd = await untitledDirtyWithUpdate();
        nextSavePath = "/notes/kept.md";

        fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Save" }));

        await waitFor(() => expect(upd.install).toHaveBeenCalledTimes(1));
        expect(disk.get("/notes/kept.md")).toMatch(/\*\*/);
        // Installing is the updater's exit, not ours: the window is left for it.
        expect(win.destroy).not.toHaveBeenCalled();
    });

    it("keeps the app open when the Save As for an untitled buffer is cancelled", async () => {
        const upd = await untitledDirtyWithUpdate();
        nextSavePath = null;

        fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Save" }));

        expect(await screen.findByRole("button", { name: "Restart now" })).toBeTruthy();
        expect(upd.install).not.toHaveBeenCalled();
    });
});

/**
 * The native menu (macOS) routes to the same handlers as the keyboard, and has to
 * respect the same gates. It did not: File > Save on the welcome screen opened a
 * Save As dialog for an empty buffer that belongs to no tab, and the View items
 * flipped state (the persisted view mode among it) with nothing open.
 */
describe("App native menu", () => {
    async function menu(id: string) {
        await waitFor(() => expect(tauriListeners.has("menu")).toBe(true));
        await act(async () => {
            tauriListeners.get("menu")!({ payload: id });
        });
    }

    it("File > Save and Save As do nothing on the welcome screen, like Ctrl+S", async () => {
        boot();

        await menu("file.save");
        await menu("file.saveAs");

        expect(dialog.save).not.toHaveBeenCalled();
    });

    it("View > Toggle Reader / Editor and Split View do nothing on the welcome screen", async () => {
        boot();

        await menu("view.toggleMode");
        await menu("view.split");

        expect(getSavedViewMode()).toBe("preview");
    });

    // The left panel is not drawn on the welcome screen, so an ungated item would
    // leave it toggled for the next document. Choosing it again once a file is
    // open tells the two apart with a positive check, which matters because some
    // panels load lazily and a "not there" check can pass before they would land:
    // gated, the second choice opens the panel; ungated, it closes it again.
    it.each([
        ["view.explorer", "File explorer"],
        ["view.toc", "Table of contents"],
        ["view.backlinks", "Backlinks"],
        ["view.history", "Version history"],
    ])("%s does nothing on the welcome screen", async (id, panel) => {
        boot();

        await menu(id);
        await openViaDialog("/notes/a.md", "# Hello\n");
        await menu(id);

        await waitFor(() => expect(document.querySelector(`aside[aria-label="${panel}"]`)).toBeTruthy());
    });

    it("File > Save still saves an open file", async () => {
        boot();
        await openViaDialog("/notes/a.md", "# Hello\n");
        await makeDirty();

        await menu("file.save");

        await waitFor(() => expect(disk.get("/notes/a.md")).toMatch(/\*\*/));
    });
});

/**
 * A save finishes when the disk says so, and the user can be on another tab by then. Every save
 * path used to apply its result to whatever tab was in front at that moment. TABS-17.
 */
describe("App save completion", () => {
    const showsUnsaved = () => screen.queryByLabelText("File has unsaved changes") !== null;
    const tabNamed = (name: RegExp) => screen.getAllByRole("tab").find((t) => name.test(t.textContent ?? ""))!;
    const switchTo = async (name: RegExp) => {
        await act(async () => {
            // Tabs activate on mousedown, as a native tab strip does.
            fireEvent.mouseDown(tabNamed(name), { button: 0 });
        });
    };

    it("a save that finishes after a tab switch marks the tab it saved, not the one in front", async () => {
        boot();
        await openViaDialog("/notes/a.md", "# A\n");
        await openViaDialog("/notes/b.md", "# B\n");
        await switchTo(/a\.md/);
        await makeDirty();

        const release = holdSaves();
        await press({ key: "s", ctrlKey: true });
        await switchTo(/b\.md/);
        await release();

        // B was never touched. Handed A's saved text as its baseline, it read as unsaved.
        await waitFor(() => expect(disk.get("/notes/a.md")).toMatch(/\*\*/));
        expect(showsUnsaved()).toBe(false);
        // And A, whose snapshot was taken mid-save, comes back saved rather than dirty.
        await switchTo(/a\.md/);
        await waitFor(() => expect(showsUnsaved()).toBe(false));
    });

    it("a Save As that finishes after a tab switch names the tab it saved", async () => {
        boot();
        await openViaDialog("/notes/b.md", "# B\n");
        await press({ key: "n", ctrlKey: true });
        await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(2));
        fireEvent.click(await screen.findByRole("button", { name: /bold/i }));

        nextSavePath = "/notes/kept.md";
        const release = holdSaves();
        await press({ key: "s", ctrlKey: true, shiftKey: true });
        await waitFor(() => expect(dialog.save).toHaveBeenCalled());
        await switchTo(/b\.md/);
        await release();

        await waitFor(() => expect(disk.get("/notes/kept.md")).toBeDefined());
        // B keeps its own name and path; it used to be renamed to the Save As target.
        expect(tabNamed(/b\.md/)).toBeTruthy();
        expect(tabNamed(/kept\.md/)).toBeTruthy();
        expect(screen.getAllByRole("tab")).toHaveLength(2);
    });
});

/**
 * A file that changed on disk is reloaded on focus when its buffer is clean. "Clean" is judged
 * before the read, and the read takes time: whatever the user does meanwhile must win. EXT-02.
 */
describe("App external reload", () => {
    const focusWindow = () =>
        act(async () => {
            window.dispatchEvent(new Event("focus"));
        });
    const changeOnDisk = (path: string, text: string) => {
        disk.set(path, text);
        mtimes.set(path, (mtimes.get(path) ?? 1) + 10);
    };

    it("does not replace what the user typed while the reload was reading", async () => {
        boot();
        await openViaDialog("/notes/a.md", "# A\n");
        changeOnDisk("/notes/a.md", "# A, from another editor\n");

        const release = holdReads();
        await focusWindow();
        await makeDirty();
        await release();

        const editor = document.querySelector(".cm-content")!;
        expect(editor.textContent).toMatch(/\*\*/);
        expect(editor.textContent).not.toMatch(/another editor/);
        // Disk and buffer now disagree, so it says so instead of reloading silently.
        expect(await screen.findByText(/changed on disk/i)).toBeTruthy();
    });

    it("does not reload a background tab over edits made after it was judged clean", async () => {
        boot();
        await openViaDialog("/notes/a.md", "# A\n");
        await openViaDialog("/notes/b.md", "# B\n");
        changeOnDisk("/notes/a.md", "# A, from another editor\n");

        const switchTo = (name: RegExp) =>
            act(async () => {
                fireEvent.mouseDown(screen.getAllByRole("tab").find((t) => name.test(t.textContent ?? ""))!, { button: 0 });
            });

        const release = holdReads();
        await focusWindow();
        // While the background read of a.md is out: bring it forward, type into it, and go
        // back to b.md, which files those edits in a.md's snapshot. That snapshot is what the
        // late read used to overwrite, text and baseline both, so the edits vanished silently.
        await switchTo(/a\.md/);
        await makeDirty();
        await switchTo(/b\.md/);
        await release();

        await switchTo(/a\.md/);
        const editor = document.querySelector(".cm-content")!;
        expect(editor.textContent).toMatch(/\*\*/);
        expect(editor.textContent).not.toMatch(/another editor/);
    });
});

/**
 * A file another program changed while the buffer holds edits of its own is a conflict, and the
 * user decides it. Autosave used to decide it for them, by writing over the other change: after
 * a toast saying a save WOULD overwrite, or with no warning at all when the window kept focus.
 * EXT-03.
 */
describe("App external conflict", () => {
    const THEIRS = "# A, from another editor\n";
    const changeOnDisk = (path: string, text: string) => {
        disk.set(path, text);
        mtimes.set(path, (mtimes.get(path) ?? 1) + 10);
    };
    const focusWindow = () =>
        act(async () => {
            window.dispatchEvent(new Event("focus"));
        });
    const switchTo = (name: RegExp) =>
        act(async () => {
            fireEvent.mouseDown(screen.getAllByRole("tab").find((t) => name.test(t.textContent ?? ""))!, { button: 0 });
        });
    const bootAutosaving = () =>
        render(
            <TestProviders settings={{ "editor.toolbar": true, "files.autoSave": true }}>
                <App />
            </TestProviders>,
        );
    // Comfortably past the 1.5 s autosave debounce.
    const waitPastAutosave = () => act(() => new Promise<void>((r) => setTimeout(r, 2200)));
    const keepMine = () => screen.findByRole("button", { name: "Keep my version" }, { timeout: 4000 });

    it("autosave does not overwrite a change made while the window kept focus", async () => {
        bootAutosaving();
        await openViaDialog("/notes/a.md", "# A\n");
        await makeDirty();
        changeOnDisk("/notes/a.md", THEIRS);

        expect(await keepMine()).toBeTruthy();
        expect(disk.get("/notes/a.md")).toBe(THEIRS);
        // The edits are still in the buffer, waiting on the choice.
        expect(document.querySelector(".cm-content")!.textContent).toMatch(/\*\*/);
    });

    it("a change seen on focus parks autosave until the user chooses", async () => {
        bootAutosaving();
        await openViaDialog("/notes/a.md", "# A\n");
        changeOnDisk("/notes/a.md", THEIRS);
        await makeDirty();
        await focusWindow();

        expect(await keepMine()).toBeTruthy();
        await waitPastAutosave();
        expect(disk.get("/notes/a.md")).toBe(THEIRS);
    });

    it("Keep my version writes the buffer over the other change", async () => {
        bootAutosaving();
        await openViaDialog("/notes/a.md", "# A\n");
        await makeDirty();
        changeOnDisk("/notes/a.md", THEIRS);

        fireEvent.click(await keepMine());

        await waitFor(() => expect(disk.get("/notes/a.md")).toMatch(/\*\*/));
        await waitFor(() => expect(screen.queryByRole("button", { name: "Keep my version" })).toBeNull());
        expect(screen.queryByLabelText("File has unsaved changes")).toBeNull();
    });

    it("Reload from disk takes the other change and drops the edits", async () => {
        bootAutosaving();
        await openViaDialog("/notes/a.md", "# A\n");
        await makeDirty();
        changeOnDisk("/notes/a.md", THEIRS);
        await keepMine();

        fireEvent.click(screen.getByRole("button", { name: "Reload from disk" }));

        await waitFor(() => expect(document.querySelector(".cm-content")!.textContent).toMatch(/another editor/));
        expect(document.querySelector(".cm-content")!.textContent).not.toMatch(/\*\*/);
        expect(screen.queryByRole("button", { name: "Keep my version" })).toBeNull();
        expect(disk.get("/notes/a.md")).toBe(THEIRS);
    });

    it("Ctrl+S does not overwrite a change it has not seen, and then asks", async () => {
        boot();
        await openViaDialog("/notes/a.md", "# A\n");
        await makeDirty();
        changeOnDisk("/notes/a.md", THEIRS);

        await press({ key: "s", ctrlKey: true });

        expect(await keepMine()).toBeTruthy();
        expect(disk.get("/notes/a.md")).toBe(THEIRS);
        // Pressed again, it takes the user to the choice rather than writing.
        await press({ key: "s", ctrlKey: true });
        await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Reload from disk" })));
        expect(disk.get("/notes/a.md")).toBe(THEIRS);
    });

    it("a background tab's autosave does not overwrite a change to its file", async () => {
        bootAutosaving();
        await openViaDialog("/notes/a.md", "# A\n");
        await openViaDialog("/notes/b.md", "# B\n");
        await switchTo(/a\.md/);
        await makeDirty();
        await switchTo(/b\.md/);
        changeOnDisk("/notes/a.md", THEIRS);

        expect(await screen.findByText(/background tab/i, {}, { timeout: 4000 })).toBeTruthy();
        expect(disk.get("/notes/a.md")).toBe(THEIRS);
        // The choice is waiting on the tab itself.
        await switchTo(/a\.md/);
        expect(await keepMine()).toBeTruthy();
        expect(document.querySelector(".cm-content")!.textContent).toMatch(/\*\*/);
    });
});

/**
 * A background tab's autosave used to swallow every failure, and nothing retried it: the effect
 * re-runs only when the tab list changes, so the tab sat dirty with no message for as long as it
 * stayed in the background. SAVE-03.
 */
describe("App background autosave failures", () => {
    const switchTo = (name: RegExp) =>
        act(async () => {
            fireEvent.mouseDown(screen.getAllByRole("tab").find((t) => name.test(t.textContent ?? ""))!, { button: 0 });
        });
    const failureToasts = () => screen.queryAllByText(/Couldn't autosave "a\.md"/);
    const writesOf = (path: string) =>
        invoke.mock.calls.filter(([cmd, args]) => cmd === "save_file" && args?.path === path).length;

    /** a.md dirty in the background, with its writes failing. */
    async function failingBackgroundTab() {
        render(
            <TestProviders settings={{ "editor.toolbar": true, "files.autoSave": true }}>
                <App />
            </TestProviders>,
        );
        await openViaDialog("/notes/a.md", "# A\n");
        await openViaDialog("/notes/b.md", "# B\n");
        await switchTo(/a\.md/);
        await makeDirty();
        failSaves.set("/notes/a.md", "Permission denied: /notes/a.md");
        await switchTo(/b\.md/);
        await waitFor(() => expect(failureToasts()).toHaveLength(1), { timeout: 4000 });
    }

    it("says which file failed, and why", async () => {
        await failingBackgroundTab();

        expect(failureToasts()[0].textContent).toMatch(/Permission denied/);
        expect(disk.get("/notes/a.md")).toBe("# A\n");
    });

    // A timer can fire a few ms early by Date.now(). The retry used to judge "due" by the clock
    // at firing, so the tab it was set for read as not yet due, was skipped, and with nothing
    // written and nothing failed no further retry was ever scheduled. Flaky on Linux CI.
    it("retries even when the timer fires early by the wall clock", async () => {
        await failingBackgroundTab();
        // Let the retry be scheduled, then run the clock 100 ms behind the timers.
        await act(() => new Promise<void>((r) => setTimeout(r, 200)));
        const realNow = Date.now.bind(Date);
        const skew = vi.spyOn(Date, "now").mockImplementation(() => realNow() - 100);
        try {
            failSaves.delete("/notes/a.md");
            await waitFor(() => expect(disk.get("/notes/a.md")).toMatch(/\*\*/), { timeout: 6000 });
        } finally {
            skew.mockRestore();
        }
    });

    it("tries again without the user switching to it", async () => {
        await failingBackgroundTab();

        failSaves.delete("/notes/a.md");

        await waitFor(() => expect(disk.get("/notes/a.md")).toMatch(/\*\*/), { timeout: 6000 });
    });

    it("does not repeat the message on every retry", async () => {
        await failingBackgroundTab();
        const before = writesOf("/notes/a.md");

        // Past the first retry, which fails the same way. The first toast is still up (errors
        // stay 5 s), so a second one would be on screen beside it.
        await waitFor(() => expect(writesOf("/notes/a.md")).toBeGreaterThan(before), { timeout: 4000 });

        expect(failureToasts()).toHaveLength(1);
    });

    it("still asks before the window closes", async () => {
        await failingBackgroundTab();
        const onClose = (win.onCloseRequested.mock.calls.at(-1) as unknown as [(e: { preventDefault: () => void }) => void])[0];
        const event = { preventDefault: vi.fn() };

        await act(async () => onClose(event));

        expect(event.preventDefault).toHaveBeenCalled();
        expect(await screen.findByText(/save them before closing/i)).toBeTruthy();
    });
});

/**
 * The title bar's Save and Save As are the only visible way to save off macOS, where the
 * window has no File menu. Everything here is done with the mouse. SAVE-04.
 */
describe("App title bar saving", () => {
    const click = (name: string | RegExp) =>
        act(async () => {
            fireEvent.click(screen.getByRole("button", { name }));
        });
    const bold = async () => {
        await act(async () => {
            fireEvent.click(await screen.findByRole("button", { name: /bold/i }));
        });
        await waitFor(() => expect(screen.queryByLabelText("File has unsaved changes")).not.toBeNull());
    };

    it("saves a new note where the user picks", async () => {
        boot();
        // Ctrl+N, not the welcome screen's New File: boot runs once per module (bootResolved),
        // so after the first test in this file the welcome screen never replaces the splash.
        // The save, the part under test, is still the mouse's.
        await press({ key: "n", ctrlKey: true });
        await bold();
        nextSavePath = "/notes/fresh.md";

        await click("Save");

        await waitFor(() => expect(disk.get("/notes/fresh.md")).toMatch(/\*\*/));
        expect(screen.getAllByRole("tab").some((t) => /fresh\.md/.test(t.textContent ?? ""))).toBe(true);
    });

    it("saves an edited file in place, without asking where", async () => {
        boot();
        await openViaDialog("/notes/a.md", "# A\n");
        await makeDirty();

        await click("Save");

        await waitFor(() => expect(disk.get("/notes/a.md")).toMatch(/\*\*/));
        expect(dialog.save).not.toHaveBeenCalled();
        await waitFor(() => expect(screen.queryByLabelText("File has unsaved changes")).toBeNull());
    });

    it("Save As writes a copy under the new name", async () => {
        boot();
        await openViaDialog("/notes/a.md", "# A\n");
        await makeDirty();
        nextSavePath = "/notes/copy.md";

        await click("Save As");

        await waitFor(() => expect(disk.get("/notes/copy.md")).toMatch(/\*\*/));
        expect(disk.get("/notes/a.md")).toBe("# A\n");
    });

    it("a cancelled Save As writes nothing and keeps the edits", async () => {
        boot();
        await openViaDialog("/notes/a.md", "# A\n");
        await makeDirty();
        nextSavePath = null;

        await click("Save As");

        await waitFor(() => expect(dialog.save).toHaveBeenCalled());
        expect(invoke.mock.calls.some(([cmd]) => cmd === "save_file")).toBe(false);
        expect(screen.queryByLabelText("File has unsaved changes")).not.toBeNull();
    });
});
