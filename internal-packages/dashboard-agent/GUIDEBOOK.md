# Dashboard agent — guidebook

An AI assistant in a side panel on every dashboard page. It reads your runs,
errors, queues, deploys and health through the same APIs you use, answers in
place, and renders rich cards. Read-only by design: the only thing it ever
creates is an alert you explicitly approved.

Branch: `feat/dashboard-agent-flows`.

This is a reference of **conditions**: what makes each thing happen, and where
that is decided. It is written so you can predict the behaviour without running
anything.

---

## What the agent does

**Ask about your project** — runs, errors, queues, tasks, deploys, health.
Every number comes from a tool call; it never invents ids or figures.

**Investigate** (flagship) — "why did this run fail?", "investigate this
error". It gathers evidence, poses falsifiable hypotheses, tests them, and
concludes on a live card with cited evidence — or says honestly that it's
inconclusive and what to check next. With a connected GitHub repo it reads your
actual source at the deployed commit and cites file:line.

**Reports** — "is anything wrong right now?" renders the deterministic health
report as a card: severity, metric grid with sparklines, who owns the problem,
and a *Next steps* row of buttons. Stale telemetry is flagged and never trusted
for advice.

**Navigate & query** — filtered page navigation, TRQL data questions with live
charts, deploy correlation, docs answers with source links.

Every card in every state is browsable at `/storybook/agent-ui` (admin only),
with no LLM and no data.

---

## When the agent is available at all

`canAccessDashboardAgent` (`apps/webapp/app/v3/canAccessDashboardAgent.server.ts`)
grants access when either holds:

- the viewer is an admin or impersonating **and** `DASHBOARD_AGENT_ADMIN_PREVIEW=1`;
- the `hasDashboardAgentAccess` feature flag resolves true for the org, whose
  default is `DASHBOARD_AGENT_ENABLED=1`.

Without access the panel provider is never mounted, so every Investigate
button returns `null` on its own — callers need no gate of their own
(`InvestigateButton.tsx`).

### One more switch

**Message quota, off by default.** `isDashboardAgentQuotaEnabled`
(`dashboardAgentQuota.server.ts`) reads `DASHBOARD_AGENT_QUOTA_ENABLED`. Off
means the quota is never checked, never recorded, and the user never sees a
cap notice — every turn resolves unlimited.

---

## Where the buttons are

Two separate mechanisms, decided differently.

### Buttons on the page itself

| Page | Button | Shown when |
| --- | --- | --- |
| Queue | Investigate | the queue is degraded (see below) |
| Error group | Investigate this error | always |
| Run (span panel) | Investigate | the run has an error block **and** a failed status |
| Run, waiting block | Investigate | whenever that block is on screen, which is what "still waiting" means |

**Degraded**, for the Investigate button, is `isQueueDegraded`
(`apps/webapp/app/components/queues/queue-thresholds.ts`) — one predicate now
shared by the queue detail page, the queues list badge and the agent's page
mapper:

1. a paused queue is never degraded — paused is a state, not a fault;
2. otherwise it is degraded if it is **at capacity**: `running >= limit` with a
   non-empty queue, where `limit` is the queue's own concurrency limit else the
   environment's. A limit of `0`, `null` or `undefined` is **never** at
   capacity — zero capacity is not saturation, and `running >= 0` holds for
   every queue;
3. otherwise it is degraded if the oldest run has waited `>= 5 min`
   (`OLDEST_WAIT_WARNING_MS`).

So a zero-concurrency queue with a backlog shows Investigate only once its
head-of-line wait passes 5 minutes, never from saturation.

### Chips in the agent panel

An empty chat offers up to five. They come from *two* places, resolved into the
same slots. The `watch` slot is never filled, so a slot behind it takes its
place.

*The page registry* (`suggested-prompts/page-prompts.ts`) answers by page kind
and its fields:

| Page kind | Chip | Offered when |
| --- | --- | --- |
| `queue` | investigate | not paused **and** health is `warn` or `crit` |
| `error` | investigate | always |
| `run` | investigate | always |

A paused queue offers no chip: its computed health is `warn` (paused counts),
so the registry carries its own `paused` guard on top of health.

*The page's live signals* (`suggested-prompts/signal-prompts.ts`) — those that
fill a chip:

| Signal | Chip slot |
| --- | --- |
| `fresh_failure` | investigate |
| `slow_run` | investigate |

**How five are picked** (`suggested-prompts/resolver.ts`): slots are
`promoted, investigate, watch, status, explain, docs`; each slot takes the first
non-dismissed candidate, signals before the page-kind default, so at most one
chip per slot. Over the cap of five, whole slots are dropped in the order
`status, watch, investigate` — `promoted`, `explain` and `docs` never yield.

---

## What it will not do

- Write anything beyond an alert you explicitly approved.
- Invent numbers or claim something doesn't exist beyond a truncated page.
- Trust a report whose telemetry is stale.
- Report an unreadable source as a negative answer.

Feedback → #dashboard-agent-feedback, or just tell the agent — a sample of turns
is scored automatically and capability gaps are collected from it (a tenth by
default, none for a turn that read source, none for an org that opted out; see
[README.md](./README.md#turn-evals)).
