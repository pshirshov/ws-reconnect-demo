import { createServer, IncomingMessage, ServerResponse } from "node:http";
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

wss.on("connection", (ws: WebSocket) => {
  const id = ++connectionCount;
  console.log(`[ws] #${id} connected (total: ${wss.clients.size})`);

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

  // Server-side keep-alive: protocol-level ping every 30s to detect dead TCP connections
  const keepAlive = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.ping();
    }
  }, 30_000);

  ws.on("close", () => clearInterval(keepAlive));
});

server.listen(PORT, () => {
  console.log(`[server] http://localhost:${PORT}`);
});
