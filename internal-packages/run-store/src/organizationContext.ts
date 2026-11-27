import { AsyncLocalStorage } from "node:async_hooks";

// `featureFlags` left undefined means no flags in hand; `null` is flags in hand.
export type OrganizationContext = {
  organizationId?: string;
  environmentId?: string;
  featureFlags?: unknown;
  bornHere?: boolean;
};

const storage = new AsyncLocalStorage<OrganizationContext>();

export const organizationContext = {
  run<T>(ctx: OrganizationContext, fn: () => T): T {
    return storage.run(ctx, fn);
  },
  get(): OrganizationContext | undefined {
    return storage.getStore();
  },
  enrich(patch: Partial<OrganizationContext>): void {
    const current = storage.getStore();
    if (current) Object.assign(current, patch);
  },
  markBornHere(): void {
    const current = storage.getStore();
    if (current) current.bornHere = true;
  },
  /** Opens a scope naming the environment, unless the context in force already names one. */
  withEnvironment<T>(environmentId: string | undefined, fn: () => T): T {
    const current = storage.getStore();
    if (environmentId === undefined || current?.environmentId !== undefined) return fn();
    return storage.run({ environmentId, bornHere: current?.bornHere }, fn);
  },
};
