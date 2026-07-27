# CK virtual-time end-to-end bench tasks

A tiny self-contained trigger.dev project used as the END-TO-END arm of the CK
virtual-time A/B (see `../2026-07-26-ck-vtime-benchmark.md`). It is deployed to a
self-hosted instance and is not part of the monorepo build.

- `src/trigger/ckBench.ts` — one `ck-bench` task on a shared base queue; per-run
  `concurrencyKey` makes the CK variants; a slot hold forces contention.
- `src/loadgen.ts` — noisy-neighbor load: tenant A floods across many keys,
  tenant B sends a few; each run is tagged and carries a per-run `region`.
- `src/collect.ts` — reads per-run `createdAt`/`startedAt` by tag and reports
  per-tenant enqueue->start latency p50/p95/p99.

Everything reads credentials from the environment (`TRIGGER_API_URL`,
`TRIGGER_SECRET_KEY`); nothing is hard-coded. Deploy with the CLI (`-p <ref>`).
The feature flag is server-side and is flipped by the operator between arms, not
by this project. Exact instance coordinates and the toggle live in the operator
runbook, kept outside this public repo.

```bash
pnpm install
# deploy (project ref on the CLI)
TRIGGER_PROJECT_REF=<ref> npx trigger.dev@latest deploy --self-hosted --profile <profile> -p <ref>
# generate load for one arm (flag already set + redeployed server-side)
ARM=off BATCH=run1 pnpm loadgen
# collect that arm
ARM=off BATCH=run1 pnpm collect
```
