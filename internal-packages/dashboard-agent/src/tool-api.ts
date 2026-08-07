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
import { apiGet, NO_AUTH, type DashboardAgentApiClient } from "./tool-api-client";
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
 * The API read tools, in the frozen key order `dashboardAgentToolSchemas` declares:
 * a different order is a different cached prompt prefix.
 */
export function buildApiTools(args: {
  ctx: DashboardAgentToolContext;
  client: DashboardAgentApiClient;
  renderInvestigations: InvestigationRenderer;
}): ToolSet {
  const { ctx, client, renderInvestigations } = args;
  const { userActorToken, projectRef, environmentName } = ctx;
  const { origin, hasAuth, envApiGet, postQuery, validateChartQuery } = client;

  return {
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
          `/api/v1/projects/${encodeURIComponent(ref)}/environments`,
          userActorToken!
        );
        if (!result.ok) return { error: `Couldn't list environments (status ${result.status}).` };
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

    // Order matters up to here: `dashboardAgentToolSchemas` is the canonical key
    // order (head start builds its prefix from it), and a different order is a
    // different cached prefix.
    get_run: tool({
      ...getRunSchema,
      execute: async ({ runId }) => {
        const result = await envApiGet(`/api/v3/runs/${encodeURIComponent(runId)}`);
        if (!result) return { error: "No current environment is available to read runs from." };
        if (!result.ok) return { error: `Couldn't get run ${runId} (status ${result.status}).` };
        return curateRun(result.data);
      },
    }),

    get_run_trace: tool({
      ...getRunTraceSchema,
      execute: async ({ runId }) => {
        const result = await envApiGet(`/api/v1/runs/${encodeURIComponent(runId)}/trace`);
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
        const result = await envApiGet(`/api/v1/errors/${encodeURIComponent(errorId)}`);
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
  };
}
