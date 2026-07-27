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

## Turning it on

```bash
# apps/webapp/.env
DASHBOARD_AGENT_DEMO=1
DASHBOARD_AGENT_ENABLED=1   # or DASHBOARD_AGENT_ADMIN_PREVIEW=1 — the panel still has to be reachable
```

Restart the webapp, open any project, open the agent panel, click the History
icon. The demo conversations are the rows titled `Demo · …`. Pick one; it renders
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
| `Demo · Investigate: card streaming` | Two revisions of one investigation card; hypotheses marked **Testing** with a spinner, one settling to **Validated**. | Is a live-revising card readable, or does it need a quieter in-progress state? Is "Testing" the right word? |
| `Demo · Investigate: concluded` | Collapsed card: **What happened** (severity + cause, 1–2 sentences) then **How to fix**. Expand "How I worked this out" for 3 hypotheses with verdict chips, evidence with `trigger://` URIs and a source excerpt. | Is the collapsed view enough to act on without expanding? Is the fix prose specific enough — and clearly *not applied*? |
| `Demo · Investigate: inconclusive` | **What we know** + **What to check next**, expanded, and deliberately **no fix section**. One hypothesis ruled out, one still open. | Does "I don't know" land as honest rather than broken? Are the next-checks concrete enough to be worth reading? |
| `Demo · Investigate: show me the code` | A follow-up turn with a fenced diff citing `file:line@sha`, ending in "I haven't applied anything". | Is a diff the right answer to "show me the code", or should it be the current source with the change described? |
| `Demo · Investigate: dirty-commit caveat` | The same conclusion with an amber caveat: source lines are the **nearest repository snapshot, not the exact deployed code**; confidence drops to medium. | Is the hedge clear without undermining the telemetry evidence, which is unaffected? Is amber too loud for it? |

## Navigation

| Open | You should see | Feedback wanted |
| --- | --- | --- |
| `Demo · Navigation: opened filtered runs` | A past-tense navigate bubble — "Opened runs filtered to failed · last 24h · send-order-receipt" — with the deep link under it, plus a chart. | Is the bubble enough to explain a screen that just changed? Should the filters be listed, or just summarised? |
| `Demo · Navigation: rejected intent` | A reserved `propose_fix` intent rejected out loud ("proposing a fix isn't available yet"), then the agent describing the change instead. | Is an explicit rejection better than the agent never offering? What should it say? |
| `Demo · Base: investigation deep link` | An investigation cited by `trigger://…/investigation/…`, plus a navigate-to-run bubble. | Should raw URIs ever be visible to users, or always resolved to a label? |

## Prompts

| Open | You should see | Feedback wanted |
| --- | --- | --- |
| `Demo · Prompts: page-aware chips` | Four chip rows — failed run, waiting run, slow run, saturated queue — each headed by the page context and signals it came from, promoted chip first in indigo. Last row: the same page after one chip was dismissed. | Is one promoted slot right? Is the promoted styling too strong? Do the chips read as *offers* rather than commands? Is dismissal worth building? |

Fixture data for M4's registry lives in `demo/fixtures/page-context.ts`: one
`AgentPageContext` per page kind (with `fresh_failure`, `waiting_run`,
`slow_run`, `concurrency_saturation` signals) and the chip set a good resolver
should return for it.

## Watch

| Open | You should see | Feedback wanted |
| --- | --- | --- |
| `Demo · Watch: created, then woke` | A watch intent, the chip row under the banner (`send-order-receipt`, `backlog-drain`), then an unprompted wake narration minutes later. | Does an unprompted message need more framing than the note above it? Is the chip row the right home for watches? |
| `Demo · Watch: expiry and cancel` | Chips in all four states (watching / fired / expired / cancelled), an expiry narration, the **couldn't verify at expiry** variant, and a cancel confirmation. Cancel `×` is intercepted. | Is the "couldn't verify" wording clearly different from "it didn't happen"? Should an expired watch offer to renew itself? |

## Reports

| Open | You should see | Feedback wanted |
| --- | --- | --- |
| `Demo · Reports: healthy` | Three green statements, collapsed findings, `nothing to do` footer, report URI at the bottom. | Is a healthy report worth a card at all, or should it be one sentence? |
| `Demo · Reports: degraded` | Flow stalled at the env concurrency limit with execution healthy: causal `read:` line, metric rows with sparklines and deltas, worst-queue attribution, "not your code", two footer actions including the do-nothing option. | Does the card survive the 380px panel width? Are the sparklines legible there? Is "not your code" prominent enough — it's the single most valuable line? |
| `Demo · Reports: docs answer with sources` | A docs answer with two source links under it and no invented API. | Are citations under the answer enough, or do they need to be inline? |

## Base states

| Open | You should see | Feedback wanted |
| --- | --- | --- |
| `Demo · Base: empty / first open` | The production suggested-prompt panel and an empty composer. | Is the first-open screen doing enough work? |
| `Demo · Base: streaming` | A partially streamed assistant message with the "Thinking…" row under it. | Does a half-sentence read as progress or as breakage? |
| `Demo · Base: tool call in flight` | A finished tool row above one still "calling…". **Click a row to expand its input/output.** | Should tool rows be visible by default, or collapsed behind one "worked on it" line? |
| `Demo · Base: error and retry` | A failed tool row, the panel's error row, and a Retry button (intercepted). | Is the error message useful? Should retry be automatic? |
| `Demo · Base: resumed chat` | A replayed transcript whose `render_view` part carried three blocks: revisions 0 and 1 of one diagnosis (collapsed latest-wins) and one **pre-envelope block with no id** that still renders and can never be revised. | Should a resumed chat be marked as historical more strongly than the demo bar does? |
| `Demo · Base: composer with a draft` | The composer pre-filled the way `openWith` fills it from a page. Sending is intercepted. | Should a prefilled question send itself, or always wait for the user? |
| `Demo · Base: banner variants` | The context banner across four page/env shapes (including a preview branch), plus the watch chip row. | Does the banner earn its row? Does a long preview-branch name break it? |
| History list | Every `Demo · …` row alongside real chats. `demoEmptyHistoryChats` is the empty state. | Are demo rows distinguishable enough from real ones in the list? |

## Notes for reviewers

- Run ids like `run_demo0f2c91` are fabricated. The `diagnosis` card links them
  to real run pages, so those links 404 — expected.
- The `chart` view block inside `Demo · Base: resumed chat` is the *real*
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
2. every `Demo · …` conversation, opened in the real panel on the env page you
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
