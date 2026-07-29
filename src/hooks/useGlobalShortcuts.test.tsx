import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { useGlobalShortcuts, type ShortcutHandlers } from "./useGlobalShortcuts";

// Unmount between tests so each harness's window keydown listener is removed
// (auto-cleanup isn't configured globally); otherwise listeners stack up.
afterEach(cleanup);

function makeHandlers(over: Partial<ShortcutHandlers> = {}): ShortcutHandlers {
    return {
        handleOpenFile: vi.fn(),
        handleSaveFile: vi.fn(),
        handleSaveAs: vi.fn(),
        handleNewFile: vi.fn(),
        handleToggleMode: vi.fn(),
        handleToggleSplit: vi.fn(),
        toggleFullscreen: vi.fn(),
        handleToggleFileExplorer: vi.fn(),
        handleToggleTOC: vi.fn(),
        handleToggleBacklinks: vi.fn(),
        handleToggleHistory: vi.fn(),
        openCheatsheet: vi.fn(),
        openPalette: vi.fn(),
        openSettings: vi.fn(),
        hasFile: true,
        content: "hello",
        ...over,
    };
}

function Harness({ handlers }: { handlers: ShortcutHandlers }) {
    useGlobalShortcuts(handlers);
    return null;
}

// Returns the event so a caller can assert defaultPrevented. Claiming the key
// from the webview is half the point of these handlers, and a handler that fires
// but never preventDefaults still lets the browser act on the chord.
function press(init: KeyboardEventInit) {
    const ev = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
    window.dispatchEvent(ev);
    return ev;
}

// Reproduces the one property the hook actually reads: defaultPrevented already
// set by the time the event bubbles to window. Dispatching straight at window
// cannot produce that ordering. It does NOT simulate focus, which the hook never
// reads, and it does not prove CodeMirror itself preventDefaults Mod-f, so a
// CodeMirror change there would keep these green.
function pressFromEditor(init: KeyboardEventInit) {
    const el = document.createElement("div");
    document.body.appendChild(el);
    el.addEventListener("keydown", (e) => e.preventDefault());
    const ev = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
    el.dispatchEvent(ev);
    el.remove();
    return ev;
}

describe("useGlobalShortcuts", () => {
    let h: ShortcutHandlers;
    beforeEach(() => {
        h = makeHandlers();
        render(<Harness handlers={h} />);
    });

    it("Ctrl+S saves", () => {
        press({ key: "s", ctrlKey: true });
        expect(h.handleSaveFile).toHaveBeenCalledTimes(1);
    });

    it("Ctrl+S still saves with CapsLock on (key reports 'S')", () => {
        // The regression this guards: an unshifted Ctrl+S under CapsLock reports
        // e.key === "S" and used to fall through to nothing.
        press({ key: "S", ctrlKey: true, shiftKey: false });
        expect(h.handleSaveFile).toHaveBeenCalledTimes(1);
        expect(h.handleSaveAs).not.toHaveBeenCalled();
    });

    it("Ctrl+Shift+S triggers Save As, not Save", () => {
        press({ key: "S", ctrlKey: true, shiftKey: true });
        expect(h.handleSaveAs).toHaveBeenCalledTimes(1);
        expect(h.handleSaveFile).not.toHaveBeenCalled();
    });

    it("Ctrl+O / Ctrl+N work case-insensitively", () => {
        press({ key: "O", ctrlKey: true });
        press({ key: "n", ctrlKey: true });
        expect(h.handleOpenFile).toHaveBeenCalledTimes(1);
        expect(h.handleNewFile).toHaveBeenCalledTimes(1);
    });

    it("Ctrl+E toggles mode only when a file is open", () => {
        press({ key: "e", ctrlKey: true });
        expect(h.handleToggleMode).toHaveBeenCalledTimes(1);
    });

    it("Ctrl+P opens the palette and Ctrl+, opens settings", () => {
        press({ key: "p", ctrlKey: true });
        press({ key: ",", ctrlKey: true });
        expect(h.openPalette).toHaveBeenCalledTimes(1);
        expect(h.openSettings).toHaveBeenCalledTimes(1);
    });

    it("F11 toggles fullscreen", () => {
        press({ key: "F11" });
        expect(h.toggleFullscreen).toHaveBeenCalledTimes(1);
    });

    it("Alt+J dispatches the AI-assist event", () => {
        const onAi = vi.fn();
        window.addEventListener("dumont:ai-assist", onAi);
        press({ key: "j", altKey: true });
        window.removeEventListener("dumont:ai-assist", onAi);
        expect(onAi).toHaveBeenCalledTimes(1);
    });

    it("Ctrl+Shift+H toggles version history", () => {
        press({ key: "H", ctrlKey: true, shiftKey: true });
        expect(h.handleToggleHistory).toHaveBeenCalledTimes(1);
    });
});

describe("useGlobalShortcuts gating", () => {
    it("does not save when there is no file and no content", () => {
        const h = makeHandlers({ hasFile: false, content: "" });
        render(<Harness handlers={h} />);
        press({ key: "s", ctrlKey: true });
        expect(h.handleSaveFile).not.toHaveBeenCalled();
    });

    // One test, not one per view mode. The hook no longer knows the view mode at
    // all: it fires whenever no editor claimed the key, and App decides which bar
    // that means. Three copies differing only in a `mode` field the hook ignored
    // read as covering three paths while exercising one.
    it("Ctrl+F opens find when no editor claimed the key", () => {
        const h = makeHandlers({ openFind: vi.fn() });
        render(<Harness handlers={h} />);
        press({ key: "f", ctrlKey: true });
        expect(h.openFind).toHaveBeenCalledTimes(1);
    });

    // The other half of that: a focused CodeMirror preventDefaults its own Mod-f
    // on the way up, and this listener is on window in the bubble phase, so it
    // must read that flag and keep out. Without the check, every Mod+F in a
    // focused editor would fire both paths.
    it("Ctrl+F keeps out when a focused editor already claimed the key", () => {
        const h = makeHandlers({ openFind: vi.fn() });
        render(<Harness handlers={h} />);
        pressFromEditor({ key: "f", ctrlKey: true });
        expect(h.openFind).not.toHaveBeenCalled();
    });

    // The macOS half of both F shortcuts. Find is deliberately kept out of the
    // native menu, so nothing else covers Cmd here: before these, ⌘F and
    // ⌘⇧F were dead on macOS while the cheatsheet advertised them.
    it("Cmd+F opens find in reader mode, and claims the key", () => {
        const h = makeHandlers({ openFind: vi.fn() });
        render(<Harness handlers={h} />);
        const ev = press({ key: "f", metaKey: true });
        expect(h.openFind).toHaveBeenCalledTimes(1);
        expect(ev.defaultPrevented).toBe(true);
    });

    it("Cmd+F keeps out when a focused editor already claimed the key", () => {
        const h = makeHandlers({ openFind: vi.fn() });
        render(<Harness handlers={h} />);
        pressFromEditor({ key: "f", metaKey: true });
        expect(h.openFind).not.toHaveBeenCalled();
    });

    // A dialog is up, so the find bar would open at z-40 underneath it and pull
    // focus into a field the user cannot see. Nothing in the app preventDefaults
    // an F chord, so defaultPrevented does not cover this and a separate gate has
    // to. The key is left unclaimed too, not just unhandled.
    it("Ctrl+F does nothing while a dialog is open", () => {
        const h = makeHandlers({ modalOpen: true, openFind: vi.fn() });
        render(<Harness handlers={h} />);
        const ev = press({ key: "f", ctrlKey: true });
        expect(h.openFind).not.toHaveBeenCalled();
        expect(ev.defaultPrevented).toBe(false);
    });

    // Opt+Cmd+F is the editor's replace. The find handler must not eat it.
    it("Opt+Cmd+F does not open find", () => {
        const h = makeHandlers({ openFind: vi.fn() });
        render(<Harness handlers={h} />);
        press({ key: "f", metaKey: true, altKey: true });
        expect(h.openFind).not.toHaveBeenCalled();
    });

    // The File Explorer menu item carries no accelerator, so the hook is the only
    // thing covering this one and Cmd+Shift+E was dead on macOS.
    it("Cmd+Shift+E toggles the file explorer", () => {
        const h = makeHandlers();
        render(<Harness handlers={h} />);
        press({ key: "e", metaKey: true, shiftKey: true });
        expect(h.handleToggleFileExplorer).toHaveBeenCalledTimes(1);
    });

    it("Ctrl+Shift+E still toggles the file explorer", () => {
        const h = makeHandlers();
        render(<Harness handlers={h} />);
        press({ key: "E", ctrlKey: true, shiftKey: true });
        expect(h.handleToggleFileExplorer).toHaveBeenCalledTimes(1);
    });

    // The shortcuts below are registered as native menu accelerators in
    // src-tauri/src/menu.rs, and AppKit matches those before the key reaches the
    // webview. Handling them here TOO would run them twice on macOS, which for a
    // toggle means it flips back and looks like nothing happened.
    //
    // These four tests exist because the alternative is a comment. Widening them
    // to (ctrlKey || metaKey) "for consistency" with the F and E handlers is the
    // single most plausible way this regresses, and prose does not fail CI.
    it("Cmd+E is left to the menu, not handled here", () => {
        const h = makeHandlers();
        render(<Harness handlers={h} />);
        press({ key: "e", metaKey: true });
        expect(h.handleToggleMode).not.toHaveBeenCalled();
    });

    it("Cmd+Shift+O is left to the menu, not handled here", () => {
        const h = makeHandlers();
        render(<Harness handlers={h} />);
        press({ key: "o", metaKey: true, shiftKey: true });
        expect(h.handleToggleTOC).not.toHaveBeenCalled();
    });

    it("Cmd+Shift+B is left to the menu, not handled here", () => {
        const h = makeHandlers();
        render(<Harness handlers={h} />);
        press({ key: "b", metaKey: true, shiftKey: true });
        expect(h.handleToggleBacklinks).not.toHaveBeenCalled();
    });

    it("Cmd+Shift+H is left to the menu, not handled here", () => {
        const h = makeHandlers();
        render(<Harness handlers={h} />);
        press({ key: "h", metaKey: true, shiftKey: true });
        expect(h.handleToggleHistory).not.toHaveBeenCalled();
    });

    // AltGr reports as ctrlKey+altKey on Windows and Linux layouts, so the
    // widened handlers must not swallow it.
    it("Ctrl+Alt+Shift+E does not toggle the file explorer", () => {
        const h = makeHandlers();
        render(<Harness handlers={h} />);
        press({ key: "e", ctrlKey: true, altKey: true, shiftKey: true });
        expect(h.handleToggleFileExplorer).not.toHaveBeenCalled();
    });

    it("Ctrl+Alt+Shift+F does not open cross-file search", () => {
        const h = makeHandlers({ openSearch: vi.fn() });
        render(<Harness handlers={h} />);
        press({ key: "f", ctrlKey: true, altKey: true, shiftKey: true });
        expect(h.openSearch).not.toHaveBeenCalled();
    });

    it("Cmd+Shift+F opens cross-file search, and claims the key", () => {
        const h = makeHandlers({ openSearch: vi.fn() });
        render(<Harness handlers={h} />);
        const ev = press({ key: "f", metaKey: true, shiftKey: true });
        expect(h.openSearch).toHaveBeenCalledTimes(1);
        expect(ev.defaultPrevented).toBe(true);
    });

    it("Ctrl+Shift+F still opens cross-file search", () => {
        const h = makeHandlers({ openSearch: vi.fn() });
        render(<Harness handlers={h} />);
        press({ key: "F", ctrlKey: true, shiftKey: true });
        expect(h.openSearch).toHaveBeenCalledTimes(1);
    });

    // The find branch requires !shiftKey, so the shifted chord cannot reach it.
    // (The early return in the cross-file branch is belt and braces, not what
    // makes this hold, so deleting that return would leave this test green.)
    it("Cmd+Shift+F does not also open the find bar", () => {
        const h = makeHandlers({ openSearch: vi.fn(), openFind: vi.fn() });
        render(<Harness handlers={h} />);
        press({ key: "f", metaKey: true, shiftKey: true });
        expect(h.openFind).not.toHaveBeenCalled();
    });

    it("Ctrl+Shift+H does nothing on the welcome screen", () => {
        const h = makeHandlers({ hasFile: false, content: "" });
        render(<Harness handlers={h} />);
        press({ key: "H", ctrlKey: true, shiftKey: true });
        expect(h.handleToggleHistory).not.toHaveBeenCalled();
    });

    it("Ctrl+Shift+B does nothing on the welcome screen", () => {
        const h = makeHandlers({ hasFile: false, content: "" });
        render(<Harness handlers={h} />);
        press({ key: "B", ctrlKey: true, shiftKey: true });
        expect(h.handleToggleBacklinks).not.toHaveBeenCalled();
    });

    /**
     * Ctrl+B is the editor's bold. Only the SHIFTED chord may reach backlinks, or
     * binding this panel would silently take bold away from every document.
     */
    it("leaves an unshifted Ctrl+B alone, so the editor keeps bold", () => {
        const h = makeHandlers();
        render(<Harness handlers={h} />);
        press({ key: "b", ctrlKey: true });
        expect(h.handleToggleBacklinks).not.toHaveBeenCalled();
    });

    it("Ctrl+Shift+B opens backlinks when a file is open", () => {
        const h = makeHandlers();
        render(<Harness handlers={h} />);
        press({ key: "B", ctrlKey: true, shiftKey: true });
        expect(h.handleToggleBacklinks).toHaveBeenCalledTimes(1);
    });
});
