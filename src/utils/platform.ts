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

/** True on Windows. Only interesting because WebView2 claims some keys there. */
export const IS_WINDOWS = /win/i.test(ua);
