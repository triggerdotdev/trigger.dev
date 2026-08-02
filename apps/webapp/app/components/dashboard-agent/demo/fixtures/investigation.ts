/**
 * Investigation fixtures — and, until M5 lands, the *proposed shape* of the
 * investigation payload itself.
 *
 * There is no `investigation` member in the view-block catalog yet: the
 * contracts package freezes only its identity rule (a block whose `id` is the
 * `investigationId` and whose `revision` climbs as the investigation
 * progresses). The payload is M5's to define, and the design review of this
 * mockup is what freezes it. So the types below are written as the real payload
 * we intend to ship, not as throwaway props: when M5 adds the block, this file's
 * `DemoInvestigation` should be liftable into `blocks.ts` more or less verbatim,
 * with `Evidence` and the envelope already in their final form.
 *
 * The card that renders these lives in `../components/DemoInvestigationCard`.
 */
import type { Evidence } from "@internal/dashboard-agent-contracts";
import {
  DEMO_WORLD,
  demoDeploymentUri,
  demoErrorUri,
  demoId,
  demoQueueUri,
  demoRunUri,
  demoSourceUri,
  demoSpanUri,
} from "../ids";

/**
 * Where a hypothesis stands. `testing` is a live state the card shows while the
 * investigation is still running; the two verdicts are terminal.
 */
export type DemoHypothesisVerdict = "testing" | "validated" | "invalidated";

export type DemoHypothesis = {
  id: string;
  /** The claim, as a falsifiable sentence. */
  statement: string;
  verdict: DemoHypothesisVerdict;
  /** Why the verdict — one sentence. Absent while `testing`. */
  finding?: string;
  /** The citations that settled it. */
  evidence: Evidence[];
};

/**
 * `concluded` — there is a cause and a fix.
 * `inconclusive` — the evidence ran out; the card must not invent a fix.
 * `in_progress` — still testing hypotheses.
 */
export type DemoInvestigationOutcome = "in_progress" | "concluded" | "inconclusive";

/**
 * How bad it is. Mirrors the report view model's severity ladder minus `ok` —
 * an investigation only exists because something was wrong.
 */
export type DemoInvestigationSeverity = "info" | "warn" | "crit";

/**
 * A caveat qualifies the whole card. `dirty_commit` is the one v1 case: the
 * source we read is the nearest repository snapshot, not provably the code that
 * was deployed, so every source citation on the card inherits the hedge.
 */
export type DemoInvestigationCaveat = {
  kind: "dirty_commit";
  message: string;
};

export type DemoInvestigation = {
  /** Doubles as the block `id` under the frozen identity rule. */
  investigationId: string;
  /** Which revision of the card this is. Climbs; the renderer keeps the highest. */
  revision: number;
  outcome: DemoInvestigationOutcome;
  severity: DemoInvestigationSeverity;
  confidence: "high" | "medium" | "low";
  /** The run (or other resource) under investigation. */
  runId?: string;
  /** Short headline, e.g. "send-order-receipt is failing on every retry". */
  title: string;
  /**
   * The collapsed view's first block. Concluded: severity + cause in one or two
   * sentences. Inconclusive: what we established instead ("What we know").
   */
  headline: string;
  /** Remediation prose. Present only when `outcome === "concluded"`. */
  remediation?: string;
  /** Present only when `outcome === "inconclusive"` — never alongside a fix. */
  checkNext?: string[];
  /** What the agent is doing right now. Present while `in_progress`. */
  progress?: string;
  hypotheses: DemoHypothesis[];
  /** Citations that back the headline itself, beyond the per-hypothesis ones. */
  evidence: Evidence[];
  caveat?: DemoInvestigationCaveat;
  startedAt: string;
  updatedAt: string;
};

const runUri = demoRunUri(DEMO_WORLD.failedRunId);
const spanUri = demoSpanUri(DEMO_WORLD.failedRunId, DEMO_WORLD.failedSpanId);
const errorUri = demoErrorUri(DEMO_WORLD.errorFingerprint);
const queueUri = demoQueueUri(DEMO_WORLD.queue);
const sourceUri = demoSourceUri(DEMO_WORLD.sourceSha, DEMO_WORLD.sourcePath, 18);

const INVESTIGATION_ID = demoId("investigation-order-receipt");

const errorEvidence: Evidence = {
  kind: "error",
  uri: errorUri,
  label: "rate_limit_exceeded · 41 runs in the last hour",
  excerpt: "ProviderError: 429 Too Many Requests (rate_limit_exceeded)",
};

const spanEvidence: Evidence = {
  kind: "span",
  uri: spanUri,
  label: "sendEmail span, attempt 3 of 3",
  excerpt: "sendEmail  412ms  ✕  429 Too Many Requests",
};

const sourceEvidence: Evidence = {
  kind: "source",
  uri: sourceUri,
  label: `${DEMO_WORLD.sourcePath}:18`,
  excerpt: "retry: { maxAttempts: 3, minTimeoutInMs: 1_000, factor: 1 },",
};

const queueEvidence: Evidence = {
  kind: "queue",
  uri: queueUri,
  label: `${DEMO_WORLD.queue} · concurrency 50 of 50`,
  excerpt: "concurrency pinned at 50 for 38 of the last 60 min",
};

const runEvidence: Evidence = {
  kind: "run",
  uri: runUri,
  label: `${DEMO_WORLD.failedRunId} · failed after 3 attempts`,
  excerpt: "attempt 1 429 · attempt 2 429 · attempt 3 429 — all within 19.4s",
};

const priorRunEvidence: Evidence = {
  kind: "run",
  uri: demoRunUri(DEMO_WORLD.priorRunId),
  label: `${DEMO_WORLD.priorRunId} · same payload, completed in 1.2s`,
  excerpt: "2,104 runs with this payload shape succeeded earlier today",
};

const deploymentEvidence: Evidence = {
  kind: "deployment",
  uri: demoDeploymentUri(DEMO_WORLD.deploymentVersion),
  label: `${DEMO_WORLD.deploymentVersion} · deployed 19h before the first failure`,
  excerpt: "first failure 09:02, deploy 14:11 the previous day — no overlap",
};

// ---------------------------------------------------------------------------
// (a) Streaming — the card mid-flight, hypotheses still being tested.
// ---------------------------------------------------------------------------

/** Revision 0: hypotheses posed, nothing settled yet. */
export const demoInvestigationStreamingRev0: DemoInvestigation = {
  investigationId: INVESTIGATION_ID,
  revision: 0,
  outcome: "in_progress",
  severity: "warn",
  confidence: "low",
  runId: DEMO_WORLD.failedRunId,
  title: `Why is ${DEMO_WORLD.taskId} failing?`,
  headline:
    "All three attempts of this run ended in an error from the email provider. I'm reading the spans to see which call failed and whether the retries had a chance to succeed.",
  progress: "Reading the run's spans",
  hypotheses: [
    {
      id: demoId("hyp-rate-limit"),
      statement: "The email provider is rate limiting this API key.",
      verdict: "testing",
      evidence: [],
    },
    {
      id: demoId("hyp-bad-payload"),
      statement: "The payload is malformed and the provider rejects it.",
      verdict: "testing",
      evidence: [],
    },
    {
      id: demoId("hyp-retry-window"),
      statement: "The retry schedule keeps every attempt inside one rate-limit window.",
      verdict: "testing",
      evidence: [],
    },
  ],
  evidence: [runEvidence, spanEvidence],
  startedAt: "2026-07-27T10:14:02.000Z",
  updatedAt: "2026-07-27T10:14:06.000Z",
};

/**
 * The card's very first frame: the subject and the one thing already read, and
 * nothing else. No hypotheses yet, so the disclosure has nothing behind it —
 * the state the gallery needs to prove an empty card still reads as an answer
 * in the making rather than as a broken one.
 */
export const demoInvestigationEarly: DemoInvestigation = {
  investigationId: demoId("investigation-order-receipt-early"),
  revision: 0,
  outcome: "in_progress",
  severity: "warn",
  confidence: "low",
  runId: DEMO_WORLD.failedRunId,
  title: `Why is ${DEMO_WORLD.taskId} failing?`,
  headline:
    "The run failed after three attempts. I'm reading its spans to see which call failed before I put any hypotheses up.",
  progress: "Reading the run's spans",
  hypotheses: [],
  evidence: [runEvidence],
  startedAt: "2026-07-27T10:14:02.000Z",
  updatedAt: "2026-07-27T10:14:03.000Z",
};

/** Revision 1: one hypothesis settled, the other still open. Same id. */
export const demoInvestigationStreamingRev1: DemoInvestigation = {
  ...demoInvestigationStreamingRev0,
  revision: 1,
  confidence: "medium",
  headline:
    "Every attempt came back 429 rate_limit_exceeded, and 41 other runs of this task hit the same error in the last hour. Checking whether the retry schedule made it worse.",
  progress: "Comparing against the last hour of runs on this queue",
  hypotheses: [
    {
      ...demoInvestigationStreamingRev0.hypotheses[0]!,
      verdict: "validated",
      finding: "All three attempts returned 429 rate_limit_exceeded inside a 20-second window.",
      evidence: [errorEvidence, spanEvidence],
    },
    {
      ...demoInvestigationStreamingRev0.hypotheses[1]!,
      verdict: "invalidated",
      finding:
        "The same payload shape succeeded on 2,104 runs earlier today, and the provider never returned a 4xx other than 429.",
      evidence: [priorRunEvidence],
    },
    {
      ...demoInvestigationStreamingRev0.hypotheses[2]!,
      verdict: "testing",
      evidence: [queueEvidence],
    },
  ],
  evidence: [runEvidence, errorEvidence, queueEvidence],
  updatedAt: "2026-07-27T10:14:11.000Z",
};

// ---------------------------------------------------------------------------
// (b) Concluded — cause + fix, two settled hypotheses, citations.
// ---------------------------------------------------------------------------

export const demoInvestigationConcluded: DemoInvestigation = {
  investigationId: INVESTIGATION_ID,
  revision: 2,
  outcome: "concluded",
  severity: "crit",
  confidence: "high",
  runId: DEMO_WORLD.failedRunId,
  title: `${DEMO_WORLD.taskId} is failing on every retry`,
  headline:
    "The email provider is rate limiting this API key, and the task's retries all land inside the same limit window — so every attempt fails. 41 runs failed this way in the last hour.",
  remediation:
    "Spread the attempts out and stop the queue bursting into the provider: raise `minTimeoutInMs` to 30s with a factor of 2 (or add jitter) so the three attempts span the limit window instead of sharing it, and cap the queue's concurrency at 20 to stay under the provider's per-second ceiling. Neither change needs a code deploy if you set the queue limit from the dashboard.",
  hypotheses: [
    {
      id: demoId("hyp-rate-limit"),
      statement: "The email provider is rate limiting this API key.",
      verdict: "validated",
      finding:
        "All three attempts returned 429 rate_limit_exceeded, and 41 other runs hit the same fingerprint in the last hour.",
      evidence: [errorEvidence, spanEvidence],
    },
    {
      id: demoId("hyp-bad-payload"),
      statement: "The payload is malformed and the provider rejects it.",
      verdict: "invalidated",
      finding:
        "The same payload succeeded on 2,104 runs earlier today; the provider never returned a 4xx other than 429.",
      evidence: [priorRunEvidence, runEvidence],
    },
    {
      id: demoId("hyp-retry-window"),
      statement: "The retry schedule keeps every attempt inside one rate-limit window.",
      verdict: "validated",
      finding:
        "maxAttempts 3 with a 1s base delay and factor 1 puts all three attempts inside 20 seconds.",
      evidence: [sourceEvidence, spanEvidence],
    },
    {
      id: demoId("hyp-queue-burst"),
      statement: "The queue is bursting into the provider faster than its per-second ceiling.",
      verdict: "validated",
      finding:
        "The queue sat at its concurrency limit of 50 for 38 of the last 60 minutes, so ~50 sends land on the provider at once every time it drains.",
      evidence: [queueEvidence],
    },
    {
      id: demoId("hyp-deploy-regression"),
      statement: "Yesterday's deploy introduced the failure.",
      verdict: "invalidated",
      finding:
        "The deploy went out 19 hours before the first failure and the task ran clean for most of that window, so the timing rules it out.",
      evidence: [deploymentEvidence],
    },
  ],
  evidence: [errorEvidence, spanEvidence, sourceEvidence, queueEvidence, deploymentEvidence],
  startedAt: "2026-07-27T10:14:02.000Z",
  updatedAt: "2026-07-27T10:14:24.000Z",
};

/**
 * Concluded, and NOT code-grounded: the cause is a saturated concurrency limit,
 * established entirely from telemetry. No file was read, so the card cites no
 * source and the executor offers no "Show code" — the contrast the gallery needs
 * against the concluded card above, whose verdict rests on a line of source.
 */
export const demoInvestigationConcludedNoCode: DemoInvestigation = {
  investigationId: demoId("investigation-queue-saturation"),
  revision: 2,
  outcome: "concluded",
  severity: "crit",
  confidence: "high",
  title: `${DEMO_WORLD.queue} is starving — nothing is starting`,
  headline: `The ${DEMO_WORLD.queue} queue has sat at its concurrency limit of 50 for 38 of the last 60 minutes, so new runs wait behind the ones already running. The p95 wait is 2 minutes against a p50 of 38 seconds, and every run that does start finishes normally.`,
  remediation:
    "Raise the queue's concurrency limit (or the environment's, if that's the one it's hitting) until the depth trend flattens. You can set it from the queue page — no deploy needed. If the limit is deliberate, the backlog is telling you the arrival rate now exceeds it, and the trigger side is what has to change.",
  hypotheses: [
    {
      id: demoId("hyp-queue-limit"),
      statement: "Runs are waiting on the queue's concurrency limit, not failing.",
      verdict: "validated",
      finding:
        "The queue was pinned at 50 of 50 for 38 of the last 60 minutes while the depth climbed from 10 to 4,210, and no run in the window failed.",
      evidence: [queueEvidence],
    },
    {
      id: demoId("hyp-queue-slow-task"),
      statement: "The task itself got slower, so each slot is held longer.",
      verdict: "invalidated",
      finding:
        "Runs that did start completed in ~1.2s, the same as earlier today — the slots turn over as fast as they ever did.",
      evidence: [priorRunEvidence],
    },
  ],
  evidence: [queueEvidence, priorRunEvidence],
  startedAt: "2026-07-27T11:02:00.000Z",
  updatedAt: "2026-07-27T11:02:19.000Z",
};

// ---------------------------------------------------------------------------
// (c) Inconclusive — "What we know" + "What to check next", no fix.
// ---------------------------------------------------------------------------

export const demoInvestigationInconclusive: DemoInvestigation = {
  investigationId: demoId("investigation-monthly-report"),
  revision: 1,
  outcome: "inconclusive",
  severity: "warn",
  confidence: "low",
  runId: DEMO_WORLD.slowRunId,
  title: `Why is ${DEMO_WORLD.slowTaskId} slow?`,
  headline:
    "This run has been executing for 24 minutes against a p95 of 3 minutes, and the time is spent inside one un-instrumented span. I can see where it stalls but not why — nothing in the telemetry explains it.",
  checkNext: [
    "Add a span (or a log) around the report aggregation step so the stall shows up in the trace.",
    "Check the warehouse the aggregation reads from — a slow upstream query would look exactly like this.",
    "Compare against the last run that finished normally to see whether the payload got bigger.",
  ],
  hypotheses: [
    {
      id: demoId("hyp-slow-oom"),
      statement: "The run is thrashing against its memory limit.",
      verdict: "invalidated",
      finding:
        "Peak memory stayed at 38% of the machine's limit for the whole run, and there is no OOM signal on the attempt.",
      evidence: [
        {
          kind: "run",
          uri: demoRunUri(DEMO_WORLD.slowRunId),
          label: `${DEMO_WORLD.slowRunId} · machine metrics, large-1x`,
          excerpt: "memory peak 38% · cpu 11% avg · no restarts",
        },
      ],
    },
    {
      id: demoId("hyp-slow-queue-wait"),
      statement: "The run spent the time waiting for a worker rather than executing.",
      verdict: "invalidated",
      finding:
        "It was dequeued 40ms after it was triggered and has been executing ever since — the time is inside the attempt, not in front of it.",
      evidence: [
        {
          kind: "queue",
          uri: demoQueueUri(DEMO_WORLD.backlogQueue),
          label: `${DEMO_WORLD.backlogQueue} · 3 of 20 concurrency in use`,
          excerpt: "dequeued 40ms after trigger · no queue wait",
        },
      ],
    },
    {
      id: demoId("hyp-slow-upstream"),
      statement: "An upstream call inside the aggregation step is blocking.",
      verdict: "testing",
      finding: undefined,
      evidence: [
        {
          kind: "span",
          uri: demoSpanUri(DEMO_WORLD.slowRunId, "span_demoe71f"),
          label: "aggregate span · 23m 41s, no children",
          excerpt: "aggregate  23m41s  ●  (no child spans)",
        },
      ],
    },
  ],
  evidence: [
    {
      kind: "run",
      uri: demoRunUri(DEMO_WORLD.slowRunId),
      label: `${DEMO_WORLD.slowRunId} · executing for 24m, p95 is 3m`,
      excerpt: "status EXECUTING · attempt 1 · started 09:17:22",
    },
    {
      kind: "span",
      uri: demoSpanUri(DEMO_WORLD.slowRunId, "span_demoe71f"),
      label: "aggregate span · 23m 41s, no children",
      excerpt: "aggregate  23m41s  ●  (no child spans)",
    },
  ],
  startedAt: "2026-07-27T09:41:00.000Z",
  updatedAt: "2026-07-27T09:41:38.000Z",
};

// ---------------------------------------------------------------------------
// (d) Degraded — a read failed mid-investigation, so the card says so.
// ---------------------------------------------------------------------------

/**
 * Inconclusive because a tool failed, not because the evidence was thin.
 *
 * A read that comes back empty or unavailable is itself a finding, and the card
 * has to name what it could not read rather than quietly answering around it: a
 * hypothesis nobody could test is `testing`, never `invalidated`, and the
 * missing read is the first thing on "What to check next".
 */
export const demoInvestigationDegraded: DemoInvestigation = {
  investigationId: demoId("investigation-order-receipt-degraded"),
  revision: 1,
  outcome: "inconclusive",
  severity: "warn",
  confidence: "low",
  runId: DEMO_WORLD.failedRunId,
  title: `Why is ${DEMO_WORLD.taskId} failing?`,
  headline: `Every attempt of this run ended in a 429 from the email provider, and 41 other runs hit the same error in the last hour. I couldn't read the trace — the spans for this run are no longer retained — so I can't tell whether the retries all landed inside one rate-limit window, which is what would explain it.`,
  checkNext: [
    "Re-run the investigation on a fresher failure, while its spans are still retained.",
    "Check the provider's dashboard for the rate limit on this API key and when it resets.",
    "Compare the task's retry settings against that window — three attempts inside one window would fail as a group.",
  ],
  hypotheses: [
    {
      id: demoId("hyp-rate-limit"),
      statement: "The email provider is rate limiting this API key.",
      verdict: "validated",
      finding: "All three attempts returned 429 rate_limit_exceeded on the same fingerprint.",
      evidence: [errorEvidence],
    },
    {
      id: demoId("hyp-retry-window"),
      statement: "The retry schedule keeps every attempt inside one rate-limit window.",
      // Evidence we couldn't get leaves a hypothesis untested — never disproved.
      verdict: "testing",
      finding: "The run's spans are no longer retained, so the attempt timings can't be read.",
      evidence: [],
    },
  ],
  evidence: [runEvidence, errorEvidence],
  startedAt: "2026-07-27T10:31:00.000Z",
  updatedAt: "2026-07-27T10:31:14.000Z",
};

// ---------------------------------------------------------------------------
// (e) Dirty-commit caveat — the same concluded card, hedged.
// ---------------------------------------------------------------------------

/**
 * The deployed version was built from a working tree with uncommitted changes,
 * so the file we read is the nearest repository snapshot rather than provably
 * the deployed code. The wording is the point of this fixture: it hedges the
 * source citation without hedging the evidence that came from telemetry.
 */
export const demoInvestigationDirtyCommit: DemoInvestigation = {
  ...demoInvestigationConcluded,
  investigationId: demoId("investigation-order-receipt-dirty"),
  confidence: "medium",
  caveat: {
    kind: "dirty_commit",
    message:
      "Source lines below come from the nearest repository snapshot, not the exact deployed code — this deploy was built from a working tree with uncommitted changes. The run, span and error evidence is unaffected.",
  },
};

export const demoInvestigations = {
  early: demoInvestigationEarly,
  streamingRev0: demoInvestigationStreamingRev0,
  streamingRev1: demoInvestigationStreamingRev1,
  concluded: demoInvestigationConcluded,
  concludedNoCode: demoInvestigationConcludedNoCode,
  inconclusive: demoInvestigationInconclusive,
  degraded: demoInvestigationDegraded,
  dirtyCommit: demoInvestigationDirtyCommit,
} as const;

/**
 * The show-code follow-up: a fenced diff citing `file:line@sha`. Kept next to
 * the investigation fixtures because it is the same turn's continuation — the
 * user asks "show me the code", the agent answers with the patch it would write.
 */
export const demoShowCodeMarkdown = `Here's the change, against \`${DEMO_WORLD.sourcePath}:14-20@${DEMO_WORLD.sourceSha.slice(0, 7)}\`:

\`\`\`diff
--- a/${DEMO_WORLD.sourcePath}
+++ b/${DEMO_WORLD.sourcePath}
@@ -14,7 +14,8 @@ export const sendOrderReceipt = task({
   id: "${DEMO_WORLD.taskId}",
   retry: {
     maxAttempts: 3,
-    minTimeoutInMs: 1_000,
-    factor: 1,
+    minTimeoutInMs: 30_000,
+    factor: 2,
+    randomize: true,
   },
\`\`\`

That spreads the three attempts across ~2 minutes instead of 20 seconds. I haven't applied anything — this is the patch I'd suggest.`;
