---
area: webapp
type: feature
---

Attach organization / project / environment to every Sentry event so "Users Impacted" counts orgs and events are filterable by tenant.

Mechanism: `AsyncLocalStorage`-backed `tenantContext` + a Sentry `addEventProcessor` that stamps `user.id = orgId`, `user.username = orgSlug`, and tags (`org_id`, `org_slug`, `project_id`, `project_ref`, `environment_id`, `env_slug`, `env_type`, `impersonating`).

Wired at the HTTP entry points:

- API routes — `apiBuilder.server.ts` wraps each handler invocation in `tenantContext.run` using the authenticated `environment`.
- Dashboard requests — an Express middleware (`tenantContextMiddleware`) resolves org/project/env from the URL pattern `/orgs/:org/projects/:project/env/:env/...` and wraps the Remix handler.

Background workers (redis-worker / schedule-engine) and socket handlers are not yet wired and remain a follow-up. Events from those entry points will continue to ship without tenant attribution until each handler is updated.
