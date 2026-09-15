import { AsyncLocalStorage } from "node:async_hooks";
import type { AuthenticatedEnvironment } from "./apiAuth.server";

// Every field is optional: each entry point fills only what it already knows.
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

// `actor` wins over `orgMember`, which only exists on dev environments.
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
