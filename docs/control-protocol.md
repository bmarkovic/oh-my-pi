# OMP control protocol (v2) daemon

`omp control serve` runs a long-lived WebSocket daemon that speaks OMP control protocol v2 to a single control-plane client. The normative wire contract is owned by the control-plane repository (`docs/contracts/omp-control-protocol.md`); this page records what this build implements and where it differs.

## Front door

- Listener: `ws://127.0.0.1:<port>/control`. Any other path returns 404. Only loopback hosts (`127.0.0.0/8`, `::1`, `localhost`) can be bound; other hosts are refused before listening because remote control requires TLS, which is not available yet.
- Credentials: an upgrade must carry exactly one of `Authorization: Bearer <token>` or `X-Omp-Control-Key: <key>`. Missing, both, wrong, or any `token`, `key` or `access_token` query parameter returns HTTP 401 and no WebSocket is opened. Each configured credential is one control principal, and a handle is visible only to the principal that created it. Credential bytes are never logged or sent in a frame.
- Frames: each message is one UTF-8 JSON object in a text frame, at most 16 MiB. Binary frames close with 1003. Messages above the limit close with 1009.
- Handshake: the first command must be `hello`. A proposal with no version 2 is answered with `version_mismatch` and closed with 1002. A silent client is closed with 1008 after 10 seconds.
- Heartbeat: a ping every 15 seconds. No inbound frame or pong for 45 seconds closes the connection as transport loss.
- Command ids are unique per connection; a reused id is rejected with `invalid_message` and is not executed.

## Running the daemon

```
omp control serve [--bind <host:port>] [--token-file <path>] [--key-file <path>]
```

- `--bind` defaults to `127.0.0.1:0` (a free loopback port). Other hosts are refused.
- Credentials come from `--token-file` or `OMP_CONTROL_TOKEN` (bearer) and `--key-file` or `OMP_CONTROL_KEY` (control key). At least one is required; otherwise the command prints a message on stderr and exits 1.
- On start, stdout carries exactly one line: the `ws://` URL including `/control`.
- SIGINT and SIGTERM close the listener and dispose every session before the process exits with the signal's status.
- The launch's other flags (for example `--approval-mode`) apply to the sessions the daemon creates.

## Catalog and session creation

Advertised features: `catalog`, `steering`, `usage`, `interrupt`, `terminate`, `tool_bindings`, `decisions`, `child_lineage`, `reconciliation`. This is the full v2 set the contract requires, plus `usage`.

- `query_catalog` returns `models` (`{id: "provider/modelId", provider}`) from the process model registry, and `agents` (`{name, description, roles: [], defaultModel?}`) discovered from the daemon's working directory. Prompts and definition paths are never included. `defaultModel` is set only when the agent's first model pattern is exactly a catalog id; looser patterns are omitted rather than guessed. `roles` is empty until agent roles exist.
- `create_session` needs an accepted `subscribe_events`. `workspacePath` must be an absolute, existing, readable directory (`invalid_workspace` otherwise). `agent` and `model` are exact catalog names and ids (`unknown_agent`, `unknown_model`); an explicit model disables model fallback. Every selection is resolved before anything is created, so a rejected request creates no session.
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

- A subagent that a root control session spawns becomes a child handle when its session is built, before any of its activity. Its `session_started` carries `parentSessionId` set to the root's handle, and every later child event carries the same field.
- Each child run settles once: `session_completed{output}` with the child's final text, `session_failed` on a model error, `session_interrupted` when the parent was interrupted, or `session_terminated` when the parent was terminated. The child's `usage` counts only its own run.
- A child's `ask` questions are decisions whose events carry the child's handle and `parentSessionId`. Its tools use the parent's tool bindings, so a bound endpoint receives the parent's token.
- `enumerate_child_sessions` lists the direct children of a handle in creation order, including settled ones. An unknown handle is `unknown_session`.
- `prompt_session`, `interrupt_session` and `terminate_session` on a child return `unsupported_operation`; the child keeps running and changes nothing.
- `interrupt_session` on the root interrupts its running children, and `terminate_session` on the root disposes them. Each child's terminal event precedes the root's.
- Control sessions run their subagents synchronously (`async.enabled` is off for the control host), so a root turn does not complete while an owned child is still running.
- Limits in this build: only direct children are tracked; a grandchild is disposed with its child but has no handle of its own. Child lifecycle is derived from the child's runs, so a child whose run ends without an observable outcome settles on the next quiet check.

## Retention, inspection and reconciliation

- Idle reuse: a session that is idle for 600 000 ms expires, publishing `session_expired{reason: "idle_ttl"}`; its children expire with it. A session with a turn in progress, or waiting on a human, is never expired. The idle clock starts when a session is created or its turn settles.
- Retired handles (terminated or expired) are retained for 60 000 ms, answering `unsupported_operation`; then they are forgotten and answer `unknown_session`. Settled decisions answer identical retries for the same window.
- Orphan grace: when a principal's last connection closes, its root sessions are terminated after 60 000 ms unless it reconnects first.
- `inspect_session` returns the session's `snapshot` (`taskRef`, `status`, `parentSessionId?`, `waitingHumanInput`, `pendingDecisions`, `lastOutcome?`, `descendants`) without changing any clock. An unknown or foreign handle is `unknown_session`.
- `reconnect {activeSessions: [{sessionId, taskRef}]}` requires an accepted `subscribe_events`. Each requested handle gets one result in request order: `retained_active`, `retained_idle` (with its last outcome), `completed` (a retired handle, status `terminated` or `expired`), or `unknown` (missing, forgotten, owned by another credential, a child, or with a different `taskRef`). A repeated or malformed entry rejects the whole command with `invalid_message`. The reply is queued before any later event for the reattached sessions. A session's live events go only to the connection that created it or later reclaimed it with `reconnect`; a detached session's events (including any that settle while no connection is attached) are not delivered to another connection and are recovered from the snapshot.
- Durations use the monotonic clock. Recovery after the daemon itself restarts is not supported; the handles are gone with the process.
