---
area: webapp
type: fix
---

LLM cost no longer double-counts cached input tokens. Prompt-cache reads and writes are now billed once at their cache rate instead of also being charged at the full input price, so cost and cache hit-rate figures on the AI metrics dashboard and Models page are accurate.
