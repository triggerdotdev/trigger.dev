# Dashboard agent — guidebook

An AI assistant in a side panel on every dashboard page. It reads your runs,
errors, queues, deploys and health through the same APIs you use, answers in
place, renders rich cards, and can keep watching things after the conversation
ends. Read-only by design: the only things it ever creates are its own watches
and, with your explicit yes, an email alert subscription.

Branch: `feat/dashboard-agent-flows`.

Read this top to bottom once. It covers what the agent does, how to run it
locally, and how to make every flow happen on demand.

---

## What the agent does

**Ask about your project** — runs, errors, queues, tasks, deploys, health.
Every number comes from a tool call; it never invents ids or figures.

**Investigate** (flagship) — "why did this run fail?", "investigate this
error". It gathers evidence, poses falsifiable hypotheses, tests them, and
concludes on a live card with cited evidence — or says honestly that it's
inconclusive and what to check next. *Investigate* buttons appear on failed
runs, error pages, and backed-up queues. With a connected GitHub repo it reads
your actual source at the deployed commit and cites file:line.

**Watch** — "tell me when this run starts", "ping me if this error comes
back", the *Watch recovery* button on a degraded health report. A durable
condition the platform checks on a schedule (no LLM in the checks), which
wakes the chat with the outcome. Fires once, expires within 24h, max 3 per
chat. Five kinds: run start / run finished / backlog drain / error recurrence
/ health recovery.

**Alerts** — when a watch is created (or fires) without a subscription, the
agent offers an email alert — one line, created only if you say yes. Standing
subscription on the standard alert channels: shows up on the project's Alerts
page, fires for every watch fire, one-click unsubscribe in every email. Ask
"what alerts do I have?" / "turn off the email alert" — the agent manages
them. Plan/flag gated; the in-dashboard notification is always on.

**Reports** — "is anything wrong right now?" renders the deterministic health
report as a card: severity, metric grid with sparklines, who owns the problem,
and a *Next steps* row of buttons. Stale telemetry is flagged and never
trusted for advice.

**Navigate & query** — "show me failed runs from the last 24h" (opens the
filtered page), TRQL data questions with live charts, deploy correlation
("did the last deploy cause this?"), docs answers with source links.

### Where the UI got updates

- **Chat button (page header)** — unread dot when a watch woke a chat you
  haven't read.
- **Persistent toast** — a wake while you're anywhere in the dashboard raises
  a notification that stays until you close it.
- **Chat history** — unread chats first and highlighted; per-chat status icon
  left of the title (spinner = agent working / watch active, magnifier =
  investigation in progress; hover for which).
- **In the transcript** — a watch's result opens with a banner that states the
  fact ("email-sends queue drained", "Run abc123 failed", "Health recovered"),
  toned by what happened rather than by which kind of watch it was; watch chips
  under the composer show live watches with cancel; clicking a card's watch
  button posts a visible request the agent answers.
- **Report cards** — terminal-style skin, metric grid with sparklines, *Next
  steps* footer with real buttons.
- **Alerts page** — the new "Dashboard agent watches" alert type on standard
  channels (email / Slack / webhook).
- **Suggested prompts** — an empty chat offers up to five, picked from where
  you are: a promoted one, *Investigate* for the failure on screen, a watch for
  the thing in front of you, an explain-this-page one, and a docs one.

Every card in every state is also browsable at `/storybook/agent-ui` (admin
only), with no LLM and no data.

### Where the buttons are

Two separate mechanisms, decided differently — worth knowing before a demo.

**Buttons on the page itself.** Every one of them hides when the agent is off.

| Page | Button | Shown when |
| --- | --- | --- |
| Queue | Investigate | the queue is degraded: not paused, and either `running >= concurrencyLimit` with a non-empty queue, or the oldest run has waited >= 5 min |
| Queue | Watch… | unless the queue is paused — a paused queue can neither drain nor grow |
| Error group | Investigate this error | always |
| Error group | Watch… | always |
| Run (span panel) | Watch… | while the run is not in a final status |
| Run (span panel) | Investigate | the run failed — next to the error block |
| Run, waiting block | Investigate | whenever that block is on screen, which is what "still waiting" means |

So a queue full of runs shows only `Watch…` until something is actually
executing or waiting too long — filling a queue with nothing to run it does not
make the page degraded.

**Chips in the agent panel.** An empty chat offers up to five. They come from
*two* places, decided separately — closing one does not close the other:

*The page registry* (`suggested-prompts/page-prompts.ts`) answers by page kind
and its fields: the queue page's "why is this backed up?" and "tell me when the
backlog drains" live here, gated on health and on `paused`.

*The page's live signals* (`suggested-prompts/signal-prompts.ts`) answer by what
is happening on screen right now:

| Signal | Chip slot |
| --- | --- |
| `fresh_failure` | investigate |
| `slow_run` | investigate |
| `waiting_run` | watch |
| `concurrency_saturation` | watch |

A backed-up queue therefore offers "tell me when the backlog drains", never
"investigate" — the page's own Investigate button is the one that asks that. A
paused queue offers neither, in either place.

So there are three sources, not two: the route's own buttons, the page registry,
and the live signals. They look identical on screen and are decided in three
different files — which is exactly how a rule gets fixed in one and left in the
other two.

---

## Prerequisites

```bash
pnpm i
pnpm run docker
pnpm run db:migrate
pnpm run db:seed
pnpm --filter @internal/dashboard-agent-db run db:migrate
```

`apps/webapp/.env` needs:

- `DASHBOARD_AGENT_ENABLED=1` (or `DASHBOARD_AGENT_ADMIN_PREVIEW=1`)
- `ANTHROPIC_API_KEY`
- `DASHBOARD_AGENT_SECRET_KEY=<a dev env key of the trigger project the agent
  task runs in>`

`internal-packages/dashboard-agent/.env` needs `ANTHROPIC_API_KEY` and
`DATABASE_URL`.

**Export `ANTHROPIC_API_KEY` in your shell too.** Not just in the `.env` files
— the agent's turns *and* the wake narration are LLM calls, and without the key
a watch fires silently: the row resolves, the banner never arrives. It is the
single most common reason a scenario looks broken.

Optional, for email alerts:

```bash
docker run -d --name mailpit -p 8025:8025 -p 1025:1025 axllent/mailpit
# then in .env: ALERT_EMAIL_TRANSPORT=smtp, ALERT_FROM_EMAIL=agent@localhost.test,
# ALERT_SMTP_HOST=localhost, ALERT_SMTP_PORT=1025, ALERT_SMTP_SECURE=0
```

## Running it locally

Two long-running processes, in this order:

```bash
pnpm run dev --filter webapp                                     # first
cd internal-packages/dashboard-agent && pnpm exec trigger dev     # then this
```

> Order matters: if you restart the webapp, restart `trigger dev` after it —
> otherwise new chat turns hang unpicked.

Open any project in the dashboard; the chat button is in the page header. Emails
land in Mailpit at http://localhost:8025.

Use a project of your own — the agent works against whatever local project you
point it at. `pnpm run db:seed` gives you the References org and its
`hello-world` project if you don't have one.

---

## The scenario kit

One command per thing a watch can see happen, so proving a flow locally is a
verb rather than hand-run Redis and ClickHouse surgery:
`apps/webapp/seed-watch-scenarios.mts`.

```bash
pnpm --filter webapp run scenarios:watch -- --help
```

It targets any local project and environment, is idempotent, wipes nothing, and
prints the next dashboard step itself. Node 20 is the version it is run on.

Every command takes `--project <ref-or-slug>` and `--env <dev|staging|prod|slug>`
(default `dev`). The walkthroughs below assume a shell alias so the flags aren't
repeated:

```bash
alias kit='pnpm --filter webapp run scenarios:watch -- --project my-app --env dev'
```

Verbs: `queue:fill`, `queue:grow`, `queue:drain`, `error:recur`, `run:fail`,
`run:succeed`, `health:degrade`, `health:recover`.

Queue verbs need a queue that exists in that environment — the kit lists the
ones it found if you name a queue it can't see. `email-sends` below is a
placeholder for one of yours.

### The two tasks the run scenarios need

The run verbs trigger a real task through the public API, so a `trigger dev` has
to be running for the project you target. Put this in its `src/trigger/`:

```ts
import { task, wait } from "@trigger.dev/sdk";

/** Sleeps, then throws — for the run-failed watch and its auto-investigation. */
export const slowFail = task({
  id: "slow-fail",
  retry: { maxAttempts: 1 },
  run: async (payload: { seconds?: number }) => {
    await wait.for({ seconds: payload.seconds ?? 60 });
    throw new Error("slow-fail failed on purpose");
  },
});

/** Sleeps, then succeeds — for the run-finished and condition-impossible cases. */
export const slowSucceed = task({
  id: "slow-succeed",
  retry: { maxAttempts: 1 },
  run: async (payload: { seconds?: number }) => {
    await wait.for({ seconds: payload.seconds ?? 60 });
    return { ok: true };
  },
});
```

`retry.maxAttempts: 1` matters: with retries on, the run stays alive through
several attempts and the watch's window can run out before the final failure.
Already have equivalents? Pass `--task <id>` instead.

### How to read the timings

A watch schedules its own next check — there is no shared cron. The first check
lands one cadence after you confirm the card:

| Cadence | Kinds | First answer |
| --- | --- | --- |
| every minute | run watches only | ~1 min |
| every 5 min (the floor for aggregates) | queue, error, health | ~5 min |

Windows on offer: 30 min, 1, 2, 6, 12, 24 hours. A watch answers **once**, then
stops. Three active watches per chat, max.

Every scenario below is the same three beats: **command → clicks → what
arrives.**

---

## 1. A queue drains

```bash
kit queue:fill email-sends 400
```

**Clicks.** Queues → `email-sends` → **Watch…** → **Customize** → under **Tell
me** pick **when it drains** → **Checking** `every 5 min` → **For** `1 hour` →
**Watch**.

**Confirmation.** "Watching email-sends until the queue drains." plus "Checking
every 5 min for up to 1 hour. It reports once, then stops." A chip labelled
`email-sends` appears above the composer.

```bash
kit queue:drain email-sends
```

**What arrives (≤5 min).** A persistent toast titled **email-sends queue
drained** with an **Open chat** button; a dot on the chat button; in the
transcript a banner labelled `WATCH UPDATE` with the same headline, the watch's
note underneath, and the agent's one-line narration.

Order matters: drain first and the watch one-shots (§10).

## 2. A queue grows above N

```bash
kit queue:fill email-sends 50
```

**Clicks.** Queues → `email-sends` → **Watch…** → **Customize** → **if it
grows** → **Above** `100` → **Watch**.

```bash
kit queue:grow email-sends 400
```

**What arrives (≤5 min).** "email-sends queue is still above 100" — the fact,
not the threshold. (`queue:grow` is `queue:fill` under another name; the verb
exists so the command reads like the watch.)

## 3. A queue comes back below N

```bash
kit queue:fill email-sends 400
```

**Clicks.** **Watch…** → **Customize** → **when it's back below** → **Below**
`100` → **Watch**.

```bash
kit queue:fill email-sends 40
```

**What arrives (≤5 min).** "email-sends queue is back below 100."

## 4. A queue stops moving

```bash
kit queue:fill email-sends 400
```

**Clicks.** **Watch…** → **Customize** → **if it stops moving** → **Watch**.
Then leave the queue alone — no further command.

**What arrives (~20 min).** "email-sends queue is stuck at 400."

Why 20 minutes: the condition is a streak of three checks whose depth never
dropped, the first check has nothing to compare against, and the cadence floor
is 5 minutes. A check that can't read a current depth freezes the streak instead
of breaking it, so a stalled ClickHouse won't produce a false answer — and won't
produce a true one either.

## 5. Runs wait longer than the SLA

```bash
kit queue:fill email-sends 400 --age-min 30
```

`--age-min` backdates the oldest queued run, which is the number this condition
reads.

**Clicks.** **Watch…** → **Customize** → **if runs wait too long** → **Waiting
longer than** `5` minutes → **Watch**.

**What arrives (≤5 min).** "runs in email-sends are waiting 30m (over your 5m
limit)."

The queue page's **Watch…** button pre-fills this one at 5 minutes when the
queue looks healthy, and switches to *when it drains* when the wait is already
over the warning line — a watch is for what happens next, not for what already
did.

## 6. An error comes back

```bash
kit error:recur     # creates the error group the first time it runs
```

**Clicks.** Errors → the group the command named → **Watch…** → **Customize** →
**if it recurs** → **For** `6 hours` → **Watch**.

**Confirmation.** "Watching error c4b4a797397a9c43 in case it happens again."

```bash
kit error:recur     # again, now that the watch exists
```

**What arrives (≤5 min).** "Error c4b4a797397a9c43 happened again."

Arm the watch **between** the two commands. A recurrence watch stamps its start
when it is persisted and only counts occurrences after that moment, so an
occurrence written earlier is invisible to it.

## 7. The same error, investigated for you

Same as §6, but in **Customize**, under **When there's an answer**, tick
**Investigate attention outcomes** before confirming.

**Confirmation** gains a line: "If it turns out badly, I'll investigate straight
away."

**What arrives.** The wake, then — without you asking — an investigation card
that opens *in progress* ("Looking into why…") and resolves into a concluded
verdict with tested hypotheses and cited runs, spans and the deploy. Findings
land as their own message.

Only outcomes that need attention start an investigation. Good news and neutral
news never do — a watch that reports "stayed quiet" costs nothing.

## 8. A run finishes

```bash
kit run:succeed 120
```

**Clicks.** Open the run the command printed → **Watch…** → **Customize** →
**when it finishes** → **Checking** `every 1 min` → **Watch**.

**What arrives (~1-3 min).** "Run run_xxx finished."

## 9. A run fails, and gets investigated

```bash
kit run:fail 120
```

**Clicks.** Open the run → **Watch…** → **Customize** → **if it fails** → tick
**Investigate attention outcomes** → **Checking** `every 1 min` → **Watch**.

**What arrives (~1-3 min).** "Run run_xxx failed" — an error-toned banner and
toast — then the auto-conducted investigation, as in §7.

Same run, no watch: the **Investigate** button on the failed run does this on
demand. That's the flagship path; the watch is the same investigation, started
by the platform instead of by you.

## 10. It already happened (the one-shot)

```bash
kit queue:drain email-sends
```

**Clicks.** Queues → `email-sends` → **Watch…** → **when it drains** →
**Watch**.

**What arrives — immediately, no waiting.** "That already happened, so there's
nothing left to watch."

No watch row is created: no chip, no wake, nothing to cancel. Because the check
runs once before the row is written, the answer you get is the answer, not a
promise of one.

## 11. It can't happen any more (condition impossible)

```bash
kit run:succeed 30
```

**Clicks.** Open the run → **Watch…** → **if it fails** → **Watch**, twice
over:

- **Before** the run finishes: the watch is created, and when the run succeeds
  it resolves "Run run_xxx succeeded" — the honest answer to "tell me if it
  fails", not an error.
- **After** it has already succeeded: the immediate check refuses it — "That
  can't happen any more, so there's nothing to watch."

## 12. The window runs out

```bash
kit queue:fill email-sends 40
```

**Clicks.** **Watch…** → **Customize** → **if it grows** → **Above**
`1000000` → **For** `30 min` → **Watch**. Then do nothing.

**What arrives, at the end of the window.** "email-sends queue stayed below
1000000" — a *positive* result, toned as good news. A window running out is an
answer, not a failure. If the last check couldn't read the queue at all you get
"The watch ended without a confirmed answer" instead, which is the honest
version of the same thing.

## 13. Asking for a watch in words

Type, in any chat:

> set up a watch for that error

**What arrives.** A tool row labelled *Filling in a watch*, then the same watch
card, pre-filled, above the composer — the agent proposes, you confirm. Nothing
is created until you press **Watch**. One card at a time; a newer proposal
replaces an older one, and reopening the chat never re-opens it.

## 14. The offer at the end of an answer

Ask about an unresolved error:

> why is send-order-receipt failing?

**What arrives.** The answer ends with "Want me to set up a watch so you're told
if it hits again?" and a **Set up a watch** button. Clicking it posts a visible
request and opens the pre-filled card — same surface as §13.

## 15. Health degrades, then recovers

```bash
kit health:degrade
```

The first run also writes a 7-day calm baseline for that environment, so the
degradation has a normal to be measured against.

**Clicks.** Ask "is anything wrong right now?" → the report card comes back
**crit** → in its *Next steps* row, **Watch recovery** → **Watch**.

```bash
kit health:recover
```

**What arrives (≤5 min).** "Health recovered", green. If an email alert
subscription was accepted, the same headline lands in Mailpit
(http://localhost:8025).

Run `health:degrade` shortly before you look, not hours before: the report's
7-day baselines are cached in the dev server for 5 minutes, and a degradation
left standing ages into its own baseline and starts reading as normal.

---

## When a scenario looks broken

| Symptom | Cause |
| --- | --- |
| Watch resolves, no banner or toast | `ANTHROPIC_API_KEY` not exported — the narration is an LLM call |
| Turns hang unpicked | the webapp was restarted after `trigger dev`; restart `trigger dev` |
| "That already happened" | the state was changed before the watch was armed |
| A recurrence watch never fires | `error:recur` ran before the watch was created |
| "This chat is already watching that." | same condition, same environment — cancel the chip first |
| "This chat already has 3 active watches." | the per-chat cap; cancel one |
| A queue watch answers nothing | the queue's depth couldn't be read as current; an unreadable check is never a verdict |
| `queue:*` says the queue doesn't exist | wrong environment — pass `--env dev` |
| The report reads ok right after `health:degrade` | the baseline cache is 5 minutes stale; wait it out or re-run |

## What it will not do

- Write anything beyond its own watches and an alert you explicitly approved.
- Invent numbers or claim something doesn't exist beyond a truncated page.
- Trust a report whose telemetry is stale.

Feedback → #dashboard-agent-feedback, or just tell the agent — a sample of turns
is scored automatically and capability gaps are collected from it (a tenth by
default, none for a turn that read source, none for an org that opted out; see
[README.md](./README.md#turn-evals)).
