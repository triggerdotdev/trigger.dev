---
area: webapp
type: improvement
---

When the v3 engine is retired, triggering a v3 task and connecting the v3 dev CLI now fail with a clear message pointing to the v4 migration guide instead of failing opaquely. Enforcement is off by default, so self-hosted instances still running v3 are unaffected until they migrate.
