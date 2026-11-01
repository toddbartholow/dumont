import { describe, it, expect } from "vitest";
import { classifyHref, relativeLinkPath } from "./previewLinks";

describe("classifyHref", () => {
    it("sorts the link kinds the reader handles", () => {
        expect(classifyHref("#setup")).toBe("anchor");
        expect(classifyHref("wikilink:Note")).toBe("wikilink");
        expect(classifyHref("https://example.com")).toBe("external");
        expect(classifyHref("HTTP://example.com")).toBe("external");
        expect(classifyHref("mailto:a@b.c")).toBe("external");
        expect(classifyHref("notes/other.md")).toBe("relative-md");
        expect(classifyHref("../up.markdown#part")).toBe("relative-md");
        expect(classifyHref("spec.pdf")).toBe("relative-file");
        expect(classifyHref("./img/diagram.png?raw=1")).toBe("relative-file");
        expect(classifyHref("folder/")).toBe("relative-file");
    });

    it("blocks everything that could navigate the app window elsewhere", () => {
        for (const href of [
            undefined, "", "   ",
            "javascript:alert(1)", "JavaScript:alert(1)", "file:///etc/passwd",
            "data:text/html,<script>", "vbscript:x", "irc://chat", "tauri://localhost",
            "//evil.example/page", "\\\\server\\share\\x.pdf", "C:\\Windows\\notepad.exe",
        ]) {
            expect(classifyHref(href), String(href)).toBe("blocked");
        }
    });
});

describe("relativeLinkPath", () => {
    it("drops the query and the fragment", () => {
        expect(relativeLinkPath("a/b.pdf?x=1#p2")).toBe("a/b.pdf");
        expect(relativeLinkPath("a/b.pdf#p2")).toBe("a/b.pdf");
        expect(relativeLinkPath("a/b.pdf")).toBe("a/b.pdf");
    });
});
