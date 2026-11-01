import { describe, it, expect } from "vitest";
import { slugify, createSlugger } from "./slugify";

describe("slugify", () => {
    it("keeps the ASCII behavior it always had", () => {
        expect(slugify("Hello World")).toBe("hello-world");
        expect(slugify("  Setup: Step 1 (Windows)!  ")).toBe("setup-step-1-windows");
        expect(slugify("snake_case_name")).toBe("snake_case_name");
        expect(slugify("a -- b")).toBe("a-b");
        expect(slugify("-edge-")).toBe("edge");
        expect(slugify("C++ & Rust?")).toBe("c-rust");
        expect(slugify("!!!")).toBe("");
    });

    it("keeps letters and digits from every script", () => {
        expect(slugify("見出し")).toBe("見出し");
        expect(slugify("Привет мир")).toBe("привет-мир");
        expect(slugify("Ελληνικά 2")).toBe("ελληνικά-2");
        expect(slugify("Café déjà vu")).toBe("café-déjà-vu");
        expect(slugify("中文：标题")).toBe("中文标题");
    });

    it("keeps combining marks, so scripts that need them stay readable", () => {
        expect(slugify("हिन्दी")).toBe("हिन्दी");
        // A decomposed e + combining acute keeps its accent.
        expect(slugify("Café")).toBe("café");
    });
});

describe("createSlugger", () => {
    it("suffixes repeats in document order", () => {
        const s = createSlugger();
        expect([s.slug("Setup"), s.slug("Setup"), s.slug("Setup")]).toEqual(["setup", "setup-1", "setup-2"]);
    });

    it("gives distinct ids to distinct non-Latin headings", () => {
        const s = createSlugger();
        expect([s.slug("はじめに"), s.slug("使い方")]).toEqual(["はじめに", "使い方"]);
    });

    it("falls back to section for headings that slug to nothing", () => {
        const s = createSlugger();
        expect([s.slug("!!!"), s.slug("")]).toEqual(["section", "section-1"]);
    });

    it("shares the count between custom ids and auto slugs", () => {
        const s = createSlugger();
        expect(s.reserve("setup")).toBe("setup");
        expect(s.slug("Setup")).toBe("setup-1");
        expect(s.reserve("setup")).toBe("setup-2");
    });
});
