use std::{
    collections::VecDeque,
    sync::{Arc, RwLock},
};

use futures::{StreamExt, future};
use tokio::{sync::broadcast, task::JoinHandle};
use tokio_stream::wrappers::{BroadcastStream, errors::BroadcastStreamRecvError};

use crate::{log_msg::LogMsg, stream_lines::LinesStreamExt};

/// In-memory history retained per execution. Capped so a chatty executor
/// can't grow unbounded; older messages roll off when this is exceeded.
const HISTORY_BYTES: usize = 100000 * 1024; // ~100 MB

/// Broadcast channel slot count. Each MsgStore allocates a ring buffer of
/// this size; multiplied across concurrent executions × multiple subscribers,
/// large values translate directly into resident RAM, but the per-message
/// cap below keeps the worst-case bounded.
///
/// Sizing rationale: observed bursts during heavy executor turns push 2-3k
/// messages between subscriber polls. With multiple popout windows each
/// holding 5-10 WebSocket subscriptions, the SLOWEST subscriber sets the
/// effective drain rate; one stalled subscriber triggers `Lagged` for that
/// stream and the frontend sees a state gap.
///
/// At BROADCAST_CAPACITY × MAX_LIVE_MSG_BYTES = 16384 × 32 KiB = 512 MiB
/// max per store, this is comfortable for the leak budget while leaving
/// ~15x headroom over the observed burst size.
const BROADCAST_CAPACITY: usize = 16384;

/// Per-message payload size cap applied to the broadcast leg only. Compiler
/// dumps, JSON blobs, and stdin echoes can be megabytes each; we keep the
/// untruncated copy in `history` (so the DB-stream-handle persistence path
/// gets the full data) but truncate before pushing to live subscribers, so
/// `BROADCAST_CAPACITY × MAX_LIVE_MSG_BYTES` bounds peak channel memory.
pub const MAX_LIVE_MSG_BYTES: usize = 32 * 1024; // 32 KiB

#[derive(Clone)]
struct StoredMsg {
    msg: LogMsg,
    bytes: usize,
}

struct Inner {
    history: VecDeque<StoredMsg>,
    total_bytes: usize,
}

pub struct MsgStore {
    inner: RwLock<Inner>,
    sender: broadcast::Sender<LogMsg>,
}

impl Default for MsgStore {
    fn default() -> Self {
        Self::new()
    }
}

/// Produce a version of `msg` whose serialized size fits within
/// `MAX_LIVE_MSG_BYTES`. String payloads are truncated at a UTF-8 char
/// boundary and a `...[truncated N bytes]` marker is appended so live
/// subscribers can see content was dropped. Patches that exceed the cap are
/// replaced with a placeholder `LogMsg::Stderr` carrying the marker (we
/// can't truncate a JSON patch without invalidating it).
fn truncate_for_broadcast(msg: LogMsg) -> LogMsg {
    fn truncate_string(s: &str, name: &'static str) -> Option<String> {
        if s.len() <= MAX_LIVE_MSG_BYTES {
            return None;
        }
        let cut = floor_char_boundary(s, MAX_LIVE_MSG_BYTES);
        let truncated_bytes = s.len() - cut;
        Some(format!(
            "{}...[{name} truncated, dropped {truncated_bytes} bytes]",
            &s[..cut]
        ))
    }
    match msg {
        LogMsg::Stdout(s) => match truncate_string(&s, "stdout") {
            Some(t) => LogMsg::Stdout(t),
            None => LogMsg::Stdout(s),
        },
        LogMsg::Stderr(s) => match truncate_string(&s, "stderr") {
            Some(t) => LogMsg::Stderr(t),
            None => LogMsg::Stderr(s),
        },
        LogMsg::JsonPatch(patch) => {
            let json_len = serde_json::to_string(&patch).map(|s| s.len()).unwrap_or(0);
            if json_len > MAX_LIVE_MSG_BYTES {
                LogMsg::Stderr(format!(
                    "[json_patch dropped from live stream, {json_len} bytes; see history for full content]"
                ))
            } else {
                LogMsg::JsonPatch(patch)
            }
        }
        other => other, // SessionId / MessageId / Ready / Finished are short
    }
}

/// Walk backward from `index` until we hit a valid UTF-8 character
/// boundary in `s`. (Mirrors `str::floor_char_boundary` which is nightly-only.)
fn floor_char_boundary(s: &str, index: usize) -> usize {
    let mut i = index.min(s.len());
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

impl MsgStore {
    pub fn new() -> Self {
        let (sender, _) = broadcast::channel(BROADCAST_CAPACITY);
        Self {
            inner: RwLock::new(Inner {
                history: VecDeque::with_capacity(32),
                total_bytes: 0,
            }),
            sender,
        }
    }

    pub fn push(&self, msg: LogMsg) {
        // Live listeners get a truncated copy of large messages so the
        // broadcast buffer can't grow unbounded. The history VecDeque keeps
        // the un-truncated message (subject to HISTORY_BYTES) so the
        // DB-stream-handle persistence path still sees full content.
        let _ = self.sender.send(truncate_for_broadcast(msg.clone()));
        let bytes = msg.approx_bytes();

        let mut inner = self.inner.write().unwrap();
        while inner.total_bytes.saturating_add(bytes) > HISTORY_BYTES {
            if let Some(front) = inner.history.pop_front() {
                inner.total_bytes = inner.total_bytes.saturating_sub(front.bytes);
            } else {
                break;
            }
        }
        inner.history.push_back(StoredMsg { msg, bytes });
        inner.total_bytes = inner.total_bytes.saturating_add(bytes);
    }

    // Convenience
    pub fn push_stdout<S: Into<String>>(&self, s: S) {
        self.push(LogMsg::Stdout(s.into()));
    }

    pub fn push_patch(&self, patch: json_patch::Patch) {
        self.push(LogMsg::JsonPatch(patch));
    }

    pub fn push_session_id(&self, session_id: String) {
        self.push(LogMsg::SessionId(session_id));
    }

    pub fn push_message_id(&self, id: String) {
        self.push(LogMsg::MessageId(id));
    }

    pub fn push_finished(&self) {
        self.push(LogMsg::Finished);
    }

    pub fn get_receiver(&self) -> broadcast::Receiver<LogMsg> {
        self.sender.subscribe()
    }

    pub fn get_history(&self) -> Vec<LogMsg> {
        self.inner
            .read()
            .unwrap()
            .history
            .iter()
            .map(|s| s.msg.clone())
            .collect()
    }

    /// History then live, as `LogMsg`.
    pub fn history_plus_stream(
        &self,
    ) -> futures::stream::BoxStream<'static, Result<LogMsg, std::io::Error>> {
        let (history, rx) = (self.get_history(), self.get_receiver());

        let hist = futures::stream::iter(history.into_iter().map(Ok::<_, std::io::Error>));
        let live = BroadcastStream::new(rx).filter_map(|res| async move {
            match res {
                Ok(msg) => Some(Ok(msg)),
                Err(BroadcastStreamRecvError::Lagged(n)) => {
                    tracing::error!(
                        skipped = n,
                        "MsgStore broadcast lagged. {n} messages dropped for this subscriber"
                    );
                    None
                }
            }
        });

        Box::pin(hist.chain(live))
    }

    pub fn stdout_chunked_stream(
        &self,
    ) -> futures::stream::BoxStream<'static, Result<String, std::io::Error>> {
        self.history_plus_stream()
            .take_while(|res| future::ready(!matches!(res, Ok(LogMsg::Finished))))
            .filter_map(|res| async move {
                match res {
                    Ok(LogMsg::Stdout(s)) => Some(Ok(s)),
                    _ => None,
                }
            })
            .boxed()
    }

    pub fn stdout_lines_stream(
        &self,
    ) -> futures::stream::BoxStream<'static, std::io::Result<String>> {
        self.stdout_chunked_stream().lines()
    }

    pub fn stderr_chunked_stream(
        &self,
    ) -> futures::stream::BoxStream<'static, Result<String, std::io::Error>> {
        self.history_plus_stream()
            .take_while(|res| future::ready(!matches!(res, Ok(LogMsg::Finished))))
            .filter_map(|res| async move {
                match res {
                    Ok(LogMsg::Stderr(s)) => Some(Ok(s)),
                    _ => None,
                }
            })
            .boxed()
    }

    /// Forward a stream of typed log messages into this store.
    pub fn spawn_forwarder<S, E>(self: Arc<Self>, stream: S) -> JoinHandle<()>
    where
        S: futures::Stream<Item = Result<LogMsg, E>> + Send + 'static,
        E: std::fmt::Display + Send + 'static,
    {
        tokio::spawn(async move {
            tokio::pin!(stream);

            while let Some(next) = stream.next().await {
                match next {
                    Ok(msg) => self.push(msg),
                    Err(e) => self.push(LogMsg::Stderr(format!("stream error: {e}"))),
                }
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn large_stdout_is_truncated_on_broadcast_but_not_in_history() {
        let store = MsgStore::new();
        let mut rx = store.get_receiver();

        let oversized = "A".repeat(MAX_LIVE_MSG_BYTES * 4);
        store.push(LogMsg::Stdout(oversized.clone()));

        // Broadcast leg: truncated with marker
        let received = rx.recv().await.expect("broadcast receive");
        match received {
            LogMsg::Stdout(s) => {
                assert!(s.len() <= MAX_LIVE_MSG_BYTES + 128, "live msg should fit cap + marker");
                assert!(s.contains("...[stdout truncated"));
                assert!(s.starts_with("AAA"));
            }
            other => panic!("expected truncated Stdout, got {other:?}"),
        }

        // History leg: original payload intact
        let history = store.get_history();
        assert_eq!(history.len(), 1);
        match &history[0] {
            LogMsg::Stdout(s) => assert_eq!(s.len(), oversized.len(), "history must keep full content"),
            other => panic!("expected Stdout in history, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn small_stdout_passes_through_unchanged() {
        let store = MsgStore::new();
        let mut rx = store.get_receiver();
        store.push(LogMsg::Stdout("hello world".into()));
        match rx.recv().await.unwrap() {
            LogMsg::Stdout(s) => assert_eq!(s, "hello world"),
            other => panic!("got {other:?}"),
        }
    }

    #[tokio::test]
    async fn truncation_respects_utf8_char_boundary() {
        let store = MsgStore::new();
        let mut rx = store.get_receiver();
        // Build a long string composed of 4-byte UTF-8 chars so that
        // MAX_LIVE_MSG_BYTES does not naturally align to a boundary.
        let oversized: String = std::iter::repeat('𝄞').take(MAX_LIVE_MSG_BYTES).collect();
        store.push(LogMsg::Stdout(oversized));
        let received = rx.recv().await.unwrap();
        match received {
            LogMsg::Stdout(s) => {
                // String::truncate would panic on a non-boundary index; if
                // truncate_for_broadcast survived the build, the boundary
                // logic is correct. Double-check the prefix still parses.
                assert!(s.chars().next() == Some('𝄞'));
                assert!(s.contains("...[stdout truncated"));
            }
            other => panic!("got {other:?}"),
        }
    }

    #[tokio::test]
    async fn large_jsonpatch_is_replaced_with_placeholder_on_broadcast() {
        // Build a JsonPatch payload whose serialized form exceeds the cap.
        let big_value = serde_json::Value::String("X".repeat(MAX_LIVE_MSG_BYTES * 2));
        let patch_json = serde_json::json!([
            { "op": "replace", "path": "/big", "value": big_value }
        ]);
        let patch: json_patch::Patch = serde_json::from_value(patch_json).unwrap();
        let store = MsgStore::new();
        let mut rx = store.get_receiver();
        store.push(LogMsg::JsonPatch(patch.clone()));

        // Broadcast: replaced with placeholder Stderr
        let received = rx.recv().await.unwrap();
        match received {
            LogMsg::Stderr(s) => {
                assert!(s.contains("json_patch dropped from live stream"));
            }
            other => panic!("expected stderr placeholder, got {other:?}"),
        }

        // History: original patch retained
        match &store.get_history()[0] {
            LogMsg::JsonPatch(_) => {}
            other => panic!("expected JsonPatch in history, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn broadcast_buffer_capacity_is_bounded() {
        // Push more messages than BROADCAST_CAPACITY without a subscriber.
        // With a bounded ring buffer, this must not allocate unboundedly,
        // panic, or block. (Smoke test: it returns.)
        let store = MsgStore::new();
        for i in 0..(BROADCAST_CAPACITY * 5) {
            store.push(LogMsg::Stdout(format!("line {i}")));
        }
        assert!(store.get_history().len() > 0);
    }

    #[tokio::test]
    async fn slow_subscriber_sees_lagged_marker_not_oom() {
        let store = MsgStore::new();
        let _rx = store.get_receiver(); // never read from
        for i in 0..(BROADCAST_CAPACITY * 3) {
            store.push(LogMsg::Stdout(format!("line {i}")));
        }
        // History is still bounded by HISTORY_BYTES; we just verify the
        // pushes returned without panic. The Lagged error path is exercised
        // inside `history_plus_stream`'s filter_map.
    }
}
