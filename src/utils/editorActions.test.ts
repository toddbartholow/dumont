import { describe, it, expect } from "vitest";
import {
    handleTab,
    handleEnter,
    handleAutoPair,
    handleSkipCloser,
    handleBackspace,
    wrapSelection,
    insertLink,
    type EditorState,
} from "./editorActions";

const st = (text: string, selStart: number, selEnd: number = selStart): EditorState => ({ text, selStart, selEnd });

describe("handleAutoPair", () => {
    it("inserts a closing pair on empty selection and centers the caret", () => {
        const r = handleAutoPair(st("", 0), "(");
        expect(r).toEqual({ text: "()", selStart: 1, selEnd: 1 });
    });

    it("wraps a non-empty selection", () => {
        const r = handleAutoPair(st("abc", 0, 3), "(");
        expect(r).toEqual({ text: "(abc)", selStart: 1, selEnd: 4 });
    });

    it("does not auto-pair a quote next to a word char (apostrophe)", () => {
        expect(handleAutoPair(st("a", 1), "'")).toBeNull();
    });

    it("returns null for a non-pairing char", () => {
        expect(handleAutoPair(st("", 0), "z")).toBeNull();
    });
});

describe("handleSkipCloser", () => {
    it("types past an existing closer", () => {
        expect(handleSkipCloser(st("()", 1), ")")).toEqual({ text: "()", selStart: 2, selEnd: 2 });
    });
    it("returns null when next char is not the closer", () => {
        expect(handleSkipCloser(st("(", 1), ")")).toBeNull();
    });
});

describe("handleBackspace", () => {
    it("erases an empty auto-pair as a unit", () => {
        expect(handleBackspace(st("()", 1))).toEqual({ text: "", selStart: 0, selEnd: 0 });
    });
    it("returns null for normal backspace", () => {
        expect(handleBackspace(st("ab", 2))).toBeNull();
    });
});

describe("wrapSelection", () => {
    it("wraps a selection with markers", () => {
        expect(wrapSelection(st("bold", 0, 4), "**", "**")).toEqual({ text: "**bold**", selStart: 2, selEnd: 6 });
    });
    it("toggles (unwraps) an already-wrapped selection", () => {
        // selecting "bold" inside "**bold**"
        expect(wrapSelection(st("**bold**", 2, 6), "**", "**")).toEqual({ text: "bold", selStart: 0, selEnd: 4 });
    });
});

describe("insertLink", () => {
    it("uses a pasted-looking URL as the href and puts caret in the text slot", () => {
        const r = insertLink(st("https://x.com", 0, 13));
        expect(r.text).toBe("[](https://x.com)");
        expect(r.selStart).toBe(1);
    });
    it("treats plain selection as link text and selects the url placeholder", () => {
        const r = insertLink(st("click", 0, 5));
        expect(r.text).toBe("[click](url)");
        expect(r.text.slice(r.selStart, r.selEnd)).toBe("url");
    });
});

describe("handleEnter", () => {
    it("continues a bullet list", () => {
        expect(handleEnter(st("- a", 3))?.text).toBe("- a\n- ");
    });
    it("increments a numbered list", () => {
        expect(handleEnter(st("1. a", 4))?.text).toBe("1. a\n2. ");
    });
    it("terminates an empty list item", () => {
        expect(handleEnter(st("- ", 2))?.text).toBe("\n");
    });
    it("continues a blockquote", () => {
        expect(handleEnter(st("> hi", 4))?.text).toBe("> hi\n> ");
    });
    it("returns null on a plain line", () => {
        expect(handleEnter(st("plain", 5))).toBeNull();
    });
});

describe("handleTab", () => {
    it("inserts indent on a single line", () => {
        expect(handleTab(st("abc", 0), false)).toEqual({ text: "  abc", selStart: 2, selEnd: 2 });
    });
    it("indents every line of a multi-line selection", () => {
        const r = handleTab(st("a\nb", 0, 3), false);
        expect(r?.text).toBe("  a\n  b");
    });
    it("outdents with shift", () => {
        const r = handleTab(st("  abc", 2), true);
        expect(r?.text).toBe("abc");
    });
    it("moves to the next table cell", () => {
        // "| a | b |" — caret in first cell -> jumps into second cell
        const r = handleTab(st("| a | b |", 2), false);
        expect(r?.selStart).toBe(6);
    });
});

// The caret is written into the text as "^", so each case reads as the document
// the user is looking at. Two carets mark a selection.
const at = (marked: string): EditorState => {
    const first = marked.indexOf("^");
    const second = marked.indexOf("^", first + 1);
    if (second === -1) return st(marked.replace("^", ""), first);
    return st(marked.replace(/\^/g, ""), first, second - 1);
};
const show = (r: { text: string; selStart: number; selEnd: number } | null): string | null => {
    if (!r) return null;
    if (r.selStart === r.selEnd) return r.text.slice(0, r.selStart) + "^" + r.text.slice(r.selStart);
    return r.text.slice(0, r.selStart) + "^" + r.text.slice(r.selStart, r.selEnd) + "^" + r.text.slice(r.selEnd);
};

describe("handleTab with a selection inside one line", () => {
    it("indents a plain line and keeps the selected text", () => {
        // Used to replace "world" with two spaces.
        expect(show(handleTab(at("hello ^world^"), false))).toBe("  hello ^world^");
    });

    it("nests a list item and keeps the selected text", () => {
        expect(show(handleTab(at("- a\n- ^bc^"), false))).toBe("- a\n  - ^bc^");
    });

    it("outdents with Shift and keeps the selected text", () => {
        expect(show(handleTab(at("  hello ^world^"), true))).toBe("hello ^world^");
    });
});

describe("table Tab in the last cell", () => {
    const table = "| a | b |\n| --- | --- |\n| 1 | 2 |";

    it("adds a row when the table ends the document", () => {
        // Used to fall through and insert two spaces in the cell instead.
        expect(show(handleTab(at("| a | b |\n| --- | --- |\n| 1 | 2^ |"), false))).toBe(
            table + "\n| ^ |  |",
        );
    });

    it("adds a row when only a trailing newline follows the table", () => {
        expect(show(handleTab(at("| a | b |\n| --- | --- |\n| 1 | 2^ |\n"), false))).toBe(
            table + "\n| ^ |  |\n",
        );
    });

    it("adds a body row below the separator of a header-only table", () => {
        expect(show(handleTab(at("| a | b^ |\n| --- | --- |"), false))).toBe(
            "| a | b |\n| --- | --- |\n| ^ |  |",
        );
    });

    it("still moves to the next body row when there is one", () => {
        expect(show(handleTab(at("| a | b^ |\n| --- | --- |\n| 1 | 2 |"), false))).toBe(
            "| a | b |\n| --- | --- |\n| ^1 | 2 |",
        );
    });
});

describe("Enter on a non-empty list item with the caret right after the marker", () => {
    it("keeps the marker and moves the text into a new item below", () => {
        // Used to count as an empty item: the marker was deleted.
        expect(show(handleEnter(at("- ^item")))).toBe("- \n- ^item");
    });

    it("keeps a task's checkbox and its checked state", () => {
        expect(show(handleEnter(at("- [x] ^done")))).toBe("- [ ] \n- [x] ^done");
        // A caret inside the prefix counts as the start of the text.
        expect(show(handleEnter(at("- ^[x] done")))).toBe("- [ ] \n- [x] ^done");
    });

    it("numbers the moved item after the new empty one", () => {
        expect(show(handleEnter(at("1. ^first")))).toBe("1. \n2. ^first");
    });

    it("splits a blockquote line instead of dropping the quote marker", () => {
        expect(show(handleEnter(at("> ^quoted")))).toBe("> \n> ^quoted");
    });

    it("still ends the list on a genuinely empty top-level item", () => {
        expect(show(handleEnter(at("- a\n- ^")))).toBe("- a\n\n^");
        expect(show(handleEnter(at("- a\n- [ ] ^")))).toBe("- a\n\n^");
    });

    it("leaves Enter alone when the caret is before the marker", () => {
        expect(handleEnter(at("^- item"))).toBeNull();
    });
});

describe("Tab and Shift+Tab nest the whole list item", () => {
    it("nests a bullet under the item above by its content width (2)", () => {
        expect(show(handleTab(at("- a\n- b^c"), false))).toBe("- a\n  - b^c");
    });

    it("nests under a numbered item by its content width (3), restarting at 1", () => {
        expect(show(handleTab(at("1. a\n2. b^"), false))).toBe("1. a\n   1. b^");
    });

    it("uses the parent's real width for a wide marker", () => {
        expect(show(handleTab(at("10. a\n11. ^b"), false))).toBe("10. a\n    1. ^b");
    });

    it("continues numbering when nesting next to an existing child", () => {
        expect(show(handleTab(at("1. a\n   1. x\n2. ^b"), false))).toBe("1. a\n   1. x\n   2. ^b");
    });

    it("nests with the caret anywhere on the line, including before the marker", () => {
        expect(show(handleTab(at("- a\n^- b"), false))).toBe("- a\n  ^- b");
    });

    it("claims Tab on the first item without changing it, since there is nothing to nest under", () => {
        expect(show(handleTab(at("- ^a"), false))).toBe("- ^a");
    });

    it("unnests to the parent's level", () => {
        expect(show(handleTab(at("1. a\n   - b^"), true))).toBe("1. a\n- b^");
    });

    it("unnests a numbered child into the parent list's numbering", () => {
        expect(show(handleTab(at("1. a\n   1. ^b"), true))).toBe("1. a\n2. ^b");
    });

    it("claims Shift+Tab on a top-level item without changing it", () => {
        expect(show(handleTab(at("- ^a"), true))).toBe("- ^a");
    });

    it("leaves a multi-line selection to the block indent", () => {
        expect(handleTab(at("- ^a\n- b^"), false)?.text).toBe("  - a\n  - b");
    });
});

describe("Enter on an empty nested item", () => {
    it("steps out one level instead of leaving the list", () => {
        expect(show(handleEnter(at("- a\n  - b\n  - ^")))).toBe("- a\n  - b\n- ^");
    });

    it("continues the parent's numbering when it steps out", () => {
        expect(show(handleEnter(at("1. a\n   - b\n   - ^")))).toBe("1. a\n   - b\n2. ^");
    });

    it("steps out one level at a time from deep nesting", () => {
        expect(show(handleEnter(at("- a\n  - b\n    - c\n    - ^")))).toBe("- a\n  - b\n    - c\n  - ^");
    });

    it("keeps a task box when it steps out", () => {
        expect(show(handleEnter(at("- [ ] a\n  - [ ] ^")))).toBe("- [ ] a\n- [ ] ^");
    });
});
