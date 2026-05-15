---
"trigger.dev": patch
---

The CLI MCP server's agent-chat tools (`start_agent_chat`, `send_agent_message`, `close_agent_chat`) now run on the new Sessions primitive, so AI assistants driving a `chat.agent` get the same idempotent-by-`chatId`, durable-across-runs behavior the browser transport gets. Required PAT scopes go from `write:inputStreams` to `read:sessions` + `write:sessions`.
