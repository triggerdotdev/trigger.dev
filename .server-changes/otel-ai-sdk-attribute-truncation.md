---
area: webapp
type: fix
---

Tighten OTel span attribute truncation for Vercel AI SDK content keys
(`ai.prompt*`, `ai.response.text/object/toolCalls/reasoning*`,
`gen_ai.prompt`, `gen_ai.completion`, `gen_ai.request.messages`,
`gen_ai.response.text`) to a 1KB per-attribute cap, plus a 32KB per-span
backstop that drops these content keys in priority order if the assembled
attributes JSON still exceeds it. Cost/token metadata (`ai.usage.*`,
`ai.model.*`, `gen_ai.usage.*`, `gen_ai.response.model`, etc.) keeps the
default 8KB cap so LLM enrichment continues to work.

Extends the same truncation to span events' attributes. AI SDK telemetry
emits one span event per conversation turn (`gen_ai.system.message`,
`gen_ai.user.message`, etc.) carrying message content as event attributes,
which previously flowed into ClickHouse uncapped because
`spanEventsToEventEvents` did not run them through `truncateAttributes`.
That field was the actual source of the oversized rows breaking the
ClickHouse JSON parser and dropping whole batches.
