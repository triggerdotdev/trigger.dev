import { useState } from "react";
import { Header3 } from "~/components/primitives/Headers";
import { Paragraph } from "~/components/primitives/Paragraph";
import SegmentedControl from "~/components/primitives/SegmentedControl";
import type { QueryScope } from "~/services/queryService.server";
import { querySchemas } from "~/v3/querySchemas";
import { TryableCodeBlock } from "./TRQLGuideContent";

// Example queries for the Examples tab
export const exampleQueries: Array<{
  title: string;
  description: string;
  query: string;
  scope: QueryScope;
  table: string;
}> = [
  {
    title: "Failed runs by task (past 7 days)",
    description: "Count of failed runs grouped by task identifier over the last 7 days.",
    query: `SELECT
  task_identifier,
  count() AS failed_count
FROM runs
WHERE status = 'Failed'
  AND triggered_at > now() - INTERVAL 7 DAY
GROUP BY task_identifier
ORDER BY failed_count DESC
LIMIT 20`,
    scope: "environment",
    table: "runs",
  },
  {
    title: "Execution duration p50 by task (past 7d)",
    description: "Median (50th percentile) execution duration for each task.",
    query: `SELECT
  task_identifier,
  quantile(0.5)(execution_duration) AS p50_duration_ms
FROM runs
WHERE triggered_at > now() - INTERVAL 7 DAY
  AND execution_duration IS NOT NULL
GROUP BY task_identifier
ORDER BY p50_duration_ms DESC
LIMIT 20`,
    scope: "environment",
    table: "runs",
  },
  {
    title: "Runs over time",
    description:
      "Count of runs bucketed over time. The bucket size adjusts automatically to the time range.",
    query: `SELECT
  timeBucket(),
  count() AS run_count
FROM runs
GROUP BY timeBucket
ORDER BY timeBucket
LIMIT 1000`,
    scope: "environment",
    table: "runs",
  },
  {
    title: "Most expensive 100 runs (past 7d)",
    description: "Top 100 runs by cost over the last 7 days.",
    query: `SELECT
  run_id,
  task_identifier,
  status,
  total_cost,
  usage_duration,
  machine,
  triggered_at
FROM runs
WHERE triggered_at > now() - INTERVAL 7 DAY
ORDER BY total_cost DESC
LIMIT 100`,
    scope: "environment",
    table: "runs",
  },
  {
    title: "CPU utilization over time",
    description: "Track process CPU utilization bucketed over time.",
    query: `SELECT
  timeBucket(),
  avg(metric_value) AS avg_cpu
FROM metrics
WHERE metric_name = 'process.cpu.utilization'
GROUP BY timeBucket
ORDER BY timeBucket
LIMIT 1000`,
    scope: "environment",
    table: "metrics",
  },
  {
    title: "Memory usage by task (past 7d)",
    description: "Average memory usage per task identifier over the last 7 days.",
    query: `SELECT
  task_identifier,
  avg(metric_value) AS avg_memory
FROM metrics
WHERE metric_name = 'system.memory.usage'
  AND bucket_start > now() - INTERVAL 7 DAY
GROUP BY task_identifier
ORDER BY avg_memory DESC
LIMIT 20`,
    scope: "environment",
    table: "metrics",
  },
  {
    title: "Available metric names",
    description: "List all distinct metric names collected in your environment.",
    query: `SELECT
  metric_name,
  count() AS sample_count
FROM metrics
GROUP BY metric_name
ORDER BY sample_count DESC
LIMIT 100`,
    scope: "environment",
    table: "metrics",
  },
];

const tableOptions = querySchemas.map((s) => ({ label: s.name, value: s.name }));

export function ExamplesContent({
  onTryExample,
}: {
  onTryExample: (query: string, scope: QueryScope) => void;
}) {
  const [selectedTable, setSelectedTable] = useState(querySchemas[0].name);
  const filtered = exampleQueries.filter((e) => e.table === selectedTable);

  return (
    <div className="space-y-6">
      <div className="sticky top-0 z-10 bg-background-bright pb-3">
        <SegmentedControl
          name="examples-table-selector"
          value={selectedTable}
          options={tableOptions}
          variant="secondary/small"
          fullWidth
          onChange={setSelectedTable}
        />
      </div>
      {filtered.map((example) => (
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
