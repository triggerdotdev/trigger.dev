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
