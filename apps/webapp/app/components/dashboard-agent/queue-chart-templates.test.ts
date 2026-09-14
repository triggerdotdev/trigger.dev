import { compileTSQL } from "@internal/tsql";
import {
  KEY_LIST_PLACEHOLDER,
  QUEUE_CHART_TEMPLATES,
  QUEUE_TEMPLATE_PLACEHOLDER,
} from "@internal/dashboard-agent/tool-schemas";
import { describe, expect, it } from "vitest";
import { querySchemas } from "~/v3/querySchemas";

const to = new Date("2026-09-09T12:00:00Z");
const from = new Date("2026-09-09T06:00:00Z");

const QUANTILES = "quantilesMerge(0.5, 0.9, 0.95, 0.99)(wait_quantiles)";

/**
 * The aggregate each chart must compile to. A gauge read with sum(), or a counter delta
 * read with anything but deltaSumTimestampMerge, is a wrong number rather than an error —
 * so the prompt's rules are pinned here per chart.
 */
const EXPECTED_AGGREGATES: Record<string, string[]> = {
  Concurrency: ["max(max_running) AS running", "max(max_limit) AS limit"],
  "Queue depth": ["max(max_queued) AS queued"],
  Throughput: [
    "deltaSumTimestampMerge(enqueue_delta) AS enqueued",
    "deltaSumTimestampMerge(started_delta) AS started",
  ],
  "Scheduling delay": [
    `round(${QUANTILES}[1]) AS p50`,
    `round(${QUANTILES}[3]) AS p95`,
    `round(${QUANTILES}[4]) AS p99`,
  ],
  Throttled: ["sum(throttled_count) AS throttled"],
  "Keys with backlog": ["max(max_ck_backlogged) AS keys"],
  "Worst key wait": ["max(max_ck_wait_ms) AS wait"],
  "Waiting runs by key": ["max(max_queued) AS waiting"],
  "Throughput by key": ["deltaSumTimestampMerge(started_delta) AS started"],
};

function compile(query: string, fillGaps: boolean) {
  return compileTSQL(
    query
      .replaceAll(QUEUE_TEMPLATE_PLACEHOLDER, "my-queue")
      .replace(KEY_LIST_PLACEHOLDER, "'tenant-1', 'tenant-2'"),
    {
      tableSchema: querySchemas,
      enforcedWhereClause: {
        organization_id: { op: "eq", value: "org_123" },
        project_id: { op: "eq", value: "proj_123" },
        environment_id: { op: "eq", value: "env_123" },
        bucket_start: { op: "gte", value: from },
      },
      timeRange: { from, to },
      fillGaps,
    }
  );
}

describe("queue chart templates", () => {
  it("keeps the queue page's nine charts", () => {
    expect(QUEUE_CHART_TEMPLATES).toHaveLength(9);
    expect(Object.keys(EXPECTED_AGGREGATES).sort()).toEqual(
      QUEUE_CHART_TEMPLATES.map((t) => t.title).sort()
    );
  });

  for (const template of QUEUE_CHART_TEMPLATES) {
    // The prompt's queries are only as good as the schema they name: compiling each one
    // turns a typo'd column or aggregate into a failing test instead of a broken chart.
    it(`compiles "${template.title}"`, () => {
      const fillGaps = template.note?.includes("fillGaps true") ?? false;
      const { sql, params } = compile(template.query, fillGaps);

      expect(Object.values(params)).toContain("my-queue");
      for (const aggregate of EXPECTED_AGGREGATES[template.title]) {
        expect(sql).toContain(aggregate);
      }
      // Reading a cumulative-counter delta with sum() mixes unrelated odometers, and
      // FINAL on these pre-aggregated tables is never right.
      expect(sql).not.toMatch(/sum\(\w+_delta\)/);
      expect(sql).not.toContain("FINAL");
    });
  }

  for (const template of QUEUE_CHART_TEMPLATES.filter((t) => t.rankQuery)) {
    it(`ranks the keys for "${template.title}" before charting them`, () => {
      const { sql, params } = compile(template.rankQuery!, false);
      expect(sql).toContain("queue_metrics_ck_v1");
      expect(sql).toContain("GROUP BY concurrency_key");
      expect(sql).toContain("ORDER BY peak DESC");
      expect(Object.values(params)).toContain("my-queue");

      // The chart query is then pinned to those keys, so the row cap can't drop buckets.
      const charted = compile(template.query, false);
      expect(charted.sql).toContain("in(concurrency_key");
      expect(Object.values(charted.params)).toContain("tenant-1");
    });
  }
});
