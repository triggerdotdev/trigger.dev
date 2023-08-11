import express, { Express } from "express";
import { TriggerClient } from "@trigger.dev/sdk";

/**
 * This is a convienence function to create an express server for the TriggerClient. If you want to use Trigger.dev with an existing express server, use `createMiddleware` instead.
 * @param client - The TriggerClient to use for the server.
 * @param port - The port to listen on, defaults to 8080.
 */
export function createExpressServer(
  client: TriggerClient,
  port: number = 8080,
  path: string = "/api/trigger"
): Express {
  const app = express();

  const middleware = createMiddleware(client, path);

  app.use(middleware);

  app.listen(port, () => {
    console.log(`Endpoint ${client.id} listening on port ${port}`);
  });

  return app;
}

/**
 * This function configures a middleware to use with an existing express server.
 * @param client - The TriggerClient to use for the middleware.
 * @param path - The path to listen on, defaults to "/api/trigger".
 *
 * @example
 * ```ts
 * import express from "express";
 * import { TriggerClient } from "@trigger.dev/sdk";
 * import { createMiddleware } from "@trigger.dev/express";
 *
 * const client = new TriggerClient({
 *  id: "my-client",
 *  apiKey: process.env["TRIGGER_API_KEY"]!,
 * });
 *
 * const app = express();
 *
 * const middleware = createMiddleware(client);
 *
 * app.use(middleware);
 *
 * app.listen(8080, () => {
 *  console.log("Listening on port 8080");
 * });
 * ```
 */
export function createMiddleware(client: TriggerClient, path: string = "/api/trigger") {
  return async (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (req.path !== path) {
      next();

      return;
    }

    if (req.method === "HEAD") {
      res.sendStatus(200);

      return;
    }

    const request = convertToStandardRequest(req);

    try {
      // This handshake handler knows how to authenticate requests,
      // call the run() function of the job, and so on
      const response = await client.handleRequest(request);

      if (!response) {
        res.status(404).json({ error: "Not found" });

        return;
      }

      // @ts-ignore
      // Optionally can do something with the job's finished
      // execution's response body
      return res.status(response.status).json(response.body);
    } catch (error) {
      next(error);
    }
  };
}

function convertToStandardRequest(req: express.Request) {
  // Prepare the request to be a fetch-compatible Request object:
  const requestHeaders = req.headers;
  const requestMethod = req.method;
  const responseHeaders = Object.create(null);

  for (const [headerName, headerValue] of Object.entries(requestHeaders)) {
    // @ts-ignore
    responseHeaders[headerName] = headerValue;
  }

  // Create a new Request object to be passed to the TriggerClient
  // where we pass the clone the incoming request metadata such as
  // headers, method, body.
  // @ts-ignore
  return new Request("https://express.js/api/trigger", {
    headers: responseHeaders,
    method: requestMethod,
    body: req.body ? JSON.stringify(req.body) : req,
    duplex: "half",
  });
}
