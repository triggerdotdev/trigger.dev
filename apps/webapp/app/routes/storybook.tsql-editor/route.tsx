import { useState } from "react";
import { TSQLEditor } from "~/components/code/TSQLEditor";
import { column, type TableSchema } from "@internal/tsql";

const runsSchema: TableSchema = {
  name: "runs",
  clickhouseName: "trigger_dev.task_runs_v2",
  description: "Task runs table - stores all task execution records",
  tenantColumns: {
    organizationId: "organization_id",
    projectId: "project_id",
    environmentId: "environment_id",
  },
  columns: {
    id: { name: "id", ...column("String", { description: "Unique run identifier" }) },
    task_id: { name: "task_id", ...column("String", { description: "Task identifier" }) },
    status: {
      name: "status",
      ...column("String", { description: "Run status (PENDING, EXECUTING, COMPLETED, FAILED)" }),
    },
    created_at: {
      name: "created_at",
      ...column("DateTime64", { description: "When the run was created" }),
    },
    started_at: {
      name: "started_at",
      ...column("Nullable(DateTime64)", { description: "When the run started executing" }),
    },
    completed_at: {
      name: "completed_at",
      ...column("Nullable(DateTime64)", { description: "When the run completed" }),
    },
    duration_ms: {
      name: "duration_ms",
      ...column("Nullable(UInt64)", { description: "Run duration in milliseconds" }),
    },
    organization_id: { name: "organization_id", ...column("String") },
    project_id: { name: "project_id", ...column("String") },
    environment_id: { name: "environment_id", ...column("String") },
  },
};

const logsSchema: TableSchema = {
  name: "logs",
  clickhouseName: "trigger_dev.task_events_v2",
  description: "Task logs and events",
  tenantColumns: {
    organizationId: "organization_id",
    projectId: "project_id",
    environmentId: "environment_id",
  },
  columns: {
    id: { name: "id", ...column("String", { description: "Event identifier" }) },
    run_id: { name: "run_id", ...column("String", { description: "Associated run ID" }) },
    level: { name: "level", ...column("String", { description: "Log level (INFO, WARN, ERROR)" }) },
    message: { name: "message", ...column("String", { description: "Log message content" }) },
    timestamp: { name: "timestamp", ...column("DateTime64", { description: "Event timestamp" }) },
    organization_id: { name: "organization_id", ...column("String") },
    project_id: { name: "project_id", ...column("String") },
    environment_id: { name: "environment_id", ...column("String") },
  },
};

const exampleSchema = [runsSchema, logsSchema];

const exampleQueries = [
  {
    name: "Simple SELECT",
    query: "SELECT * FROM runs LIMIT 10",
  },
  {
    name: "With WHERE clause",
    query: "SELECT id, task_id, status, created_at FROM runs WHERE status = 'COMPLETED' LIMIT 100",
  },
  {
    name: "Aggregation",
    query: "SELECT status, count(*) as count FROM runs GROUP BY status ORDER BY count DESC",
  },
  {
    name: "Join query",
    query: `SELECT 
  runs.id,
  runs.status,
  logs.message,
  logs.level
FROM runs
JOIN logs ON runs.id = logs.run_id
WHERE logs.level = 'ERROR'
LIMIT 50`,
  },
  {
    name: "Date filtering",
    query: `SELECT 
  toStartOfDay(created_at) as day,
  count(*) as runs_count,
  avg(duration_ms) as avg_duration
FROM runs
WHERE created_at > now() - INTERVAL 7 DAY
GROUP BY day
ORDER BY day DESC`,
  },
];

export default function Story() {
  const [query, setQuery] = useState(exampleQueries[0].query);

  return (
    <div className="flex flex-col gap-y-8 p-8">
      <div>
        <h1 className="mb-2 text-2xl font-bold text-text-bright">TSQL Editor</h1>
        <p className="text-text-dimmed">
          A CodeMirror-based SQL editor with syntax highlighting, schema-aware autocomplete, and
          real-time error detection.
        </p>
      </div>

      {/* Example queries */}
      <div className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold text-text-bright">Example Queries</h2>
        <div className="flex flex-wrap gap-2">
          {exampleQueries.map((example) => (
            <button
              key={example.name}
              onClick={() => setQuery(example.query)}
              className="rounded bg-charcoal-700 px-3 py-1.5 text-sm text-text-dimmed transition hover:bg-charcoal-600 hover:text-text-bright"
            >
              {example.name}
            </button>
          ))}
        </div>
      </div>

      {/* Main editor */}
      <div className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold text-text-bright">Editor with Schema</h2>
        <p className="text-sm text-text-dimmed">
          Try typing to see autocomplete suggestions. Available tables: <code>runs</code>,{" "}
          <code>logs</code>
        </p>
        <div className="overflow-hidden rounded-lg border border-grid-dimmed">
          <TSQLEditor
            defaultValue={query}
            onChange={setQuery}
            schema={exampleSchema}
            linterEnabled={true}
            showCopyButton={true}
            showClearButton={true}
            minHeight="200px"
            className="min-h-[200px]"
          />
        </div>
      </div>

      {/* Read-only example */}
      <div className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold text-text-bright">Read-only Mode</h2>
        <div className="overflow-hidden rounded-lg border border-grid-dimmed">
          <TSQLEditor
            defaultValue="SELECT id, status, created_at FROM runs WHERE status = 'FAILED' ORDER BY created_at DESC LIMIT 10"
            readOnly={true}
            schema={exampleSchema}
            linterEnabled={false}
            showCopyButton={true}
            showClearButton={false}
            className="min-h-[100px]"
          />
        </div>
      </div>

      {/* Editor without schema (no autocomplete) */}
      <div className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold text-text-bright">Without Schema (Basic Mode)</h2>
        <p className="text-sm text-text-dimmed">
          Editor without schema - still has SQL syntax highlighting and keyword completion.
        </p>
        <div className="overflow-hidden rounded-lg border border-grid-dimmed">
          <TSQLEditor
            defaultValue="SELECT * FROM my_table WHERE id = 1"
            linterEnabled={true}
            showCopyButton={true}
            className="min-h-[100px]"
          />
        </div>
      </div>

      {/* Error example */}
      <div className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold text-text-bright">With Syntax Error</h2>
        <p className="text-sm text-text-dimmed">
          The linter detects syntax errors and underlines them in red.
        </p>
        <div className="overflow-hidden rounded-lg border border-grid-dimmed">
          <TSQLEditor
            defaultValue="SELEC * FORM runs"
            linterEnabled={true}
            showCopyButton={true}
            className="min-h-[100px]"
          />
        </div>
      </div>

      {/* Available tables reference */}
      <div className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold text-text-bright">Available Schema</h2>
        <div className="grid gap-4 md:grid-cols-2">
          {exampleSchema.map((table) => (
            <div
              key={table.name}
              className="rounded-lg border border-grid-dimmed bg-charcoal-800 p-4"
            >
              <h3 className="mb-1 font-mono text-sm font-semibold text-text-bright">
                {table.name}
              </h3>
              <p className="mb-3 text-xs text-text-dimmed">{table.description}</p>
              <div className="space-y-1">
                {Object.entries(table.columns).map(([name, col]) => (
                  <div key={name} className="flex items-baseline gap-2 text-xs">
                    <code className="text-blue-400">{name}</code>
                    <span className="text-charcoal-400">{col.type}</span>
                    {col.description && (
                      <span className="text-text-dimmed">- {col.description}</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
