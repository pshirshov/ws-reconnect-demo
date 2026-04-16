export interface PingMessage {
  type: "ping";
  nonce: string;
  clientTs: number;
}

export interface PongMessage {
  type: "pong";
  nonce: string;
  clientTs: number;
  serverTs: number;
}
