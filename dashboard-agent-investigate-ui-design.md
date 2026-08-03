# Dashboard Agent — Investigate: UI & interaction design

dashboard agent · design chapter · v1 · 2026-08-01

> **Authority:** companion to the [Feature Design](dashboard-agent-feature-design.md) (behavior/trust canon) and the [Development Plan](dashboard-agent-development-plan.md) (implementation canon), and a sibling to the [Watch chapter](dashboard-agent-watch-ui-design.md). This chapter is canonical for the **visual and interaction design** of Investigate: entry points, the card, its states, wording, and the technical shape they rest on. Conventions shared with Watch are inherited, not restated — **transcript hygiene**, **"Who is speaking"**, the **two-layer presentation rule** (meaning in contracts, wording in a webapp presenter), and **"adapters authorize; the core receives an authorized context"**. Where behavior is restated here, the Feature Design wins on any disagreement.

---

## §0 Decision summary

**What Investigate is.** A bounded diagnostic workflow the agent runs inside a conversation: it gathers evidence about **one** concrete failure or anomaly, tests hypotheses against it, and returns a single living card that ends in a **verdict** — concluded with a cause, or honestly inconclusive. **One investigation, one card:** revisions update it in place, they never stack.

**What we are deciding now.** The creation UI. Which dashboard objects offer it. The card's states and anatomy. The evidence trust model. Verdict semantics. What ships this iteration, and what stays agent-authored.

**Scope.** This document is about the dashboard: entry points, the card, the chat surfaces. MCP and other surfaces are separate documents.

**This iteration.**

- One universal **Investigate** action on failed run · error group · degraded queue · waiting/stuck run.
- One living card, revised in place, from first evidence to verdict.
- The verdict model of §4, with evidence trust enforced (read proof, scope validation, no silent drops).
- Server-generated follow-up actions: Show code · View similar failures · Ask a follow-up.
- The one-sentence close.

**Explicitly not this iteration.** Proactive investigations · cost investigation · cross-run pattern analysis · deploy-verdict diagnosis · cross-environment diff · post-incident timelines · MCP.

## §1 Product boundaries

Four neighbors, hard-separated. This section is the filter for roadmap fantasy: if a proposal does not fit the Investigation column, it is not an investigation.

| | **Investigation** | **Watch** | **Report** | **Plain chat answer** |
|---|---|---|---|---|
| Question | why did this happen | when does this condition resolve | what is the state now | anything, once |
| Determinism | agent work, hypothesis-driven | deterministic checks | deterministic snapshot | model answer |
| Lifetime | one bounded workflow | temporary, bounded window | instant | the turn |
| Artifact | one revisable card | a watch, then one wake | an immutable snapshot card | prose only |
| Ownership | belongs to a conversation | belongs to a conversation | belongs to a conversation | — |
| Cost | consumes one bounded agent workflow | deterministic between creation and result | free | one turn |

- **Report → Investigation** and **Watch → Investigation** are hand-offs, never conversions. A report finding or a watch outcome may *lead to* an investigation; **neither ever becomes one silently** (binding).
- **An investigation never starts unprompted** (binding). Exactly three openings exist: the user asks, the user clicks **Investigate**, or the user gave investigate-on-attention consent when creating a watch — see [Watch §6](dashboard-agent-watch-ui-design.md).
- **A plain answer is not a failed investigation.** A lookup ("what's this run's status?") is answered in prose. An investigation is opened only when the question needs diagnosis.

## §2 Core user journeys

User scenarios only; the machinery is §7.

### 2.1 Start

**Path A — contextual action.** Every supported object exposes the same action: **Investigate**. One tap posts the visible request into the chat, in the user's own voice, and the agent begins.

| Object | The request the tap posts |
|---|---|
| Failed run | why did this run fail? |
| Error group | why does this error keep happening? |
| Degraded queue | why is this queue backed up? |
| Waiting / stuck run | why is this run not progressing? |

**The entry is universal; the subject is contextual.** There is no per-object CTA label.

**Investigate has no form card, and that is the point (binding).** Watch collects configuration before it makes a deterministic promise, so it opens a system/form card and speaks in a deliberately canned voice. Investigate collects nothing — a tap is the whole configuration — and what follows **is** agent work. So the tap posts the user's request and the agent answers it in the agent's own voice. Forcing a confirmation card here would fake a decision the user does not have to make; wearing the form voice here would disguise real model work as deterministic machinery. See [Watch §2.2 "Who is speaking"](dashboard-agent-watch-ui-design.md) — this is the same rule, landing on the other side.

**Path B — free text.** "Why did this run fail?", "what's going on with prod?", "why is send-receipt failing?" The agent recognises a diagnostic ask and opens an investigation. No confirmation step.

**Path C — consented watch outcome.** A watch that resolves to an attention outcome, with consent given at creation, opens an investigation without asking again. Cross-reference only: [Watch §6](dashboard-agent-watch-ui-design.md) owns the consent, the sequencing, and the rule that a failed investigation never delays the wake.

### 2.2 Running

**One living card appears early** — before anything is tested, not after the answer is known. It carries the subject, the status, and what is established so far, and it is **updated in place** as evidence lands.

- **One progress line, never two spinners** (binding). Progress is a single pill beneath the card, on the same line the chat uses for any in-flight tool. The card itself never carries a second spinner.
- **Hypothesis churn is the agent's business.** The card shows consolidated state — the hypotheses that survived posing, with their current verdicts — not every idea that was entertained and dropped mid-round.
- **The investigation does not lock the conversation.** The user can keep typing. Nothing about the card is modal.
- The card is legible at every moment it exists. A user who reads it mid-flight learns the subject, what is known, and that work is still happening — never a blank frame waiting for a result.

### 2.3 Verdict

The card settles into exactly one terminal outcome.

- **Concluded** — a named cause, code-grounded when the cause lives in code (`file:line` at the deployed commit), plus how to fix it.
- **Inconclusive** — what was checked, what that established, and what would decide it. Never a fix, not even a hedged one.

**The closing prose is ONE sentence** (binding). The card carries the detail; the close names the cause in the user's own terms, or names what is not established. Anything list-shaped belongs on the card and only there. A close that restates the card is a bug, not a summary.

### 2.4 Follow-ups

A settled card offers server-generated actions — never model-authored ones. §6 owns which, and when.

### 2.5 Failure and abandonment

- **A tool failure mid-investigation degrades the card honestly** (binding). It settles as inconclusive, naming what could not be read, and says so on the card. A card left reading `in_progress` when the turn ends is a defect: the user is watching a spinner that will never stop.
- **Leaving the page changes nothing.** The investigation lives in the chat, not on the page it was started from. It is there when the user comes back.
- A budget exhausted is not a crash: the investigation concludes or goes inconclusive **within** the budget (§4.3), it never runs out silently.

## §3 Supported dashboard scenarios

Capabilities are wider than the UI (§9). The UI advertises only the head scenarios.

| Scenario | Contextual UI | Typed chat |
|---|---|---|
| A run failed | ✅ Run page **Investigate** | ✅ |
| An error group keeps recurring | ✅ Error page **Investigate** | ✅ |
| A queue is warn/crit | ✅ Queue page **Investigate** | ✅ |
| A run is waiting / stuck | ✅ Run page **Investigate** | ✅ |

Anything not in this table is reachable by typed ask **once the scenario is supported end to end; a reader alone is not a capability.** It is not advertised in the UI.

## §4 Investigation model and outcomes

The canonical model. UI and backend both obey it.

### 4.1 States

```
in_progress → concluded | inconclusive
```

- **Exactly one terminal state.** There is no "cancelled" and no "expired": an investigation that runs out of evidence or budget is `inconclusive`, which is an answer.
- **Revisions are monotonic.** A revision only ever climbs, and identity is fixed for the investigation's life.
- **Latest-wins rendering** (binding). One card per investigation across the whole transcript, however many revisions were emitted. Two cards for one investigation is a rendering bug.

### 4.2 The verdict model

A cause must be **evidence-backed**. Each evidence item is a typed citation — run, error, deployment, span, queue, report, source — resolved to a **canonical URI**. There is no free-form reference field: a pointer that cannot be resolved, linked or validated is not evidence.

**Citation-grade source evidence requires read proof** (binding). A file is citable only if it was **actually read, this turn, at the exact commit the citation names**. The turn's repository snapshot is not proof of reading and never stands in for it: a path nobody opened is model-authored, and a card that cites it claims grounding it does not have.

**A hypothesis carries its own citations.** A hypothesis marked validated must say what settled it; a hypothesis with a verdict and no finding is an assertion, not a conclusion.

**Confidence is reported, not inferred.** Low confidence does not render as validated — it folds into inconclusive.

### 4.3 Honesty rules (binding)

Each of these exists to prevent a specific observed failure, and each reads as a rule:

1. **Truncated data supports what was seen, never what was not.** Off a truncated or paged result, no absence claim is permitted — not even hedged.
2. **Missing evidence is not disproof.** Evidence that could not be obtained makes a hypothesis inconclusive, never invalidated.
3. **Deployed-commit uncertainty is said aloud.** When the read snapshot is not provably the deployed code, the card carries the **dirty-snapshot caveat**, confidence drops, and every source citation inherits the hedge.
4. **Inconclusive never promises a fix.** "What to check next" holds things to look at, measure or find out. "Add retries", "raise the timeout", "add a guard" are changes, not checks — they belong to a concluded card and nowhere else.
5. **A symptom is not a cause.** A timeout, a socket hangup, a dependency's 5xx say *what* failed, never *why*. Concluding requires a **mechanism**: evidence showing how the failure happens.
6. **The step budget is bounded, and the verdict is inside it.** Steps are reserved up front for testing and for rendering the verdict. Conclude-or-inconclusive happens within the budget; a budget exhausted before the verdict renders is a defect, not an outcome.
7. **The verdict lands on the card before it lands in prose.** No cause, fix or dead end is stated in prose while the card still reads `in_progress`.

### 4.4 Code-addressable causes

When the cause lives in code, the card cites `file:line` at the **pinned deployed SHA** — the commit the run under investigation actually ran, not the latest branch. Without a repository the agent read, the card makes no claim about the code at all. When the deployed source cannot be resolved, the card says so rather than quietly answering off the latest branch.

## §5 Interaction and visual design

### 5.1 Principles

Shared principles are inherited from [Watch §5.1](dashboard-agent-watch-ui-design.md) — state lives in the icon, no ambient spend, no fake agent voice on deterministic UI. Investigate adds three (binding):

1. **One card, one truth.** Revisions update the card in place. A transcript that shows the same investigation twice is wrong, whatever the revisions said.
2. **The card outlives the turn.** The card is the persisted artifact; prose is commentary on it. Anything the user must still have tomorrow belongs on the card.
3. **No theater.** Evidence counts, hypothesis counts and progress are real state, never decoration. A progress line names what is being read right now, or it does not appear.

### 5.2 Components

| Component | Anatomy & rules |
|---|---|
| Investigation card | Bordered card. **Header strip:** the label "Investigation", a severity badge, a confidence badge, and the subject on its own truncating line (a run id cannot ride the badge row reliably at panel width). **Body sections:** *What happened* (concluded) or *What we know* (otherwise) · *How to fix* (concluded only) · *What to check next* (inconclusive only) · caveat callout · a disclosure holding *Hypotheses* and *Evidence*. The two endings are mutually exclusive on the card, enforced by the schema — a card can never render both a fix and a check-next list. |
| Progress pill | One line, **outside** the card, the same pill the chat uses for any in-flight tool, so the transcript never shows two spinner styles at once. Present only while `in_progress`. |
| Evidence row | Kind badge + human label + the resolved link + optional verbatim excerpt in a monospace block. The link is the resolved canonical URI; **an unresolved URI still renders as the raw URI** — visibly addressable is the minimum bar, and hiding it would hide a failure. |
| Hypothesis row | Verdict badge (Testing · Validated · Ruled out) + the falsifiable statement + the finding + its own stacked citations. |
| Actions row | Server-generated buttons under a settled card (§6). First action primary, the rest secondary. Absent when there is no host to receive the intent. |

**Two layers, one meaning.** The investigation model, its outcome/verdict vocabulary and the semantic action kinds live in **contracts**, consumed by any surface. **User-facing wording lives in a webapp presenter.** Components contain no kind-specific wording — the same rule the Watch chapter states for the wake surfaces.

### 5.3 Wording

- **Section titles are facts, not labels.** *What happened* · *What we know* · *Hypotheses* · *Evidence* · *How to fix* · *What to check next*. No "Analysis", no "Summary", no "Details".
- **The disclosure is honest about what it hides:** "How I worked this out", with the hypothesis count.
- **The one-sentence close** (§2.3). Concluded: the cause, concretely — the saturated limit, the `file:line` that broke. Inconclusive: what is *not* established and what to check first. "Here's what I found" is not an answer.
- **The card never narrates the UI.** No "see the card above".

### 5.4 State gallery (screenshot pack)

Every cell is a gallery fixture; light + dark.

**In progress:** early (subject + first evidence, no hypotheses yet) · mid (hypotheses posed, one testing) · long progress label truncation.
**Concluded:** code-grounded (source citation with `file:line`, Show code offered) · not code-grounded (no repo, or source unresolved — no Show code) · with the dirty-snapshot caveat · high vs low confidence badges.
**Inconclusive:** with check-next list · degraded after a tool failure (names what could not be read) · no evidence at all.
**Evidence:** long excerpt overflow · many citations (truncation rule) · unresolved URI fallback · every kind's badge.
**Actions:** Show code only · Show code + View similar · Ask a follow-up (inconclusive) · no actions.
**Entry points:** the same **Investigate** action on failed run · error group · degraded queue · waiting run.

### 5.5 Open questions

1. **Long-evidence truncation.** Does the Evidence section cap at N rows with a "show all", or does the disclosure carry the whole weight?
2. **A11y of a card that changes under the reader.** Should a revision announce politely, or is the progress pill the only announced surface?
3. **Narrow panel (320px min).** Header badge row wrapping, and whether the actions row stacks.

## §6 Follow-up actions (server-generated, binding)

**The executor decides which actions a settled card offers. The model can neither request a button nor supply its target.** The whole promise of an action is that the thing it offers really exists; only the executor knows that.

| Action | Offered when | What it does |
|---|---|---|
| **Show code** | outcome is `concluded` **and** the cause is code-addressable **and** the file was read this turn at the pinned snapshot **and** a concrete location (line) exists | Emits a canned ask for a **fenced-diff minimal fix**, anchored `file:line@sha`, carrying the dirty-snapshot caveat when the commit is not provably what shipped |
| **Watch for recurrence** | outcome is terminal and the subject has a watchable identity | Hands off to the Watch card, pre-filled — see [Watch §2.1](dashboard-agent-watch-ui-design.md). The hand-off creates nothing on its own |
| **View similar failures** | an error citation survived canonicalization | Navigates to the canonical error / filtered-runs URI |
| **Ask a follow-up** | outcome is `inconclusive` | Sends the user's own next question, in their voice |

Rules:

- **Actions emit the same typed intents the rest of the chat uses** — `ask` and `navigate`, nothing bespoke. The card emits; the host honours or declines, exactly like every other intent.
- **A navigate target is always an already-canonical URI**, built by the executor. A click can never reach a target the model improvised.
- **Components carry no kind-specific wording.** Semantic action mapping lives in contracts; the English lives in the webapp presenter (§5.2).
- **An action vocabulary the host does not know is skipped, not failed.** The action set is versioned separately from the card payload, so an older host renders fewer buttons rather than nothing.

## §7 Technical design

### 7.1 Contracts and storage

| Layer | Owns |
|---|---|
| Contracts | The versioned **investigation block**: the investigation state (outcome, severity, confidence, subject, headline, hypotheses with their verdicts and citations, evidence, remediation XOR check-next, caveat), the typed **evidence** shape, and the **action vocabulary**. The exclusivity rules are schema-enforced, not prose: only a concluded investigation may carry a fix; check-next belongs to an inconclusive one; a validated hypothesis must state its finding. |
| Datastore | The **investigations table**: revisioned state, plus an immutable org / project / environment / user snapshot. The row is the identity authority. |
| Webapp | Rendering, URI resolution, the presenter. |

**The meaning layer is shared.** Any future surface reads the same resolved model — outcome, verdict, evidence kinds, action kinds — and reinvents none of it.

### 7.2 Identity and authority

- **The executor owns the investigationId** (binding). The model reports *state only*. It can neither supply an id nor overwrite one; the executor commits the revision and stamps identity onto the block afterwards.
- **Revisions are monotonic**, assigned by the store.
- **An id is only ever a pointer.** The store verifies the row belongs to this chat, project and environment — the chat binding is server-side. A stale or hallucinated id fails as a tool error with **nothing written**, never as a card whose identity could not be established.
- **A context mismatch is an error, not a fallback.** It never silently opens a second investigation.

### 7.3 Evidence pipeline

```
model cites bare ids / structured refs
  → executor canonicalizes to trigger:// URIs
  → kind + project/environment scope validation
  → read-ledger proof for source citations
  → persisted, rendered, resolvable
```

- The model cannot construct a canonical URI — the grammar embeds the environment id, which the model never sees. So it cites what the read tools gave it: one bare id for simple kinds, `{runId, spanId}` for a span, `{path, line?, sha?}` for a source location. A source location is **never** a `path:line` string; a string cannot be canonicalized.
- **A URI that arrives whole is validated, not trusted.** Its kind must match the citation's kind and its project + environment must be this turn's. A URI from another scope cannot be smuggled in.
- **Read-ledger proof for source** (§4.2). The ledger is per-turn: a later turn re-rendering the same card re-reads the file. Cheap, and the only honest option.
- **A ref that fails canonicalization fails the render BY NAME** (binding). Nothing is ever dropped silently. A quietly missing source citation is precisely the code-grounding the card exists to prove, so the tool returns an error naming the offending citation and the model fixes or removes it.

### 7.4 Step budget and honesty enforcement

The honesty rules of §4.3 are **prompt-level rules backed by executor-level gates** — neither layer alone is sufficient.

| Rule | Prompt | Executor gate |
|---|---|---|
| Source citation is read-proved | "read it first, then cite it" | render fails by name (§7.3) |
| Show code only when real | — | capability gating (§6) |
| Card reaches a verdict | four phases, verdict is the last call | the budget reserves steps for the test round and the verdict render |
| No invented identity | "report state only" | the model's field does not exist at the boundary |
| Fix XOR check-next | the two endings are exclusive | schema refinement |

**Evals assert the honesty rules** — truncation discipline, symptom-vs-mechanism, the inconclusive-offers-no-fix rule, the dirty-snapshot caveat, and diff quality behind Show code. A rule with no eval is a suggestion.

### 7.5 Rendering

- **Envelope latest-wins.** The panel keeps the highest revision per investigation id and drops the rest — one card, whatever the transcript holds.
- **A block with no identity is non-revisable** and renders once, in transcript order. It can never be replaced by a later revision.
- **`resolveUri` is the host's job**, through the panel's resolve action. The pure card takes props and renders; that is what lets the same fixture render in the panel and in the gallery.
- **Source resolves to a GitHub blob at the pinned SHA**, with the line anchor — the code that ran, not the code that is there now.

### 7.6 UI and chat adapters

- **Contextual Investigate** — posts the user's request into the chat; the agent's normal turn machinery does the rest. No separate creation endpoint, no configuration state.
- **Chat** — free text reaches the same workflow.
- Both obey the one rule: **adapters authorize; the core receives an authorized context.** Nothing in the investigation path takes a project or environment from client input. That rule is what keeps further adapters cheap; they are a separate document.

## §8 Delivery scope

Theme: **Investigate stops being a prompt behaviour and becomes a visible, trustworthy artifact.**

**Must ship**

1. Contextual **Investigate** on the four §3 objects.
2. The living card, revised in place, with the §4 model end to end.
3. Evidence trust: read proof, scope validation, no silent drops (§7.3).
4. The one-sentence close (§2.3).
5. Server-generated follow-ups: **Show code**, **View similar failures**, **Ask a follow-up** (§6).
6. **Watch for recurrence** hand-off — **only if the Watch iteration's card ships first**. This is an order dependency, named on purpose: the hand-off pre-fills the Watch card, so without that card there is nothing to hand off to, and a button that opens nothing is worse than no button.
7. Tests, the §5.4 gallery matrix, and evals for the §4.3 honesty rules.

**Cut first, in this order**

1. **Show code**, if diff-quality evals lag. The gating is cheap; a bad diff behind a confident button is not.
2. **The waiting / stuck-run scenario** — the least evidenced of the four.

**Explicitly deferred**

- **Proactive investigations.** "Never unprompted" stays binding (§1); the only relaxation is watch-creation consent, and it belongs to Watch.
- Cost investigation · cross-run pattern analysis · deploy-verdict diagnosis · cross-environment diff · post-incident timelines.
- **MCP and other surfaces** — a separate document. The shared meaning layer (§7.1) is what makes that document short.

## §9 Capability map and roadmap

> *This section describes capabilities enabled by the Investigate primitive. It is not committed dashboard UI. Most scenarios are expected to be agent-authored first and graduate into visible product surfaces only after demonstrated demand.*

Demand is head-heavy — a run failed, an error keeps coming back, a queue is backed up — and value is decided by entry points and verdict quality, not by scenario count. The catalog is the **agent's vocabulary, not the user's menu**.

### 9.1 Capability catalog

Legend: **this iteration** = shipping now (§8) · **future** = a new reader, addressing scheme, or evidence source is required · **speculative** = no mechanics decided.

| Scenario | Mechanism | Likely surface | Status |
|---|---|---|---|
| Why did this run fail | run + trace + error reads, source at the deployed commit | Dashboard + chat | this iteration |
| Why does this error keep happening | error group + affected versions + representative runs | Dashboard + chat | this iteration |
| Why is this queue backed up | queue metrics + concurrency + the runs behind the depth | Dashboard + chat | this iteration |
| Why is this run stuck | waitpoint / attempt state + trace | Dashboard + chat | this iteration (first cut, §8) |
| What broke in this deploy | deploy diff + first-N-runs verdict | Chat first | future |
| Why is this expensive | cost attribution across runs | Chat first | future |
| Is this task flaky, and how | run-history characterization over time | Chat first | future |
| Works in staging, fails in prod | cross-environment comparison of config, versions, data | Chat first | future |
| Post-incident timeline assembly | multi-source correlation into one ordered narrative | Chat first | speculative |

Fences carried by these rows:

- **Deploy verdict** — a deploy that correlates in time is not a cause; the mechanism must be in the diff.
- **Cost** — an attribution without a per-run cost seam is a guess, and a guess is inconclusive.
- **Flaky characterization** — a rate is a description, not a cause; it concludes only with a mechanism.
- **Cross-environment diff** — a difference found is not the difference that matters until it is tied to the failure.

### 9.2 Roadmap

The ranking is a bet, not a promise.

| Rank | Capability | Why next | Evidence required |
|---|---|---|---|
| 1 | Deploy verdict | the most common real story behind "it broke today" | deploy-diff seam + typed asks |
| 2 | Cross-environment diff | high-value, frequently asked, currently unanswerable | comparable config/version reads across envs |
| 3 | Flaky-task characterization | turns a recurring annoyance into a decision | run-history aggregation the card can cite |
| 4 | Cost investigation | stated demand | per-run cost attribution seam |
| 5 | Post-incident timeline | strong narrative, weak mechanics | repeated multi-investigation behaviour |

### 9.3 Parking lot

Unranked, no mechanics decided: investigation digests · saved investigations · comparing two investigations · investigation-to-issue export · org-level recurring-cause rollups.
