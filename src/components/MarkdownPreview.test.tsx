// Regression test for footnote navigation (CodenameFlux report): remark-rehype
// already prefixes footnote ids and hrefs with `user-content-`, and
// rehype-sanitize's default clobber pass used to prefix the id a SECOND time,
// so footnote refs and back-arrows pointed at ids that don't exist. The
// invariant asserted here — every in-page link's href resolves to a real id in
// the rendered document — is what keeps clicks working in the app and links
// working in exported HTML, regardless of prefix policy.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";
import { MarkdownPreview } from "./MarkdownPreview";
import { invoke } from "@tauri-apps/api/core";
import { extractHeadings } from "../utils/outline";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";

vi.mock("@tauri-apps/api/core", () => ({
    invoke: vi.fn(async () => null),
    convertFileSrc: (p: string) => p,
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async () => {}), revealItemInDir: vi.fn(async () => {}) }));

afterEach(cleanup);

function renderPreview(content: string, extraProps: Record<string, unknown> = {}) {
    return render(
        <MarkdownPreview
            content={content}
            fileName="test.md"
            fileSize={content.length}
            onEditClick={() => {}}
            {...extraProps}
        />,
    );
}

describe("footnote links", () => {
    it("gives every footnote ref and back-arrow an href that resolves to a real id", async () => {
        const { container } = renderPreview(
            "Some text[^1] and more[^2].\n\n[^1]: First note.\n[^2]: Second note.",
        );
        // The body renders through useTransition, so wait for the links.
        const links = await waitFor(() => {
            const ls = Array.from(container.querySelectorAll<HTMLAnchorElement>("a[href^='#']"));
            expect(ls.length).toBeGreaterThanOrEqual(4); // 2 refs + 2 back-arrows
            return ls;
        });
        for (const link of links) {
            const id = decodeURIComponent(link.getAttribute("href")!.slice(1));
            expect(
                container.querySelector(`[id="${id}"]`),
                `no element with id "${id}" for href "${link.getAttribute("href")}"`,
            ).toBeTruthy();
        }
    });
});

// Extended markdown syntaxes (SYNTAX-01, CodenameFlux review): ==highlight==,
// ^sup^/~sub~, definition lists and {#custom-id} heading ids. Exports capture
// the preview DOM, so asserting the rendered elements covers exports too.
describe("extended markdown syntax", () => {
    it("renders mark, sup, sub, definition lists and a custom heading id", async () => {
        const md = [
            "# My Title {#custom-id}",
            "",
            "Water is H~2~O and E = mc^2^, said the ==highlighted== part.",
            "",
            "Term one",
            ": The first definition",
        ].join("\n");
        const { container } = renderPreview(md);
        await waitFor(() => expect(container.querySelector("mark")).toBeTruthy());
        expect(container.querySelector("mark")!.textContent).toBe("highlighted");
        expect(container.querySelector("sub")!.textContent).toBe("2");
        expect(container.querySelector("sup")!.textContent).toBe("2");
        expect(container.querySelector("dl")).toBeTruthy();
        expect(container.querySelector("dt")!.textContent).toBe("Term one");
        expect(container.querySelector("dd")!.textContent).toContain("The first definition");
        const h1 = container.querySelector("h1")!;
        expect(h1.id).toBe("custom-id");
        // The {#custom-id} marker itself must not leak into the rendered text.
        expect(h1.textContent).not.toContain("{#custom-id}");
    });

    it("keeps GFM strikethrough (~~) working next to mark (==) and sub (~)", async () => {
        const { container } = renderPreview("==x== then ~~y~~ then ~z~");
        await waitFor(() => expect(container.querySelector("mark")).toBeTruthy());
        expect(container.querySelector("mark")!.textContent).toBe("x");
        expect(container.querySelector("del")!.textContent).toBe("y");
        expect(container.querySelector("sub")!.textContent).toBe("z");
    });

    it("still gives headings without {#id} their slug id (fallback intact)", async () => {
        const { container } = renderPreview("## Regular Heading\n\n## Regular Heading");
        const headings = await waitFor(() => {
            const hs = Array.from(container.querySelectorAll<HTMLHeadingElement>("h2"));
            expect(hs.length).toBe(2);
            return hs;
        });
        expect(headings[0].id).toBe("regular-heading");
        // Dedup suffixing must survive the custom-id change too.
        expect(headings[1].id).toBe("regular-heading-1");
    });

    it("keeps GFM task lists working alongside the new plugins", async () => {
        const { container } = renderPreview("- [ ] open item\n- [x] done item");
        await waitFor(() => {
            const boxes = container.querySelectorAll<HTMLInputElement>("input[type='checkbox']");
            expect(boxes.length).toBe(2);
            expect(boxes[1].checked).toBe(true);
        });
    });

    // The npm remark-supersub plugin split text on ANY even marker count,
    // corrupting ordinary prose. The local plugin requires Pandoc's rule:
    // non-empty content with no whitespace between the markers.
    it("leaves prose with unpaired or spaced markers untouched", async () => {
        const md = [
            "x^2 + y^2 stays literal",
            "",
            "edit ~/.config and ~/.bashrc now",
            "",
            "see [^a] and [^b] here",
        ].join("\n");
        const { container } = renderPreview(md);
        await waitFor(() => expect(container.textContent).toContain("x^2 + y^2 stays literal"));
        expect(container.querySelector("sup")).toBeFalsy();
        expect(container.querySelector("sub")).toBeFalsy();
        expect(container.textContent).toContain("edit ~/.config and ~/.bashrc now");
        expect(container.textContent).toContain("see [^a] and [^b] here");
    });

    it("rejects {#ids} that are not valid anchors and dedupes repeated custom ids", async () => {
        const md = [
            "# Bad One {#My Id}",
            "",
            "# Twin {#dup}",
            "",
            "# Other Twin {#dup}",
        ].join("\n");
        const { container } = renderPreview(md);
        const headings = await waitFor(() => {
            const hs = Array.from(container.querySelectorAll<HTMLHeadingElement>("h1"));
            expect(hs.length).toBe(3);
            return hs;
        });
        // Invalid id (space) stays literal text and falls back to the slug.
        expect(headings[0].textContent).toContain("{#My Id}");
        expect(headings[0].id).not.toBe("My Id");
        // Duplicate custom ids must not produce duplicate DOM ids.
        expect(headings[1].id).toBe("dup");
        expect(headings[2].id).toBe("dup-1");
    });

    it("does not mangle tildes inside inline math when KaTeX is active", async () => {
        // hasMath() triggers the lazy math chain; remark-math extracts $a~b$
        // into an inlineMath node at parse time, so remark-supersub must only
        // see the ~z~ outside the math span.
        const { container } = renderPreview("$a~b$ stays math but ~z~ is sub");
        await waitFor(() => expect(container.querySelector(".katex")).toBeTruthy(), { timeout: 10000 });
        const sub = container.querySelector("sub");
        expect(sub).toBeTruthy();
        expect(sub!.textContent).toBe("z");
        // The math span must not contain a <sub> injected by supersub.
        expect(container.querySelector(".katex sub")).toBeFalsy();
    }, 15000);

    // mhchem registers \ce on whichever KaTeX it imports, which is the
    // top-level package, while rehype-katex renders with the KaTeX ITS range
    // resolves to. A top-level bump past rehype-katex's range (Dependabot's
    // katex 0.19 in PR #20) splits them: \ce lands on a copy nothing renders
    // with, and every formula comes out in KaTeX's error color.
    it("renders mhchem's \\ce through the same KaTeX that rehype-katex uses", async () => {
        const { container } = renderPreview("Water is $\\ce{H2O}$.");
        await waitFor(() => expect(container.querySelector(".katex")).toBeTruthy(), { timeout: 10000 });
        expect(container.innerHTML).not.toMatch(/#cc0000|katex-error/i);
    }, 15000);
});

// Relative .md links used to render as href="#" with the target held only in
// the onClick closure — exports captured dead anchors. The real href must be
// in the DOM, with in-app navigation still going through the callback.
describe("relative markdown links", () => {
    it("renders the real href and navigates in-app on click", async () => {
        const onNavigateRelative = vi.fn();
        const { container } = renderPreview("[other](notes/other.md)", { onNavigateRelative });
        const link = await waitFor(() => {
            const a = container.querySelector<HTMLAnchorElement>("a[data-relative-md]");
            expect(a).toBeTruthy();
            return a!;
        });
        expect(link.getAttribute("href")).toBe("notes/other.md");

        const click = new MouseEvent("click", { bubbles: true, cancelable: true });
        link.dispatchEvent(click);
        expect(onNavigateRelative).toHaveBeenCalledWith("notes/other.md");
        // preventDefault must fire or the webview would navigate to the .md URL.
        expect(click.defaultPrevented).toBe(true);
    });
});

// A local image is read through Rust, and the read takes time. Change the image while one is
// still loading and the old read must not land on the new one.
describe("local images", () => {
    it("shows the current image when an earlier read lands after it", async () => {
        const held = new Map<string, () => void>();
        vi.mocked(invoke).mockImplementation(((cmd: string, args: { relPath?: string }) => {
            if (cmd !== "read_image_file") return Promise.resolve(null);
            return new Promise<unknown>((resolve) => held.set(args.relPath!, () => resolve(new ArrayBuffer(4))));
        }) as typeof invoke);
        // jsdom has no object URLs. Number them in the order they are made, which is the
        // order the reads are released in below.
        let made = 0;
        const created = vi.fn(() => `blob:${++made}`);
        Object.assign(URL, { createObjectURL: created, revokeObjectURL: vi.fn() });

        const { container, rerender } = renderPreview("![pic](late-first.png)", { filePath: "/notes/doc.md" });
        await waitFor(() => expect(held.has("late-first.png")).toBe(true));
        rerender(
            <MarkdownPreview content="![pic](on-time.png)" fileName="test.md" fileSize={20} onEditClick={() => {}} filePath="/notes/doc.md" />,
        );
        await waitFor(() => expect(held.has("on-time.png")).toBe(true));

        held.get("on-time.png")!(); // becomes blob:1
        await waitFor(() => expect(container.querySelector("img")?.getAttribute("src")).toBe("blob:1"));
        held.get("late-first.png")!(); // becomes blob:2, and must not be shown
        await waitFor(() => expect(created).toHaveBeenCalledTimes(2));

        expect(container.querySelector("img")?.getAttribute("src")).toBe("blob:1");
    });
});

// Slugs used to be ASCII-only, so every CJK or Cyrillic heading became
// "section", "section-1"... The outline extractor names headings with the same
// slugger, so its ids must be exactly the ids the preview put in the DOM.
describe("heading ids", () => {
    it("slugs non-Latin headings and agrees with the outline's ids", async () => {
        const md = "# 見出し\n\n# Привет мир\n\n## Setup\n\n## Setup\n\n# Intro {#setup}\n\n```\n# not a heading\n```";
        const { container } = renderPreview(md);
        const ids = await waitFor(() => {
            const hs = Array.from(container.querySelectorAll("h1, h2"));
            expect(hs.length).toBe(5);
            return hs.map((h) => h.id);
        });
        expect(ids).toEqual(["見出し", "привет-мир", "setup", "setup-1", "setup-2"]);
        expect(extractHeadings(md).map((h) => h.id)).toEqual(ids);
    });
});

describe("wikilinks", () => {
    it("renders [[links]] in prose but leaves code untouched", async () => {
        const { container } = renderPreview("See [[Note]].\n\n```js\nconst x = [[1, 2]];\n```\n\nand `[[inline]]`");
        await waitFor(() => expect(container.querySelector("a[title='Wikilink: Note']")).toBeTruthy());
        expect(container.querySelector("pre")!.textContent).toContain("const x = [[1, 2]];");
        expect(container.querySelector("p:last-of-type code")!.textContent).toBe("[[inline]]");
        expect(container.querySelectorAll("a[title^='Wikilink']").length).toBe(1);
    });
});

// The webview is the app window: a link the browser follows replaces Dumont,
// unsaved document and all. Only http(s)/mailto/anchors/wikilinks/.md links
// used to be prevented, so `[spec](spec.pdf)` navigated the app away.
describe("links never navigate the app window", () => {
    const click = (el: Element, init: MouseEventInit = {}) => {
        const ev = new MouseEvent("click", { bubbles: true, cancelable: true, ...init });
        el.dispatchEvent(ev);
        return ev;
    };
    const auxClick = (el: Element) => {
        const ev = new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 });
        el.dispatchEvent(ev);
        return ev;
    };
    const firstLink = async (container: HTMLElement) =>
        waitFor(() => {
            const a = container.querySelector("a");
            expect(a).toBeTruthy();
            return a!;
        });

    it("reveals a relative file next to the document instead of following it", async () => {
        vi.mocked(revealItemInDir).mockClear();
        const { container } = renderPreview("[spec](docs/spec%20v2.pdf#page=3)", { filePath: "/notes/doc.md" });
        const a = await firstLink(container);
        expect(a.getAttribute("href")).toBe("docs/spec%20v2.pdf#page=3"); // exports keep the link
        expect(click(a).defaultPrevented).toBe(true);
        expect(auxClick(a).defaultPrevented).toBe(true);
        expect(revealItemInDir).toHaveBeenCalledWith("/notes/docs/spec v2.pdf");
    });

    it("explains instead of navigating when the document has no folder yet", async () => {
        const onNotify = vi.fn();
        vi.mocked(revealItemInDir).mockClear();
        const { container } = renderPreview("[pic](pic.png)", { onNotify });
        const a = await firstLink(container);
        expect(click(a).defaultPrevented).toBe(true);
        expect(revealItemInDir).not.toHaveBeenCalled();
        expect(onNotify).toHaveBeenCalledWith(expect.stringMatching(/save the document/i), "info");
    });

    it("says so when the linked file does not exist", async () => {
        const onNotify = vi.fn();
        vi.mocked(revealItemInDir).mockRejectedValueOnce(new Error("not found"));
        const { container } = renderPreview("[gone](gone.zip)", { filePath: "C:\\notes\\doc.md", onNotify });
        click(await firstLink(container));
        await waitFor(() => expect(onNotify).toHaveBeenCalledWith('Could not find "gone.zip"', "error"));
    });

    it("prevents a relative .md link even without in-app navigation", async () => {
        const { container } = renderPreview("[other](other.md)", { filePath: "/notes/doc.md" });
        expect(click(await firstLink(container)).defaultPrevented).toBe(true);
    });

    it("blocks raw-HTML links with other schemes", async () => {
        const { container } = renderPreview('<a href="file:///etc/passwd">f</a> <a href="//evil.example/">e</a>', { filePath: "/n/d.md" });
        await waitFor(() => expect(container.querySelectorAll("a").length).toBe(2));
        for (const a of Array.from(container.querySelectorAll("a"))) {
            expect(click(a).defaultPrevented).toBe(true);
            expect(auxClick(a).defaultPrevented).toBe(true);
            expect(a.getAttribute("href") ?? "").not.toMatch(/^(file:|\/\/)/);
        }
    });

    it("opens external links with the OS, on middle-click too", async () => {
        vi.mocked(openUrl).mockClear();
        const { container } = renderPreview("[site](https://example.com)");
        const a = await firstLink(container);
        expect(click(a).defaultPrevented).toBe(true);
        expect(auxClick(a).defaultPrevented).toBe(true);
        expect(openUrl).toHaveBeenCalledTimes(2);
    });

    it("blocks middle-click on wikilinks and anchors", async () => {
        const { container } = renderPreview("[[Note]] and [top](#top)");
        await waitFor(() => expect(container.querySelectorAll("a").length).toBe(2));
        for (const a of Array.from(container.querySelectorAll("a"))) {
            expect(auxClick(a).defaultPrevented).toBe(true);
        }
    });

    it("does not leak react-markdown's node prop onto DOM elements", async () => {
        const { container } = renderPreview("# H\n\n[a](https://x.y) ![i](https://x.y/i.png)\n\n```\ncode\n```\n\n- [ ] task\n\n| a |\n|---|\n| b |");
        await waitFor(() => expect(container.querySelector("pre")).toBeTruthy());
        expect(container.querySelector("[node]")).toBeNull();
    });
});

describe("image sources", () => {
    const PNG = "data:image/png;base64,iVBORw0KGgo=";

    it("shows a raster data: image, even in an untitled buffer", async () => {
        const { container } = renderPreview(`![dot](${PNG})`);
        await waitFor(() => expect(container.querySelector("img")?.getAttribute("src")).toBe(PNG));
    });

    it("never displays an SVG or non-image data: URL", async () => {
        const { container } = renderPreview(
            "![svg](data:image/svg+xml;base64,PHN2Zz4=)\n\n<img src=\"data:text/html,<b>x</b>\">",
            { filePath: "/notes/doc.md" },
        );
        await waitFor(() => expect(container.textContent).toContain("Failed to load image"));
        expect(container.querySelector("img")).toBeNull();
        expect(container.innerHTML).not.toMatch(/data:(image\/svg|text\/html)/);
    });

    it("shows the error card, not an endless skeleton, when a relative image cannot resolve", async () => {
        const { container } = renderPreview("![local](pic.png)"); // no filePath: unsaved buffer
        await waitFor(() => expect(container.textContent).toContain("Failed to load image: pic.png"));
        expect(container.querySelector(".animate-pulse")).toBeNull();
    });

    // A <div> inside a <p> is invalid HTML: React warns, and a parser reading an
    // export closes the paragraph early.
    it("renders its placeholders as spans inside the paragraph", async () => {
        vi.mocked(invoke).mockImplementation((() => new Promise(() => {})) as typeof invoke);
        const { container } = renderPreview("text ![a](never.png) and ![b](../escape.png)", { filePath: "/notes/doc.md" });
        await waitFor(() => {
            expect(container.querySelector("p .animate-pulse")).toBeTruthy();
            expect(container.querySelector("p")!.textContent).toContain("Failed to load image");
        });
        expect(container.querySelector("p div")).toBeNull();
        vi.mocked(invoke).mockImplementation((async () => null) as typeof invoke);
    });
});

describe("local image refresh", () => {
    it("re-reads an image changed on disk when the window regains focus, without a skeleton flash", async () => {
        let mtime = 100;
        const reads: string[] = [];
        let holdReads = false;
        let release = () => {};
        vi.mocked(invoke).mockImplementation(((cmd: string, args: { relPath?: string; path?: string }) => {
            if (cmd === "get_file_info") return Promise.resolve({ modified: mtime });
            if (cmd === "read_image_file") {
                reads.push(args.relPath!);
                if (!holdReads) return Promise.resolve(new ArrayBuffer(4));
                return new Promise<unknown>((resolve) => { release = () => resolve(new ArrayBuffer(4)); });
            }
            return Promise.resolve(null);
        }) as typeof invoke);
        let made = 0;
        const revoked: string[] = [];
        Object.assign(URL, {
            createObjectURL: vi.fn(() => `blob:r${++made}`),
            revokeObjectURL: vi.fn((u: string) => revoked.push(u)),
        });

        const { container } = renderPreview("![a](refresh-me.png) ![b](refresh-me.png)", { filePath: "/focus/doc.md" });
        await waitFor(() => {
            const srcs = Array.from(container.querySelectorAll("img")).map((i) => i.getAttribute("src"));
            expect(srcs).toEqual(["blob:r1", "blob:r1"]);
        });
        expect(reads).toEqual(["refresh-me.png"]); // two references, one read

        // Focus without a change: no re-read.
        window.dispatchEvent(new Event("focus"));
        await new Promise((r) => setTimeout(r, 20));
        expect(reads.length).toBe(1);

        mtime = 200;
        holdReads = true;
        window.dispatchEvent(new Event("focus"));
        await waitFor(() => expect(reads.length).toBe(2));
        // The old picture stays up while the new one loads.
        expect(container.querySelector(".animate-pulse")).toBeNull();
        expect(container.querySelector("img")?.getAttribute("src")).toBe("blob:r1");
        release();
        await waitFor(() => {
            const srcs = Array.from(container.querySelectorAll("img")).map((i) => i.getAttribute("src"));
            expect(srcs).toEqual(["blob:r2", "blob:r2"]);
        });
        expect(reads.length).toBe(2);
        expect(revoked).toEqual(["blob:r1"]);
        vi.mocked(invoke).mockImplementation((async () => null) as typeof invoke);
    });
});
