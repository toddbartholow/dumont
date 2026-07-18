/**
 * AI assist — minimal OpenAI-compatible client.
 *
 * Calls the user-configured endpoint with a system prompt and the selected
 * text. Supports endpoints that follow the OpenAI Chat Completions schema:
 *   POST /chat/completions
 *   { model, messages: [{role, content}] }
 *   → { choices: [{ message: { content } }] }
 *
 * Local providers like Ollama (with /v1 prefix) and llama.cpp expose the same
 * shape, so this works for fully-local setups too.
 *
 * Requests go through the Rust transport (aiTransport) rather than fetch —
 * see the comment there for why (CORS/CSP, AI-01).
 */

import { aiFetch, type AiHttpResponse } from "./aiTransport";

export type AIAction = "rewrite" | "shorten" | "expand" | "continue" | "translate";

const SYSTEM_PROMPTS: Record<AIAction, string> = {
    rewrite: "Rewrite the user's text for clarity and flow. Output the rewritten text only — no preface, no quotes, no explanation.",
    shorten: "Shorten the user's text to about half the length while keeping the meaning. Output the shortened text only.",
    expand: "Expand the user's text with more detail and context. Output the expanded text only.",
    continue: "Continue writing in the same style and tone. Output only the continuation, not the original.",
    translate: "Translate the user's text to English. Output the translation only.",
};

export interface AIConfig {
    endpoint: string;
    model: string;
}

/** Hard timeout for an AI request. A misconfigured endpoint or a stuck local
 *  llama.cpp process otherwise leaves the bubble spinning forever; 60s is
 *  long enough for slow local models on first load but short enough that the
 *  user gets a clear error rather than a frozen UI. */
const AI_REQUEST_TIMEOUT_MS = 60_000;

/** Cap on what we accept back from the AI. Pasting hundreds of MB of model
 *  output into the editor would freeze the textarea/preview; a 200 KB ceiling
 *  covers any reasonable rewrite/expand and matches what a sane chat
 *  completion returns. */
const AI_MAX_OUTPUT_CHARS = 200_000;

/** True when the URL is well-formed and uses http(s). */
export function isValidEndpoint(raw: string): boolean {
    try {
        const u = new URL(raw);
        return u.protocol === "http:" || u.protocol === "https:";
    } catch {
        return false;
    }
}

export async function runAIAction(
    action: AIAction,
    text: string,
    cfg: AIConfig,
    signal?: AbortSignal
): Promise<string> {
    if (!cfg.endpoint) throw new Error("AI endpoint not configured. Open Settings → AI to set one up.");
    if (!isValidEndpoint(cfg.endpoint)) {
        throw new Error("AI endpoint must be a valid http:// or https:// URL.");
    }
    if (!cfg.model) throw new Error("AI model not configured.");

    let res: AiHttpResponse;
    try {
        res = await aiFetch(
            cfg.endpoint,
            JSON.stringify({
                model: cfg.model,
                messages: [
                    { role: "system", content: SYSTEM_PROMPTS[action] },
                    { role: "user", content: text },
                ],
                temperature: 0.7,
                stream: false,
            }),
            // Non-streaming request: the 60s budget covers the whole exchange
            // (totalTimeoutMs), not just time-to-headers.
            { signal, connectTimeoutMs: AI_REQUEST_TIMEOUT_MS, totalTimeoutMs: AI_REQUEST_TIMEOUT_MS }
        );
    } catch (e) {
        // Surface a timeout specifically so the user doesn't see a generic
        // error and think the endpoint rejected them. User aborts arrive as
        // AbortError (whose message never contains "timed out") and rethrow.
        if (e instanceof Error && e.message.includes("timed out")) {
            throw new Error(`AI request timed out after ${AI_REQUEST_TIMEOUT_MS / 1000}s.`, { cause: e });
        }
        throw e;
    }

    const ok = res.status >= 200 && res.status < 300;
    if (!ok) {
        // Map common HTTP statuses to actionable messages instead of dumping a
        // raw status + body the user can't interpret (AI-04). The body snippet
        // is appended on a second line for debugging when present.
        const detail = res.body.trim().slice(0, 200);
        let msg: string;
        if (res.status === 401 || res.status === 403) {
            msg = "API key invalid or unauthorized — check Settings → AI.";
        } else if (res.status === 404) {
            msg = "Endpoint not found (404) — check the URL in Settings → AI.";
        } else if (res.status === 429) {
            msg = "Rate limited (429) — wait a moment and try again.";
        } else if (res.status >= 500) {
            msg = `AI service unavailable (${res.status}). Try again later.`;
        } else {
            msg = `AI request failed (${res.status}).`;
        }
        throw new Error(detail ? `${msg}\n${detail}` : msg);
    }

    const data = JSON.parse(res.body);
    const content =
        data?.choices?.[0]?.message?.content ??
        data?.message?.content ?? // ollama native shape, also handled
        "";
    if (!content) throw new Error("AI returned an empty response.");
    const out = String(content).trim();
    // Truncate runaway responses. Markdown editors don't need megabyte-scale
    // suggestions, and pasting one in tanks input latency for a long time.
    if (out.length > AI_MAX_OUTPUT_CHARS) {
        return out.slice(0, AI_MAX_OUTPUT_CHARS) + "\n\n[Response truncated]";
    }
    return out;
}
