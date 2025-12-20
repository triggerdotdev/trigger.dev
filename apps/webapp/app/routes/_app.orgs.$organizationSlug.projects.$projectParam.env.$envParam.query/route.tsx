import {
  ArrowDownTrayIcon,
  ClipboardIcon,
  LightBulbIcon,
  PlayIcon,
} from "@heroicons/react/20/solid";
import type { OutputColumnMetadata } from "@internal/clickhouse";
import type { ColumnSchema } from "@internal/tsql";
import { Form, useNavigation } from "@remix-run/react";
import {
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
  redirect,
} from "@remix-run/server-runtime";
import { useState } from "react";
import { typedjson, useTypedActionData, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { ClockRotateLeftIcon } from "~/assets/icons/ClockRotateLeftIcon";
import { ExitIcon } from "~/assets/icons/ExitIcon";
import { AlphaTitle } from "~/components/AlphaBadge";
import { CodeBlock } from "~/components/code/CodeBlock";
import { TSQLEditor } from "~/components/code/TSQLEditor";
import { TSQLResultsTable } from "~/components/code/TSQLResultsTable";
import {
  ClientTabs,
  ClientTabsContent,
  ClientTabsList,
  ClientTabsTrigger,
} from "~/components/primitives/ClientTabs";
import { DateTime } from "~/components/primitives/DateTime";
import { EnvironmentLabel } from "~/components/environments/EnvironmentLabel";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Badge } from "~/components/primitives/Badge";
import { Button } from "~/components/primitives/Buttons";
import { CopyableText } from "~/components/primitives/CopyableText";
import { Header2, Header3 } from "~/components/primitives/Headers";
import { NavBar, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import {
  Popover,
  PopoverArrowTrigger,
  PopoverContent,
  PopoverMenuItem,
  PopoverTrigger,
} from "~/components/primitives/Popover";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "~/components/primitives/Resizable";
import { Select, SelectItem } from "~/components/primitives/Select";
import { Spinner } from "~/components/primitives/Spinner";
import { Switch } from "~/components/primitives/Switch";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { QueryPresenter, type QueryHistoryItem } from "~/presenters/v3/QueryPresenter.server";
import { executeQuery, type QueryScope } from "~/services/queryService.server";
import { requireUser } from "~/services/session.server";
import { downloadFile, rowsToCSV, rowsToJSON } from "~/utils/dataExport";
import { EnvironmentParamSchema } from "~/utils/pathBuilder";
import { querySchemas } from "~/v3/querySchemas";

const scopeOptions = [
  { value: "environment", label: "Environment" },
  { value: "project", label: "Project" },
  { value: "organization", label: "Organization" },
] as const;

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const user = await requireUser(request);

  if (!user.admin) {
    throw redirect("/");
  }

  const { projectParam, organizationSlug, envParam } = EnvironmentParamSchema.parse(params);

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

  return typedjson({
    defaultQuery,
    history,
  });
};

const ActionSchema = z.object({
  query: z.string().min(1, "Query is required"),
  scope: z.enum(["environment", "project", "organization"]),
});

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const user = await requireUser(request);

  // Temporarily admin-only
  if (!user.admin) {
    return typedjson(
      { error: "Unauthorized", rows: null, columns: null, stats: null },
      { status: 403 }
    );
  }

  const { projectParam, organizationSlug, envParam } = EnvironmentParamSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, user.id);
  if (!project) {
    return typedjson(
      { error: "Project not found", rows: null, columns: null, stats: null },
      { status: 404 }
    );
  }

  const environment = await findEnvironmentBySlug(project.id, envParam, user.id);
  if (!environment) {
    return typedjson(
      { error: "Environment not found", rows: null, columns: null, stats: null },
      { status: 404 }
    );
  }

  const formData = await request.formData();
  const parsed = ActionSchema.safeParse({
    query: formData.get("query"),
    scope: formData.get("scope"),
  });

  if (!parsed.success) {
    return typedjson(
      {
        error: parsed.error.errors.map((e) => e.message).join(", "),
        rows: null,
        columns: null,
        stats: null,
      },
      { status: 400 }
    );
  }

  const { query, scope } = parsed.data;

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
      history: {
        source: "DASHBOARD",
        userId: user.id,
      },
    });

    if (error) {
      return typedjson(
        { error: error.message, rows: null, columns: null, stats: null },
        { status: 400 }
      );
    }

    return typedjson({
      error: null,
      rows: result.rows,
      columns: result.columns,
      stats: result.stats,
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Unknown error executing query";
    return typedjson(
      { error: errorMessage, rows: null, columns: null, stats: null },
      { status: 500 }
    );
  }
};

export default function Page() {
  const { defaultQuery, history } = useTypedLoaderData<typeof loader>();
  const results = useTypedActionData<typeof action>();
  const navigation = useNavigation();

  const [query, setQuery] = useState(defaultQuery);
  const [scope, setScope] = useState<QueryScope>("environment");
  const [prettyFormatting, setPrettyFormatting] = useState(true);
  const [showHelpSidebar, setShowHelpSidebar] = useState(true);

  const isLoading = navigation.state === "submitting" || navigation.state === "loading";

  const handleHistorySelected = (item: QueryHistoryItem) => {
    setQuery(item.query);
    setScope(item.scope);
  };

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title={<AlphaTitle>Query</AlphaTitle>} />
      </NavBar>
      <PageBody scrollable={false}>
        <ResizablePanelGroup orientation="horizontal" className="max-h-full">
          <ResizablePanel id="query-main" className="max-h-full">
            <div className="grid max-h-full grid-rows-[auto_1fr] overflow-hidden">
              {/* Query editor */}
              <div className="flex flex-col gap-2 pb-2">
                <TSQLEditor
                  defaultValue={query}
                  onChange={setQuery}
                  schema={querySchemas}
                  linterEnabled={true}
                  showCopyButton={true}
                  showClearButton={true}
                  minHeight="200px"
                  className="min-h-[200px]"
                  additionalActions={
                    showHelpSidebar ? null : (
                      <Button variant="minimal/small" onClick={() => setShowHelpSidebar(true)}>
                        Help
                      </Button>
                    )
                  }
                />
                <Form method="post" className="flex items-center justify-between gap-2 px-2">
                  <input type="hidden" name="query" value={query} />
                  <input type="hidden" name="scope" value={scope} />
                  <QueryHistoryPopover history={history} onQuerySelected={handleHistorySelected} />
                  <div className="flex items-center gap-2">
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
                    {!showHelpSidebar && (
                      <Button
                        variant="minimal/small"
                        TrailingIcon={LightBulbIcon}
                        onClick={() => setShowHelpSidebar(true)}
                        className="px-2.5"
                      />
                    )}
                    <Button
                      type="submit"
                      variant="primary/small"
                      disabled={isLoading || !query.trim()}
                      shortcut={{ modifiers: ["mod"], key: "enter", enabledOnInputElements: true }}
                      LeadingIcon={
                        isLoading ? <Spinner className="size-4" color="white" /> : undefined
                      }
                    >
                      {isLoading ? "Querying..." : "Query"}
                    </Button>
                  </div>
                </Form>
              </div>
              {/* Results */}
              <div className="grid max-h-full grid-rows-[2rem_1fr] overflow-hidden border-t border-grid-dimmed">
                <div className="flex items-center justify-between border-b border-grid-dimmed bg-charcoal-900 px-3">
                  <div className="flex items-center gap-3">
                    <Header3>
                      {results?.rows?.length ? `${results.rows.length} Results` : "Results"}
                    </Header3>
                    {results?.stats && (
                      <span className="text-xs text-text-dimmed">
                        {formatQueryStats(results.stats)}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-3">
                    {results?.rows && results?.columns && results.rows.length > 0 && (
                      <ExportResultsButton rows={results.rows} columns={results.columns} />
                    )}
                    <Switch
                      variant="small"
                      label="Pretty formatting"
                      checked={prettyFormatting}
                      onCheckedChange={setPrettyFormatting}
                    />
                  </div>
                </div>
                {isLoading ? (
                  <div className="flex items-center gap-2 p-4 text-text-dimmed">
                    <Spinner className="size-4" />
                    <span>Executing query...</span>
                  </div>
                ) : results?.error ? (
                  <pre className="whitespace-pre-wrap p-4 text-sm text-red-400">
                    {results.error}
                  </pre>
                ) : results?.rows && results?.columns ? (
                  <TSQLResultsTable
                    rows={results.rows}
                    columns={results.columns}
                    prettyFormatting={prettyFormatting}
                  />
                ) : (
                  <Paragraph variant="small" className="p-4 text-text-dimmed">
                    Run a query to see results here.
                  </Paragraph>
                )}
              </div>
            </div>
          </ResizablePanel>
          {showHelpSidebar && (
            <>
              <ResizableHandle id="query-handle" />
              <ResizablePanel
                id="query-help"
                min="200px"
                default="400px"
                max="500px"
                className="w-full"
              >
                <QueryHelpSidebar
                  onClose={() => setShowHelpSidebar(false)}
                  onTryExample={(exampleQuery, exampleScope) => {
                    setQuery(exampleQuery);
                    setScope(exampleScope);
                  }}
                />
              </ResizablePanel>
            </>
          )}
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
      <PopoverArrowTrigger isOpen={isOpen}>Export</PopoverArrowTrigger>
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

// Example queries for the Examples tab
const exampleQueries: Array<{
  title: string;
  description: string;
  query: string;
  scope: QueryScope;
}> = [
  {
    title: "Failed runs by task (past 7 days)",
    description: "Count of failed runs grouped by task identifier over the last 7 days.",
    query: `SELECT
  task_identifier,
  count() AS failed_count
FROM runs
WHERE status = 'Failed'
  AND created_at > now() - INTERVAL 7 DAY
GROUP BY task_identifier
ORDER BY failed_count DESC
LIMIT 20`,
    scope: "environment",
  },
  {
    title: "Execution duration p50 by task (past 7d)",
    description: "Median (50th percentile) execution duration for each task.",
    query: `SELECT
  task_identifier,
  quantile(0.5)(execution_duration) AS p50_duration_ms
FROM runs
WHERE created_at > now() - INTERVAL 7 DAY
  AND execution_duration IS NOT NULL
GROUP BY task_identifier
ORDER BY p50_duration_ms DESC
LIMIT 20`,
    scope: "environment",
  },
  {
    title: "Most expensive 100 runs (past 7d)",
    description: "Top 100 runs by compute cost over the last 7 days.",
    query: `SELECT
  run_id,
  task_identifier,
  status,
  compute_cost,
  usage_duration,
  machine,
  created_at
FROM runs
WHERE created_at > now() - INTERVAL 7 DAY
ORDER BY compute_cost DESC
LIMIT 100`,
    scope: "environment",
  },
];

function QueryHelpSidebar({
  onClose,
  onTryExample,
}: {
  onClose: () => void;
  onTryExample: (query: string, scope: QueryScope) => void;
}) {
  return (
    <div className="grid h-full max-h-full grid-rows-[auto_1fr] overflow-hidden bg-background-bright">
      <div className="flex items-center justify-between gap-2 border-b border-grid-dimmed p-3 pt-2">
        <Header2 className="flex items-center gap-2">
          <LightBulbIcon className="size-4 min-w-4 text-sun-500" />
          Query help
        </Header2>
        <Button
          onClick={onClose}
          variant="minimal/small"
          TrailingIcon={ExitIcon}
          shortcut={{ key: "esc" }}
          shortcutPosition="before-trailing-icon"
          className="pl-[0.375rem]"
        />
      </div>
      <ClientTabs defaultValue="guide" className="flex min-h-0 flex-col overflow-hidden">
        <ClientTabsList variant="underline" className="mx-3 shrink-0">
          <ClientTabsTrigger value="guide" variant="underline" layoutId="query-help-tabs">
            Writing TRQL
          </ClientTabsTrigger>
          <ClientTabsTrigger value="schema" variant="underline" layoutId="query-help-tabs">
            Table schema
          </ClientTabsTrigger>
          <ClientTabsTrigger value="examples" variant="underline" layoutId="query-help-tabs">
            Examples
          </ClientTabsTrigger>
        </ClientTabsList>
        <ClientTabsContent
          value="guide"
          className="min-h-0 flex-1 overflow-y-auto p-3 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600"
        >
          <TRQLGuideContent onTryExample={onTryExample} />
        </ClientTabsContent>
        <ClientTabsContent
          value="schema"
          className="min-h-0 flex-1 overflow-y-auto p-3 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600"
        >
          <TableSchemaContent />
        </ClientTabsContent>
        <ClientTabsContent
          value="examples"
          className="min-h-0 flex-1 overflow-y-auto p-3 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600"
        >
          <ExamplesContent onTryExample={onTryExample} />
        </ClientTabsContent>
      </ClientTabs>
    </div>
  );
}

/** A code block with an integrated "Try it" button */
function TryableCodeBlock({
  code,
  onTry,
  className,
}: {
  code: string;
  onTry?: () => void;
  className?: string;
}) {
  return (
    <div className={className}>
      <CodeBlock
        code={code}
        language="sql"
        showLineNumbers={false}
        showOpenInModal={false}
        className={onTry ? "rounded-b-none border-b-0 text-xs" : "text-xs"}
      />
      {onTry && (
        <div className="flex justify-end rounded-b-md border border-grid-bright p-1">
          <Button variant="minimal/small" onClick={onTry} LeadingIcon={PlayIcon}>
            Try it
          </Button>
        </div>
      )}
    </div>
  );
}

function TRQLGuideContent({
  onTryExample,
}: {
  onTryExample: (query: string, scope: QueryScope) => void;
}) {
  return (
    <div className="space-y-6">
      {/* Table of contents */}
      <nav className="space-y-1 text-sm">
        <a href="#basic" className="block text-text-link hover:underline">
          Basic queries
        </a>
        <a href="#filtering" className="block text-text-link hover:underline">
          Filtering with WHERE
        </a>
        <a href="#sorting" className="block text-text-link hover:underline">
          Sorting &amp; limiting
        </a>
        <a href="#grouping" className="block text-text-link hover:underline">
          Grouping &amp; aggregation
        </a>
        <a href="#functions" className="block text-text-link hover:underline">
          Available functions
        </a>
      </nav>

      {/* Basic queries */}
      <section id="basic">
        <Header3 className="mb-2 text-text-bright">Basic queries</Header3>
        <Paragraph variant="small" className="mb-2 text-text-dimmed">
          Select columns from a table. Use <code className="text-xs">*</code> to select all columns,
          or list specific columns.
        </Paragraph>
        <TryableCodeBlock
          code={`SELECT run_id, task_identifier, status
FROM runs
LIMIT 10`}
          onTry={() =>
            onTryExample(
              `SELECT run_id, task_identifier, status
FROM runs
LIMIT 10`,
              "environment"
            )
          }
        />
        <Paragraph variant="small" className="mt-3 text-text-dimmed">
          Alias columns with <code className="text-xs">AS</code>:
        </Paragraph>
        <TryableCodeBlock
          code={`SELECT task_identifier AS task, count() AS total
FROM runs
GROUP BY task`}
          onTry={() =>
            onTryExample(
              `SELECT task_identifier AS task, count() AS total
FROM runs
GROUP BY task`,
              "environment"
            )
          }
          className="mt-1"
        />
      </section>

      {/* Filtering */}
      <section id="filtering">
        <Header3 className="mb-2 text-text-bright">Filtering with WHERE</Header3>
        <Paragraph variant="small" className="mb-2 text-text-dimmed">
          Use comparison operators: <code className="text-xs">=</code>,{" "}
          <code className="text-xs">!=</code>, <code className="text-xs">&lt;</code>,{" "}
          <code className="text-xs">&gt;</code>, <code className="text-xs">&lt;=</code>,{" "}
          <code className="text-xs">&gt;=</code>
        </Paragraph>
        <TryableCodeBlock
          code={`SELECT * FROM runs
WHERE status = 'Failed'
  AND created_at > now() - INTERVAL 1 DAY`}
          onTry={() =>
            onTryExample(
              `SELECT * FROM runs
WHERE status = 'Failed'
  AND created_at > now() - INTERVAL 1 DAY`,
              "environment"
            )
          }
        />
        <Paragraph variant="small" className="mt-3 text-text-dimmed">
          Other operators:
        </Paragraph>
        <TryableCodeBlock
          code={`-- IN for multiple values
WHERE status IN ('Failed', 'Crashed')

-- LIKE for pattern matching (% = wildcard)
WHERE task_identifier LIKE 'email%'

-- ILIKE for case-insensitive matching
WHERE task_identifier ILIKE '%send%'

-- BETWEEN for ranges
WHERE created_at BETWEEN '2024-01-01' AND '2024-01-31'

-- NULL checks
WHERE completed_at IS NOT NULL`}
          className="mt-1"
        />
      </section>

      {/* Sorting & limiting */}
      <section id="sorting">
        <Header3 className="mb-2 text-text-bright">Sorting &amp; limiting</Header3>
        <Paragraph variant="small" className="mb-2 text-text-dimmed">
          Sort results with <code className="text-xs">ORDER BY</code> (ASC/DESC). Limit results with{" "}
          <code className="text-xs">LIMIT</code>.
        </Paragraph>
        <TryableCodeBlock
          code={`SELECT run_id, compute_cost, created_at
FROM runs
ORDER BY compute_cost DESC, created_at ASC
LIMIT 50`}
          onTry={() =>
            onTryExample(
              `SELECT run_id, compute_cost, created_at
FROM runs
ORDER BY compute_cost DESC, created_at ASC
LIMIT 50`,
              "environment"
            )
          }
        />
      </section>

      {/* Grouping */}
      <section id="grouping">
        <Header3 className="mb-2 text-text-bright">Grouping &amp; aggregation</Header3>
        <Paragraph variant="small" className="mb-2 text-text-dimmed">
          Use <code className="text-xs">GROUP BY</code> with aggregate functions. Filter groups with{" "}
          <code className="text-xs">HAVING</code>.
        </Paragraph>
        <TryableCodeBlock
          code={`SELECT
  task_identifier,
  status,
  count() AS run_count,
  avg(usage_duration) AS avg_duration
FROM runs
GROUP BY task_identifier, status
HAVING run_count > 10
ORDER BY run_count DESC`}
          onTry={() =>
            onTryExample(
              `SELECT
  task_identifier,
  status,
  count() AS run_count,
  avg(usage_duration) AS avg_duration
FROM runs
GROUP BY task_identifier, status
HAVING run_count > 10
ORDER BY run_count DESC`,
              "environment"
            )
          }
        />
      </section>

      {/* Functions */}
      <section id="functions">
        <Header3 className="mb-2 text-text-bright">Available functions</Header3>

        <div className="space-y-4">
          {/* Aggregate functions */}
          <FunctionCategory
            title="Aggregate functions"
            functions={[
              "count()",
              "countIf(col, cond)",
              "countDistinct(col)",
              "sum(col)",
              "sumIf(col, cond)",
              "avg(col)",
              "avgIf(col, cond)",
              "min(col)",
              "minIf(col, cond)",
              "max(col)",
              "maxIf(col, cond)",
              "uniq(col)",
              "uniqExact(col)",
              "uniqIf(col, cond)",
              "any(col)",
              "anyLast(col)",
              "argMin(arg, val)",
              "argMax(arg, val)",
              "median(col)",
              "medianExact(col)",
              "quantile(p)(col)",
              "quantiles(p1, p2)(col)",
              "stddevPop(col)",
              "stddevSamp(col)",
              "varPop(col)",
              "varSamp(col)",
              "covarPop(x, y)",
              "covarSamp(x, y)",
              "corr(x, y)",
              "groupArray(col)",
              "groupUniqArray(col)",
              "topK(k)(col)",
            ]}
          />

          {/* String functions */}
          <FunctionCategory
            title="String functions"
            functions={[
              "length(s)",
              "lengthUTF8(s)",
              "empty(s)",
              "notEmpty(s)",
              "lower(s)",
              "upper(s)",
              "lowerUTF8(s)",
              "upperUTF8(s)",
              "reverse(s)",
              "reverseUTF8(s)",
              "concat(s1, s2, ...)",
              "substring(s, offset, len)",
              "substr(s, offset, len)",
              "left(s, n)",
              "right(s, n)",
              "trim(s)",
              "trimLeft(s)",
              "trimRight(s)",
              "ltrim(s)",
              "rtrim(s)",
              "leftPad(s, len, char)",
              "rightPad(s, len, char)",
              "startsWith(s, prefix)",
              "endsWith(s, suffix)",
              "position(haystack, needle)",
              "locate(haystack, needle)",
              "replace(s, from, to)",
              "replaceOne(s, from, to)",
              "replaceAll(s, from, to)",
              "replaceRegexpOne(s, pattern, replacement)",
              "replaceRegexpAll(s, pattern, replacement)",
              "match(s, pattern)",
              "extract(s, pattern)",
              "extractAll(s, pattern)",
              "like(s, pattern)",
              "ilike(s, pattern)",
              "notLike(s, pattern)",
              "notILike(s, pattern)",
              "splitByChar(sep, s)",
              "splitByString(sep, s)",
              "splitByRegexp(pattern, s)",
              "arrayStringConcat(arr, sep)",
              "base64Encode(s)",
              "base64Decode(s)",
              "repeat(s, n)",
              "space(n)",
              "format(pattern, args...)",
            ]}
          />

          {/* Date/time functions */}
          <FunctionCategory
            title="Date/time functions"
            functions={[
              "now()",
              "now64()",
              "today()",
              "yesterday()",
              "toYear(dt)",
              "toQuarter(dt)",
              "toMonth(dt)",
              "toDayOfYear(dt)",
              "toDayOfMonth(dt)",
              "toDayOfWeek(dt)",
              "toHour(dt)",
              "toMinute(dt)",
              "toSecond(dt)",
              "toDate(dt)",
              "toDateTime(dt)",
              "toDateTime64(dt)",
              "toStartOfYear(dt)",
              "toStartOfQuarter(dt)",
              "toStartOfMonth(dt)",
              "toStartOfWeek(dt)",
              "toMonday(dt)",
              "toStartOfDay(dt)",
              "toStartOfHour(dt)",
              "toStartOfMinute(dt)",
              "toStartOfSecond(dt)",
              "toStartOfFiveMinutes(dt)",
              "toStartOfTenMinutes(dt)",
              "toStartOfFifteenMinutes(dt)",
              "toStartOfInterval(dt, interval)",
              "toUnixTimestamp(dt)",
              "toTime(dt)",
              "toISOYear(dt)",
              "toISOWeek(dt)",
              "toWeek(dt)",
              "toYearWeek(dt)",
              "dateDiff(unit, start, end)",
              "date_diff(unit, start, end)",
              "dateAdd(unit, n, dt)",
              "date_add(unit, n, dt)",
              "dateSub(unit, n, dt)",
              "date_sub(unit, n, dt)",
              "dateTrunc(unit, dt)",
              "date_trunc(unit, dt)",
              "addSeconds(dt, n)",
              "addMinutes(dt, n)",
              "addHours(dt, n)",
              "addDays(dt, n)",
              "addWeeks(dt, n)",
              "addMonths(dt, n)",
              "addQuarters(dt, n)",
              "addYears(dt, n)",
              "subtractSeconds(dt, n)",
              "subtractMinutes(dt, n)",
              "subtractHours(dt, n)",
              "subtractDays(dt, n)",
              "subtractWeeks(dt, n)",
              "subtractMonths(dt, n)",
              "subtractQuarters(dt, n)",
              "subtractYears(dt, n)",
              "formatDateTime(dt, format)",
              "parseDateTime(s, format)",
              "parseDateTimeBestEffort(s)",
              "toTimeZone(dt, tz)",
            ]}
          />

          {/* Conditional & null functions */}
          <FunctionCategory
            title="Conditional & null functions"
            functions={[
              "if(cond, then, else)",
              "multiIf(c1, t1, c2, t2, ..., else)",
              "coalesce(a, b, ...)",
              "ifNull(x, alt)",
              "nullIf(x, y)",
              "isNull(x)",
              "isNotNull(x)",
              "assumeNotNull(x)",
              "toNullable(x)",
            ]}
          />

          {/* Arithmetic & math */}
          <FunctionCategory
            title="Arithmetic & math functions"
            functions={[
              "plus(a, b)",
              "minus(a, b)",
              "multiply(a, b)",
              "divide(a, b)",
              "intDiv(a, b)",
              "intDivOrZero(a, b)",
              "modulo(a, b)",
              "moduloOrZero(a, b)",
              "negate(x)",
              "abs(x)",
              "sign(x)",
              "gcd(a, b)",
              "lcm(a, b)",
              "exp(x)",
              "log(x)",
              "ln(x)",
              "exp2(x)",
              "log2(x)",
              "exp10(x)",
              "log10(x)",
              "sqrt(x)",
              "cbrt(x)",
              "pow(x, y)",
              "power(x, y)",
              "round(x, n)",
              "floor(x)",
              "ceil(x)",
              "ceiling(x)",
              "trunc(x)",
              "truncate(x)",
              "sin(x)",
              "cos(x)",
              "tan(x)",
              "asin(x)",
              "acos(x)",
              "atan(x)",
              "least(a, b)",
              "greatest(a, b)",
              "min2(a, b)",
              "max2(a, b)",
            ]}
          />

          {/* Array functions */}
          <FunctionCategory
            title="Array functions"
            functions={[
              "array(a, b, ...)",
              "range(start, end, step)",
              "length(arr)",
              "empty(arr)",
              "notEmpty(arr)",
              "has(arr, elem)",
              "hasAll(arr1, arr2)",
              "hasAny(arr1, arr2)",
              "indexOf(arr, elem)",
              "arrayElement(arr, n)",
              "arrayJoin(arr)",
              "arrayConcat(arr1, arr2)",
              "arraySlice(arr, offset, length)",
              "arrayPushBack(arr, elem)",
              "arrayPushFront(arr, elem)",
              "arrayPopBack(arr)",
              "arrayPopFront(arr)",
              "arraySort(arr)",
              "arrayReverseSort(arr)",
              "arrayReverse(arr)",
              "arrayUniq(arr)",
              "arrayDistinct(arr)",
              "arrayCompact(arr)",
              "arrayFlatten(arr)",
              "arrayIntersect(arr1, arr2)",
              "arrayMap(func, arr)",
              "arrayFilter(func, arr)",
              "arrayExists(func, arr)",
              "arrayAll(func, arr)",
              "arrayFirst(func, arr)",
              "arrayLast(func, arr)",
              "arrayFirstIndex(func, arr)",
              "arrayLastIndex(func, arr)",
              "arrayMin(arr)",
              "arrayMax(arr)",
              "arraySum(arr)",
              "arrayAvg(arr)",
              "arrayCount(func, arr)",
              "arrayReduce(agg, arr)",
              "arrayShuffle(arr)",
              "arrayZip(arr1, arr2)",
            ]}
          />

          {/* JSON functions */}
          <FunctionCategory
            title="JSON functions"
            functions={[
              "JSONHas(json, key)",
              "JSONLength(json)",
              "JSONType(json, key)",
              "JSONExtract(json, key, type)",
              "JSONExtractString(json, key)",
              "JSONExtractInt(json, key)",
              "JSONExtractUInt(json, key)",
              "JSONExtractFloat(json, key)",
              "JSONExtractBool(json, key)",
              "JSONExtractRaw(json, key)",
              "JSONExtractArrayRaw(json, key)",
              "JSONExtractKeys(json)",
              "JSONExtractKeysAndValues(json, type)",
              "toJSONString(value)",
            ]}
          />

          {/* Type conversion */}
          <FunctionCategory
            title="Type conversion functions"
            functions={[
              "toString(x)",
              "toFixedString(s, n)",
              "toInt8(x)",
              "toInt16(x)",
              "toInt32(x)",
              "toInt64(x)",
              "toUInt8(x)",
              "toUInt16(x)",
              "toUInt32(x)",
              "toUInt64(x)",
              "toFloat32(x)",
              "toFloat64(x)",
              "toDecimal32(x, s)",
              "toDecimal64(x, s)",
              "toDecimal128(x, s)",
              "toDate(x)",
              "toDateOrNull(x)",
              "toDateOrZero(x)",
              "toDateTime(x)",
              "toDateTimeOrNull(x)",
              "toDateTimeOrZero(x)",
              "toUUID(x)",
              "toUUIDOrNull(x)",
              "toTypeName(x)",
            ]}
          />

          {/* Comparison & logical */}
          <FunctionCategory
            title="Comparison & logical functions"
            functions={[
              "equals(a, b)",
              "notEquals(a, b)",
              "less(a, b)",
              "greater(a, b)",
              "lessOrEquals(a, b)",
              "greaterOrEquals(a, b)",
              "and(a, b, ...)",
              "or(a, b, ...)",
              "xor(a, b)",
              "not(x)",
              "in(x, set)",
              "notIn(x, set)",
            ]}
          />

          {/* Hash functions */}
          <FunctionCategory
            title="Hash functions"
            functions={[
              "MD5(s)",
              "SHA1(s)",
              "SHA224(s)",
              "SHA256(s)",
              "SHA384(s)",
              "SHA512(s)",
              "sipHash64(s)",
              "sipHash128(s)",
              "cityHash64(s)",
              "xxHash32(s)",
              "xxHash64(s)",
              "murmurHash2_32(s)",
              "murmurHash2_64(s)",
              "murmurHash3_32(s)",
              "murmurHash3_64(s)",
              "murmurHash3_128(s)",
              "hex(s)",
              "unhex(s)",
            ]}
          />

          {/* URL functions */}
          <FunctionCategory
            title="URL functions"
            functions={[
              "protocol(url)",
              "domain(url)",
              "domainWithoutWWW(url)",
              "topLevelDomain(url)",
              "firstSignificantSubdomain(url)",
              "port(url)",
              "path(url)",
              "pathFull(url)",
              "queryString(url)",
              "fragment(url)",
              "extractURLParameter(url, name)",
              "extractURLParameters(url)",
              "encodeURLComponent(s)",
              "decodeURLComponent(s)",
            ]}
          />

          {/* UUID & other */}
          <FunctionCategory
            title="UUID & utility functions"
            functions={[
              "generateUUIDv4()",
              "UUIDStringToNum(s)",
              "UUIDNumToString(n)",
              "isFinite(x)",
              "isInfinite(x)",
              "isNaN(x)",
              "formatReadableSize(bytes)",
              "formatReadableQuantity(n)",
              "formatReadableTimeDelta(seconds)",
              "runningDifference(col)",
              "neighbor(col, offset)",
              "bar(x, min, max, width)",
              "transform(x, from_arr, to_arr, default)",
            ]}
          />

          {/* Tuple & map functions */}
          <FunctionCategory
            title="Tuple & map functions"
            functions={[
              "tuple(a, b, ...)",
              "tupleElement(tuple, n)",
              "untuple(tuple)",
              "map(k1, v1, k2, v2, ...)",
              "mapFromArrays(keys, values)",
              "mapContains(map, key)",
              "mapKeys(map)",
              "mapValues(map)",
            ]}
          />

          {/* Window functions */}
          <FunctionCategory
            title="Window functions"
            functions={[
              "row_number()",
              "rank()",
              "dense_rank()",
              "first_value(col)",
              "last_value(col)",
              "nth_value(col, n)",
              "lag(col, offset, default)",
              "lead(col, offset, default)",
            ]}
          />

          {/* Interval functions */}
          <FunctionCategory
            title="Interval functions"
            functions={[
              "toIntervalSecond(n)",
              "toIntervalMinute(n)",
              "toIntervalHour(n)",
              "toIntervalDay(n)",
              "toIntervalWeek(n)",
              "toIntervalMonth(n)",
              "toIntervalQuarter(n)",
              "toIntervalYear(n)",
            ]}
          />
        </div>
      </section>
    </div>
  );
}

function FunctionCategory({ title, functions }: { title: string; functions: string[] }) {
  return (
    <div>
      <Paragraph variant="small/bright" className="mb-1">
        {title}
      </Paragraph>
      <div className="flex flex-wrap gap-1">
        {functions.map((fn) => (
          <code
            key={fn}
            className="rounded bg-charcoal-750 px-1.5 py-0.5 font-mono text-xxs text-indigo-400"
          >
            {fn}
          </code>
        ))}
      </div>
    </div>
  );
}

function TableSchemaContent() {
  return (
    <div>
      {querySchemas.map((table) => (
        <div key={table.name} className="mb-6">
          <div className="mb-2">
            <Header3 className="font-mono text-text-bright">{table.name}</Header3>
            {table.description && (
              <Paragraph variant="small" className="mt-1 text-text-dimmed">
                {table.description}
              </Paragraph>
            )}
          </div>
          <div className="flex flex-col gap-2 divide-y divide-grid-dimmed">
            {Object.values(table.columns).map((col) => (
              <ColumnHelpItem key={col.name} col={col} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function ExamplesContent({
  onTryExample,
}: {
  onTryExample: (query: string, scope: QueryScope) => void;
}) {
  return (
    <div className="space-y-6">
      {exampleQueries.map((example) => (
        <div key={example.title}>
          <Header3 className="mb-1 text-text-bright">{example.title}</Header3>
          <Paragraph variant="small" className="mb-2 text-text-dimmed">
            {example.description}
          </Paragraph>
          <TryableCodeBlock
            code={example.query}
            onTry={() => onTryExample(example.query, example.scope)}
          />
        </div>
      ))}
    </div>
  );
}

function ColumnHelpItem({ col }: { col: ColumnSchema }) {
  return (
    <div className="pt-1">
      <div className="flex items-center gap-2">
        <CopyableText value={col.name} className="text-sm text-indigo-400" />
        <Badge className="font-mono text-xxs">{col.type}</Badge>
      </div>
      {col.description && (
        <Paragraph variant="extra-small" className="mt-1 text-text-dimmed">
          {col.description}
        </Paragraph>
      )}
      {col.example && (
        <div className="mt-1 flex items-baseline gap-0.5">
          <span className="text-xs text-text-dimmed">Example:</span>
          <CopyableText
            value={col.example}
            className="rounded-sm bg-charcoal-750 px-1.5 py-0.5 font-mono text-xxs"
          />
        </div>
      )}
      {col.allowedValues && col.allowedValues.length > 0 && (
        <div className="mt-0.5 flex flex-wrap gap-1">
          <span className="text-xs text-text-dimmed">Available options:</span>
          {col.allowedValues.map((value) => (
            <CopyableText
              key={value}
              value={col.valueMap?.[value] ?? value}
              className="rounded-sm bg-charcoal-750 px-1.5 py-0.5 font-mono text-xxs"
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ScopeItem({ scope }: { scope: QueryScope }) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();

  switch (scope) {
    case "organization":
      return organization.title;
    case "project":
      return project.name;
    case "environment":
      return <EnvironmentLabel environment={environment} />;
    default:
      return scope;
  }
}

function formatQueryStats(stats: {
  read_rows: string;
  read_bytes: string;
  elapsed_ns: string;
  byte_seconds: string;
}): string {
  const readRows = parseInt(stats.read_rows, 10);
  const readBytes = parseInt(stats.read_bytes, 10);
  const elapsedNs = parseInt(stats.elapsed_ns, 10);
  const byteSeconds = parseFloat(stats.byte_seconds);

  const elapsedMs = elapsedNs / 1_000_000;
  const formattedTime =
    elapsedMs < 1000 ? `${elapsedMs.toFixed(1)}ms` : `${(elapsedMs / 1000).toFixed(2)}s`;
  const formattedBytes = formatBytes(readBytes);

  return `${readRows.toLocaleString()} rows read · ${formattedBytes} · ${formattedTime} · ${formatBytes(
    byteSeconds
  )}s`;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

const SQL_KEYWORDS = [
  "SELECT",
  "FROM",
  "WHERE",
  "ORDER BY",
  "LIMIT",
  "GROUP BY",
  "HAVING",
  "JOIN",
  "LEFT JOIN",
  "RIGHT JOIN",
  "INNER JOIN",
  "OUTER JOIN",
  "AND",
  "OR",
  "AS",
  "ON",
  "IN",
  "NOT",
  "NULL",
  "DESC",
  "ASC",
  "DISTINCT",
  "COUNT",
  "SUM",
  "AVG",
  "MIN",
  "MAX",
];

function highlightSQL(query: string): React.ReactNode[] {
  // Normalize whitespace for display (let CSS line-clamp handle truncation)
  const normalized = query.replace(/\s+/g, " ").slice(0, 200);
  const suffix = "";

  // Create a regex pattern that matches keywords as whole words (case insensitive)
  const keywordPattern = new RegExp(
    `\\b(${SQL_KEYWORDS.map((k) => k.replace(/\s+/g, "\\s+")).join("|")})\\b`,
    "gi"
  );

  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match;

  while ((match = keywordPattern.exec(normalized)) !== null) {
    // Add text before the match
    if (match.index > lastIndex) {
      parts.push(normalized.slice(lastIndex, match.index));
    }
    // Add the highlighted keyword
    parts.push(
      <span key={match.index} className="text-[#c678dd]">
        {match[0]}
      </span>
    );
    lastIndex = keywordPattern.lastIndex;
  }

  // Add remaining text
  if (lastIndex < normalized.length) {
    parts.push(normalized.slice(lastIndex));
  }

  if (suffix) {
    parts.push(suffix);
  }

  return parts;
}

function QueryHistoryPopover({
  history,
  onQuerySelected,
}: {
  history: QueryHistoryItem[];
  onQuerySelected: (item: QueryHistoryItem) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="tertiary/small"
          LeadingIcon={ClockRotateLeftIcon}
          disabled={history.length === 0}
        >
          History
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[400px] min-w-0 overflow-hidden p-0"
        align="start"
        sideOffset={6}
      >
        <div className="max-h-80 overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
          <div className="p-1">
            {history.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  onQuerySelected(item);
                  setIsOpen(false);
                }}
                className="flex w-full items-center gap-2 rounded-sm px-2 py-2 outline-none transition-colors focus-custom hover:bg-charcoal-900"
              >
                <div className="flex flex-1 flex-col items-start overflow-hidden">
                  <p className="line-clamp-2 w-full break-words text-left font-mono text-xs text-[#9b99ff]">
                    {highlightSQL(item.query)}
                  </p>
                  <div className="flex items-center gap-2 text-xs text-text-dimmed">
                    <DateTime date={item.createdAt} showTooltip={false} />
                    {item.userName && <span>· {item.userName}</span>}
                    <span className="capitalize">· {item.scope}</span>
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
