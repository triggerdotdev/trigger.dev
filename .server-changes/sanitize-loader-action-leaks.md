---
area: webapp
type: fix
---

Wrap two loaders/actions that previously let thrown errors propagate to Remix's default 500 serializer, which writes `error.message` into the response body. When the underlying call (Prisma, etc.) fails, the raw error string was reaching API consumers — including the SDK, which surfaces it back to users via `TriggerApiError`. Each handler now catches non-Response errors, logs server-side, and returns a generic 500 body. `throw json(...)` / `throw redirect(...)` from auth helpers is re-thrown unchanged.

Covers `api.v1.projects.$projectRef.envvars.$slug.$name.ts` (loader + action) and `resources.platform-changelogs.tsx` (loader).
