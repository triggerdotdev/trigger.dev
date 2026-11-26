import {
  DASHBOARD_AGENT_LOG_EXCERPT_CHARS,
  DASHBOARD_AGENT_LOG_ID_CHARS,
  DASHBOARD_AGENT_LOG_SEARCH_LIMIT,
  dashboardAgentLogSearchBody,
  dashboardAgentLogSearchResult,
  type dashboardAgentLogSearchValidationError,
  sliceWellFormed,
} from "@internal/dashboard-agent-contracts";
import { json } from "@remix-run/server-runtime";
import type { z } from "zod";
import { isRunFriendlyId } from "~/components/dashboard-agent/run-id";
import { getRequestAbortSignal } from "~/services/httpAsyncStorage.server";
import { hasLogsPageAccess } from "~/services/logsAccess.server";
import { searchLogsInEnvironment } from "~/services/logsSearch.server";
import { createActionApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { DASHBOARD_AGENT_CLIENT } from "~/services/userActorEnvironment.server";
import { ServiceValidationError } from "~/v3/services/common.server";

const { action, loader } = createActionApiRoute(
  {
    method: "POST",
    body: dashboardAgentLogSearchBody,
    allowJWT: true,
    authorization: { action: "read", resource: () => ({ type: "runs" }) },
  },
  async ({ body, authentication: { actor, environment } }) => {
    if (!actor?.verified || actor.client !== DASHBOARD_AGENT_CLIENT || actor.pat) {
      return json({ error: "Dashboard agent access required" }, { status: 403 });
    }

    if (!(await hasLogsPageAccess(actor.sub, false, false, environment.organization.slug))) {
      return json({ error: "Logs are not available for this organization." }, { status: 403 });
    }

    const { from, to, ...filters } = body;
    const { page, searchedFrom, cursorIgnored, budgetSpent } = await searchLogsInEnvironment(
      environment,
      actor.sub,
      {
        ...filters,
        from: from === undefined ? undefined : Date.parse(from),
        to: to === undefined ? undefined : Date.parse(to),
        pageSize: DASHBOARD_AGENT_LOG_SEARCH_LIMIT,
      },
      { signal: getRequestAbortSignal() }
    ).catch((error: unknown) => {
      if (error instanceof ServiceValidationError) {
        throw json(
          { code: "log_search_validation", error: error.message } satisfies z.output<
            typeof dashboardAgentLogSearchValidationError
          >,
          { status: 400 }
        );
      }
      throw error;
    });
    const { complete, timedOut, stopped, expired, searchedTo } = page.searchProgress;

    return json({
      logs: page.logs.map((log) => ({
        runId:
          log.runId.length <= DASHBOARD_AGENT_LOG_ID_CHARS && isRunFriendlyId(log.runId)
            ? log.runId
            : undefined,
        taskIdentifier: sliceWellFormed(log.taskIdentifier, DASHBOARD_AGENT_LOG_ID_CHARS),
        level: log.level,
        timestamp: log.triggeredTimestamp,
        message:
          log.message.length > DASHBOARD_AGENT_LOG_EXCERPT_CHARS
            ? `${sliceWellFormed(log.message, DASHBOARD_AGENT_LOG_EXCERPT_CHARS)}…`
            : log.message,
      })),
      range: { from: page.filters.from.toISOString(), to: page.filters.to.toISOString() },
      searchedFrom: searchedFrom.toISOString(),
      searchedTo,
      complete,
      retentionClamped: page.retention?.wasClamped ?? false,
      timedOut,
      stopped,
      expired,
      cursorIgnored,
      budgetSpent,
      nextCursor: dashboardAgentLogSearchResult.shape.nextCursor.safeParse(page.pagination.next)
        .data,
    } satisfies z.output<typeof dashboardAgentLogSearchResult>);
  }
);

export { action, loader };
