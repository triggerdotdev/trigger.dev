import type { NextFunction, Request, Response } from "express";
import { tenantContext, type TenantContext } from "./tenantContext.server";

const URL_PATTERN = /^\/orgs\/([^/]+)(?:\/projects\/([^/]+)(?:\/env\/([^/]+))?)?/;

export type ParsedTenantPath = {
  orgSlug: string;
  projectSlug?: string;
  envSlug?: string;
};

// Pulls whatever tenant slugs are present in the URL. `/orgs/:o` returns the
// org alone; `/orgs/:o/projects/:p` adds the project; `/orgs/:o/projects/:p/env/:e`
// returns all three. Non-tenant paths (`/`, `/login`, `/admin/*`) return undefined.
export function parseTenantPath(pathname: string): ParsedTenantPath | undefined {
  const match = pathname.match(URL_PATTERN);
  if (!match) return undefined;
  const [, orgSlug, projectSlug, envSlug] = match;
  if (!orgSlug) return undefined;
  return {
    orgSlug,
    ...(projectSlug ? { projectSlug } : {}),
    ...(envSlug ? { envSlug } : {}),
  };
}

export function resolveTenantContextFromPath(pathname: string): TenantContext {
  return parseTenantPath(pathname) ?? {};
}

export type PathResolver = (pathname: string) => TenantContext;

export function createTenantContextMiddleware(resolver: PathResolver) {
  // Always establish an ALS scope, even when the path carries no tenant
  // slugs. Authenticated loaders (e.g. the `_app` layout) then enrich the
  // same scope with `userId`, so non-tenant pages still get user attribution.
  return function tenantContextMiddleware(req: Request, res: Response, next: NextFunction) {
    tenantContext.run(resolver(req.path), () => next());
  };
}

export const tenantContextMiddleware = createTenantContextMiddleware(resolveTenantContextFromPath);
