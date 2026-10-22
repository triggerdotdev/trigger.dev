import {
  getCapability,
  compileTemplate as compileTemplateWithParams,
  type AlertCapability,
  type AlertParams,
  type Condition,
  type EvaluationResult,
} from "@internal/alert-contracts";

type ScalarCapability = AlertCapability & {
  binding: AlertCapability["binding"] & { template: string; table: string };
};

const GAUGE_HORIZON_MULTIPLIER = 3;

export interface QueryEvaluatorConfig {
  failureRateMinVolume: number;
  snapshotRangeSec: number;
  rowsCap?: number;
}

export const DEFAULT_QUERY_EVALUATOR_CONFIG: QueryEvaluatorConfig = {
  failureRateMinVolume: 10,
  snapshotRangeSec: 90 * 86_400,
};

type RowOccurrence = { sourceEventId?: string; facts: Record<string, unknown> };

export type QueryEvaluationResult =
  | Exclude<EvaluationResult, { kind: "occurrence" }>
  | (Omit<Extract<EvaluationResult, { kind: "occurrence" }>, "occurrences"> & {
      occurrences: RowOccurrence[];
    });

export interface QueryEvaluatorInput {
  capabilityKey: string;
  params: AlertParams;
  condition: Condition;
  organizationId: string;
  projectId: string;
  now: Date;
  ctx?: Record<string, string>;
}

export type QueryRowRunner = (
  query: string,
  context: { organizationId: string; projectId: string; environmentId: string },
  range: { from: string; to: string },
  opts?: { fullRetention?: boolean }
) => Promise<Record<string, unknown>[]>;

export function compileTemplate(
  template: string,
  vars: { scope: string; params?: Record<string, number> }
): string {
  return compileTemplateWithParams(template, vars.scope, vars.params);
}

/** Rejects control characters and escapes backslash before quote, so a trailing
 * backslash in scope input can't consume the closing quote (ClickHouse's lexer treats
 * backslash as an escape char, so naively doubling only the quote isn't enough). */
export function escapeTsqlString(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(value)) {
    throw new Error("Invalid character in alert scope value");
  }
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

export function scopeWhere(params: AlertParams): string {
  switch (params.scope.type) {
    case "queue":
      return `queue = '${escapeTsqlString(params.scope.queue)}'`;
    case "queuePattern":
      return `queue LIKE '${escapeTsqlString(params.scope.pattern)}'`;
    case "task":
      return `task_identifier = '${escapeTsqlString(params.scope.taskIdentifier)}'`;
    case "all":
      return "1 = 1";
    case "errorGroup":
      return `task_identifier = '${escapeTsqlString(params.scope.taskIdentifier)}' AND error_fingerprint = '${escapeTsqlString(params.scope.fingerprint)}'`;
  }
}

function toLatestBucketTemplate(template: string): string {
  return template.replace(/\bmax\(([^)]+)\)/g, (_, col) => `argMax(${col}, bucket_start)`);
}

function toHorizonStateTemplate(template: string): string {
  return template
    .replace(/deltaSumTimestampMerge\(started_delta\)/g, "0")
    .replace(
      /\bmax\(max_queued\)/g,
      "argMaxIf(max_queued, bucket_start, max_queued > 0 OR max_running > 0 OR max_limit > 0 OR max_env_limit > 0)"
    );
}

function windowRange(now: Date, windowSec: number): { from: string; to: string } {
  return {
    from: new Date(now.getTime() - windowSec * 1000).toISOString(),
    to: now.toISOString(),
  };
}

function extractScalar(row: Record<string, unknown> | undefined): number | null {
  if (!row) return null;
  const value = Object.values(row)[0];
  if (value === null || value === undefined) return null;
  const num = Number(value);
  return Number.isNaN(num) ? null : num;
}

function compareThreshold(value: number, condition: Extract<Condition, { kind: "threshold" }>) {
  return condition.operator === ">" ? value > condition.value : value < condition.value;
}

function buildFacts(
  value: number | null,
  windowSec: number,
  bucketSec: number,
  now: Date,
  unit: AlertCapability["unit"],
  threshold?: number,
  extra?: Record<string, unknown>
) {
  return {
    value,
    unit,
    threshold,
    windowSec,
    bucketSec,
    observedAt: now.toISOString(),
    ...extra,
  };
}

async function runScalars(
  template: string,
  scope: string,
  input: QueryEvaluatorInput,
  range: { from: string; to: string },
  runner: QueryRowRunner,
  params?: Record<string, number>
): Promise<number[]> {
  const rows = await runner(
    compileTemplate(template, { scope, params }),
    {
      organizationId: input.organizationId,
      projectId: input.projectId,
      environmentId: input.params.environmentId,
    },
    range
  );
  return rows.map((row) => extractScalar(row)).filter((v): v is number => v !== null);
}

interface KeyedValue {
  key: string;
  value: number;
}

const SCALAR_KEY = "__scalar__";

function extractKeyedValue(row: Record<string, unknown>): KeyedValue | null {
  let key: string | undefined;
  let raw: unknown;
  for (const value of Object.values(row)) {
    if (typeof value === "string" && key === undefined) {
      key = value;
    } else {
      raw = value;
    }
  }
  if (key === undefined) {
    const scalar = extractScalar(row);
    if (scalar !== null) return { key: SCALAR_KEY, value: scalar };
    return null;
  }
  if (raw === null || raw === undefined) return null;
  const value = Number(raw);
  return Number.isNaN(value) ? null : { key, value };
}

async function runKeyedValues(
  template: string,
  scope: string,
  input: QueryEvaluatorInput,
  range: { from: string; to: string },
  runner: QueryRowRunner,
  params?: Record<string, number>
): Promise<Map<string, number>> {
  const rows = await runner(
    compileTemplate(template, { scope, params }),
    {
      organizationId: input.organizationId,
      projectId: input.projectId,
      environmentId: input.params.environmentId,
    },
    range
  );
  const map = new Map<string, number>();
  for (const row of rows) {
    const kv = extractKeyedValue(row);
    if (kv) map.set(kv.key, kv.value);
  }
  return map;
}

function worstOffender(
  offenders: KeyedValue[],
  operator: Extract<Condition, { kind: "threshold" }>["operator"]
) {
  return offenders.reduce((worst, o) =>
    (operator === ">" ? o.value > worst.value : o.value < worst.value) ? o : worst
  );
}

const GROUP_SCOPE_TYPES = new Set(["queuePattern", "all"]);

async function evaluateGaugeThreshold(
  capability: ScalarCapability,
  input: QueryEvaluatorInput,
  runner: QueryRowRunner
): Promise<EvaluationResult> {
  const condition = input.condition;
  if (condition.kind !== "threshold") {
    throw new Error(`${capability.key} requires a threshold condition`);
  }
  if (capability.binding.type !== "query") {
    throw new Error(`${capability.key} is not a query-bound capability`);
  }

  const bucketSec = capability.binding.minCadenceSec;
  const scope = scopeWhere(input.params);
  const windowSec = condition.windowSec;
  const horizonSec = bucketSec * GAUGE_HORIZON_MULTIPLIER;

  const horizonTemplate = toLatestBucketTemplate(capability.binding.template);

  const horizon = await runKeyedValues(
    horizonTemplate,
    scope,
    input,
    windowRange(input.now, horizonSec),
    runner
  );
  const current = await runKeyedValues(
    capability.binding.template,
    scope,
    input,
    windowRange(input.now, windowSec),
    runner
  );

  const merged = new Map<string, number>(horizon);
  for (const [key, value] of current) merged.set(key, value);

  if (merged.size === 0) {
    return {
      kind: "stateful",
      outcome: "unavailable",
      facts: buildFacts(null, windowSec, bucketSec, input.now, capability.unit, condition.value, {
        unavailableReason: "stale_beyond_horizon",
      }),
    };
  }

  const offenders = Array.from(merged, ([key, value]) => ({ key, value }));
  const anyMet = offenders.some((o) => compareThreshold(o.value, condition));
  const worst = worstOffender(offenders, condition.operator);
  const isGroupScope = GROUP_SCOPE_TYPES.has(input.params.scope.type);

  return {
    kind: "stateful",
    outcome: anyMet ? "met" : "not_met",
    facts: buildFacts(
      worst.value,
      windowSec,
      bucketSec,
      input.now,
      capability.unit,
      condition.value,
      isGroupScope ? { offenders } : undefined
    ),
  };
}

async function evaluateSnapshotThreshold(
  capability: ScalarCapability,
  input: QueryEvaluatorInput,
  runner: QueryRowRunner,
  config: QueryEvaluatorConfig
): Promise<EvaluationResult> {
  const condition = input.condition;
  if (condition.kind !== "threshold") {
    throw new Error(`${capability.key} requires a threshold condition`);
  }
  if (capability.binding.type !== "query") {
    throw new Error(`${capability.key} is not a query-bound capability`);
  }

  const bucketSec = capability.binding.minCadenceSec;
  const scope = scopeWhere(input.params);
  const windowSec = condition.windowSec;

  const values = await runScalars(
    capability.binding.template,
    scope,
    input,
    windowRange(input.now, config.snapshotRangeSec),
    runner
  );
  const value = values[0] ?? 0;

  return {
    kind: "stateful",
    outcome: compareThreshold(value, condition) ? "met" : "not_met",
    facts: buildFacts(value, windowSec, bucketSec, input.now, capability.unit, condition.value),
  };
}

async function evaluateCounterThreshold(
  capability: ScalarCapability,
  input: QueryEvaluatorInput,
  runner: QueryRowRunner
): Promise<EvaluationResult> {
  const condition = input.condition;
  if (condition.kind !== "threshold") {
    throw new Error(`${capability.key} requires a threshold condition`);
  }
  if (capability.binding.type !== "query") {
    throw new Error(`${capability.key} is not a query-bound capability`);
  }

  const bucketSec = capability.binding.minCadenceSec;
  const scope = scopeWhere(input.params);
  const windowSec = condition.windowSec;

  const values = await runScalars(
    capability.binding.template,
    scope,
    input,
    windowRange(input.now, windowSec),
    runner
  );

  const value = values[0] ?? 0;
  return {
    kind: "stateful",
    outcome: compareThreshold(value, condition) ? "met" : "not_met",
    facts: buildFacts(value, windowSec, bucketSec, input.now, capability.unit, condition.value),
  };
}

async function evaluateThreshold(
  capability: ScalarCapability,
  input: QueryEvaluatorInput,
  runner: QueryRowRunner,
  config: QueryEvaluatorConfig
): Promise<EvaluationResult> {
  switch (capability.freshness) {
    case "gauge":
      return evaluateGaugeThreshold(capability, input, runner);
    case "snapshot":
      return evaluateSnapshotThreshold(capability, input, runner, config);
    case "counter":
      return evaluateCounterThreshold(capability, input, runner);
  }
}

async function evaluateFailureRate(
  capability: ScalarCapability,
  input: QueryEvaluatorInput,
  runner: QueryRowRunner,
  config: QueryEvaluatorConfig
): Promise<EvaluationResult> {
  const condition = input.condition;
  if (condition.kind !== "threshold") {
    throw new Error("runs.failure_rate requires a threshold condition");
  }
  if (capability.binding.type !== "query") {
    throw new Error("runs.failure_rate is not a query-bound capability");
  }

  const bucketSec = capability.binding.minCadenceSec;
  const scope = scopeWhere(input.params);
  const windowSec = condition.windowSec;
  const range = windowRange(input.now, windowSec);

  const FINISHED_VOLUME_TEMPLATE = "SELECT count() FROM runs WHERE {{scope}} AND is_finished = 1";
  const totalValues = await runScalars(FINISHED_VOLUME_TEMPLATE, scope, input, range, runner);
  const total = totalValues[0] ?? 0;

  if (total < config.failureRateMinVolume) {
    return {
      kind: "stateful",
      outcome: "not_met",
      facts: buildFacts(null, windowSec, bucketSec, input.now, capability.unit, condition.value, {
        lowVolume: true,
        total,
      }),
    };
  }

  const rateValues = await runScalars(capability.binding.template, scope, input, range, runner);
  if (rateValues.length === 0) {
    return {
      kind: "stateful",
      outcome: "unavailable",
      facts: buildFacts(null, windowSec, bucketSec, input.now, capability.unit, condition.value, {
        total,
        unavailableReason: "empty_result",
      }),
    };
  }

  const rate = rateValues[0]!;
  return {
    kind: "stateful",
    outcome: compareThreshold(rate, condition) ? "met" : "not_met",
    facts: buildFacts(rate, windowSec, bucketSec, input.now, capability.unit, condition.value, {
      total,
    }),
  };
}

export const ROWS_CAP = 200;

export const DEFAULT_CHECKPOINT_LOOKBACK_SEC = 3600;

export function checkpointSince(
  checkpoint: Date | undefined,
  createdAt: Date,
  lookbackSec: number,
  retention?: { now: Date; seenRetentionSec: number; floor?: Date }
): Date {
  const floored = checkpoint ? Math.floor(checkpoint.getTime() / 60_000) * 60_000 : undefined;
  const base =
    floored === undefined
      ? createdAt.getTime()
      : Math.max(createdAt.getTime(), floored - lookbackSec * 1000);
  if (!retention) return new Date(base);
  const minSince = retention.now.getTime() - (retention.seenRetentionSec - lookbackSec) * 1000;
  return new Date(Math.max(base, minSince, retention.floor?.getTime() ?? 0));
}

export function forwardUntil(now: Date): Date {
  return new Date(Math.floor(now.getTime() / 60_000) * 60_000 + 60_000);
}

export function clickhouseDateTimeLiteral(date: Date): string {
  return `'${date.toISOString().slice(0, 19).replace("T", " ")}'`;
}

export type RowCursor = Array<[column: string, value: string]>;

export function keysetAfter(cursor: RowCursor): string {
  const [[column, value], ...rest] = cursor as [RowCursor[number], ...RowCursor];
  const literal = `'${escapeTsqlString(value)}'`;
  return rest.length === 0
    ? `${column} > ${literal}`
    : `(${column} > ${literal} OR (${column} = ${literal} AND ${keysetAfter(rest)}))`;
}

function rowKeyPart(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

async function evaluateRows(
  capability: AlertCapability,
  input: QueryEvaluatorInput,
  runner: QueryRowRunner,
  config: QueryEvaluatorConfig
): Promise<QueryEvaluationResult> {
  const binding = capability.binding;
  if (!binding.template || !binding.rowKey?.length) {
    throw new Error(`${capability.key} has no template or rowKey`);
  }
  const rowKey = binding.rowKey;
  const cap = config.rowsCap ?? ROWS_CAP;

  const query = `${compileTemplateWithParams(
    binding.template,
    scopeWhere(input.params),
    undefined,
    { until: clickhouseDateTimeLiteral(forwardUntil(input.now)), after: "1 = 1", ...input.ctx }
  )} LIMIT ${cap + 1}`;
  const rows = await runner(
    query,
    {
      organizationId: input.organizationId,
      projectId: input.projectId,
      environmentId: input.params.environmentId,
    },
    windowRange(input.now, config.snapshotRangeSec),
    { fullRetention: binding.fullRetention }
  );

  const capped = rows.length > cap;
  const occurrences = rows.slice(0, cap).map((row) => ({
    sourceEventId: [
      capability.key,
      input.params.environmentId,
      ...rowKey.map((col) => rowKeyPart(row[col])),
    ].join(":"),
    facts: { ...row },
  }));

  return {
    kind: "occurrence",
    outcome: occurrences.length > 0 ? "met" : "not_met",
    occurrences,
    facts: {
      observedAt: input.now.toISOString(),
      rowCount: occurrences.length,
      rowCap: cap,
      capped,
    },
  };
}

export function resolveEffectiveParams(
  condition: Extract<Condition, { kind: "state" }> | undefined,
  declared: Array<{ key: string; default: number }> | undefined
): Record<string, number> {
  const condParams = condition?.params ?? {};
  const result: Record<string, number> = {};
  if (declared) {
    for (const p of declared) {
      result[p.key] = condParams[p.key] ?? p.default;
    }
  }
  return result;
}

async function evaluateState(
  capability: AlertCapability,
  input: QueryEvaluatorInput,
  runner: QueryRowRunner
): Promise<EvaluationResult> {
  const condition = input.condition;
  if (condition.kind !== "state") {
    throw new Error(`${capability.key} requires a state condition`);
  }
  if (capability.binding.type !== "query" || !capability.binding.template) {
    throw new Error(`${capability.key} is not a query-bound capability`);
  }

  const bucketSec = capability.binding.minCadenceSec;
  const scope = scopeWhere(input.params);
  const effectiveParams = resolveEffectiveParams(condition, capability.binding.params);
  const windowParam = capability.binding.windowParam;
  const windowSec = Math.max(
    input.params.windowSec ?? bucketSec,
    windowParam ? (effectiveParams[windowParam] ?? 0) + bucketSec : 0
  );

  let effective = await runScalars(
    capability.binding.template,
    scope,
    input,
    windowRange(input.now, windowSec),
    runner,
    effectiveParams
  );

  if (effective.length === 0 && capability.freshness === "gauge") {
    const horizonSec = bucketSec * GAUGE_HORIZON_MULTIPLIER;
    const horizonValues = await runScalars(
      toHorizonStateTemplate(capability.binding.template),
      scope,
      input,
      windowRange(input.now, horizonSec),
      runner,
      effectiveParams
    );
    if (horizonValues.length === 0) {
      return {
        kind: "stateful",
        outcome: "unavailable",
        facts: buildFacts(null, windowSec, bucketSec, input.now, capability.unit, undefined, {
          unavailableReason: "stale_beyond_horizon",
        }),
      };
    }
    effective = horizonValues;
  }

  const anyTrue = effective.some((v) => v !== 0);
  return {
    kind: "stateful",
    outcome: anyTrue ? "met" : "not_met",
    facts: buildFacts(
      anyTrue ? 1 : 0,
      windowSec,
      bucketSec,
      input.now,
      capability.unit,
      undefined,
      {
        effectiveParams,
      }
    ),
  };
}

async function evaluateAbsence(
  capability: ScalarCapability,
  input: QueryEvaluatorInput,
  runner: QueryRowRunner
): Promise<EvaluationResult> {
  const condition = input.condition;
  if (condition.kind !== "absence") {
    throw new Error(`${capability.key} requires an absence condition`);
  }
  if (capability.binding.type !== "query") {
    throw new Error(`${capability.key} is not a query-bound capability`);
  }

  const bucketSec = capability.binding.minCadenceSec;
  const quietWindowSec = condition.quietWindowSec;

  if (capability.minWindowSec && quietWindowSec < capability.minWindowSec) {
    return {
      kind: "stateful",
      outcome: "impossible",
      facts: buildFacts(null, quietWindowSec, bucketSec, input.now, capability.unit),
    };
  }

  const values = await runScalars(
    capability.binding.template,
    scopeWhere(input.params),
    input,
    windowRange(input.now, quietWindowSec),
    runner
  );

  const count = values[0] ?? 0;
  return {
    kind: "stateful",
    outcome: count === 0 ? "met" : "not_met",
    facts: buildFacts(count, quietWindowSec, bucketSec, input.now, capability.unit),
  };
}

export async function evaluateQueryCapability(
  input: QueryEvaluatorInput,
  runner: QueryRowRunner,
  config: QueryEvaluatorConfig = DEFAULT_QUERY_EVALUATOR_CONFIG
): Promise<QueryEvaluationResult> {
  const resolvedRunner = runner;
  const capability = getCapability(input.capabilityKey);
  if (!capability) {
    throw new Error(`unknown alert capability: ${input.capabilityKey}`);
  }
  if (capability.binding.type !== "query") {
    throw new Error(`${input.capabilityKey} is not a query-bound capability`);
  }

  if (capability.binding.emit === "rows") {
    return evaluateRows(capability, input, resolvedRunner, config);
  }

  if (input.condition.kind === "state") {
    return evaluateState(capability, input, resolvedRunner);
  }

  if (!capability.binding.template || !capability.binding.table) {
    throw new Error(`${input.capabilityKey} has no template or table`);
  }
  const scalar = capability as ScalarCapability;

  switch (capability.key) {
    case "runs.created":
      return evaluateAbsence(scalar, input, resolvedRunner);
    case "runs.failure_rate":
      return evaluateFailureRate(scalar, input, resolvedRunner, config);
    default:
      return evaluateThreshold(scalar, input, resolvedRunner, config);
  }
}
