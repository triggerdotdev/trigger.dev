# Dashboard agent — guidebook

An AI assistant in a side panel on every dashboard page. It reads your runs,
errors, queues, deploys and health through the same APIs you use, answers in
place, renders rich cards, and can keep watching things after the conversation
ends. Read-only by design: the only things it ever creates are its own watches
and, with your explicit yes, an email alert subscription.

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

**Watch** — a durable condition the platform checks on a schedule (no LLM in
the checks), which wakes the chat with the outcome. Ten kinds, listed below. It
answers **once**, then stops.

**Alerts** — when a watch is created (or fires) without a subscription, the
agent offers an email alert — one line, created only if you say yes. Standing
subscription on the standard alert channels: shows up on the project's Alerts
page, fires for every watch fire, one-click unsubscribe in every email.

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

Without access the panel provider is never mounted, so every Investigate and
Watch button returns `null` on its own — callers need no gate of their own
(`InvestigateButton.tsx`, `WatchButton.tsx`).

Scheduling a watch needs one more thing: `DASHBOARD_AGENT_SECRET_KEY`. Without
it creation refuses with "The dashboard agent is not configured, so watches
can't be scheduled." (`isDashboardAgentConfigured`, `dashboardAgent.server.ts`).
The same gate stops the sweep delivering wakes — it still finalizes the rows.

---

## Where the buttons are

Two separate mechanisms, decided differently.

### Buttons on the page itself

| Page | Button | Shown when |
| --- | --- | --- |
| Queue | Investigate | the queue is degraded (see below) |
| Queue | Watch… | the queue is not paused |
| Error group | Investigate this error | always |
| Error group | Watch… | always |
| Run (span panel) | Watch… | the run is not in a final status |
| Run (span panel) | Investigate | the run has an error block **and** a failed status |
| Run, waiting block | Investigate | whenever that block is on screen, which is what "still waiting" means |
| Report card, *Next steps* | Watch recovery | the report is `health` and its severity is `warn` or `crit` |

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
head-of-line wait passes 5 minutes, never from saturation. A queue full of runs
with nothing executing shows only `Watch…`.

**What the queue's Watch button pre-fills** (`watch-recommendations.ts`): the
oldest wait `>= 5 min` gives `backlog_drain`; anything else, including an
unknown wait, gives `queue_oldest_age` at 5 minutes. A watch is for what happens
next — offering the SLA watch when the SLA is already breached would one-shot
instead of watching.

The other pre-fills: error group → `error_recurrence`, 5 min / 6 h; run panel →
`run_finished`, 1 min / 1 h; report card → `health_recovery` carrying the
current severity as `fromSeverity`, 5 min / 6 h.

### Chips in the agent panel

An empty chat offers up to five. They come from *two* places, resolved into the
same slots.

*The page registry* (`suggested-prompts/page-prompts.ts`) answers by page kind
and its fields. Only `error` and `queue` contribute a watch chip:

| Page kind | Chip | Offered when |
| --- | --- | --- |
| `queue` | investigate | not paused **and** health is `warn` or `crit` |
| `queue` | watch | not paused |
| `error` | investigate, watch | always |
| `run` | investigate | always |

A backed-up queue therefore offers **both** chips. A paused queue offers
neither: its computed health is `warn` (paused counts), so the registry carries
its own `paused` guard on top of health.

*The page's live signals* (`suggested-prompts/signal-prompts.ts`) — the complete
list:

| Signal | Chip slot |
| --- | --- |
| `fresh_failure` | investigate |
| `slow_run` | investigate |
| `waiting_run` | watch |
| `concurrency_saturation` | watch |

`concurrency_saturation` is raised only when the queue is at capacity **and**
not paused (`page-mappers.ts`), using the same `isQueueAtCapacity` guard, so the
zero-limit rule holds here too.

**How five are picked** (`suggested-prompts/resolver.ts`): slots are
`promoted, investigate, watch, status, explain, docs`; each slot takes the first
non-dismissed candidate, signals before the page-kind default, so at most one
chip per slot. Over the cap of five, whole slots are dropped in the order
`status, watch, investigate` — `promoted`, `explain` and `docs` never yield.

---

## The ten watch kinds, and what makes each fire

The spec union is `internal-packages/dashboard-agent-contracts/src/watch.ts`.
Every check is deterministic and runs without an LLM.

A check returns one of four results, and only two of them are verdicts:

| Result | Meaning |
| --- | --- |
| `satisfied` | the condition is true now |
| `terminal_unsatisfied` | it can never become true, so stop checking |
| `pending` | not true yet; keep checking |
| `unavailable` | the check itself couldn't run — never true, never false |

### Run conditions — `dashboardAgentWatchRunChecks.ts`

All three read one run row, scoped to the watch's environment.

| Kind | Satisfied when | Impossible when |
| --- | --- | --- |
| `run_start` | `startedAt` is set, whatever the current status | the run reached a final status without ever starting, or the row is gone |
| `run_finished` | the status is any final status — including cancelled and failed | the row is gone |
| `run_failed` | the status is a final **failing** one | the run completed successfully or was cancelled, or the row is gone |

The failing set is `COMPLETED_WITH_ERRORS`, `SYSTEM_FAILURE`, `CRASHED`,
`EXPIRED`, `TIMED_OUT`, `INTERRUPTED`. `CANCELED` is neither a success nor a
failure and gets its own presentation.

`run_finished` fires on a failure too — the resolution alone can't tell the two
apart, so the observed final status decides the headline: a failed run reads
"Run x failed" in error tone, a cancelled one reads neutrally.

`run_failed` on a successful run resolves *impossible*, and that is presented as
good news — "Run x succeeded" — not as an error.

### Queue conditions — `dashboardAgentWatchQueueChecks.ts`

| Kind | Satisfied when |
| --- | --- |
| `backlog_drain` | the current pending depth is `0` |
| `queue_depth_above` | depth `> threshold` |
| `queue_depth_below` | depth `<= threshold` |
| `queue_stalled` | depth `> 0` and the depth failed to decrease for `ticks` consecutive checks |
| `queue_oldest_age` | the oldest still-waiting run has waited `> thresholdMinutes` |

For all five, the **only** impossible outcome is the queue no longer existing. A
live queue is never impossible, however far it is from the threshold.

**The freshness fence.** Depth comes from the live queue counter; if that read
fails, from the newest 60-second ClickHouse bucket, which counts as current only
if its end is within 60 s of now (`dashboardAgentWatchChecks.server.ts`). A
non-current reading at or below the *quiet line* is refused as `unavailable`
rather than believed — the quiet line is `0` for drain and stall, and the
threshold for the two depth kinds. A stale empty bucket is never read as
drained. `queue_stalled` is stricter still: it refuses **any** non-current
reading, because a phantom sample would enter the streak as if it had been
observed now.

**The stall streak** is the one piece of state, carried in the previous check's
facts. `ticks` defaults to 3 (min 2, max 12) and is not offered by the card. The
first check has nothing to compare against, so it scores 0; each later check
whose depth is `>= the previous` adds one; a depth of `0` resets it; a check
that couldn't read a current depth *freezes* it rather than breaking it. With
the default of 3 and the 5-minute cadence floor, the earliest a stall can fire
is the fourth check.

**Oldest age** takes the worst wait across concurrency keys with a live backlog
(capped at 50 keys), falling back to the queue's oldest message. If either read
fails the whole reading is `unavailable` — a partial read would under-report the
wait and silently miss the SLA. Nothing waiting is `pending`, and is only
terminal if the queue is also gone.

### `error_recurrence` — `dashboardAgentWatchErrorChecks.ts`

Satisfied on the first occurrence proven to be after `since`. `since` is
**server-set when the row is persisted** and is deliberately absent from the
spec, so nothing can backdate the window: an occurrence written before the watch
existed is invisible to it.

The proof is `errors_v1`'s `last_seen` at millisecond precision, because the
per-minute rollup can't separate the prompting error from a recurrence in the
same minute. The rollup then supplies the count, which is a lower bound when the
creation minute itself has hits.

A fingerprint never seen in the environment is `pending`, not impossible. This
kind has no terminal outcome of its own.

### `health_recovery` — `dashboardAgentWatchHealthChecks.ts`

Satisfied only when the health report is **trustworthy and `ok`**. An
untrustworthy report is `pending` and records no severity — it is not an
observation. A report that can't be produced or carries an unknown severity is
`unavailable`.

### When a check throws

Any exception inside any check is caught in one place (`checkWatch`) and becomes
`unavailable` with an unverified observation. A check failure is never a verdict.

---

## From a check to an answer

`watchResolutionForCheck` (`watch.ts`) turns the result into a resolution:

| Result | Before the deadline | On the deadline |
| --- | --- | --- |
| `satisfied` | `condition_met` | `condition_met` |
| `terminal_unsatisfied` | `condition_impossible` | `condition_impossible` |
| `pending` | keep checking | `window_completed` |
| `unavailable` | keep checking | `window_completed` |

A check landing exactly on the deadline can still fire or refuse — only an
unfinished or unreadable one becomes a completed window. The claimed row's
`expiresAt` decides that, not the clock the check ran on
(`watch-lifecycle.ts`).

**A completed window is an answer, not a failure.** Whether it is good or bad
news is declared per kind, never inferred:

| Kind | `condition_met` | `window_completed` |
| --- | --- | --- |
| `run_start` | good — started | attention — hasn't started yet |
| `run_finished` | good, unless the final status was a failure | attention — still running |
| `run_failed` | attention — failed | **good** — hasn't failed |
| `backlog_drain` | good — drained | attention — still hasn't drained |
| `queue_depth_above` | attention — above the threshold | **good** — stayed below |
| `queue_depth_below` | good — back below | attention — still above |
| `queue_stalled` | attention — stuck | **good** — kept moving |
| `queue_oldest_age` | attention — over the SLA | **good** — stayed under |
| `error_recurrence` | attention — happened again | **good** — stayed quiet |
| `health_recovery` | good — recovered | attention — hasn't recovered |

`condition_impossible` is neutral for every kind, with two refinements: a
`run_failed` watch on a run that succeeded reads as good news, and on a
cancelled run as neutral.

One rule overrides the whole table: if the window completed on an **unverified**
observation, the answer is neutral and says only "The watch ended without a
confirmed answer" — an unreadable source is never reported as "it didn't
happen".

The final English lives in one place,
`dashboard-agent-contracts/src/watch-wording.ts`, and the card, banner, toast,
email, Slack message, webhook and the agent's own narration all read it. Numbers
come from the frozen observation, never a fresh read, so a retry produces the
same sentence.

### Which wakes cost a model call

`planWatchNarration` (`watch-narration.ts`):

- a consented investigation → Sonnet, with the conversation, so the promise and
  the findings read as one voice;
- any other **attention** outcome → Haiku, given the wake alone;
- everything else, good or merely factual → **no model call at all**; the
  sentence is composed from the contracts' wording.

---

## Creating a watch

`createDashboardAgentWatch` (`apps/webapp/app/services/dashboardAgentWatches.server.ts`).
The order is load-bearing.

1. **Not configured** → "The dashboard agent is not configured, so watches can't
   be scheduled."
2. **The target must exist in this environment** → otherwise "That target
   doesn't exist in this environment." Run kinds need the run row, queue kinds
   the queue row, `health_recovery` a known report key. `error_recurrence`
   validates only that the fingerprint is non-empty: zero occurrences so far is
   the normal case. These reads go to the **primary**, so a run or queue created
   a moment ago is visible; the polling checks use the replica.
3. **Duplicate** → "This chat is already watching that." The identity is the
   kind plus its target, with the threshold folded in for the two depth kinds
   and the SLA for `queue_oldest_age`; cadence, window, note and `ticks` are
   deliberately **not** part of it. It is unique across `(chat, project,
   environment)` among **active** rows only, enforced by a partial unique index
   rather than by the read-then-insert check — two different chats may watch the
   same thing.
4. **Cap** → "This chat already has 3 active watches. Cancel one first." The
   count is over every active watch on the chat, whatever project or environment
   it points at.
5. **The immediate check**, run before any row is written:
   - `satisfied` → "That already happened, so there's nothing left to watch."
   - `terminal_unsatisfied` → "That can't happen any more, so there's nothing to
     watch."
   In both cases **no row is created** — no chip, no wake, nothing to cancel.
   The check *is* the delivery, so the answer you get is the answer.
   - `unavailable` → the watch **is** created, and the confirmation says so:
     "We couldn't check that just now. Watching anyway."
6. **The first tick must schedule.** If it can't, the row is cancelled — not
   resolved, because the condition was never evaluated — and cancellation is
   silent, so no wake is sent: "The watch couldn't be scheduled. Nothing is
   being watched."

## Cadence, window and expiry

| | Options |
| --- | --- |
| Cadence, run kinds | 1, 5, 15 or 60 minutes |
| Cadence, everything else | 5, 15 or 60 minutes — 5 is the floor for aggregates |
| Window | 30 min, 1, 2, 6, 12 or 24 hours |

The ceiling is 24 hours and the schema enforces both. A watch schedules its own
next check — no cron polls for due watches — so the first answer lands one cadence
after you confirm the card. `expiresAt` is creation time plus the window.

Due watches of one `(environment, cadence)` group can instead be checked
together in one pass (`dashboardAgentWatchBatch.server.ts`). Every per-watch
check arms that group's chain and is told whether it is running; if it is, the
watch hands over and its own chain stops rescheduling, because the group now
reschedules once for everyone. A tick arriving slightly early still counts as
due, by up to half a cadence and at most 30 seconds, and a watch whose deadline
falls within one cadence is always due, so the final evaluation is never missed.
The group's chain stops only when nothing is active **and** nothing is owed.

A check that came back `unavailable` in a batch is recorded as an attempt rather
than as a check, so the stall streak and the last-checked time survive it. If the
batch check itself can't be read, nothing was looked at, so nothing is recorded —
and the chain still reschedules, so the group keeps its cadence.

A sweep (`dashboardAgentWatchSweep.server.ts`) is the backstop:

- a row still active **2 minutes** past `expiresAt` is finalized;
- a resolved row whose wake is still owed **5 minutes** later is redelivered —
  the sweep can't tell whether the user was already told, so delivery is
  id-deduped rather than conditional.

The agent project runs two scheduled tasks of its own: `dashboard-agent-investigation-sweep`
every 5 minutes settles cards left `in_progress` past **30 minutes**
(`investigation-sweep.ts`), and `dashboard-agent-maintenance` at 03:00 UTC daily is
retention (`maintenance.ts`) — judged turns and soft-deleted chats past **30
days**, terminal watches and their submission ledger past **7 days** — a purged
watch outcome still lives in the transcript. Retention connects with
`DASHBOARD_AGENT_DATABASE_URL`, falling back to `DATABASE_URL`, like the watch
and sweep tasks, and skips only when neither is set.

The sweep re-authorizes each row before reading anything, and carries the
previous check's facts into the final evaluation, so a stall streak survives the
boundary. It finalizes overdue rows even when the agent isn't configured to
deliver — otherwise they would stay active forever — and leaves the wake owed.

## What ends a watch without an answer

A watch reaches `fired` or `expired` by resolving, and both deliver a wake.
**Cancellation is the ending without an answer: no resolution and never a wake.**
The five reasons (`watch-schema.ts`):

| Reason | When |
| --- | --- |
| `user` | the chip's cancel, scoped through the chat: the watch must belong to that chat and the chat to this user in this org. A no-op if it already resolved |
| | Alone among the reasons, it leaves one neutral line in the transcript ("Stopped watching …"), keyed off the watch id so a retry can't repeat it. Still no wake, no delivery |
| `chat_deleted` | deleting a chat cancels its watches in the same transaction, so live watches can't outlive a chat the user can no longer see |
| `access_revoked` | the creator's access no longer holds — checked before any read |
| `scheduling_failed` | the first tick couldn't be scheduled |
| `superseded` | a concurrent submission recorded a different outcome, so the orphan row is cancelled before the replay |

**Access is re-authorized on every check, on the primary** — replica lag would
extend access the user has already lost. It requires the row's frozen project
and organization to still match, the environment not archived, the project and
org not deleted, membership to still exist, a development environment to still
belong to this user, and `canAccessDashboardAgent` to still pass. Any partial
pass is a full revoke.

A watch that has already fired is **not** cancelled when its creator loses
access — it is terminal already. It just gets no alert.

## The two follow-ups

They are independent opt-ins, never a radio group. In-chat delivery is always on
and is not one of them.

**Investigate attention outcomes.** An investigation opens only when the
resolved outcome's category is `attention`, per the table above — both the
webapp's kick (`watchWantsInvestigation`) and the agent's own wake call the same
contracts function, so the two can't disagree. Good news and neutral news never
start one, however the watch was configured. Two consequences worth stating:
every `condition_impossible` is neutral, so an impossible watch never
investigates; and a window that completed on an unverified observation is
neutral too, so an unreadable source never starts one either.

The kick is best-effort and happens only after the wake is in the transcript:
the wake is the delivery that matters, and a failed kick never retries or
invalidates it.

**Email me as well.** Attached only when the box is ticked, only after the watch
exists, and never able to fail creation. It goes to the user's own account
email, never an address from the request.

Two gates, and **neither is a plan check** — billing gates that separately:

- the same agent-access gate as everything else;
- an email transport must be configured (`ALERT_FROM_EMAIL` and
  `ALERT_EMAIL_TRANSPORT`).

When either refuses, the card reports the subscription as `unavailable` and says
"I couldn't add email notifications, so updates will appear in the dashboard
only." The watch still runs, and that outcome is frozen on the ledger row and
replayed on a retry rather than decided again — the confirmation in the
transcript is append-once, so a second decision would contradict it forever.

**Only a fired watch emails.** An expiry is narrated in the chat and nothing
else. The access gate is re-checked at delivery time as well as at subscribe
time, so a revoked flag stops the mail without anyone cleaning up channels.

## What it will not do

- Write anything beyond its own watches and an alert you explicitly approved.
- Invent numbers or claim something doesn't exist beyond a truncated page.
- Trust a report whose telemetry is stale.
- Report an unreadable source as a negative answer.

Feedback → #dashboard-agent-feedback, or just tell the agent — a sample of turns
is scored automatically and capability gaps are collected from it (a tenth by
default, none for a turn that read source, none for an org that opted out; see
[README.md](./README.md#turn-evals)).
