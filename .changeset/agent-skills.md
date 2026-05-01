---
"@trigger.dev/sdk": patch
"@trigger.dev/core": patch
"@trigger.dev/build": patch
"trigger.dev": patch
---

Agent Skills — developer-authored folders (`SKILL.md` + scripts/references/assets) bundled into the deploy image automatically and discovered by the chat agent via progressive disclosure. Built on the [AI SDK cookbook pattern](https://ai-sdk.dev/cookbook/guides/agent-skills) — portable across providers.

**SDK:**

- `skills.define({ id, path })` registers a skill with the resource catalog; the Trigger.dev CLI bundles the folder into `/app/.trigger/skills/{id}/` automatically — no `trigger.config.ts` changes, no build extension.
- `SkillHandle.local()` reads the bundled `SKILL.md` at runtime, parses frontmatter, returns a `ResolvedSkill`.
- `chat.skills.set([...])` stores resolved skills for the current run.
- `chat.toStreamTextOptions()` auto-injects the skills preamble into the system prompt and merges three tools — `loadSkill`, `readFile`, `bash` — scoped per-skill with path-traversal guards and output caps (64 KB stdout/stderr, 1 MB `readFile`). `bash` runs with `cwd` = skill directory; the turn's abort signal propagates.
- `@trigger.dev/sdk/ai/skills-runtime` subpath — the `bash` + `readFile` runtime primitives (backed by `node:child_process` + `node:fs/promises`) live here, not in `@trigger.dev/sdk/ai`. Fixes client-bundle build errors (`UnhandledSchemeError: Reading from "node:child_process"…`) that hit Next.js + Webpack when a browser page imports types from `@trigger.dev/sdk/ai` (for example `ChatUiMessage` via a shared tools file). The chat-agent factory loads the runtime lazily via a computed-string dynamic import, so server workers still get full skill support without any caller changes.

This is the SDK + CLI layer only — no backend, no dashboard overrides yet. Dashboard-editable `SKILL.md` text and override flow are on the roadmap; `skill.resolve()` currently throws.
