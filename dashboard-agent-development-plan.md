# Dashboard Agent — development plan

dashboard agent · development plan · v3.1 canonical · updated 2026-07-30 
# Build plan: Investigate · Watch · navigation · docs · smart prompts · reports 

Feature milestones M0–M7, one PR each (8 PRs total). Visual work leads. Branching from [feat/report-health (#4327)](https://github.com/triggerdotdev/trigger.dev/pull/4327). 

>  **Document authority**  
- **Development Plan (this document)** — canonical for scope, sequencing, contracts, PR boundaries, implementation constraints, and acceptance criteria. 
- **[Current State & Design](https://claude.ai/code/artifact/08e0f0d4-c1cb-4f11-9a6e-1aa2cdc5d3c6)** — canonical for audited existing behavior at the pinned commit. If implementation HEAD has drifted, verify only the seams the current milestone touches; do not repeat the full audit. 
- **[New-type Flows: Feature Design](https://claude.ai/code/artifact/88c5720a-8bf8-4069-9b6f-2cb09d67f2da)** — canonical for user behavior, UX semantics, trust model, product rationale. It does not define build sequencing.  **Conflict rule:** when companion documents disagree on an implementation detail, do not merge both interpretations — follow this document and update the stale companion text in the same PR.  

>  **Δ As built — execution deltas (2026-07-30, binding updates)**  
- **PR strategy changed by the product owner:** one stacked draft PR — [#4418](https://github.com/triggerdotdev/trigger.dev/pull/4418) — carries M0–M6.5 (M0+M1 were combined first, then M2–M6 continued in the same PR). Design-review UI fixes landed as commits inside it, not separate PRs. M7 remains open. 
- **Branching:** forked from `feat/queue-metrics-and-health` (a superset of feat/report-health); after queue-metrics squash-merged to main, main was merged back in and the PR retargeted to `main`. 
- **M1 demo mode was superseded:** demo chats were removed in favor of a seeded live playground project (`db:seed:agent-examples` — real runs/errors/queues/deploys, live trigger:// links, example conversations, `--heartbeat/--degrade/--recover` stand controls). Fixture matrices live only in the storybook gallery. The heartbeat is a review-stand crutch removed before merge. 
- **Suggested prompts:** five slots, ordered promoted → investigate → watch → explain-page → docs (was "cap 4"). 
- **Evidence input boundary (M5):** the model cites bare resource ids (`evidenceRefSchema`); the render_view executor canonicalizes them into `trigger://` URIs (the model never holds the environment id). Persisted/emitted contracts stay strict. 
- **M6 delta:** a card's watch button posts a *visible chat request* answered via `schedule_watch` (the silent dashboard-adapter POST was dropped for transcript transparency and the alert offer); wake messages render under a toned **wake banner**; confirmations must state cadence, fires-once, and the expiry. 
- **NEW — M6.5 shipped (alerts & notifications):** standing alerts via a `DASHBOARD_AGENT_WATCH` alert-channel type (email/Slack/webhook, one-click unsubscribe in every email, visible on the Alerts page), agent tools `list_alerts/create_alert/delete_alert`, offer-at-creation and after-fire (explicit confirmation only), plan+flag gated; the in-dashboard signal is *ungated*: persistent wake toast (agent Callout), unread dot on the launcher, unread-first highlighted history, per-chat status icons, `last_read_at`. 
- **Chart blocks gained optional `actions`** (≤3; ask / navigate with a canonical URI, non-parsing targets cost the button not the call); ranking questions are answered in prose with the winner named — the chart illustrates. 
- **Chat rendering semantics:** in-flight tools are pending pills (no streamed input JSON); completed tool calls render nothing (failed ones keep their error row); one live status element at a time; latest-wins for investigation revisions applies transcript-wide. 
- **Navigation shipped end-to-end:** a host resolve endpoint turns `trigger://` targets into dashboard paths and the panel navigates SPA-style (rule #3 held — no raw paths anywhere).    

## §0 Inherited estate — audit results 

### Merged and solid (build on it, don't re-audit) 

[#4018](https://github.com/triggerdotdev/trigger.dev/pull/4018) plus follow-ups: #4050, #4053, #4054/#4032/#4037/#4069 (agent DB), #4128 (version pin), #4133, #3834, #3882, #3891. Code mode (TRI-11155) largely in main: `repo-tools.ts`, run→SHA pinning, the `repo/snapshot` route. 

### Open PRs — decisions   [](https://github.com/triggerdotdev/trigger.dev/pull/4344)`````` [](https://github.com/triggerdotdev/trigger.dev/pull/4349) [](https://github.com/triggerdotdev/trigger.dev/pull/3856) [](https://github.com/triggerdotdev/trigger.dev/pull/4131) 

| PR | What | Call |
|---|---|---|
| #4344 | Hosted webhooks, agent channels (Slack), chat.event, HITL approve/deny | coordinate Watch's wake message is a session action ({type:"watch.fired",…}) so it converges with chat.event.onAction when #4344 lands. Do not depend on it. |
| #4349 | Resume-stream perf | adopt when merged No code coupling. |
| #3856 | Realtime host routing (cloud infra) | ignore |
| #4131 | Queue metrics + health dashboard | rule below |
 

**#4131 rule (binding):** if #4131 is not merged when a milestone that touches queues starts, implement the server capability against the existing `queue_metrics` source, but do *not* add UI entry points that require #4131's pages. M3/M5/M6 acceptance must not depend on the open PR unless it has merged; queue-page entry points move to a follow-up commit that lands after it. 

### Abandoned branches — reference only, never merge 

`origin/webapp-dashboard-agent{,-api}` (Dan, Jun 4–5, old AskAI surface). Mine for tool shapes; never merge code. 

### External dependency 

`ask_support` requires `SUPPORT_ASK_URL/SECRET`. **Config gate, not a maybe:** the docs lane ships as `search_docs` (always available); `ask_support` is enabled iff its env vars are present, and its verification line applies only in an env where they are. 

## §1 Git & PR strategy  
- Branch `feat/dashboard-agent-flows` from `feat/report-health` (#4327). Rebase onto main when #4327 merges — early, not at the end. 
- **Superseded (see Δ): shipped as one stacked draft PR (#4418) for M0–M6.5.** Original rule — exactly 8 feature milestone PRs, one per milestone — PRs may be big; each is independently demoable and revertable and carries its milestone's Verification checklist in the description. **Design-review-only UI fixes may land as small independent PRs and do not count toward the milestone PR total** — they must remain webapp/UI-only and cannot change frozen contracts or milestone dependencies. 
- Commits scoped by surface, never mixed: `reports:` / `agent:` / `webapp:`. Cherry-pick map (hashes by concern) maintained in each PR description.  

## §1½ MCP-readiness rules — write to the surface, not the transport   ****```` **``** **``**** **** **** 

| # | Rule | Payoff |
|---|---|---|
| 1 | Logic lives in transport-independent server modules taking AuthenticatedEnvironment (or, for watch-check, a resolved initiating identity) — ReportPresenter.call() is the template. Remix routes are thin adapters. | Server MCP = a second adapter over the same module. |
| 2 | tools.ts never contains logic — fetch wrappers over API routes only. | Parity by construction. |
| 3 | trigger:// URIs everywhere: evidence, report links, and intents carry URI strings; hosts resolve them to URLs at render time. No agent-visible surface ever emits a raw dashboard path — including navigation. | Future MCP resources are addressed by the same URIs; citations become live pointers. |
| 4 | Pure block components (props in, no Remix hooks); the intent envelope is a serializable discriminated union; the host routes intents. | Same components mount in MCP-UI. |
| 5 | Authorization only at the API layer; new-tool scopes in one constant. | MCP clients enter the same gate. |
 

**Acceptance test (every milestone):** every new capability is reachable via `curl`. 

## §2 Standing rule — the populated mockup leads 

Design team ask (verbatim): *"Review all data outputs for rich content components (charts, etc.) — Eric has built some rough components; need a full audit before launch. Capture screenshots of every chat state to draw on top of and plan improvements."* 

**Execution model for this iteration:** M1 delivers the *entire* agent experience as a populated mockup behind the feature flag — every flow, every card, every state, on dummy data, clickable in the real dashboard — plus a playbook and the screenshot pack. The whole team (designers first) reviews visuals, buttons, and branding against it **while backend work across M2–M6 proceeds in parallel where allowed by the dependency graph (§3)**. Later milestones replace dummy data with real behavior under an already-reviewed UI; every milestone still refreshes the gallery + pack before its PR is assembled. Design feedback lands as small independent UI-only PRs (outside the 8-PR milestone count, per §1) at any time without blocking backend work. 

## §2½ Standing rule — token economy   **** **** **** ****`` **** **** **** 

| Rule | Mechanism | Where |
|---|---|---|
| LLM only narrates; facts are computed. | Reports, ETA/drain math, watch conditions, waiting-run cause, version correlation — deterministic server code, curl-able with zero LLM. The model reads dense precomputed payloads and adds one short narration. | M2/M5/M6 |
| Watch ticks are LLM-free. | One deterministic check per tick; the model runs once, at wake/expiry. A 24h watch ≈ 1 LLM call. Asserted via run logs in M6 verification. | M6 |
| Caching stays intact. | Protocol prompt text goes into the cached system block / managed prompt — never per-turn dynamic text that busts the prefix cache. Reviewed on every prompt PR. | M5 |
| Caps hold the ceiling. | stepCountIs(10), trace ≤60 spans, query ≤200 rows; hypotheses 2 by default, ≤4; parallel evidence calls (see M5 step budget). | M5 |
| Per-turn evals get a sample rate. | Env-var gate (default 1.0) on the Sonnet judge trigger — the biggest hidden token sink at scale. | M0 |
| Cheap models for cheap jobs. | Titles already Haiku; wake/waiting narrations are Haiku candidates via the managed-prompt model field — decided in M7 tuning, dashboard edit, no deploy. | M7 |
| No ambient LLM. | Prompts registry, deep-links, chips, gallery — deterministic. Only explicit user actions (send, Investigate, Show code, watch wake) spend tokens. | M3/M4 |
  

## §M0 Foundation: bring-up, contracts, spike · PR 1 of 8 

>  

#### Goal 

A chat turn round-trips locally; all shared contracts exist as merged code with exactly one canonical definition each; **all foundational unknowns have written verdicts** (token scopes, queue position, environment identity, queue-wait timestamp). **Execution order inside M0: complete the three spikes before implementing/finalizing `triggerUri` — the environment verdict is part of the contract freeze.** 

#### Preconditions 

Branch created from feat/report-health; local stack per AGENTS.md; `DASHBOARD_AGENT_*` env vars set; agent project running via `trigger dev`. 

#### Build  
- **Bring-up + SETUP note:** full turn E2E, resume after refresh, head start, mode fallback. Seeded scenarios: degraded report env; one failed run with a known code-level cause; one queued run; one long-running run. 
- **Scope-check verdict:** confirm the UAT exchange mints `read:query` satisfying the reports route's `everyResource`. Audit says yes — verify once, write the verdict in the PR. 
- **Spike — three written verdicts:** (a) per-run queue-position source in existing data — prove or disprove (M5's waiting-run acceptance does *not* assume it); (b) the stable unique environment identifier incl. preview (freezes the URI `{env}` segment); (c) the canonical "time waiting to start" timestamp (`queuedAt`/equivalent) — if none exists, `startedAt − createdAt` is labeled "time from creation to start", never "queue/start latency". 
- **Contracts, frozen now (architecture-level):**  
  - `triggerUri` module with the full v1 grammar and pinned identity semantics: 

```
{proj} = the project's external ref ("proj_…") — rename-stable, matches API projectRef
{env}  = NOT frozen on a name — the M0 spike must answer: "what existing stable
         identifier uniquely identifies the concrete environment, INCLUDING
         preview environments?" (the audit shows preview branches aren't
         threaded; a bare "preview" name is not unique). If a stable environment
         ref/id exists, use it and keep names display-only; if the API verifiably
         guarantees (projectRef, environmentName[, branch]) uniqueness, freeze
         that as a written invariant instead. Grammar below is frozen; the {env}
         segment's resolution freezes with the spike verdict.
segments that carry arbitrary values (queue names, fingerprints) are
  percent-encoded path segments; a source {path} preserves "/" separators and
  percent-encodes each individual path segment

trigger://{proj}/{env}/run/{id}
trigger://{proj}/{env}/run/{id}/span/{spanId}
trigger://{proj}/{env}/error/{fingerprint}
trigger://{proj}/{env}/queue/{name}
trigger://{proj}/{env}/deployment/{version}
trigger://{proj}/{env}/report/{key}
trigger://{proj}/{env}/source/{sha}/{path}?line={n}
trigger://{proj}/{env}/investigation/{id}
```
 
  - **Intent envelope** — discriminated union, serializable: 

```
type AgentIntent =
  | { kind: "navigate";    target: TriggerUri; filters?: RunFilters }
  | { kind: "ask";         prompt: string }
  | { kind: "watch";       spec: WatchSpec }
  | { kind: "propose_fix"; investigationId: string }
    // RESERVED for the structured-diff iteration.
    // MUST NOT be emitted or executed in M0–M7 (Show code uses "ask");
    // hosts may explicitly reject the reserved variant in their switch.
```
 
  - **WatchSpec** — discriminated union; cadence constraints are schema-level, not comments; `since` is never model input (server sets it to watch creation): 

```
type RunStateCadence = { checkEveryMinutes: 1 | 5 | 15 | 60 };
type StandardCadence = { checkEveryMinutes: 5 | 15 | 60 };
type WatchCommon = { maxHours: number /* ≤24 */; note: string };

type WatchSpec = WatchCommon & (
  | ({ kind: "run_start";        runId: string }        & RunStateCadence)
  | ({ kind: "run_finished";     runId: string }        & RunStateCadence)
  | ({ kind: "backlog_drain";    queue: string }        & StandardCadence)
  | ({ kind: "error_recurrence"; fingerprint: string }  & StandardCadence)
    // persisted spec gains server-set `since = watch.createdAt`; not in the tool schema
  | ({ kind: "health_recovery";  report: "health"; fromSeverity: "warn" | "crit" } & StandardCadence)
);
// deploy_verdict is NOT v1 (What's next)
// watchIdentity(spec) = the condition within an environment: "run_start:run_123" · …
// active-watch dedup key = (chatId, project, environment, watchIdentity(spec))
//   cadence/note/TTL are not part of identity
// deterministic checks return: pending | satisfied | terminal_unsatisfied | unavailable
```
 
  - **Block envelope** — `{ type, id, revision, version }` on every *newly emitted* view block + lenient parsing. **Legacy migration rule:** existing `chart`/`diagnosis` blocks in stored transcripts/snapshots remain parseable — `id/revision/version` are optional for legacy payloads; a missing `id` means "non-revisable block", rendered in transcript order. All newly emitted blocks MUST carry the v1 envelope. **id semantics (frozen):** `ReportBlock.id = the source tool-call id, revision = 0` — every report snapshot is a separate immutable historical block (latest-wins must never let a fresh health report overwrite an old card in the transcript); `InvestigationBlock.id = investigationId, revision increasing` — an investigation is the progressive entity. The *envelope* freezes now; **investigation payload stays provisional until the M1 design pass and freezes before M5**. 
  - **`investigations` table** (dashboard-agent-db): `id PK · chatId · projectRef · environmentRef · revision · state jsonb · createdAt · updatedAt` — decided now, not left as "chat metadata record": a global `trigger://…/investigation/{id}` lookup must not require knowing the chatId or scanning jsonb. **Identity plumbing (explicit):** the table stores the *same canonical identifiers the `trigger://` scheme uses* — `projectRef` = the external ref, `environmentRef` = the M0 spike's environment-identifier verdict — sourced from the turn's server-injected clientData. **M0 updates the server-injected turn context to carry the canonical environment identity selected by the spike; downstream code never reconstructs it from `environmentName`** — otherwise the spike would pick the right identity while the transport stayed on the old one. 
  - **Evidence item** — `{ kind, uri: TriggerUri, label, excerpt? }`. No free-form `reference: string`. 
  - **`AgentPageContext`** — page identity + a *signals* layer, so M4 consumes facts the page loader already computed instead of raw rows (and never forces a contract change after freeze). ONE exposure mechanism: typed route `handle` read via a `useMatches()` mapper — decided; no per-route hacks. 

```
type AgentPage =
  | { kind: "runs";       filters?: RunFilters }
  | { kind: "run";        runId: string; status: string; taskId: string; queue?: string }
  | { kind: "error";      fingerprint: string }
  | { kind: "queue";      name: string; health?: "ok" | "warn" | "crit" }
  | { kind: "deployment"; version: string }
  | { kind: "other";      path: string };

type AgentPageSignal =
  | { kind: "fresh_failure"; runId: string; failedAt: string }
  | { kind: "waiting_run";   runId: string; queue?: string }
  | { kind: "slow_run";      runId: string; durationMs: number; baselineP95Ms: number }
  | { kind: "concurrency_saturation"; severity: "warn" | "crit" };

type AgentPageContext = { page: AgentPage; signals: AgentPageSignal[] };
```
 Pages/loaders decide which facts they already have and emit signals; the prompt registry consumes them deterministically. **Transport (frozen):** `DashboardAgentPanel` derives `AgentPageContext` from the `useMatches()` mapper and sends the full value as turn `clientData` on *create and every subsequent turn* (the user may navigate mid-chat); the head-start path receives the same context on the first message so cold and head-start behave identically. 
  - **Launcher context** gains `openWith(text)`; **suggested-prompts registry** shape; **`watches` table** schema: `id · chatId · spec jsonb · status · deliveryStatus (not_required|pending|delivered — not_required while active and for all cancelled outcomes; only fired/expired notify) · createdAt · expiresAt · lastCheckedAt · firedAt · deliveredAt · cancelledAt · lastResult jsonb` — plus immutable `organizationId/projectId/environmentId/userId` (the initiating identity the watch-check endpoint re-authorizes; a watch remembers what it observes regardless of the user's current page).  
- **Head-start silent-loss fix** (moved here from M1 — it's a server reliability fix, not visual work): a failed warm step surfaces an error turn to the client instead of an empty resumed stream (`dashboardAgentHeadStart.server.ts`). 
- Eval sample-rate gate (env var, default 1.0) on the per-turn judge (§2½). 
- Doc hygiene: stale "No tools yet" comment; db README missing `chat_turn_evals`.  

#### Invariants / non-goals 

No feature UI, no prompt changes beyond hygiene. Contracts compile and are exported from final homes; consumers come later. The investigation payload shape is explicitly NOT frozen here. 

#### Verification (agent gate)  
- SETUP note reproduces bring-up on a clean env; scope + spike verdicts written in the PR. 
- Contracts typecheck; `triggerUri.parse(format(x)) === x` round-trip tests; WatchSpec/AgentIntent exhaustiveness tests; cadence constraint is schema-enforced (a 1-minute `backlog_drain` fails validation). 
- Legacy hydration test: a conversation containing pre-M0 `diagnosis`/`chart` blocks (no envelope) renders correctly. 
- Head-start failure path shows an error turn (forced warm-step failure test). 
- Sample-rate gate honored (0.0 → no eval task triggered, asserted in a unit test).   

## §M1 The populated mockup: demo mode + gallery + playbook + screenshots · PR 2 of 8 · the design handoff 

>  

#### Goal 

Anyone on the team, with the flag on, opens the real dashboard and **clicks through every v1 case defined by this plan — on dummy data**: investigations (incl. the Investigate UI end-to-end), navigation answers, prompt-aware links, watches, reports, Show-code diffs. A playbook lists every case; the gallery + screenshot pack capture every state. This is the populated mockup handed to designers — they iterate on buttons and branding against it while backend work proceeds in parallel per the dependency graph. 

#### Preconditions 

M0 contracts (fixtures are typed against the envelope, AgentIntent, WatchSpec, AgentPageContext — dummy data exercises the real contracts, so "swap dummy for real" later changes data sources, not components). 

#### Build  
- **Demo mode behind the flag:** a fixture-conversation layer — canned transcripts (typed `UIMessage[]` with real tool parts) rendered through the *real* panel components, no transport, no LLM. Surfaced as demo chats in the panel history ("Demo · Investigate a failed run", "Demo · Watch a queue", "Demo · Ask about health", …), gated by a demo flag alongside `canAccessDashboardAgent`. 
**Isolation guardrails (normative):** demo fixtures never reach real chat/watch/navigation/eval routes — `demo:*`-namespaced ids everywhere; a local intent interceptor (demo intents render their outcome, never call real actions/navigation); **zero persisted writes** — no chats/watches/investigations rows, no evals, no analytics events from demo sessions. The mockup deliberately lives inside the real dashboard; these guardrails are what make that safe. 
- **Full case coverage as fixtures — the whole experience, not just components:**  
  - *Investigate:* entry buttons on dummy run/error/queue contexts · card streaming (testing chips flipping) · concluded (What happened / How to fix) · inconclusive (What we know / What to check next) · Show details expanded · Show code posting a dummy diff into the chat · dirty-commit caveat variant. 
  - *Navigation:* dummy answers where the agent "navigates" — the navigate-intent bubble ("Opened runs filtered to failed · last 24h") and deep-link rendering. 
  - *Prompt-aware links:* suggested prompts per page kind with dummy signals — fresh-failure first, waiting-run, slow-run, saturation; promoted slot + dismissed state. 
  - *Watch:* chips in header/history, wake narration, expiry narration ("couldn't verify at expiry" variant too), cancel affordance. 
  - *Reports:* card from canned VMs (healthy + degraded), footer intents; charts; docs answer with sources. 
  - *Base states:* empty/first-open, streaming, tool-call in flight/expanded, error turn + retry, resumed chat, history states, banner variants, composer/draft.  
- **State gallery stays** (storybook.agent-ui rebuilt): the same states as an isolated per-component matrix — the gallery is for pixel-level design work and the screenshot script; demo mode is for flow-level review. Both are fed by the same fixture set (one source of dummy data). 
- **Playbook** — a short doc (linked from the PR and the demo history header): every case, one line each — what to open, what you should see, what feedback we want. Colleagues review systematically, not by wandering. 
- **Rich-content audit fixes** (Current State §10 UI punch list): composer autofocus/aria; currentPage unification via page-label map; delete confirm + error handling; active-chat title; cold-start prompt flash; run-id regex + light-theme badge palette; AgentChart hardcodes + error-text sanitization; "Thinking…" through tool calls; retry-on-error. 
- **Grouped rendering** — latest-wins by `(type, id)`/revision, proven with three mock revisions of one investigation (demo chat + gallery state). 
- **Screenshot pack:** Playwright walks the gallery *and* the demo chats, light+dark PNGs, one command, manifest listing every state/case.  

#### Invariants / non-goals 

No real backend/agent behavior — fixtures only (the head-start server fix already landed in M0). Investigation payload may still adjust from design review — it freezes at the end of this milestone's review, before M5. 

#### Verification 

**Agent gate:** with the demo flag on, every playbook case is reachable by clicking in the real dashboard; gallery renders all manifest states; one command regenerates the full pack (gallery + demo); three mock revisions render as ONE card; no console errors; **isolation asserted:** a demo session produces zero rows (chats/watches/investigations/evals) and zero real intent/navigation calls — verified by test; PR links playbook + pack. **External gate (not agent-blocking):** team walkthrough done, design annotations collected, investigation-payload freeze recorded. The PR merges on the agent gate.  

## §M2 Reports spine · PR 3 of 8 

>  

#### Goal 

The agent grounds "is something wrong?" in the deterministic report, and the user sees the real report card in chat with working intents. 

#### Preconditions 

M0 (triggerUri, intent envelope, scope verdict); M1 gallery exists for state additions. 

#### Build  
- `get_report` tool (fetch `/api/v1/reports/:key?format=json`) + prompt guidance incl. `facts.trustworthy` handling. 
- `resolveTriggerUri(env, uri) → {label, url}` server module; report `links[]` become URIs resolved at render (no more empty strings). 
- `<ReportView vm onIntent>` — pure component; footer actions emit AgentIntents (navigate / ask / watch). 
- `ReportBlock` — **rendering mechanics decided (option B, one rich-content architecture):** a deterministic client adapter converts the completed `tool-get_report` part's output into a synthetic `ReportBlock { type:"report", id: sourceToolCallId, revision: 0, version, vm, reportUri, asOf }` (immutable snapshot — per the M0 id-semantics rule) and feeds it through the shared `ViewBlocks` registry → `<ReportView>`. The LLM never reconstructs VM fields; grounding and card render the *same snapshot* (one fact, two consumers — no second fetch that could disagree with the narration seconds later; unlike AgentChart, which is deliberately live, report evidence needs snapshot consistency); and the view catalog stays the single registry the gallery exercises. `{reportUri, asOf}` serve addressing/refresh ("view latest" intent) and the future MCP resource.  

#### Invariants / non-goals 

ReportView imports no Remix hooks (grep-checked). No report-content changes (that's #4327's domain — keep `reports:` commits clean for cherry-picks). 

#### Verification (agent gate)  
- "How is prod doing?" → rendered report card; footer intents navigate correctly. 
- `curl` returns the VM; every link URI resolves to a real path. 
- Eval smoke: report fetched for an is-anything-wrong question; no action advice when `trustworthy:false`. 
- Gallery/pack refreshed with real report states.   

## §M3 Navigation, docs & tool batch · PR 4 of 8 

>  

#### Goal 

The agent can take you places (URI-addressed, filter-precise), read docs, and has every read tool Investigate/Watch need. 

#### Preconditions 

M0 contracts; #4131 rule consulted for queue endpoints. 

#### Build   ****```` `` ``  ```` `` 

| Tool | Mechanism |
|---|---|
| navigate_to | URI-based, per rule #3: the tool emits {kind:"navigate", target: TriggerUri, filters?} — never a raw dashboard path. The panel host resolves URI+filters to a URL (runs filters are URL params) and calls navigate(); a future MCP host resolves the same intent its own way. Whitelist = the URI grammar itself. |
| get_current_page | Exposes AgentPageContext (already in clientData) + prompt guidance. |
| search_docs | Port of the existing MCP tool. Docs lane baseline; ask_support stays config-gated. |
| list_deploys / get_deploy | Thin fetch over deployments API. |
| correlate_version | New route (e.g. …runs.$runId.commit.ts): resolveRunCommit + GitMeta (message, PR#, title, dirty). Extract the shared UAT-auth preamble helper (currently triplicated) — do not add a 4th copy. |
| get_queue | Queue depth/throughput/throttled over queue_metrics — server capability regardless of #4131's UI. |
 

Each: schema → registry maps (key order = head-start order) → execute wrapper → prompt line → scope entry in the single cap constant → eval TOOL_CASE + fixture. 

#### Invariants / non-goals 

No write tools. No logic in tools.ts. No raw paths anywhere in agent-visible output. 

#### Verification (agent gate)  
- "Show me failed runs of <task> in the last 24h" ends on the correctly-filtered runs page, via a navigate intent whose target is a `trigger://` URI (asserted in the transcript). 
- `correlate_version` answers with commit + PR metadata for the seeded deploy — in chat and via curl. 
- search_docs answers a how-do-I question; ask_support verified iff creds present. 
- Tool-selection evals green with new cases.   

## §M4 Suggested-prompts system · PR 5 of 8 

>  

#### Goal 

Prompts are page- and state-aware, with a product-controlled promoted slot — and the fresh-failure path funnels into Investigate. 

#### Preconditions 

M0 (`AgentPageContext` + route-handle mechanism, registry shape, openWith). 

#### Build  
- Registry keyed by `page.kind` (labels from TRI-11029); resolver `(context: AgentPageContext) → SuggestedPrompt[]`, ordering promoted → contextual → default, five slots (see Δ). 
- Contextual prompts consume **`context.signals`** (M0 contract — pages emit facts their loaders already computed, no extra queries): `fresh_failure` → "Investigate run_x — failed 4m ago" first; `waiting_run` → "Why is this run waiting?"; `slow_run` → "~4× slower than usual — investigate?"; `concurrency_saturation` → "Explain current saturation". State-driven rule: signals are emitted only for abnormal state. 
- Promoted slot: typed config read through a feature-flag JSON value (swap without deploy); dismissable per user (localStorage).  

#### Invariants / non-goals 

Zero LLM involvement; zero added queries (page loader data only); prompts component consumes the registry, no inline lists. 

#### Verification (agent gate)  
- Prompts change across runs/run/error/queue/deployments pages (gallery states per kind). 
- Seeded fresh failure → Investigate prompt first; click sends the full prompt via openWith. 
- Flag-value change swaps the promoted prompt without deploy; dismiss persists. 
- Gallery/pack refreshed.   

## §M5 Investigate · PR 6 of 8 

>  

#### Goal 

One click on a failure yields a hypothesis-verdict investigation card with citation-grade evidence — honest under truncation, degradation, and the step ceiling. 

#### Preconditions 

M2 (report grounding), M3 (correlate_version, list_deploys), M1 design pass on the investigation card → **payload frozen here, before implementation**. 

#### Build  
- **Protocol prompt** (managed, cache-safe) encoding, verbatim rules:  
  - Baseline evidence calls issued in parallel where independent. 
  - Reserve at least two model steps for hypothesis testing + conclusion. 
  - Default to 2 hypotheses; expand up to 4 only when evidence and remaining step budget justify it. 
  - Conclude or explicitly return inconclusive before the 10-step ceiling. 
  - Truncated evidence supports positive observations only — never absence claims; missing evidence ≠ disproven hypothesis. 
  - Code-grounding degradation matrix (Feature Design §1), incl. `dirty:true` → "nearest repository snapshot", never "exact deployed code". 
  - Confidence policy: high = direct evidence + corroboration; medium = correlation, causal link incomplete; low → folds into inconclusive.  
- **Investigation block** (payload frozen after the M1 design pass), **answer-first, two disclosure levels, conditional on outcome**: a *concluded* card collapses to *What happened* + *How to fix*; an *inconclusive* card collapses to *What we know* + *What to check next* — never a fix for an unvalidated cause; *Show details* expands hypotheses/verdict chips/evidence (`{kind, uri, label, excerpt?}`) + source excerpt — pure client-side, zero LLM; ***Show code* posts the potential diff into the chat** — an `ask` intent with a canned prompt, one agent turn emitting a fenced diff (minimal, cites `file:line@sha`, dirty caveat; rendered by the existing markdown/CodeBlock path — the structured diff block stays next-iteration, and the `propose_fix` intent kind stays reserved for it). **Visibility (strict, per Feature Design):** *Show code* appears only when concluded + code-addressable cause + the file was actually read at the pinned snapshot + a concrete location is in the investigation state; hidden for inconclusive, assistant mode, operational/config causes, unavailable source; dirty commit allowed with the caveat. 
- **Fix-suggestion hygiene in the protocol prompt:** a suggested change is minimal, cites `file:line@sha`, is never offered without the file actually read, carries the snapshot caveat on a dirty commit — plus one eval case judging a Show-code diff for exactly these properties. 
- **Entry points** via openWith: run page error section; error group header; queues list warn/crit rows ("Investigate this queue" — flow cause tree scoped to one queue; #4131 rule applies to placement); Concurrency page "Explain current saturation" (severity-driven). 
- **"Why is this run waiting?"** on the run page queue widget. Deterministic module (curl-able), conditional contract:  
  - *Always* compute: current queue depth, current scheduling delay, observed throughput, and the diagnosed limiting cause (throttled / env-limit pinned / stall). 
  - *Queue-drain ETA* (formula, in the module: `pending / observed dequeue rate` over the recent window) — only when a trustworthy dequeue rate exists; presented as "queue drains in ~N min", never as a promise about this run. 
  - *Per-run start ETA* — only if the M0 spike proved sufficient ordering/position information (queues aren't guaranteed simple FIFO — priorities/concurrency keys break depth÷throughput math). Otherwise explicitly omitted.  Widget may show the deterministic lines without the agent; the button opens a narration over precomputed facts. 
- **Investigation identity is system-owned (never model-owned):** the `render_view` executor assigns `investigationId` on the first render (persists revision 0, returns the id to the model); subsequent renders verify same chat/project/env, atomically assign the next revision, upsert the `investigations` record, and emit the canonical block. The model reports state, never authority fields. 
- **Investigation persistence:** each committed revision upserts the `investigations` table (M0 schema) — `trigger://…/investigation/{id}` resolves without knowing the chatId; no jsonb scans, no transcript archaeology. 
- **Golden evals** (seeded scenarios): env-limit saturation → flow cause; schema-drift failure → code-grounded cause; flaky upstream → inconclusive; **dirty-deploy scenario → snapshot-honesty wording**; truncation scenario → no absence claim. Every golden investigation finishes ≤10 steps.  

#### Invariants / non-goals 

**No automatic diff generation, no structured diff block, and no writes — a user-triggered Show code turn producing a fenced text diff is explicitly in scope.** No GitHub writes, no new watch kinds. The card payload does not change after freeze without a version bump. Prompt additions live in the cached block. 

#### Verification (agent gate)  
- Seeded schema-drift failure → card whose *collapsed* view answers "what happened" + "how to fix" in prose without showing hypotheses; *Show details* expands ≥2 tested hypotheses with the validated code-grounded cause and a source URI resolving to the GitHub blob at the SHA (expansion is client-side — zero LLM, asserted); working intents. 
- *Show code* on the same scenario posts a fenced diff into the chat that is minimal, cites `file:line@sha`, and matches the actually-read file (the hygiene eval case); the button is absent in assistant mode. 
- Flaky-upstream → inconclusive with ruled-out causes; dirty-deploy → snapshot wording present; truncation → no absence assertion (evals assert all three). 
- Waiting-run answer contains depth + delay + cause always; drain ETA when computable; per-run start ETA only when supported by the M0 spike verdict — precomputation verified via curl with zero LLM. 
- Latest investigation state readable by `investigationId` after the chat turn ends (persistence check). 
- Identity-safety tests: a model-supplied or malformed id/revision cannot overwrite another investigation; concurrent revision commits produce monotonically increasing revisions. 
- Three revisions of one investigation render as one card (real path, not mock). 
- Golden evals green in CI; ≤10 steps each; no hallucinated-id signals. 
- Gallery/pack refreshed with real card states.   

## §M6 Watch · PR 7 of 8 

>  

#### Goal 

The agent keeps promises across hours — with a complete auth story, a real state machine, and deterministic per-kind semantics. 

#### Preconditions 

M0 (WatchSpec, watches table), M2 (report json path), M3 (get_queue). M5 only for the investigate→watch entry; other entries are independent. 

#### Build  
- **Creation — one capability, two adapters, authorization at the API layer (Feature Design §2, rule #5):** adapters authenticate and authorize (user → org/project/environment/chat) and hand a resolved `AuthorizedWatchContext` to `createWatch(context, spec)`, which does guardrails/scoped dedup, persists the immutable identity, runs the immediate check, mints the token via an injected webapp capability, and schedules — *never* receiving raw user/env or deciding permissions. **Ownership binding (normative):** neither adapter supplies initiating identity as trusted input — the API proves the chat belongs to this user AND org, then (a chat is org+user-scoped, *not* env-bound) takes project/environment from the *authorized current creation context* (agent path: the authenticated turn's injected context; UI path: the authenticated page context), verifies the spec target is valid in that environment, and **snapshots project/environment immutably into the watch row**; any client-supplied mismatch is rejected. Adapter 1 — **`schedule_watch` tool**, following the standard new-tool contract in full: schema → head-start registry (key order!) → fetch wrapper → prompt guidance → TOOL_CASE + eval fixture. Adapter 2 — **UI intent** `{kind:"watch", spec}` → dashboard-authenticated action, no LLM round-trip. 
- **Auth (normative, Feature Design §2 — mechanism frozen):** watchers never persist a UAT or env JWT. At watch creation the webapp mints a *signed internal watch token* (`client:"dashboard-agent-watch"`, `watchId` claim, **`exp = expiresAt + a bounded grace period`** — the token outlives `expiresAt` so a delayed tick can still perform the *final expiry check*; the endpoint never permits ordinary checks after `expiresAt` and permits only the final expiry evaluation during the grace window; the watch *row*, not token expiry, is the authority on whether environment reads are allowed); each tick presents it to the private watch-check endpoint; the webapp verifies signature + watchId match, then **re-authorizes the initiating user against the watch's immutable project/environment through the same current authorization path as an interactive dashboard request**, then applies the feature gate, then runs the deterministic check through transport-independent modules. **Signing:** a dedicated watch-token sign/verify helper using `SESSION_SECRET` with a distinct token type/audience; the watch-check endpoint accepts only this type, and UAT verification paths must reject it (no new secret; capability disjoint from user-actor tokens). Not a user credential; capability bounded to one watch. Access revoked → atomic transition to `cancelled(access_revoked)`, no environment data read, no wake. 
- **Watcher task** (`dashboard-agent-watch`, eval-turn pattern, own lazy pool): tick algorithm per Feature Design — idempotency key `watch:{id}:tick:{n}`; checks return `pending | satisfied | terminal_unsatisfied | unavailable`; *atomic* condition transition on satisfied/terminal/TTL; **delivery is a separate durable state, required only for notifying outcomes** (fired/expired → pending → delivered; every cancelled outcome → `not_required`, no wake ever). The session action carries the outcome-qualified stable id `watch:{watchId}:{terminalStatus}`; delivery retries independently; `delivered` is marked only after the append is acknowledged. **The retry guarantor is the task retry policy:** any failure before delivery-ack fails the invocation and the platform retries it — the retried invocation loads terminal + `delivery=pending` and performs delivery only (no condition tick is ever scheduled after a terminal transition). Receiving side dedups on the action id. `run_start` checks the authoritative execution-start marker (`startedAt`), not current status — a run that started and finished between ticks still fires; **wait duration uses the M0 timestamp verdict**: `startedAt − queuedAt`/equivalent when authoritative, otherwise `startedAt − createdAt` labelled "time from creation to start" (never "queue/start latency"). 
- **Chat deletion:** the soft-delete action atomically cancels all the chat's active watches with `reason: chat_deleted` (deliveryStatus `not_required`); scheduled ticks no-op. 
- **Creation does an immediate check** — already-satisfied (or terminally unsatisfiable) conditions fire at creation, no first-tick wait. 
- **Kinds v1** = run_start, run_finished, backlog_drain, error_recurrence, health_recovery — semantics exactly per the Feature Design determinism table, incl. `terminal_unsatisfied` (run cancelled before starting narrates immediately) and server-set `since`. `deploy_verdict` is NOT built. Dedup by `(chatId, project, environment, watchIdentity(spec))`. 
- **Wake:** `appendToSessionStream(chatId,"in",{type:"watch.fired"|"watch.expired", id:"watch:{watchId}:{terminalStatus}", …})`; one narration turn (result, refreshed card, next step; never a new investigation unprompted); wake turns tagged for the judge. 
- **UI:** chips in header + history (status lifted from chat to panel; listChats gains a status field); cancel = a new intent on the dashboard-agent route action under the user's session (UAT cap stays read-only); expiry always narrates. 
- **Guardrails:** ≤3 active per chat; dedup key = `(chatId, project, environment, watchIdentity(spec))` — `watchIdentity` identifies the condition *within* an environment, and a chat is not env-bound, so the same spec in two environments is two independent watches; TTL ≤ 24h. 
- **Entries:** Investigate nextAction; direct ask; run-widget "Tell me when this run starts" (run_start); report footer "watch it drain instead"; queue-page button subject to the #4131 rule.  

#### Invariants / non-goals 

Zero LLM in ticks; no user credentials at rest; terminal states immutable; no deploy_verdict; wake shape stays a session action (chat.event-compatible). 

#### Verification (agent gate)  
- Seeded backlog drains → chat wakes with correct narration + refreshed card (short-tick E2E); run_start fires within one tick and reports the correctly-labelled start-wait duration per the M0 verdict. 
- Typed "tell me when this run starts" calls `schedule_watch` and creates the *same persisted watch* as the UI watch intent (both rows identical modulo creation source). 
- Expiry narrates; cancel works from chip and via curl and emits **no** wake (deliveryStatus `not_required`); revocation test: remove the user's access mid-watch → watch cancels with `access_revoked`, no env read on that tick, no wake (asserted via logs). 
- Chat-delete test: soft-deleting a chat cancels its active watches; a subsequently firing tick no-ops. 
- Cross-token rejection test: a watch token is rejected by UAT verification paths and vice versa; the watch-check endpoint rejects UATs and expired/mismatched-watchId tokens. 
- Grace-window test: a tick scheduled slightly after `expiresAt` still produces exactly one expiry outcome with a final authorized check ("still degraded/not drained" narration carries fresh data); ordinary (non-final) checks after `expiresAt` are refused. If the final check is *unavailable*, the watch expires anyway — narration says the condition couldn't be verified at expiry + last successful observation/time; TTL never extends. 
- Ownership-binding test: a create request with a chatId not owned by the authenticated user/org, *or* with client-supplied project/environment differing from the authorized current creation context, is rejected; no watch row is created. 
- `run_start` marker test: run that started and completed between ticks → fires with the correct start-wait duration and label per the M0 verdict (not terminal_unsatisfied). 
- Race test: two concurrent ticks on a met condition → exactly one wake (idempotency/atomic transition). 
- **Lost-wake test:** simulated crash after the condition transition but before the session append → the *task retry* (not a scheduled condition tick) performs delivery-only and the user gets exactly one narration (delivery-state + action-id dedup). 
- Immediate-check test: watch on an already-started run fires at creation with the correctly-labelled start-wait duration (M0 verdict); `run_start` on a run cancelled before starting narrates the terminal outcome, not "still queued". 
- 4th watch rejected; the same spec in the same environment dedupes, while the same spec in two environments creates two independent watches; run logs show zero LLM in ticks. 
- Gallery/pack refreshed (chips, wake, expiry states).   

## §M7 Hardening, demo, rollout · PR 8 of 8 

>  

#### Goal 

The whole arc (investigate → watch → wake) is provably repeatable, evals gate the prompts, and rollout/config is documented. 

#### Preconditions 

M1–M6 merged. 

#### Build  
- Full eval run; prompt tuning via overrides. **Haiku routing for wake/waiting narrations: evaluate only** — the current mechanism resolves one model per managed system prompt, with no per-turn model selector; implement only if such a selector already exists by then, otherwise defer (don't let M7 become an architecture PR). 
- **Deterministic demo scenario:** a scripted, seeded end-to-end run of the arc (script + assertions in repo). The human screen recording is an external launch asset, not an agent gate. 
- Rollout notes: flags (canAccessDashboardAgent, promoted-prompt flag), watcher deploys with the agent (#4128 pinning), changeset + `.server-changes/` per convention. 
- Final gallery/pack refresh; cherry-pick map finalized.  

#### Invariants / non-goals 

No new features; only tuning, tests, docs. 

#### Verification 

**Agent gate:** demo script passes on a fresh env from the SETUP note; all milestone eval suites green; pack current; release notes + flag docs in the PR. **External gate:** design sign-off; human demo recording; launch checklist.  

## §3 Dependencies & parallel tracks           

| Milestone | Needs | Parallel with |
|---|---|---|
| M0 | — | — |
| M1 | M0 contracts | M2/M3 backend halves |
| M2 | M0 | M1, M3 |
| M3 | M0; #4131 rule | M1, M2, M4 |
| M4 | M0; M1 gallery | M3, M5 backend |
| M5 | M2, M3; M1 design pass (payload freeze) | M6 backend |
| M6 | M0, M2, M3; M5 only for its entry | M5 polish |
| M7 | M1–M6 | — |
 

Three file-disjoint tracks: **A** webapp UI · **B** agent package · **C** webapp server. 

**After M1, milestones M2–M6 are "swap dummy for real":** the UI shipped in the mockup stays; each backend milestone replaces its fixture data source with real behavior (M2 report fixtures → real tool output; M3 navigation dummies → real intents; M4 dummy signals → real page signals; M5 canned investigation → real protocol; M6 fixture chips/wakes → real watcher). Design fixes from the ongoing review land as small independent UI-only PRs (outside the milestone count, §1) — they never block backend tracks and never touch frozen contracts. 

### Risk register  
- **#4327 merge timing** — rebase early; `reports:` commits stay clean. 
- **#4344 landing mid-build** — wake shape already compatible; optional swap to `chat.event` is a follow-up. 
- **M1 design pass slippage** — M5 cannot start card implementation before the payload freeze; backend protocol work (prompt, deterministic modules) is not blocked. 
- **Prompt-quality churn on Investigate** — bounded by the golden eval set; overrides allow post-ship tuning.  

## §4 What's next — after this iteration  
- **Structured diff block** — Show-code's text diff graduates to a first-class view block (file/hunks/copy button, its own evals; the reserved `propose_fix` intent). Then the PR path: server-side octokit, App write permissions, approval card. 
- **Safe mutations, approval-first (TRI-11031)** — replay/cancel/bulk with preview; first candidate replay-verify; pairs with #4344's HITL approve. 
- **`deploy_verdict` watch** — requires the deterministic predicate design (baseline window, sample floor, failure/duration deltas) — belongs with the regression report work. 
- **Per-run queue position** — if the M0 spike proved a source, add position to the waiting-run answer; if not, a data-platform task first. 
- **Proactive investigations (Advisor)** — report-alert crit auto-starts an investigation chat; token-impersonation decision + per-org opt-in + launcher badge. 
- **Slack push / digest** — via agent channels when #4344 lands. 
- **More reports: cost, regression** — registry drop-ins; "why is spend up?" becomes an investigation lens. 
- **⌘K palette** — deterministic navigate/jump + inline ReportView + agent handoff row. 
- **Eval maturation (TRI-11159/11160/11163)** — aggregation/alerting over chat_turn_evals; golden CI gate; adversarial sets; different judge model. 
- **Approved-examples loop (TRI-11030)**; **UX debt** — history pagination, rename/pin UI, env-scoped history filter, multiTab, per-env version pin (#4133); **preview-branch threading** in the in-proxy.  

## §5 After server-side MCP lands  
- `registerResource("trigger://{proj}/{env}/report/{key}")` over `ReportPresenter.call()`; then `…/investigation/{id}`, `…/run/{id}` per the frozen URI grammar. 
- `registerTool` adapters over the same API routes the agent's wrappers use; retire overlapping stdio-MCP implementations. 
- Swap tools.ts transport to the shared surface client — the agent becomes a client of the surface; signatures unchanged. 
- Sessions-as-resources: `trigger://…/session/{id}` + start/send/close/approve; migrate CLI agent-chat tools; watch.fired becomes a subscribable session event. 
- `resources/subscribe`: report severity + watch events push to subscribed hosts. 
- MCP-UI mount of ReportView + investigation card (components already pure; navigate intents already URI-based — this is packaging). 
- Trust-gate spec conformance pass: tier table (read cap / write tier / approve protocol) as the AX spec; verify cap + exchange + route authorization; close the repo.snapshot cap-bypass note. 
- Retire BFF-isms; the curl-ability test becomes MCP-readability.  

Companions: [Feature Design](https://claude.ai/code/artifact/88c5720a-8bf8-4069-9b6f-2cb09d67f2da) (behavior/UX/trust — incl. Watch auth model, determinism table, state machine, degradation matrix, progressive-rendering decision) · [Current State & Design](https://claude.ai/code/artifact/08e0f0d4-c1cb-4f11-9a6e-1aa2cdc5d3c6) (audited base at the pinned commit). Estate audit: gh survey 2026-07-27.
