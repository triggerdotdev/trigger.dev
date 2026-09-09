---
area: webapp
type: fix
---

Stop counting agent LLM calls twice. An agent framework emits a wrapper span around the inference span that did the work, and both were priced, so LLM cost aggregates and the AI metrics page reported roughly double for agent workloads. Per-call figures in the run view were always correct and are unchanged.
