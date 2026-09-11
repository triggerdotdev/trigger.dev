---
area: webapp
type: fix
---

Retried trigger and batch trigger requests are deduplicated again: when the SDK automatically retries a request that the server had in fact already accepted, you get the original run or batch back instead of a duplicate one.
