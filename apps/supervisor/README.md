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

4. Build CLI, then deploy a reference project

```sh
pnpm exec trigger deploy --self-hosted

# The additional network flag is required on linux
pnpm exec trigger deploy --self-hosted --network host
```

## Additional worker groups

When adding more worker groups you might also want to make them the default for a specific project. This will allow you to test it without having to change the global default:

```sh
api_url=http://localhost:3030
wg_name=my-worker

# edit these
admin_pat=tr_pat_...
project_id=clsw6q8wz...

curl -sS \
    -X POST \
    "$api_url/admin/api/v1/workers" \
    -H "Authorization: Bearer $admin_pat" \
    -H "Content-Type: application/json" \
    -d "{
        \"name\": \"$wg_name\",
        \"makeDefaultForProjectId\": \"$project_id\"
    }"
```
