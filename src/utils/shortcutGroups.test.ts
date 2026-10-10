import { describe, it, expect } from "vitest";
import { matchesShortcut, shortcutGroups, shortcutSearchText } from "./shortcutGroups";

const keysFor = (mac: boolean, description: string) =>
    shortcutGroups(mac).flatMap((g) => g.items).filter((it) => it.description === description).map((it) => it.keys);

describe("shortcut cheatsheet rows", () => {
    it.each([true, false])("lists no row twice (mac: %s)", (mac) => {
        const rows = shortcutGroups(mac).flatMap((g) => g.items.map((it) => `${it.keys} ${it.description}`));
        expect(new Set(rows).size).toBe(rows.length);
    });

    // New and Close were listed under File AND Tabs, so the filter showed each twice.
    it.each([true, false])("lists each key for one action only once (mac: %s)", (mac) => {
        const all = shortcutGroups(mac).flatMap((g) => g.items);
        const n = all.filter((it) => it.keys === (mac ? "⌘N" : "Ctrl+N")).length;
        const w = all.filter((it) => it.keys === (mac ? "⌘W" : "Ctrl+W")).length;
        expect(n).toBe(1);
        expect(w).toBe(1);
    });

    // The handler listens for Ctrl+Tab on every platform. ⌘Tab is the macOS app
    // switcher and never reaches the app.
    it("shows Control, not Cmd, for tab cycling on macOS", () => {
        expect(keysFor(true, "Next tab")).toEqual(["⌃Tab"]);
        expect(keysFor(true, "Previous tab")).toEqual(["⌃⇧Tab"]);
        expect(keysFor(false, "Next tab")).toEqual(["Ctrl+Tab"]);
    });

    it("shows Cmd for reopen and jump-to-tab on macOS, which the handler now takes", () => {
        expect(keysFor(true, "Reopen closed tab")).toEqual(["⇧⌘T"]);
        expect(keysFor(true, "Jump to tab N")).toEqual(["⌘1-8"]);
        expect(keysFor(false, "Reopen closed tab")).toEqual(["Ctrl+Shift+T"]);
    });

    // F11 is Show Desktop on macOS; the View menu's Toggle Full Screen is ⌃⌘F.
    it("shows the key that actually toggles fullscreen on each platform", () => {
        expect(keysFor(true, "Toggle fullscreen")).toEqual(["⌃⌘F"]);
        expect(keysFor(false, "Toggle fullscreen")).toEqual(["F11"]);
    });

    // Linux used to be shown Ctrl+J, which the handler does not listen for.
    it("shows Alt+J for AI assist off macOS and ⌘J on it", () => {
        const ai = "AI assist on selection (also: the AI toolbar button, command palette)";
        expect(keysFor(false, ai)).toEqual(["Alt+J"]);
        expect(keysFor(true, ai)).toEqual(["⌘J"]);
    });

    it("keeps replace off Cmd+H on macOS, where it is Hide", () => {
        expect(keysFor(true, "Find and replace")).toEqual(["⌥⌘F"]);
        expect(keysFor(false, "Find and replace")).toEqual(["Ctrl+H"]);
    });
});

// On macOS the keys are glyphs, so the filter has to know their names.
describe("shortcut cheatsheet filter", () => {
    const find = (mac: boolean, q: string) =>
        shortcutGroups(mac).flatMap((g) => g.items).filter((it) => matchesShortcut(it, q)).map((it) => it.description);

    it.each(["shift", "cmd", "command", "ctrl+shift+s", "shift+s"])("finds Save As on macOS by %s", (q) => {
        expect(find(true, q)).toContain("Save As…");
    });

    it("finds replace on macOS by option or alt", () => {
        expect(find(true, "option")).toContain("Find and replace");
        expect(find(true, "alt")).toContain("Find and replace");
    });

    it("finds tab cycling on macOS by ctrl or control", () => {
        expect(find(true, "control")).toContain("Next tab");
        expect(find(true, "ctrl+tab")).toContain("Next tab");
    });

    it("still matches the spelled-out keys off macOS", () => {
        expect(find(false, "ctrl+shift+s")).toContain("Save As…");
        expect(find(false, "cmd")).toEqual([]);
    });

    it("spells a glyph label the off-macOS way", () => {
        expect(shortcutSearchText("⇧⌘S")).toContain("ctrl+shift+s");
        expect(shortcutSearchText("⌥←/→")).toContain("alt+←/→");
        expect(shortcutSearchText("Ctrl+Tab")).toBe("ctrl+tab");
    });
});
