# Dashboard Agent — team guidebook

An AI assistant in a side panel on every dashboard page. It reads your runs,
errors, queues, deploys and health through the same APIs you use, answers in
place, renders rich cards, and can keep watching things after the conversation
ends. Read-only by design — the only things it ever creates are its own
watches and (with your explicit yes) an email alert subscription.

Branch: `feat/dashboard-agent-flows`.

---

## Run it locally (10 minutes)

```bash
git checkout feat/dashboard-agent-flows && pnpm i
pnpm run docker && pnpm run db:migrate && pnpm run db:seed
pnpm --filter @internal/dashboard-agent-db run db:migrate

# The playground: a project with realistic data + example conversations
pnpm --filter webapp run db:seed:agent-examples
# Keep its telemetry fresh while you play (Ctrl-C safe):
pnpm --filter webapp run db:seed:agent-examples -- --heartbeat
```

`apps/webapp/.env` needs: `DASHBOARD_AGENT_ENABLED=1`, `ANTHROPIC_API_KEY`,
`DASHBOARD_AGENT_SECRET_KEY=<a dev env key of the trigger project the agent
task runs in>`. Optional, for email alerts:

```bash
docker run -d --name mailpit -p 8025:8025 -p 1025:1025 axllent/mailpit
# then in .env: ALERT_EMAIL_TRANSPORT=smtp, ALERT_FROM_EMAIL=agent@localhost.test,
# ALERT_SMTP_HOST=localhost, ALERT_SMTP_PORT=1025, ALERT_SMTP_SECURE=0
```

`internal-packages/dashboard-agent/.env` needs `ANTHROPIC_API_KEY` and
`DATABASE_URL`. Then:

```bash
pnpm run dev --filter webapp          # start FIRST
cd internal-packages/dashboard-agent && pnpm exec trigger dev   # then this
```

> Order matters: if you restart the webapp, restart `trigger dev` after it —
> otherwise new chat turns hang unpicked.

Open the playground (the seeder prints the URL): the chat button is in the
page header. Emails land in Mailpit at http://localhost:8025.

### Make things happen on demand

```bash
pnpm --filter webapp run db:seed:agent-examples -- --degrade   # prod goes crit
pnpm --filter webapp run db:seed:agent-examples -- --recover   # prod recovers
```

That pair is how you demo the whole watch-fires-alert loop to yourself.

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

## The full toolbox — what's convenient to do through the agent

Everything it can reach, phrased as things you'd actually say. ⭐ = the
scenarios worth trying first.

| Say | It does |
| --- | --- |
| ⭐ "Why did this run fail?" / *Investigate* | full investigation card with tested hypotheses and cited evidence |
| ⭐ "Tell me when the backlog drains" / "…when this run starts" | durable watch that wakes the chat (and emails you, if subscribed) |
| ⭐ "Is anything wrong right now?" | the deterministic health report as a card |
| ⭐ "Show me the failing code" (repo connected) | reads your source at the run's deployed commit, cites file:line |
| "Where am I?" / "what is this page showing?" | explains the current page — it always knows where you are |
| "Take me to the email-sends queue" / "show failed runs from the last 24h" | navigates the dashboard for you, filters applied |
| "What happened to run_abc?" / "show its timeline" | run details and its trace, span by span |
| "What errors are recurring?" / "how widespread is this one?" | error groups, counts, first/last seen |
| "What's queued right now, and why isn't it moving?" | queue depth, throughput, limiting cause, drain estimate |
| "How many runs failed yesterday, by task?" / "chart it" | TRQL query over your run data, rendered as a live chart |
| "What's deployed right now?" / "did the last deploy cause this?" | deploy list, current version, run→commit correlation |
| "What tasks does this project have?" | the task list with file paths |
| "How do retries work?" / "how do I set a concurrency limit?" | docs answer with source links |
| "What alerts do I have?" / "turn off the email alert" | lists and manages your watch-result subscriptions |
| "This looks broken, can you flag it to support?" | files the context to the support channel |

## Where the UI got updates

- **Chat button (page header)** — unread dot when a watch woke a chat you
  haven't read.
- **Persistent toast** — a wake while you're anywhere in the dashboard raises
  a notification that stays until you close it.
- **Chat history** — unread chats first and highlighted; per-chat status icon
  left of the title (spinner = agent working / watch active, magnifier =
  investigation in progress; hover for which).
- **In the transcript** — a watch's result opens with a banner that states the
  fact ("email-sends queue drained", "Run abc123 failed", "Health recovered"),
  toned by what actually happened rather than by which kind of watch it was;
  watch chips under the composer show live watches with cancel; clicking a
  card's watch button posts a visible request the agent answers.
- **Report cards** — terminal-style skin, metric grid with sparklines, *Next
  steps* footer with real buttons (docs entries always get the docs button).
- **Alerts page** — the new "Dashboard agent watches" alert type on standard
  channels (email / Slack / webhook).

## Suggested prompts

An empty chat offers up to five, picked from where you are: a promoted one
(product-controlled), *Investigate* for the failure on screen, a watch for
the thing in front of you, an explain-this-page one, and a docs one.

## The demo script — four acts, ~15 minutes

Run `-- --degrade` RIGHT BEFORE the demo, not ahead of time — a degradation
left running for a while blends into the baselines and starts reading as
normal (re-run `--degrade` if the report says ok). One terminal stays open for
the act-four commands.

**Act 1 — hello (30 seconds)**
1. Any page → chat button → *"Where am I? What is this page showing?"* — it
   knows where you are, no clarification needed.
2. *"Take me to the email-sends queue"* — it drives the dashboard for you.

**Act 2 — something's wrong (the centerpiece)**
3. *"Is anything wrong right now?"* → the terminal-style report card: crit,
   pinned concurrency, sparklines, "not your code", a *Next steps* row of real
   buttons.
4. Click **[Watch recovery]** → your request appears in the chat → the agent
   confirms: checks every 5 minutes, fires once, gives up after N hours — and
   offers an email alert. Say *"yes"* and the channel appears on the Alerts
   page.
5. While the watch ticks — **Investigate**: open the failing
   `send-order-receipt` error → *Investigate* → a live card: hypotheses tested
   in front of you, a concluded verdict citing runs, spans, and the deploy
   (a 429 rate limit).
6. Bonus, same chat: *"Show me the failing code"* — file:line at the deployed
   commit.

**Act 3 — data and knowledge (the interlude)**
7. *"How many runs failed yesterday, by task? Chart it"* — TRQL + a live chart.
8. *"Did the last deploy cause this?"* — run → commit → deploy correlation.
9. *"How do retries work?"* — a docs answer with source buttons.

**Act 4 — the finale: it comes back on its own**
10. In the terminal: `pnpm --filter webapp run db:seed:agent-examples -- --recover`.
    Close the panel and wander the dashboard.
11. Within ~5 minutes, unprompted: a persistent "Watch update" toast, a dot on
    the chat button, the chat on top of History highlighted — inside, the green
    **"Watch update — all clear"** banner — and the email in Mailpit
    (localhost:8025) with the same headline and one-click unsubscribe.
12. Curtain: *"What alerts do I have?"* → the list; *"turn it off"* →
    unsubscribed right from the chat.

Safety nets: History ships seeded example conversations (browsable without
spending a token), and every card state lives in the gallery at
`/storybook/agent-ui`. `-- --degrade` resets the stage for a repeat run.

## Try these

| Where | Say / click | You'll see |
| --- | --- | --- |
| prod runs page | "Is anything wrong right now?" | degraded report card (run `--degrade` first) |
| that card | *Watch recovery* → confirm the alert offer | visible request, chip, alert channel on /alerts |
| terminal | `--recover` | report turns ok; within ~5 min the chat wakes green + email in Mailpit |
| a failed run | *Investigate* | live investigation card, concluded with evidence |
| an error page | "Ping me if this error comes back" | pending watch; recurrence wakes the chat |
| anywhere | "How many runs failed yesterday, by task?" | TRQL answer, chart on request |
| anywhere | "What alerts do I have?" | the agent lists your subscriptions |

The panel's History also ships seeded example conversations — every flow
readable without spending a token — and there's a component gallery at
`/storybook/agent-ui` (admin only) with every card in every state.

## What it will not do

- Write anything beyond its own watches and an alert you explicitly approved.
- Invent numbers or claim something doesn't exist beyond a truncated page.
- Trust a report whose telemetry is stale.

Feedback → #dashboard-agent-feedback, or just tell the agent — every
conversation is evaluated and capability gaps are collected automatically.
