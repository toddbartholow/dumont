// Modified by IRQ Studio, LLC (2026) from an Apache-2.0 licensed original.
// See NOTICE for attribution and license terms.

/**
 * The two ways settings.json can lose data, both found in review.
 *
 * Neither is a race between renders. Both are races against the DISK: the window
 * where a write is in flight is milliseconds, not microseconds, and on a network
 * home directory or behind an antivirus filter driver it is much longer than that.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, act, cleanup } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { SettingsProvider, useSetting, useSettings } from "./SettingsProvider";
import { defaultSettings } from "./schema";

const mockInvoke = vi.mocked(invoke);

/** The file, plus a hook to hold a write open while the UI carries on. */
let file: string;
let writes: string[];
let release: (() => void) | null;
/** Hold the first write open, so a second can start while it is still in flight. */
let parkFirstWrite = false;

afterEach(cleanup);

beforeEach(() => {
    file = `{\n  "editor.minimap": true\n}`;
    writes = [];
    release = null;
    parkFirstWrite = false;
    mockInvoke.mockReset();
    mockInvoke.mockImplementation(async (cmd: string, args?: any) => {
        if (cmd === "read_settings") return file;
        if (cmd === "write_settings") {
            const text = args!.text as string;
            // Park the write mid-flight when a test asks for it, so a second write
            // can start while the first has not landed. This is the IPC round trip.
            if (parkFirstWrite && writes.length === 0) {
                await new Promise<void>((r) => { release = r; });
            }
            writes.push(text);
            file = text;
            return null;
        }
        return null;
    });
});

function Harness({ onReady }: { onReady: (api: ReturnType<typeof useSettings>) => void }) {
    const api = useSettings();
    onReady(api);
    const [minimap] = useSetting<boolean>("editor.minimap");
    const [wrap] = useSetting<boolean>("editor.wordWrap");
    return <div data-testid="v">{`${minimap},${wrap}`}</div>;
}

function mount(initialText: string, error: string | null = null) {
    file = initialText;
    let api!: ReturnType<typeof useSettings>;
    const values = { ...defaultSettings() };
    render(
        <SettingsProvider
            initial={{
                values,
                present: new Set(["editor.minimap"]),
                text: initialText,
                error,
            }}
        >
            <Harness onReady={(a) => { api = a; }} />
        </SettingsProvider>,
    );
    return () => api;
}

describe("two settings changed while a write is in flight", () => {
    it("does not lose the first one", async () => {
        // Click two toggles in Settings > Editor, faster than a disk write. The
        // second edit must be computed from the text the first one produced.
        parkFirstWrite = true;
        const api = mount(`{\n  "editor.minimap": true\n}`);

        await act(async () => {
            void api().set("editor.minimap", false);   // parks in the mock, mid-IPC
            void api().set("editor.wordWrap", false);  // starts before the first lands
            await Promise.resolve();
            release?.();
            await new Promise((r) => setTimeout(r, 0));
        });

        const final = JSON.parse(file);
        expect(final["editor.wordWrap"]).toBe(false);
        // The one that used to vanish: the second write was computed from the
        // pre-first-write text, so it landed on a file that never had the first.
        expect(final).toHaveProperty("editor.minimap");
        expect(final["editor.minimap"]).toBe(false);
    });
});

describe("a settings.json that does not parse", () => {
    it("is never overwritten by a UI toggle", async () => {
        // The user has a typo in their file. The app runs on defaults and says so.
        // Clicking a toggle must not write over the file they are about to fix: the
        // banner in the UI promises exactly that.
        const broken = `{\n  "editor.minimap": true,,\n}`;
        const api = mount(broken, "CommaExpected at line 2, column 26");

        await act(async () => {
            await api().set("editor.wordWrap", false).catch(() => { });
            release?.();
            await new Promise((r) => setTimeout(r, 0));
        });

        expect(writes).toEqual([]);
        expect(file).toBe(broken);
    });

    it("surfaces the refusal instead of pretending the setting applied", async () => {
        const api = mount(`{\n  "editor.minimap": true,,\n}`, "CommaExpected at line 2, column 26");

        await act(async () => {
            await api().set("editor.wordWrap", false).catch(() => { });
        });

        // wordWrap stays at its default of true: the write was refused, so the
        // optimistic update must not survive it. Otherwise the toggle sits in the
        // flipped position and un-flips itself on the next launch.
        // (minimap reads false because that is its default; it was never touched.)
        expect(screen.getByTestId("v").textContent).toBe("false,true");
    });
});

describe("a write that fails", () => {
    it("does not discard a concurrent write that succeeded", async () => {
        // The provider used to roll back to a snapshot taken before its own await.
        // With two writes in flight that snapshot predates the OTHER one, so one
        // failed toggle silently reverted a second, successful toggle, and left
        // memory, `text` and the file in three different states.
        const api = mount(`{\n  "editor.minimap": true\n}`);

        let failNext = true;
        mockInvoke.mockImplementation(async (cmd: string, args?: any) => {
            if (cmd === "read_settings") return file;
            if (cmd === "write_settings") {
                if (failNext) { failNext = false; throw new Error("could not replace settings.json: EPERM"); }
                file = args!.text as string;
                writes.push(file);
                return null;
            }
            return null;
        });

        await act(async () => {
            const a = api().set("editor.wordWrap", false).catch(() => { });
            const b = api().set("editor.spellCheck", true).catch(() => { });
            await Promise.all([a, b]);
        });

        // The second write landed, and it carried both edits. Memory must agree with
        // the DISK, whatever the disk ended up holding, rather than with a snapshot.
        const onDisk = JSON.parse(file);
        expect(api().values["editor.spellCheck"]).toBe(onDisk["editor.spellCheck"]);
        expect(api().values["editor.wordWrap"]).toBe(onDisk["editor.wordWrap"]);
        expect(JSON.parse(api().text)).toEqual(onDisk);
    });

    it("reports the failure as a WRITE error, not as an unparseable file", async () => {
        // `error` means "the file does not parse", and it gates every future write.
        // Latching it on a transient EPERM put up a banner saying the file could not
        // be read and had not been changed, both false, and blocked the next toggle.
        const api = mount(`{\n  "editor.minimap": true\n}`);
        mockInvoke.mockImplementation(async (cmd: string) => {
            if (cmd === "read_settings") return file;
            if (cmd === "write_settings") throw new Error("EPERM");
            return null;
        });

        await act(async () => { await api().set("editor.wordWrap", false).catch(() => { }); });

        expect(api().writeError).toMatch(/EPERM/);
        expect(api().error).toBeNull();      // the file is fine; we could not write it
    });
});
