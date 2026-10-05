---
area: webapp
type: breaking
---

Creating or resuming a session with `POST /api/v1/sessions` now requires both session-write and task-trigger permissions. Scoped keys and public tokens must grant `write:sessions` (or access to the target session) and permission to trigger its task.
