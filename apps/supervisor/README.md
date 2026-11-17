# Supervisor

## Dev setup

1. Create a worker group

```sh
api_url=http://localhost:3030
wg_name=my-worker

# edit this
admin_pat=tr_pat_...

curl -sS \
    -X POST \
    "$api_url/admin/api/v1/workers" \
    -H "Authorization: Bearer $admin_pat" \
    -H "Content-Type: application/json" \
    -d "{\"name\": \"$wg_name\"}"
```

If the worker group is newly created, the response will include a `token` field. If the group already exists, no token is returned.

2. Create `.env` and set the worker token

```sh
cp .env.example .env

# Then edit your .env and set this to the token.plaintext value
TRIGGER_WORKER_TOKEN=tr_wgt_...
```

3. Start the supervisor

```sh
pnpm dev
```

4. Build CLI, then deploy a test project

```sh
pnpm exec trigger deploy --self-hosted

# The additional network flag is required on linux
pnpm exec trigger deploy --self-hosted --network host
```

## Secret proxy lab integration

`SECRET_PROXY_INTERCEPTOR_SOCKET` requires `SECRET_PROXY_UNSAFE_LAB_ENABLED=true`, forced Kubernetes, the run-crd microVM runtime, and enforced workload authentication. The lab opt-in also asserts that exactly one supervisor exclusively owns this interceptor control socket and is its only registrar. Do not enable it on a shared interceptor.

Startup permanently revokes credential authority for all existing allocation contexts through the owner-only socket, including contexts whose first PUT is still pending. A supervisor restart deliberately disrupts running and pending protected runs: they need new VM allocations created after the reset. Ordinary opaque HTTPS continues on the old contexts. Proxy capability stays false until the reset acknowledges with HTTP 204. A failed reset is retried by the existing cleanup timer; ordinary runs remain available.

This is a dedicated unsafe-lab lane, not an enabled-everywhere rollout. It supports no warm starts, checkpoints, compute snapshots or restores, including for ordinary runs on that supervisor. Configuring the socket clears both supervisor warm URLs, preventing this supervisor from dispatching to warm guests. The native compute operator independently injects the guest warm URL: its `runner.warm_start_url` must also be empty, and the lab node pool must not be shared with ordinary lanes or warm pools. Clearing supervisor configuration alone does not stop native guests registering as warm.

Route enrolled environments only to the lab worker group or queue. The warm service matches deployment, version and machine, not worker group, so sharing a warm service can cross worker groups. Incorrect routing or operator configuration causes protected attempts to nack through preflight and can exhaust the dequeue budget; the Kubernetes identity checks still prevent reused guests receiving bindings. There is no guaranteed fresh reschedule after warm rejection.

Cold starts verify Runner/Pod placement and discover a live fcrun-owned allocation context before advertising per-run proxy capability. Its guest/run/attempt pin must match, and its actual VM allocation ID is used for binding and revocation. Warm, missing or unsupported contexts report no capability, so protected attempts are rejected before execution. Supervisors without the socket keep their existing behavior. Ordinary runs retain no proxy binding state, and retry restrictions remain per run. A post-start attachment failure revokes before completing the attempt with a queued retry, consuming an attempt under the existing retry limits.

Do not subscribe lab supervisors to restore-phase queues. A checkpoint may contain plaintext from before enrollment. Any pre-existing checkpointed run whose restore lands on the lab lane is permanently failed before restore or runner creation, including when an existing queue is converted into the lab lane. Snapshot deletion remains enabled through its separate `TRIGGER_SNAPSHOT_DELETE_URL`. Continuations on ordinary supervisors are outside this lab guard.

Allocation identity now comes from fcrun-owned listeners inside individual CNI namespaces, not source-IP lookups. fcrun requires `network.plugin_socket` pointing at `<controlSocket>.allocations` (the old socket setting remains an alias); the operator's existing `runner.additionalEnv` must set `TRIGGER_SECRET_PROXY_ENABLED=true`. The shim validates that trusted bootstrap and requests the generic `network_plugin` attachment; fcrun forwards its opaque run/attempt fields without interpreting them. The interceptor validates and pins the same execution metadata as before. Attached pooled namespaces are refused. Each context permits only its bootstrap run and attempt, including after credential revocation; no context is recreated for an adopted VM after a daemon restart.

Use a new cell and exclusive fresh-work queue with explicit test-org opt-in. The shared schema and per-org/environment routing flags support an explicit `proxy` channel, separate from stable/canary. For example, subscribe only this cell to `us-east-1:v2:ondemand:fresh:compute:proxy` and opt test orgs into `workerQueueChannel=proxy` and `workerQueueCompatibility=compute`. Ordinary fleets must not also consume that queue. No org flags or infrastructure are changed automatically; cell Terraform remains separate.

Native TAP/namespace and broker tests are component evidence, not a platform-to-Firecracker/Cilium E2E claim. Target-cell CNI behavior, guest CA installation, public-edge blocking, connection pooling and production PKI still require deployment validation. The unsafe-lab gate remains.

## Worker group management

### Shared variables

```sh
api_url=http://localhost:3030
admin_pat=tr_pat_... # edit this
```

- These are used by all commands

### Create a worker group

```sh
wg_name=my-worker

curl -sS \
    -X POST \
    "$api_url/admin/api/v1/workers" \
    -H "Authorization: Bearer $admin_pat" \
    -H "Content-Type: application/json" \
    -d "{\"name\": \"$wg_name\"}"
```

- If the worker group already exists, no token will be returned

### Set a worker group as default for a project

```sh
wg_name=my-worker
project_id=clsw6q8wz...

curl -sS \
    -X POST \
    "$api_url/admin/api/v1/workers" \
    -H "Authorization: Bearer $admin_pat" \
    -H "Content-Type: application/json" \
    -d "{\"name\": \"$wg_name\", \"projectId\": \"$project_id\", \"makeDefaultForProject\": true}"
```

- If the worker group doesn't exist, yet it will be created
- If the worker group already exists, it will be attached to the project as default. No token will be returned.

### Remove the default worker group from a project

```sh
project_id=clsw6q8wz...

curl -sS \
    -X POST \
    "$api_url/admin/api/v1/workers" \
    -H "Authorization: Bearer $admin_pat" \
    -H "Content-Type: application/json" \
    -d "{\"projectId\": \"$project_id\", \"removeDefaultFromProject\": true}"
```

- The project will then use the global default again
- When `removeDefaultFromProject: true` no other actions will be performed
