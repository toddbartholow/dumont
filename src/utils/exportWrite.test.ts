import { describe, it, expect, vi, type Mock } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { EXPORT_PATH_HEADER, writeExportFile } from "./exportWrite";

describe("writeExportFile", () => {
    it("sends text as UTF-8 bytes in the body, not as a JSON argument", async () => {
        (invoke as Mock).mockClear();
        await writeExportFile("/tmp/out.html", "<p>café</p>");
        expect(invoke).toHaveBeenCalledOnce();
        const [cmd, body] = (invoke as Mock).mock.calls[0];
        expect(cmd).toBe("write_export_file");
        // isView, not instanceof: jsdom's Uint8Array is not the realm TextEncoder returns into.
        expect(ArrayBuffer.isView(body)).toBe(true);
        expect(new TextDecoder().decode(body)).toBe("<p>café</p>");
    });

    it("passes bytes through untouched", async () => {
        (invoke as Mock).mockClear();
        const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
        await writeExportFile("/tmp/out.docx", bytes);
        expect((invoke as Mock).mock.calls[0][1]).toBe(bytes);
    });

    // A header value must be ASCII; a Windows path with a space and an accent is not.
    it("percent-encodes the path into its header", async () => {
        (invoke as Mock).mockClear();
        const path = "C:\\Users\\me\\My Notes\\résumé.html";
        await writeExportFile(path, "x");
        const headers = (invoke as Mock).mock.calls[0][2].headers;
        expect(headers[EXPORT_PATH_HEADER]).toBe("C%3A%5CUsers%5Cme%5CMy%20Notes%5Cr%C3%A9sum%C3%A9.html");
        expect(decodeURIComponent(headers[EXPORT_PATH_HEADER])).toBe(path);
    });

    it("surfaces a failed write to the caller", async () => {
        (invoke as Mock).mockRejectedValueOnce("Failed to write file: denied");
        await expect(writeExportFile("/tmp/out.html", "x")).rejects.toBe("Failed to write file: denied");
    });
});
