import {
  agentIntentSchema,
  formatTriggerUri,
  INVESTIGATION_CAPABILITIES_VERSION,
  investigationBlockSchema,
  safeParseTriggerUri,
  VIEW_BLOCK_VERSION,
  WATCH_MAX_HOURS,
  type AgentPageContext,
  type Evidence,
  type EvidenceRef,
  type InvestigationAction,
  type InvestigationBlockBodyInput,
  type InvestigationCapabilities,
  type InvestigationState,
  type InvestigationStateInput,
  type ParsedTriggerUri,
  type ViewBlockInput,
} from "@internal/dashboard-agent-contracts";
import { logger } from "@trigger.dev/sdk";
import { tool, type ToolSet } from "ai";
import type { JSONValue } from "@ai-sdk/provider";
import {
  askSupportSchema,
  correlateVersionSchema,
  createAlertSchema,
  deleteAlertSchema,
  getCurrentPageSchema,
  getDeploySchema,
  getErrorSchema,
  getQuerySchemaSchema,
  getQueueSchema,
  getReportSchema,
  getRunSchema,
  getRunTraceSchema,
  listAlertsSchema,
  listDeploysSchema,
  listEnvironmentsSchema,
  listErrorsSchema,
  listProjectsSchema,
  listRunsSchema,
  listTasksSchema,
  navigateToSchema,
  renderViewSchema,
  runQuerySchema,
  scheduleWatchSchema,
  searchDocsSchema,
} from "./tool-schemas";
import { buildRepoTools, type RepoSnapshot } from "./repo-tools";

/**
 * The agent is firewalled from the main database: every tool reads through the public
 * API as the user. Tools return `{ error }` on failure rather than throwing.
 */

// Injected server-side by the `in` proxy. All optional: a turn with no token gets
// tools that fail closed.
export type DashboardAgentToolContext = {
  userActorToken?: string;
  apiOrigin?: string;
  projectRef?: string;
  // Canonical API env name (dev/staging/prod/preview), resolved by the proxy.
  environmentName?: string;
  // RuntimeEnvironment id: the `{env}` component of every trigger:// URI this turn
  // emits. Names and slugs must never appear in a URI.
  environmentId?: string;
  // The dashboard path the user is on, passed as context to ask_support.
  currentPage?: string;
  chatId?: string;
  // Structured view of the same page, when the host could classify it.
  pageContext?: AgentPageContext;
  // Present only when the project has a connected GitHub repo. Adds the source tools.
  repoSnapshot?: RepoSnapshot;
  investigations?: InvestigationsCapability;
};

/**
 * A capability rather than a database import, so this file stays reachable without
 * `@internal/dashboard-agent-db`. Without an `id` the store creates at revision 0.
 */
export type InvestigationsCapability = {
  upsert(params: {
    id?: string;
    projectRef: string;
    environmentRef: string;
    state: unknown;
  }): Promise<
    | { ok: true; id: string; revision: number; created: boolean }
    | { ok: false; error: "not_found" | "context_mismatch" }
  >;
};

type FetchResult = { ok: true; data: unknown } | { ok: false; status: number };

// "query" is the server rejecting the TRQL, "transport" is the request breaking. Chart
// validation only fails a render on "query".
type QueryPostResult =
  | { ok: true; rows: Array<Record<string, unknown>> }
  | { ok: false; kind: "query" | "transport"; error: string };

async function apiGet(origin: string, path: string, token: string): Promise<FetchResult> {
  const res = await fetch(`${origin}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (!res.ok) return { ok: false, status: res.status };
  return { ok: true, data: await res.json() };
}

// The exchange ceilings these scopes to the delegated token's read-only cap, so the
// JWT can never widen the grant. Null when there is no current env, or on a denial.
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

const MAX_TRACE_SPANS = 60;
function curateTrace(data: unknown) {
  const root = (data as any)?.trace?.rootSpan;
  const spans: Array<Record<string, unknown>> = [];
  const walk = (span: any, depth: number) => {
    if (!span || spans.length >= MAX_TRACE_SPANS) return;
    const d = span.data ?? {};
    // The two flags are emitted only when true; absent means false.
    spans.push({
      depth,
      message: d.message,
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

// Drops the per-metric `series` arrays and `links`; `seriesOmitted` records that the
// shape is lossy. Grades and `facts.trustworthy` survive verbatim.
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
      // "unknown" means `value` is a placeholder, not a measurement. "measured" is the
      // default and is dropped.
      ...(m.availability === "unknown" ? { availability: "unknown" } : {}),
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

// Anything larger than 30 days, or unparseable, clamps down.
const MAX_PERIOD_SECONDS = 30 * 24 * 60 * 60;
const PERIOD_UNIT_SECONDS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 };
function clampPeriod(period: string): string {
  const match = /^(\d+)\s*([smhdw])$/.exec(period.trim());
  if (!match) return "30d";
  const seconds = Number(match[1]) * PERIOD_UNIT_SECONDS[match[2]];
  return seconds > MAX_PERIOD_SECONDS ? "30d" : period.trim();
}

// A JSON-RPC `tools/call` against the public docs MCP endpoint: no auth, no user data.
// The endpoint answers with either JSON or a single-event SSE stream.
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

/** What clicking "Show code" asks for. The eval sends this exact prompt. */
export function showCodeAskPrompt(args: { path: string; line: number; sha: string }): string {
  const shortSha = args.sha.slice(0, 7);
  return (
    `Propose a fix. Reply with one fenced \`\`\`diff block holding the minimal change, ` +
    `anchored to ${args.path}:${args.line}@${shortSha} — re-read that file at that commit if you need it. ` +
    `If ${shortSha} isn't the branch head, or that version was built from a dirty tree, say so in one line. ` +
    `Don't restate the investigation.`
  );
}

/** Defaults the "Watch for a repeat" card shows, which the user can change. */
const RECURRENCE_WATCH = { checkEveryMinutes: 15, maxHours: WATCH_MAX_HOURS } as const;

// Always returns the same tool set, so it stays stable while the SDK replays it over
// prior history. With no delegated token each tool reports that instead of disappearing.
export function buildDashboardAgentTools(ctx: DashboardAgentToolContext): ToolSet {
  const { userActorToken, apiOrigin, projectRef, environmentName } = ctx;
  const origin = apiOrigin ? apiOrigin.replace(/\/$/, "") : "";
  const hasAuth = Boolean(userActorToken && origin);

  // Turn-scoped, since the tool set is rebuilt per turn, and keyed by project +
  // environment. Caching the promise makes concurrent calls share one exchange.
  const envJwts = new Map<string, Promise<string | null>>();
  function getEnvJwt(refresh = false): Promise<string | null> {
    if (!hasAuth || !projectRef || !environmentName) return Promise.resolve(null);
    const key = `${projectRef}/${environmentName}`;
    if (refresh) envJwts.delete(key);
    let pending = envJwts.get(key);
    if (!pending) {
      pending = exchangeEnvJwt(origin, userActorToken!, projectRef, environmentName);
      envJwts.set(key, pending);
    }
    return pending;
  }

  /**
   * `null` means there is no current environment. On an unauthorized result the cache
   * entry is dropped and the call is retried once, since a token can be minted stale.
   */
  async function withEnvJwt<T>(
    call: (jwt: string) => Promise<T>,
    isUnauthorized: (result: T) => boolean
  ): Promise<T | null> {
    const jwt = await getEnvJwt();
    if (!jwt) return null;
    const first = await call(jwt);
    if (!isUnauthorized(first)) return first;
    const fresh = await getEnvJwt(true);
    if (!fresh) return first;
    return call(fresh);
  }

  const unauthorizedGet = (result: FetchResult) => !result.ok && result.status === 401;

  function envApiGet(path: string): Promise<FetchResult | null> {
    return withEnvJwt((jwt) => apiGet(origin, path, jwt), unauthorizedGet);
  }

  // A POST, so it can't use envApiGet, but keeps the same JWT cache and one-shot
  // re-exchange on a 401. Shared by run_query and chart-block validation.
  async function postQuery(
    query: string,
    period: string | undefined
  ): Promise<QueryPostResult | null> {
    const attempt = await withEnvJwt<{ res: Response } | { error: string }>(
      async (jwt) => {
        try {
          return {
            res: await fetch(`${origin}/api/v1/query`, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${jwt}`,
                "Content-Type": "application/json",
                Accept: "application/json",
              },
              body: JSON.stringify({ query, scope: "environment", period, format: "json" }),
            }),
          };
        } catch (error) {
          return { error: `Query request failed: ${(error as Error).message}` };
        }
      },
      (result) => "res" in result && result.res.status === 401
    );
    if (!attempt) return null;
    if ("error" in attempt) return { ok: false, kind: "transport", error: attempt.error };
    const res = attempt.res;
    // The route returns 400 with { error } for invalid TRQL.
    const data = (await res.json().catch(() => ({}))) as { results?: unknown; error?: string };
    if (!res.ok) {
      return {
        ok: false,
        kind: res.status >= 500 ? "transport" : "query",
        error: data.error ?? `Query failed (status ${res.status}).`,
      };
    }
    return {
      ok: true,
      rows: Array.isArray(data.results) ? (data.results as Array<Record<string, unknown>>) : [],
    };
  }

  // Skipped rather than blocking the render when there is no token or the request broke.
  async function validateChartQuery(
    query: string,
    period: string | undefined
  ): Promise<string | null> {
    const result = await postQuery(query, period);
    if (!result || result.ok) return null;
    if (result.kind === "transport") {
      logger.warn("Skipped chart query validation", { error: result.error });
      return null;
    }
    return result.error;
  }

  async function alertsRequest(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown
  ): Promise<{ data: unknown } | { error: string }> {
    let res: Response;
    try {
      res = await fetch(`${origin}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${userActorToken!}`,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      return { error: `Couldn't reach the alerts API: ${(error as Error).message}` };
    }

    const data = (await res.json().catch(() => undefined)) as
      | { error?: string; reason?: string; code?: string }
      | undefined;

    // 403 is a capability refusal and `reason` says which one.
    if (res.status === 403) {
      return {
        error:
          data?.reason === "email_alerts_not_configured"
            ? "Email delivery isn't set up on this instance, so an email alert can't be created. Tell the user that, and that watch results still show in the dashboard."
            : "Email alerts aren't enabled here. Tell the user that, and that watch results still show in the dashboard.",
      };
    }
    if (res.status === 400 && data?.code === "email_not_allowed") {
      return { error: data.error ?? "Alerts can only go to the user's own account email." };
    }
    if (!res.ok) {
      return { error: data?.error ?? `The alerts API failed (status ${res.status}).` };
    }
    return { data };
  }

  // Null means the file tools fall back to the default tracked-branch snapshot.
  const fetchRunSnapshot = async (runId: string): Promise<RepoSnapshot | null> => {
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

  // Memoized per turn so the file tools and the read tracker below agree on the commit.
  const runSnapshots = new Map<string, Promise<RepoSnapshot | null>>();
  const resolveRunSnapshot = (runId: string): Promise<RepoSnapshot | null> => {
    let pending = runSnapshots.get(runId);
    if (!pending) {
      pending = fetchRunSnapshot(runId);
      runSnapshots.set(runId, pending);
    }
    return pending;
  };

  // Which files this turn read, and at which commit. A source citation canonicalizes
  // only against a read recorded here.
  const filesReadBySha = new Map<string, Set<string>>();

  function recordFileRead(path: string, sha: string) {
    const key = path.replace(/^\/+/, "");
    const shas = filesReadBySha.get(key) ?? new Set<string>();
    shas.add(sha);
    filesReadBySha.set(key, shas);
  }

  function wasReadThisTurn(path: string, sha: string): boolean {
    return filesReadBySha.get(path.replace(/^\/+/, ""))?.has(sha) ?? false;
  }

  /** The commit a read was served from: the run-pinned snapshot, else the default. */
  function shaForReadPath(path: string): string | undefined {
    const shas = filesReadBySha.get(path.replace(/^\/+/, ""));
    if (!shas || shas.size === 0) return undefined;
    // A path read at two commits resolves to the default snapshot's.
    const preferred = ctx.repoSnapshot?.sha;
    if (preferred && shas.has(preferred)) return preferred;
    return [...shas][shas.size - 1];
  }

  /** Records a successful read against its commit, keeping repo-tools unaware of it. */
  function withReadTracking(repoTools: ToolSet): ToolSet {
    const readFile = repoTools.read_file;
    if (!readFile?.execute) return repoTools;
    const execute = readFile.execute.bind(readFile);
    return {
      ...repoTools,
      read_file: {
        ...readFile,
        execute: async (input: any, options: any) => {
          const result = await execute(input, options);
          const path = (result as { path?: string } | undefined)?.path;
          if (path && !(result as { error?: unknown }).error) {
            const sha = input?.runId
              ? (await resolveRunSnapshot(input.runId))?.sha
              : ctx.repoSnapshot?.sha;
            if (sha) recordFileRead(path, sha);
          }
          return result;
        },
      } as (typeof repoTools)[string],
    };
  }

  // Assigned by the store on the first investigation block and reused after that. Scoped
  // to the tool set, so the model only passes the id back across turns.
  let currentInvestigationId: string | undefined;

  /**
   * Builds the canonical `trigger://` URI for a cited ref. A ref that can't be
   * canonicalized is returned as a named error, never dropped.
   */
  function canonicalizeEvidence(
    items: EvidenceRef[],
    scope: { projectRef: string; environmentId: string }
  ): { evidence: Evidence[]; errors: string[] } {
    const evidence: Evidence[] = [];
    const errors: string[] = [];
    const base = { projectRef: scope.projectRef, environmentId: scope.environmentId };

    for (const item of items) {
      if (item.kind === "span") {
        evidence.push({
          kind: "span",
          label: item.label,
          ...(item.excerpt === undefined ? {} : { excerpt: item.excerpt }),
          uri: formatTriggerUri({
            ...base,
            kind: "span",
            runId: item.runId.trim(),
            spanId: item.spanId.trim(),
          }),
        });
        continue;
      }

      if (item.kind === "source") {
        const path = item.path.trim().replace(/^\/+/, "");
        // The commit comes from this turn's read ledger and nowhere else: the turn's
        // snapshot sha is not proof of reading.
        const claimed = item.sha?.trim();
        if (claimed && !wasReadThisTurn(path, claimed)) {
          errors.push(
            `source "${path}" wasn't read at commit ${claimed.slice(
              0,
              7
            )} — read_file it at that commit, or cite the commit you did read it at`
          );
          continue;
        }
        const sha = claimed || shaForReadPath(path);
        if (!sha) {
          errors.push(
            `source "${path}" wasn't read this turn — read it with read_file first, then cite it`
          );
          continue;
        }
        evidence.push({
          kind: "source",
          label: item.label,
          ...(item.excerpt === undefined ? {} : { excerpt: item.excerpt }),
          uri: formatTriggerUri({
            ...base,
            kind: "source",
            sha,
            path,
            ...(item.line === undefined ? {} : { line: item.line }),
          }),
        });
        continue;
      }

      let ref = item.uri.trim();

      // Already a full URI: kind and scope both have to match, so a URI from another
      // scope can't be smuggled in.
      const asUri = safeParseTriggerUri(ref);
      if (asUri.success) {
        const parsedUri = asUri.data;
        if (parsedUri.kind !== item.kind) {
          errors.push(`${item.kind} evidence cites a ${parsedUri.kind} URI (${ref})`);
          continue;
        }
        if (
          parsedUri.projectRef !== scope.projectRef ||
          parsedUri.environmentId !== scope.environmentId
        ) {
          errors.push(`${ref} belongs to a different project or environment`);
          continue;
        }
        // A canonical URI never carries the friendly "error_" prefix.
        const normalizedUri =
          parsedUri.kind === "error"
            ? { ...parsedUri, fingerprint: parsedUri.fingerprint.replace(/^error_/, "") }
            : parsedUri;
        evidence.push({ ...item, uri: formatTriggerUri(normalizedUri) });
        continue;
      }

      // An improvised almost-URI: salvage the bare id from the last path segment.
      if (ref.includes("://")) {
        const segments = ref.split("?")[0]!.split("/").filter(Boolean);
        const last = segments[segments.length - 1];
        if (!last || last.includes(":")) {
          errors.push(`${item.kind} evidence "${ref}" isn't a resource id`);
          continue;
        }
        ref = last;
      }

      let parsed: ParsedTriggerUri;
      switch (item.kind) {
        case "run":
          parsed = { ...base, kind: "run", runId: ref };
          break;
        case "error":
          // The errors API returns "error_<fingerprint>" but the URI keys on the raw one.
          parsed = { ...base, kind: "error", fingerprint: ref.replace(/^error_/, "") };
          break;
        case "queue":
          parsed = { ...base, kind: "queue", name: ref };
          break;
        case "deployment":
          parsed = { ...base, kind: "deployment", version: ref };
          break;
        case "report":
          parsed = { ...base, kind: "report", key: ref };
          break;
        case "investigation":
          parsed = { ...base, kind: "investigation", investigationId: ref };
          break;
        case "runs":
          parsed = { ...base, kind: "runs" };
          break;
      }
      evidence.push({ ...item, uri: formatTriggerUri(parsed) });
    }

    return { evidence, errors };
  }

  function canonicalizeInvestigationState(
    state: InvestigationStateInput,
    scope: { projectRef: string; environmentId: string }
  ): { state: InvestigationState; errors: string[] } {
    const own = canonicalizeEvidence(state.evidence, scope);
    const errors = [...own.errors];
    const hypotheses = state.hypotheses.map((hypothesis) => {
      const cited = canonicalizeEvidence(hypothesis.evidence, scope);
      errors.push(...cited.errors);
      return { ...hypothesis, evidence: cited.evidence };
    });
    return { state: { ...state, evidence: own.evidence, hypotheses }, errors };
  }

  /**
   * The card's typed next actions, decided here and never by the model. "Show code"
   * needs a concluded card, a cited source line, and a read at that commit this turn.
   */
  function investigationCapabilities(state: InvestigationState): InvestigationCapabilities | null {
    if (state.outcome === "in_progress") return null;

    const cited = [...state.evidence, ...state.hypotheses.flatMap((h) => h.evidence)];
    const actions: InvestigationAction[] = [];

    if (state.outcome === "concluded") {
      for (const evidence of cited) {
        if (evidence.kind !== "source") continue;
        const parsed = safeParseTriggerUri(evidence.uri);
        if (!parsed.success || parsed.data.kind !== "source") continue;
        const { path, line, sha } = parsed.data;
        if (line === undefined) continue;
        if (!wasReadThisTurn(path, sha)) continue;
        actions.push({
          kind: "show_code",
          label: "Show code",
          intent: { kind: "ask", prompt: showCodeAskPrompt({ path, line, sha }) },
        });
        break;
      }
    }

    if (state.outcome === "inconclusive") {
      actions.push({
        kind: "ask_follow_up",
        label: "Keep digging",
        intent: {
          kind: "ask",
          prompt: "Keep digging into this — what else can you check?",
        },
      });
    }

    const errorUri = cited.find((evidence) => evidence.kind === "error")?.uri;

    // "Watch for a repeat" needs a cited error fingerprint to pre-fill from, so without
    // one it is left off.
    const parsedError = errorUri ? safeParseTriggerUri(errorUri) : undefined;
    if (
      state.outcome === "concluded" &&
      parsedError?.success &&
      parsedError.data.kind === "error"
    ) {
      actions.push({
        kind: "watch_recurrence",
        label: "Watch for a repeat",
        intent: {
          kind: "watch",
          // A pre-fill only: emitting the spec creates nothing.
          spec: {
            kind: "error_recurrence",
            fingerprint: parsedError.data.fingerprint,
            checkEveryMinutes: RECURRENCE_WATCH.checkEveryMinutes,
            maxHours: RECURRENCE_WATCH.maxHours,
            note: `A repeat of: ${state.title}`,
          },
        },
      });
    }

    if (errorUri) {
      actions.push({
        kind: "view_similar",
        label: "View similar failures",
        intent: { kind: "navigate", target: errorUri },
      });
    }

    if (actions.length === 0) return null;
    return { version: INVESTIGATION_CAPABILITIES_VERSION, actions };
  }

  /**
   * Commits a revision per investigation block, then stamps identity from what came
   * back. `continueId` is only a pointer; the turn's own closure wins when set.
   */
  async function renderInvestigations(blocks: ViewBlockInput[], continueId?: string) {
    if (!blocks.some((block) => block.type === "investigation")) return { blocks };

    if (!ctx.investigations) {
      return { error: "Investigations aren't available on this turn, so I can't render one." };
    }
    if (!projectRef || !ctx.environmentId) {
      return {
        error:
          "No current project and environment for this turn, so an investigation can't be scoped. Answer in prose instead.",
      };
    }

    const rendered: unknown[] = [];
    let investigationId: string | undefined;
    let revision: number | undefined;

    for (const block of blocks) {
      if (block.type !== "investigation") {
        rendered.push(block);
        continue;
      }

      // Canonical URIs are built before anything is stored or emitted, and a citation
      // that can't be canonicalized fails the call by name.
      let canonicalized: ReturnType<typeof canonicalizeInvestigationState>;
      try {
        canonicalized = canonicalizeInvestigationState(
          (block as InvestigationBlockBodyInput).investigation,
          { projectRef, environmentId: ctx.environmentId }
        );
      } catch (error) {
        return {
          error: `Couldn't cite that evidence: ${
            error instanceof Error ? error.message : "a citation was malformed"
          }. Fix or remove those citations and render again.`,
        };
      }
      if (canonicalized.errors.length > 0) {
        return {
          error: `Couldn't cite some of that evidence: ${canonicalized.errors.join(
            "; "
          )}. Fix or remove those citations and render again.`,
        };
      }
      const state = canonicalized.state;

      // A storage failure's message can carry the full SQL text, which must never reach
      // the transcript.
      let result: Awaited<ReturnType<InvestigationsCapability["upsert"]>>;
      try {
        result = await ctx.investigations.upsert({
          id: currentInvestigationId ?? continueId,
          projectRef,
          environmentRef: ctx.environmentId,
          state,
        });
      } catch (error) {
        console.error("investigation upsert failed", error);
        return {
          error:
            "Couldn't save the investigation right now. Say what you found in prose, honestly — if a card is already open it will be closed as inconclusive when the turn ends.",
        };
      }

      if (!result.ok) {
        // Nothing was written, so no card can be rendered.
        return {
          error:
            result.error === "context_mismatch"
              ? "That investigation belongs to a different chat, project, or environment, so it can't be updated here."
              : "That investigation no longer exists. Render again without an investigationId to start a new one.",
        };
      }

      currentInvestigationId = result.id;
      investigationId = result.id;
      revision = result.revision;

      const capabilities = investigationCapabilities(state);

      const parsed = investigationBlockSchema.safeParse({
        ...block,
        investigation: state,
        ...(capabilities ? { capabilities } : {}),
        id: result.id,
        revision: result.revision,
        version: VIEW_BLOCK_VERSION,
      });
      if (!parsed.success) {
        return { error: "Couldn't render that investigation: the card payload didn't validate." };
      }
      rendered.push(parsed.data);
    }

    return { blocks: rendered, investigationId, revision };
  }

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
        const result = await envApiGet(`/api/v3/runs/${runId}`);
        if (!result) return { error: "No current environment is available to read runs from." };
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
        // A user-level route, so it uses the delegated token with no env-JWT exchange.
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
        const effectivePeriod = period ? clampPeriod(period) : undefined;
        const sp = new URLSearchParams();
        if (status) sp.append("filter[status]", status);
        if (taskIdentifier) sp.append("filter[taskIdentifier]", taskIdentifier);
        if (errorId) sp.append("filter[error]", errorId);
        if (effectivePeriod) sp.append("filter[createdAt][period]", effectivePeriod);
        sp.append("page[size]", String(Math.min(limit ?? 10, 50)));
        const result = await envApiGet(`/api/v1/runs?${sp.toString()}`);
        if (!result) return { error: "No current environment is available to read runs from." };
        if (!result.ok) return { error: `Couldn't list runs (status ${result.status}).` };
        return { ...curateRuns(result.data), period: effectivePeriod };
      },
    }),

    get_run_trace: tool({
      ...getRunTraceSchema,
      execute: async ({ runId }) => {
        const result = await envApiGet(`/api/v1/runs/${runId}/trace`);
        if (!result) return { error: "No current environment is available to read runs from." };
        if (!result.ok)
          return { error: `Couldn't get the trace for ${runId} (status ${result.status}).` };
        return curateTrace(result.data);
      },
    }),

    list_errors: tool({
      ...listErrorsSchema,
      execute: async ({ status, taskIdentifier, search, period, limit }) => {
        const sp = new URLSearchParams();
        if (status) sp.append("filter[status]", status);
        if (taskIdentifier) sp.append("filter[taskIdentifier]", taskIdentifier);
        if (search) sp.append("filter[search]", search);
        if (period) sp.append("filter[period]", period);
        sp.append("page[size]", String(Math.min(limit ?? 20, 100)));
        const result = await envApiGet(`/api/v1/errors?${sp.toString()}`);
        if (!result) return { error: "No current environment is available to read errors from." };
        if (!result.ok) return { error: `Couldn't list errors (status ${result.status}).` };
        return curateErrors(result.data);
      },
    }),

    get_error: tool({
      ...getErrorSchema,
      execute: async ({ errorId }) => {
        const result = await envApiGet(`/api/v1/errors/${errorId}`);
        if (!result) return { error: "No current environment is available to read errors from." };
        if (!result.ok)
          return { error: `Couldn't get error ${errorId} (status ${result.status}).` };
        return curateError(result.data);
      },
    }),

    get_query_schema: tool({
      ...getQuerySchemaSchema,
      execute: async ({ table }) => {
        const result = await envApiGet("/api/v1/query/schema");
        if (!result) return { error: "No current environment is available to query." };
        if (!result.ok)
          return { error: `Couldn't load the query schema (status ${result.status}).` };
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
      execute: async ({ query, period }) => {
        const result = await postQuery(query, period);
        if (!result) return { error: "No current environment is available to query." };
        if (!result.ok) return { error: result.error };
        const cap = 200;
        const rows = result.rows;
        return { rows: rows.slice(0, cap), rowCount: rows.length, truncated: rows.length > cap };
      },
    }),

    // No user data and no delegated token: this uses a server-side shared secret.
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

    // A `chart` block's query runs here first so a broken one becomes a named failure
    // the model can fix; the panel would run it after the turn, too late to report.
    render_view: tool({
      ...renderViewSchema,
      execute: async (view) => {
        for (const block of view.blocks) {
          if (block.type !== "chart") continue;
          const queryError = await validateChartQuery(block.query, block.period);
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
      execute: async ({ key, period }) => {
        const reportKey = key ?? "health";
        const sp = new URLSearchParams({ format: "json" });
        if (period) sp.append("period", period);
        const result = await envApiGet(
          `/api/v1/reports/${encodeURIComponent(reportKey)}?${sp.toString()}`
        );
        if (!result) return { error: "No current environment is available to report on." };
        if (!result.ok) {
          return { error: `Couldn't get the ${reportKey} report (status ${result.status}).` };
        }
        // Built from the RuntimeEnvironment id the proxy injects, never the env name.
        const uri =
          projectRef && ctx.environmentId
            ? formatTriggerUri({
                kind: "report",
                projectRef,
                environmentId: ctx.environmentId,
                key: reportKey,
              })
            : undefined;
        // The tool output IS the trimmed view model the panel's report block reads.
        return { ...curateReport(result.data), ...(uri ? { uri } : {}) };
      },
      // The card renders the full view model; the model reads the graded summary.
      toModelOutput: ({ output }) => ({ type: "json", value: getReportModelOutput(output) }),
    }),

    get_queue: tool({
      ...getQueueSchema,
      execute: async ({ queue, type, period }) => {
        const sp = new URLSearchParams({ type: type ?? "task" });
        if (period) sp.append("period", period);
        // Double-encoded: a task queue's ClickHouse name carries a `task/` prefix, and
        // the route un-escapes `%2F` back to `/` itself.
        const result = await envApiGet(
          `/api/v1/queues/${encodeURIComponent(queue)}/metrics?${sp.toString()}`
        );
        if (!result) return { error: "No current environment is available to read queues from." };
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
        const effectivePeriod = period ? clampPeriod(period) : undefined;
        const sp = new URLSearchParams();
        if (status) sp.append("status", status);
        if (effectivePeriod) sp.append("period", effectivePeriod);
        sp.append("page[size]", String(Math.min(limit ?? 10, 50)));
        const result = await envApiGet(`/api/v1/deployments?${sp.toString()}`);
        if (!result) {
          return { error: "No current environment is available to read deployments from." };
        }
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
        const noEnv = { error: "No current environment is available to read deployments from." };
        // No version: the promoted deployment, which is what new runs use.
        if (!version) {
          const result = await envApiGet("/api/v1/deployments/current");
          if (!result) return noEnv;
          if (!result.ok) {
            return { error: `Couldn't get the current deployment (status ${result.status}).` };
          }
          return { deploy: curateDeploy(result.data), isCurrent: true };
        }
        // The public retrieve route is API-key-only, so find the version in the
        // JWT-reachable list instead.
        const result = await envApiGet("/api/v1/deployments?page[size]=100");
        if (!result) return noEnv;
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
        // A user-level route, so this uses the delegated token rather than the env JWT.
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

    // Context tools: no fetch, no auth.
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
            // Filters ride in the intent, not the URI.
            parsed = { kind: "runs", ...scope };
            break;
          case "run":
            parsed = { kind: "run", ...scope, runId: destination.runId };
            break;
          case "error":
            // The API's friendly id is accepted; the page keys on the raw one.
            parsed = {
              kind: "error",
              ...scope,
              fingerprint: destination.fingerprint.replace(/^error_/, ""),
            };
            break;
          case "queue":
            parsed = { kind: "queue", ...scope, name: destination.name };
            break;
          case "deployment":
            parsed = { kind: "deployment", ...scope, version: destination.version };
            break;
        }

        // Re-validated through the intent schema, so a malformed id becomes a tool error
        // rather than an intent the host must reject.
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

    // Proposes a watch, never creates one: the user confirming the card is what starts
    // it, so the card owns consent, the cap and dedup.
    schedule_watch: tool({
      ...scheduleWatchSchema,
      execute: async ({ watch }) => {
        // Re-validated through the intent schema, so a rejected spec becomes a tool
        // error rather than an intent the host drops.
        try {
          return { intent: agentIntentSchema.parse({ kind: "watch", spec: watch }) };
        } catch (error) {
          return { error: `Couldn't build that watch: ${(error as Error).message}` };
        }
      },
    }),

    // Project-level, so these use the delegated token, not the env JWT. Every call
    // carries the chat id, which is what the API scopes its authorization through.
    list_alerts: tool({
      ...listAlertsSchema,
      execute: async () => {
        if (!hasAuth) return NO_AUTH;
        if (!ctx.chatId) return { error: "No chat is available to read alerts from." };
        const result = await alertsRequest(
          "GET",
          `/api/v1/dashboard-agent/alerts?chatId=${encodeURIComponent(ctx.chatId)}`
        );
        if ("error" in result) return result;
        const alerts = (result.data as { alerts?: unknown } | undefined)?.alerts;
        return { alerts: Array.isArray(alerts) ? alerts : [] };
      },
    }),

    create_alert: tool({
      ...createAlertSchema,
      execute: async ({ email }) => {
        if (!hasAuth) return NO_AUTH;
        if (!ctx.chatId) return { error: "No chat is available to create an alert from." };
        const result = await alertsRequest("POST", "/api/v1/dashboard-agent/alerts", {
          chatId: ctx.chatId,
          channel: "email",
          ...(email ? { email } : {}),
        });
        if ("error" in result) return result;
        return { created: true, alert: (result.data as { alert?: unknown } | undefined)?.alert };
      },
    }),

    delete_alert: tool({
      ...deleteAlertSchema,
      execute: async ({ alertId }) => {
        if (!hasAuth) return NO_AUTH;
        if (!ctx.chatId) return { error: "No chat is available to change alerts from." };
        const result = await alertsRequest(
          "DELETE",
          `/api/v1/dashboard-agent/alerts/${encodeURIComponent(alertId)}`,
          { chatId: ctx.chatId }
        );
        if ("error" in result) return result;
        return { deleted: true, alertId };
      },
    }),
  };

  // Code mode: when the project has a connected repo, add the source tools.
  if (!ctx.repoSnapshot) return apiTools;
  return {
    ...apiTools,
    ...withReadTracking(buildRepoTools(ctx.repoSnapshot, resolveRunSnapshot)),
  };
}
