// Modified by IRQ Studio, LLC (2026) from an Apache-2.0 licensed original.
// See NOTICE for attribution and license terms.

/**
 * The five themes Dumont ships, lifted verbatim out of the [data-theme] blocks
 * that used to live in index.css. These are the shipped colors: the comments
 * that carry a contrast ratio came with the value and are the reason it is what
 * it is, so they traveled with it.
 *
 * None of them uses `extends`. They look like they could (four of them are
 * variations on "a dark editor"), but they share almost no literal values: light
 * and dark agree on exactly one of the 37 tokens. Inheriting to save a line would
 * mean a tweak to dark silently repainting Dracula. `extends` exists for a user's
 * "dark, but with a red accent", which overrides three tokens and means it.
 */
import type { ThemeDef } from "./types";

const dark: ThemeDef = {
    id: "dark",
    name: "Dark",
    type: "dark",
    tokens: {
        "--bg-primary": "#0a0a0a",
        "--bg-secondary": "#141414",
        "--bg-titlebar": "#0a0a0a",
        "--bg-editor": "#0a0a0a",
        "--bg-gutter": "#0f0f0f",
        "--bg-hover": "#1f1f1f",
        "--bg-input": "#141414",

        "--text-primary": "#ffffff",
        // #737373 was 3.89:1 on --bg-secondary, below the 4.5:1 AA floor for the
        // secondary labels it is used for.
        "--text-secondary": "#8a8a8a", // 4.77:1 on --bg-hover, 5.34:1 on --bg-secondary
        "--text-muted": "#525252",

        "--accent": "#ffffff",
        "--accent-hover": "rgba(255, 255, 255, 0.9)",
        "--focus-ring": "#ffffff", // 16.48:1 on --bg-hover
        "--accent-text": "#0a0a0a",

        "--border": "#262626",
        "--border-subtle": "#1a1a1a",

        "--code-bg": "#141414",
        "--code-text": "#a3a3a3",
        "--blockquote-bg": "rgba(20, 20, 20, 0.8)",

        "--syntax-h1": "#ffffff",
        "--syntax-h2": "#e5e5e5",
        "--syntax-h3": "#d4d4d4",
        "--syntax-link": "#a3a3a3",
        "--syntax-bold": "#ffffff",
        "--syntax-list": "#a3a3a3",
        "--syntax-number": "#a3a3a3",
        "--syntax-quote": "#737373",
        "--syntax-code": "#737373",

        "--status-saved": "#22c55e",
        "--status-unsaved": "#f59e0b",
        "--danger": "#ef4444",
        "--danger-text": "#ef4444", // 4.90:1 on --bg-secondary

        "--scrollbar-track": "#0a0a0a",
        "--scrollbar-thumb": "#262626",
        "--scrollbar-hover": "#404040",

        "--selection-bg": "#404040",
        "--selection-text": "#ffffff",
    },
};

// A soft, warm-neutral light. The faint warmth gives it a gentle character
// without drifting toward the cream Paper theme. Only the surface and border
// tokens are warmed; the text colors are the neutral grays, so the contrast
// ratios hold.
const light: ThemeDef = {
    id: "light",
    name: "Light",
    type: "light",
    tokens: {
        "--bg-primary": "#ffffff",
        "--bg-secondary": "#faf9f7",
        "--bg-titlebar": "#f4f2ee",
        "--bg-editor": "#ffffff",
        "--bg-gutter": "#faf9f7",
        "--bg-hover": "#efece8",
        "--bg-input": "#faf9f7",

        "--text-primary": "#171717",
        "--text-secondary": "#525252",
        "--text-muted": "#a3a3a3",

        "--accent": "#171717",
        "--accent-hover": "rgba(23, 23, 23, 0.9)",
        "--focus-ring": "#171717", // 15.22:1
        "--accent-text": "#ffffff",

        "--border": "#e8e4de",
        "--border-subtle": "#efece8",

        "--code-bg": "#f4f2ee",
        "--code-text": "#dc2626",
        "--blockquote-bg": "rgba(244, 242, 238, 0.8)",

        "--syntax-h1": "#171717",
        "--syntax-h2": "#262626",
        "--syntax-h3": "#404040",
        "--syntax-link": "#2563eb",
        "--syntax-bold": "#171717",
        "--syntax-list": "#525252",
        "--syntax-number": "#525252",
        "--syntax-quote": "#737373",
        "--syntax-code": "#737373",

        "--status-saved": "#16a34a",
        "--status-unsaved": "#d97706",
        "--danger": "#dc2626",
        "--danger-text": "#dc2626", // 4.59:1

        "--scrollbar-track": "#fafafa",
        "--scrollbar-thumb": "#d4d4d4",
        "--scrollbar-hover": "#a3a3a3",

        "--selection-bg": "#171717",
        "--selection-text": "#ffffff",
    },
};

const paper: ThemeDef = {
    id: "paper",
    name: "Paper",
    type: "light",
    tokens: {
        "--bg-primary": "#f5f0e6",
        "--bg-secondary": "#ebe5d8",
        "--bg-titlebar": "#e0d9cc",
        "--bg-editor": "#faf8f3",
        "--bg-gutter": "#ebe5d8",
        "--bg-hover": "#ddd6c6",
        "--bg-input": "#ebe5d8",

        "--text-primary": "#3d3d3d",
        "--text-secondary": "#5a5340",
        "--text-muted": "#7a7160", // AA on --bg-primary (~4.6:1); was #9a8f7a (~2.7:1, fail)

        "--accent": "#5c4033",
        "--accent-hover": "rgba(92, 64, 51, 0.9)",
        "--focus-ring": "#5c4033", // 6.49:1
        "--accent-text": "#faf8f3",

        "--border": "#d4cfc2",
        "--border-subtle": "#e0d9cc",

        "--code-bg": "#ebe5d8",
        "--code-text": "#8b5a2b",
        "--blockquote-bg": "rgba(235, 229, 216, 0.6)",

        "--syntax-h1": "#3d3029",
        "--syntax-h2": "#5c4033",
        "--syntax-h3": "#6b5344",
        "--syntax-link": "#2d5a7b",
        "--syntax-bold": "#5c4033",
        "--syntax-list": "#6b5344",
        "--syntax-number": "#8b5a2b",
        "--syntax-quote": "#6b6352",
        "--syntax-code": "#6b6352",

        "--status-saved": "#5a7d5a",
        "--status-unsaved": "#b8860b",
        "--danger": "#cd5c5c",
        "--danger-text": "#b03a3a", // #cd5c5c was 3.17:1 as text; this is 4.76:1

        "--scrollbar-track": "#ebe5d8",
        "--scrollbar-thumb": "#c9c0ae",
        "--scrollbar-hover": "#a69d8d",

        "--selection-bg": "#5c4033",
        "--selection-text": "#faf8f3",
    },
};

const dracula: ThemeDef = {
    id: "dracula",
    name: "Dracula",
    type: "dark",
    tokens: {
        "--bg-primary": "#282a36",
        "--bg-secondary": "#343746",
        "--bg-titlebar": "#21222c",
        "--bg-editor": "#282a36",
        "--bg-gutter": "#21222c",
        "--bg-hover": "#44475a",
        "--bg-input": "#343746",

        "--text-primary": "#f8f8f2",
        "--text-secondary": "#d6d6d6",
        "--text-muted": "#6272a4",

        "--accent": "#bd93f9",
        "--accent-hover": "#a679f7",
        "--focus-ring": "#d6bcfa", // 5.42:1 on --bg-hover. It carries ACTIVE TEXT there, so the bar is 4.5, not 3
        "--accent-text": "#282a36",

        "--border": "#44475a",
        "--border-subtle": "#3a3d4d",

        "--code-bg": "#21222c",
        "--code-text": "#f8f8f2",
        "--blockquote-bg": "rgba(68, 71, 90, 0.35)",

        "--syntax-h1": "#ff79c6",
        "--syntax-h2": "#ff79c6",
        "--syntax-h3": "#bd93f9",
        "--syntax-link": "#8be9fd",
        "--syntax-bold": "#f8f8f2",
        "--syntax-list": "#ffb86c",
        "--syntax-number": "#bd93f9",
        "--syntax-quote": "#6272a4",
        "--syntax-code": "#50fa7b",

        "--status-saved": "#50fa7b",
        "--status-unsaved": "#ffb86c",
        "--danger": "#ff5555",
        "--danger-text": "#ff7b7b", // #ff5555 was 3.75:1 as text; this is 4.70:1

        "--scrollbar-track": "#21222c",
        "--scrollbar-thumb": "#44475a",
        "--scrollbar-hover": "#6272a4",

        "--selection-bg": "#44475a",
        "--selection-text": "#f8f8f2",
    },
};

// Visual Studio 2017's dark IDE chrome with its C/C++ editor palette: keyword
// blue for headings, type teal for h3, string salmon for code, comment green for
// quotes, VS-blue accent and selection.
//
// It is the one built-in that declares its own --hljs-* colors. Those ARE the
// theme: a code block that does not look like Visual Studio is not vs2017-dark,
// however well the generic derivation would have done. All ten are spelled out,
// including the two the derivation would have produced anyway (keyword, params),
// so that a later tweak to --syntax-h2 cannot quietly repaint VS's keywords.
const vs2017Dark: ThemeDef = {
    id: "vs2017-dark",
    name: "VS 2017 Dark",
    type: "dark",
    tokens: {
        "--bg-primary": "#1e1e1e",
        "--bg-secondary": "#252526",
        "--bg-titlebar": "#2d2d30",
        "--bg-editor": "#1e1e1e",
        "--bg-gutter": "#252526",
        "--bg-hover": "#3e3e40",
        "--bg-input": "#333337",

        "--text-primary": "#dcdcdc",
        "--text-secondary": "#b0b0b0", // #9d9d9d was 3.93:1 on --bg-hover; this is 4.92:1
        "--text-muted": "#808080",

        "--accent": "#007acc",
        "--accent-hover": "#1c97ea",
        "--focus-ring": "#4fc1ff", // #007acc was 2.37:1 on --bg-hover; this is 5.29:1
        "--accent-text": "#ffffff",

        "--border": "#3f3f46",
        "--border-subtle": "#2d2d30",

        "--code-bg": "#252526",
        "--code-text": "#d69d85",
        "--blockquote-bg": "rgba(37, 37, 38, 0.8)",

        "--syntax-h1": "#569cd6",
        "--syntax-h2": "#569cd6",
        "--syntax-h3": "#4ec9b0",
        "--syntax-link": "#9cdcfe",
        "--syntax-bold": "#dcdcdc",
        "--syntax-list": "#b5cea8",
        "--syntax-number": "#b5cea8",
        "--syntax-quote": "#57a64a",
        "--syntax-code": "#d69d85",

        "--status-saved": "#57a64a",
        "--status-unsaved": "#d7ba7d",
        "--danger": "#f44747",
        "--danger-text": "#ff8577", // #f44747 was 3.50:1 as text; this is 5.32:1

        "--scrollbar-track": "#1e1e1e",
        "--scrollbar-thumb": "#424242",
        "--scrollbar-hover": "#686868",

        "--selection-bg": "#264f78",
        "--selection-text": "#ffffff",

        // Visual Studio's own C/C++ editor colors. Note the plain (uncolored)
        // function names: that is not an omission, it is what the real IDE does.
        "--hljs-keyword": "#569cd6",
        "--hljs-string": "#d69d85",
        "--hljs-number": "#b5cea8",
        "--hljs-literal": "#b5cea8",
        "--hljs-params": "#b5cea8",
        "--hljs-function": "#dcdcdc",
        "--hljs-title": "#dcdcdc",
        "--hljs-comment": "#57a64a",
        "--hljs-built-in": "#4ec9b0",
        "--hljs-attr": "#9cdcfe",
    },
};

// Solarized, Ethan Schoonover's palette (MIT). Its sixteen colors are fixed and
// the two modes are one design: the eight accents are shared, and only the base
// tones swap ends. So the pair is ported together or not at all.
//
// The base tones, named as Schoonover names them, because the comments below are
// unreadable otherwise:
//   base03 #002b36  base02 #073642  base01 #586e75  base00 #657b83
//   base0  #839496  base1  #93a1a1  base2  #eee8d5  base3  #fdf6e3
// On a dark background base0 is body text and base1 is emphasized; on a light one
// base00 is body and base01 is emphasized. That inversion is the whole trick.
//
// Two tokens are ours rather than Schoonover's, and both are chrome:
//   --bg-hover, because Solarized names no hover surface (it has base02 for
//   "background highlights" and nothing above it), and a hover row that is also
//   the panel color is not a hover row.
//   --focus-ring, because the accents are tuned against base03/base3, not against
//   a hover surface sitting between them, and blue lands under 4.5:1 there.
// Nothing in the document itself is invented: every --syntax-* and --hljs-* below
// is one of the sixteen.
const solarizedDark: ThemeDef = {
    id: "solarized-dark",
    name: "Solarized Dark",
    type: "dark",
    tokens: {
        // The panel is DARKER than the page, which is how Solarized ports layer it:
        // base02 is spoken for as the "background highlight", so it becomes the hover
        // rather than the panel. Elevating the panel instead would leave the hover
        // with nowhere to go: base0 does not clear the 4.5 text floor on any surface
        // lighter than base02, at any brightness.
        "--bg-primary": "#002b36", // base03
        "--bg-secondary": "#00212b",
        "--bg-titlebar": "#001b23",
        "--bg-editor": "#002b36",
        "--bg-gutter": "#00212b",
        "--bg-hover": "#073642", // base02, Solarized's own background highlight
        "--bg-input": "#00212b",

        // base2 as primary text and base1 as secondary. Solarized's dark text ramp is
        // base01 -> base0 -> base1, but base0 is only 4.11:1 on base02, so the ramp
        // shifts up one: base1 becomes the secondary tone and base2 the primary. Both
        // are still Solarized's own colors, and the hierarchy survives.
        "--text-primary": "#eee8d5", // base2: 10.61:1 on --bg-hover
        "--text-secondary": "#93a1a1", // base1: 4.86:1 on --bg-hover
        "--text-muted": "#586e75", // base01

        "--accent": "#3d9bdb", // blue, lightened: base03 is only 4.08:1 on #268bd2, under the text floor
        "--accent-hover": "#59ade5",
        "--focus-ring": "#4aa3e0", // 4.71:1 on --bg-hover
        "--accent-text": "#002b36", // base03 on the blue fill: 4.94:1

        "--border": "#073642",
        "--border-subtle": "#00212b",

        "--code-bg": "#073642",
        "--code-text": "#2dada3", // cyan, which is what Solarized paints strings (lifted to 4.72:1 on --code-bg)
        "--blockquote-bg": "rgba(7, 54, 66, 0.6)",

        "--syntax-h1": "#268bd2", // blue
        "--syntax-h2": "#2aa198", // cyan
        "--syntax-h3": "#859900", // green
        "--syntax-link": "#3295da", // blue, lifted: #268bd2 is 4.08:1 as body text here
        "--syntax-bold": "#93a1a1", // base1
        "--syntax-list": "#b58900", // yellow
        "--syntax-number": "#e96a35", // orange, lifted: #cb4b16 is 3.26:1
        "--syntax-quote": "#7c929a", // base00, lifted: #657b83 is 3.37:1
        "--syntax-code": "#2dada3", // cyan, lifted: #2aa198 is 4.12:1

        "--status-saved": "#859900", // green
        "--status-unsaved": "#b58900", // yellow
        "--danger": "#dc322f", // red
        "--danger-text": "#e56563", // red is 3.25:1 as text on base03; this is 4.56:1

        "--scrollbar-track": "#002b36",
        "--scrollbar-thumb": "#073642",
        "--scrollbar-hover": "#586e75",

        "--selection-bg": "#073642", // base02, which IS Solarized's selection
        "--selection-text": "#eee8d5",

        // Solarized's syntax ROLES: green keywords, cyan strings, blue functions,
        // magenta numbers, a gray comment. The generic derivation would paint strings
        // base1 (near-white) and functions green, which is not this theme.
        //
        // The hues are Solarized's; the lightness is not, quite. Every one of these is
        // its accent lifted until it clears 4.5:1 on base02, the surface a code block
        // is actually drawn on. Solarized's own values land between 2.42:1 (the base01
        // comment) and 4.12:1 there, and a comment at 2.42:1 is not a quiet comment,
        // it is an absent one. What identifies a palette is its hue, so the hue is what
        // survived. See the note on the light side about which way each moves.
        "--hljs-keyword": "#92a800", // green
        "--hljs-string": "#2dada3", // cyan
        "--hljs-number": "#e279ac", // magenta
        "--hljs-literal": "#e279ac", // magenta
        "--hljs-function": "#4ca2df", // blue
        "--hljs-title": "#4ca2df", // blue
        "--hljs-params": "#8e9e9f", // base0
        "--hljs-comment": "#889fa6", // base01, lifted hard: it was 2.42:1
        "--hljs-built-in": "#c49500", // yellow
        "--hljs-attr": "#4ca2df", // blue
    },
};

const solarizedLight: ThemeDef = {
    id: "solarized-light",
    name: "Solarized Light",
    type: "light",
    tokens: {
        "--bg-primary": "#fdf6e3", // base3
        "--bg-secondary": "#eee8d5", // base2
        "--bg-titlebar": "#e4ddc8",
        "--bg-editor": "#fdf6e3",
        "--bg-gutter": "#eee8d5",
        "--bg-hover": "#ded8c4", // ours, for the same reason as the dark side's
        "--bg-input": "#eee8d5",

        // Solarized Light's text tones do not clear WCAG AA on Solarized Light's own
        // backgrounds. This is the palette's oldest and most-repeated criticism, not a
        // porting slip: base00, the BODY tone, is 4.13:1 on base3, and base01, the
        // EMPHASIZED tone, is 4.39:1 on base2. Both are under the 4.5 floor.
        //
        // So the ramp shifts down one, exactly as the dark side's shifts up: base02
        // (a real Solarized tone) carries primary text, and the secondary tone is a
        // darkened base01. Everything the eye reads as "Solarized" (the cream ground,
        // the eight accents) is untouched; what moved is the gray the words are set in,
        // and it moved because the alternative is prose you cannot read.
        "--text-primary": "#073642", // base02: 9.12:1 on --bg-hover
        "--text-secondary": "#4a5d63", // base01 darkened: 4.85:1 on --bg-hover
        "--text-muted": "#93a1a1", // base1

        // The two modes cannot share one blue fill. #268bd2 carries base03 at 4.08:1
        // and base3 at 3.41:1: it is squeezed, and fails to hold AA text either way.
        // So the dark side lightens its blue and the light side darkens its own.
        "--accent": "#1a6fa8", // base3 on the blue fill: 5.01:1
        "--accent-hover": "#15639a",
        "--focus-ring": "#185d8c", // blue is 2.58:1 on --bg-hover; this is 4.94:1
        "--accent-text": "#fdf6e3", // base3

        "--border": "#ded8c4",
        "--border-subtle": "#eee8d5",

        "--code-bg": "#eee8d5",
        // Inline code is drawn on --code-bg, NOT on the page: 4.63:1 there. Solarized's
        // orange (#cb4b16) is 3.62:1 on base2, which is why this is not that orange.
        "--code-text": "#b73d1d",
        "--blockquote-bg": "rgba(238, 232, 213, 0.7)",

        "--syntax-h1": "#1a6fa8",
        "--syntax-h2": "#2a8a82", // cyan (#2aa198) is 2.93:1 here: too faint for a heading
        "--syntax-h3": "#6a7a00", // green (#859900) is 2.97:1 here
        "--syntax-link": "#185d8c",
        "--syntax-bold": "#073642", // base02
        "--syntax-list": "#8a6800", // yellow (#b58900) is 2.98:1 here
        "--syntax-number": "#c1401f",
        "--syntax-quote": "#5e737a", // base00 darkened: #657b83 is 4.13:1
        "--syntax-code": "#257a73", // cyan darkened: #2a8a82 is 3.85:1

        "--status-saved": "#6a7a00",
        "--status-unsaved": "#8a6800",
        "--danger": "#dc322f", // red
        "--danger-text": "#c42d2a", // red is 4.29:1 as text on base3; this is 5.18:1

        "--scrollbar-track": "#eee8d5",
        "--scrollbar-thumb": "#ded8c4",
        "--scrollbar-hover": "#93a1a1",

        "--selection-bg": "#1a6fa8",
        "--selection-text": "#fdf6e3",

        // The same roles as the dark side, moving the other way: a code color on base2
        // is DARKENED to clear 4.5:1, where on base02 it is lightened. That symmetry is
        // Solarized's whole idea, applied to the one axis it did not itself hold to.
        //
        // Solarized's light comments are base1 (#93a1a1), which is 2.0:1 on base2. Even
        // base0, the body tone, is only 2.58:1 there. Neither is a comment anyone can
        // read, so this is a gray of the same hue at 4.60:1.
        "--hljs-keyword": "#5d6b00", // green
        "--hljs-string": "#226f68", // cyan
        "--hljs-number": "#b5366b", // magenta
        "--hljs-literal": "#b5366b", // magenta
        "--hljs-function": "#1c6a9e", // blue
        "--hljs-title": "#1c6a9e", // blue
        "--hljs-params": "#55686f", // base00
        "--hljs-comment": "#5b6a6c", // base1 darkened hard: it was 2.0:1
        "--hljs-built-in": "#806000", // yellow
        "--hljs-attr": "#1c6a9e", // blue
    },
};

// Nord (MIT). Four Polar Night grays, three Snow Storm whites, four Frost blues,
// five Aurora accents, and nothing else. It is the calmest dark here by a distance,
// which is why it earns a place next to Dracula rather than duplicating it.
//
//   nord0 #2e3440  nord1 #3b4252  nord2 #434c5e  nord3 #4c566a
//   nord4 #d8dee9  nord5 #e5e9f0  nord6 #eceff4
//   nord7 #8fbcbb  nord8 #88c0d0  nord9 #81a1c1  nord10 #5e81ac
//   nord11 #bf616a  nord12 #d08770  nord13 #ebcb8b  nord14 #a3be8c  nord15 #b48ead
//
// nord3 is Nord's comment color and it is 2.5:1 on nord0. The wider Nord community
// hit this years ago and settled on #616e88 for comments, which is what the code
// blocks use here. UI chrome cannot take even that, so --text-secondary is nord4.
const nord: ThemeDef = {
    id: "nord",
    name: "Nord",
    type: "dark",
    tokens: {
        "--bg-primary": "#2e3440", // nord0
        "--bg-secondary": "#3b4252", // nord1
        "--bg-titlebar": "#272b35",
        "--bg-editor": "#2e3440",
        "--bg-gutter": "#3b4252",
        "--bg-hover": "#434c5e", // nord2
        "--bg-input": "#3b4252",

        "--text-primary": "#eceff4", // nord6
        "--text-secondary": "#c3cbd9", // nord3/#616e88 are both far under 4.5:1; this sits between nord4 and nord2
        "--text-muted": "#68738a",

        "--accent": "#88c0d0", // nord8, Nord's signature Frost blue
        "--accent-hover": "#9ad0de",
        "--focus-ring": "#96c8d6", // nord8 is 4.31:1 on nord2, just under the text floor; this is 4.74:1
        "--accent-text": "#2e3440", // nord0 on the Frost fill: 6.24:1

        "--border": "#434c5e",
        "--border-subtle": "#3b4252",

        "--code-bg": "#3b4252",
        "--code-text": "#a3be8c", // nord14
        "--blockquote-bg": "rgba(59, 66, 82, 0.6)",

        "--syntax-h1": "#88c0d0", // nord8
        "--syntax-h2": "#81a1c1", // nord9
        "--syntax-h3": "#8fbcbb", // nord7
        "--syntax-link": "#88c0d0", // nord8
        "--syntax-bold": "#eceff4", // nord6
        "--syntax-list": "#ebcb8b", // nord13
        "--syntax-number": "#b894b1", // nord15 lifted: #b48ead is 4.41:1
        "--syntax-quote": "#96a0b4", // lifted: #7b88a1 is 3.50:1
        "--syntax-code": "#a3be8c", // nord14

        "--status-saved": "#a3be8c", // nord14
        "--status-unsaved": "#ebcb8b", // nord13
        "--danger": "#bf616a", // nord11
        "--danger-text": "#dda6ab", // nord11 is 3.05:1 as text on nord0; this is 6.02:1

        "--scrollbar-track": "#2e3440",
        "--scrollbar-thumb": "#434c5e",
        "--scrollbar-hover": "#4c566a",

        "--selection-bg": "#434c5e", // nord2
        "--selection-text": "#eceff4",

        // Nord's syntax roles: nord9 keywords, nord14 strings, nord8 functions, nord15
        // numbers, and a gray comment. The Frost and Aurora hues are Nord's; three of
        // them are lifted to clear 4.5:1 on nord1.
        //
        // The comment is the reason this theme cannot be shipped verbatim. Nord's own
        // is nord3 (#4c566a), which is 1.4:1 on nord1: not a color, a rumour. The
        // community's long-standing substitute, #616e88, is 1.96:1, barely better. This
        // is that same blue-gray at 4.62:1, which is what the other nine shipped themes
        // give a comment.
        "--hljs-keyword": "#99b3cd", // nord9
        "--hljs-string": "#a3be8c", // nord14
        "--hljs-number": "#c4a7bf", // nord15
        "--hljs-literal": "#99b3cd", // nord9
        "--hljs-function": "#88c0d0", // nord8
        "--hljs-title": "#88c0d0", // nord8
        "--hljs-params": "#d8dee9", // nord4
        "--hljs-comment": "#a8b0c1", // nord3's hue, lifted from 1.4:1
        "--hljs-built-in": "#8fbcbb", // nord7
        "--hljs-attr": "#8fbcbb", // nord7
    },
};

// Catppuccin Mocha (MIT). Four flavors exist; Mocha is the dark one everybody
// means, and Latte below is its light counterpart. Mauve is the project's own
// default accent, so it is the one used here.
//
//   base #1e1e2e  mantle #181825  crust #11111b
//   surface0 #313244  surface1 #45475a  surface2 #585b70
//   overlay0 #6c7086  overlay1 #7f849c  overlay2 #9399b2
//   subtext0 #a6adc8  subtext1 #bac2de  text #cdd6f4
//
// Note that mantle and crust are DARKER than base, the opposite of how the older
// dark themes here elevate a panel. That is Catppuccin's own layering (base is the
// editor, mantle the panel, crust the title bar) and it is left alone.
const catppuccinMocha: ThemeDef = {
    id: "catppuccin-mocha",
    name: "Catppuccin Mocha",
    type: "dark",
    tokens: {
        "--bg-primary": "#1e1e2e", // base
        "--bg-secondary": "#181825", // mantle
        "--bg-titlebar": "#11111b", // crust
        "--bg-editor": "#1e1e2e",
        "--bg-gutter": "#181825",
        "--bg-hover": "#313244", // surface0
        "--bg-input": "#313244", // surface0

        "--text-primary": "#cdd6f4", // text
        "--text-secondary": "#a6adc8", // subtext0: 5.65:1 on surface0
        "--text-muted": "#6c7086", // overlay0

        "--accent": "#cba6f7", // mauve
        "--accent-hover": "#dcbcff",
        "--focus-ring": "#cba6f7", // 6.19:1 on --bg-hover, so the accent carries it unchanged
        "--accent-text": "#1e1e2e", // base on the mauve fill: 8.07:1

        "--border": "#45475a", // surface1
        "--border-subtle": "#313244", // surface0

        "--code-bg": "#181825",
        "--code-text": "#a6e3a1", // green
        "--blockquote-bg": "rgba(49, 50, 68, 0.5)",

        "--syntax-h1": "#89b4fa", // blue
        "--syntax-h2": "#74c7ec", // sapphire
        "--syntax-h3": "#94e2d5", // teal
        "--syntax-link": "#89dceb", // sky
        "--syntax-bold": "#cdd6f4", // text
        "--syntax-list": "#fab387", // peach
        "--syntax-number": "#fab387", // peach
        "--syntax-quote": "#9399b2", // overlay2
        "--syntax-code": "#a6e3a1", // green

        "--status-saved": "#a6e3a1", // green
        "--status-unsaved": "#f9e2af", // yellow
        "--danger": "#f38ba8", // red
        "--danger-text": "#f38ba8", // 7.08:1 on base, so it needs no lighter twin

        "--scrollbar-track": "#181825",
        "--scrollbar-thumb": "#313244",
        "--scrollbar-hover": "#45475a",

        "--selection-bg": "#45475a", // surface1
        "--selection-text": "#cdd6f4",

        // Catppuccin's syntax roles: mauve keywords, green strings, blue functions,
        // peach numbers, yellow types, maroon parameters, overlay2 comments.
        "--hljs-keyword": "#cba6f7",
        "--hljs-string": "#a6e3a1",
        "--hljs-number": "#fab387",
        "--hljs-literal": "#fab387",
        "--hljs-function": "#89b4fa",
        "--hljs-title": "#89b4fa",
        "--hljs-params": "#eba0ac",
        "--hljs-comment": "#9399b2",
        "--hljs-built-in": "#f9e2af",
        "--hljs-attr": "#f9e2af",
    },
};

// Catppuccin Latte (MIT), the light flavor. Same roles, same names, inverted
// ramp: base is the lightest and text the darkest.
//
//   base #eff1f5  mantle #e6e9ef  crust #dce0e8
//   surface0 #ccd0da  surface1 #bcc0cc  surface2 #acb0be
//   overlay0 #9ca0b0  overlay1 #8c8fa1  overlay2 #7c7f93
//   subtext0 #6c6f85  subtext1 #5c5f77  text #4c4f69
const catppuccinLatte: ThemeDef = {
    id: "catppuccin-latte",
    name: "Catppuccin Latte",
    type: "light",
    tokens: {
        "--bg-primary": "#eff1f5", // base
        "--bg-secondary": "#e6e9ef", // mantle
        "--bg-titlebar": "#dce0e8", // crust
        "--bg-editor": "#eff1f5",
        "--bg-gutter": "#e6e9ef",
        "--bg-hover": "#ccd0da", // surface0
        "--bg-input": "#e6e9ef",

        "--text-primary": "#4c4f69", // text: 5.17:1 on surface0
        "--text-secondary": "#53556b", // subtext1 (#5c5f77) is 4.05:1 on surface0; darkened, this is 4.72:1
        "--text-muted": "#8c8fa1", // overlay1

        "--accent": "#8839ef", // mauve
        "--accent-hover": "#7a2ce0",
        "--focus-ring": "#7230c9", // mauve is 3.51:1 on surface0, well under the text floor; this is 4.56:1
        "--accent-text": "#eff1f5", // base on the mauve fill: 4.79:1

        "--border": "#bcc0cc", // surface1
        "--border-subtle": "#ccd0da", // surface0

        "--code-bg": "#e6e9ef",
        // Red, not Catppuccin's green: the green is 2.75:1 on the mantle an inline code
        // span sits on, and this is 4.60:1 there. The light theme and Paper already set
        // inline code in red, so it is also the house convention.
        "--code-text": "#ce0f38",
        "--blockquote-bg": "rgba(204, 208, 218, 0.5)",

        "--syntax-h1": "#1e66f5", // blue
        "--syntax-h2": "#8839ef", // mauve (sapphire is 2.87:1 here, too faint for a heading)
        "--syntax-h3": "#179299", // teal
        "--syntax-link": "#145ff5", // blue, darkened: #1e66f5 is 4.34:1 as body text
        "--syntax-bold": "#4c4f69", // text
        "--syntax-list": "#bc4501", // peach, darkened: #fe640b is 2.64:1
        "--syntax-number": "#bc4501", // peach, darkened: #fe640b is 2.64:1
        "--syntax-quote": "#676a7f", // subtext0, darkened: #6c6f85 is 4.37:1
        "--syntax-code": "#d20f39", // red

        "--status-saved": "#40a02b", // green
        "--status-unsaved": "#df8e1d", // yellow
        "--danger": "#d20f39", // red
        "--danger-text": "#ce0f38", // red is 4.46:1 as text on the mantle panel; this is 4.60:1

        "--scrollbar-track": "#e6e9ef",
        "--scrollbar-thumb": "#ccd0da",
        "--scrollbar-hover": "#acb0be",

        "--selection-bg": "#8839ef",
        "--selection-text": "#eff1f5",

        // The same roles as Mocha, in Latte's accents, darkened to clear 4.5:1 on the
        // mantle a code block sits on.
        //
        // Latte moves further from its published hexes than any other theme here, and
        // the reason is structural rather than sloppy: a light PASTEL palette cannot
        // hold 4.5:1 and stay pastel. Latte's peach is 2.45:1 on its own panel and its
        // yellow is 2.15:1, so as code they are decoration, not text. Darkened to carry
        // words, the peach reads as a burnt orange and the yellow as an ocher. That is
        // the honest cost of the trade, and it is the trade this app has made
        // everywhere else. Mocha, by contrast, needed NOTHING: every one of its code
        // colors already cleared the floor, which is a real compliment to it.
        "--hljs-keyword": "#8534ef", // mauve
        "--hljs-string": "#2e741f", // green
        "--hljs-number": "#b24101", // peach
        "--hljs-literal": "#b24101", // peach
        "--hljs-function": "#0b59f4", // blue
        "--hljs-title": "#0b59f4", // blue
        "--hljs-params": "#c91b2a", // maroon
        "--hljs-comment": "#636679", // overlay2
        "--hljs-built-in": "#8e5a12", // yellow
        "--hljs-attr": "#8e5a12", // yellow
    },
};

/** In display order: this is the order the Settings lists render. */
export const BUILTIN_THEMES: readonly ThemeDef[] = [
    dark,
    light,
    paper,
    dracula,
    vs2017Dark,
    solarizedDark,
    solarizedLight,
    nord,
    catppuccinMocha,
    catppuccinLatte,
];
