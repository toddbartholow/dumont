import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { renderHook } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { useAutosave, type UseAutosaveOptions } from "./useAutosave";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const base = (over: Partial<UseAutosaveOptions> = {}): UseAutosaveOptions => ({
  enabled: true,
  filePath: "C:/doc.md",
  content: "new",
  originalContent: "old",
  isReviewActive: false,
  onSaved: vi.fn(),
  onError: vi.fn(),
  ...over,
});

/** How many times the document has been written (history snapshots also go through invoke). */
const saves = () => (invoke as Mock).mock.calls.filter(([cmd]) => cmd === "save_file").length;

describe("useAutosave", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    (invoke as Mock).mockReset().mockResolvedValue(1700000000000);
  });
  afterEach(() => vi.useRealTimers());

  it("does not save when disabled", async () => {
    renderHook((p: UseAutosaveOptions) => useAutosave(p), { initialProps: base({ enabled: false }) });
    await vi.advanceTimersByTimeAsync(2000);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("does not save an Untitled buffer (no path)", async () => {
    renderHook((p: UseAutosaveOptions) => useAutosave(p), { initialProps: base({ filePath: null }) });
    await vi.advanceTimersByTimeAsync(2000);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("does not save when the buffer is clean", async () => {
    renderHook((p: UseAutosaveOptions) => useAutosave(p), { initialProps: base({ content: "x", originalContent: "x" }) });
    await vi.advanceTimersByTimeAsync(2000);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("does NOT save while an AI review is pending, even when dirty (AI-01)", async () => {
    const onSaved = vi.fn();
    renderHook((p: UseAutosaveOptions) => useAutosave(p), {
      initialProps: base({ isReviewActive: true, onSaved }),
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(invoke).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("saves after the debounce and reports the new mtime, saved content and tab", async () => {
    const onSaved = vi.fn();
    renderHook((p: UseAutosaveOptions) => useAutosave(p), { initialProps: base({ onSaved, documentId: "tab-1" }) });

    // Nothing before the debounce elapses.
    await vi.advanceTimersByTimeAsync(1000);
    expect(invoke).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(600);
    expect(invoke).toHaveBeenCalledWith("save_file", { path: "C:/doc.md", content: "new" });
    // The tab comes back with the result: by now the user may be looking at another one.
    expect(onSaved).toHaveBeenCalledWith(1700000000000, "new", "tab-1");
  });

  it("coalesces rapid edits — only the latest content is written", async () => {
    const onSaved = vi.fn();
    const { rerender } = renderHook((p: UseAutosaveOptions) => useAutosave(p), {
      initialProps: base({ content: "a", onSaved }),
    });
    await vi.advanceTimersByTimeAsync(1000); // not yet
    rerender(base({ content: "ab", onSaved }));
    await vi.advanceTimersByTimeAsync(1000); // resets, still not yet
    rerender(base({ content: "abc", onSaved }));
    await vi.advanceTimersByTimeAsync(1600);

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("save_file", { path: "C:/doc.md", content: "abc" });
  });

  it("throttles repeated failures to onError", async () => {
    (invoke as Mock).mockRejectedValue("Disk full");
    const onError = vi.fn();
    const { rerender } = renderHook((p: UseAutosaveOptions) => useAutosave(p), {
      initialProps: base({ content: "a", onError }),
    });
    await vi.advanceTimersByTimeAsync(1600);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith("Disk full");

    // A second failure shortly after stays silent (30s throttle window).
    rerender(base({ content: "b", onError }));
    await vi.advanceTimersByTimeAsync(1600);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  // EXT-03: an autosave is the one write the user never chose, so it checks the disk first.
  it("passes the known mtime, so the write is refused if the file moved on disk", async () => {
    renderHook((p: UseAutosaveOptions) => useAutosave(p), { initialProps: base({ getKnownMtime: () => 42 }) });
    await vi.advanceTimersByTimeAsync(1600);
    expect(invoke).toHaveBeenCalledWith("save_file", { path: "C:/doc.md", content: "new", expectedMtime: 42 });
  });

  it("reports a refused write as a conflict, not an error", async () => {
    (invoke as Mock).mockRejectedValue("File changed on disk: C:/doc.md");
    const onError = vi.fn();
    const onConflict = vi.fn();
    renderHook((p: UseAutosaveOptions) => useAutosave(p), {
      initialProps: base({ getKnownMtime: () => 42, documentId: "tab-1", onError, onConflict }),
    });
    await vi.advanceTimersByTimeAsync(1600);
    expect(onConflict).toHaveBeenCalledWith("tab-1");
    expect(onError).not.toHaveBeenCalled();
  });

  it("does not save a conflicted document, even when dirty", async () => {
    renderHook((p: UseAutosaveOptions) => useAutosave(p), { initialProps: base({ isConflicted: true }) });
    await vi.advanceTimersByTimeAsync(5000);
    expect(invoke).not.toHaveBeenCalled();
  });

  // SAVE-03: the effect re-runs only when the text changes, so a failed write used to stay
  // failed until the user typed again.
  it("retries a failed write without waiting for more typing, and backs off", async () => {
    (invoke as Mock).mockRejectedValueOnce("Disk full").mockRejectedValueOnce("Disk full");
    const onSaved = vi.fn();
    const onError = vi.fn();
    renderHook((p: UseAutosaveOptions) => useAutosave(p), { initialProps: base({ onSaved, onError }) });

    await vi.advanceTimersByTimeAsync(1600); // first attempt fails
    expect(saves()).toBe(1);
    await vi.advanceTimersByTimeAsync(1000); // inside the 2 s backoff
    expect(saves()).toBe(1);
    await vi.advanceTimersByTimeAsync(3000); // retry 1 fails
    expect(saves()).toBe(2);
    await vi.advanceTimersByTimeAsync(1000); // inside the 4 s backoff
    expect(saves()).toBe(2);
    await vi.advanceTimersByTimeAsync(5000); // retry 2 lands
    expect(saves()).toBe(3);
    expect(onSaved).toHaveBeenCalledTimes(1);
    // Three failures' worth of trouble, told once.
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("does not let typing hurry a write past its backoff", async () => {
    (invoke as Mock).mockRejectedValueOnce("Disk full");
    const { rerender } = renderHook((p: UseAutosaveOptions) => useAutosave(p), {
      initialProps: base({ content: "a" }),
    });
    await vi.advanceTimersByTimeAsync(1600); // fails; retry due 2 s later
    rerender(base({ content: "ab" }));
    await vi.advanceTimersByTimeAsync(1550); // the new debounce has passed, the backoff has not
    expect(saves()).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(saves()).toBe(2);
    expect(invoke).toHaveBeenLastCalledWith("save_file", { path: "C:/doc.md", content: "ab" });
  });
});
