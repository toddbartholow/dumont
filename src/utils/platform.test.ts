import { describe, it, expect } from "vitest";
import { shortcutLabel, aiAssistShortcut, fullscreenShortcut } from "./platform";

describe("shortcutLabel", () => {
    it("spells Mod as Ctrl off macOS", () => {
        expect(shortcutLabel("Mod+S", false)).toBe("Ctrl+S");
        expect(shortcutLabel("Mod+Shift+S", false)).toBe("Ctrl+Shift+S");
        expect(shortcutLabel("Mod+,", false)).toBe("Ctrl+,");
        expect(shortcutLabel("Mod+\\", false)).toBe("Ctrl+\\");
    });

    it("renders Mod as ⌘ on macOS, in the native menu's form", () => {
        expect(shortcutLabel("Mod+S", true)).toBe("⌘S");
        expect(shortcutLabel("Mod+Shift+S", true)).toBe("⇧⌘S");
        expect(shortcutLabel("Alt+Mod+F", true)).toBe("⌥⌘F");
    });

    // Written in any order, printed in Apple's: ⌃⌥⇧⌘.
    it("orders macOS modifiers the way the menu bar does", () => {
        expect(shortcutLabel("Mod+Shift+Alt+Ctrl+X", true)).toBe("⌃⌥⇧⌘X");
        expect(shortcutLabel("Shift+Mod+T", true)).toBe("⇧⌘T");
    });

    // Ctrl+Tab is Control on a Mac too. Rendering it as ⌘ would send the user
    // to the app switcher.
    it("keeps a real Ctrl chord as Control on every platform", () => {
        expect(shortcutLabel("Ctrl+Tab", true)).toBe("⌃Tab");
        expect(shortcutLabel("Ctrl+Shift+Tab", true)).toBe("⌃⇧Tab");
        expect(shortcutLabel("Ctrl+Tab", false)).toBe("Ctrl+Tab");
    });

    it("spells Alt as ⌥ on macOS and Alt elsewhere", () => {
        expect(shortcutLabel("Alt+←/→", true)).toBe("⌥←/→");
        expect(shortcutLabel("Alt+←/→", false)).toBe("Alt+←/→");
    });

    it("passes a bare key through", () => {
        expect(shortcutLabel("?", true)).toBe("?");
        expect(shortcutLabel("F11", false)).toBe("F11");
    });

    it("says Ctrl once when a chord names both Mod and Ctrl off macOS", () => {
        expect(shortcutLabel("Ctrl+Mod+F", false)).toBe("Ctrl+F");
    });
});

describe("platform shortcut hints", () => {
    // The handler takes Alt+J and Cmd+J, never Ctrl+J: WebView2 claims it on
    // Windows, and on Linux nothing listens for it.
    it("AI assist is ⌘J on macOS and Alt+J on Windows and Linux", () => {
        expect(aiAssistShortcut(true)).toBe("⌘J");
        expect(aiAssistShortcut(false)).toBe("Alt+J");
    });

    it("fullscreen is the View menu's ⌃⌘F on macOS and F11 elsewhere", () => {
        expect(fullscreenShortcut(true)).toBe("⌃⌘F");
        expect(fullscreenShortcut(false)).toBe("F11");
    });
});
