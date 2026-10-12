---
area: webapp
type: fix
---

Webhook deliveries from a provider's shared IP addresses are no longer throttled by other customers' traffic or by a spoofed `X-Forwarded-For` header; the per-IP limit now applies only to requests for endpoints that don't exist, and every ingest 429 includes `Retry-After`.
