import { describe, it, expect } from "vitest";
import { BUILTIN_THEMES, resolveTheme } from "./index";
import type { ThemeTokens } from "./types";
import { checkContrast, contrastRatio, type ThemeProblem } from "./contrast";

/**
 * SCAFFOLDING, not the shipped themes.
 *
 * Realistic palettes to build synthetic cases on: take one, break exactly one
 * token, assert the validator notices. They are snapshots and they will rot, so
 * nothing here may be read as "what the app ships". The tests that check the real
 * themes read the registry instead: see shippedThemes() at the foot of this file.
 *
 * This distinction is not pedantry. These started life as a copy of the real
 * palettes, and within the hour dracula was fixed in index.css while this copy
 * went on asserting the old broken value, cheerfully green. Its dracula entry is
 * deleted for that reason: the real one is read from source now.
 */
const PALETTES = {
    dark: {
        "--bg-primary": "#0a0a0a",
        "--bg-secondary": "#141414",
        "--bg-hover": "#1f1f1f",
        "--bg-input": "#141414",
        "--text-primary": "#ffffff",
        "--text-secondary": "#8a8a8a",
        "--text-muted": "#525252",
        "--accent": "#ffffff",
        "--focus-ring": "#ffffff",
        "--accent-text": "#0a0a0a",
        "--danger": "#ef4444",
        "--danger-text": "#ef4444",
    },
    light: {
        "--bg-primary": "#ffffff",
        "--bg-secondary": "#faf9f7",
        "--bg-hover": "#efece8",
        "--bg-input": "#faf9f7",
        "--text-primary": "#171717",
        "--text-secondary": "#525252",
        "--text-muted": "#a3a3a3",
        "--accent": "#171717",
        "--focus-ring": "#171717",
        "--accent-text": "#ffffff",
        "--danger": "#dc2626",
        "--danger-text": "#dc2626",
    },
    paper: {
        "--bg-primary": "#f5f0e6",
        "--bg-secondary": "#ebe5d8",
        "--bg-hover": "#ddd6c6",
        "--bg-input": "#ebe5d8",
        "--text-primary": "#3d3d3d",
        "--text-secondary": "#5a5340",
        "--text-muted": "#7a7160",
        "--accent": "#5c4033",
        "--focus-ring": "#5c4033",
        "--accent-text": "#faf8f3",
        "--danger": "#cd5c5c",
        "--danger-text": "#b03a3a",
    },
    vs2017: {
        "--bg-primary": "#1e1e1e",
        "--bg-secondary": "#252526",
        "--bg-hover": "#3e3e40",
        "--bg-input": "#333337",
        "--text-primary": "#dcdcdc",
        "--text-secondary": "#b0b0b0",
        "--text-muted": "#808080",
        "--accent": "#007acc",
        "--focus-ring": "#4fc1ff",
        "--accent-text": "#ffffff",
        "--danger": "#f44747",
        "--danger-text": "#ff8577",
    },
} as const;

/** A theme that clears every rule. Start here and break one thing at a time. */
function passingTheme(overrides: Record<string, string> = {}): Record<string, string> {
    return { ...PALETTES.light, ...overrides };
}

function find(problems: ThemeProblem[], token: string, against: string): ThemeProblem | undefined {
    return problems.find((p) => p.token === token && p.against === against);
}

describe("contrastRatio", () => {
    it("anchors on the two ratios everyone knows", () => {
        expect(contrastRatio("#000000", "#ffffff")).toBe(21);
        expect(contrastRatio("#ffffff", "#ffffff")).toBe(1);
        expect(contrastRatio("#000000", "#000000")).toBe(1);
    });

    it("is symmetric, since a ratio has no opinion about which is on top", () => {
        expect(contrastRatio("#007acc", "#1e1e1e")).toBeCloseTo(contrastRatio("#1e1e1e", "#007acc"), 10);
    });

    it("stays inside 1..21", () => {
        for (const [a, b] of [
            ["#000", "#fff"],
            ["#bd93f9", "#282a36"],
            ["#8a8a8a", "#141414"],
        ]) {
            const r = contrastRatio(a, b);
            expect(r).toBeGreaterThanOrEqual(1);
            expect(r).toBeLessThanOrEqual(21);
        }
    });
});

/**
 * The bug this module exists to prevent.
 *
 * #007acc looked fine because it was checked against the panel. It was never
 * drawn on the panel: the active-option outline was drawn on --bg-hover, where
 * it is 2.37:1 and invisible. Both halves are asserted, because it is the GAP
 * between them that is the bug. A validator that only measured against
 * --bg-primary would have called this theme clean.
 */
describe("the regression: measured against the wrong surface", () => {
    const ACCENT = "#007acc";
    const PANEL = "#1e1e1e"; // --bg-primary
    const HOVER = "#3e3e40"; // --bg-hover, the surface it was actually drawn on

    it("passes on the panel it was wrongly measured against", () => {
        expect(contrastRatio(ACCENT, PANEL)).toBeCloseTo(3.7, 1);
        expect(contrastRatio(ACCENT, PANEL)).toBeGreaterThanOrEqual(3);
    });

    it("fails on --bg-hover, the surface it is really drawn on", () => {
        expect(contrastRatio(ACCENT, HOVER)).toBeCloseTo(2.37, 2);
        expect(contrastRatio(ACCENT, HOVER)).toBeLessThan(3);
    });

    it("catches a --focus-ring that only clears the panel, which is why the token exists", () => {
        // A theme author reaches for the old accent as their focus ring. On the
        // panel it is fine. On a hovered row it disappears. This must be caught.
        const problems = checkContrast(passingTheme({
            "--bg-primary": PANEL,
            "--bg-secondary": "#252526",
            "--bg-hover": HOVER,
            "--bg-input": "#333337",
            "--text-primary": "#dcdcdc",
            "--text-secondary": "#b0b0b0",
            "--focus-ring": ACCENT,
        }));

        const hit = find(problems, "--focus-ring", "--bg-hover");
        expect(hit).toBeDefined();
        expect(hit!.ratio).toBe(2.37);
        // 4.5, not 3: --focus-ring now carries the ACTIVE TEXT on a hover row (the
        // job that --accent used to do there, badly), so it is held to the text
        // floor on that surface.
        expect(hit!.required).toBe(4.5);
    });

    it("does not let --bg-primary launder a --focus-ring failure", () => {
        // The whole point: passing on one surface must not excuse failing on another.
        const problems = checkContrast(passingTheme({
            "--bg-primary": PANEL,
            "--bg-secondary": "#252526",
            "--bg-hover": HOVER,
            "--bg-input": "#333337",
            "--text-primary": "#dcdcdc",
            "--text-secondary": "#b0b0b0",
            "--focus-ring": ACCENT,
        }));
        expect(problems.some((p) => p.token === "--focus-ring")).toBe(true);
    });
});

describe("the rules", () => {
    it("returns [] for a theme that passes everything", () => {
        expect(checkContrast(passingTheme())).toEqual([]);
    });

    it("holds --text-secondary to the 4.5:1 text floor on --bg-hover", () => {
        // #9d9d9d on vs2017's hover was 3.93:1: clears the 3:1 graphics bar,
        // fails the text bar. It labels real UI, so the text bar is the one.
        const problems = checkContrast({
            ...PALETTES.vs2017,
            "--text-secondary": "#9d9d9d",
        });
        const hit = find(problems, "--text-secondary", "--bg-hover");
        expect(hit).toBeDefined();
        expect(hit!.required).toBe(4.5);
        expect(hit!.ratio).toBeLessThan(4.5);
        expect(hit!.ratio).toBeGreaterThan(3); // Would have passed a 3:1 rule.
    });

    it("holds --danger-text to 4.5:1 but --danger only to 3:1", () => {
        // paper's #cd5c5c was 3.17:1 as text: fine as a fill, unreadable as a word.
        const problems = checkContrast({
            ...PALETTES.paper,
            "--danger": "#cd5c5c",
            "--danger-text": "#cd5c5c",
        });
        expect(find(problems, "--danger-text", "--bg-primary")).toBeDefined();
        expect(find(problems, "--danger", "--bg-primary")).toBeUndefined();
    });

    it("checks --accent-text against the accent fill it is drawn on", () => {
        const problems = checkContrast(passingTheme({
            "--accent": "#5c4033",
            "--accent-text": "#6b5044", // Near-invisible on its own fill.
        }));
        const hit = find(problems, "--accent-text", "--accent");
        expect(hit).toBeDefined();
        expect(hit!.against).toBe("--accent");
        expect(hit!.required).toBe(4.5);
    });

    it("exempts --text-muted, which paints decorative things", () => {
        // The minimap is aria-hidden and renders with this at low alpha. Raising it
        // for AA once made the overview brighter than the document it summarizes.
        const problems = checkContrast(passingTheme({ "--text-muted": "#fdfdfd" }));
        expect(problems.filter((p) => p.token === "--text-muted")).toEqual([]);
        expect(problems).toEqual([]);
    });

    it("reports every surface a token fails on, not just the first", () => {
        const problems = checkContrast(passingTheme({ "--text-secondary": "#f2f0ee" }));
        const surfaces = problems
            .filter((p) => p.token === "--text-secondary")
            .map((p) => p.against);
        expect(surfaces).toEqual(["--bg-primary", "--bg-secondary", "--bg-hover"]);
    });
});

describe("color formats", () => {
    // Every spelling of black, so a theme author's syntax choice never changes
    // the verdict.
    const BLACKS = [
        "#000",
        "#000000",
        "#000000ff",
        "#000f", // 4-digit hex with alpha
        "rgb(0, 0, 0)",
        "rgba(0, 0, 0, 1)",
        "rgb(0 0 0)",
        "rgb(0 0 0 / 100%)",
        "rgb(0% 0% 0%)",
        "hsl(0 0% 0%)",
        "hsl(0, 0%, 0%)",
        "black",
        "  #000000  ",
        "#FFF".replace("FFF", "000"), // case-insensitivity, via an uppercase source
    ];

    it.each(BLACKS)("reads %s as black against white", (value) => {
        expect(contrastRatio(value, "#ffffff")).toBeCloseTo(21, 5);
    });

    it("reads uppercase hex", () => {
        expect(contrastRatio("#FFFFFF", "#000000")).toBe(21);
    });

    it("reads hsl hues that are not gray", () => {
        // hsl(210 100% 40%) is roughly #0066cc, a mid blue: nowhere near either extreme.
        const r = contrastRatio("hsl(210 100% 40%)", "#ffffff");
        expect(r).toBeGreaterThan(4);
        expect(r).toBeLessThan(7);
    });
});

describe("alpha", () => {
    it("composites a translucent token before measuring, because 35% of a color is not that color", () => {
        // Opaque black on white is 21:1. The same black at 50% is a mid gray.
        expect(contrastRatio("#000000", "#ffffff")).toBe(21);
        expect(contrastRatio("rgba(0, 0, 0, 0.5)", "#ffffff")).toBeCloseTo(3.98, 2);
        expect(contrastRatio("rgb(0 0 0 / 50%)", "#ffffff")).toBeCloseTo(3.98, 2);
        expect(contrastRatio("#00000080", "#ffffff")).toBeCloseTo(3.98, 1);
    });

    it("fully transparent text resolves to its surface, which is a 1:1 invisibility bug", () => {
        expect(contrastRatio("transparent", "#ffffff")).toBe(1);
        expect(contrastRatio("rgba(0, 0, 0, 0)", "#123456")).toBe(1);
    });

    it("turns a passing token into a failing one when alpha is added", () => {
        // #171717 on white is 17.9:1. At 20% alpha it is a pale gray and unreadable.
        const opaque = checkContrast(passingTheme({ "--text-primary": "#171717" }));
        expect(opaque).toEqual([]);

        const faded = checkContrast(passingTheme({ "--text-primary": "rgb(23 23 23 / 20%)" }));
        const hit = find(faded, "--text-primary", "--bg-primary");
        expect(hit).toBeDefined();
        expect(hit!.ratio).toBeLessThan(4.5);
    });

    it("composites a translucent SURFACE over the page background", () => {
        // The most common way a hand-written theme builds a hover row. Skipping it
        // would blind the validator to the entire hover state.
        const problems = checkContrast({
            ...PALETTES.dark,
            "--bg-hover": "rgba(255, 255, 255, 0.06)", // resolves to ~#1a1a1a over #0a0a0a
            "--text-secondary": "#8a8a8a",
        });
        // #8a8a8a stays legible on that resolved hover, so no false alarm.
        expect(find(problems, "--text-secondary", "--bg-hover")).toBeUndefined();

        // But a dark secondary text on the same resolved hover must still be caught.
        const bad = checkContrast({
            ...PALETTES.dark,
            "--bg-hover": "rgba(255, 255, 255, 0.06)",
            "--text-secondary": "#3a3a3a",
        });
        expect(find(bad, "--text-secondary", "--bg-hover")).toBeDefined();
    });
});

describe("unparseable values are skipped, never guessed at and never thrown", () => {
    const JUNK = [
        "var(--something-else)",
        "linear-gradient(to right, #000, #fff)",
        "rebeccapurple", // A real CSS color we deliberately do not model.
        "color-mix(in srgb, red, blue)",
        "#12345", // Not a valid hex length.
        "rgb(0, 0)", // Too few channels.
        "rgb(0 0 0 0)", // Missing the slash.
        "not-a-color",
        "",
        "   ",
    ];

    it.each(JUNK)("returns NaN rather than throwing for %s", (value) => {
        expect(() => contrastRatio(value, "#ffffff")).not.toThrow();
        expect(contrastRatio(value, "#ffffff")).toBeNaN();
        expect(contrastRatio("#ffffff", value)).toBeNaN();
    });

    it.each(JUNK)("skips the pair rather than reporting a false failure for %s", (value) => {
        // As a foreground: the token is unreadable, so we say nothing about it.
        const asToken = checkContrast(passingTheme({ "--text-primary": value }));
        expect(asToken.filter((p) => p.token === "--text-primary")).toEqual([]);

        // As a surface: every token measured against it goes quiet, and nothing else breaks.
        const asSurface = checkContrast(passingTheme({ "--bg-hover": value }));
        expect(asSurface.filter((p) => p.against === "--bg-hover")).toEqual([]);
    });

    it("survives a theme that is entirely junk", () => {
        const problems = checkContrast({
            "--bg-primary": "var(--x)",
            "--text-primary": "linear-gradient(red, blue)",
            "--accent": "chartreuse",
        });
        expect(problems).toEqual([]);
    });

    it("survives missing tokens, since a partial theme inherits the rest", () => {
        expect(checkContrast({})).toEqual([]);
        expect(checkContrast({ "--text-primary": "#000000" })).toEqual([]);
    });

    it("survives non-string values, which JSON will happily hand us", () => {
        const hostile = {
            "--bg-primary": "#ffffff",
            "--text-primary": 42,
            "--accent": null,
            "--focus-ring": { nested: true },
            "--danger": ["#fff"],
        } as unknown as Record<string, string>;
        expect(() => checkContrast(hostile)).not.toThrow();
        expect(checkContrast(hostile)).toEqual([]);
    });

    it("still judges the tokens it CAN read when a sibling is junk", () => {
        // One bad token must not silence the whole report.
        const problems = checkContrast(passingTheme({
            "--accent": "var(--brand)", // unreadable, skipped
            "--text-primary": "#eeeeee", // readable, and far too pale for white
        }));
        expect(problems.some((p) => p.token === "--accent")).toBe(false);
        expect(find(problems, "--text-primary", "--bg-primary")).toBeDefined();
    });
});

describe("the ThemeProblem report", () => {
    const problems = checkContrast(passingTheme({ "--text-primary": "#eeeeee" }));
    const hit = find(problems, "--text-primary", "--bg-primary")!;

    it("names both tokens, the ratio and the requirement", () => {
        expect(hit.message).toContain("--text-primary");
        expect(hit.message).toContain("--bg-primary");
        expect(hit.message).toContain(hit.ratio.toFixed(2));
        expect(hit.message).toContain("4.5:1");
    });

    it("rounds the ratio to 2dp", () => {
        for (const p of problems) {
            expect(p.ratio).toBe(Math.round(p.ratio * 100) / 100);
        }
    });

    it("only ever requires 3 or 4.5", () => {
        for (const p of problems) {
            expect([3, 4.5]).toContain(p.required);
        }
    });

    it("holds no em dashes, per house style", () => {
        for (const p of problems) {
            expect(p.message).not.toContain("—");
        }
    });

    it("is stable across calls, so the lint gutter does not reshuffle", () => {
        const theme = passingTheme({ "--text-secondary": "#f2f0ee", "--focus-ring": "#fafafa" });
        expect(checkContrast(theme)).toEqual(checkContrast(theme));
    });
});

/**
 * The shipped themes, read from the SOURCE rather than copied into this file.
 *
 * The first version of this suite pasted the five palettes in as fixtures. They
 * were correct on the day they were pasted, and they were another copy of the
 * theme data: within the hour dracula was fixed at source while these tests went
 * on cheerfully asserting the old broken values, green the whole time. A test
 * that carries its own copy of the thing it tests cannot fail when that thing
 * changes, which is the one job it had.
 *
 * So it reads the registry. This used to parse index.css; the tokens are a data
 * model now, and this followed them, which is the point: it tracks whatever the
 * app actually renders from.
 */
function shippedThemes(): Record<string, ThemeTokens> {
    return Object.fromEntries(BUILTIN_THEMES.map((t) => [t.id, resolveTheme(t.id)]));
}

describe("the shipped themes", () => {
    const themes = shippedThemes();

    // The whole point of the module. Every theme we ship must pass every rule, so
    // that a violation in this suite means someone changed a color and broke it.
    it.each(BUILTIN_THEMES.map((t) => t.id))("%s passes every rule", (name) => {
        expect(checkContrast(themes[name])).toEqual([]);
    });

    /**
     * The two bugs this validator found on its first run against our own themes,
     * pinned as the regressions they were.
     *
     * dracula: --accent-text was #f8f8f2 on the #bd93f9 accent fill, 2.26:1, where
     * text needs 4.5:1. Every primary button label, the AI chat bubbles, and the
     * selected search row.
     *
     * vs2017: --accent (#007acc) was drawn on --bg-hover by seven components at
     * 2.37:1. Those usages now use --focus-ring, which is what it is for. The
     * markup-level guard is in tokenUsage.test.ts; what is checked here is that
     * the colors themselves are sound.
     */
    it("dracula's button text is legible on its accent fill", () => {
        const t = themes.dracula;
        expect(contrastRatio(t["--accent-text"], t["--accent"])).toBeGreaterThanOrEqual(4.5);
    });

    it("the token drawn on a hover row is readable AS TEXT in every theme", () => {
        for (const name of BUILTIN_THEMES.map((t) => t.id)) {
            const t = themes[name];
            expect(
                contrastRatio(t["--focus-ring"], t["--bg-hover"]),
                `${name}: --focus-ring on --bg-hover`,
            ).toBeGreaterThanOrEqual(4.5);
        }
    });
});
