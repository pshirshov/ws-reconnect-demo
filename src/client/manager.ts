import {
  ManagedConnection,
  ConnectionState,
  ConnectionConfig,
  ConnectionStats,
} from "./connection.js";

export interface ManagerStats {
  connections: ConnectionStats[];
  activeConnectionId: string | null;
  frozen: boolean;
  consecutiveFailures: number;
  maxRetries: number;
  reconnectScheduledAt: number | null;
  reconnectDelayMs: number | null;
  reconnectDeferredUntilVisible: boolean;
  isTerminal: boolean;
}

export interface LogEntry {
  timestamp: number;
  message: string;
}

export class ConnectionManager {
  private connections = new Map<string, ManagedConnection>();
  private activeId: string | null = null;
  private wsUrl: string;
  private config: ConnectionConfig;
  private frozen = false;
  private destroyed = false;

  private logEntries: LogEntry[] = [];
  private static readonly MAX_LOG_ENTRIES = 500;

  // Reconnection with exponential backoff + jitter
  private consecutiveFailures = 0;
  private reconnectTimerId: ReturnType<typeof setTimeout> | null = null;
  private reconnectScheduledAt: number | null = null;
  private reconnectDelayMs: number | null = null;
  private pendingReconnectOnVisible = false;
  private isTerminal = false;
  private static readonly BACKOFF_BASE_MS = 1_000;
  private static readonly BACKOFF_MAX_MS = 30_000;
  private static readonly BACKOFF_MAX_RETRIES = 15;
  private static readonly MAX_LIVE_CONNECTIONS = 3;
  // Close codes that indicate a permanent error — don't reconnect
  // 1002=protocol error, 1003=unsupported data, 1007=invalid payload,
  // 1009=message too big, 1010=mandatory extension, 1015=TLS failure
  private static readonly NON_RETRIABLE_CODES = new Set([1002, 1003, 1007, 1009, 1010, 1015]);

  // Time-jump detection: catches page freeze/resume that the Page Lifecycle API misses
  private lastTickAt = Date.now();
  private tickIntervalId: ReturnType<typeof setInterval> | null = null;

  private deadRetentionMs: number;
  private cleanupIntervalId: ReturnType<typeof setInterval> | null = null;

  private readonly onUpdate: () => void;

  constructor(
    wsUrl: string,
    config: ConnectionConfig,
    deadRetentionMs: number,
    onUpdate: () => void,
  ) {
    this.wsUrl = wsUrl;
    this.config = config;
    this.deadRetentionMs = deadRetentionMs;
    this.onUpdate = onUpdate;

    this.setupLifecycleListeners();
    this.startTimeJumpDetector();
    this.startCleanupTimer();
  }

  connect(): void {
    this.createConnection();
  }

  getStats(): ManagerStats {
    const connections: ConnectionStats[] = [];
    for (const conn of this.connections.values()) {
      connections.push(conn.getStats());
    }
    // Active first, then newest first
    connections.sort((a, b) => {
      if (a.id === this.activeId) return -1;
      if (b.id === this.activeId) return 1;
      return b.createdAt - a.createdAt;
    });

    return {
      connections,
      activeConnectionId: this.activeId,
      frozen: this.frozen,
      consecutiveFailures: this.consecutiveFailures,
      maxRetries: ConnectionManager.BACKOFF_MAX_RETRIES,
      reconnectScheduledAt: this.reconnectScheduledAt,
      reconnectDelayMs: this.reconnectDelayMs,
      reconnectDeferredUntilVisible: this.pendingReconnectOnVisible,
      isTerminal: this.isTerminal,
    };
  }

  getLog(): readonly LogEntry[] {
    return this.logEntries;
  }

  getConfig(): ConnectionConfig {
    return { ...this.config };
  }

  updateConfig(config: ConnectionConfig, deadRetentionMs: number): void {
    this.config = config;
    this.deadRetentionMs = deadRetentionMs;
    this.log("Config updated — ping=" + config.pingIntervalMs +
      "ms timeout=" + config.pongTimeoutMs +
      "ms grace=" + config.staleGracePeriodMs + "ms");
  }

  closeAllAndReconnect(): void {
    this.activeId = null;
    this.consecutiveFailures = 0;
    this.pendingReconnectOnVisible = false;
    this.isTerminal = false;
    if (this.reconnectTimerId !== null) {
      clearTimeout(this.reconnectTimerId);
      this.reconnectTimerId = null;
    }
    this.reconnectScheduledAt = null;
    this.reconnectDelayMs = null;
    for (const conn of this.connections.values()) {
      conn.close("user initiated reconnect");
    }
    this.createConnection();
  }

  killActiveConnection(): void {
    if (!this.activeId) return;
    const conn = this.connections.get(this.activeId);
    if (conn) {
      conn.close("user killed active connection");
    }
  }

  /**
   * Simulates a page freeze by pausing all ping/pong processing.
   *
   * NOTE: In a real page freeze, ALL timers stop and resume together.
   * Our simulation is imperfect — JS timers still fire but handlers are no-ops.
   * The time-jump detector triggers proper recovery on unfreeze.
   */
  simulateFreeze(durationMs: number): void {
    if (this.frozen) return;

    this.frozen = true;
    this.log(`Simulating page freeze for ${durationMs}ms`);

    for (const conn of this.connections.values()) {
      conn.setFrozen(true);
    }

    this.onUpdate();

    setTimeout(() => {
      this.frozen = false;
      for (const conn of this.connections.values()) {
        conn.setFrozen(false);
      }
      this.log("Freeze simulation ended — checking connections");
      this.handleResume(durationMs);
      this.onUpdate();
    }, durationMs);
  }

  destroy(): void {
    this.destroyed = true;

    if (this.tickIntervalId) clearInterval(this.tickIntervalId);
    if (this.cleanupIntervalId) clearInterval(this.cleanupIntervalId);
    if (this.reconnectTimerId) clearTimeout(this.reconnectTimerId);

    for (const conn of this.connections.values()) {
      conn.close("manager destroyed");
    }
    this.connections.clear();

    // Belt-and-suspenders: conn.close() above synchronously re-enters handleDead()
    // which may arm a new reconnect timer. Clear it again.
    if (this.reconnectTimerId) {
      clearTimeout(this.reconnectTimerId);
      this.reconnectTimerId = null;
    }
  }

  // --- Private ---

  /** Create a connection immediately (no backoff). Use scheduleReconnect() for retries. */
  private createConnection(): void {
    if (this.destroyed) return;

    const liveCount = this.countLive();
    if (liveCount >= ConnectionManager.MAX_LIVE_CONNECTIONS) {
      this.log(`Max live connections (${ConnectionManager.MAX_LIVE_CONNECTIONS}) reached`);
      return;
    }

    let conn: ManagedConnection;
    try {
      conn = new ManagedConnection(this.wsUrl, this.config, this.handleStateChange);
    } catch (err) {
      this.log(`Failed to create connection: ${err}`);
      return;
    }

    this.connections.set(conn.id, conn);
    this.log(`${conn.id} created`);

    if (this.activeId === null) {
      this.activeId = conn.id;
    }

    this.onUpdate();
  }

  /** Schedule a reconnect using exponential backoff with jitter. */
  private scheduleReconnect(): void {
    if (this.destroyed) return;

    if (this.consecutiveFailures >= ConnectionManager.BACKOFF_MAX_RETRIES) {
      this.log(`Max retries (${ConnectionManager.BACKOFF_MAX_RETRIES}) reached — stopped`);
      this.isTerminal = true;
      this.onUpdate();
      return;
    }

    // Defer reconnection when tab is hidden (Phoenix pattern — avoid wasting
    // resources on connections the user can't see)
    if (document.visibilityState === "hidden") {
      if (!this.pendingReconnectOnVisible) {
        this.pendingReconnectOnVisible = true;
        this.log("Deferring reconnection — tab is hidden");
      }
      return;
    }

    const delay = this.getBackoffDelay();
    this.log(`Reconnecting in ${Math.round(delay)}ms (attempt ${this.consecutiveFailures}/${ConnectionManager.BACKOFF_MAX_RETRIES})`);

    if (this.reconnectTimerId !== null) clearTimeout(this.reconnectTimerId);
    this.reconnectScheduledAt = Date.now() + delay;
    this.reconnectDelayMs = delay;
    this.reconnectTimerId = setTimeout(() => {
      this.reconnectTimerId = null;
      this.reconnectScheduledAt = null;
      this.reconnectDelayMs = null;
      if (this.needsNewConnection()) {
        this.createConnection();
      }
      this.onUpdate();
    }, delay);
  }

  private getBackoffDelay(): number {
    const exp = Math.max(0, this.consecutiveFailures - 1);
    const base = ConnectionManager.BACKOFF_BASE_MS * Math.pow(2, exp);
    const capped = Math.min(base, ConnectionManager.BACKOFF_MAX_MS);
    // Full jitter: random between 50% and 100% of computed delay
    return capped * (0.5 + Math.random() * 0.5);
  }

  private handleStateChange = (
    conn: ManagedConnection,
    oldState: ConnectionState,
    newState: ConnectionState,
  ): void => {
    if (this.destroyed) return;

    this.log(`${conn.id}: ${oldState} → ${newState}${conn.id === this.activeId ? " (active)" : ""}`);

    switch (newState) {
      case ConnectionState.ALIVE:
        this.handleAlive(conn);
        break;
      case ConnectionState.STALE:
        this.handleStale(conn);
        break;
      case ConnectionState.DEAD:
        this.handleDead(conn);
        break;
    }

    this.onUpdate();
  };

  private handleAlive(conn: ManagedConnection): void {
    // Successful connection resets backoff
    this.consecutiveFailures = 0;
    this.pendingReconnectOnVisible = false;
    this.isTerminal = false;
    if (this.reconnectTimerId !== null) {
      clearTimeout(this.reconnectTimerId);
      this.reconnectTimerId = null;
    }
    this.reconnectScheduledAt = null;
    this.reconnectDelayMs = null;

    if (this.activeId === null) {
      this.activeId = conn.id;
      this.log(`Promoted ${conn.id} to active (no previous active)`);
      return;
    }

    if (conn.id === this.activeId) return; // active refreshed — good

    // A non-active connection became alive
    const active = this.connections.get(this.activeId);
    if (!active || active.currentState !== ConnectionState.ALIVE) {
      // Current active is unhealthy, promote this one
      const old = this.activeId;
      this.activeId = conn.id;
      this.log(`Promoted ${conn.id} to active (was ${old})`);
      if (active && active.currentState === ConnectionState.STALE) {
        active.close("superseded by new active");
      }
    } else {
      // Already have a healthy active — close the extra
      conn.close("superseded: active connection is healthy");
    }
  }

  private handleStale(conn: ManagedConnection): void {
    if (conn.id !== this.activeId) return; // let non-active connections expire on their own
    this.ensureReplacement();
  }

  private handleDead(conn: ManagedConnection): void {
    if (conn.id === this.activeId) {
      this.activeId = null;

      // Don't reconnect for non-retriable close codes (protocol errors, not network)
      const stats = conn.getStats();
      if (stats.closeCode !== null && ConnectionManager.NON_RETRIABLE_CODES.has(stats.closeCode)) {
        this.log(`Close code ${stats.closeCode} is non-retriable — stopped`);
        this.isTerminal = true;
        return;
      }

      // Try to find an existing replacement
      for (const c of this.connections.values()) {
        if (c.currentState === ConnectionState.ALIVE) {
          this.activeId = c.id;
          this.log(`Promoted ${c.id} to active`);
          return;
        }
      }
      for (const c of this.connections.values()) {
        if (c.currentState === ConnectionState.NEW) {
          this.activeId = c.id;
          this.log(`${c.id} (NEW) pending active`);
          return;
        }
      }

      // No candidates — reconnect with backoff
      this.consecutiveFailures++;
      this.scheduleReconnect();
    } else {
      // Non-active connection died — if active is STALE, ensure replacement exists
      if (this.activeId) {
        const active = this.connections.get(this.activeId);
        if (active && active.currentState === ConnectionState.STALE) {
          this.ensureReplacement();
        }
      }
    }
  }

  private ensureReplacement(): void {
    for (const conn of this.connections.values()) {
      if (conn.id === this.activeId) continue;
      const s = conn.currentState;
      if (s === ConnectionState.NEW || s === ConnectionState.ALIVE) return; // already in progress
    }
    this.createConnection();
  }

  private needsNewConnection(): boolean {
    for (const conn of this.connections.values()) {
      const s = conn.currentState;
      if (s === ConnectionState.NEW || s === ConnectionState.ALIVE) return false;
    }
    return true;
  }

  private countLive(): number {
    let count = 0;
    for (const conn of this.connections.values()) {
      if (conn.currentState !== ConnectionState.DEAD) count++;
    }
    return count;
  }

  // --- Page lifecycle ---

  private setupLifecycleListeners(): void {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        this.log("Page became visible — checking connections");
        // If reconnection was deferred while hidden, trigger it now
        if (this.pendingReconnectOnVisible) {
          this.pendingReconnectOnVisible = false;
          this.scheduleReconnect();
        }
        this.checkAllConnections();
      } else {
        this.log("Page became hidden");
      }
    });

    // Page Lifecycle API (Chrome 68+; other browsers ignore these)
    document.addEventListener("freeze", () => this.log("Page freeze event received"));
    document.addEventListener("resume", () => {
      this.log("Page resume event received");
      // Unknown duration — assume long freeze
      this.handleResume(Infinity);
    });

    // BFCache: close connections on pagehide so the page can be cached.
    // Open WebSocket connections prevent BFCache in all browsers.
    window.addEventListener("pagehide", (e: PageTransitionEvent) => {
      if (e.persisted) {
        this.log("pagehide (persisted) — closing for BFCache");
        this.activeId = null;
        for (const conn of this.connections.values()) {
          conn.close("entering BFCache");
        }
      }
    });

    window.addEventListener("pageshow", (e: PageTransitionEvent) => {
      if (e.persisted) {
        this.log("pageshow (persisted) — reconnecting from BFCache");
        this.consecutiveFailures = 0;
        this.createConnection();
      }
    });

    window.addEventListener("online", () => {
      this.log("Network: online — checking connections");
      this.checkAllConnections();
    });
    window.addEventListener("offline", () => this.log("Network: offline"));

    // Network Information API (Chrome/Edge)
    const nav = navigator as Navigator & { connection?: EventTarget & { effectiveType?: string } };
    if (nav.connection) {
      nav.connection.addEventListener("change", () => {
        const type = (nav.connection as { effectiveType?: string }).effectiveType ?? "unknown";
        this.log(`Network change: ${type} — checking connections`);
        this.checkAllConnections();
      });
    }
  }

  /**
   * Detects time jumps caused by page freeze/resume, OS sleep, or
   * debugger breakpoints. If the 1 s tick arrives much later than
   * expected, something paused the event loop.
   */
  private startTimeJumpDetector(): void {
    const TICK_MS = 1_000;
    const JUMP_THRESHOLD_MS = 3_000;

    this.tickIntervalId = setInterval(() => {
      const now = Date.now();
      const elapsed = now - this.lastTickAt;
      this.lastTickAt = now;

      if (elapsed > TICK_MS + JUMP_THRESHOLD_MS) {
        this.log(`Time jump detected: ${elapsed}ms elapsed (expected ~${TICK_MS}ms)`);
        this.handleResume(elapsed);
      }
    }, TICK_MS);
  }

  private handleResume(gapMs: number): void {
    // Short gap (< pong timeout): connection is probably fine, just verify
    // Long gap (>= pong timeout): connection is almost certainly dead
    //   (NAT tables flushed, TCP state gone, Firefox won't fire close).
    //   Proactively open a new connection in parallel so we don't waste
    //   the pong timeout waiting to confirm what we already know.
    //   If the old one turns out alive, the new one is closed as "superseded".
    const longFreeze = gapMs >= this.config.pongTimeoutMs;

    if (longFreeze) {
      this.log(`Long freeze (${Math.round(gapMs)}ms) — opening new connection proactively`);
      this.createConnection();
    }

    this.checkAllConnections();
  }

  private checkAllConnections(): void {
    let hasAliveOrNew = false;

    for (const conn of this.connections.values()) {
      const s = conn.currentState;
      if (s === ConnectionState.ALIVE || s === ConnectionState.STALE) {
        conn.checkAlive();
      }
      if (s === ConnectionState.ALIVE || s === ConnectionState.NEW) {
        hasAliveOrNew = true;
      }
    }

    if (!hasAliveOrNew) {
      this.createConnection();
    }
  }

  private startCleanupTimer(): void {
    this.cleanupIntervalId = setInterval(() => {
      const now = Date.now();
      for (const [id, conn] of this.connections) {
        const stats = conn.getStats();
        if (stats.state === ConnectionState.DEAD && stats.deadAt !== null && now - stats.deadAt > this.deadRetentionMs) {
          this.connections.delete(id);
          this.onUpdate();
        }
      }
    }, 5_000);
  }

  private log(message: string): void {
    this.logEntries.unshift({ timestamp: Date.now(), message });
    if (this.logEntries.length > ConnectionManager.MAX_LOG_ENTRIES) {
      this.logEntries.pop();
    }
  }
}
