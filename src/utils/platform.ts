// Single source of truth for "which OS is this", because the shortcut hints the
// UI shows have to match the modifiers the handlers actually listen for.
//
// There were four private copies of this before, in two different flavors, and
// they had already drifted: two tested `navigator.platform` alone, two fell back
// to `navigator.userAgent`. `navigator.platform` is deprecated and returns ""
// under some privacy-hardened configurations, so the copies without the fallback
// would quietly render "Ctrl+F" to a Mac user while Cmd+F was the binding that
// worked. The fallback form is the one that survives that, so it is the one here.
//
// Same lesson as appearanceOptions.ts: two surfaces describing one fact keep
// their own copies, and the copies drift.

const ua = typeof navigator !== "undefined" ? navigator.platform || navigator.userAgent || "" : "";

/** True on macOS, where the app's Mod key hints render as ⌘. */
export const IS_MAC = /mac|ipod|iphone|ipad/i.test(ua);

/** True on Windows. Only interesting because WebView2 claims some keys there.
 *  Not a bare /win/: that matches "darwin", which is what jsdom's user agent
 *  says on a Mac, and made tests behave differently by host. navigator.platform
 *  is "Win32" (or "Win64") on Windows; the user agent says "Windows NT". */
export const IS_WINDOWS = /\bwin(32|64|dows)\b/i.test(ua);

// macOS glyphs, in the order Apple's own menus print them: ⌃⌥⇧⌘.
const MAC_ORDER = ["Ctrl", "Alt", "Shift", "Mod"] as const;
const MAC_GLYPH: Record<string, string> = { Ctrl: "⌃", Alt: "⌥", Shift: "⇧", Mod: "⌘" };
const PC_ORDER = ["Mod", "Ctrl", "Alt", "Shift"] as const;
const PC_NAME: Record<string, string> = { Mod: "Ctrl", Ctrl: "Ctrl", Alt: "Alt", Shift: "Shift" };

/**
 * A shortcut the way this platform writes it, so a hint names the key the
 * handler actually listens for.
 *
 * Write the chord CodeMirror-style, with "+" between parts. "Mod" is the key
 * that is Cmd on macOS and Ctrl elsewhere; "Ctrl" is Control on every platform,
 * for the few chords that really are Control on a Mac too (Ctrl+Tab). Mixing
 * them up is the bug this exists to prevent: Cmd+Tab is the macOS app switcher.
 *
 * macOS gets its menu-bar form, glyphs and no separator ("Mod+Shift+S" reads
 * ⇧⌘S, matching the native menu next to it). Everywhere else is spelled out:
 * Ctrl+Shift+S. The last part is the key and passes through untouched.
 */
export function shortcutLabel(chord: string, mac: boolean = IS_MAC): string {
    const parts = chord.split("+");
    const key = parts.pop() ?? "";
    const mods = new Set(parts);
    if (mac) return MAC_ORDER.filter((m) => mods.has(m)).map((m) => MAC_GLYPH[m]).join("") + key;
    // Mod and Ctrl are the same key off macOS, so a chord naming both says it once.
    const names = PC_ORDER.filter((m) => mods.has(m)).map((m) => PC_NAME[m]);
    return [...new Set(names), key].join("+");
}

/** AI assist: Cmd+J on macOS; Alt+J elsewhere, since WebView2 takes Ctrl+J on
 *  Windows and the handler does not listen for Ctrl+J on Linux either. */
export function aiAssistShortcut(mac: boolean = IS_MAC): string {
    return shortcutLabel(mac ? "Mod+J" : "Alt+J", mac);
}

/** Fullscreen. F11 on Windows and Linux. On macOS F11 is Show Desktop and never
 *  reaches the app; the native View menu's Toggle Full Screen owns ⌃⌘F there. */
export function fullscreenShortcut(mac: boolean = IS_MAC): string {
    return mac ? shortcutLabel("Ctrl+Mod+F", true) : "F11";
}

/** Open the completion list in a CodeMirror editor: Ctrl+Space, which is
 *  Control on macOS too. CodeMirror's completionKeymap also carries a Mac-only
 *  Alt-`, deliberately not offered: on a US layout Option+` is a dead key, the
 *  event's key is "Dead", and CodeMirror skips its physical-key fallback for
 *  Alt-only chords on macOS, so that binding most likely never matches. */
export function completionShortcut(mac: boolean = IS_MAC): string {
    return shortcutLabel("Ctrl+Space", mac);
}
