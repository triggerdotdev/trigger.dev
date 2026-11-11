# Manual waitpoint rollback recovery

This internal command discovers bounded pages of organization-owned native run partitions and RUN/DATETIME/MANUAL/BATCH sources, or inspects supplied run IDs. It produces a review manifest, cleans explicitly selected partitions/sources, and verifies retained withdrawals, indexed absorption contributions and remaining retention. It starts no engine, worker, fanout loop, snapshot reader, or application server. Importing the service has no connections or side effects. Normal flag-off paths never invoke it.

**A verified page is not an organization-complete re-enable certificate.** Sources published before this source registry was deployed still require source IDs or surviving fanout hints; future pending sources and permanent keyed retention remain deliberate. Every scope report includes an `unhandled` list, even when every selected result says `verified: true`.

## Incident prerequisites

1. Disable `waitpointStoreEnabled` for the affected organization through existing controls. New runs use legacy creation while disabled. After disabling a global default, wait at least one configured `GLOBAL_FLAGS_RELOAD_INTERVAL_MS` (default 5 seconds) before inspection so application flag caches can refresh. Keep the flag fixed throughout inspection/apply/verification and serialize re-enable with the incident owner. The command checks the authoritative org override/global default before inspection and each destructive step, but a SQL flag read and MemoryDB write cannot form one atomic transaction.
2. Use bounded discovery below when incident IDs are missing. Native admission publishes an organization-owned run registry before absorption; retained withdrawal IDs are indexed atomically with detach, so current `blk`/`co` and old block IDs are rediscoverable after state expiry. Native RUN/DATETIME publication also records organization-owned source IDs before the first source write. These source registries cover pending publications and completed sources after metadata expiry; existing due/quarantine discovery remains available. Supplied-run inspection remains available; its optional `sourceIds` retain the existing narrow reviewed-source behavior. Contribution identities remain indexed per run. There is no keyspace scan or unindexed SQL query.
3. Active and pending runs with authoritative metadata never qualify merely because they are old. A missing SQL run is eligible only when its trusted organization registry entry survives; it is explicitly classified `abandoned-registry-owned` and requires disabled-organization maintenance selection. SQL errors propagate and foreign SQL ownership is refused. To abandon an affected live run, cancel it through the normal run lifecycle, wait for authoritative terminal status, then inspect again. This command does not cancel or terminalize the application run. Run metadata is read from the current run store's primary through the existing run-ID router; native coordination/results remain authoritative in MemoryDB.
4. Drain or stop producers/lifecycle work for the selected terminal runs and named sources before apply; stop fanout visits for those sources too. Disabling the flag alone does not stop already-started fanout. Existing atomic terminal fencing rejects in-flight delivery and new absorption before watcher withdrawal. An exact state comparison inside the first destructive script rejects a cycle changed after preflight. A partial failure retains the exact withdrawal manifest without TTL for a manual retry. Do not re-enable with unresolved selected targets.
5. Use the **deployed read topology**, including legacy/new databases and every configured generation-2 shard/alias, even if split creation was disabled. Use primary endpoints. Single mode is for legacy-schema run metadata only and refuses dedicated-store run IDs; use routed mode for any deployment that has dedicated-store runs. Missing owning shards, tenant mismatch, legacy markers, corrupt native state and changed lifecycle fail closed. Missing run metadata alone permits only the explicit registry-owned abandonment described above. Never redirect missing runs or reconstruct native state from Postgres.

Finite retained native MANUAL catalogs require optional `workerQueue: {"redisUrlEnv":"RUN_ENGINE_WORKER_REDIS_URL","keyPrefix":"engine:worker:"}` in the topology configuration. Use the exact deployed worker Redis endpoint and full queue prefix (including `worker:`); this opens only an enqueue/inspect client. Apply replaces the source's retirement job with a fresh scheduled identity, including any previous DLQ attempt. Verification reports `maintenanceAvailableAt`; re-enable before the earliest reported time, or rerun maintenance and verification if that time passes while disabled. Disabled ordinary workers may consume this job, so verification is a bounded validity window. Pending tokens and immutable permanent keys intentionally retain their catalogs and discovery ownership.

## Operator invocation

Install workspace dependencies and generate database clients normally. Use this checked-out release's source and matching database schemas. From `trigger.dev/`, build the database runtime required by the harness:

```sh
pnpm run build --filter @trigger.dev/database
```

`@trigger.dev/database` resolves to `dist/` even with the source condition below; generating the clients alone does not create this runtime. Then, from `trigger.dev/internal-packages/run-engine/`:

```sh
NODE_OPTIONS=--conditions=@triggerdotdev/source pnpm exec tsx harness/waitpointRollbackRecovery.ts \
  --config /secure/rollback-topology.json --scope /secure/rollback-scope.json \
  --out /secure/rollback-plan.json
```

Connection URLs come from named environment variables and never appear in the manifest. Example single-database topology:

```json
{
  "deployment": "production-region-a",
  "controlPlaneUrlEnv": "DATABASE_URL",
  "redisUrlEnv": "RUN_ENGINE_WAITPOINT_STORE_REDIS_URL",
  "redisCluster": true,
  "runStores": { "mode": "single", "urlEnv": "DATABASE_URL" }
}
```

For a routed deployment replace `runStores` with its deployed topology:

```json
{
  "mode": "routed",
  "legacyUrlEnv": "RUN_OPS_LEGACY_DATABASE_URL",
  "newUrlEnv": "RUN_OPS_DATABASE_URL",
  "shards": [
    { "key": "a", "aliasOf": "new" },
    { "key": "b", "urlEnv": "RUN_OPS_SHARD_B_DATABASE_URL" }
  ]
}
```

For discovery, save a cursor request (start with partition 0):

```json
{"organizationId":"org_internal_id","kind":"runs","partition":0}
```

```sh
NODE_OPTIONS=--conditions=@triggerdotdev/source pnpm exec tsx harness/waitpointRollbackRecovery.ts \
  --config /secure/rollback-topology.json --discover /secure/cursor.json \
  --out /secure/discovery-page.json
```

The output contains `plan` and `next`. Save the unedited `plan` object as the reviewed plan file. If `next` is non-null, save it as the next cursor request; continue to exhaustion for each partition 0–15 and each kind `runs`, `pending-sources`, `due`, `quarantine`. All scores are included, including future due entries and quarantine. Each read examines at most 100 members, performs at most 64 rank-one binary-search reads, and returns a stable `(score, member)` cursor. Unrelated organizations may change earlier ranks without skipping target entries. Keep the target organization's producers/fanout quiescent so its own members do not move across the cursor. Run discovery reads at most 98 historical withdrawal IDs per run; remaining IDs keep verification false and the run registered for a fresh page after apply. Run discovery does not materialize all parent edges or source payloads.

Select sources explicitly with `--source SOURCE_ID` (repeat as needed), and runs with `--run RUN_ID`, up to 100 total selections per apply. Source-only plans need no run ID. Source ownership is checked through an indexed primary environment lookup during discovery and again during apply. Surviving environment ownership must agree. Trusted source registry membership plus immutable native organization metadata permits a deleted environment; errors are never treated as absence. An absent source record is actionable only through trusted source registry evidence and when all source keys are absent. Other missing ownership remains unknown and retained. A completed source with live watchers remains unverified. Discovered run withdrawal removes only that run's watchers; completed source cleanup is selected independently. After registry retirement, a saved abandoned plan may verify its unchanged converged native state, but cannot authorize another apply without registry membership.

Example scope (maximum 100 unique runs and 20 supplied historical blocks per run):

```json
{
  "organizationId": "org_internal_id",
  "runs": [
    { "runId": "internal_run_id", "blockIds": ["known_previous_block_id"], "sourceIds": ["known_source_id"] },
    { "runId": "another_internal_run_id", "blockIds": [] }
  ]
}
```

Inspection is the default: primary SQL reads and fixed-size read-only MemoryDB scripts, without tombstones or index repair. It reports terminal, pending, active-requires-cancellation, legacy and unknown targets; counts/TTLs; generation identity; indexed contribution count and named retained withdrawal obligations. Source environment ownership, immutable record metadata, status and completion identity are saved in the plan before withdrawal. Supplied-run inspection includes up to 128 detached withdrawal targets per run in the reviewed source list. If more remain, apply stops on an unreviewed source; preserve the previous source list and inspect again with the additional IDs, or use organization discovery. Customer outputs are not loaded. Review ownership, classification, native identities, obligations and `unhandled`. Plans expire after one hour and bind to the deployment/topology/endpoints. Keep them private; re-inspect instead of editing eligibility/generation fields.

Apply requires explicit selection from the reviewed terminal entries:

```sh
NODE_OPTIONS=--conditions=@triggerdotdev/source pnpm exec tsx harness/waitpointRollbackRecovery.ts \
  --config /secure/rollback-topology.json --plan /secure/rollback-plan.json \
  --apply --run internal_run_id --confirm-maintenance-window \
  --out /secure/rollback-apply.json
```

`--confirm-maintenance-window` acknowledges the prerequisites; it is not a runtime rollout flag or permission to cancel runs. The command preflights all selections, revalidates ownership/status at each target, uses the existing fenced terminal withdrawal, retires indexed contribution records in pages of at most 128 with the exact generation rechecked in each atomic deletion, and verifies the scoped keys. Snapshot results remain readable for the existing 14-day terminal retention window. For each reviewed completed source, a constant-work atomic check requires the saved source identity and zero live watchers before unlinking its stale paging queue/fanout and arming the ordinary 14-day record window. Completion output remains intact, existing TTLs never extend, and keyed DATETIME retention/allocation rules are preserved. Shared sources with live watchers are left intact and make cleanup unverified; resolve those watchers through their owners before retrying. A source still held by a parent run's prepared registration receives no new retention and is reported unverified, with `registrationHold: true` when it was selected as a source; an elapsed DATETIME still receives its empty completion and an elapsed MANUAL its timeout error. The hold does not name its run: find candidate parents with run discovery, cancel a live holder through the normal lifecycle, then select the terminal or abandoned holder (its contribution cleanup releases the hold), then inspect and apply the source again. Future deadlines, active RUN children and shared sources are preserved. Eligible terminal/missing RUN children receive finite record retention; elapsed DATETIME deadlines receive their normal empty completion. Tracked keyed attempt receipts are fenced and receive finite retention before discovery metadata is retired. Source-index removal follows in its own slot; the saved plan owns replay if that step fails, including after the source record expires. Sources absent with no remaining source-slot keys can have their stale index entry removed. It never withdraws another run's registrations. Reapplying a converged target does not extend retention.

On error, apply stops before the next selected target. The report preserves completed results and includes an `errors` array with the failure stage and message. Preflight failures produce an error report before mutation; setup or input failures after reserving the output path also produce a structured error report. Errors and unverified results exit nonzero. Preserve the plan, resolve the operational cause (permissions/connectivity), then rerun with a fresh output filename within plan validity. Durable withdrawal evidence owns recovery after process exit. After plan expiry, repeat discovery to recover remaining run/withdrawal and completed-source identities. For supplied-run plans, preserve previous source IDs through `sourceIds`. A page verifies only its saved scope. Missing/corrupt state is not repaired. Output files use exclusive creation and mode `0600`; evidence files are never overwritten.

Verify separately while disabled:

```sh
NODE_OPTIONS=--conditions=@triggerdotdev/source pnpm exec tsx harness/waitpointRollbackRecovery.ts \
  --config /secure/rollback-topology.json --plan /secure/rollback-plan.json \
  --verify --out /secure/rollback-verification.json
```

Unsuccessful apply/verification exits nonzero. Verification covers every eligible entry in the manifest, including entries not yet selected for apply. `verified: true` means no persistent run partition key, indexed contribution, indexed or named withdrawal obligation, or current/cleanup block reference for that terminal run, and every reviewed completed source has converged with no source fanout/index obligation. Future pending sources, active children and shared sources are reported as retained; eligible pending RUN/DATETIME sources and tracked keyed attempt receipts are included in cleanup. Review noneligible inspection entries too.

## Contribution residue after re-enable

If rollback consumed recovery jobs while the flag was off, indexed absorption contribution records can remain after re-enable. Use the separate `contributions-only` operation for explicitly supplied terminal runs. Full rollback still requires the flag to be disabled; this operation works with either flag value and never releases watchers, installs terminal fences, changes results retention, or removes other run keys.

Keep the deployed topology and primary ownership checks above. **Drain or stop all producers/lifecycle work for the selected terminal runs throughout inspection, apply and verification**, including already-started absorption and compensation jobs. Serialize this maintenance with the incident owner. This operation relies on authoritative terminality and quiescence; it does not install a fence against in-flight producers. An unchanged stale native `blk`/`co` reference, or absent native state after expiry, is allowed. Each page compares the exact inspected native generation inside the deletion script; a changed cycle requires fresh inspection. Active, missing, legacy and foreign runs remain ineligible.

Create a fresh review plan with the operation recorded in it:

```sh
NODE_OPTIONS=--conditions=@triggerdotdev/source pnpm exec tsx harness/waitpointRollbackRecovery.ts \
  --config /secure/rollback-topology.json --scope /secure/rollback-scope.json \
  --operation contributions-only --out /secure/contribution-plan.json
```

Apply and verify using the same commands above, substituting this plan and fresh output filenames. The plan selects the operation; do not pass `--operation` to apply/verify. Explicit `--run` selection and `--confirm-maintenance-window` remain required for apply. Plans expire after one hour; changed primary run metadata or native generation requires re-inspection. Interrupted pages leave the remaining index members discoverable for manual rerun, even after ordinary state expires (re-inspect after expiry).

For this operation alone, `verified: true` means the supplied terminal run's contribution index is empty. It does **not** certify run-partition retention or withdrawal cleanup. No job or absorption IDs are needed, but the operator must supply run IDs with surviving authoritative ownership/terminal metadata. Omitted runs, missing metadata and records absent from the index cannot be discovered or certified. Unknown scope can therefore still leave residue; run/source registry discovery is a separate explicit operation and there is no background reconciliation.

## Coverage limits before re-enable

- Organization run registries discover admitted runs, including missing SQL runs, within the sixteen explicitly requested partition pages. Missing SQL alone is never deletion evidence: trusted registry ownership is required. Older unindexed runs still require incident IDs.
- Per-run withdrawal indexes retain detached block IDs after ordinary run state expires. Historical withdrawals created before that index was deployed still require supplied IDs or current `blk`/`co` references.
- Outstanding per-absorption records for supplied runs are included through their durable per-run index. No job or absorption ID input is needed. Active/pending runs and foreign tenants remain ineligible.
- Source ownership registries discover native publications without source IDs, including completed sources whose record expired while due/quarantine hints remain. Older unindexed sources and untracked keyed receipts remain outside this operation. Tracked keyed receipt identities survive source expiry and losing-candidate deletion; their candidate publication fences and per-attempt receipt retention are included without changing permanent key mappings. Future deadlines, active children and live watchers are retained.
- Legacy Postgres rows remain outside cleanup scope. Native records are never shadowed or reconstructed there.

Before re-enable, deploy the fixed release and review scope, cleanup/verification evidence and every unresolved coverage gap with the incident owner. Re-enable uses the existing deliberate flag operation; this command never changes it. Local standalone Redis tests prove the exercised protocol, not cloud MemoryDB failover or production scope completeness.

## Index costs and boundaries

Native absorption adds one organization run-index `ZADD`, partitioned by run ID over sixteen fixed keys per organization. Rollover/abandon/terminal detach adds a same-slot withdrawal-index `ZADD`; finalization adds its matching `ZREM`. No owed index has a TTL. Successful wait/resume keeps admission evidence; terminal lifecycle checks the native fence (or fully absent state), empty contribution/withdrawal indexes and finite remaining key TTLs before removing the organization member. A crash before absorption leaves discoverable admission evidence; a lost retirement reply is replay-safe. These commands run only after native routing admission, with no ordinary flag-off work. Manual discovery performs bounded reads and indexed primary ownership lookups; costs have not been latency-measured. The source registry also discovers pending sources without fanout hints.

Pending source discovery uses the same cursor format with `"kind":"pending-sources"`, for all sixteen partitions. It is organization-owned evidence published before native RUN/DATETIME creation, so incident source IDs and deadline jobs are not required. Inspect each page, then explicitly select source IDs with `--source` during the disabled, quiescent maintenance window.

For selected sources with no live watchers, terminal or confirmed-missing RUN children permit finite retention of the existing pending record (accepted rollback run loss); no synthetic result is written. Passed DATETIME deadlines receive their ordinary empty completion and normal retention. Future pending sources and active RUN children remain untouched. Permanent keyed DATETIME mappings and their records remain permanent. Missing publication records may have their organization-owned index entry removed only when all source keys are absent. Interrupted cleanup is replayable from the saved plan; renew expired plans by rediscovering and retaining source IDs.

Enabled native publication adds one partitioned ZADD before the first source write. Completion republishes ownership atomically with any new hint and retains it while due/quarantine hints or keyed allocation protection remain. Normal hint retirement, candidate closure/acknowledgement, and already-completed recovery retire the member with ZREM only after hint removal or finite candidate retention owns recovery. A crash retains a duplicate discovery entry. Normal hint retirement reads immutable organization metadata and keyed allocation protection with one HMGET, then retires the hint and source membership atomically when no quarantine/protection remains. Protected keyed sources get one post-removal allocation check; concurrent acknowledgement can require one bounded retirement EVAL. Candidate acknowledgement/closure uses one bounded retirement EVAL. Counts and latency have not been benchmarked. Flag-off paths perform none of these operations.

For keyed DATETIME attempts, source publication atomically records the exact scoped per-attempt receipt key and fixed publication deadline beside the source registry. A normal acknowledgement removes this metadata only after receipt retention is finite. Cached losers stay discoverable until acknowledgement, even after their candidate record is deleted. Manual cleanup revalidates the captured identity before changing receipt retention; interrupted cleanup retains discovery evidence. Before touching a tracked candidate, cleanup reads and fences its live receipt atomically using Redis time. An expired unpublished `pending` receipt is cancelled first; only a cancelled attempt or a receipt naming another winner authorizes candidate deletion, even when the requested DATETIME deadline is still future. Published future winners remain unchanged. If the receipt is missing while a source record remains, cleanup retains the source and discovery evidence and reports it unverified: receipt absence cannot prove that the candidate never won. After the publication deadline, an inspection that found no source record may retire stale discovery metadata only if an atomic check still finds all source-slot keys absent. Receipt metadata adds one hash entry per unresolved keyed attempt, one indexed metadata read per inspected source, and one receipt-fencing command before source cleanup plus one receipt-retention command after converged cleanup per selected tracked source. These operator-only costs are unmeasured; no extra ordinary flag-off work or background job is added.
