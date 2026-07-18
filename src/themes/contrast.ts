/**
 * Contrast validation for user-authored themes.
 *
 * The governing idea, and the one that is easy to get wrong: contrast is
 * measured against the surface a thing is ACTUALLY DRAWN ON, not against the
 * page background. We shipped that bug once. The vs2017 accent (#007acc) clears
 * 3:1 on the panel (#1e1e1e) but is only 2.37:1 on --bg-hover (#3e3e40), so an
 * active-option outline painted in it was invisible on exactly the row it was
 * meant to mark. A token is only as legible as its worst surface, which is why
 * every rule below carries an explicit list of surfaces rather than defaulting
 * to --bg-primary.
 */

/** One broken contrast rule, ready to render in the JSON editor's lint gutter. */
export interface ThemeProblem {
    /** The offending token, e.g. "--focus-ring". */
    token: string;
    /** The surface it failed on, e.g. "--bg-hover". */
    against: string;
    /** Measured ratio, rounded to 2dp. */
    ratio: number;
    /** The bar it had to clear: 3 or 4.5. */
    required: number;
    /** Human sentence naming both tokens, the ratio and the requirement. */
    message: string;
}

interface Rgba {
    /** 0..255 */
    r: number;
    g: number;
    b: number;
    /** 0..1 */
    a: number;
}

interface Rule {
    token: string;
    required: number;
    /** Every surface this token is painted on. It must clear the bar on all of them. */
    surfaces: string[];
}

/**
 * The rules.
 *
 * Thresholds follow WCAG 2.1: 4.5:1 for body text (1.4.3), 3:1 for non-text
 * UI and graphics (1.4.11). A token sits in one bucket or the other according
 * to what it actually paints, not according to its name.
 *
 * --text-muted is deliberately absent, on the grounds that it paints decorative
 * things: the minimap is aria-hidden and renders with it at low alpha, and raising
 * the token to clear AA once made the overview brighter than the document it
 * summarizes, which was worse for everyone and helped nobody.
 *
 * That reasoning is sound and the premise WAS FALSE. The token had quietly become
 * the app's de facto secondary text color: sixty sites of real copy a user is meant
 * to read, including every setting's description, every backlink's line number and
 * every command's shortcut hint. It fails 4.5:1 on ALL TEN themes on both surfaces
 * (nord 2.11:1; even paper, the best case, only reaches 4.24:1). So the exemption
 * was not protecting a decorative token, it was hiding an unreadable one.
 *
 * Those sixty sites are --text-secondary now, and the premise is true again. The
 * thing that keeps it true is tokenUsage.test.ts, which reads the MARKUP: a checker
 * over token pairs cannot do this job, because a pair is only a violation when the
 * markup puts the two together, and by then the pair is gone from the palette's
 * point of view.
 *
 * Known exceptions, stated rather than pretended away: the editor's gutter (line
 * numbers, 2.11-3.88:1) and the settings-JSON comment color (2.48-4.54:1) still use
 * it, because dimming both is a deliberate and universal editor convention, and
 * because promoting the comment color would flatten it into the same weight as the
 * values beside it.
 */
const RULES: Rule[] = [
    // --bg-hover and --bg-input included on the specialist's recommendation: this
    // is the label of a HOVERED list row and the text you type into an input, so
    // those are surfaces it genuinely lands on. All five shipped themes already
    // clear it, so the rule closes a hole for user themes without crying wolf.
    { token: "--text-primary", required: 4.5, surfaces: ["--bg-primary", "--bg-secondary", "--bg-hover", "--bg-input"] },
    // Bound by the text floor, not the 3:1 graphics floor: it labels real UI
    // (timestamps, field hints, secondary buttons), so it has to be readable.
    { token: "--text-secondary", required: 4.5, surfaces: ["--bg-primary", "--bg-secondary", "--bg-hover"] },
    // Fills and large blocks, never small text, hence 3:1.
    //
    // NOT measured against --bg-hover, though it once was. Nothing draws --accent
    // on --bg-hover any more: seven components did, which is how vs2017 shipped an
    // active-item indicator at 2.37:1, and they were all moved to --focus-ring.
    // Keeping the pair here would fail vs2017 forever for a condition that no
    // longer occurs on screen, and a validator that cries wolf gets ignored.
    // Which pairs actually MEET is a fact about the markup, so the guard against a
    // regression lives there instead: see themes/tokenUsage.test.ts.
    { token: "--accent", required: 3, surfaces: ["--bg-primary", "--bg-secondary"] },

    // Keyboard cursors, selection ticks, active borders, and now the active TEXT
    // that used to be drawn in --accent on a hover row. That last job is why the
    // bar on --bg-hover is the 4.5:1 TEXT floor and not the 3:1 graphics floor:
    // this token has to be readable as a word there, not merely visible as a mark.
    { token: "--focus-ring", required: 4.5, surfaces: ["--bg-hover"] },
    { token: "--focus-ring", required: 3, surfaces: ["--bg-secondary", "--bg-input", "--bg-primary"] },
    // Error TEXT, so the text floor applies. Separate from --danger for the same
    // reason --focus-ring is separate from --accent: the fill color is usually
    // too light to read as a word.
    { token: "--danger-text", required: 4.5, surfaces: ["--bg-primary", "--bg-secondary"] },
    { token: "--danger", required: 3, surfaces: ["--bg-primary"] },
    // Text drawn ON the accent fill (button labels, active rows), so the surface
    // here is another token rather than a background.
    { token: "--accent-text", required: 4.5, surfaces: ["--accent"] },
];

/**
 * The base surface an alpha color is assumed to sit on.
 *
 * Hand-written themes very often express a hover row as a translucent overlay
 * (`rgba(255 255 255 / 6%)`). Skipping those pairs would blind the validator to
 * the single most common way an author builds a hover state, so we composite
 * them over the page background instead, which is what the user actually sees.
 */
const BASE_SURFACE = "--bg-primary";

/**
 * Named colors we recognize. Deliberately tiny: an unknown name is skipped, not
 * failed, so a short list costs us coverage but never correctness. `transparent`
 * earns its place because a token set to it is a genuine invisible-text bug and
 * compositing catches it (it resolves to the surface, giving 1:1).
 */
const NAMED: Record<string, Rgba> = {
    transparent: { r: 0, g: 0, b: 0, a: 0 },
    white: { r: 255, g: 255, b: 255, a: 1 },
    black: { r: 0, g: 0, b: 0, a: 1 },
    red: { r: 255, g: 0, b: 0, a: 1 },
    gray: { r: 128, g: 128, b: 128, a: 1 },
    grey: { r: 128, g: 128, b: 128, a: 1 },
};

function clamp(n: number, lo: number, hi: number): number {
    return Math.min(hi, Math.max(lo, n));
}

/** A channel: bare number (0..255) or percentage. Returns NaN when malformed. */
function parseChannel(raw: string): number {
    const s = raw.trim();
    if (s === "") return NaN;
    const pct = s.endsWith("%");
    const n = Number(pct ? s.slice(0, -1) : s);
    if (!Number.isFinite(n)) return NaN;
    return clamp(pct ? (n / 100) * 255 : n, 0, 255);
}

/** Alpha: bare number (0..1) or percentage. Returns NaN when malformed. */
function parseAlpha(raw: string): number {
    const s = raw.trim();
    if (s === "") return NaN;
    const pct = s.endsWith("%");
    const n = Number(pct ? s.slice(0, -1) : s);
    if (!Number.isFinite(n)) return NaN;
    return clamp(pct ? n / 100 : n, 0, 1);
}

function parseHex(value: string): Rgba | null {
    const m = /^#([0-9a-f]+)$/i.exec(value);
    if (!m) return null;
    const h = m[1];
    // 5 and 7 digit hex is not a thing; treat as malformed rather than guessing.
    if (h.length !== 3 && h.length !== 4 && h.length !== 6 && h.length !== 8) return null;

    const short = h.length === 3 || h.length === 4;
    const pair = (i: number): number =>
        short ? parseInt(h[i] + h[i], 16) : parseInt(h.slice(i * 2, i * 2 + 2), 16);

    const hasAlpha = h.length === 4 || h.length === 8;
    return {
        r: pair(0),
        g: pair(1),
        b: pair(2),
        a: hasAlpha ? pair(3) / 255 : 1,
    };
}

/**
 * Splits an rgb()/hsl() body into components and an optional alpha, covering
 * both the legacy comma form and the modern space-separated form with a slash.
 */
function splitBody(body: string): { parts: string[]; alpha: string | null } | null {
    const slash = body.split("/");
    if (slash.length > 2) return null;

    const head = slash[0];
    const alpha = slash.length === 2 ? slash[1] : null;

    // Commas and slashes are not mixed in valid CSS, but tolerate `rgba(r, g, b, a)`.
    if (head.includes(",")) {
        const parts = head.split(",").map((p) => p.trim());
        if (alpha !== null) return null; // `rgb(r, g, b / a)` is not valid CSS.
        if (parts.length === 4) return { parts: parts.slice(0, 3), alpha: parts[3] };
        if (parts.length === 3) return { parts, alpha: null };
        return null;
    }

    const parts = head.trim().split(/\s+/).filter(Boolean);
    if (parts.length !== 3) return null;
    return { parts, alpha };
}

function parseRgb(value: string): Rgba | null {
    const m = /^rgba?\(([^)]*)\)$/i.exec(value);
    if (!m) return null;
    const split = splitBody(m[1]);
    if (!split) return null;

    const [r, g, b] = split.parts.map(parseChannel);
    const a = split.alpha === null ? 1 : parseAlpha(split.alpha);
    if (![r, g, b, a].every(Number.isFinite)) return null;
    return { r, g, b, a };
}

/**
 * hsl() is not in the required set, but hand-written themes reach for it
 * constantly. Skipping it would leave an author with an entirely unvalidated
 * theme and no warning, which is a worse failure than a missing format: silence
 * reads as a pass.
 */
function parseHsl(value: string): Rgba | null {
    const m = /^hsla?\(([^)]*)\)$/i.exec(value);
    if (!m) return null;
    const split = splitBody(m[1]);
    if (!split) return null;

    const hRaw = split.parts[0].trim().replace(/deg$/i, "");
    const h = Number(hRaw);
    const s = parseAlpha(split.parts[1].trim().endsWith("%") ? split.parts[1] : `${split.parts[1]}%`);
    const l = parseAlpha(split.parts[2].trim().endsWith("%") ? split.parts[2] : `${split.parts[2]}%`);
    const a = split.alpha === null ? 1 : parseAlpha(split.alpha);
    if (![h, s, l, a].every(Number.isFinite)) return null;

    const c = (1 - Math.abs(2 * l - 1)) * s;
    const hp = (((h % 360) + 360) % 360) / 60;
    const x = c * (1 - Math.abs((hp % 2) - 1));
    const [r1, g1, b1] =
        hp < 1 ? [c, x, 0]
        : hp < 2 ? [x, c, 0]
        : hp < 3 ? [0, c, x]
        : hp < 4 ? [0, x, c]
        : hp < 5 ? [x, 0, c]
        : [c, 0, x];
    const m0 = l - c / 2;
    return {
        r: Math.round((r1 + m0) * 255),
        g: Math.round((g1 + m0) * 255),
        b: Math.round((b1 + m0) * 255),
        a,
    };
}

/**
 * Parses a CSS color. Returns null for anything we cannot read: gradients,
 * `var(...)`, color functions we do not model, unknown names. Null means
 * "unknown", and unknown must never become a reported failure. A validator that
 * cries wolf gets switched off, and one that throws takes the settings UI with it.
 */
function parseColor(value: unknown): Rgba | null {
    if (typeof value !== "string") return null;
    const v = value.trim().toLowerCase();
    if (v === "") return null;
    if (Object.prototype.hasOwnProperty.call(NAMED, v)) return NAMED[v];
    return parseHex(v) ?? parseRgb(v) ?? parseHsl(v);
}

/**
 * Source-over compositing, done on gamma-encoded sRGB bytes rather than on
 * linear light. That is what browsers do by default, so it is what the user sees,
 * and matching them matters more here than matching a color scientist.
 */
function composite(fg: Rgba, bg: Rgba): Rgba {
    if (fg.a >= 1) return fg;
    return {
        r: fg.r * fg.a + bg.r * (1 - fg.a),
        g: fg.g * fg.a + bg.g * (1 - fg.a),
        b: fg.b * fg.a + bg.b * (1 - fg.a),
        a: 1,
    };
}

/**
 * WCAG 2.1 uses a 0.03928 branch point where the sRGB spec says 0.04045. The
 * two differ below the fourth decimal of a ratio, but we match WCAG on purpose:
 * when an author disputes a lint result they will check it against some other
 * WCAG tool, and our number has to be the same number.
 */
function linearize(channel8: number): number {
    const c = channel8 / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function relativeLuminance(c: Rgba): number {
    return (
        0.2126 * linearize(c.r) + 0.7152 * linearize(c.g) + 0.0722 * linearize(c.b)
    );
}

function ratioOf(fg: Rgba, bg: Rgba): number {
    const l1 = relativeLuminance(fg);
    const l2 = relativeLuminance(bg);
    const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
    return (hi + 0.05) / (lo + 0.05);
}

/** Two decimal places, the precision the report speaks in. */
function round2(n: number): number {
    return Math.round(n * 100) / 100;
}

/**
 * WCAG 2.1 relative-luminance contrast ratio, 1..21.
 *
 * `a` is composited over `b` when translucent, because a color at 35% alpha is
 * not that color. Returns NaN if either value cannot be parsed; callers must
 * treat NaN as "unknown" and skip, never as a failure.
 *
 * If `b` itself is translucent its backdrop is unknowable from two arguments
 * alone, so it is flattened over white. checkContrast never relies on that: it
 * resolves surfaces against the page background first.
 */
export function contrastRatio(a: string, b: string): number {
    const fg = parseColor(a);
    const bg = parseColor(b);
    if (!fg || !bg) return NaN;

    const surface = composite(bg, { r: 255, g: 255, b: 255, a: 1 });
    return ratioOf(composite(fg, surface), surface);
}

/**
 * Resolves a token to an opaque color. A translucent surface is composited over
 * the page background, since that is what it is painted on. Returns null when the
 * token is missing, unparseable, or translucent with no resolvable base, all of
 * which mean "we cannot judge this" rather than "this fails".
 */
function resolveSurface(tokens: Record<string, string>, name: string): Rgba | null {
    const self = parseColor(tokens[name]);
    if (!self) return null;
    if (self.a >= 1) return self;

    // The page background is the bottom of the stack. If it is itself translucent
    // there is nothing underneath it we know about, so we decline to guess.
    if (name === BASE_SURFACE) return null;
    const base = parseColor(tokens[BASE_SURFACE]);
    if (!base || base.a < 1) return null;

    return composite(self, base);
}

function describe(token: string, against: string, ratio: number, required: number): string {
    return (
        `${token} is ${ratio.toFixed(2)}:1 against ${against}, below the ${required}:1 minimum. ` +
        `It is drawn on ${against}, so that is the surface it has to clear.`
    );
}

/**
 * Every contrast rule a theme breaks. Empty means it passes.
 *
 * Problems come back in a stable order (rule order, then surface order) so the
 * lint gutter does not reshuffle itself between keystrokes.
 */
export function checkContrast(tokens: Record<string, string>): ThemeProblem[] {
    const problems: ThemeProblem[] = [];
    if (!tokens || typeof tokens !== "object") return problems;

    for (const rule of RULES) {
        const fgRaw = parseColor(tokens[rule.token]);
        if (!fgRaw) continue; // Missing or unreadable: a partial theme inherits the rest.

        for (const surfaceName of rule.surfaces) {
            const surface = resolveSurface(tokens, surfaceName);
            if (!surface) continue;

            const ratio = round2(ratioOf(composite(fgRaw, surface), surface));
            if (!Number.isFinite(ratio)) continue;

            // Compare the rounded figure, not the raw one. The report has to be
            // self-consistent: printing "3.00:1, below the 3:1 minimum" for a raw
            // 2.998 reads as a bug in the linter and gets it distrusted. The 0.005
            // of slack is far below anything an author could act on.
            if (ratio < rule.required) {
                problems.push({
                    token: rule.token,
                    against: surfaceName,
                    ratio,
                    required: rule.required,
                    message: describe(rule.token, surfaceName, ratio, rule.required),
                });
            }
        }
    }

    return problems;
}
