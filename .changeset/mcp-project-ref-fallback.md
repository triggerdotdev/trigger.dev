---
"trigger.dev": patch
---

fix(cli): use the --project-ref option in MCP tools when a call passes no projectRef

`trigger mcp --project-ref <ref>` started in a directory without a `trigger.config.ts` previously still failed with "No project ref found. Please provide a projectRef." because `McpContext.getProjectRef` never read the server option. Tools now fall back to the `--project-ref` passed at server start before trying config detection.
