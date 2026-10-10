import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import { renderHook, act } from "@testing-library/react";

// Pose as macOS before platform.ts is loaded: IS_MAC is read once, at import,
// from navigator.platform. The modules below are imported dynamically for that
// reason; a static import would be hoisted above this line.
Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
afterAll(() => {
    delete (navigator as unknown as Record<string, unknown>).platform;
});

/** The fake window: its fullscreen flag, and the resize listener the hook registers. */
let osFullscreen = false;
let onResize: (() => void) | null = null;
const win = {
    isFullscreen: vi.fn(async () => osFullscreen),
    setFullscreen: vi.fn(async (v: boolean) => { osFullscreen = v; }),
    isMaximized: vi.fn(async () => false),
    unmaximize: vi.fn(async () => {}),
    maximize: vi.fn(async () => {}),
    onResized: vi.fn(async (cb: () => void) => {
        onResize = cb;
        return () => { onResize = null; };
    }),
};
vi.mock("@tauri-apps/api/window", () => ({ Window: { getCurrent: () => win } }));

const { useFullscreen } = await import("./useFullscreen");
const { IS_MAC } = await import("../utils/platform");

/** The OS changes fullscreen behind the hook's back, as the native ⌃⌘F does. */
async function osToggles(to: boolean) {
    osFullscreen = to;
    await act(async () => {
        onResize?.();
        await Promise.resolve();
    });
}

/** Run the hook's own toggle through its fade timers. */
async function toggle(fn: () => Promise<void>) {
    await act(async () => {
        const p = fn();
        await vi.advanceTimersByTimeAsync(500);
        await p;
    });
}

/** Mount the hook with window sync on, and let its listener register. */
async function mountSynced() {
    const hook = renderHook(() => useFullscreen(vi.fn(), { syncFromWindow: true }));
    await act(async () => {});
    return hook;
}

beforeEach(() => {
    osFullscreen = false;
    onResize = null;
    vi.clearAllMocks();
    win.isMaximized.mockImplementation(async () => false);
    win.setFullscreen.mockImplementation(async (v: boolean) => { osFullscreen = v; });
    win.unmaximize.mockImplementation(async () => {});
    win.onResized.mockImplementation(async (cb: () => void) => {
        onResize = cb;
        return () => { onResize = null; };
    });
    vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe("useFullscreen", () => {
    it("is posing as macOS, which the tests below rely on", () => {
        expect(IS_MAC).toBe(true);
    });

    // The native View menu's Toggle Full Screen never calls the hook. Before this
    // the title bar kept offering "Maximize" on a fullscreen window.
    it("follows a fullscreen change it did not make", async () => {
        const { result } = await mountSynced();

        await osToggles(true);
        expect(result.current.isFullscreen).toBe(true);

        await osToggles(false);
        expect(result.current.isFullscreen).toBe(false);
    });

    it("syncs from the window by default on macOS", async () => {
        const { result } = renderHook(() => useFullscreen(vi.fn()));
        await act(async () => {});

        await osToggles(true);
        expect(result.current.isFullscreen).toBe(true);
    });

    // After the OS entered fullscreen, the hook's own toggle has to mean "exit".
    it("exits on its next toggle after the OS entered fullscreen", async () => {
        const { result } = await mountSynced();
        await osToggles(true);

        await toggle(result.current.toggleFullscreen);

        expect(win.setFullscreen).toHaveBeenLastCalledWith(false);
        expect(result.current.isFullscreen).toBe(false);
    });

    // Windows and Linux: the hook keeps its own count and does not listen.
    it("keeps its own state when not syncing from the window", async () => {
        const { result } = renderHook(() => useFullscreen(vi.fn(), { syncFromWindow: false }));
        await act(async () => {});

        expect(win.onResized).not.toHaveBeenCalled();
        await toggle(result.current.toggleFullscreen);
        expect(result.current.isFullscreen).toBe(true);
    });

    // Asserted under the macOS pose, so the old hard-coded F11 fails it.
    it("names the macOS fullscreen key in the hint", async () => {
        const notify = vi.fn();
        const { result } = renderHook(() => useFullscreen(notify, { syncFromWindow: false }));

        await toggle(result.current.toggleFullscreen);

        expect(notify).toHaveBeenCalledWith("Fullscreen on. Press ⌃⌘F to exit");
    });

    // The window resizes during the hook's own transition (unmaximize, then
    // fullscreen). Read then, the half-done state would be taken as an outside
    // change, and that throws away the remembered maximize.
    it("ignores resizes from its own toggle, and restores the maximize on exit", async () => {
        win.isMaximized.mockImplementation(async () => true);
        win.unmaximize.mockImplementation(async () => { onResize?.(); });
        win.setFullscreen.mockImplementation(async (v: boolean) => { osFullscreen = v; onResize?.(); });
        const { result } = await mountSynced();

        await toggle(result.current.toggleFullscreen);
        await toggle(result.current.toggleFullscreen);

        expect(win.maximize).toHaveBeenCalledTimes(1);
        expect(result.current.isFullscreen).toBe(false);
    });

    // Maximized -> fullscreen -> exit, all through the hook, leaves the window
    // maximized and the ref saying so. If the user then unmaximizes and enters
    // fullscreen some other way, exiting through the hook must not re-maximize.
    it("forgets a stale maximize once fullscreen changes behind its back", async () => {
        win.isMaximized.mockImplementation(async () => true);
        const { result } = await mountSynced();
        await toggle(result.current.toggleFullscreen);
        await toggle(result.current.toggleFullscreen);
        win.maximize.mockClear();

        await osToggles(true);
        await toggle(result.current.toggleFullscreen);

        expect(win.setFullscreen).toHaveBeenLastCalledWith(false);
        expect(win.maximize).not.toHaveBeenCalled();
    });

    // Two toggles overlapping: the first finishing must not reopen the gate
    // while the second is still resizing the window.
    it("keeps ignoring resizes until every overlapping toggle is done", async () => {
        const pending: (() => void)[] = [];
        win.setFullscreen.mockImplementation(
            (v: boolean) => new Promise<void>((resolve) => pending.push(() => { osFullscreen = v; resolve(); })),
        );
        const { result } = await mountSynced();

        let first!: Promise<void>, second!: Promise<void>;
        await act(async () => {
            first = result.current.toggleFullscreen();
            second = result.current.toggleFullscreen();
            await vi.advanceTimersByTimeAsync(200);
        });
        expect(pending).toHaveLength(2);

        await act(async () => {
            pending[0]();
            await first;
        });
        expect(result.current.isFullscreen).toBe(true);

        // The second toggle is still mid-flight and the OS reports a transient
        // state. With a flag, the first toggle's finally had already cleared the
        // guard, and this read flipped the state.
        osFullscreen = false;
        await act(async () => {
            onResize?.();
            await Promise.resolve();
            await Promise.resolve();
        });
        expect(result.current.isFullscreen).toBe(true);

        await act(async () => {
            pending[1]();
            await second;
            await vi.advanceTimersByTimeAsync(500);
        });
    });

    // A toggle that starts while a resize's read is still in flight: the read
    // predates the toggle, so its answer must be dropped, not applied on top.
    it("drops a read that a toggle overtook", async () => {
        const { result } = await mountSynced();
        let answer!: (fs: boolean) => void;
        win.isFullscreen.mockImplementationOnce(() => new Promise<boolean>((resolve) => { answer = resolve; }));

        let toggling!: Promise<void>;
        await act(async () => {
            onResize?.();
            toggling = result.current.toggleFullscreen();
            answer(true);
            await Promise.resolve();
            await Promise.resolve();
        });
        expect(result.current.isFullscreen).toBe(false);

        await act(async () => {
            await vi.advanceTimersByTimeAsync(500);
            await toggling;
        });
        expect(result.current.isFullscreen).toBe(true);
    });

    // Unmounted before Tauri finished registering the listener: the late
    // unlisten still has to run, or the listener outlives the component.
    it("unlistens when unmounted before the listener registered", async () => {
        let register!: (fn: () => void) => void;
        win.onResized.mockImplementation(() => new Promise<() => void>((resolve) => { register = resolve; }));
        const unlisten = vi.fn();
        const { unmount } = renderHook(() => useFullscreen(vi.fn(), { syncFromWindow: true }));

        unmount();
        await act(async () => {
            register(unlisten);
            await Promise.resolve();
        });

        expect(unlisten).toHaveBeenCalledTimes(1);
    });
});
