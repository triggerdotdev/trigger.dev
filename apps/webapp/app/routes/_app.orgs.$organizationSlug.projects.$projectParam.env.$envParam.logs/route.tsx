import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { type MetaFunction, useFetcher, useNavigation, useLocation } from "@remix-run/react";
import {
  TypedAwait,
  typeddefer,
  type UseDataFunctionReturn,
  useTypedLoaderData,
} from "remix-typedjson";
import { requireUserId } from "~/services/session.server";

import { docsPath, EnvironmentParamSchema } from "~/utils/pathBuilder";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { getRunFiltersFromRequest } from "~/presenters/RunFilters.server";
import { LogsListPresenter } from "~/presenters/v3/LogsListPresenter.server";
import { $replica } from "~/db.server";
import { clickhouseClient } from "~/services/clickhouseInstance.server";
import {
  setRootOnlyFilterPreference,
  uiPreferencesStorage,
} from "~/services/preferences/uiPreferences.server";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { LinkButton } from "~/components/primitives/Buttons";
import { BookOpenIcon } from "@heroicons/react/24/solid";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { Spinner } from "~/components/primitives/Spinner";
import { Paragraph } from "~/components/primitives/Paragraph";
import { Callout } from "~/components/primitives/Callout";
import type { TaskRunListSearchFilters } from "~/components/runs/v3/RunFilters";
import { RunsFilters } from "~/components/runs/v3/RunFilters";
import { LogsTable } from "~/components/logs/LogsTable";
import type { LogEntry } from "~/presenters/v3/LogsListPresenter.server";
import { LogDetailView } from "~/components/logs/LogDetailView";
import { LogsSearchInput } from "~/components/logs/LogsSearchInput";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "~/components/primitives/Resizable";

export const meta: MetaFunction = () => {
  return [
    {
      title: `Logs | Trigger.dev`,
    },
  ];
};

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { projectParam, organizationSlug, envParam } = EnvironmentParamSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) {
    throw new Error("Project not found");
  }

  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) {
    throw new Error("Environment not found");
  }

  const filters = await getRunFiltersFromRequest(request);

  // Get search term from query params
  const url = new URL(request.url);
  const search = url.searchParams.get("search") ?? undefined;

  const presenter = new LogsListPresenter($replica, clickhouseClient);
  const list = presenter.call(project.organizationId, environment.id, {
    userId,
    projectId: project.id,
    ...filters,
    search,
  });

  const session = await setRootOnlyFilterPreference(filters.rootOnly, request);
  const cookieValue = await uiPreferencesStorage.commitSession(session);

  return typeddefer(
    {
      data: list,
      rootOnlyDefault: filters.rootOnly,
      filters,
    },
    {
      headers: {
        "Set-Cookie": cookieValue,
      },
    }
  );
};

export default function Page() {
  const { data, rootOnlyDefault, filters } = useTypedLoaderData<typeof loader>();

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="Logs" />
        <PageAccessories>
          <LinkButton
            variant={"docs/small"}
            LeadingIcon={BookOpenIcon}
            to={docsPath("/runs-and-attempts")}
          >
            Logs docs
          </LinkButton>
        </PageAccessories>
      </NavBar>

      <PageBody scrollable={false}>
        <Suspense
          fallback={
            <div className="grid h-full max-h-full grid-rows-[2.5rem_auto] overflow-hidden">
              <div className="border-b border-grid-bright" />
              <div className="my-2 flex items-center justify-center">
                <div className="mx-auto flex items-center gap-2">
                  <Spinner />
                  <Paragraph variant="small">Loading logs</Paragraph>
                </div>
              </div>
            </div>
          }
        >
          <TypedAwait
            resolve={data}
            errorElement={
              <div className="flex items-center justify-center px-3 py-12">
                <Callout variant="error" className="max-w-fit">
                  Unable to load your logs. Please refresh the page or try again in a moment.
                </Callout>
              </div>
            }
          >
            {(list) => {
              return (
                <LogsList
                  list={list}
                  rootOnlyDefault={rootOnlyDefault}
                  filters={filters}
                />
              );
            }}
          </TypedAwait>
        </Suspense>
      </PageBody>
    </PageContainer>
  );
}

function LogsList({
  list,
  rootOnlyDefault,
  filters,
}: {
  list: Awaited<UseDataFunctionReturn<typeof loader>["data"]>;
  rootOnlyDefault: boolean;
  filters: TaskRunListSearchFilters;
}) {
  const navigation = useNavigation();
  const location = useLocation();
  const fetcher = useFetcher<{ logs: LogEntry[]; pagination: { next?: string } }>();
  const isLoading = navigation.state !== "idle";

  // Accumulated logs state
  const [accumulatedLogs, setAccumulatedLogs] = useState<LogEntry[]>(list.logs);
  const [nextCursor, setNextCursor] = useState<string | undefined>(list.pagination.next);

  // Selected log state - managed locally to avoid triggering navigation
  const [selectedLogId, setSelectedLogId] = useState<string | undefined>(() => {
    // Initialize from URL on mount
    const params = new URLSearchParams(location.search);
    return params.get("log") ?? undefined;
  });

  // Reset accumulated logs when the initial list changes (e.g., filters change)
  useEffect(() => {
    setAccumulatedLogs(list.logs);
    setNextCursor(list.pagination.next);
  }, [list.logs, list.pagination.next]);

  // Append new logs when fetcher completes (with deduplication)
  useEffect(() => {
    if (fetcher.data && fetcher.state === "idle") {
      setAccumulatedLogs((prev) => {
        const existingIds = new Set(prev.map((log) => log.id));
        const newLogs = fetcher.data!.logs.filter((log) => !existingIds.has(log.id));
        return [...prev, ...newLogs];
      });
      setNextCursor(fetcher.data.pagination.next);
    }
  }, [fetcher.data, fetcher.state]);

  // Build resource URL for loading more
  const loadMoreUrl = useMemo(() => {
    if (!nextCursor) return null;
    // Transform /orgs/.../logs to /resources/orgs/.../logs
    const resourcePath = `/resources${location.pathname}`;
    const params = new URLSearchParams(location.search);
    params.set("cursor", nextCursor);
    params.delete("log"); // Don't include selected log in fetch
    return `${resourcePath}?${params.toString()}`;
  }, [location.pathname, location.search, nextCursor]);

  // Handle loading more
  const handleLoadMore = useCallback(() => {
    if (loadMoreUrl && fetcher.state === "idle") {
      fetcher.load(loadMoreUrl);
    }
  }, [loadMoreUrl, fetcher]);

  // Find the selected log in the accumulated list for initial data
  const selectedLog = useMemo(() => {
    if (!selectedLogId) return undefined;
    return accumulatedLogs.find((log) => log.id === selectedLogId);
  }, [selectedLogId, accumulatedLogs]);

  // Update URL without triggering navigation using History API
  const updateUrlWithLog = useCallback(
    (logId: string | undefined) => {
      const url = new URL(window.location.href);
      if (logId) {
        url.searchParams.set("log", logId);
      } else {
        url.searchParams.delete("log");
      }
      window.history.replaceState(null, "", url.toString());
    },
    []
  );

  // Handle log selection
  const handleLogSelect = useCallback(
    (logId: string) => {
      setSelectedLogId(logId);
      updateUrlWithLog(logId);
    },
    [updateUrlWithLog]
  );

  // Handle closing the side panel
  const handleClosePanel = useCallback(() => {
    setSelectedLogId(undefined);
    updateUrlWithLog(undefined);
  }, [updateUrlWithLog]);

  return (
    <ResizablePanelGroup orientation="horizontal" className="max-h-full">
      <ResizablePanel id="logs-main" min="200px">
        <div className="grid h-full max-h-full grid-rows-[auto_1fr] overflow-hidden">
          {/* Filters */}
          <div className="flex items-start justify-between gap-x-2 p-2">
            <div className="flex flex-row flex-wrap items-center gap-1">
              <RunsFilters
                possibleTasks={list.possibleTasks}
                bulkActions={list.bulkActions}
                hasFilters={list.hasFilters}
                rootOnlyDefault={rootOnlyDefault}
                hideSearch
              />
              <LogsSearchInput />
            </div>
          </div>

          {/* Table */}
          <LogsTable
            logs={accumulatedLogs}
            hasFilters={list.hasFilters}
            filters={list.filters}
            searchTerm={list.searchTerm}
            isLoading={isLoading}
            isLoadingMore={fetcher.state === "loading"}
            hasMore={!!nextCursor}
            onLoadMore={handleLoadMore}
            selectedLogId={selectedLogId}
            onLogSelect={handleLogSelect}
          />
        </div>
      </ResizablePanel>

      {/* Side panel for log details */}
      {selectedLogId && (
        <>
          <ResizableHandle id="logs-handle" />
          <ResizablePanel id="log-detail" min="300px" default="430px" max="600px" isStaticAtRest>
            <LogDetailView
              logId={selectedLogId}
              initialLog={selectedLog}
              onClose={handleClosePanel}
            />
          </ResizablePanel>
        </>
      )}
    </ResizablePanelGroup>
  );
}
