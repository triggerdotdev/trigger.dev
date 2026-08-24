# @internal/dashboard-agent

The in-dashboard agent, built on `chat.agent` and deployed as its own Trigger
project. This is the launch-week dogfood: we run our own product on the
primitive we ship.

Running it locally, what it does, and a walkthrough per flow:
[GUIDEBOOK.md](./GUIDEBOOK.md).

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
datastore, falling back to `DATABASE_URL` when the store lives in the main
database) and `OBJECT_STORE_*` (chat.agent's built-in conversation snapshot).

## Consumed by the webapp

The webapp imports only the task **type** for transport type-safety:

```ts
import type { dashboardAgent } from "@internal/dashboard-agent";
```

Never a value import (see `src/index.ts`).

## What a call costs

Two numbers decide the bill: the cacheable prefix every call pays for, and the
conversation that rides on top of it.

- **The prefix** (system prompt + tool schemas) is measured in `src/prompt-prefix.ts` and
  budgeted in `src/prompt-prefix.test.ts`: explicit ceilings per mode, plus a committed
  snapshot of prompt chars/tokens, tool-schema chars/tokens, tool count and the fingerprints.
  A change that grows the prefix past a ceiling must **move that ceiling in the same PR** and
  accept the snapshot diff (`vitest -u`) — that is the whole point of the numbers.
- **The conversation** is compacted in `src/compaction.ts`: above 60k tokens of conversation
  (on top of the ~21k prefix) the older part becomes a Haiku-written summary. The UI
  transcript is never compacted, and an open investigation, a live watch and an already
  delivered wake are pinned back onto the model's history verbatim, so a summary can never
  cost the agent the `investigationId` it has to keep revising.

## Turn evals

A sampled fraction of turns is scored by an LLM judge (`dashboard-agent-eval-turn`), which
writes one `chat_turn_evals` row. The rules live in one file, `src/eval-policy.ts`:

- **Sampling.** `DASHBOARD_AGENT_EVAL_SAMPLE_RATE`, default **0.1** — the judge is a full
  model call per turn and nothing reads the rows yet. Golden / CI runs are a separate lane:
  `DASHBOARD_AGENT_EVAL_SAMPLE_RATE_CI` (default 1) applies only when
  `DASHBOARD_AGENT_EVAL_CONTEXT=ci`, so neither lane can change the other's rate.
- **Redaction.** Run payloads and outputs, query result rows, file contents and span
  attributes are replaced by their shape before the turn leaves the agent. The row keeps the
  judge's derived verdict only — never the question, the answer, or any tool data.
- **Code mode.** A turn that called a source tool is not judged at all.
- **Opt-out.** Per-org, via the `dashboardAgentTurnEvalsEnabled` feature flag. The agent asks
  the API before every judged turn and judges only on an explicit yes.
- **Retention.** Rows are dropped after 30 days by the webapp's dashboard-agent sweep.

When a document and the code disagree about any of the above, the code is the fact and the
document is the bug: fix the document in the same change.
