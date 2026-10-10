import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

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
const { fullscreenShortcut } = await import("../utils/platform");

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

beforeEach(() => {
    osFullscreen = false;
    onResize = null;
    vi.clearAllMocks();
    vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe("useFullscreen", () => {
    // The native View menu's Toggle Full Screen never calls the hook. Before this
    // the title bar kept offering "Maximize" on a fullscreen window.
    it("follows a fullscreen change it did not make", async () => {
        const { result } = renderHook(() => useFullscreen(vi.fn(), { syncFromWindow: true }));
        await act(async () => {});

        await osToggles(true);
        expect(result.current.isFullscreen).toBe(true);

        await osToggles(false);
        expect(result.current.isFullscreen).toBe(false);
    });

    // After the OS entered fullscreen, the hook's own toggle has to mean "exit".
    it("exits on its next toggle after the OS entered fullscreen", async () => {
        const { result } = renderHook(() => useFullscreen(vi.fn(), { syncFromWindow: true }));
        await act(async () => {});
        await osToggles(true);

        await toggle(result.current.toggleFullscreen);

        expect(win.setFullscreen).toHaveBeenLastCalledWith(false);
        expect(result.current.isFullscreen).toBe(false);
    });

    // Windows: isFullscreen() is unreliable on a frameless window there, so the
    // hook keeps its own count and does not listen.
    it("keeps its own state when not syncing from the window", async () => {
        const { result } = renderHook(() => useFullscreen(vi.fn(), { syncFromWindow: false }));
        await act(async () => {});

        expect(win.onResized).not.toHaveBeenCalled();
        await toggle(result.current.toggleFullscreen);
        expect(result.current.isFullscreen).toBe(true);
    });

    it("names this platform's fullscreen key in the hint", async () => {
        const notify = vi.fn();
        const { result } = renderHook(() => useFullscreen(notify, { syncFromWindow: false }));

        await toggle(result.current.toggleFullscreen);

        expect(notify).toHaveBeenCalledWith(`Fullscreen on. Press ${fullscreenShortcut()} to exit`);
    });
});
