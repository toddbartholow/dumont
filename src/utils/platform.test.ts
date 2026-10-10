import { describe, it, expect, vi, afterEach } from "vitest";
import { shortcutLabel, aiAssistShortcut, fullscreenShortcut, completionShortcut } from "./platform";

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

    // Control on every platform, and nothing else: CodeMirror's Mac-only Alt-`
    // binding is a dead key on a US layout and is not advertised.
    it("completion is Ctrl+Space, Control on macOS too", () => {
        expect(completionShortcut(false)).toBe("Ctrl+Space");
        expect(completionShortcut(true)).toBe("⌃Space");
    });
});

// IS_MAC and IS_WINDOWS are read once, at import, from navigator.platform with
// the user agent as the fallback, so each case reloads the module under a pose.
describe("platform detection", () => {
    afterEach(() => {
        delete (navigator as unknown as Record<string, unknown>).platform;
        delete (navigator as unknown as Record<string, unknown>).userAgent;
        vi.resetModules();
    });

    async function detect(platform: string, userAgent: string) {
        Object.defineProperty(navigator, "platform", { value: platform, configurable: true });
        Object.defineProperty(navigator, "userAgent", { value: userAgent, configurable: true });
        vi.resetModules();
        const { IS_MAC, IS_WINDOWS } = await import("./platform");
        return { IS_MAC, IS_WINDOWS };
    }

    // jsdom's user agent on a Mac. A bare /win/ matched the "win" in darwin.
    it("does not take darwin for Windows", async () => {
        expect(await detect("", "Mozilla/5.0 (darwin) AppleWebKit/537.36 (KHTML, like Gecko) jsdom/26.1.0"))
            .toEqual({ IS_MAC: false, IS_WINDOWS: false });
    });

    it.each(["Win32", "Win64"])("recognizes Windows from navigator.platform %s", async (platform) => {
        expect((await detect(platform, "")).IS_WINDOWS).toBe(true);
    });

    it("recognizes Windows from the user agent when platform is blank", async () => {
        expect((await detect("", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).IS_WINDOWS).toBe(true);
    });

    it("recognizes macOS and leaves it off Windows", async () => {
        expect(await detect("MacIntel", "")).toEqual({ IS_MAC: true, IS_WINDOWS: false });
    });

    it("leaves Linux as neither", async () => {
        expect(await detect("Linux x86_64", "")).toEqual({ IS_MAC: false, IS_WINDOWS: false });
    });
});
