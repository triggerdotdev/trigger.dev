# Sources and decisions

Reviewed 2026-10-30. Repository-relative paths refer to the Trigger.dev repository.

## Source inventory

| Source | Trust / confidence | Contribution |
| --- | --- | --- |
| [Agent Skills specification](https://agentskills.io/specification) | Official / high | Standard frontmatter, directory naming, portable Markdown, self-contained manual copy. |
| packages/convex/README.md; src/client/index.ts; src/component/shared.ts | Implementation / high | Configuration, IDs, API methods, callbacks, limits, idempotency, paused recovery. |
| [Merged refresh PR #1410](https://github.com/triggerdotdev/chonk/pull/1410) and its component tests | Implementation and regression tests / high | Five-second coalescing, in-flight follow-up, asynchronous hint semantics, lifecycle no-ops. |
| packages/convex/example/convex/realtime.ts; jobs.ts; src/RealtimeJobPanel.tsx; src/editorState.ts | Working integration / high | Owner checks, scoped auth, token expiry, REST-safe worker credentials, selection/request restoration. |
| packages/cli-v3/skills/trigger-realtime-and-frontend/SKILL.md; packages/trigger-sdk/skills/trigger-realtime-and-frontend/SKILL.md | Existing repository convention / high | Installed version as authority; distinction between installer pointers and full guides. No installer pointer is added here. |
| packages/convex/README.md; package.json; tsconfig.json | Repository configuration / high | Manual discovery, publication allowlist, library/example isolation. |
| Example reload and cross-session integration tests | Regression evidence / high | No implicit selection by matching defaults, request ID recovery, owned active jobs. |

Use source contracts rather than copying a generic component-template release process. The code examples are adapted to an owned text-processing job, not a copy of demo-specific capabilities, limits, or project settings.

## Synthesis and precision

- Adopted integration-documentation / inline-guidance: one coherent contract fits a single skill. Runtime references or scripts would add navigation without a separate lookup need.
- Added with reason: no component-specific skill existed; widening the generic Realtime skill would mix Convex transaction/recovery rules into unrelated frontend work.
- Kept provenance and maintenance separate from runtime. Publish only the self-contained guide.
- Reused standard CLI skill documentation conventions but deliberately deferred all CLI registration, per user request.
- Preferred owned application IDs over browser-supplied remote IDs; tenant/task/request namespacing over unscoped idempotency.
- Added explicit version gating because older installed components lack refresh.
- No provider-specific tools, session variables, or machine-specific paths.
- Retrieval stopped after implementation, merged refresh tests, real example security/recovery paths, repository distribution, and format specification covered the contract. More generic SDK documentation would mostly repeat existing guidance.

## Coverage

| Dimension | Coverage |
| --- | --- |
| API / configuration | Installed declaration check, setup, trigger/get/list/refresh/resume, host/key environment. |
| Downstream uses | Transactional work, reactive reads, callbacks, hybrid progress, reload recovery, synchronization repair. |
| Failures / workarounds | Twelve symptom/fix cases plus callback, output, idempotency and secret-handling constraints. |
| Version variance | Missing refresh, explicit upgrades, no arbitrary preview pin, manual copy refresh. |
| Security | Per-owner wrappers, server-derived run scope, REST payload audit, separate artifact authorization. |
| Portability / packaging | Standard frontmatter, manual copy, installed-package resolution, npm allowlist without example assets. |

## Gaps

Structural and TypeScript checks are not a model behavior evaluation. The skill intentionally does not choose business-specific auth, file retention, provider spending policy, or analytics infrastructure. It requires installed declarations for version-specific details.
