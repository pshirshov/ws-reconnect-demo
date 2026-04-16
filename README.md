# WebSocket Reconnect Demo

A TypeScript client+server demo that maintains resilient WebSocket connections across page lifecycle events, network changes, and browser bugs.

## Quick start

```bash
npm install
npm start        # builds client + starts server
```

Open `http://localhost:3000`. The dashboard shows live connection state, RTT measurements, and an event log.

## Problem

Browser WebSocket connections silently die under many real-world conditions:

- **Page freeze/unfreeze** — mobile browsers and desktop Chrome freeze background tabs, suspending all timers and network activity. On resume, the WebSocket may appear `OPEN` but the TCP connection is gone.
- **IP address changes** — switching between Wi-Fi and cellular, VPN toggles, or roaming can invalidate the underlying TCP connection without triggering a `close` event.
- **Firefox stale connection bugs** — Firefox historically lacks TCP keepalives on WebSocket connections ([bug 920074](https://bugzilla.mozilla.org/show_bug.cgi?id=920074)), causing idle connections to be silently dropped by NAT devices. Firefox also silently throttles WebSocket connection attempts with delays up to 60s ([bug 1360753](https://bugzilla.mozilla.org/show_bug.cgi?id=1360753)).
- **Proxy/load balancer timeouts** — Nginx defaults to 60s idle timeout, Cloudflare Free/Pro to 100s. Without heartbeats, connections are dropped silently.

The browser's `close` event is **not reliable** for detecting these failures. The only reliable method is application-level heartbeats.

## Architecture

### Connection state machine

```
NEW ──→ ALIVE ──→ STALE ──→ DEAD
  │              ↑       │
  │              └───────┘  (recovery: pong arrives during grace period)
  └──────────────────────→ DEAD  (connect timeout or socket error)
```

| State | Meaning |
|-------|---------|
| `NEW` | WebSocket created, TCP/TLS handshake in progress |
| `ALIVE` | Socket open, recent successful ping/pong |
| `STALE` | Ping timeout fired — no pong received within `pongTimeoutMs`. May recover if a late pong arrives. |
| `DEAD` | Terminal. Socket closed or failed. Kept in UI for `deadRetentionMs`, then cleaned up. |

### Connection pool

The `ConnectionManager` maintains a pool of connections (normally one). When the active connection goes `STALE`:

1. A **replacement connection** is created immediately
2. The old connection has a **grace period** (`staleGracePeriodMs`) to recover
3. If the old connection receives a late pong → `STALE → ALIVE` → closed as "superseded" (the new connection takes over)
4. If it doesn't recover → `STALE → DEAD` after the grace period

This ensures zero-gap connectivity: the new connection is establishing while we wait to confirm the old one is dead.

### Ping/pong protocol

**Client → Server:**
```json
{ "type": "ping", "nonce": "uuid-v4", "clientTs": 1713264000000 }
```

**Server → Client:**
```json
{ "type": "pong", "nonce": "uuid-v4", "clientTs": 1713264000000, "serverTs": 1713264000001 }
```

Each ping carries a unique nonce and the client's timestamp. The server echoes both and adds its own timestamp. The client computes RTT as `now - clientTs` when the matching pong arrives.

Per-ping timeouts track individual nonces. If a specific pong never arrives within `pongTimeoutMs`, the connection is marked `STALE`. This is more precise than a generic "last activity" check.

## Resilience mechanisms

### 1. Application-level heartbeat

The client sends pings every `pingIntervalMs` (default 5s). Each ping has a per-nonce timeout of `pongTimeoutMs` (default 3s). This detects dead connections that the browser's `close` event misses — especially Firefox's stale WebSocket bug where `readyState` stays `OPEN` on a dead TCP connection.

### 2. Connect timeout

New connections are aborted if the TCP/TLS handshake doesn't complete within `connectTimeoutMs` (default 10s). This prevents stuck `CONNECTING` sockets (captive portals, SYN blackholes) from blocking reconnection indefinitely. The timeout checks both the wrapper state (`NEW`) and the native `readyState` (`CONNECTING`) to avoid aborting a socket that has already opened but whose `open` event hasn't dispatched yet.

### 3. Time-jump detection

A 1-second interval timer compares `Date.now()` against the expected tick time. If the elapsed time exceeds 4 seconds (1s interval + 3s threshold), a page freeze or OS sleep is inferred. This catches freeze/resume events that the Page Lifecycle API misses (it's Chrome-only).

On detection:
- **Short gap** (< `pongTimeoutMs`): existing connections are pinged to verify liveness.
- **Long gap** (≥ `pongTimeoutMs`): a new connection is opened **proactively** in parallel. If the old connection turns out to be alive, the new one is closed as "superseded." If it's dead (the common case after a real freeze), the new connection is already establishing.

### 4. Page Lifecycle API integration

| Event | Action |
|-------|--------|
| `visibilitychange` → visible | Check all connections; trigger deferred reconnection if pending |
| `visibilitychange` → hidden | Log (reconnection attempts are deferred while hidden per Phoenix pattern) |
| `freeze` (Chrome) | Log |
| `resume` (Chrome) | Treat as long freeze — proactive reconnect |
| `pagehide` (persisted) | Close all connections to allow BFCache |
| `pageshow` (persisted) | Reconnect from BFCache restoration |
| `online` | Check all connections |
| `offline` | Log |
| Network Information API `change` | Check all connections (Chrome/Edge only) |

### 5. BFCache support

Open WebSocket connections prevent the page from entering the back-forward cache. The manager closes all connections on `pagehide` (when `event.persisted` is true) and reconnects on `pageshow`. This follows web.dev recommendations — `pagehide` is used instead of `beforeunload`/`unload` because those events themselves can prevent BFCache eligibility.

### 6. Visibility-aware reconnection (Phoenix pattern)

When a reconnection is needed but the tab is hidden (`document.visibilityState === "hidden"`), the attempt is **deferred** instead of executed. When the tab becomes visible, the deferred reconnection triggers immediately. This avoids wasting resources on connections the user can't see — a pattern from the [Phoenix framework](https://github.com/phoenixframework/phoenix/pull/6534).

### 7. Exponential backoff with jitter

Failed reconnections use exponential backoff:

```
delay = min(1000ms × 2^(failures-1), 30000ms) × random(0.5, 1.0)
```

- Base: 1s
- Multiplier: 2× per attempt
- Cap: 30s
- Jitter: 50-100% (full jitter to prevent thundering herd after server restart)
- Max retries: 15 (then stops; user can trigger manual reconnect)

Backoff resets to 0 when any connection reaches `ALIVE`.

### 8. Close code routing

WebSocket close codes are classified as retriable or permanent:

| Retriable (reconnect) | Permanent (stop) |
|---|---|
| 1001 Going Away | 1002 Protocol Error |
| 1005 No Status | 1003 Unsupported Data |
| 1006 Abnormal Closure | 1007 Invalid Payload |
| 1011 Internal Error | 1009 Message Too Big |
| 1012 Service Restart | 1010 Mandatory Extension |
| 1013 Try Again Later | 1015 TLS Failure |
| 1014 Bad Gateway | |

On a non-retriable close code, the manager stops reconnecting. On retriable codes, exponential backoff applies.

### 9. Destroyed flag

The `ConnectionManager.destroy()` method sets a `destroyed` flag before closing connections. This prevents `conn.close()` from synchronously re-entering `handleDead()` → `scheduleReconnect()` → arming a new timer after the destroy cleanup. All state-change handlers, `createConnection`, and `scheduleReconnect` check this flag.

## Server-side heartbeat

The server uses RFC 6455 protocol-level pings to detect and reap dead clients. The implementation addresses three subtle issues:

### Event-loop ordering

In Node.js, timer callbacks (phase 1) run before I/O callbacks (phase 4) in the same event loop iteration. After a server stall, both the heartbeat timer and buffered pong handlers may be queued simultaneously. If the timer runs first and terminates a client whose pong is sitting in the I/O queue, it's a false positive.

**Solution:** Termination is deferred to `setImmediate()` (phase 5, "check"), which runs **after** the I/O poll phase. By the time setImmediate executes, any buffered pong handlers have already had a chance to clear the pending flag.

```
Timer phase:     collect candidates, rotate nonces, send new pings
     ↓
I/O poll phase:  buffered pong handlers run → clear pending flag
     ↓
Check phase:     setImmediate → only terminate if STILL pending
```

### Nonce correlation

Each `ws.ping(nonce)` carries a random 8-byte payload. The `pong` handler only clears the pending flag if the echoed payload matches the **current** or **previous** nonce. This rejects unsolicited pong frames (legal per RFC 6455 § 5.5.3) that could otherwise keep dead connections alive.

The "previous nonce" acceptance window exists specifically for the setImmediate gap: after a stall, the timer may rotate the nonce before the pong for the old nonce is processed in the I/O phase.

### Server pause resilience

The combination of setImmediate deferral and previous-nonce acceptance means no drift-detection threshold is needed. After any server pause (SIGSTOP, VM suspend, debugger breakpoint), the buffered pong from the old nonce is processed in the I/O phase before setImmediate checks liveness. No false-positive mass disconnects regardless of pause duration.

## Configuration

All timing values are configurable in the dashboard UI:

| Parameter | Default | Description |
|-----------|---------|-------------|
| Ping interval | 5000ms | How often the client sends application-level pings |
| Pong timeout | 3000ms | Per-ping timeout before marking connection `STALE` |
| Connect timeout | 10000ms | Max time for TCP/TLS handshake before aborting |
| Stale grace period | 15000ms | How long a `STALE` connection can recover before `DEAD` |
| Dead retention | 60000ms | How long `DEAD` connections remain visible in the UI |

Changes take effect on "Apply & Reconnect" (closes all connections and creates a fresh one with the new config).

The 5s default ping interval is aggressive for a demo (shows activity quickly). Production deployments typically use 25-30s to stay under common proxy idle timeouts (Nginx 60s, Cloudflare 100s, cellular NAT 30s).

## Dashboard UI

The dark-themed dashboard shows:

- **Status bar** — connection count by state, frozen indicator
- **Connection cards** — per-connection state, timestamps, RTT stats (last/avg/min/max), pending pings, packet loss percentage, close reason with code
- **Event log** — timestamped log of state transitions, lifecycle events, and reconnection attempts

### Test actions

| Button | Effect |
|--------|--------|
| Freeze 5s / 15s / 30s | Simulates page freeze by pausing all ping/pong processing. Tests time-jump detection and connection recovery. |
| Kill Active | Closes the active connection. Tests failover to replacement. |
| Close All & Reconnect | Tears down everything and starts fresh. Resets backoff. |

## File structure

```
src/
├── protocol.ts            Shared PingMessage / PongMessage types
├── server.ts              HTTP static server + WebSocket handler + heartbeat
└── client/
    ├── index.ts           Entry point — wires manager, UI, WebSocket URL
    ├── connection.ts      ManagedConnection: state machine, ping/pong, RTT
    ├── manager.ts         ConnectionManager: pool, lifecycle, backoff
    └── ui.ts              Dashboard rendering with requestAnimationFrame
public/
    └── index.html         HTML shell + CSS (dark theme, monospace)
```

## Known limitations

- **No Web Worker heartbeat** — Chrome throttles main-thread timers to 1/min after 5 minutes hidden + 30s silent. A dedicated Web Worker for the heartbeat timer would avoid this. The time-jump detector partially mitigates this by catching the resulting gap on resume.
- **No session resumption** — reconnection creates a fresh logical session. Production systems would track message sequence numbers and replay missed messages.
- **Freeze simulation is imperfect** — real page freezes suspend ALL timers simultaneously. The simulation sets a `frozen` flag that makes handlers no-op, but timers still fire. The time-jump detector triggers proper recovery on unfreeze.
- **No TLS** — the demo runs plain HTTP/WS. Production would use HTTPS/WSS.

## References

- [Chrome Page Lifecycle API](https://developer.chrome.com/docs/web-platform/page-lifecycle-api)
- [web.dev BFCache guide](https://web.dev/articles/bfcache)
- [Phoenix visibility-aware reconnection (PR #6534)](https://github.com/phoenixframework/phoenix/pull/6534)
- [Firefox WebSocket bugs: 920074](https://bugzilla.mozilla.org/show_bug.cgi?id=920074), [1360753](https://bugzilla.mozilla.org/show_bug.cgi?id=1360753), [1921382](https://bugzilla.mozilla.org/show_bug.cgi?id=1921382)
- [ws library heartbeat pattern](https://github.com/websockets/ws#how-to-detect-and-close-broken-connections)
- [RFC 6455 § 5.5.2-3 — Ping/Pong frames](https://www.rfc-editor.org/rfc/rfc6455#section-5.5.2)
- [WebSocket close codes reference](https://websocket.org/reference/close-codes/)
