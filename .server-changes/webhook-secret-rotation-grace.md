---
area: webapp
type: feature
---

Rotating a webhook endpoint's signing secret can keep the old one valid for a while, so you can rotate without failing deliveries that are still signed with it. The rotate and regenerate dialogs let you choose how long the old secret stays valid (up to 7 days, 24 hours by default). The `rotate-secret` and `secret` endpoints accept an optional `previousSecretTtlSeconds` and return `previousSecretExpiresAt`. With no value, the old secret stops working immediately, as before.
