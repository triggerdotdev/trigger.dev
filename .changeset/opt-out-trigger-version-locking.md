---
"@trigger.dev/core": minor
"@trigger.dev/sdk": minor
---

Allow opting out of `TRIGGER_VERSION` locking per-call and per-scope (fixes #3380).

`TriggerOptions.version` now accepts `null` in addition to a version string, and `ApiClientConfiguration` gains a `version?: string | null` field that applies to every trigger inside an `auth.withAuth(...)` scope. Passing `null` explicitly unpins the call: `lockToVersion` is omitted from the request and the server resolves to the current deployed version, ignoring the `TRIGGER_VERSION` environment variable.

Precedence (highest first): per-call `version` option, scoped `version` in `ApiClientConfiguration`, `TRIGGER_VERSION` env var. `undefined` at any level falls through to the next level; only `null` explicitly unpins.

Use cases:
- Cross-project triggers where the ambient `TRIGGER_VERSION` (e.g., injected by the Vercel integration for your "main" project) does not apply to a sibling project.
- One-off calls that should always run on the current deployed version regardless of the runtime environment.

```ts
// Scoped: every trigger inside this scope resolves to the current deployed version
await auth.withAuth({ secretKey, version: null }, async () => {
  await tasks.trigger("some-task", payload);
});

// Per-call: only this call is unpinned
await tasks.trigger("some-task", payload, { version: null });
```

The existing string-pin behavior and `TRIGGER_VERSION` fallback are unchanged.
