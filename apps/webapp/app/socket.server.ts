import type http from "http";
import type { Server as EngineServer } from "engine.io";
import { singleton } from "./utils/singleton";
import { env } from "./env.server";
import { Redis } from "ioredis";
import { createAdapter } from "@socket.io/redis-adapter";
import { Server } from "socket.io";
import { WebSocketServer } from "ws";

// wss and io are used directly in express.server.ts without bundling
// so don't import from /app here
// entry.server.ts gets bundled, so see initializeWebSocketServer() there
// to add extra handlers that register on first request

export const wss = singleton("wss", () => {
  return new WebSocketServer({ noServer: true });
});

export const io = singleton("socketIo", () => {
  if (!env.REDIS_HOST || !env.REDIS_PORT) {
    console.warn("No redis config found, skipping socket.io");
    return new Server();
  }

  const pubClient = new Redis({
    port: env.REDIS_PORT,
    host: env.REDIS_HOST,
    username: env.REDIS_USERNAME,
    password: env.REDIS_PASSWORD,
    enableAutoPipelining: true,
    ...(env.REDIS_TLS_DISABLED === "true" ? {} : { tls: {} }),
  });
  const subClient = pubClient.duplicate();

  const io = new Server({
    adapter: createAdapter(pubClient, subClient, {
      key: "tr:socket.io:",
      publishOnSpecificResponseChannel: true,
    }),
  });

  return io;
});

export function registerSocketIo(server: http.Server) {
  server.keepAliveTimeout = 65 * 1000;

  process.on("SIGTERM", () => {
    server.close((err) => {
      if (err) {
        console.error("Error closing express server:", err);
      } else {
        console.log("Express server closed gracefully.");
      }
    });
  });

  io.on("connection", (socket) => {
    console.log(`[socket.io][${socket.id}] connection at url: ${socket.request.url}`);
  });

  console.log("Attaching socket.io");

  io.attach(server);
  // prevent duplicate upgrades from listeners created by io.attach()
  server.removeAllListeners("upgrade");

  server.on("upgrade", async (req, socket, head) => {
    console.log(
      `Attemping to upgrade connection at url ${req.url} with headers: ${JSON.stringify(
        req.headers
      )}`
    );

    socket.on("error", (err) => {
      console.error("Connection upgrade error:", err);
    });

    const url = new URL(req.url ?? "", "http://localhost");

    // Upgrade socket.io connection
    if (url.pathname.startsWith("/socket.io/")) {
      console.log(`Socket.io client connected, upgrading their connection...`);

      // https://github.com/socketio/socket.io/issues/4693
      (io.engine as EngineServer).handleUpgrade(req, socket, head);
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
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });
}
