/**
 * Where an AI endpoint points, as far as the API key is concerned.
 *
 * Over plain http the key travels in the clear. That is fine for a server on this
 * machine (Ollama, LM Studio) and not fine for one anywhere else, so the Rust side
 * refuses to attach a saved key to a plain-http request for a non-loopback host.
 * Settings uses this to say so before the user runs into it.
 */

/** Loopback: 127.0.0.0/8, ::1, `localhost` and any `*.localhost` name. */
export function isLoopbackHost(hostname: string): boolean {
    // URL keeps the brackets on an IPv6 host ("[::1]") and a fully qualified
    // name may end in a dot ("localhost.").
    let host = hostname.toLowerCase();
    if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
    if (host.endsWith(".")) host = host.slice(0, -1);
    if (host === "localhost" || host.endsWith(".localhost")) return true;
    if (host === "::1") return true;
    const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
    return !!v4 && Number(v4[1]) === 127 && v4.slice(1).every((n) => Number(n) <= 255);
}

/**
 * True when `endpoint` is a plain `http://` URL to a host other than this
 * machine: the case where a saved key will not be sent. An https endpoint, a
 * loopback one, or text that is not a URL at all is false; the endpoint field
 * reports a malformed URL on its own.
 */
export function isPlainHttpToRemoteHost(endpoint: string): boolean {
    let url: URL;
    try {
        url = new URL(endpoint.trim());
    } catch {
        return false;
    }
    // URL normalizes the host first, so "127.1" and "0x7f.0.0.1" arrive here as
    // "127.0.0.1", and an uppercase scheme as "http:".
    return url.protocol === "http:" && !isLoopbackHost(url.hostname);
}
