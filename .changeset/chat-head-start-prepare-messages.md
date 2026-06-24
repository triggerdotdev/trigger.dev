---
"@trigger.dev/sdk": patch
---

Fix Head Start handovers breaking when a `chat.agent` also defines a `prepareMessages` hook. A handover hands the first turn's pending tool call to the agent as a tool-approval round whose trailing tool message must reach the model untouched. A `prepareMessages` hook that rewrites the last message (for example the recommended prompt-caching breakpoint) could disturb it, so the turn failed with "tool_use ids were found without tool_result". The agent now preserves that approval tail across `prepareMessages`, so caching and Head Start compose cleanly.
