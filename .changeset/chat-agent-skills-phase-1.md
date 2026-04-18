---
"@trigger.dev/sdk": patch
"@trigger.dev/core": patch
"@trigger.dev/build": patch
"trigger.dev": patch
---

Add agent skills — developer-authored folders (`SKILL.md` + scripts/references/assets) bundled into the deploy image automatically, discovered by the chat agent via progressive disclosure. Built on the [AI SDK cookbook pattern](https://ai-sdk.dev/cookbook/guides/agent-skills) — portable across providers.

**New:**
- `skills.define({ id, path })` registers a skill with the resource catalog; the Trigger.dev CLI bundles the folder into `/app/.trigger/skills/{id}/` automatically — no `trigger.config.ts` changes, no build extension.
- `SkillHandle.local()` reads the bundled `SKILL.md` at runtime, parses frontmatter, returns a `ResolvedSkill`.
- `chat.skills.set([...])` stores resolved skills for the current run.
- `chat.toStreamTextOptions()` auto-injects the skills preamble into the system prompt and merges three tools — `loadSkill`, `readFile`, `bash` — scoped per-skill with path-traversal guards and output caps (64 KB stdout/stderr, 1 MB `readFile`). `bash` runs with `cwd` = skill directory; the turn's abort signal propagates.

Phase 1 is SDK + CLI only — no backend, no dashboard overrides. Dashboard-editable `SKILL.md` text lands in Phase 2 (`skill.resolve()` currently throws).
