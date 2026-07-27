import {
  agentIntentSchema,
  formatTriggerUri,
  type AgentPageContext,
  type ParsedTriggerUri,
} from "@internal/dashboard-agent-contracts";
import { tool, type ToolSet } from "ai";
import {
  askSupportSchema,
  correlateVersionSchema,
  getCurrentPageSchema,
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
  navigateToSchema,
  renderViewSchema,
  runQuerySchema,
  searchDocsSchema,
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
  // RuntimeEnvironment id — the `{env}` component of every trigger:// URI this
  // turn emits. Names/slugs are display-only and must never appear in a URI.
  environmentId?: string;
  // The dashboard path the user is on, passed as context to ask_support.
  currentPage?: string;
  // Structured view of the same page, when the host could classify it. Read by
  // get_current_page so the agent can resolve "this run" without asking.
  pageContext?: AgentPageContext;
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
  return {
    traceId: (data as any)?.trace?.traceId,
    spans,
    truncated: spans.length >= MAX_TRACE_SPANS,
  };
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

/**
 * The health report VM, curated for a model.
 *
 * Everything that carries a judgement survives verbatim (summary, findings,
 * metrics, facts, footer) so the agent can quote the report's own grades instead
 * of re-deriving them. Two things are dropped: the per-metric `series` arrays
 * (nine × 48 numbers the model can't use in prose) and `links` (the route emits
 * them with empty urls). `seriesOmitted` records that the shape is lossy.
 *
 * `facts.trustworthy === false` means the telemetry behind the numbers is stale.
 * The prompt forbids acting on that; keep the flag at the top level of `facts` so
 * it can't be missed.
 */
function curateReport(data: unknown) {
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
      breakdown: m.breakdown,
      annotation: m.annotation,
      availability: m.availability,
      severity: m.severity,
    })),
    facts: {
      trustworthy: facts.trustworthy,
      staleReason: facts.staleReason,
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
    footer: vm.footer,
    seriesOmitted: true,
  };
}

function curateDeploy(deployment: any) {
  const git = (deployment?.git ?? undefined) as Record<string, unknown> | undefined;
  return {
    id: deployment?.id,
    version: deployment?.version,
    shortCode: deployment?.shortCode,
    status: deployment?.status,
    createdAt: deployment?.createdAt,
    deployedAt: deployment?.deployedAt,
    commitMessage: git?.commitMessage,
    commitRef: git?.commitRef,
    pullRequestNumber: git?.pullRequestNumber,
    error: deployment?.error ? { name: deployment.error.name } : undefined,
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

/**
 * Docs search, ported from the CLI's MCP `search_docs` tool
 * (packages/cli-v3/src/mcp/mintlifyClient.ts): a JSON-RPC `tools/call` against
 * the public Mintlify-hosted docs MCP endpoint. Public knowledge, so no auth and
 * no user data — same reasoning as ask_support, minus the shared secret.
 *
 * The endpoint answers with either JSON or a single-event SSE stream, so both are
 * handled. Returns the MCP result's text blocks, capped.
 */
const DOCS_MCP_URL = "https://trigger.dev/docs/mcp";
const DOCS_MCP_TOOL = "search_trigger_dev";
const DOCS_RESULT_MAX_CHARS = 20_000;

async function searchTriggerDocs(
  query: string,
  signal: AbortSignal
): Promise<{ results: string } | { error: string }> {
  let res: Response;
  try {
    res = await fetch(DOCS_MCP_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2025-06-18",
      },
      signal,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: DOCS_MCP_TOOL, arguments: { query } },
      }),
    });
  } catch (error) {
    return { error: `Couldn't reach the docs: ${(error as Error).message}` };
  }

  if (!res.ok) return { error: `The docs search failed (status ${res.status}).` };

  const body = await res.text();
  let payload: any;
  if (res.headers.get("content-type")?.includes("text/event-stream")) {
    // One `data:` event carries the whole JSON-RPC response.
    const line = body.split("\n").find((l) => l.startsWith("data:"));
    if (!line) return { error: "The docs search returned no data." };
    try {
      payload = JSON.parse(line.slice(5).trim());
    } catch {
      return { error: "The docs search returned an unreadable response." };
    }
  } else {
    try {
      payload = JSON.parse(body);
    } catch {
      return { error: "The docs search returned an unreadable response." };
    }
  }

  if (payload?.error?.message) return { error: `The docs search failed: ${payload.error.message}` };

  const content = payload?.result?.content;
  const text = (Array.isArray(content) ? content : [])
    .filter((part: any) => part?.type === "text" && typeof part.text === "string")
    .map((part: any) => part.text as string)
    .join("\n\n")
    .trim();

  if (!text) return { error: "The docs search found nothing for that query." };
  return { results: text.slice(0, DOCS_RESULT_MAX_CHARS) };
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
    return {
      tarballUrl: d.tarballUrl,
      owner: d.owner,
      repo: d.repo,
      sha: d.sha,
      defaultBranch: d.defaultBranch,
    };
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
        const result = await apiGet(
          origin,
          `/api/v1/projects/${ref}/environments`,
          userActorToken!
        );
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
        if (!result.ok)
          return { error: `Couldn't get the trace for ${runId} (status ${result.status}).` };
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
        if (!result.ok)
          return { error: `Couldn't get error ${errorId} (status ${result.status}).` };
        return curateError(result.data);
      },
    }),

    get_query_schema: tool({
      ...getQuerySchemaSchema,
      execute: async ({ table }) => {
        const envJwt = await getEnvJwt();
        if (!envJwt) return { error: "No current environment is available to query." };
        const result = await apiGet(origin, "/api/v1/query/schema", envJwt);
        if (!result.ok)
          return { error: `Couldn't load the query schema (status ${result.status}).` };
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
        const rows = Array.isArray(data.results)
          ? (data.results as Array<Record<string, unknown>>)
          : [];
        const cap = 200;
        return { rows: rows.slice(0, cap), rowCount: rows.length, truncated: rows.length > cap };
      },
    }),

    // Knowledge lane: forward the question to the support assistant via the
    // service-to-service /api/ask proxy (the support-chat agent composes the
    // answer). No user data and no UAT — knowledge is public, so this uses a
    // shared secret, runs server-side in the task, and never reaches the browser.
    ask_support: tool({
      ...askSupportSchema,
      execute: async ({ question }) => {
        const url = process.env.SUPPORT_ASK_URL ?? "http://localhost:3939/api/ask";
        const secret = process.env.SUPPORT_ASK_SECRET;
        if (!secret)
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
          // The endpoint streams a UI-message SSE; accumulate the text-delta
          // chunks into the final answer (tool-output-error chunks are noise).
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

    // Presentation tool, not a data tool: it renders a view spec the agent
    // composed from already-gathered data. zod validates the spec before this
    // runs, so execute just echoes it back as the tool output for the dashboard
    // render registry to pick up. No auth, no API call — always available.
    render_view: tool({
      ...renderViewSchema,
      execute: async (view) => view,
    }),

    get_report: tool({
      ...getReportSchema,
      execute: async ({ key, period }) => {
        const envJwt = await getEnvJwt();
        if (!envJwt) return { error: "No current environment is available to report on." };
        const reportKey = key ?? "health";
        const sp = new URLSearchParams({ format: "json" });
        if (period) sp.append("period", period);
        const result = await apiGet(
          origin,
          `/api/v1/reports/${encodeURIComponent(reportKey)}?${sp.toString()}`,
          envJwt
        );
        if (!result.ok) {
          return { error: `Couldn't get the ${reportKey} report (status ${result.status}).` };
        }
        // The report's own trigger:// URI travels with the snapshot, so the card
        // can show where it came from without re-deriving the scope. Built from
        // the RuntimeEnvironment *id* the proxy injects — never the env name.
        const uri =
          projectRef && ctx.environmentId
            ? formatTriggerUri({
                kind: "report",
                projectRef,
                environmentId: ctx.environmentId,
                key: reportKey,
              })
            : undefined;
        // Flat and curated: the tool output IS the (trimmed) view model, so the
        // panel's report-block adapter reads it directly. Deliberately NOT
        // accompanied by the untouched VM — carrying the metric series twice
        // would bloat the model's context for fields only the renderer reads.
        return { ...curateReport(result.data), ...(uri ? { uri } : {}) };
      },
    }),

    get_queue: tool({
      ...getQueueSchema,
      execute: async ({ queue, type, period }) => {
        const envJwt = await getEnvJwt();
        if (!envJwt) return { error: "No current environment is available to read queues from." };
        const sp = new URLSearchParams({ type: type ?? "task" });
        if (period) sp.append("period", period);
        // Double-encode the name: a task queue's ClickHouse name carries a `task/`
        // prefix, and the route un-escapes `%2F` back to `/` itself.
        const result = await apiGet(
          origin,
          `/api/v1/queues/${encodeURIComponent(queue)}/metrics?${sp.toString()}`,
          envJwt
        );
        if (!result.ok) {
          return {
            error: `Couldn't get metrics for the ${queue} queue (status ${result.status}).`,
          };
        }
        return result.data;
      },
    }),

    list_deploys: tool({
      ...listDeploysSchema,
      execute: async ({ status, period, limit }) => {
        const envJwt = await getEnvJwt();
        if (!envJwt) {
          return { error: "No current environment is available to read deployments from." };
        }
        const effectivePeriod = period ? clampPeriod(period) : undefined;
        const sp = new URLSearchParams();
        if (status) sp.append("status", status);
        if (effectivePeriod) sp.append("period", effectivePeriod);
        sp.append("page[size]", String(Math.min(limit ?? 10, 50)));
        const result = await apiGet(origin, `/api/v1/deployments?${sp.toString()}`, envJwt);
        if (!result.ok) return { error: `Couldn't list deployments (status ${result.status}).` };
        const rows = ((result.data as any)?.data ?? []) as any[];
        return {
          deploys: (Array.isArray(rows) ? rows : []).map(curateDeploy),
          period: effectivePeriod,
          nextCursor: (result.data as any)?.pagination?.next,
        };
      },
    }),

    get_deploy: tool({
      ...getDeploySchema,
      execute: async ({ version }) => {
        const envJwt = await getEnvJwt();
        if (!envJwt) {
          return { error: "No current environment is available to read deployments from." };
        }
        // No version: the promoted deployment, which is what new runs use.
        if (!version) {
          const result = await apiGet(origin, "/api/v1/deployments/current", envJwt);
          if (!result.ok) {
            return { error: `Couldn't get the current deployment (status ${result.status}).` };
          }
          return { deploy: curateDeploy(result.data), isCurrent: true };
        }
        // The public retrieve route is API-key-only, so find the version in the
        // JWT-reachable list instead. One page is plenty for "which deploy was
        // that"; anything older is a list_deploys question.
        const result = await apiGet(origin, "/api/v1/deployments?page[size]=100", envJwt);
        if (!result.ok) return { error: `Couldn't look up deployments (status ${result.status}).` };
        const rows = ((result.data as any)?.data ?? []) as any[];
        const match = (Array.isArray(rows) ? rows : []).find(
          (d: any) => d?.version === version || d?.shortCode === version
        );
        if (!match) {
          return {
            error: `No deployment ${version} in this environment's last 100 deploys. Use list_deploys to see what exists.`,
          };
        }
        return { deploy: curateDeploy(match), isCurrent: false };
      },
    }),

    correlate_version: tool({
      ...correlateVersionSchema,
      execute: async ({ runId }) => {
        if (!hasAuth) return NO_AUTH;
        if (!projectRef || !environmentName) {
          return { error: "No current environment is available to resolve the run's version." };
        }
        // A user-level route (like the repo snapshot), so this uses the delegated
        // token directly rather than the env JWT.
        const result = await apiGet(
          origin,
          `/api/v1/projects/${projectRef}/${environmentName}/runs/${encodeURIComponent(runId)}/commit`,
          userActorToken!
        );
        if (!result.ok) {
          if (result.status === 404) {
            return {
              error: `Run ${runId} isn't locked to a deployed version, so there's no commit to correlate (dev runs behave this way).`,
            };
          }
          return { error: `Couldn't resolve the commit for ${runId} (status ${result.status}).` };
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

    // Context tools: no fetch, no auth. They read what the host already told us
    // about this turn, or hand an intent back for the host to act on.
    get_current_page: tool({
      ...getCurrentPageSchema,
      execute: async () => {
        if (ctx.pageContext) {
          return {
            page: ctx.pageContext.page,
            signals: ctx.pageContext.signals,
            path: ctx.currentPage,
          };
        }
        // Older turns (and unclassified routes) carry only the raw path.
        if (ctx.currentPage) {
          return { page: { kind: "other", path: ctx.currentPage }, signals: [] };
        }
        return {
          page: null,
          signals: [],
          note: "This turn carried no page context, so ask the user what they're looking at.",
        };
      },
    }),

    navigate_to: tool({
      ...navigateToSchema,
      execute: async ({ destination }) => {
        if (!projectRef || !ctx.environmentId) {
          return {
            error:
              "No current project and environment for this turn, so there's nowhere to navigate to. Tell the user what to look at instead.",
          };
        }
        const scope = { projectRef, environmentId: ctx.environmentId };

        let parsed: ParsedTriggerUri;
        switch (destination.kind) {
          case "runs":
            // The runs collection URI; filters ride in the intent, not the URI.
            parsed = { kind: "runs", ...scope };
            break;
          case "run":
            parsed = { kind: "run", ...scope, runId: destination.runId };
            break;
          case "error":
            parsed = { kind: "error", ...scope, fingerprint: destination.fingerprint };
            break;
          case "queue":
            parsed = { kind: "queue", ...scope, name: destination.name };
            break;
          case "deployment":
            parsed = { kind: "deployment", ...scope, version: destination.version };
            break;
        }

        // Format, then re-validate through the intent schema, so a malformed id
        // becomes a tool error the model can recover from rather than an intent
        // the host has to reject.
        try {
          const intent = agentIntentSchema.parse({
            kind: "navigate",
            target: formatTriggerUri(parsed),
            ...(destination.kind === "runs" && destination.filters
              ? { filters: destination.filters }
              : {}),
          });
          return destination.kind === "runs"
            ? { intent, appliedFilters: destination.filters ?? {} }
            : { intent };
        } catch (error) {
          return { error: `Couldn't build a link for that: ${(error as Error).message}` };
        }
      },
    }),
  };

  // Code mode: when the project has a connected repo, add the source tools.
  if (!ctx.repoSnapshot) return apiTools;
  return { ...apiTools, ...buildRepoTools(ctx.repoSnapshot, resolveRunSnapshot) };
}
