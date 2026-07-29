---
"trigger.dev": patch
---

`trigger mcp` now always starts the MCP server, and the interactive install wizard has moved behind `trigger mcp --install`. Previously the wizard opened whenever stdout was a terminal, so any MCP host that spawns the command over a pseudo-terminal waited on a server that never started and eventually timed out.
