import { $replica } from "~/db.server";
import { LogsListPresenter, type LogsListOptions } from "~/presenters/v3/LogsListPresenter.server";
import { decodeLogsSearchCursor } from "~/utils/logSearchCursor.server";
import type { AuthenticatedEnvironment } from "./apiAuth.server";
import { clickhouseFactory } from "./clickhouse/clickhouseFactoryInstance.server";
import { getCurrentPlan } from "./platform.v3.server";

export const LOGS_SEARCH_BUDGET_MS = 10_000;

type SearchOptions = Pick<
  LogsListOptions,
  "tasks" | "runId" | "search" | "period" | "from" | "to" | "levels" | "cursor"
> & { pageSize: number };

/** Unlike the interactive list, keep reading slices until the caller has a page of results. */
export async function searchLogsInEnvironment(
  environment: AuthenticatedEnvironment,
  userId: string,
  filters: SearchOptions,
  {
    signal,
    budgetMs = LOGS_SEARCH_BUDGET_MS,
    now = () => performance.now(),
  }: { signal: AbortSignal; budgetMs?: number; now?: () => number }
) {
  const { id, organizationId, projectId } = environment;
  const plan = await getCurrentPlan(organizationId);
  const retentionLimitDays = plan?.v3Subscription?.plan?.limits.logRetentionDays.number ?? 30;
  const clickhouse = await clickhouseFactory.getClickhouseForOrganization(organizationId, "logs");
  const presenter = new LogsListPresenter($replica, clickhouse);
  const startedAt = now();
  const read = (cursor: string | undefined, pageSize: number) =>
    presenter.call(
      organizationId,
      id,
      { ...filters, userId, projectId, cursor, pageSize, retentionLimitDays, defaultPeriod: "1d" },
      signal
    );

  const first = await read(filters.cursor, filters.pageSize);
  const logs = [...first.logs];
  let page = first;
  let searchedTo = first.searchProgress.searchedTo;
  while (
    page.pagination.next &&
    logs.length < filters.pageSize &&
    now() - startedAt < budgetMs &&
    !signal.aborted
  ) {
    page = await read(page.pagination.next, filters.pageSize - logs.length);
    logs.push(...page.logs);
    searchedTo = page.searchProgress.searchedTo ?? searchedTo;
  }

  const applied =
    first.pagination.cursorApplied && filters.cursor
      ? decodeLogsSearchCursor(filters.cursor)
      : null;
  return {
    page: {
      ...page,
      logs,
      filters: first.filters,
      searchProgress: { ...page.searchProgress, searchedTo },
    },
    searchedFrom: new Date(applied?.slice.remainingUpper ?? first.filters.to.getTime()),
    cursorIgnored: first.pagination.cursorApplied === false,
    budgetSpent: page.pagination.next !== undefined && logs.length < filters.pageSize,
  };
}
