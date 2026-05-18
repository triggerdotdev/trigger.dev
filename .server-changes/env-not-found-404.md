---
area: webapp
type: fix
---

Return 404 instead of 500 when a dashboard loader is hit with a slug that no longer exists. Affected loaders (runs, sessions, batches, schedule detail) threw bare `Error("Environment not found")` / `Error("Project not found")` / `Error("Schedule not found")`, which Remix surfaces as 500 and Sentry's auto-instrumentation captures, creating ongoing noise from real users following stale preview-branch or deleted-resource links. Replaced with a `throwNotFound(statusText)` helper that throws a Response with status 404, matching the established pattern in sibling routes (agents, alerts, bulk-actions, etc.).
