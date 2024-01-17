import { IncomingMessage } from "node:http";
import { WebSocketServer } from "ws";
import { AuthenticatedEnvironment, authenticateApiKey } from "~/services/apiAuth.server";
import { singleton } from "../utils/singleton";
import { randomUUID } from "node:crypto";
import { Evt } from "evt";
import { logger } from "~/services/logger.server";

export const wss = singleton("wss", initalizeWebSocketServer);

let handlers: Map<string, WebsocketHandlers>;

function initalizeWebSocketServer() {
  const server = new WebSocketServer({ noServer: true });

  server.on("connection", handleWebSocketConnection);

  handlers = new Map();

  return server;
}

async function handleWebSocketConnection(ws: WebSocket, req: IncomingMessage) {
  const authHeader = req.headers.authorization;

  if (!authHeader || typeof authHeader !== "string") {
    ws.close(1008, "Missing Authorization header");
    return;
  }

  const [authType, apiKey] = authHeader.split(" ");

  if (authType !== "Bearer" || !apiKey) {
    ws.close(1008, "Invalid Authorization header");
    return;
  }

  const authenticationResult = await authenticateApiKey(apiKey);

  if (!authenticationResult) {
    ws.close(1008, "Invalid API key");
    return;
  }

  const authenticatedEnv = authenticationResult.environment;

  const handler = new WebsocketHandlers(ws, authenticatedEnv);

  handlers.set(handler.id, handler);

  handler.onClose.attach((closeEvent) => {
    logger.debug("Websocket closed", { closeEvent });

    handlers.delete(handler.id);
  });

  await handler.start();
}

class WebsocketHandlers {
  public id: string;
  public onClose: Evt<CloseEvent> = new Evt();

  constructor(public ws: WebSocket, public authenticatedEnv: AuthenticatedEnvironment) {
    this.id = randomUUID();

    ws.onclose = this.#handleClose.bind(this);
    ws.onmessage = this.#handleMessage.bind(this);
    ws.onerror = this.#handleError.bind(this);
  }

  async start() {}

  async #handleMessage(ev: MessageEvent) {
    const data = JSON.parse(ev.data.toString());

    logger.debug("Websocket message received", { data });
  }

  async #handleClose(ev: CloseEvent) {
    this.onClose.post(ev);
  }

  async #handleError(ev: Event) {
    logger.error("Websocket error", { ev });
  }
}
