import { describe, it, expect } from "vitest";
import { rewriteWikilinksOutsideCode as rw } from "./wikilinkRewrite";

describe("rewriteWikilinksOutsideCode", () => {
    it("rewrites wikilinks in prose, with and without an alias", () => {
        expect(rw("see [[Foo Bar]] now")).toBe("see [Foo Bar](wikilink:Foo%20Bar) now");
        expect(rw("[[Foo|the bar]]")).toBe("[the bar](wikilink:Foo)");
    });

    it("returns a body without wikilinks unchanged", () => {
        const doc = "# Title\n\n```js\nconst a = [1];\n```\n";
        expect(rw(doc)).toBe(doc);
    });

    it("leaves backtick and tilde fences alone", () => {
        const doc = "prose [[A]]\n\n```js\nconst x = [[1, 2]].flat();\n```\n\n~~~\n[[keep]]\n~~~\n[[B]]";
        expect(rw(doc)).toBe(
            "prose [A](wikilink:A)\n\n```js\nconst x = [[1, 2]].flat();\n```\n\n~~~\n[[keep]]\n~~~\n[B](wikilink:B)",
        );
    });

    it("closes a fence only with the same character at least as long", () => {
        const doc = "````\n```\n[[inside]]\n~~~\n````\n[[after]]";
        expect(rw(doc)).toBe("````\n```\n[[inside]]\n~~~\n````\n[after](wikilink:after)");
    });

    it("treats an unclosed fence as running to the end", () => {
        expect(rw("[[a]]\n```\n[[b]]")).toBe("[a](wikilink:a)\n```\n[[b]]");
    });

    it("leaves indented code alone, but not indented list content", () => {
        expect(rw("para\n\n    x = [[1]]\n\n[[Real]]")).toBe("para\n\n    x = [[1]]\n\n[Real](wikilink:Real)");
        expect(rw("- item\n\n    more [[Note]]")).toBe("- item\n\n    more [Note](wikilink:Note)");
        // A paragraph's lazy continuation line is not code either.
        expect(rw("para\n    [[Lazy]]")).toBe("para\n    [Lazy](wikilink:Lazy)");
    });

    it("leaves inline code spans alone, matching backtick run lengths", () => {
        expect(rw("use `[[x]]` here [[Real]]")).toBe("use `[[x]]` here [Real](wikilink:Real)");
        expect(rw("``a ` [[x]]`` and [[y]]")).toBe("``a ` [[x]]`` and [y](wikilink:y)");
        // An unmatched backtick is literal, so the link after it still rewrites.
        expect(rw("a ` b [[y]]")).toBe("a ` b [y](wikilink:y)");
    });

    it("leaves inline and display math alone", () => {
        expect(rw("$f[[i]]$ and [[Real]]")).toBe("$f[[i]]$ and [Real](wikilink:Real)");
        expect(rw("$$\nm[[i]] = 0\n$$\n[[Real]]")).toBe("$$\nm[[i]] = 0\n$$\n[Real](wikilink:Real)");
        expect(rw("inline $$a[[1]]$$ then [[R]]")).toBe("inline $$a[[1]]$$ then [R](wikilink:R)");
    });

    it("does not mistake prices for math", () => {
        expect(rw("costs $5 and [[Note]] $10")).toBe("costs $5 and [Note](wikilink:Note) $10");
    });
});
