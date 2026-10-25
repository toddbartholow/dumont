import { describe, it, expect, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { aiFetch } from "./aiTransport";

vi.mock("@tauri-apps/api/core", () => {
    // Minimal stand-in for the Tauri Channel: aiFetch assigns `onmessage`, and
    // the invoke mock below fires it to simulate the Rust side's events.
    class Channel {
        onmessage: (event: unknown) => void = () => {};
    }
    return { Channel, invoke: vi.fn() };
});
const mockInvoke = vi.mocked(invoke);

interface EventChannel {
    onmessage: (event: unknown) => void;
}
const channelOf = (args: unknown) => (args as { channel: EventChannel }).channel;

describe("aiFetch", () => {
    /** The Rust side's events for one response. */
    const respond = (status: number, chunks: string[]) =>
        mockInvoke.mockImplementation(async (cmd, args) => {
            if (cmd !== "ai_request") return;
            const ch = channelOf(args);
            ch.onmessage({ type: "status", status });
            for (const data of chunks) ch.onmessage({ type: "chunk", data });
            ch.onmessage({ type: "done" });
        });

    it("accumulates chunk/status/done events into the response", async () => {
        respond(200, ["hel", "lo\n"]);

        const statuses: number[] = [];
        const res = await aiFetch("https://api.test/v1", "{}", {
            connectTimeoutMs: 1000,
            onStatus: (s) => statuses.push(s),
        });

        expect(res).toEqual({ status: 200, body: "hello\n" });
        expect(statuses).toEqual([200]);
    });

    // AI-07: a streamed reply is the consumer's; a second whole copy here is memory spent on
    // nothing, for as long as the generation runs.
    it("hands a successful body to the stream consumer instead of also keeping it", async () => {
        respond(200, ["hel", "lo\n"]);

        const chunks: string[] = [];
        const res = await aiFetch("https://api.test/v1", "{}", {
            connectTimeoutMs: 1000,
            onChunk: (t) => chunks.push(t),
        });

        expect(chunks).toEqual(["hel", "lo\n"]);
        expect(res).toEqual({ status: 200, body: "" });
    });

    it("still keeps an error body with a stream consumer, for the error message", async () => {
        respond(500, ["upstream ", "exploded"]);

        const res = await aiFetch("https://api.test/v1", "{}", { connectTimeoutMs: 1000, onChunk: () => {} });

        expect(res).toEqual({ status: 500, body: "upstream exploded" });
    });

    it("passes the idle timeout to Rust", async () => {
        let captured: Record<string, unknown> | undefined;
        mockInvoke.mockImplementation(async (cmd, args) => {
            if (cmd !== "ai_request") return;
            captured = args as Record<string, unknown>;
            channelOf(args).onmessage({ type: "done" });
        });

        await aiFetch("https://api.test/v1", "{}", { connectTimeoutMs: 1000, idleTimeoutMs: 30_000 });

        expect(captured?.idleTimeoutMs).toBe(30_000);
    });

    it("never puts the API key in the ai_request payload (Rust reads it from the keychain, SECURITY-01)", async () => {
        let captured: Record<string, unknown> | undefined;
        mockInvoke.mockImplementation(async (cmd, args) => {
            if (cmd !== "ai_request") return;
            captured = args as Record<string, unknown>;
            const ch = channelOf(args);
            ch.onmessage({ type: "status", status: 200 });
            ch.onmessage({ type: "done" });
        });

        await aiFetch("https://api.test/v1", "{}", { connectTimeoutMs: 1000 });

        expect(captured).toBeDefined();
        // The credential must not cross the IPC boundary in either form.
        expect(captured).not.toHaveProperty("apiKey");
        expect(captured).not.toHaveProperty("key");
        expect(Object.keys(captured!).sort()).toEqual(
            ["body", "channel", "connectTimeoutMs", "endpoint", "id", "idleTimeoutMs", "totalTimeoutMs"],
        );
    });

    it("converts a plain-string rejection into an Error", async () => {
        mockInvoke.mockRejectedValue("Could not reach the AI endpoint: connection refused");
        const p = aiFetch("https://api.test/v1", "{}", { connectTimeoutMs: 1000 });
        await expect(p).rejects.toBeInstanceOf(Error);
        await expect(p).rejects.toThrow("Could not reach the AI endpoint: connection refused");
    });

    it('converts a "cancelled" rejection into an AbortError', async () => {
        mockInvoke.mockRejectedValue("cancelled");
        await expect(
            aiFetch("https://api.test/v1", "{}", { connectTimeoutMs: 1000 })
        ).rejects.toMatchObject({ name: "AbortError" });
    });

    it("short-circuits with AbortError when the signal is already aborted", async () => {
        const ctrl = new AbortController();
        ctrl.abort();
        await expect(
            aiFetch("https://api.test/v1", "{}", { signal: ctrl.signal, connectTimeoutMs: 1000 })
        ).rejects.toMatchObject({ name: "AbortError" });
        expect(mockInvoke).not.toHaveBeenCalled();
    });

    it("invokes ai_cancel when the signal aborts mid-flight", async () => {
        let rejectRequest!: (reason: unknown) => void;
        mockInvoke.mockImplementation((cmd) => {
            if (cmd === "ai_request") {
                return new Promise((_resolve, reject) => {
                    rejectRequest = reject;
                });
            }
            return Promise.resolve(undefined);
        });

        const ctrl = new AbortController();
        const p = aiFetch("https://api.test/v1", "{}", {
            signal: ctrl.signal,
            connectTimeoutMs: 1000,
        });
        const requestId = (mockInvoke.mock.calls[0][1] as { id: number }).id;

        ctrl.abort();
        expect(mockInvoke).toHaveBeenCalledWith("ai_cancel", { id: requestId });

        // The Rust side rejects the original command with "cancelled".
        rejectRequest("cancelled");
        await expect(p).rejects.toMatchObject({ name: "AbortError" });
    });
});
