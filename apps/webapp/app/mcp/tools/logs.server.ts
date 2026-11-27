import { parseDate } from "@trigger.dev/core/v3/isomorphic";
import { $replica } from "~/db.server";
import { LogDetailPresenter } from "~/presenters/v3/LogDetailPresenter.server";
import { clickhouseFactory } from "~/services/clickhouse/clickhouseFactoryInstance.server";
import { hasLogsPageAccess } from "~/services/logsAccess.server";
import { LOGS_SEARCH_BUDGET_MS, searchLogsInEnvironment } from "~/services/logsSearch.server";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { ServiceValidationError } from "~/v3/services/common.server";
import type { McpToolContext } from "../gate/types";
import type { McpToolDefinition } from "../registry.server";
import { defineReadTool, errorResult, resolveToolEnvironment, textResult } from "./define.server";
import { parseLogHandle } from "./format/logFields";
import { formatLogDetail, formatLogsPage } from "./format/logs";
import { GetLogInput, SearchLogsInput } from "./schemas/logs";

const LOGS_NOT_AVAILABLE = "Logs are not available for this organization.";

async function resolveLogsEnvironment(
  ctx: McpToolContext
): Promise<{ environment: AuthenticatedEnvironment } | { error: string }> {
  const environment = await resolveToolEnvironment(ctx);
  if (!environment) return { error: "Environment not found" };

  const allowed = await hasLogsPageAccess(
    ctx.identity.userId,
    false,
    false,
    environment.organization.slug
  );
  return allowed ? { environment } : { error: LOGS_NOT_AVAILABLE };
}

function parseTime(value: string | undefined): number | undefined | null {
  if (value === undefined) return undefined;
  return parseDate(value)?.getTime() ?? null;
}

function createSearchLogs(searchBudgetMs: number, now: () => number) {
  return defineReadTool({
    name: "search_logs",
    title: "Search Logs",
    description: `Search the logs of an environment, newest first, like the Logs page in the dashboard. Filter by text, level, task, run, and time period. One call keeps searching older logs until the page is full, starts no new read after ${searchBudgetMs / 1000} seconds, and returns a cursor when more may exist. Messages are shortened in the list; use get_log with a returned log ID to read one entry in full.`,
    shape: SearchLogsInput.shape,
    auth: { action: "read", subject: "runs" },
    run: async (input, ctx) => {
      const resolved = await resolveLogsEnvironment(ctx);
      if ("error" in resolved) return errorResult(resolved.error);
      const { environment } = resolved;

      const from = parseTime(input.from);
      if (from === null) return errorResult(`Invalid arguments: from=${input.from}`);
      const to = parseTime(input.to);
      if (to === null) return errorResult(`Invalid arguments: to=${input.to}`);

      try {
        const { page, ...coverage } = await searchLogsInEnvironment(
          environment,
          ctx.identity.userId,
          {
            tasks: input.tasks?.length ? input.tasks : undefined,
            runId: input.runId,
            search: input.search,
            period: input.period,
            from,
            to,
            levels: input.levels?.length ? input.levels : undefined,
            cursor: input.cursor,
            pageSize: input.limit,
          },
          { signal: ctx.signal, budgetMs: searchBudgetMs, now }
        );
        return textResult(formatLogsPage(page, coverage));
      } catch (error) {
        if (error instanceof ServiceValidationError) return errorResult(error.message);
        throw error;
      }
    },
  });
}

const getLog = defineReadTool({
  name: "get_log",
  title: "Get Log",
  description:
    "Get one log entry in full, including its attributes. The log ID comes from search_logs.",
  shape: GetLogInput.shape,
  auth: { action: "read", subject: "runs" },
  run: async (input, ctx) => {
    const resolved = await resolveLogsEnvironment(ctx);
    if ("error" in resolved) return errorResult(resolved.error);
    const { environment } = resolved;

    const parts = parseLogHandle(input.logId);
    if (!parts) return errorResult("Invalid log ID");
    const { traceId, spanId, startTime } = parts;

    const logsClickhouse = await clickhouseFactory.getClickhouseForOrganization(
      environment.organizationId,
      "logs"
    );

    try {
      const log = await new LogDetailPresenter($replica, logsClickhouse).call({
        environmentId: environment.id,
        organizationId: environment.organizationId,
        projectId: environment.projectId,
        spanId,
        traceId,
        startTime,
      });
      if (!log) return errorResult("Log not found");

      return textResult(formatLogDetail(log));
    } catch (error) {
      if (error instanceof ServiceValidationError) return errorResult(error.message);
      throw error;
    }
  },
});

const PERIOD_WITH_RANGE = "Invalid arguments: Pass either period or from/to, not both";

export function createLogsTools({
  searchBudgetMs = LOGS_SEARCH_BUDGET_MS,
  now = () => performance.now(),
}: { searchBudgetMs?: number; now?: () => number } = {}): McpToolDefinition[] {
  const searchLogs = createSearchLogs(searchBudgetMs, now);
  return [
    {
      ...searchLogs,
      handler: (args, ...rest) => {
        const a = args as Record<string, unknown> | undefined;
        return a?.period !== undefined && (a.from !== undefined || a.to !== undefined)
          ? Promise.resolve(errorResult(PERIOD_WITH_RANGE))
          : searchLogs.handler(args, ...rest);
      },
    },
    getLog,
  ];
}

export const logsTools: McpToolDefinition[] = createLogsTools();
