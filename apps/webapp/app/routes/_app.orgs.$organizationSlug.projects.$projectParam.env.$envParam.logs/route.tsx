import { type LoaderFunctionArgs, redirect } from "@remix-run/server-runtime";
import { type MetaFunction, useFetcher, useNavigation, useLocation, Form } from "@remix-run/react";
import { XMarkIcon } from "@heroicons/react/20/solid";
import { ServiceValidationError } from "~/v3/services/baseService.server";
import {
  TypedAwait,
  typeddefer,
  type UseDataFunctionReturn,
  useTypedLoaderData,
} from "remix-typedjson";
import { requireUser } from "~/services/session.server";
import { getCurrentPlan } from "~/services/platform.v3.server";

import { EnvironmentParamSchema } from "~/utils/pathBuilder";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { LogsListPresenter } from "~/presenters/v3/LogsListPresenter.server";
import type { LogLevel } from "~/utils/logUtils";
import { $replica, prisma } from "~/db.server";
import { clickhouseClient } from "~/services/clickhouseInstance.server";
import { NavBar, PageTitle } from "~/components/primitives/PageHeader";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useOptimisticLocation } from "~/hooks/useOptimisticLocation";
import { Spinner } from "~/components/primitives/Spinner";
import { Paragraph } from "~/components/primitives/Paragraph";
import { Callout } from "~/components/primitives/Callout";
import { LogsTable } from "~/components/logs/LogsTable";
import type { LogEntry } from "~/presenters/v3/LogsListPresenter.server";
import { LogDetailView } from "~/components/logs/LogDetailView";
import { LogsSearchInput } from "~/components/logs/LogsSearchInput";
import { LogsLevelFilter } from "~/components/logs/LogsLevelFilter";
import { LogsTaskFilter } from "~/components/logs/LogsTaskFilter";
import { LogsRunIdFilter } from "~/components/logs/LogsRunIdFilter";
import { TimeFilter } from "~/components/runs/v3/SharedFilters";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "~/components/primitives/Resizable";
import { Switch } from "~/components/primitives/Switch";
import { Button } from "~/components/primitives/Buttons";
import { FEATURE_FLAG, validateFeatureFlagValue } from "~/v3/featureFlags.server";

// Valid log levels for filtering
const validLevels: LogLevel[] = ["DEBUG", "INFO", "WARN", "ERROR"];

function parseLevelsFromUrl(url: URL): LogLevel[] | undefined {
  const levelParams = url.searchParams.getAll("levels").filter((v) => v.length > 0);
  if (levelParams.length === 0) return undefined;
  return levelParams.filter((l): l is LogLevel => validLevels.includes(l as LogLevel));
}

export const meta: MetaFunction = () => {
  return [
    {
      title: `Logs | Trigger.dev`,
    },
  ];
};

// TODO: Move this to a more appropriate shared location
async function hasLogsPageAccess(
  userId: string,
  isAdmin: boolean,
  isImpersonating: boolean,
  organizationSlug: string
): Promise<boolean> {
  if (isAdmin || isImpersonating) {
    return true;
  }

  // Check organization feature flags
  const organization = await prisma.organization.findFirst({
    where: {
      slug: organizationSlug,
      members: { some: { userId } },
    },
    select: {
      featureFlags: true,
    },
  });

  if (!organization?.featureFlags) {
    return false;
  }

  const flags = organization.featureFlags as Record<string, unknown>;
  const hasLogsPageAccessResult = validateFeatureFlagValue(
    FEATURE_FLAG.hasLogsPageAccess,
    flags.hasLogsPageAccess
  );

  return hasLogsPageAccessResult.success && hasLogsPageAccessResult.data === true;
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const user = await requireUser(request);
  const userId = user.id;
  const isAdmin = user.admin || user.isImpersonating;

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
  const tasks = url.searchParams.getAll("tasks").filter((t) => t.length > 0);
  const runId = url.searchParams.get("runId") ?? undefined;
  const search = url.searchParams.get("search") ?? undefined;
  const levels = parseLevelsFromUrl(url);
  const showDebug = url.searchParams.get("showDebug") === "true";
  const period = url.searchParams.get("period") ?? undefined;
  const fromStr = url.searchParams.get("from");
  const toStr = url.searchParams.get("to");
  const from = fromStr ? parseInt(fromStr, 10) : undefined;
  const to = toStr ? parseInt(toStr, 10) : undefined;

  // Get the user's plan to determine log retention limit
  const plan = await getCurrentPlan(project.organizationId);
  const retentionLimitDays = plan?.v3Subscription?.plan?.limits.logRetentionDays.number ?? 30;

  const presenter = new LogsListPresenter($replica, clickhouseClient);

  const listPromise = presenter
    .call(project.organizationId, environment.id, {
      userId,
      projectId: project.id,
      tasks: tasks.length > 0 ? tasks : undefined,
      runId,
      search,
      levels,
      period,
      from,
      to,
      includeDebugLogs: isAdmin && showDebug,
      defaultPeriod: "1h",
      retentionLimitDays,
    })
    .catch((error) => {
      if (error instanceof ServiceValidationError) {
        return { error: error.message };
      }
      throw error;
    });

  return typeddefer({
    data: listPromise,
    isAdmin,
    showDebug,
    defaultPeriod: "1h",
  });
};

export default function Page() {
  const { data, isAdmin, showDebug, defaultPeriod } =
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
                <FiltersBar
                  isAdmin={isAdmin}
                  showDebug={showDebug}
                  defaultPeriod={defaultPeriod}
                />
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
                      isAdmin={isAdmin}
                      showDebug={showDebug}
                      defaultPeriod={defaultPeriod}
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
                    isAdmin={isAdmin}
                    showDebug={showDebug}
                    defaultPeriod={defaultPeriod}
                  />
                  <LogsList
                    list={result}
                    isAdmin={isAdmin}
                    showDebug={showDebug}
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

function RetentionNotice({
  logCount,
  retentionDays,
}: {
  logCount: number;
  retentionDays: number;
}) {
  return (
    <Paragraph variant="extra-small" className="flex items-center gap-1 whitespace-nowrap">
      <span className="text-text-dimmed">
       Showing last {retentionDays} {retentionDays === 1 ? 'day' : 'days'}
      </span>
      <a
        href="https://trigger.dev/pricing"
        target="_blank"
        rel="noopener noreferrer"
        className="text-text-link hover:underline"
      >
        Upgrade
      </a>
    </Paragraph>
  );
}

function FiltersBar({
  list,
  isAdmin,
  showDebug,
  defaultPeriod,
}: {
  list?: Exclude<Awaited<UseDataFunctionReturn<typeof loader>["data"]>, { error: string }>;
  isAdmin: boolean;
  showDebug: boolean;
  defaultPeriod?: string;
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

  const handleDebugToggle = useCallback((checked: boolean) => {
    const url = new URL(window.location.href);
    if (checked) {
      url.searchParams.set("showDebug", "true");
    } else {
      url.searchParams.delete("showDebug");
    }
    window.location.href = url.toString();
  }, []);

  return (
    <div className="flex items-start justify-between gap-x-2 border-b border-grid-bright p-2">
      <div className="flex flex-row flex-wrap items-center gap-1">
        {list ? (
          <>
            <LogsTaskFilter possibleTasks={list.possibleTasks} />
            <LogsRunIdFilter />
            <TimeFilter defaultPeriod={defaultPeriod} />
            <LogsLevelFilter/>
            <LogsSearchInput />
            {hasFilters && (
              <Form className="h-6">
                <Button variant="secondary/small" LeadingIcon={XMarkIcon} tooltip="Clear all filters" />
              </Form>
            )}
          </>
        ) : (
          <>
            <LogsTaskFilter possibleTasks={[]} />
            <LogsRunIdFilter />
            <TimeFilter defaultPeriod={defaultPeriod} />
            <LogsLevelFilter/>
            <LogsSearchInput />
            {hasFilters && (
              <Form className="h-6">
                <Button variant="secondary/small" LeadingIcon={XMarkIcon} tooltip="Clear all filters" />
              </Form>
            )}
          </>
        )}
      </div>
      <div className="flex items-center gap-2">
        {list?.retention?.wasClamped && (
          <RetentionNotice
            logCount={list.logs.length}
            retentionDays={list.retention.limitDays}
          />
        )}
        {isAdmin && (
          <Switch
            variant="small"
            label="Debug"
            checked={showDebug}
            onCheckedChange={handleDebugToggle}
          />
        )}
      </div>
    </div>
  );
}

function LogsList({
  list,
}: {
  list: Exclude<Awaited<UseDataFunctionReturn<typeof loader>["data"]>, { error: string }>; //exclude error, it is handled
  isAdmin: boolean;
  showDebug: boolean;
  defaultPeriod?: string;
}) {
  const navigation = useNavigation();
  const location = useLocation();
  const fetcher = useFetcher<{ logs: LogEntry[]; pagination: { next?: string } }>();
  const [, startTransition] = useTransition();
  const isLoading = navigation.state !== "idle";

  // Accumulated logs state
  const [accumulatedLogs, setAccumulatedLogs] = useState<LogEntry[]>(list.logs);
  const [nextCursor, setNextCursor] = useState<string | undefined>(list.pagination.next);

  // Selected log state - managed locally to avoid triggering navigation
  const [selectedLogId, setSelectedLogId] = useState<string | undefined>();

  // Track which filter state (search params) the current fetcher request corresponds to
  const fetcherFilterStateRef = useRef<string>(location.search);

  // Clear accumulated logs immediately when filters change (for instant visual feedback)
  useEffect(() => {
    setAccumulatedLogs([]);
    setNextCursor(undefined);
    // Close side panel when filters change to avoid showing a log that's no longer visible
    setSelectedLogId(undefined);
  }, [location.search]);

  // Populate accumulated logs when new data arrives
  useEffect(() => {
    setAccumulatedLogs(list.logs);
    setNextCursor(list.pagination.next);
  }, [list.logs, list.pagination.next]);

  // Clear log parameter from URL when selectedLogId is cleared
  useEffect(() => {
    if (!selectedLogId) {
      const url = new URL(window.location.href);
      if (url.searchParams.has("log")) {
        url.searchParams.delete("log");
        window.history.replaceState(null, "", url.toString());
      }
    }
  }, [selectedLogId]);

  // Append new logs when fetcher completes (with deduplication)
  useEffect(() => {
    if (fetcher.data && fetcher.state === "idle") {
      // Ignore fetcher data if it was loaded for a different filter state
      if (fetcherFilterStateRef.current !== location.search) {
        return;
      }

      const existingIds = new Set(accumulatedLogs.map((log) => log.id));
      const newLogs = fetcher.data.logs.filter((log) => !existingIds.has(log.id));
      if (newLogs.length > 0) {
        setAccumulatedLogs((prev) => [...prev, ...newLogs]);
      }
      setNextCursor(fetcher.data.pagination.next);
    }
  }, [fetcher.data, fetcher.state, accumulatedLogs, location.search]);

  // Build resource URL for loading more
  const loadMoreUrl = useMemo(() => {
    if (!nextCursor) return null;
    const resourcePath = `/resources${location.pathname}`;
    const params = new URLSearchParams(location.search);
    params.set("cursor", nextCursor);
    params.delete("log");
    return `${resourcePath}?${params.toString()}`;
  }, [location.pathname, location.search, nextCursor]);

  const handleLoadMore = useCallback(() => {
    if (loadMoreUrl && fetcher.state === "idle") {
      // Store the current filter state before loading
      fetcherFilterStateRef.current = location.search;
      fetcher.load(loadMoreUrl);
    }
  }, [loadMoreUrl, fetcher, location.search]);

  const selectedLog = useMemo(() => {
    if (!selectedLogId) return undefined;
    return accumulatedLogs.find((log) => log.id === selectedLogId);
  }, [selectedLogId, accumulatedLogs]);

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

  return (
    <ResizablePanelGroup orientation="horizontal" className="max-h-full">
      <ResizablePanel id="logs-main" min="200px">
        <LogsTable
          key={location.search}
          logs={accumulatedLogs}
          searchTerm={list.searchTerm}
          isLoading={isLoading}
          isLoadingMore={fetcher.state === "loading"}
          hasMore={!!nextCursor}
          onLoadMore={handleLoadMore}
          selectedLogId={selectedLogId}
          onLogSelect={handleLogSelect}
        />
      </ResizablePanel>
      {/* Side panel for log details */}
      {selectedLogId && (
        <>
          <ResizableHandle id="logs-handle" />
          <ResizablePanel id="log-detail" min="300px" default="430px" max="600px" isStaticAtRest>
            <Suspense
              fallback={
                <div className="flex h-full items-center justify-center">
                  <Spinner />
                </div>
              }
            >
              <LogDetailView
                logId={selectedLogId}
                initialLog={selectedLog}
                onClose={handleClosePanel}
                searchTerm={list.searchTerm}
              />
            </Suspense>
          </ResizablePanel>
        </>
      )}
    </ResizablePanelGroup>
  );
}
