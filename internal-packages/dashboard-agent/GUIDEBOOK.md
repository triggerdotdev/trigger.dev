# Dashboard Agent — team guidebook

The dashboard agent is an AI assistant living in a side panel on every page of the
dashboard. It reads your runs, errors, queues, deployments and health telemetry
through the same APIs you use, answers in place, and renders rich cards — never
guessing at numbers it didn't fetch. It is **read-only**: it can look at
everything you can, and change nothing.

This guide covers what you can ask, what to click, and how to run it locally.
Everything here works today on the `feat/dashboard-agent-flows` branch.

---

## Running it locally

```bash
pnpm run docker && pnpm run db:migrate && pnpm run db:seed
# the agent's own tables:
pnpm --filter @internal/dashboard-agent-db run db:migrate

# a playground project with realistic data + 14 example conversations:
pnpm --filter webapp run db:seed:agent-examples
# optional: keep the playground's telemetry fresh forever (Ctrl-C safe):
pnpm --filter webapp run db:seed:agent-examples -- --heartbeat
```

In `apps/webapp/.env`: `DASHBOARD_AGENT_ENABLED=1`, `ANTHROPIC_API_KEY=…`, and
`DASHBOARD_AGENT_SECRET_KEY=<a dev env key of the trigger project the agent task
runs in>`. In `internal-packages/dashboard-agent/.env`: `ANTHROPIC_API_KEY` and
`DATABASE_URL`. Then:

```bash
pnpm run dev --filter webapp
cd internal-packages/dashboard-agent && pnpm exec trigger dev
```

Open the playground: **`/orgs/agent-examples-…/projects/agent-examples-…/env/prod/runs`**
(the seeder prints the exact URL). The panel opens from the chat button in the
page header. History persists per org and user; reopening the panel on a new
page starts a fresh chat, your old ones stay in History.

> If the health report says its telemetry is stale, re-run the seeder (the data
> aged out of the 1-hour window) or keep `--heartbeat` running.

---

## What you can ask

### "Is anything wrong?" — health

> How is prod doing? · Is anything wrong right now? · Why is the backlog growing?

The agent grounds these in the deterministic health report (`get_report`) — the
same numbers `/report health` gives you in the CLI — and renders the report card:
severity headline, metric grid with sparklines, what owns the problem, and a
line of actions. If the report says its own telemetry is stale, the agent will
tell you the numbers can't be trusted and won't give action advice off them.

### "Why did this fail?" — investigations

> Investigate run run_abc — why did it fail? · What's causing this error, and is
> it still happening?

The flagship flow. The agent gathers evidence (run, trace, error group, deploy
correlation), forms 2–4 falsifiable hypotheses, tests each with a targeted
check, and concludes on a card: **what happened** and **how to fix it**, every
claim cited back to the runs, spans, errors and deployments it read. If it can't
prove a cause it says so — an *inconclusive* card lists what was ruled out and
what to check next, and never invents a fix.

**Buttons, so you rarely type this yourself:** *Investigate* appears on a failed
run's error section, on an error group's page, and on backed-up queue rows;
*Why is this run waiting?* appears on a queued run (backed by a deterministic
queue diagnosis — depth, throughput, limiting cause, drain estimate).

When the project has a connected GitHub repo, investigations read your actual
source at the run's deployed commit and cite `file:line`. If the deploy was
built with uncommitted changes, the agent says its source view is the nearest
repository snapshot — not the exact deployed code.

### "Show me…" — navigation

> Show me failed runs from the last 24 hours · Take me to the email-sends queue

The agent navigates the dashboard for you — the runs list with the right
filters applied, a specific run, error, queue or deployment.

### "What / how many…" — data questions

> How many runs failed yesterday, by task? · Chart failures per hour for the
> last day · What's the p95 duration of send-order-receipt?

Backed by TRQL (our analytics query language) over your run data; results can
render as live charts in the chat.

### "What changed?" — deploys

> What's deployed right now? · What commit is this run running? · Did the
> failures start after the last deploy?

`correlate_version` ties a run to its exact commit, PR and deploy — the agent
uses it to check "did a deploy cause this?" during investigations too.

### "How do I…?" — product knowledge

> How do retries work? · How do I set a concurrency limit? · How do I use
> batchTrigger?

Answered from the Trigger.dev docs with source links under the answer.

---

## The example conversations

The seeded playground ships 14 real conversations in the panel's History —
open any of them to see the flows without spending a token. Highlights:

| Open | What it shows |
| --- | --- |
| **send-order-receipt failure** | A full investigation: 4 tool calls, a concluded card with 4 tested hypotheses, cited evidence, a follow-up question answered |
| **Intermittent upstream timeouts** | The honest ending — inconclusive, no invented fix, concrete next checks |
| **Failure after yesterday's deploy** | Deploy correlation + the uncommitted-changes caveat |
| **Is anything wrong right now?** | The degraded health report card — pinned concurrency, growing backlog, "not your code" |
| **How is prod doing?** | The healthy report card |
| **Failed runs in the last 24h** | Navigation + a live chart |
| **Show me the failing code** | A proposed fix as a diff, cited to file:line at the deployed commit |
| **How do I use batchTrigger?** | A docs answer with sources |

The live data behind them is real: click through any cited run, error, queue or
deployment. Try clicking **Investigate on the failed `send-order-receipt` run**
for a fresh, live investigation.

There's also a component gallery at `/storybook/agent-ui` (admin only): every
card in every state, with light/dark toggles.

## What the agent will not do

- **Write anything.** No retries, no cancels, no config changes — it points you
  at the right page instead. (Safe, approval-gated actions are on the roadmap.)
- **Invent numbers or IDs.** Every figure comes from a tool call; if a page of
  results was truncated, it won't claim something *doesn't* exist beyond it.
- **Trust stale data.** A report whose telemetry is stale is presented as
  informational only.

## Coming next

**Watches** — "tell me when the backlog drains", "ping me if this error comes
back": durable conditions the platform checks on a schedule (no LLM involved)
that wake the conversation with the answer when they fire. In development now;
this guide gets a second edition when it ships.

---

Feedback → #dashboard-agent-feedback, or just tell the agent — every
conversation is evaluated and capability gaps are collected automatically.
