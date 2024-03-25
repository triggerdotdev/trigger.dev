import path from "path";
import express from "express";
import compression from "compression";
import morgan from "morgan";
import { createRequestHandler } from "@remix-run/express";
import { WebSocketServer } from "ws";
import { broadcastDevReady, logDevReady } from "@remix-run/server-runtime";
import type { Server as IoServer } from "socket.io";
import type { Server as EngineServer } from "engine.io";
import { RegistryProxy } from "~/v3/registryProxy.server";
import { RateLimitMiddleware, apiRateLimiter } from "~/services/apiRateLimit.server";

const app = express();

if (process.env.DISABLE_COMPRESSION !== "1") {
  app.use(compression());
}

// http://expressjs.com/en/advanced/best-practice-security.html#at-a-minimum-disable-x-powered-by-header
app.disable("x-powered-by");

// Remix fingerprints its assets so we can cache forever.
app.use("/build", express.static("public/build", { immutable: true, maxAge: "1y" }));

// Everything else (like favicon.ico) is cached for an hour. You may want to be
// more aggressive with this caching.
app.use(express.static("public", { maxAge: "1h" }));

app.use(morgan("tiny"));

process.title = "node webapp-server";

const MODE = process.env.NODE_ENV;
const BUILD_DIR = path.join(process.cwd(), "build");
const build = require(BUILD_DIR);

const port = process.env.REMIX_APP_PORT || process.env.PORT || 3000;

if (process.env.HTTP_SERVER_DISABLED !== "true") {
  const socketIo: { io: IoServer } | undefined = build.entry.module.socketIo;
  const wss: WebSocketServer | undefined = build.entry.module.wss;
  const registryProxy: RegistryProxy | undefined = build.entry.module.registryProxy;
  const apiRateLimiter: RateLimitMiddleware = build.entry.module.apiRateLimiter;

  if (registryProxy && process.env.ENABLE_REGISTRY_PROXY === "true") {
    console.log(`🐳 Enabling container registry proxy to ${registryProxy.origin}`);

    // Adjusted to match /v2 and any subpath under /v2
    app.all("/v2/*", async (req, res) => {
      await registryProxy.call(req, res);
    });

    // This might also be necessary if you need to explicitly match /v2 as well
    app.all("/v2", async (req, res) => {
      await registryProxy.call(req, res);
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

  if (process.env.DASHBOARD_AND_API_DISABLED !== "true") {
    app.use(apiRateLimiter);

    app.all(
      "*",
      // @ts-ignore
      createRequestHandler({
        build,
        mode: MODE,
      })
    );
  } else {
    // we need to do the health check here at /healthcheck
    app.get("/healthcheck", (req, res) => {
      res.status(200).send("OK");
    });
  }

  const server = app.listen(port, () => {
    console.log(`✅ server ready: http://localhost:${port} [NODE_ENV: ${MODE}]`);

    if (MODE === "development") {
      broadcastDevReady(build)
        .then(() => logDevReady(build))
        .catch(console.error);
    }
  });

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
  server.removeAllListeners("upgrade"); // prevent duplicate upgrades from listeners created by io.attach()

  server.on("upgrade", async (req, socket, head) => {
    console.log(
      `Attemping to upgrade connection at url ${req.url} with headers: ${JSON.stringify(
        req.headers
      )}`
    );

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
} else {
  require(BUILD_DIR);
  console.log(`✅ app ready (skipping http server)`);
}
