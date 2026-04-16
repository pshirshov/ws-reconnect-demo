import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, extname } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import type { PingMessage, PongMessage } from "./protocol.js";

const PORT = parseInt(process.env.PORT ?? "3000", 10);
const PUBLIC_DIR = join(process.cwd(), "public");

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const pathname = new URL(req.url!, `http://localhost`).pathname;
  const filePath = pathname === "/" ? "/index.html" : pathname;
  const fullPath = join(PUBLIC_DIR, filePath);

  // Prevent directory traversal
  if (!fullPath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const data = await readFile(fullPath);
    const ext = extname(fullPath);
    res.writeHead(200, { "Content-Type": MIME_TYPES[ext] ?? "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("Not Found");
  }
}

const server = createServer(handleHttp);
const wss = new WebSocketServer({ server, path: "/ws" });

let connectionCount = 0;

// Server-side heartbeat: detect and reap dead clients.
// Protocol-level ping every 30s; terminate if the previous ping went unanswered.
//
// Design:
// - Each ping carries a random 8-byte nonce. Only pongs echoing the current or
//   previous nonce clear the pending flag. This rejects unsolicited pong frames
//   (legal per RFC 6455 § 5.5.3) that could keep dead connections alive.
// - Termination is deferred to setImmediate (check phase) so that pong handlers
//   queued during an event-loop stall run first (I/O poll phase). Node event loop:
//   timers → I/O poll → check. This avoids false-positive disconnects after server
//   pauses, debugger stops, or CPU spikes.
// - The "previous nonce" acceptance window is needed because after a stall, the
//   timer may rotate the nonce before the pong for the old nonce is processed.
const HEARTBEAT_MS = 30_000;

interface SocketHeartbeat {
  nonce: Buffer;
  prevNonce: Buffer | null;
  pending: boolean;
}
const hbState = new WeakMap<WebSocket, SocketHeartbeat>();

const heartbeat = setInterval(() => {
  const candidates: WebSocket[] = [];
  for (const ws of wss.clients) {
    const hb = hbState.get(ws);
    if (!hb) continue;
    // Collect if previous ping went unanswered, then rotate and send new ping
    if (hb.pending) candidates.push(ws);
    const nonce = randomBytes(8);
    hb.prevNonce = hb.nonce;
    hb.nonce = nonce;
    hb.pending = true;
    ws.ping(nonce);
  }

  // Defer termination to setImmediate (runs after I/O poll phase, giving
  // buffered pong handlers a chance to clear the pending flag first).
  if (candidates.length > 0) {
    setImmediate(() => {
      for (const ws of candidates) {
        const hb = hbState.get(ws);
        if (hb && hb.pending) {
          console.log(`[ws] terminating unresponsive client`);
          ws.terminate();
        }
      }
    });
  }
}, HEARTBEAT_MS);

wss.on("close", () => clearInterval(heartbeat));

wss.on("connection", (ws: WebSocket) => {
  const id = ++connectionCount;
  console.log(`[ws] #${id} connected (total: ${wss.clients.size})`);

  hbState.set(ws, { nonce: randomBytes(8), prevNonce: null, pending: false });
  ws.on("pong", (data: Buffer) => {
    const hb = hbState.get(ws);
    if (!hb) return;
    // Only accept pongs echoing our current or previous nonce
    if (data.equals(hb.nonce) || (hb.prevNonce !== null && data.equals(hb.prevNonce))) {
      hb.pending = false;
    }
  });

  ws.on("message", (data: Buffer) => {
    let msg: PingMessage;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      console.error(`[ws] #${id} malformed message`);
      return;
    }

    if (msg.type === "ping") {
      const pong: PongMessage = {
        type: "pong",
        nonce: msg.nonce,
        clientTs: msg.clientTs,
        serverTs: Date.now(),
      };
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(pong));
      }
    }
  });

  ws.on("close", (code: number, reason: Buffer) => {
    console.log(`[ws] #${id} closed code=${code} reason=${reason.toString() || "(none)"}`);
  });

  ws.on("error", (err: Error) => {
    console.error(`[ws] #${id} error: ${err.message}`);
  });
});

server.listen(PORT, () => {
  console.log(`[server] http://localhost:${PORT}`);
});
