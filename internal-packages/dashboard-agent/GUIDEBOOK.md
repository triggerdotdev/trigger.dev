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

## Where the UI got updates

- **Chat button (page header)** — unread dot when a watch woke a chat you
  haven't read.
- **Persistent toast** — a wake while you're anywhere in the dashboard raises
  a notification that stays until you close it.
- **Chat history** — unread chats first and highlighted; per-chat status icon
  left of the title (spinner = agent working / watch active, magnifier =
  investigation in progress; hover for which).
- **In the transcript** — wake messages open with a tone banner ("Watch
  update — all clear" / "needs your attention" / expired); watch chips under
  the composer show live watches with cancel; clicking a card's watch button
  posts a visible request the agent answers.
- **Report cards** — terminal-style skin, metric grid with sparklines, *Next
  steps* footer with real buttons (docs entries always get the docs button).
- **Alerts page** — the new "Dashboard agent watches" alert type on standard
  channels (email / Slack / webhook).

## Suggested prompts

An empty chat offers up to five, picked from where you are: a promoted one
(product-controlled), *Investigate* for the failure on screen, a watch for
the thing in front of you, an explain-this-page one, and a docs one.

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
