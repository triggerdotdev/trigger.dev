---
"@trigger.dev/core": patch
---

Browser realtime subscriptions now resume reliably after the tab is hidden and shown again. This comes from upgrading `@electric-sql/client` to 1.3.0, which also lets apps that depend on 1.3.0 share a single copy with the SDK.
