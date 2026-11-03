# OMP control protocol (v2) daemon

`omp control serve` runs a long-lived WebSocket daemon that speaks OMP control protocol v2 to a single control-plane client. The normative wire contract is owned by the control-plane repository (`docs/contracts/omp-control-protocol.md`); this page records what this build implements and where it differs.

## Front door

- Listener: `ws://127.0.0.1:<port>/control`. Any other path returns 404. Only loopback hosts (`127.0.0.0/8`, `::1`, `localhost`) can be bound; other hosts are refused before listening because remote control requires TLS, which is not available yet.
- Credentials: an upgrade must carry exactly one of `Authorization: Bearer <token>` or `X-Omp-Control-Key: <key>`. Missing, both, wrong, or any `token`, `key` or `access_token` query parameter returns HTTP 401 and no WebSocket is opened. Each configured credential is one control principal, and a handle is visible only to the principal that created it. Credential bytes are never logged or sent in a frame.
- Frames: each message is one UTF-8 JSON object in a text frame, at most 16 MiB. Binary frames close with 1003. Messages above the limit close with 1009.
- Handshake: the first command must be `hello`. A proposal with no version 2 is answered with `version_mismatch` and closed with 1002. A silent client is closed with 1008 after 10 seconds.
- Heartbeat: a ping every 15 seconds. No inbound frame or pong for 45 seconds closes the connection as transport loss.
- Command ids are unique per connection; a reused id is rejected with `invalid_message` and is not executed.
