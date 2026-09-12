---
"@trigger.dev/sdk": patch
---

`chat.agent`: after a Head Start turn whose handed-over tool call was followed by more tool steps, the next turn no longer fails with `tool_use ids must be unique`. The runtime kept the warm step's pending tool call in the model context alongside the completed response that already contained it.
