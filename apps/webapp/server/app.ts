import { createRequestHandler } from "@remix-run/express";
import type { Server as EngineServer } from "engine.io";
import express from "express";
import { createServer } from "http";
import { nanoid } from "nanoid";

export const app = express();

const { socketIo } = await import("../app/v3/handleSocketIo.server");
const { wss } = await import("../app/v3/handleWebsockets.server");
const { registryProxy } = await import("../app/v3/registryProxy.server");
const { apiRateLimiter } = await import("../app/services/apiRateLimit.server");
const { runWithHttpContext } = await import("../app/services/httpAsyncStorage.server");

// Registry proxy (with feature flag)
if (registryProxy && process.env.ENABLE_REGISTRY_PROXY === "true") {
  console.log(`🐳 Enabling container registry proxy to ${registryProxy.origin}`);
  app.all("/v2/*", async (req, res) => await registryProxy.call(req, res));
  app.all("/v2", async (req, res) => await registryProxy.call(req, res));
}

// Request context middleware
app.use((req, res, next) => {
  const requestId = nanoid();
  runWithHttpContext(
    {
      requestId,
      path: req.url,
      host: req.hostname,
      method: req.method,
    },
    next
  );
});

// Dashboard and API (with feature flag)
if (process.env.DASHBOARD_AND_API_DISABLED !== "true") {
  app.use(apiRateLimiter);

  app.use(
    createRequestHandler({
      // @ts-expect-error - virtual module provided by React Router at build time
      build: () => import("virtual:remix/server-build"),
      getLoadContext() {
        return {
          VALUE_FROM_EXPRESS: "Hello from Express",
        };
      },
    })
  );
}

// app is imported by server.js in viteServer.ssrLoadModule("./server/app.ts")
// So this should be attached to the same Express instance
const server = createServer(app);

// WebSocket setup
socketIo?.io.attach(server);
server.removeAllListeners("upgrade"); // prevent duplicate upgrades from listeners created by io.attach()

server.on("upgrade", async (req, socket, head) => {
  console.log(
    `Attemping to upgrade connection at url ${req.url} with headers: ${JSON.stringify(req.headers)}`
  );

  socket.on("error", (err) => {
    console.error("Connection upgrade error:", err);
  });

  const url = new URL(req.url ?? "", "http://localhost");

  // Upgrade socket.io connection
  if (url.pathname.startsWith("/socket.io/")) {
    console.log(`Socket.io client connected, upgrading their connection...`);

    // https://github.com/socketio/socket.io/issues/4693
    (socketIo?.io.engine as EngineServer).handleUpgrade(req, socket, head);
    return;
  }

  // Only upgrade the connecting if the path is `/ws`
  if (url.pathname !== "/ws") {
    // Setting the socket.destroy() error param causes an error event to be emitted which needs to be handled with socket.on("error") to prevent uncaught exceptions.
    socket.destroy(
      new Error(
        "Cannot connect because of invalid path: Please include `/ws` in the path of your upgrade request."
      )
    );
    return;
  }

  console.log(`Client connected, upgrading their connection...`);

  // Handle the WebSocket connection
  wss?.handleUpgrade(req, socket, head, (ws) => {
    wss?.emit("connection", ws, req);
  });
});
