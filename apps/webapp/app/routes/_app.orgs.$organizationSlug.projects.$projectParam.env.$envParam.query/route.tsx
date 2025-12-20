import { ArrowDownTrayIcon, ClipboardIcon, LightBulbIcon } from "@heroicons/react/20/solid";
import type { FieldMappings, OutputColumnMetadata } from "@internal/clickhouse";
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
import { ExitIcon } from "~/assets/icons/ExitIcon";
import { AlphaTitle } from "~/components/AlphaBadge";
import { TSQLEditor } from "~/components/code/TSQLEditor";
import { TSQLResultsTable } from "~/components/code/TSQLResultsTable";
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
import { prisma } from "~/db.server";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { executeQuery } from "~/services/queryService.server";
import { requireUser } from "~/services/session.server";
import { downloadFile, rowsToCSV, rowsToJSON } from "~/utils/dataExport";
import { EnvironmentParamSchema } from "~/utils/pathBuilder";
import { defaultQuery, querySchemas } from "~/v3/querySchemas";

const scopeOptions = [
  { value: "environment", label: "Environment" },
  { value: "project", label: "Project" },
  { value: "organization", label: "Organization" },
] as const;

type QueryScope = (typeof scopeOptions)[number]["value"];

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

  return typedjson({
    organizationId: project.organizationId,
    projectId: project.id,
    environmentId: environment.id,
    defaultQuery,
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

  // Build tenant IDs based on scope
  const tenantOptions: {
    organizationId: string;
    projectId?: string;
    environmentId?: string;
  } = {
    organizationId: project.organizationId,
  };

  if (scope === "project" || scope === "environment") {
    tenantOptions.projectId = project.id;
  }

  if (scope === "environment") {
    tenantOptions.environmentId = environment.id;
  }

  // Build field mappings for project_ref → project_id and environment_id → slug translation
  const projects = await prisma.project.findMany({
    where: { organizationId: project.organizationId },
    select: { id: true, externalRef: true },
  });

  const environments = await prisma.runtimeEnvironment.findMany({
    where: { project: { organizationId: project.organizationId } },
    select: { id: true, slug: true },
  });

  const fieldMappings: FieldMappings = {
    project: Object.fromEntries(projects.map((p) => [p.id, p.externalRef])),
    environment: Object.fromEntries(environments.map((e) => [e.id, e.slug])),
  };

  try {
    const [error, result] = await executeQuery({
      name: "query-page",
      query,
      schema: z.record(z.any()),
      tableSchema: querySchemas,
      transformValues: true,
      fieldMappings,
      ...tenantOptions,
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
  const { defaultQuery } = useTypedLoaderData<typeof loader>();
  const results = useTypedActionData<typeof action>();
  const navigation = useNavigation();

  const [query, setQuery] = useState(defaultQuery);
  const [scope, setScope] = useState<QueryScope>("environment");
  const [prettyFormatting, setPrettyFormatting] = useState(true);
  const [showHelpSidebar, setShowHelpSidebar] = useState(true);

  const isLoading = navigation.state === "submitting" || navigation.state === "loading";

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
                <Form method="post" className="flex items-center justify-end gap-2 px-2">
                  <input type="hidden" name="query" value={query} />
                  <input type="hidden" name="scope" value={scope} />
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
                <QueryHelpSidebar onClose={() => setShowHelpSidebar(false)} />
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

function QueryHelpSidebar({ onClose }: { onClose: () => void }) {
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
      <div className="overflow-y-scroll p-3 pt-2 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
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
