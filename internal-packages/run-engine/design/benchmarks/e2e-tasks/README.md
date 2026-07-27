# CK virtual-time end-to-end bench tasks

A tiny self-contained trigger.dev project used as the END-TO-END arm of the CK
virtual-time A/B (see `../2026-07-26-ck-vtime-benchmark.md`). It deploys to a
self-hosted instance and is not part of the monorepo build.

- `src/trigger/ckBench.ts` — one `ck-bench` task on a shared base queue; per-run
  `concurrencyKey` makes the CK variants; a slot hold forces contention.
- `src/loadgen.ts` — noisy-neighbor load: tenant A floods across many keys,
  tenant B sends a few; each run carries a per-run `region`. Captures every run
  id at trigger time and writes a manifest (`e2e-results/manifest-<batch>.json`).
- `src/waitdrain.ts` — polls the manifest's run ids until all are terminal.
- `src/collect.ts` — reads each run's `createdAt`/`startedAt` by id and reports
  per-tenant enqueue->start latency p50/p95/p99.
- `src/preflight.ts` — fires one run per region to validate routing + access.

Everything reads credentials from the environment (`TRIGGER_API_URL`,
`TRIGGER_SECRET_KEY`); nothing is hard-coded. The feature flag is server-side and
is flipped by the operator between arms, not by this project. Exact instance
coordinates and the toggle live in the operator runbook, kept outside this repo.

## Deploy from a standalone checkout, not inside the monorepo

This project must be installed and deployed from OUTSIDE the pnpm monorepo tree
(copy it somewhere with no `pnpm-workspace.yaml` ancestor). Inside the workspace,
`pnpm install` binds to the workspace and links the local SDK instead of the
pinned published one. Use npm for the standalone copy (it avoids pnpm's
build-script policy on esbuild):

```bash
cp -r <this dir> ~/ck-vtime-e2e && cd ~/ck-vtime-e2e
npm install                        # CLI + SDK pinned to the same version (4.5.7)
```

## Deploy

The 4.5.7 CLI has no `--self-hosted` flag; self-hosted is implicit from the
profile's API URL. Do NOT pass `--local-build` (it routes to a cloud-only ECR
credential endpoint and fails on self-hosted). The push then rides the host's
existing docker login to the registry. `--network host` is required so the
in-build indexer step can reach the instance API (e.g. over a tailnet):

```bash
TRIGGER_PROJECT_REF=<ref> \
  ./node_modules/.bin/trigger deploy -e prod --network host --profile <profile> -p <ref>
```

Deploy to the `prod` environment: the `dev` environment short-circuits
worker-group routing, so dev runs never reach the managed regions.

## Run one A/B arm

The flag is flipped + redeployed server-side by the operator; run this once per
arm with the matching `ARM`. This instance's `runs.list` (ClickHouse-backed) can
be empty, so the harness enumerates runs from the trigger-time id manifest, not
by tag.

```bash
export TRIGGER_API_URL=<instance url>
export TRIGGER_SECRET_KEY=<prod env secret key>

# validate region routing once
./node_modules/.bin/tsx src/preflight.ts

# one arm (env knobs: HOLD_MS, A_KEYS, A_PER_KEY, B_KEYS, B_PER_KEY, REGIONS)
ARM=off BATCH=off-1 ./node_modules/.bin/tsx src/loadgen.ts
BATCH=off-1 ./node_modules/.bin/tsx src/waitdrain.ts
ARM=off BATCH=off-1 ./node_modules/.bin/tsx src/collect.ts
```

Results land in `e2e-results/` (`manifest-<batch>.json`, `e2e-<batch>-<arm>.json`,
`e2e-summary.md`).
