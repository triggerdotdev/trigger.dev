---
"@trigger.dev/sdk": patch
---

The bundled chat agent skills now use `claude-sonnet-5-5` in their examples. They used `claude-sonnet-4-5`, which Anthropic retires on November 30, 2026, so agents following the skills would have generated code that stops working.
