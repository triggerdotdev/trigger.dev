import {
  ArrowDownTrayIcon,
  BookmarkIcon,
  CalendarIcon,
  ClipboardIcon,
  PencilIcon,
  PencilSquareIcon,
} from "@heroicons/react/20/solid";
import type { OutputColumnMetadata } from "@internal/clickhouse";
import { DialogClose } from "@radix-ui/react-dialog";
import { useFetcher } from "@remix-run/react";
import { IconChartHistogram } from "@tabler/icons-react";
import { formatDurationNanoseconds } from "@trigger.dev/core/v3";
import { Clipboard } from "lucide-react";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { flushSync } from "react-dom";
import { useTypedFetcher } from "remix-typedjson";
import simplur from "simplur";
import { AISparkleIcon } from "~/assets/icons/AISparkleIcon";
import { ChartConfigPanel, defaultChartConfig } from "~/components/code/ChartConfigPanel";
import { autoFormatSQL, TSQLEditor } from "~/components/code/TSQLEditor";
import { EnvironmentLabel } from "~/components/environments/EnvironmentLabel";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import {
  QueryWidget,
  type BigNumberConfiguration,
  type ChartConfiguration,
  type QueryWidgetConfig,
  type QueryWidgetData,
} from "~/components/metrics/QueryWidget";
import { SaveToDashboardDialog } from "~/components/metrics/SaveToDashboardDialog";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Callout } from "~/components/primitives/Callout";
import {
  ClientTabs,
  ClientTabsContent,
  ClientTabsList,
  ClientTabsTrigger,
} from "~/components/primitives/ClientTabs";
import { Dialog, DialogContent, DialogFooter, DialogHeader } from "~/components/primitives/Dialog";
import { Header3 } from "~/components/primitives/Headers";
import { Input } from "~/components/primitives/Input";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Label } from "~/components/primitives/Label";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
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
import { TimeFilter } from "~/components/runs/v3/SharedFilters";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import type { QueryHistoryItem } from "~/presenters/v3/QueryPresenter.server";
import { QueryHelpSidebar } from "~/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.query/QueryHelpSidebar";
import { QueryHistoryPopover } from "~/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.query/QueryHistoryPopover";
import type { AITimeFilter } from "~/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.query/types";
import type { action as titleAction } from "~/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.query.ai-title";
import type { QueryScope } from "~/services/queryService.server";
import { downloadFile, rowsToCSV, rowsToJSON } from "~/utils/dataExport";
import { organizationBillingPath } from "~/utils/pathBuilder";
import { querySchemas } from "~/v3/querySchemas";

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

// Type for the query action response
type QueryActionResponse = {
  error: string | null;
  rows: Record<string, unknown>[] | null;
  columns: OutputColumnMetadata[] | null;
  stats: { elapsed_ns: string } | null;
  hiddenColumns: string[] | null;
  reachedMaxRows: boolean | null;
  explainOutput: string | null;
  generatedSql: string | null;
  queryId?: string | null;
  periodClipped: number | null;
  maxQueryPeriod?: number;
};

export type QueryEditorMode =
  | { type: "standalone" }
  | { type: "dashboard-add"; dashboardId: string; dashboardName: string }
  | {
      type: "dashboard-edit";
      dashboardId: string;
      dashboardName: string;
      widgetId: string;
      widgetName: string;
    };

/** Data passed to the save render prop */
export type QueryEditorSaveData = {
  title: string;
  query: string;
  config: QueryWidgetConfig;
};

export type QueryEditorProps = {
  // Default values - used to initialize state
  defaultQuery: string;
  defaultScope: QueryScope;
  defaultPeriod: string;
  defaultTimeFilter?: { period?: string; from?: string; to?: string };
  defaultResultsView?: "table" | "graph" | "bignumber";
  defaultChartConfig?: ChartConfiguration;
  defaultBigNumberConfig?: BigNumberConfiguration;
  /** Initial result data to display (e.g., when editing an existing widget) */
  defaultData?: QueryWidgetData;

  // Other required data
  history: QueryHistoryItem[];
  isAdmin: boolean;
  maxRows: number;

  // The URL to post query execution requests to
  queryActionUrl: string;

  // Mode determines NavBar and save behavior
  mode: QueryEditorMode;

  // Max period days (from plan)
  maxPeriodDays?: number;

  // Render prop for save functionality - receives current data, returns ReactNode
  save?: (data: QueryEditorSaveData) => ReactNode;
  onClose?: () => void;
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
    fetcher: ReturnType<typeof useTypedFetcher<QueryActionResponse>>;
    isAdmin: boolean;
    queryActionUrl: string;
    maxPeriodDays?: number;
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
    queryActionUrl,
    maxPeriodDays,
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
        action={queryActionUrl}
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
            variant="secondary/small"
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
              asChild
              button={
                <span>
                  <Button
                    variant="secondary/small"
                    disabled={true}
                    type="button"
                    LeadingIcon={CalendarIcon}
                    leadingIconClassName="text-text-dimmed/70"
                  >
                    Set in query
                  </Button>
                </span>
              }
              className="max-w-48"
              content="Your query includes a WHERE clause with triggered_at so this filter is disabled."
            />
          ) : (
            <TimeFilter
              defaultPeriod={defaultPeriod}
              labelName="Triggered"
              hideLabel
              valueClassName="text-text-bright"
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

export function QueryEditor({
  defaultQuery,
  defaultScope,
  defaultPeriod,
  defaultTimeFilter,
  defaultResultsView = "table",
  defaultChartConfig: initialChartConfig,
  defaultBigNumberConfig: initialBigNumberConfig,
  defaultData,
  history,
  isAdmin,
  maxRows,
  queryActionUrl,
  mode,
  maxPeriodDays,
  save,
  onClose,
}: QueryEditorProps) {
  const fetcher = useTypedFetcher<QueryActionResponse>();

  // Use defaultData as initial results, then switch to fetcher data once a query is run
  const fetcherResults = fetcher.data;
  const results =
    fetcherResults ??
    (defaultData
      ? {
          error: null,
          rows: defaultData.rows,
          columns: defaultData.columns,
          stats: null,
          hiddenColumns: null,
          reachedMaxRows: false,
          explainOutput: null,
          generatedSql: null,
          queryId: null,
          periodClipped: null,
        }
      : null);

  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();

  const editorRef = useRef<QueryEditorFormHandle>(null);
  const [prettyFormatting, setPrettyFormatting] = useState(true);
  const [resultsView, setResultsView] = useState<"table" | "graph" | "bignumber">(
    defaultResultsView
  );
  const [chartConfig, setChartConfig] = useState<ChartConfiguration>(
    initialChartConfig ?? defaultChartConfig
  );
  const [bigNumberConfig, setBigNumberConfig] = useState<BigNumberConfiguration>(
    initialBigNumberConfig ?? { column: "", aggregation: "sum", abbreviate: true }
  );
  const [sidebarTab, setSidebarTab] = useState<string>("ai");
  const [aiFixRequest, setAiFixRequest] = useState<{ prompt: string; key: number } | null>(null);

  // Save to dashboard dialog state (only for standalone mode)
  const [isSaveDialogOpen, setIsSaveDialogOpen] = useState(false);

  // Title generation state
  const titleFetcher = useFetcher<typeof titleAction>();
  const isTitleLoading = titleFetcher.state !== "idle";
  const generatedTitle = titleFetcher.data?.title;
  const [historyTitle, setHistoryTitle] = useState<string | null>(
    history.length > 0 ? history[0].title ?? null : null
  );

  // For edit mode, use the widget name as initial title
  const initialTitle = mode.type === "dashboard-edit" ? mode.widgetName : null;
  const [editModeTitle, setEditModeTitle] = useState<string | null>(initialTitle);

  // User-set title (takes priority, and disables AI regeneration)
  const [userTitle, setUserTitle] = useState<string | null>(null);

  // Effective title: user title > edit mode title > history title > generated title
  const queryTitle =
    userTitle ??
    (mode.type === "dashboard-edit"
      ? editModeTitle ?? historyTitle ?? generatedTitle ?? null
      : historyTitle ?? generatedTitle ?? null);

  // Track if user has manually set a title (disables AI regeneration)
  const hasUserTitle = userTitle !== null;

  // Track whether we should generate a title for the current results
  const [shouldGenerateTitle, setShouldGenerateTitle] = useState(false);

  // Trigger title generation when query succeeds (only for new queries, not history, not if user set title)
  useEffect(() => {
    if (
      results?.rows &&
      !results.error &&
      results.queryId &&
      shouldGenerateTitle &&
      !historyTitle &&
      !hasUserTitle &&
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
    hasUserTitle,
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
  const handleTimeFilterChange = useCallback((filter: AITimeFilter) => {
    editorRef.current?.setTimeFilter({
      period: filter.period,
      from: filter.from,
      to: filter.to,
    });
  }, []);

  const isLoading = fetcher.state === "submitting" || fetcher.state === "loading";

  // Create a stable key from columns to detect schema changes
  const columnsKey = results?.columns
    ? results.columns.map((c) => `${c.name}:${c.type}`).join(",")
    : "";

  // Reset chart config only when column schema actually changes
  // This allows re-running queries with different WHERE clauses without losing config
  useEffect(() => {
    if (columnsKey && !initialChartConfig) {
      setChartConfig(defaultChartConfig);
    }
  }, [columnsKey, initialChartConfig]);

  const handleChartConfigChange = useCallback((config: ChartConfiguration) => {
    setChartConfig(config);
  }, []);

  // Handle query submission - prepare for title generation
  const handleQuerySubmit = useCallback(() => {
    setHistoryTitle(null); // Clear history title when running a new query
    setEditModeTitle(null); // Clear edit mode title when running a new query
    // Only enable title generation if user hasn't manually set a title
    // userTitle persists across query edits once set
    setShouldGenerateTitle(!hasUserTitle);
  }, [hasUserTitle]);

  // Handle history selection - use existing title if available
  const handleHistorySelected = useCallback((item: QueryHistoryItem) => {
    setHistoryTitle(item.title ?? null);
    setEditModeTitle(null);
    setUserTitle(null); // Clear user title when selecting from history
    setShouldGenerateTitle(false); // Don't generate title for history items
  }, []);

  // Handle user renaming the title
  const handleRenameTitle = useCallback((newTitle: string) => {
    setUserTitle(newTitle);
    // Clear other title sources since user has explicitly set the title
    setHistoryTitle(null);
    setEditModeTitle(null);
  }, []);

  // Compute current save data for the save render prop
  const currentQuery = editorRef.current?.getQuery() ?? "";
  const saveData: QueryEditorSaveData = {
    title: queryTitle ?? "Untitled Query",
    query: currentQuery,
    config:
      resultsView === "table"
        ? { type: "table", prettyFormatting, sorting: [] }
        : resultsView === "bignumber"
        ? { type: "bignumber", ...bigNumberConfig }
        : { type: "chart", ...chartConfig },
  };

  // Render NavBar based on mode
  const renderNavBar = () => {
    switch (mode.type) {
      case "standalone":
        return (
          <NavBar>
            <PageTitle title="Query" />
          </NavBar>
        );
      case "dashboard-add":
        return (
          <NavBar>
            <PageTitle title={`Add chart to ${mode.dashboardName}`} />
            <PageAccessories>
              <Button
                variant="secondary/small"
                onClick={onClose}
                shortcut={{ key: "esc" }}
                shortcutPosition="before-trailing-icon"
                // className="pl-1"
              >
                Cancel
              </Button>
            </PageAccessories>
          </NavBar>
        );
      case "dashboard-edit":
        return (
          <NavBar>
            <PageTitle title={`Editing "${mode.widgetName}"`} />
            <PageAccessories>
              <Button
                variant="secondary/small"
                onClick={onClose}
                shortcut={{ key: "esc" }}
                shortcutPosition="before-trailing-icon"
                // className="pl-1"
              >
                Cancel
              </Button>
            </PageAccessories>
          </NavBar>
        );
    }
  };

  return (
    <PageContainer>
      {renderNavBar()}
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
                  defaultQuery={defaultQuery}
                  defaultScope={defaultScope}
                  defaultTimeFilter={defaultTimeFilter}
                  history={history}
                  fetcher={fetcher}
                  isAdmin={isAdmin}
                  queryActionUrl={queryActionUrl}
                  maxPeriodDays={maxPeriodDays}
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
                  onValueChange={(v) => setResultsView(v as "table" | "graph" | "bignumber")}
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
                    <ClientTabsTrigger
                      value="bignumber"
                      variant="underline"
                      layoutId="results-tabs"
                      disabled={!results?.rows || results.rows.length === 0}
                    >
                      Big number
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
                              variant="tertiary/small"
                              label="Pretty formatting"
                              checked={prettyFormatting}
                              onCheckedChange={setPrettyFormatting}
                            />
                          )}
                        </div>
                      </div>
                    ) : null}
                  </ClientTabsList>
                  <ClientTabsContent value="table" className="m-0 min-h-0 overflow-y-hidden">
                    {isLoading ? (
                      <div className="flex items-center gap-2 p-4 text-sm text-text-dimmed">
                        <Spinner className="size-4" />
                        <span>Executing query…</span>
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
                          <QueryWidget
                            title={
                              <QueryTitle
                                isTitleLoading={isTitleLoading}
                                title={queryTitle}
                                onRename={handleRenameTitle}
                              />
                            }
                            data={{
                              rows: results.rows,
                              columns: results.columns,
                            }}
                            config={{
                              type: "table",
                              prettyFormatting,
                              sorting: [],
                            }}
                            accessory={
                              mode.type === "standalone" ? (
                                <Button
                                  variant="primary/small"
                                  onClick={() => setIsSaveDialogOpen(true)}
                                >
                                  Add to dashboard
                                </Button>
                              ) : save ? (
                                save(saveData)
                              ) : undefined
                            }
                          />
                        </div>
                      </div>
                    ) : (
                      <div className="flex h-full flex-col items-center justify-center gap-3">
                        <IconChartHistogram className="size-16 text-charcoal-650" />
                        <Paragraph className="max-w-48 text-center text-text-dimmed">
                          Run a query to visualize the results.
                        </Paragraph>
                      </div>
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
                          onRenameTitle={handleRenameTitle}
                          accessory={
                            mode.type === "standalone" ? (
                              <Button
                                variant="primary/small"
                                onClick={() => setIsSaveDialogOpen(true)}
                              >
                                Add to dashboard
                              </Button>
                            ) : save ? (
                              save(saveData)
                            ) : undefined
                          }
                        />
                      </>
                    ) : (
                      <div className="flex h-full flex-col items-center justify-center gap-3">
                        <IconChartHistogram className="size-16 text-charcoal-650" />
                        <Paragraph className="max-w-48 text-center text-text-dimmed">
                          Run a query to visualize the results.
                        </Paragraph>
                      </div>
                    )}
                  </ClientTabsContent>
                  <ClientTabsContent
                    value="bignumber"
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
                        <ResultsBigNumber
                          rows={results.rows}
                          columns={results.columns}
                          bigNumberConfig={bigNumberConfig}
                          onBigNumberConfigChange={setBigNumberConfig}
                          queryTitle={queryTitle}
                          isTitleLoading={isTitleLoading}
                          onRenameTitle={handleRenameTitle}
                          accessory={
                            mode.type === "standalone" ? (
                              <Button
                                variant="primary/small"
                                onClick={() => setIsSaveDialogOpen(true)}
                              >
                                Add to dashboard
                              </Button>
                            ) : save ? (
                              save(saveData)
                            ) : undefined
                          }
                        />
                      </>
                    ) : (
                      <div className="flex h-full flex-col items-center justify-center gap-3">
                        <IconChartHistogram className="size-16 text-charcoal-650" />
                        <Paragraph className="max-w-48 text-center text-text-dimmed">
                          Run a query to visualize the results.
                        </Paragraph>
                      </div>
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
      {mode.type === "standalone" && (
        <SaveToDashboardDialog
          title={queryTitle ?? "Untitled Query"}
          query={editorRef.current?.getQuery() ?? ""}
          config={
            resultsView === "table"
              ? { type: "table", prettyFormatting, sorting: [] }
              : resultsView === "bignumber"
              ? { type: "bignumber", ...bigNumberConfig }
              : { type: "chart", ...chartConfig }
          }
          isOpen={isSaveDialogOpen}
          onOpenChange={setIsSaveDialogOpen}
        />
      )}
    </PageContainer>
  );
}

function QueryTitle({
  isTitleLoading,
  title,
  onRename,
}: {
  isTitleLoading: boolean;
  title: string | null;
  onRename?: (newTitle: string) => void;
}) {
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [renameValue, setRenameValue] = useState(title ?? "");

  // Update rename value when title changes
  useEffect(() => {
    setRenameValue(title ?? "");
  }, [title]);

  if (isTitleLoading)
    return (
      <span className="flex items-center gap-2 text-text-dimmed">
        <Spinner className="size-3" /> Generating title…
      </span>
    );

  return (
    <>
      <span className="group flex items-center gap-1">
        {title ?? "Results"}
        {onRename && title && (
          <Button
            variant="minimal/small"
            LeadingIcon={PencilSquareIcon}
            leadingIconClassName="text-text-dimmed group-hover/button:text-text-bright"
            className="opacity-0 transition-opacity group-hover:opacity-100"
            onClick={() => {
              setRenameValue(title);
              setIsDialogOpen(true);
            }}
          />
        )}
      </span>
      {onRename && (
        <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>Rename chart</DialogHeader>
            <form
              className="space-y-4 pt-3"
              onSubmit={(e) => {
                e.preventDefault();
                if (renameValue.trim()) {
                  onRename(renameValue.trim());
                  setIsDialogOpen(false);
                }
              }}
            >
              <InputGroup>
                <Label>Title</Label>
                <Input
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  placeholder="Chart title"
                  autoFocus
                />
              </InputGroup>
              <DialogFooter>
                <DialogClose asChild>
                  <Button variant="secondary/medium">Cancel</Button>
                </DialogClose>
                <Button type="submit" variant="primary/medium" disabled={!renameValue.trim()}>
                  Save
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      )}
    </>
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
      <PopoverArrowTrigger variant="minimal" isOpen={isOpen}>
        Export
      </PopoverArrowTrigger>
      <PopoverContent className="min-w-[10rem] p-1" align="end">
        <div className="flex flex-col gap-1">
          <PopoverMenuItem
            icon={Clipboard}
            title="Copy CSV"
            onClick={handleCopyCSV}
            className="pl-1"
          />
          <PopoverMenuItem icon={ArrowDownTrayIcon} title="Export CSV" onClick={handleExportCSV} />
          <PopoverMenuItem
            icon={Clipboard}
            title="Copy JSON"
            onClick={handleCopyJSON}
            className="pl-1"
          />
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
      return <span className="text-text-bright">{`Org: ${organization.title}`}</span>;
    case "project":
      return <span className="text-text-bright">{`Project: ${project.name}`}</span>;
    case "environment":
      return (
        <span className="text-text-bright">
          Env: <EnvironmentLabel environment={environment} />
        </span>
      );
    default:
      return <span className="text-text-bright">{scope}</span>;
  }
}

function QueryResultsCallouts({
  hiddenColumns,
  periodClipped,
  organizationSlug,
}: {
  hiddenColumns: string[] | null | undefined;
  periodClipped: number | null;
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
  periodClipped: number | null
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
  onRenameTitle,
  accessory,
}: {
  rows: Record<string, unknown>[];
  columns: OutputColumnMetadata[];
  chartConfig: ChartConfiguration;
  onChartConfigChange: (config: ChartConfiguration) => void;
  queryTitle: string | null;
  isTitleLoading: boolean;
  onRenameTitle?: (newTitle: string) => void;
  accessory?: ReactNode;
}) {
  return (
    <>
      <ResizablePanelGroup className="overflow-hidden">
        <ResizablePanel id="chart-results">
          <div className="h-full overflow-hidden bg-charcoal-900 p-2">
            <QueryWidget
              title={
                <QueryTitle
                  isTitleLoading={isTitleLoading}
                  title={queryTitle}
                  onRename={onRenameTitle}
                />
              }
              data={{
                rows,
                columns,
              }}
              config={{
                type: "chart",
                ...chartConfig,
              }}
              accessory={accessory}
            />
          </div>
        </ResizablePanel>
        <ResizableHandle id="chart-split" />
        <ResizablePanel id="chart-config" min="50px" default="200px">
          <ChartConfigPanel columns={columns} config={chartConfig} onChange={onChartConfigChange} />
        </ResizablePanel>
      </ResizablePanelGroup>
    </>
  );
}

function isNumericColumnType(type: string): boolean {
  return (
    type.startsWith("Int") ||
    type.startsWith("UInt") ||
    type.startsWith("Float") ||
    type.startsWith("Decimal") ||
    type.startsWith("Nullable(Int") ||
    type.startsWith("Nullable(UInt") ||
    type.startsWith("Nullable(Float") ||
    type.startsWith("Nullable(Decimal")
  );
}

function ResultsBigNumber({
  rows,
  columns,
  bigNumberConfig,
  onBigNumberConfigChange,
  queryTitle,
  isTitleLoading,
  onRenameTitle,
  accessory,
}: {
  rows: Record<string, unknown>[];
  columns: OutputColumnMetadata[];
  bigNumberConfig: BigNumberConfiguration;
  onBigNumberConfigChange: (config: BigNumberConfiguration) => void;
  queryTitle: string | null;
  isTitleLoading: boolean;
  onRenameTitle?: (newTitle: string) => void;
  accessory?: ReactNode;
}) {
  // Auto-select first numeric column if none selected
  const numericColumns = columns.filter((c) => isNumericColumnType(c.type));

  useEffect(() => {
    if (!bigNumberConfig.column && numericColumns.length > 0) {
      onBigNumberConfigChange({ ...bigNumberConfig, column: numericColumns[0].name });
    }
  }, [columns]);

  return (
    <>
      <ResizablePanelGroup className="overflow-hidden">
        <ResizablePanel id="bignumber-results">
          <div className="h-full overflow-hidden bg-charcoal-900 p-2">
            <QueryWidget
              title={
                <QueryTitle
                  isTitleLoading={isTitleLoading}
                  title={queryTitle}
                  onRename={onRenameTitle}
                />
              }
              data={{
                rows,
                columns,
              }}
              config={{
                type: "bignumber",
                ...bigNumberConfig,
              }}
              accessory={accessory}
            />
          </div>
        </ResizablePanel>
        <ResizableHandle id="bignumber-split" />
        <ResizablePanel id="bignumber-config" min="50px" default="200px">
          <BigNumberConfigPanel
            columns={columns}
            config={bigNumberConfig}
            onChange={onBigNumberConfigChange}
          />
        </ResizablePanel>
      </ResizablePanelGroup>
    </>
  );
}

const bigNumberAggregationOptions = [
  { value: "sum", label: "Sum" },
  { value: "avg", label: "Average" },
  { value: "count", label: "Count" },
  { value: "min", label: "Min" },
  { value: "max", label: "Max" },
  { value: "first", label: "First" },
  { value: "last", label: "Last" },
] as const;

const bigNumberSortOptions = [
  { value: "", label: "Unsorted" },
  { value: "asc", label: "Ascending" },
  { value: "desc", label: "Descending" },
] as const;

function BigNumberConfigPanel({
  columns,
  config,
  onChange,
}: {
  columns: OutputColumnMetadata[];
  config: BigNumberConfiguration;
  onChange: (config: BigNumberConfiguration) => void;
}) {
  const numericColumns = columns.filter((c) => isNumericColumnType(c.type));
  const allColumns = columns;

  // For count aggregation, any column works; for others, prefer numeric
  const availableColumns = config.aggregation === "count" ? allColumns : numericColumns;

  return (
    <div className="flex h-full flex-col gap-2 overflow-y-auto p-2">
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <Paragraph variant="extra-small" className="text-text-dimmed">
            Column
          </Paragraph>
          <Select
            value={config.column || ""}
            setValue={(value) => onChange({ ...config, column: value })}
            variant="tertiary/small"
            dropdownIcon={true}
            items={availableColumns.map((c) => ({ value: c.name, label: c.name }))}
            text={(value) => value || "Select column"}
            placeholder="Select column"
          >
            {(items) =>
              items.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))
            }
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <Paragraph variant="extra-small" className="text-text-dimmed">
            Sort order
          </Paragraph>
          <Select
            value={config.sortDirection ?? ""}
            setValue={(value) =>
              onChange({
                ...config,
                sortDirection: value === "" ? undefined : (value as "asc" | "desc"),
              })
            }
            variant="tertiary/small"
            dropdownIcon={true}
            items={[...bigNumberSortOptions]}
            text={(value) =>
              bigNumberSortOptions.find((o) => o.value === value)?.label ?? "Unsorted"
            }
          >
            {(items) =>
              items.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))
            }
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <Paragraph variant="extra-small" className="text-text-dimmed">
            Aggregation
          </Paragraph>
          <Select
            value={config.aggregation}
            setValue={(value) =>
              onChange({ ...config, aggregation: value as BigNumberConfiguration["aggregation"] })
            }
            variant="tertiary/small"
            dropdownIcon={true}
            items={[...bigNumberAggregationOptions]}
            text={(value) =>
              bigNumberAggregationOptions.find((o) => o.value === value)?.label ?? value
            }
          >
            {(items) =>
              items.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))
            }
          </Select>
        </div>
        <div className="flex items-center justify-between">
          <Switch
            label="Abbreviate large values"
            labelPosition="right"
            variant="small"
            checked={config.abbreviate ?? false}
            onCheckedChange={(checked) => onChange({ ...config, abbreviate: checked })}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Paragraph variant="extra-small" className="text-text-dimmed">
            Prefix
          </Paragraph>
          <Input
            value={config.prefix ?? ""}
            onChange={(e) => onChange({ ...config, prefix: e.target.value || undefined })}
            placeholder="e.g. $"
            variant="small"
          />
        </div>
        <div className="flex flex-col gap-1">
          <Paragraph variant="extra-small" className="text-text-dimmed">
            Suffix
          </Paragraph>
          <Input
            value={config.suffix ?? ""}
            onChange={(e) => onChange({ ...config, suffix: e.target.value || undefined })}
            placeholder="e.g. ms"
            variant="small"
          />
        </div>
      </div>
    </div>
  );
}
