import { ArrowDownTrayIcon, ClipboardIcon } from "@heroicons/react/20/solid";
import type { OutputColumnMetadata, WhereClauseFallback } from "@internal/clickhouse";
import { Form, useNavigation } from "@remix-run/react";
import {
  redirect,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "@remix-run/server-runtime";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { typedjson, useTypedActionData, useTypedLoaderData } from "remix-typedjson";
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
import { TimeFilter, timeFilters } from "~/components/runs/v3/SharedFilters";
import { useSearchParams } from "~/hooks/useSearchParam";
import { Button } from "~/components/primitives/Buttons";
import { Callout } from "~/components/primitives/Callout";
import { Card } from "~/components/primitives/charts/Card";
import {
  ClientTabs,
  ClientTabsContent,
  ClientTabsList,
  ClientTabsTrigger,
} from "~/components/primitives/ClientTabs";
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
import { prisma } from "~/db.server";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { QueryPresenter, type QueryHistoryItem } from "~/presenters/v3/QueryPresenter.server";
import { executeQuery, type QueryScope } from "~/services/queryService.server";
import { downloadFile, rowsToCSV, rowsToJSON } from "~/utils/dataExport";
import { EnvironmentParamSchema } from "~/utils/pathBuilder";
import { FEATURE_FLAG, validateFeatureFlagValue } from "~/v3/featureFlags.server";
import { querySchemas } from "~/v3/querySchemas";
import { QueryHelpSidebar } from "./QueryHelpSidebar";
import { QueryHistoryPopover } from "./QueryHistoryPopover";
import { formatQueryStats } from "./utils";
import { requireUser } from "~/services/session.server";
import parse from "parse-duration";

async function hasQueryAccess(
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
  const hasQueryAccessResult = validateFeatureFlagValue(
    FEATURE_FLAG.hasQueryAccess,
    flags.hasQueryAccess
  );

  return hasQueryAccessResult.success && hasQueryAccessResult.data === true;
}

const scopeOptions = [
  { value: "environment", label: "Environment" },
  { value: "project", label: "Project" },
  { value: "organization", label: "Organization" },
] as const;

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const user = await requireUser(request);
  const { projectParam, organizationSlug, envParam } = EnvironmentParamSchema.parse(params);

  const canAccess = await hasQueryAccess(
    user.id,
    user.admin,
    user.isImpersonating,
    organizationSlug
  );
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
    history,
    isAdmin,
  });
};

const DEFAULT_PERIOD = "7d";

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

  const canAccess = await hasQueryAccess(
    user.id,
    user.admin,
    user.isImpersonating,
    organizationSlug
  );
  if (!canAccess) {
    return typedjson(
      {
        error: "Unauthorized",
        rows: null,
        columns: null,
        stats: null,
        hiddenColumns: null,
        explainOutput: null,
        generatedSql: null,
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
        explainOutput: null,
        generatedSql: null,
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
        explainOutput: null,
        generatedSql: null,
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
        explainOutput: null,
        generatedSql: null,
      },
      { status: 400 }
    );
  }

  const { query, scope, explain: explainParam, period, from, to } = parsed.data;
  // Only allow explain for admins/impersonating users
  const isAdmin = user.admin || user.isImpersonating;
  const explain = explainParam === "true" && isAdmin;

  // Build time filter fallback for triggered_at column
  const timeFilter = timeFilters({
    period: period ?? undefined,
    from: from ?? undefined,
    to: to ?? undefined,
    defaultPeriod: DEFAULT_PERIOD,
  });

  let triggeredAtFallback: WhereClauseFallback;
  if (timeFilter.from && timeFilter.to) {
    // Both from and to specified - use BETWEEN
    triggeredAtFallback = { op: "between", low: timeFilter.from, high: timeFilter.to };
  } else if (timeFilter.from) {
    // Only from specified
    triggeredAtFallback = { op: "gte", value: timeFilter.from };
  } else if (timeFilter.to) {
    // Only to specified
    triggeredAtFallback = { op: "lte", value: timeFilter.to };
  } else {
    // Period specified (or default) - calculate from now
    const periodMs = parse(timeFilter.period ?? DEFAULT_PERIOD) ?? 7 * 24 * 60 * 60 * 1000;
    triggeredAtFallback = { op: "gte", value: new Date(Date.now() - periodMs) };
  }

  try {
    const [error, result] = await executeQuery({
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
      whereClauseFallback: {
        triggered_at: triggeredAtFallback,
      },
      history: {
        source: "DASHBOARD",
        userId: user.id,
        skip: user.isImpersonating,
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
          explainOutput: null,
          generatedSql: null,
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
      explainOutput: result.explainOutput ?? null,
      generatedSql: result.generatedSql ?? null,
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
        explainOutput: null,
        generatedSql: null,
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
}

/** Self-contained query editor with form - isolates query state from parent */
const QueryEditorForm = forwardRef<
  QueryEditorFormHandle,
  {
    defaultQuery: string;
    defaultScope: QueryScope;
    history: QueryHistoryItem[];
    isLoading: boolean;
    isAdmin: boolean;
  }
>(function QueryEditorForm({ defaultQuery, defaultScope, history, isLoading, isAdmin }, ref) {
  const [query, setQuery] = useState(defaultQuery);
  const [scope, setScope] = useState<QueryScope>(defaultScope);
  const { value: searchParamValue } = useSearchParams();

  // Get time filter values from URL search params
  const period = searchParamValue("period");
  const from = searchParamValue("from");
  const to = searchParamValue("to");

  // Expose methods to parent for external query setting (history, AI, examples)
  useImperativeHandle(
    ref,
    () => ({
      setQuery,
      setScope,
      getQuery: () => query,
    }),
    [query]
  );

  const handleHistorySelected = useCallback((item: QueryHistoryItem) => {
    setQuery(item.query);
    setScope(item.scope);
  }, []);

  return (
    <div className="flex flex-col gap-2 bg-charcoal-900 pb-2">
      <TSQLEditor
        defaultValue={query}
        onChange={setQuery}
        schema={querySchemas}
        linterEnabled={true}
        showCopyButton={true}
        showClearButton={true}
        minHeight="200px"
        className="min-h-[200px]"
      />
      <Form method="post" className="flex items-center justify-between gap-2 px-2">
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
          <TimeFilter defaultPeriod={DEFAULT_PERIOD} labelName="Triggered" applyShortcut={{ key: "enter", enabledOnInputElements: true }} />
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
      </Form>
    </div>
  );
});

export default function Page() {
  const { defaultQuery, history, isAdmin } = useTypedLoaderData<typeof loader>();
  const results = useTypedActionData<typeof action>();
  const navigation = useNavigation();

  // Use most recent history item if available, otherwise fall back to defaults
  const initialQuery = history.length > 0 ? history[0].query : defaultQuery;
  const initialScope: QueryScope = history.length > 0 ? history[0].scope : "environment";

  const editorRef = useRef<QueryEditorFormHandle>(null);
  const [prettyFormatting, setPrettyFormatting] = useState(true);
  const [resultsView, setResultsView] = useState<"table" | "graph">("table");
  const [chartConfig, setChartConfig] = useState<ChartConfiguration>(defaultChartConfig);
  const [sidebarTab, setSidebarTab] = useState<string>("ai");
  const [aiFixRequest, setAiFixRequest] = useState<{ prompt: string; key: number } | null>(null);

  const handleTryFixError = useCallback((errorMessage: string) => {
    setSidebarTab("ai");
    setAiFixRequest((prev) => ({
      prompt: `Fix this query error: ${errorMessage}`,
      key: (prev?.key ?? 0) + 1,
    }));
  }, []);

  const isLoading = (navigation.state === "submitting" || navigation.state === "loading") && navigation.formMethod === "POST";


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

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title={<AlphaTitle>Query</AlphaTitle>} />
      </NavBar>
      <PageBody scrollable={false}>
        <ResizablePanelGroup orientation="horizontal" className="h-full max-h-full bg-charcoal-800">
          <ResizablePanel id="query-main" className="h-full">
            <div className="grid h-full grid-rows-[auto_1fr] overflow-hidden">
              {/* Query editor - isolated component to prevent re-renders */}
              <QueryEditorForm
                ref={editorRef}
                defaultQuery={initialQuery}
                defaultScope={initialScope}
                history={history}
                isLoading={isLoading}
                isAdmin={isAdmin}
              />
              {/* Results */}
              <div className="grid max-h-full grid-rows-[1fr] overflow-hidden border-t border-grid-dimmed bg-charcoal-800">
                <ClientTabs
                  value={resultsView}
                  onValueChange={(v) => setResultsView(v as "table" | "graph")}
                  className="grid min-h-0 grid-rows-[auto_1fr] overflow-hidden"
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
                          <span className="text-xs text-text-dimmed">
                            {results?.rows?.length ? `${results.rows.length} Results` : "Results"}
                          </span>
                          {results?.stats && (
                            <span className="text-xs text-text-dimmed">
                              {formatQueryStats(results.stats)}
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
                      <div className="flex h-full flex-col overflow-hidden">
                        {results.hiddenColumns && results.hiddenColumns.length > 0 && (
                          <Callout variant="warning" className="m-2 shrink-0 text-sm">
                            <code>SELECT *</code> doesn't return all columns because it's slow. The
                            following columns are not shown:{" "}
                            <span className="font-mono text-xs">
                              {results.hiddenColumns.join(", ")}
                            </span>
                            . Specify them explicitly to include them.
                          </Callout>
                        )}
                        <div className="h-full bg-charcoal-900 p-2">
                          <Card className="h-full overflow-hidden p-0">
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
                    className="m-0 grid min-h-0 grid-rows-[1fr] overflow-hidden"
                  >
                    {results?.rows && results?.columns && results.rows.length > 0 ? (
                      <ResizablePanelGroup className="h-full overflow-hidden">
                        <ResizablePanel id="chart-results">
                          <div className="h-full bg-charcoal-900 p-2">
                            <Card>
                              <Card.Content>
                                <QueryResultsChart
                                  rows={results.rows}
                                  columns={results.columns}
                                  config={chartConfig}
                                />
                              </Card.Content>
                            </Card>
                          </div>
                        </ResizablePanel>
                        <ResizableHandle id="chart-split" />
                        <ResizablePanel id="chart-config" min="50px" default="200px">
                          <ChartConfigPanel
                            columns={results.columns}
                            config={chartConfig}
                            onChange={handleChartConfigChange}
                          />
                        </ResizablePanel>
                      </ResizablePanelGroup>
                    ) : (
                      <Paragraph variant="small" className="p-4 text-text-dimmed">
                        Run a query to visualize results.
                      </Paragraph>
                    )}
                  </ClientTabsContent>
                </ClientTabs>
              </div>
            </div>
          </ResizablePanel>
          <ResizableHandle id="query-handle" />
          <ResizablePanel
            id="query-help"
            min="200px"
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
