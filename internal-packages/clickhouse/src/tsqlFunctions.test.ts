import { clickhouseTest } from "@internal/testcontainers";
import { z } from "zod";
import { ClickhouseClient } from "./client/client.js";
import { executeTSQL, type TableSchema } from "./client/tsql.js";
import { insertTaskRuns } from "./taskRuns.js";
import { column } from "@internal/tsql";

/**
 * Schema definition for task_runs table used in function tests.
 * Includes numeric, string, datetime, and array columns for exercising all function categories.
 */
const taskRunsSchema: TableSchema = {
  name: "task_runs",
  clickhouseName: "trigger_dev.task_runs_v2",
  columns: {
    run_id: { name: "run_id", ...column("String") },
    friendly_id: { name: "friendly_id", ...column("String") },
    status: { name: "status", ...column("String") },
    task_identifier: { name: "task_identifier", ...column("String") },
    queue: { name: "queue", ...column("String") },
    environment_id: { name: "environment_id", ...column("String") },
    environment_type: { name: "environment_type", ...column("String") },
    organization_id: { name: "organization_id", ...column("String") },
    project_id: { name: "project_id", ...column("String") },
    created_at: { name: "created_at", ...column("DateTime64") },
    updated_at: { name: "updated_at", ...column("DateTime64") },
    started_at: { name: "started_at", ...column("Nullable(DateTime64)") },
    completed_at: { name: "completed_at", ...column("Nullable(DateTime64)") },
    is_test: { name: "is_test", ...column("UInt8") },
    tags: { name: "tags", ...column("Array(String)") },
    usage_duration_ms: { name: "usage_duration_ms", ...column("UInt32") },
    cost_in_cents: { name: "cost_in_cents", ...column("Float64") },
    attempt: { name: "attempt", ...column("UInt8") },
    depth: { name: "depth", ...column("UInt8") },
  },
  tenantColumns: {
    organizationId: "organization_id",
    projectId: "project_id",
    environmentId: "environment_id",
  },
};

const enforcedWhereClause = {
  organization_id: { op: "eq" as const, value: "org_tenant1" },
  project_id: { op: "eq" as const, value: "proj_tenant1" },
  environment_id: { op: "eq" as const, value: "env_tenant1" },
};

const defaultTaskRun = {
  environment_id: "env_tenant1",
  environment_type: "DEVELOPMENT",
  organization_id: "org_tenant1",
  project_id: "proj_tenant1",
  run_id: "run_func_test_1",
  friendly_id: "friendly_func_test_1",
  attempt: 1,
  engine: "V2",
  status: "COMPLETED_SUCCESSFULLY",
  task_identifier: "my-task",
  queue: "my-queue",
  schedule_id: "",
  batch_id: "",
  created_at: Date.now(),
  updated_at: Date.now(),
  started_at: Date.now() - 5000,
  completed_at: Date.now(),
  tags: ["tag-a", "tag-b"],
  output: null,
  error: null,
  usage_duration_ms: 4500,
  cost_in_cents: 1.5,
  base_cost_in_cents: 0.5,
  task_version: "1.0.0",
  sdk_version: "4.0.0",
  cli_version: "4.0.0",
  machine_preset: "small-1x",
  is_test: false,
  span_id: "span_123",
  trace_id: "trace_123",
  idempotency_key: "idem_123",
  expiration_ttl: "",
  root_run_id: "",
  parent_run_id: "",
  depth: 2,
  concurrency_key: "",
  bulk_action_group_ids: [] as string[],
  _version: "1",
};

/**
 * Helper: execute a TSQL query and assert no errors.
 */
async function assertQueryExecutes(client: ClickhouseClient, tsqlQuery: string): Promise<void> {
  const [error] = await executeTSQL(client, {
    name: "func-test",
    query: tsqlQuery,
    schema: z.record(z.any()),
    enforcedWhereClause,
    tableSchema: [taskRunsSchema],
  });

  if (error) {
    throw new Error(`Query failed: ${tsqlQuery}\n\nError: ${error.message}`);
  }
}

/**
 * Helper: set up a client with test data inserted.
 */
async function setupClient(clickhouseContainer: { getConnectionUrl(): string }) {
  const client = new ClickhouseClient({
    name: "func-test",
    url: clickhouseContainer.getConnectionUrl(),
  });

  const insert = insertTaskRuns(client, { async_insert: 0 });
  const [insertError] = await insert([defaultTaskRun]);
  expect(insertError).toBeNull();

  return client;
}

/**
 * Helper: run all test cases in a single ClickHouse container.
 * Each case is a [name, tsqlQuery] tuple.
 */
async function runCases(client: ClickhouseClient, cases: [string, string][]): Promise<void> {
  const failures: string[] = [];

  for (const [name, query] of cases) {
    try {
      await assertQueryExecutes(client, query);
    } catch (e) {
      failures.push(`  ${name}: ${(e as Error).message}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `${failures.length}/${cases.length} function(s) failed:\n${failures.join("\n")}`
    );
  }
}

const url = "https://user:pass@www.example.com:8080/path/page?q=1&r=2#frag";

describe("TSQL Function Smoke Tests", () => {
  // ─── Arithmetic functions ─────────────────────────────────────────────────

  clickhouseTest("Arithmetic functions", async ({ clickhouseContainer }) => {
    const client = await setupClient(clickhouseContainer);
    await runCases(client, [
      ["plus", "SELECT plus(usage_duration_ms, 1) AS r FROM task_runs"],
      ["minus", "SELECT minus(usage_duration_ms, 1) AS r FROM task_runs"],
      ["multiply", "SELECT multiply(usage_duration_ms, 2) AS r FROM task_runs"],
      ["divide", "SELECT divide(usage_duration_ms, 2) AS r FROM task_runs"],
      ["intDiv", "SELECT intDiv(usage_duration_ms, 2) AS r FROM task_runs"],
      ["intDivOrZero", "SELECT intDivOrZero(usage_duration_ms, 0) AS r FROM task_runs"],
      ["modulo", "SELECT modulo(usage_duration_ms, 3) AS r FROM task_runs"],
      ["moduloOrZero", "SELECT moduloOrZero(usage_duration_ms, 0) AS r FROM task_runs"],
      ["positiveModulo", "SELECT positiveModulo(usage_duration_ms, 3) AS r FROM task_runs"],
      ["negate", "SELECT negate(cost_in_cents) AS r FROM task_runs"],
      ["abs", "SELECT abs(cost_in_cents) AS r FROM task_runs"],
      ["gcd", "SELECT gcd(12, 8) AS r FROM task_runs"],
      ["lcm", "SELECT lcm(12, 8) AS r FROM task_runs"],
    ]);
  });

  // ─── Mathematical functions ───────────────────────────────────────────────

  clickhouseTest("Mathematical functions", async ({ clickhouseContainer }) => {
    const client = await setupClient(clickhouseContainer);
    await runCases(client, [
      ["exp", "SELECT exp(1) AS r FROM task_runs"],
      ["log", "SELECT log(2.718) AS r FROM task_runs"],
      ["ln", "SELECT ln(2.718) AS r FROM task_runs"],
      ["exp2", "SELECT exp2(3) AS r FROM task_runs"],
      ["log2", "SELECT log2(8) AS r FROM task_runs"],
      ["exp10", "SELECT exp10(2) AS r FROM task_runs"],
      ["log10", "SELECT log10(100) AS r FROM task_runs"],
      ["sqrt", "SELECT sqrt(16) AS r FROM task_runs"],
      ["cbrt", "SELECT cbrt(27) AS r FROM task_runs"],
      ["erf", "SELECT erf(1) AS r FROM task_runs"],
      ["erfc", "SELECT erfc(1) AS r FROM task_runs"],
      ["lgamma", "SELECT lgamma(5) AS r FROM task_runs"],
      ["tgamma", "SELECT tgamma(5) AS r FROM task_runs"],
      ["sin", "SELECT sin(1) AS r FROM task_runs"],
      ["cos", "SELECT cos(1) AS r FROM task_runs"],
      ["tan", "SELECT tan(1) AS r FROM task_runs"],
      ["asin", "SELECT asin(0.5) AS r FROM task_runs"],
      ["acos", "SELECT acos(0.5) AS r FROM task_runs"],
      ["atan", "SELECT atan(1) AS r FROM task_runs"],
      ["pow", "SELECT pow(2, 3) AS r FROM task_runs"],
      ["power", "SELECT power(2, 3) AS r FROM task_runs"],
      ["round", "SELECT round(3.14159, 2) AS r FROM task_runs"],
      ["floor", "SELECT floor(3.7) AS r FROM task_runs"],
      ["ceil", "SELECT ceil(3.2) AS r FROM task_runs"],
      ["ceiling", "SELECT ceiling(3.2) AS r FROM task_runs"],
      ["trunc", "SELECT trunc(3.7) AS r FROM task_runs"],
      ["truncate", "SELECT truncate(3.7) AS r FROM task_runs"],
      ["sign", "SELECT sign(-5) AS r FROM task_runs"],
    ]);
  });

  // ─── String functions ─────────────────────────────────────────────────────

  clickhouseTest("String functions", async ({ clickhouseContainer }) => {
    const client = await setupClient(clickhouseContainer);
    await runCases(client, [
      ["empty", "SELECT empty(status) AS r FROM task_runs"],
      ["notEmpty", "SELECT notEmpty(status) AS r FROM task_runs"],
      ["length", "SELECT length(status) AS r FROM task_runs"],
      ["lengthUTF8", "SELECT lengthUTF8(status) AS r FROM task_runs"],
      ["char_length", "SELECT char_length(status) AS r FROM task_runs"],
      ["character_length", "SELECT character_length(status) AS r FROM task_runs"],
      ["lower", "SELECT lower(status) AS r FROM task_runs"],
      ["upper", "SELECT upper(status) AS r FROM task_runs"],
      ["lowerUTF8", "SELECT lowerUTF8(status) AS r FROM task_runs"],
      ["upperUTF8", "SELECT upperUTF8(status) AS r FROM task_runs"],
      ["reverse", "SELECT reverse(status) AS r FROM task_runs"],
      ["reverseUTF8", "SELECT reverseUTF8(status) AS r FROM task_runs"],
      ["concat", "SELECT concat(status, '-', run_id) AS r FROM task_runs"],
      ["substring", "SELECT substring(status, 1, 3) AS r FROM task_runs"],
      ["substr", "SELECT substr(status, 1, 3) AS r FROM task_runs"],
      ["mid", "SELECT mid(status, 1, 3) AS r FROM task_runs"],
      ["substringUTF8", "SELECT substringUTF8(status, 1, 3) AS r FROM task_runs"],
      [
        "appendTrailingCharIfAbsent",
        "SELECT appendTrailingCharIfAbsent(status, '!') AS r FROM task_runs",
      ],
      ["base64Encode", "SELECT base64Encode(status) AS r FROM task_runs"],
      ["base64Decode", "SELECT base64Decode(base64Encode(status)) AS r FROM task_runs"],
      ["tryBase64Decode", "SELECT tryBase64Decode('aGVsbG8=') AS r FROM task_runs"],
      ["endsWith", "SELECT endsWith(status, 'LY') AS r FROM task_runs"],
      ["startsWith", "SELECT startsWith(status, 'COM') AS r FROM task_runs"],
      ["trim", "SELECT trim(status) AS r FROM task_runs"],
      ["trimLeft", "SELECT trimLeft(status) AS r FROM task_runs"],
      ["trimRight", "SELECT trimRight(status) AS r FROM task_runs"],
      ["ltrim", "SELECT ltrim(status) AS r FROM task_runs"],
      ["rtrim", "SELECT rtrim(status) AS r FROM task_runs"],
      ["leftPad", "SELECT leftPad(status, 30, '*') AS r FROM task_runs"],
      ["rightPad", "SELECT rightPad(status, 30, '*') AS r FROM task_runs"],
      ["leftPadUTF8", "SELECT leftPadUTF8(status, 30, '*') AS r FROM task_runs"],
      ["rightPadUTF8", "SELECT rightPadUTF8(status, 30, '*') AS r FROM task_runs"],
      ["left", "SELECT left(status, 3) AS r FROM task_runs"],
      ["right", "SELECT right(status, 3) AS r FROM task_runs"],
      ["repeat", "SELECT repeat(status, 2) AS r FROM task_runs"],
      ["space", "SELECT space(5) AS r FROM task_runs"],
      ["replace", "SELECT replace(status, 'COMPLETED', 'DONE') AS r FROM task_runs"],
      ["replaceOne", "SELECT replaceOne(status, 'COMPLETED', 'DONE') AS r FROM task_runs"],
      ["replaceAll", "SELECT replaceAll(status, 'COMPLETED', 'DONE') AS r FROM task_runs"],
      ["replaceRegexpOne", "SELECT replaceRegexpOne(status, '[A-Z]+', 'X') AS r FROM task_runs"],
      ["replaceRegexpAll", "SELECT replaceRegexpAll(status, '[A-Z]', 'x') AS r FROM task_runs"],
      ["position", "SELECT position(status, 'COM') AS r FROM task_runs"],
      [
        "positionCaseInsensitive",
        "SELECT positionCaseInsensitive(status, 'com') AS r FROM task_runs",
      ],
      ["positionUTF8", "SELECT positionUTF8(status, 'COM') AS r FROM task_runs"],
      [
        "positionCaseInsensitiveUTF8",
        "SELECT positionCaseInsensitiveUTF8(status, 'com') AS r FROM task_runs",
      ],
      ["locate", "SELECT locate(status, 'COM') AS r FROM task_runs"],
      ["match", "SELECT match(status, 'COMPLETED.*') AS r FROM task_runs"],
      ["like", "SELECT like(status, '%COMPLETED%') AS r FROM task_runs"],
      ["ilike", "SELECT ilike(status, '%completed%') AS r FROM task_runs"],
      ["notLike", "SELECT notLike(status, '%PENDING%') AS r FROM task_runs"],
      ["notILike", "SELECT notILike(status, '%pending%') AS r FROM task_runs"],
      ["splitByChar", "SELECT splitByChar('_', status) AS r FROM task_runs"],
      ["splitByString", "SELECT splitByString('_', status) AS r FROM task_runs"],
      ["splitByRegexp", "SELECT splitByRegexp('_', status) AS r FROM task_runs"],
      ["arrayStringConcat", "SELECT arrayStringConcat(tags, ',') AS r FROM task_runs"],
      ["format", "SELECT format('{0}-{1}', status, run_id) AS r FROM task_runs"],
    ]);
  });

  // ─── Null functions ───────────────────────────────────────────────────────

  clickhouseTest("Null functions", async ({ clickhouseContainer }) => {
    const client = await setupClient(clickhouseContainer);
    await runCases(client, [
      ["coalesce", "SELECT coalesce(started_at, now()) AS r FROM task_runs"],
      ["ifNull", "SELECT ifNull(started_at, now()) AS r FROM task_runs"],
      ["nullIf", "SELECT nullIf(status, 'PENDING') AS r FROM task_runs"],
      ["assumeNotNull", "SELECT assumeNotNull(started_at) AS r FROM task_runs"],
      ["toNullable", "SELECT toNullable(status) AS r FROM task_runs"],
      ["isNull", "SELECT isNull(started_at) AS r FROM task_runs"],
      ["isNotNull", "SELECT isNotNull(started_at) AS r FROM task_runs"],
    ]);
  });

  // ─── Conditional functions ────────────────────────────────────────────────

  clickhouseTest("Conditional functions", async ({ clickhouseContainer }) => {
    const client = await setupClient(clickhouseContainer);
    await runCases(client, [
      ["if", "SELECT if(usage_duration_ms > 1000, 'slow', 'fast') AS r FROM task_runs"],
      [
        "multiIf",
        "SELECT multiIf(usage_duration_ms > 5000, 'slow', usage_duration_ms > 1000, 'medium', 'fast') AS r FROM task_runs",
      ],
    ]);
  });

  // ─── Comparison functions ─────────────────────────────────────────────────

  clickhouseTest("Comparison functions", async ({ clickhouseContainer }) => {
    const client = await setupClient(clickhouseContainer);
    await runCases(client, [
      ["equals", "SELECT equals(status, 'PENDING') AS r FROM task_runs"],
      ["notEquals", "SELECT notEquals(status, 'PENDING') AS r FROM task_runs"],
      ["less", "SELECT less(usage_duration_ms, 9999) AS r FROM task_runs"],
      ["greater", "SELECT greater(usage_duration_ms, 0) AS r FROM task_runs"],
      ["lessOrEquals", "SELECT lessOrEquals(usage_duration_ms, 9999) AS r FROM task_runs"],
      ["greaterOrEquals", "SELECT greaterOrEquals(usage_duration_ms, 0) AS r FROM task_runs"],
    ]);
  });

  // ─── Logical functions ────────────────────────────────────────────────────

  clickhouseTest("Logical functions", async ({ clickhouseContainer }) => {
    const client = await setupClient(clickhouseContainer);
    await runCases(client, [
      ["and", "SELECT and(usage_duration_ms > 0, is_test = 0) AS r FROM task_runs"],
      ["or", "SELECT or(usage_duration_ms > 9999, is_test = 0) AS r FROM task_runs"],
      ["xor", "SELECT xor(usage_duration_ms > 0, is_test = 1) AS r FROM task_runs"],
      ["not", "SELECT not(is_test) AS r FROM task_runs"],
    ]);
  });

  // ─── Type conversion functions ────────────────────────────────────────────

  clickhouseTest("Type conversion functions", async ({ clickhouseContainer }) => {
    const client = await setupClient(clickhouseContainer);
    await runCases(client, [
      ["toString", "SELECT toString(usage_duration_ms) AS r FROM task_runs"],
      ["toFixedString", "SELECT toFixedString(status, 30) AS r FROM task_runs"],
      ["toUInt8", "SELECT toUInt8(is_test) AS r FROM task_runs"],
      ["toUInt16", "SELECT toUInt16(usage_duration_ms) AS r FROM task_runs"],
      ["toUInt32", "SELECT toUInt32(usage_duration_ms) AS r FROM task_runs"],
      ["toUInt64", "SELECT toUInt64(usage_duration_ms) AS r FROM task_runs"],
      ["toInt8", "SELECT toInt8(1) AS r FROM task_runs"],
      ["toInt16", "SELECT toInt16(1) AS r FROM task_runs"],
      ["toInt32", "SELECT toInt32(1) AS r FROM task_runs"],
      ["toInt64", "SELECT toInt64(usage_duration_ms) AS r FROM task_runs"],
      ["toInt128", "SELECT toInt128(1) AS r FROM task_runs"],
      ["toInt256", "SELECT toInt256(1) AS r FROM task_runs"],
      ["toUInt128", "SELECT toUInt128(1) AS r FROM task_runs"],
      ["toUInt256", "SELECT toUInt256(1) AS r FROM task_runs"],
      ["toFloat32", "SELECT toFloat32(cost_in_cents) AS r FROM task_runs"],
      ["toFloat64", "SELECT toFloat64(cost_in_cents) AS r FROM task_runs"],
      ["toDecimal32", "SELECT toDecimal32(cost_in_cents, 2) AS r FROM task_runs"],
      ["toDecimal64", "SELECT toDecimal64(cost_in_cents, 2) AS r FROM task_runs"],
      ["toDecimal128", "SELECT toDecimal128(cost_in_cents, 2) AS r FROM task_runs"],
      ["toDecimal256", "SELECT toDecimal256(cost_in_cents, 2) AS r FROM task_runs"],
      ["toDate", "SELECT toDate(created_at) AS r FROM task_runs"],
      ["toDateOrNull", "SELECT toDateOrNull('2024-01-01') AS r FROM task_runs"],
      ["toDateOrZero", "SELECT toDateOrZero('invalid') AS r FROM task_runs"],
      ["toDate32", "SELECT toDate32(created_at) AS r FROM task_runs"],
      ["toDate32OrNull", "SELECT toDate32OrNull('2024-01-01') AS r FROM task_runs"],
      ["toDate32OrZero", "SELECT toDate32OrZero('invalid') AS r FROM task_runs"],
      ["toDateTime", "SELECT toDateTime(created_at) AS r FROM task_runs"],
      ["toDateTimeOrNull", "SELECT toDateTimeOrNull('2024-01-01 00:00:00') AS r FROM task_runs"],
      ["toDateTimeOrZero", "SELECT toDateTimeOrZero('invalid') AS r FROM task_runs"],
      ["toDateTime64", "SELECT toDateTime64(created_at, 3) AS r FROM task_runs"],
      [
        "toDateTime64OrNull",
        "SELECT toDateTime64OrNull('2024-01-01 00:00:00.000', 3) AS r FROM task_runs",
      ],
      ["toDateTime64OrZero", "SELECT toDateTime64OrZero('invalid', 3) AS r FROM task_runs"],
      ["toTypeName", "SELECT toTypeName(status) AS r FROM task_runs"],
    ]);
  });

  // ─── Date/time functions ──────────────────────────────────────────────────

  clickhouseTest("Date/time functions", async ({ clickhouseContainer }) => {
    const client = await setupClient(clickhouseContainer);
    await runCases(client, [
      ["now", "SELECT now() AS r FROM task_runs"],
      ["now64", "SELECT now64() AS r FROM task_runs"],
      ["today", "SELECT today() AS r FROM task_runs"],
      ["yesterday", "SELECT yesterday() AS r FROM task_runs"],
      ["toYear", "SELECT toYear(created_at) AS r FROM task_runs"],
      ["toQuarter", "SELECT toQuarter(created_at) AS r FROM task_runs"],
      ["toMonth", "SELECT toMonth(created_at) AS r FROM task_runs"],
      ["toDayOfYear", "SELECT toDayOfYear(created_at) AS r FROM task_runs"],
      ["toDayOfMonth", "SELECT toDayOfMonth(created_at) AS r FROM task_runs"],
      ["toDayOfWeek", "SELECT toDayOfWeek(created_at) AS r FROM task_runs"],
      ["toHour", "SELECT toHour(created_at) AS r FROM task_runs"],
      ["toMinute", "SELECT toMinute(created_at) AS r FROM task_runs"],
      ["toSecond", "SELECT toSecond(created_at) AS r FROM task_runs"],
      ["toUnixTimestamp", "SELECT toUnixTimestamp(created_at) AS r FROM task_runs"],
      ["toStartOfYear", "SELECT toStartOfYear(created_at) AS r FROM task_runs"],
      ["toStartOfQuarter", "SELECT toStartOfQuarter(created_at) AS r FROM task_runs"],
      ["toStartOfMonth", "SELECT toStartOfMonth(created_at) AS r FROM task_runs"],
      ["toMonday", "SELECT toMonday(created_at) AS r FROM task_runs"],
      ["toStartOfWeek", "SELECT toStartOfWeek(created_at) AS r FROM task_runs"],
      ["toStartOfDay", "SELECT toStartOfDay(created_at) AS r FROM task_runs"],
      ["toStartOfHour", "SELECT toStartOfHour(created_at) AS r FROM task_runs"],
      ["toStartOfMinute", "SELECT toStartOfMinute(created_at) AS r FROM task_runs"],
      ["toStartOfSecond", "SELECT toStartOfSecond(created_at) AS r FROM task_runs"],
      ["toStartOfFiveMinutes", "SELECT toStartOfFiveMinutes(created_at) AS r FROM task_runs"],
      ["toStartOfTenMinutes", "SELECT toStartOfTenMinutes(created_at) AS r FROM task_runs"],
      ["toStartOfFifteenMinutes", "SELECT toStartOfFifteenMinutes(created_at) AS r FROM task_runs"],
      [
        "toStartOfInterval",
        "SELECT toStartOfInterval(created_at, INTERVAL 1 hour) AS r FROM task_runs",
      ],
      ["toTime", "SELECT toTime(created_at) AS r FROM task_runs"],
      ["toISOYear", "SELECT toISOYear(created_at) AS r FROM task_runs"],
      ["toISOWeek", "SELECT toISOWeek(created_at) AS r FROM task_runs"],
      ["toWeek", "SELECT toWeek(created_at) AS r FROM task_runs"],
      ["toYearWeek", "SELECT toYearWeek(created_at) AS r FROM task_runs"],
      ["dateAdd (string unit)", "SELECT dateAdd('day', 7, created_at) AS r FROM task_runs"],
      ["dateAdd (keyword unit)", "SELECT dateAdd(day, 7, created_at) AS r FROM task_runs"],
      ["dateSub (string unit)", "SELECT dateSub('hour', 1, created_at) AS r FROM task_runs"],
      [
        "dateDiff (string unit)",
        "SELECT dateDiff('minute', created_at, updated_at) AS r FROM task_runs",
      ],
      [
        "dateDiff (millisecond)",
        "SELECT dateDiff('millisecond', created_at, updated_at) AS r FROM task_runs",
      ],
      [
        "dateDiff (microsecond)",
        "SELECT dateDiff('microsecond', created_at, updated_at) AS r FROM task_runs",
      ],
      [
        "dateDiff (nanosecond)",
        "SELECT dateDiff('nanosecond', created_at, updated_at) AS r FROM task_runs",
      ],
      ["dateTrunc (string unit)", "SELECT dateTrunc('month', created_at) AS r FROM task_runs"],
      ["date_add (string unit)", "SELECT date_add('day', 7, created_at) AS r FROM task_runs"],
      ["date_sub (string unit)", "SELECT date_sub('hour', 1, created_at) AS r FROM task_runs"],
      [
        "date_diff (string unit)",
        "SELECT date_diff('minute', created_at, updated_at) AS r FROM task_runs",
      ],
      ["date_trunc (string unit)", "SELECT date_trunc('month', created_at) AS r FROM task_runs"],
      ["addSeconds", "SELECT addSeconds(created_at, 10) AS r FROM task_runs"],
      ["addMinutes", "SELECT addMinutes(created_at, 10) AS r FROM task_runs"],
      ["addHours", "SELECT addHours(created_at, 1) AS r FROM task_runs"],
      ["addDays", "SELECT addDays(created_at, 1) AS r FROM task_runs"],
      ["addWeeks", "SELECT addWeeks(created_at, 1) AS r FROM task_runs"],
      ["addMonths", "SELECT addMonths(created_at, 1) AS r FROM task_runs"],
      ["addQuarters", "SELECT addQuarters(created_at, 1) AS r FROM task_runs"],
      ["addYears", "SELECT addYears(created_at, 1) AS r FROM task_runs"],
      ["subtractSeconds", "SELECT subtractSeconds(created_at, 10) AS r FROM task_runs"],
      ["subtractMinutes", "SELECT subtractMinutes(created_at, 10) AS r FROM task_runs"],
      ["subtractHours", "SELECT subtractHours(created_at, 1) AS r FROM task_runs"],
      ["subtractDays", "SELECT subtractDays(created_at, 1) AS r FROM task_runs"],
      ["subtractWeeks", "SELECT subtractWeeks(created_at, 1) AS r FROM task_runs"],
      ["subtractMonths", "SELECT subtractMonths(created_at, 1) AS r FROM task_runs"],
      ["subtractQuarters", "SELECT subtractQuarters(created_at, 1) AS r FROM task_runs"],
      ["subtractYears", "SELECT subtractYears(created_at, 1) AS r FROM task_runs"],
      ["toTimeZone", "SELECT toTimeZone(created_at, 'America/New_York') AS r FROM task_runs"],
      ["formatDateTime", "SELECT formatDateTime(created_at, '%Y-%m-%d') AS r FROM task_runs"],
      ["parseDateTime", "SELECT parseDateTime('2024-01-15', '%Y-%m-%d') AS r FROM task_runs"],
      [
        "parseDateTimeBestEffort",
        "SELECT parseDateTimeBestEffort('2024-01-15 10:30:00') AS r FROM task_runs",
      ],
      [
        "parseDateTimeBestEffortOrNull",
        "SELECT parseDateTimeBestEffortOrNull('invalid') AS r FROM task_runs",
      ],
      [
        "parseDateTimeBestEffortOrZero",
        "SELECT parseDateTimeBestEffortOrZero('invalid') AS r FROM task_runs",
      ],
      [
        "parseDateTime64BestEffort",
        "SELECT parseDateTime64BestEffort('2024-01-15 10:30:00.123') AS r FROM task_runs",
      ],
      [
        "parseDateTime64BestEffortOrNull",
        "SELECT parseDateTime64BestEffortOrNull('invalid') AS r FROM task_runs",
      ],
      [
        "parseDateTime64BestEffortOrZero",
        "SELECT parseDateTime64BestEffortOrZero('invalid') AS r FROM task_runs",
      ],
    ]);
  });

  // ─── Interval functions ───────────────────────────────────────────────────

  clickhouseTest("Interval functions", async ({ clickhouseContainer }) => {
    const client = await setupClient(clickhouseContainer);
    await runCases(client, [
      ["toIntervalSecond", "SELECT toIntervalSecond(10) AS r FROM task_runs"],
      ["toIntervalMinute", "SELECT toIntervalMinute(5) AS r FROM task_runs"],
      ["toIntervalHour", "SELECT toIntervalHour(1) AS r FROM task_runs"],
      ["toIntervalDay", "SELECT toIntervalDay(7) AS r FROM task_runs"],
      ["toIntervalWeek", "SELECT toIntervalWeek(2) AS r FROM task_runs"],
      ["toIntervalMonth", "SELECT toIntervalMonth(3) AS r FROM task_runs"],
      ["toIntervalQuarter", "SELECT toIntervalQuarter(1) AS r FROM task_runs"],
      ["toIntervalYear", "SELECT toIntervalYear(1) AS r FROM task_runs"],
    ]);
  });

  // ─── Array functions ──────────────────────────────────────────────────────

  clickhouseTest("Array functions", async ({ clickhouseContainer }) => {
    const client = await setupClient(clickhouseContainer);
    await runCases(client, [
      ["array", "SELECT array(1, 2, 3) AS r FROM task_runs"],
      ["range", "SELECT range(5) AS r FROM task_runs"],
      ["arrayElement", "SELECT arrayElement(tags, 1) AS r FROM task_runs"],
      ["has", "SELECT has(tags, 'tag-a') AS r FROM task_runs"],
      ["hasAll", "SELECT hasAll(tags, array('tag-a')) AS r FROM task_runs"],
      ["hasAny", "SELECT hasAny(tags, array('tag-a', 'tag-c')) AS r FROM task_runs"],
      ["hasSubstr", "SELECT hasSubstr(tags, array('tag-a')) AS r FROM task_runs"],
      ["indexOf", "SELECT indexOf(tags, 'tag-a') AS r FROM task_runs"],
      ["arrayCount", "SELECT arrayCount(array(1, 0, 1, 0)) AS r FROM task_runs"],
      ["countEqual", "SELECT countEqual(tags, 'tag-a') AS r FROM task_runs"],
      ["arrayEnumerate", "SELECT arrayEnumerate(tags) AS r FROM task_runs"],
      ["arrayEnumerateDense", "SELECT arrayEnumerateDense(tags) AS r FROM task_runs"],
      ["arrayEnumerateUniq", "SELECT arrayEnumerateUniq(tags) AS r FROM task_runs"],
      ["arrayPopBack", "SELECT arrayPopBack(tags) AS r FROM task_runs"],
      ["arrayPopFront", "SELECT arrayPopFront(tags) AS r FROM task_runs"],
      ["arrayPushBack", "SELECT arrayPushBack(tags, 'tag-new') AS r FROM task_runs"],
      ["arrayPushFront", "SELECT arrayPushFront(tags, 'tag-new') AS r FROM task_runs"],
      ["arrayResize", "SELECT arrayResize(tags, 5, '') AS r FROM task_runs"],
      ["arraySlice", "SELECT arraySlice(tags, 1, 1) AS r FROM task_runs"],
      ["arraySort", "SELECT arraySort(tags) AS r FROM task_runs"],
      ["arrayReverseSort", "SELECT arrayReverseSort(tags) AS r FROM task_runs"],
      ["arrayShuffle", "SELECT arrayShuffle(tags) AS r FROM task_runs"],
      ["arrayUniq", "SELECT arrayUniq(tags) AS r FROM task_runs"],
      ["arrayDifference", "SELECT arrayDifference(array(1, 2, 5)) AS r FROM task_runs"],
      ["arrayDistinct", "SELECT arrayDistinct(tags) AS r FROM task_runs"],
      ["arrayIntersect", "SELECT arrayIntersect(tags, array('tag-a')) AS r FROM task_runs"],
      ["arrayReduce", "SELECT arrayReduce('sum', array(1, 2, 3)) AS r FROM task_runs"],
      ["arrayReverse", "SELECT arrayReverse(tags) AS r FROM task_runs"],
      ["arrayFlatten", "SELECT arrayFlatten(array(array(1, 2), array(3))) AS r FROM task_runs"],
      ["arrayCompact", "SELECT arrayCompact(array(1, 1, 2, 3, 3)) AS r FROM task_runs"],
      ["arrayZip", "SELECT arrayZip(array(1, 2), array('a', 'b')) AS r FROM task_runs"],
      // Lambda-based array functions (arrayMap, arrayFilter, arrayExists, arrayAll,
      // arrayFirst, arrayLast, arrayFirstIndex, arrayLastIndex) are skipped because
      // TSQL schema validation resolves lambda variables (e.g. `x`) as column references.
      ["arrayMin", "SELECT arrayMin(array(1, 2, 3)) AS r FROM task_runs"],
      ["arrayMax", "SELECT arrayMax(array(1, 2, 3)) AS r FROM task_runs"],
      ["arraySum", "SELECT arraySum(array(1, 2, 3)) AS r FROM task_runs"],
      ["arrayAvg", "SELECT arrayAvg(array(1, 2, 3)) AS r FROM task_runs"],
      ["arrayCumSum", "SELECT arrayCumSum(array(1, 2, 3)) AS r FROM task_runs"],
      [
        "arrayCumSumNonNegative",
        "SELECT arrayCumSumNonNegative(array(1, -2, 3)) AS r FROM task_runs",
      ],
      ["arrayProduct", "SELECT arrayProduct(array(1, 2, 3)) AS r FROM task_runs"],
      ["arrayJoin", "SELECT arrayJoin(array(1, 2, 3)) AS r FROM task_runs"],
    ]);
  });

  // ─── JSON functions ───────────────────────────────────────────────────────

  clickhouseTest("JSON functions", async ({ clickhouseContainer }) => {
    const client = await setupClient(clickhouseContainer);
    await runCases(client, [
      ["JSONHas", `SELECT JSONHas('{"a": 1}', 'a') AS r FROM task_runs`],
      ["JSONLength", `SELECT JSONLength('{"a": 1, "b": 2}') AS r FROM task_runs`],
      ["JSONType", `SELECT JSONType('{"a": 1}', 'a') AS r FROM task_runs`],
      ["JSONExtractUInt", `SELECT JSONExtractUInt('{"a": 1}', 'a') AS r FROM task_runs`],
      ["JSONExtractInt", `SELECT JSONExtractInt('{"a": -1}', 'a') AS r FROM task_runs`],
      ["JSONExtractFloat", `SELECT JSONExtractFloat('{"a": 1.5}', 'a') AS r FROM task_runs`],
      ["JSONExtractBool", `SELECT JSONExtractBool('{"a": true}', 'a') AS r FROM task_runs`],
      ["JSONExtractString", `SELECT JSONExtractString('{"a": "hello"}', 'a') AS r FROM task_runs`],
      ["JSONExtractRaw", `SELECT JSONExtractRaw('{"a": [1,2]}', 'a') AS r FROM task_runs`],
      [
        "JSONExtractArrayRaw",
        `SELECT JSONExtractArrayRaw('{"a": [1,2]}', 'a') AS r FROM task_runs`,
      ],
      ["JSONExtractKeys", `SELECT JSONExtractKeys('{"a": 1, "b": 2}') AS r FROM task_runs`],
      ["toJSONString", "SELECT toJSONString(map('a', 1)) AS r FROM task_runs"],
    ]);
  });

  // ─── Tuple functions ──────────────────────────────────────────────────────

  clickhouseTest("Tuple functions", async ({ clickhouseContainer }) => {
    const client = await setupClient(clickhouseContainer);
    await runCases(client, [
      ["tuple", "SELECT tuple(1, 'a', 3.14) AS r FROM task_runs"],
      ["tupleElement", "SELECT tupleElement(tuple(1, 'a'), 1) AS r FROM task_runs"],
      ["untuple", "SELECT untuple(tuple(1, 'a')) FROM task_runs"],
    ]);
  });

  // ─── Map functions ────────────────────────────────────────────────────────

  clickhouseTest("Map functions", async ({ clickhouseContainer }) => {
    const client = await setupClient(clickhouseContainer);
    await runCases(client, [
      ["map", "SELECT map('a', 1, 'b', 2) AS r FROM task_runs"],
      ["mapFromArrays", "SELECT mapFromArrays(array('a', 'b'), array(1, 2)) AS r FROM task_runs"],
      ["mapContains", "SELECT mapContains(map('a', 1), 'a') AS r FROM task_runs"],
      ["mapKeys", "SELECT mapKeys(map('a', 1, 'b', 2)) AS r FROM task_runs"],
      ["mapValues", "SELECT mapValues(map('a', 1, 'b', 2)) AS r FROM task_runs"],
    ]);
  });

  // ─── Hash functions ───────────────────────────────────────────────────────

  clickhouseTest("Hash functions", async ({ clickhouseContainer }) => {
    const client = await setupClient(clickhouseContainer);
    await runCases(client, [
      ["MD5", "SELECT hex(MD5('hello')) AS r FROM task_runs"],
      ["SHA1", "SELECT hex(SHA1('hello')) AS r FROM task_runs"],
      ["SHA224", "SELECT hex(SHA224('hello')) AS r FROM task_runs"],
      ["SHA256", "SELECT hex(SHA256('hello')) AS r FROM task_runs"],
      ["SHA384", "SELECT hex(SHA384('hello')) AS r FROM task_runs"],
      ["SHA512", "SELECT hex(SHA512('hello')) AS r FROM task_runs"],
      ["sipHash64", "SELECT sipHash64('hello') AS r FROM task_runs"],
      ["sipHash128", "SELECT hex(sipHash128('hello')) AS r FROM task_runs"],
      ["cityHash64", "SELECT cityHash64('hello') AS r FROM task_runs"],
      ["intHash32", "SELECT intHash32(42) AS r FROM task_runs"],
      ["intHash64", "SELECT intHash64(42) AS r FROM task_runs"],
      ["farmHash64", "SELECT farmHash64('hello') AS r FROM task_runs"],
      ["farmFingerprint64", "SELECT farmFingerprint64('hello') AS r FROM task_runs"],
      ["xxHash32", "SELECT xxHash32('hello') AS r FROM task_runs"],
      ["xxHash64", "SELECT xxHash64('hello') AS r FROM task_runs"],
      ["murmurHash2_32", "SELECT murmurHash2_32('hello') AS r FROM task_runs"],
      ["murmurHash2_64", "SELECT murmurHash2_64('hello') AS r FROM task_runs"],
      ["murmurHash3_32", "SELECT murmurHash3_32('hello') AS r FROM task_runs"],
      ["murmurHash3_64", "SELECT murmurHash3_64('hello') AS r FROM task_runs"],
      ["murmurHash3_128", "SELECT hex(murmurHash3_128('hello')) AS r FROM task_runs"],
      ["hex", "SELECT hex(255) AS r FROM task_runs"],
      ["unhex", "SELECT unhex('48656C6C6F') AS r FROM task_runs"],
    ]);
  });

  // ─── URL functions ────────────────────────────────────────────────────────

  clickhouseTest("URL functions", async ({ clickhouseContainer }) => {
    const client = await setupClient(clickhouseContainer);
    await runCases(client, [
      ["protocol", `SELECT protocol('${url}') AS r FROM task_runs`],
      ["domain", `SELECT domain('${url}') AS r FROM task_runs`],
      ["domainWithoutWWW", `SELECT domainWithoutWWW('${url}') AS r FROM task_runs`],
      ["topLevelDomain", `SELECT topLevelDomain('${url}') AS r FROM task_runs`],
      [
        "firstSignificantSubdomain",
        `SELECT firstSignificantSubdomain('${url}') AS r FROM task_runs`,
      ],
      [
        "cutToFirstSignificantSubdomain",
        `SELECT cutToFirstSignificantSubdomain('${url}') AS r FROM task_runs`,
      ],
      [
        "cutToFirstSignificantSubdomainWithWWW",
        `SELECT cutToFirstSignificantSubdomainWithWWW('${url}') AS r FROM task_runs`,
      ],
      ["port", `SELECT port('${url}') AS r FROM task_runs`],
      ["path", `SELECT path('${url}') AS r FROM task_runs`],
      ["pathFull", `SELECT pathFull('${url}') AS r FROM task_runs`],
      ["queryString", `SELECT queryString('${url}') AS r FROM task_runs`],
      ["fragment", `SELECT fragment('${url}') AS r FROM task_runs`],
      ["extractURLParameter", `SELECT extractURLParameter('${url}', 'q') AS r FROM task_runs`],
      ["extractURLParameters", `SELECT extractURLParameters('${url}') AS r FROM task_runs`],
      ["encodeURLComponent", "SELECT encodeURLComponent('hello world') AS r FROM task_runs"],
      ["decodeURLComponent", "SELECT decodeURLComponent('hello%20world') AS r FROM task_runs"],
    ]);
  });

  // ─── UUID functions ───────────────────────────────────────────────────────

  clickhouseTest("UUID functions", async ({ clickhouseContainer }) => {
    const client = await setupClient(clickhouseContainer);
    await runCases(client, [
      ["generateUUIDv4", "SELECT generateUUIDv4() AS r FROM task_runs"],
      [
        "UUIDStringToNum",
        "SELECT UUIDStringToNum('00000000-0000-0000-0000-000000000000') AS r FROM task_runs",
      ],
      [
        "UUIDNumToString",
        "SELECT UUIDNumToString(UUIDStringToNum('00000000-0000-0000-0000-000000000000')) AS r FROM task_runs",
      ],
      ["toUUID", "SELECT toUUID('00000000-0000-0000-0000-000000000000') AS r FROM task_runs"],
      ["toUUIDOrNull", "SELECT toUUIDOrNull('not-a-uuid') AS r FROM task_runs"],
      ["toUUIDOrZero", "SELECT toUUIDOrZero('not-a-uuid') AS r FROM task_runs"],
    ]);
  });

  // ─── Misc functions ───────────────────────────────────────────────────────

  clickhouseTest("Misc functions", async ({ clickhouseContainer }) => {
    const client = await setupClient(clickhouseContainer);
    await runCases(client, [
      ["isFinite", "SELECT isFinite(1.0) AS r FROM task_runs"],
      ["isInfinite", "SELECT isInfinite(1.0 / 0) AS r FROM task_runs"],
      // ifNotFinite: TSQL definition has maxArgs: 1, but ClickHouse expects 2.
      // Skipped until the function definition is fixed.
      // ["ifNotFinite", "SELECT ifNotFinite(1.0 / 0, 0) AS r FROM task_runs"],
      ["isNaN", "SELECT isNaN(0.0 / 0) AS r FROM task_runs"],
      ["bar", "SELECT bar(usage_duration_ms, 0, 10000, 20) AS r FROM task_runs"],
      [
        "transform",
        "SELECT transform(status, array('PENDING', 'COMPLETED_SUCCESSFULLY'), array('P', 'C'), 'X') AS r FROM task_runs",
      ],
      [
        "formatReadableDecimalSize",
        "SELECT formatReadableDecimalSize(1000000) AS r FROM task_runs",
      ],
      ["formatReadableSize", "SELECT formatReadableSize(1000000) AS r FROM task_runs"],
      ["formatReadableQuantity", "SELECT formatReadableQuantity(1000000) AS r FROM task_runs"],
      ["formatReadableTimeDelta", "SELECT formatReadableTimeDelta(3661) AS r FROM task_runs"],
      ["least", "SELECT least(1, 2) AS r FROM task_runs"],
      ["greatest", "SELECT greatest(1, 2) AS r FROM task_runs"],
      ["min2", "SELECT min2(1, 2) AS r FROM task_runs"],
      ["max2", "SELECT max2(1, 2) AS r FROM task_runs"],
    ]);
  });

  // ─── Aggregate functions ──────────────────────────────────────────────────

  clickhouseTest("Aggregate functions", async ({ clickhouseContainer }) => {
    const client = await setupClient(clickhouseContainer);
    await runCases(client, [
      ["count()", "SELECT count() AS r FROM task_runs"],
      ["count(col)", "SELECT count(run_id) AS r FROM task_runs"],
      ["countDistinct", "SELECT countDistinct(status) AS r FROM task_runs"],
      ["min", "SELECT min(usage_duration_ms) AS r FROM task_runs"],
      ["max", "SELECT max(usage_duration_ms) AS r FROM task_runs"],
      ["sum", "SELECT sum(usage_duration_ms) AS r FROM task_runs"],
      ["avg", "SELECT avg(usage_duration_ms) AS r FROM task_runs"],
      ["any", "SELECT any(status) AS r FROM task_runs"],
      ["anyLast", "SELECT anyLast(status) AS r FROM task_runs"],
      ["anyHeavy", "SELECT anyHeavy(status) AS r FROM task_runs"],
      ["argMin", "SELECT argMin(run_id, usage_duration_ms) AS r FROM task_runs"],
      ["argMax", "SELECT argMax(run_id, usage_duration_ms) AS r FROM task_runs"],
      ["stddevPop", "SELECT stddevPop(usage_duration_ms) AS r FROM task_runs"],
      ["stddevSamp", "SELECT stddevSamp(usage_duration_ms) AS r FROM task_runs"],
      ["varPop", "SELECT varPop(usage_duration_ms) AS r FROM task_runs"],
      ["varSamp", "SELECT varSamp(usage_duration_ms) AS r FROM task_runs"],
      ["covarPop", "SELECT covarPop(usage_duration_ms, cost_in_cents) AS r FROM task_runs"],
      ["covarSamp", "SELECT covarSamp(usage_duration_ms, cost_in_cents) AS r FROM task_runs"],
      ["corr", "SELECT corr(usage_duration_ms, cost_in_cents) AS r FROM task_runs"],
      ["groupArray", "SELECT groupArray(status) AS r FROM task_runs"],
      ["groupUniqArray", "SELECT groupUniqArray(status) AS r FROM task_runs"],
      ["groupArrayMovingAvg", "SELECT groupArrayMovingAvg(usage_duration_ms) AS r FROM task_runs"],
      ["groupArrayMovingSum", "SELECT groupArrayMovingSum(usage_duration_ms) AS r FROM task_runs"],
      ["uniq", "SELECT uniq(status) AS r FROM task_runs"],
      ["uniqExact", "SELECT uniqExact(status) AS r FROM task_runs"],
      ["uniqHLL12", "SELECT uniqHLL12(status) AS r FROM task_runs"],
      ["uniqTheta", "SELECT uniqTheta(status) AS r FROM task_runs"],
      ["median", "SELECT median(usage_duration_ms) AS r FROM task_runs"],
      ["medianExact", "SELECT medianExact(usage_duration_ms) AS r FROM task_runs"],
      ["quantile", "SELECT quantile(0.95)(usage_duration_ms) AS r FROM task_runs"],
      ["quantiles", "SELECT quantiles(0.5, 0.9, 0.99)(usage_duration_ms) AS r FROM task_runs"],
      ["topK", "SELECT topK(3)(status) AS r FROM task_runs"],
      [
        "simpleLinearRegression",
        "SELECT simpleLinearRegression(usage_duration_ms, cost_in_cents) AS r FROM task_runs",
      ],
      ["groupArraySample", "SELECT groupArraySample(2)(status) AS r FROM task_runs"],
    ]);
  });

  // ─── Conditional aggregate functions ──────────────────────────────────────

  clickhouseTest("Conditional aggregate functions", async ({ clickhouseContainer }) => {
    const client = await setupClient(clickhouseContainer);
    await runCases(client, [
      ["countIf", "SELECT countIf(usage_duration_ms > 1000) AS r FROM task_runs"],
      [
        "countDistinctIf",
        "SELECT countDistinctIf(status, usage_duration_ms > 0) AS r FROM task_runs",
      ],
      ["minIf", "SELECT minIf(usage_duration_ms, is_test = 0) AS r FROM task_runs"],
      ["maxIf", "SELECT maxIf(usage_duration_ms, is_test = 0) AS r FROM task_runs"],
      ["sumIf", "SELECT sumIf(usage_duration_ms, is_test = 0) AS r FROM task_runs"],
      ["avgIf", "SELECT avgIf(usage_duration_ms, is_test = 0) AS r FROM task_runs"],
      ["anyIf", "SELECT anyIf(status, usage_duration_ms > 0) AS r FROM task_runs"],
      ["anyLastIf", "SELECT anyLastIf(status, usage_duration_ms > 0) AS r FROM task_runs"],
      ["anyHeavyIf", "SELECT anyHeavyIf(status, usage_duration_ms > 0) AS r FROM task_runs"],
      ["groupArrayIf", "SELECT groupArrayIf(status, usage_duration_ms > 0) AS r FROM task_runs"],
      [
        "groupUniqArrayIf",
        "SELECT groupUniqArrayIf(status, usage_duration_ms > 0) AS r FROM task_runs",
      ],
      ["uniqIf", "SELECT uniqIf(status, usage_duration_ms > 0) AS r FROM task_runs"],
      ["uniqExactIf", "SELECT uniqExactIf(status, usage_duration_ms > 0) AS r FROM task_runs"],
      ["medianIf", "SELECT medianIf(usage_duration_ms, is_test = 0) AS r FROM task_runs"],
      ["quantileIf", "SELECT quantileIf(0.95)(usage_duration_ms, is_test = 0) AS r FROM task_runs"],
      ["argMinIf", "SELECT argMinIf(run_id, usage_duration_ms, is_test = 0) AS r FROM task_runs"],
      ["argMaxIf", "SELECT argMaxIf(run_id, usage_duration_ms, is_test = 0) AS r FROM task_runs"],
    ]);
  });

  // ─── Search functions ─────────────────────────────────────────────────────

  clickhouseTest("Search functions", async ({ clickhouseContainer }) => {
    const client = await setupClient(clickhouseContainer);
    await runCases(client, [
      [
        "multiMatchAny",
        "SELECT multiMatchAny(status, array('COMPLETED.*', 'PENDING')) AS r FROM task_runs",
      ],
      [
        "multiMatchAnyIndex",
        "SELECT multiMatchAnyIndex(status, array('COMPLETED.*', 'PENDING')) AS r FROM task_runs",
      ],
      [
        "multiMatchAllIndices",
        "SELECT multiMatchAllIndices(status, array('COMPLETED.*', 'PEND.*')) AS r FROM task_runs",
      ],
      [
        "multiSearchFirstPosition",
        "SELECT multiSearchFirstPosition(status, array('COMP', 'PEND')) AS r FROM task_runs",
      ],
      [
        "multiSearchFirstIndex",
        "SELECT multiSearchFirstIndex(status, array('COMP', 'PEND')) AS r FROM task_runs",
      ],
      [
        "multiSearchAny",
        "SELECT multiSearchAny(status, array('COMP', 'PEND')) AS r FROM task_runs",
      ],
      ["extract", "SELECT extract(status, '[A-Z]+') AS r FROM task_runs"],
      ["extractAll", "SELECT extractAll(status, '[A-Z]+') AS r FROM task_runs"],
      [
        "extractAllGroupsHorizontal",
        "SELECT extractAllGroupsHorizontal(status, '([A-Z]+)') AS r FROM task_runs",
      ],
      [
        "extractAllGroupsVertical",
        "SELECT extractAllGroupsVertical(status, '([A-Z]+)') AS r FROM task_runs",
      ],
    ]);
  });
});
