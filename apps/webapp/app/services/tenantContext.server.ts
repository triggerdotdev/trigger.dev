import { AsyncLocalStorage } from "node:async_hooks";
import type { AuthenticatedEnvironment } from "./apiAuth.server";

export type TenantContext = {
  org: { id: string; slug: string };
  project: { id: string; ref: string };
  environment: {
    id: string;
    slug: string;
    type: "DEVELOPMENT" | "PREVIEW" | "STAGING" | "PRODUCTION";
  };
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
};

export function tenantContextFromAuthEnvironment(env: AuthenticatedEnvironment): TenantContext {
  return {
    org: { id: env.organization.id, slug: env.organization.slug },
    project: { id: env.project.id, ref: env.project.externalRef },
    environment: { id: env.id, slug: env.slug, type: env.type },
  };
}
