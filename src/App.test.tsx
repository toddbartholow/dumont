import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
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

const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    const path = args?.path as string;
    switch (cmd) {
        case "read_file": {
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
        default:
            return null;
    }
});

/** What the OS file picker answers next. */
let nextOpenPath: string | null = null;
let nextSavePath: string | null = null;

vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...(a as [string])) }));
vi.mock("@tauri-apps/api/event", () => ({
    listen: vi.fn(async () => () => {}),
    TauriEvent: { DRAG_DROP: "drag-drop", WINDOW_CLOSE_REQUESTED: "close" },
}));
const win = {
    setTitle: vi.fn(async () => {}),
    destroy: vi.fn(async () => {}),
    onCloseRequested: vi.fn(async () => () => {}),
    isFullscreen: vi.fn(async () => false),
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

beforeAll(installCodeMirrorDomPolyfills);

beforeEach(() => {
    disk.clear();
    mtimes.clear();
    localStorage.clear();
    invoke.mockClear();
    nextOpenPath = null;
    nextSavePath = null;
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
    await waitFor(() => expect(document.body.textContent).toMatch(/Unsaved/i));
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
