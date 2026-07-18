//! Native HTTP transport for AI requests (AI-01).
//!
//! The webview's `fetch` runs from origin `https://tauri.localhost`, so every
//! call to an AI endpoint is cross-origin and most OpenAI-compatible servers
//! fail the CORS preflight the browser requires (curl has no CORS, hence
//! "works in curl but not in the app"); plain-http LAN endpoints are
//! additionally blocked by the CSP. Routing the request through reqwest here
//! gives curl parity: anything curl can reach, the AI panel can reach.
//!
//! Responses are streamed back to the frontend over a `Channel` as whole
//! lines, so the existing SSE parsing there keeps working unchanged.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use futures_util::StreamExt;
use tauri::ipc::Channel;

use crate::commands;

#[derive(Clone, serde::Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AiEvent {
    Status { status: u16 },
    Chunk { data: String },
    Done,
}

/// In-flight request cancellation handles, keyed by the frontend-chosen
/// request id. Firing (or dropping) a sender aborts that request's
/// `tokio::select!` below.
#[derive(Default)]
pub struct AiCancel(Mutex<HashMap<u32, tokio::sync::oneshot::Sender<()>>>);

/// One shared client so connection pools / TLS sessions are reused across
/// requests instead of being rebuilt per call.
fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(reqwest::Client::new)
}

/// Split off every complete line in `buf` (up to and including the last
/// `\n`), leaving any trailing partial line buffered. Forwarding only whole
/// lines means the frontend's line-oriented SSE parser never sees a JSON
/// payload cut mid-way. `from_utf8_lossy` is safe here: `\n` is ASCII, so a
/// multi-byte UTF-8 character can never straddle the split point.
fn take_complete_lines(buf: &mut Vec<u8>) -> Option<String> {
    let cut = buf.iter().rposition(|&b| b == b'\n')? + 1;
    let complete: Vec<u8> = buf.drain(..cut).collect();
    Some(String::from_utf8_lossy(&complete).into_owned())
}

/// Drain whatever is left after the stream ends (a body with no trailing
/// newline, e.g. a non-streamed JSON response).
fn flush_remainder(buf: &mut Vec<u8>) -> Option<String> {
    if buf.is_empty() {
        return None;
    }
    let rest = std::mem::take(buf);
    Some(String::from_utf8_lossy(&rest).into_owned())
}

/// The request proper: send, report the status, stream the body line-wise.
/// Non-2xx statuses are NOT errors here — the body still streams so the
/// frontend can map the status + body snippet to its existing messages.
async fn run_request(
    endpoint: &str,
    api_key: Option<String>,
    body: String,
    connect_timeout_ms: u64,
    total_timeout_ms: Option<u64>,
    channel: &Channel<AiEvent>,
) -> Result<(), String> {
    let fut = async {
        let mut req = client()
            .post(endpoint)
            .header("Content-Type", "application/json")
            .body(body);
        if let Some(key) = api_key.filter(|k| !k.is_empty()) {
            req = req.header("Authorization", format!("Bearer {key}"));
        }

        // The connect timeout guards until the response HEADERS arrive; a slow
        // generation after that is legitimate and must not be cut off.
        let resp = tokio::time::timeout(Duration::from_millis(connect_timeout_ms), req.send())
            .await
            .map_err(|_| "timed out".to_string())?
            .map_err(|e| format!("Could not reach the AI endpoint: {e}"))?;

        let _ = channel.send(AiEvent::Status {
            status: resp.status().as_u16(),
        });

        let mut stream = resp.bytes_stream();
        let mut buf: Vec<u8> = Vec::new();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| format!("AI response stream failed: {e}"))?;
            buf.extend_from_slice(&chunk);
            if let Some(lines) = take_complete_lines(&mut buf) {
                let _ = channel.send(AiEvent::Chunk { data: lines });
            }
        }
        if let Some(rest) = flush_remainder(&mut buf) {
            let _ = channel.send(AiEvent::Chunk { data: rest });
        }
        let _ = channel.send(AiEvent::Done);
        Ok(())
    };

    match total_timeout_ms {
        Some(total) => tokio::time::timeout(Duration::from_millis(total), fut)
            .await
            .map_err(|_| "timed out".to_string())?,
        None => fut.await,
    }
}

// The parameter list mirrors the IPC contract with aiTransport.ts one-to-one;
// bundling them into a struct would only move the same seven fields around.
//
// There is deliberately no `api_key` parameter. The key lives in the OS keychain
// and is read HERE, in Rust (see below), never handed to the webview: an earlier
// design returned it over IPC via `get_ai_key`, so any webview XSS could read it.
// Rust attaches the `Authorization` header itself; the key never crosses back.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn ai_request(
    state: tauri::State<'_, AiCancel>,
    id: u32,
    endpoint: String,
    body: String,
    connect_timeout_ms: u64,
    total_timeout_ms: Option<u64>,
    channel: Channel<AiEvent>,
) -> Result<(), String> {
    // The frontend validates too, but the endpoint is user-configured input
    // crossing a trust boundary, so re-check here (defense in depth).
    let valid = reqwest::Url::parse(&endpoint)
        .map(|u| matches!(u.scheme(), "http" | "https"))
        .unwrap_or(false);
    if !valid {
        return Err("AI endpoint must be a valid http:// or https:// URL.".to_string());
    }

    // Read the key from the keychain on the blocking pool. The read is blocking
    // and, on unsigned macOS builds, can raise an UNBOUNDED permission prompt, so
    // it must not run on this async task's runtime thread. `Ok(None)` (no key, or
    // an empty one) proceeds WITHOUT an Authorization header, which is exactly what
    // a local endpoint like Ollama wants; a real keychain error is surfaced rather
    // than sent on as a silent 401.
    let api_key = match tokio::task::spawn_blocking(commands::read_ai_key).await {
        Ok(Ok(key)) => key,
        Ok(Err(e)) => {
            return Err(format!("Could not read the AI API key from the keychain: {e}"));
        }
        Err(e) => {
            return Err(format!("Could not read the AI API key from the keychain: {e}"));
        }
    };

    let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel::<()>();
    state.0.lock().unwrap().insert(id, cancel_tx);

    // "cancelled" is a contract with the frontend transport: it maps exactly
    // that string to an AbortError so a user cancel isn't shown as a failure.
    let result = tokio::select! {
        _ = cancel_rx => Err("cancelled".to_string()),
        r = run_request(&endpoint, api_key, body, connect_timeout_ms, total_timeout_ms, &channel) => r,
    };

    // Single removal point: the select above is the only way out of the
    // request, so this covers success, error, timeout, and cancellation.
    state.0.lock().unwrap().remove(&id);
    result
}

#[tauri::command]
pub async fn ai_cancel(state: tauri::State<'_, AiCancel>, id: u32) -> Result<(), String> {
    // A missing id just means the request already finished — races are fine.
    if let Some(tx) = state.0.lock().unwrap().remove(&id) {
        let _ = tx.send(());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{flush_remainder, take_complete_lines};

    #[test]
    fn no_newline_returns_none_and_keeps_buffer() {
        let mut buf = b"partial line".to_vec();
        assert_eq!(take_complete_lines(&mut buf), None);
        assert_eq!(buf, b"partial line");
    }

    #[test]
    fn splits_complete_lines_from_trailing_partial() {
        let mut buf = b"data: one\ndata: two\ndata: thr".to_vec();
        assert_eq!(
            take_complete_lines(&mut buf),
            Some("data: one\ndata: two\n".to_string())
        );
        assert_eq!(buf, b"data: thr");
    }

    #[test]
    fn multibyte_char_split_across_chunks_survives() {
        // "é" is 0xC3 0xA9; a network chunk boundary can fall between the two
        // bytes. The partial byte must stay buffered (no lossy replacement)
        // until its line completes.
        let mut buf = b"line one\n\xC3".to_vec();
        assert_eq!(take_complete_lines(&mut buf), Some("line one\n".to_string()));
        assert_eq!(buf, b"\xC3");

        buf.extend_from_slice(b"\xA9 end\n");
        assert_eq!(take_complete_lines(&mut buf), Some("é end\n".to_string()));
        assert!(buf.is_empty());
    }

    #[test]
    fn flush_returns_remainder_once() {
        let mut buf = b"{\"no\":\"newline\"}".to_vec();
        assert_eq!(
            flush_remainder(&mut buf),
            Some("{\"no\":\"newline\"}".to_string())
        );
        assert!(buf.is_empty());
        assert_eq!(flush_remainder(&mut buf), None);
    }
}
