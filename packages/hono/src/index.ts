import type { TriggerClient } from "@trigger.dev/sdk";
import type { Env, Hono, HonoRequest, MiddlewareHandler } from "hono";

export function createMiddleware(
  client: TriggerClient,
  path: string = "/api/trigger"
): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.path !== path) {
      return await next();
    }

    if (c.req.method === "HEAD") {
      return new Response(null, { status: 200 });
    }

    const request = convertToStandardRequest(c.req);

    const response = await client.handleRequest(request);

    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: response.headers,
    });
  };
}

export function addMiddleware<TEnv extends Env>(
  app: Hono<TEnv>,
  callback: (env: TEnv["Bindings"]) => TriggerClient
) {
  app.use("/api/trigger", async (c, next) => {
    const client = callback(c.env);

    if (c.req.method === "HEAD") {
      return new Response(null, { status: 200 });
    }

    const request = convertToStandardRequest(c.req);

    const response = await client.handleRequest(request);

    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: response.headers,
    });
  });
}

function convertToStandardRequest(req: HonoRequest): Request {
  const headers: Record<string, string> = {};
  const entries = req.raw.headers.entries();

  for (const [key, value] of entries) {
    headers[key] = value;
  }

  return new Request(req.raw.url, {
    method: req.raw.method,
    headers,
    body: req.raw.body,
    // @ts-ignore
    duplex: "half",
  });
}
