# Supervisor

## Dev setup

1. Create a worker group

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
        \"makeDefault\": true,
        \"projectId\": \"$project_id\"
    }"
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
