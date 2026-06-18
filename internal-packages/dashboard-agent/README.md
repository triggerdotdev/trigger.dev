# @internal/dashboard-agent

The in-dashboard agent, built on `chat.agent` and deployed as its own Trigger
project. This is the launch-week dogfood: we run our own product on the
primitive we ship.

## Why a separate package (not inside apps/webapp)

The agent has **no access to the main database, ClickHouse, or webapp
internals** — it reads everything via the API. Living in a standalone package
that doesn't depend on the webapp makes that firewall **structural**: the
package physically cannot import webapp server code. It also keeps the webapp a
pure Remix app instead of a dual Remix-app-and-Trigger-project, and gives the
agent a small, fast, independently deployable + testable build context.

It writes conversation state to its own datastore via `@internal/dashboard-agent-db`
(the same package the webapp reads from for the History tab). It never touches
Prisma.

## Deploy / dev

This is a Trigger project with its own `trigger.config.ts`. The project ref is
read from `TRIGGER_DASHBOARD_AGENT_PROJECT_REF` (never hardcoded — public repo).

```bash
cd internal-packages/dashboard-agent
TRIGGER_DASHBOARD_AGENT_PROJECT_REF=<your-project> pnpm run dev      # trigger dev
TRIGGER_DASHBOARD_AGENT_PROJECT_REF=<your-project> pnpm run deploy   # trigger deploy
```

Runtime env the deployed task needs: `DASHBOARD_AGENT_DATABASE_URL` (the agent
datastore) and `OBJECT_STORE_*` (chat.agent's built-in conversation snapshot).

## Consumed by the webapp

The webapp imports only the task **type** for transport type-safety:

```ts
import type { dashboardAgent } from "@internal/dashboard-agent";
```

Never a value import (see `src/index.ts`).
