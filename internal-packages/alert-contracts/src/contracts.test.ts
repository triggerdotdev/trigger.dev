import { describe, expect, it } from "vitest";
import {
  alertCapabilitySchema,
  conditionSchema,
  evaluationResultSchema,
  occurrenceSchema,
  occurrenceExpiresAt,
  alertEventTypeSchema,
  behaviorSchema,
  alertParamsSchema,
  notifierRefSchema,
  notifierRefKey,
  isScopeAllowed,
  compileTemplate,
  validateConditionParams,
  type AlertScopeType,
  type Behavior,
  type EvaluationResult,
} from "./schemas.js";
import {
  V1_CAPABILITIES,
  getCapability,
  listCapabilities,
  CURRENTLY_QUEUED_PREDICATE_PENDING,
} from "./registry.js";
import { QUERY_SOURCES, minCadenceForTables, modesForTables } from "./querySources.js";
import {
  displayStatus,
  transition,
  resolve,
  expire,
  stop,
  type AlertState,
  type TransitionInput,
} from "./transitions.js";

const VALID_QUERY_TABLES = [
  "runs",
  "concurrency_metrics",
  "env_metrics",
  "errors",
  "error_occurrences",
];

const VALID_ERRORS_COLUMNS = [
  "task_identifier",
  "error_fingerprint",
  "first_seen",
  "last_seen",
  "occurrence_count",
];

const VALID_ERROR_OCCURRENCES_COLUMNS = ["task_identifier", "error_fingerprint", "minute", "count"];

const VALID_RUNS_COLUMNS = [
  "run_id",
  "environment",
  "project",
  "environment_type",
  "attempt_count",
  "status",
  "is_finished",
  "task_identifier",
  "queue",
  "batch_id",
  "root_run_id",
  "parent_run_id",
  "depth",
  "is_root_run",
  "is_child_run",
  "idempotency_key",
  "idempotency_key_scope",
  "region",
  "triggered_at",
  "queued_at",
  "dequeued_at",
  "executed_at",
  "completed_at",
  "delay_until",
  "has_delay",
  "expired_at",
  "ttl",
  "execution_duration",
  "total_duration",
  "queued_duration",
  "usage_duration",
];

const VALID_QUEUE_METRICS_COLUMNS = [
  "environment",
  "project",
  "queue",
  "bucket_start",
  "enqueue_delta",
  "started_delta",
  "ack_delta",
  "nack_delta",
  "dlq_delta",
  "throttled_count",
  "max_queued",
  "max_running",
  "max_limit",
  "max_env_queued",
  "max_env_running",
  "max_env_limit",
  "max_ck_backlogged",
  "max_ck_wait_ms",
  "wait_ms_sum",
  "wait_ms_count",
  "wait_quantiles",
];

describe("schemas", () => {
  it("round-trips a valid capability", () => {
    const cap = V1_CAPABILITIES[0]!;
    expect(alertCapabilitySchema.parse(cap)).toEqual(cap);
  });

  it("round-trips a threshold condition", () => {
    const c = { kind: "threshold" as const, operator: ">" as const, value: 100, windowSec: 300 };
    expect(conditionSchema.parse(c)).toEqual(c);
  });

  it("round-trips an absence condition", () => {
    const c = { kind: "absence" as const, quietWindowSec: 1800 };
    expect(conditionSchema.parse(c)).toEqual(c);
  });

  it("rejects condition with missing required field", () => {
    expect(() => conditionSchema.parse({ kind: "threshold", value: 100 })).toThrow();
  });

  it("round-trips evaluation result", () => {
    const r = { kind: "stateful" as const, outcome: "met" as const, facts: { depth: 150 } };
    expect(evaluationResultSchema.parse(r)).toEqual(r);
  });

  it("round-trips occurrence evaluation result", () => {
    const r = {
      kind: "occurrence" as const,
      outcome: "met" as const,
      occurrences: [
        {
          sourceEventId: "e1",
          rowTime: new Date("2026-01-01T00:00:00Z"),
          expiresAt: new Date("2026-01-08T00:00:00Z"),
          facts: { fingerprint: "abc" },
        },
      ],
      nextCursor: "cur1",
      facts: {},
    };
    expect(evaluationResultSchema.parse(r)).toEqual(r);
  });

  it("rejects matched as an event type", () => {
    expect(alertEventTypeSchema.safeParse("matched").success).toBe(false);
    expect(alertEventTypeSchema.safeParse("raised").success).toBe(true);
  });

  it("occurrence requires rowTime and expiresAt", () => {
    const rowTime = "2026-01-01T00:00:00Z";
    const expiresAt = "2026-01-08T00:00:00Z";
    expect(occurrenceSchema.safeParse({ sourceEventId: "e1", expiresAt, facts: {} }).success).toBe(
      false
    );
    expect(occurrenceSchema.safeParse({ sourceEventId: "e1", rowTime, facts: {} }).success).toBe(
      false
    );
    expect(
      occurrenceSchema.safeParse({ sourceEventId: "e1", rowTime: "nope", expiresAt, facts: {} })
        .success
    ).toBe(false);
    const parsed = occurrenceSchema.parse({ sourceEventId: "e1", rowTime, expiresAt, facts: {} });
    expect(parsed.rowTime).toEqual(new Date(rowTime));
    expect(parsed.expiresAt).toEqual(new Date(expiresAt));
  });

  it("occurrence requires a non-empty sourceEventId", () => {
    const base = { rowTime: "2026-01-01T00:00:00Z", expiresAt: "2026-01-08T00:00:00Z", facts: {} };
    expect(occurrenceSchema.safeParse(base).success).toBe(false);
    expect(occurrenceSchema.safeParse({ ...base, sourceEventId: "" }).success).toBe(false);
    expect(occurrenceSchema.safeParse({ ...base, sourceEventId: "e1" }).success).toBe(true);
  });

  it("occurrenceExpiresAt adds retention to rowTime", () => {
    const rowTime = new Date("2026-01-01T00:00:00Z");
    expect(occurrenceExpiresAt(rowTime, 7 * 24 * 3600)).toEqual(new Date("2026-01-08T00:00:00Z"));
  });

  it("round-trips behavior", () => {
    const b = { expiresAt: "2099-12-01T00:00:00Z" };
    expect(behaviorSchema.parse(b)).toEqual(b);
  });

  it("behavior expiresAt must be a future ISO datetime", () => {
    const future = new Date(Date.now() + 3600_000);
    expect(behaviorSchema.safeParse({ expiresAt: future.toISOString() }).success).toBe(true);
    expect(
      behaviorSchema.safeParse({ expiresAt: future.toISOString().replace("Z", "+00:00") }).success
    ).toBe(true);
    expect(behaviorSchema.safeParse({ expiresAt: "garbage" }).success).toBe(false);
    expect(behaviorSchema.safeParse({ expiresAt: "2020-01-01T00:00:00Z" }).success).toBe(false);
  });

  it("round-trips alert params", () => {
    const p = {
      environmentId: "env_123",
      scope: { type: "queue" as const, queue: "my-queue" },
      windowSec: 600,
    };
    expect(alertParamsSchema.parse(p)).toEqual(p);
  });

  it("threshold value must be finite", () => {
    expect(() =>
      conditionSchema.parse({ kind: "threshold", operator: ">", value: Infinity, windowSec: 300 })
    ).toThrow();
    expect(() =>
      conditionSchema.parse({ kind: "threshold", operator: ">", value: NaN, windowSec: 300 })
    ).toThrow();
  });

  it("threshold windowSec must be a positive integer", () => {
    expect(() =>
      conditionSchema.parse({ kind: "threshold", operator: ">", value: 10, windowSec: 0 })
    ).toThrow();
    expect(() =>
      conditionSchema.parse({ kind: "threshold", operator: ">", value: 10, windowSec: -1 })
    ).toThrow();
    expect(() =>
      conditionSchema.parse({ kind: "threshold", operator: ">", value: 10, windowSec: 1.5 })
    ).toThrow();
  });

  it("holdSec must be a positive integer when provided", () => {
    expect(() =>
      conditionSchema.parse({
        kind: "threshold",
        operator: ">",
        value: 10,
        windowSec: 300,
        holdSec: 0,
      })
    ).toThrow();
    expect(() =>
      conditionSchema.parse({ kind: "state", stateKey: "degraded", holdSec: -5 })
    ).toThrow();
    expect(
      conditionSchema.parse({
        kind: "threshold",
        operator: ">",
        value: 10,
        windowSec: 300,
        holdSec: 60,
      })
    ).toBeDefined();
  });

  it("absence quietWindowSec must be a positive whole number", () => {
    expect(() => conditionSchema.parse({ kind: "absence", quietWindowSec: 0 })).toThrow();
    expect(() => conditionSchema.parse({ kind: "absence", quietWindowSec: 1.5 })).toThrow();
    expect(conditionSchema.parse({ kind: "absence", quietWindowSec: 600 })).toBeDefined();
  });

  it("state condition accepts params", () => {
    const c = conditionSchema.parse({
      kind: "state",
      stateKey: "degraded",
      params: { failureRatePct: 25 },
    });
    expect(c.kind).toBe("state");
    if (c.kind === "state") {
      expect(c.params).toEqual({ failureRatePct: 25 });
    }
  });

  it("state condition params must be finite", () => {
    expect(() =>
      conditionSchema.parse({
        kind: "state",
        stateKey: "degraded",
        params: { x: Infinity },
      })
    ).toThrow();
    expect(() =>
      conditionSchema.parse({
        kind: "state",
        stateKey: "degraded",
        params: { x: NaN },
      })
    ).toThrow();
  });
});

describe("compileTemplate", () => {
  it("substitutes scope and params", () => {
    const result = compileTemplate("SELECT x > {{p.threshold}} FROM t WHERE {{scope}}", "1 = 1", {
      threshold: 42,
    });
    expect(result).toBe("SELECT x > 42 FROM t WHERE 1 = 1");
  });

  it("rejects non-finite param value", () => {
    expect(() => compileTemplate("{{p.x}}", "1=1", { x: Infinity })).toThrow("not finite");
  });

  it("rejects unresolved param placeholder", () => {
    expect(() => compileTemplate("{{p.missing}}", "1=1", {})).toThrow("unresolved");
    expect(() => compileTemplate("{{p.missing}}", "1=1")).toThrow("unresolved");
  });

  it("handles param keys containing regex metacharacters", () => {
    const result = compileTemplate("SELECT {{p.rate(pct)}} FROM t WHERE {{scope}}", "1=1", {
      "rate(pct)": 99,
    });
    expect(result).toBe("SELECT 99 FROM t WHERE 1=1");
  });

  it("defaults ctx.until to the next minute and lets an explicit value win", () => {
    const t = "x >= {{ctx.checkpoint}} AND x < {{ctx.until}}";
    const ctx = { checkpoint: "'a'" };
    const sql = compileTemplate(t, "1=1", undefined, ctx);
    const until = /x < '([^']+)'$/.exec(sql)![1]!;
    expect(Date.parse(`${until.replace(" ", "T")}Z`)).toBeGreaterThan(Date.now());
    expect(compileTemplate(t, "1=1", undefined, { ...ctx, until: "'b'" })).toBe(
      "x >= 'a' AND x < 'b'"
    );
    expect(() => compileTemplate(t, "1=1")).toThrow("unresolved ctx");
  });

  it("substitutes ctx values and rejects unresolved ctx placeholders", () => {
    expect(compileTemplate("x >= {{ctx.checkpoint}}", "1=1", undefined, { checkpoint: "5" })).toBe(
      "x >= 5"
    );
    expect(() => compileTemplate("x >= {{ctx.checkpoint}}", "1=1")).toThrow("unresolved ctx");
  });

  it("no error when template has no param placeholders and no params passed", () => {
    expect(compileTemplate("SELECT 1 FROM t WHERE {{scope}}", "1=1")).toBe(
      "SELECT 1 FROM t WHERE 1=1"
    );
  });
});

describe("validateConditionParams", () => {
  const declared = [
    { key: "failureRatePct", label: "Failure rate", default: 10, min: 0, max: 100 },
    { key: "durationP95Ms", label: "Duration", default: 300000, min: 1000 },
  ];

  it("accepts valid params", () => {
    expect(() => validateConditionParams({ failureRatePct: 25 }, declared)).not.toThrow();
  });

  it("rejects unknown param key", () => {
    expect(() => validateConditionParams({ bogus: 5 }, declared)).toThrow("unknown param key");
  });

  it("rejects value below min", () => {
    expect(() => validateConditionParams({ failureRatePct: -1 }, declared)).toThrow("below min");
  });

  it("rejects value above max", () => {
    expect(() => validateConditionParams({ failureRatePct: 101 }, declared)).toThrow("above max");
  });

  it("rejects non-finite param", () => {
    expect(() => validateConditionParams({ failureRatePct: NaN }, declared)).toThrow("not finite");
  });
});

describe("registry", () => {
  it("has 16 capabilities", () => {
    expect(V1_CAPABILITIES).toHaveLength(17);
  });

  it("has unique keys", () => {
    const keys = V1_CAPABILITIES.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("all capabilities validate against schema", () => {
    for (const cap of V1_CAPABILITIES) {
      expect(() => alertCapabilitySchema.parse(cap)).not.toThrow();
    }
  });

  it("every capability declares minCadenceSec (no fallback)", () => {
    for (const cap of V1_CAPABILITIES) {
      expect(typeof cap.minCadenceSec).toBe("number");
      expect(cap.minCadenceSec).toBeGreaterThan(0);
    }
  });

  it("health.* capabilities use query bindings", () => {
    for (const cap of V1_CAPABILITIES) {
      if (cap.area === "health") {
        expect(cap.binding.type).toBe("query");
        expect(cap.signal).toBe("state");
        expect(cap.allowedKinds).toEqual(["state"]);
      }
    }
  });

  it("errors.* capabilities are exactly errors.new and errors.occurred_again", () => {
    const errorCaps = V1_CAPABILITIES.filter((c) => c.key.startsWith("errors."));
    expect(errorCaps.map((c) => c.key)).toEqual(["errors.new", "errors.occurred_again"]);
    for (const cap of errorCaps) {
      expect(cap.area).toBe("errors");
      expect(cap.allowedKinds).toEqual(["occurrence"]);
      expect(cap.binding.emit).toBe("rows");
      expect(cap.binding.ctx).toEqual(["checkpoint", "until", "after"]);
      expect(cap.binding.seriesTemplate).toBeDefined();
      expect(cap.minCadenceSec).toBe(300);
    }
  });

  it("non-errors capabilities are unchanged", () => {
    const bindings = Object.fromEntries(
      V1_CAPABILITIES.filter((c) => c.area !== "errors").map((c) => [
        c.key,
        { template: c.binding.template, table: c.binding.table, scopes: c.allowedScopes },
      ])
    );
    for (const cap of V1_CAPABILITIES.filter((c) => c.area !== "errors")) {
      expect(cap.binding.emit).toBeUndefined();
      expect(cap.binding.ctx).toBeUndefined();
      expect(cap.binding.seriesTemplate).toBeUndefined();
      expect(cap.binding.rowKey).toBeUndefined();
    }
    expect(bindings).toMatchInlineSnapshot(`
      {
        "custom.query": {
          "scopes": [
            "all",
          ],
          "table": undefined,
          "template": "",
        },
        "health.all": {
          "scopes": [
            "all",
          ],
          "table": undefined,
          "template": undefined,
        },
        "health.execution": {
          "scopes": [
            "all",
          ],
          "table": "runs",
          "template": "SELECT countIf(status IN ('CRASHED','SYSTEM_FAILURE','TIMED_OUT','COMPLETED_WITH_ERRORS')) * 100 / if(count() = 0, 1, count()) > {{p.failureRatePct}} OR quantile(0.95)(execution_duration) > {{p.durationP95Ms}} FROM runs WHERE {{scope}} AND is_finished = 1",
        },
        "health.flow": {
          "scopes": [
            "all",
          ],
          "table": "concurrency_metrics",
          "template": "SELECT quantilesMerge(0.95)(wait_quantiles)[1] > {{p.schedulingDelayMs}} OR max(max_queued) > {{p.backlogCount}} OR if(max(max_queued) > 0, deltaSumTimestampMerge(started_delta) = 0, 0) FROM concurrency_metrics WHERE {{scope}} GROUP BY queue",
        },
        "health.liveness": {
          "scopes": [
            "all",
          ],
          "table": "runs",
          "template": "SELECT dateDiff('second', max(triggered_at), now()) > {{p.silenceSec}} FROM runs WHERE {{scope}}",
        },
        "queue.concurrency": {
          "scopes": [
            "queue",
            "queuePattern",
            "all",
          ],
          "table": "concurrency_metrics",
          "template": "SELECT queue, if(max(max_limit) > 0, max(max_running) / max(max_limit) * 100, 0) FROM concurrency_metrics WHERE {{scope}} GROUP BY queue",
        },
        "queue.depth": {
          "scopes": [
            "queue",
            "queuePattern",
            "all",
          ],
          "table": "concurrency_metrics",
          "template": "SELECT queue, max(max_queued) FROM concurrency_metrics WHERE {{scope}} GROUP BY queue",
        },
        "queue.oldest_age": {
          "scopes": [
            "queue",
            "queuePattern",
            "all",
          ],
          "table": "runs",
          "template": "SELECT max(dateDiff('millisecond', queued_at, now())) FROM runs WHERE {{scope}} AND status = 'PENDING' AND queued_at IS NOT NULL AND dequeued_at IS NULL",
        },
        "queue.scheduling_delay_p95": {
          "scopes": [
            "queue",
            "queuePattern",
            "all",
          ],
          "table": "concurrency_metrics",
          "template": "SELECT quantilesMerge(0.95)(wait_quantiles)[1] FROM concurrency_metrics WHERE {{scope}}",
        },
        "queue.stalled": {
          "scopes": [
            "queue",
            "queuePattern",
            "all",
          ],
          "table": "concurrency_metrics",
          "template": "SELECT max(max_queued) > 0 AND deltaSumTimestampMerge(started_delta) = 0 FROM concurrency_metrics WHERE {{scope}} GROUP BY queue",
        },
        "runs.created": {
          "scopes": [
            "task",
            "all",
          ],
          "table": "runs",
          "template": "SELECT count() FROM runs WHERE {{scope}}",
        },
        "runs.duration_p95": {
          "scopes": [
            "task",
            "all",
          ],
          "table": "runs",
          "template": "SELECT quantile(0.95)(execution_duration) FROM runs WHERE {{scope}} AND is_finished = 1",
        },
        "runs.failed": {
          "scopes": [
            "task",
            "all",
          ],
          "table": "runs",
          "template": "SELECT count() FROM runs WHERE {{scope}} AND status IN ('CRASHED', 'SYSTEM_FAILURE', 'TIMED_OUT', 'COMPLETED_WITH_ERRORS')",
        },
        "runs.failure_rate": {
          "scopes": [
            "task",
            "all",
          ],
          "table": "runs",
          "template": "SELECT countIf(status IN ('CRASHED', 'SYSTEM_FAILURE', 'TIMED_OUT', 'COMPLETED_WITH_ERRORS')) / count() * 100 FROM runs WHERE {{scope}} AND is_finished = 1",
        },
        "runs.volume": {
          "scopes": [
            "task",
            "all",
          ],
          "table": "runs",
          "template": "SELECT count() FROM runs WHERE {{scope}}",
        },
      }
    `);
  });

  it.each(["1 = 1", "task_identifier = 'my-task'"])(
    "errors.new compiles for scope %s",
    (scopeSql) => {
      const cap = getCapability("errors.new")!;
      const sql = compileTemplate(cap.binding.template!, scopeSql, undefined, {
        checkpoint: "'2026-01-01 00:00:00'",
        until: "'2026-01-02 00:00:00'",
        after: "1 = 1",
      });
      expect(sql).toContain(`WHERE ${scopeSql} GROUP BY`);
      expect(sql).toContain("min(first_seen) AS group_first_seen");
      expect(sql).toMatch(
        /HAVING group_first_seen >= '2026-01-01 00:00:00' AND group_first_seen < '2026-01-02 00:00:00' AND 1 = 1 ORDER BY group_first_seen ASC, task_identifier ASC, error_fingerprint ASC$/
      );
      expect(cap.binding.rowKey).toEqual(["task_identifier", "error_fingerprint"]);
    }
  );

  it("errors.new reads errors over full retention (no last_seen predicate)", () => {
    const cap = getCapability("errors.new")!;
    expect(cap.binding.template).not.toMatch(/last_seen/);
    expect(cap.binding.seriesTemplate).not.toMatch(/last_seen/);
  });

  it("errors.occurred_again compiles for an errorGroup scope", () => {
    const cap = getCapability("errors.occurred_again")!;
    expect(cap.allowedScopes).toEqual(["errorGroup"]);
    const scopeSql = "task_identifier = 'my-task' AND error_fingerprint = 'abc'";
    const sql = compileTemplate(cap.binding.template!, scopeSql, undefined, {
      checkpoint: "'2026-01-01 00:00:00'",
      until: "'2026-01-02 00:00:00'",
      after: "1 = 1",
    });
    expect(sql).toContain(
      `WHERE ${scopeSql} AND minute >= '2026-01-01 00:00:00' AND minute < '2026-01-02 00:00:00'`
    );
    expect(sql).toContain("AND minute < '2026-01-02 00:00:00' AND 1 = 1 GROUP BY");
    expect(sql).toMatch(/ORDER BY minute ASC, task_identifier ASC, error_fingerprint ASC$/);
    expect(compileTemplate(cap.binding.seriesTemplate!, scopeSql)).toContain(scopeSql);
    expect(cap.binding.rowKey).toEqual(["task_identifier", "error_fingerprint", "minute"]);
  });

  it("rejects a template using an undeclared ctx name", () => {
    const cap = getCapability("errors.new")!;
    expect(() =>
      alertCapabilitySchema.parse({
        ...cap,
        binding: { ...cap.binding, template: `${cap.binding.template} AND {{ctx.other}}` },
      })
    ).toThrow("undeclared ctx name");
    expect(() =>
      alertCapabilitySchema.parse({
        ...cap,
        binding: { ...cap.binding, ctx: undefined },
      })
    ).toThrow("undeclared ctx name");
  });

  it("accepts an errorGroup scope in alert params", () => {
    const params = {
      environmentId: "env_1",
      scope: { type: "errorGroup", taskIdentifier: "my-task", fingerprint: "abc" },
    };
    expect(alertParamsSchema.parse(params)).toEqual(params);
    expect(() =>
      alertParamsSchema.parse({ environmentId: "env_1", scope: { type: "errorGroup" } })
    ).toThrow();
  });

  it("every non-composite query binding references a valid table", () => {
    for (const cap of V1_CAPABILITIES) {
      if (cap.binding.type === "query" && !cap.binding.compositeOf && cap.binding.table) {
        expect(VALID_QUERY_TABLES).toContain(cap.binding.table);
      }
    }
  });

  it("query templates reference columns that exist in their table", () => {
    const columnsByTable: Record<string, string[]> = {
      runs: VALID_RUNS_COLUMNS,
      concurrency_metrics: VALID_QUEUE_METRICS_COLUMNS,
      errors: VALID_ERRORS_COLUMNS,
      error_occurrences: VALID_ERROR_OCCURRENCES_COLUMNS,
    };

    const sqlKeywords = new Set([
      "select",
      "from",
      "where",
      "and",
      "or",
      "not",
      "in",
      "is",
      "null",
      "as",
      "group",
      "by",
      "order",
      "asc",
      "desc",
      "interval",
      "second",
      "now",
      "max",
      "min",
      "count",
      "sum",
      "if",
      "true",
      "false",
      "runs",
      "concurrency_metrics",
      "env_metrics",
      "queue",
      "quantile",
      "quantilesmmerge",
      "quantilesmerge",
      "countif",
      "datediff",
      "millisecond",
      "deltasumtimestampmerge",
      "greatest",
      "having",
      "errors",
      "error_occurrences",
      "tostartofminute",
      "bucket",
      "new_groups",
      "occurrences",
      "group_first_seen",
    ]);

    for (const cap of V1_CAPABILITIES) {
      if (cap.binding.type !== "query" || !cap.binding.template) continue;
      const cols = columnsByTable[cap.binding.table!];
      if (!cols) continue;

      const template = [cap.binding.template, cap.binding.seriesTemplate ?? ""]
        .join(" ")
        .replace(/\{\{[^}]+\}\}/g, "")
        .replace(/\bp\.\w+/g, "");
      const columnRefs = template.match(/\b([a-z][a-z_0-9]*)\b/g) ?? [];
      for (const ref of columnRefs) {
        if (sqlKeywords.has(ref.toLowerCase())) continue;
        if (ref.match(/^\d/)) continue;
        expect(
          cols.includes(ref),
          `Column "${ref}" from template of ${cap.key} not found in ${cap.binding.table}`
        ).toBe(true);
      }
    }
  });

  it("getCapability returns the right entry", () => {
    expect(getCapability("queue.depth")?.title).toBe("Queue depth");
    expect(getCapability("nonexistent")).toBeUndefined();
  });

  it("listCapabilities filters by area", () => {
    const queues = listCapabilities({ area: "queues" });
    expect(queues.length).toBeGreaterThan(0);
    expect(queues.every((c) => c.area === "queues")).toBe(true);
  });

  it("listCapabilities filters by surface", () => {
    const contextual = listCapabilities({ surface: "contextual" });
    expect(contextual.every((c) => c.surfaces.includes("contextual"))).toBe(true);
    const healthContextual = contextual.filter((c) => c.area === "health");
    expect(healthContextual.length).toBe(0);
  });

  it("listCapabilities filters curated only", () => {
    const curated = listCapabilities({ curatedOnly: true });
    expect(curated.every((c) => c.curated)).toBe(true);
    expect(curated.some((c) => c.key === "queue.scheduling_delay_p95")).toBe(false);
    expect(curated.some((c) => c.key === "runs.failure_rate")).toBe(false);
  });

  it.each(["1 = 1", "task_identifier = 'my-task'"])(
    "runs.failed compiles with the failed-status predicate for scope %s",
    (scopeSql) => {
      const cap = getCapability("runs.failed");
      expect(cap?.binding.type).toBe("query");
      if (cap?.binding.type !== "query") return;
      const sql = compileTemplate(cap.binding.template!, scopeSql);
      expect(sql).toContain(scopeSql);
      expect(sql).toContain(
        "status IN ('CRASHED', 'SYSTEM_FAILURE', 'TIMED_OUT', 'COMPLETED_WITH_ERRORS')"
      );
      expect(cap.unit).toBe("count");
    }
  );

  it("runs.created has minWindowSec >= 1800", () => {
    const cap = getCapability("runs.created");
    expect(cap).toBeDefined();
    expect(cap!.minWindowSec).toBeGreaterThanOrEqual(1800);
  });

  it("queue.oldest_age template uses CURRENTLY_QUEUED_PREDICATE_PENDING", () => {
    const cap = getCapability("queue.oldest_age");
    expect(cap?.binding.type).toBe("query");
    if (cap?.binding.type === "query") {
      expect(cap.binding.template).toContain(CURRENTLY_QUEUED_PREDICATE_PENDING);
    }
  });

  it("every capability has a freshness classification", () => {
    for (const cap of V1_CAPABILITIES) {
      expect(["gauge", "counter", "snapshot"], `${cap.key} is missing freshness`).toContain(
        cap.freshness
      );
    }
  });

  it("queue.oldest_age is classified as a snapshot, never gauge carry-forward", () => {
    expect(getCapability("queue.oldest_age")?.freshness).toBe("snapshot");
  });

  it("every capability declares allowedScopes", () => {
    for (const cap of V1_CAPABILITIES) {
      expect(cap.allowedScopes.length, `${cap.key} has empty allowedScopes`).toBeGreaterThan(0);
      if (cap.allowedScopes.includes("errorGroup")) continue;
      expect(cap.allowedScopes, `${cap.key} must include 'all'`).toContain("all");
    }
  });

  const EXPECTED_SCOPES: Record<string, AlertScopeType[]> = {
    "queue.depth": ["queue", "queuePattern", "all"],
    "queue.oldest_age": ["queue", "queuePattern", "all"],
    "queue.concurrency": ["queue", "queuePattern", "all"],
    "queue.stalled": ["queue", "queuePattern", "all"],
    "queue.scheduling_delay_p95": ["queue", "queuePattern", "all"],
    "runs.volume": ["task", "all"],
    "runs.duration_p95": ["task", "all"],
    "runs.created": ["task", "all"],
    "runs.failure_rate": ["task", "all"],
    "runs.failed": ["task", "all"],
    "health.flow": ["all"],
    "health.execution": ["all"],
    "health.liveness": ["all"],
    "health.all": ["all"],
    "custom.query": ["all"],
    "errors.new": ["task", "all"],
    "errors.occurred_again": ["errorGroup"],
  };

  it.each(V1_CAPABILITIES.map((c) => c.key))(
    "scope compatibility: %s has exactly the expected scopes",
    (key) => {
      const cap = getCapability(key)!;
      const expected = EXPECTED_SCOPES[key];
      expect(expected, `missing expected scopes for ${key}`).toBeDefined();
      expect([...cap.allowedScopes].sort()).toEqual([...expected!].sort());
    }
  );

  it("isScopeAllowed rejects disallowed scopes", () => {
    const queueDepth = getCapability("queue.depth")!;
    expect(isScopeAllowed(queueDepth, "queue")).toBe(true);
    expect(isScopeAllowed(queueDepth, "task")).toBe(false);

    const healthAll = getCapability("health.all")!;
    expect(isScopeAllowed(healthAll, "all")).toBe(true);
    expect(isScopeAllowed(healthAll, "queue")).toBe(false);
  });

  it("health.all is composite of health.flow, health.execution, health.liveness", () => {
    const cap = getCapability("health.all")!;
    expect(cap.binding.compositeOf).toEqual(["health.flow", "health.execution", "health.liveness"]);
  });

  it("health.all params are the union of sub-capability params", () => {
    const cap = getCapability("health.all")!;
    const paramKeys = cap.binding.params!.map((p) => p.key).sort();
    expect(paramKeys).toEqual([
      "backlogCount",
      "durationP95Ms",
      "failureRatePct",
      "schedulingDelayMs",
      "silenceSec",
    ]);
  });

  it("health.flow template includes GROUP BY queue", () => {
    const cap = getCapability("health.flow")!;
    expect(cap.binding.template).toContain("GROUP BY queue");
  });

  it("compositeOf references must be registered state capabilities", () => {
    for (const cap of V1_CAPABILITIES) {
      if (!cap.binding.compositeOf) continue;
      for (const ref of cap.binding.compositeOf) {
        const sub = getCapability(ref);
        expect(sub, `compositeOf references unknown capability: ${ref}`).toBeDefined();
        expect(sub!.signal).toBe("state");
      }
    }
  });

  it("windowParam references a declared param", () => {
    expect(getCapability("health.liveness")!.binding.windowParam).toBe("silenceSec");
    for (const cap of V1_CAPABILITIES) {
      const windowParam = cap.binding.windowParam;
      if (!windowParam) continue;
      expect(cap.binding.params?.map((p) => p.key)).toContain(windowParam);
    }
  });

  it("rejects compositeOf referencing a non-state capability", () => {
    const metricCap = getCapability("queue.depth")!;
    expect(metricCap.signal).not.toBe("state");
  });
});

describe("displayStatus", () => {
  it("returns needs_attention when attention is needs_attention", () => {
    expect(displayStatus("active", "needs_attention")).toEqual({ status: "needs_attention" });
    expect(displayStatus("expired", "needs_attention")).toEqual({ status: "needs_attention" });
  });

  it("returns active when lifecycle is active and attention clear", () => {
    expect(displayStatus("active", "clear")).toEqual({ status: "active" });
  });

  it("returns inactive with correct reason", () => {
    expect(displayStatus("completed", "clear")).toEqual({
      status: "inactive",
      reason: "completed",
    });
    expect(displayStatus("expired", "clear")).toEqual({ status: "inactive", reason: "expired" });
    expect(displayStatus("stopped", "clear")).toEqual({ status: "inactive", reason: "stopped" });
  });
});

describe("transition", () => {
  const behavior: Behavior = {};
  const t0 = new Date("2026-01-01T00:00:00Z");
  const t1 = new Date("2026-01-01T00:05:00Z");

  function stateful(outcome: "met" | "not_met" | "impossible" | "unavailable"): EvaluationResult {
    return { kind: "stateful", outcome, facts: {} };
  }

  function makeInput(result: EvaluationResult, opts?: Partial<TransitionInput>): TransitionInput {
    return { result, now: t0, holdSec: 0, behavior, ...opts };
  }

  function makeState(overrides?: Partial<AlertState>): AlertState {
    return {
      lifecycle: "active",
      attention: "clear",
      observedCondition: "unknown",
      pendingMetSince: null,
      ...overrides,
    };
  }

  it("unknown -> met: raises", () => {
    const { next, events } = transition(makeState(), makeInput(stateful("met")));
    expect(next.observedCondition).toBe("met");
    expect(next.attention).toBe("needs_attention");
    expect(events).toEqual(["raised"]);
  });

  it("unknown -> not_met: no-op", () => {
    const { next, events } = transition(makeState(), makeInput(stateful("not_met")));
    expect(next.observedCondition).toBe("not_met");
    expect(events).toEqual([]);
  });

  it("not_met -> met: raises", () => {
    const prev = makeState({ observedCondition: "not_met" });
    const { next, events } = transition(prev, makeInput(stateful("met")));
    expect(next.attention).toBe("needs_attention");
    expect(events).toEqual(["raised"]);
  });

  it("not_met -> met while clear: raises and notifies", () => {
    const prev = makeState({ observedCondition: "not_met", attention: "clear" });
    const { events, notify } = transition(prev, makeInput(stateful("met")));
    expect(events).toEqual(["raised"]);
    expect(notify).toBe(true);
  });

  it("not_met -> met while needs_attention: raises silently", () => {
    const prev = makeState({ observedCondition: "not_met", attention: "needs_attention" });
    const { next, events, notify } = transition(prev, makeInput(stateful("met")));
    expect(events).toEqual(["raised"]);
    expect(notify).toBe(false);
    expect(next.attention).toBe("needs_attention");
  });

  it("met -> met while clear: raises and notifies", () => {
    const prev = makeState({ observedCondition: "met", attention: "clear" });
    const { events, notify } = transition(prev, makeInput(stateful("met")));
    expect(events).toEqual(["raised"]);
    expect(notify).toBe(true);
  });

  it("raise, recover, raise without resolve: second raise is silent", () => {
    const first = transition(makeState(), makeInput(stateful("met")));
    expect(first.notify).toBe(true);
    const recovered = transition(first.next, makeInput(stateful("not_met")));
    expect(recovered.events).toEqual(["recovered"]);
    const second = transition(recovered.next, makeInput(stateful("met")));
    expect(second.events).toEqual(["raised"]);
    expect(second.notify).toBe(false);
  });

  it("met -> met: no event (stateful kinds write nothing on repeated met)", () => {
    const prev = makeState({ observedCondition: "met", attention: "needs_attention" });
    const { next, events, notify } = transition(prev, makeInput(stateful("met")));
    expect(next.observedCondition).toBe("met");
    expect(events).toEqual([]);
    expect(notify).toBe(false);
  });

  it("met -> not_met: recovery, attention unchanged", () => {
    const prev = makeState({ observedCondition: "met", attention: "needs_attention" });
    const { next, events } = transition(prev, makeInput(stateful("not_met")));
    expect(next.observedCondition).toBe("not_met");
    expect(next.attention).toBe("needs_attention");
    expect(events).toEqual(["recovered"]);
  });

  it("not_met -> not_met: no event", () => {
    const prev = makeState({ observedCondition: "not_met" });
    const { events } = transition(prev, makeInput(stateful("not_met")));
    expect(events).toEqual([]);
  });

  it("resolved while met -> met: re-raises once", () => {
    const raised = makeState({ observedCondition: "met", attention: "needs_attention" });
    const { next: resolved } = resolve(raised);
    const first = transition(resolved, makeInput(stateful("met")));
    expect(first.events).toEqual(["raised"]);
    expect(first.next.attention).toBe("needs_attention");
    expect(first.next.observedCondition).toBe("met");

    const second = transition(first.next, makeInput(stateful("met")));
    expect(second.events).toEqual([]);
    expect(second.next.attention).toBe("needs_attention");
  });

  it("resolved while met with hold: re-raises only after hold elapses", () => {
    const resolved = makeState({ observedCondition: "met", attention: "clear" });
    const pending = transition(resolved, makeInput(stateful("met"), { holdSec: 300, now: t0 }));
    expect(pending.events).toEqual([]);
    expect(pending.next.pendingMetSince).toEqual(t0);

    const ready = transition(pending.next, makeInput(stateful("met"), { holdSec: 300, now: t1 }));
    expect(ready.events).toEqual(["raised"]);
    expect(ready.next.attention).toBe("needs_attention");
  });

  it("acknowledged (met, clear) -> not_met: recovery", () => {
    const prev = makeState({ observedCondition: "met", attention: "clear" });
    const { next, events } = transition(prev, makeInput(stateful("not_met")));
    expect(events).toEqual(["recovered"]);
    expect(next.attention).toBe("clear");
  });

  it("not_met -> met after recovery and resolve: re-raises", () => {
    const prev = makeState({ observedCondition: "not_met", attention: "clear" });
    const { next, events } = transition(prev, makeInput(stateful("met")));
    expect(events).toEqual(["raised"]);
    expect(next.attention).toBe("needs_attention");
  });

  it("hold: met before hold completes stays pending", () => {
    const prev = makeState({ observedCondition: "not_met" });
    const { next, events } = transition(
      prev,
      makeInput(stateful("met"), { holdSec: 600, now: t0 })
    );
    expect(next.pendingMetSince).toEqual(t0);
    expect(events).toEqual([]);
    expect(next.observedCondition).toBe("not_met");
  });

  it("hold: met after hold elapsed raises", () => {
    const prev = makeState({ observedCondition: "not_met", pendingMetSince: t0 });
    const { next, events } = transition(
      prev,
      makeInput(stateful("met"), { holdSec: 300, now: t1 })
    );
    expect(events).toEqual(["raised"]);
    expect(next.pendingMetSince).toBeNull();
  });

  it("hold: not_met before hold completes clears pending", () => {
    const prev = makeState({ observedCondition: "not_met", pendingMetSince: t0 });
    const { next, events } = transition(
      prev,
      makeInput(stateful("not_met"), { holdSec: 600, now: t1 })
    );
    expect(next.pendingMetSince).toBeNull();
    expect(events).toEqual([]);
  });

  it("hold: unavailable clears pending (DEC-120)", () => {
    const prev = makeState({ observedCondition: "not_met", pendingMetSince: t0 });
    const { next, events } = transition(
      prev,
      makeInput(stateful("unavailable"), { holdSec: 600, now: t1 })
    );
    expect(next.pendingMetSince).toBeNull();
    expect(events).toEqual([]);
  });

  it("impossible: clears to not_met", () => {
    const prev = makeState({ observedCondition: "met", attention: "needs_attention" });
    const { next, events } = transition(prev, makeInput(stateful("impossible")));
    expect(next.observedCondition).toBe("not_met");
    expect(events).toEqual([]);
  });

  it("non-active lifecycle: no transition", () => {
    const prev = makeState({ lifecycle: "stopped" });
    const { next, events } = transition(prev, makeInput(stateful("met")));
    expect(events).toEqual([]);
    expect(next.lifecycle).toBe("stopped");
  });

  describe("occurrence kind", () => {
    const r1 = new Date("2026-01-01T00:01:00Z");
    const r2 = new Date("2026-01-01T00:02:00Z");
    const r3 = new Date("2026-01-01T00:03:00Z");

    function o(fp: string, rowTime: Date) {
      return {
        sourceEventId: fp,
        rowTime,
        expiresAt: occurrenceExpiresAt(rowTime, 3600),
        facts: { fp },
      };
    }

    function occ(occurrences: ReturnType<typeof o>[]): EvaluationResult {
      return { kind: "occurrence", outcome: "met", occurrences, nextCursor: "c1", facts: {} };
    }

    it("first unseen occurrence while clear: raised", () => {
      const { next, events } = transition(makeState(), makeInput(occ([o("a", r1)])));
      expect(events).toEqual(["raised"]);
      expect(next.attention).toBe("needs_attention");
    });

    it("occurrence raise leaves observedCondition unknown", () => {
      const { next } = transition(makeState(), makeInput(occ([o("a", r1)])));
      expect(next.observedCondition).toBe("unknown");
    });

    it("multiple unseen occurrences while clear: a single raised", () => {
      const { next, events, unseenOccurrences, latestOccurrenceAt } = transition(
        makeState(),
        makeInput(occ([o("a", r1), o("c", r3), o("b", r2)]))
      );
      expect(events).toEqual(["raised"]);
      expect(next.attention).toBe("needs_attention");
      expect(unseenOccurrences).toBe(3);
      expect(latestOccurrenceAt).toEqual(r3);
    });

    it("unseen occurrences while needs_attention: no event, attention unchanged", () => {
      const prev = makeState({ attention: "needs_attention" });
      const { next, events, unseenOccurrences, latestOccurrenceAt } = transition(
        prev,
        makeInput(occ([o("a", r1), o("b", r2), o("c", r1)]))
      );
      expect(events).toEqual([]);
      expect(next).toEqual(prev);
      expect(unseenOccurrences).toBe(3);
      expect(latestOccurrenceAt).toEqual(r2);
    });

    it("no unseen occurrences while clear: no event, state unchanged", () => {
      const prev = makeState();
      const { next, events, unseenOccurrences, latestOccurrenceAt } = transition(
        prev,
        makeInput(occ([]))
      );
      expect(events).toEqual([]);
      expect(next).toEqual(prev);
      expect(next.attention).toBe("clear");
      expect(unseenOccurrences).toBe(0);
      expect(latestOccurrenceAt).toBeNull();
    });

    it("non-active lifecycle: no event", () => {
      const prev = makeState({ lifecycle: "stopped" });
      const { next, events } = transition(prev, makeInput(occ([o("a", r1)])));
      expect(events).toEqual([]);
      expect(next).toEqual(prev);
    });
  });

  describe("resolve", () => {
    it("clears attention, lifecycle stays active", () => {
      const prev = makeState({ attention: "needs_attention", observedCondition: "met" });
      const { next, events } = resolve(prev);
      expect(next.attention).toBe("clear");
      expect(next.lifecycle).toBe("active");
      expect(events).toEqual(["resolved"]);
    });

    it("leaves lifecycle unchanged", () => {
      for (const lifecycle of ["active", "completed", "stopped"] as const) {
        const prev = makeState({ lifecycle, attention: "needs_attention" });
        expect(resolve(prev).next.lifecycle).toBe(lifecycle);
      }
    });

    it("resolving an expired alert keeps lifecycle expired", () => {
      const prev = makeState({
        lifecycle: "expired",
        attention: "needs_attention",
        observedCondition: "met",
      });
      const { next, events } = resolve(prev);
      expect(next.lifecycle).toBe("expired");
      expect(next.attention).toBe("clear");
      expect(events).toEqual(["resolved"]);
    });
  });

  describe("expire", () => {
    it("sets lifecycle to expired and clears attention", () => {
      const prev = makeState({ attention: "needs_attention" });
      const { next, events } = expire(prev);
      expect(next.lifecycle).toBe("expired");
      expect(next.attention).toBe("clear");
      expect(events).toEqual(["expired"]);
    });
  });

  describe("stop", () => {
    it("sets lifecycle to stopped, preserves attention", () => {
      const prev = makeState({ attention: "needs_attention" });
      const { next, events } = stop(prev);
      expect(next.lifecycle).toBe("stopped");
      expect(next.attention).toBe("needs_attention");
      expect(events).toEqual(["stopped"]);
    });
  });

  describe("critical mutations from spec section 3.13", () => {
    it("met->met writes an event -> fails", () => {
      const prev = makeState({ observedCondition: "met", attention: "needs_attention" });
      const { events } = transition(prev, makeInput(stateful("met")));
      expect(events).not.toContain("raised");
      expect(events.length).toBe(0);
    });

    it("hold satisfied by elapsed time, not tick count", () => {
      const prev = makeState({ observedCondition: "not_met", pendingMetSince: t0 });
      const tooEarly = new Date(t0.getTime() + 299_000);
      const { events: earlyEvents } = transition(
        prev,
        makeInput(stateful("met"), { holdSec: 300, now: tooEarly })
      );
      expect(earlyEvents).toEqual([]);

      const justRight = new Date(t0.getTime() + 300_000);
      const { events: readyEvents } = transition(
        prev,
        makeInput(stateful("met"), { holdSec: 300, now: justRight })
      );
      expect(readyEvents).toEqual(["raised"]);
    });

    it("expiry clears attention", () => {
      const prev = makeState({ attention: "needs_attention" });
      const { next } = expire(prev);
      expect(next.attention).toBe("clear");
    });

    it("recovery does not derive from attention", () => {
      const prevWithAttention = makeState({
        observedCondition: "met",
        attention: "needs_attention",
      });
      const { next: n1 } = transition(prevWithAttention, makeInput(stateful("not_met")));
      expect(n1.attention).toBe("needs_attention");

      const prevWithClear = makeState({ observedCondition: "met", attention: "clear" });
      const { next: n2 } = transition(prevWithClear, makeInput(stateful("not_met")));
      expect(n2.attention).toBe("clear");
    });
  });
});

describe("notifierRefSchema / notifierRefKey", () => {
  it("parses a channel ref", () => {
    const ref = notifierRefSchema.parse({ type: "channel", channelId: "chan_1" });
    expect(ref).toEqual({ type: "channel", channelId: "chan_1" });
  });

  it("parses a chat ref with chatId", () => {
    const ref = notifierRefSchema.parse({ type: "chat", chatId: "chat_1" });
    expect(ref).toEqual({ type: "chat", chatId: "chat_1" });
  });

  it("fails when chatId is stripped from a chat notifier ref", () => {
    const ref = notifierRefSchema.parse({ type: "chat", chatId: "chat_abc" });
    expect(ref.type === "chat" && ref.chatId).toBe("chat_abc");
  });

  it("fails when a bare {type:'chat'} is accepted", () => {
    expect(() => notifierRefSchema.parse({ type: "chat" })).toThrow();
  });

  it("rejects an unknown type", () => {
    expect(() => notifierRefSchema.parse({ type: "sms", channelId: "x" })).toThrow();
  });

  it("derives a stable key per channel id", () => {
    expect(notifierRefKey({ type: "channel", channelId: "chan_1" })).toBe("channel:chan_1");
    expect(notifierRefKey({ type: "channel", channelId: "chan_2" })).toBe("channel:chan_2");
  });

  it("derives a stable key for a chat ref with chatId", () => {
    expect(notifierRefKey({ type: "chat", chatId: "chat_1", userId: "user_1" })).toBe(
      "chat:chat_1:user_1"
    );
  });

  it("derives a stable key for a chat ref scoped to a conversation", () => {
    expect(notifierRefKey({ type: "chat", conversationId: "conv_1", userId: "user_1" })).toBe(
      "chat:conv_1:user_1"
    );
  });

  it("chatId takes precedence over conversationId in key", () => {
    expect(
      notifierRefKey({ type: "chat", chatId: "chat_1", conversationId: "conv_1", userId: "u" })
    ).toBe("chat:chat_1:u");
  });

  it("collapses a chat ref with only userId to a project-wide key", () => {
    expect(notifierRefKey({ type: "chat", userId: "user_1" })).toBe("chat:project:user_1");
  });

  it("distinct chat userIds never collapse into the same key", () => {
    const keyA = notifierRefKey({ type: "chat", userId: "user_a" });
    const keyB = notifierRefKey({ type: "chat", userId: "user_b" });
    expect(keyA).not.toBe(keyB);
  });
});

describe("query alerts contracts", () => {
  const base = { environmentId: "env_1", scope: { type: "all" as const } };
  const signal = {
    v: 1,
    sources: [{ sourceId: "runs", windowColumn: "triggered_at" }],
    mode: "threshold",
  };

  it("keeps a valid querySignal and rejects an invalid one", () => {
    expect(alertParamsSchema.parse({ ...base, querySignal: signal }).querySignal).toEqual(signal);
    expect(() => alertParamsSchema.parse({ ...base, querySignal: { ...signal, v: 2 } })).toThrow();
    expect(() =>
      alertParamsSchema.parse({ ...base, querySignal: { ...signal, cadenceSec: 60 } })
    ).toThrow();
  });

  it("never lists custom.query on any surface", () => {
    const cap = getCapability("custom.query")!;
    expect(cap.area).toBe("query");
    expect(cap.curated).toBe(false);
    for (const surface of ["agent", "mcp", "alerts_page", "contextual"]) {
      expect(listCapabilities({ surface }).map((c) => c.key)).not.toContain("custom.query");
    }
    expect(listCapabilities({ curatedOnly: true }).map((c) => c.key)).not.toContain("custom.query");
  });

  it("has a well-formed catalog", () => {
    for (const source of Object.values(QUERY_SOURCES)) {
      expect(source.timeColumns.threshold, source.table).toBeTruthy();
      if (source.modes.includes("match")) {
        expect(source.stableId, source.table).toBeTruthy();
        expect(source.timeColumns.match, source.table).toBeTruthy();
      }
    }
  });

  it("derives modes and cadence across sources", () => {
    expect(modesForTables(["runs", "llm_metrics"])).toEqual(["threshold", "match"]);
    expect(modesForTables(["runs", "errors"])).toEqual(["threshold", "match"]);
    expect(modesForTables(["errors"])).toEqual(["threshold"]);
    expect(modesForTables(["runs"])).toContain("match");
    expect(minCadenceForTables(["runs", "errors"])).toBe(600);
  });

  it("gives a shared window column name the same semantics in every source", () => {
    const seen = new Map<string, boolean>();
    for (const source of Object.values(QUERY_SOURCES)) {
      const entries: [string, boolean][] = [
        [source.timeColumns.threshold, source.eventTime.threshold],
      ];
      if (source.timeColumns.match)
        entries.push([source.timeColumns.match, source.eventTime.match!]);
      for (const [column, eventTime] of entries) {
        if (seen.has(column)) expect(eventTime, `${source.table}.${column}`).toBe(seen.get(column));
        seen.set(column, eventTime);
      }
    }
  });

  it("pins every catalog time column to the approved event-time table", () => {
    const actual = Object.values(QUERY_SOURCES).flatMap((s) => [
      `${s.table}.${s.timeColumns.threshold}=${s.eventTime.threshold}`,
      ...(s.timeColumns.match ? [`${s.table}.${s.timeColumns.match}=${s.eventTime.match}`] : []),
    ]);
    expect(actual.sort()).toEqual(
      [
        "runs.triggered_at=false",
        "runs.completed_at=true",
        "error_occurrences.minute=true",
        "errors.last_seen=false",
        "llm_metrics.start_time=true",
        "llm_metrics.start_time=true",
        "metrics.bucket_start=false",
        "concurrency_metrics.bucket_start=false",
        "env_metrics.bucket_start=false",
      ].sort()
    );
  });

  it("supports nothing when any table is unknown", () => {
    expect(modesForTables(["runs", "llm_models"])).toEqual([]);
    expect(minCadenceForTables(["runs", "llm_models"])).toBeUndefined();
  });
});
