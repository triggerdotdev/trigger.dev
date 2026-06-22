import { tool, type ToolSet } from "ai";
import {
  getErrorSchema,
  getQuerySchemaSchema,
  getRunSchema,
  getRunTraceSchema,
  listEnvironmentsSchema,
  listErrorsSchema,
  listProjectsSchema,
  listRunsSchema,
  listTasksSchema,
  renderViewSchema,
  runQuerySchema,
} from "./tool-schemas";
import { buildRepoTools, type RepoSnapshot } from "./repo-tools";

/**
 * Read-only tools for the dashboard agent. The agent is firewalled from the
 * main database, so every tool reaches the user's data the sanctioned way: the
 * public Trigger.dev API, authenticated as the user with the short-lived
 * delegated token the `in` proxy injects into the turn's metadata.
 *
 * - User-level reads (projects, environments) use the delegated token directly.
 * - Environment-scoped reads (runs, tasks, errors) first exchange the token for
 *   an env JWT for the current project + environment, then call the API with that.
 *
 * Tools return `{ error }` on failure rather than throwing, so the model can
 * recover and explain instead of the turn dying.
 */

// The per-turn context the `in` proxy injects server-side. All optional: on a
// turn that didn't carry a token (e.g. an older session) we expose no tools.
export type DashboardAgentToolContext = {
  userActorToken?: string;
  apiOrigin?: string;
  projectRef?: string;
  // Canonical API env name (dev/staging/prod/preview), resolved by the proxy.
  environmentName?: string;
  // Present only when the current project has a connected GitHub repo: a signed
  // archive pointer the code-mode file tools read from. Adds the source tools.
  repoSnapshot?: RepoSnapshot;
};

type FetchResult = { ok: true; data: unknown } | { ok: false; status: number };

async function apiGet(origin: string, path: string, token: string): Promise<FetchResult> {
  const res = await fetch(`${origin}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (!res.ok) return { ok: false, status: res.status };
  return { ok: true, data: await res.json() };
}

// Swap the delegated token for an env JWT scoped to the current project + env.
// The exchange ceilings these scopes to the token's read-only cap, so the JWT
// can never widen the grant. Returns null when there's no current env or the
// exchange is denied.
async function exchangeEnvJwt(
  origin: string,
  userActorToken: string,
  projectRef: string,
  environmentName: string
): Promise<string | null> {
  const res = await fetch(`${origin}/api/v1/projects/${projectRef}/${environmentName}/jwt`, {
    method: "POST",
    headers: { Authorization: `Bearer ${userActorToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      claims: { scopes: ["read:runs", "read:deployments", "read:errors", "read:query"] },
    }),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { token?: string };
  return data.token ?? null;
}

function curateProjects(data: unknown) {
  const projects = Array.isArray(data) ? data : [];
  return {
    projects: projects.map((p: any) => ({
      ref: p.externalRef,
      name: p.name,
      slug: p.slug,
      organization: p.organization?.title,
    })),
  };
}

function curateEnvironments(data: unknown) {
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

function curateRun(run: any) {
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
    durationMs: run.durationMs,
    costInCents: run.costInCents,
    attemptCount: run.attemptCount,
    tags: run.tags,
    error: run.error ? { name: run.error.name, message: run.error.message } : undefined,
  };
}

function curateTasks(data: unknown) {
  const tasks = (data as any)?.worker?.tasks ?? [];
  return {
    tasks: (Array.isArray(tasks) ? tasks : []).map((t: any) => ({
      slug: t.slug,
      filePath: t.filePath,
      triggerSource: t.triggerSource,
    })),
  };
}

function curateRuns(data: unknown) {
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
      durationMs: r.durationMs,
      tags: r.tags,
    })),
    nextCursor: (data as any)?.pagination?.next,
  };
}

// Flatten the nested trace tree into a compact, depth-tagged list so the model
// can reason over the timeline without the full span payloads (output,
// properties, raw events are dropped). Capped so a deep trace stays small.
const MAX_TRACE_SPANS = 60;
function curateTrace(data: unknown) {
  const root = (data as any)?.trace?.rootSpan;
  const spans: Array<Record<string, unknown>> = [];
  const walk = (span: any, depth: number) => {
    if (!span || spans.length >= MAX_TRACE_SPANS) return;
    const d = span.data ?? {};
    spans.push({
      depth,
      message: d.message,
      task: d.taskSlug,
      durationMs: d.duration,
      level: d.level,
      isError: d.isError,
      isPartial: d.isPartial,
    });
    for (const child of span.children ?? []) walk(child, depth + 1);
  };
  walk(root, 0);
  return { traceId: (data as any)?.trace?.traceId, spans, truncated: spans.length >= MAX_TRACE_SPANS };
}

function curateErrors(data: unknown) {
  const groups = (data as any)?.data ?? [];
  return {
    errors: (Array.isArray(groups) ? groups : []).map((g: any) => ({
      id: g.id,
      taskIdentifier: g.taskIdentifier,
      errorType: g.errorType,
      errorMessage: g.errorMessage,
      status: g.status,
      count: g.count,
      firstSeen: g.firstSeen,
      lastSeen: g.lastSeen,
    })),
    nextCursor: (data as any)?.pagination?.next,
  };
}

function curateError(group: any) {
  return {
    id: group.id,
    taskIdentifier: group.taskIdentifier,
    errorType: group.errorType,
    errorMessage: group.errorMessage,
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
    ignoredReason: group.ignoredReason,
    ignoredByUserId: group.ignoredByUserId,
  };
}

// Cap the run-list lookback at 30 days. Parse the `<number><unit>` window and
// clamp anything larger (or unparseable) down to 30d, so the agent can't scan
// huge time ranges. Returns the effective period so the model reports the real
// window it queried.
const MAX_PERIOD_SECONDS = 30 * 24 * 60 * 60;
const PERIOD_UNIT_SECONDS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 };
function clampPeriod(period: string): string {
  const match = /^(\d+)\s*([smhdw])$/.exec(period.trim());
  if (!match) return "30d";
  const seconds = Number(match[1]) * PERIOD_UNIT_SECONDS[match[2]];
  return seconds > MAX_PERIOD_SECONDS ? "30d" : period.trim();
}

const NO_AUTH = { error: "No delegated access is available for this turn." } as const;

// Always returns the same tool set so it stays stable across turns (the SDK
// replays it over prior history). When a turn carried no delegated token, each
// tool reports that rather than silently disappearing.
export function buildDashboardAgentTools(ctx: DashboardAgentToolContext): ToolSet {
  const { userActorToken, apiOrigin, projectRef, environmentName } = ctx;
  const origin = apiOrigin ? apiOrigin.replace(/\/$/, "") : "";
  const hasAuth = Boolean(userActorToken && origin);

  // Exchange lazily and once per turn — turns that never touch an env tool
  // never pay for the exchange.
  let envJwtPromise: Promise<string | null> | undefined;
  function getEnvJwt(): Promise<string | null> {
    if (!hasAuth || !projectRef || !environmentName) return Promise.resolve(null);
    envJwtPromise ??= exchangeEnvJwt(origin, userActorToken!, projectRef, environmentName);
    return envJwtPromise;
  }

  // Run-SHA pinning: ask the webapp for a snapshot pinned to a specific run's
  // deployed commit (it mints the scoped token + signed URL server-side). null
  // means the file tools fall back to the default tracked-branch snapshot.
  const resolveRunSnapshot = async (runId: string): Promise<RepoSnapshot | null> => {
    if (!hasAuth || !projectRef || !environmentName) return null;
    const result = await apiGet(
      origin,
      `/api/v1/projects/${projectRef}/${environmentName}/repo/snapshot?runId=${encodeURIComponent(runId)}`,
      userActorToken!
    );
    if (!result.ok) return null;
    const d = result.data as Partial<RepoSnapshot> | undefined;
    if (!d?.tarballUrl || !d.owner || !d.repo || !d.sha) return null;
    return { tarballUrl: d.tarballUrl, owner: d.owner, repo: d.repo, sha: d.sha, defaultBranch: d.defaultBranch };
  };

  const apiTools: ToolSet = {
    list_projects: tool({
      ...listProjectsSchema,
      execute: async () => {
        if (!hasAuth) return NO_AUTH;
        const result = await apiGet(origin, "/api/v1/projects", userActorToken!);
        if (!result.ok) return { error: `Couldn't list projects (status ${result.status}).` };
        return curateProjects(result.data);
      },
    }),

    list_environments: tool({
      ...listEnvironmentsSchema,
      execute: async ({ projectRef: inputRef }) => {
        if (!hasAuth) return NO_AUTH;
        const ref = inputRef ?? projectRef;
        if (!ref) return { error: "No project ref available. Ask the user which project." };
        const result = await apiGet(origin, `/api/v1/projects/${ref}/environments`, userActorToken!);
        if (!result.ok) return { error: `Couldn't list environments (status ${result.status}).` };
        return curateEnvironments(result.data);
      },
    }),

    get_run: tool({
      ...getRunSchema,
      execute: async ({ runId }) => {
        const envJwt = await getEnvJwt();
        if (!envJwt) return { error: "No current environment is available to read runs from." };
        const result = await apiGet(origin, `/api/v3/runs/${runId}`, envJwt);
        if (!result.ok) return { error: `Couldn't get run ${runId} (status ${result.status}).` };
        return curateRun(result.data);
      },
    }),

    list_tasks: tool({
      ...listTasksSchema,
      execute: async () => {
        if (!hasAuth) return NO_AUTH;
        if (!projectRef || !environmentName) {
          return { error: "No current environment is available to read tasks from." };
        }
        // The worker-by-tag route is user-level (PAT/UAT), so this uses the
        // delegated token directly — no env-JWT exchange.
        const result = await apiGet(
          origin,
          `/api/v1/projects/${projectRef}/${environmentName}/workers/current`,
          userActorToken!
        );
        if (!result.ok) return { error: `Couldn't list tasks (status ${result.status}).` };
        return curateTasks(result.data);
      },
    }),

    list_runs: tool({
      ...listRunsSchema,
      execute: async ({ status, taskIdentifier, errorId, period, limit }) => {
        const envJwt = await getEnvJwt();
        if (!envJwt) return { error: "No current environment is available to read runs from." };
        const effectivePeriod = period ? clampPeriod(period) : undefined;
        const sp = new URLSearchParams();
        if (status) sp.append("filter[status]", status);
        if (taskIdentifier) sp.append("filter[taskIdentifier]", taskIdentifier);
        if (errorId) sp.append("filter[error]", errorId);
        if (effectivePeriod) sp.append("filter[createdAt][period]", effectivePeriod);
        sp.append("page[size]", String(Math.min(limit ?? 10, 50)));
        const result = await apiGet(origin, `/api/v1/runs?${sp.toString()}`, envJwt);
        if (!result.ok) return { error: `Couldn't list runs (status ${result.status}).` };
        return { ...curateRuns(result.data), period: effectivePeriod };
      },
    }),

    get_run_trace: tool({
      ...getRunTraceSchema,
      execute: async ({ runId }) => {
        const envJwt = await getEnvJwt();
        if (!envJwt) return { error: "No current environment is available to read runs from." };
        const result = await apiGet(origin, `/api/v1/runs/${runId}/trace`, envJwt);
        if (!result.ok) return { error: `Couldn't get the trace for ${runId} (status ${result.status}).` };
        return curateTrace(result.data);
      },
    }),

    list_errors: tool({
      ...listErrorsSchema,
      execute: async ({ status, taskIdentifier, search, period, limit }) => {
        const envJwt = await getEnvJwt();
        if (!envJwt) return { error: "No current environment is available to read errors from." };
        const sp = new URLSearchParams();
        if (status) sp.append("filter[status]", status);
        if (taskIdentifier) sp.append("filter[taskIdentifier]", taskIdentifier);
        if (search) sp.append("filter[search]", search);
        if (period) sp.append("filter[period]", period);
        sp.append("page[size]", String(Math.min(limit ?? 20, 100)));
        const result = await apiGet(origin, `/api/v1/errors?${sp.toString()}`, envJwt);
        if (!result.ok) return { error: `Couldn't list errors (status ${result.status}).` };
        return curateErrors(result.data);
      },
    }),

    get_error: tool({
      ...getErrorSchema,
      execute: async ({ errorId }) => {
        const envJwt = await getEnvJwt();
        if (!envJwt) return { error: "No current environment is available to read errors from." };
        const result = await apiGet(origin, `/api/v1/errors/${errorId}`, envJwt);
        if (!result.ok) return { error: `Couldn't get error ${errorId} (status ${result.status}).` };
        return curateError(result.data);
      },
    }),

    get_query_schema: tool({
      ...getQuerySchemaSchema,
      execute: async ({ table }) => {
        const envJwt = await getEnvJwt();
        if (!envJwt) return { error: "No current environment is available to query." };
        const result = await apiGet(origin, "/api/v1/query/schema", envJwt);
        if (!result.ok) return { error: `Couldn't load the query schema (status ${result.status}).` };
        const tables = ((result.data as { tables?: any[] })?.tables ?? []) as any[];
        // No table → list what's queryable; a table → its columns.
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
          return { error: `Unknown table "${table}". Available: ${tables.map((t) => t.name).join(", ")}.` };
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
      execute: async ({ query, period }) => {
        const envJwt = await getEnvJwt();
        if (!envJwt) return { error: "No current environment is available to query." };
        let res: Response;
        try {
          res = await fetch(`${origin}/api/v1/query`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${envJwt}`,
              "Content-Type": "application/json",
              Accept: "application/json",
            },
            body: JSON.stringify({ query, scope: "environment", period, format: "json" }),
          });
        } catch (error) {
          return { error: `Query request failed: ${(error as Error).message}` };
        }
        // The route returns 400 with { error } for invalid TRQL; surface it so
        // the model can fix the query rather than the turn dying.
        const data = (await res.json().catch(() => ({}))) as { results?: unknown; error?: string };
        if (!res.ok) return { error: data.error ?? `Query failed (status ${res.status}).` };
        const rows = Array.isArray(data.results) ? (data.results as Array<Record<string, unknown>>) : [];
        const cap = 200;
        return { rows: rows.slice(0, cap), rowCount: rows.length, truncated: rows.length > cap };
      },
    }),

    // Presentation tool, not a data tool: it renders a view spec the agent
    // composed from already-gathered data. zod validates the spec before this
    // runs, so execute just echoes it back as the tool output for the dashboard
    // render registry to pick up. No auth, no API call — always available.
    render_view: tool({
      ...renderViewSchema,
      execute: async (view) => view,
    }),
  };

  // Code mode: when the project has a connected repo, add the source tools.
  if (!ctx.repoSnapshot) return apiTools;
  return { ...apiTools, ...buildRepoTools(ctx.repoSnapshot, resolveRunSnapshot) };
}
