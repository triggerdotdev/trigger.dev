import type { JSONValue } from "@ai-sdk/provider";
import { sliceWellFormed } from "@internal/dashboard-agent-contracts";

/**
 * Everything that trims an API payload down to what a tool returns, plus the two
 * `toModelOutput` projections and the period clamp. No IO, no auth.
 */

// Free-text captured from runs, errors and commits is authored outside our
// system, so it can carry text that reads like instructions to the model. Fence
// it in a hard-to-spoof provenance delimiter (named to the model in the system
// prompt) and cap its length so one field can't bury the fence or blow context.
const MAX_UNTRUSTED_FIELD_CHARS = 4096;
export function fenceUntrusted(label: string, text: unknown): string | undefined {
  if (text === undefined || text === null) return undefined;
  // Neutralize the guillemet delimiter bytes so the payload can't reproduce the
  // closing token and break out of its own fence. Guillemets are effectively
  // absent from real run/error/commit text, so flattening them to ASCII is safe.
  const raw = String(text).replaceAll("«", "<").replaceAll("»", ">");
  const capped =
    raw.length > MAX_UNTRUSTED_FIELD_CHARS
      ? `${sliceWellFormed(raw, MAX_UNTRUSTED_FIELD_CHARS)}…[truncated ${
          raw.length - MAX_UNTRUSTED_FIELD_CHARS
        } chars]`
      : raw;
  return `«untrusted:${label}» ${capped} «/untrusted:${label}»`;
}

/**
 * Mirrors dashboardAgentWatchRunChecks.describeRunWait: `queuedAt` only counts when the
 * source marked it reliable (a re-enqueue doesn't restamp it), else falls back to age.
 */
function computeRunWait(run: {
  createdAt?: unknown;
  startedAt?: unknown;
  finishedAt?: unknown;
  queuedAt?: unknown;
  queueWaitReliable?: unknown;
}):
  | { ms: number; measuredFrom: "queued" | "created"; reliable: boolean; label: string }
  | undefined {
  if (!run.createdAt) return undefined;
  const now = Date.now();
  const created = new Date(run.createdAt as string).getTime();
  const started = run.startedAt ? new Date(run.startedAt as string).getTime() : undefined;
  // A terminal run that never started (EXPIRED/CANCELED/...) stops waiting at finishedAt,
  // not at read-time — curation sees arbitrary history, not just live watch targets.
  const finished = run.finishedAt ? new Date(run.finishedAt as string).getTime() : undefined;
  const end = started ?? finished ?? now;
  const queuedAt = run.queuedAt ? new Date(run.queuedAt as string).getTime() : null;

  if (queuedAt !== null && run.queueWaitReliable === true) {
    const ms = Math.max(0, end - queuedAt);
    return { ms, measuredFrom: "queued", reliable: true, label: `queued for ${formatWaitMs(ms)}` };
  }

  const ms = Math.max(0, end - created);
  return {
    ms,
    measuredFrom: "created",
    reliable: false,
    label: `time from creation: ${formatWaitMs(ms)}`,
  };
}

function formatWaitMs(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.round(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const totalHours = Math.round(totalMinutes / 60);
  if (totalHours < 24) return `${totalHours}h`;
  return `${Math.round(totalHours / 24)}d`;
}

/**
 * The route lists projects across every org the user belongs to (it's identity-only,
 * no per-org authorization gate), so this is the only thing that scopes the result to
 * the conversation's organization. Missing `organizationId` fails closed to an empty
 * list rather than leaking every org's projects.
 */
export function curateProjects(data: unknown, organizationId?: string) {
  const projects = Array.isArray(data) ? data : [];
  const scoped = projects.filter((p: any) => p.organization?.id === organizationId);
  return {
    projects: scoped.map((p: any) => ({
      ref: p.externalRef,
      name: p.name,
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
      branchName: e.branchName ?? undefined,
    })),
  };
}

export function curateRun(run: any) {
  return {
    id: run.id,
    status: run.status,
    taskIdentifier: run.taskIdentifier,
    version: run.version,
    isQueued: run.isQueued,
    isExecuting: run.isExecuting,
    isCompleted: run.isCompleted,
    isFailed: run.isFailed,
    isCancelled: run.isCancelled,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    wait: computeRunWait(run),
    durationMs: run.durationMs,
    costInCents: run.costInCents,
    attemptCount: run.attemptCount,
    tags: run.tags,
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
      slug: t.slug,
      filePath: t.filePath,
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
      taskIdentifier: r.taskIdentifier,
      version: r.version,
      isTest: r.isTest,
      createdAt: r.createdAt,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      wait: computeRunWait(r),
      durationMs: r.durationMs,
      tags: r.tags,
    })),
    nextCursor: (data as any)?.pagination?.next,
  };
}

const MAX_TRACE_SPANS = 60;
export function curateTrace(data: unknown) {
  const root = (data as any)?.trace?.rootSpan;
  const spans: Array<Record<string, unknown>> = [];
  const walk = (span: any, depth: number) => {
    if (!span || spans.length >= MAX_TRACE_SPANS) return;
    const d = span.data ?? {};
    // The two flags are emitted only when true; absent means false.
    spans.push({
      spanId: span.id,
      depth,
      message: fenceUntrusted("spanMessage", d.message),
      task: d.taskSlug,
      durationMs: d.duration,
      level: d.level,
      ...(d.isError ? { isError: true } : {}),
      ...(d.isPartial ? { isPartial: true } : {}),
    });
    for (const child of span.children ?? []) walk(child, depth + 1);
  };
  walk(root, 0);
  return {
    traceId: (data as any)?.trace?.traceId,
    spans,
    truncated: spans.length >= MAX_TRACE_SPANS,
  };
}

export function curateErrors(data: unknown) {
  const groups = (data as any)?.data ?? [];
  return {
    errors: (Array.isArray(groups) ? groups : []).map((g: any) => ({
      id: g.id,
      taskIdentifier: g.taskIdentifier,
      errorType: fenceUntrusted("errorType", g.errorType),
      errorMessage: fenceUntrusted("errorMessage", g.errorMessage),
      status: g.status,
      count: g.count,
      firstSeen: g.firstSeen,
      lastSeen: g.lastSeen,
    })),
    nextCursor: (data as any)?.pagination?.next,
  };
}

export function curateError(group: any) {
  return {
    id: group.id,
    taskIdentifier: group.taskIdentifier,
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
    // True when an occurrence landed after the resolution, so the model never has to
    // compare resolvedAt/lastSeen dates itself.
    recurredSinceResolve: group.resolvedAt
      ? new Date(group.lastSeen).getTime() > new Date(group.resolvedAt).getTime()
      : undefined,
    ignoredAt: group.ignoredAt,
    ignoredUntil: group.ignoredUntil,
    ignoredReason: fenceUntrusted("ignoredReason", group.ignoredReason),
    ignoredByUserId: group.ignoredByUserId,
  };
}

// The card's copy: everything it draws, including the per-metric `series` and the
// `links` recommendations key into. The model's copy is trimmed separately by
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
      // "unknown" means `value` is a placeholder, not a measurement. "measured" is the
      // default and is dropped.
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

/**
 * What the model sees of a `render_view` result: an acknowledgement, not the card.
 *
 * The blocks are the panel's view model and the canonicalized copy is larger than
 * what the model wrote, so echoing it back cost the prefix twice per investigation
 * and again in the judge payload. Errors pass through verbatim — the prompt tells
 * the model to read them and render again.
 */
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

/**
 * What the model sees of a `get_report` result: the graded findings and metric
 * values, without the render-only detail the report card draws from (per-key
 * breakdowns, metric annotations, finding observations and exclusions, footer).
 */
export function getReportModelOutput(output: unknown): JSONValue {
  const vm = (output ?? {}) as any;
  if (vm.error !== undefined) return { error: vm.error };
  return {
    title: vm.title,
    scope: vm.scope,
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
      attribution: f.attribution,
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
    facts: vm.facts,
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

// Anything larger than 30 days, or unparseable, clamps down.
const MAX_PERIOD_SECONDS = 30 * 24 * 60 * 60;
const PERIOD_UNIT_SECONDS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 };
export function clampPeriod(period: string): string {
  const match = /^(\d+)\s*([smhdw])$/.exec(period.trim());
  if (!match) return "30d";
  const seconds = Number(match[1]) * PERIOD_UNIT_SECONDS[match[2]];
  return seconds > MAX_PERIOD_SECONDS ? "30d" : period.trim();
}
