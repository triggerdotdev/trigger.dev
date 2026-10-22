import type { RequestHandler } from "express";
import { getRouterPath, pathHasPrefix, sanitizeHttpUrl } from "./sanitizeHttpUrl";

const MACHINE_PATH_PREFIXES = [
  "/api",
  "/engine",
  "/realtime",
  "/otel",
  "/webhooks/v1/ingest",
  "/admin/api",
  "/healthcheck",
  "/metrics",
];

const MACHINE_PATH_PATTERNS = [
  /^\/webhooks\/v1\/accounts\/?$/,
  /^\/projects\/v3\/[^/]+\/metrics\/?$/,
];

export type ApiOnlyServiceMode = "report" | "enforce";

export type ApiOnlyServiceDecision =
  | { action: "allow" }
  | { action: "redirect"; location: string }
  | { action: "notFound" };

export function parseApiOnlyServiceMode(value: string | undefined): ApiOnlyServiceMode | undefined {
  return value === "report" || value === "enforce" ? value : undefined;
}

/**
 * Whether the server should mount its static file middleware. An enforcing
 * API-only service serves no dashboard assets at all: `express.static` decodes
 * the path after this gate has matched it, so an encoded separator
 * (`/api/..%2fassets/x.js`) would otherwise reach a build file through an
 * allowed prefix.
 */
export function servesStaticFiles(mode: ApiOnlyServiceMode | undefined): boolean {
  return mode !== "enforce";
}

/**
 * Decides what a service that should only serve the machine APIs (SDK, CLI,
 * workers, OTLP, webhook ingress, the admin API, the accounts webhook and the
 * project metrics scrape endpoint) does with a request. Machine paths are allowed. Anything
 * else is a dashboard, login or resource route: a `GET`/`HEAD` is sent to the
 * same path on `appOrigin`, where the dashboard lives, and other methods get a
 * 404. Without an `appOrigin` everything outside the machine paths is a 404.
 */
export function decideApiOnlyServiceRequest({
  method,
  pathname,
  originalUrl,
  appOrigin,
}: {
  method: string;
  pathname: string | undefined;
  originalUrl: string;
  appOrigin: string | undefined;
}): ApiOnlyServiceDecision {
  if (
    pathname &&
    (MACHINE_PATH_PREFIXES.some((prefix) => pathHasPrefix(pathname, prefix)) ||
      MACHINE_PATH_PATTERNS.some((pattern) => pattern.test(pathname)))
  ) {
    return { action: "allow" };
  }

  if (appOrigin && (method === "GET" || method === "HEAD")) {
    const origin = new URL(appOrigin).origin;
    const path = originalUrl.startsWith("/") ? originalUrl : `/${originalUrl}`;
    return { action: "redirect", location: `${origin}${path}` };
  }

  return { action: "notFound" };
}

/**
 * The Express middleware for `API_ONLY_SERVICE_MODE`. It logs every request
 * it would act on, in both modes, because the access log is mounted after it.
 * `report` then serves the request as before; `enforce` redirects or 404s it.
 */
export function createApiOnlyServiceMiddleware({
  mode,
  appOrigin,
  log = (line) => console.log(line),
}: {
  mode: ApiOnlyServiceMode;
  appOrigin: string | undefined;
  log?: (line: string) => void;
}): RequestHandler {
  return (req, res, next) => {
    const decision = decideApiOnlyServiceRequest({
      method: req.method,
      pathname: getRouterPath(req),
      originalUrl: req.originalUrl,
      appOrigin,
    });

    if (decision.action === "allow") {
      next();
      return;
    }

    const enforced = mode === "enforce";
    log(
      JSON.stringify({
        message: "Dashboard route on an API-only service",
        method: req.method,
        path: sanitizeHttpUrl(req.originalUrl),
        decision: decision.action,
        enforced,
      })
    );

    if (!enforced) {
      next();
      return;
    }

    if (decision.action === "redirect") {
      res.redirect(302, decision.location);
      return;
    }

    res.status(404).send("Not Found");
  };
}
