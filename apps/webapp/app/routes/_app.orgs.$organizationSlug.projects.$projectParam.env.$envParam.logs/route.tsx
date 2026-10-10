import { type LoaderFunctionArgs, redirect } from "@remix-run/server-runtime";
import { useNavigation, useLocation, useNavigate, Form } from "@remix-run/react";
import { XMarkIcon } from "@heroicons/react/20/solid";
import { ServiceValidationError } from "~/v3/services/baseService.server";
import {
  TypedAwait,
  typeddefer,
  type UseDataFunctionReturn,
  useTypedLoaderData,
} from "remix-typedjson";
import { getRequestAbortSignal } from "~/services/httpAsyncStorage.server";
import { requireUser } from "~/services/session.server";
import { getCurrentPlan } from "~/services/platform.v3.server";
import { EnvironmentParamSchema } from "~/utils/pathBuilder";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import type { LogEntry } from "~/presenters/v3/LogsListPresenter.server";
import { LogsListPresenter } from "~/presenters/v3/LogsListPresenter.server";
import type { LogLevel } from "~/utils/logUtils";
import { $replica } from "~/db.server";
import { clickhouseFactory } from "~/services/clickhouse/clickhouseFactoryInstance.server";
import { NavBar, PageTitle } from "~/components/primitives/PageHeader";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useOptimisticLocation } from "~/hooks/useOptimisticLocation";
import { Spinner } from "~/components/primitives/Spinner";
import { Paragraph } from "~/components/primitives/Paragraph";
import { Callout } from "~/components/primitives/Callout";
import { LogsTable } from "~/components/logs/LogsTable";
import { LogDetailView } from "~/components/logs/LogDetailView";
import { SearchInput } from "~/components/primitives/SearchInput";
import { LogsLevelFilter } from "~/components/logs/LogsLevelFilter";
import { LogsTaskFilter } from "~/components/logs/LogsTaskFilter";
import { LogsRunIdFilter } from "~/components/logs/LogsRunIdFilter";
import { TimeFilter } from "~/components/runs/v3/SharedFilters";
import {
  RESIZABLE_PANEL_ANIMATION,
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  collapsibleHandleClassName,
  useFrozenValue,
} from "~/components/primitives/Resizable";
import { Button } from "~/components/primitives/Buttons";
import { sectionAgentPageContext } from "~/components/dashboard-agent/suggested-prompts";
import type { Handle } from "~/utils/handle";
import { pageMeta } from "~/utils/pageTitle";
import { hasLogsPageAccess } from "~/services/logsAccess.server";
import { MIN_LOGS_SEARCH_LENGTH, normalizeLogsSearchTerm } from "~/utils/logSearch";

// Valid log levels for filtering
const validLevels: LogLevel[] = ["TRACE", "DEBUG", "INFO", "WARN", "ERROR"];
const AUTOMATIC_SEARCH_BUDGET_MS = 20_000;

type LogsResourceData = {
  logs: LogEntry[];
  pagination: { next?: string };
  pageSize: number;
  searchProgress: {
    searchedTo?: string;
    complete: boolean;
    timedOut: boolean;
    stopped: boolean;
    expired: boolean;
    queryElapsedMs: number;
  };
  searchExpansion?: { nextPeriod: string };
};

function logIdentity(log: LogEntry): string {
  return log.projectionFingerprint ?? log.id;
}

function logsFilterState(pathname: string, search: string): string {
  const params = new URLSearchParams(search);
  params.delete("cursor");
  params.delete("log");
  return `${pathname}?${params.toString()}`;
}

function formatSearchedTo(value: string): string {
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(
    new Date(value)
  );
}

function formatSearchPeriod(period: string): string {
  const days = Number(period.replace("d", ""));
  return days === 1 ? "day" : `${days} days`;
}

function parseLevelsFromUrl(url: URL): LogLevel[] | undefined {
  const levelParams = url.searchParams.getAll("levels").filter((v) => v.length > 0);
  if (levelParams.length === 0) return undefined;
  return levelParams.filter((l): l is LogLevel => validLevels.includes(l as LogLevel));
}

export const handle: Handle = {
  agentPageContext: () => sectionAgentPageContext("logs"),
};

export const meta = pageMeta("Logs");

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const user = await requireUser(request);
  const userId = user.id;

  const { projectParam, organizationSlug, envParam } = EnvironmentParamSchema.parse(params);

  const canAccess = await hasLogsPageAccess(
    userId,
    user.admin,
    user.isImpersonating,
    organizationSlug
  );

  if (!canAccess) {
    throw redirect("/");
  }

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) {
    throw new Response("Project not found", { status: 404 });
  }

  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) {
    throw new Response("Environment not found", { status: 404 });
  }

  // Get filters from query params
  const url = new URL(request.url);
  const requestFilterState = logsFilterState(url.pathname, url.search);
  const tasks = url.searchParams.getAll("tasks").filter((t) => t.length > 0);
  const runId = url.searchParams.get("runId") ?? undefined;
  const search = url.searchParams.get("search") ?? undefined;
  const levels = parseLevelsFromUrl(url);
  const period = url.searchParams.get("period") ?? undefined;
  const fromStr = url.searchParams.get("from");
  const toStr = url.searchParams.get("to");
  const from = fromStr ? parseInt(fromStr, 10) : undefined;
  const to = toStr ? parseInt(toStr, 10) : undefined;

  // Get the user's plan to determine log retention limit
  const plan = await getCurrentPlan(project.organizationId);
  const retentionLimitDays = plan?.v3Subscription?.plan?.limits.logRetentionDays.number ?? 30;

  const logsClickhouse = await clickhouseFactory.getClickhouseForOrganization(
    project.organizationId,
    "logs"
  );
  const presenter = new LogsListPresenter($replica, logsClickhouse);

  const listPromise = presenter
    .call(
      project.organizationId,
      environment.id,
      {
        userId,
        projectId: project.id,
        tasks: tasks.length > 0 ? tasks : undefined,
        runId,
        search,
        levels,
        period,
        from,
        to,
        defaultPeriod: "1d",
        retentionLimitDays,
      },
      getRequestAbortSignal()
    )
    .catch((error) => {
      if (error instanceof ServiceValidationError) {
        return { error: error.message };
      }
      throw error;
    });

  return typeddefer({
    data: listPromise,
    defaultPeriod: "1d",
    retentionLimitDays,
    requestFilterState,
  });
};

export default function Page() {
  const { data, defaultPeriod, retentionLimitDays, requestFilterState } =
    useTypedLoaderData<typeof loader>();

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="Logs" />
      </NavBar>

      <PageBody scrollable={false}>
        <Suspense
          fallback={
            <div className="grid h-full max-h-full grid-rows-[2.5rem_auto] overflow-hidden">
              <div className="border-b border-grid-bright" />
              <div className="my-2 flex items-center justify-center">
                <div className="mx-auto flex items-center gap-2">
                  <Spinner />
                  <Paragraph variant="small">Loading logs…</Paragraph>
                </div>
              </div>
            </div>
          }
        >
          <TypedAwait
            resolve={data}
            errorElement={
              <div className="grid h-full max-h-full grid-rows-[2.5rem_auto_1fr] overflow-hidden">
                <FiltersBar defaultPeriod={defaultPeriod} retentionLimitDays={retentionLimitDays} />
                <div className="flex items-center justify-center px-3 py-12">
                  <Callout variant="error" className="max-w-fit">
                    Unable to load your logs. Please refresh the page or try again in a moment.
                  </Callout>
                </div>
              </div>
            }
          >
            {(result) => {
              // Check if result contains an error
              if ("error" in result) {
                return (
                  <div className="grid h-full max-h-full grid-rows-[2.5rem_auto_1fr] overflow-hidden">
                    <FiltersBar
                      defaultPeriod={defaultPeriod}
                      retentionLimitDays={retentionLimitDays}
                    />
                    <div className="flex items-center justify-center px-3 py-12">
                      <Callout variant="error" className="max-w-fit">
                        {result.error}
                      </Callout>
                    </div>
                  </div>
                );
              }
              return (
                <div className="grid h-full max-h-full grid-rows-[2.5rem_1fr] overflow-hidden">
                  <FiltersBar
                    list={result}
                    defaultPeriod={defaultPeriod}
                    retentionLimitDays={retentionLimitDays}
                  />
                  <LogsList
                    key={requestFilterState}
                    list={result}
                    requestFilterState={requestFilterState}
                    defaultPeriod={defaultPeriod}
                  />
                </div>
              );
            }}
          </TypedAwait>
        </Suspense>
      </PageBody>
    </PageContainer>
  );
}

function FiltersBar({
  list,
  defaultPeriod,
  retentionLimitDays,
}: {
  list?: Exclude<Awaited<UseDataFunctionReturn<typeof loader>["data"]>, { error: string }>;
  defaultPeriod?: string;
  retentionLimitDays: number;
}) {
  const location = useOptimisticLocation();
  const searchParams = new URLSearchParams(location.search);
  const hasFilters =
    searchParams.has("tasks") ||
    searchParams.has("runId") ||
    searchParams.has("search") ||
    searchParams.has("levels") ||
    searchParams.has("period") ||
    searchParams.has("from") ||
    searchParams.has("to");

  return (
    <div className="flex items-start justify-between gap-x-2 border-b border-grid-bright p-2">
      <div className="flex flex-row flex-wrap items-center gap-1.5">
        {list ? (
          <>
            <SearchInput
              minLength={MIN_LOGS_SEARCH_LENGTH}
              normalizeForValidation={normalizeLogsSearchTerm}
            />
            <LogsTaskFilter possibleTasks={list.possibleTasks} />
            <LogsRunIdFilter />
            <TimeFilter defaultPeriod={defaultPeriod} maxPeriodDays={retentionLimitDays} />
            <LogsLevelFilter />
            {hasFilters && (
              <Form className="-ml-1 h-6">
                <Button
                  variant="minimal/small"
                  LeadingIcon={XMarkIcon}
                  tooltip="Clear all filters"
                  className="group-hover/button:bg-transparent"
                  leadingIconClassName="group-hover/button:text-text-bright"
                />
              </Form>
            )}
          </>
        ) : (
          <>
            <LogsTaskFilter possibleTasks={[]} />
            <LogsRunIdFilter />
            <TimeFilter defaultPeriod={defaultPeriod} maxPeriodDays={retentionLimitDays} />
            <LogsLevelFilter />
            <SearchInput
              minLength={MIN_LOGS_SEARCH_LENGTH}
              normalizeForValidation={normalizeLogsSearchTerm}
            />
            {hasFilters && (
              <Form className="-ml-1 h-6">
                <Button
                  variant="minimal/small"
                  LeadingIcon={XMarkIcon}
                  tooltip="Clear all filters"
                  className="group-hover/button:bg-transparent"
                  leadingIconClassName="group-hover/button:text-text-bright"
                />
              </Form>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function LogsList({
  list,
  requestFilterState,
}: {
  list: Exclude<Awaited<UseDataFunctionReturn<typeof loader>["data"]>, { error: string }>; //exclude error, it is handled
  requestFilterState: string;
  defaultPeriod?: string;
}) {
  const navigation = useNavigation();
  const navigate = useNavigate();
  const location = useLocation();
  const [, startTransition] = useTransition();
  const isLoading = navigation.state !== "idle";
  const filterState = useMemo(
    () => logsFilterState(location.pathname, location.search),
    [location.pathname, location.search]
  );

  const [stateSourceList, setStateSourceList] = useState(list);
  const [accumulatedLogs, setAccumulatedLogs] = useState<LogEntry[]>(list.logs);
  const [nextCursor, setNextCursor] = useState<string | undefined>(list.pagination.next);
  const [searchProgress, setSearchProgress] = useState(list.searchProgress);
  const [searchExpansion, setSearchExpansion] = useState(list.searchExpansion);
  const [targetRowCount, setTargetRowCount] = useState(list.pageSize);
  const [automaticBudgetUsed, setAutomaticBudgetUsed] = useState(
    list.searchProgress.queryElapsedMs
  );
  const [initialBudgetStartedAt] = useState(() => Date.now() - list.searchProgress.queryElapsedMs);
  const [automaticSearchPaused, setAutomaticSearchPaused] = useState(false);
  const [continuationError, setContinuationError] = useState<string>();
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [selectedLogId, setSelectedLogId] = useState<string | undefined>(() => {
    const params = new URLSearchParams(location.search);
    return params.get("log") ?? undefined;
  });
  const abortControllerRef = useRef<AbortController | undefined>(undefined);
  const inFlightRef = useRef(false);
  const nextCursorRef = useRef(nextCursor);
  const activeFilterStateRef = useRef(filterState);
  const activeListRef = useRef<typeof list | undefined>(list);
  const automaticBudgetRef = useRef({ startedAt: initialBudgetStartedAt });

  useEffect(() => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = undefined;
    inFlightRef.current = false;
    activeListRef.current = undefined;

    if (filterState !== requestFilterState) {
      // oxlint-disable-next-line react/set-state-in-effect -- An origin mismatch cancels the prior loader snapshot immediately.
      setIsLoadingMore(false);
      return;
    }

    activeFilterStateRef.current = requestFilterState;
    activeListRef.current = list;
    // oxlint-disable-next-line react/set-state-in-effect -- Route data replaces the prior filter's accumulated search state.
    setStateSourceList(list);
    setAccumulatedLogs(list.logs);
    nextCursorRef.current = list.pagination.next;
    setNextCursor(list.pagination.next);
    setSearchProgress(list.searchProgress);
    setSearchExpansion(list.searchExpansion);
    setTargetRowCount(list.pageSize);
    automaticBudgetRef.current.startedAt = Date.now() - list.searchProgress.queryElapsedMs;
    setAutomaticBudgetUsed(list.searchProgress.queryElapsedMs);
    setAutomaticSearchPaused(false);
    setContinuationError(undefined);
    setIsLoadingMore(false);
    const params = new URLSearchParams(location.search);
    setSelectedLogId(params.get("log") ?? undefined);

    return () => {
      abortControllerRef.current?.abort();
      if (activeListRef.current === list) activeListRef.current = undefined;
    };
  }, [filterState, list, location.search, requestFilterState]);

  useEffect(() => {
    if (!isLoading) {
      if (filterState === requestFilterState && stateSourceList === list) {
        activeListRef.current = list;
      }
      return;
    }

    abortControllerRef.current?.abort();
    abortControllerRef.current = undefined;
    inFlightRef.current = false;
    activeListRef.current = undefined;
    // oxlint-disable-next-line react/set-state-in-effect -- Pending navigation cancels the old filter's request immediately.
    setIsLoadingMore(false);
  }, [filterState, isLoading, list, requestFilterState, stateSourceList]);

  useEffect(() => {
    if (!selectedLogId) {
      const url = new URL(window.location.href);
      if (url.searchParams.has("log")) {
        url.searchParams.delete("log");
        window.history.replaceState(null, "", url.toString());
      }
    }
  }, [selectedLogId]);

  const loadMore = useCallback(
    async (requestedRows: number) => {
      if (
        !nextCursor ||
        nextCursor !== nextCursorRef.current ||
        inFlightRef.current ||
        isLoading ||
        filterState !== requestFilterState ||
        stateSourceList !== list ||
        activeListRef.current !== list
      ) {
        return;
      }

      inFlightRef.current = true;
      setContinuationError(undefined);
      setIsLoadingMore(true);
      const responseFilterState = filterState;
      const controller = new AbortController();
      abortControllerRef.current?.abort();
      abortControllerRef.current = controller;

      const resourcePath = `/resources${location.pathname}`;
      const params = new URLSearchParams(location.search);
      params.set("cursor", nextCursor);
      params.set("pageSize", String(Math.max(1, requestedRows)));
      params.delete("log");

      try {
        const response = await fetch(`${resourcePath}?${params.toString()}`, {
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(
            response.status === 422
              ? await response.text()
              : "Unable to continue log search. Please try again."
          );
        }

        const data = (await response.json()) as LogsResourceData;
        if (
          controller.signal.aborted ||
          activeFilterStateRef.current !== responseFilterState ||
          activeListRef.current !== list
        ) {
          return;
        }

        setAccumulatedLogs((current) => {
          const identities = new Set(current.map(logIdentity));
          const newLogs = data.logs.filter((log) => !identities.has(logIdentity(log)));
          return newLogs.length === 0 ? current : [...current, ...newLogs];
        });
        nextCursorRef.current = data.pagination.next;
        setNextCursor(data.pagination.next);
        setSearchProgress((current) => ({
          ...data.searchProgress,
          searchedTo: data.searchProgress.searchedTo ?? current.searchedTo,
        }));
        setSearchExpansion(data.searchExpansion);
      } catch (error) {
        if (
          !controller.signal.aborted &&
          activeFilterStateRef.current === responseFilterState &&
          activeListRef.current === list
        ) {
          setContinuationError(
            error instanceof Error
              ? error.message
              : "Unable to continue log search. Please try again."
          );
          setAutomaticSearchPaused(true);
        }
      } finally {
        if (abortControllerRef.current === controller) {
          abortControllerRef.current = undefined;
          inFlightRef.current = false;
          setAutomaticBudgetUsed(Date.now() - automaticBudgetRef.current.startedAt);
          setIsLoadingMore(false);
        }
      }
    },
    [
      filterState,
      isLoading,
      list,
      location.pathname,
      location.search,
      nextCursor,
      requestFilterState,
      stateSourceList,
    ]
  );

  useEffect(() => {
    if (
      !nextCursor ||
      filterState !== requestFilterState ||
      stateSourceList !== list ||
      activeListRef.current !== list ||
      accumulatedLogs.length >= targetRowCount ||
      automaticSearchPaused ||
      isLoading ||
      isLoadingMore
    ) {
      return;
    }

    const elapsed = Date.now() - automaticBudgetRef.current.startedAt;
    if (elapsed >= AUTOMATIC_SEARCH_BUDGET_MS) {
      // oxlint-disable-next-line react/set-state-in-effect -- Exhausting the current page budget pauses automatic requests.
      setAutomaticBudgetUsed(elapsed);
      setAutomaticSearchPaused(true);
      return;
    }

    // oxlint-disable-next-line react/set-state-in-effect -- The automatic loop intentionally starts the next bounded request.
    void loadMore(targetRowCount - accumulatedLogs.length);
  }, [
    accumulatedLogs.length,
    automaticBudgetUsed,
    automaticSearchPaused,
    filterState,
    isLoading,
    isLoadingMore,
    list,
    loadMore,
    nextCursor,
    requestFilterState,
    stateSourceList,
    targetRowCount,
  ]);

  const handleAutomaticLoadMore = useCallback(() => {
    if (
      inFlightRef.current ||
      automaticSearchPaused ||
      isLoading ||
      !nextCursor ||
      nextCursor !== nextCursorRef.current ||
      filterState !== requestFilterState ||
      stateSourceList !== list ||
      activeListRef.current !== list
    ) {
      return;
    }

    const elapsed = Date.now() - automaticBudgetRef.current.startedAt;
    if (accumulatedLogs.length < targetRowCount) {
      if (elapsed >= AUTOMATIC_SEARCH_BUDGET_MS) {
        setAutomaticBudgetUsed(elapsed);
        setAutomaticSearchPaused(true);
        return;
      }
      void loadMore(targetRowCount - accumulatedLogs.length);
      return;
    }

    const nextTarget = targetRowCount + list.pageSize;
    automaticBudgetRef.current.startedAt = Date.now();
    setAutomaticBudgetUsed(0);
    setTargetRowCount(nextTarget);
    void loadMore(list.pageSize);
  }, [
    accumulatedLogs.length,
    automaticSearchPaused,
    filterState,
    isLoading,
    list,
    loadMore,
    nextCursor,
    requestFilterState,
    stateSourceList,
    targetRowCount,
  ]);

  const handleKeepSearching = () => {
    if (
      isLoading ||
      !nextCursor ||
      nextCursor !== nextCursorRef.current ||
      filterState !== requestFilterState ||
      stateSourceList !== list ||
      activeListRef.current !== list
    ) {
      return;
    }

    const nextTarget =
      accumulatedLogs.length >= targetRowCount ? targetRowCount + list.pageSize : targetRowCount;
    automaticBudgetRef.current.startedAt = Date.now();
    setAutomaticBudgetUsed(0);
    setAutomaticSearchPaused(false);
    setTargetRowCount(nextTarget);
    void loadMore(Math.max(1, nextTarget - accumulatedLogs.length));
  };

  const selectedLog = useMemo(() => {
    if (!selectedLogId) return undefined;
    return accumulatedLogs.find((log) => log.id === selectedLogId);
  }, [selectedLogId, accumulatedLogs]);

  const frozenLogId = useFrozenValue(selectedLogId);
  const frozenLog = useFrozenValue(selectedLog);
  const displayLogId = selectedLogId ?? frozenLogId;
  const displayLog = selectedLog ?? frozenLog ?? undefined;

  const updateUrlWithLog = useCallback((logId: string | undefined) => {
    const url = new URL(window.location.href);
    if (logId) {
      url.searchParams.set("log", logId);
    } else {
      url.searchParams.delete("log");
    }
    window.history.replaceState(null, "", url.toString());
  }, []);

  const handleLogSelect = useCallback(
    (logId: string) => {
      startTransition(() => {
        setSelectedLogId(logId);
      });
      updateUrlWithLog(logId);
    },
    [updateUrlWithLog, startTransition]
  );

  const handleClosePanel = useCallback(() => {
    startTransition(() => {
      setSelectedLogId(undefined);
    });
    updateUrlWithLog(undefined);
  }, [updateUrlWithLog, startTransition]);

  const expandSearch = () => {
    const url = new URL(window.location.href);
    url.searchParams.set("period", searchExpansion?.nextPeriod ?? "7d");
    url.searchParams.delete("cursor");
    url.searchParams.delete("log");
    navigate(`${url.pathname}?${url.searchParams.toString()}`);
  };

  const visibleSearchExpansion = accumulatedLogs.length === 0 ? searchExpansion : undefined;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {visibleSearchExpansion && (
        <Callout
          variant="info"
          className="m-2 mb-0"
          cta={
            <Button variant="tertiary/small" onClick={expandSearch}>
              Search last {formatSearchPeriod(visibleSearchExpansion.nextPeriod)}
            </Button>
          }
        >
          No matches in the last day.
        </Callout>
      )}
      {continuationError && (
        <Callout variant="warning" className="m-2 mb-0">
          {continuationError}
        </Callout>
      )}
      {searchProgress.stopped && (
        <Callout variant="warning" className="m-2 mb-0">
          Search stopped because this time range repeatedly timed out. Earlier results are still
          shown. Try a shorter time range or more specific filters.
        </Callout>
      )}
      {searchProgress.expired && (
        <Callout variant="warning" className="m-2 mb-0">
          Search stopped because the remaining time range is no longer retained. Earlier results are
          still shown.
        </Callout>
      )}
      <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
        <ResizablePanel id="logs-main" min="200px">
          <LogsTable
            key={requestFilterState}
            logs={accumulatedLogs}
            searchTerm={list.searchTerm}
            isLoading={isLoading || (isLoadingMore && accumulatedLogs.length === 0)}
            isLoadingMore={isLoadingMore}
            hasMore={!!nextCursor}
            isIncomplete={searchProgress.stopped || searchProgress.expired}
            onLoadMore={handleAutomaticLoadMore}
            showKeepSearching={automaticSearchPaused}
            onKeepSearching={handleKeepSearching}
            searchedTo={
              searchProgress.searchedTo ? formatSearchedTo(searchProgress.searchedTo) : undefined
            }
            selectedLogId={selectedLogId}
            onLogSelect={handleLogSelect}
          />
        </ResizablePanel>
        <ResizableHandle id="logs-handle" className={collapsibleHandleClassName(!!selectedLogId)} />
        <ResizablePanel
          id="log-detail"
          default="430px"
          min="430px"
          max="600px"
          className="overflow-hidden"
          collapsible
          collapsed={!selectedLogId}
          onCollapseChange={() => {}}
          collapsedSize="0px"
          collapseAnimation={RESIZABLE_PANEL_ANIMATION}
        >
          <div className="h-full" style={{ minWidth: 430 }}>
            {displayLogId && (
              <Suspense
                fallback={
                  <div className="flex h-full items-center justify-center">
                    <Spinner />
                  </div>
                }
              >
                <LogDetailView
                  logId={displayLogId}
                  initialLog={displayLog}
                  onClose={handleClosePanel}
                  searchTerm={list.searchTerm}
                />
              </Suspense>
            )}
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
