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
//!
//! Nothing the endpoint sends is trusted to be small or to end. A response is
//! held to a line length and a total size, an error body is cut to the part
//! the error message shows, and a stream that goes quiet is ended by an idle
//! timeout (see `pump`). AI-07.

use std::collections::HashMap;
use std::fmt::Display;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use futures_util::{Stream, StreamExt};
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

/// The longest line held while waiting for its newline. One SSE frame is one
/// `data:` line, and a non-streamed completion is usually the whole body on
/// one line, so this is also the largest such completion accepted.
const MAX_LINE_BYTES: usize = 8 * 1024 * 1024;
/// The most one response may send in total.
const MAX_BODY_BYTES: usize = 32 * 1024 * 1024;
/// A non-2xx body is read only for the snippet the error message shows (the
/// frontend uses its first 200 characters), so the rest is not worth holding.
const MAX_ERROR_BODY_BYTES: usize = 64 * 1024;

/// The error an idle timeout ends a request with. A contract with the frontend
/// (aiChat.ts), which turns it into its own message.
const STALLED: &str = "stalled";

/// Forward a response body to `emit` as whole lines, within the limits above.
///
/// Before these limits, every byte was appended to one buffer that was drained
/// only at a newline, so a body without one (a misconfigured endpoint, a proxy
/// serving a binary) grew it until the app ran out of memory, and the frontend
/// kept a second copy. With `error_body` set the body is kept only up to
/// `MAX_ERROR_BODY_BYTES` and delivered in one piece, and anything past that
/// is not read at all.
///
/// `idle`, if given, ends the request when no data arrives for that long. It
/// restarts on every chunk, so a slow generation is never cut off while it is
/// still producing; the user's Stop button covers one that is merely long.
async fn pump<S, B, E>(
    stream: S,
    error_body: bool,
    idle: Option<Duration>,
    mut emit: impl FnMut(String),
) -> Result<(), String>
where
    S: Stream<Item = Result<B, E>>,
    B: AsRef<[u8]>,
    E: Display,
{
    let mut stream = std::pin::pin!(stream);
    let mut buf: Vec<u8> = Vec::new();
    let mut total = 0usize;
    loop {
        let next = match idle {
            Some(d) => tokio::time::timeout(d, stream.next())
                .await
                .map_err(|_| STALLED.to_string())?,
            None => stream.next().await,
        };
        let Some(chunk) = next else { break };
        let chunk = chunk.map_err(|e| format!("AI response stream failed: {e}"))?;
        let bytes = chunk.as_ref();
        if error_body {
            let room = MAX_ERROR_BODY_BYTES - buf.len();
            buf.extend_from_slice(&bytes[..bytes.len().min(room)]);
            if buf.len() >= MAX_ERROR_BODY_BYTES {
                break;
            }
            continue;
        }
        total += bytes.len();
        if total > MAX_BODY_BYTES {
            return Err(format!(
                "The AI response was larger than {} MB, so it was stopped.",
                MAX_BODY_BYTES / (1024 * 1024)
            ));
        }
        buf.extend_from_slice(bytes);
        if let Some(lines) = take_complete_lines(&mut buf) {
            emit(lines);
        }
        if buf.len() > MAX_LINE_BYTES {
            return Err(format!(
                "The AI response sent more than {} MB without a line break, so it was stopped.",
                MAX_LINE_BYTES / (1024 * 1024)
            ));
        }
    }
    if let Some(rest) = flush_remainder(&mut buf) {
        emit(rest);
    }
    Ok(())
}

/// The request proper: send, report the status, stream the body line-wise.
/// Non-2xx statuses are NOT errors here — the body still streams so the
/// frontend can map the status + body snippet to its existing messages.
///
/// Events go to `emit` rather than straight to a `Channel`, so the tests can
/// run a real request against a local server and read what it would send.
async fn run_request(
    endpoint: &str,
    api_key: Option<String>,
    body: String,
    connect_timeout_ms: u64,
    total_timeout_ms: Option<u64>,
    idle_timeout_ms: Option<u64>,
    mut emit: impl FnMut(AiEvent),
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

        let status = resp.status();
        emit(AiEvent::Status {
            status: status.as_u16(),
        });

        pump(
            resp.bytes_stream(),
            !status.is_success(),
            idle_timeout_ms.map(Duration::from_millis),
            |data| emit(AiEvent::Chunk { data }),
        )
        .await?;
        emit(AiEvent::Done);
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
// bundling them into a struct would only move the same eight fields around.
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
    idle_timeout_ms: Option<u64>,
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

    let request = run_request(
        &endpoint,
        api_key,
        body,
        connect_timeout_ms,
        total_timeout_ms,
        idle_timeout_ms,
        |event| {
            let _ = channel.send(event);
        },
    );
    run_cancellable(&state, id, request).await
}

/// Run `request` under cancellation handle `id`, so `cancel(id)` can end it.
/// Split out of `ai_request` so the tests can drive it without a Tauri `State`.
async fn run_cancellable(
    cancels: &AiCancel,
    id: u32,
    request: impl std::future::Future<Output = Result<(), String>>,
) -> Result<(), String> {
    let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel::<()>();
    cancels.0.lock().unwrap().insert(id, cancel_tx);

    // "cancelled" is a contract with the frontend transport: it maps exactly
    // that string to an AbortError so a user cancel isn't shown as a failure.
    let result = tokio::select! {
        _ = cancel_rx => Err("cancelled".to_string()),
        r = request => r,
    };

    // Single removal point: the select above is the only way out of the
    // request, so this covers success, error, timeout, and cancellation.
    cancels.0.lock().unwrap().remove(&id);
    result
}

/// Fire the cancellation handle for `id`, if that request is still running.
fn cancel(cancels: &AiCancel, id: u32) {
    // A missing id just means the request already finished — races are fine.
    if let Some(tx) = cancels.0.lock().unwrap().remove(&id) {
        let _ = tx.send(());
    }
}

#[tauri::command]
pub async fn ai_cancel(state: tauri::State<'_, AiCancel>, id: u32) -> Result<(), String> {
    cancel(&state, id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        cancel, flush_remainder, pump, run_cancellable, run_request, take_complete_lines, AiCancel,
        AiEvent, MAX_BODY_BYTES, MAX_ERROR_BODY_BYTES, MAX_LINE_BYTES, STALLED,
    };
    use futures_util::{stream, StreamExt};
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn block_on<F: std::future::Future>(f: F) -> F::Output {
        // Plain current-thread runtime, as in commands.rs: no #[tokio::test] here.
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(f)
    }

    type Chunk = Result<Vec<u8>, std::io::Error>;

    /// Run `pump` over `chunks` and collect what it forwards.
    fn pump_all(
        chunks: impl futures_util::Stream<Item = Chunk>,
        error_body: bool,
        idle: Option<Duration>,
    ) -> (Result<(), String>, Vec<String>) {
        let mut out = Vec::new();
        let r = block_on(pump(chunks, error_body, idle, |s| out.push(s)));
        (r, out)
    }

    #[test]
    fn pump_forwards_whole_lines_and_the_remainder() {
        let chunks = stream::iter(vec![
            Ok(b"data: a\nda".to_vec()),
            Ok(b"ta: b\ntail".to_vec()),
        ]);
        let (r, out) = pump_all(chunks, false, None);
        assert_eq!(r, Ok(()));
        assert_eq!(out, vec!["data: a\n", "data: b\n", "tail"]);
    }

    #[test]
    fn an_oversized_frame_stops_the_request() {
        let mut frame = b"data: ".to_vec();
        frame.resize(MAX_LINE_BYTES + 1, b'x');
        let (r, out) = pump_all(stream::iter(vec![Ok(frame)]), false, None);
        assert!(r.unwrap_err().contains("without a line break"));
        assert!(out.is_empty());
    }

    // The case the line cap exists for: no newline, ever. Before it, the buffer took
    // every byte the endpoint cared to send.
    #[test]
    fn an_endless_body_with_no_newline_is_cut_off_at_the_line_cap() {
        let mut pulled = 0usize;
        let chunks = stream::iter(std::iter::repeat_with(|| {
            pulled += 1;
            Ok(vec![b'x'; 1024 * 1024])
        }));
        let (r, _) = pump_all(chunks, false, None);
        assert!(r.unwrap_err().contains("without a line break"));
        assert_eq!(pulled, MAX_LINE_BYTES / (1024 * 1024) + 1);
    }

    #[test]
    fn a_body_past_the_total_cap_stops_the_request_even_in_whole_lines() {
        let mut line = vec![b'x'; 1024 * 1024 - 1];
        line.push(b'\n');
        let n = MAX_BODY_BYTES / line.len() + 1;
        let chunks = stream::iter((0..n).map(move |_| Ok(line.clone())));
        let (r, out) = pump_all(chunks, false, None);
        assert!(r.unwrap_err().contains("larger than 32 MB"));
        assert!(out.len() < n);
    }

    #[test]
    fn a_large_error_body_is_cut_to_the_snippet_and_delivered_once() {
        let chunks = stream::iter((0..20).map(|_| Ok(vec![b'e'; 16 * 1024])));
        let (r, out) = pump_all(chunks, true, None);
        assert_eq!(r, Ok(()));
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].len(), MAX_ERROR_BODY_BYTES);
    }

    // The idle timeout restarts on each chunk: a generation that is slow but steady
    // runs as long as it keeps producing, here several times the timeout in total.
    #[test]
    fn a_slow_but_steady_stream_is_not_cut_off() {
        let chunks = stream::unfold(0, |i| async move {
            if i == 8 {
                return None;
            }
            tokio::time::sleep(Duration::from_millis(40)).await;
            Some((Ok(format!("data: {i}\n").into_bytes()), i + 1))
        });
        let (r, out) = pump_all(chunks, false, Some(Duration::from_millis(150)));
        assert_eq!(r, Ok(()));
        assert_eq!(out.len(), 8);
    }

    #[test]
    fn a_stalled_stream_ends_with_the_stalled_error() {
        let chunks = stream::iter(vec![Ok(b"data: first\n".to_vec())]).chain(stream::pending());
        let (r, out) = pump_all(chunks, false, Some(Duration::from_millis(100)));
        assert_eq!(r, Err(STALLED.to_string()));
        assert_eq!(out, vec!["data: first\n"]);
    }

    /// Serve one request on a local port with `response` (raw HTTP, the body ending at
    /// close) and return the endpoint URL.
    async fn serve_once(response: Vec<u8>) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut req = [0u8; 4096];
            let _ = sock.read(&mut req).await;
            let _ = sock.write_all(&response).await;
            let _ = sock.shutdown().await;
        });
        format!("http://{addr}/v1/chat/completions")
    }

    fn http(status: &str, body: &[u8]) -> Vec<u8> {
        let mut r = format!(
            "HTTP/1.1 {status}\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n"
        )
        .into_bytes();
        r.extend_from_slice(body);
        r
    }

    /// Serve `response` and run one real request against it, in ONE runtime: the
    /// server is a task, and it would die with a runtime of its own.
    fn request(response: Vec<u8>) -> (Result<(), String>, Vec<AiEvent>) {
        let mut events = Vec::new();
        let r = block_on(async {
            let endpoint = serve_once(response).await;
            run_request(&endpoint, None, "{}".into(), 5_000, None, Some(5_000), |e| {
                events.push(e)
            })
            .await
        });
        (r, events)
    }

    #[test]
    fn a_real_request_streams_status_lines_and_done() {
        let (r, events) = request(http("200 OK", b"data: one\ndata: [DONE]\n"));
        assert_eq!(r, Ok(()));
        assert!(matches!(events.first(), Some(AiEvent::Status { status: 200 })));
        let body: String = events
            .iter()
            .filter_map(|e| match e {
                AiEvent::Chunk { data } => Some(data.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(body, "data: one\ndata: [DONE]\n");
        assert!(matches!(events.last(), Some(AiEvent::Done)));
    }

    #[test]
    fn a_real_error_response_with_a_huge_body_is_truncated() {
        let (r, events) = request(http("500 Internal Server Error", &vec![b'e'; 1024 * 1024]));
        assert_eq!(r, Ok(()));
        assert!(matches!(events.first(), Some(AiEvent::Status { status: 500 })));
        let sizes: Vec<usize> = events
            .iter()
            .filter_map(|e| match e {
                AiEvent::Chunk { data } => Some(data.len()),
                _ => None,
            })
            .collect();
        assert_eq!(sizes, vec![MAX_ERROR_BODY_BYTES]);
    }

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

    /// Serve the headers and one SSE line, then hold the connection open without a
    /// further byte: a generation still in progress, as far as the client can tell.
    async fn serve_then_hang() -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut req = [0u8; 4096];
            let _ = sock.read(&mut req).await;
            let _ = sock.write_all(&http("200 OK", b"data: first\n")).await;
            let _ = sock.flush().await;
            tokio::time::sleep(Duration::from_secs(60)).await;
            drop(sock);
        });
        format!("http://{addr}/v1/chat/completions")
    }

    // The Stop button. A real request mid-stream is ended by cancel(), promptly and with
    // the exact "cancelled" the frontend turns into an AbortError, and its handle is gone
    // afterwards so a second cancel is a no-op.
    #[test]
    fn cancel_ends_a_request_mid_stream() {
        let cancels = AiCancel::default();
        let mut events = Vec::new();
        let started = std::time::Instant::now();
        let r = block_on(async {
            let endpoint = serve_then_hang().await;
            // No idle timeout: only the cancel can end this request.
            let request = run_request(&endpoint, None, "{}".into(), 5_000, None, None, |e| {
                // Stop as soon as the first line is in, as a user would mid-reply.
                if matches!(e, AiEvent::Chunk { .. }) {
                    cancel(&cancels, 7);
                }
                events.push(e);
            });
            run_cancellable(&cancels, 7, request).await
        });
        assert_eq!(r, Err("cancelled".to_string()));
        assert!(started.elapsed() < Duration::from_secs(10));
        assert!(events.iter().any(|e| matches!(e, AiEvent::Chunk { .. })));
        assert!(!events.iter().any(|e| matches!(e, AiEvent::Done)));
        assert!(cancels.0.lock().unwrap().is_empty());
        cancel(&cancels, 7);
    }

    #[test]
    fn a_finished_request_leaves_no_handle_and_ignores_a_late_cancel() {
        let cancels = AiCancel::default();
        let r = block_on(run_cancellable(&cancels, 3, async { Ok(()) }));
        assert_eq!(r, Ok(()));
        assert!(cancels.0.lock().unwrap().is_empty());
        // The frontend's abort can lose the race with the response; that is not an error.
        cancel(&cancels, 3);
    }

    // Cancelling one request leaves another running.
    #[test]
    fn cancel_ends_only_the_request_it_names() {
        let cancels = AiCancel::default();
        let (a, b) = block_on(async {
            let slow = async {
                tokio::time::sleep(Duration::from_millis(200)).await;
                Ok(())
            };
            let named = async {
                tokio::time::sleep(Duration::from_millis(20)).await;
                cancel(&cancels, 1);
                tokio::time::sleep(Duration::from_secs(60)).await;
                Ok(())
            };
            tokio::join!(run_cancellable(&cancels, 1, named), run_cancellable(&cancels, 2, slow))
        });
        assert_eq!(a, Err("cancelled".to_string()));
        assert_eq!(b, Ok(()));
    }
}
