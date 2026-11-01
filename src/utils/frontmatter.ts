/**
 * Lightweight YAML-frontmatter parser and surgical editor.
 *
 * Handles the subset of YAML that's actually used in markdown frontmatter:
 *   - scalar values (strings, numbers, booleans), quoted or plain, including a
 *     plain value continued on more-indented lines
 *   - block scalars: `key: |` and `key: >`, with their indented content
 *   - inline arrays: tags: [a, b, c]
 *   - block arrays: tags:\n  - a\n  - b
 *   - comments, on their own line or after a value
 *
 * Anything more exotic is preserved as a raw string so we don't lose data.
 *
 * Edits from the Properties card go through `updateFrontmatter`, which rewrites
 * only the lines of the keys that changed. The block is the user's text: its
 * comments, key order, quoting and blank lines belong to them, and regenerating
 * the whole block from the parsed map threw all of that away on the first click.
 */

export type FrontmatterValue = string | number | boolean | string[];

export interface FrontmatterResult {
    /** Body markdown with the frontmatter block stripped. */
    body: string;
    /** Parsed key-value map. Empty object if no frontmatter present. */
    data: Record<string, FrontmatterValue>;
    /** True if the source started with a valid `---\n...\n---\n` block. */
    hasFrontmatter: boolean;
}

const FM_REGEX = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

const stripQuotes = (s: string): string => {
    const t = s.trim();
    if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
        return t.slice(1, -1).replace(/\\(["\\])/g, "$1");
    }
    if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) {
        return t.slice(1, -1).replace(/''/g, "'");
    }
    return t;
};

const coerceScalar = (raw: string): string | number | boolean => {
    const t = raw.trim();
    if (t === "true") return true;
    if (t === "false") return false;
    if (/^-?\d+$/.test(t)) return parseInt(t, 10);
    if (/^-?\d*\.\d+$/.test(t)) return parseFloat(t);
    return stripQuotes(t);
};

/** The items of an inline array as written, quotes and all. */
const inlineArrayItems = (raw: string): string[] => {
    const inner = raw.trim().slice(1, -1); // remove [ ]
    if (!inner.trim()) return [];
    return inner.split(",").map((s) => s.trim());
};

const parseInlineArray = (raw: string): string[] => inlineArrayItems(raw).map(stripQuotes);

/**
 * Split a value from a trailing comment. In YAML a `#` starts a comment only
 * after whitespace and outside quotes, so `https://x.test/#top` keeps its `#`.
 * Returns [value, comment]; the comment keeps its leading whitespace.
 */
function splitComment(v: string): [string, string] {
    if (v.startsWith('"') || v.startsWith("'")) {
        const q = v[0];
        let k = 1;
        while (k < v.length) {
            if (q === '"' && v[k] === "\\") { k += 2; continue; }
            if (v[k] === q) {
                if (q === "'" && v[k + 1] === "'") { k += 2; continue; }
                break;
            }
            k++;
        }
        if (k < v.length && /^\s+#/.test(v.slice(k + 1))) return [v.slice(0, k + 1), v.slice(k + 1)];
        return [v, ""];
    }
    const m = /\s+#/.exec(v);
    return m ? [v.slice(0, m.index), v.slice(m.index)] : [v, ""];
}

const indentOf = (line: string): number => line.length - line.trimStart().length;

const BLOCK_SCALAR = /^[|>][+-]?\d?[+-]?$/;
const LIST_ITEM = /^\s*-(\s|$)/;

/** One key of the block, and exactly which lines it occupies. */
interface Entry {
    key: string;
    value: FrontmatterValue;
    kind: "scalar" | "inline-array" | "block-array" | "block-scalar";
    /** First line of the entry, and one past its last. */
    start: number;
    end: number;
    /** The key line up to the value: indentation, key, colon and the gap after it. */
    prefix: string;
    /** The value as written on the key line, comment removed. */
    raw: string;
    /** A trailing comment on the key line, with its leading whitespace. */
    comment: string;
    /** block-array: the line index of each item. */
    itemLines?: number[];
    /** block-scalar: the indentation of its content lines. */
    contentIndent?: string;
}

/**
 * Walk the block's lines once, recording every key and its line span. The parser
 * and the editor both read this, so the keys the card shows are exactly the keys
 * the editor knows how to find.
 */
function scanEntries(lines: string[]): Entry[] {
    const entries: Entry[] = [];
    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#") || LIST_ITEM.test(line)) {
            i++;
            continue;
        }

        const colonIdx = trimmed.indexOf(":");
        if (colonIdx === -1) {
            i++;
            continue;
        }

        const keyIndent = indentOf(line);
        const key = trimmed.slice(0, colonIdx).trim();
        const afterColon = trimmed.slice(colonIdx + 1);
        const [value, comment] = splitComment(afterColon.trim());
        const gap = value ? afterColon.slice(0, afterColon.length - afterColon.trimStart().length) : " ";
        const prefix = line.slice(0, keyIndent) + trimmed.slice(0, colonIdx + 1) + (gap || " ");
        const base = { key, start: i, prefix, raw: value, comment };

        // Inline array: tags: [a, b, c]
        if (value.startsWith("[") && value.endsWith("]")) {
            entries.push({ ...base, kind: "inline-array", value: parseInlineArray(value), end: i + 1 });
            i++;
            continue;
        }

        // Block array: the next non-empty lines are "- " items.
        if (value === "") {
            const items: string[] = [];
            const itemLines: number[] = [];
            let j = i + 1;
            while (j < lines.length) {
                const next = lines[j];
                const ntrim = next.trim();
                // Blank lines and comments may sit between items.
                if (!ntrim || ntrim.startsWith("#")) { j++; continue; }
                if (!LIST_ITEM.test(next)) break;
                items.push(stripQuotes(splitComment(ntrim.replace(/^-\s*/, ""))[0]));
                itemLines.push(j);
                j++;
            }
            if (items.length > 0) {
                const end = itemLines[itemLines.length - 1] + 1;
                entries.push({ ...base, kind: "block-array", value: items, end, itemLines });
                i = end;
                continue;
            }
        }

        // Block scalar: `key: |` or `key: >`, then lines indented past the key.
        if (BLOCK_SCALAR.test(value)) {
            const content: string[] = [];
            let contentIndent = -1;
            let last = i;
            for (let j = i + 1; j < lines.length; j++) {
                const next = lines[j];
                if (!next.trim()) { content.push(""); continue; }
                const ind = indentOf(next);
                if (contentIndent === -1) {
                    if (ind <= keyIndent) break;
                    contentIndent = ind;
                }
                if (ind < contentIndent) break;
                content.push(next.slice(contentIndent));
                last = j;
            }
            content.length = last - i; // trailing blank lines are not content
            const text = content.join("\n");
            entries.push({
                ...base,
                kind: "block-scalar",
                // Folded: a single newline reads as a space, and each extra one survives.
                value: value.startsWith(">") ? text.replace(/([^\n])\n(?=[^\n])/g, "$1 ").replace(/\n(\n+)/g, "$1") : text,
                end: last + 1,
                contentIndent: " ".repeat(contentIndent === -1 ? keyIndent + 2 : contentIndent),
            });
            i = last + 1;
            continue;
        }

        // Plain scalar, which YAML lets continue on more-indented lines. A line
        // with a colon is a key of its own, which is how this parser has always
        // read a nested map.
        const parts = value ? [value] : [];
        let j = i + 1;
        if (!comment) {
            while (j < lines.length) {
                const next = lines[j];
                const ntrim = next.trim();
                if (!ntrim || ntrim.startsWith("#") || ntrim.includes(":") || indentOf(next) <= keyIndent) break;
                parts.push(splitComment(ntrim)[0]);
                j++;
            }
        }
        entries.push({ ...base, kind: "scalar", value: coerceScalar(parts.join(" ")), end: j });
        i = j;
    }
    return entries;
}

export function parseFrontmatter(source: string): FrontmatterResult {
    const match = source.match(FM_REGEX);
    if (!match) {
        return { body: source, data: {}, hasFrontmatter: false };
    }

    const body = source.slice(match[0].length);
    const data: Record<string, FrontmatterValue> = {};
    // A repeated key: the last one wins, as in the YAML parsers that allow it.
    for (const e of scanEntries(match[1].split(/\r?\n/))) data[e.key] = e.value;
    return { body, data, hasFrontmatter: true };
}

const quoteDouble = (v: string): string => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

const formatScalar = (v: string | number | boolean): string => {
    if (typeof v === "boolean") return v ? "true" : "false";
    if (typeof v === "number") return String(v);
    // Quote a string that would otherwise read back as something else: a number
    // or a boolean, a comment, a list item, a flow collection, or trimmed.
    if (
        v === "" ||
        /^(true|false|-?\d+(\.\d+)?|-?\d*\.\d+)$/.test(v) ||
        /[:#&*!|>'"]/.test(v) ||
        /^\s|\s$|^-(\s|$)|^[[{]/.test(v) ||
        v.includes("\n")
    ) {
        return quoteDouble(v);
    }
    return v;
};

const formatValue = (v: FrontmatterValue): string => {
    if (Array.isArray(v)) {
        return `[${v.map((s) => formatScalar(s)).join(", ")}]`;
    }
    return formatScalar(v);
};

/** Serialize a parsed frontmatter map into a new `---` block + the body. */
export function serializeFrontmatter(data: Record<string, FrontmatterValue>, body: string): string {
    const lines = Object.entries(data).map(([k, v]) => `${k}: ${formatValue(v)}`);
    if (lines.length === 0) return body;
    return `---\n${lines.join("\n")}\n---\n${body.startsWith("\n") ? "" : "\n"}${body}`;
}

/** A new scalar in the quoting style the old value was written in. */
function formatLike(v: string | number | boolean, raw: string): string {
    if (typeof v !== "string") return formatScalar(v);
    const t = raw.trim();
    if (t.length >= 2 && t.startsWith("'") && t.endsWith("'") && !v.includes("\n")) {
        return `'${v.replace(/'/g, "''")}'`;
    }
    if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) return quoteDouble(v);
    return formatScalar(v);
}

/**
 * Whether the card left a value alone.
 *
 * A text input cannot hold a newline: the browser strips them from its value. So
 * a multi-line value that comes back with exactly its newlines missing was only
 * focused and blurred, not edited, and must not be flattened onto one line.
 */
function sameValue(next: FrontmatterValue, old: FrontmatterValue): boolean {
    if (Array.isArray(next) && Array.isArray(old)) {
        return next.length === old.length && next.every((x, i) => x === old[i]);
    }
    if (typeof next === "string" && typeof old === "string" && old.includes("\n")) {
        return next === old || next === old.replace(/[\r\n]/g, "");
    }
    return next === old;
}

/** Indices into `old` removed to get `next`, or null if `next` is not `old` minus some items. */
function removedIndices(old: string[], next: string[]): number[] | null {
    const removed: number[] = [];
    let j = 0;
    old.forEach((item, i) => {
        if (j < next.length && item === next[j]) j++;
        else removed.push(i);
    });
    return j === next.length ? removed : null;
}

/** The replacement lines for one entry whose value changed. */
function rewriteEntry(e: Entry, v: FrontmatterValue, lines: string[]): string[] {
    const span = lines.slice(e.start, e.end);
    const one = (value: string) => [e.prefix + value + e.comment];

    if (e.kind === "block-array" && Array.isArray(v) && v.length > 0) {
        const old = e.value as string[];
        const itemLines = e.itemLines!.map((n) => n - e.start);
        // Removing items: drop exactly those lines and keep everything between.
        const removed = removedIndices(old, v);
        if (removed) {
            const drop = new Set(removed.map((r) => itemLines[r]));
            return span.filter((_, n) => !drop.has(n));
        }
        // Appending: new lines after the last item, written like it.
        const lastItem = itemLines[itemLines.length - 1];
        const itemPrefix = /^\s*-\s*/.exec(span[lastItem])![0];
        const fmt = (s: string) => itemPrefix + formatScalar(s);
        if (old.every((x, n) => v[n] === x)) {
            return [...span.slice(0, lastItem + 1), ...v.slice(old.length).map(fmt), ...span.slice(lastItem + 1)];
        }
        return [span[0], ...v.map(fmt)];
    }

    if (e.kind === "inline-array" && Array.isArray(v)) {
        // Keep each surviving item as it was written, quotes and all.
        const rawItems = inlineArrayItems(e.raw);
        const sep = rawItems.length < 2 || /,\s/.test(e.raw) ? ", " : ",";
        const items = v.map((s) => rawItems.find((r) => stripQuotes(r) === s) ?? formatScalar(s));
        return one(`[${items.join(sep)}]`);
    }

    if (e.kind === "block-scalar" && typeof v === "string") {
        // Keep the header line, chomping indicator and all; rewrite the content.
        const pieces = v === "" ? [] : v.split("\n");
        const content = e.raw.startsWith(">")
            ? pieces.flatMap((p, n) => (n === 0 ? [p] : ["", p]))
            : pieces;
        return [span[0], ...content.map((c) => (c ? e.contentIndent + c : ""))];
    }

    if (Array.isArray(v)) return one(formatValue(v));
    return one(e.kind === "scalar" ? formatLike(v, e.raw) : formatScalar(v));
}

/**
 * Apply the Properties card's new map to the document, touching only what
 * changed: a changed key has its own line(s) rewritten, a removed key loses its
 * line(s), and a new key is appended to the block. Every other byte of the
 * source is left as it was: comments, blank lines, quoting, key order, the body.
 */
export function updateFrontmatter(source: string, next: Record<string, FrontmatterValue>): string {
    const match = source.match(FM_REGEX);
    if (!match) {
        return Object.keys(next).length > 0 ? serializeFrontmatter(next, source) : source;
    }

    const has = (k: string) => Object.prototype.hasOwnProperty.call(next, k);
    const eol = match[0].includes("\r\n") ? "\r\n" : "\n";
    const yamlStart = match[0].indexOf("\n") + 1;
    const yamlEnd = yamlStart + match[1].length;
    const lines = match[1].split(/\r?\n/);
    const entries = scanEntries(lines);

    // A repeated key: the card shows, and so edits, the last one.
    const current = new Map<string, Entry>();
    for (const e of entries) current.set(e.key, e);

    const ops: { start: number; end: number; lines: string[] }[] = [];
    for (const e of entries) {
        // Removed: every occurrence, or an earlier duplicate would resurface.
        if (!has(e.key)) ops.push({ start: e.start, end: e.end, lines: [] });
    }
    for (const [key, e] of current) {
        if (!has(key) || sameValue(next[key], e.value)) continue;
        ops.push({ start: e.start, end: e.end, lines: rewriteEntry(e, next[key], lines) });
    }
    // Bottom up, so each splice leaves the line numbers above it valid.
    ops.sort((a, b) => b.start - a.start);
    for (const op of ops) lines.splice(op.start, op.end - op.start, ...op.lines);

    const added = Object.keys(next)
        .filter((k) => !current.has(k))
        .map((k) => `${k}: ${formatValue(next[k])}`);
    if (added.length > 0) {
        // After the last non-blank line, so trailing blank lines stay where they were.
        let at = lines.length;
        while (at > 0 && !lines[at - 1].trim()) at--;
        lines.splice(at, 0, ...added);
    }

    // Nothing left at all: drop the block, as serializing an empty map always did.
    if (lines.every((l) => !l.trim())) return source.slice(match[0].length);

    return source.slice(0, yamlStart) + lines.join(eol) + source.slice(yamlEnd);
}
