import { createRequestHandler } from "@remix-run/express";
import { broadcastDevReady, logDevReady } from "@remix-run/server-runtime";
import compression from "compression";
import type { Server as EngineServer } from "engine.io";
import express from "express";
import morgan from "morgan";
import { nanoid } from "nanoid";
import path from "path";
import type { Server as IoServer } from "socket.io";
import { WebSocketServer } from "ws";
import { RateLimitMiddleware } from "~/services/apiRateLimit.server";
import { type RunWithHttpContextFunction } from "~/services/httpAsyncStorage.server";

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
  const apiRateLimiter: RateLimitMiddleware = build.entry.module.apiRateLimiter;
  const engineRateLimiter: RateLimitMiddleware = build.entry.module.engineRateLimiter;
  const runWithHttpContext: RunWithHttpContextFunction = build.entry.module.runWithHttpContext;

  app.use((req, res, next) => {
    // helpful headers:
    res.set("Strict-Transport-Security", `max-age=${60 * 60 * 24 * 365 * 100}`);

    // Add X-Robots-Tag header for test-cloud.trigger.dev
    if (req.hostname !== "cloud.trigger.dev") {
      res.set("X-Robots-Tag", "noindex, nofollow");
    }

    // /clean-urls/ -> /clean-urls
    if (req.path.endsWith("/") && req.path.length > 1) {
      const query = req.url.slice(req.path.length);
      const safepath = req.path.slice(0, -1).replace(/\/+/g, "/");
      res.redirect(301, safepath + query);
      return;
    }
    next();
  });

  app.use((req, res, next) => {
    // Generate a unique request ID for each request
    const requestId = nanoid();

    runWithHttpContext({ requestId, path: req.url, host: req.hostname, method: req.method }, next);
  });

  if (process.env.DASHBOARD_AND_API_DISABLED !== "true") {
    if (process.env.ALLOW_ONLY_REALTIME_API === "true") {
      // Block all requests that do not start with /realtime
      app.use((req, res, next) => {
        // Make sure /healthcheck is still accessible
        if (!req.url.startsWith("/realtime") && req.url !== "/healthcheck") {
          res.status(404).send("Not Found");
          return;
        }

        next();
      });
    }

    app.use(apiRateLimiter);
    app.use(engineRateLimiter);

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
  // Mitigate against https://github.com/triggerdotdev/trigger.dev/security/dependabot/128
  // by not allowing 2000+ headers to be sent and causing a DoS
  // headers will instead be limited by the maxHeaderSize
  server.maxHeadersCount = 0;

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
} else {
  require(BUILD_DIR);
  console.log(`✅ app ready (skipping http server)`);
}
