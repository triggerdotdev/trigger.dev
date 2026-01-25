import { type LoaderFunctionArgs, redirect } from "@remix-run/server-runtime";
import { type MetaFunction, useFetcher, useNavigation, useLocation } from "@remix-run/react";
import { ServiceValidationError } from "~/v3/services/baseService.server";
import {
  TypedAwait,
  typeddefer,
  type UseDataFunctionReturn,
  useTypedLoaderData,
} from "remix-typedjson";
import { requireUser } from "~/services/session.server";

import { EnvironmentParamSchema } from "~/utils/pathBuilder";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { getRunFiltersFromRequest } from "~/presenters/RunFilters.server";
import { LogsListPresenter } from "~/presenters/v3/LogsListPresenter.server";
import type { LogLevel } from "~/utils/logUtils";
import { $replica, prisma } from "~/db.server";
import { clickhouseClient } from "~/services/clickhouseInstance.server";
import {
  setRootOnlyFilterPreference,
  uiPreferencesStorage,
} from "~/services/preferences/uiPreferences.server";
import { NavBar, PageTitle } from "~/components/primitives/PageHeader";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Suspense, useCallback, useEffect, useMemo, useState, useTransition } from "react";
import { Spinner } from "~/components/primitives/Spinner";
import { Paragraph } from "~/components/primitives/Paragraph";
import { Callout } from "~/components/primitives/Callout";
import { RunsFilters } from "~/components/runs/v3/RunFilters";
import { LogsTable } from "~/components/logs/LogsTable";
import type { LogEntry } from "~/presenters/v3/LogsListPresenter.server";
import { LogDetailView } from "~/components/logs/LogDetailView";
import { LogsSearchInput } from "~/components/logs/LogsSearchInput";
import { LogsLevelFilter } from "~/components/logs/LogsLevelFilter";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "~/components/primitives/Resizable";
import { Switch } from "~/components/primitives/Switch";
import { Button } from "~/components/primitives/Buttons";
import { ArrowPathIcon } from "@heroicons/react/20/solid";
import { FEATURE_FLAG, validateFeatureFlagValue } from "~/v3/featureFlags.server";

// Valid log levels for filtering
const validLevels: LogLevel[] = ["TRACE", "DEBUG", "INFO", "WARN", "ERROR", "CANCELLED"];

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

  const filters = await getRunFiltersFromRequest(request);

  // Get search term, levels, and showDebug from query params
  const url = new URL(request.url);
  const search = url.searchParams.get("search") ?? undefined;
  const levels = parseLevelsFromUrl(url);
  const showDebug = url.searchParams.get("showDebug") === "true";

  const presenter = new LogsListPresenter($replica, clickhouseClient);

  const listPromise = presenter
    .call(project.organizationId, environment.id, {
      userId,
      projectId: project.id,
      ...filters,
      search,
      levels,
      includeDebugLogs: isAdmin && showDebug,
      defaultPeriod: "1h",
    })
    .catch((error) => {
      if (error instanceof ServiceValidationError) {
        return { error: "Failed to load logs. Please refresh and try again." };
      }
      throw error;
    });

  const session = await setRootOnlyFilterPreference(filters.rootOnly, request);
  const cookieValue = await uiPreferencesStorage.commitSession(session);

  return typeddefer(
    {
      data: listPromise,
      rootOnlyDefault: filters.rootOnly,
      filters,
      isAdmin,
      showDebug,
      defaultPeriod: "1h",
    },
    {
      headers: {
        "Set-Cookie": cookieValue,
      },
    }
  );
};

export default function Page() {
  const { data, rootOnlyDefault, isAdmin, showDebug, defaultPeriod } =
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
                  rootOnlyDefault={rootOnlyDefault}
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
                      list={result}
                      rootOnlyDefault={rootOnlyDefault}
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
                    rootOnlyDefault={rootOnlyDefault}
                    isAdmin={isAdmin}
                    showDebug={showDebug}
                    defaultPeriod={defaultPeriod}
                  />
                  <LogsList
                    list={result}
                    rootOnlyDefault={rootOnlyDefault}
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

function FiltersBar({
  list,
  rootOnlyDefault,
  isAdmin,
  showDebug,
  defaultPeriod,
}: {
  list?: Exclude<Awaited<UseDataFunctionReturn<typeof loader>["data"]>, { error: string }>;
  rootOnlyDefault: boolean;
  isAdmin: boolean;
  showDebug: boolean;
  defaultPeriod?: string;
}) {
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
            <RunsFilters
              possibleTasks={list.possibleTasks}
              bulkActions={list.bulkActions}
              hasFilters={list.hasFilters}
              rootOnlyDefault={rootOnlyDefault}
              hideSearch
              defaultPeriod={defaultPeriod}
            />
            <LogsLevelFilter showDebug={showDebug} />
            <LogsSearchInput />
          </>
        ) : (
          <>
            <RunsFilters
              possibleTasks={[]}
              bulkActions={[]}
              hasFilters={false}
              rootOnlyDefault={rootOnlyDefault}
              hideSearch
              defaultPeriod={defaultPeriod}
            />
            <LogsLevelFilter showDebug={showDebug} />
            <LogsSearchInput />
          </>
        )}
      </div>
      {isAdmin && (
        <Switch
          variant="small"
          label="Debug"
          checked={showDebug}
          onCheckedChange={handleDebugToggle}
        />
      )}
    </div>
  );
}

function LogsList({
  list,
  rootOnlyDefault,
  isAdmin,
  showDebug,
  defaultPeriod,
}: {
  list: Exclude<Awaited<UseDataFunctionReturn<typeof loader>["data"]>, { error: string }>; //exclude error, it is handled
  rootOnlyDefault: boolean;
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

  // Reset accumulated logs when filters change (by watching URL search params)
  useEffect(() => {
    setAccumulatedLogs(list.logs);
    setNextCursor(list.pagination.next);
    // Close side panel when filters change to avoid showing a log that's no longer visible
    setSelectedLogId(undefined);
  }, [location.search]);

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
      const existingIds = new Set(accumulatedLogs.map((log) => log.id));
      const newLogs = fetcher.data.logs.filter((log) => !existingIds.has(log.id));
      if (newLogs.length > 0) {
        setAccumulatedLogs((prev) => [...prev, ...newLogs]);
        setNextCursor(fetcher.data.pagination.next);
      }
    }
  }, [fetcher.data, fetcher.state, accumulatedLogs]);

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
      fetcher.load(loadMoreUrl);
    }
  }, [loadMoreUrl, fetcher]);

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
