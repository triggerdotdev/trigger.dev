import path from "path";
import express from "express";
import compression from "compression";
import morgan from "morgan";
import { createRequestHandler } from "@remix-run/express";
import { WebSocketServer } from "ws";
import { broadcastDevReady, logDevReady } from "@remix-run/server-runtime";

const app = express();

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

const MODE = process.env.NODE_ENV;
const BUILD_DIR = path.join(process.cwd(), "build");
const build = require(BUILD_DIR);

app.all(
  "*",
  createRequestHandler({
    build,
    mode: MODE,
  })
);

const port = process.env.REMIX_APP_PORT || process.env.PORT || 3000;

if (process.env.HTTP_SERVER_DISABLED !== "true") {
  const wss: WebSocketServer | undefined = build.entry.module.wss;

  const server = app.listen(port, () => {
    console.log(`✅ app ready: http://localhost:${port} [NODE_ENV: ${MODE}]`);

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

  server.on("upgrade", async (req, socket, head) => {
    console.log(
      `Attemping to upgrade connection at url ${req.url} with headers: ${JSON.stringify(
        req.headers
      )}`
    );

    const url = new URL(req.url ?? "", "http://localhost");

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
