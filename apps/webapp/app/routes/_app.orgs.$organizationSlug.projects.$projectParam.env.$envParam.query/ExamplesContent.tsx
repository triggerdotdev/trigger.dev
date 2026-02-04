import { Header3 } from "~/components/primitives/Headers";
import { Paragraph } from "~/components/primitives/Paragraph";
import type { QueryScope } from "~/services/queryService.server";
import { TryableCodeBlock } from "./TRQLGuideContent";

// Example queries for the Examples tab
export const exampleQueries: Array<{
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
  AND triggered_at > now() - INTERVAL 7 DAY
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
WHERE triggered_at > now() - INTERVAL 7 DAY
  AND execution_duration IS NOT NULL
GROUP BY task_identifier
ORDER BY p50_duration_ms DESC
LIMIT 20`,
    scope: "environment",
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
  },
];

export function ExamplesContent({
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
