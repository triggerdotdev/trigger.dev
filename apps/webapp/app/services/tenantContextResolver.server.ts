import type { NextFunction, Request, Response } from "express";
import { prisma } from "~/db.server";
import { tenantContext, type TenantContext } from "./tenantContext.server";
import { logger } from "./logger.server";

const URL_PATTERN = /^\/orgs\/([^/]+)(?:\/projects\/([^/]+)(?:\/env\/([^/]+))?)?/;

export type ParsedTenantPath = {
  orgSlug: string;
  projectParam: string;
  envParam: string;
};

export function parseTenantPath(pathname: string): ParsedTenantPath | undefined {
  const match = pathname.match(URL_PATTERN);
  if (!match) return undefined;
  const [, orgSlug, projectParam, envParam] = match;
  if (!orgSlug || !projectParam || !envParam) return undefined;
  return { orgSlug, projectParam, envParam };
}

export async function resolveTenantContextFromPath(
  pathname: string
): Promise<TenantContext | undefined> {
  const parsed = parseTenantPath(pathname);
  if (!parsed) return undefined;

  try {
    const env = await prisma.runtimeEnvironment.findFirst({
      where: {
        slug: parsed.envParam,
        project: { slug: parsed.projectParam, organization: { slug: parsed.orgSlug } },
      },
      select: {
        id: true,
        slug: true,
        type: true,
        project: { select: { id: true, externalRef: true } },
        organization: { select: { id: true, slug: true } },
      },
    });
    if (!env) return undefined;
    return {
      org: { id: env.organization.id, slug: env.organization.slug },
      project: { id: env.project.id, ref: env.project.externalRef },
      environment: {
        id: env.id,
        slug: env.slug,
        type: env.type,
      },
    };
  } catch (error) {
    logger.warn("tenantContextResolver: lookup failed", {
      error: error instanceof Error ? error.message : String(error),
      pathname,
    });
    return undefined;
  }
}

export type PathResolver = (pathname: string) => Promise<TenantContext | undefined>;

export function createTenantContextMiddleware(resolver: PathResolver) {
  return async function tenantContextMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
  ) {
    const ctx = await resolver(req.path);
    if (ctx) {
      tenantContext.run(ctx, () => next());
    } else {
      next();
    }
  };
}

export const tenantContextMiddleware = createTenantContextMiddleware(resolveTenantContextFromPath);
