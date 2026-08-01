# Dashboard agent review playbook

The example conversations are **real stored chats over real data**. A seeder
creates an isolated `agent-examples` project — runs, queues, a deployment, an
error group, metrics — and stores the conversations as transcripts in the
agent's own datastore. The panel loads them through the production path, so
every id, queue name, version and citation resolves to a live dashboard page,
and what a reviewer sees is what a real chat looks like.

Each conversation is **one story**. Variation matrices — the same card in four
states, one row across four page kinds — belong to the state gallery at the
bottom of this page, never to a chat, where stacked variants read as a bug
rather than a comparison.

## Seeding it

```bash
pnpm run db:seed                                  # once, for the local user
pnpm --filter webapp run db:seed:agent-examples   # the example project + chats
```

The webapp has to be running (the seeder fetches the live report card from it),
and the panel has to be reachable: `DASHBOARD_AGENT_ENABLED=1` or
`DASHBOARD_AGENT_ADMIN_PREVIEW=1` in `apps/webapp/.env`.

Re-runnable — it wipes only what it owns. Add `-- --scale 0.1` for a fast
iteration, and leave `-- --heartbeat` running beside it to keep the report's
liveness finding fresh. Read the header of
`apps/webapp/seed-agent-examples.mts` for the story's numbers and the two
caveats about baselines.

Then open the `agent-examples` project (org `agent-examples`), open the agent
panel and click the History icon: the conversations below are the rows.

A few cases have no stored form — a half-arrived message, a tool row mid-call,
an unsent draft, the prompt chip row, the revising investigation card. A stored
transcript can't be mid-flight and panel chrome isn't a transcript item, so
those live in the state gallery instead;
`apps/webapp/seed-agent-examples-chats.mts` records each one and why
(`SKIPPED_DEMO_CHATS`).

The fixtures behind the gallery live in
`apps/webapp/app/components/dashboard-agent/demo/fixtures/`, one file per flow.

## What is real and what is a stand-in

| Rendered by | Cases |
| --- | --- |
| Production components | messages, text/markdown, reasoning, tool rows, `diagnosis`, `chart` and report view blocks, context banner, suggested prompts, composer, history list |
| Gallery-only stand-ins | investigation card (no block type until M5), prompt row with promoted/dismissed states, navigate bubble, chart card with canned rows |

The stored conversations only carry what the production renderer handles, so the
beats that have no block type yet (investigations, intents) are
assistant text there, and the cards themselves are reviewed in the gallery.

The stand-in cards are the ones to review hardest: **this review freezes
their payloads.** The investigation card's props are written as the intended M5
block payload (`hypotheses[]` with verdicts, `evidence[]` of `trigger://`
citations, `confidence`, `outcome`, `severity`, `caveat`), and the report card
consumes the real `ReportViewModel` with prose resolved through the real health
message catalog.

---

## Investigate

| Open | You should see | Feedback wanted |
| --- | --- | --- |
| `Why did this run fail?` | Two revisions of one investigation card; hypotheses marked **Testing** with a spinner, one settling to **Validated**. | Is a live-revising card readable, or does it need a quieter in-progress state? Is "Testing" the right word? |
| `send-order-receipt failure` | Collapsed card: **What happened** (severity + cause, 1–2 sentences) then **How to fix**. Expand "How I worked this out" for 3 hypotheses with verdict chips, evidence with `trigger://` URIs and a source excerpt. | Is the collapsed view enough to act on without expanding? Is the fix prose specific enough — and clearly *not applied*? |
| `Intermittent upstream timeouts` | **What we know** + **What to check next**, expanded, and deliberately **no fix section**. One hypothesis ruled out, one still open. | Does "I don't know" land as honest rather than broken? Are the next-checks concrete enough to be worth reading? |
| `Show me the failing code` | A follow-up turn with a fenced diff citing `file:line@sha`, ending in "I haven't applied anything". | Is a diff the right answer to "show me the code", or should it be the current source with the change described? |
| `Failure after yesterday's deploy` | The same conclusion with an amber caveat: source lines are the **nearest repository snapshot, not the exact deployed code**; confidence drops to medium. | Is the hedge clear without undermining the telemetry evidence, which is unaffected? Is amber too loud for it? |

## Navigation

| Open | You should see | Feedback wanted |
| --- | --- | --- |
| `Failed runs in the last 24h` | A past-tense navigate bubble — "Opened runs filtered to failed · last 24h · send-order-receipt" — with the deep link under it, plus a chart. | Is the bubble enough to explain a screen that just changed? Should the filters be listed, or just summarised? |
| `Take me to my deployments` | A reserved `propose_fix` intent rejected out loud ("proposing a fix isn't available yet"), then the agent describing the change instead. | Is an explicit rejection better than the agent never offering? What should it say? |
| `Follow-up on the investigation` | An investigation cited by `trigger://…/investigation/…`, plus a navigate-to-run bubble. | Should raw URIs ever be visible to users, or always resolved to a label? |

## Prompts

| Open | You should see | Feedback wanted |
| --- | --- | --- |
| `What should I look at here?` | One chip row for one page: a run that failed a minute ago, the context line it was derived from above it, and the fresh-failure prompt promoted to the top slot in indigo. Chips are intercepted; the dismiss `×` appears on hover. | Is one promoted slot right? Is the promoted styling too strong? Do the chips read as *offers* rather than commands? Is dismissal worth building? |

Fixture data for M4's registry lives in `demo/fixtures/page-context.ts`: one
`AgentPageContext` per page kind (with `fresh_failure`, `waiting_run`,
`slow_run`, `concurrency_saturation` signals) and the chip set a good resolver
should return for it. The chat shows only the failed-run page — the other page
kinds and the post-dismissal row are in the state gallery, because a chat is one
story and stacked variants of one row read as a bug.

## Reports

| Open | You should see | Feedback wanted |
| --- | --- | --- |
| `How is prod doing?` | Three green statements, collapsed findings, `nothing to do` footer, report URI at the bottom. | Is a healthy report worth a card at all, or should it be one sentence? |
| `Is anything wrong right now?` | Flow stalled at the env concurrency limit with execution healthy: causal `read:` line, metric rows with sparklines and deltas, worst-queue attribution, "not your code", two footer actions including the do-nothing option. | Does the card survive the 380px panel width? Are the sparklines legible there? Is "not your code" prominent enough — it's the single most valuable line? |
| `How do I use batchTrigger?` | A docs answer with two source links under it and no invented API. | Are citations under the answer enough, or do they need to be inline? |

## Base states

| Open | You should see | Feedback wanted |
| --- | --- | --- |
| `Summarize today's failures` | A partially streamed assistant message with the "Thinking…" row under it. | Does a half-sentence read as progress or as breakage? |
| `How deep is the email queue?` | A finished tool row above one still "calling…". **Click a row to expand its input/output.** | Should tool rows be visible by default, or collapsed behind one "worked on it" line? |
| `List yesterday's runs` | A failed tool row, the panel's error row, and a Retry button (intercepted). | Is the error message useful? Should retry be automatic? |
| `Queue health over time` | A replayed transcript whose `render_view` part carried three blocks: revisions 0 and 1 of one diagnosis (collapsed latest-wins) and one **pre-envelope block with no id** that still renders and can never be revised. | Should a resumed chat be marked as historical more strongly than the demo bar does? |
| `Draft in the composer` | A question left half typed (`why did the send-order-receipt run from last nig`) sitting in the composer, over an empty conversation — so the first-open suggested-prompt panel is on screen behind it. Sending is intercepted. | Should a draft survive closing the panel? Should the prompt panel stay visible while someone is typing, or get out of the way? |
| `Which page am I on?` | A real exchange: the agent names the page, project and environment from page context (`Runs`, `demo-storefront`, `prod`), says what it can already see on that page, offers to investigate the newest failure, then explains that context is re-read on every message. | Does the banner earn its row when the agent can say the same thing? Is “I read your page on every message” reassuring or unsettling? |
| History list | Every seeded conversation as a row, newest first. A project with no chats yet is the empty state. | Does the list read naturally? Is a title enough to find a chat by? |

## Notes for reviewers

- Every run id, queue, error group and deployment version in a seeded chat
  exists: follow the links. They point at the seeded project's prod
  environment, while the dashboard opens on dev by default.
- The `chart` view block inside `Queue health over time` is the *real*
  `AgentChart`, which runs its query against your current environment.
- The gallery fixtures under `demo/` contain no server imports and no `fetch`
  calls. A vitest suite (`demo/demo.test.ts`) enforces that, validates every
  fixture against the contracts schemas, and checks the id namespacing — a
  fixture id can never pass for a real one.

---

## Gallery & screenshot pack

The seeded conversations show the flows. The **state gallery** shows the states:
every card, chip row, prompt row, intent bubble and message-level state, in
isolation, at panel width, fed by the same fixtures.

### The gallery

`http://localhost:3030/storybook/agent-ui` — no env var needed, but you must be
signed in as an admin (the local seed user is). Every state is its own anchored
section, so `#report-degraded` links straight to one. The theme buttons at the
top right flip `data-theme` on the root element; the app itself is dark-only for
now, so that toggle is how a light render is produced.

What renders is driven by `apps/webapp/app/routes/storybook.agent-ui/manifest.ts`
— one row per state, `{ sectionId, title, group }`. The `sectionId` is the DOM
id, the deep-link anchor and the screenshot filename, so it is stable; a manifest
row the page can't render shows up as a red "no renderer" box rather than
disappearing. Add a state by adding a manifest row and a `STATES` entry.

### The screenshot pack

```bash
# terminal 1, repo root — apps/webapp/.env needs
#   DASHBOARD_AGENT_ENABLED=1   # or DASHBOARD_AGENT_ADMIN_PREVIEW=1
pnpm run dev --filter webapp

# terminal 2, apps/webapp — first run only
pnpm exec playwright install chromium

# terminal 2, apps/webapp
SCREENSHOT_ENV_PATH=/orgs/<org>/projects/<project>/env/dev/runs \
  pnpm run agent-ui:screenshots
```

It logs in over the local magic-link flow (dev redirects straight to the link,
so no email), then walks two things in each theme:

1. every gallery section, captured by its `id`;
2. every conversation in the panel's history, opened in the real panel on the
   env page you passed, captured as the panel element. Point
   `SCREENSHOT_ENV_PATH` at the seeded `agent-examples` project to capture the
   example chats.

Drop `SCREENSHOT_ENV_PATH` to do the gallery only. Other knobs: `BASE_URL`
(default `http://localhost:3030`), `SCREENSHOT_EMAIL` (default
`local@trigger.dev`, must be an admin), `SCREENSHOT_THEMES` (default
`dark,light`), `SCREENSHOT_OUT`, `SCREENSHOT_SCALE` (device pixel ratio, default
2), `SCREENSHOT_HEADED=1` to watch it.

Output lands in `apps/webapp/screenshots/agent-ui/` (git-ignored):

```
{theme}/{group}/{sectionId}.png
manifest.json
```

`manifest.json` is the index of the run: when it was taken, against what, and
one row per attempted capture with its theme, group, section id, title, relative
file path and — for anything that failed — the reason. Every capture is
attempted even if earlier ones fail, and the exit code is non-zero if anything
did, so the pack doubles as a smoke test that the gallery still renders.
