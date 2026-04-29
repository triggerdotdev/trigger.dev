---
area: supervisor
type: feature
---

Add `KUBERNETES_POD_DNS_NDOTS_OVERRIDE_ENABLED` flag (off by default) that overrides the cluster default and sets `dnsConfig.options.ndots` on runner pods (defaulting to 2, configurable via `KUBERNETES_POD_DNS_NDOTS`). Kubernetes defaults pods to `ndots: 5`, so any name with fewer than 5 dots — including typical external domains like `api.example.com` — is first walked through every entry in the cluster search list (`<ns>.svc.cluster.local`, `svc.cluster.local`, `cluster.local`) before being tried as-is, turning one resolution into 4+ CoreDNS queries (×2 with A+AAAA). Using a lower `ndots` value reduces DNS query amplification in the `cluster.local` zone.

Note: before enabling, make sure no code path relies on search-list expansion for names with dots ≥ the configured value — those names will hit their as-is form first and could resolve externally before falling back to the cluster search path.
