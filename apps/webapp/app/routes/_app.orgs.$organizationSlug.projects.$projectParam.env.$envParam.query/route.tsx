import {
  ArrowDownTrayIcon,
  ArrowsPointingOutIcon,
  ArrowTrendingUpIcon,
  ClipboardIcon,
  TableCellsIcon,
} from "@heroicons/react/20/solid";
import type { OutputColumnMetadata } from "@internal/clickhouse";
import { type WhereClauseCondition } from "@internal/tsql";
import { useFetcher } from "@remix-run/react";
import {
  redirect,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "@remix-run/server-runtime";
import parse from "parse-duration";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { typedjson, useTypedFetcher, useTypedLoaderData } from "remix-typedjson";
import simplur from "simplur";
import { z } from "zod";
import { AISparkleIcon } from "~/assets/icons/AISparkleIcon";
import { AlphaTitle } from "~/components/AlphaBadge";
import {
  ChartConfigPanel,
  defaultChartConfig,
  type ChartConfiguration,
} from "~/components/code/ChartConfigPanel";
import { QueryResultsChart } from "~/components/code/QueryResultsChart";
import { autoFormatSQL, TSQLEditor } from "~/components/code/TSQLEditor";
import { TSQLResultsTable } from "~/components/code/TSQLResultsTable";
import { EnvironmentLabel } from "~/components/environments/EnvironmentLabel";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Callout } from "~/components/primitives/Callout";
import { Card } from "~/components/primitives/charts/Card";
import {
  ClientTabs,
  ClientTabsContent,
  ClientTabsList,
  ClientTabsTrigger,
} from "~/components/primitives/ClientTabs";
import { Dialog, DialogContent, DialogHeader } from "~/components/primitives/Dialog";
import { Header3 } from "~/components/primitives/Headers";
import { NavBar, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import {
  Popover,
  PopoverArrowTrigger,
  PopoverContent,
  PopoverMenuItem,
} from "~/components/primitives/Popover";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "~/components/primitives/Resizable";
import { Select, SelectItem } from "~/components/primitives/Select";
import { Spinner } from "~/components/primitives/Spinner";
import { Switch } from "~/components/primitives/Switch";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import { TimeFilter, timeFilters } from "~/components/runs/v3/SharedFilters";
import { prisma } from "~/db.server";
import { env } from "~/env.server";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { useSearchParams } from "~/hooks/useSearchParam";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { QueryPresenter, type QueryHistoryItem } from "~/presenters/v3/QueryPresenter.server";
import type { action as titleAction } from "~/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.query.ai-title";
import { getLimit } from "~/services/platform.v3.server";
import { executeQuery, type QueryScope } from "~/services/queryService.server";
import { requireUser } from "~/services/session.server";
import { downloadFile, rowsToCSV, rowsToJSON } from "~/utils/dataExport";
import { EnvironmentParamSchema, organizationBillingPath } from "~/utils/pathBuilder";
import { canAccessQuery } from "~/v3/canAccessQuery.server";
import { querySchemas } from "~/v3/querySchemas";
import { useCurrentPlan } from "../_app.orgs.$organizationSlug/route";
import { QueryHelpSidebar } from "./QueryHelpSidebar";
import { QueryHistoryPopover } from "./QueryHistoryPopover";
import type { AITimeFilter } from "./types";
import { formatDurationNanoseconds } from "@trigger.dev/core/v3";

/** Convert a Date or ISO string to ISO string format */
function toISOString(value: Date | string): string {
  if (typeof value === "string") {
    return value;
  }
  return value.toISOString();
}

const scopeOptions = [
  { value: "environment", label: "Environment" },
  { value: "project", label: "Project" },
  { value: "organization", label: "Organization" },
] as const;

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const user = await requireUser(request);
  const { projectParam, organizationSlug, envParam } = EnvironmentParamSchema.parse(params);

  const canAccess = await canAccessQuery({
    userId: user.id,
    isAdmin: user.admin,
    isImpersonating: user.isImpersonating,
    organizationSlug,
  });
  if (!canAccess) {
    throw redirect("/");
  }

  const project = await findProjectBySlug(organizationSlug, projectParam, user.id);
  if (!project) {
    throw new Response(undefined, {
      status: 404,
      statusText: "Project not found",
    });
  }

  const environment = await findEnvironmentBySlug(project.id, envParam, user.id);
  if (!environment) {
    throw new Response(undefined, {
      status: 404,
      statusText: "Environment not found",
    });
  }

  const presenter = new QueryPresenter();
  const { defaultQuery, history } = await presenter.call({
    organizationId: project.organizationId,
  });

  // Admins and impersonating users can use EXPLAIN
  const isAdmin = user.admin || user.isImpersonating;

  return typedjson({
    defaultQuery,
    defaultPeriod: await getDefaultPeriod(project.organizationId),
    history,
    isAdmin,
    maxRows: env.QUERY_CLICKHOUSE_MAX_RETURNED_ROWS,
  });
};

async function getDefaultPeriod(organizationId: string): Promise<string> {
  const idealDefaultPeriodDays = 7;
  const maxQueryPeriod = await getLimit(organizationId, "queryPeriodDays", 30);
  if (maxQueryPeriod < idealDefaultPeriodDays) {
    return `${maxQueryPeriod}d`;
  }
  return `${idealDefaultPeriodDays}d`;
}

const ActionSchema = z.object({
  query: z.string().min(1, "Query is required"),
  scope: z.enum(["environment", "project", "organization"]),
  explain: z.enum(["true", "false"]).nullable().optional(),
  period: z.string().nullable().optional(),
  from: z.string().nullable().optional(),
  to: z.string().nullable().optional(),
});

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const user = await requireUser(request);
  const { projectParam, organizationSlug, envParam } = EnvironmentParamSchema.parse(params);

  const canAccess = await canAccessQuery({
    userId: user.id,
    isAdmin: user.admin,
    isImpersonating: user.isImpersonating,
    organizationSlug,
  });
  if (!canAccess) {
    return typedjson(
      {
        error: "Unauthorized",
        rows: null,
        columns: null,
        stats: null,
        hiddenColumns: null,
        reachedMaxRows: null,
        explainOutput: null,
        generatedSql: null,
        periodClipped: null,
      },
      { status: 403 }
    );
  }

  const project = await findProjectBySlug(organizationSlug, projectParam, user.id);
  if (!project) {
    return typedjson(
      {
        error: "Project not found",
        rows: null,
        columns: null,
        stats: null,
        hiddenColumns: null,
        reachedMaxRows: null,
        explainOutput: null,
        generatedSql: null,
        periodClipped: null,
      },
      { status: 404 }
    );
  }

  const environment = await findEnvironmentBySlug(project.id, envParam, user.id);
  if (!environment) {
    return typedjson(
      {
        error: "Environment not found",
        rows: null,
        columns: null,
        stats: null,
        hiddenColumns: null,
        reachedMaxRows: null,
        explainOutput: null,
        generatedSql: null,
        periodClipped: null,
      },
      { status: 404 }
    );
  }

  const formData = await request.formData();
  const parsed = ActionSchema.safeParse({
    query: formData.get("query"),
    scope: formData.get("scope"),
    explain: formData.get("explain"),
    period: formData.get("period"),
    from: formData.get("from"),
    to: formData.get("to"),
  });

  if (!parsed.success) {
    return typedjson(
      {
        error: parsed.error.errors.map((e) => e.message).join(", "),
        rows: null,
        columns: null,
        stats: null,
        hiddenColumns: null,
        reachedMaxRows: null,
        explainOutput: null,
        generatedSql: null,
        periodClipped: null,
      },
      { status: 400 }
    );
  }

  const { query, scope, explain: explainParam, period, from, to } = parsed.data;
  // Only allow explain for admins/impersonating users
  const isAdmin = user.admin || user.isImpersonating;
  const explain = explainParam === "true" && isAdmin;

  // Build time filter fallback for triggered_at column
  const defaultPeriod = await getDefaultPeriod(project.organizationId);
  const timeFilter = timeFilters({
    period: period ?? undefined,
    from: from ?? undefined,
    to: to ?? undefined,
    defaultPeriod,
  });

  // Calculate the effective "from" date the user is requesting (for period clipping check)
  // This is null only when the user specifies just a "to" date (rare case)
  let requestedFromDate: Date | null = null;
  if (timeFilter.from) {
    requestedFromDate = new Date(timeFilter.from);
  } else if (!timeFilter.to) {
    // Period specified (or default) - calculate from now
    const periodMs = parse(timeFilter.period ?? defaultPeriod) ?? 7 * 24 * 60 * 60 * 1000;
    requestedFromDate = new Date(Date.now() - periodMs);
  }

  // Build the fallback WHERE condition based on what the user specified
  let triggeredAtFallback: WhereClauseCondition;
  if (timeFilter.from && timeFilter.to) {
    triggeredAtFallback = { op: "between", low: timeFilter.from, high: timeFilter.to };
  } else if (timeFilter.from) {
    triggeredAtFallback = { op: "gte", value: timeFilter.from };
  } else if (timeFilter.to) {
    triggeredAtFallback = { op: "lte", value: timeFilter.to };
  } else {
    triggeredAtFallback = { op: "gte", value: requestedFromDate! };
  }

  const maxQueryPeriod = await getLimit(project.organizationId, "queryPeriodDays", 30);
  const maxQueryPeriodDate = new Date(Date.now() - maxQueryPeriod * 24 * 60 * 60 * 1000);

  // Check if the requested time period exceeds the plan limit
  const periodClipped = requestedFromDate !== null && requestedFromDate < maxQueryPeriodDate;

  // Force tenant isolation and time period limits
  const enforcedWhereClause = {
    organization_id: { op: "eq", value: project.organizationId },
    project_id:
      scope === "project" || scope === "environment" ? { op: "eq", value: project.id } : undefined,
    environment_id: scope === "environment" ? { op: "eq", value: environment.id } : undefined,
    triggered_at: { op: "gte", value: maxQueryPeriodDate },
  } satisfies Record<string, WhereClauseCondition | undefined>;

  try {
    const [error, result, queryId] = await executeQuery({
      name: "query-page",
      query,
      schema: z.record(z.any()),
      tableSchema: querySchemas,
      transformValues: true,
      scope,
      organizationId: project.organizationId,
      projectId: project.id,
      environmentId: environment.id,
      explain,
      enforcedWhereClause,
      whereClauseFallback: {
        triggered_at: triggeredAtFallback,
      },
      history: {
        source: "DASHBOARD",
        userId: user.id,
        skip: user.isImpersonating,
        timeFilter: {
          // Save the effective period used for the query (timeFilters() handles defaults)
          // Only save period if no custom from/to range was specified
          period: timeFilter.from || timeFilter.to ? undefined : timeFilter.period,
          from: timeFilter.from,
          to: timeFilter.to,
        },
      },
    });

    if (error) {
      return typedjson(
        {
          error: error.message,
          rows: null,
          columns: null,
          stats: null,
          hiddenColumns: null,
          reachedMaxRows: null,
          explainOutput: null,
          generatedSql: null,
          queryId: null,
          periodClipped: null,
        },
        { status: 400 }
      );
    }

    return typedjson({
      error: null,
      rows: result.rows,
      columns: result.columns,
      stats: result.stats,
      hiddenColumns: result.hiddenColumns ?? null,
      reachedMaxRows: result.reachedMaxRows,
      explainOutput: result.explainOutput ?? null,
      generatedSql: result.generatedSql ?? null,
      queryId,
      periodClipped: periodClipped ? maxQueryPeriod : null,
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Unknown error executing query";
    return typedjson(
      {
        error: errorMessage,
        rows: null,
        columns: null,
        stats: null,
        hiddenColumns: null,
        reachedMaxRows: null,
        explainOutput: null,
        generatedSql: null,
        queryId: null,
        periodClipped: null,
      },
      { status: 500 }
    );
  }
};

/** Handle for imperatively setting the query from outside */
interface QueryEditorFormHandle {
  setQuery: (query: string) => void;
  setScope: (scope: QueryScope) => void;
  getQuery: () => string;
  setTimeFilter: (filter: { period?: string; from?: string; to?: string }) => void;
}

/** Self-contained query editor with form - isolates query state from parent */
const QueryEditorForm = forwardRef<
  QueryEditorFormHandle,
  {
    defaultPeriod: string;
    defaultQuery: string;
    defaultScope: QueryScope;
    defaultTimeFilter?: { period?: string; from?: string; to?: string };
    history: QueryHistoryItem[];
    fetcher: ReturnType<typeof useTypedFetcher<typeof action>>;
    isAdmin: boolean;
    onQuerySubmit?: () => void;
    onHistorySelected?: (item: QueryHistoryItem) => void;
  }
>(function QueryEditorForm(
  {
    defaultPeriod,
    defaultQuery,
    defaultScope,
    defaultTimeFilter,
    history,
    fetcher,
    isAdmin,
    onQuerySubmit,
    onHistorySelected,
  },
  ref
) {
  const isLoading = fetcher.state === "submitting" || fetcher.state === "loading";
  const [query, setQuery] = useState(defaultQuery);
  const [scope, setScope] = useState<QueryScope>(defaultScope);
  const formRef = useRef<HTMLFormElement>(null);
  const prevFetcherState = useRef(fetcher.state);
  const plan = useCurrentPlan();
  const maxPeriodDays = plan?.v3Subscription?.plan?.limits?.queryPeriodDays?.number;

  // Notify parent when query is submitted (for title generation)
  useEffect(() => {
    if (prevFetcherState.current !== "submitting" && fetcher.state === "submitting") {
      onQuerySubmit?.();
    }
    prevFetcherState.current = fetcher.state;
  }, [fetcher.state, onQuerySubmit]);

  // Get time filter values - initialize from props (which may come from history)
  const [period, setPeriod] = useState<string | undefined>(defaultTimeFilter?.period);
  const [from, setFrom] = useState<string | undefined>(defaultTimeFilter?.from);
  const [to, setTo] = useState<string | undefined>(defaultTimeFilter?.to);

  // Check if the query contains triggered_at in a WHERE clause
  // This disables the time filter UI since the user is filtering in their query
  const queryHasTriggeredAt = /\bWHERE\b[\s\S]*\btriggered_at\b/i.test(query);

  // Expose methods to parent for external query setting (history, AI, examples)
  useImperativeHandle(
    ref,
    () => ({
      setQuery,
      setScope,
      getQuery: () => query,
      setTimeFilter: (filter: { period?: string; from?: string; to?: string }) => {
        setPeriod(filter.period);
        setFrom(filter.from);
        setTo(filter.to);
      },
    }),
    [query]
  );

  const handleHistorySelected = useCallback(
    (item: QueryHistoryItem) => {
      setQuery(item.query);
      setScope(item.scope);
      // Apply time filter from history item
      // Note: filterFrom/filterTo might be Date objects or ISO strings depending on serialization
      setPeriod(item.filterPeriod ?? undefined);
      setFrom(item.filterFrom ? toISOString(item.filterFrom) : undefined);
      setTo(item.filterTo ? toISOString(item.filterTo) : undefined);
      // Notify parent about history selection (for title)
      onHistorySelected?.(item);
    },
    [onHistorySelected]
  );

  return (
    <div className="flex h-full flex-col gap-2 bg-charcoal-900 pb-2">
      <TSQLEditor
        defaultValue={query}
        onChange={setQuery}
        schema={querySchemas}
        linterEnabled={true}
        showCopyButton={true}
        showClearButton={true}
        className="min-h-0 flex-1"
      />
      <fetcher.Form
        ref={formRef}
        method="post"
        className="flex items-center justify-between gap-2 px-2"
      >
        <input type="hidden" name="query" value={query} />
        <input type="hidden" name="scope" value={scope} />
        {/* Pass time filter values to action */}
        <input type="hidden" name="period" value={period ?? ""} />
        <input type="hidden" name="from" value={from ?? ""} />
        <input type="hidden" name="to" value={to ?? ""} />
        <QueryHistoryPopover history={history} onQuerySelected={handleHistorySelected} />
        <div className="flex items-center gap-1">
          {isAdmin && (
            <Button
              type="submit"
              name="explain"
              value="true"
              variant="minimal/small"
              disabled={isLoading || !query.trim()}
            >
              Explain
            </Button>
          )}
          <Select
            value={scope}
            setValue={(value) => setScope(value as QueryScope)}
            variant="tertiary/small"
            dropdownIcon={true}
            items={[...scopeOptions]}
            text={(value) => {
              return <ScopeItem scope={value as QueryScope} />;
            }}
          >
            {(items) =>
              items.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  <ScopeItem scope={item.value as QueryScope} />
                </SelectItem>
              ))
            }
          </Select>
          {queryHasTriggeredAt ? (
            <SimpleTooltip
              button={
                <Button variant="tertiary/small" disabled={true} type="button">
                  Set in query
                </Button>
              }
              content="Your query includes a WHERE clause with triggered_at so this filter is disabled."
            />
          ) : (
            <TimeFilter
              defaultPeriod={defaultPeriod}
              labelName="Triggered"
              hideLabel
              period={period}
              from={from}
              to={to}
              applyShortcut={{ key: "enter", enabledOnInputElements: true }}
              onValueChange={(values) => {
                flushSync(() => {
                  setPeriod(values.period);
                  setFrom(values.from);
                  setTo(values.to);
                });
                if (formRef.current) {
                  fetcher.submit(formRef.current);
                }
              }}
              maxPeriodDays={maxPeriodDays}
            />
          )}
          <Button
            type="submit"
            variant="primary/small"
            disabled={isLoading || !query.trim()}
            shortcut={{ modifiers: ["mod"], key: "enter", enabledOnInputElements: true }}
            LeadingIcon={isLoading ? <Spinner className="size-4" color="white" /> : undefined}
          >
            {isLoading ? "Querying..." : "Query"}
          </Button>
        </div>
      </fetcher.Form>
    </div>
  );
});

export default function Page() {
  const { defaultPeriod, defaultQuery, history, isAdmin, maxRows } =
    useTypedLoaderData<typeof loader>();
  const fetcher = useTypedFetcher<typeof action>();
  const results = fetcher.data;
  const { replace: replaceSearchParams } = useSearchParams();

  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();

  // Use most recent history item if available, otherwise fall back to defaults
  const initialQuery = history.length > 0 ? history[0].query : defaultQuery;
  const initialScope: QueryScope = history.length > 0 ? history[0].scope : "environment";
  const initialTimeFilter =
    history.length > 0
      ? {
          period: history[0].filterPeriod ?? undefined,
          // Note: filterFrom/filterTo might be Date objects or ISO strings depending on serialization
          from: history[0].filterFrom ? toISOString(history[0].filterFrom) : undefined,
          to: history[0].filterTo ? toISOString(history[0].filterTo) : undefined,
        }
      : undefined;

  const editorRef = useRef<QueryEditorFormHandle>(null);
  const [prettyFormatting, setPrettyFormatting] = useState(true);
  const [resultsView, setResultsView] = useState<"table" | "graph">("table");
  const [chartConfig, setChartConfig] = useState<ChartConfiguration>(defaultChartConfig);
  const [sidebarTab, setSidebarTab] = useState<string>("ai");
  const [aiFixRequest, setAiFixRequest] = useState<{ prompt: string; key: number } | null>(null);

  // Title generation state
  const titleFetcher = useFetcher<typeof titleAction>();
  const isTitleLoading = titleFetcher.state !== "idle";
  const generatedTitle = titleFetcher.data?.title;
  const [historyTitle, setHistoryTitle] = useState<string | null>(
    history.length > 0 ? history[0].title ?? null : null
  );

  // Effective title: history title takes precedence, then generated
  const queryTitle = historyTitle ?? generatedTitle ?? null;

  // Track whether we should generate a title for the current results
  const [shouldGenerateTitle, setShouldGenerateTitle] = useState(false);

  // Trigger title generation when query succeeds (only for new queries, not history)
  useEffect(() => {
    if (
      results?.rows &&
      !results.error &&
      results.queryId &&
      shouldGenerateTitle &&
      !historyTitle &&
      titleFetcher.state === "idle"
    ) {
      const currentQuery = editorRef.current?.getQuery();
      if (currentQuery) {
        titleFetcher.submit(
          { query: currentQuery, queryId: results.queryId },
          {
            method: "POST",
            action: `/resources/orgs/${organization.slug}/projects/${project.slug}/env/${environment.slug}/query/ai-title`,
            encType: "application/json",
          }
        );
        setShouldGenerateTitle(false);
      }
    }
  }, [
    results,
    shouldGenerateTitle,
    historyTitle,
    titleFetcher,
    organization.slug,
    project.slug,
    environment.slug,
  ]);

  const handleTryFixError = useCallback((errorMessage: string) => {
    setSidebarTab("ai");
    setAiFixRequest((prev) => ({
      prompt: `Fix this query error: ${errorMessage}`,
      key: (prev?.key ?? 0) + 1,
    }));
  }, []);

  // Handle time filter changes from AI
  const handleTimeFilterChange = useCallback(
    (filter: AITimeFilter) => {
      replaceSearchParams({
        period: filter.period,
        from: filter.from,
        to: filter.to,
        // Clear cursor/direction when time filter changes
        cursor: undefined,
        direction: undefined,
      });
    },
    [replaceSearchParams]
  );

  const isLoading = fetcher.state === "submitting" || fetcher.state === "loading";

  // Create a stable key from columns to detect schema changes
  const columnsKey = results?.columns
    ? results.columns.map((c) => `${c.name}:${c.type}`).join(",")
    : "";

  // Reset chart config only when column schema actually changes
  // This allows re-running queries with different WHERE clauses without losing config
  useEffect(() => {
    if (columnsKey) {
      setChartConfig(defaultChartConfig);
    }
  }, [columnsKey]);

  const handleChartConfigChange = useCallback((config: ChartConfiguration) => {
    setChartConfig(config);
  }, []);

  // Handle query submission - prepare for title generation
  const handleQuerySubmit = useCallback(() => {
    setHistoryTitle(null); // Clear history title when running a new query
    setShouldGenerateTitle(true); // Enable title generation for new results
  }, []);

  // Handle history selection - use existing title if available
  const handleHistorySelected = useCallback((item: QueryHistoryItem) => {
    setHistoryTitle(item.title ?? null);
    setShouldGenerateTitle(false); // Don't generate title for history items
  }, []);

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title={<AlphaTitle>Query</AlphaTitle>} />
      </NavBar>
      <PageBody scrollable={false}>
        <ResizablePanelGroup orientation="horizontal" className="h-full max-h-full bg-charcoal-800">
          <ResizablePanel id="query-main" className="h-full">
            <ResizablePanelGroup orientation="vertical" className="h-full overflow-hidden">
              {/* Query editor - isolated component to prevent re-renders */}
              <ResizablePanel
                id="query-editor"
                min="100px"
                default="300px"
                className="overflow-hidden"
              >
                <QueryEditorForm
                  ref={editorRef}
                  defaultPeriod={defaultPeriod}
                  defaultQuery={initialQuery}
                  defaultScope={initialScope}
                  defaultTimeFilter={initialTimeFilter}
                  history={history}
                  fetcher={fetcher}
                  isAdmin={isAdmin}
                  onQuerySubmit={handleQuerySubmit}
                  onHistorySelected={handleHistorySelected}
                />
              </ResizablePanel>
              <ResizableHandle id="query-editor-handle" />
              {/* Results */}
              <ResizablePanel
                id="query-results"
                min="200px"
                className="overflow-hidden bg-charcoal-800"
              >
                <ClientTabs
                  value={resultsView}
                  onValueChange={(v) => setResultsView(v as "table" | "graph")}
                  className="grid h-full max-h-full min-h-0 grid-rows-[auto_1fr] overflow-hidden"
                >
                  <ClientTabsList
                    variant="underline"
                    className="shrink-0 overflow-hidden pl-3 pr-1"
                  >
                    <ClientTabsTrigger value="table" variant="underline" layoutId="results-tabs">
                      Table
                    </ClientTabsTrigger>
                    <ClientTabsTrigger
                      value="graph"
                      variant="underline"
                      layoutId="results-tabs"
                      disabled={!results?.rows || results.rows.length === 0}
                    >
                      Graph
                    </ClientTabsTrigger>
                    {results?.rows ? (
                      <div className="flex flex-1 items-center justify-end gap-2 overflow-hidden border-b border-grid-dimmed pl-3">
                        <div className="flex items-center gap-2 overflow-hidden truncate">
                          {results.reachedMaxRows ? (
                            <SimpleTooltip
                              buttonClassName="text-warning text-xs"
                              button={`${results.rows.length.toLocaleString()} Results`}
                              content={`Results are limited to ${maxRows.toLocaleString()} rows maximum.`}
                            />
                          ) : (
                            <span className="text-xs text-text-dimmed">
                              {results.rows.length > 0
                                ? `${results.rows.length.toLocaleString()} Results`
                                : "Results"}
                            </span>
                          )}
                          {results?.stats && (
                            <span className="text-xs text-text-dimmed">
                              {formatDurationNanoseconds(parseInt(results.stats.elapsed_ns, 10))}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-1">
                          {results?.rows && results?.columns && results.rows.length > 0 && (
                            <ExportResultsButton rows={results.rows} columns={results.columns} />
                          )}
                          {resultsView === "table" && (
                            <Switch
                              variant="secondary/small"
                              label="Pretty formatting"
                              checked={prettyFormatting}
                              onCheckedChange={setPrettyFormatting}
                            />
                          )}
                        </div>
                      </div>
                    ) : null}
                  </ClientTabsList>
                  <ClientTabsContent value="table" className="min-h-0 overflow-y-hidden">
                    {isLoading ? (
                      <div className="flex items-center gap-2 p-4 text-sm text-text-dimmed">
                        <Spinner className="size-4" />
                        <span>Executing query...</span>
                      </div>
                    ) : results?.error ? (
                      <div className="p-4">
                        <pre className="whitespace-pre-wrap text-sm text-red-400">
                          {results.error}
                        </pre>
                        <Button
                          variant="tertiary/small"
                          className="mt-3"
                          LeadingIcon={AISparkleIcon}
                          onClick={() => handleTryFixError(results.error!)}
                        >
                          Try fix error
                        </Button>
                      </div>
                    ) : results?.explainOutput ? (
                      <div className="flex h-full flex-col gap-4 overflow-auto p-3">
                        {results.generatedSql && (
                          <div>
                            <Header3 className="mb-2">Generated ClickHouse SQL</Header3>
                            <div className="overflow-auto rounded border border-grid-dimmed bg-charcoal-900 p-3">
                              <pre className="whitespace-pre font-mono text-xs text-text-bright">
                                {results.generatedSql}
                              </pre>
                            </div>
                          </div>
                        )}
                        <div className="flex min-h-0 flex-1 flex-col">
                          <Header3 className="mb-2">Query Execution Plan</Header3>
                          <div className="min-h-0 flex-1 overflow-auto rounded border border-grid-dimmed bg-charcoal-900 p-3">
                            <pre className="whitespace-pre font-mono text-xs text-text-bright">
                              {results.explainOutput}
                            </pre>
                          </div>
                        </div>
                      </div>
                    ) : results?.rows && results?.columns ? (
                      <div
                        className={`grid h-full max-h-full overflow-hidden bg-charcoal-900 ${
                          hasQueryResultsCallouts(results.hiddenColumns, results.periodClipped)
                            ? "grid-rows-[auto_1fr]"
                            : "grid-rows-[1fr]"
                        }`}
                      >
                        <QueryResultsCallouts
                          hiddenColumns={results.hiddenColumns}
                          periodClipped={results.periodClipped}
                          organizationSlug={organization.slug}
                        />
                        <div className="overflow-hidden p-2">
                          <Card className="h-full overflow-hidden px-0 pb-0">
                            <Card.Header>
                              <div className="flex items-center gap-1.5">
                                <TableCellsIcon className="size-5 text-indigo-500" />
                                {isTitleLoading ? (
                                  <span className="flex items-center gap-2 text-text-dimmed">
                                    <Spinner className="size-3" /> Generating title...
                                  </span>
                                ) : (
                                  queryTitle ?? "Results"
                                )}
                              </div>
                            </Card.Header>
                            <Card.Content className="min-h-0 flex-1 overflow-hidden p-0">
                              <TSQLResultsTable
                                rows={results.rows}
                                columns={results.columns}
                                prettyFormatting={prettyFormatting}
                              />
                            </Card.Content>
                          </Card>
                        </div>
                      </div>
                    ) : (
                      <Paragraph variant="small" className="p-4 text-text-dimmed">
                        Run a query to see results here.
                      </Paragraph>
                    )}
                  </ClientTabsContent>
                  <ClientTabsContent
                    value="graph"
                    className={`m-0 grid h-full max-h-full min-h-0 overflow-hidden bg-charcoal-900 ${
                      results?.rows &&
                      results.rows.length > 0 &&
                      hasQueryResultsCallouts(results.hiddenColumns, results.periodClipped)
                        ? "grid-rows-[auto_1fr]"
                        : "grid-rows-[1fr]"
                    }`}
                  >
                    {results?.rows && results?.columns && results.rows.length > 0 ? (
                      <>
                        <QueryResultsCallouts
                          hiddenColumns={results.hiddenColumns}
                          periodClipped={results.periodClipped}
                          organizationSlug={organization.slug}
                        />
                        <ResultsChart
                          rows={results.rows}
                          columns={results.columns}
                          chartConfig={chartConfig}
                          onChartConfigChange={handleChartConfigChange}
                          queryTitle={queryTitle}
                          isTitleLoading={isTitleLoading}
                        />
                      </>
                    ) : (
                      <Paragraph variant="small" className="p-4 text-text-dimmed">
                        Run a query to visualize results.
                      </Paragraph>
                    )}
                  </ClientTabsContent>
                </ClientTabs>
              </ResizablePanel>
            </ResizablePanelGroup>
          </ResizablePanel>
          <ResizableHandle id="query-handle" />
          <ResizablePanel
            id="query-help"
            min="200px"
            collapsible
            collapsedSize="20px"
            default="400px"
            max="500px"
            className="w-full"
          >
            <QueryHelpSidebar
              onTryExample={(exampleQuery, exampleScope) => {
                editorRef.current?.setQuery(exampleQuery);
                editorRef.current?.setScope(exampleScope);
              }}
              onQueryGenerated={(query) => {
                const formatted = autoFormatSQL(query);
                editorRef.current?.setQuery(formatted);
              }}
              onTimeFilterChange={handleTimeFilterChange}
              getCurrentQuery={() => editorRef.current?.getQuery() ?? ""}
              activeTab={sidebarTab}
              onTabChange={setSidebarTab}
              aiFixRequest={aiFixRequest}
            />
          </ResizablePanel>
        </ResizablePanelGroup>
      </PageBody>
    </PageContainer>
  );
}

function ExportResultsButton({
  rows,
  columns,
}: {
  rows: Record<string, unknown>[];
  columns: OutputColumnMetadata[];
}) {
  const [isOpen, setIsOpen] = useState(false);

  const handleCopyCSV = () => {
    const csv = rowsToCSV(rows, columns);
    navigator.clipboard.writeText(csv);
    setIsOpen(false);
  };

  const handleExportCSV = () => {
    const csv = rowsToCSV(rows, columns);
    const timestamp = new Date().toISOString().slice(0, 19).replace(/[:-]/g, "");
    downloadFile(csv, `query-results-${timestamp}.csv`, "text/csv");
    setIsOpen(false);
  };

  const handleCopyJSON = () => {
    const json = rowsToJSON(rows);
    navigator.clipboard.writeText(json);
    setIsOpen(false);
  };

  const handleExportJSON = () => {
    const json = rowsToJSON(rows);
    const timestamp = new Date().toISOString().slice(0, 19).replace(/[:-]/g, "");
    downloadFile(json, `query-results-${timestamp}.json`, "application/json");
    setIsOpen(false);
  };

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverArrowTrigger variant="tertiary" isOpen={isOpen}>
        Export
      </PopoverArrowTrigger>
      <PopoverContent className="min-w-[10rem] p-1" align="end">
        <div className="flex flex-col gap-1">
          <PopoverMenuItem icon={ClipboardIcon} title="Copy CSV" onClick={handleCopyCSV} />
          <PopoverMenuItem icon={ArrowDownTrayIcon} title="Export CSV" onClick={handleExportCSV} />
          <PopoverMenuItem icon={ClipboardIcon} title="Copy JSON" onClick={handleCopyJSON} />
          <PopoverMenuItem
            icon={ArrowDownTrayIcon}
            title="Export JSON"
            onClick={handleExportJSON}
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}

function ScopeItem({ scope }: { scope: QueryScope }) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();

  switch (scope) {
    case "organization":
      return `Org: ${organization.title}`;
    case "project":
      return `Project: ${project.name}`;
    case "environment":
      return (
        <>
          Env: <EnvironmentLabel environment={environment} />
        </>
      );
    default:
      return scope;
  }
}

function QueryResultsCallouts({
  hiddenColumns,
  periodClipped,
  organizationSlug,
}: {
  hiddenColumns: string[] | null | undefined;
  periodClipped: number | null | undefined;
  organizationSlug: string;
}) {
  const hasCallouts = (hiddenColumns && hiddenColumns.length > 0) || periodClipped;

  if (!hasCallouts) {
    return null;
  }

  return (
    <div className="flex flex-col gap-2 px-2 pt-2">
      {hiddenColumns && hiddenColumns.length > 0 && (
        <Callout variant="warning" className="shrink-0 text-sm">
          <code>SELECT *</code> doesn't return all columns because it's slow. The following columns
          are not shown: <span className="font-mono text-xs">{hiddenColumns.join(", ")}</span>.
          Specify them explicitly to include them.
        </Callout>
      )}
      {periodClipped && (
        <Callout
          variant="pricing"
          cta={
            <LinkButton
              variant="primary/small"
              to={organizationBillingPath({ slug: organizationSlug })}
            >
              Upgrade
            </LinkButton>
          }
          className="items-center"
        >
          {simplur`Results are limited to the last ${periodClipped} day[|s] based on your plan.`}
        </Callout>
      )}
    </div>
  );
}

function hasQueryResultsCallouts(
  hiddenColumns: string[] | null | undefined,
  periodClipped: number | null | undefined
): boolean {
  return (hiddenColumns && hiddenColumns.length > 0) || !!periodClipped;
}

function ResultsChart({
  rows,
  columns,
  chartConfig,
  onChartConfigChange,
  queryTitle,
  isTitleLoading,
}: {
  rows: Record<string, unknown>[];
  columns: OutputColumnMetadata[];
  chartConfig: ChartConfiguration;
  onChartConfigChange: (config: ChartConfiguration) => void;
  queryTitle: string | null;
  isTitleLoading: boolean;
}) {
  const [isOpen, setIsOpen] = useState(false);

  const titleContent = isTitleLoading ? (
    <span className="flex items-center gap-2 text-text-dimmed">
      <Spinner className="size-3" /> Generating title...
    </span>
  ) : (
    queryTitle ?? "Chart"
  );

  return (
    <>
      <ResizablePanelGroup className="overflow-hidden">
        <ResizablePanel id="chart-results">
          <div className="h-full overflow-hidden bg-charcoal-900 p-2">
            <Card className="h-full">
              <Card.Header>
                <div className="flex items-center gap-1.5">
                  <ArrowTrendingUpIcon className="size-5 text-indigo-500" />
                  {titleContent}
                </div>
                <Card.Accessory>
                  <Button
                    variant="minimal/small"
                    LeadingIcon={ArrowsPointingOutIcon}
                    onClick={() => setIsOpen(true)}
                  />
                </Card.Accessory>
              </Card.Header>
              <Card.Content className="h-full min-h-0 flex-1">
                <QueryResultsChart
                  rows={rows}
                  columns={columns}
                  config={chartConfig}
                  onViewAllLegendItems={() => setIsOpen(true)}
                />
              </Card.Content>
            </Card>
          </div>
        </ResizablePanel>
        <ResizableHandle id="chart-split" />
        <ResizablePanel id="chart-config" min="50px" default="200px">
          <ChartConfigPanel columns={columns} config={chartConfig} onChange={onChartConfigChange} />
        </ResizablePanel>
      </ResizablePanelGroup>
      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogContent fullscreen>
          <DialogHeader>{queryTitle ?? "Chart"}</DialogHeader>
          <div className="h-full min-h-0 w-full flex-1 overflow-hidden pt-4">
            <QueryResultsChart
              rows={rows}
              columns={columns}
              config={chartConfig}
              fullLegend={true}
              legendScrollable={true}
            />
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
