import {
  createMcpHandler,
  isLegacyRequest,
  McpServer,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import express, {
  type ErrorRequestHandler,
  type Request as ExpressRequest,
  type RequestHandler,
  type Response as ExpressResponse,
} from "express";
import type { McpBearerAuthResult } from "./auth/bearer.server";
import type { McpPreAuthRateLimit } from "./preAuthRateLimit.server";
import {
  mcpTools,
  registerMcpTools,
  type McpToolContext,
  type McpToolDefinition,
} from "./registry.server";

export type McpRouterOptions = {
  allowedOrigin: string;
  authenticate: (request: Request) => Promise<McpBearerAuthResult>;
  rateLimit: RequestHandler;
  preAuth?: McpPreAuthRateLimit;
  tools?: McpToolDefinition[];
};

export function createMcpRouter(options: McpRouterOptions): express.Router {
  const tools = options.tools ?? mcpTools;
  const router = express.Router();
  const buildServer = (ctx: McpToolContext) => {
    const server = new McpServer(
      { name: "trigger.dev", version: "1.0.0" },
      {
        capabilities: { tools: {} },
        cacheHints: { "tools/list": { ttlMs: 0, cacheScope: "private" } },
      }
    );
    registerMcpTools(server, tools, ctx);
    return server;
  };
  router.all("/", hostOriginGuard(options.allowedOrigin));
  const modernContexts = new WeakMap<Request, Omit<McpToolContext, "era">>();
  const modern = createMcpHandler(
    ({ era, requestInfo }) => {
      const ctx = requestInfo && modernContexts.get(requestInfo);
      if (!ctx) throw new Error("MCP request context missing");
      return buildServer({ ...ctx, era });
    },
    { legacy: "reject", responseMode: "json" }
  );

  router.post(
    "/",
    options.preAuth?.gate ?? ((_req, _res, next) => next()),
    async (req, res, next) => {
      try {
        const request = headersOnlyRequest(req);
        const auth = await options.authenticate(request);
        if (!auth.ok) {
          await options.preAuth?.recordFailure(req);
          await sendFetchResponse(res, auth.response);
          return;
        }
        res.locals.mcpIdentity = auth.identity;
        res.locals.mcpRequest = request;
        next();
      } catch (error) {
        next(error);
      }
    },
    options.rateLimit,
    express.json({ limit: "1mb" }),
    async (req, res, next) => {
      const request: Request = res.locals.mcpRequest;
      const ctx = { identity: res.locals.mcpIdentity, request };
      try {
        if (Array.isArray(req.body)) {
          res.status(400).json({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32600, message: "Batch requests are not supported" },
          });
          return;
        }
        if (await isLegacyRequest(request, req.body)) {
          const server = buildServer({ ...ctx, era: "legacy" });
          await pipeFetchResponse(res, await serveLegacy(server, request, req.body, res));
          return;
        }
        if (req.body?.method === "subscriptions/listen") {
          res.status(404).json({
            jsonrpc: "2.0",
            id: req.body.id ?? null,
            error: { code: -32601, message: "Method not found" },
          });
          return;
        }
        modernContexts.set(request, ctx);
        await pipeFetchResponse(res, await modern.fetch(request, { parsedBody: req.body }));
      } catch (error) {
        next(error);
      }
    }
  );

  router.all("/", (_req, res) => {
    res.set("Allow", "POST").status(405).json({ error: "Method not allowed" });
  });

  router.use(bodyErrorHandler);

  return router;
}

function hostOriginGuard(allowedOrigin: string): RequestHandler {
  const { host, origin: allowed } = new URL(allowedOrigin);
  const allowedHost = host.toLowerCase();
  return (req, res, next) => {
    if (req.headers.host?.toLowerCase() !== allowedHost) {
      res.status(404).end();
      return;
    }
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== allowed) {
      res.status(403).end();
      return;
    }
    next();
  };
}

async function serveLegacy(
  server: McpServer,
  request: Request,
  parsedBody: unknown,
  res: ExpressResponse
) {
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  return transport.handleRequest(request, { parsedBody });
}

const bodyErrorHandler: ErrorRequestHandler = (error, _req, res, next) => {
  if (error?.type === "entity.parse.failed") {
    res.status(400).json({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    });
    return;
  }
  if (error?.type === "entity.too.large") {
    res.status(413).json({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "Request body too large" },
    });
    return;
  }
  next(error);
};

function headersOnlyRequest(req: ExpressRequest): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  return new Request(new URL(req.originalUrl, "http://localhost"), { method: "POST", headers });
}

async function sendFetchResponse(res: ExpressResponse, response: Response) {
  res.status(response.status);
  response.headers.forEach((value, name) => res.setHeader(name, value));
  res.send(await response.text());
}

async function pipeFetchResponse(res: ExpressResponse, response: Response) {
  res.status(response.status);
  response.headers.forEach((value, name) => res.setHeader(name, value));
  res.end(Buffer.from(await response.arrayBuffer()));
}
