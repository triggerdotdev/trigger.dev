import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { measureTSQLNesting } from "@internal/tsql";
import { describe, expect, it } from "vitest";
import { watchBlockedReasons } from "~/components/alerts/queryAlertLink";
import { querySchemas } from "~/v3/querySchemas";
import {
  analyzeQueryForAlert,
  queryAlertAnalysisSchema,
  toQuerySignal,
  type AnalyzeQueryContext,
  type QueryAlertAnalysis,
} from "./analyzeQueryForAlert.server";

const ctx: AnalyzeQueryContext = { tableSchemas: querySchemas, flags: {} };
const queueCtx: AnalyzeQueryContext = {
  tableSchemas: querySchemas,
  flags: { QUEUE_METRICS: true },
};

const analyze = (query: string, context = ctx) => {
  const analysis = analyzeQueryForAlert(query, context);
  expect(queryAlertAnalysisSchema.parse(analysis)).toEqual(analysis);
  return analysis;
};
const threshold = (a: QueryAlertAnalysis) => a.modes.find((m) => m.mode === "threshold");
const match = (a: QueryAlertAnalysis) => a.modes.find((m) => m.mode === "match");
const unsupportedCode = (a: QueryAlertAnalysis, mode: string) =>
  a.unsupported.find((u) => u.mode === mode)?.code;
const errorCodes = (a: QueryAlertAnalysis) => a.errors.map((e) => e.code);

describe("analyzeQueryForAlert: threshold shapes", () => {
  it.each([
    {
      name: "scalar count",
      query: "SELECT count() AS failures FROM runs WHERE status = 'Failed'",
      measures: ["failures"],
      absence: true,
    },
    {
      name: "scalar countIf",
      query: "SELECT countIf(status = 'Failed') AS failed FROM runs",
      measures: ["failed"],
      absence: true,
    },
    {
      name: "scalar sum of an event count column",
      query: "SELECT sum(count) AS occurrences FROM error_occurrences",
      measures: ["occurrences"],
      absence: true,
    },
    {
      name: "scalar avg is not count-like",
      query: "SELECT avg(usage_duration) AS duration FROM runs",
      measures: ["duration"],
      absence: false,
    },
    {
      name: "scalar sum of a non-count column",
      query: "SELECT sum(attempt_count) AS attempts FROM runs",
      measures: ["attempts"],
      absence: false,
    },
    {
      name: "scalar with several measures",
      query: "SELECT avg(usage_duration) AS duration, count() AS total FROM runs",
      measures: ["duration", "total"],
      absence: true,
    },
    {
      name: "scalar over a FROM-subquery",
      query: "SELECT count() AS c FROM (SELECT run_id FROM runs WHERE status = 'Failed')",
      measures: ["c"],
      absence: true,
    },
    {
      name: "scalar count whose HAVING can drop the row",
      query: "SELECT count() AS c FROM runs HAVING count() < 10",
      measures: ["c"],
      absence: false,
    },
    {
      name: "scalar over an outer aggregate of a UNION",
      query:
        "SELECT sum(c) AS c FROM (SELECT count() AS c FROM runs UNION ALL SELECT count() AS c FROM runs WHERE status = 'Failed')",
      measures: ["c"],
      absence: false,
    },
  ])("$name", ({ query, measures, absence }) => {
    const a = analyze(query);
    expect(a.errors).toEqual([]);
    expect(a.ok).toBe(true);
    const mode = threshold(a);
    expect(mode).toMatchObject({ mode: "threshold", shape: "scalar", groupColumns: [] });
    expect(mode && "measures" in mode && mode.measures.map((m) => m.column)).toEqual(measures);
    expect(mode && "absenceAllowed" in mode && mode.absenceAllowed).toBe(absence);
    if (!absence) expect(unsupportedCode(a, "absence")).toBe("not_count_like");
    expect(unsupportedCode(a, "match")).toBe("aggregated");
    expect(a.columns.filter((c) => c.role === "measure").map((c) => c.name)).toEqual(measures);
  });

  it("grouped threshold lists group columns and never allows absence", () => {
    const a = analyze(
      "SELECT task_identifier, queue, count() AS failures FROM runs WHERE status = 'Failed' GROUP BY task_identifier, queue"
    );
    expect(a.ok).toBe(true);
    expect(threshold(a)).toMatchObject({
      shape: "grouped",
      groupColumns: ["task_identifier", "queue"],
      measures: [{ column: "failures", type: "UInt64", countLike: true }],
      absenceAllowed: false,
    });
    expect(a.columns.map((c) => c.role)).toEqual(["group", "group", "measure"]);
    expect(a.suggestedName).toBe("failures on runs by task_identifier, queue");
  });

  it("accepts a positional UNION grouped by a non-time column", () => {
    const a = analyze(
      "SELECT s, count() AS c FROM (SELECT status AS s FROM runs UNION ALL SELECT status FROM runs) GROUP BY s"
    );
    expect(a.errors).toEqual([]);
    expect(threshold(a)).toMatchObject({ shape: "grouped", groupColumns: ["s"] });
  });

  it.each([
    {
      query:
        "SELECT minIf(metric_value, metric_name = 'api.rate_limit.remaining_min') AS lowest_remaining, maxIf(metric_value, metric_name = 'api.rate_limit.limit.burst') AS burst, round(lowest_remaining / burst * 100, 1) AS lowest_headroom_pct FROM metrics WHERE metric_name LIKE 'api.rate_limit.%'",
      measures: ["lowest_remaining", "burst", "lowest_headroom_pct"],
    },
    {
      query:
        "SELECT countDistinct(bucket_start) AS active_buckets, uniqExactIf(bucket_start, metric_name = 'api.rate_limit.denied') AS limited_buckets, round(limited_buckets / active_buckets * 100, 1) AS limited_pct, limited_buckets * 10 AS seconds_limited FROM metrics WHERE metric_name LIKE 'api.rate_limit.%'",
      measures: ["active_buckets", "limited_buckets", "limited_pct", "seconds_limited"],
    },
  ])("treats expressions over aggregate aliases as measures: $measures", ({ query, measures }) => {
    const a = analyze(query);
    expect(a.ok).toBe(true);
    expect(threshold(a)).toMatchObject({ shape: "scalar" });
    expect(a.columns.filter((c) => c.role === "measure").map((c) => c.name)).toEqual(measures);
  });

  it.each([
    {
      query: "SELECT f / c AS rate, count() AS c, countIf(status = 'Failed') AS f FROM runs",
      measures: ["rate", "c", "f"],
    },
    { query: "SELECT count() AS Total, total * 2 AS d FROM runs", measures: ["Total", "d"] },
    {
      query: "SELECT sum(c) AS status, status * 100 AS pct FROM (SELECT count() AS c FROM runs)",
      measures: ["status", "pct"],
    },
  ])("resolves aggregate aliases like TSQL: $query", ({ query, measures }) => {
    const a = analyze(query);
    expect(a.ok).toBe(true);
    expect(a.columns.filter((c) => c.role === "measure").map((c) => c.name)).toEqual(measures);
  });

  it("never treats a case-colliding alias as an aggregate alias", () => {
    const a = analyze(
      "SELECT task_identifier, attempt_count AS c, count() AS C, c * 2 AS d FROM runs GROUP BY task_identifier, c"
    );
    expect(a.columns.filter((c) => c.role === "measure").map((c) => c.name)).toEqual(["C"]);
  });

  it("does not demand aggregate-alias expressions in GROUP BY", () => {
    const a = analyze(
      "SELECT task_identifier, count() AS c, countIf(status = 'Failed') AS f, f / c AS rate FROM runs GROUP BY task_identifier"
    );
    expect(a.ok).toBe(true);
    expect(threshold(a)).toMatchObject({ shape: "grouped", groupColumns: ["task_identifier"] });
    expect(a.columns.filter((c) => c.role === "measure").map((c) => c.name)).toEqual([
      "c",
      "f",
      "rate",
    ]);
  });

  it("carries the column format of a measure", () => {
    const a = analyze(
      "SELECT task_identifier, avg(usage_duration) AS d FROM runs GROUP BY task_identifier"
    );
    expect(threshold(a)).toMatchObject({ measures: [{ column: "d", format: "duration" }] });
  });

  it.each([
    "SELECT timeBucket() AS t, count() AS c FROM runs GROUP BY t",
    "SELECT task_identifier, count() AS c FROM runs GROUP BY task_identifier, timeBucket()",
    "SELECT toStartOfHour(triggered_at) AS h, count() AS c FROM runs GROUP BY h",
    "SELECT triggered_at, count() AS c FROM runs GROUP BY triggered_at",
    "SELECT minute, sum(count) AS c FROM error_occurrences GROUP BY minute",
    "SELECT h, count() AS c FROM (SELECT toStartOfHour(triggered_at) AS h FROM runs) GROUP BY h",
    "SELECT h, count() AS c FROM (SELECT triggered_at AS h FROM runs) GROUP BY h",
    "SELECT toHour(triggered_at) AS h, count() AS c FROM (SELECT * FROM runs) GROUP BY h",
    "SELECT toHour(triggered_at) AS h, count() AS c FROM runs GROUP BY h",
    "SELECT toDayOfWeek(completed_at) AS d, count() AS c FROM runs GROUP BY d",
    "SELECT toMinute(x.triggered_at) AS m, count() AS c FROM (SELECT x.* FROM runs AS x) AS x GROUP BY m",
  ])("rejects GROUP BY on time: %s", (query) => {
    const a = analyze(query);
    expect(a.ok).toBe(false);
    expect(unsupportedCode(a, "threshold")).toBe("group_by_time");
  });

  it.each([
    {
      query: "SELECT count() AS c FROM runs UNION ALL SELECT count() AS c FROM runs",
      code: "union_aggregate",
    },
    { query: "SELECT task_identifier, count() AS c FROM runs", code: "mixed_aggregates" },
    {
      query: "SELECT task_identifier AS t, upper(t) AS u, count() AS c FROM runs",
      code: "mixed_aggregates",
    },
    {
      query: "SELECT max(metric_value) AS metric_value, metric_value * 100 AS pct FROM metrics",
      code: "mixed_aggregates",
    },
    {
      query: "SELECT count() AS c, sum(attempt_count) AS C, c * 2 AS d FROM runs",
      code: "mixed_aggregates",
    },
    { query: "SELECT count() AS c FROM runs GROUP BY status", code: "group_by_unprojected" },
    {
      query: "SELECT status, count() AS c FROM runs GROUP BY status, task_identifier",
      code: "group_by_unprojected",
    },
    {
      query: "SELECT task_identifier FROM runs GROUP BY task_identifier",
      code: "no_numeric_measure",
    },
    { query: "SELECT max(triggered_at) AS last FROM runs", code: "no_numeric_measure" },
    {
      query:
        "SELECT task_identifier, count() AS c, rank() OVER (ORDER BY c) AS r FROM runs GROUP BY task_identifier",
      code: "ranked",
    },
    { query: "SELECT run_id, completed_at FROM runs", code: "rows_need_aggregate" },
  ])("threshold unsupported: $code", ({ query, code }) => {
    const a = analyze(query);
    expect(a.errors).toEqual([]);
    expect(threshold(a)).toBeUndefined();
    expect(unsupportedCode(a, "threshold")).toBe(code);
    expect(a.unsupported.find((u) => u.code === code)?.message.length).toBeGreaterThan(10);
  });
});

describe("analyzeQueryForAlert: match", () => {
  it.each([
    {
      name: "bare id and event column",
      query: "SELECT run_id, completed_at, status FROM runs WHERE status = 'Failed'",
      sourceId: "runs",
      rowId: "run_id",
      event: "completed_at",
    },
    {
      name: "aliased columns",
      query: "SELECT r.run_id AS id, r.completed_at AS finished FROM runs AS r",
      sourceId: "runs",
      rowId: "id",
      event: "finished",
    },
    {
      name: "through a FROM-subquery",
      query:
        "SELECT run_id, completed_at FROM (SELECT run_id, completed_at, status FROM runs WHERE status = 'Failed')",
      sourceId: "runs",
      rowId: "run_id",
      event: "completed_at",
    },
    {
      name: "through an aliased FROM-subquery",
      query:
        "SELECT x.id AS id, x.at AS at FROM (SELECT run_id AS id, completed_at AS at FROM runs) AS x",
      sourceId: "runs",
      rowId: "id",
      event: "at",
    },
    {
      name: "UNION branches that agree",
      query:
        "SELECT run_id, completed_at FROM runs WHERE status = 'Failed' UNION ALL SELECT run_id, completed_at FROM runs WHERE status = 'Crashed'",
      sourceId: "runs",
      rowId: "run_id",
      event: "completed_at",
    },
    {
      name: "llm_metrics spans",
      query: "SELECT span_id, start_time, response_model FROM llm_metrics WHERE total_cost > 1",
      sourceId: "llm_metrics",
      rowId: "span_id",
      event: "start_time",
    },
  ])("$name", ({ query, sourceId, rowId, event }) => {
    const a = analyze(query);
    expect(a.errors).toEqual([]);
    expect(a.ok).toBe(true);
    expect(match(a)).toEqual({ mode: "match", sourceId, rowIdColumn: rowId, eventColumn: event });
    expect(a.columns.find((c) => c.role === "rowId")?.name).toBe(rowId);
    expect(unsupportedCode(a, "threshold")).toBe("rows_need_aggregate");
    expect(a.suggestedName).toBe(`New ${sourceId} rows matching the query`);
  });

  it.each([
    { query: "SELECT lower(run_id) AS id, completed_at FROM runs", code: "derived_id" },
    {
      query: "SELECT id, completed_at FROM (SELECT lower(run_id) AS id, completed_at FROM runs)",
      code: "derived_id",
    },
    {
      query:
        "SELECT run_id AS id, completed_at AS at FROM runs UNION ALL SELECT span_id AS id, start_time AS at FROM llm_metrics",
      code: "union_branches_disagree",
    },
    {
      query:
        "SELECT run_id, completed_at FROM runs UNION ALL SELECT status, completed_at FROM runs",
      code: "union_branches_disagree",
    },
    { query: "SELECT DISTINCT run_id, completed_at FROM runs", code: "distinct" },
    {
      query: "SELECT run_id, completed_at FROM runs ARRAY JOIN tags AS tag",
      code: "array_join",
    },
    { query: "SELECT run_id, status FROM runs", code: "no_event_column" },
    { query: "SELECT run_id, triggered_at FROM runs", code: "no_event_column" },
    {
      query:
        "SELECT run_id, completed_at FROM runs WHERE task_identifier IN (SELECT task_identifier FROM runs WHERE status = 'Failed')",
      code: "id_source_repeated",
    },
    {
      query:
        "SELECT a.run_id AS run_id, a.completed_at AS completed_at FROM runs AS a JOIN runs AS b ON a.root_run_id = b.run_id",
      code: "id_source_repeated",
    },
    {
      query:
        "SELECT run_id, completed_at FROM (SELECT run_id, completed_at FROM runs GROUP BY run_id, completed_at)",
      code: "aggregated",
    },
    { query: "SELECT error_type, error_message FROM error_occurrences", code: "no_row_id" },
    { query: "SELECT * FROM runs", code: "no_row_id" },
    {
      query: "SELECT x.run_id, completed_at FROM (SELECT run_id, completed_at FROM runs) AS x",
      code: "unnamed_column",
    },
    {
      query:
        "SELECT run_id, completed_at FROM (SELECT run_id, status AS run_id, completed_at FROM runs)",
      code: "no_row_id",
    },
    {
      query:
        "SELECT r.run_id AS run_id, r.completed_at AS completed_at FROM llm_metrics AS l LEFT JOIN runs AS r ON r.run_id = l.run_id",
      code: "outer_join_id",
    },
    {
      query:
        "SELECT r.run_id AS run_id, r.completed_at AS completed_at FROM runs AS r RIGHT JOIN llm_metrics AS l ON r.run_id = l.run_id",
      code: "outer_join_id",
    },
    { query: "SELECT count() AS c FROM runs", code: "aggregated" },
  ])("match unsupported: $code — $query", ({ query, code }) => {
    const a = analyze(query);
    expect(a.errors).toEqual([]);
    expect(match(a)).toBeUndefined();
    expect(unsupportedCode(a, "match")).toBe(code);
  });

  it("allows match on a JOIN when the lineage lands on its one match-capable source", () => {
    const a = analyze(
      "SELECT r.run_id AS run_id, r.completed_at AS completed_at FROM runs AS r JOIN error_occurrences AS e ON e.task_identifier = r.task_identifier"
    );
    expect(match(a)).toEqual({
      mode: "match",
      sourceId: "runs",
      rowIdColumn: "run_id",
      eventColumn: "completed_at",
    });
  });

  it("rejects match on a JOIN where no source is match-capable", () => {
    const a = analyze(
      "SELECT e.error_type AS error_type, x.task_identifier AS task FROM error_occurrences AS e JOIN errors AS x ON x.task_identifier = e.task_identifier"
    );
    expect(a.errors).toEqual([]);
    expect(match(a)).toBeUndefined();
    expect(unsupportedCode(a, "match")).toBe("no_row_id");
  });
});

describe("analyzeQueryForAlert: sources", () => {
  it("collects every JOIN source, with aliases, and takes the strictest cadence", () => {
    const a = analyze(
      "SELECT count() AS c FROM llm_metrics AS l JOIN runs AS r ON r.run_id = l.run_id"
    );
    expect(a.sources).toEqual([
      { sourceId: "llm_metrics", alias: "l" },
      { sourceId: "runs", alias: "r" },
    ]);
    expect(a.limits).toEqual({
      minCadenceSec: 600,
      maxWindowSec: 86400,
      maxGroups: 500,
      maxMatchRowsPerEval: 200,
      detailRows: 10,
    });
    expect(threshold(a)).toMatchObject({ absenceAllowed: false });
    expect(unsupportedCode(a, "absence")).toBe("source_mode");
  });

  it("collects a source read only inside an IN-subquery", () => {
    const a = analyze(
      "SELECT sum(count) AS c FROM error_occurrences WHERE task_identifier IN (SELECT task_identifier FROM runs WHERE status = 'Failed')"
    );
    expect(a.sources.map((s) => s.sourceId).sort()).toEqual(["error_occurrences", "runs"]);
    expect(a.limits.minCadenceSec).toBe(600);
  });

  it("uses the single source's floor", () => {
    expect(analyze("SELECT sum(count) AS c FROM error_occurrences").limits.minCadenceSec).toBe(300);
  });

  it("allows flagged sources only when the flag is on", () => {
    const query = "SELECT queue, max(max_queued) AS queued FROM concurrency_metrics GROUP BY queue";
    expect(errorCodes(analyze(query))).toEqual(["source_disabled"]);
    const on = analyze(query, queueCtx);
    expect(on.ok).toBe(true);
    expect(threshold(on)).toMatchObject({ shape: "grouped", groupColumns: ["queue"] });
  });
});

describe("analyzeQueryForAlert: errors", () => {
  it.each([
    {
      query: "SELECT count() AS c FROM runs WHERE task_identifier = {{task}}",
      code: "placeholder",
    },
    {
      query: "SELECT count() AS c FROM runs WHERE task_identifier = '{{task}}'",
      code: "placeholder",
    },
    { query: "SELECT count() AS c FROM runs LIMIT 10", code: "limit" },
    {
      query: "SELECT run_id, completed_at FROM runs ORDER BY completed_at LIMIT 10 OFFSET 5",
      code: "limit",
    },
    {
      query: "SELECT run_id, completed_at FROM runs ORDER BY completed_at LIMIT 3 WITH TIES",
      code: "limit",
    },
    { query: "SELECT count() AS c FROM (SELECT run_id FROM runs LIMIT 10)", code: "limit" },
    { query: "SELECT run_id FROM runs LIMIT 1 BY task_identifier", code: "parse_error" },
    {
      query:
        "SELECT run_id, completed_at AS done FROM runs WHERE greater(done, now() - INTERVAL 1 HOUR)",
      code: "window_column_filter",
    },
    {
      query:
        "SELECT count() AS c FROM (SELECT status AS t FROM runs UNION ALL SELECT * FROM (SELECT triggered_at FROM runs)) WHERE greater(t, now())",
      code: "union_star_unverifiable",
    },
    {
      query:
        "SELECT count() AS c FROM (SELECT * FROM (SELECT status FROM runs) UNION ALL SELECT triggered_at AS status FROM runs) WHERE greater(status, now())",
      code: "union_star_unverifiable",
    },
    {
      query:
        "SELECT count() AS c FROM (SELECT * FROM runs) WHERE greater(triggered_at, now() - INTERVAL 1 HOUR)",
      code: "window_column_filter",
    },
    {
      query:
        "SELECT count() AS c FROM (SELECT triggered_at AS t FROM runs) WHERE greater(t, now() - INTERVAL 1 HOUR)",
      code: "window_column_filter",
    },
    {
      query:
        "SELECT task_identifier, count() AS c FROM runs GROUP BY task_identifier HAVING greater(max(triggered_at), now() - INTERVAL 1 HOUR)",
      code: "window_column_filter",
    },
    {
      query:
        "SELECT count() AS c FROM runs AS a JOIN runs AS b ON a.run_id = b.root_run_id AND greater(b.triggered_at, now() - INTERVAL 1 HOUR)",
      code: "window_column_filter",
    },
    {
      query: "SELECT count() AS c FROM runs WHERE triggered_at > now() - INTERVAL 1 HOUR",
      code: "window_column_filter",
    },
    {
      query: "SELECT run_id, completed_at FROM runs WHERE completed_at > now() - INTERVAL 1 HOUR",
      code: "window_column_filter",
    },
    {
      query:
        "SELECT count() AS c FROM runs JOIN error_occurrences AS e ON e.task_identifier = runs.task_identifier WHERE e.minute > now() - INTERVAL 1 HOUR",
      code: "window_column_filter",
    },
    {
      query:
        "SELECT count() AS c FROM (SELECT run_id FROM runs WHERE triggered_at > now() - INTERVAL 1 HOUR)",
      code: "window_column_filter",
    },
    { query: "SELECT count() AS c FROM llm_models", code: "not_alert_source" },
    { query: "SELECT count() AS c FROM concurrency_metrics_by_key", code: "not_alert_source" },
    {
      query:
        "SELECT count() AS c FROM llm_metrics JOIN llm_models AS m ON m.response_model = llm_metrics.response_model",
      code: "not_alert_source",
    },
    {
      query:
        "SELECT count() AS c FROM llm_metrics WHERE response_model IN (SELECT response_model FROM llm_models)",
      code: "not_alert_source",
    },
    { query: "SELECT count() AS c FROM nope", code: "unknown_table" },
    {
      query: "SELECT count() AS c FROM runs JOIN nope ON nope.id = runs.run_id",
      code: "unknown_table",
    },
    { query: "SELECT 1 AS one", code: "no_sources" },
    { query: "SELEKT count() FROM runs", code: "parse_error" },
    { query: "SELECT count() AS c, count() AS c FROM runs", code: "duplicate_columns" },
    { query: "SELECT nope_column FROM runs", code: "invalid_query" },
  ])("$code — $query", ({ query, code }) => {
    const a = analyze(query);
    expect(a.ok).toBe(false);
    expect(a.modes).toEqual([]);
    expect(errorCodes(a)).toContain(code);
    expect(a.errors.every((e) => e.message.length > 10)).toBe(true);
  });

  it("names the window column in the message", () => {
    const a = analyze("SELECT count() AS c FROM runs WHERE triggered_at > now() - INTERVAL 1 HOUR");
    expect(a.errors[0]!.message).toBe(
      "Remove the filter on triggered_at: the alert window owns time."
    );
  });

  it("rejects CTEs with the TRQL message for every mode", () => {
    const a = analyze(
      "WITH x AS (SELECT run_id, completed_at FROM runs) SELECT run_id, completed_at FROM x"
    );
    expect(a.ok).toBe(false);
    expect(a.unsupported).toEqual(
      ["threshold", "absence", "match"].map((mode) => ({
        mode,
        code: "cte",
        message: "TRQL does not support CTEs yet.",
      }))
    );
  });

  it("falls back to the query text for the name", () => {
    expect(analyze("SELECT  count()   FROM llm_models").suggestedName).toBe(
      "SELECT count() FROM llm_models"
    );
  });
});

describe("toQuerySignal", () => {
  it("scalar threshold and absence", () => {
    const a = analyze("SELECT count() AS failures FROM runs WHERE status = 'Failed'");
    expect(toQuerySignal(a, { mode: "threshold" })).toEqual({
      ok: true,
      signal: {
        v: 1,
        sources: [{ sourceId: "runs", windowColumn: "triggered_at" }],
        mode: "threshold",
        measure: "failures",
      },
    });
    expect(toQuerySignal(a, { mode: "absence" })).toMatchObject({
      ok: true,
      signal: { mode: "absence", measure: "failures" },
    });
  });

  it("requires a measure choice when there are several", () => {
    const a = analyze("SELECT avg(usage_duration) AS duration, count() AS total FROM runs");
    expect(toQuerySignal(a, { mode: "threshold" })).toMatchObject({ ok: false });
    expect(toQuerySignal(a, { mode: "threshold", measure: "duration" })).toMatchObject({
      ok: true,
      signal: { measure: "duration" },
    });
    expect(toQuerySignal(a, { mode: "absence", measure: "duration" })).toMatchObject({ ok: false });
    expect(toQuerySignal(a, { mode: "absence", measure: "total" })).toMatchObject({ ok: true });
    expect(toQuerySignal(a, { mode: "threshold", measure: "nope" })).toMatchObject({ ok: false });
  });

  it("grouped threshold windows every source on its own column", () => {
    const a = analyze(
      "SELECT e.task_identifier AS task, sum(e.count) AS c FROM error_occurrences AS e JOIN runs AS r ON r.task_identifier = e.task_identifier GROUP BY task"
    );
    expect(toQuerySignal(a, { mode: "threshold" })).toEqual({
      ok: true,
      signal: {
        v: 1,
        sources: [
          { sourceId: "error_occurrences", windowColumn: "minute" },
          { sourceId: "runs", windowColumn: "triggered_at" },
        ],
        mode: "threshold",
        measure: "c",
        groupColumns: ["task"],
      },
    });
  });

  it("match windows the id source on its event column", () => {
    const a = analyze("SELECT run_id, completed_at FROM runs WHERE status = 'Failed'");
    expect(toQuerySignal(a, { mode: "match" })).toEqual({
      ok: true,
      signal: {
        v: 1,
        sources: [{ sourceId: "runs", windowColumn: "completed_at" }],
        mode: "match",
        rowId: { sourceId: "runs", column: "run_id", eventColumn: "completed_at" },
      },
    });
    expect(toQuerySignal(a, { mode: "threshold" })).toMatchObject({ ok: false });
  });

  it("refuses an invalid analysis", () => {
    expect(
      toQuerySignal(analyze("SELECT count() FROM runs LIMIT 1"), { mode: "threshold" })
    ).toMatchObject({
      ok: false,
    });
  });
});

describe("analyzeQueryForAlert: nesting guard", () => {
  const chain = (n: number, open = "abs(") => `${open.repeat(n)}1${")".repeat(n)}`;
  const nested = (open: string, n: number) =>
    `SELECT count() AS c FROM runs WHERE ${chain(n, open)} = 1`;
  const rejectsFast = (query: string, code: string, message: string) => {
    const a = analyze(query);
    expect(a.ok).toBe(false);
    expect(a.modes).toEqual([]);
    expect(a.errors).toEqual([{ code, message }]);
    expect(a.unsupported.map((u) => u.code)).toEqual([code, code, code]);
  };
  const tooDeep = (query: string) =>
    rejectsFast(query, "too_deeply_nested", "Query is too deeply nested");

  it.each([
    { name: "13-deep parens", query: nested("(", 13) },
    { name: "13-deep calls", query: nested("abs(", 13) },
    {
      name: "a call chain after a // comment",
      query: `SELECT count() AS c FROM runs // '\nWHERE ${chain(33)} = 1 -- '`,
    },
    {
      name: "a call chain inside an f-string",
      query: `SELECT count() AS c FROM runs WHERE status = f'{${chain(33)}}'`,
    },
    {
      name: "a call chain inside tag text",
      query: `SELECT count() AS c FROM runs WHERE status = <a>'{${chain(33)}}'</a>`,
    },
  ])("rejects $name before parsing", ({ query }) => tooDeep(query));

  it("rejects many sibling chains under the depth limit as too complex", () => {
    rejectsFast(
      `SELECT count() AS c FROM runs WHERE ${Array(48).fill(chain(12)).join(" + ")} = 1`,
      "too_complex",
      "Query is too complex to watch"
    );
  });

  it.each([
    {
      name: "128 NOTs",
      code: "too_deeply_nested",
      query: `SELECT count() AS c FROM runs WHERE ${"NOT ".repeat(128)}status = 'x'`,
    },
    {
      name: "64 nested CASEs",
      code: "too_deeply_nested",
      query: `SELECT count() AS c FROM runs WHERE ${"CASE WHEN 1 = 1 THEN ".repeat(64)}1${" END".repeat(64)} = 1`,
    },
    {
      name: "a 100-part dotted name",
      code: "too_complex",
      query: `SELECT count() AS c FROM runs WHERE a${".b".repeat(100)} = 1`,
    },
    {
      name: "60 unrecognized characters",
      code: "too_complex",
      query: `SELECT count() AS c FROM runs WHERE status = ${"@".repeat(60)}`,
    },
    {
      name: "40 BETWEEN terms",
      code: "too_complex",
      query: `SELECT count() AS c FROM runs WHERE ${Array(40).fill("attempt_count BETWEEN 1 AND 2").join(" AND ")}`,
    },
    {
      name: "a 190-deep lambda chain",
      code: "too_complex",
      query: `SELECT count() AS c FROM runs WHERE has(arrayMap(${"x -> ".repeat(190)}1, tags), 1)`,
    },
    {
      name: "190 nested INTERVALs",
      code: "too_complex",
      query: `SELECT count() AS c FROM runs WHERE started_at > ${"INTERVAL ".repeat(190)}1${" DAY".repeat(190)}`,
    },
    {
      name: "79 right-nested NOTs",
      code: "too_complex",
      query: `SELECT count() AS c FROM runs WHERE ${"NOT a = ".repeat(79)}1`,
    },
    {
      name: "11 calls around an 88-term AND chain",
      code: "too_complex",
      query: `SELECT count() AS c FROM runs WHERE ${"abs(".repeat(11)}${Array(88).fill("x = 1").join(" AND ")}${")".repeat(11)} = 1`,
    },
    {
      name: "12 BETWEENs before 75 AND terms",
      code: "too_complex",
      query: `SELECT count() AS c FROM runs WHERE ${Array(12).fill("x BETWEEN 1 AND 2").join(" AND ")} AND ${Array(75).fill("x = 1").join(" AND ")}`,
    },
    {
      name: "12 CASEs with an end column before THEN",
      code: "too_complex",
      query: `SELECT count() AS c FROM runs WHERE ${"CASE WHEN end = 1 AND ".repeat(12)}${Array(60).fill("x = 1").join(" AND ")}${" THEN 1 END".repeat(12)} = 1`,
    },
    {
      name: "470 AND terms",
      code: "too_complex",
      query: `SELECT count() AS c FROM runs WHERE ${Array(470).fill("status = 'x'").join(" AND ")}`,
    },
  ])("rejects $name before parsing", ({ code, query }) =>
    rejectsFast(
      query,
      code,
      code === "too_complex" ? "Query is too complex to watch" : "Query is too deeply nested"
    )
  );

  it.each([
    "SELECT count() AS c FROM runs WHERE NOT queue IS NULL",
    "SELECT countIf(CASE WHEN status = 'Failed' THEN 1 ELSE 0 END = 1) AS c FROM runs",
    "SELECT count() AS c FROM runs AS r WHERE r.output.data.x = 1",
    "SELECT count() AS c FROM runs WHERE attempt_count - 1 > -1",
    "SELECT count() AS c FROM runs WHERE attempt_count BETWEEN 1 AND 2 AND attempt_count NOT BETWEEN 3 AND 4",
    "SELECT count() AS c FROM runs WHERE executed_at > now() - INTERVAL 1 DAY",
    `SELECT count() AS c FROM runs WHERE ${Array(20).fill("queue IS NOT NULL").join(" AND ")}`,
    `SELECT count() AS c FROM runs WHERE ${Array(73).fill("queue != 'x'").join(" AND ")}`,
  ])("analyzes %s", (query) => {
    expect(analyze(query).ok).toBe(true);
  });

  it.each([
    { query: "SELECT CASE WHEN a THEN b ELSE c END AS x FROM runs", depth: 1 },
    { query: "SELECT CASE WHEN a THEN end ELSE c END AS x FROM runs", depth: 1 },
    { query: "SELECT CASE WHEN a THEN CASE WHEN b THEN end END END AS x FROM runs", depth: 2 },
    {
      query: "SELECT CASE WHEN a THEN 1 END + abs(CASE WHEN b THEN 1 END) AS x FROM runs",
      depth: 2,
    },
  ])("measures CASE depth in $query", ({ query, depth }) => {
    expect(measureTSQLNesting(query).maxDepth).toBe(depth);
  });

  it("passes an end column through to the compiler", () => {
    expect(measureTSQLNesting("SELECT end FROM runs WHERE end > 1")).toMatchObject({ maxDepth: 0 });
    expect(errorCodes(analyze("SELECT end FROM runs WHERE end > 1"))).toEqual(["invalid_query"]);
  });

  it("passes a lambda through to the compiler", () => {
    const a = analyze("SELECT count() AS c FROM runs WHERE arrayCount(x -> x = 'a', tags) > 0");
    expect(errorCodes(a)).toEqual(["invalid_query"]);
  });

  it.each(["(", "abs("])("analyzes 12-deep %s nesting", (open) => {
    expect(threshold(analyze(nested(open, 12)))).toMatchObject({ measures: [{ column: "c" }] });
  });

  it("analyzes a query with a few nested calls and a 10-item IN list", () => {
    const tasks = Array.from({ length: 10 }, (_, i) => `'task-${i}'`).join(", ");
    const a = analyze(
      `SELECT countIf(status = 'Failed') AS failed, round(avg(coalesce(usage_duration, 0)), 2) AS duration FROM runs WHERE task_identifier IN (${tasks}) AND lower(trim(queue)) != 'x'`
    );
    expect(a.ok).toBe(true);
    expect(threshold(a)?.measures.map((m) => m.column)).toContain("failed");
  });

  it.each([
    {
      name: "a string literal",
      query: `SELECT count() AS c FROM runs WHERE status = '${"(".repeat(100)}'`,
    },
    { name: "a block comment", query: `SELECT count() AS c FROM runs /* ${"((((".repeat(10)} */` },
  ])("ignores brackets in $name", ({ query }) => {
    expect(measureTSQLNesting(query).maxDepth).toBe(1);
    expect(analyze(query).ok).toBe(true);
  });
});

describe("analyzeQueryForAlert: query shape table", () => {
  it.each([
    {
      name: "min/max If with alias arithmetic",
      query:
        "SELECT minIf(metric_value, metric_name = 'api.rate_limit.remaining_min') AS lowest_remaining, maxIf(metric_value, metric_name = 'api.rate_limit.limit.burst') AS burst, round(lowest_remaining / burst * 100, 1) AS lowest_headroom_pct FROM metrics WHERE metric_name LIKE 'api.rate_limit.%'",
      measures: ["lowest_remaining", "burst", "lowest_headroom_pct"],
    },
    {
      name: "distinct counts with chained aliases",
      query:
        "SELECT countDistinct(bucket_start) AS active_buckets, uniqExactIf(bucket_start, metric_name = 'api.rate_limit.denied') AS limited_buckets, round(limited_buckets / active_buckets * 100, 1) AS limited_pct, limited_buckets * 10 AS seconds_limited FROM metrics WHERE metric_name LIKE 'api.rate_limit.%'",
      measures: ["active_buckets", "limited_buckets", "limited_pct", "seconds_limited"],
    },
    {
      name: "HAVING over an aggregate alias",
      query: "SELECT task_identifier, count() AS c FROM runs GROUP BY task_identifier HAVING c > 5",
      measures: ["c"],
      shape: "grouped",
    },
    {
      name: "ORDER BY without LIMIT",
      query: "SELECT count() AS c FROM runs ORDER BY c DESC",
      measures: ["c"],
    },
    {
      name: "IN list filter",
      query:
        "SELECT count() AS runs FROM runs WHERE status = 'COMPLETED_WITH_ERRORS' AND task_identifier IN ('a','b')",
      measures: ["runs"],
    },
    {
      name: "parametric quantile",
      query: "SELECT quantile(0.95)(usage_duration) AS p95 FROM runs WHERE task_identifier = 'x'",
      measures: ["p95"],
    },
    {
      name: "division of aggregates",
      query:
        "SELECT countIf(status = 'COMPLETED_WITH_ERRORS') / count() * 100 AS failure_pct FROM runs",
      measures: ["failure_pct"],
    },
  ])("accepts $name", ({ query, measures, shape }) => {
    const a = analyze(query);
    expect(a.errors).toEqual([]);
    expect(a.ok).toBe(true);
    expect(threshold(a)?.measures.map((m) => m.column)).toEqual(measures);
    if (shape) expect(threshold(a)?.shape).toBe(shape);
  });

  it("rejects grouping by a time bucket with the time-grouping reason", () => {
    const a = analyze(
      "SELECT toStartOfMinute(bucket_start) AS m, count() AS c FROM metrics GROUP BY m LIMIT 1000"
    );
    expect(a.errors.map((e) => e.code)).toEqual(["limit"]);
    const noLimit = analyze(
      "SELECT toStartOfMinute(bucket_start) AS m, count() AS c FROM metrics GROUP BY m"
    );
    expect(noLimit.ok).toBe(false);
    expect(noLimit.unsupported.find((u) => u.mode === "threshold")).toEqual({
      mode: "threshold",
      code: "group_by_time",
      message: "Remove time buckets from GROUP BY: the alert evaluates one window at a time.",
    });
  });

  it("leads with the real reason, not the new-row mismatch", () => {
    const grouped = analyze(
      "SELECT toStartOfMinute(bucket_start) AS m, count() AS c FROM metrics GROUP BY m"
    );
    expect(watchBlockedReasons(grouped, "q")[0]).toMatch(/time buckets/);
    const rows = analyze("SELECT run_id FROM runs LIMIT 5");
    expect(watchBlockedReasons(rows, "q")[0]).toMatch(/LIMIT/);
  });

  it("shows the aggregate requirement, not row-id advice, for a threshold-only source", () => {
    const a = analyze("SELECT metric_name FROM metrics");
    expect(a.unsupported.some((u) => u.mode === "match")).toBe(true);
    expect(watchBlockedReasons(a, "q")).toEqual([
      "Threshold alerts need an aggregate such as count() or avg().",
    ]);
  });

  it("does not offer new-row alerts for SELECT *", () => {
    const a = analyze("SELECT * FROM runs WHERE status='FAILED'");
    expect(match(a)).toBeUndefined();
  });
});

describe("import boundary", () => {
  it("nothing under queryAlerts/ imports the dashboard agent", () => {
    const dir = __dirname;
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = readFileSync(join(dir, file), "utf8");
      expect(source, file).not.toMatch(
        /from\s+["'](@internal\/dashboard-agent|~\/components\/dashboard-agent)/
      );
      expect(source, file).not.toMatch(
        /import\(\s*["'](@internal\/dashboard-agent|~\/components\/dashboard-agent)/
      );
    }
  });
});
