import { describe, it, expect } from "vitest";
import { isLoopbackHost, isPlainHttpToRemoteHost } from "./aiEndpoint";

describe("isLoopbackHost", () => {
    it.each([
        "localhost",
        "LOCALHOST",
        "localhost.",
        "app.localhost",
        "a.b.localhost",
        "127.0.0.1",
        "127.255.255.254",
        "127.1.2.3",
        "::1",
        "[::1]",
    ])("treats %s as loopback", (host) => {
        expect(isLoopbackHost(host)).toBe(true);
    });

    it.each([
        "example.com",
        "localhost.example.com",
        "notlocalhost",
        "128.0.0.1",
        "10.0.0.5",
        "192.168.1.10",
        "0.0.0.0",
        "127.0.0.256",
        "[::2]",
        "[2001:db8::1]",
        "",
    ])("treats %s as remote", (host) => {
        expect(isLoopbackHost(host)).toBe(false);
    });
});

describe("isPlainHttpToRemoteHost", () => {
    it.each([
        "http://example.com/v1/chat/completions",
        "http://192.168.1.10:11434/v1/chat/completions",
        "HTTP://Example.com/v1",
        "http://localhost.example.com/v1",
        "  http://example.com/v1  ",
    ])("flags %s", (endpoint) => {
        expect(isPlainHttpToRemoteHost(endpoint)).toBe(true);
    });

    it.each([
        // Loopback over http is fine: the key never leaves the machine.
        "http://localhost:11434/v1/chat/completions",
        "http://127.0.0.1:1234/v1/chat/completions",
        "http://127.1:1234/v1",
        "http://[::1]:8080/v1",
        "http://ollama.localhost/v1",
        // https is encrypted wherever it goes.
        "https://api.openai.com/v1/chat/completions",
        "https://192.168.1.10/v1",
        // Not a URL: the endpoint field reports that on its own.
        "",
        "not a url",
        "ftp://example.com/",
    ])("does not flag %s", (endpoint) => {
        expect(isPlainHttpToRemoteHost(endpoint)).toBe(false);
    });
});
