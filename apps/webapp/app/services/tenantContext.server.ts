import { AsyncLocalStorage } from "node:async_hooks";
import type { AuthenticatedEnvironment } from "./apiAuth.server";

// All fields are optional: the middleware establishes an empty scope per request and each
// entry point fills what it already knows, without extra queries.
export type TenantContext = {
  userId?: string;
  orgSlug?: string;
  projectSlug?: string;
  envSlug?: string;
  orgId?: string;
  projectId?: string;
  projectRef?: string;
  envId?: string;
  envType?: "DEVELOPMENT" | "PREVIEW" | "STAGING" | "PRODUCTION";
  impersonating?: boolean;
};

const storage = new AsyncLocalStorage<TenantContext>();

export const tenantContext = {
  run<T>(ctx: TenantContext, fn: () => T): T {
    return storage.run(ctx, fn);
  },
  get(): TenantContext | undefined {
    return storage.getStore();
  },
  enrich(patch: Partial<TenantContext>): void {
    const current = storage.getStore();
    if (current) Object.assign(current, patch);
  },
};

// `actor` is the env JWT's delegation claim. It wins over `orgMember`, which only exists on
// dev environments, so a call against a shared prod or staging env still gets attributed.
export function tenantContextFromAuthEnvironment(
  env: AuthenticatedEnvironment,
  actor?: { sub: string }
): TenantContext {
  return {
    userId: actor?.sub ?? env.orgMember?.userId,
    orgSlug: env.organization.slug,
    projectSlug: env.project.slug,
    envSlug: env.slug,
    orgId: env.organization.id,
    projectId: env.project.id,
    projectRef: env.project.externalRef,
    envId: env.id,
    envType: env.type,
  };
}
