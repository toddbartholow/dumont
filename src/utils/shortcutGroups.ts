import { IS_MAC, aiAssistShortcut, fullscreenShortcut, shortcutLabel } from "./platform";

export interface Shortcut {
    keys: string;
    description: string;
}

export interface ShortcutGroup {
    title: string;
    items: Shortcut[];
}

/**
 * The cheatsheet's rows. Every one has to be true on the platform it is shown
 * on, which means naming the key the handler (useGlobalShortcuts, the editor's
 * keymap, or a native menu accelerator in menu.rs) actually listens for there.
 * Chords go through shortcutLabel: "Mod" for Cmd-on-macOS, "Ctrl" only where
 * the binding really is Control everywhere.
 *
 * A function of `mac` rather than a constant so the tests can check both
 * platforms' rows.
 */
export function shortcutGroups(mac: boolean = IS_MAC): ShortcutGroup[] {
    const k = (chord: string) => shortcutLabel(chord, mac);
    return [
        {
            title: "File",
            items: [
                { keys: k("Mod+O"), description: "Open file" },
                { keys: k("Mod+N"), description: "New file (new tab)" },
                { keys: k("Mod+W"), description: "Close tab" },
                { keys: k("Mod+S"), description: "Save" },
                { keys: k("Mod+Shift+S"), description: "Save As…" },
            ],
        },
        {
            // New and Close live under File only; listing them twice made the
            // filter return each one twice.
            title: "Tabs",
            items: [
                { keys: k("Mod+Shift+T"), description: "Reopen closed tab" },
                // Ctrl on macOS too. Cmd+Tab is the system app switcher and never
                // reaches the app; the handler listens for Ctrl+Tab everywhere.
                { keys: k("Ctrl+Tab"), description: "Next tab" },
                { keys: k("Ctrl+Shift+Tab"), description: "Previous tab" },
                // Not while typing: in the editor and text fields Alt+Arrow moves
                // the caret by word, and the Ctrl+Tab pair above is the way there.
                { keys: k("Alt+←/→"), description: "Previous / next tab (outside the editor)" },
                { keys: k("Mod+1-8"), description: "Jump to tab N" },
                { keys: k("Mod+9"), description: "Jump to last tab" },
            ],
        },
        {
            title: "View",
            items: [
                { keys: k("Mod+E"), description: "Toggle Reader / Code" },
                { keys: k("Mod+\\"), description: "Toggle split view" },
                // F11 is Show Desktop on macOS and never reaches the app. ⌃⌘F is the
                // native View menu's Toggle Full Screen.
                { keys: fullscreenShortcut(mac), description: "Toggle fullscreen" },
                { keys: k("Mod+Shift+B"), description: "Toggle backlinks" },
                { keys: k("Mod+Shift+E"), description: "Toggle file explorer" },
                // Two Find rows, because there are two find bars and they are not the
                // same feature: the reader searches rendered text, the editor searches
                // the source and can replace. The editor's row lives in the editor
                // navigation group below, with its own modifier note.
                { keys: k("Mod+F"), description: "Find in page (reader mode)" },
                { keys: k("Mod+Shift+F"), description: "Search across files" },
                { keys: k("Mod+Shift+O"), description: "Toggle outline" },
                { keys: k("Mod+Shift+H"), description: "Toggle version history" },
                { keys: k("Mod+P"), description: "Command palette" },
                { keys: k("Mod+,"), description: "Open settings" },
                { keys: "?", description: "Show this cheatsheet" },
            ],
        },
        {
            title: "AI",
            items: [
                { keys: aiAssistShortcut(mac), description: "AI assist on selection (also: the AI toolbar button, command palette)" },
            ],
        },
        {
            title: "Editor: Formatting",
            items: [
                { keys: k("Mod+B"), description: "Bold (toggle)" },
                { keys: k("Mod+I"), description: "Italic (toggle)" },
                { keys: k("Mod+K"), description: "Insert link" },
                { keys: k("Mod+/"), description: "Toggle blockquote on line" },
            ],
        },
        {
            title: "Editor: Navigation",
            items: [
                { keys: "Tab", description: "Indent line / selection" },
                { keys: k("Shift+Tab"), description: "Outdent line / selection" },
                { keys: "Enter", description: "Continue list, blockquote, or task item" },
                { keys: k("Mod+F"), description: "Find" },
                // NOT Cmd+H on macOS: that is Hide, and the OS matches a menu key
                // equivalent before the editor ever sees the key. Option+Cmd+F is where
                // mac editors put replace. Ctrl+H is still right everywhere else.
                { keys: k(mac ? "Alt+Mod+F" : "Mod+H"), description: "Find and replace" },
            ],
        },
        {
            title: "Editor: Auto-pair",
            items: [
                { keys: "( [ { ` \" '", description: "Wrap selection or insert pair" },
                { keys: ") ] } ` \" '", description: "Type past matching closer" },
                { keys: "Backspace", description: "Removes empty pair atomically" },
            ],
        },
        {
            title: "Slash & Smart Paste",
            items: [
                { keys: "/", description: "Slash menu (at line start)" },
                { keys: "Paste URL on selection", description: "Wraps selection as link" },
                { keys: "Paste rich HTML", description: "Converts to markdown" },
                { keys: "Paste tab-separated", description: "Converts to GFM table" },
            ],
        },
    ];
}
