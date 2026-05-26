# Security Fix Pipeline — Design Spec

**Date:** 2026-05-26
**Status:** Approved, ready for implementation planning
**Author:** Daniel Sutton (with Claude)

## Problem

We have ~250 security findings filed as Linear tickets. Each needs to be
validated, then — if real — fixed with production-grade care: minimal blast
radius, no breaking changes, cautious rollout, migration considerations. We
want a dedicated machine to chew through this batch autonomously and produce
reviewable artifacts, without constant approval cycles.

Strict constraints:

- **Nothing leaks to GitHub.** Findings are exploitable; patches and commit
  messages must be treated as sensitive until disclosure timing is decided.
- **Production-grade fixes only.** Multi-step rollouts, backwards-compatible
  changes, migration plans where relevant.
- **Human review at the end.** Patches never auto-apply; the upstreaming
  process is deliberate and separate.

## Scope

In scope: validation, fix design, patch generation, regression testing,
verification, artifact packaging, queue management, review surface.

Out of scope: actually upstreaming fixes (separate human process post-review);
disclosure / CVE / advisory workflow.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│ Dedicated machine                                            │
│                                                              │
│   Linear  ◄────── worker.ts ──────► docker compose -p sec-X │
│   (queue)         (serial, N=1)            │                │
│      ▲                                     ▼                │
│      │                              ┌──────────────┐        │
│      │                              │ per-issue    │        │
│      │                              │ compose stack│        │
│      │                              │  postgres    │        │
│      │                              │  redis       │        │
│      │                              │  clickhouse  │        │
│      │                              │  minio       │        │
│      │                              │  electric    │        │
│      │                              │  webapp ◄────┼──┐     │
│      │                              │  agent  ◄────┼──┤ shared
│      │                              └──────────────┘  │ /repo
│      │                                                ▼ volume
│      │                                            artifacts │
│      │                                              vol     │
│      │                                                │     │
│      │            ┌──────────┐                    ┌──────┐  │
│      └────────────┤dashboard │◄───────────────────┤MinIO │  │
│                   │localhost │                    └──────┘  │
│                   │  :4000   │                              │
│                   └──────────┘                              │
└─────────────────────────────────────────────────────────────┘
```

Three components: **worker daemon**, **per-issue compose stack**, **review
dashboard**. Linear is the queue. MinIO is the artifact store. No GitHub, no
external services beyond Anthropic API and Linear API.

## Queue & State (Linear)

Linear is the queue. The worker reads from the **deepsec-findings** view:
`https://linear.app/triggerdotdev/view/deepsec-findings-c443c3c869c0`
All 250 issues already exist in this view. State lives in labels applied on
top of the existing ticket state:

| Label | Meaning |
|---|---|
| `agent:queued` | Ready for the worker to pick up |
| `agent:in-progress` | Claimed; container running |
| `agent:done` | Artifact bundle uploaded, ready for review |
| `agent:false-positive` | Agent determined the finding is not real |
| `agent:runaway` | Soft-limit hit (turns, wall timeout, heartbeat). Resumable. |
| `agent:resume` | Operator queued for resumption from a runaway snapshot |
| `agent:failed` | Hard failure (crash, OOM, non-resumable error); needs human eyes |
| `agent:reviewed-accept` | Human approved the fix bundle (set by dashboard) |
| `agent:reviewed-reject` | Human rejected the fix bundle (set by dashboard) |

Audit trail is free — every label change appears in Linear's activity feed.

## Worker Daemon

Single TS process running under systemd on the dedicated machine. **Serial,
processes one issue at a time.**

### Main loop

```ts
while (running) {
  // Source: deepsec-findings Linear view; pick the highest-priority issue
  // labelled agent:queued (or not yet labelled by us — first-pass adoption).
  const issue = await linear.nextFromDeepsecView({ label: "agent:queued" });
  if (!issue) { await sleep(30_000); continue; }

  await claim(issue);         // write state(claimed) → setLabel(in-progress)
  await run(issue);           // compose up → wait → compose down
  await persistArtifacts();   // collect → upload to MinIO → verify
  await notify(issue);        // post Linear comment (idempotent)
  await finalize(issue);      // setLabel(done|failed|false-positive)
}
```

### Local state file is source of truth

`/var/lib/sec-fix-worker/state/<issueId>.json`:

```json
{
  "phase": "claimed" | "running" | "uploaded" | "finalized",
  "startedAt": "...",
  "project": "sec-LIN-1234",
  "containerExitCode": null,
  "outcome": "done" | "failed" | "false-positive" | null
}
```

Each transition: write state file → fsync → do side effect → write state
file. State file leads side effects so a crash always leaves a recoverable
record.

### Reconcile on every startup

Before entering the loop:

1. `docker compose ls --filter name=sec-*` → for each orphaned project: tail
   logs, `compose down -v`, mark corresponding state file `phase: "crashed"`,
   set Linear label `agent:failed`, post Linear comment with the tail.
2. Scan `./state/*.json` for non-finalized entries → finish whatever step was
   interrupted (re-upload, re-comment, re-label as needed; all idempotent).
3. Scan Linear for issues stuck on `agent:in-progress` with no local state
   file (worker was wiped) → reset to `agent:queued`.

### Idempotency

- Uploads check MinIO for existing artifact before re-uploading
- Linear comments include marker `<!-- sec-fix-worker:<issueId>:<runId> -->`;
  duplicate-comment detection skips re-posting

## Per-Issue Compose Stack

One `stack.yml` template instantiated per issue with `--project-name
sec-<issueId>`. Compose's project name provides the isolation boundary:
isolated network, isolated named volumes, complete teardown via `compose down
-v`.

### Services

```yaml
services:
  postgres:    # ephemeral pgdata per project
  redis:       # ephemeral per project
  clickhouse:  # ephemeral per project
  minio:       # ephemeral; per-issue uploads go to the host MinIO, not this one
  electric:    # ephemeral per project

  webapp:
    volumes:
      - repo:/repo                       # shared with agent
      - pnpm-store:/pnpm-store           # shared read-mostly across all projects
    command: pnpm --filter webapp dev
    depends_on: [postgres, redis, clickhouse, electric]
    healthcheck: curl http://localhost:3030/healthcheck

  agent:
    volumes:
      - repo:/repo                       # SAME volume as webapp
      - artifacts:/artifacts             # output drop
    command: node /run-agent.mjs
    depends_on:
      webapp: { condition: service_healthy }

volumes:
  pgdata:        # per project
  repo:          # per project, populated from a baked tar snapshot
  artifacts:     # per project
  pnpm-store:
    external: true
    name: pnpm-store-shared              # ONE shared volume across all runs
```

### Repo volume population

**Pinned base SHA: `37eeaa36908fb1aad48fc43d04e5b4e8f474f957`** — `origin/main`
of `trigger.dev-mirror` as of 2026-05-25, the commit immediately preceding
the most recent deepsec revalidate run (2026-05-25 18:14). Findings were
produced against this revision of the codebase, so reproduction and fixes
target it.

A `repo.tar` snapshot at this SHA is baked into the base image; an init
container extracts it into the `repo` volume at stack startup (~5–10s). If a
Linear issue specifies a different base SHA in its body, the worker swaps in
a `git-clone`-from-local-bare-mirror init container instead.

### Network isolation

Compose stack's default network has egress restricted via iptables init
container (or Docker network policy plugin) to:

- `api.anthropic.com`
- `api.linear.app`
- Local MinIO host

Inbound: none. Belt-and-braces with the agent's `disallowedTools` list.

## Agent Container

### Image

Base image (`trigger-mirror-agent:pinned`) contains:

- Repo tar snapshot at a pinned SHA
- pnpm store warm (`pnpm fetch`) — actually mounted as shared external volume
- `@anthropic-ai/claude-agent-sdk` installed globally
- `/run-agent.mjs` (the bridge script)
- `/prompts/security-fix.md` (system prompt encoding the methodology)
- MCP server configs (Linear read+write only; no GitHub MCP)

API keys passed via Docker secret files at `/run/secrets/anthropic` and
`/run/secrets/linear`, never as env vars.

### `run-agent.mjs` — the worker↔agent bridge

```js
import { query } from "@anthropic-ai/claude-agent-sdk";
import { LinearClient } from "@linear/sdk";
import fs from "node:fs/promises";

const issueId = process.env.LINEAR_ISSUE_ID;
const linear  = new LinearClient({ apiKey: await readSecret("linear") });
const issue   = await linear.issue(issueId);

const systemPrompt = await fs.readFile("/prompts/security-fix.md", "utf8");
const userPrompt   = renderIssueContext(issue, await issue.comments());

await fs.mkdir("/artifacts", { recursive: true });
startHeartbeat("/artifacts/.heartbeat"); // updated every 60s

const result = query({
  prompt: userPrompt,
  options: {
    systemPrompt,
    cwd: "/repo",
    permissionMode: "bypassPermissions",
    allowedTools: ["Read", "Edit", "Write", "Bash", "Grep", "Glob"],
    disallowedTools: ["WebFetch", "WebSearch"],
    mcpServers: { linear: { /* read+write */ } },
    maxTurns: 200,  // hard ceiling; runaway loops fail rather than burn budget
  },
});

const transcript = await fs.open("/artifacts/transcript.jsonl", "w");
let finalText = "";
for await (const msg of result) {
  await transcript.write(JSON.stringify(msg) + "\n");
  if (msg.type === "assistant") finalText = extractText(msg);
}
await transcript.close();

await fs.writeFile("/artifacts/final-summary.md", finalText);
await fs.writeFile("/artifacts/status.json",
  JSON.stringify({ issueId, endedAt: new Date().toISOString() }));

process.exit(0);
```

Process exits when the SDK's async iterator finishes. Container exits.
`docker compose wait agent` on the host returns. **Unix process lifecycle is
the synchronization primitive — no IPC, no polling, no marker files.**

### Agent contract (encoded in system prompt)

1. **Validate**: reproduce the finding or declare false positive. Write
   `/artifacts/validation.md`.
2. **If false positive**: final assistant message is
   `FALSE_POSITIVE: <one-line>`. Stop.
3. **If real**: produce the bundle in `/artifacts/`:
   - `design.md` — blast radius, public-API/DB impact, backwards-compat
     strategy, alternatives considered, minimal-impact justification
   - `rollout.md` — sequencing across PRs if non-atomic, feature flags,
     migration order, monitoring/rollback signals
   - `patches/01-*.patch`, `02-*.patch`, ... — ordered, applied with `git am`
   - `tests/` — new/updated regression tests, referenced inside the patches
   - `verification.log` — captured output of `pnpm typecheck` (apps/internal
     packages) or `pnpm build` (public packages) per CLAUDE.md, plus
     `pnpm test` for the affected package
   - `changeset.md` — draft `.changeset/` entry if any public package touched
4. **Final assistant message**: `SUBMITTED: <one-line summary>`. Agent stops
   by simply not calling another tool; SDK loop exits.

### Bias toward minimal impact

System prompt explicitly instructs: prefer additive changes over modifying
existing surfaces; prefer flagged rollouts over direct ships; prefer multiple
small ordered patches over one big atomic change when the fix touches public
contracts or schema. The agent has agency to decide, but defaults are
cautious.

## Resumable Runs

The agent can hit a soft limit — maxTurns (200), wall timeout (90 min), or
heartbeat watchdog (10 min stall) — with valuable in-progress state. These
outcomes are **resumable**, not failures.

### Classification of run outcomes

| Outcome | Cause | Resumable? |
|---|---|---|
| `done` | Final message `SUBMITTED` | — |
| `false-positive` | Final message `FALSE_POSITIVE` | — |
| `runaway` | maxTurns hit, wall timeout, heartbeat stall | Yes |
| `failed` | Container crash, OOM, exit code from non-timeout cause | No (state suspect) |

### What survives teardown

Two named volumes are snapshotted before `compose down -v`:

- **`repo`** volume → `./snapshots/<issueId>/run-N/repo/` (source files only;
  `node_modules` and pnpm store excluded — rehydrated from the base image on
  resume; snapshot stays under ~100 MB per run)
- **`agent-session`** volume (mount of `~/.claude/projects/` inside the agent
  container, where the SDK persists session JSONL) →
  `./session-snapshots/<issueId>/run-N/`

Plus the partial `/artifacts/` contents (whatever the agent had written so
far) are collected exactly as for completed runs.

Snapshots upload to MinIO under
`s3://security-artifacts/<issueId>/runaway-<N>/`. Local copies retained 14
days (longer than artifact cache because resumes can happen later); MinIO is
the long-term store.

### Resume action

Triggered from the dashboard (Resume button on a runaway issue) or
`worker-cli resume <issueId>`:

1. Dashboard sets `agent:resume` label and posts a Linear comment
   (`<!-- resume:run-N -->` marker for idempotency)
2. Worker picks the issue up like a normal queued issue but branches:
   ```ts
   if (issue.labels.includes("agent:resume")) {
     await restoreRepoVolume(issueId, project);        // hydrate from snapshot
     await restoreSessionVolume(issueId, project);     // hydrate SDK session
     await stack.up({ resumeRunNumber: priorRunCount + 1 });
   } else {
     await stack.up({ fresh: true });
   }
   ```
3. Inside the container, `run-agent.mjs` checks for an existing session ID in
   the mounted session volume. If present, calls
   `query({ ..., resume: sessionId })` to continue the prior conversation
   rather than starting fresh. The user prompt is prefixed with: "You are
   resuming after hitting `<reason>`. Review `/artifacts/` for what you've
   already produced and continue from there."

### Resume budget

- **Max 3 resumes per issue** (configurable). After the 3rd consecutive
  runaway outcome, the issue auto-promotes to `agent:failed` with a comment
  explaining the cap was hit. Prevents infinite resume loops on truly
  unfixable issues.
- Each resume gets a **fresh 90-min wall budget** and a **fresh 200-turn
  budget**. The whole point of resume is to extend the available compute,
  so per-run budgets reset; only the attempt count is capped.
- Attempt count tracked in the local state file under
  `runaways: [{ runNumber, reason, endedAt }, ...]` and reflected in the
  dashboard.

### State file additions

```json
{
  "phase": "...",
  "currentRun": 2,
  "runaways": [
    { "runNumber": 1, "reason": "maxTurns", "endedAt": "2026-05-26T11:30:00Z" }
  ],
  "sessionId": "claude-session-abc123"
}
```

### Dashboard surface

The Review tab shows runaway issues with:

- Reason for runaway (turns / wall / heartbeat)
- Attempt count (e.g. "runaway 2 of 3")
- Partial artifacts produced so far (whatever the agent had written)
- **Resume** button (disabled at the cap)
- **Mark failed** button (operator can manually give up)
- **Mark false-positive** button (if the partial work is enough to make the
  call without resuming)

The Queue tab shows runaway issues queued for resume distinctly from
fresh-queued issues.

## Artifact Storage

- Worker collects `/artifacts/` from the per-project volume to
  `./out/<issueId>/` on the host
- Uploads to local MinIO at `s3://security-artifacts/<issueId>/`
- Verifies ETags
- Local `./out/<issueId>/` cached for 7 days; MinIO is source of truth

## Review Dashboard

Local Remix app on `localhost:4000`, run on the dedicated machine.

### Queue tab (live operational view)

- Counts: queued / in-progress / done / failed / false-positive
- Currently-running container (single, since serial): live log tail
- Recent failures with summaries

### Review tab (per-issue review)

For each `agent:done` issue:

- Validation evidence (rendered Markdown)
- Design doc with blast-radius, alternatives, minimal-impact justification
- Rollout plan
- Ordered patches rendered with a proper diff component (Monaco / react-diff-view)
- Tests rendered alongside their patch
- Verification log
- Changeset draft
- Actions: **Approve** / **Reject** / **Needs changes** — writes
  `agent:reviewed-accept` or `agent:reviewed-reject` back to Linear, plus a
  review-notes comment

State syncs to Linear on every action; dashboard is stateless beyond
short-lived UI state.

## Durability (Unsupervised Operation)

### Process supervision

- systemd unit with `Restart=always`, `RestartSec=10`, `WatchdogSec=120`;
  worker pings `sd_notify(WATCHDOG=1)` every 30s
- `flock /var/lock/sec-fix-worker.lock` at startup; double-instance prevented
- Kill switch: worker checks `/var/lib/sec-fix-worker/STOP` at top of loop;
  drains current issue and exits cleanly if present

### Timeouts

- `compose up`: 5 min
- `compose wait agent`: 90 min
- `compose down`: 2 min
- Linear API call: 30s with exponential backoff, max 5 attempts
- MinIO upload: 5 min per file, retry 3x
- **Agent heartbeat watchdog**: agent writes `/artifacts/.heartbeat` every
  60s; if unchanged for 10 min, worker `compose kill agent` → mark
  `runaway` (resumable; see "Resumable Runs"). Catches infinite tool-call
  loops that don't trip `maxTurns`.

The 90-min wall timeout and `maxTurns: 200` also produce `runaway` outcomes
rather than hard `failed`. Only container crashes, OOM kills, and non-timeout
non-zero exit codes produce `failed`.

### Circuit breakers

- **Consecutive failures**: 5 in a row → write `/var/lib/sec-fix-worker/PAUSED`,
  alert, stop picking up new work. Stays alive for status reporting.
- **Failure rate**: >40% over last 20 issues → same.
- **Disk**: before each issue, check free space on `/var/lib/docker` and
  `./out/`; if under 20 GB, pause and alert.

### Resource hygiene

- Per-issue logs `./logs/<issueId>.log` capped at 100 MB via streaming truncation
- `docker image prune -f` after every 10 issues
- `docker volume prune -f` at reconcile time
- `./out/<id>/` deleted after 7 days

### Secret hygiene

- API keys via Docker secrets (`/run/secrets/*`), not env vars
- Transcript scrubber runs over `transcript.jsonl` pre-upload: regex-strips
  Bearer tokens, known key prefixes, common secret patterns
- System prompt forbids writing secrets to artifact files

### Observability (dashboard-only, no external alerting)

The review dashboard is the operator's single surface. No Slack, no email, no
webhooks — the operator checks the dashboard on their own cadence.

The dashboard's queue tab shows:

- Live queue counts (queued / in-progress / done / failed / false-positive)
- Currently-running issue with live log tail
- Last N completed and last N failed, with summaries
- Circuit-breaker state (running / paused-by-consecutive-failures /
  paused-by-failure-rate / paused-by-disk)
- Free disk on `/var/lib/docker` and `./out/`
- Projected completion time based on rolling average

Worker also writes a heartbeat to `/var/lib/sec-fix-worker/heartbeat.json`
every 60s; dashboard surfaces "last heartbeat" as a freshness indicator. If
the worker dies silently, the dashboard makes it obvious within a minute.

### Stop conditions

Worker exits cleanly (systemd does not restart past this point — one-shot
disable) when:

- Queue is empty AND no `agent:in-progress` issues remain
- `STOP` file touched
- Circuit breaker tripped (alerts; stays alive but does not pick up new work)

## Upstreaming (Out of Pipeline)

Explicitly out of scope for this pipeline. After review, a separate human
process:

1. Decides disclosure timing for each accepted fix
2. Sanitizes commit messages if needed
3. Applies patches to a real branch with `git am`
4. Creates real PRs against `main` (now safe — fix is known good, no
   reference to the vulnerability in commit messages until disclosure)
5. Coordinates with security advisories / CVE assignment as appropriate

The pipeline's job ends at `agent:reviewed-accept`.

## Wall-Clock Budget

~30 min avg per issue × 250 issues = ~125 hours = ~5.2 days continuous serial
processing. Kick off Friday, review the following week. If too slow later,
lifting to N=2 concurrency is a one-line change to the worker semaphore.

## What We Build

1. **Base Docker image** (`trigger-mirror-base`) — repo tar, pnpm fetch
2. **Agent Docker image** (`trigger-mirror-agent`) — base + agent SDK +
   `run-agent.mjs` + prompts + MCP configs
3. **`stack.yml`** — the per-issue compose template
4. **`worker.ts`** — the daemon (~150 lines incl. reconcile, durability,
   circuit breakers, alerting)
5. **`run-agent.mjs`** — the in-container bridge script (~80 lines)
6. **`/prompts/security-fix.md`** — the system prompt encoding the
   validation/fix/rollout methodology and minimal-impact bias
7. **Review dashboard** — local Remix app, queue + review tabs, diff renderer,
   Linear writeback
8. **systemd unit** + **iptables egress policy** + **MinIO bucket setup** +
   **status Linear issue setup**

## Non-Goals

- Auto-applying patches to `main`
- Public PR creation
- CVE / advisory automation
- Multi-machine orchestration (single dedicated machine)
- Parallel issue processing (serial, N=1, by design)
- Re-running an issue automatically after failure (retries are human-driven
  via re-labeling to `agent:queued`)
