import type { Event, EventHint } from "@sentry/remix";
import { tenantContext } from "../services/tenantContext.server";

export function addTenantContextToEvent(event: Event, _hint: EventHint): Event {
  const ctx = tenantContext.get();
  if (!ctx) return event;
  return {
    ...event,
    // Only stamp user.id when we have a real user — keeps "Users Impacted"
    // counting distinct humans rather than mixing in tenants. Events without
    // a known user (e.g. unauthenticated paths) skip user attribution.
    ...(ctx.userId ? { user: { ...event.user, id: ctx.userId } } : {}),
    tags: {
      ...event.tags,
      ...(ctx.orgSlug ? { org_slug: ctx.orgSlug } : {}),
      ...(ctx.projectSlug ? { project_slug: ctx.projectSlug } : {}),
      ...(ctx.envSlug ? { env_slug: ctx.envSlug } : {}),
      ...(ctx.orgId ? { org_id: ctx.orgId } : {}),
      ...(ctx.projectId ? { project_id: ctx.projectId } : {}),
      ...(ctx.projectRef ? { project_ref: ctx.projectRef } : {}),
      ...(ctx.envId ? { environment_id: ctx.envId } : {}),
      ...(ctx.envType ? { env_type: ctx.envType } : {}),
      ...(ctx.impersonating ? { impersonating: "true" } : {}),
    },
  };
}
