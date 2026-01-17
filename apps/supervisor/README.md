# Supervisor

## Quick Setup (Recommended)

Use the automated setup script to create and configure workers.

### Prerequisites

- `curl` and `jq` installed
- Personal Access Token (PAT) from your Trigger.dev instance

### Basic Usage

```bash
# Interactive mode (will prompt for missing values)
./scripts/setup-worker.sh

# With parameters
./scripts/setup-worker.sh \
  --name my-worker \
  --pat tr_pat_... \
  --api-url https://trigger.example.com \
  --project-ref proj_... \
  --default
```

### Examples

**Self-hosted with specific project:**

```bash
./scripts/setup-worker.sh \
  --name production-worker \
  --pat tr_pat_... \
  --api-url https://trigger.example.com \
  --project-ref proj_... \
  --default
```

**Using environment variables:**

```bash
export TRIGGER_PAT=tr_pat_...
export TRIGGER_API_URL=https://trigger.example.com
export TRIGGER_WORKER_NAME=my-worker
export TRIGGER_PROJECT_REF=proj_...

./scripts/setup-worker.sh --default
```

**List available projects first:**

```bash
./scripts/setup-worker.sh --list-projects
```

**Dry-run (see what would happen):**

```bash
./scripts/setup-worker.sh \
  --name test-worker \
  --project-ref proj_... \
  --dry-run
```

### Script Options

| Option                | Description                               |
| --------------------- | ----------------------------------------- |
| `--name <name>`       | Worker group name (required)              |
| `--pat <token>`       | Personal Access Token (tr*pat*...)        |
| `--api-url <url>`     | Trigger.dev API URL                       |
| `--project-ref <ref>` | Project external ref (proj\_...)          |
| `--project-id <id>`   | Project internal ID (cmk...)              |
| `--default`           | Make worker default for project           |
| `--list-projects`     | List all projects and exit                |
| `--dry-run`           | Show what would be done without executing |
| `--help`              | Show help message                         |

### Finding Your PAT

Your Personal Access Token is stored locally after running `trigger.dev login`:

**macOS:**

```bash
cat ~/Library/Preferences/trigger/config.json | jq -r '.profiles.default.accessToken'
# OR
cat ~/Library/Application\ Support/trigger/config.json | jq -r '.profiles.default.accessToken'
```

**Linux:**

```bash
cat ~/.config/trigger/config.json | jq -r '.profiles.default.accessToken'
```

**Windows:**

```powershell
type %APPDATA%\trigger\config.json | jq -r ".profiles.default.accessToken"
```

---

## Dev setup

**Quick Start:** Use the [automated setup script](#quick-setup-recommended) for easier configuration.

**Manual Setup:** Follow these steps if you prefer manual configuration:

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

---

## Appendix: Project ID Types

Trigger.dev uses two types of project identifiers:

| Type             | Format          | Where Used                      | Example                     |
| ---------------- | --------------- | ------------------------------- | --------------------------- |
| **External Ref** | `proj_...`      | trigger.config.ts, CLI commands | `proj_pxutendrlvklfzuatira` |
| **Internal ID**  | `cmk...` (CUID) | Admin APIs, Database operations | `cmkif24mo0005nu1yt2y5dkrf` |

The setup script automatically resolves external refs to internal IDs when needed.

### Getting Project Information

List all projects with both ID types:

```bash
curl -sS \
  -H "Authorization: Bearer tr_pat_..." \
  "https://your-instance.trigger.dev/api/v1/projects" | jq
```

Or use the setup script:

```bash
./scripts/setup-worker.sh --list-projects --pat tr_pat_...
```
