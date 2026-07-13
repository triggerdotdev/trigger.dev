import type { IncomingMessage } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { authenticateApiKey } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { singleton } from "../utils/singleton";
import { V3_DEV_DEPRECATION_MESSAGE } from "./engineDeprecation.server";

export const wss = singleton("wss", initalizeWebSocketServer);

function initalizeWebSocketServer() {
  const server = new WebSocketServer({ noServer: true });

  server.on("connection", handleWebSocketConnection);

  return server;
}

async function handleWebSocketConnection(ws: WebSocket, req: IncomingMessage) {
  logger.debug("Handle websocket connection", {
    ipAddress: req.headers["x-forwarded-for"] || req.socket.remoteAddress,
  });

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

  if (!authenticationResult || !authenticationResult.ok) {
    ws.close(1008, "Invalid API key");
    return;
  }

  const authenticatedEnv = authenticationResult.environment;

  // This websocket is only used by the legacy v3 `trigger dev` CLI (v4 uses a
  // different dev transport). The v3 engine is end-of-lifed, so there is no
  // longer any work to run here — close with the graceful upgrade message so
  // an old CLI is told what to do instead of sitting connected.
  logger.warn("Rejected deprecated v3 dev CLI websocket connection", {
    environmentId: authenticatedEnv.id,
    projectId: authenticatedEnv.projectId,
    organizationId: authenticatedEnv.organizationId,
  });
  ws.close(1008, V3_DEV_DEPRECATION_MESSAGE);
}
