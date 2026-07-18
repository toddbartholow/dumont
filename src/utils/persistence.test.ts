import { describe, it, expect, beforeEach, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
    getRecentFiles, addRecentFile, removeRecentFile, clearRecentFiles,
    getSplitRatio, setSplitRatio,
    setAIKey, aiKeyPresent, initAIKey,
    getSession, setSession,
} from "./persistence";

// persistence reaches the keychain through Tauri commands, dynamically imported.
// Stub invoke so the key path can be exercised without a real backend.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const mockInvoke = vi.mocked(invoke);

beforeEach(() => {
    localStorage.clear();
    mockInvoke.mockReset();
});

describe("recent files", () => {
    it("adds most-recent first and de-duplicates by path", () => {
        addRecentFile("/a.md", "a");
        addRecentFile("/b.md", "b");
        addRecentFile("/a.md", "a"); // re-open a -> moves to front
        const list = getRecentFiles();
        expect(list.map((f) => f.path)).toEqual(["/a.md", "/b.md"]);
    });

    it("caps the list at 25 entries", () => {
        for (let i = 0; i < 30; i++) addRecentFile(`/f${i}.md`, `f${i}`);
        expect(getRecentFiles()).toHaveLength(25);
    });

    it("removes and clears", () => {
        addRecentFile("/a.md", "a");
        addRecentFile("/b.md", "b");
        removeRecentFile("/a.md");
        expect(getRecentFiles().map((f) => f.path)).toEqual(["/b.md"]);
        clearRecentFiles();
        expect(getRecentFiles()).toEqual([]);
    });
});

describe("split ratio", () => {
    it("defaults to 0.5", () => {
        expect(getSplitRatio()).toBe(0.5);
    });
    it("persists a valid value and rejects out-of-range", () => {
        setSplitRatio(0.3);
        expect(getSplitRatio()).toBe(0.3);
        setSplitRatio(0.99); // out of (0.15, 0.85) -> falls back to 0.5
        expect(getSplitRatio()).toBe(0.5);
    });
});

describe("the AI key", () => {
    // The key is keychain-backed and WRITE-ONLY from the webview (SECURITY-01):
    // Rust reads it directly, so there is no getAIKey() and nothing here ever
    // returns the value. setAIKey writes through the keychain; aiKeyPresent() only
    // reports whether one is saved.

    it("writes the key through set_ai_key and never stores it in localStorage", async () => {
        mockInvoke.mockResolvedValue(undefined);
        setAIKey("secret");
        await vi.waitFor(() =>
            expect(mockInvoke).toHaveBeenCalledWith("set_ai_key", { key: "secret" }),
        );
        // No plaintext copy is left behind anywhere in localStorage.
        expect(localStorage.getItem("dumont:aiApiKey")).toBeNull();
    });

    it("clears the stored key when given an empty string", async () => {
        mockInvoke.mockResolvedValue(undefined);
        setAIKey("");
        await vi.waitFor(() =>
            expect(mockInvoke).toHaveBeenCalledWith("set_ai_key", { key: "" }),
        );
    });

    it("reports whether a key is saved via ai_key_present, without revealing it", async () => {
        mockInvoke.mockResolvedValue(true);
        await expect(aiKeyPresent()).resolves.toBe(true);
        expect(mockInvoke).toHaveBeenCalledWith("ai_key_present");
    });

    it("reports absence safely when the keychain check throws, so the UI degrades", async () => {
        mockInvoke.mockRejectedValue("no keychain");
        await expect(aiKeyPresent()).resolves.toBe(false);
    });

    it("migrates a legacy plaintext key into the keychain, then deletes it", async () => {
        localStorage.setItem("dumont:aiApiKey", JSON.stringify("legacy-key"));
        mockInvoke.mockResolvedValue(undefined);
        await initAIKey();
        expect(mockInvoke).toHaveBeenCalledWith("set_ai_key", { key: "legacy-key" });
        expect(localStorage.getItem("dumont:aiApiKey")).toBeNull();
    });

    it("does nothing when there is no legacy key to migrate", async () => {
        await initAIKey();
        expect(mockInvoke).not.toHaveBeenCalled();
    });

    // The endpoint and the model are NOT here any more. They are settings, and
    // live in settings.json; see src/settings/. A credential does not.
});

/**
 * The session is every tab you had open. A regression here does not throw, it just quietly
 * hands back `null` and the app opens on the welcome screen with your work nowhere in sight.
 *
 * It has real defensive logic, and defensive logic is exactly the kind that rots unnoticed:
 * it only runs against input nobody produces on purpose. None of it was tested.
 */
describe("the session", () => {
    const tabs = [{ path: "/a.md", cursorLine: 3 }, { path: "/b.md" }, { path: "/c.md" }];

    it("round-trips the open tabs and which one was active", () => {
        setSession({ tabs, activeIndex: 1 });

        expect(getSession()).toEqual({ tabs, activeIndex: 1 });
    });

    it("is null when there is no session, rather than an empty one", () => {
        expect(getSession()).toBeNull();
    });

    it("is null for a session with no tabs, so the app opens on the welcome screen", () => {
        setSession({ tabs: [], activeIndex: 0 });

        expect(getSession()).toBeNull();
    });

    /**
     * The file is JSON in localStorage and a user can edit it. A single malformed entry must
     * cost them that one tab, not all of them: dropping the whole session because one path
     * came back as a number is the difference between losing a tab and losing the lot.
     */
    it("drops a malformed tab and keeps the rest", () => {
        localStorage.setItem("dumont:session", JSON.stringify({
            tabs: [{ path: "/a.md" }, { path: 42 }, null, { nope: true }, { path: "/b.md" }],
            activeIndex: 0,
        }));

        expect(getSession()).toEqual({
            tabs: [{ path: "/a.md" }, { path: "/b.md" }],
            activeIndex: 0,
        });
    });

    it("is null when `tabs` is not even a list", () => {
        localStorage.setItem("dumont:session", JSON.stringify({ tabs: "/a.md", activeIndex: 0 }));

        expect(getSession()).toBeNull();
    });

    /**
     * activeIndex is an index into a list that the filter above may just have shortened. Left
     * unclamped it points past the end, and the restore opens... nothing.
     */
    it("clamps activeIndex into the surviving tabs", () => {
        localStorage.setItem("dumont:session", JSON.stringify({
            tabs: [{ path: "/a.md" }, { path: "/b.md" }],
            activeIndex: 99,
        }));

        expect(getSession()?.activeIndex).toBe(1);
    });

    it("clamps a negative activeIndex to the first tab", () => {
        localStorage.setItem("dumont:session", JSON.stringify({ tabs, activeIndex: -5 }));

        expect(getSession()?.activeIndex).toBe(0);
    });

    it("falls back to the first tab when activeIndex is not a whole number", () => {
        for (const bad of [1.5, "1", null, undefined, NaN]) {
            localStorage.setItem("dumont:session", JSON.stringify({ tabs, activeIndex: bad }));
            expect(getSession()?.activeIndex, `activeIndex: ${String(bad)}`).toBe(0);
        }
    });

    it("survives a corrupt value without throwing, because a crash here loses everything", () => {
        localStorage.setItem("dumont:session", "{not json");

        expect(() => getSession()).not.toThrow();
        expect(getSession()).toBeNull();
    });

    it("clears with null", () => {
        setSession({ tabs, activeIndex: 0 });
        setSession(null);

        expect(getSession()).toBeNull();
    });
});
