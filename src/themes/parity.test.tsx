// Modified by IRQ Studio, LLC (2026) from an Apache-2.0 licensed original.
// See NOTICE for attribution and license terms.

/**
 * The app and the export must paint from the same theme.
 *
 * exportUtils used to hold a second, hand-written copy of every theme's colors,
 * and it had drifted: seven stale values across four themes. The failure was
 * invisible, which is the whole problem: an export looked plausible, just not like
 * the app. These tests exist so the copy cannot come back, in that file or any
 * other. If a color in an exported document is not a color the running app
 * resolved for that theme, one of them is lying and the suite says which.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render } from "@testing-library/react";

// exportUtils pulls in the Tauri plugins at module load. The generators under test
// never call them.
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn() }));
vi.mock("@tauri-apps/plugin-fs", () => ({ writeTextFile: vi.fn(), writeFile: vi.fn() }));

import { TestProviders } from "../test/providers";
import { generateHTML } from "../utils/exportUtils";
import { THEMES } from "../utils/appearanceOptions";
import type { Theme } from "../context/ThemeContext";
import {
    BUILTIN_THEMES,
    CODE_TOKEN_NAMES,
    THEME_TOKEN_NAMES,
    resolveThemeStyles,
    type ThemeDef,
} from "./index";
import { contrastRatio } from "./contrast";

const IDS = BUILTIN_THEMES.map((t) => t.id as Theme);

/** Every color literal an exported document actually paints with. */
function colorsIn(css: string): string[] {
    return css.match(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g) ?? [];
}

/**
 * Colors in the export that are deliberately NOT theme tokens.
 *
 * Each one is a decision, and each one is the whole reason this list is explicit:
 * adding to it should feel like something you are doing on purpose.
 */
const NOT_FROM_THE_THEME = new Set([
    "#ffffff", // @media print: a printed page is white, whatever theme is on screen
    "#171717", // ...and the text on it is near-black
    "rgba(255, 196, 0, 0.35)", // ==highlight==: one amber for every theme, as in the app
]);

beforeEach(() => {
    // Each render writes the theme onto <html>, which persists across tests in the
    // same jsdom document. Start from nothing so a stale token cannot pass for a
    // fresh one.
    document.documentElement.removeAttribute("style");
});

describe.each(IDS)("the %s theme", (id) => {
    it("paints the app with exactly the tokens the registry resolved", () => {
        render(<TestProviders settings={{ "appearance.theme": id }}><div /></TestProviders>);

        const el = document.documentElement;
        const expected = resolveThemeStyles(id);
        for (const [name, value] of Object.entries(expected)) {
            expect(el.style.getPropertyValue(name), `${id} ${name}`).toBe(value);
        }
        // The attribute survives the move to runtime tokens. Other rules key off it,
        // and so does anyone debugging in the inspector.
        expect(el.getAttribute("data-theme")).toBe(id);
        expect(el.getAttribute("data-theme-type")).toBe(BUILTIN_THEMES.find((t) => t.id === id)!.type);
    });

    it("bakes those same tokens into an export, and invents no color of its own", () => {
        const tokens = resolveThemeStyles(id);
        const values = new Set(Object.values(tokens));
        const css = generateHTML("<p>x</p>", "t", id, "inter", 16, []);

        for (const color of colorsIn(css)) {
            expect(
                values.has(color) || NOT_FROM_THE_THEME.has(color),
                `${id}: the export paints with ${color}, which is not one of its colors`,
            ).toBe(true);
        }
    });

    it("carries the tokens an exported document actually needs", () => {
        const t = resolveThemeStyles(id);
        const css = generateHTML("<p>x</p>", "t", id, "inter", 16, []);

        expect(css).toContain(`background-color: ${t["--bg-primary"]}`);
        expect(css).toContain(`color: ${t["--text-primary"]}`);
        expect(css).toContain(`color: ${t["--syntax-h1"]}`);
        expect(css).toContain(`background: ${t["--code-bg"]}`);
        expect(css).toContain(`border-left: 4px solid ${t["--accent"]}`);
        expect(css).toContain(`.hljs-keyword { color: ${t["--hljs-keyword"]}; }`);
        expect(css).toContain(`.hljs-comment { color: ${t["--hljs-comment"]};`);
    });
});

describe("the drift this refactor deleted", () => {
    // Four tokens had gone stale in exportUtils' private copy. Three of them were
    // the contrast fixes: the app raised --text-secondary to clear 4.5:1 and the
    // export kept shipping the value that failed it. The fourth was the light
    // theme, which was warmed and left cold in exports. These are the values the
    // export used to bake; none of them may ever appear in one again.
    const STALE: Array<[Theme, string, string]> = [
        ["dark", "--text-secondary", "#737373"], // raised to #8a8a8a to clear 4.5:1
        ["paper", "--text-secondary", "#6b6352"], // since changed to #5a5340
        ["vs2017-dark", "--text-secondary", "#9d9d9d"], // raised to #b0b0b0
        ["light", "--bg-secondary", "#fafafa"], // warmed to #faf9f7
        ["light", "--border", "#e5e5e5"], // warmed to #e8e4de
        ["light", "--code-bg", "#f5f5f5"], // warmed to #f4f2ee
        ["light", "--blockquote-bg", "rgba(250, 250, 250, 0.8)"], // warmed
    ];

    it.each(STALE)("%s exports the live %s, not the stale %s", (theme, token, stale) => {
        const now = resolveThemeStyles(theme)[token];
        // Guard the guard: if the theme ever adopts this color again on purpose,
        // this is what tells you to delete the row rather than chase a ghost.
        expect(now).not.toBe(stale);
        const css = generateHTML("<p>x</p>", "t", theme, "inter", 16, []);
        expect(css).toContain(now);
        expect(css).not.toContain(stale);
    });

    // The export hardcoded one green for code function names on every theme that
    // was not vs2017-dark, including the three whose --status-saved is a different
    // green entirely.
    it("no longer paints every theme's functions with the dark theme's green", () => {
        for (const id of ["light", "paper", "dracula"] as Theme[]) {
            const t = resolveThemeStyles(id);
            const css = generateHTML("<p>x</p>", "t", id, "inter", 16, []);
            expect(css).toContain(`.hljs-function { color: ${t["--status-saved"]}; }`);
            expect(css).not.toContain("#22c55e"); // the dark theme's, and only the dark theme's
        }
    });
});

/**
 * The hole the built-in-only loop above left open.
 *
 * Every test in this file iterates `IDS`, the ten BUILT-IN themes, and none of them
 * ever passed a user theme. `resolveThemeStyles(id, extra)` needs `extra` to find a
 * theme the app did not ship, and the export path was calling it without one: a custom
 * theme's id was not found, the merge chain came back empty, and the export silently
 * fell back to the base (dark) palette. So a user with their own theme exported a
 * document painted in a theme they had never chosen, the app looked right the whole
 * time, and every one of these parity tests passed.
 *
 * A guard that only checks the cases the code already gets right is not a guard.
 */
describe("a theme the user wrote themselves", () => {
    const MINE: ThemeDef = {
        id: "mine",
        name: "Mine",
        type: "light",
        tokens: {
            "--bg-primary": "#fdf1e0",
            "--text-primary": "#2b1d0e",
            "--syntax-h1": "#b5122e",
            "--code-bg": "#f3e3c9",
        },
    };

    it("is what the export paints with, not the built-in dark theme", () => {
        const mine = resolveThemeStyles("mine" as Theme, [MINE]);
        const css = generateHTML("<p>x</p>", "t", "mine" as Theme, "inter", 16, [MINE]);

        expect(css).toContain(`background-color: ${mine["--bg-primary"]}`);
        expect(css).toContain(`color: ${mine["--text-primary"]}`);
        expect(css).toContain(`color: ${mine["--syntax-h1"]}`);
        expect(css).toContain(`background: ${mine["--code-bg"]}`);

        // And specifically NOT the dark built-in, which is what it used to fall back to.
        const dark = resolveThemeStyles("dark");
        expect(css).not.toContain(`background-color: ${dark["--bg-primary"]}`);
    });

    it("inherits the base for tokens it does not define, rather than being discarded", () => {
        const mine = resolveThemeStyles("mine" as Theme, [MINE]);
        const css = generateHTML("<p>x</p>", "t", "mine" as Theme, "inter", 16, [MINE]);

        // MINE says nothing about --accent, so the merge chain supplies one. Whatever
        // it is, the export must paint with the SAME one the app does.
        expect(css).toContain(`border-left: 4px solid ${mine["--accent"]}`);
    });
});

describe("the theme swatches", () => {
    it("are the theme's own colors, not a literal typed beside its name", () => {
        for (const option of THEMES) {
            const tokens = resolveThemeStyles(option.id);
            expect(option.colors).toEqual([tokens["--bg-primary"], tokens["--accent"]]);
        }
    });

    /**
     * The swatch's job is to TELL THE THEMES APART, and the pair it is built from is
     * the only thing that makes it able to.
     *
     * It used to be page-plus-panel, which worked only because the first five themes
     * happened to have a visible step between those two. Solarized Dark is #002b36 on
     * #00212b, Mocha #1e1e2e on #181825, Latte #eff1f5 on #e6e9ef: as swatches, three
     * flat squares, and a picker that cannot answer the one question it is asked.
     * Hence the accent, which is the color a person actually chooses a theme by.
     *
     * 3:1 is the graphics floor, and --accent already owes it against --bg-primary, so
     * this holds by construction. It is asserted anyway: it is the REASON for the pair,
     * and a future swatch built from two tokens that happen to be close would be a
     * silent regression the day it shipped, not a failing test.
     */
    it("shows two tones that can actually be told apart", () => {
        for (const option of THEMES) {
            expect(
                contrastRatio(option.colors[0], option.colors[1]),
                `${option.id}: the swatch is one flat square`,
            ).toBeGreaterThanOrEqual(3);
        }
    });

    it("offers every built-in theme, in the registry's order", () => {
        expect(THEMES.map((t) => t.id)).toEqual(IDS);
    });
});

describe("the token vocabulary", () => {
    // 37 colors and 10 code colors, and nothing else may be written onto <html>
    // under the guise of a theme. A token added here without a value in every
    // built-in fails the completeness test in themes.test.ts, which is the point.
    it("is the 37 tokens plus the derived code colors", () => {
        expect(THEME_TOKEN_NAMES).toHaveLength(37);
        expect(CODE_TOKEN_NAMES).toHaveLength(10);
        for (const name of [...THEME_TOKEN_NAMES, ...CODE_TOKEN_NAMES]) {
            expect(name.startsWith("--"), `${name} is not a custom property name`).toBe(true);
        }
    });
});
