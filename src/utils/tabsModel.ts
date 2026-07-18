/**
 * Pure data model for the open-file tabs. The heavy state lives in App (the
 * "active" tab is the live editor); these helpers just manage the list so the
 * tricky bits (which tab to focus after a close) are unit-testable.
 */

export interface TabState {
  /** Stable id for the lifetime of the tab (unrelated to the file path). */
  id: string;
  /** null for an unsaved "Untitled" buffer. */
  filePath: string | null;
  fileName: string;
  content: string;
  originalContent: string;
  fileSize: number;
  /** Last-known on-disk mtime (ms), for external-change detection. */
  knownMtime: number;
  /** 1-based caret/top-visible line when last active, to restore your place on
   *  switch-back. Undefined for a never-yet-focused tab. */
  cursorLine?: number;
}

/** A tab is dirty when its buffer differs from what's on disk. */
export function isTabDirty(tab: Pick<TabState, "content" | "originalContent">): boolean {
  return tab.content !== tab.originalContent;
}

/** The live editor buffer for the ACTIVE tab. Its stored snapshot in the tabs
 *  array lags until the next switch, so dirty checks for the active tab must
 *  read these live values instead. `fileName` may be null for an Untitled buffer. */
export interface LiveActiveTab {
  filePath: string | null;
  fileName: string | null;
  content: string;
  originalContent: string;
}

/** A tab that has unsaved changes, in the shape the window-close save loop needs. */
export interface DirtyTab {
  id: string;
  filePath: string | null;
  fileName: string;
  content: string;
}

/**
 * Every open tab with unsaved changes. The ACTIVE tab is read from `live` (the
 * editor's current buffer) rather than its stored snapshot, which lags until the
 * next tab switch; every other tab is compared against its own saved
 * originalContent. This is what the window-close guard uses so a dirty
 * BACKGROUND tab can't be discarded silently when the active tab is clean.
 * TABS-04 / issue #88.
 */
export function collectDirtyTabs(
  tabs: TabState[],
  activeId: string | null,
  live: LiveActiveTab
): DirtyTab[] {
  const dirty: DirtyTab[] = [];
  for (const t of tabs) {
    const isActive = t.id === activeId;
    const content = isActive ? live.content : t.content;
    const originalContent = isActive ? live.originalContent : t.originalContent;
    if (!isTabDirty({ content, originalContent })) continue;
    dirty.push({
      id: t.id,
      filePath: isActive ? live.filePath : t.filePath,
      fileName: isActive ? (live.fileName ?? "Untitled.md") : t.fileName,
      content,
    });
  }
  return dirty;
}

/** Find an open tab by file path (null paths never match). */
export function findTabByPath(tabs: TabState[], path: string | null): TabState | undefined {
  if (path == null) return undefined;
  return tabs.find((t) => t.filePath === path);
}

/**
 * Which tab should become active after `closingId` is closed: the tab to the
 * right (the one that slides into the closed slot), else the tab to the left,
 * else null when nothing remains. Mirrors common editor behavior.
 */
export function nextActiveAfterClose(tabs: TabState[], closingId: string): string | null {
  const idx = tabs.findIndex((t) => t.id === closingId);
  if (idx === -1) return null;
  const remaining = tabs.filter((t) => t.id !== closingId);
  if (remaining.length === 0) return null;
  return (remaining[idx] ?? remaining[idx - 1] ?? remaining[remaining.length - 1]).id;
}

/**
 * The name for a new Untitled buffer, numbered so repeated Ctrl+N don't all read
 * "Untitled.md". Returns the lowest "Untitled-N.md" not currently in use by an
 * unsaved tab (N starts at 1). TABS-08.
 */
export function nextUntitledName(tabs: TabState[]): string {
  const used = new Set(
    tabs.filter((t) => t.filePath === null).map((t) => t.fileName)
  );
  for (let n = 1; ; n++) {
    const candidate = `Untitled-${n}.md`;
    if (!used.has(candidate)) return candidate;
  }
}

/**
 * An existing untitled buffer that is empty and pristine (no path, no content) —
 * worth reusing on "New file" instead of stacking another identical blank tab.
 * TABS-08.
 */
export function findReusableUntitledTab(tabs: TabState[]): TabState | undefined {
  return tabs.find((t) => t.filePath === null && t.content === "" && t.originalContent === "");
}

/** Folder segments of a path in natural (root → parent) order. `a/b/c/x.md` →
 *  ["a","b","c"]. Handles both `/` and `\` separators. Null → []. */
function parentSegments(filePath: string | null): string[] {
  if (!filePath) return [];
  const parts = filePath.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.slice(0, -1); // drop the file name itself
}

/**
 * Display label per tab: just the file name when unique, else the file name plus
 * the shortest trailing folder path that distinguishes it from the other tabs
 * sharing that name — like `README.md — docs`. TABS-09.
 */
export function computeTabLabels(
  tabs: Array<{ id: string; fileName: string; filePath: string | null }>
): Map<string, string> {
  const labels = new Map<string, string>();
  const byName = new Map<string, typeof tabs>();
  for (const t of tabs) {
    const arr = byName.get(t.fileName) ?? [];
    arr.push(t);
    byName.set(t.fileName, arr);
  }
  for (const [name, group] of byName) {
    if (group.length === 1) {
      labels.set(group[0].id, name);
      continue;
    }
    const withSegs = group.map((t) => ({ id: t.id, segs: parentSegments(t.filePath) }));
    const maxDepth = Math.max(1, ...withSegs.map((g) => g.segs.length));
    for (const g of withSegs) {
      let suffix = "";
      for (let d = 1; d <= maxDepth; d++) {
        const mine = g.segs.slice(-d).join("/");
        const collision = withSegs.some((o) => o.id !== g.id && o.segs.slice(-d).join("/") === mine);
        suffix = mine;
        if (!collision) break;
      }
      labels.set(g.id, suffix ? `${name} — ${suffix}` : name);
    }
  }
  return labels;
}

/** Move a tab from one index to another, returning a new array. Out-of-range or
 *  no-op moves return the original array unchanged. Used for drag-reorder. TABS-10. */
export function moveTab(tabs: TabState[], fromIndex: number, toIndex: number): TabState[] {
  if (
    fromIndex === toIndex ||
    fromIndex < 0 || fromIndex >= tabs.length ||
    toIndex < 0 || toIndex >= tabs.length
  ) {
    return tabs;
  }
  const copy = tabs.slice();
  const [item] = copy.splice(fromIndex, 1);
  copy.splice(toIndex, 0, item);
  return copy;
}

/**
 * A tab as it ACTUALLY is right now, with the active tab's live buffer merged in.
 *
 * The rule this encodes is the most dangerous convention in the app: the active tab's entry
 * in the `tabs` array is deliberately STALE. The live editor buffer is the truth for it, and
 * the snapshot only catches up on the next switch. Every consumer of tab data therefore has
 * to write `id === activeId ? live : snapshot`, and there were ten of them, each doing it by
 * hand. The eleventh is the one that forgets, and what it forgets is whether the user has
 * unsaved work.
 *
 * So: read a tab through here, not out of the array.
 */
export interface ResolvedTab {
  id: string;
  filePath: string | null;
  fileName: string;
  content: string;
  originalContent: string;
}

export function resolveTab(
  tabs: TabState[],
  id: string,
  activeId: string | null,
  live: LiveActiveTab
): ResolvedTab | null {
  const t = tabs.find((x) => x.id === id);
  if (!t) return null;
  if (id !== activeId) {
    return {
      id: t.id,
      filePath: t.filePath,
      fileName: t.fileName,
      content: t.content,
      originalContent: t.originalContent,
    };
  }
  return {
    id: t.id,
    filePath: live.filePath,
    // An unsaved buffer has no name of its own; the tabs array is the only place that
    // carries one, so fall back to it rather than inventing a second default.
    fileName: live.fileName ?? t.fileName,
    content: live.content,
    originalContent: live.originalContent,
  };
}

/** What closing a tab should actually do. */
export type CloseTabDecision =
  /** No such tab. Nothing to do. */
  | { action: "gone" }
  /** Clean: close it without asking. */
  | { action: "close" }
  /** Dirty: the user has unsaved work in it and must be asked first. */
  | { action: "prompt"; fileName: string };

/**
 * Decide what closing a tab means, WITHOUT closing it.
 *
 * This is the gate that stands between a Ctrl+W and a lost draft, and it used to be written
 * inline in App with its own hand-rolled dirty check, sitting a few feet away from an
 * exported, tested `isTabDirty` that it did not call. That is the shape of a bug waiting to
 * happen: the tested function and the running function were two different functions.
 */
export function closeTabDecision(
  tabs: TabState[],
  id: string,
  activeId: string | null,
  live: LiveActiveTab
): CloseTabDecision {
  const tab = resolveTab(tabs, id, activeId, live);
  if (!tab) return { action: "gone" };
  if (isTabDirty(tab)) return { action: "prompt", fileName: tab.fileName };
  return { action: "close" };
}

/**
 * The background tabs that need autosaving.
 *
 * The ACTIVE tab is excluded because useAutosave already owns it: its snapshot in this array
 * is stale by design, so judging it from here would either miss the user's latest keystrokes
 * or save text they have already moved past. A tab with no path has nowhere to be saved to.
 */
export function backgroundTabsToAutosave(tabs: TabState[], activeId: string | null): TabState[] {
  return tabs.filter((t) => t.id !== activeId && t.filePath !== null && isTabDirty(t));
}

/**
 * Mark a tab saved, but ONLY if its content has not moved since the save was started.
 *
 * The write is asynchronous, and a user can switch to a background tab and type into it while
 * its own autosave is still in flight. Marking it clean on the strength of what we SET OUT to
 * write would tell the app that whatever they typed in the meantime is already on disk. It is
 * not. Their edit would then sit there looking saved, and be lost on quit.
 */
export function markTabSaved(
  tabs: TabState[],
  id: string,
  writtenContent: string,
  mtime: number
): TabState[] {
  return tabs.map((t) =>
    t.id === id && t.content === writtenContent
      ? { ...t, originalContent: writtenContent, knownMtime: mtime }
      : t
  );
}

/** What a background tab's file changing underneath us means. */
export type ExternalChange =
  /** The file has not moved, or we never knew its mtime. Leave it alone. */
  | { action: "none" }
  /** Clean tab: adopt the new contents silently. Nothing of the user's is at stake. */
  | { action: "reload" }
  /** Dirty tab: two versions now exist and only the user can choose. Warn, do not touch. */
  | { action: "warn" };

/**
 * Decide what an on-disk change to a BACKGROUND tab means.
 *
 * `knownMtime > 0` is the guard that stops a tab we have never stat'd from being treated as
 * changed. And a DIRTY tab is never silently reloaded: that would throw away the user's
 * unsaved edit to adopt someone else's, which is the worst of both.
 */
export function externalChangeDecision(
  tab: Pick<TabState, "content" | "originalContent" | "knownMtime">,
  diskMtime: number
): ExternalChange {
  if (!(tab.knownMtime > 0 && diskMtime > tab.knownMtime)) return { action: "none" };
  return isTabDirty(tab) ? { action: "warn" } : { action: "reload" };
}
