/**
 * The single source of truth for type sizing.
 *
 * The font size used to be a three-value enum ('small' | 'medium' | 'large')
 * with its ladder hard-coded in three places: index.css, exportUtils.ts, and
 * the two settings surfaces. It is now an arbitrary px number the user can
 * type, so every consumer derives its sizes from typeScale() instead:
 * ThemeContext writes them to CSS variables, and exportUtils bakes them into
 * exported HTML/PDF/DOCX.
 *
 * The coefficients are reverse-engineered from the old ladder rather than
 * invented — h2, h3, line-height and both editor values were exactly linear
 * across small/medium/large, so 14/16/18px reproduce the legacy look. (The old
 * h1 ramp alone was non-linear: +0.375em then +0.25em. It is straightened here,
 * which moves 'large' h1 from 2.5em to 2.625em — ~2px — in exchange for a scale
 * that stays coherent at every size from 11 to 32.)
 */

export const MIN_FONT_SIZE = 11;
export const MAX_FONT_SIZE = 32;
export const DEFAULT_FONT_SIZE = 16;

/** Offered in the size dropdown. A superset of the legacy 14/16/18, so every
 *  existing user lands on a preset after migration. */
export const FONT_SIZE_PRESETS = [12, 13, 14, 16, 18, 20, 24] as const;

/** The values the pre-1.0.50 enum mapped to, for migrating stored settings. */
export const LEGACY_FONT_SIZES: Record<string, number> = {
    small: 14,
    medium: 16,
    large: 18,
};

/** Whole px within [MIN, MAX]. Fractional input rounds — --line-height-editor
 *  must stay an integer (see below). */
export function clampFontSize(n: number): number {
    if (!Number.isFinite(n)) return DEFAULT_FONT_SIZE;
    return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(n)));
}

/** Read a persisted font size, upgrading the legacy enum values in the process.
 *  Anything unparseable falls back to the default rather than throwing. */
export function parseFontSize(raw: string | null | undefined): number {
    if (raw == null || raw === "") return DEFAULT_FONT_SIZE;
    // An own-property check, not `in`: `in` walks the prototype chain, so a
    // corrupt stored value of "toString" or "constructor" would match and hand
    // back a *function* through a signature that promises a number.
    if (Object.hasOwn(LEGACY_FONT_SIZES, raw)) return LEGACY_FONT_SIZES[raw];
    const n = Number(raw);
    return Number.isFinite(n) ? clampFontSize(n) : DEFAULT_FONT_SIZE;
}

export interface TypeScale {
    /** Body text, px. */
    base: string;
    /** Heading sizes, em — relative to base, so they follow it automatically. */
    h1: string;
    h2: string;
    h3: string;
    /** Unitless multiplier for prose. */
    lineHeight: string;
    /** Editor (CodeMirror) text, px. */
    editor: string;
    /** Editor line box, px. */
    editorLineHeight: string;
}

const clamp = (lo: number, v: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Round to 3dp without trailing zeros, so the CSS reads `2.25em` not `2.250em`. */
const em = (v: number) => `${Number(v.toFixed(3))}em`;

export function typeScale(input: number): TypeScale {
    const base = clampFontSize(input);
    // Offset from the legacy 'small' (14px), the anchor the old ladder started at.
    const d = base - 14;

    // Monospace reads noticeably larger than proportional text at the same px,
    // so the editor sits on a slightly smaller ladder than the preview.
    const editor = clamp(10, Math.round(base * 0.9), 28);

    return {
        base: `${base}px`,
        h1: em(clamp(1.6, 1.875 + d * 0.1875, 3.0)),
        h2: em(clamp(1.4, 1.5 + d * 0.125, 2.3)),
        h3: em(clamp(1.05, 1.125 + d * 0.0625, 1.6)),
        lineHeight: String(Number(clamp(1.45, 1.6 + d * 0.05, 1.85).toFixed(3))),
        editor: `${editor}px`,
        // Integer px, NOT a unitless multiplier: the editor paints its gutter and
        // active-line stripe off the line box, so a fractional line height leaves
        // sub-pixel seams between rows.
        editorLineHeight: `${Math.round(editor * 1.7)}px`,
    };
}
