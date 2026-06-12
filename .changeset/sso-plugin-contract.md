---
"@trigger.dev/plugins": patch
---

Add the SSO plugin contract (`SsoController`, `SsoPlugin`, domain types, error unions). Vendor-neutral surface for self-service SSO setup, login routing, and JIT provisioning — the cloud implementation lives outside the package; OSS deployments get a no-op fallback that returns `no_sso` from `decideRouteForEmail`.
