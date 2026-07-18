import { describe, it, expect, vi } from "vitest";
import { isValidEndpoint, runAIAction, type AIConfig } from "./aiAssist";
import { aiFetch } from "./aiTransport";

vi.mock("./aiTransport", () => ({ aiFetch: vi.fn() }));
const mockAiFetch = vi.mocked(aiFetch);

const cfg = (over: Partial<AIConfig> = {}): AIConfig => ({
    endpoint: "https://api.test/v1/chat/completions",
    model: "test-model",
    ...over,
});

/** Shorthand for a transport response the Rust command would deliver. */
const respond = (status: number, body: unknown) =>
    mockAiFetch.mockResolvedValue({
        status,
        body: typeof body === "string" ? body : JSON.stringify(body),
    });

describe("isValidEndpoint", () => {
    it("accepts http and https", () => {
        expect(isValidEndpoint("http://localhost:11434/v1/chat/completions")).toBe(true);
        expect(isValidEndpoint("https://api.openai.com/v1/chat/completions")).toBe(true);
    });
    it("rejects other schemes and garbage", () => {
        expect(isValidEndpoint("ftp://x")).toBe(false);
        expect(isValidEndpoint("not a url")).toBe(false);
        expect(isValidEndpoint("")).toBe(false);
    });
});

describe("runAIAction config guards", () => {
    it("throws when endpoint missing", async () => {
        await expect(runAIAction("rewrite", "hi", cfg({ endpoint: "" }))).rejects.toThrow(/endpoint not configured/i);
    });
    it("throws for an invalid endpoint URL", async () => {
        await expect(runAIAction("rewrite", "hi", cfg({ endpoint: "nope" }))).rejects.toThrow(/valid http/i);
    });
    it("throws when model missing", async () => {
        await expect(runAIAction("rewrite", "hi", cfg({ model: "" }))).rejects.toThrow(/model not configured/i);
    });
});

describe("runAIAction request handling", () => {
    it("returns the OpenAI-style content on success", async () => {
        respond(200, { choices: [{ message: { content: "  hello  " } }] });
        await expect(runAIAction("rewrite", "x", cfg())).resolves.toBe("hello");
    });

    it("supports the Ollama native shape", async () => {
        respond(200, { message: { content: "ollama out" } });
        await expect(runAIAction("continue", "x", cfg())).resolves.toBe("ollama out");
    });

    it("maps a 401 to an actionable message", async () => {
        respond(401, "unauthorized");
        await expect(runAIAction("rewrite", "x", cfg())).rejects.toThrow(/api key invalid or unauthorized/i);
    });

    it("throws on an empty response", async () => {
        respond(200, { choices: [{ message: { content: "" } }] });
        await expect(runAIAction("rewrite", "x", cfg())).rejects.toThrow(/empty response/i);
    });

    it("truncates a runaway response", async () => {
        respond(200, { choices: [{ message: { content: "a".repeat(300_000) } }] });
        const out = await runAIAction("expand", "x", cfg());
        expect(out.length).toBeLessThan(210_000);
        expect(out.endsWith("[Response truncated]")).toBe(true);
    });

    it("maps a transport timeout to the 60s message", async () => {
        mockAiFetch.mockRejectedValue(new Error("timed out"));
        await expect(runAIAction("rewrite", "x", cfg())).rejects.toThrow("AI request timed out after 60s.");
    });

    it("lets a user abort propagate as AbortError", async () => {
        mockAiFetch.mockRejectedValue(new DOMException("The operation was aborted.", "AbortError"));
        await expect(runAIAction("rewrite", "x", cfg())).rejects.toMatchObject({ name: "AbortError" });
    });
});
