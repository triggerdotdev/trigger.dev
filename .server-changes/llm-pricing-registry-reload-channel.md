---
area: webapp
type: improvement
---

The LLM pricing registry now reloads from the database whenever a publish lands on `LLM_PRICING_RELOAD_CHANNEL` on the worker Redis, instead of waiting for the next 5-minute interval. LLM model and pricing changes reflect in cost enrichment within seconds.
