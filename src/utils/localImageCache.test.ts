import { describe, expect, it, vi } from "vitest";
import { createLocalImageCache, joinImagePath } from "./localImageCache";

function setup(initialMtime: number | null = 100) {
    let mtime = initialMtime;
    let n = 0;
    const deps = {
        stat: vi.fn(async (_path: string) => mtime),
        read: vi.fn(async (_baseDir: string, _relPath: string) => new ArrayBuffer(4)),
        createUrl: vi.fn((_blob: Blob) => `blob:${++n}`),
        revokeUrl: vi.fn((_url: string) => {}),
    };
    const get = createLocalImageCache({ ...deps, cap: 2 });
    return { get, deps, setMtime: (m: number | null) => { mtime = m; } };
}

describe("createLocalImageCache", () => {
    it("serves repeat lookups of an unchanged file from memory", async () => {
        const { get, deps } = setup();
        expect(await get("/docs", "a.png", "image/png")).toBe("blob:1");
        expect(await get("/docs", "a.png", "image/png")).toBe("blob:1");
        expect(deps.read).toHaveBeenCalledTimes(1);
        expect(deps.stat).toHaveBeenCalledWith("/docs/a.png");
    });

    it("re-reads an image rewritten on disk and revokes the stale URL", async () => {
        const { get, deps, setMtime } = setup();
        await get("/docs", "a.png", "image/png");
        setMtime(200);
        expect(await get("/docs", "a.png", "image/png")).toBe("blob:2");
        expect(deps.read).toHaveBeenCalledTimes(2);
        expect(deps.revokeUrl).toHaveBeenCalledWith("blob:1");
    });

    it("keeps the cached copy when the file can't be stat'ed", async () => {
        const { get, deps, setMtime } = setup();
        await get("/docs", "a.png", "image/png");
        setMtime(null);
        expect(await get("/docs", "a.png", "image/png")).toBe("blob:1");
        expect(deps.read).toHaveBeenCalledTimes(1);
    });

    it("evicts and revokes the least recently used entry past the cap", async () => {
        const { get, deps } = setup();
        await get("/d", "a.png", "image/png");
        await get("/d", "b.png", "image/png");
        await get("/d", "a.png", "image/png"); // a is now the most recent
        await get("/d", "c.png", "image/png");
        expect(deps.revokeUrl).toHaveBeenCalledTimes(1);
        expect(deps.revokeUrl).toHaveBeenCalledWith("blob:2"); // b evicted
    });

    it("keys by folder too, so two documents' a.png never share a URL", async () => {
        const { get } = setup();
        expect(await get("/one", "a.png", "image/png")).toBe("blob:1");
        expect(await get("/two", "a.png", "image/png")).toBe("blob:2");
    });

    it("shares one lookup between concurrent references to the same image", async () => {
        const { get, deps, setMtime } = setup();
        const first = await Promise.all([1, 2, 3].map(() => get("/docs", "a.png", "image/png")));
        expect(first).toEqual(["blob:1", "blob:1", "blob:1"]);
        expect(deps.stat).toHaveBeenCalledTimes(1);
        expect(deps.read).toHaveBeenCalledTimes(1);

        setMtime(200); // rewritten on disk, then every reference re-checks on focus
        const second = await Promise.all([1, 2, 3].map(() => get("/docs", "a.png", "image/png")));
        expect(second).toEqual(["blob:2", "blob:2", "blob:2"]);
        expect(deps.read).toHaveBeenCalledTimes(2);
        expect(deps.createUrl).toHaveBeenCalledTimes(2);
        // Exactly the one stale URL is revoked; nothing is leaked.
        expect(deps.revokeUrl).toHaveBeenCalledTimes(1);
        expect(deps.revokeUrl).toHaveBeenCalledWith("blob:1");
    });

    it("lets a failed lookup be retried", async () => {
        const { get, deps } = setup();
        deps.read.mockRejectedValueOnce(new Error("locked"));
        await expect(get("/docs", "a.png", "image/png")).rejects.toThrow("locked");
        expect(await get("/docs", "a.png", "image/png")).toBe("blob:1");
    });

    it("joins folder and relative path for the stat call", () => {
        expect(joinImagePath("/docs/", "img/a.png")).toBe("/docs/img/a.png");
        expect(joinImagePath("C:\\docs", "a.png")).toBe("C:\\docs/a.png");
    });
});
