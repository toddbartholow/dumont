// Modified by IRQ Studio, LLC (2026) from an Apache-2.0 licensed original.
// See NOTICE for attribution and license terms.

/**
 * The Content-Security-Policy is the second, independent layer under the Markdown
 * sanitizer (see xssSanitize.test.tsx and .claude/security-audit.md). Even if a
 * script ever reached the webview, `script-src 'self'` stops it from running. That
 * makes this one line load-bearing: with arbitrary file read and write exposed over
 * IPC, script execution in the webview is host RCE.
 *
 * This test reads the shipped config, so relaxing the CSP is a deliberate,
 * reviewable change to this assertion rather than a one-word edit in a JSON file
 * nobody re-reads.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Resolved from the repo root (vitest's cwd), because vite rewrites import.meta.url
// to a non-file scheme under transform, so fileURLToPath rejects it.
const conf = JSON.parse(
    readFileSync(resolve(process.cwd(), "src-tauri/tauri.conf.json"), "utf8"),
) as { app?: { security?: { csp?: string } } };

/** Split a CSP string into `directive -> [values]`. */
function directives(csp: string): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const part of csp.split(";").map((p) => p.trim()).filter(Boolean)) {
        const [name, ...values] = part.split(/\s+/);
        out[name] = values;
    }
    return out;
}

describe("the CSP is a release-gating invariant", () => {
    const csp = conf.app?.security?.csp;

    it("defines a CSP at all", () => {
        expect(typeof csp).toBe("string");
    });

    it("keeps script-src exactly 'self': no unsafe-inline, no unsafe-eval, no remote host", () => {
        // The whole RCE posture rests here. 'unsafe-inline'/'unsafe-eval', a nonce,
        // or an extra host would let injected or remote script run with the app's
        // filesystem access. If a real need ever arises, change this on purpose.
        expect(directives(csp!)["script-src"]).toEqual(["'self'"]);
    });

    it("keeps object-src 'none', so no plugin or embed can become a script sink", () => {
        expect(directives(csp!)["object-src"]).toEqual(["'none'"]);
    });

    it("keeps connect-src off bare https:, denying a webview XSS a ready exfiltration channel", () => {
        // AI traffic and the updater both run through Rust (reqwest), not webview
        // fetch, and the single webview fetch only reads blob: URLs when inlining
        // export images. A wildcard `https:` here would grant no feature and would
        // just be an outbound channel if script ever ran. localhost stays for a
        // local AI endpoint reached during a "test connection" round-trip.
        const connect = directives(csp!)["connect-src"] ?? [];
        expect(connect).not.toContain("https:");
        expect(connect).toContain("'self'");
    });
});
