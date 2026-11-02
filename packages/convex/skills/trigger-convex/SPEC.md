# trigger-convex maintenance contract

## Intent and scope

Teach coding agents to integrate Trigger.dev with Convex using the installed component contract. Cover atomic submission, owned reactive reads, callbacks, hybrid Realtime, reload recovery, and paused synchronization.

Exclude Convex-only development, generic Trigger task authoring, directory submission, and autonomous deployment/provider spending. The skill is portable Markdown with standard Agent Skills frontmatter.

## Layout and distribution

- Class: integration-documentation. Shape: inline-guidance, with no scripts, runtime references, or provider-specific mechanics.
- Keep runtime instructions in SKILL.md; keep evidence and decisions in SOURCES.md.
- Publish only SKILL.md. These maintenance files remain repository-only.
- Do not add a CLI skill pointer or installer registration. Installation is manual, documented in the package README.
- The installed README and declarations take precedence over copied instructions. Gate refresh on API availability.

## Trigger checks

Should trigger:
- Trigger a report transactionally from a Convex mutation.
- Show a Convex job using Trigger Realtime and refresh persisted completion.
- Restore a background image edit after refreshing the page.
- Repair paused synchronization without submitting duplicate paid work.

Should not trigger:
- Build a Convex-only chat app.
- Write a standalone Trigger task without Convex.
- Submit a component to the directory.
- Configure unrelated analytics or deploy infrastructure.

## Validation and acceptance

Validate standard frontmatter, portable paths, and the manually copied standalone file. Typecheck the code examples against real Convex generated builder/model types and compatible installed component declarations. Run package build/tests, formatting/lint, and inspect an actual package tarball: it must contain the skill and still exclude the example and maintenance files.

Review for eight or more concrete failure/repair cases and the six downstream flows identified in SKILL.md. In particular, preserve request idempotency, exact-run token ownership, REST-readable payload safety, asynchronous refresh semantics, and polling recovery.

No LLM behavior benchmark is required for this change. Use the trigger queries above for future skill evaluation. Do not infer behavioral effectiveness from structural validation alone.

## Maintenance

Update the skill when the public API, lifecycle/limits, token semantics, or authentication boundaries change. Recheck SOURCES.md and the installed-package examples. Keep private customer data, credentials, and operator identifiers out of evidence. Re-copy the manual skill after upgrading the component.
