import { createExpressApp } from "remix-create-express-app";
import http from "http";
import morgan from "morgan";
import compression from "compression";
import { registryProxy } from "./v3/registryProxy.server";
import { apiRateLimiter } from "./services/apiRateLimit.server";
import { registerSocketIo } from "./socket.server";
import { runWithHttpContext } from "./entry.server";
import { nanoid } from "nanoid";

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

      app.use((req, res, next) => {
        // Generate a unique request ID for each request
        const requestId = nanoid();

        runWithHttpContext({ requestId, path: req.url, host: req.hostname }, next);
      });
    }

    app.use(apiRateLimiter);
  },
  createServer(app) {
    const server = http.createServer(app);

    registerSocketIo(server);

    return server;
  },
  // TODO: MISSING if (process.env.DASHBOARD_AND_API_DISABLED !== "true") {
});
