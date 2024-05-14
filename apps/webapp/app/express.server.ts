import { createExpressApp } from "remix-create-express-app";
import http from "http";
import morgan from "morgan";
import compression from "compression";

import type { Server as EngineServer } from "engine.io";

import { registryProxy } from "./v3/registryProxy.server";
import { apiRateLimiter } from "./services/apiRateLimit.server";
import { socketIo } from "./v3/handleSocketIo.server";
import { wss } from "./v3/handleWebsockets.server";

export const express = createExpressApp({
  configure(app) {
    if (process.env.DISABLE_COMPRESSION !== "1") {
      app.use(compression());
    }

    // http://expressjs.com/en/advanced/best-practice-security.html#at-a-minimum-disable-x-powered-by-header
    app.disable("x-powered-by");
    app.use(morgan("tiny"));

    process.title = "node webapp-server";

    if (!process.env.PORT) {
      // TODO: Test REMIX_APP_PORT
      process.env.PORT = process.env.REMIX_APP_PORT || "3000";
    }

    if (process.env.HTTP_SERVER_DISABLED !== "true") {
      if (registryProxy && process.env.ENABLE_REGISTRY_PROXY === "true") {
        console.log(`🐳 Enabling container registry proxy to ${registryProxy.origin}`);

        // Adjusted to match /v2 and any subpath under /v2
        app.all("/v2/*", async (req, res) => {
          await registryProxy?.call(req, res);
        });

        // This might also be necessary if you need to explicitly match /v2 as well
        app.all("/v2", async (req, res) => {
          await registryProxy?.call(req, res);
        });
      }

      app.use((req, res, next) => {
        // helpful headers:
        res.set("Strict-Transport-Security", `max-age=${60 * 60 * 24 * 365 * 100}`);

        // /clean-urls/ -> /clean-urls
        if (req.path.endsWith("/") && req.path.length > 1) {
          const query = req.url.slice(req.path.length);
          const safepath = req.path.slice(0, -1).replace(/\/+/g, "/");
          res.redirect(301, safepath + query);
          return;
        }
        next();
      });
    }

    app.use(apiRateLimiter);
  },
  createServer(app) {
    const server = http.createServer(app);

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

    socketIo?.io.attach(server);
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

    return server;
  },
  // TODO: MISSING if (process.env.DASHBOARD_AND_API_DISABLED !== "true") {
});
