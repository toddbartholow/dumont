import { describe, it, expect } from "vitest";
import { extractHeadings, stripInlineMarkdown } from "./outline";

const brief = (md: string) => extractHeadings(md).map(({ text, level, line }) => ({ text, level, line }));

describe("extractHeadings", () => {
    it("reads ATX headings with display text and source lines", () => {
        const md = "# Title\n\n## **Setup** for [Windows](https://x.com) {#win} ##\n\n### snake_case_name";
        expect(extractHeadings(md)).toEqual([
            { text: "Title", level: 1, line: 1, id: "title" },
            { text: "Setup for Windows", level: 2, line: 3, id: "win" },
            { text: "snake_case_name", level: 3, line: 5, id: "snake_case_name" },
        ]);
    });

    it("reads setext headings, including multi-line ones", () => {
        const md = "Big Title\n=========\n\nSection\nspans two\n---\n\ntext";
        expect(brief(md)).toEqual([
            { text: "Big Title", level: 1, line: 1 },
            { text: "Section spans two", level: 2, line: 4 },
        ]);
    });

    it("does not treat thematic breaks, list items or code as headings", () => {
        const md = [
            "para", "", "---", "",
            "- item", "---", "",
            "    # indented code", "",
            "```bash", "# comment", "```", "",
            "~~~", "# also code", "~~~", "",
            "````md", "```", "# still inside the longer fence", "```", "````",
        ].join("\n");
        expect(brief(md)).toEqual([]);
    });

    it("treats an unclosed fence as running to the end", () => {
        expect(brief("# Before\n```\n# inside\n")).toEqual([{ text: "Before", level: 1, line: 1 }]);
    });

    it("does not mistake an indented line inside a list for code", () => {
        const md = "- item\n\n    continued\n\n# After";
        expect(brief(md)).toEqual([{ text: "After", level: 1, line: 5 }]);
    });

    it("skips frontmatter and keeps content-relative line numbers", () => {
        const md = "---\ntitle: x\n# not a heading\n---\n# Real";
        expect(brief(md)).toEqual([{ text: "Real", level: 1, line: 5 }]);
    });

    it("handles CRLF line endings", () => {
        expect(brief("---\r\na: 1\r\n---\r\n# One\r\n\r\nTwo\r\n===\r\n")).toEqual([
            { text: "One", level: 1, line: 4 },
            { text: "Two", level: 1, line: 6 },
        ]);
    });

    it("ignores empty ATX headings but keeps the slug count in step with the preview", () => {
        const out = extractHeadings("#\n\n## \n\n## ok\n\n# !!!");
        expect(out.map((h) => [h.text, h.id])).toEqual([
            ["ok", "ok"],
            ["!!!", "section-2"],
        ]);
    });

    it("gives repeated and non-Latin headings the preview's ids", () => {
        const md = "# Setup\n## Setup\n# 見出し\n# Привет";
        expect(extractHeadings(md).map((h) => h.id)).toEqual(["setup", "setup-1", "見出し", "привет"]);
    });

    it("reserves custom ids against later auto slugs", () => {
        const md = "# Intro {#setup}\n# Setup";
        expect(extractHeadings(md).map((h) => h.id)).toEqual(["setup", "setup-1"]);
    });
});

describe("stripInlineMarkdown", () => {
    it("strips emphasis, links, images and markers", () => {
        expect(stripInlineMarkdown("**bold** *it* _em_ ~~gone~~ ==mark==")).toBe("bold it em gone mark");
        expect(stripInlineMarkdown("![logo](a.png) [docs](x.md) [ref][1]")).toBe("logo docs ref");
        expect(stripInlineMarkdown("[[Note|alias]] and [[Plain]]")).toBe("alias and Plain");
        expect(stripInlineMarkdown("H~2~O and x^2^")).toBe("H2O and x2");
    });

    it("keeps code spans literal", () => {
        expect(stripInlineMarkdown("Use `**not bold**` here")).toBe("Use **not bold** here");
        expect(stripInlineMarkdown("``a ` b``")).toBe("a ` b");
    });

    it("leaves intraword underscores and unmatched backticks alone", () => {
        expect(stripInlineMarkdown("snake_case_name")).toBe("snake_case_name");
        expect(stripInlineMarkdown("a ` b")).toBe("a ` b");
    });

    it("decodes escapes and entities and drops raw HTML", () => {
        expect(stripInlineMarkdown("\\*literal\\* &amp; <b>tag</b> &#169;")).toBe("*literal* & tag ©");
    });
});
