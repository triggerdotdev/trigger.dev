import {
  agentIntentSchema,
  formatTriggerUri,
  investigationBlockSchema,
  VIEW_BLOCK_VERSION,
  type AgentPageContext,
  type InvestigationBlockBody,
  type ParsedTriggerUri,
  type ViewBlockInput,
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
  scheduleWatchSchema,
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
  // The chat this turn belongs to, supplied by dashboard-agent.ts (the same seam
  // the investigations capability comes through). A watch belongs to a chat: it
  // is guardrailed per chat and its wake is delivered back into this one.
  chatId?: string;
  // Structured view of the same page, when the host could classify it. Read by
  // get_current_page so the agent can resolve "this run" without asking.
  pageContext?: AgentPageContext;
  // Present only when the current project has a connected GitHub repo: a signed
  // archive pointer the code-mode file tools read from. Adds the source tools.
  repoSnapshot?: RepoSnapshot;
  // The narrow seam to the agent's own datastore, supplied per turn by
  // dashboard-agent.ts (which knows the chat id). Only the investigation
  // executor uses it; everything else in this file reaches data through the API.
  investigations?: InvestigationsCapability;
};

/**
 * Committing one investigation revision — the only write the tool lane performs.
 *
 * Deliberately a capability rather than a database import: this file is the tool
 * lane, and it must stay reachable without `@internal/dashboard-agent-db` (and
 * its postgres/drizzle runtime). `dashboard-agent.ts` supplies the real
 * implementation over `upsertInvestigationRevision`, tests inject a fake.
 *
 * Without an `id` the store creates the investigation at revision 0 and returns
 * the id it generated; with one it bumps the revision atomically. The result
 * mirrors the query's, so a mismatched context surfaces as an error the model can
 * report instead of a silent overwrite.
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
    // The two flags are emitted only when true: absent means false, and a list of
    // 60 spans that each spell out `isError: false, isPartial: false` spends ~2KB
    // of context saying nothing.
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
      // Only the lossy case travels: "unknown" means `value` is a placeholder the
      // model must not read as a real measurement. "measured" is the default and
      // says nothing, so it's dropped.
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

  // Exchange lazily and once per turn — turns that never touch an env tool never
  // pay for the exchange, and a turn with six env-scoped tool calls pays for one.
  // The tool set is rebuilt per turn, so this Map is exactly turn-scoped: no TTL
  // to reason about, and a JWT can't outlive the turn it was minted for. Keyed by
  // project + environment so the cache can never hand a tool a token for another
  // scope. The promise (not the token) is cached, so concurrent tool calls in one
  // step share a single in-flight exchange.
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
   * Run an env-scoped API call with the turn's cached JWT.
   *
   * `null` means there is no current environment (the caller reports that in its
   * own words). On an unauthorized result the cache entry is dropped and the call
   * is retried once with a fresh exchange — a cached token can have been minted
   * right at its expiry edge, and one extra exchange is far cheaper than failing
   * the tool. Anything else (including a second 401) is returned as-is.
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

  // The common shape: a GET against an env-scoped route, with the retry above.
  function envApiGet(path: string): Promise<FetchResult | null> {
    return withEnvJwt((jwt) => apiGet(origin, path, jwt), unauthorizedGet);
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

  // The investigation this tool set is working on. Assigned by the store on the
  // first investigation block and reused after that, so a second render revises
  // the same card instead of opening a second investigation. Scoped to the tool
  // set (one per turn), which is why the model never has to carry the id within
  // a turn — across turns it passes the id back (see `renderInvestigations`).
  let currentInvestigationId: string | undefined;

  /**
   * Stamp identity onto the spec's investigation blocks, committing a revision for
   * each one first.
   *
   * The model emits investigation *state*; the row in the investigations table is
   * what says which investigation that is and which revision this render makes.
   * So the executor writes first and stamps the envelope from what came back — the
   * transcript then carries canonical identity, and the panel collapses revisions
   * latest-wins onto one live card. Other block types pass through untouched.
   *
   * `continueId` is the tool-level `investigationId` the model may pass back on a
   * later turn (the id an earlier render returned to it). The turn's own closure
   * wins when it's set, so within-turn behavior is unchanged and the model can't
   * redirect a render mid-investigation. The id is only ever a pointer: the store
   * verifies the row belongs to this chat + project + environment (the chatId is
   * bound server-side, not by the model), so a stale or hallucinated id fails as
   * `not_found` / `context_mismatch` with nothing written.
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

    for (const block of blocks) {
      if (block.type !== "investigation") {
        rendered.push(block);
        continue;
      }

      // Tools return {error}, never throw — and a storage failure's message can
      // carry the full SQL text, which must never reach the transcript.
      let result: Awaited<ReturnType<InvestigationsCapability["upsert"]>>;
      try {
        result = await ctx.investigations.upsert({
          id: currentInvestigationId ?? continueId,
          projectRef,
          environmentRef: ctx.environmentId,
          state: (block as InvestigationBlockBody).investigation,
        });
      } catch (error) {
        console.error("investigation upsert failed", error);
        return {
          error:
            "Couldn't save the investigation right now. Answer in prose instead of rendering the card.",
        };
      }

      if (!result.ok) {
        // Either the investigation is gone or it belongs to another
        // chat/project/environment. Nothing was written; say so rather than
        // rendering a card whose identity we couldn't establish.
        return {
          error:
            result.error === "context_mismatch"
              ? "That investigation belongs to a different chat, project, or environment, so it can't be updated here."
              : "That investigation no longer exists. Render again without an investigationId to start a new one.",
        };
      }

      currentInvestigationId = result.id;
      investigationId = result.id;

      const parsed = investigationBlockSchema.safeParse({
        ...block,
        id: result.id,
        revision: result.revision,
        version: VIEW_BLOCK_VERSION,
      });
      if (!parsed.success) {
        return { error: "Couldn't render that investigation: the card payload didn't validate." };
      }
      rendered.push(parsed.data);
    }

    // Tell the model which investigation it just rendered, so it can talk about
    // the card it produced without inventing (or needing to track) an id.
    return { blocks: rendered, investigationId };
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
        // POST, so it can't use envApiGet — same JWT cache and same one-shot
        // re-exchange on a 401, spelled out around the query request.
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
        if (!attempt) return { error: "No current environment is available to query." };
        if ("error" in attempt) return attempt;
        const res = attempt.res;
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
    // runs, so for most blocks execute just echoes it back as the tool output for
    // the dashboard render registry to pick up.
    //
    // An `investigation` block is the exception — see `renderInvestigations`: it
    // is the one progressive block, so the executor (not the model) owns its
    // identity and commits each revision before the block reaches the transcript.
    render_view: tool({
      ...renderViewSchema,
      execute: async (view) => renderInvestigations(view.blocks, view.investigationId),
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
        const sp = new URLSearchParams({ type: type ?? "task" });
        if (period) sp.append("period", period);
        // Double-encode the name: a task queue's ClickHouse name carries a `task/`
        // prefix, and the route un-escapes `%2F` back to `/` itself.
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
        // JWT-reachable list instead. One page is plenty for "which deploy was
        // that"; anything older is a list_deploys question.
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

    // The one tool that schedules future work. The host owns everything the
    // model shouldn't: the tenancy snapshot, the watch token, the periodic
    // checks, and the guardrails (≤3 per chat, no duplicate on the same thing,
    // 24h ceiling). The model composes the spec and gets back either the created
    // watch or — when the condition already holds — the immediate outcome.
    schedule_watch: tool({
      ...scheduleWatchSchema,
      execute: async ({ watch }) => {
        if (!hasAuth) return NO_AUTH;
        if (!ctx.chatId) {
          return { error: "This turn isn't attached to a chat, so a watch can't be scheduled." };
        }
        let res: Response;
        try {
          res = await fetch(`${origin}/api/v1/dashboard-agent/watches`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${userActorToken!}`,
              "Content-Type": "application/json",
              Accept: "application/json",
            },
            body: JSON.stringify({ spec: watch, chatId: ctx.chatId }),
          });
        } catch (error) {
          return { error: `Couldn't schedule the watch: ${(error as Error).message}` };
        }

        const data = (await res.json().catch(() => undefined)) as
          | {
              watchId?: string;
              identity?: string;
              status?: string;
              expiresAt?: string;
              immediate?: { result?: string; facts?: unknown };
              existingId?: string;
              error?: string;
              code?: string;
            }
          | undefined;

        if (!res.ok) {
          switch (data?.code) {
            case "limit_reached":
              return {
                error:
                  "This chat already has the maximum of 3 active watches. Cancel one of them before adding another.",
              };
            case "duplicate":
              return {
                error: `That's already being watched in this chat${
                  (data.existingId ?? data.watchId)
                    ? ` (watch ${data.existingId ?? data.watchId})`
                    : ""
                }, so nothing new was scheduled. Tell the user the existing watch covers it.`,
              };
            case "invalid_target":
              return {
                error:
                  data.error ??
                  "That thing can't be watched — check the run id, queue, or error group is right.",
              };
            default:
              return {
                error: data?.error ?? `Couldn't schedule the watch (status ${res.status}).`,
              };
          }
        }

        // Already true at creation time: there is nothing to wait for, so the
        // model must answer now instead of promising a message later.
        if (data?.immediate) {
          return {
            immediate: data.immediate,
            watching: false,
            note: "The condition already holds, so no watch is running. Answer now.",
          };
        }

        return {
          watchId: data?.watchId,
          identity: data?.identity,
          status: data?.status ?? "active",
          expiresAt: data?.expiresAt,
          checkEveryMinutes: watch.checkEveryMinutes,
          note: watch.note,
          watching: true,
        };
      },
    }),
  };

  // Code mode: when the project has a connected repo, add the source tools.
  if (!ctx.repoSnapshot) return apiTools;
  return { ...apiTools, ...buildRepoTools(ctx.repoSnapshot, resolveRunSnapshot) };
}
