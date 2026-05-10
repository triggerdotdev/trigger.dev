---
"@trigger.dev/sdk": patch
"@trigger.dev/core": patch
"@trigger.dev/build": patch
"trigger.dev": patch
---

Add Agent Skills for `chat.agent`. Drop a folder with a `SKILL.md` and any helper scripts/references next to your task code, register it with `skills.define({ id, path })`, and the CLI bundles it into the deploy image automatically — no `trigger.config.ts` changes. The agent gets a one-line summary in its system prompt and discovers full instructions on demand via `loadSkill`, with `bash` and `readFile` tools scoped per-skill (path-traversal guards, output caps, abort-signal propagation).

```ts
const pdfSkill = skills.define({ id: "pdf-extract", path: "./skills/pdf-extract" });

chat.skills.set([await pdfSkill.local()]);
```

Built on the [AI SDK cookbook pattern](https://ai-sdk.dev/cookbook/guides/agent-skills) — portable across providers. SDK + CLI only for now; dashboard-editable `SKILL.md` text is on the roadmap.
