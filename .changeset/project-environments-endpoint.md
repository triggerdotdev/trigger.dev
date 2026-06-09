---
"@trigger.dev/core": patch
---

Add `GetProjectEnvironmentsResponseBody` and `ProjectEnvironment` schemas for the new `GET /api/v1/projects/{projectRef}/environments` endpoint, which lists the parent environments (dev, staging, preview, prod) a personal access token can access for a project. Dev is scoped to the token owner and branch (preview child) environments are excluded.
