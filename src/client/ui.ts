import type { ConnectionManager } from "./manager.js";
import { ConnectionState, DEFAULT_CONFIG } from "./connection.js";
import type { ConnectionConfig, ConnectionStats } from "./connection.js";

export class UI {
  private manager: ConnectionManager;
  private container: HTMLElement;
  private rafId: number | null = null;
  private lastRenderAt = 0;
  private static readonly RENDER_INTERVAL_MS = 100;

  constructor(manager: ConnectionManager, container: HTMLElement) {
    this.manager = manager;
    this.container = container;

    this.renderShell();
    this.setupEventListeners();
    this.scheduleUpdate();
  }

  /** Called by the manager on state changes for immediate UI refresh. */
  requestUpdate(): void {
    this.renderDynamic();
  }

  destroy(): void {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
  }

  // --- Rendering ---

  private renderShell(): void {
    this.container.innerHTML = `
      <h1>WebSocket Reconnect Demo</h1>

      <div class="section">
        <h2>Configuration</h2>
        <div class="config-grid">
          <label>Ping interval <input type="number" id="cfg-ping" value="${DEFAULT_CONFIG.pingIntervalMs}" min="500" step="500">ms</label>
          <label>Pong timeout <input type="number" id="cfg-timeout" value="${DEFAULT_CONFIG.pongTimeoutMs}" min="500" step="500">ms</label>
          <label>Connect timeout <input type="number" id="cfg-connect" value="${DEFAULT_CONFIG.connectTimeoutMs}" min="1000" step="1000">ms</label>
          <label>Stale grace <input type="number" id="cfg-grace" value="${DEFAULT_CONFIG.staleGracePeriodMs}" min="1000" step="1000">ms</label>
          <label>Dead retention <input type="number" id="cfg-retention" value="60000" min="5000" step="5000">ms</label>
        </div>
        <div class="btn-row">
          <button id="btn-apply">Apply &amp; Reconnect</button>
        </div>
      </div>

      <div class="section">
        <h2>Actions</h2>
        <div class="btn-row">
          <button id="btn-f5">Freeze 5 s</button>
          <button id="btn-f15">Freeze 15 s</button>
          <button id="btn-f30">Freeze 30 s</button>
          <button id="btn-kill">Kill Active</button>
          <button id="btn-reconn">Close All &amp; Reconnect</button>
        </div>
      </div>

      <div class="section" id="status-section">
        <h2>Status</h2>
        <div id="status-bar"></div>
      </div>

      <div class="section">
        <h2>Connections</h2>
        <div id="conn-list"></div>
      </div>

      <div class="section">
        <h2>Event Log</h2>
        <div id="log-list"></div>
      </div>
    `;
  }

  private setupEventListeners(): void {
    const $ = (id: string) => document.getElementById(id)!;

    $("btn-apply").addEventListener("click", () => {
      const cfg: ConnectionConfig = {
        pingIntervalMs: parseInt(($("cfg-ping") as HTMLInputElement).value),
        pongTimeoutMs: parseInt(($("cfg-timeout") as HTMLInputElement).value),
        connectTimeoutMs: parseInt(($("cfg-connect") as HTMLInputElement).value),
        staleGracePeriodMs: parseInt(($("cfg-grace") as HTMLInputElement).value),
      };
      const retention = parseInt(($("cfg-retention") as HTMLInputElement).value);
      this.manager.updateConfig(cfg, retention);
      this.manager.closeAllAndReconnect();
    });

    $("btn-f5").addEventListener("click", () => this.manager.simulateFreeze(5_000));
    $("btn-f15").addEventListener("click", () => this.manager.simulateFreeze(15_000));
    $("btn-f30").addEventListener("click", () => this.manager.simulateFreeze(30_000));
    $("btn-kill").addEventListener("click", () => this.manager.killActiveConnection());
    $("btn-reconn").addEventListener("click", () => this.manager.closeAllAndReconnect());
  }

  private scheduleUpdate(): void {
    this.rafId = requestAnimationFrame(() => {
      const now = Date.now();
      if (now - this.lastRenderAt >= UI.RENDER_INTERVAL_MS) {
        this.renderDynamic();
        this.lastRenderAt = now;
      }
      this.scheduleUpdate();
    });
  }

  private renderDynamic(): void {
    const stats = this.manager.getStats();
    this.renderStatus(stats);
    this.renderConnections(stats);
    this.renderLog();
    this.updateTitle(stats);
  }

  private renderStatus(stats: ReturnType<ConnectionManager["getStats"]>): void {
    const counts = { NEW: 0, ALIVE: 0, STALE: 0, DEAD: 0 };
    for (const c of stats.connections) counts[c.state]++;

    const parts: string[] = [];
    if (counts.ALIVE) parts.push(`<span class="state-alive">${counts.ALIVE} alive</span>`);
    if (counts.NEW) parts.push(`<span class="state-new">${counts.NEW} new</span>`);
    if (counts.STALE) parts.push(`<span class="state-stale">${counts.STALE} stale</span>`);
    if (counts.DEAD) parts.push(`<span class="state-dead">${counts.DEAD} dead</span>`);

    const frozen = stats.frozen ? ' <span class="frozen-badge">FROZEN</span>' : "";
    document.getElementById("status-bar")!.innerHTML =
      `${stats.connections.length} connection${stats.connections.length !== 1 ? "s" : ""}: ${parts.join(", ") || "none"}${frozen}`;
  }

  private renderConnections(stats: ReturnType<ConnectionManager["getStats"]>): void {
    const el = document.getElementById("conn-list")!;

    if (stats.connections.length === 0) {
      el.innerHTML = '<div class="empty">No connections</div>';
      return;
    }

    el.innerHTML = stats.connections.map(c => this.renderCard(c, stats.activeConnectionId, stats.frozen)).join("");
  }

  private renderCard(c: ConnectionStats, activeId: string | null, frozen: boolean): string {
    const isActive = c.id === activeId;
    const sl = c.state.toLowerCase();

    return `
      <div class="card card-${sl}${isActive ? " card-active" : ""}">
        <div class="card-hdr">
          <span class="card-id">${esc(c.id)}</span>
          <span class="badge badge-${sl}">${c.state}</span>
          ${isActive ? '<span class="badge badge-active">active</span>' : ""}
          ${frozen ? '<span class="badge badge-frozen">frozen</span>' : ""}
        </div>
        <div class="card-body">
          <div class="row">
            <span>Created ${timeAgo(c.createdAt)}</span>
            ${c.staleAt !== null ? `<span>Stale ${timeAgo(c.staleAt)}</span>` : ""}
            ${c.deadAt !== null ? `<span>Died ${timeAgo(c.deadAt)}</span>` : ""}
          </div>
          <div class="row">
            <span>Ping ${c.lastPingSentAt !== null ? timeAgo(c.lastPingSentAt) : "—"}</span>
            <span>Pong ${c.lastPongReceivedAt !== null ? timeAgo(c.lastPongReceivedAt) : "—"}</span>
            <span>Pending ${c.pendingPingCount}</span>
          </div>
          <div class="row">
            <span>RTT ${ms(c.lastRtt)}</span>
            <span>avg ${ms(c.avgRtt)}</span>
            <span>min ${ms(c.minRtt)}</span>
            <span>max ${ms(c.maxRtt)}</span>
            ${c.lastRtt !== null ? `<span class="rtt-bar"><span class="rtt-fill" style="width:${Math.min(c.lastRtt, 300) / 3}%"></span></span>` : ""}
          </div>
          <div class="row">
            <span>Sent ${c.totalPingsSent}</span>
            <span>Received ${c.totalPongsReceived}</span>
            ${c.totalPingsSent > 0 ? `<span>Loss ${((1 - c.totalPongsReceived / c.totalPingsSent) * 100).toFixed(1)}%</span>` : ""}
          </div>
          ${c.closeReason ? `<div class="row close-reason">Closed: ${c.closeCode !== null ? `[${c.closeCode}] ` : ""}${esc(c.closeReason)}</div>` : ""}
        </div>
      </div>`;
  }

  private renderLog(): void {
    const entries = this.manager.getLog();
    const el = document.getElementById("log-list")!;

    // Only render first 100 entries
    const html: string[] = [];
    const limit = Math.min(entries.length, 100);
    for (let i = 0; i < limit; i++) {
      const e = entries[i];
      const t = new Date(e.timestamp);
      const ts = t.toLocaleTimeString("en-US", { hour12: false, fractionalSecondDigits: 3 } as Intl.DateTimeFormatOptions);
      html.push(`<div class="log-row"><span class="log-ts">${ts}</span> ${esc(e.message)}</div>`);
    }
    el.innerHTML = html.join("");
  }

  private updateTitle(stats: ReturnType<ConnectionManager["getStats"]>): void {
    const alive = stats.connections.filter(c => c.state === ConnectionState.ALIVE).length;
    const total = stats.connections.length;
    const frozen = stats.frozen ? " [FROZEN]" : "";
    document.title = `(${alive}/${total}) WS Reconnect${frozen}`;
  }
}

// --- Helpers ---

function timeAgo(ts: number): string {
  const d = Date.now() - ts;
  if (d < 1_000) return "now";
  if (d < 60_000) return `${Math.floor(d / 1_000)}s ago`;
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ${Math.floor((d % 60_000) / 1_000)}s ago`;
  return `${Math.floor(d / 3_600_000)}h ago`;
}

function ms(val: number | null): string {
  return val !== null ? `${val}ms` : "—";
}

function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
