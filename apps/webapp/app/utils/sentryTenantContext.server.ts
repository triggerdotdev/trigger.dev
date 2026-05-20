import type { Event, EventHint } from "@sentry/remix";
import { tenantContext } from "../services/tenantContext.server";

export function addTenantContextToEvent(event: Event, _hint: EventHint): Event {
  const ctx = tenantContext.get();
  if (!ctx) return event;
  return {
    ...event,
    user: {
      ...event.user,
      id: ctx.org.id,
      username: ctx.org.slug,
    },
    tags: {
      ...event.tags,
      org_id: ctx.org.id,
      org_slug: ctx.org.slug,
      project_id: ctx.project.id,
      project_ref: ctx.project.ref,
      environment_id: ctx.environment.id,
      env_slug: ctx.environment.slug,
      env_type: ctx.environment.type,
      ...(ctx.impersonating ? { impersonating: "true" } : {}),
    },
  };
}
