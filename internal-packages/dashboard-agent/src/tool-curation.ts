import type { JSONValue } from "@ai-sdk/provider";
import { sliceWellFormed, type QueueGrounding } from "@internal/dashboard-agent-contracts";

// Trims API payloads down to what a tool returns, plus the toModelOutput projections
// and the period clamp. No IO, no auth.

// Free-text from runs/errors/commits is authored outside our system, so it can carry
// text that reads like instructions. Fence it in a hard-to-spoof delimiter (named to the
// model in the system prompt) and cap its length so one field can't blow context.
const MAX_UNTRUSTED_FIELD_CHARS = 4096;

// Neutralize guillemet bytes so the payload can't reproduce a closing token and break
// out of its own fence — they're effectively absent from real run/error text.
export function sanitizeUntrusted(text: unknown, maxChars = MAX_UNTRUSTED_FIELD_CHARS): string {
  const raw = String(text).replaceAll("«", "<").replaceAll("»", ">");
  return raw.length > maxChars
    ? `${sliceWellFormed(raw, maxChars)}…[truncated ${raw.length - maxChars} chars]`
    : raw;
}

export function fenceUntrusted(
  label: string,
  text: unknown,
  maxChars?: number
): string | undefined {
  if (text === undefined || text === null) return undefined;
  return `«untrusted:${label}» ${sanitizeUntrusted(text, maxChars)} «/untrusted:${label}»`;
}

// Fail closed: with no organization to scope to, nothing is trustworthy to return.
export function curateProjects(data: unknown, organizationId: string | undefined) {
  if (!organizationId) return { projects: [] };
  const projects = Array.isArray(data) ? data : [];
  return {
    projects: projects
      .filter((p: any) => p.organization?.id === organizationId)
      .map((p: any) => ({
        ref: p.externalRef,
        name: p.name,
        slug: p.slug,
        organization: p.organization?.title,
      })),
  };
}

export function curateEnvironments(data: unknown) {
  const envs = Array.isArray(data) ? data : [];
  return {
    environments: envs.map((e: any) => ({
      slug: e.slug,
      type: e.type,
      paused: e.paused,
      branchName: fenceUntrusted("branchName", e.branchName),
    })),
  };
}

// A retry or expiry-requeue makes "when did it first start waiting" ambiguous, so only a
// first, non-expired attempt counts as a reliable queue-wait reading.
function queueWait(run: any): { queueWaitMs: number | null; queueWaitReliable: boolean } {
  const startedAtMs = run.startedAt ? Date.parse(run.startedAt) : undefined;
  const createdAtMs = run.createdAt ? Date.parse(run.createdAt) : undefined;
  const delayedUntilMs = run.delayedUntil ? Date.parse(run.delayedUntil) : undefined;

  const queueWaitReliable =
    startedAtMs !== undefined &&
    typeof run.attemptCount === "number" &&
    run.attemptCount <= 1 &&
    !run.expiredAt;

  if (!queueWaitReliable || startedAtMs === undefined || createdAtMs === undefined) {
    return { queueWaitMs: null, queueWaitReliable };
  }
  const queueStartMs = Math.max(createdAtMs, delayedUntilMs ?? createdAtMs);
  const queueWaitMs = startedAtMs - queueStartMs;
  // A negative wait is clock skew, not a measurement — never a reliable reading.
  if (queueWaitMs < 0) return { queueWaitMs: null, queueWaitReliable: false };
  return { queueWaitMs, queueWaitReliable };
}

function fenceTags(tags: unknown) {
  return Array.isArray(tags) ? tags.map((tag) => fenceUntrusted("tag", tag)) : tags;
}

export function curateRun(run: any) {
  return {
    id: run.id,
    status: run.status,
    taskIdentifier: fenceUntrusted("taskIdentifier", run.taskIdentifier),
    version: run.version,
    isQueued: run.isQueued,
    isExecuting: run.isExecuting,
    isCompleted: run.isCompleted,
    isFailed: run.isFailed,
    isCancelled: run.isCancelled,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    durationMs: run.durationMs,
    costInCents: run.costInCents,
    attemptCount: run.attemptCount,
    tags: fenceTags(run.tags),
    ...queueWait(run),
    error: run.error
      ? {
          name: fenceUntrusted("errorName", run.error.name),
          message: fenceUntrusted("errorMessage", run.error.message),
        }
      : undefined,
  };
}

export function curateTasks(data: unknown) {
  const tasks = (data as any)?.worker?.tasks ?? [];
  return {
    tasks: (Array.isArray(tasks) ? tasks : []).map((t: any) => ({
      slug: fenceUntrusted("taskSlug", t.slug),
      filePath: fenceUntrusted("filePath", t.filePath),
      triggerSource: t.triggerSource,
    })),
  };
}

export function curateRuns(data: unknown) {
  const runs = (data as any)?.data ?? [];
  return {
    runs: (Array.isArray(runs) ? runs : []).map((r: any) => ({
      id: r.id,
      status: r.status,
      taskIdentifier: fenceUntrusted("taskIdentifier", r.taskIdentifier),
      version: r.version,
      isTest: r.isTest,
      createdAt: r.createdAt,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      durationMs: r.durationMs,
      tags: fenceTags(r.tags),
    })),
    nextCursor: (data as any)?.pagination?.next,
  };
}

const MAX_TRACE_SPANS = 60;

// The legacy public trace reports span durations in nanoseconds. Event
// `properties.duration` is milliseconds.
const nsToMs = (duration: unknown) =>
  typeof duration === "number" ? Math.round(duration / 1_000_000) : undefined;

export type TraceSource = "agent" | "legacy";

// The agent trace endpoint already reports `data.durationMs`; only the legacy
// public endpoint needs the ns-to-ms conversion.
function spanDurationMs(d: any, source: TraceSource): number | undefined {
  if (d?.isPartial) return undefined;
  return source === "agent" ? d?.durationMs : nsToMs(d?.duration);
}

// Attempt spans are the run span's direct children, titled `Attempt N` by the SDK.
// Nothing else in the payload marks them: ClickHouse stamps `data.attemptNumber` on every
// span inside an attempt and Postgres stamps none, so neither identifies the attempt.
const ATTEMPT_MESSAGE = /^Attempt (\d+)$/;
function attemptNumberOf(span: any, depth: number): number | undefined {
  if (depth !== 1) return undefined;
  const match = ATTEMPT_MESSAGE.exec(String(span.data?.message ?? ""));
  return match ? Number(match[1]) : undefined;
}

const RUN_STILL_EXECUTING_NOTE =
  "The run hasn't finished, so the run span has no duration yet. attemptMs is the latest attempt seen, execution only.";
const FINISHED_NOTE =
  "rootSpanMs is wall clock from trigger to finish, including queue time and waits. attemptMs is the latest attempt seen, execution only.";

export function curateTrace(data: unknown, source: TraceSource = "legacy") {
  const root = (data as any)?.trace?.rootSpan;
  const spans: Array<Record<string, unknown>> = [];
  let dropped = false;
  let latestAttempt: { number: number; durationMs: number | undefined } | undefined;
  const walk = (span: any, depth: number) => {
    if (!span) return;
    if (spans.length >= MAX_TRACE_SPANS) {
      dropped = true;
      return;
    }
    const d = span.data ?? {};
    const attemptNumber = attemptNumberOf(span, depth);
    if (attemptNumber !== undefined && (!latestAttempt || attemptNumber >= latestAttempt.number)) {
      latestAttempt = {
        number: attemptNumber,
        durationMs: spanDurationMs(d, source),
      };
    }
    // The two flags are emitted only when true; absent means false.
    spans.push({
      id: span.id,
      depth,
      ...(depth === 0
        ? { kind: "run" }
        : attemptNumber !== undefined
          ? { kind: "attempt", attemptNumber }
          : {}),
      message: fenceUntrusted("spanMessage", d.message),
      task: fenceUntrusted("taskSlug", d.taskSlug),
      // An unfinished span is written with duration 0, which isn't a duration.
      durationMs: spanDurationMs(d, source),
      level: d.level,
      ...(d.isError ? { isError: true } : {}),
      ...(d.isPartial ? { isPartial: true } : {}),
    });
    for (const child of span.children ?? []) walk(child, depth + 1);
  };
  walk(root, 0);
  // An unfinished span is written with duration 0, and a truncated walk can have cut the
  // latest attempt off — neither is a duration worth handing the model.
  const runStillExecuting = root?.data?.isPartial === true;
  // Either we dropped spans ourselves or the store already capped the trace it handed us.
  const truncated = dropped || (data as any)?.trace?.isTruncated === true;
  const attempt = truncated ? undefined : latestAttempt;
  return {
    traceId: (data as any)?.trace?.traceId,
    spans,
    truncated,
    ...(spans.length > 0
      ? {
          durations: {
            ...(runStillExecuting ? {} : { rootSpanMs: spanDurationMs(root?.data ?? {}, source) }),
            ...(typeof attempt?.durationMs === "number"
              ? { attemptMs: attempt.durationMs, attemptNumber: attempt.number }
              : {}),
            note: runStillExecuting ? RUN_STILL_EXECUTING_NOTE : FINISHED_NOTE,
          },
        }
      : {}),
  };
}

// The launch events the trace view shows to non-admins. Source of truth is
// `apps/webapp/app/utils/timelineSpanEvents.ts`, which this package can't import.
const LAUNCH_EVENT_LABELS: Record<string, string> = {
  dequeue: "Dequeued",
  fork: "Launched",
  import: "Importing task file",
};

const MAX_TIMELINE_PHASES = 20;
const MAX_PHASE_LABEL_CHARS = 80;

type TimelinePhase = {
  label: string;
  startOffsetMs: number;
  durationMs?: number;
  status: "ongoing" | "done" | "error";
  detail?: string;
  spanId?: string;
};

// A hard cap including the ellipsis: the label is stored on the card and rendered, so
// it gets no "[truncated N chars]" marker.
function phaseLabel(message: unknown): string {
  const clean = sanitizeUntrusted(message ?? "Unnamed span");
  return clean.length > MAX_PHASE_LABEL_CHARS
    ? `${sliceWellFormed(clean, MAX_PHASE_LABEL_CHARS - 1)}…`
    : clean;
}

// The head (queue wait, launch events) always survives the cap. Of the work phases,
// anything still running does too, then the most recent fill what's left.
function capWorkPhases(work: TimelinePhase[], budget: number): TimelinePhase[] {
  if (budget <= 0) return [];
  if (work.length <= budget) return work;
  const kept = new Set(work.filter((phase) => phase.status === "ongoing").slice(-budget));
  for (let i = work.length - 1; i >= 0 && kept.size < budget; i--) kept.add(work[i]!);
  return work.filter((phase) => kept.has(phase));
}

// The SDK stamps launch events on the first attempt only, so the head and the work
// come off different spans on a retried run.
function attemptSpans(root: any) {
  let first: { number: number; span: any } | undefined;
  let latest: { number: number; span: any } | undefined;
  for (const child of root?.children ?? []) {
    const number = attemptNumberOf(child, 1);
    if (number === undefined) continue;
    if (!first || number < first.number) first = { number, span: child };
    if (!latest || number >= latest.number) latest = { number, span: child };
  }
  return { first: first?.span, latest: latest?.span };
}

/**
 * The card's timeline: queue wait, then the attempt's launch events, then its direct
 * children as the work it did. Stamped here so the renderer never reads its own clock.
 */
export function derivePhases(data: unknown, run?: any, source: TraceSource = "legacy") {
  const root = (data as any)?.trace?.rootSpan;
  if (!root) return undefined;

  const baseMs = run?.createdAt ? Date.parse(run.createdAt) : Date.parse(root.data?.startTime);
  if (!Number.isFinite(baseMs)) return undefined;

  const offsetOf = (at: unknown) => {
    const ms = Date.parse(String(at));
    return Number.isFinite(ms) ? Math.max(0, Math.round(ms - baseMs)) : undefined;
  };

  const head: TimelinePhase[] = [];
  const work: TimelinePhase[] = [];

  const { queueWaitMs, queueWaitReliable } = queueWait(run ?? {});
  if (queueWaitReliable && queueWaitMs !== null) {
    // A delayed run only starts waiting at `delayedUntil`, so the phase sits there —
    // offset plus duration always lands on `startedAt`.
    head.push({
      label: "Queued",
      startOffsetMs: run?.delayedUntil ? (offsetOf(run.delayedUntil) ?? 0) : 0,
      durationMs: queueWaitMs,
      status: "done",
    });
  }

  const attempt = attemptSpans(root);

  for (const event of attempt.first?.data?.events ?? []) {
    const name = event?.properties?.event;
    const label = typeof name === "string" ? LAUNCH_EVENT_LABELS[name] : undefined;
    const startOffsetMs = offsetOf(event?.time);
    if (!label || startOffsetMs === undefined) continue;
    const duration = event?.properties?.duration;
    head.push({
      label,
      startOffsetMs,
      ...(typeof duration === "number" && duration > 0 ? { durationMs: Math.round(duration) } : {}),
      status: "done",
    });
  }

  for (const child of attempt.latest?.children ?? []) {
    const d = child?.data ?? {};
    const startOffsetMs = offsetOf(d.startTime);
    if (startOffsetMs === undefined) continue;
    const spanMs = spanDurationMs(d, source);
    const durationMs = spanMs === undefined ? undefined : Math.max(0, spanMs);
    work.push({
      // Never fenced: this label is stored on the card and rendered as-is.
      label: phaseLabel(d.message),
      startOffsetMs,
      ...(durationMs !== undefined ? { durationMs } : {}),
      status: d.isError ? "error" : d.isPartial ? "ongoing" : "done",
      ...(d.taskSlug ? { detail: d.taskSlug } : {}),
      ...(typeof child.id === "string" ? { spanId: child.id } : {}),
    });
  }

  if (head.length === 0 && work.length === 0) return undefined;
  head.sort((a, b) => a.startOffsetMs - b.startOffsetMs);
  work.sort((a, b) => a.startOffsetMs - b.startOffsetMs);
  const phases = [
    ...head.slice(0, MAX_TIMELINE_PHASES),
    ...capWorkPhases(work, MAX_TIMELINE_PHASES - Math.min(head.length, MAX_TIMELINE_PHASES)),
  ];

  const asOfMs = Date.now();
  const finishedMs = run?.finishedAt ? Date.parse(run.finishedAt) : undefined;
  // Without the run row a finished run has to be measured off its own root span, or
  // the elapsed time silently becomes "however long ago this run was triggered".
  const rootStartMs = Date.parse(root.data?.startTime);
  const rootSpanMs = spanDurationMs(root.data ?? {}, source);
  const rootEndMs =
    rootSpanMs !== undefined && Number.isFinite(rootStartMs) ? rootStartMs + rootSpanMs : undefined;
  const endMs =
    finishedMs !== undefined && Number.isFinite(finishedMs) ? finishedMs : (rootEndMs ?? asOfMs);
  return {
    startedAt: new Date(baseMs).toISOString(),
    elapsedMs: Math.max(0, Math.round(endMs - baseMs)),
    asOf: new Date(asOfMs).toISOString(),
    phases,
    // A capped trace can be missing the latest attempt entirely, so a timeline off it
    // must not read as the whole run.
    ...((data as any)?.trace?.isTruncated || phases.length < head.length + work.length
      ? { truncated: true }
      : {}),
  };
}

export const MAX_RESULT_CHARS = 60_000;

/** The leading rows that fit the character budget, so one result can't flood context. */
export function capRows<T>(rows: T[], maxChars = MAX_RESULT_CHARS) {
  let used = 0;
  let kept = 0;
  for (const row of rows) {
    used += JSON.stringify(row)?.length ?? 0;
    if (used > maxChars) break;
    kept++;
  }
  const dropped = rows.length - kept;
  return {
    rows: rows.slice(0, kept),
    ...(dropped > 0
      ? { note: `${dropped} of ${rows.length} rows dropped to fit the result size. Narrow it.` }
      : {}),
  };
}

export function curateErrors(data: unknown) {
  const groups = (data as any)?.data ?? [];
  const errors = (Array.isArray(groups) ? groups : []).map((g: any) => ({
    id: g.id,
    taskIdentifier: fenceUntrusted("taskIdentifier", g.taskIdentifier),
    errorType: fenceUntrusted("errorType", g.errorType),
    errorMessage: fenceUntrusted("errorMessage", g.errorMessage),
    status: g.status,
    count: g.count,
    firstSeen: g.firstSeen,
    lastSeen: g.lastSeen,
  }));
  return { errors, nextCursor: (data as any)?.pagination?.next };
}

// The model's copy of `list_errors`, held to the result budget.
export function listErrorsModelOutput(output: any): JSONValue {
  if (!Array.isArray(output?.errors)) return output;
  const { rows, note } = capRows(output.errors);
  if (!note) return output;
  // A cursor past dropped rows would skip them for good.
  const { nextCursor: _skipped, ...rest } = output;
  return { ...rest, errors: rows, truncated: true, note };
}

export function curateError(group: any) {
  return {
    id: group.id,
    taskIdentifier: fenceUntrusted("taskIdentifier", group.taskIdentifier),
    errorType: fenceUntrusted("errorType", group.errorType),
    errorMessage: fenceUntrusted("errorMessage", group.errorMessage),
    status: group.status,
    count: group.count,
    firstSeen: group.firstSeen,
    lastSeen: group.lastSeen,
    affectedVersions: group.affectedVersions,
    resolvedAt: group.resolvedAt,
    resolvedInVersion: group.resolvedInVersion,
    resolvedBy: group.resolvedBy,
    ignoredAt: group.ignoredAt,
    ignoredUntil: group.ignoredUntil,
    ignoredReason: fenceUntrusted("ignoredReason", group.ignoredReason),
    ignoredByUserId: group.ignoredByUserId,
  };
}

// The card's copy: everything it draws. The model's copy is trimmed separately by
// `getReportModelOutput`, so this costs no context.
export function curateReport(data: unknown) {
  const vm = (data ?? {}) as any;
  const facts = (vm.facts ?? {}) as any;
  const flowEvidence = (facts.flowEvidence ?? {}) as any;
  return {
    title: vm.title,
    scope: vm.scope,
    period: vm.period,
    baselineLabel: vm.baselineLabel,
    generatedAt: vm.generatedAt,
    windowMinutes: vm.windowMinutes,
    summary: vm.summary,
    findings: (vm.findings ?? []).map((f: any) => ({
      type: f.type,
      severity: f.severity,
      reason: f.reason,
      read: f.read,
      metricIds: f.metricIds,
      recommendation: f.recommendation,
      hedge: f.hedge,
      anomalyWindow: f.anomalyWindow,
      attribution: f.attribution,
      exclusions: f.exclusions,
      observations: f.observations,
    })),
    metrics: (vm.metrics ?? []).map((m: any) => ({
      id: m.id,
      value: m.value,
      unit: m.unit,
      aggregation: m.aggregation,
      normal: m.normal,
      delta: m.delta,
      series: m.series,
      breakdown: m.breakdown,
      annotation: m.annotation,
      // "unknown" means `value` is a placeholder; "measured" is the default and is dropped.
      ...(m.availability === "unknown" ? { availability: "unknown" } : {}),
      severity: m.severity,
    })),
    facts: {
      trustworthy: facts.trustworthy,
      untrustworthyReason: facts.untrustworthyReason,
      flowSource: facts.flowSource,
      pendingEstimated: facts.pendingEstimated,
      throughput: facts.throughput,
      flowEvidence: {
        envLimit: flowEvidence.envLimit,
        throttledShare: flowEvidence.throttledShare,
        worstQueue: flowEvidence.worstQueue,
        dlqDelta: flowEvidence.dlqDelta,
      },
    },
    links: vm.links,
    footer: vm.footer,
  };
}

// What the model sees of a `render_view` result: an acknowledgement, not the card —
// echoing the canonicalized copy back would cost the prefix twice per investigation.
export function renderViewModelOutput(output: unknown): JSONValue {
  const result = (output ?? {}) as {
    error?: string;
    investigationId?: string;
    revision?: number;
  };
  if (result.error !== undefined) return { ok: false, error: result.error };
  return {
    ok: true,
    ...(result.investigationId ? { investigationId: result.investigationId } : {}),
    ...(result.revision !== undefined ? { revision: result.revision } : {}),
  };
}

// What the model sees of a `get_report` result: graded findings and metric values,
// without the render-only detail the report card draws from.
export function getReportModelOutput(output: unknown): JSONValue {
  const vm = (output ?? {}) as any;
  if (vm.error !== undefined) return { error: vm.error };
  const flowEvidence = vm.facts?.flowEvidence;
  const worstQueue = flowEvidence?.worstQueue;
  return {
    title: vm.title,
    scope: fenceUntrusted("reportScope", vm.scope),
    period: vm.period,
    summary: vm.summary,
    findings: (vm.findings ?? []).map((f: any) => ({
      type: f.type,
      severity: f.severity,
      reason: f.reason,
      read: f.read,
      metricIds: f.metricIds,
      recommendation: f.recommendation,
      hedge: f.hedge,
      anomalyWindow: f.anomalyWindow,
      attribution: f.attribution
        ? { ...f.attribution, key: fenceUntrusted("reportAttribution", f.attribution.key) }
        : f.attribution,
    })),
    metrics: (vm.metrics ?? []).map((m: any) => ({
      id: m.id,
      value: m.value,
      unit: m.unit,
      normal: m.normal,
      delta: m.delta,
      severity: m.severity,
      ...(m.availability === "unknown" ? { availability: "unknown" } : {}),
    })),
    facts: worstQueue
      ? {
          ...vm.facts,
          flowEvidence: {
            ...flowEvidence,
            worstQueue: { ...worstQueue, name: fenceUntrusted("queueName", worstQueue.name) },
          },
        }
      : vm.facts,
    ...(vm.uri ? { uri: vm.uri } : {}),
    detailOnCard: true,
  };
}

export function curateDeploy(deployment: any) {
  const git = (deployment?.git ?? undefined) as Record<string, unknown> | undefined;
  return {
    id: deployment?.id,
    version: deployment?.version,
    shortCode: deployment?.shortCode,
    status: deployment?.status,
    createdAt: deployment?.createdAt,
    deployedAt: deployment?.deployedAt,
    commitMessage: fenceUntrusted("commitMessage", git?.commitMessage),
    commitRef: fenceUntrusted("commitRef", git?.commitRef),
    pullRequestNumber: git?.pullRequestNumber,
    error: deployment?.error ? { name: deployment.error.name } : undefined,
  };
}

export function curateCommit(data: any) {
  const git = data?.git;
  return {
    runId: data?.runId,
    version: data?.version,
    sha:
      typeof data?.sha === "string" && /^[0-9a-f]{7,40}$/i.test(data.sha)
        ? data.sha
        : fenceUntrusted("sha", data?.sha),
    dirty: data?.dirty,
    shortCode: data?.shortCode,
    deployedAt: data?.deployedAt,
    git: git
      ? {
          source: git.source,
          commitMessage: fenceUntrusted("commitMessage", git.commitMessage),
          commitAuthorName: fenceUntrusted("commitAuthorName", git.commitAuthorName),
          commitRef: fenceUntrusted("commitRef", git.commitRef),
          remoteUrl: fenceUntrusted("remoteUrl", git.remoteUrl),
          ghUsername: fenceUntrusted("ghUsername", git.ghUsername),
          pullRequestNumber: git.pullRequestNumber,
          pullRequestTitle: fenceUntrusted("pullRequestTitle", git.pullRequestTitle),
          pullRequestState: git.pullRequestState,
        }
      : undefined,
  };
}

const MAX_PHASE_FIELD_CHARS = 200;
const MAX_TIMELINE_CHARS = 10_000;
// Room for the truncation note and the array punctuation `capRows` doesn't count.
const RESULT_SLACK_CHARS = 500;

// The card keeps the timeline's labels as-is; the model's copy gets them fenced, and the
// timeline and spans share one result budget.
export function runTraceModelOutput(output: any): JSONValue {
  if (!Array.isArray(output?.spans)) return output;
  const { spans, timeline, ...rest } = output;
  const phases = capRows(
    (timeline?.phases ?? []).map((phase: any) => ({
      ...phase,
      label: fenceUntrusted("phaseLabel", phase.label, MAX_PHASE_FIELD_CHARS),
      ...(phase.detail !== undefined
        ? { detail: fenceUntrusted("taskSlug", phase.detail, MAX_PHASE_FIELD_CHARS) }
        : {}),
    })),
    MAX_TIMELINE_CHARS
  );
  const fencedTimeline = timeline
    ? { ...timeline, phases: phases.rows, ...(phases.note ? { truncated: true } : {}) }
    : undefined;
  const used = JSON.stringify({ ...rest, timeline: fencedTimeline }).length + RESULT_SLACK_CHARS;
  const { rows, note } = capRows(spans, MAX_RESULT_CHARS - used);
  return {
    ...rest,
    spans: rows,
    ...(note ? { truncated: true, note } : {}),
    ...(fencedTimeline ? { timeline: fencedTimeline } : {}),
  };
}

// Values our own system sets; every other page string can carry customer text.
const PAGE_SAFE_KEYS = new Set(["kind", "runId", "status", "failedAt"]);

function fenceStrings(value: unknown, label: string): unknown {
  if (typeof value === "string") return fenceUntrusted(label, value);
  if (Array.isArray(value)) return value.map((item) => fenceStrings(item, label));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, fenceStrings(item, label)])
    );
  }
  return value;
}

export function fencePageFields<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      PAGE_SAFE_KEYS.has(key) ? item : fenceStrings(item, key),
    ])
  ) as T;
}

// Concurrency keys are set by whoever triggers the run, so they arrive as untrusted text.
export function curateQueueGrounding(grounding: QueueGrounding): QueueGrounding {
  if ("status" in grounding) return grounding;
  return {
    ...grounding,
    concurrencyKeys: {
      ...grounding.concurrencyKeys,
      rows: grounding.concurrencyKeys.rows.map((row) => ({
        ...row,
        key: fenceUntrusted("concurrencyKey", row.key)!,
      })),
    },
  };
}

// Anything larger than 30 days, or unparseable, clamps down.
const MAX_PERIOD_SECONDS = 30 * 24 * 60 * 60;
const PERIOD_UNIT_SECONDS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 };
export function clampPeriod(period: string): string {
  const match = /^(\d+)\s*([smhdw])$/.exec(period.trim());
  if (!match) return "30d";
  const seconds = Number(match[1]) * PERIOD_UNIT_SECONDS[match[2]];
  return seconds > MAX_PERIOD_SECONDS ? "30d" : period.trim();
}
