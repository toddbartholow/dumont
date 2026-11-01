/**
 * Turn `[[Target]]` and `[[Target|alias]]` into `[alias](wikilink:Target)`
 * before the preview parses the body, everywhere EXCEPT code and math.
 *
 * The rewrite used to be one regex over the whole body, so `[[1, 2]]` in a
 * fenced JavaScript block rendered as `[1, 2](wikilink:1%2C%202)`, an inline
 * `` `[[x]]` `` showed its link syntax, and `$m[[i]]$` broke the formula.
 * Fenced code (``` and ~~~, closed only by a fence of the same character at
 * least as long), indented code, `$$` display math, inline code spans and
 * inline `$...$` math are now passed through untouched.
 */

const WIKILINK_RE = /\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]/g;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const INDENTED = /^(?: {4}|\t)/;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])(?:\s|$)/;
const DISPLAY_MATH_OPEN = /^\s*\$\$/;

export function rewriteWikilinks(text: string): string {
    return text.replace(WIKILINK_RE, (_m, target: string, alias?: string) => {
        const t = target.trim();
        const a = (alias ?? target).trim();
        return `[${a}](wikilink:${encodeURIComponent(t)})`;
    });
}

export function rewriteWikilinksOutsideCode(body: string): string {
    // Cheap exit for the common document with no wikilinks at all.
    if (!body.includes("[[")) return body;

    const lines = body.split("\n");
    const out: string[] = [];
    let prose: string[] = [];
    const flush = () => {
        if (prose.length) out.push(rewriteInline(prose.join("\n")));
        prose = [];
    };

    let fence: { char: string; len: number } | null = null;
    let inMath = false;
    let inIndented = false;
    let inList = false;
    let prevBlank = true;

    for (const line of lines) {
        const blank = line.trim() === "";
        const wasBlank = prevBlank;
        prevBlank = blank;

        if (fence) {
            out.push(line);
            const close = line.match(FENCE_CLOSE);
            if (close && close[1][0] === fence.char && close[1].length >= fence.len) fence = null;
            continue;
        }
        if (inMath) {
            out.push(line);
            if (line.includes("$$")) inMath = false;
            continue;
        }
        // Indented code starts after a blank line, outside a list (where
        // indentation means nesting), and runs through indented and blank lines.
        if (INDENTED.test(line) && !inList && (inIndented || wasBlank)) {
            flush();
            inIndented = true;
            out.push(line);
            continue;
        }
        if (inIndented && blank) {
            out.push(line);
            continue;
        }
        inIndented = false;

        if (LIST_ITEM.test(line)) inList = true;
        else if (!blank && wasBlank && !/^\s/.test(line)) inList = false;

        const open = line.match(FENCE_OPEN);
        // A backtick fence's info string may not contain a backtick.
        if (open && !(open[1][0] === "`" && open[2].includes("`"))) {
            flush();
            fence = { char: open[1][0], len: open[1].length };
            out.push(line);
            continue;
        }
        // `$$` opening a display block that does not close on the same line.
        if (DISPLAY_MATH_OPEN.test(line) && line.indexOf("$$", line.indexOf("$$") + 2) === -1) {
            flush();
            inMath = true;
            out.push(line);
            continue;
        }
        prose.push(line);
    }
    flush();
    return out.join("\n");
}

/** Rewrite wikilinks in a run of prose, leaving code spans and inline math literal. */
function rewriteInline(text: string): string {
    let out = "";
    let plainStart = 0;
    let i = 0;
    const protect = (from: number, to: number) => {
        out += rewriteWikilinks(text.slice(plainStart, from)) + text.slice(from, to);
        plainStart = to;
        i = to;
    };
    while (i < text.length) {
        const ch = text[i];
        if (ch === "\\") {
            i += 2;
            continue;
        }
        if (ch === "`") {
            let run = i;
            while (text[run] === "`") run++;
            const close = closingTicks(text, run, run - i);
            if (close === -1) {
                i = run; // unmatched: the backticks are literal text
                continue;
            }
            protect(i, close + (run - i));
            continue;
        }
        if (ch === "$") {
            const end = mathEnd(text, i);
            if (end !== -1) {
                protect(i, end);
                continue;
            }
        }
        i++;
    }
    return out + rewriteWikilinks(text.slice(plainStart));
}

/** Start of the next backtick run of exactly `len`, not crossing a blank line, or -1. */
function closingTicks(s: string, from: number, len: number): number {
    let i = from;
    while (i < s.length) {
        const at = s.indexOf("`", i);
        if (at === -1) return -1;
        const between = s.slice(from, at);
        if (/\n[ \t]*\n/.test(between)) return -1;
        let end = at;
        while (s[end] === "`") end++;
        if (end - at === len) return at;
        i = end;
    }
    return -1;
}

/**
 * End (exclusive) of a math span starting at `start`, or -1. `$$...$$` may
 * span lines within the paragraph. Inline `$...$` follows the preview's math
 * detection: no space just inside either dollar, and no digit right after
 * the closing one, so "$5 and $10" is prose.
 */
function mathEnd(s: string, start: number): number {
    if (s[start + 1] === "$") {
        const close = s.indexOf("$$", start + 2);
        return close === -1 ? -1 : close + 2;
    }
    const first = s[start + 1];
    if (first === undefined || /\s/.test(first)) return -1;
    for (let j = start + 1; j < s.length; j++) {
        const c = s[j];
        if (c === "\n") return -1;
        if (c === "\\") { j++; continue; }
        if (c !== "$") continue;
        if (/\s/.test(s[j - 1]) || j === start + 1) return -1;
        if (/\d/.test(s[j + 1] ?? "")) return -1;
        return j + 1;
    }
    return -1;
}
