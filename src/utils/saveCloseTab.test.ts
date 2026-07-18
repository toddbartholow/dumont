import { describe, it, expect, vi } from "vitest";
import { saveThenClose, type SaveCloseIO } from "./saveCloseTab";

const io = (over: Partial<SaveCloseIO> = {}): SaveCloseIO => ({
    pickPath: vi.fn(async () => "/picked.md"),
    save: vi.fn(async () => 123),
    onError: vi.fn(),
    ...over,
});

const saved = { filePath: "/a.md", fileName: "a.md", content: "body" };
const untitled = { filePath: null, fileName: "Untitled.md", content: "body" };

/**
 * One guarantee: THE TAB SURVIVES UNLESS ITS CONTENTS REACHED THE DISK.
 *
 * This was two bare `return` statements inside an async callback in App, and those two
 * returns were the only thing between a cancelled file picker and a destroyed buffer. Turn
 * either into a fallthrough and every other test in the project still passes while the user's
 * work is deleted. That is the definition of an untested guarantee.
 */
describe("saveThenClose", () => {
    it("writes a tab that already has a path, and then it is safe to close", async () => {
        const deps = io();

        const out = await saveThenClose(saved, deps);

        expect(deps.save).toHaveBeenCalledWith("/a.md", "body");
        expect(deps.pickPath).not.toHaveBeenCalled(); // it has a home already
        expect(out).toEqual({ action: "close", path: "/a.md" });
    });

    it("asks where to put an unsaved buffer, then writes it there", async () => {
        const deps = io({ pickPath: vi.fn(async () => "/chosen.md") });

        const out = await saveThenClose(untitled, deps);

        expect(deps.pickPath).toHaveBeenCalledWith("Untitled.md");
        expect(deps.save).toHaveBeenCalledWith("/chosen.md", "body");
        expect(out).toEqual({ action: "close", path: "/chosen.md" });
    });

    /**
     * The user hit Escape on the file picker. They did not say "discard", they said "not now",
     * and those are different answers. Closing the tab here treats the second as the first and
     * the buffer is gone with no further dialog.
     */
    it("KEEPS THE TAB when the user cancels the save dialog, and writes nothing", async () => {
        const deps = io({ pickPath: vi.fn(async () => null) });

        const out = await saveThenClose(untitled, deps);

        expect(out).toEqual({ action: "keep-open", reason: "cancelled" });
        expect(deps.save).not.toHaveBeenCalled();
        expect(deps.onError).not.toHaveBeenCalled(); // cancelling is not an error
    });

    /**
     * A full disk, a read-only volume, a file locked by something else. The content is still
     * only in memory, and memory is exactly what closing the tab throws away.
     */
    it("KEEPS THE TAB when the write fails, and says why", async () => {
        const deps = io({
            save: vi.fn(async () => {
                throw new Error("No space left on device");
            }),
        });

        const out = await saveThenClose(saved, deps);

        expect(out).toEqual({ action: "keep-open", reason: "save-failed" });
        expect(deps.onError).toHaveBeenCalledWith("No space left on device");
    });

    it("keeps the tab when the write fails AFTER the user chose a location", async () => {
        const deps = io({
            pickPath: vi.fn(async () => "/chosen.md"),
            save: vi.fn(async () => {
                throw new Error("Permission denied");
            }),
        });

        const out = await saveThenClose(untitled, deps);

        expect(out).toEqual({ action: "keep-open", reason: "save-failed" });
    });

    it("reports a non-Error rejection rather than swallowing it", async () => {
        const deps = io({ save: vi.fn(async () => Promise.reject("disk on fire")) });

        const out = await saveThenClose(saved, deps);

        expect(out.action).toBe("keep-open");
        expect(deps.onError).toHaveBeenCalledWith("disk on fire");
    });

    /**
     * The property, stated once over every failure mode there is: if the bytes did not reach
     * the disk, the tab does not close. A future edit that adds a new way to fail has to keep
     * this true.
     */
    it("never says close unless save() actually resolved", async () => {
        const failures: Array<Partial<SaveCloseIO>> = [
            { pickPath: vi.fn(async () => null) },
            { save: vi.fn(async () => { throw new Error("x"); }) },
            { pickPath: vi.fn(async () => ""), }, // an empty path is not a path
        ];

        for (const f of failures) {
            const out = await saveThenClose(untitled, io(f));
            expect(out.action, JSON.stringify(Object.keys(f))).toBe("keep-open");
        }
    });
});
