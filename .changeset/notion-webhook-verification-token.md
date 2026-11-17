---
"@trigger.dev/core": patch
"@trigger.dev/sdk": patch
---

`webhooks.notion()` endpoints accept Notion's verification request. While the endpoint has no signing secret, the `verification_token` Notion sends is stored as its signing secret, so you can paste it back into Notion and later deliveries verify with it. Redeploy with this version for existing Notion endpoints to pick it up.
