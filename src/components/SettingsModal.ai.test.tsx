import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { TestProviders } from "../test/providers";

// No keychain under jsdom: each test says whether a key is saved.
let keySaved = false;
vi.mock("../utils/persistence", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../utils/persistence")>()),
    aiKeyPresent: vi.fn(async () => keySaved),
    setAIKey: vi.fn(async () => {}),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: vi.fn(), openUrl: vi.fn() }));

const { SettingsModal } = await import("./SettingsModal");

afterEach(() => {
    cleanup();
    keySaved = false;
});

async function openAiSection(endpoint: string) {
    render(
        <TestProviders settings={{ "ai.endpoint": endpoint, "ai.model": "m" }}>
            <SettingsModal isOpen onClose={() => {}} />
        </TestProviders>,
    );
    // Let the mount-time aiKeyPresent() check land.
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: /^auto_awesome\s*AI$/ }));
}

const WARNING = /your saved API key will not be sent/i;

describe("SettingsModal AI section", () => {
    it("warns when a saved key meets a plain-http endpoint on another machine", async () => {
        keySaved = true;
        await openAiSection("http://192.168.1.10:11434/v1/chat/completions");
        expect(screen.getByText(WARNING)).toBeTruthy();
    });

    it("does not warn for a loopback http endpoint or for https", async () => {
        keySaved = true;
        await openAiSection("http://localhost:11434/v1/chat/completions");
        expect(screen.queryByText(WARNING)).toBeNull();

        const field = screen.getByPlaceholderText("https://api.openai.com/v1/chat/completions");
        fireEvent.change(field, { target: { value: "https://example.com/v1/chat/completions" } });
        expect(screen.queryByText(WARNING)).toBeNull();

        // And it follows the field as it is typed, before anything is saved.
        fireEvent.change(field, { target: { value: "http://example.com/v1/chat/completions" } });
        expect(screen.getByText(WARNING)).toBeTruthy();
    });

    it("does not warn when no key is saved, until one is typed", async () => {
        await openAiSection("http://example.com/v1/chat/completions");
        expect(screen.queryByText(WARNING)).toBeNull();

        const keyField = document.querySelector<HTMLInputElement>('input[type="password"]')!;
        fireEvent.change(keyField, { target: { value: "sk-test" } });
        expect(screen.getByText(WARNING)).toBeTruthy();
    });

    it("keeps the API key out of autofill and spellcheck", async () => {
        await openAiSection("");
        const keyField = document.querySelector<HTMLInputElement>('input[type="password"]')!;
        expect(keyField.getAttribute("autocomplete")).toBe("off");
        expect(keyField.getAttribute("spellcheck")).toBe("false");
    });

    it("says the panel sends the whole document, and does not call https unencrypted", async () => {
        await openAiSection("");
        const privacy = screen.getByText(/Privacy:/).closest("p")!;
        expect(privacy.textContent).toMatch(/whole open document/);
        expect(privacy.textContent).toMatch(/chat history/);
        expect(privacy.textContent).not.toMatch(/selected text is sent unencrypted/);
    });
});
