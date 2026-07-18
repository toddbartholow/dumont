import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
    HISTORY_CHANGED_EVENT,
    formatBytes,
    formatSnapshotClock,
    formatSnapshotTime,
    recordSnapshot,
    setHistoryConfig,
} from "./history";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const mockInvoke = vi.mocked(invoke);

/** A fixed "now": Wednesday 12 March 2025, 14:32:00 local time. */
const NOW = new Date(2025, 2, 12, 14, 32, 0).getTime();
const ago = (ms: number) => NOW - ms;

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

describe("formatSnapshotTime", () => {
  it("reads as relative while relative is the useful frame", () => {
    expect(formatSnapshotTime(ago(0), NOW)).toBe("just now");
    expect(formatSnapshotTime(ago(9 * SECOND), NOW)).toBe("just now");
    expect(formatSnapshotTime(ago(30 * SECOND), NOW)).toBe("30 seconds ago");
    expect(formatSnapshotTime(ago(1 * MINUTE), NOW)).toBe("1 minute ago");
    expect(formatSnapshotTime(ago(2 * MINUTE), NOW)).toBe("2 minutes ago");
    expect(formatSnapshotTime(ago(59 * MINUTE), NOW)).toBe("59 minutes ago");
    expect(formatSnapshotTime(ago(1 * HOUR), NOW)).toBe("1 hour ago");
    expect(formatSnapshotTime(ago(3 * HOUR), NOW)).toBe("3 hours ago");
  });

  it("switches to a clock time once relative stops being helpful", () => {
    // 14:32 yesterday. "24 hours ago" is a worse answer than "yesterday 14:32".
    expect(formatSnapshotTime(ago(24 * HOUR), NOW)).toBe("yesterday 14:32");
    expect(formatSnapshotTime(ago(3 * 24 * HOUR), NOW)).toBe("9 Mar 14:32");
  });

  /**
   * Past the hour mark, the CALENDAR day decides, not a block of 24 hours.
   *
   * At 10:00, a snapshot from 20:00 last night is fourteen hours old, so a clock
   * that counts in 24-hour blocks calls it "14 hours ago" and leaves the reader to
   * do the arithmetic. It is yesterday evening, and that is what it should say.
   */
  it("says yesterday for a previous calendar day, even inside 24 hours", () => {
    const thisMorning = new Date(2025, 2, 12, 10, 0, 0).getTime();
    const lastNight = new Date(2025, 2, 11, 20, 0, 0).getTime();
    expect(formatSnapshotTime(lastNight, thisMorning)).toBe("yesterday 20:00");
  });

  /**
   * The minute scale still wins under an hour, though, even across midnight. A
   * snapshot from 23:50, read at 00:10, is twenty minutes old; "yesterday 23:50" is
   * technically true and a worse answer to the question the user is asking.
   */
  it("keeps the relative form under an hour, midnight or not", () => {
    const justAfterMidnight = new Date(2025, 2, 12, 0, 10, 0).getTime();
    const lateLastNight = new Date(2025, 2, 11, 23, 50, 0).getTime();
    expect(formatSnapshotTime(lateLastNight, justAfterMidnight)).toBe("20 minutes ago");
  });

  it("names the year once it is not this one", () => {
    const lastYear = new Date(2024, 10, 3, 9, 5, 0).getTime();
    expect(formatSnapshotTime(lastYear, NOW)).toBe("3 Nov 2024 09:05");
  });

  /** A clock that has been wound back must not print "-4 seconds ago". */
  it("does not go negative when the snapshot is in the future", () => {
    expect(formatSnapshotTime(NOW + 5 * MINUTE, NOW)).toBe("just now");
  });
});

describe("formatSnapshotClock", () => {
    /**
     * The banner's label is set ONCE, when the snapshot is opened as a proposed
     * change, and then sits over the diff for as long as the user takes to work
     * through it. A relative time there freezes at the click and rots, until the
     * banner says "2 minutes ago" while the row it came from, ticking once a minute
     * two inches to its left, says "17 minutes ago". So the banner is absolute: the
     * same instant reads the same at any later `now`.
     */
    it("does not rot: the same snapshot reads the same however long the review is left open", () => {
        const taken = ago(2 * MINUTE);

        const atClick = formatSnapshotClock(taken, NOW);
        const fifteenMinutesLater = formatSnapshotClock(taken, NOW + 15 * MINUTE);
        const twoHoursLater = formatSnapshotClock(taken, NOW + 2 * HOUR);

        expect(fifteenMinutesLater).toBe(atClick);
        expect(twoHoursLater).toBe(atClick);
    });

    it("names the day rather than counting backwards from now", () => {
        expect(formatSnapshotClock(ago(2 * MINUTE), NOW)).toBe("today at 14:30");
        expect(formatSnapshotClock(ago(24 * HOUR), NOW)).toBe("yesterday at 14:32");
        expect(formatSnapshotClock(ago(3 * 24 * HOUR), NOW)).toBe("9 Mar at 14:32");
    });

    it("adds the year once the snapshot is from a different one", () => {
        const lastYear = new Date(2024, 10, 2, 9, 5, 0).getTime();
        expect(formatSnapshotClock(lastYear, NOW)).toBe("2 Nov 2024 at 09:05");
    });
});

describe("formatBytes", () => {
  it("scales the unit to the size", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(842)).toBe("842 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(51_200)).toBe("50 KB");
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
    expect(formatBytes(12 * 1024 * 1024)).toBe("12 MB");
  });
});

describe("recordSnapshot", () => {
  beforeEach(() => {
    setHistoryConfig({ enabled: true, limit: 50, intervalSecs: 60 });
  });

  /** Wait out the promise chain inside recordSnapshot, which is fire-and-forget. */
  const settle = () => new Promise((r) => setTimeout(r, 0));

  const listen = () => {
    const seen: string[] = [];
    const onChanged = (e: Event) => seen.push((e as CustomEvent).detail.path);
    window.addEventListener(HISTORY_CHANGED_EVENT, onChanged);
    return {
      seen,
      stop: () => window.removeEventListener(HISTORY_CHANGED_EVENT, onChanged),
    };
  };

  it("announces a snapshot that was actually recorded", async () => {
    mockInvoke.mockResolvedValue({ id: "1", timestamp: 1, bytes: 2 });
    const { seen, stop } = listen();

    recordSnapshot("/notes/a.md", "hello");
    await settle();

    expect(seen).toEqual(["/notes/a.md"]);
    stop();
  });

  /**
   * A null return means the store did not change: the save fell inside
   * files.historyInterval, or its content was identical, or the file was too big.
   * Announcing it would make an open History panel re-read the disk on every
   * autosave, every 1.5 seconds of typing, only to render the same list back.
   */
  it("stays silent when the save recorded nothing", async () => {
    mockInvoke.mockResolvedValue(null);
    const { seen, stop } = listen();

    recordSnapshot("/notes/a.md", "hello");
    await settle();

    expect(seen).toEqual([]);
    stop();
  });

  it("never lets a failed snapshot escape as a rejection, because a save must not fail with it", async () => {
    mockInvoke.mockRejectedValue(new Error("disk full"));
    const { seen, stop } = listen();

    expect(() => recordSnapshot("/notes/a.md", "hello")).not.toThrow();
    await settle();

    expect(seen).toEqual([]);
    stop();
  });

  it("does not reach the disk at all when history is turned off", async () => {
    setHistoryConfig({ enabled: false, limit: 50, intervalSecs: 60 });

    recordSnapshot("/notes/a.md", "hello");
    await settle();

    expect(mockInvoke).not.toHaveBeenCalled();
  });
});
