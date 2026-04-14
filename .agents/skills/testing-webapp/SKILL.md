# Testing the trigger.dev Webapp

## Overview
How to build, run, and comprehensively test the trigger.dev webapp locally.

## Devin Secrets Needed
None required for local testing - the webapp auto-logs in with `local@trigger.dev` in dev mode.

## Prerequisites
- Node.js 20.20.0 (via nvm)
- pnpm 10.23.0
- Docker services running (postgres, redis, clickhouse, electric, etc.)
- Migrations applied (`pnpm run db:migrate`)

## Build Process
The webapp build has 3 sequential steps that must all complete:

```bash
cd apps/webapp

# Step 1: Build Remix assets (client + server bundles)
npx remix build

# Step 2: Build Express server entry point
npx esbuild --platform=node --format=cjs ./server.ts --outdir=build --sourcemap

# Step 3: Build Sentry integration module
npx esbuild --platform=node --format=cjs ./sentry.server.ts --outdir=build --sourcemap
```

**Important:** `remix dev` only does Step 1. Steps 2 and 3 must be run manually before starting the dev server. The server.ts imports sentry.server.ts, so both must exist.

## Starting the Dev Server
```bash
cd apps/webapp
PORT=3030 node_modules/.bin/remix dev -c "node ./build/server.js"
```

The webapp will be available at `http://localhost:3030`. It auto-redirects to the login page, and in local dev mode, logging in with `local@trigger.dev` auto-completes without needing a real email.

## Operational Testing with Reference Projects
To test with real task data, use the hello-world reference project:

### Setup
1. Update `references/hello-world/trigger.config.ts` with the local project ref:
   ```bash
   # Get project ref from database
   docker exec database psql -U postgres -d trigger -t -A -c "SELECT externalRef FROM \"Project\" LIMIT 1;"
   ```

2. Authenticate the CLI against localhost:
   ```bash
   node packages/cli-v3/dist/esm/index.js login -a http://localhost:3030 --profile local
   ```

3. Start the dev server:
   ```bash
   cd references/hello-world
   node /path/to/packages/cli-v3/dist/esm/index.js dev -a http://localhost:3030 --profile local
   ```

### Triggering Tasks
Get the dev API key from the database:
```bash
docker exec database psql -U postgres -d trigger -t -A -c "SELECT apiKey FROM \"RuntimeEnvironment\" WHERE type='DEVELOPMENT' LIMIT 1;"
```

Trigger tasks via API:
```bash
curl -s http://localhost:3030/api/v1/tasks/hello-world/trigger \
  -H "Authorization: Bearer <API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"payload":{"sleepFor":1000}}'
```

## Comprehensive UI Testing Checklist

### Sidebar Pages (22 pages)
- **Tasks**: Task list, search filtering, columns, row click navigation
- **Runs**: Run list with mixed statuses, all table columns
- **Run Detail**: Trace tree, log levels, timeline, replay button, search
- **Batches**: May show empty state
- **Schedules**: Schedule entries with CRON, timezone, next run
- **Queues**: Queue list, pagination, search, pause buttons
- **Waitpoint tokens**: May show empty state with docs links
- **Deployments**: Deploy instructions, environment switcher
- **Test**: Task list with search, payload editor
- **Bulk actions**: Instructions, "New bulk action" button
- **API keys**: Secret keys with regenerate button
- **Environment variables**: Add new button
- **Alerts**: Environment-specific messaging
- **Preview branches**: New branch button
- **Regions**: May show 400 error in local dev (no worker group) - this is expected
- **Limits**: Concurrency, rate limits, quotas, plan features
- **Project settings General**: Project ref, name form, delete form
- **Project settings Integrations**: Integration list/empty state
- **Organization settings**: Logo, org name, delete form
- **Team**: User list, invite button, seat count

### Filter Dropdowns
- **Filter menu** (funnel icon on Runs page): 11 filter types - Status, Tasks, Tags, Versions, Queues, Machines, Run ID, Batch ID, Schedule ID, Bulk action, Error ID
- **Status filter**: 13 statuses - Pending version, Delayed, Queued, Dequeued, Executing, Waiting, Completed, Failed, Timed out, Crashed, System failure, Canceled, Expired
- **Date filter** (Created): Custom input, relative presets (1min-30days), exact date range, quick presets
- **Root only toggle**: Updates URL with `?rootOnly=true`

### Switcher Dropdowns
- **Environment switcher**: Dev, Staging, Preview (expandable), Production
- **Project/Org switcher**: Org info, projects, New project, New org, Account, Logout

## Tips
- The `pnpm run dev --filter webapp` command might not work reliably. Use the manual build + `remix dev` approach instead.
- If port 3030 is already in use: `fuser -k 3030/tcp`
- The trigger CLI must authenticate against localhost separately from cloud: use `-a http://localhost:3030 --profile local`
- `pnpm run db:seed` may hang - it's not required if migrations are applied
- The Regions page showing a 400 error in local dev is expected behavior (no worker group configured)
