import { formatTriggerUri } from "@internal/dashboard-agent-contracts";
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
  type EnvUnavailable,
} from "./tool-api-client";
import type { DashboardAgentToolContext } from "./tool-context";
import {
  clampPeriod,
  curateDeploy,
  curateEnvironments,
  curateError,
  curateErrors,
  curateProjects,
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

/**
 * What to tell the model when a read never reached an environment. Only a missing
 * environment is stated as one; a failed exchange says the read didn't land, and carries
 * its status, so an authorization failure is never reported as an absent environment.
 */
function envUnavailableError(result: EnvUnavailable, action: string): { error: string } {
  if (result.envUnavailable === "missing") {
    return { error: `No current environment is available to ${action}.` };
  }
  const status = result.status ? ` (status ${result.status})` : "";
  return { error: `Couldn't reach the current environment to ${action}${status}.` };
}

/**
 * The API read tools, in the frozen key order `dashboardAgentToolSchemas` declares:
 * a different order is a different cached prompt prefix.
 */
/**
 * Whether a metrics answer carries no evidence the queue exists. Zeroes across the board
 * are what the route returns for a name it has never seen, and also what a genuinely idle
 * queue looks like — so this only decides whether to try the other queue kind, never what
 * to tell the user.
 */
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

/**
 * The name to ask for a queue under. Only a task queue carries the `task/` prefix — and the
 * route adds it itself — so a custom queue asked for as `task/worker-1` has to lose it, or
 * the metrics, live-row and consumer reads all miss the row that is stored as `worker-1`.
 */
export function queueNameForKind(queue: string, kind: "task" | "custom"): string {
  return kind === "custom" ? queue.replace(/^task\//, "") : queue;
}

/**
 * The deployed tasks whose `queueConfig` points at this queue, from the current worker's
 * task list. A custom queue's name is unrelated to any task id, so who consumes it can
 * only be read off the tasks — never guessed from the name.
 */
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

/**
 * What the queue's live row read came back with. "The route said 404" and "the read never
 * landed" are different answers: only the first is evidence about the queue, and collapsing
 * them turns an expired token or a 5xx into "that queue doesn't exist".
 */
export type QueueLiveRead =
  | { kind: "row"; row: Record<string, unknown> }
  | { kind: "missing" }
  | { kind: "unknown"; status?: number };

/** Reads the live-row response into those three states. */
export function readQueueLiveState(result: EnvFetchResult | null): QueueLiveRead {
  // No current environment, or a read that never landed: nothing is known either way.
  if (!result) return { kind: "unknown" };
  if (isEnvUnavailable(result)) {
    return {
      kind: "unknown",
      status: result.envUnavailable === "unknown" ? result.status : undefined,
    };
  }
  if (!result.ok) {
    // A request that never landed carries no status, and says nothing about the queue.
    if (!("status" in result)) return { kind: "unknown" };
    return result.status === 404 ? { kind: "missing" } : { kind: "unknown", status: result.status };
  }
  const row = (result.data as { data?: Record<string, unknown> })?.data ?? result.data;
  if (!row || typeof row !== "object") return { kind: "unknown" };
  return { kind: "row", row: row as Record<string, unknown> };
}

/**
 * The better of two live reads of the same queue name under either kind. A row wins; failing
 * that a failed read wins over a 404, since one 404 with the other read broken is not proof.
 */
export function pickQueueLiveState(first: QueueLiveRead, second: QueueLiveRead): QueueLiveRead {
  if (first.kind === "row") return first;
  if (second.kind === "row") return second;
  if (first.kind === "unknown") return first;
  return second;
}

/**
 * Metrics plus the queue's live row. `paused` is the part the model must lead with: a queue
 * someone stopped explains its own emptiness, and every metric below it is a consequence
 * rather than a finding. When the read failed, `exists` is `"unknown"` rather than `false`,
 * because an unreachable queue is not an absent one.
 */
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
    // Older API rows carry neither field; omit rather than fabricate an empty answer.
    ...(row.slotHolders !== undefined ? { slotHolders: row.slotHolders } : {}),
    ...(row.holderResolution !== undefined ? { holderResolution: row.holderResolution } : {}),
    ...(row.slotHolderFacts !== undefined ? { slotHolderFacts: row.slotHolderFacts } : {}),
  };
}

/** Failed `run_query` calls in a row before the tool tells the model to stop and answer. */
export const MAX_CONSECUTIVE_QUERY_FAILURES = 3;

export function buildApiTools(args: {
  ctx: DashboardAgentToolContext;
  client: DashboardAgentApiClient;
  renderInvestigations: InvestigationRenderer;
}): ToolSet {
  const { ctx, client, renderInvestigations } = args;
  const { userActorToken, projectRef, environmentName, environmentBranch } = ctx;
  const { origin, hasAuth, envApiGet, postQuery, validateChartQuery } = client;

  // A failed query hands the model the database error to fix, and it usually does. When it
  // doesn't, the only other limit is the turn's 10 steps, so one broken query can eat the
  // whole turn and leave the user with no answer at all. This tool set is built per turn,
  // so the counter caps consecutive failures within one turn.
  let consecutiveQueryFailures = 0;

  return {
    list_projects: tool({
      ...listProjectsSchema,
      execute: async () => {
        if (!hasAuth) return NO_AUTH;
        const result = await apiGet(origin, "/api/v1/projects", userActorToken!);
        if (!result.ok) return { error: `Couldn't list projects${fetchReason(result)}.` };
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
          `/api/v1/projects/${encodeURIComponent(ref)}/environments`,
          userActorToken!
        );
        if (!result.ok) return { error: `Couldn't list environments${fetchReason(result)}.` };
        return curateEnvironments(result.data);
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
          userActorToken!,
          environmentBranch
        );
        if (!result.ok) return { error: `Couldn't list tasks${fetchReason(result)}.` };
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
        if (isEnvUnavailable(result)) return envUnavailableError(result, "read runs from");
        if (!result.ok) return { error: `Couldn't list runs${fetchReason(result)}.` };
        return { ...curateRuns(result.data), period: effectivePeriod };
      },
    }),

    // Order matters up to here: `dashboardAgentToolSchemas` is the canonical key
    // order (head start builds its prefix from it), and a different order is a
    // different cached prefix.
    get_run: tool({
      ...getRunSchema,
      execute: async ({ runId }) => {
        const result = await envApiGet(`/api/v3/runs/${encodeURIComponent(runId)}`);
        if (isEnvUnavailable(result)) return envUnavailableError(result, "read runs from");
        if (!result.ok) return { error: `Couldn't get run ${runId}${fetchReason(result)}.` };
        return curateRun(result.data);
      },
    }),

    get_run_trace: tool({
      ...getRunTraceSchema,
      execute: async ({ runId }) => {
        const result = await envApiGet(`/api/v1/runs/${encodeURIComponent(runId)}/trace`);
        if (isEnvUnavailable(result)) return envUnavailableError(result, "read runs from");
        if (!result.ok)
          return { error: `Couldn't get the trace for ${runId}${fetchReason(result)}.` };
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
        if (isEnvUnavailable(result)) return envUnavailableError(result, "read errors from");
        if (!result.ok) return { error: `Couldn't list errors${fetchReason(result)}.` };
        return curateErrors(result.data);
      },
    }),

    get_error: tool({
      ...getErrorSchema,
      execute: async ({ errorId }) => {
        const result = await envApiGet(`/api/v1/errors/${encodeURIComponent(errorId)}`);
        if (isEnvUnavailable(result)) return envUnavailableError(result, "read errors from");
        if (!result.ok) return { error: `Couldn't get error ${errorId}${fetchReason(result)}.` };
        return curateError(result.data);
      },
    }),

    get_query_schema: tool({
      ...getQuerySchemaSchema,
      execute: async ({ table }) => {
        const result = await envApiGet("/api/v1/query/schema");
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
      execute: async ({ query, period }) => {
        const result = await postQuery(query, period);
        if (isEnvUnavailable(result)) return envUnavailableError(result, "query");
        if (!result.ok) {
          // Only SQL errors count toward the cap; transport and busy errors are transient,
          // and the same query may work on a retry.
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
        // Both or nothing: a default URL would send the question and the secret somewhere
        // unintended whenever only the secret is set.
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
        if (isEnvUnavailable(result)) return envUnavailableError(result, "report on");
        if (!result.ok) {
          return { error: `Couldn't get the ${reportKey} report${fetchReason(result)}.` };
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
        // The metrics route answers an unknown queue with zeroes rather than a 404, so a
        // wrong `type` reads exactly like an idle queue — and the wrong half of that pair
        // is easy to pick, since a named queue and a task's own queue look alike. Try the
        // other kind before believing the zeroes, and say which one answered.
        const read = async (kind: "task" | "custom") => {
          const sp = new URLSearchParams({ type: kind });
          if (period) sp.append("period", period);
          // Queue names may contain `/`; encode them as a single path segment.
          const result = await envApiGet(
            `/api/v1/queues/${encodeURIComponent(queueNameForKind(queue, kind))}/metrics?${sp.toString()}`
          );
          return result;
        };

        // Live state first: metrics are a window, and a window can't say "paused" or show a
        // backlog that arrived after it. A queue nobody is running is not the same as a queue
        // someone stopped, and the answer has to lead with which one it is.
        const live = async (kind: "task" | "custom") => {
          const result = await envApiGet(
            `/api/v1/queues/${encodeURIComponent(queueNameForKind(queue, kind))}?type=${kind}`
          );
          return readQueueLiveState(result);
        };

        // Only a custom queue needs this read: a task queue's consumer is the task it is
        // named after, while a custom queue's name says nothing about who writes to it.
        const answer = async (metrics: unknown, kind: "task" | "custom", state: QueueLiveRead) => {
          const base = withLiveState(metrics, kind, state);
          if (base.queueType !== "custom" || !hasAuth || !projectRef || !environmentName) {
            return base;
          }
          const workers = await apiGet(
            origin,
            `/api/v1/projects/${projectRef}/${environmentName}/workers/current`,
            userActorToken!
          );
          if (!workers.ok) return base;
          return {
            ...base,
            consumerTasks: consumerTasksForQueue(workers.data, queueNameForKind(queue, "custom")),
          };
        };

        const first = await read(type ?? "task");
        if (isEnvUnavailable(first)) return envUnavailableError(first, "read queues from");
        if (!first.ok) {
          return {
            error: `Couldn't get metrics for the ${queue} queue${fetchReason(first)}.`,
          };
        }
        if (queueMetricsAreEmpty(first.data)) {
          const otherKind = type === "custom" ? "task" : "custom";
          const other = await read(otherKind);
          if (!isEnvUnavailable(other) && other.ok && !queueMetricsAreEmpty(other.data)) {
            return await answer(other.data, otherKind, await live(otherKind));
          }
          // Neither kind has metrics, so the live row is the only thing that can tell them
          // apart: a paused or empty queue that exists, against a name that doesn't.
          const kind = type ?? "task";
          const primary = await live(kind);
          const state =
            primary.kind === "row" ? primary : pickQueueLiveState(primary, await live(otherKind));
          return await answer(first.data, kind, state);
        }
        const kind = type ?? "task";
        return await answer(first.data, kind, await live(kind));
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
        if (isEnvUnavailable(result)) return envUnavailableError(result, "read deployments from");
        if (!result.ok) return { error: `Couldn't list deployments${fetchReason(result)}.` };
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
        const noEnv = (r: EnvUnavailable) => envUnavailableError(r, "read deployments from");
        // No version: the promoted deployment, which is what new runs use.
        if (!version) {
          const result = await envApiGet("/api/v1/deployments/current");
          if (isEnvUnavailable(result)) return noEnv(result);
          if (!result.ok) {
            return { error: `Couldn't get the current deployment${fetchReason(result)}.` };
          }
          return { deploy: curateDeploy(result.data), isCurrent: true };
        }
        // The public retrieve route is API-key-only, so find the version in the
        // JWT-reachable list instead.
        const result = await envApiGet("/api/v1/deployments?page[size]=100");
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
          userActorToken!,
          environmentBranch
        );
        if (!result.ok) {
          // Only a real 404 says "no commit"; a transport failure says nothing.
          if ("status" in result && result.status === 404) {
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
