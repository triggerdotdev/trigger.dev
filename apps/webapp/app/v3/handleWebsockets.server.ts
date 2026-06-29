import { IncomingMessage } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { authenticateApiKey } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { singleton } from "../utils/singleton";
import { AuthenticatedSocketConnection } from "./authenticatedSocketConnection.server";
import { Gauge } from "prom-client";
import { metricsRegister } from "~/metrics.server";
import { isV3Disabled, V3_DEV_DEPRECATION_MESSAGE } from "./engineDeprecation.server";

export const wss = singleton("wss", initalizeWebSocketServer);

let authenticatedConnections: Map<string, AuthenticatedSocketConnection>;

function initalizeWebSocketServer() {
  const server = new WebSocketServer({ noServer: true });

  server.on("connection", handleWebSocketConnection);

  authenticatedConnections = new Map();

  new Gauge({
    name: "dev_authenticated_connections",
    help: "Number of authenticated dev connections",
    collect() {
      this.set(authenticatedConnections.size);
    },
    registers: [metricsRegister],
  });

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

  // This legacy websocket is only used by the v3 `trigger dev` CLI (v4 uses a
  // different dev transport). When the v3 shutdown is on, close it with a
  // graceful reason instead of letting the CLI sit connected with no work.
  if (isV3Disabled()) {
    logger.warn("Rejected deprecated v3 dev CLI websocket connection", {
      environmentId: authenticatedEnv.id,
      projectId: authenticatedEnv.projectId,
      organizationId: authenticatedEnv.organizationId,
    });
    ws.close(1008, V3_DEV_DEPRECATION_MESSAGE);
    return;
  }

  const authenticatedConnection = new AuthenticatedSocketConnection(
    ws,
    authenticatedEnv,
    req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "unknown"
  );

  authenticatedConnections.set(authenticatedConnection.id, authenticatedConnection);

  authenticatedConnection.onClose.attachOnce((closeEvent) => {
    logger.debug("Websocket closed", {
      closeEvent,
      authenticatedConnectionId: authenticatedConnection.id,
    });

    authenticatedConnections.delete(authenticatedConnection.id);
  });

  await authenticatedConnection.initialize();
}
