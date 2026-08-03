# Dashboard Agent — new-type flows: feature design

dashboard agent · feature design · v3.1 · updated 2026-07-30 
# Investigations & Watches: the two flows only Trigger can ship 

Product behavior, UX semantics, and the trust model for the two new-type agent flows — grounded in four research passes (chat.agent primitives, code-mode depth, the Linear roadmap, the mid-2026 competitive field). 

> **Authority:** this document is canonical for *user behavior, UX semantics, trust model, and product rationale*. It does not define build sequencing, schemas-as-code, or acceptance criteria — those live in the [Development Plan](https://claude.ai/code/artifact/d075c936-3d52-4d27-915b-be0f3de95a6e), which wins on any implementation disagreement. 

> **Δ As built (2026-07-30):** both flows shipped and were verified live end-to-end. Execution deltas that changed this document's semantics are marked **Δ** inline: the dashboard watch adapter now posts a *visible chat request* (the silent POST was dropped), wakes render under a toned **wake banner**, and a new layer — **alerts & notifications (M6.5)** — was added: standing email/Slack/webhook alerts on watch fires with one-click unsubscribe and agent-managed subscriptions, plus an always-on in-dashboard signal (persistent wake toast, unread launcher dot, unread-first history). The full delta list lives in the Development Plan's Δ block.  

## §0 Research base — what constrains the design   **** **** **** ****** ****```` **** 

| Fact | Consequence for design |
|---|---|
| The investigation UX has converged (Datadog Bits AI SRE, incident.io, Grafana Investigations): trigger → hypotheses → each tested against telemetry → validated invalidated inconclusive with cited evidence → summary → chat follow-up. | Ship this shape; don't invent a novel grammar. |
| No background-jobs platform has an in-dashboard agent. Temporal, Inngest, Upstash all stopped at MCP servers. | Open lane; first-mover framing for launch week. |
| The praised moment everywhere is "the answer was already waiting"; the criticized moment is review fatigue on low-confidence output. | Autonomy is a dial; inconclusive results stay honest and quiet. |
| Our structural edge: we are the executor, not an observer. The investigation itself can be durable; the platform can watch, wake, and (later) act and verify. | Design flows that stay alive and close the loop. |
| The primitive backbone exists: any authorized process can wake or spawn a chat via session.in/append; the agent triggers tasks in its own project with delay; run → exact commit SHA → source reads are production-shaped. | Both flows are protocol + schema + one small task — no new infrastructure. |
| Roadmap reserves the slots: TRI-11028 (failure card ≅ ReportVM), TRI-11029 (contextual buttons), TRI-11155 (code mode), Reports doc (report-alerts, actionable reports), MCP vision (self-healing loop, durable resident agent). | These flows are steps on existing rails. |
 

## §1 Flow A — Failure Investigations · the flagship 

**One line:** a button on any failed run or error group — *Investigate* — starts a structured investigation that gathers evidence, forms falsifiable hypotheses, tests each with real tool calls, and concludes with a verdict card whose every claim links to a run, span, error, metric, queue, deployment, or *line of the user's own source at the deployed commit*. 

### Why this is the powerful one  
- **TRI-11028 executed at 2026 standards** — same card slot, hypothesis-verdict grammar users already trust. 
- **Code grounding beats every APM:** Sentry starts from a stack trace; we start from the run — payload, trace, queue state, deploy version — *and* the failing frame's file at the run's commit. The native evidence line: *"first seen in v20260722.3, deployed from PR #482 — `parsePayload` (src/lib/payload.ts:41) now requires `userId`"*. 
- **The pipeline exists:** run/trace/error tools, TRQL, version→commit correlation, code tools with runId pinning, report grounding.  

### UX walkthrough  

user · entry *Investigate* on a failed run's error section, an error group header, a warn/crit queue row, or the waiting-run widget ("Why is this run waiting?"); or a contextual suggested prompt; or asked in chat. 

agent · phase 1 — evidence, deterministic first Streams tool calls: run + trace; error fingerprint + first-seen version; version → commit/PR; before/after cohort; health report (json) as ambient state. Facts land before any interpretation. Independent evidence calls are issued in parallel. **Δ** In the transcript an in-flight tool renders as a compact *pending pill* ("Reading the run's trace…") — never streamed input JSON; a landed call leaves no row (only failed calls keep their error row). 

agent · phase 2 — hypotheses Forms falsifiable hypotheses (default 2; up to 4 only when evidence and remaining step budget justify it). The card appears with hypotheses marked testing… 

agent · phase 3 — test each One targeted check per hypothesis. Chips flip to validated / invalidated as evidence arrives. 

agent · phase 4 — conclusion Final card, **answer-first**: the default (collapsed) view is two short sections a human reads in five seconds — **"What happened"** (severity + the cause in 1–2 plain sentences) and **"How to fix"** (a concrete remediation description in prose — what to change and where, even while automated fixes aren't built). Below them: *Show details* (expands the tested hypotheses with verdicts + all evidence citations, incl. the source excerpt — pure client-side, no LLM) and ***Show code* — which posts the potential diff into the chat**: an ask-intent that runs one agent turn producing the proposed change as a fenced diff (minimal, citing `file:line@sha`, dirty-commit caveat when applicable; code mode only — hidden otherwise). Plus next actions: *watch for recurrence* · *view similar failures* · *ask a follow-up*. The investigation must conclude — or explicitly return *inconclusive* — within the platform's step ceiling; it never trails off. **Δ** The closing prose after the verdict card is exactly one sentence — anything list-shaped belongs on the card; and latest-wins collapse applies *transcript-wide*, so the in_progress working copy disappears when the verdict renders. 

honest failure mode No hypothesis validates → status inconclusive: what was ruled out, what data would decide it. No invented confidence.  

### Progressive rendering — decided semantics 

> decision · latest-wins by block id — identity is system-owned Every investigation card carries a stable `investigationId` and a monotonically increasing `revision`. The agent re-emits the card as hypotheses resolve; the transcript renderer groups `render_view` outputs by `(type, id)` and renders **only the latest revision** — one card with flipping chips. No live data-part protocol needed. **Δ As built:** the collapse is enforced across the whole transcript (all messages, all tool parts), not merely within one `render_view` output. 

 **Identity and revision are system-owned, never model-owned.** The model reports *state*, not authority fields: 

```
first investigation render
  → render_view executor assigns investigationId, persists revision 0,
    returns investigationId to the model
subsequent render with investigationId
  → executor verifies same chat/project/env
  → atomically assigns the next revision
  → upserts the investigations record
  → emits the canonical block
```
 A model-supplied or malformed id/revision can never overwrite another investigation; concurrent updates produce monotonically increasing revisions. 

### The card — grammar 

Congruent with ReportVM (headline · severity · facts · evidence · links · next actions). Exact schema-as-code is frozen in the Development Plan (M0 envelope, payload after the M1 design pass); the behavioral contract:  
- **Answer-first disclosure (two levels), conditional on the outcome:** a *concluded* card shows *What happened* (1–2 sentences) and *How to fix* (remediation prose); an *inconclusive* card shows **What we know** and **What to check next** — it never promises a fix for a cause it couldn't validate (the honesty model extends to the section headers). *Show details* expands hypotheses + evidence + source excerpt (client-side, free); *Show code* posts the **potential diff** into the chat via an ask-intent (one explicit LLM turn — allowed by the token-economy rule because it's a user click). 
- **Show code visibility (strict):** visible only when the investigation is *concluded*, the cause/fix is *code-addressable*, the relevant source file was actually read at the run's pinned snapshot, and a concrete file/location is present in the investigation state. Hidden for: inconclusive outcomes, assistant mode, operational/configuration causes (a pinned concurrency limit has no diff), and unavailable source. A dirty commit is allowed with the snapshot caveat. 
- **Evidence is always a citation:** `{ kind, uri, label, excerpt? }` where `uri` is a `trigger://` URI (run, span, error, queue, deployment, report, source line, investigation). Hosts resolve URIs to links; the model never emits raw dashboard URLs. **Δ As built:** at the tool boundary the model cites *bare resource ids* (it never holds the environment id the URI grammar embeds); the render_view executor canonicalizes them into `trigger://` URIs before anything is stored or rendered — the persisted contract stays strict. 
- **Next actions are typed intents** (`navigate / ask / watch`; `propose_fix` reserved for the next iteration), not free-form buttons. 
- **Confidence is a policy, not a feeling:** *high* = direct evidence plus independent corroboration; *medium* = strong correlation, causal link incomplete; *low* = cannot be validated — a low-confidence hypothesis is never rendered "validated"; it folds into inconclusive. 
- **Fix-suggestion hygiene** (free-text fixes will happen whenever the user asks — govern them, don't pretend they're off): a suggested change is minimal, cites `file:line@sha`, is never offered without the file actually read, and carries the snapshot caveat on a dirty commit. The structured diff block remains next-iteration.  

### Evidence integrity rules 

> truncation & absence Tool results are capped (trace ≤60 spans, query ≤200 rows) and flagged `truncated`. **Truncated evidence may support a positive observation but must never be used to assert absence** ("no other runs failed after the deploy" is forbidden off a truncated page). **Missing evidence ≠ disproven hypothesis** — an unverifiable hypothesis is inconclusive, not invalidated. 

### Code grounding — degradation matrix     ``****    

| Condition | Behavior |
|---|---|
| No connected GitHub repo | Assistant mode: investigation proceeds without source evidence; never fakes code claims. |
| Run has no deployed commit (dev run / unresolvable SHA) | State "source for this run is unavailable"; do not silently fall back to another ref for run-specific claims. |
| dirty === true on the deployment | Never label repository evidence "the exact deployed code." Present the commit as the nearest repository snapshot and state that uncommitted build changes prevent exact source attribution. |
| No PR metadata in GitMeta | Cite commit SHA + message only. |
| Line no longer maps cleanly / excerpt ambiguous | Cite the file, not a line. |
| Source tool truncation or error | Evidence marked partial; the truncation rule above applies. |
 

### The autonomy dial  

**answer + diff on ask** — **This iteration.** Card ends at What happened / How to fix; *Show code* posts the potential diff into the chat as text (hygiene rules above; code mode only). Nothing is written anywhere — the diff is conversation content the user copies. 

**structured diff block** — **Next iteration:** the same diff as a first-class view block (file/hunks/copy button, its own evals). The `propose_fix` intent kind is reserved for it now, unused in v1. 

**open a PR** — Phase 2+: server-side octokit, App write permissions, approval-card gate. A disabled affordance may tell the story in the UI.  

## §2 Flow B — Watches · the durable one 

**One line:** the agent can promise the future — *"I'll watch this and tell you"* — because a chat is a durable session any authorized process can wake: a watcher re-checks a deterministic condition and the conversation resumes hours later with the answer. 

### Authorization model (the trust design — normative) 

> watchers never hold user credentials — and the credential is per-watch The per-turn user-actor token lives 10 minutes; a watch lives up to 24 hours. Therefore: **watchers never persist a UAT or an environment JWT.** The mechanism, frozen: 

```
webapp creates the watch
  → mints a signed internal watch token:
      client = "dashboard-agent-watch" · claim: watchId
      exp = watch expiresAt + a bounded grace period (e.g. +1h) — the token must
      outlive expiresAt so a delayed tick can still perform the FINAL expiry
      check ("still degraded after N h" promises fresh data). The endpoint never
      permits ordinary checks after expiresAt; during the grace window it permits
      only the final expiry evaluation for that watch. The watch ROW, not token
      expiry, is the authority on whether environment reads are allowed.
watcher carries only that token
  → POST private watch-check endpoint
  → webapp verifies signature + watchId match
  → THEN re-authorizes the initiating user against the watch's immutable
    project/environment using the SAME current authorization path as an
    interactive dashboard request, then applies the feature gate
  → deterministic check via transport-independent server modules
```
 It is not a user credential, and its capability is bounded to one watch — a stolen token is not a general internal API credential. **Signing:** a dedicated watch-token sign/verify helper using `SESSION_SECRET` with a distinct token type/audience (`client:"dashboard-agent-watch"`); the watch-check endpoint accepts only this token type, and it must be rejected by UAT verification paths (no new secret is introduced, but the capability stays disjoint from user-actor tokens — cross-token rejection is unit-tested). **If access has been revoked, the watch terminates (status `cancelled`, reason `access_revoked`) without reading environment data.** Environment-level authorization matters here: plain org membership is weaker than the dashboard's env access model, so the re-auth goes through the same path an interactive request would. 

 Shape: `watch task → per-watch token → trusted server adapter → re-authorize initiating user → deterministic module` — never `watch task → stored user token`. The watch row immutably records what it observes (project, environment, initiating user), independent of whatever page the user opens tomorrow. 

### Watch kinds — v1 and their deterministic semantics 

The spec is a discriminated union (schema-as-code in the Development Plan). `deploy_verdict` is **not in v1**: a deterministic deploy verdict needs a defined predicate (baseline window, sample floor, failure/duration deltas) that belongs to the future regression report — it moves to What's next rather than letting the model invent product semantics. 

Every deterministic check returns one of four results — never a bare boolean: 

```
pending                // condition not yet met — schedule next tick
satisfied              // condition met — fire
terminal_unsatisfied   // condition can never be met — fire with the terminal outcome
unavailable            // check failed / data unreachable — record failed tick, retry until TTL
```
 

**Unavailability rule (applies to every kind):** a failed or unavailable check is *never* interpreted as condition true or false. It records a failed tick and retries until TTL; repeated failures surface in the expiry narration. **If the final expiry evaluation itself is unavailable, the watch transitions to `expired` anyway** — the narration says the condition could not be verified at expiry and includes the last successful observation and its time; TTL is never extended because the final check failed.   **``******``   ````********`` ```` 

| Kind | satisfied (fires) | terminal_unsatisfied | Expiry (maxHours reached) |
|---|---|---|---|
| run_start { runId } | Satisfied whenever the run has an authoritative execution-start marker (startedAt), regardless of its current status — a run that started and finished between two ticks still fires. Narration reports how long the run waited — using the canonical queue-entry timestamp identified by the M0 check; if none exists, startedAt − createdAt is reported as "time from creation to start", never as "queue/start latency" (scheduled and deliberately-delayed runs would make that number a lie). | Terminal state AND no execution-start marker exists → "cancelled/expired before it started" — immediately, not after 24h. | "Still queued after N h" + current queue diagnosis. |
| run_finished { runId } | Run status enters the canonical terminal set; narration names the outcome. | — | "Still running after N h" + duration vs its usual p95. |
| backlog_drain { queue } | Current pending count for the queue = 0. | Queue no longer exists → say so. | "Not drained: depth now X" + limiting cause. |
| error_recurrence { fingerprint } | First occurrence with occurredAt > since. since is server-set to watch creation time — the model never chooses it; historical occurrences never count. Δ The API error id (error_<fp>) is normalized to the raw fingerprint at the check boundary. | — | Positive result: "no recurrence in N h". |
| health_recovery { report:"health", fromSeverity } | facts.trustworthy === true AND summary severity = ok. Stale/untrustworthy data never fires recovery. | — | "Still degraded/unknown" + last severity. |
 

**Creation does an immediate check:** if the condition is already satisfied (or terminally unsatisfiable) at creation time, the watch fires right away — "tell me when this run starts" on a run that started two seconds ago answers now, not on the next tick. **Identity for dedup:** `watchIdentity(spec)` identifies the condition *within an environment* — e.g. `run_start:run_123`, `backlog_drain:email-sends`, `health_recovery:health`; cadence/note/TTL are not part of identity. Because a chat is not env-bound, **active-watch dedup is scoped by chat + immutable project/environment + watchIdentity(spec)** — one chat may legitimately hold a prod `health_recovery` watch and a staging one simultaneously. 

### Lifecycle — state machine, at-least-once, durable delivery 

```
Condition state:                 Delivery state:
active ──▶ fired                 not_required ──▶ pending ──▶ delivered
active ──▶ expired
active ──▶ cancelled             fired / expired   → delivery pending → delivered
Terminal states immutable.       cancelled(user | access_revoked | chat_deleted)
                                                   → delivery not_required (no wake)

Each tick (idempotency key watch:{id}:tick:{n}):
  load watch
  → if terminal AND delivery=pending → retry delivery only (idempotent), exit
  → if terminal (delivered or not_required) → exit
  → authenticate (per-watch token) → re-authorize initiating user
  → deterministic check (zero LLM) → pending | satisfied | terminal_unsatisfied | unavailable
  → satisfied/terminal_unsatisfied or TTL → ATOMIC condition transition
    (sets delivery=pending), then deliver; mark delivered only after the
    session append is acknowledged
  → unavailable → record failed tick; pending → record lastCheckedAt/lastResult
  → schedule next tick (delay)
```
 

> delivery is durable and idempotent — no lost wakes, no double narrations, no ghost wakes Condition evaluation is at-least-once; **wake delivery is durable and idempotent, and only *notifying* terminal outcomes (fired, expired) deliver** — a cancelled watch (user cancel, access revoked, chat deleted) emits nothing, ever. A notifying terminal watch is not considered complete until its session action has been acknowledged. **Who guarantees the retry: the task retry policy.** `dashboard-agent-watch` runs with a retry policy; any failure before delivery is acknowledged fails the task invocation, and the platform retries it — the retried invocation loads terminal + `delivery=pending` and performs *delivery only* (no separate condition tick needs scheduling, and none should exist after a terminal transition). The atomic condition transition prevents duplicate wakes from racing ticks; the delivery state + retry policy prevent the opposite failure — a crash after the transition but before the append cannot lose the wake, because the invocation itself retries. The session action id is outcome-qualified — `watch:{watchId}:{terminalStatus}` (`…:fired` / `…:expired`) — and the receiving side dedups on it, so a crash between append and the delivered-mark cannot produce two narration turns either. **Δ As built:** after the delivered-mark on a *fired* watch, the watcher additionally calls a token-authenticated fired-callback so the webapp can fan out standing alerts (M6.5); a callback failure is logged and never fails the tick — the in-chat wake is the durability contract, the alert is best-effort on top. 

The wake is a structured *session action* (`{type:"watch.fired" | "watch.expired", id:"watch:{watchId}:{terminalStatus}", …}`) appended to `session.in` — the shape #4344's `chat.event` converges on — after which the agent runs exactly one narration turn: state the result, refresh the relevant card, suggest the next step; never start new investigations unprompted. **Δ** The wake message's id doubles as the render key for the **wake banner**: the transcript opens the narration with a toned attention banner — "Watch update — all clear" (green: recovery, drain, run start/finish), "needs your attention" (red: error recurrence), "Watch expired — no answer" (neutral) — so an unprompted message is unmistakable. The streamed narration and its persisted copy share that id, so the panel can never render one wake twice. **Chat deletion:** soft-deleting a chat atomically cancels all its active watches with `reason: chat_deleted`; no wake is emitted; already-scheduled ticks subsequently no-op. 

### Guardrails & UI  
- ≤3 active watches per chat; dedup by `(chat, project, environment, watchIdentity(spec))`; hard TTL ≤ 24h; ticks are LLM-free (a 24h watch ≈ one LLM call, at wake). 
- Chips in the panel header and history list (watching · backlog-drain · email-sends); cancel from the chip; expiry always narrates — a watch never dies silently. 
- **Δ Watch confirmations state the lifetime:** what is watched, the check cadence, that it fires ONCE, and exactly when it gives up — a watch is never open-ended and the user never has to ask. 
- **Δ Notifications (M6.5, ungated):** a wake that lands while the panel is closed raises a persistent in-dashboard toast (the agent Callout — chat icon, manual close, opens the exact chat), lights an unread dot on the chat launcher, and floats the chat to the top of History highlighted; per-chat status icons show what's live (agent working / investigation open / watch active). Read state is per chat (`last_read_at`). 
- **Δ Standing alerts (M6.5, plan+flag gated):** watch fires can also notify through the standard alert channels (email/Slack/webhook) via a dedicated alert type — visible and manageable on the Alerts page, one-click unsubscribe in every email. The agent offers the subscription at watch creation (and after a fire) but creates it only on explicit confirmation, and can list/disable subscriptions on request. The email opens with the same wake-banner headline. When the plan denies alerts, the agent says so plainly — the in-dashboard signal above still always works.  

### How a watch is created — one capability, two adapters 

Only the webapp can create a watch correctly (it holds `SESSION_SECRET`, sets the immutable initiating identity, mints the per-watch token). Creation is **one server capability with authorization kept at the API layer** (rule #5 — the business module never decides permissions): 

```
agent adapter (schedule_watch → UAT-authenticated endpoint)
dashboard adapter — Δ as built: a card's watch button posts a VISIBLE chat
  request ("Watch this for me — tell me when …") answered by the agent via
  schedule_watch; the silent authenticated-action POST was dropped so the
  transcript shows what was asked, the agent confirms the lifetime, and the
  alert offer applies
        ↓ authenticate · authorize user → org/project/environment/chat
        ↓ AuthorizedWatchContext
createWatch(context, spec)
  — guardrails/scoped dedup · persists immutable identity ·
    immediate deterministic check · token mint via injected webapp
    capability · schedules the first tick
  — never receives raw user/project/env, never decides permissions
```
 

> ownership binding — identity is never trusted client input Neither adapter may supply initiating identity as trusted input. **A chat is org+user-scoped, not an immutable env-bound entity** (project/env are per-turn context) — so the API proves the chat belongs to this user AND this organization, then takes project/environment from the *authorized current creation context* (the authenticated turn's injected context on the agent path; the authenticated page context on the UI path), verifies the WatchSpec target is valid inside that environment, and **snapshots the resolved project/environment immutably into the watch row** — rejecting any client-supplied mismatch. `createWatch` receives only the resolved authorized context; a compromised or malfunctioning agent cannot plant a durable wake in someone else's conversation or environment. (The per-tick *watch-check*, by contrast, genuinely re-authorizes — that is a new access moment hours later.) 

The agent path keeps the UAT read-only with respect to the customer environment — a watch is agent-session state, not a customer mutation. **Δ** The UI button now deliberately costs one LLM turn: transparency in the transcript and the alert offer were judged worth it over the free silent POST. 

### Where watches come from  
- Investigation next-action (*Watch for recurrence*) — the flows compose: investigate → conclude → watch → confirm fixed. 
- Direct ask: "tell me when the backlog drains." 
- Queue detail page (per-queue dashboard): *Watch this queue*. 
- Run page waiting-run widget: *Tell me when this run starts* (run_start); long-running runs: *tell me when it's done* (run_finished). 
- Degraded health report footer in chat: *Watch recovery* — **Δ** a real button in the report's *Next steps* row.  

## §3 Deferred — the proactive seed (decided: after this iteration) 

"The answer already waiting": health report goes crit → the system starts an investigation chat itself (head-start machinery already supports server-initiated sessions), so opening the dashboard shows a completed investigation in history. Needs the token-impersonation decision (the alert's creator) + per-org opt-in. Reuses Flows A+B wholesale — only the trigger is new. Lives in the Development Plan's "What's next". 

## §4 How it lands on the roadmap rails   `````````` ``  ``****   

| Rail | What these flows deliver on it |
|---|---|
| TRI-11028 | The failure card, upgraded to hypothesis-verdict grammar; correlateRunsWithDeploy → correlate_version; compareRunSets/findSimilarErrors ship as run_query prompt recipes, promoted to tools only if evals show misuse. |
| TRI-11029 / 11164 | Investigate/Watch buttons are the first contextual intents; evidence citations use the same trigger:// URIs reports use — inline citations done once. |
| TRI-11155 | Code mode gets its killer consumer; the read-only boundary and the dirty-commit honesty rule keep its trust contract intact. |
| Reports doc | get_report as agent grounding (dogfood both ways); a watch is a report-alert-by-condition in personal form; report footers gain watch intents. Δ The report-alert lineage is now literal: watch fires ride the standard alert-channel pipeline (M6.5). |
| AX map / MCP vision | Investigation card ≅ ReportVM; watches seed the durable-resident-agent and subscribe-and-react shapes; the self-healing loop = Flow A → (propose-fix) → approval-first replay (TRI-11031) → Flow B verification. Each phase ships value alone. |
| Evals (TRI-11158…) | Golden investigations are the first structured-output evals; wake narrations are judged by the existing per-turn judge (tagged). |
 

## §5 Considered and not chosen  
- **`deploy_verdict` watch in v1** — no defined deterministic predicate yet; deferred with the regression-report work rather than letting the model improvise what "deploy is clean" means. 
- **Structured propose-fix flow** — out of scope (diff view block, its own evals, PR path). *User-triggered Show code text diffs are in scope* — the boundary is automation and structure, not the diff itself. 
- **Morning digest / Slack push** — right shape (Advisor), wrong iteration; watches prove the wake mechanics first. **Δ** Partially superseded: M6.5's standing alert channels already push watch fires to email/Slack/webhook; the digest shape remains future work. 
- **Cost-anomaly explainer** — wants the cost report; the investigation grammar absorbs it later. 
- **GitHub PR creation** — zero write plumbing exists; Phase 2 with approval gates. 
- **Free-form LLM in a ⌘K palette** — deterministic palette deferred entirely; chat is the LLM surface.  

Research: chat.agent primitive matrix · code-mode map · Linear deep read (TRI-11028/11029/11155/11026/11030/11460; Reports/AX/MCP docs) · competitive scan (Datadog, Sentry Seer, Copilot agent, Vercel, Grafana, incident.io, PagerDuty; Temporal/Inngest/Upstash have no dashboard agent). Companions: [Development Plan](https://claude.ai/code/artifact/d075c936-3d52-4d27-915b-be0f3de95a6e) (canonical execution spec) · [Current State & Design](https://claude.ai/code/artifact/08e0f0d4-c1cb-4f11-9a6e-1aa2cdc5d3c6) (audited base).
