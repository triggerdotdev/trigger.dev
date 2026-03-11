---
area: webapp
type: feature
---

Add automatic LLM cost calculation for spans with GenAI semantic conventions. When a span arrives with `gen_ai.response.model` and token usage data, costs are calculated from an in-memory pricing registry backed by Postgres and dual-written to both span attributes (`trigger.llm.*`) and a new `llm_usage_v1` ClickHouse table.
