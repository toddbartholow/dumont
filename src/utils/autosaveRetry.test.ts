import { describe, it, expect } from "vitest";
import {
    AUTOSAVE_ERROR_THROTTLE_MS,
    AUTOSAVE_RETRY_MAX_MS,
    autosaveRetryDelay,
    recordAutosaveFailure,
} from "./autosaveRetry";

describe("autosaveRetryDelay", () => {
    it("starts short and doubles", () => {
        expect(autosaveRetryDelay(1)).toBe(2_000);
        expect(autosaveRetryDelay(2)).toBe(4_000);
        expect(autosaveRetryDelay(3)).toBe(8_000);
    });

    // Bounded, but never given up on: a dirty document keeps being retried.
    it("stops growing at the cap", () => {
        expect(autosaveRetryDelay(20)).toBe(AUTOSAVE_RETRY_MAX_MS);
        expect(autosaveRetryDelay(1000)).toBe(AUTOSAVE_RETRY_MAX_MS);
    });
});

describe("recordAutosaveFailure", () => {
    it("tells the user about the first failure and schedules a retry", () => {
        const { failure, notify } = recordAutosaveFailure(undefined, 10_000);
        expect(notify).toBe(true);
        expect(failure).toEqual({ attempts: 1, retryAt: 12_000, toastedAt: 10_000 });
    });

    it("stays quiet about repeats inside the throttle window, and backs off further", () => {
        const first = recordAutosaveFailure(undefined, 10_000).failure;
        const { failure, notify } = recordAutosaveFailure(first, 12_000);
        expect(notify).toBe(false);
        expect(failure).toEqual({ attempts: 2, retryAt: 16_000, toastedAt: 10_000 });
    });

    it("tells the user again once the window has passed", () => {
        const first = recordAutosaveFailure(undefined, 10_000).failure;
        const { failure, notify } = recordAutosaveFailure(first, 10_000 + AUTOSAVE_ERROR_THROTTLE_MS);
        expect(notify).toBe(true);
        expect(failure.toastedAt).toBe(10_000 + AUTOSAVE_ERROR_THROTTLE_MS);
    });
});
