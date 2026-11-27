---
"@trigger.dev/sdk": patch
"@trigger.dev/core": patch
---

Sandbox tasks restrict outbound network access by default. `sandbox.network` accepts `"restricted"` (Trigger.dev's services and the allowed domains of granted Vault variables only), `{ allow: ["api.example.com", "*.example.com"] }` to also allow HTTPS to those hosts, or `"unrestricted"`. Restricted sandboxes can only make outbound connections on port 443; a blocked HTTPS request gets a `403` with an `x-trigger-network-denied` header.
