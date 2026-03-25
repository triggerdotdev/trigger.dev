import { evalite } from "evalite";
import { Levenshtein } from "autoevals";
import { AIQueryService } from "~/v3/services/aiQueryService.server";
import { runsSchema } from "~/v3/querySchemas";
import dotenv from "dotenv";
import { traceAISDKModel } from "evalite/ai-sdk";
import { openai } from "@ai-sdk/openai";

dotenv.config({ path: "../../.env" });

// Helper to normalize queries for comparison
function normalizeQuery(query: string): string {
  return query
    .replace(/\s+/g, " ")
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")")
    .trim()
    .toLowerCase();
}

// Type for parsed query results
interface ParsedQueryResult {
  success: boolean;
  query?: string;
  error?: string;
}

// Custom scorer that checks if the generated query is semantically similar
// and also syntactically valid
const QuerySimilarity = {
  name: "QuerySimilarity",
  scorer: async ({
    input,
    output,
    expected,
  }: {
    input: string;
    output: string;
    expected?: string;
  }) => {
    if (!expected) {
      return 0;
    }

    // Parse the output to extract the query
    const outputParsed = JSON.parse(output) as ParsedQueryResult;
    const expectedParsed = JSON.parse(expected) as ParsedQueryResult;

    // Check success status first
    if (outputParsed.success !== expectedParsed.success) {
      return 0;
    }

    // If both failed, check if error messages are similar
    if (!outputParsed.success && !expectedParsed.success) {
      // Give partial credit for correctly identifying an error case
      return 0.5;
    }

    // If both succeeded, compare the queries
    if (outputParsed.success && expectedParsed.success) {
      const normalizedOutput = normalizeQuery(outputParsed.query ?? "");
      const normalizedExpected = normalizeQuery(expectedParsed.query ?? "");

      // Key patterns to check
      const patterns = [
        // Table name
        /from\s+runs/i,
        // Status filter patterns
        /status\s*=\s*'[^']+'/i,
        /status\s+in\s*\([^)]+\)/i,
        // Time patterns
        /interval\s+\d+\s+(day|hour|minute|week|month)/i,
        /triggered_at\s*>/i,
        // Aggregation patterns
        /count\(\)/i,
        /sum\(/i,
        /avg\(/i,
        /group\s+by/i,
        // Ordering
        /order\s+by/i,
        // Limit
        /limit\s+\d+/i,
      ];

      let matchScore = 0;
      let totalPatterns = 0;

      for (const pattern of patterns) {
        const outputMatch = pattern.test(normalizedOutput);
        const expectedMatch = pattern.test(normalizedExpected);

        if (expectedMatch) {
          totalPatterns++;
          if (outputMatch) {
            matchScore++;
          }
        }
      }

      // Base score from pattern matching
      const patternScore = totalPatterns > 0 ? matchScore / totalPatterns : 0.5;

      // Use Levenshtein for overall similarity
      const levenshteinResult = await Levenshtein({
        output: normalizedOutput,
        expected: normalizedExpected,
      });
      const levenshteinScore = levenshteinResult?.score ?? 0;

      // Weighted combination
      return 0.6 * patternScore + 0.4 * levenshteinScore;
    }

    return 0;
  },
};

evalite("AI Query Generator", {
  data: async () => {
    return [
      // Basic SELECT queries
      {
        input: "Show me all runs",
        expected: JSON.stringify({
          success: true,
          query: `SELECT *
FROM runs
LIMIT 100`,
        }),
      },
      {
        input: "Get the 10 most recent runs",
        expected: JSON.stringify({
          success: true,
          query: `SELECT *
FROM runs
ORDER BY triggered_at DESC
LIMIT 10`,
        }),
      },

      // Status filtering
      {
        input: "Show failed runs",
        expected: JSON.stringify({
          success: true,
          query: `SELECT *
FROM runs
WHERE status = 'Failed'
LIMIT 100`,
        }),
      },
      {
        input: "Get all completed runs",
        expected: JSON.stringify({
          success: true,
          query: `SELECT *
FROM runs
WHERE status = 'Completed'
LIMIT 100`,
        }),
      },
      {
        input: "Find runs that crashed or timed out",
        expected: JSON.stringify({
          success: true,
          query: `SELECT *
FROM runs
WHERE status IN ('Crashed', 'Timed out')
LIMIT 100`,
        }),
      },

      // Time-based filtering
      {
        input: "Runs from the last 7 days",
        expected: JSON.stringify({
          success: true,
          query: `SELECT *
FROM runs
WHERE triggered_at > now() - INTERVAL 7 DAY
LIMIT 100`,
        }),
      },
      {
        input: "Show runs from the past hour",
        expected: JSON.stringify({
          success: true,
          query: `SELECT *
FROM runs
WHERE triggered_at > now() - INTERVAL 1 HOUR
LIMIT 100`,
        }),
      },
      {
        input: "Failed runs in the last 24 hours",
        expected: JSON.stringify({
          success: true,
          query: `SELECT *
FROM runs
WHERE status = 'Failed'
  AND triggered_at > now() - INTERVAL 1 DAY
ORDER BY triggered_at DESC
LIMIT 100`,
        }),
      },

      // Aggregations
      {
        input: "Count of runs by status",
        expected: JSON.stringify({
          success: true,
          query: `SELECT status, count() AS count
FROM runs
GROUP BY status
ORDER BY count DESC`,
        }),
      },
      {
        input: "How many runs per task?",
        expected: JSON.stringify({
          success: true,
          query: `SELECT task_identifier, count() AS run_count
FROM runs
GROUP BY task_identifier
ORDER BY run_count DESC
LIMIT 100`,
        }),
      },
      {
        input: "Average execution duration by task",
        expected: JSON.stringify({
          success: true,
          query: `SELECT task_identifier, avg(execution_duration) AS avg_duration
FROM runs
GROUP BY task_identifier
ORDER BY avg_duration DESC
LIMIT 100`,
        }),
      },
      {
        input: "Total cost by task in the last 30 days",
        expected: JSON.stringify({
          success: true,
          query: `SELECT task_identifier, sum(total_cost) AS total_cost
FROM runs
WHERE triggered_at > now() - INTERVAL 30 DAY
GROUP BY task_identifier
ORDER BY total_cost DESC
LIMIT 100`,
        }),
      },

      // Complex queries
      {
        input: "Top 10 most expensive failed runs from last week",
        expected: JSON.stringify({
          success: true,
          query: `SELECT run_id, task_identifier, status, total_cost, triggered_at
FROM runs
WHERE status = 'Failed'
  AND triggered_at > now() - INTERVAL 7 DAY
ORDER BY total_cost DESC
LIMIT 10`,
        }),
      },
      {
        input: "Runs using large machines that took more than 5 minutes",
        expected: JSON.stringify({
          success: true,
          query: `SELECT *
FROM runs
WHERE machine IN ('large-1x', 'large-2x')
  AND usage_duration > 300000
LIMIT 100`,
        }),
      },
      {
        input: "Show p95 execution duration by task for completed runs",
        expected: JSON.stringify({
          success: true,
          query: `SELECT task_identifier, quantile(0.95)(execution_duration) AS p95_duration
FROM runs
WHERE status = 'Completed'
  AND execution_duration IS NOT NULL
GROUP BY task_identifier
ORDER BY p95_duration DESC
LIMIT 100`,
        }),
      },

      // Specific columns
      {
        input: "Just show run IDs and their statuses",
        expected: JSON.stringify({
          success: true,
          query: `SELECT run_id, status
FROM runs
LIMIT 100`,
        }),
      },
      {
        input: "Get run_id, task, status and cost for recent runs",
        expected: JSON.stringify({
          success: true,
          query: `SELECT run_id, task_identifier, status, total_cost
FROM runs
ORDER BY triggered_at DESC
LIMIT 100`,
        }),
      },

      // Root runs
      {
        input: "Show only root runs (not child runs)",
        expected: JSON.stringify({
          success: true,
          query: `SELECT *
FROM runs
WHERE is_root_run = 1
LIMIT 100`,
        }),
      },

      // Queue filtering
      {
        input: "Runs in the shared queue",
        expected: JSON.stringify({
          success: true,
          query: `SELECT *
FROM runs
WHERE queue LIKE '%shared%'
LIMIT 100`,
        }),
      },

      // Tags
      {
        input: "Find runs with tag 'important'",
        expected: JSON.stringify({
          success: true,
          query: `SELECT *
FROM runs
WHERE has(tags, 'important')
LIMIT 100`,
        }),
      },

      // Error cases
      {
        input: "Do something",
        expected: JSON.stringify({
          success: false,
          error: "Please be more specific about what data you want to query",
        }),
      },
      {
        input: "Show me the weather",
        expected: JSON.stringify({
          success: false,
          error: "I can only generate queries for task run data",
        }),
      },
    ];
  },
  task: async (input) => {
    const service = new AIQueryService([runsSchema], traceAISDKModel(openai("gpt-4o-mini")));

    const result = await service.call(input);
    return JSON.stringify(result);
  },
  scorers: [QuerySimilarity, Levenshtein],
});
