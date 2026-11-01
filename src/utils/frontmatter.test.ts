import { describe, it, expect } from "vitest";
import { parseFrontmatter, serializeFrontmatter, updateFrontmatter, type FrontmatterValue } from "./frontmatter";

describe("parseFrontmatter", () => {
    it("returns the source unchanged when there is no frontmatter", () => {
        const r = parseFrontmatter("# Just a heading");
        expect(r.hasFrontmatter).toBe(false);
        expect(r.body).toBe("# Just a heading");
        expect(r.data).toEqual({});
    });

    it("parses scalars, inline arrays, block arrays, booleans, and numbers", () => {
        const src = [
            "---",
            "title: Hello",
            "count: 3",
            "ratio: 1.5",
            "published: true",
            "tags: [a, b]",
            "list:",
            "  - x",
            "  - y",
            "---",
            "body text",
        ].join("\n");
        const r = parseFrontmatter(src);
        expect(r.hasFrontmatter).toBe(true);
        expect(r.data.title).toBe("Hello");
        expect(r.data.count).toBe(3);
        expect(r.data.ratio).toBe(1.5);
        expect(r.data.published).toBe(true);
        expect(r.data.tags).toEqual(["a", "b"]);
        expect(r.data.list).toEqual(["x", "y"]);
        expect(r.body).toBe("body text");
    });
});

describe("serializeFrontmatter round-trip", () => {
    it("re-parses to the same data", () => {
        const data = { title: "Hello", tags: ["a", "b"], count: 3, published: true };
        const serialized = serializeFrontmatter(data, "body");
        const reparsed = parseFrontmatter(serialized);
        expect(reparsed.data).toEqual(data);
    });

    it("returns the body unchanged when there is no data", () => {
        expect(serializeFrontmatter({}, "hello")).toBe("hello");
    });
});

describe("parseFrontmatter reads more of real-world YAML", () => {
    const parse = (...yaml: string[]) => parseFrontmatter(["---", ...yaml, "---", "body"].join("\n")).data;

    it("drops trailing comments, but not a # inside a value or quotes", () => {
        expect(parse(
            "draft: true # flip when ready",
            "url: https://x.test/#top",
            'title: "a # b" # c',
            "tags: [a, b] # note",
            "lang: C#",
        )).toEqual({ draft: true, url: "https://x.test/#top", title: "a # b", tags: ["a", "b"], lang: "C#" });
    });

    it("reads literal and folded block scalars", () => {
        expect(parse(
            "lit: |",
            "  line one",
            "  line two",
            "fold: >-",
            "  one",
            "  two",
            "",
            "  three",
            "after: x",
        )).toEqual({ lit: "line one\nline two", fold: "one two\nthree", after: "x" });
    });

    it("folds a plain value continued on more-indented lines", () => {
        expect(parse("summary: a long", "  summary here", "next: 1")).toEqual({ summary: "a long summary here", next: 1 });
    });

    it("unescapes quotes inside quoted strings", () => {
        expect(parse("a: 'it''s'", 'b: "say \\"hi\\""')).toEqual({ a: "it's", b: 'say "hi"' });
    });

    it("reads list items at any indentation", () => {
        expect(parse("tags:", "    - a", "    - b")).toEqual({ tags: ["a", "b"] });
    });
});

describe("updateFrontmatter edits only what changed", () => {
    const doc = (...yaml: string[]) => ["---", ...yaml, "---", "", "# Body", "", "text"].join("\n");
    /** Apply a card edit the way the card does: spread the parsed map and change one key. */
    const edit = (source: string, patch: Record<string, FrontmatterValue>) =>
        updateFrontmatter(source, { ...parseFrontmatter(source).data, ...patch });

    const SOURCE = doc(
        "# Post metadata",
        'title: "Hello"   # shown in the tab',
        "",
        "date: 2024-01-02",
        "draft: true",
        "# Tags drive the index",
        "tags:",
        "  - one   # first",
        "  # an aside",
        "  - two",
        "inline: ['x', y]",
        "summary: >",
        "  A folded",
        "  paragraph.",
        "",
        "author: Someone",
    );

    it("leaves the source byte-identical when nothing changed", () => {
        expect(edit(SOURCE, {})).toBe(SOURCE);
    });

    it("rewrites one scalar's line, keeping its quotes and comment and every other line", () => {
        const out = edit(SOURCE, { title: "Goodbye" });
        expect(out).toBe(SOURCE.replace('title: "Hello"   # shown in the tab', 'title: "Goodbye"   # shown in the tab'));
    });

    it("keeps single quotes single, escaping as YAML does", () => {
        const out = edit(doc("name: 'Ann'"), { name: "Ann's" });
        expect(out).toBe(doc("name: 'Ann''s'"));
        expect(parseFrontmatter(out).data.name).toBe("Ann's");
    });

    it("quotes a new plain value only when it needs it", () => {
        expect(edit(doc("author: Someone"), { author: "Else" })).toBe(doc("author: Else"));
        expect(edit(doc("author: Someone"), { author: "A: B" })).toBe(doc('author: "A: B"'));
        expect(edit(doc("author: Someone"), { author: "42" })).toBe(doc('author: "42"'));
        expect(parseFrontmatter(edit(doc("author: Someone"), { author: "42" })).data.author).toBe("42");
    });

    it("flips a boolean in place", () => {
        expect(edit(SOURCE, { draft: false })).toBe(SOURCE.replace("draft: true", "draft: false"));
    });

    it("removes one block-array item and keeps the comments around the rest", () => {
        expect(edit(SOURCE, { tags: ["two"] })).toBe(SOURCE.replace("  - one   # first\n", ""));
    });

    it("appends a block-array item after the last one, written like it", () => {
        expect(edit(SOURCE, { tags: ["one", "two", "three"] })).toBe(SOURCE.replace("  - two\n", "  - two\n  - three\n"));
    });

    it("edits an inline array in place, keeping how surviving items were written", () => {
        expect(edit(SOURCE, { inline: ["x", "y", "z"] })).toBe(SOURCE.replace("inline: ['x', y]", "inline: ['x', y, z]"));
        expect(edit(SOURCE, { inline: ["y"] })).toBe(SOURCE.replace("inline: ['x', y]", "inline: [y]"));
    });

    it("rewrites a multi-line value as a whole, keeping its block style", () => {
        const out = edit(SOURCE, { summary: "New text." });
        expect(out).toBe(SOURCE.replace("summary: >\n  A folded\n  paragraph.\n", "summary: >\n  New text.\n"));
        expect(parseFrontmatter(out).data.summary).toBe("New text.");
    });

    it("rewrites a literal block scalar line by line", () => {
        const src = doc("notes: |-", "    first", "    second", "after: 1");
        expect(edit(src, { notes: "first\nchanged" })).toBe(doc("notes: |-", "    first", "    changed", "after: 1"));
    });

    it("does not flatten a multi-line value the card only focused and blurred", () => {
        // A text input strips newlines from its value, so the card hands back
        // "line oneline two" for a value whose line breaks it could not show.
        const src = doc("lit: |", "  line one", "  line two");
        expect(updateFrontmatter(src, { lit: "line oneline two" })).toBe(src);
    });

    it("replaces a plain value continued over several lines with one line", () => {
        const src = doc("summary: a long", "  summary here", "next: 1");
        expect(edit(src, { summary: "short" })).toBe(doc("summary: short", "next: 1"));
    });

    it("appends a new key at the end of the block, before trailing blank lines", () => {
        const src = doc("a: 1", "# trailing comment", "");
        expect(updateFrontmatter(src, { a: 1, b: "two" })).toBe(doc("a: 1", "# trailing comment", "b: two", ""));
    });

    it("removes a key's line(s), and every duplicate of it", () => {
        const src = doc("keep: 1", "gone: x", "list:", "  - a", "  - b", "# still here", "gone: y");
        expect(updateFrontmatter(src, { keep: 1 })).toBe(doc("keep: 1", "# still here"));
    });

    it("edits the last of a repeated key, which is the one the card shows", () => {
        expect(edit(doc("k: first", "k: second"), { k: "third" })).toBe(doc("k: first", "k: third"));
    });

    it("keeps CRLF line endings and the body untouched", () => {
        const src = "---\r\n# c\r\ntitle: A\r\ncount: 2\r\n---\r\nBody\r\n";
        expect(edit(src, { count: 3 })).toBe("---\r\n# c\r\ntitle: A\r\ncount: 3\r\n---\r\nBody\r\n");
    });

    it("drops the block when every key is removed and nothing else is left", () => {
        expect(updateFrontmatter("---\na: 1\n---\nbody", {})).toBe("body");
    });

    it("keeps comments when every key is removed", () => {
        expect(updateFrontmatter("---\n# keep me\na: 1\n---\nbody", {})).toBe("---\n# keep me\n---\nbody");
    });

    it("creates a block when the document had none", () => {
        expect(updateFrontmatter("body", { title: "T" })).toBe("---\ntitle: T\n---\n\nbody");
        expect(updateFrontmatter("body", {})).toBe("body");
    });

    it("finds keys named like Object.prototype members", () => {
        expect(edit(doc("constructor: x", "a: 1"), { a: 2 })).toBe(doc("constructor: x", "a: 2"));
    });
});
