/**
 * Headings read from the markdown source, for the outline panel and the
 * command palette's heading list.
 *
 * Both used to run `/^#{1,6}\s+/` over every line, which listed a `# comment`
 * inside a fenced bash block and a `#` line in YAML frontmatter as headings,
 * showed the raw source ("**Setup** for [Windows](https://...) {#win}") as the
 * title, and missed setext headings (`Title` over a `===` line) entirely.
 *
 * Lines are 1-based and content-relative (frontmatter included), the numbering
 * the editor, the preview's goto-line handler and the active-heading tracking
 * all use. Ids come from the same slugger the preview assigns heading ids
 * with, duplicate suffixes and `{#custom-id}`s included, so an entry's id is
 * the id of the heading it names.
 */

import { parseFrontmatter } from "./frontmatter";
import { createSlugger } from "./slugify";

export interface OutlineHeading {
    /** Display text, inline markdown removed. */
    text: string;
    level: number;
    /** 1-based, content-relative source line of the heading's first line. */
    line: number;
    /** The id the preview gives this heading. */
    id: string;
}

const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const SETEXT_UNDERLINE = /^ {0,3}(=+|-+)[ \t]*$/;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
// Mirrors remarkCustomHeadingId: only a valid anchor counts as a custom id.
const CUSTOM_ID = /[ \t]*\{#([A-Za-z][A-Za-z0-9_-]*)\}[ \t]*$/;
const INDENTED_CODE = /^(?: {4}|\t)/;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])(?:\s|$)/;

/** Can this line be (part of) the paragraph a setext underline turns into a heading? */
const isParagraphLine = (line: string): boolean =>
    line.trim() !== "" &&
    !INDENTED_CODE.test(line) &&
    !ATX.test(line) &&
    !LIST_ITEM.test(line) &&
    !/^\s*>/.test(line) &&
    !/^\s*\|/.test(line) &&
    !FENCE_OPEN.test(line) &&
    !SETEXT_UNDERLINE.test(line);

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function stripSpanMarkup(input: string): string {
    // Backslash escapes are literal characters: park them in the private-use
    // area so the emphasis passes below can't pair them, then put them back.
    const escaped: string[] = [];
    const s = input.replace(/\\([!-/:-@[-`{-~])/g, (_m, ch: string) => {
        escaped.push(ch);
        return String.fromCharCode(0xe000 + escaped.length - 1);
    });
    return s
        // Images and links keep their visible text: ![alt](src), [text](href), [text][ref].
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/!\[([^\]]*)\]\[[^\]]*\]/g, "$1")
        .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/\[([^\]]*)\]\[[^\]]*\]/g, "$1")
        // Wikilinks: [[Target|alias]] shows the alias, [[Target]] the target.
        .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
        .replace(/\[\[([^\]]+)\]\]/g, "$1")
        // Autolinks keep the address; any other tag is raw HTML and goes.
        .replace(/<((?:https?:|mailto:)[^>\s]+)>/gi, "$1")
        .replace(/<\/?[A-Za-z][^>]*>/g, "")
        // Emphasis, strike, ==mark==, ^sup^ and ~sub~. Underscore emphasis only
        // at word edges, so snake_case_name survives as written.
        .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2")
        .replace(/\*(?=\S)([\s\S]*?\S)\*/g, "$1")
        .replace(/(^|[^\p{L}\p{N}_])_(?=\S)([\s\S]*?\S)_(?![\p{L}\p{N}_])/gu, "$1$2")
        .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "$1")
        .replace(/==(?=\S)([\s\S]*?\S)==/g, "$1")
        .replace(/\^(\S+?)\^/g, "$1")
        .replace(/~(\S+?)~/g, "$1")
        .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_m, name: string) => ENTITIES[name])
        .replace(/&#(\d+);/g, (_m, n: string) => safeCodePoint(Number(n)))
        .replace(/&#x([0-9a-f]+);/gi, (_m, n: string) => safeCodePoint(parseInt(n, 16)))
        .replace(/[-]/g, (c) => escaped[c.charCodeAt(0) - 0xe000] ?? c);
}

function safeCodePoint(n: number): string {
    return Number.isInteger(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "�";
}

/**
 * Plain text of a heading's inline markdown, roughly what the preview renders.
 * Code spans are cut out first so their contents stay literal (`**x**` in
 * backticks is not bold).
 */
export function stripInlineMarkdown(raw: string): string {
    let out = "";
    let i = 0;
    while (i < raw.length) {
        const tick = raw.indexOf("`", i);
        if (tick === -1) {
            out += stripSpanMarkup(raw.slice(i));
            break;
        }
        let run = tick;
        while (raw[run] === "`") run++;
        const fence = raw.slice(tick, run);
        const close = findClosingTicks(raw, run, fence.length);
        if (close === -1) {
            // An unmatched backtick run is literal text.
            out += stripSpanMarkup(raw.slice(i, run));
            i = run;
            continue;
        }
        out += stripSpanMarkup(raw.slice(i, tick));
        out += raw.slice(run, close).replace(/^ (.*) $/, "$1");
        i = close + fence.length;
    }
    return out.replace(/\s+/g, " ").trim();
}

/** Index of the next backtick run of exactly `len` at or after `from`, or -1. */
function findClosingTicks(s: string, from: number, len: number): number {
    let i = from;
    while (i < s.length) {
        const at = s.indexOf("`", i);
        if (at === -1) return -1;
        let end = at;
        while (s[end] === "`") end++;
        if (end - at === len) return at;
        i = end;
    }
    return -1;
}

export function extractHeadings(content: string): OutlineHeading[] {
    const normalized = content.replace(/\r\n?/g, "\n");
    const lines = normalized.split("\n");

    // Skip frontmatter by the same rule the preview strips it with, so the
    // two agree on where the body starts.
    const { body, hasFrontmatter } = parseFrontmatter(normalized);
    let i = hasFrontmatter ? Math.max(0, lines.length - body.split("\n").length) : 0;

    const raw: { source: string; level: number; line: number }[] = [];
    let fence: { char: string; len: number } | null = null;
    let paraStart = -1;      // first line of the open paragraph, for setext
    let prevBlank = true;    // indented code can only start after a blank line
    let inIndentedCode = false;
    let inList = false;      // inside a list, indentation is nesting, not code

    for (; i < lines.length; i++) {
        const line = lines[i];
        const blank = line.trim() === "";
        const wasBlank = prevBlank;
        prevBlank = blank;

        if (fence) {
            const close = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
            if (close && close[1][0] === fence.char && close[1].length >= fence.len) fence = null;
            continue;
        }

        // Indented code: 4+ spaces after a blank line (a paragraph's lazy
        // continuation never follows a blank) and outside any list.
        if (INDENTED_CODE.test(line) && !inList && (inIndentedCode || wasBlank)) {
            inIndentedCode = true;
            paraStart = -1;
            continue;
        }
        if (!blank) inIndentedCode = false;

        // A list runs until a blank line is followed by an unindented line
        // that is not another item.
        if (LIST_ITEM.test(line)) inList = true;
        else if (!blank && wasBlank && !/^\s/.test(line)) inList = false;

        const open = line.match(FENCE_OPEN);
        // A backtick fence's info string may not contain a backtick.
        if (open && !(open[1][0] === "`" && open[2].includes("`"))) {
            fence = { char: open[1][0], len: open[1].length };
            paraStart = -1;
            continue;
        }

        const atx = line.match(ATX);
        if (atx) {
            raw.push({ source: atx[2] ?? "", level: atx[1].length, line: i + 1 });
            paraStart = -1;
            continue;
        }

        const underline = line.match(SETEXT_UNDERLINE);
        if (underline && paraStart !== -1) {
            const source = lines.slice(paraStart, i).map((l) => l.trim()).join(" ");
            raw.push({ source, level: underline[1][0] === "=" ? 1 : 2, line: paraStart + 1 });
            paraStart = -1;
            continue;
        }

        if (isParagraphLine(line)) {
            if (paraStart === -1) paraStart = i;
        } else {
            paraStart = -1;
        }
    }

    const slugger = createSlugger();
    const out: OutlineHeading[] = [];
    for (const h of raw) {
        const custom = h.source.match(CUSTOM_ID);
        const text = stripInlineMarkdown(custom ? h.source.slice(0, custom.index) : h.source);
        // An empty `#` line renders as an empty heading in the preview, which
        // still takes an id; keep the slugger in step but list nothing.
        const id = custom ? slugger.reserve(custom[1]) : slugger.slug(text);
        if (text) out.push({ text, level: h.level, line: h.line, id });
    }
    return out;
}
