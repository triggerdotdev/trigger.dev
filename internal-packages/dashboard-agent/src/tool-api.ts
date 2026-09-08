import {
  formatTriggerUri,
  queueGroundingSchema,
  type QueueGrounding,
} from "@internal/dashboard-agent-contracts";
import { tool, type ToolSet } from "ai";
import {
  askSupportSchema,
  correlateVersionSchema,
  getDeploySchema,
  getErrorSchema,
  getQuerySchemaSchema,
  getQueueSchema,
  getReportSchema,
  getRunSchema,
  getRunTraceSchema,
  listDeploysSchema,
  listEnvironmentsSchema,
  listErrorsSchema,
  listProjectsSchema,
  listRunsSchema,
  listTasksSchema,
  renderViewSchema,
  runQuerySchema,
  searchDocsSchema,
} from "./tool-schemas";
import {
  apiGet,
  fetchReason,
  isEnvUnavailable,
  NO_AUTH,
  type DashboardAgentApiClient,
  type EnvFetchResult,
  type EnvTarget,
  type EnvUnavailable,
} from "./tool-api-client";
import type { DashboardAgentToolContext } from "./tool-context";
import { bareFingerprint, recordRead } from "./tool-read-scope";
import type { ScopedReadKind, SourceReadLedger } from "./tool-source-ledger";
import {
  clampPeriod,
  curateDeploy,
  curateEnvironments,
  curateError,
  curateErrors,
  curateProjects,
  curateQueueGrounding,
  curateReport,
  curateRun,
  curateRuns,
  curateTasks,
  curateTrace,
  getReportModelOutput,
  renderViewModelOutput,
} from "./tool-curation";
import { searchTriggerDocs } from "./tool-docs";
import type { InvestigationRenderer } from "./tool-investigations";

function noEnvironmentError(action: string): { error: string } {
  return { error: `No current environment is available to ${action}.` };
}

/** Only a missing environment is stated as one; a failed exchange carries its status,
 * so an authorization failure is never reported as an absent environment. */
function envUnavailableError(result: EnvUnavailable, action: string): { error: string } {
  if (result.envUnavailable === "missing") return noEnvironmentError(action);
  const status = result.status ? ` (status ${result.status})` : "";
  return { error: `Couldn't reach the current environment to ${action}${status}.` };
}

/** The target fields every environment-bound tool takes, as the model may fill them in. */
export type TargetInput = { project?: string; environment?: string; branch?: string };

// Only the `proj_` prefix + one path segment: seeded refs don't match the generator's shape.
const PROJECT_REF = /^proj_[A-Za-z0-9_-]{1,64}$/;
const PROJECT_TOKEN = /^[A-Za-z0-9_-]{1,100}$/;
const ENVIRONMENT_NAMES = ["dev", "staging", "prod", "preview"];

type ProjectRow = { ref?: string; name?: string; slug?: string };

// One project list per turn, memoized off the (per-turn) tool context.
const projectLists = new WeakMap<object, Promise<ProjectRow[] | null>>();

/** The organization's projects as `list_projects` reports them, or null if unreadable. */
function turnProjects(ctx: DashboardAgentToolContext): Promise<ProjectRow[] | null> {
  let pending = projectLists.get(ctx);
  if (!pending) {
    const origin = ctx.apiOrigin ? ctx.apiOrigin.replace(/\/$/, "") : "";
    pending = (async () => {
      if (!origin || !ctx.userActorToken || !ctx.organizationId) return null;
      const result = await apiGet(origin, "/api/v1/projects", ctx.userActorToken);
      if (!result.ok) return null;
      return curateProjects(result.data, ctx.organizationId).projects as ProjectRow[];
    })().then((rows) => {
      // A failed read isn't the answer "no projects": don't pin the turn to it.
      if (!rows) projectLists.delete(ctx);
      return rows;
    });
    projectLists.set(ctx, pending);
  }
  return pending;
}

// An ambiguous or unknown name is an error, never a silent fallback to the conversation's own.
async function resolveProjectRef(
  value: string,
  ctx: DashboardAgentToolContext
): Promise<{ ok: true; ref: string; slug?: string } | { ok: false; error: string }> {
  if (PROJECT_REF.test(value)) return { ok: true, ref: value };
  const projects = await turnProjects(ctx);
  if (!projects) {
    return { ok: false, error: `Couldn't look up the organization's projects to find "${value}".` };
  }
  const bySlug = projects.filter((project) => project.slug === value);
  const matches =
    bySlug.length > 0
      ? bySlug
      : projects.filter((project) => project.name?.toLowerCase() === value.toLowerCase());
  if (matches.length === 0) {
    const slugs = projects.map((project) => project.slug).filter(Boolean);
    return {
      ok: false,
      error: `No project "${value}" in this organization. Available: ${slugs.join(", ") || "none"}.`,
    };
  }
  if (matches.length > 1) {
    const refs = matches.map((project) => project.ref).filter(Boolean);
    return {
      ok: false,
      error: `"${value}" matches more than one project. Name it by ref: ${refs.join(", ")}.`,
    };
  }
  const only = matches[0];
  if (!only.ref) return { ok: false, error: `Project "${value}" has no ref to address it by.` };
  return { ok: true, ref: only.ref, slug: only.slug };
}

/** Git's own branch-name rule, plus no leading `-`, which reads as a flag. */
function isBranchName(branch: string): boolean {
  if (!branch || branch === "@" || branch.startsWith("-")) return false;
  if (/[\s~^:?*[\\]/.test(branch) || /[\u0000-\u001f\u007f]/.test(branch)) return false;
  if (branch.includes("..") || branch.includes("@{") || branch.endsWith(".lock")) return false;
  return branch
    .split("/")
    .every((segment) => segment !== "" && !segment.startsWith(".") && !segment.endsWith("."));
}

// An omitted field (`undefined`, never `""`) falls back to the conversation's own scope.
export async function resolveTarget(
  input: TargetInput,
  ctx: DashboardAgentToolContext,
  action: string
): Promise<
  | { ok: true; target: EnvTarget; conversationScope: boolean; projectSlug?: string }
  | { ok: false; error: string }
> {
  if (input.project !== undefined && !PROJECT_TOKEN.test(input.project)) {
    return { ok: false, error: `"${input.project}" isn't a project ref or slug.` };
  }
  if (input.environment !== undefined && !ENVIRONMENT_NAMES.includes(input.environment)) {
    return {
      ok: false,
      error: `"${input.environment}" isn't an environment. Use ${ENVIRONMENT_NAMES.join(", ")}.`,
    };
  }
  if (input.branch !== undefined && !isBranchName(input.branch)) {
    return { ok: false, error: `"${input.branch}" isn't a branch name.` };
  }
  let projectRef = ctx.projectRef;
  let projectSlug: string | undefined;
  if (input.project !== undefined) {
    const found = await resolveProjectRef(input.project, ctx);
    if (!found.ok) return found;
    projectRef = found.ref;
    projectSlug = found.slug;
  }
  const environmentName = input.environment ?? ctx.environmentName;
  const conversationScope =
    projectRef === ctx.projectRef && environmentName === ctx.environmentName;
  const branch = input.branch ?? (conversationScope ? ctx.environmentBranch : undefined);
  if (!projectRef || !environmentName) {
    return { ok: false, ...noEnvironmentError(action) };
  }
  // "preview" alone addresses the parent environment; a branch row needs one named.
  if (environmentName === "preview" && !branch && !conversationScope) {
    return {
      ok: false,
      error: "Name the branch too: a preview environment is addressed by name plus branch.",
    };
  }
  return {
    ok: true,
    target: { projectRef, environmentName, ...(branch ? { branch } : {}) },
    conversationScope: conversationScope && branch === ctx.environmentBranch,
    ...(projectSlug ? { projectSlug } : {}),
  };
}

/** The project and environment an answer was actually read from. */
function scopeOf(resolved: { target: EnvTarget; projectSlug?: string }) {
  const { target, projectSlug } = resolved;
  return {
    project: { ref: target.projectRef, ...(projectSlug ? { slug: projectSlug } : {}) },
    environment: {
      name: target.environmentName,
      ...(target.branch ? { branch: target.branch } : {}),
    },
  };
}

function notFoundIn(
  resolved: { target: EnvTarget; projectSlug?: string },
  subject: string,
  locatableAsQueue?: boolean
): { error: string } {
  const { project, environment } = scopeOf(resolved);
  const where = `${project.slug ?? project.ref}/${environment.name}${
    environment.branch ? `@${environment.branch}` : ""
  }`;
  const how = locatableAsQueue ? 'call locate with kind "queue"' : "call locate";
  return {
    error: `${subject} not found in ${where}; ${how} to find it in the organization.`,
  };
}

function isNotFound(result: { ok: false; status?: number } | object): boolean {
  return "status" in result && (result as { status?: number }).status === 404;
}

/** A name-addressed project route, with both model-supplied segments escaped. */
function envPath(target: EnvTarget, suffix: string): string {
  const project = encodeURIComponent(target.projectRef);
  return `/api/v1/projects/${project}/${encodeURIComponent(target.environmentName)}${suffix}`;
}

/** Zeroed metrics mean "never seen" or "genuinely idle" alike — decides only whether to
 * try the other queue kind, never what to tell the user. */
export function queueMetricsAreEmpty(data: unknown): boolean {
  const d = data as {
    peakQueued?: number;
    startedCount?: number;
    throttledCount?: number;
    depthTrend?: unknown[];
    waitMs?: { p50?: number | null; p95?: number | null };
  } | null;
  if (!d) return true;
  return (
    (d.peakQueued ?? 0) === 0 &&
    (d.startedCount ?? 0) === 0 &&
    (d.throttledCount ?? 0) === 0 &&
    (d.depthTrend ?? []).length === 0 &&
    d.waitMs?.p50 == null &&
    d.waitMs?.p95 == null
  );
}

/** Strips the `task/` prefix for a custom queue: the route adds it back for task queues only. */
export function queueNameForKind(queue: string, kind: "task" | "custom"): string {
  return kind === "custom" ? queue.replace(/^task\//, "") : queue;
}

/** The deployed tasks whose `queueConfig` points at this queue — read off the task list,
 * never guessed from the queue's name. */
export function consumerTasksForQueue(workers: unknown, queueName: string): string[] {
  const tasks = (workers as { worker?: { tasks?: unknown } } | null)?.worker?.tasks;
  if (!Array.isArray(tasks)) return [];
  const slugs = new Set<string>();
  for (const task of tasks as Array<{ slug?: unknown; queueConfig?: { name?: unknown } | null }>) {
    if (typeof task?.slug !== "string") continue;
    if (task.queueConfig?.name === queueName) slugs.add(task.slug);
  }
  return [...slugs].sort();
}

/** A 404 ("missing") is distinct from a read that never landed ("unknown"): collapsing
 * them turns an expired token or a 5xx into "that queue doesn't exist". */
export type QueueLiveRead =
  | { kind: "row"; row: Record<string, unknown> }
  | { kind: "missing" }
  | { kind: "unknown"; status?: number };

export function readQueueLiveState(result: EnvFetchResult | null): QueueLiveRead {
  if (!result) return { kind: "unknown" };
  if (isEnvUnavailable(result)) {
    return {
      kind: "unknown",
      status: result.envUnavailable === "unknown" ? result.status : undefined,
    };
  }
  if (!result.ok) {
    if (!("status" in result)) return { kind: "unknown" };
    return result.status === 404 ? { kind: "missing" } : { kind: "unknown", status: result.status };
  }
  const row = (result.data as { data?: Record<string, unknown> })?.data ?? result.data;
  if (!row || typeof row !== "object") return { kind: "unknown" };
  return { kind: "row", row: row as Record<string, unknown> };
}

/** The better of two live reads: a row wins; else a failed read wins over a 404, since one
 * 404 with the other read broken is not proof. */
export function pickQueueLiveState(first: QueueLiveRead, second: QueueLiveRead): QueueLiveRead {
  if (first.kind === "row") return first;
  if (second.kind === "row") return second;
  if (first.kind === "unknown") return first;
  return second;
}

/** Metrics plus the live row. `exists` is `"unknown"`, not `false`, when the read failed —
 * an unreachable queue is not an absent one. */
export function withLiveState(metrics: unknown, queueType: "task" | "custom", live: QueueLiveRead) {
  if (live.kind === "missing") return { ...(metrics as object), queueType, exists: false };
  if (live.kind === "unknown") {
    return {
      ...(metrics as object),
      queueType,
      exists: "unknown" as const,
      liveStateError: live.status
        ? `Couldn't read the queue's live row (status ${live.status}).`
        : "Couldn't read the queue's live row.",
    };
  }
  const { row } = live;
  return {
    ...(metrics as object),
    queueType: (row.type as string) ?? queueType,
    exists: true,
    paused: Boolean(row.paused),
    queuedNow: row.queued ?? null,
    runningNow: row.running ?? null,
    concurrencyLimit: row.concurrencyLimit ?? null,
  };
}

const LEGACY_ENGINE_QUEUE_ERROR =
  "This environment runs the legacy run engine; live queue state (depth, limit, paused) and scheduler grounding are unavailable there. Metrics still work.";

/** The queue routes answer `400 {"error":"engine-version"}` on a legacy-engine environment. */
function isLegacyEngineRead(result: EnvFetchResult): boolean {
  if (isEnvUnavailable(result) || result.ok || !("status" in result)) return false;
  return (
    result.status === 400 &&
    (result.data as { error?: string } | undefined)?.error === "engine-version"
  );
}

const GROUNDING_UNAVAILABLE: QueueGrounding = {
  status: "unresolved",
  reason: "scheduler_unavailable",
};

// A transport failure or malformed payload reads as "grounding unavailable", never as zeros.
async function readQueueGrounding(
  envApiGet: DashboardAgentApiClient["envApiGet"],
  target: EnvTarget,
  queue: string,
  kind: "task" | "custom"
): Promise<QueueGrounding> {
  const result = await envApiGet(
    `/api/v1/dashboard-agent/queues/${encodeURIComponent(
      queueNameForKind(queue, kind)
    )}/grounding?type=${kind}`,
    target
  );
  if (isEnvUnavailable(result) || !result.ok) return GROUNDING_UNAVAILABLE;
  // Validate the shape, but pass the server's own object through — a re-encode would
  // silently drop a field the schema hasn't caught up to yet.
  const parsed = queueGroundingSchema.safeParse(result.data);
  return parsed.success
    ? curateQueueGrounding(result.data as QueueGrounding)
    : GROUNDING_UNAVAILABLE;
}

/** Failed `run_query` calls in a row before the tool tells the model to stop and answer. */
export const MAX_CONSECUTIVE_QUERY_FAILURES = 3;

export function buildApiTools(args: {
  ctx: DashboardAgentToolContext;
  client: DashboardAgentApiClient;
  renderInvestigations: InvestigationRenderer;
  reads?: SourceReadLedger;
}): ToolSet {
  const { ctx, client, renderInvestigations, reads } = args;
  const { userActorToken } = ctx;
  const { origin, hasAuth, envApiGet, postQuery, validateChartQuery, environmentIdFor } = client;

  // Records the scope a read actually landed in, so a citation of it canonicalizes there.
  async function noteRead(kind: "run" | ScopedReadKind, id: string, target: EnvTarget) {
    if (!reads) return;
    const environmentId = await environmentIdFor(target);
    if (!environmentId) {
      // Should be unreachable: this read already succeeded against `target`.
      console.warn(`dashboard-agent: couldn't resolve an environment id to scope a ${kind} read`, {
        id,
        target,
      });
      return;
    }
    recordRead(reads, kind, id, {
      projectRef: target.projectRef,
      environmentId,
      environmentName: target.environmentName,
    });
  }

  // Keyed off the RESOLVED target's environment id, never the conversation's own.
  async function evidenceUriFor(
    target: EnvTarget,
    build: (environmentId: string) => string
  ): Promise<string | undefined> {
    const environmentId = await environmentIdFor(target);
    return environmentId ? build(environmentId) : undefined;
  }

  /** The same uri, per row of a list, from the scope the rows were read from. */
  async function withRowUris<T extends object>(
    target: EnvTarget,
    rows: T[],
    build: (row: T, environmentId: string) => string | undefined
  ): Promise<T[]> {
    if (rows.length === 0) return rows;
    const environmentId = await environmentIdFor(target);
    if (!environmentId) return rows;
    return rows.map((row) => {
      const uri = build(row, environmentId);
      return uri ? { ...row, uri } : row;
    });
  }

  // Caps consecutive failures per turn, or a broken query could eat the whole step budget.
  let consecutiveQueryFailures = 0;

  return {
    list_projects: tool({
      ...listProjectsSchema,
      execute: async () => {
        if (!hasAuth) return NO_AUTH;
        const result = await apiGet(origin, "/api/v1/projects", userActorToken!);
        if (!result.ok) return { error: `Couldn't list projects${fetchReason(result)}.` };
        return curateProjects(result.data, ctx.organizationId);
      },
    }),

    list_environments: tool({
      ...listEnvironmentsSchema,
      execute: async ({ projectRef: inputRef }) => {
        if (!hasAuth) return NO_AUTH;
        if (inputRef !== undefined && !PROJECT_REF.test(inputRef)) {
          return { error: `"${inputRef}" isn't a project ref (proj_...).` };
        }
        const ref = inputRef ?? ctx.projectRef;
        if (!ref) return { error: "No project ref available. Ask the user which project." };
        const result = await apiGet(
          origin,
          `/api/v1/projects/${encodeURIComponent(ref)}/environments`,
          userActorToken!
        );
        if (!result.ok) return { error: `Couldn't list environments${fetchReason(result)}.` };
        return curateEnvironments(result.data);
      },
    }),

    list_tasks: tool({
      ...listTasksSchema,
      execute: async (input) => {
        if (!hasAuth) return NO_AUTH;
        const resolved = await resolveTarget(input, ctx, "read tasks from");
        if (!resolved.ok) return { error: resolved.error };
        // A user-level route, so it uses the delegated token with no env-JWT exchange.
        const result = await apiGet(
          origin,
          envPath(resolved.target, "/workers/current"),
          userActorToken!,
          resolved.target.branch
        );
        if (!result.ok) return { error: `Couldn't list tasks${fetchReason(result)}.` };
        return { ...scopeOf(resolved), ...curateTasks(result.data) };
      },
    }),

    list_runs: tool({
      ...listRunsSchema,
      execute: async (input) => {
        const resolved = await resolveTarget(input, ctx, "read runs from");
        if (!resolved.ok) return { error: resolved.error };
        const { status, taskIdentifier, errorId, period, limit } = input;
        const effectivePeriod = period ? clampPeriod(period) : undefined;
        const sp = new URLSearchParams();
        if (status) sp.append("filter[status]", status);
        if (taskIdentifier) sp.append("filter[taskIdentifier]", taskIdentifier);
        if (errorId) sp.append("filter[error]", errorId);
        if (effectivePeriod) sp.append("filter[createdAt][period]", effectivePeriod);
        sp.append("page[size]", String(Math.min(limit ?? 10, 50)));
        const result = await envApiGet(`/api/v1/runs?${sp.toString()}`, resolved.target);
        if (isEnvUnavailable(result)) return envUnavailableError(result, "read runs from");
        if (!result.ok) return { error: `Couldn't list runs${fetchReason(result)}.` };
        const curated = curateRuns(result.data);
        await Promise.all(curated.runs.map((r) => noteRead("run", r.id, resolved.target)));
        const runs = await withRowUris(resolved.target, curated.runs, (run, environmentId) =>
          typeof run.id === "string"
            ? formatTriggerUri({
                kind: "run",
                projectRef: resolved.target.projectRef,
                environmentId,
                runId: run.id,
              })
            : undefined
        );
        return { ...curated, runs, period: effectivePeriod };
      },
    }),

    // Order matters up to here: `dashboardAgentToolSchemas` is the canonical key
    // order (head start builds its prefix from it), and a different order is a
    // different cached prefix.
    get_run: tool({
      ...getRunSchema,
      execute: async (input) => {
        const resolved = await resolveTarget(input, ctx, "read runs from");
        if (!resolved.ok) return { error: resolved.error };
        const { runId } = input;
        const result = await envApiGet(
          `/api/v3/runs/${encodeURIComponent(runId)}`,
          resolved.target
        );
        if (isEnvUnavailable(result)) return envUnavailableError(result, "read runs from");
        if (!result.ok) {
          if (isNotFound(result)) return notFoundIn(resolved, `Run ${runId}`);
          return { error: `Couldn't get run ${runId}${fetchReason(result)}.` };
        }
        await noteRead("run", runId, resolved.target);
        const uri = await evidenceUriFor(resolved.target, (environmentId) =>
          formatTriggerUri({
            kind: "run",
            projectRef: resolved.target.projectRef,
            environmentId,
            runId,
          })
        );
        return { ...curateRun(result.data), ...(uri ? { uri } : {}) };
      },
    }),

    get_run_trace: tool({
      ...getRunTraceSchema,
      execute: async (input) => {
        const resolved = await resolveTarget(input, ctx, "read runs from");
        if (!resolved.ok) return { error: resolved.error };
        const { runId } = input;
        const result = await envApiGet(
          `/api/v1/runs/${encodeURIComponent(runId)}/trace`,
          resolved.target
        );
        if (isEnvUnavailable(result)) return envUnavailableError(result, "read runs from");
        if (!result.ok) {
          if (isNotFound(result)) return notFoundIn(resolved, `Run ${runId}`);
          return { error: `Couldn't get the trace for ${runId}${fetchReason(result)}.` };
        }
        await noteRead("run", runId, resolved.target);
        const curated = curateTrace(result.data);
        const environmentId = await environmentIdFor(resolved.target);
        const spans = environmentId
          ? curated.spans.map((span) =>
              typeof span.id === "string"
                ? {
                    ...span,
                    uri: formatTriggerUri({
                      kind: "span",
                      projectRef: resolved.target.projectRef,
                      environmentId,
                      runId,
                      spanId: span.id,
                    }),
                  }
                : span
            )
          : curated.spans;
        return { ...curated, spans };
      },
    }),

    list_errors: tool({
      ...listErrorsSchema,
      execute: async (input) => {
        const resolved = await resolveTarget(input, ctx, "read errors from");
        if (!resolved.ok) return { error: resolved.error };
        const { status, taskIdentifier, search, period, limit } = input;
        const sp = new URLSearchParams();
        if (status) sp.append("filter[status]", status);
        if (taskIdentifier) sp.append("filter[taskIdentifier]", taskIdentifier);
        if (search) sp.append("filter[search]", search);
        if (period) sp.append("filter[period]", period);
        sp.append("page[size]", String(Math.min(limit ?? 20, 100)));
        const result = await envApiGet(`/api/v1/errors?${sp.toString()}`, resolved.target);
        if (isEnvUnavailable(result)) return envUnavailableError(result, "read errors from");
        if (!result.ok) return { error: `Couldn't list errors${fetchReason(result)}.` };
        const curated = curateErrors(result.data);
        await Promise.all(curated.errors.map((e) => noteRead("error", e.id, resolved.target)));
        const errors = await withRowUris(resolved.target, curated.errors, (error, environmentId) =>
          typeof error.id === "string"
            ? formatTriggerUri({
                kind: "error",
                projectRef: resolved.target.projectRef,
                environmentId,
                fingerprint: bareFingerprint(error.id),
              })
            : undefined
        );
        return { ...curated, errors };
      },
    }),

    get_error: tool({
      ...getErrorSchema,
      execute: async (input) => {
        const resolved = await resolveTarget(input, ctx, "read errors from");
        if (!resolved.ok) return { error: resolved.error };
        const { errorId } = input;
        const result = await envApiGet(
          `/api/v1/errors/${encodeURIComponent(errorId)}`,
          resolved.target
        );
        if (isEnvUnavailable(result)) return envUnavailableError(result, "read errors from");
        if (!result.ok) {
          if (isNotFound(result)) return notFoundIn(resolved, `Error ${errorId}`);
          return { error: `Couldn't get error ${errorId}${fetchReason(result)}.` };
        }
        await noteRead("error", errorId, resolved.target);
        const uri = await evidenceUriFor(resolved.target, (environmentId) =>
          formatTriggerUri({
            kind: "error",
            projectRef: resolved.target.projectRef,
            environmentId,
            fingerprint: bareFingerprint(errorId),
          })
        );
        return { ...curateError(result.data), ...(uri ? { uri } : {}) };
      },
    }),

    get_query_schema: tool({
      ...getQuerySchemaSchema,
      execute: async (input) => {
        const resolved = await resolveTarget(input, ctx, "query");
        if (!resolved.ok) return { error: resolved.error };
        const { table } = input;
        const result = await envApiGet("/api/v1/query/schema", resolved.target);
        if (isEnvUnavailable(result)) return envUnavailableError(result, "query");
        if (!result.ok) return { error: `Couldn't load the query schema${fetchReason(result)}.` };
        const tables = ((result.data as { tables?: any[] })?.tables ?? []) as any[];
        if (!table) {
          return {
            tables: tables.map((t) => ({
              name: t.name,
              description: t.description,
              timeColumn: t.timeColumn,
            })),
          };
        }
        const match = tables.find((t) => t.name === table);
        if (!match) {
          return {
            error: `Unknown table "${table}". Available: ${tables.map((t) => t.name).join(", ")}.`,
          };
        }
        return {
          name: match.name,
          description: match.description,
          timeColumn: match.timeColumn,
          columns: (match.columns ?? []).map((c: any) => ({
            name: c.name,
            type: c.type,
            description: c.description,
            allowedValues: c.allowedValues,
            coreColumn: c.coreColumn,
          })),
        };
      },
    }),

    run_query: tool({
      ...runQuerySchema,
      execute: async (input) => {
        const resolved = await resolveTarget(input, ctx, "query");
        if (!resolved.ok) return { error: resolved.error };
        const result = await postQuery(input.query, input.period, resolved.target);
        if (isEnvUnavailable(result)) return envUnavailableError(result, "query");
        if (!result.ok) {
          // Only SQL errors count toward the cap; transport/busy errors may work on a retry.
          if (result.kind === "query") {
            consecutiveQueryFailures++;
            if (consecutiveQueryFailures >= MAX_CONSECUTIVE_QUERY_FAILURES) {
              return {
                error: `${result.error} That is ${consecutiveQueryFailures} queries in a row that failed. Stop querying and answer the user with what you already have.`,
              };
            }
          }
          return { error: result.error };
        }
        consecutiveQueryFailures = 0;
        const cap = 200;
        const rows = result.rows;
        return { rows: rows.slice(0, cap), rowCount: rows.length, truncated: rows.length > cap };
      },
    }),

    // No user data and no delegated token: this uses a server-side shared secret.
    ask_support: tool({
      ...askSupportSchema,
      execute: async ({ question }) => {
        // Both or nothing: a default URL would send the secret somewhere unintended.
        const url = process.env.SUPPORT_ASK_URL;
        const secret = process.env.SUPPORT_ASK_SECRET;
        if (!url || !secret)
          return { error: "The support assistant isn't configured in this environment." };
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 60_000);
        try {
          const res = await fetch(url, {
            method: "POST",
            headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              question,
              context: ctx.currentPage ? { currentPage: ctx.currentPage } : undefined,
            }),
            signal: controller.signal,
          });
          if (!res.ok)
            return { error: `The support assistant request failed (status ${res.status}).` };
          // The endpoint streams a UI-message SSE, so text-delta chunks accumulate.
          const body = await res.text();
          let answer = "";
          for (const line of body.split("\n")) {
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === "[DONE]") continue;
            try {
              const chunk = JSON.parse(payload) as { type?: string; delta?: string };
              if (chunk.type === "text-delta" && typeof chunk.delta === "string")
                answer += chunk.delta;
            } catch {
              // Skip keepalives / non-JSON lines.
            }
          }
          answer = answer.trim();
          return answer ? { answer } : { error: "The support assistant returned no answer." };
        } catch (error) {
          return { error: `Couldn't reach the support assistant: ${(error as Error).message}` };
        } finally {
          clearTimeout(timer);
        }
      },
    }),

    // A `chart` block's query runs here first — the panel would run it too late to report.
    render_view: tool({
      ...renderViewSchema,
      execute: async (view) => {
        const scope = await resolveTarget({}, ctx, "render a chart");
        for (const block of view.blocks) {
          if (block.type !== "chart") continue;
          const queryError = await validateChartQuery(
            block.query,
            block.period,
            scope.ok ? scope.target : undefined
          );
          if (queryError) {
            return {
              error: `The chart query failed: ${queryError}. Fix the query — column names are snake_case — and render the chart again.`,
            };
          }
        }
        return renderInvestigations(view.blocks, view.investigationId);
      },
      // The client keeps the blocks; the model only gets the acknowledgement.
      toModelOutput: ({ output }) => ({ type: "json", value: renderViewModelOutput(output) }),
    }),

    get_report: tool({
      ...getReportSchema,
      execute: async (input) => {
        const resolved = await resolveTarget(input, ctx, "report on");
        if (!resolved.ok) return { error: resolved.error };
        const reportKey = input.key ?? "health";
        const sp = new URLSearchParams({ format: "json" });
        if (input.period) sp.append("period", input.period);
        const result = await envApiGet(
          `/api/v1/reports/${encodeURIComponent(reportKey)}?${sp.toString()}`,
          resolved.target
        );
        if (isEnvUnavailable(result)) return envUnavailableError(result, "report on");
        if (!result.ok) {
          return { error: `Couldn't get the ${reportKey} report${fetchReason(result)}.` };
        }
        await noteRead("report", reportKey, resolved.target);
        const uri = await evidenceUriFor(resolved.target, (environmentId) =>
          formatTriggerUri({
            kind: "report",
            projectRef: resolved.target.projectRef,
            environmentId,
            key: reportKey,
          })
        );
        // The tool output IS the trimmed view model the panel's report block reads.
        return { ...curateReport(result.data), ...(uri ? { uri } : {}) };
      },
      // The card renders the full view model; the model reads the graded summary.
      toModelOutput: ({ output }) => ({ type: "json", value: getReportModelOutput(output) }),
    }),

    get_queue: tool({
      ...getQueueSchema,
      execute: async (input) => {
        const resolved = await resolveTarget(input, ctx, "read queues from");
        if (!resolved.ok) return { error: resolved.error };
        const { target } = resolved;
        const { queue, type, period } = input;
        let legacyEngine = false;
        const watchEngine = (result: EnvFetchResult) => {
          if (isLegacyEngineRead(result)) legacyEngine = true;
          return result;
        };
        // The metrics route answers an unknown queue with zeroes rather than a 404, so a
        // wrong `type` reads exactly like an idle queue — try the other kind before believing it.
        const read = async (kind: "task" | "custom") => {
          const sp = new URLSearchParams({ type: kind });
          if (period) sp.append("period", period);
          // Queue names may contain `/`; encode them as a single path segment.
          const result = await envApiGet(
            `/api/v1/queues/${encodeURIComponent(queueNameForKind(queue, kind))}/metrics?${sp.toString()}`,
            target
          );
          return watchEngine(result);
        };

        // Live state first: metrics are a window and can't say "paused" — a queue nobody
        // is running isn't the same as a queue someone stopped.
        const live = async (kind: "task" | "custom") => {
          const result = await envApiGet(
            `/api/v1/queues/${encodeURIComponent(queueNameForKind(queue, kind))}?type=${kind}`,
            target
          );
          return readQueueLiveState(watchEngine(result));
        };

        // Only a custom queue needs a consumer read: a task queue's consumer is its own task.
        const answer = async (
          metrics: unknown,
          kind: "task" | "custom",
          state: QueueLiveRead,
          grounding: QueueGrounding
        ) => {
          if (legacyEngine) return { error: LEGACY_ENGINE_QUEUE_ERROR };
          const withGrounding = {
            ...scopeOf(resolved),
            ...withLiveState(metrics, kind, state),
            grounding,
          };
          // Only a confirmed-existing queue is a real read: zeroed metrics or a 404 say
          // nothing about which environment's queue this name is.
          let uri: string | undefined;
          if (withGrounding.exists === true) {
            // Cite the name actually looked up (post task/-strip), not the raw input.
            const resolvedQueueName = queueNameForKind(queue, kind);
            await noteRead("queue", resolvedQueueName, target);
            uri = await evidenceUriFor(target, (environmentId) =>
              formatTriggerUri({
                kind: "queue",
                projectRef: target.projectRef,
                environmentId,
                name: resolvedQueueName,
              })
            );
          }
          const notFound =
            withGrounding.exists === false
              ? notFoundIn(resolved, `Queue ${queueNameForKind(queue, kind)}`, true).error
              : undefined;
          const base = {
            ...withGrounding,
            ...(uri ? { uri } : {}),
            ...(notFound ? { notFound } : {}),
          };
          if (base.queueType !== "custom" || !hasAuth) return base;
          const workers = await apiGet(
            origin,
            envPath(target, "/workers/current"),
            userActorToken!,
            target.branch
          );
          if (!workers.ok) return base;
          return {
            ...base,
            consumerTasks: consumerTasksForQueue(workers.data, queueNameForKind(queue, "custom")),
          };
        };

        // Fetched alongside the live row/metrics once the answered kind is known.
        const groundingFor = (kind: "task" | "custom") =>
          readQueueGrounding(envApiGet, target, queue, kind);

        const first = await read(type ?? "task");
        if (isEnvUnavailable(first)) return envUnavailableError(first, "read queues from");
        if (!first.ok) {
          if (legacyEngine) return { error: LEGACY_ENGINE_QUEUE_ERROR };
          return {
            error: `Couldn't get metrics for the ${queue} queue${fetchReason(first)}.`,
          };
        }
        if (queueMetricsAreEmpty(first.data)) {
          const otherKind = type === "custom" ? "task" : "custom";
          const other = await read(otherKind);
          if (!isEnvUnavailable(other) && other.ok && !queueMetricsAreEmpty(other.data)) {
            const [state, grounding] = await Promise.all([
              live(otherKind),
              groundingFor(otherKind),
            ]);
            return await answer(other.data, otherKind, state, grounding);
          }
          // Neither kind has metrics; the live row is the only thing that can tell them apart.
          const kind = type ?? "task";
          const primary = await live(kind);
          if (primary.kind === "row") {
            return await answer(first.data, kind, primary, await groundingFor(kind));
          }
          // Ground on whichever kind actually answered, never the one tried first.
          const secondary = await live(otherKind);
          const state = pickQueueLiveState(primary, secondary);
          const winningKind = state === secondary ? otherKind : kind;
          return await answer(first.data, winningKind, state, await groundingFor(winningKind));
        }
        const kind = type ?? "task";
        const [state, grounding] = await Promise.all([live(kind), groundingFor(kind)]);
        return await answer(first.data, kind, state, grounding);
      },
    }),

    list_deploys: tool({
      ...listDeploysSchema,
      execute: async (input) => {
        const resolved = await resolveTarget(input, ctx, "read deployments from");
        if (!resolved.ok) return { error: resolved.error };
        const { status, period, limit } = input;
        const effectivePeriod = period ? clampPeriod(period) : undefined;
        const sp = new URLSearchParams();
        if (status) sp.append("status", status);
        if (effectivePeriod) sp.append("period", effectivePeriod);
        sp.append("page[size]", String(Math.min(limit ?? 10, 50)));
        const result = await envApiGet(`/api/v1/deployments?${sp.toString()}`, resolved.target);
        if (isEnvUnavailable(result)) return envUnavailableError(result, "read deployments from");
        if (!result.ok) return { error: `Couldn't list deployments${fetchReason(result)}.` };
        const rows = ((result.data as any)?.data ?? []) as any[];
        const curatedDeploys = (Array.isArray(rows) ? rows : []).map(curateDeploy);
        await Promise.all(
          curatedDeploys.map((d) =>
            d.version ? noteRead("deployment", d.version, resolved.target) : null
          )
        );
        const deploys = await withRowUris(
          resolved.target,
          curatedDeploys,
          (deploy, environmentId) =>
            deploy.version
              ? formatTriggerUri({
                  kind: "deployment",
                  projectRef: resolved.target.projectRef,
                  environmentId,
                  version: deploy.version,
                })
              : undefined
        );
        return {
          deploys,
          period: effectivePeriod,
          nextCursor: (result.data as any)?.pagination?.next,
        };
      },
    }),

    get_deploy: tool({
      ...getDeploySchema,
      execute: async (input) => {
        const resolved = await resolveTarget(input, ctx, "read deployments from");
        if (!resolved.ok) return { error: resolved.error };
        const { version } = input;
        const noEnv = (r: EnvUnavailable) => envUnavailableError(r, "read deployments from");
        const withUri = async (deploy: ReturnType<typeof curateDeploy>) => {
          if (!deploy.version) return deploy;
          await noteRead("deployment", deploy.version, resolved.target);
          const uri = await evidenceUriFor(resolved.target, (environmentId) =>
            formatTriggerUri({
              kind: "deployment",
              projectRef: resolved.target.projectRef,
              environmentId,
              version: deploy.version,
            })
          );
          return { ...deploy, ...(uri ? { uri } : {}) };
        };
        // No version: the promoted deployment, which is what new runs use.
        if (!version) {
          const result = await envApiGet("/api/v1/deployments/current", resolved.target);
          if (isEnvUnavailable(result)) return noEnv(result);
          if (!result.ok) {
            return { error: `Couldn't get the current deployment${fetchReason(result)}.` };
          }
          return { deploy: await withUri(curateDeploy(result.data)), isCurrent: true };
        }
        // The public retrieve route is API-key-only; find the version in the JWT-reachable list.
        const result = await envApiGet("/api/v1/deployments?page[size]=100", resolved.target);
        if (isEnvUnavailable(result)) return noEnv(result);
        if (!result.ok) return { error: `Couldn't look up deployments${fetchReason(result)}.` };
        const rows = ((result.data as any)?.data ?? []) as any[];
        const match = (Array.isArray(rows) ? rows : []).find(
          (d: any) => d?.version === version || d?.shortCode === version
        );
        if (!match) {
          return {
            error: `No deployment ${version} in this environment's last 100 deploys. Use list_deploys to see what exists.`,
          };
        }
        return { deploy: await withUri(curateDeploy(match)), isCurrent: false };
      },
    }),

    correlate_version: tool({
      ...correlateVersionSchema,
      execute: async (input) => {
        if (!hasAuth) return NO_AUTH;
        const resolved = await resolveTarget(input, ctx, "resolve the run's version");
        if (!resolved.ok) return { error: resolved.error };
        const { runId } = input;
        // A user-level route, so this uses the delegated token rather than the env JWT.
        const result = await apiGet(
          origin,
          envPath(resolved.target, `/runs/${encodeURIComponent(runId)}/commit`),
          userActorToken!,
          resolved.target.branch
        );
        if (!result.ok) {
          // Only a real 404 says "no commit"; a transport failure says nothing.
          if (isNotFound(result)) {
            return {
              error: `Run ${runId} isn't locked to a deployed version, so there's no commit to correlate (dev runs behave this way).`,
            };
          }
          return { error: `Couldn't resolve the commit for ${runId}${fetchReason(result)}.` };
        }
        return result.data;
      },
    }),

    search_docs: tool({
      ...searchDocsSchema,
      execute: async ({ query }) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 30_000);
        try {
          return await searchTriggerDocs(query, controller.signal);
        } finally {
          clearTimeout(timer);
        }
      },
    }),
  };
}
