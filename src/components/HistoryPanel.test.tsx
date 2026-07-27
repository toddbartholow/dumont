import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { HistoryPanel } from "./HistoryPanel";
import { HISTORY_CHANGED_EVENT, type SnapshotMeta } from "../utils/history";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const mockInvoke = invoke as Mock;

const FILE = "/notes/engine.md";

/**
 * A fixed "now": Wednesday 12 March 2025, 14:32:00 local time. The same instant
 * history.test.ts pins its formatter tests to.
 *
 * This used to be `Date.now()`, which made the file fail for three hours every
 * night. formatSnapshotTime switches from "3 hours ago" to "yesterday 22:32" on
 * the CALENDAR day, deliberately (see its tests), so between midnight and 03:00
 * the three-hour-old fixture below fell on the previous day and the row read
 * "yesterday ..." instead. The formatter was right and the clock was the variable,
 * which is exactly the thing a test should not leave free.
 *
 * Mid-afternoon, so every fixture here sits well inside the same calendar day.
 */
const NOW = new Date(2025, 2, 12, 14, 32, 0).getTime();

const snapshots: SnapshotMeta[] = [
  { id: "3", timestamp: NOW - 2 * 60_000, bytes: 2048 },
  { id: "2", timestamp: NOW - 30 * 60_000, bytes: 1024 },
  { id: "1", timestamp: NOW - 3 * 60 * 60_000, bytes: 512 },
];

const props = (over: Partial<React.ComponentProps<typeof HistoryPanel>> = {}) => ({
  isOpen: true,
  filePath: FILE,
  enabled: true,
  onEnable: vi.fn(),
  onPreview: vi.fn(),
  onError: vi.fn(),
  onClose: vi.fn(),
  ...over,
});

/** The default backend: a file with three snapshots. */
const withSnapshots = () =>
  mockInvoke.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
    if (cmd === "list_snapshots") return snapshots;
    if (cmd === "read_snapshot") return `content of snapshot ${args.id}`;
    if (cmd === "clear_history") return null;
    return null;
  });

const row = (label: string) => screen.getByText(label).closest("button")!;
const button = (name: string) => screen.getByRole("button", { name });

describe("HistoryPanel", () => {
  beforeEach(() => {
    // Date ONLY. The panel re-renders its relative labels on a window.setInterval
    // tick, and Testing Library's waitFor picks its real-timer path by sniffing
    // setTimeout — faking the whole timer suite would stall both and leave every
    // `await waitFor` in this file hanging on a clock nothing advances.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    mockInvoke.mockReset();
    withSnapshots();
  });
  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it("lists the snapshots newest first, with their age and size", async () => {
    render(<HistoryPanel {...props()} />);

    await waitFor(() => expect(screen.getByText("2 minutes ago")).toBeInTheDocument());
    expect(screen.getByText("30 minutes ago")).toBeInTheDocument();
    expect(screen.getByText("3 hours ago")).toBeInTheDocument();
    expect(screen.getByText("2.0 KB")).toBeInTheDocument();

    // Rust hands them over newest first; the panel must not resort them.
    const rows = screen.getAllByRole("button").filter((b) => b.textContent?.includes("ago"));
    expect(rows[0]).toHaveTextContent("2 minutes ago");
    expect(rows[0]).toHaveTextContent("Latest");
  });

  it("previews a snapshot as a proposed change rather than restoring it", async () => {
    const onPreview = vi.fn();
    render(<HistoryPanel {...props({ onPreview })} />);

    await waitFor(() => expect(screen.getByText("30 minutes ago")).toBeInTheDocument());
    fireEvent.click(row("30 minutes ago"));

    // The label names WHICH version is on offer. The merge view it drives is shared
    // with Agent mode, whose banner reads "AI suggested changes"; letting that stand
    // over a restore would credit an AI with the user's own earlier draft.
    //
    // It is an ABSOLUTE clock time, deliberately, even though the ROW it came from
    // says "30 minutes ago". The banner is written once and then sits above the diff
    // for as long as the user takes over it, while the list ticks every minute
    // beside it, so a relative label there would rot and end up contradicting its own
    // row.
    await waitFor(() =>
      expect(onPreview).toHaveBeenCalledWith(
        "content of snapshot 2",
        // Exact, now that the clock is fixed. The `(today|yesterday)` this used to
        // allow was the same wall-clock leak as the one in the fixture above: a
        // snapshot taken 30 minutes ago is only "yesterday" if the test happens to
        // run in the first half hour after midnight.
        "Snapshot from today at 14:02"
      )
    );
    // Nothing was written. Performing the restore is the diff view's job, and the
    // user's: they accept the chunks they want and press Ctrl+S.
    expect(mockInvoke).not.toHaveBeenCalledWith("save_file", expect.anything());
    expect(row("30 minutes ago")).toHaveAttribute("aria-current", "true");
  });

  /**
   * Off is not the same as empty, and must not look like it. An empty list here
   * would read as "this file has no history", when the truth is that nothing is
   * recording one.
   */
  it("says history is OFF rather than showing an empty list", async () => {
    const onEnable = vi.fn();
    render(<HistoryPanel {...props({ enabled: false, onEnable })} />);

    expect(screen.getByText("Version history is off.")).toBeInTheDocument();
    expect(screen.queryByText(/snapshots yet/)).not.toBeInTheDocument();
    expect(mockInvoke).not.toHaveBeenCalled();

    fireEvent.click(button("Turn on history"));
    expect(onEnable).toHaveBeenCalled();
  });

  it("has a real empty state for a file that has never been saved", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => (cmd === "list_snapshots" ? [] : null));
    render(<HistoryPanel {...props()} />);

    await waitFor(() => expect(screen.getByText("No snapshots yet.")).toBeInTheDocument());
    expect(button("Clear history for this file")).toBeDisabled();
  });

  it("tells an Untitled buffer why it has no history", () => {
    render(<HistoryPanel {...props({ filePath: null })} />);

    expect(screen.getByText("Nothing to track yet.")).toBeInTheDocument();
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("clears the history only after a confirmation", async () => {
    render(<HistoryPanel {...props()} />);
    await waitFor(() => expect(screen.getByText("2 minutes ago")).toBeInTheDocument());

    fireEvent.click(button("Clear history for this file"));
    expect(mockInvoke).not.toHaveBeenCalledWith("clear_history", expect.anything());

    // Backing out leaves the snapshots alone.
    fireEvent.click(button("Cancel"));
    expect(mockInvoke).not.toHaveBeenCalledWith("clear_history", expect.anything());
    expect(screen.getByText("2 minutes ago")).toBeInTheDocument();

    fireEvent.click(button("Clear history for this file"));
    fireEvent.click(button("Clear history"));

    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("clear_history", { path: FILE }));
    await waitFor(() => expect(screen.getByText("No snapshots yet.")).toBeInTheDocument());
  });

  it("refreshes when a save records a snapshot", async () => {
    render(<HistoryPanel {...props()} />);
    await waitFor(() => expect(screen.getByText("2 minutes ago")).toBeInTheDocument());

    const listCalls = () => mockInvoke.mock.calls.filter(([cmd]) => cmd === "list_snapshots").length;
    const before = listCalls();

    window.dispatchEvent(new CustomEvent(HISTORY_CHANGED_EVENT, { detail: { path: FILE } }));
    await waitFor(() => expect(listCalls()).toBe(before + 1));

    // Another document's save is not this panel's business.
    window.dispatchEvent(new CustomEvent(HISTORY_CHANGED_EVENT, { detail: { path: "/other.md" } }));
    await new Promise((r) => setTimeout(r, 0));
    expect(listCalls()).toBe(before + 1);
  });

  it("closes on Escape", async () => {
    const onClose = vi.fn();
    render(<HistoryPanel {...props({ onClose })} />);
    await waitFor(() => expect(screen.getByText("2 minutes ago")).toBeInTheDocument());

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("reports a snapshot it cannot read instead of proposing an empty document", async () => {
    const onPreview = vi.fn();
    const onError = vi.fn();
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "list_snapshots") return snapshots;
      throw new Error("could not read snapshot");
    });

    render(<HistoryPanel {...props({ onPreview, onError })} />);
    await waitFor(() => expect(screen.getByText("2 minutes ago")).toBeInTheDocument());
    fireEvent.click(row("2 minutes ago"));

    await waitFor(() => expect(onError).toHaveBeenCalledWith("Could not read that snapshot"));
    expect(onPreview).not.toHaveBeenCalled();
  });
});
