import { IncomingMessage } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { authenticateApiKey } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { singleton } from "../utils/singleton";
import { AuthenticatedSocketConnection } from "./authenticatedSocketConnection.server";

export const wss = singleton("wss", initalizeWebSocketServer);

let authenticatedConnections: Map<string, AuthenticatedSocketConnection>;

function initalizeWebSocketServer() {
  const server = new WebSocketServer({ noServer: true });

  server.on("connection", handleWebSocketConnection);

  authenticatedConnections = new Map();

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

  const authenticatedConnection = new AuthenticatedSocketConnection(ws, authenticatedEnv);

  authenticatedConnections.set(authenticatedConnection.id, authenticatedConnection);

  authenticatedConnection.onClose.attach((closeEvent) => {
    logger.debug("Websocket closed", { closeEvent });

    authenticatedConnections.delete(authenticatedConnection.id);
  });

  await authenticatedConnection.initialize();
}
