---
"@trigger.dev/core": patch
"trigger.dev": patch
---

Add `get_span_details` MCP tool for inspecting individual spans within a run trace.

- New `get_span_details` tool returns full span attributes, timing, events, and AI enrichment (model, tokens, cost, speed)
- Span IDs now shown in `get_run_details` trace output for easy discovery
- New API endpoint `GET /api/v1/runs/:runId/spans/:spanId`
- New `retrieveSpan()` method on the API client
