/**
 * Editor key-handling helpers for Dumont's CodeEditor.
 *
 * All functions are pure: they take the current text + selection and return the
 * new text + selection, or `null` if the key is not handled (so the textarea
 * default behavior runs).
 */

export interface EditorState {
    text: string;
    selStart: number;
    selEnd: number;
}

export interface EditorResult {
    text: string;
    selStart: number;
    selEnd: number;
}

const INDENT = "  "; // 2 spaces — markdown-friendly nested lists

/* ---------- Selection / line helpers ---------- */

const lineStartIndex = (text: string, pos: number): number => {
    const before = text.slice(0, pos);
    const nl = before.lastIndexOf("\n");
    return nl === -1 ? 0 : nl + 1;
};

const lineEndIndex = (text: string, pos: number): number => {
    const idx = text.indexOf("\n", pos);
    return idx === -1 ? text.length : idx;
};

/* ---------- Table cell navigation ---------- */

const isTableLine = (line: string): boolean => {
    const t = line.trim();
    return t.startsWith("|") && t.endsWith("|") && t.length > 1;
};

/**
 * Tab inside a markdown table moves to the next cell (skipping the separator
 * `| --- |` row). At the last cell of a row, jumps to row 1 of next row.
 * At the last cell of the last row, creates a new row.
 */
export function handleTableTab(state: EditorState, shift: boolean): EditorResult | null {
    const { text, selStart, selEnd } = state;
    if (selStart !== selEnd) return null;

    const ls = lineStartIndex(text, selStart);
    const le = lineEndIndex(text, selStart);
    const line = text.slice(ls, le);
    if (!isTableLine(line)) return null;

    // Find pipe positions on the current line
    const pipes: number[] = [];
    for (let i = 0; i < line.length; i++) if (line[i] === "|") pipes.push(i);
    if (pipes.length < 2) return null;

    const localPos = selStart - ls;
    let cellIdx = 0;
    for (let i = 0; i < pipes.length - 1; i++) {
        if (localPos >= pipes[i] && localPos <= pipes[i + 1]) {
            cellIdx = i;
            break;
        }
    }

    if (!shift) {
        if (cellIdx < pipes.length - 2) {
            // Next cell, place caret at content start
            const target = ls + pipes[cellIdx + 1] + 2;
            return { text, selStart: target, selEnd: target };
        }
        // Last cell: go to the next row's first cell, skipping separator rows.
        // Past the end of the text counts as "not a table row", so Tab in the
        // last cell of a table that ENDS the document still adds a row. The
        // loop used to run only while `nextLs < text.length`, which skipped it
        // entirely there and fell through to a plain two-space indent.
        let nextLs = le + 1;
        // Where a new row goes: after this row, or after any separator rows
        // skipped below it, so a header-only table grows a body row rather than
        // a row wedged between the header and its separator.
        let insertAt = le;
        for (;;) {
            const inText = nextLs <= text.length;
            const nle = inText ? lineEndIndex(text, nextLs) : nextLs;
            const nextLine = inText ? text.slice(nextLs, nle) : "";
            if (!isTableLine(nextLine)) {
                // Not a table: create a new row matching the column count
                const cols = pipes.length - 1;
                const blank = "| " + Array(cols).fill("").join(" | ") + " |";
                const inserted = "\n" + blank;
                const target = insertAt + 3; // after first "| "
                return {
                    text: text.slice(0, insertAt) + inserted + text.slice(insertAt),
                    selStart: target,
                    selEnd: target,
                };
            }
            // Skip separator rows
            if (/^\|\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|$/.test(nextLine.trim())) {
                insertAt = nle;
                nextLs = nle + 1;
                continue;
            }
            // Found a body row — go to its first cell
            const firstPipe = nextLs + nextLine.indexOf("|");
            const target = firstPipe + 2;
            return { text, selStart: target, selEnd: target };
        }
    }

    // Shift+Tab — previous cell
    if (cellIdx > 0) {
        const target = ls + pipes[cellIdx - 1] + 2;
        return { text, selStart: target, selEnd: target };
    }
    // First cell — try previous row
    if (ls > 0) {
        let prevLe = ls - 1;
        while (prevLe > 0) {
            const prevLs = lineStartIndex(text, prevLe - 1);
            const prevLine = text.slice(prevLs, prevLe);
            if (!isTableLine(prevLine)) break;
            if (/^\|\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|$/.test(prevLine.trim())) {
                prevLe = prevLs - 1;
                continue;
            }
            // Last cell of prev row
            const prevPipes: number[] = [];
            for (let i = 0; i < prevLine.length; i++) if (prevLine[i] === "|") prevPipes.push(i);
            const target = prevLs + prevPipes[prevPipes.length - 2] + 2;
            return { text, selStart: target, selEnd: target };
        }
    }
    return null;
}

/* ---------- Tab / Shift+Tab ---------- */

export function handleTab(state: EditorState, shift: boolean): EditorResult | null {
    // Try table-tab first; falls through to indent if not in a table.
    const tableResult = handleTableTab(state, shift);
    if (tableResult) return tableResult;

    const { text, selStart, selEnd } = state;

    // Multi-line: indent or outdent each line in the selection
    const hasNewline = text.slice(selStart, selEnd).includes("\n");
    if (selStart !== selEnd && hasNewline) {
        const blockStart = lineStartIndex(text, selStart);
        const blockEnd = lineEndIndex(text, selEnd);
        const block = text.slice(blockStart, blockEnd);
        const lines = block.split("\n");

        let newBlock: string;
        if (shift) {
            newBlock = lines.map((l) => l.startsWith(INDENT) ? l.slice(INDENT.length) : l.startsWith(" ") ? l.slice(1) : l).join("\n");
        } else {
            newBlock = lines.map((l) => INDENT + l).join("\n");
        }

        const newText = text.slice(0, blockStart) + newBlock + text.slice(blockEnd);
        const delta = newBlock.length - block.length;
        return {
            text: newText,
            selStart: blockStart,
            selEnd: blockEnd + delta,
        };
    }

    // A list item nests or un-nests as a whole ITEM, wherever the caret is on
    // its line and with or without a selection inside it, the way Obsidian,
    // Typora and VS Code behave. Tab used to splice two spaces at the caret,
    // usually mid-text, so it could never build a nested list.
    const listResult = indentListItem(state, shift);
    if (listResult) return listResult;

    // Single-line: insert / remove indent
    if (shift) {
        const ls = lineStartIndex(text, selStart);
        const head = text.slice(ls, ls + INDENT.length);
        if (head === INDENT) {
            return {
                text: text.slice(0, ls) + text.slice(ls + INDENT.length),
                selStart: Math.max(ls, selStart - INDENT.length),
                selEnd: Math.max(ls, selEnd - INDENT.length),
            };
        }
        return null;
    }

    // A selection within one line indents that line and keeps the selection on
    // the same text, like the multi-line branch above. This used to splice the
    // indent in place of the selection (`text.slice(selEnd)`), deleting it.
    if (selStart !== selEnd) {
        const ls = lineStartIndex(text, selStart);
        return {
            text: text.slice(0, ls) + INDENT + text.slice(ls),
            selStart: selStart + INDENT.length,
            selEnd: selEnd + INDENT.length,
        };
    }

    return {
        text: text.slice(0, selStart) + INDENT + text.slice(selStart),
        selStart: selStart + INDENT.length,
        selEnd: selStart + INDENT.length,
    };
}

/* ---------- List structure ---------- */

const LIST_PATTERN = /^(\s*)([-*+]|\d+\.)(\s+)(\[[ xX]\]\s+)?/;
const QUOTE_PATTERN = /^(\s*>\s+)/;
const NUMBERED = /^(\d+)\.$/;

interface ListLine {
    indent: string;
    marker: string;
    /** Indent + marker + the spaces after it: the column a child item's marker
     *  has to start at to nest under this one. 2 for "- ", 3 for "1. ". */
    contentColumn: number;
    /** Full prefix length, including a task box: where the item's text starts. */
    prefixLength: number;
    taskBox: boolean;
}

function parseListLine(line: string): ListLine | null {
    const m = line.match(LIST_PATTERN);
    if (!m) return null;
    // CommonMark: five or more spaces after the marker means one space plus an
    // indented code block, so the content column is just past a single space.
    const spaces = m[3].length > 4 ? 1 : m[3].length;
    return {
        indent: m[1],
        marker: m[2],
        contentColumn: m[1].length + m[2].length + spaces,
        prefixLength: m[0].length,
        taskBox: !!m[4],
    };
}

/** Scan upward from the line before `lineStart`, skipping blank lines, and hand
 *  each line and its indent width to `visit` until it returns something other
 *  than undefined. */
function scanUp<T>(text: string, lineStart: number, visit: (line: string, indent: number) => T | undefined): T | null {
    let end = lineStart - 1;
    // Bounded: no real list is anywhere near this long, and a keystroke must not
    // walk a whole large document.
    for (let guard = 0; end >= 0 && guard < 500; guard++) {
        const start = lineStartIndex(text, end);
        const line = text.slice(start, end);
        end = start - 1;
        if (line.trim() === "") continue;
        const found = visit(line, line.length - line.trimStart().length);
        if (found !== undefined) return found;
    }
    return null;
}

/** The item a line indented by `indentLen` belongs to: the nearest less-indented
 *  line above, if it is a list item. Deeper lines are skipped; any other
 *  less-indented line ends the search with no parent. */
function findParentItem(text: string, lineStart: number, indentLen: number): ListLine | null {
    return scanUp(text, lineStart, (line, indent) => (indent < indentLen ? parseListLine(line) : undefined));
}

/** The item directly above at exactly `indentLen` (same list level), skipping
 *  deeper lines. A shallower line, or a non-item at this level, means none. */
function findPreviousSibling(text: string, lineStart: number, indentLen: number): ListLine | null {
    return scanUp(text, lineStart, (line, indent) => {
        if (indent > indentLen) return undefined;
        return indent === indentLen ? parseListLine(line) : null;
    });
}

/** The marker after `marker` in the same list: "3." becomes "4.", bullets repeat. */
function nextMarkerAfter(marker: string): string {
    const n = marker.match(NUMBERED);
    return n ? `${parseInt(n[1], 10) + 1}.` : marker;
}

/**
 * Tab / Shift+Tab on a list line: move the whole item one level deeper or
 * shallower. Nesting indents to the content column of the item above it ("- "
 * children indent 2, "1. " children indent 3), because that is what nests in
 * CommonMark: two spaces under "1." does not. A numbered item that becomes a
 * first child restarts at "1.", and one that joins an existing level continues
 * its numbering. Returns null for non-list lines and multi-line selections.
 */
function indentListItem(state: EditorState, shift: boolean): EditorResult | null {
    const { text, selStart, selEnd } = state;
    if (text.slice(selStart, selEnd).includes("\n")) return null;
    const ls = lineStartIndex(text, selStart);
    const le = lineEndIndex(text, selStart);
    const line = text.slice(ls, le);
    const item = parseListLine(line);
    if (!item) return null;

    const numbered = NUMBERED.test(item.marker);
    let newIndent: string;
    let newMarker = item.marker;
    if (!shift) {
        const sibling = findPreviousSibling(text, ls, item.indent.length);
        // Nothing above to nest under: indenting would only make a stray
        // over-indented line (four spaces is a code block), so keep the text
        // and just claim the key.
        if (!sibling) return { text, selStart, selEnd };
        newIndent = " ".repeat(sibling.contentColumn);
        if (numbered) {
            const prevChild = findPreviousSibling(text, ls, newIndent.length);
            newMarker = prevChild && NUMBERED.test(prevChild.marker) ? nextMarkerAfter(prevChild.marker) : "1.";
        }
    } else {
        if (item.indent.length === 0) return { text, selStart, selEnd };
        const parent = findParentItem(text, ls, item.indent.length);
        newIndent = parent ? parent.indent : item.indent.slice(0, Math.max(0, item.indent.length - INDENT.length));
        if (numbered) {
            const prevAtLevel = findPreviousSibling(text, ls, newIndent.length);
            if (prevAtLevel && NUMBERED.test(prevAtLevel.marker)) newMarker = nextMarkerAfter(prevAtLevel.marker);
        }
    }

    const oldHead = item.indent + item.marker;
    const newHead = newIndent + newMarker;
    const delta = newHead.length - oldHead.length;
    // Positions inside the old indent or marker land just after the new
    // indent; everything after the marker moves with the text.
    const shiftPos = (p: number) => (p - ls <= oldHead.length ? Math.max(ls + newIndent.length, p + delta) : p + delta);
    return {
        text: text.slice(0, ls) + newHead + line.slice(oldHead.length) + text.slice(le),
        selStart: shiftPos(selStart),
        selEnd: shiftPos(selEnd),
    };
}

/* ---------- Enter: list continuation ---------- */

export function handleEnter(state: EditorState): EditorResult | null {
    const { text, selStart, selEnd } = state;
    if (selStart !== selEnd) return null;

    const ls = lineStartIndex(text, selStart);
    const le = lineEndIndex(text, selStart);
    const currentLine = text.slice(ls, selStart);
    // Whether an item or quote is EMPTY is decided by the whole line, not just
    // the text before the caret. With the caret right after "- " on "- item",
    // the part before the caret looked empty, so Enter deleted the marker and
    // the text fell out of the list.
    const fullLine = text.slice(ls, le);

    // Blockquote continuation
    const qm = currentLine.match(QUOTE_PATTERN);
    if (qm) {
        // If only the quote prefix is on the line, terminate the quote
        if (fullLine.trim() === ">") {
            return {
                text: text.slice(0, ls) + "\n" + text.slice(le),
                selStart: ls + 1,
                selEnd: ls + 1,
            };
        }
        const insert = "\n" + qm[1];
        return {
            text: text.slice(0, selStart) + insert + text.slice(selEnd),
            selStart: selStart + insert.length,
            selEnd: selStart + insert.length,
        };
    }

    // List continuation. The caret has to be past the marker and its space;
    // inside the indent or on the marker itself, Enter is a plain newline.
    const item = parseListLine(fullLine);
    const caretCol = selStart - ls;
    if (!item || caretCol < item.indent.length + item.marker.length + 1) return null;
    const { indent, marker } = item;
    const taskBox = item.taskBox ? "[ ] " : "";

    if (fullLine.slice(item.prefixLength).trim() === "") {
        // Empty NESTED item: step out one level, becoming the next item of its
        // parent's list, rather than leaving the list altogether.
        if (indent.length > 0) {
            const parent = findParentItem(text, ls, indent.length);
            const outIndent = parent ? parent.indent : indent.slice(0, Math.max(0, indent.length - INDENT.length));
            const outMarker = parent ? nextMarkerAfter(parent.marker) : marker;
            const head = `${outIndent}${outMarker} ${taskBox}`;
            return {
                text: text.slice(0, ls) + head + text.slice(le),
                selStart: ls + head.length,
                selEnd: ls + head.length,
            };
        }
        // Empty top-level item: end the list.
        return {
            text: text.slice(0, ls) + "\n" + text.slice(le),
            selStart: ls + 1,
            selEnd: ls + 1,
        };
    }

    const nextMarker = nextMarkerAfter(marker);

    // Caret at the start of a non-empty item's text (or inside its prefix):
    // open an empty item above and keep this one, task state and all, below,
    // with the caret still at the start of its text.
    if (caretCol <= item.prefixLength) {
        const above = `${indent}${marker} ${taskBox}`;
        const below = `${indent}${nextMarker}${fullLine.slice(indent.length + marker.length)}`;
        const caret = ls + above.length + 1 + item.prefixLength + (nextMarker.length - marker.length);
        return {
            text: text.slice(0, ls) + above + "\n" + below + text.slice(le),
            selStart: caret,
            selEnd: caret,
        };
    }

    const insert = `\n${indent}${nextMarker} ${taskBox}`;
    return {
        text: text.slice(0, selStart) + insert + text.slice(selEnd),
        selStart: selStart + insert.length,
        selEnd: selStart + insert.length,
    };
}

/* ---------- Auto-pair ---------- */

const AUTO_PAIRS: Record<string, string> = {
    "(": ")",
    "[": "]",
    "{": "}",
    "`": "`",
    '"': '"',
    "'": "'",
};

const WRAP_PAIRS: Record<string, string> = {
    "(": ")",
    "[": "]",
    "{": "}",
    "`": "`",
    "*": "*",
    "_": "_",
    '"': '"',
};

export function handleAutoPair(state: EditorState, ch: string): EditorResult | null {
    const { text, selStart, selEnd } = state;

    // Wrap selection
    if (selStart !== selEnd && WRAP_PAIRS[ch]) {
        const close = WRAP_PAIRS[ch];
        const selected = text.slice(selStart, selEnd);
        const wrapped = ch + selected + close;
        return {
            text: text.slice(0, selStart) + wrapped + text.slice(selEnd),
            selStart: selStart + 1,
            selEnd: selEnd + 1,
        };
    }

    // Empty selection: insert pair, place caret in middle
    if (selStart === selEnd && AUTO_PAIRS[ch]) {
        const close = AUTO_PAIRS[ch];
        const nextChar = text[selStart] ?? "";
        // Don't auto-pair quotes when next to a word char (likely an apostrophe)
        if ((ch === "'" || ch === '"') && /\w/.test(text[selStart - 1] ?? "")) return null;
        // Don't double-up if the close char is already there (let the user "type past" it)
        if (nextChar === close && (ch === ")" || ch === "]" || ch === "}" || ch === "`" || ch === '"' || ch === "'")) return null;

        const inserted = ch + close;
        return {
            text: text.slice(0, selStart) + inserted + text.slice(selEnd),
            selStart: selStart + 1,
            selEnd: selStart + 1,
        };
    }

    return null;
}

/** "Type past" closer when caret is right before a matching closer that we just inserted. */
export function handleSkipCloser(state: EditorState, ch: string): EditorResult | null {
    const { text, selStart, selEnd } = state;
    if (selStart !== selEnd) return null;
    if (![")", "]", "}", "`", '"', "'"].includes(ch)) return null;
    if (text[selStart] !== ch) return null;
    return {
        text,
        selStart: selStart + 1,
        selEnd: selStart + 1,
    };
}

/* ---------- Bold / Italic / Link ---------- */

export function wrapSelection(
    state: EditorState,
    left: string,
    right: string = left,
    placeholder: string = ""
): EditorResult {
    const { text, selStart, selEnd } = state;
    const selected = text.slice(selStart, selEnd) || placeholder;

    // Toggle: if selection is already wrapped, unwrap
    const beforeSel = text.slice(Math.max(0, selStart - left.length), selStart);
    const afterSel = text.slice(selEnd, selEnd + right.length);
    if (selStart !== selEnd && beforeSel === left && afterSel === right) {
        return {
            text: text.slice(0, selStart - left.length) + selected + text.slice(selEnd + right.length),
            selStart: selStart - left.length,
            selEnd: selEnd - left.length,
        };
    }

    const wrapped = left + selected + right;
    return {
        text: text.slice(0, selStart) + wrapped + text.slice(selEnd),
        selStart: selStart + left.length,
        selEnd: selStart + left.length + selected.length,
    };
}

export function insertLink(state: EditorState): EditorResult {
    const { text, selStart, selEnd } = state;
    const selected = text.slice(selStart, selEnd);
    const isUrl = /^https?:\/\//i.test(selected);
    const linkText = isUrl ? "" : selected;
    const url = isUrl ? selected : "url";
    const inserted = `[${linkText}](${url})`;
    const newText = text.slice(0, selStart) + inserted + text.slice(selEnd);
    // Place caret inside whichever part is empty
    const caret = isUrl
        ? selStart + 1 // inside [|]
        : selStart + linkText.length + 3; // inside (|)
    return {
        text: newText,
        selStart: caret,
        selEnd: isUrl ? caret : caret + url.length,
    };
}

/* ---------- Backspace: erase auto-pair ---------- */

export function handleBackspace(state: EditorState): EditorResult | null {
    const { text, selStart, selEnd } = state;
    if (selStart !== selEnd || selStart === 0) return null;
    const prev = text[selStart - 1];
    const next = text[selStart];
    if (
        (prev === "(" && next === ")") ||
        (prev === "[" && next === "]") ||
        (prev === "{" && next === "}") ||
        (prev === "`" && next === "`") ||
        (prev === '"' && next === '"') ||
        (prev === "'" && next === "'")
    ) {
        return {
            text: text.slice(0, selStart - 1) + text.slice(selStart + 1),
            selStart: selStart - 1,
            selEnd: selStart - 1,
        };
    }
    return null;
}
