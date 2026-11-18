# MCP golden transcripts

JSON-RPC request/response pairs recorded from the real MCP router (real tool registry, seeded
org/user/PAT/project/environment/task/run) for each protocol revision. They pin the wire
behaviour clients see today so the SDK migration can prove nothing changed for that revision.

`2025-11-25/` holds one file per case: `initialize`, `tools/list` (names, titles, descriptions,
input schemas, annotations, order), `tools/call` for `list_projects`, `list_runs`,
`get_run_details` (first page) and `get_task_schema`, and the error paths (401 without bearer,
`GET /mcp` 405, malformed JSON 400, oversized body 413, unknown tool, cross-tenant `projectRef`).

Volatile values (ids, tokens, timestamps, cursors, fence boundaries) are replaced by placeholders
such as `<RUN_ID>` by `normalize()` in `test/mcpGolden.test.ts` before comparing.
`list_runs` uses a Postgres-backed `listRuns` instead of ClickHouse; everything else is real.

## Updating

Any difference fails `pnpm run test --run test/mcpGolden.test.ts`. If the change is intended,
regenerate and review the diff:

```
UPDATE_GOLDEN=1 pnpm run test --run test/mcpGolden.test.ts
```

## 2026-07-28

The SDK v2 migration adds `2026-07-28/` fixtures with a separate functional-equivalence check.
Wire identity across revisions is not expected (SEP-2106), so the 2025-11-25 fixtures stay the
byte-identical reference for that revision only.
