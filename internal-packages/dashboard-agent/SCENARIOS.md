# Watch & Investigate — scenario walkthroughs

Every Watch condition and both Investigate entry points, as a command plus the
clicks that go with it. Run these on a local env; nothing here needs staging.

The commands are the scenario kit, `apps/webapp/seed-watch-scenarios.mts`:

```bash
pnpm --filter webapp run scenarios:watch -- --help
```

It runs on top of the seeded `agent-examples` stand, is idempotent, wipes
nothing, and prints the next dashboard step itself.

---

## Prereqs

```bash
pnpm run docker
pnpm run db:migrate
pnpm run db:seed                                    # creates the References org + hello-world
pnpm --filter @internal/dashboard-agent-db run db:migrate
pnpm --filter webapp run db:seed:agent-examples     # the stand
```

`apps/webapp/.env` needs `DASHBOARD_AGENT_ENABLED=1`, `ANTHROPIC_API_KEY` and
`DASHBOARD_AGENT_SECRET_KEY=<a dev key of the project the agent task runs in>`.

**Export `ANTHROPIC_API_KEY`.** Not just in `.env` files — the agent's turns
*and* the wake narration are LLM calls, and without the key a watch fires
silently: the row resolves, the banner never arrives. It is the single most
common reason a scenario looks broken.

Three long-running processes, in this order:

```bash
pnpm run dev --filter webapp                                   # first
cd internal-packages/dashboard-agent && pnpm exec trigger dev --profile local
cd <references>/projects/hello-world && pnpm exec trigger dev --profile local
```

Restarting the webapp means restarting both `trigger dev`s, or new turns hang
unpicked. The hello-world one is only needed for the run scenarios.

### The two tasks the run scenarios need

They live in the references repo, which this monorepo can't ship. Put this in
`<references>/projects/hello-world/src/trigger/slowFail.ts`:

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

---

## How to read the timings

A watch schedules its own next check — there is no shared cron. The first check
lands one cadence after you confirm the card, so:

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
pnpm --filter webapp run scenarios:watch -- queue:fill email-sends 400
```

**Clicks.** Queues → `email-sends` → **Watch…** → **Customize** → under **Tell
me** pick **when it drains** → **Checking** `every 5 min` → **For** `1 hour` →
**Watch**.

**Confirmation.** "Watching email-sends until the queue drains." plus "Checking
every 5 min for up to 1 hour. It reports once, then stops." A chip labelled
`email-sends` appears above the composer.

```bash
pnpm --filter webapp run scenarios:watch -- queue:drain email-sends
```

**What arrives (≤5 min).** A persistent toast titled **email-sends queue
drained** with an **Open chat** button; a dot on the chat button; in the
transcript a banner labelled `WATCH UPDATE` with the same headline, the watch's
note underneath, and the agent's one-line narration.

Order matters: drain first and the watch one-shots (§10).

## 2. A queue grows above N

```bash
pnpm --filter webapp run scenarios:watch -- queue:fill email-sends 50
```

**Clicks.** Queues → `email-sends` → **Watch…** → **Customize** → **if it
grows** → **Above** `100` → **Watch**.

```bash
pnpm --filter webapp run scenarios:watch -- queue:grow email-sends 400
```

**What arrives (≤5 min).** "email-sends queue is still above 100" — the fact,
not the threshold. (`queue:grow` is `queue:fill` under another name; the verb
exists so the command reads like the watch.)

## 3. A queue comes back below N

```bash
pnpm --filter webapp run scenarios:watch -- queue:fill email-sends 400
```

**Clicks.** **Watch…** → **Customize** → **when it's back below** → **Below**
`100` → **Watch**.

```bash
pnpm --filter webapp run scenarios:watch -- queue:fill email-sends 40
```

**What arrives (≤5 min).** "email-sends queue is back below 100."

## 4. A queue stops moving

```bash
pnpm --filter webapp run scenarios:watch -- queue:fill email-sends 400
```

**Clicks.** **Watch…** → **Customize** → **if it stops moving** → **Watch**.
Then leave the queue alone — no further command.

**What arrives (~20 min).** "email-sends queue is stuck at 400."

Why 20 minutes: the condition is a streak of three checks whose depth never
dropped, the first check has nothing to compare against, and the cadence floor
is 5 minutes. The streak length isn't a field on the card. A check that can't
read a current depth freezes the streak instead of breaking it, so a stalled
ClickHouse won't produce a false answer — and won't produce a true one either.

## 5. Runs wait longer than the SLA

```bash
pnpm --filter webapp run scenarios:watch -- queue:fill email-sends 400 --age-min 30
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
# nothing to run first — the stand's 429 group is already there
```

**Clicks.** Errors → the `send-order-receipt` 429 group → **Watch…** →
**Customize** → **if it recurs** → **For** `6 hours` → **Watch**.

**Confirmation.** "Watching error c4b4a797 in case it happens again."

```bash
pnpm --filter webapp run scenarios:watch -- error:recur
```

**What arrives (≤5 min).** "Error c4b4a797 happened again."

Arm the watch **first**. A recurrence watch stamps its start when it is
persisted and only counts occurrences after that moment, so an occurrence
written earlier is invisible to it.

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
pnpm --filter webapp run scenarios:watch -- run:succeed 120
```

**Clicks.** In the **hello-world** project (dev), open the run the command
printed → **Watch…** → **Customize** → **when it finishes** → **Checking**
`every 1 min` → **Watch**.

**What arrives (~1-3 min).** "Run run_xxx finished."

## 9. A run fails, and gets investigated

```bash
pnpm --filter webapp run scenarios:watch -- run:fail 120
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
pnpm --filter webapp run scenarios:watch -- queue:drain email-sends
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
pnpm --filter webapp run scenarios:watch -- run:succeed 30
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
pnpm --filter webapp run scenarios:watch -- queue:fill email-sends 40
```

**Clicks.** **Watch…** → **Customize** → **if it grows** → **Above**
`1000000` → **For** `30 min` (or `1 hour`, if you have the patience) →
**Watch**. Then do nothing.

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

## 15. Health recovers

```bash
pnpm --filter webapp run scenarios:watch -- health:degrade
```

**Clicks.** Ask "is anything wrong right now?" → the report card comes back
**crit** → in its *Next steps* row, **Watch recovery** → **Watch**.

```bash
pnpm --filter webapp run scenarios:watch -- health:recover
```

**What arrives (≤5 min).** "Health recovered", green. If an email alert
subscription was accepted, the same headline lands in Mailpit
(http://localhost:8025).

The report's 7-day baselines are cached in the dev server for 5 minutes, so a
"normal" column can lag the flip by that much. Run `health:degrade` shortly
before a session, not hours before: a degradation left standing ages into its
own baseline and starts reading as normal.

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
