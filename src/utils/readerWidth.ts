/**
 * The reader-view column widths, in display order.
 *
 * Single source of truth for the three surfaces that would otherwise each carry
 * their own copy and drift: the setting's schema (its enum options and default),
 * the Settings dropdown (labels and hints), and the preview (the measure/wide
 * pixel pairs it writes as CSS variables). This mirrors how the theme and font
 * lists are hoisted into appearanceOptions.ts for the same reason.
 *
 * `measure` is the prose column; `wide` is how far code blocks and tables break
 * out past it. "full" fills the window for both. index.css spends these via
 * --reader-measure / --reader-wide (see MarkdownPreview). Defaults are tuned for
 * a maximized 1920px window; every tier is capped by the container, so a narrow
 * window shrinks to fit.
 */
export interface ReaderWidthTier {
    id: string;
    /** Display label in the Settings dropdown. */
    label: string;
    /** Prose column width: a CSS length, or "100%" for the full tier. */
    measure: string;
    /** How wide code blocks and tables may grow. */
    wide: string;
}

export const READER_WIDTH_TIERS: readonly ReaderWidthTier[] = [
    { id: "narrow", label: "Narrow", measure: "640px", wide: "960px" },
    { id: "medium", label: "Medium", measure: "820px", wide: "1100px" },
    { id: "wide", label: "Wide", measure: "1024px", wide: "1400px" },
    { id: "full", label: "Full width", measure: "100%", wide: "100%" },
];

/** The default tier id: the schema's default and the preview's fallback. */
export const DEFAULT_READER_WIDTH = "wide";

/** measure/wide pairs keyed by tier id, for the preview's CSS variables. */
export const READER_WIDTHS: Record<string, { measure: string; wide: string }> =
    Object.fromEntries(
        READER_WIDTH_TIERS.map((t) => [t.id, { measure: t.measure, wide: t.wide }]),
    );

/** The dropdown hint: the measure px, or a phrase for the full tier. */
export function readerWidthHint(tier: ReaderWidthTier): string {
    return tier.measure === "100%" ? "fills the window" : tier.measure;
}
