---
area: webapp
type: feature
---

AI prompt management dashboard and enhanced span inspectors.

**Prompt management:**
- Prompts list page with version status, model, override indicators, and 24h usage sparklines
- Prompt detail page with template viewer, variable preview, version history timeline, and override editor
- Create, edit, and remove overrides to change prompt content or model without redeploying
- Promote any code-deployed version to current
- Generations tab with infinite scroll, live polling, and inline span inspector
- Per-prompt metrics: total generations, avg tokens, avg cost, latency, with version-level breakdowns

**AI span inspectors:**
- Custom inspectors for `ai.generateText`, `ai.streamText`, `ai.generateObject`, `ai.streamObject` parent spans
- `ai.toolCall` inspector showing tool name, call ID, and input arguments
- `ai.embed` inspector showing model, provider, and input text
- Prompt tab on AI spans linking to prompt version with template and input variables
- Compact timestamp and duration header on all AI span inspectors

**AI metrics dashboard:**
- Operations, Providers, and Prompts filters on the AI Metrics dashboard
- Cost by prompt widget
- "AI" section in the sidebar with Prompts and AI Metrics links

**Other improvements:**
- Resizable panel sizes now persist across page refreshes
- Fixed `<div>` inside `<p>` DOM nesting warnings in span titles and chat messages
