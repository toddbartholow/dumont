import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

// One fake update, rebuilt per test. `download` and `install` are separate spies
// because the whole point is the gap between them: the restart question has to be
// asked after the bytes are down and before anything is installed.
let update: { version: string; currentVersion: string; body: string; download: ReturnType<typeof vi.fn>; install: ReturnType<typeof vi.fn> };
vi.mock("@tauri-apps/plugin-updater", () => ({ check: vi.fn(async () => update) }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn(async () => {}) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

const { UpdateDialog } = await import("./UpdateDialog");
const { relaunch } = await import("@tauri-apps/plugin-process");

beforeEach(() => {
    update = {
        version: "9.9.9",
        currentVersion: "1.0.0",
        body: "",
        download: vi.fn(async () => {}),
        install: vi.fn(async () => {}),
    };
    vi.mocked(relaunch).mockClear();
});
afterEach(cleanup);

const clickUpdate = async () => fireEvent.click(await screen.findByRole("button", { name: "Update now" }));

describe("UpdateDialog restart gate", () => {
    it("downloads, asks, then installs and relaunches when the documents are safe", async () => {
        const order: string[] = [];
        update.download.mockImplementation(async () => { order.push("download"); });
        update.install.mockImplementation(async () => { order.push("install"); });
        const confirmRestart = vi.fn(async () => { order.push("confirm"); return true; });
        render(<UpdateDialog confirmRestart={confirmRestart} />);
        await clickUpdate();
        await waitFor(() => expect(relaunch).toHaveBeenCalledTimes(1));
        expect(order).toEqual(["download", "confirm", "install"]);
    });

    // On Windows install() IS the exit: the plugin runs the installer and calls
    // std::process::exit(0). So a cancelled question must mean install never ran.
    it("does not install when the user cancels, and offers the restart again", async () => {
        const confirmRestart = vi.fn(async () => false);
        render(<UpdateDialog confirmRestart={confirmRestart} />);
        await clickUpdate();
        const restart = await screen.findByRole("button", { name: "Restart now" });
        expect(update.install).not.toHaveBeenCalled();
        expect(relaunch).not.toHaveBeenCalled();

        confirmRestart.mockResolvedValueOnce(true);
        fireEvent.click(restart);
        await waitFor(() => expect(update.install).toHaveBeenCalledTimes(1));
        // The bytes from the first attempt are reused, not fetched again.
        expect(update.download).toHaveBeenCalledTimes(1);
    });

    it("gets out of the way while the unsaved-changes dialog is asking", async () => {
        let answer!: (ok: boolean) => void;
        const confirmRestart = vi.fn(() => new Promise<boolean>((r) => { answer = r; }));
        render(<UpdateDialog confirmRestart={confirmRestart} />);
        await clickUpdate();
        await waitFor(() => expect(confirmRestart).toHaveBeenCalled());
        // This overlay sits above the shared Modal layer, so staying up would hide
        // the very question it is waiting on.
        expect(screen.queryByRole("dialog", { name: "Update available" })).toBeNull();
        answer(false);
        expect(await screen.findByRole("button", { name: "Restart now" })).toBeTruthy();
    });
});
