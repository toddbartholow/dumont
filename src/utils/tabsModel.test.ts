import { describe, it, expect } from "vitest";
import {
  findTabByPath,
  isTabDirty,
  collectDirtyTabs,
  nextActiveAfterClose,
  nextUntitledName,
  findReusableUntitledTab,
  computeTabLabels,
  moveTab,
  closeTabDecision,
  resolveTab,
  backgroundTabsToAutosave,
  markTabSaved,
  externalChangeDecision,
  type LiveActiveTab,
  type TabState,
} from "./tabsModel";

const tab = (id: string, filePath: string | null, content = "x", originalContent = "x"): TabState => ({
  id, filePath, fileName: filePath?.replace(/\\/g, "/").split("/").pop() ?? "Untitled.md",
  content, originalContent, fileSize: 0, knownMtime: 0,
});

describe("isTabDirty", () => {
  it("is dirty only when content diverges from the saved original", () => {
    expect(isTabDirty({ content: "a", originalContent: "a" })).toBe(false);
    expect(isTabDirty({ content: "a", originalContent: "b" })).toBe(true);
  });
});

describe("collectDirtyTabs", () => {
  // Live buffer for the active tab, defaulting to a clean matching pair.
  const live = (over: Partial<LiveActiveTab> = {}): LiveActiveTab => ({
    filePath: "/active.md", fileName: "active.md", content: "x", originalContent: "x", ...over,
  });

  it("returns nothing when every tab is clean", () => {
    const tabs = [tab("1", "/a.md"), tab("2", "/b.md")];
    expect(collectDirtyTabs(tabs, "1", live({ filePath: "/a.md", fileName: "a.md" }))).toEqual([]);
  });

  it("flags a dirty BACKGROUND tab even when the active tab is clean (issue #88)", () => {
    const tabs = [
      tab("1", "/a.md"), // active, clean
      tab("2", "/b.md", "edited", "saved"), // background, dirty
    ];
    const dirty = collectDirtyTabs(tabs, "1", live({ filePath: "/a.md", fileName: "a.md" }));
    expect(dirty.map((t) => t.id)).toEqual(["2"]);
    expect(dirty[0]).toMatchObject({ filePath: "/b.md", fileName: "b.md", content: "edited" });
  });

  it("uses the LIVE buffer for the active tab, not its stale snapshot", () => {
    // The active tab's stored snapshot still reads clean, but the live editor
    // buffer has unsaved edits — the live values must win.
    const tabs = [tab("1", "/a.md", "x", "x")];
    const dirty = collectDirtyTabs(tabs, "1", live({ filePath: "/a.md", fileName: "a.md", content: "typed", originalContent: "x" }));
    expect(dirty.map((t) => t.id)).toEqual(["1"]);
    expect(dirty[0].content).toBe("typed");
  });

  it("treats the active tab as clean via live values even if its snapshot looks dirty", () => {
    // Snapshot diverges (lags behind the last save) but the live buffer is clean.
    const tabs = [tab("1", "/a.md", "stale", "saved")];
    expect(collectDirtyTabs(tabs, "1", live({ filePath: "/a.md", fileName: "a.md", content: "same", originalContent: "same" }))).toEqual([]);
  });

  it("names an unsaved active Untitled buffer 'Untitled.md'", () => {
    const untitled: TabState = {
      id: "1", filePath: null, fileName: "Untitled-1.md",
      content: "hi", originalContent: "", fileSize: 0, knownMtime: 0,
    };
    const dirty = collectDirtyTabs([untitled], "1", live({ filePath: null, fileName: null, content: "hi", originalContent: "" }));
    expect(dirty[0]).toMatchObject({ filePath: null, fileName: "Untitled.md", content: "hi" });
  });

  it("collects every dirty tab across active and background", () => {
    const tabs = [
      tab("1", "/a.md", "x", "x"), // active, dirty via live below
      tab("2", "/b.md", "edited", "saved"), // background, dirty
      tab("3", "/c.md"), // background, clean
    ];
    const dirty = collectDirtyTabs(tabs, "1", live({ filePath: "/a.md", fileName: "a.md", content: "typed", originalContent: "x" }));
    expect(dirty.map((t) => t.id)).toEqual(["1", "2"]);
  });
});

describe("findTabByPath", () => {
  const tabs = [tab("1", "/a.md"), tab("2", "/b.md"), tab("3", null)];
  it("finds by path", () => {
    expect(findTabByPath(tabs, "/b.md")?.id).toBe("2");
  });
  it("never matches a null path (multiple Untitled buffers are distinct)", () => {
    expect(findTabByPath(tabs, null)).toBeUndefined();
  });
  it("returns undefined when not open", () => {
    expect(findTabByPath(tabs, "/missing.md")).toBeUndefined();
  });
});

describe("nextActiveAfterClose", () => {
  const tabs = [tab("1", "/a.md"), tab("2", "/b.md"), tab("3", "/c.md")];

  it("focuses the tab to the right of the closed one", () => {
    expect(nextActiveAfterClose(tabs, "2")).toBe("3");
  });
  it("focuses the left neighbour when closing the last tab", () => {
    expect(nextActiveAfterClose(tabs, "3")).toBe("2");
  });
  it("focuses the new first tab when closing the first", () => {
    expect(nextActiveAfterClose(tabs, "1")).toBe("2");
  });
  it("returns null when closing the only tab", () => {
    expect(nextActiveAfterClose([tab("1", "/a.md")], "1")).toBeNull();
  });
  it("returns null for an unknown id", () => {
    expect(nextActiveAfterClose(tabs, "nope")).toBeNull();
  });
});

describe("nextUntitledName", () => {
  const untitled = (id: string, name: string): TabState => ({
    id, filePath: null, fileName: name, content: "", originalContent: "", fileSize: 0, knownMtime: 0,
  });
  it("starts at Untitled-1.md", () => {
    expect(nextUntitledName([])).toBe("Untitled-1.md");
  });
  it("skips names already in use", () => {
    expect(nextUntitledName([untitled("1", "Untitled-1.md")])).toBe("Untitled-2.md");
  });
  it("fills the lowest gap", () => {
    expect(nextUntitledName([untitled("1", "Untitled-1.md"), untitled("3", "Untitled-3.md")])).toBe("Untitled-2.md");
  });
  it("ignores saved files with the same name", () => {
    expect(nextUntitledName([tab("1", "/x/Untitled-1.md")])).toBe("Untitled-1.md");
  });
});

describe("findReusableUntitledTab", () => {
  it("finds a pristine empty untitled buffer", () => {
    const tabs = [tab("1", "/a.md"), { ...tab("2", null), content: "", originalContent: "" }];
    expect(findReusableUntitledTab(tabs)?.id).toBe("2");
  });
  it("ignores an untitled buffer that has content", () => {
    const tabs = [{ ...tab("2", null), content: "hi", originalContent: "" }];
    expect(findReusableUntitledTab(tabs)).toBeUndefined();
  });
  it("ignores saved files", () => {
    expect(findReusableUntitledTab([tab("1", "/a.md")])).toBeUndefined();
  });
});

describe("computeTabLabels", () => {
  it("shows the bare name when unique", () => {
    const labels = computeTabLabels([{ id: "1", fileName: "a.md", filePath: "/x/a.md" }]);
    expect(labels.get("1")).toBe("a.md");
  });
  it("appends the distinguishing parent folder for duplicates", () => {
    const labels = computeTabLabels([
      { id: "1", fileName: "README.md", filePath: "/proj/docs/README.md" },
      { id: "2", fileName: "README.md", filePath: "/proj/src/README.md" },
    ]);
    expect(labels.get("1")).toBe("README.md — docs");
    expect(labels.get("2")).toBe("README.md — src");
  });
  it("walks further up when the immediate parent also collides", () => {
    const labels = computeTabLabels([
      { id: "1", fileName: "README.md", filePath: "/a/docs/README.md" },
      { id: "2", fileName: "README.md", filePath: "/b/docs/README.md" },
    ]);
    expect(labels.get("1")).toBe("README.md — a/docs");
    expect(labels.get("2")).toBe("README.md — b/docs");
  });
  it("handles Windows separators", () => {
    const labels = computeTabLabels([
      { id: "1", fileName: "note.md", filePath: "C:\\one\\note.md" },
      { id: "2", fileName: "note.md", filePath: "C:\\two\\note.md" },
    ]);
    expect(labels.get("1")).toBe("note.md — one");
    expect(labels.get("2")).toBe("note.md — two");
  });
});

describe("moveTab", () => {
  const tabs = [tab("1", "/a.md"), tab("2", "/b.md"), tab("3", "/c.md")];
  it("moves a tab to a later position", () => {
    expect(moveTab(tabs, 0, 2).map((t) => t.id)).toEqual(["2", "3", "1"]);
  });
  it("moves a tab to an earlier position", () => {
    expect(moveTab(tabs, 2, 0).map((t) => t.id)).toEqual(["3", "1", "2"]);
  });
  it("returns the same array for a no-op or out-of-range move", () => {
    expect(moveTab(tabs, 1, 1)).toBe(tabs);
    expect(moveTab(tabs, -1, 0)).toBe(tabs);
    expect(moveTab(tabs, 0, 9)).toBe(tabs);
  });
});

/**
 * The active tab's snapshot in the tabs array is STALE BY DESIGN: the live editor buffer is
 * the truth for it, and the array only catches up on the next switch. Every consumer of tab
 * data has to merge the two, and until these functions existed, ten call sites did it by
 * hand. The eleventh is the one that forgets, and what it forgets is whether the user has
 * unsaved work in the file it is about to close.
 */
describe("resolveTab", () => {
  const live = (over: Partial<LiveActiveTab> = {}): LiveActiveTab => ({
    filePath: "/a.md", fileName: "a.md", content: "live", originalContent: "live", ...over,
  });

  it("reads the ACTIVE tab from the live buffer, not from its stale snapshot", () => {
    // The snapshot says clean and says "old". The live buffer says the user has typed.
    const tabs = [tab("1", "/a.md", "old", "old"), tab("2", "/b.md")];

    const r = resolveTab(tabs, "1", "1", live({ content: "typed", originalContent: "old" }));

    expect(r).toEqual({
      id: "1",
      filePath: "/a.md",
      fileName: "a.md",
      content: "typed",
      originalContent: "old",
    });
  });

  it("reads a BACKGROUND tab from its snapshot, ignoring the live buffer entirely", () => {
    const tabs = [tab("1", "/a.md"), tab("2", "/b.md", "bg content", "bg saved")];

    const r = resolveTab(tabs, "2", "1", live({ content: "the active tab's text" }));

    expect(r?.content).toBe("bg content");
    expect(r?.originalContent).toBe("bg saved");
  });

  it("keeps the tab's own name for an unsaved buffer, which has none of its own", () => {
    const tabs = [tab("1", null)]; // Untitled: fileName comes from the tab, not the buffer

    const r = resolveTab(tabs, "1", "1", live({ filePath: null, fileName: null }));

    expect(r?.fileName).toBe("Untitled.md");
    expect(r?.filePath).toBeNull();
  });

  it("is null for a tab that is not there", () => {
    expect(resolveTab([tab("1", "/a.md")], "nope", "1", live())).toBeNull();
  });
});

/**
 * THE gate between Ctrl+W and a lost draft.
 *
 * This lived inline in App with its own hand-rolled dirty comparison, a few feet away from
 * the exported, tested `isTabDirty` that it did not call. The tested function and the running
 * function were two different functions, and only one of them had tests.
 */
describe("closeTabDecision", () => {
  const live = (over: Partial<LiveActiveTab> = {}): LiveActiveTab => ({
    filePath: "/a.md", fileName: "a.md", content: "x", originalContent: "x", ...over,
  });

  it("closes a clean tab without asking", () => {
    const tabs = [tab("1", "/a.md", "x", "x")];
    expect(closeTabDecision(tabs, "1", "1", live())).toEqual({ action: "close" });
  });

  /**
   * The one that loses work. The ACTIVE tab's snapshot still says clean, because it does not
   * catch up until the next switch. Read the snapshot and you close it silently, taking
   * everything the user has typed since the last save with it.
   */
  it("prompts for the ACTIVE tab when the LIVE buffer is dirty and its snapshot is not", () => {
    const tabs = [tab("1", "/a.md", "saved", "saved")]; // snapshot: clean

    const decision = closeTabDecision(tabs, "1", "1", live({
      content: "a paragraph the user just wrote",
      originalContent: "saved",
    }));

    expect(decision).toEqual({ action: "prompt", fileName: "a.md" });
  });

  /**
   * The mirror image. A BACKGROUND tab must be judged on its own snapshot: the live buffer
   * belongs to a different document entirely, and reading it here would either miss the
   * background tab's unsaved work or invent some it does not have.
   */
  it("prompts for a dirty BACKGROUND tab even while the active buffer is clean", () => {
    const tabs = [
      tab("1", "/a.md", "x", "x"),
      tab("2", "/b.md", "edited in the background", "saved"),
    ];

    expect(closeTabDecision(tabs, "2", "1", live())).toEqual({
      action: "prompt",
      fileName: "b.md",
    });
  });

  it("does not prompt for a clean BACKGROUND tab just because the active buffer is dirty", () => {
    const tabs = [tab("1", "/a.md"), tab("2", "/b.md", "same", "same")];

    const decision = closeTabDecision(tabs, "2", "1", live({
      content: "the ACTIVE tab is the dirty one",
      originalContent: "x",
    }));

    expect(decision).toEqual({ action: "close" });
  });

  it("names an unsaved buffer in the prompt, so the dialog can say what is at stake", () => {
    const tabs = [tab("1", null, "typed", "")];

    expect(closeTabDecision(tabs, "1", "1", live({
      filePath: null, fileName: null, content: "typed", originalContent: "",
    }))).toEqual({ action: "prompt", fileName: "Untitled.md" });
  });

  it("says so, rather than throwing, when the tab is already gone", () => {
    expect(closeTabDecision([], "1", null, live())).toEqual({ action: "gone" });
  });
});

/**
 * Autosave and external-change detection each exist TWICE in this app: once in a hook for the
 * active tab, and once again, independently, inside App for the background tabs. The hooks
 * are well tested. The background copies had no tests at all, and the tested twin lends them
 * a confidence they never earned. These are the decisions inside the untested copies.
 */
describe("backgroundTabsToAutosave", () => {
  it("saves a dirty background tab", () => {
    const tabs = [tab("1", "/a.md"), tab("2", "/b.md", "typed", "saved")];

    expect(backgroundTabsToAutosave(tabs, "1").map((t) => t.id)).toEqual(["2"]);
  });

  /**
   * The ACTIVE tab is useAutosave's job, and it must not be this one's. Its snapshot here is
   * stale by design, so judging it from this array would either miss what the user has just
   * typed or write back text they have already moved past.
   */
  it("never touches the active tab, however dirty its stale snapshot looks", () => {
    const tabs = [tab("1", "/a.md", "stale", "saved"), tab("2", "/b.md")];

    expect(backgroundTabsToAutosave(tabs, "1")).toEqual([]);
  });

  it("skips a clean background tab", () => {
    const tabs = [tab("1", "/a.md"), tab("2", "/b.md", "same", "same")];

    expect(backgroundTabsToAutosave(tabs, "1")).toEqual([]);
  });

  /** An unsaved buffer has nowhere to be written to. Autosave must not invent a path. */
  it("skips a dirty background tab that has never been saved anywhere", () => {
    const tabs = [tab("1", "/a.md"), tab("2", null, "typed", "")];

    expect(backgroundTabsToAutosave(tabs, "1")).toEqual([]);
  });
});

describe("markTabSaved", () => {
  it("marks the tab clean and records the new mtime", () => {
    const tabs = [tab("1", "/a.md", "written", "old")];

    const next = markTabSaved(tabs, "1", "written", 999);

    expect(next[0].originalContent).toBe("written");
    expect(next[0].knownMtime).toBe(999);
  });

  /**
   * THE one that loses work. The write is asynchronous, and the user can switch to a
   * background tab and type into it while its own autosave is still in flight. Marking it
   * clean on the strength of what we SET OUT to write tells the app that whatever they typed
   * in the meantime is already on disk. It is not. The edit then sits there looking saved,
   * and goes in the bin on quit, with no dialog, because the app believes there is nothing to
   * ask about.
   */
  it("refuses to mark a tab clean if its content moved while the write was in flight", () => {
    const tabs = [tab("1", "/a.md", "what the user typed DURING the save", "old")];

    const next = markTabSaved(tabs, "1", "what we actually wrote", 999);

    expect(next[0].content).toBe("what the user typed DURING the save");
    expect(next[0].originalContent).toBe("old"); // still dirty, so it will be saved again
    expect(isTabDirty(next[0])).toBe(true);
  });

  it("leaves every other tab alone", () => {
    const tabs = [tab("1", "/a.md", "x", "y"), tab("2", "/b.md", "p", "q")];

    const next = markTabSaved(tabs, "1", "x", 1);

    expect(next[1]).toEqual(tabs[1]);
  });
});

describe("externalChangeDecision", () => {
  const t = (content: string, originalContent: string, knownMtime: number) =>
    ({ content, originalContent, knownMtime });

  it("does nothing when the file has not moved", () => {
    expect(externalChangeDecision(t("x", "x", 100), 100)).toEqual({ action: "none" });
    expect(externalChangeDecision(t("x", "x", 100), 50)).toEqual({ action: "none" });
  });

  /** A tab we have never stat'd has knownMtime 0, and 0 is not evidence that anything changed. */
  it("does nothing when we never knew the file's mtime", () => {
    expect(externalChangeDecision(t("x", "x", 0), 12345)).toEqual({ action: "none" });
  });

  it("silently adopts the new contents when the tab is clean", () => {
    expect(externalChangeDecision(t("x", "x", 100), 200)).toEqual({ action: "reload" });
  });

  /**
   * The other one that loses work. The file changed on disk AND the user has unsaved edits in
   * that tab. Two versions now exist and only a human can choose between them. Reloading would
   * throw the user's edit away to adopt someone else's; saving over it would do the reverse.
   * So: say so, and touch nothing.
   */
  it("warns rather than reloading when the tab is dirty, because a reload would eat the edit", () => {
    expect(externalChangeDecision(t("my unsaved edit", "saved", 100), 200)).toEqual({
      action: "warn",
    });
  });
});
