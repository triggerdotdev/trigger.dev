---
"@trigger.dev/core": patch
---

`envvars.upload` now accepts an optional `isSecret` flag, letting you create the imported variables as secret (redacted) environment variables. When omitted, variables default to non-secret.

```ts
await envvars.upload("proj_1234", "prod", {
  variables: { STRIPE_SECRET_KEY: "sk_live_..." },
  isSecret: true,
});
```
