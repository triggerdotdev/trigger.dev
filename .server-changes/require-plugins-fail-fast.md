---
area: webapp
type: feature
---

Add `REQUIRE_PLUGINS=1` env var. When set, the RBAC plugin loader throws instead of silently falling back to the default implementation if the plugin module fails to load (missing, broken transitive dep, etc.). The webapp's `/healthcheck` route now resolves the lazy plugin controller so the throw surfaces during readiness probes — a deploy where the plugin didn't load fails the probe and is rolled back.

Self-hosters leave `REQUIRE_PLUGINS` unset and continue to use the fallback when no plugin is installed.
