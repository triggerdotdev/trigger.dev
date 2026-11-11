import type { NextFunction, Request, Response } from "express";
import { getRouterPath, pathHasPrefix } from "./sanitizeHttpUrl";

export function otlpIngestRoutesDisabled(env: NodeJS.ProcessEnv): boolean {
  return env.OTLP_INGEST_ROUTES_DISABLED === "true";
}

export function blockOtlpIngestRoutes(req: Request, res: Response, next: NextFunction): void {
  const pathname = getRouterPath(req);
  if (pathname && pathHasPrefix(pathname, "/otel")) {
    res.status(404).send("Not Found");
    return;
  }

  next();
}
