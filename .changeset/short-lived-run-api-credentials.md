---
"@trigger.dev/core": patch
"@trigger.dev/sdk": patch
---

Use short-lived run tokens for supported SDK operations inside deployed tasks when available, retaining environment-key compatibility for unsupported operations and missing or expired tokens. Explicit credentials still take precedence. Public-token helpers use server-side minting with run tokens rather than signing locally.

Project and organization queries, and branch overrides targeting another PREVIEW or DEVELOPMENT environment, keep using compatibility credentials. Branch headers do not change credential selection in STAGING or PRODUCTION. Chat subscriptions reread implicit credentials for each connection.
