---
"@trigger.dev/sdk": patch
---

Split the skill-runtime primitives (`bash` + `readFile` tool implementations, backed by `node:child_process` + `node:fs/promises`) out of `@trigger.dev/sdk/ai` into a new `@trigger.dev/sdk/ai/skills-runtime` subpath. Fixes client-bundle build errors (`UnhandledSchemeError: Reading from "node:child_process"…`) that hit Next.js + Webpack when a browser page imports types from `@trigger.dev/sdk/ai` (for example `ChatUiMessage` via a shared tools file). The chat-agent factory now loads the runtime lazily via a computed-string dynamic import, so server workers still get full skill support without any caller changes.
