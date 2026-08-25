# Deployment telemetry attributes

`deploymentTelemetry.ts` is the single owner of these names. `deployment.lifecycle`
(one wide event per terminal transition, span backdated createdAt → terminal) and
`deployment.initialized` (zero-duration funnel event at creation) are emitted by
`services/recordDeploymentLifecycle.server.ts`. Axiom queries, dashboards, and
monitors reference these names — treat renames as breaking changes.

| Attribute                        | Events           | Values / notes                                                             |
| -------------------------------- | ---------------- | -------------------------------------------------------------------------- |
| `$trigger.org.id`                | both             | Organization id                                                             |
| `$trigger.project.id`            | both             | Project id                                                                  |
| `$trigger.project.ref`           | both             | Project external ref (`proj_…`)                                            |
| `$trigger.env.id`                | both             | Environment id                                                              |
| `$trigger.env.type`              | both             | `PRODUCTION` / `STAGING` / `PREVIEW` / `DEVELOPMENT`                        |
| `deployment.id`                  | both             | Deployment friendly id — dedup key (`arg_max(_time, *) by deployment.id`)   |
| `deployment.version`             | both             | Deployment version, e.g. `20260825.3`                                       |
| `deployment.status`              | both             | lifecycle: terminal status; initialized: initial status (`PENDING`/`BUILDING`) |
| `deployment.success`             | lifecycle        | `status === "DEPLOYED"`. CANCELED is excluded from failure rates            |
| `deployment.build_path`          | both             | `depot` / `native` / `local_bundle` (rare `--local-build` lands in `depot`) |
| `deployment.worker_type`         | both             | `V1` / `MANAGED` (run engine)                                               |
| `deployment.runtime`             | both             | `node` / `node-22` / `bun` / …                                              |
| `deployment.runtime_version`     | lifecycle        | Set at indexing; null for pre-index failures                                |
| `deployment.cli_version`         | both             | From `x-trigger-cli-version` at init; null for pre-column history           |
| `deployment.triggered_via`       | both             | e.g. `cli`, GitHub/Vercel integrations                                      |
| `deployment.commit_sha`          | lifecycle        | From git meta when present                                                  |
| `deployment.error.name`          | lifecycle        | Error class from `errorData` (`TimeoutError`, build errors, …)              |
| `deployment.error.message`       | lifecycle        | Human-readable failure reason                                               |
| `deployment.canceled_reason`     | lifecycle        | Only on CANCELED                                                            |
| `deployment.duration.total_ms`   | lifecycle        | createdAt → terminal (also the span's own duration)                         |
| `deployment.duration.queue_ms`   | lifecycle        | createdAt → startedAt; ≈0 when created directly in BUILDING (depot)         |
| `deployment.duration.install_ms` | lifecycle        | startedAt → installedAt; build-server paths only (depot never sets it)      |
| `deployment.duration.building_ms`| lifecycle        | (installedAt ?? startedAt) → builtAt                                        |
| `deployment.duration.deploying_ms`| lifecycle       | builtAt → terminal; for depot dominated by the server-side registry push    |

The span's `_time` is the deployment's **createdAt**, so a TIMED_OUT event lands
backdated by up to the full deploy timeout (~23 min at current defaults) — monitors
must use windows longer than the max timeout or they will systematically miss the
stuck deployments they exist to catch.

Phase durations are omitted (not zero) when a boundary timestamp is missing —
timestamp chains are path-shaped. Compare only shared phases across build paths;
`total_ms` excludes local-bundle's pre-init client work (esbuild + upload) until
the CLI passes client timings.
