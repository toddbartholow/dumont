/**
 * Decides which file the app should open on launch.
 *
 * Priority is the whole bug fix: a file the user just double-clicked in the
 * OS (CLI arg) must always beat the last-session restore. The old design
 * raced a delayed backend event against the restore and sometimes lost,
 * reopening yesterday's file instead of the one the user clicked.
 */
export type BootSource = "cli" | "last" | "none";

export interface BootTarget {
    path: string | null;
    source: BootSource;
}

export function pickBootFile(cliFile: string | null, lastFile: string | null): BootTarget {
    if (cliFile) return { path: cliFile, source: "cli" };
    if (lastFile) return { path: lastFile, source: "last" };
    return { path: null, source: "none" };
}

// The launch-file resolution must run exactly once per webview load. React
// StrictMode double-invokes effects in dev: without this guard the second run
// would find the CLI file already consumed (the backend take()s it) and start
// a racing last-session restore that can overwrite the just-opened file.
// Module-level on purpose: StrictMode remounts share module state. It lives
// here rather than in App.tsx so a test can reset it (a component file may
// export only components).
let bootClaimed = false;

/** True the first time it is called in this webview load, false after. */
export function claimBoot(): boolean {
    if (bootClaimed) return false;
    bootClaimed = true;
    return true;
}

/** Let the next App mount run the boot restore again. Tests only. */
export function resetBootForTests(): void {
    bootClaimed = false;
}
