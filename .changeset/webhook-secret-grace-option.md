---
"@trigger.dev/core": patch
"trigger.dev": patch
---

The `generate_webhook_secret` and `set_webhook_secret` MCP tools take an optional `previousSecretTtlSeconds` to keep accepting a webhook endpoint's old signing secret while the provider switches to the new one (up to 7 days), and report when the old secret stops working.
