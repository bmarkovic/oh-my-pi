# OMP control protocol (v2) daemon

`omp control serve` runs a long-lived WebSocket daemon that speaks OMP control protocol v2 to a single control-plane client. The normative wire contract is owned by the control-plane repository (`docs/contracts/omp-control-protocol.md`); this page records what this build implements and where it differs.

## Front door

- Listener: `ws://127.0.0.1:<port>/control` on loopback (`127.0.0.0/8`, `::1`, `localhost`). Any other path returns 404. A non-loopback host is refused unless TLS is configured, in which case the listener serves `wss://` (see TLS).
- Credentials: an upgrade must carry exactly one of `Authorization: Bearer <token>` or `X-Omp-Control-Key: <key>`. Missing, both, wrong, or any `token`, `key` or `access_token` query parameter returns HTTP 401 and no WebSocket is opened. Each configured credential is one control principal, and a handle is visible only to the principal that created it. Credential bytes are never logged or sent in a frame.
- Frames: each message is one UTF-8 JSON object in a text frame, at most 16 MiB. Binary frames close with 1003. Messages above the limit close with 1009 on the way in. On the way out, an oversize event is elided rather than sent over the limit (see Oversize events).
- Handshake: the first command must be `hello`. A proposal with no version 2 is answered with `version_mismatch` and closed with 1002. A silent client is closed with 1008 after 10 seconds.
- Outbound: replies and events share one FIFO queue per connection, so an acknowledgement is always sent before the events that follow it. While the transport is congested, frames wait in the queue and go out in order once it drains. Pings are not queued and are skipped while frames wait. If the queue would exceed 64 MiB, the daemon drops nothing silently: it sends no further frames and closes with 1013 `outbound backlog exceeded`. Frames delivered before the close form a gap-free prefix. The client reconnects and calls `reconnect` for the authoritative state; sessions are retained as for any transport loss.
- Heartbeat: a ping every 15 seconds. No inbound frame or pong for 45 seconds closes the connection as transport loss.
- Command ids are unique per connection; a reused id is rejected with `invalid_message` and is not executed.

## Running the daemon

```
omp control serve [--bind <host:port>] [--token-file <path>] [--key-file <path>] [--tls-cert <path> --tls-key <path>]
```

- `--bind` defaults to `127.0.0.1:0` (a free loopback port). Non-loopback hosts need `--tls-cert` and `--tls-key`; wildcard addresses (`0.0.0.0`, `::`, and other spellings of them such as `0` or `::0`) are refused even with TLS.
- Credentials come from `--token-file` or `OMP_CONTROL_TOKEN` (bearer) and `--key-file` or `OMP_CONTROL_KEY` (control key). At least one is required; otherwise the command prints a message on stderr and exits 1. Credential files must be owner-only (see Credential files).
- On start, stdout carries exactly one line: the `ws://` URL (`wss://` with TLS) including `/control`.
- SIGINT and SIGTERM run the shutdown described in Shutdown, then the process exits with the signal's status (130 for SIGINT, 143 for SIGTERM). SIGHUP also shuts down, exiting 129, so run the daemon under a supervisor or `nohup` if the terminal may hang up.
- The launch's other flags (for example `--approval-mode`) apply to the sessions the daemon creates.

## Shutdown

- Shutdown stops accepting connections at once. Over open connections, `create_session` and `prompt_session` (including steering) answer `unsupported_operation` with `daemon is shutting down`, with no side effect. `inspect_session`, `enumerate_child_sessions`, `interrupt_session`, `terminate_session`, `answer_decision` and `reconnect` keep working.
- Every root session of every principal is stopped, including orphans whose connection already closed. For each active turn, deepest handle first, the outcome is `session_failed` with `code: "daemon_shutdown"` and the message `daemon is shutting down`, and it is the turn's one outcome. Then each handle is disposed deepest first and `session_terminated` follows, with no `usage`. An idle session gets only `session_terminated`. A child's events precede its parent's.
- The failed outcome projects as a failure, not a cancellation: the daemon stopped the work, nobody asked to cancel it. `session_failed.code` is an open string; `daemon_shutdown` is the value for this case.
- Stopping has an 8-second budget. If sessions are still settling when it runs out, the daemon logs a warning and disposes the rest without waiting for them. Then it flushes each connection's queued frames (up to 500 ms), closes every connection with 1001 `server shutting down`, and waits up to one second for the close handshakes before the listener stops.

## Oversize events

- A server frame whose UTF-8 size would exceed 16 MiB is cut until it fits. Frames within the limit are never changed.
- Elidable fields: `session_completed.output`, `session_failed.error`, `decision_answered.text`. For `decision_requested`, in order: `context` is removed entirely, then `question` is cut, then each option `label` is cut to an equal byte share (never less than its first code point).
- Never changed or dropped: `version`, `type`, `sessionId`, `parentSessionId`, `at`, `inReplyTo`, `code`, `usage`, `reason`, `decisionId`, every `optionId`, the number and order of options, and `allowFreeText`. No event is suppressed.
- Cuts keep a prefix and never split a code point. Each cut event carries `elided`: RFC 6901 JSON Pointers of the changed fields, for example `["/output"]`. The field is absent when nothing was cut. Clients that ignore unknown fields keep working.
- The cut event is the one stored as the session's last outcome and as its pending decision, so `inspect_session` and `reconnect` agree with what was delivered.
- A decision that cannot fit a frame even with its labels cut to one code point is not asked: the `ask` tool receives an error, and the turn continues.
- In a reply that embeds events (`session_inspected`, `reconciled`) that is over the limit, the embedded events are cut to at most 4 KiB each, descendants last to first and then the root's own event, until the reply fits. Records keep their ids and statuses.
- The daemon never sends a frame that is still over the limit after this. If one is produced, it logs an error and closes the connection with 1011.

## TLS

- `--tls-cert` and `--tls-key` are given together or not at all; one alone exits 2. The certificate is a PEM chain. The key is a PEM private key that must pass the credential-file rule (owner-only, mode 0600), and it is loaded before listening: an unreadable or unparseable certificate or key exits 1 and nothing is printed.
- With TLS the listener serves `wss://` and the stdout line is `wss://<bind host>:<port>/control`, with IPv6 hosts bracketed. Plain HTTP requests to that port never complete an upgrade.
- The daemon does not check the certificate against the bind host. The operator must issue a certificate that covers the host clients dial. A private CA is trusted by the client, not the daemon.
- Certificate rotation needs a restart. A reverse proxy that terminates TLS in front of a loopback listener is the documented alternative; the daemon then needs no TLS flags.

## Credential files

- `--token-file` and `--key-file` must be regular files owned by the daemon's user with no group or other permission bits (`chmod 600`). Otherwise the daemon refuses to start: it exits 1 before printing the URL, names the file and its mode on stderr, and never prints the file's bytes. There is no override.
- Rotation: the daemon stat-polls credential files every two seconds and re-reads a file that changed. Replace the file by writing a temporary file and renaming it over the original, so a half-written value is never read. Upgrades that present the old value get 401 after the next poll. Connections already open stay open. Deleting the file, or leaving it unusable (for example mode 0644), refuses that credential until a valid file reappears; the daemon logs the path and reason, never the value. Environment credentials (`OMP_CONTROL_TOKEN`, `OMP_CONTROL_KEY`) are fixed for the process lifetime; restart the daemon to change them.
- Windows does not check file permissions (POSIX mode bits do not describe NTFS ACLs). Keep the file in a directory only you can read.
- Mode bits do not stop processes running as the same user, including the agent's own shell. Until the agent runs under a separate account or sandbox, a same-user agent can read the file.
- Credentials from `OMP_CONTROL_TOKEN` and `OMP_CONTROL_KEY` are unset from the environment once read, so agent-spawned processes do not inherit them.

## Catalog and session creation

Advertised features: `catalog`, `steering`, `usage`, `interrupt`, `terminate`, `tool_bindings`, `decisions`, `child_lineage`, `reconciliation`. This is the full v2 set the contract requires, plus `usage`.

- `query_catalog` returns `models` (`{id: "provider/modelId", provider}`) from the process model registry, and `agents` (`{name, description, roles: [], defaultModel?}`) discovered from the daemon's working directory. Prompts and definition paths are never included. `defaultModel` is set only when the agent's first model pattern is exactly a catalog id; looser patterns are omitted rather than guessed. `roles` is empty until agent roles exist.
- `create_session` needs an accepted `subscribe_events`. `workspacePath` must be an absolute, existing, readable directory (`invalid_workspace` otherwise). `agent` and `model` are exact catalog names and ids (`unknown_agent`, `unknown_model`); agents are looked up from the daemon's working directory exactly as the catalog lists them, never from the task workspace; an explicit model disables model fallback. Every selection is resolved before anything is created, so a rejected request creates no session.
- `tools` binds operator endpoints as model tools (see Tool bindings). A malformed set is `invalid_message` and installs nothing.
- A session factory failure is answered with `invalid_message` and the message `session could not be created`. The contract has no internal-error code, so this is the closest typed rejection; nothing is retained.
- Handles are opaque UUIDs owned by the credential that created them. Another credential's lookups read as `unknown_session`.

## Turns, steering and usage

- `prompt_session` on an idle session is accepted atomically: the handle becomes active, the turn deadline (`timeoutMs`, default 1 800 000 ms) starts, then `ack` and `session_started` are sent in that order.
- `prompt_session` on an active session is steering: `ack` only. No second `session_started`, and the deadline is not reset.
- Each accepted turn settles exactly once: `session_completed{output}` with the final assistant text (empty when the turn produced no assistant output), or `session_failed{code, error}` with `code` `execution_failed` (model error or an aborted run) or `timeout` (the deadline fired; the turn is aborted first). The turn is settled only after the session is quiet, so a steer queued before the run began is part of the same turn.
- `usage` is the session's own turn delta of provider-reported input, output and total tokens. It is omitted when the provider reported no tokens for the turn.
- `operatorUserId` is recorded on the turn and never used for authorization.
- `prompt_session` requires an accepted `subscribe_events`; a subscribed connection receives the events of the sessions its credential owns.

## Interrupt

- `interrupt_session` on an active session is acknowledged, then the turn's generation and tools are aborted. Once the run has unwound, the turn settles as `session_interrupted{usage?}` and the handle returns to idle. An interrupt is neither a success nor a failure.
- A stop that arrives first decides the turn: an interrupt after the deadline fired, or a deadline after an interrupt, does not change the outcome that is already in progress.
- `interrupt_session` on an idle session is an idempotent `ack` with no event.
- An unknown handle answers `unknown_session`.

## Terminate

- `terminate_session` acknowledges, then disposes the session. On an idle session `session_terminated` follows the teardown and carries no usage. On an active session the turn's only outcome is `session_terminated{usage?}`: a hard stop overrides an interrupt or deadline already in progress, and no completed, failed or interrupted event is sent for that turn.
- The event is published only after the session is disposed. If teardown fails, nothing is confirmed: an active turn settles as `session_failed{code: "teardown_failed"}` and the handle is left as it was, so a later `terminate_session` can retry.
- A terminated handle is kept as a tombstone. `prompt_session`, `interrupt_session` and `terminate_session` on it return `unsupported_operation`. Tombstones are retained until the reconciliation feature forgets them.

## Tool bindings

- A binding is `{name, description, endpointUrl, authToken, schema}`. Names are unique, `endpointUrl` is an absolute http(s) URL, `authToken` is non-empty, and `schema` is a JSON Schema object the daemon can represent. Any violation is `invalid_message` naming the field and index only; no binding is installed.
- `create_session.tools` installs the set once the session exists, before the handle is returned. A failed install disposes the new session and creates nothing.
- Idle `prompt_session.tools` replaces the whole set atomically before the ack. `[]` removes every binding; omitting `tools` keeps the set. During an active turn, `tools` is `invalid_message` and the bindings are unchanged.
- Each call POSTs the model's JSON input to `endpointUrl` with `Authorization: Bearer <authToken>`. A non-2xx answer is a tool error that names only the status. Response bodies are capped at 16 MiB, and every occurrence of the token in a body is replaced with `[redacted]` before the model sees it. The token never appears in events, logs or errors.
- The model sees a binding under a provider-safe name: a name already in `[a-zA-Z0-9_-]{1,64}` is kept, any other (such as `git.status`) has its stray characters replaced with `_`, with a numeric suffix when that collides (`git_status`, `git_status_2`). The binding's own name stays its identity on the wire; providers reject dotted tool names, and omp drops replayed calls under them.
- Installation goes through the session's host-tool refresh, not the extension loader, so it is atomic and can be replaced at an idle boundary.

## Decisions

- The model's `ask` tool runs in a control session as a decision. `decision_requested{decisionId, question, options, allowFreeText}` carries one `optionId` per choice (`"0"`, `"1"`, …). The ask tool's reserved free-text option arrives as an option too; choosing it asks for text, which is a decision with no options and `allowFreeText: true`.
- A session has at most one pending decision. The turn waits for the answer; the deadline keeps running, and nothing is chosen automatically.
- `answer_decision` takes exactly one of `optionId` or `text` (text only when the question allowed it). A malformed answer is `invalid_message` and the question stays pending. An accepted answer is acknowledged, then `decision_answered{decisionId, optionId|text, answeringUserId?}` is published, then the tool continues.
- An identical answer retried after acceptance gets `ack` with no second event. A different answer, an answer to a settled or invalidated question, a question of another credential, or an unknown id is `invalid_decision_state`.
- Interrupt, terminate and the deadline invalidate a pending question before the session settles. A deadline while waiting settles the turn as `session_failed{code: "timeout"}`.
- A multi-select question is refused to the tool, which gets an error instead of a question. Confirmations are denied.
- Settled decisions are kept for the life of the daemon in this build; the reconciliation feature bounds that record window.

## Child lineage

- A subagent that a control session spawns becomes a child handle when its session is built, before any of its activity, at any depth. Its `session_started` carries `parentSessionId` set to its immediate parent's handle (the root for a direct child, the child for a grandchild), and every later event of that handle carries the same field. Events of every depth are delivered on the root's connection; the client finds the root by walking `parentSessionId` back through the handles it has seen.
- Each child run settles once: `session_completed{output}` with the child's final text, `session_failed` on a model error, `session_interrupted` when the parent was interrupted, or `session_terminated` when the parent was terminated. The child's `usage` counts only its own run.
- A child's `ask` questions are decisions whose events carry the child's handle and `parentSessionId`. Its tools use the parent's tool bindings, so a bound endpoint receives the parent's token.
- `enumerate_child_sessions` lists the direct children of a handle in creation order, including settled ones. A child handle lists its own children. An unknown handle is `unknown_session`.
- A grandchild's tools are the root's bindings, unchanged, and its questions are decisions with its own handle. Its depth is bounded by the runtime's subagent recursion limit (two levels by default).
- `prompt_session`, `interrupt_session` and `terminate_session` on a child at any depth return `unsupported_operation`; the child keeps running and changes nothing.
- `interrupt_session` on the root interrupts its running descendants, and `terminate_session` on the root disposes them. Each descendant's terminal event precedes its parent's, so the order is deepest first, then the root.
- `reconnect` returns a root's snapshot with `descendants` for the whole subtree, depth-first pre-order, so every parent precedes its children. Each descendant names its immediate parent.
- Control sessions run their subagents synchronously (`async.enabled` is off for the control host), so a root turn does not complete while an owned child is still running.
- Limits in this build: a subagent that a restored (revived) child spawns runs headless, without a handle. Child lifecycle is derived from the child's runs, so a child whose run ends without an observable outcome settles on the next quiet check.

## Retention, inspection and reconciliation

- Idle reuse: a session that is idle for 600 000 ms expires, publishing `session_expired{reason: "idle_ttl"}`; its children expire with it. A session with a turn in progress, or waiting on a human, is never expired. The idle clock starts when a session is created or its turn settles.
- Retired handles (terminated or expired) are retained for 60 000 ms, answering `unsupported_operation`; then they are forgotten and answer `unknown_session`. Settled decisions answer identical retries for the same window.
- Orphan grace: when a principal's last connection closes, its root sessions are terminated after 60 000 ms unless it reconnects first.
- `inspect_session` returns the session's `snapshot` (`taskRef`, `status`, `parentSessionId?`, `waitingHumanInput`, `pendingDecisions`, `lastOutcome?`, `descendants`) without changing any clock. An unknown or foreign handle is `unknown_session`.
- `reconnect {activeSessions: [{sessionId, taskRef}]}` requires an accepted `subscribe_events`. Each requested handle gets one result in request order: `retained_active`, `retained_idle` (with its last outcome), `completed` (a retired handle, status `terminated` or `expired`), or `unknown` (missing, forgotten, owned by another credential, a child, or with a different `taskRef`). A repeated or malformed entry rejects the whole command with `invalid_message`. The reply is queued before any later event for the reattached sessions. A session's live events go only to the connection that created it or later reclaimed it with `reconnect`; a detached session's events (including any that settle while no connection is attached) are not delivered to another connection and are recovered from the snapshot.
- Durations use the monotonic clock. Recovery after the daemon itself restarts is not supported; the handles are gone with the process.
