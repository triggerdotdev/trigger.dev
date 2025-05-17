import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { z } from "zod";
import { SimpleStructuredLogger } from "../utils/structuredLogger.js";
import { HttpReply, getJsonBody } from "../apps/http.js";
import { Registry, Histogram, Counter } from "prom-client";
import { tryCatch } from "../../utils.js";

const logger = new SimpleStructuredLogger("http-server");

type RouteHandler<
  TParams extends z.ZodFirstPartySchemaTypes = z.ZodUnknown,
  TQuery extends z.ZodFirstPartySchemaTypes = z.ZodUnknown,
  TBody extends z.ZodFirstPartySchemaTypes = z.ZodUnknown,
> = (ctx: {
  params: z.infer<TParams>;
  queryParams: z.infer<TQuery>;
  body: z.infer<TBody>;
  req: IncomingMessage;
  res: ServerResponse;
  reply: HttpReply;
}) => Promise<any>;

interface RouteDefinition<
  TParams extends z.ZodFirstPartySchemaTypes = z.ZodUnknown,
  TQuery extends z.ZodFirstPartySchemaTypes = z.ZodUnknown,
  TBody extends z.ZodFirstPartySchemaTypes = z.ZodUnknown,
> {
  paramsSchema?: TParams;
  querySchema?: TQuery;
  bodySchema?: TBody;
  keepConnectionAlive?: boolean;
  handler: RouteHandler<TParams, TQuery, TBody>;
}

const HttpMethod = z.enum([
  "GET",
  "POST",
  "PUT",
  "DELETE",
  "PATCH",
  "OPTIONS",
  "HEAD",
  "CONNECT",
  "TRACE",
]);
type HttpMethod = z.infer<typeof HttpMethod>;

type RouteMap = Partial<{
  [path: string]: Partial<{
    [method in HttpMethod]: RouteDefinition;
  }>;
}>;

type HttpServerOptions = {
  port: number;
  host: string;
  metrics?: {
    register?: Registry;
    expose?: boolean;
    collect?: boolean;
  };
};

export class HttpServer {
  private static httpRequestDuration?: Histogram;
  private static httpRequestTotal?: Counter;

  private readonly metricsRegister?: Registry;

  private readonly port: number;
  private readonly host: string;
  private routes: RouteMap = {};
  public readonly server: ReturnType<typeof createServer>;

  constructor(options: HttpServerOptions) {
    this.port = options.port;
    this.host = options.host;
    this.metricsRegister = options.metrics?.register;
    const collectMetrics = options.metrics?.collect ?? true;
    const exposeMetrics = options.metrics?.expose ?? false;

    // Initialize metrics only if registry is provided and not already initialized
    if (this.metricsRegister && collectMetrics) {
      if (!HttpServer.httpRequestDuration) {
        HttpServer.httpRequestDuration = new Histogram({
          name: "http_request_duration_seconds",
          help: "Duration of HTTP requests in seconds",
          labelNames: ["method", "route", "status", "port", "host"],
          registers: [this.metricsRegister],
        });
      }

      if (!HttpServer.httpRequestTotal) {
        HttpServer.httpRequestTotal = new Counter({
          name: "http_requests_total",
          help: "Total number of HTTP requests",
          labelNames: ["method", "route", "status", "port", "host"],
          registers: [this.metricsRegister],
        });
      }
    }

    if (exposeMetrics) {
      // Register metrics route
      this.route("/metrics", "GET", {
        handler: async ({ reply }) => {
          if (!this.metricsRegister) {
            return reply.text("Metrics registry not found", 500);
          }

          return reply.text(
            await this.metricsRegister.metrics(),
            200,
            this.metricsRegister.contentType
          );
        },
      });
    }

    this.server = createServer(async (req, res) => {
      const reply = new HttpReply(res);
      const startTime = process.hrtime();

      try {
        const { url, method } = req;

        logger.debug(`${method} ${url?.split("?")[0]}`, { url });

        if (!url) {
          logger.error("Request URL is empty", { method });
          return reply.text("Request URL is empty", 400);
        }

        if (!method) {
          logger.error("Request method is empty", { url });
          return reply.text("Request method is empty", 400);
        }

        const httpMethod = HttpMethod.safeParse(method);

        if (!httpMethod.success) {
          logger.error("HTTP method not implemented", { url, method });
          return reply.text(`HTTP method ${method} not implemented`, 400);
        }

        const route = this.findRoute(url);

        if (!route) {
          logger.error("No route match", { url, method });
          return reply.empty(404);
        }

        const routeDefinition = this.routes[route]?.[httpMethod.data];

        if (!routeDefinition) {
          logger.error("Invalid method", { url, method, parsedMethod: httpMethod.data });
          return reply.empty(405);
        }

        const { handler, paramsSchema, querySchema, bodySchema, keepConnectionAlive } =
          routeDefinition;

        const params = this.parseRouteParams(route, url);
        const parsedParams = this.optionalSchema(paramsSchema, params);

        if (!parsedParams.success) {
          logger.error("Failed to parse params schema", { url, method, params });
          return reply.text("Invalid params", 400);
        }

        const queryParams = this.parseQueryParams(url);
        const parsedQueryParams = this.optionalSchema(querySchema, queryParams);

        if (!parsedQueryParams.success) {
          logger.error("Failed to parse query params schema", { url, method, queryParams });
          return reply.text("Invalid query params", 400);
        }

        const body = await getJsonBody(req);
        const parsedBody = this.optionalSchema(bodySchema, body);

        if (!parsedBody.success) {
          logger.error("Failed to parse body schema", {
            url,
            method,
            body,
            error: parsedBody.error,
          });
          return reply.json({ ok: false, error: "Invalid body" }, false, 400);
        }

        const [error] = await tryCatch(
          handler({
            reply,
            req,
            res,
            params: parsedParams.data,
            queryParams: parsedQueryParams.data,
            body: parsedBody.data,
          })
        );

        if (error) {
          logger.error("Route handler error", { error: this.formatError(error) });
          return reply.empty(500);
        }

        if (keepConnectionAlive) {
          // Return early to keep the connection alive
          return;
        }
      } catch (error) {
        logger.error("Failed to handle request", { error: this.formatError(error) });
        return reply.empty(500);
      } finally {
        this.collectMetrics(req, res, startTime);
      }

      return reply.empty(501);
    });

    this.server.on("clientError", (_, socket) => {
      socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    });
  }

  route<
    TParams extends z.ZodFirstPartySchemaTypes = z.ZodUnknown,
    TQuery extends z.ZodFirstPartySchemaTypes = z.ZodUnknown,
    TBody extends z.ZodFirstPartySchemaTypes = z.ZodUnknown,
  >(path: `/${string}`, method: HttpMethod, definition: RouteDefinition<TParams, TQuery, TBody>) {
    this.routes[path] = {
      ...this.routes[path],
      [method]: definition,
    };
    return this;
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(this.port, this.host, () => {
        logger.log("HTTP server listening on port", { port: this.port });
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      this.server.close(() => {
        logger.log("HTTP server stopped");
        resolve();
      });
    });
  }

  private collectMetrics(req: IncomingMessage, res: ServerResponse, startTime: [number, number]) {
    if (!this.metricsRegister || !HttpServer.httpRequestDuration || !HttpServer.httpRequestTotal) {
      return;
    }

    const [seconds, nanoseconds] = process.hrtime(startTime);
    const duration = seconds + nanoseconds / 1e9;

    const route = this.findRoute(req.url ?? "") ?? "unknown";
    const method = req.method ?? "unknown";
    const status = res.statusCode.toString();

    HttpServer.httpRequestDuration.observe(
      { method, route, status, port: this.port, host: this.host },
      duration
    );
    HttpServer.httpRequestTotal.inc({ method, route, status, port: this.port, host: this.host });
  }

  private optionalSchema<
    TSchema extends z.ZodFirstPartySchemaTypes | undefined,
    TData extends TSchema extends z.ZodFirstPartySchemaTypes ? z.TypeOf<TSchema> : TData,
  >(
    schema: TSchema,
    data: TData
  ):
    | {
        success: false;
        error: string;
      }
    | {
        success: true;
        data: TSchema extends z.ZodFirstPartySchemaTypes ? z.infer<TSchema> : TData;
      } {
    if (!schema) {
      return { success: true, data };
    }

    const parsed = schema.safeParse(data);

    if (!parsed.success) {
      return { success: false, error: parsed.error.message };
    }

    return { success: true, data: parsed.data };
  }

  private parseQueryParams(url: string): Record<string, string> {
    const { searchParams } = new URL(url, "http://localhost");
    return Object.fromEntries(searchParams.entries());
  }

  private parseRouteParams(route: string, url: string): Record<string, string> {
    const params: Record<string, string> = {};

    const routeParts = route.split("/");
    const urlWithoutQueryParams = url.split("?")[0];

    if (!urlWithoutQueryParams) {
      return params;
    }

    const urlParts = urlWithoutQueryParams.split("/");

    routeParts.forEach((part, index) => {
      if (part.startsWith(":")) {
        const paramName = part.slice(1);
        const urlPart = urlParts[index];

        if (!urlPart) {
          return;
        }

        params[paramName] = urlPart;
      }
    });

    return params;
  }

  private findRoute(url: string): string | null {
    for (const route in this.routes) {
      const routeParts = route.split("/");
      const urlWithoutQueryParams = url.split("?")[0];

      if (!urlWithoutQueryParams) {
        continue;
      }

      const urlParts = urlWithoutQueryParams.split("/");

      if (routeParts.length !== urlParts.length) {
        continue;
      }

      const matches = routeParts.every((part, i) => {
        if (part.startsWith(":")) {
          // Always match route params
          return true;
        }
        return part === urlParts[i];
      });

      if (matches) {
        return route;
      }
    }

    return null;
  }

  private formatError(error: unknown): string | Record<string, string | undefined> {
    if (error instanceof Error) {
      return {
        name: error.name,
        message: error.message,
        stack: error.stack,
      };
    }

    return String(error);
  }
}
