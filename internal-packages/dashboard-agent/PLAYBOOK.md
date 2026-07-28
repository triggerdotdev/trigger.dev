# Dashboard agent review playbook

Demo mode is a set of **canned conversations** rendered by the real panel: real
message renderer, real view-catalog cards, real banner and composer, with no
transport, no agent run and no LLM. It exists so the v1 flows can be reviewed as
UI before their backends land.

**All data in demo mode is fabricated.** Every run id, queue, error, report and
investigation is a fixture. Nothing is fetched, nothing is written, and every
affordance (deep links, report actions, prompt chips, watch cancel, Send) is
intercepted — clicking one appends an inline `demo` note saying what *would*
have happened.

Each conversation is **one story**, as close to a real one as fixtures allow.
Variation matrices — the same card in four states, one row across four page
kinds — belong to the state gallery at the bottom of this page, never to a chat,
where stacked variants read as a bug rather than a comparison.

## Turning it on

```bash
# apps/webapp/.env
DASHBOARD_AGENT_DEMO=1
DASHBOARD_AGENT_ENABLED=1   # or DASHBOARD_AGENT_ADMIN_PREVIEW=1 — the panel still has to be reachable
```

Restart the webapp, open any project, open the agent panel, click the History
icon. Demo conversations look exactly like real chats (deliberately — review the true experience); they are the extra history rows listed below. Pick one; it renders
in place of a real chat.

An env var rather than a feature flag on purpose: demo mode is a local review
tool, not a rollout, and a per-org flag would put fabricated runs one toggle away
from a production org. It is independent of agent access, so a reviewer needs no
Anthropic key and no deployed agent task — only a reachable panel.

Everything lives in `apps/webapp/app/components/dashboard-agent/demo/`; the
fixtures are in `demo/fixtures/`, one file per flow.

## What is real and what is a stand-in

| Rendered by | Cases |
| --- | --- |
| Production components | messages, text/markdown, reasoning, tool rows, `diagnosis` and `chart` view blocks, context banner, suggested prompts, composer, history list |
| Demo-only cards | investigation card (no block type until M5), report card (no `ReportView` until M2), chart card with canned rows (the real one fetches `/resources/metric`), watch chips, prompt row with promoted/dismissed states, navigate bubble |

The two stand-in cards are the ones to review hardest: **this review freezes
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

## Watch

| Open | You should see | Feedback wanted |
| --- | --- | --- |
| `Tell me when the backlog drains` | A watch intent, the chip row under the banner (`send-order-receipt`, `backlog-drain`), then an unprompted wake narration minutes later. | Does an unprompted message need more framing than the note above it? Is the chip row the right home for watches? |
| `Watch for that error recurring` | Chips in all four states (watching / fired / expired / cancelled), an expiry narration, the **couldn't verify at expiry** variant, and a cancel confirmation. The cancel control on an active chip is a labelled icon button (“Cancel the backlog-drain watch”, tooltip on hover) and is intercepted. | Is the "couldn't verify" wording clearly different from "it didn't happen"? Should an expired watch offer to renew itself? |

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
| History list | Every demo row alongside real chats (demo rows are visually identical by design). `demoEmptyHistoryChats` is the empty state. | Does the mixed list read naturally? |

## Notes for reviewers

- Run ids like `run_demo0f2c91` are fabricated. The `diagnosis` card links them
  to real run pages, so those links 404 — expected.
- The `chart` view block inside `Queue health over time` is the *real*
  `AgentChart`, which runs its query against your current environment. It may be
  empty locally. Every other chart in demo mode uses canned rows.
- `demo/` contains no server imports and no `fetch` calls; the only server file
  is `demoFlag.server.ts`, which nothing in `demo/` imports. A vitest suite
  (`demo/demo.test.ts`) enforces that, validates every fixture against the
  contracts schemas, and checks the id namespacing.

---

## Gallery & screenshot pack

The demo conversations show the flows. The **state gallery** shows the states:
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
#   DASHBOARD_AGENT_DEMO=1
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
2. every demo conversation, opened in the real panel on the env page you
   passed, captured as the panel element.

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
