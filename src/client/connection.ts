import type { PingMessage, PongMessage } from "../protocol.js";

export enum ConnectionState {
  NEW = "NEW",
  ALIVE = "ALIVE",
  STALE = "STALE",
  DEAD = "DEAD",
}

export interface ConnectionConfig {
  pingIntervalMs: number;
  pongTimeoutMs: number;
  staleGracePeriodMs: number;
}

export const DEFAULT_CONFIG: ConnectionConfig = {
  pingIntervalMs: 5_000,
  pongTimeoutMs: 3_000,
  staleGracePeriodMs: 15_000,
};

export interface ConnectionStats {
  id: string;
  state: ConnectionState;
  createdAt: number;
  lastPingSentAt: number | null;
  lastPongReceivedAt: number | null;
  lastRtt: number | null;
  avgRtt: number | null;
  minRtt: number | null;
  maxRtt: number | null;
  pendingPingCount: number;
  totalPingsSent: number;
  totalPongsReceived: number;
  staleAt: number | null;
  deadAt: number | null;
  closeCode: number | null;
  closeReason: string | null;
}

export type StateChangeCallback = (
  conn: ManagedConnection,
  oldState: ConnectionState,
  newState: ConnectionState,
) => void;

let connectionCounter = 0;

export class ManagedConnection {
  readonly id: string;
  private ws: WebSocket;
  private state: ConnectionState = ConnectionState.NEW;
  private readonly createdAt: number = Date.now();

  private pendingPings = new Map<string, number>(); // nonce → sentAt
  private lastPingSentAt: number | null = null;
  private lastPongReceivedAt: number | null = null;
  private lastRtt: number | null = null;
  private rttSamples: number[] = [];
  private totalPingsSent = 0;
  private totalPongsReceived = 0;
  private static readonly MAX_RTT_SAMPLES = 50;

  private staleAt: number | null = null;
  private deadAt: number | null = null;
  private closeCode: number | null = null;
  private closeReason: string | null = null;

  private pingIntervalId: ReturnType<typeof setInterval> | null = null;
  private staleTimeoutId: ReturnType<typeof setTimeout> | null = null;

  private readonly config: ConnectionConfig;
  private readonly onStateChange: StateChangeCallback;
  private frozen = false;

  constructor(
    url: string,
    config: ConnectionConfig,
    onStateChange: StateChangeCallback,
  ) {
    this.id = `conn-${++connectionCounter}`;
    this.config = config;
    this.onStateChange = onStateChange;

    this.ws = new WebSocket(url);
    this.ws.onopen = this.handleOpen.bind(this);
    this.ws.onclose = this.handleClose.bind(this);
    this.ws.onerror = () => {}; // close always follows error
    this.ws.onmessage = this.handleMessage.bind(this);
  }

  get currentState(): ConnectionState {
    return this.state;
  }

  getStats(): ConnectionStats {
    const rtt = this.rttSamples;
    return {
      id: this.id,
      state: this.state,
      createdAt: this.createdAt,
      lastPingSentAt: this.lastPingSentAt,
      lastPongReceivedAt: this.lastPongReceivedAt,
      lastRtt: this.lastRtt,
      avgRtt: rtt.length > 0 ? Math.round(rtt.reduce((a, b) => a + b, 0) / rtt.length) : null,
      minRtt: rtt.length > 0 ? Math.min(...rtt) : null,
      maxRtt: rtt.length > 0 ? Math.max(...rtt) : null,
      pendingPingCount: this.pendingPings.size,
      totalPingsSent: this.totalPingsSent,
      totalPongsReceived: this.totalPongsReceived,
      staleAt: this.staleAt,
      deadAt: this.deadAt,
      closeCode: this.closeCode,
      closeReason: this.closeReason,
    };
  }

  sendPing(): void {
    if (this.frozen) return;
    if (this.state === ConnectionState.DEAD) return;
    if (this.ws.readyState !== WebSocket.OPEN) return;

    const nonce = crypto.randomUUID();
    const now = Date.now();

    const msg: PingMessage = { type: "ping", nonce, clientTs: now };
    this.pendingPings.set(nonce, now);
    this.lastPingSentAt = now;
    this.totalPingsSent++;

    this.ws.send(JSON.stringify(msg));

    // Per-ping timeout: if this specific pong never arrives, mark stale
    setTimeout(() => {
      if (this.pendingPings.has(nonce) && this.state !== ConnectionState.DEAD && !this.frozen) {
        this.markStale();
      }
    }, this.config.pongTimeoutMs);
  }

  close(reason: string): void {
    if (this.state === ConnectionState.DEAD) return;

    this.closeCode = 1000;
    this.closeReason = reason;
    this.clearAllTimers();

    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
      this.ws.close(1000, reason.slice(0, 123)); // WS reason max 123 bytes
    }

    this.transitionTo(ConnectionState.DEAD);
  }

  /** Send an immediate ping to verify the connection is alive. */
  checkAlive(): void {
    if (this.state !== ConnectionState.ALIVE && this.state !== ConnectionState.STALE) return;

    // Discard old pending pings that will never resolve (e.g. after page freeze)
    const now = Date.now();
    for (const [nonce, sentAt] of this.pendingPings) {
      if (now - sentAt > this.config.pongTimeoutMs * 3) {
        this.pendingPings.delete(nonce);
      }
    }

    this.sendPing();
  }

  setFrozen(frozen: boolean): void {
    this.frozen = frozen;
  }

  // --- Private ---

  private handleOpen(): void {
    this.transitionTo(ConnectionState.ALIVE);
    this.pingIntervalId = setInterval(() => this.sendPing(), this.config.pingIntervalMs);
    this.sendPing();
  }

  private handleClose(event: CloseEvent): void {
    if (this.state === ConnectionState.DEAD) return;
    this.closeCode = event.code;
    this.closeReason ??= `code=${event.code} reason=${event.reason || "(none)"}`;
    this.clearAllTimers();
    this.transitionTo(ConnectionState.DEAD);
  }

  private handleMessage(event: MessageEvent): void {
    if (this.frozen) return;

    let msg: PongMessage;
    try {
      msg = JSON.parse(event.data as string);
    } catch {
      return;
    }

    if (msg.type !== "pong") return;

    const sentAt = this.pendingPings.get(msg.nonce);
    if (sentAt === undefined) return;

    this.pendingPings.delete(msg.nonce);

    const now = Date.now();
    const rtt = now - sentAt;

    this.lastPongReceivedAt = now;
    this.lastRtt = rtt;
    this.totalPongsReceived++;

    this.rttSamples.push(rtt);
    if (this.rttSamples.length > ManagedConnection.MAX_RTT_SAMPLES) {
      this.rttSamples.shift();
    }

    // Recover from STALE if we got a pong
    if (this.state === ConnectionState.STALE) {
      if (this.staleTimeoutId !== null) {
        clearTimeout(this.staleTimeoutId);
        this.staleTimeoutId = null;
      }
      this.staleAt = null;
      this.transitionTo(ConnectionState.ALIVE);
    }
  }

  private markStale(): void {
    if (this.frozen) return;
    if (this.state !== ConnectionState.ALIVE) return;

    this.staleAt = Date.now();
    this.transitionTo(ConnectionState.STALE);

    // After the grace period, give up and kill the connection
    this.staleTimeoutId = setTimeout(() => {
      if (this.state === ConnectionState.STALE) {
        this.close(`stale for ${this.config.staleGracePeriodMs}ms without recovery`);
      }
    }, this.config.staleGracePeriodMs);
  }

  private clearAllTimers(): void {
    if (this.pingIntervalId !== null) {
      clearInterval(this.pingIntervalId);
      this.pingIntervalId = null;
    }
    if (this.staleTimeoutId !== null) {
      clearTimeout(this.staleTimeoutId);
      this.staleTimeoutId = null;
    }
  }

  private transitionTo(newState: ConnectionState): void {
    const oldState = this.state;
    if (oldState === newState) return;
    if (oldState === ConnectionState.DEAD) return; // terminal

    this.state = newState;
    if (newState === ConnectionState.DEAD) {
      this.deadAt = Date.now();
      this.clearAllTimers();
    }

    this.onStateChange(this, oldState, newState);
  }
}
