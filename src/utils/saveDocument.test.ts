import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { saveDocument } from "./saveDocument";
import { setHistoryConfig, HISTORY_CHANGED_EVENT } from "./history";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const mockInvoke = invoke as Mock;

/** Let the fire-and-forget snapshot promise settle. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("saveDocument", () => {
  beforeEach(() => {
    mockInvoke.mockReset().mockResolvedValue(1700000000000);
    setHistoryConfig({ enabled: true, limit: 50, intervalSecs: 60 });
  });

  it("writes the file and returns the new mtime", async () => {
    const mtime = await saveDocument("/notes/a.md", "hello");
    expect(mockInvoke).toHaveBeenCalledWith("save_file", { path: "/notes/a.md", content: "hello" });
    expect(mtime).toBe(1700000000000);
  });

  it("records a snapshot, passing the user's limits through to Rust", async () => {
    setHistoryConfig({ enabled: true, limit: 25, intervalSecs: 120 });
    await saveDocument("/notes/a.md", "hello");
    await flush();

    expect(mockInvoke).toHaveBeenCalledWith("snapshot_file", {
      path: "/notes/a.md",
      content: "hello",
      maxSnapshots: 25,
      minIntervalSecs: 120,
    });
  });

  it("announces the change so an open history panel refreshes", async () => {
    const heard = vi.fn();
    window.addEventListener(HISTORY_CHANGED_EVENT, heard);
    await saveDocument("/notes/a.md", "hello");
    await flush();
    window.removeEventListener(HISTORY_CHANGED_EVENT, heard);

    expect(heard).toHaveBeenCalledTimes(1);
  });

  it("takes no snapshot when history is off", async () => {
    setHistoryConfig({ enabled: false, limit: 50, intervalSecs: 60 });
    await saveDocument("/notes/a.md", "hello");
    await flush();

    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockInvoke).toHaveBeenCalledWith("save_file", { path: "/notes/a.md", content: "hello" });
  });

  /**
   * The guarantee the whole design rests on. History is a service to the document,
   * and a service that can take the document down with it is worse than none: a
   * full disk in the history store must not turn a save that WORKED into an error
   * toast telling the user their file did not save.
   */
  it("still resolves when the snapshot fails, and never rethrows", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "snapshot_file") throw new Error("history store is unwritable");
      return 1700000000000;
    });

    await expect(saveDocument("/notes/a.md", "hello")).resolves.toBe(1700000000000);
    await flush(); // an unhandled rejection here would fail the suite
  });

  it("does not wait for the snapshot before returning", async () => {
    let releaseSnapshot: (() => void) | undefined;
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "snapshot_file") {
        await new Promise<void>((resolve) => { releaseSnapshot = resolve; });
        return null;
      }
      return 1700000000000;
    });

    // Resolves with the snapshot still in flight. Ctrl+S must not pay for it.
    await expect(saveDocument("/notes/a.md", "hello")).resolves.toBe(1700000000000);
    releaseSnapshot?.();
  });

  /** A failed WRITE is still a real failure and has to reach the caller. */
  it("rejects when the file itself cannot be written", async () => {
    mockInvoke.mockRejectedValue("Document is 60 MB; maximum is 50 MB");
    await expect(saveDocument("/notes/a.md", "hello")).rejects.toBe(
      "Document is 60 MB; maximum is 50 MB",
    );
  });
});
