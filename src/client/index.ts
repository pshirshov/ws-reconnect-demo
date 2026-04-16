import { ConnectionManager } from "./manager.js";
import { DEFAULT_CONFIG } from "./connection.js";
import { UI } from "./ui.js";

const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
const wsUrl = `${protocol}//${window.location.host}/ws`;

let ui: UI | null = null;

const manager = new ConnectionManager(
  wsUrl,
  { ...DEFAULT_CONFIG },
  60_000,
  () => ui?.requestUpdate(),
);

const container = document.getElementById("app")!;
ui = new UI(manager, container);

manager.connect();
