// Modified by IRQ Studio, LLC (2026) from an Apache-2.0 licensed original.
// See NOTICE for attribution and license terms.

import { describe, it, expect } from "vitest";
import { FONTS, fontStack, isBundledFont, sanitizeFontStack } from "./appearanceOptions";
import { coerce, SETTING_BY_KEY, setKnownThemeIds } from "../settings/schema";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { settingsLinter } from "../settings/jsonSupport";

const INTER = FONTS[0].stack;

describe("resolving a font to a CSS stack", () => {
    it("maps a bundled id to its stack", () => {
        expect(fontStack("lora")).toBe(FONTS.find((f) => f.id === "lora")!.stack);
        expect(isBundledFont("lora")).toBe(true);
    });

    it("treats anything else as a font installed on the machine", () => {
        // The whole point: the app does not get to decide which fonts exist.
        expect(fontStack("Iosevka")).toBe(`Iosevka, ${INTER}`);
        expect(isBundledFont("Iosevka")).toBe(false);
    });

    it("keeps a full CSS font list intact", () => {
        expect(fontStack("Iosevka, monospace")).toBe(`Iosevka, monospace, ${INTER}`);
    });

    it("falls back through a real stack, so a typo degrades to something readable", () => {
        // Not to the browser's default serif, which looks like the app is broken.
        expect(fontStack("Notinstalled")).toContain(INTER);
    });

    it("falls back to the default when the value is empty", () => {
        expect(fontStack("   ")).toBe(INTER);
    });
});

describe("sanitizing a font value", () => {
    // This string is interpolated into a `font-family:` declaration inside a
    // <style> block when exporting HTML. Unsanitized, it escapes the declaration
    // and rewrites the exported document.
    it("cannot escape the CSS declaration it is written into", () => {
        const attack = 'x; } body { display: none } .z {';
        const out = sanitizeFontStack(attack);
        expect(out).not.toContain("}");
        expect(out).not.toContain("{");
        expect(out).not.toContain(";");
        expect(out).toBe("x");
    });

    it("strips comment markers and at-rules", () => {
        expect(sanitizeFontStack("a /* c */ @import url(x)")).not.toMatch(/[@]|\/\*|\*\//);
    });

    it("caps the length", () => {
        expect(sanitizeFontStack("x".repeat(500)).length).toBeLessThanOrEqual(200);
    });

    it("leaves an ordinary font list untouched", () => {
        const ok = "'Source Serif 4', Georgia, serif";
        expect(sanitizeFontStack(ok)).toBe(ok);
    });

    it("sanitizes on the way through fontStack, not just on its own", () => {
        expect(fontStack('x; } body { display: none } .z {')).toBe(`x, ${INTER}`);
    });
});

describe("the font setting accepts fonts we have never heard of", () => {
    const def = SETTING_BY_KEY.get("appearance.font")!;

    it("keeps a custom value instead of snapping back to the default", () => {
        // A closed enum would coerce this to "inter" and the setting would appear
        // to do nothing, which is what a strict schema costs here.
        expect(coerce(def, "Iosevka")).toBe("Iosevka");
    });

    it("still rejects the wrong type, and an empty string", () => {
        expect(coerce(def, 42)).toBe("inter");
        expect(coerce(def, "  ")).toBe("inter");
    });

    it("does NOT warn about an unfamiliar font in the JSON editor", () => {
        const view = new EditorView({
            state: EditorState.create({ doc: `{ "appearance.font": "Iosevka" }` }),
        });
        const out = settingsLinter(view);
        view.destroy();
        expect(out).toEqual([]);
    });

    it("still warns about a THEME that does not exist", () => {
        // Unlike a font, a theme has to BE somewhere: a built-in, or a file in the
        // themes folder. An id that names neither paints nothing, so it is reported.
        // It is reported rather than silently coerced, because at boot the app
        // cannot yet tell a typo from a user theme it has not finished reading.
        setKnownThemeIds(["dark", "light", "paper", "dracula", "vs2017-dark"]);

        const view = new EditorView({
            state: EditorState.create({ doc: `{ "appearance.theme": "iosevka-dark" }` }),
        });
        const out = settingsLinter(view);
        view.destroy();
        expect(out).toHaveLength(1);
        expect(out[0].message).toMatch(/is not a theme/);
    });
});
