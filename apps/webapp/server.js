import compression from "compression";
import express from "express";
import morgan from "morgan";

const BUILD_PATH = "./build/server/index.js";
const app = express();
const MODE = process.env.NODE_ENV;
const port = process.env.REMIX_APP_PORT || process.env.PORT || 3000;

// Basic middleware setup
if (process.env.DISABLE_COMPRESSION !== "1") {
  app.use(compression());
}

app.disable("x-powered-by");

// Security and URL cleanup middleware
app.use((req, res, next) => {
  res.set("Strict-Transport-Security", `max-age=${60 * 60 * 24 * 365 * 100}`);
  if (req.path.endsWith("/") && req.path.length > 1) {
    const query = req.url.slice(req.path.length);
    const safepath = req.path.slice(0, -1).replace(/\/+/g, "/");
    res.redirect(301, safepath + query);
    return;
  }
  next();
});

// Only configure the app if HTTP server is enabled
if (process.env.HTTP_SERVER_DISABLED !== "true") {
  if (MODE === "development") {
    async function createViteServer() {
      const vite = await import("vite");
      const viteServer = await vite.createServer({
        server: { middlewareMode: true },
        appType: "custom",
      });

      app.use(viteServer.middlewares);

      // Import the app from the server/app.ts file
      // The server.ts stuff that imports from the app has been turned into a middleware
      // This allows Vite to bundle it and then we import it here
      app.use(async (req, res, next) => {
        try {
          /** @type {import("./server/app.ts")} */
          const source = await viteServer.ssrLoadModule("./server/app.ts");

          return source.app(req, res, next);
        } catch (error) {
          if (error instanceof Error) {
            viteServer.ssrFixStacktrace(error);
          }
          next(error);
        }
      });
    }

    await createViteServer().catch((err) => {
      console.error("Error setting up Vite dev server:", err);
    });
  } else {
    console.log("Starting production server");
    app.use("/assets", express.static("build/client/assets", { immutable: true, maxAge: "1y" }));
    app.use(express.static("build/client", { maxAge: "1h" }));

    // Imports `app` export from './server/app.ts'
    app.use(await import(BUILD_PATH).then((mod) => mod.app));
  }

  if (process.env.DASHBOARD_AND_API_DISABLED === "true") {
    app.get("/healthcheck", (_, res) => res.status(200).send("OK"));
  }
}

app.use(
  morgan("tiny", {
    skip: (req) => {
      // Vite dev server logs /@fs/ requests and hot reloads for specific files
      // Unsure if this is the best way to suppress them from logs
      if (req.url.startsWith("/@")) return true;
      if (req.url.match(/\.[jt]sx?$/)) return true;
      return false;
    },
  })
);

const server = app.listen(port, async () => {
  try {
    // Ping the server and send an initial request
    // That will trigger the Remix handler and should guarantee that Remix will break immediately if there's an issue
    await performHealthcheck(port);
    console.log(`✅ server ready: http://localhost:${port} [NODE_ENV: ${MODE}]`);
  } catch (error) {
    console.error("Server started but healthcheck failed:", error);
    process.exit(1);
  }
});

// Server cleanup
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

async function performHealthcheck(port, retries = 5, delay = 1000) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(`http://localhost:${port}/`);

      if (!res.ok) {
        throw new Error(`Healthcheck failed with status ${res.status}`);
      }

      return res.text();
    } catch (error) {
      if (i === retries - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}
