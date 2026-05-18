---
area: webapp
type: fix
---

Sweep across the remaining `apps/webapp/app/routes/api.v1.*` raw loaders/actions that previously let thrown errors propagate to Remix's default 500 serializer, which writes `error.message` into the response body. Earlier passes covered routes with leaking `catch` blocks and two specific naked routes; this pass covers the rest of the API surface that doesn't go through `createLoaderApiRoute` / `createActionApiRoute`.

Each handler now wraps its body in try/catch, re-throws `Response` instances so auth helpers' `throw json(...)` / `throw redirect(...)` pass through unchanged, logs non-Response errors, and returns `{ error: "Internal Server Error" }` 500. For routes that already had an inner try/catch covering a service call but with auth/parsing outside the try (alertChannels, batches.results, deployments.finalize, several others), an outer try/catch is added so the inner typed-error handling is preserved. The `api.v1.authorization-code.ts` catch branch was returning `error.message` verbatim — switched to a generic body.

Each route was verified locally with a synthetic-throw probe: inject `throw new Error("SYNTHETIC ...")` at the top of the catch'd try, curl the route with a dummy bearer token, confirm the response body is the generic shape and that the synthetic message is captured server-side via `logger.error`.
