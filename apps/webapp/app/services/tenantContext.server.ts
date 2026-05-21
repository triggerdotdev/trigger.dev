import { AsyncLocalStorage } from "node:async_hooks";
import type { AuthenticatedEnvironment } from "./apiAuth.server";

// All fields are optional. The middleware establishes an empty scope per
// request; entry points fill what they know:
//   - URL-matching paths get the slug trio from the Express middleware (zero IO).
//   - The `_app` layout adds `userId` for any authenticated request.
//   - The env layout adds tenant IDs / env type after its own existing DB query.
//   - API routes get the full set up-front from `authenticationResult.environment`.
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

export function tenantContextFromAuthEnvironment(env: AuthenticatedEnvironment): TenantContext {
  return {
    userId: env.orgMember?.userId,
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
