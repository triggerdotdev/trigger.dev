---
area: webapp
type: feature
---

Add `RUNTIME_API_ORIGIN` env var to route managed runner traffic through an in-cluster URL, bypassing tracing gateways that rewrite the W3C `traceparent` header and break parent→child run links.
