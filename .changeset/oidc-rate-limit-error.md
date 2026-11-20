---
"@trigger.dev/core": patch
"@trigger.dev/sdk": patch
---

When OIDC token requests are still throttled after retries, `auth.getOIDCToken()` now throws `RateLimitError` with code `RATE_LIMIT_EXCEEDED` for both per-run and shared API limits. If you catch these errors with `instanceof OIDCTokenError`, check for `RateLimitError` instead. Other OIDC errors and retry behavior are unchanged.
