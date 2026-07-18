import { describe, it, expect } from "vitest";
import {
    typeScale,
    clampFontSize,
    parseFontSize,
    MIN_FONT_SIZE,
    MAX_FONT_SIZE,
    DEFAULT_FONT_SIZE,
    FONT_SIZE_PRESETS,
} from "./typeScale";

describe("typeScale", () => {
    // The arbitrary-size scale replaced a hand-tuned small/medium/large ladder.
    // These lock in that the three legacy sizes still render exactly as they did,
    // so the change is invisible to existing users.
    it("reproduces the legacy 'small' (14px) ladder", () => {
        expect(typeScale(14)).toEqual({
            base: "14px",
            h1: "1.875em",
            h2: "1.5em",
            h3: "1.125em",
            lineHeight: "1.6",
            editor: "13px",
            editorLineHeight: "22px",
        });
    });

    it("reproduces the legacy 'medium' (16px) ladder", () => {
        expect(typeScale(16)).toEqual({
            base: "16px",
            h1: "2.25em",
            h2: "1.75em",
            h3: "1.25em",
            lineHeight: "1.7",
            editor: "14px",
            editorLineHeight: "24px",
        });
    });

    it("reproduces the legacy 'large' (18px) ladder, bar the straightened h1", () => {
        const s = typeScale(18);
        expect(s.base).toBe("18px");
        expect(s.h2).toBe("2em");
        expect(s.h3).toBe("1.375em");
        expect(s.lineHeight).toBe("1.8");
        expect(s.editor).toBe("16px");
        expect(s.editorLineHeight).toBe("27px");
        // The old ladder's h1 ramp was non-linear (+0.375 then +0.25); the linear
        // scale lands 0.125em higher here. Deliberate — see typeScale.ts.
        expect(s.h1).toBe("2.625em");
    });

    it("keeps the editor line height an integer px at every size", () => {
        for (let n = MIN_FONT_SIZE; n <= MAX_FONT_SIZE; n++) {
            const { editorLineHeight } = typeScale(n);
            expect(editorLineHeight).toMatch(/^\d+px$/);
        }
    });

    it("grows monotonically and stays within the sane bounds", () => {
        const px = (v: string) => parseFloat(v);
        for (let n = MIN_FONT_SIZE; n < MAX_FONT_SIZE; n++) {
            const a = typeScale(n);
            const b = typeScale(n + 1);
            expect(px(b.base)).toBeGreaterThan(px(a.base));
            expect(px(b.editor)).toBeGreaterThanOrEqual(px(a.editor));
            expect(px(b.h1)).toBeGreaterThanOrEqual(px(a.h1));
        }
        // Headings must not run away at the extremes.
        expect(parseFloat(typeScale(MAX_FONT_SIZE).h1)).toBeLessThanOrEqual(3);
        expect(parseFloat(typeScale(MIN_FONT_SIZE).h1)).toBeGreaterThanOrEqual(1.6);
    });

    it("clamps out-of-range and fractional input", () => {
        expect(clampFontSize(4)).toBe(MIN_FONT_SIZE);
        expect(clampFontSize(200)).toBe(MAX_FONT_SIZE);
        expect(clampFontSize(15.7)).toBe(16);
        expect(clampFontSize(NaN)).toBe(DEFAULT_FONT_SIZE);
        // A clamped size must still produce a valid scale, not NaNpx.
        expect(typeScale(999).base).toBe(`${MAX_FONT_SIZE}px`);
    });

    it("offers presets that all sit inside the allowed range", () => {
        for (const p of FONT_SIZE_PRESETS) {
            expect(p).toBeGreaterThanOrEqual(MIN_FONT_SIZE);
            expect(p).toBeLessThanOrEqual(MAX_FONT_SIZE);
            expect(clampFontSize(p)).toBe(p);
        }
    });
});

describe("parseFontSize", () => {
    it("migrates the legacy enum values", () => {
        expect(parseFontSize("small")).toBe(14);
        expect(parseFontSize("medium")).toBe(16);
        expect(parseFontSize("large")).toBe(18);
    });

    it("round-trips numeric strings", () => {
        expect(parseFontSize("18")).toBe(18);
        expect(parseFontSize("11")).toBe(11);
    });

    it("falls back to the default for missing or corrupt values", () => {
        expect(parseFontSize(null)).toBe(DEFAULT_FONT_SIZE);
        expect(parseFontSize("")).toBe(DEFAULT_FONT_SIZE);
        expect(parseFontSize("enormous")).toBe(DEFAULT_FONT_SIZE);
    });

    // The legacy lookup must not read through Object.prototype, or a stored
    // "toString" would come back as a function typed as a number.
    it("does not resolve inherited Object properties as legacy sizes", () => {
        for (const key of ["toString", "constructor", "valueOf", "__proto__"]) {
            expect(parseFontSize(key)).toBe(DEFAULT_FONT_SIZE);
        }
    });

    it("clamps stored values that are out of range", () => {
        expect(parseFontSize("400")).toBe(MAX_FONT_SIZE);
        expect(parseFontSize("2")).toBe(MIN_FONT_SIZE);
    });
});
