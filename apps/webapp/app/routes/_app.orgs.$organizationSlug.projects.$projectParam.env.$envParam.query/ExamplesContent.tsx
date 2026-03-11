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
  {
    title: "LLM cost by model (past 7d)",
    description: "Total cost, input tokens, and output tokens grouped by model over the last 7 days.",
    query: `SELECT
  response_model,
  SUM(total_cost) AS total_cost,
  SUM(input_tokens) AS input_tokens,
  SUM(output_tokens) AS output_tokens
FROM llm_usage
WHERE start_time > now() - INTERVAL 7 DAY
GROUP BY response_model
ORDER BY total_cost DESC`,
    scope: "environment",
    table: "llm_usage",
  },
  {
    title: "LLM cost over time",
    description: "Total LLM cost bucketed over time. The bucket size adjusts automatically.",
    query: `SELECT
  timeBucket(),
  SUM(total_cost) AS total_cost
FROM llm_usage
GROUP BY timeBucket
ORDER BY timeBucket
LIMIT 1000`,
    scope: "environment",
    table: "llm_usage",
  },
  {
    title: "Most expensive runs by LLM cost (top 50)",
    description: "Top 50 runs by total LLM cost with token breakdown.",
    query: `SELECT
  run_id,
  task_identifier,
  SUM(total_cost) AS llm_cost,
  SUM(input_tokens) AS input_tokens,
  SUM(output_tokens) AS output_tokens
FROM llm_usage
GROUP BY run_id, task_identifier
ORDER BY llm_cost DESC
LIMIT 50`,
    scope: "environment",
    table: "llm_usage",
  },
  {
    title: "LLM calls by provider",
    description: "Count and cost of LLM calls grouped by AI provider.",
    query: `SELECT
  gen_ai_system,
  count() AS call_count,
  SUM(total_cost) AS total_cost
FROM llm_usage
GROUP BY gen_ai_system
ORDER BY total_cost DESC`,
    scope: "environment",
    table: "llm_usage",
  },
  {
    title: "LLM cost by user",
    description:
      "Total LLM cost per user from run tags or AI SDK telemetry metadata. Uses metadata.userId which comes from experimental_telemetry metadata or run tags like user:123.",
    query: `SELECT
  metadata.userId AS user_id,
  SUM(total_cost) AS total_cost,
  SUM(total_tokens) AS total_tokens,
  count() AS call_count
FROM llm_usage
WHERE metadata.userId != ''
GROUP BY metadata.userId
ORDER BY total_cost DESC
LIMIT 50`,
    scope: "environment",
    table: "llm_usage",
  },
  {
    title: "LLM cost by metadata key",
    description:
      "Browse all metadata keys and their LLM cost. Metadata comes from run tags (key:value) and AI SDK telemetry metadata.",
    query: `SELECT
  metadata,
  response_model,
  total_cost,
  total_tokens,
  run_id
FROM llm_usage
ORDER BY start_time DESC
LIMIT 20`,
    scope: "environment",
    table: "llm_usage",
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
