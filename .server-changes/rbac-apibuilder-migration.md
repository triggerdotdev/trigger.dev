---
area: webapp
type: improvement
---

Migrate `apiBuilder.server.ts` to `rbac.authenticateBearer` + `ability.can` (TRI-8719). All 30 API routes that used `authorization.superScopes` now rely on the RBAC plugin's scope-algebra plus an `ACTION_ALIASES` compatibility map (`trigger`/`batchTrigger`/`update` satisfied by `write:*` scopes). Two intentional improvements: empty-resource routes (`/api/v1/batches`, `/api/v1/idempotencyKeys/:key/reset`) now accept JWTs (previously denied by the legacy empty-resource short-circuit); id-scoped `write:tasks:*` scopes now grant `POST /api/v1/tasks/:taskId/trigger` (previously denied by literal superScope mismatch). Both are strict supersets of the current accept set — no JWT regresses.
