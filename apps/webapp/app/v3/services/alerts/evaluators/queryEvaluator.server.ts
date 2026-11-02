import {
  getCapability,
  getQuerySource,
  compileTemplate as compileTemplateWithParams,
  type AlertCapability,
  type AlertParams,
  type Condition,
  type EvaluationResult,
  type QuerySignal,
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
  capability?: AlertCapability;
  matchWindow?: { from: Date; to: Date };
  observingSince?: Date;
}

export type WindowCondition = {
  table: string;
  column: string;
  from: Date;
  to: Date;
  branch?: number;
};

export type QueryRowRunner = (
  query: string,
  context: { organizationId: string; projectId: string; environmentId: string },
  range: { from: string; to: string },
  opts?: { fullRetention?: boolean; windowConditions?: WindowCondition[]; maxRows?: number }
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

export function identifier(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `\`${name.replace(/`/g, "``")}\``;
}

export function keysetAfter(cursor: RowCursor): string {
  const [[name, value], ...rest] = cursor as [RowCursor[number], ...RowCursor];
  const column = identifier(name);
  const literal = `'${escapeTsqlString(value)}'`;
  return rest.length === 0
    ? `${column} > ${literal}`
    : `(${column} > ${literal} OR (${column} = ${literal} AND ${keysetAfter(rest)}))`;
}

export function rowKeyPart(value: unknown): string {
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
    {
      fullRetention: binding.fullRetention,
      windowConditions: binding.source === "custom" ? matchWindows(input) : undefined,
    }
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

const MAX_OFFENDING_GROUPS = 8;
const SIGNAL_COLUMNS = new Set(["met", "reading_value", "reading_count", "samples"]);

async function evaluateLimitSignals(
  capability: AlertCapability,
  input: QueryEvaluatorInput,
  runner: QueryRowRunner
): Promise<EvaluationResult> {
  const condition = input.condition as Extract<Condition, { kind: "state" }>;
  const signalTemplates = capability.binding.signalTemplates ?? {};
  const bucketSec = capability.binding.minCadenceSec;
  const windowSec = input.params.windowSec ?? bucketSec;
  const effectiveParams = resolveEffectiveParams(condition, capability.binding.params);
  const selected = (capability.supportedSignals ?? []).filter(
    (signal) => !condition.signals || condition.signals.includes(signal)
  );

  const signals: Record<string, Record<string, unknown>> = {};
  const offendingGroups = new Set<string>();
  let anyAvailable = false;
  let anyMet = false;
  for (const signal of selected) {
    const template = signalTemplates[signal];
    if (!template) continue;
    const rows = await runner(
      compileTemplate(template, {
        scope: scopeWhere(input.params),
        params: effectiveParams,
      }),
      {
        organizationId: input.organizationId,
        projectId: input.projectId,
        environmentId: input.params.environmentId,
      },
      windowRange(input.now, windowSec)
    );
    const sampled = rows.filter((row) => Number(row.samples) > 0);
    const readingKey = / AS reading_count, /.test(template) ? "count" : "value";
    const readings = sampled.map((row) => Number(row[`reading_${readingKey}`]));
    const metRows = sampled.filter((row) => Number(row.met) !== 0);
    const met = metRows.length > 0;
    if (sampled.length > 0) anyAvailable = true;
    if (met) anyMet = true;
    for (const row of metRows) {
      const group = Object.entries(row)
        .filter(([column]) => !SIGNAL_COLUMNS.has(column))
        .map(([, value]) => String(value))
        .join(" / ");
      if (group) offendingGroups.add(group);
    }
    const reading =
      sampled.length === 0
        ? null
        : readingKey === "count"
          ? readings.reduce((a, b) => a + b, 0)
          : Math.max(...readings);
    signals[signal] = {
      [readingKey]: reading,
      ...(signal === "approaching" ? { threshold: effectiveParams.utilisationPct } : {}),
      met,
    };
  }

  const extra = {
    effectiveParams,
    signals,
    ...(offendingGroups.size > 0
      ? { offendingGroups: [...offendingGroups].slice(0, MAX_OFFENDING_GROUPS) }
      : {}),
  };
  if (!anyAvailable) {
    return {
      kind: "stateful",
      outcome: "unavailable",
      facts: buildFacts(null, windowSec, bucketSec, input.now, capability.unit, undefined, {
        ...extra,
        unavailableReason: selected.length > 0 ? "no_data" : "no_selected_signals",
      }),
    };
  }
  return {
    kind: "stateful",
    outcome: anyMet ? "met" : "not_met",
    facts: buildFacts(
      anyMet ? 1 : 0,
      windowSec,
      bucketSec,
      input.now,
      capability.unit,
      undefined,
      extra
    ),
  };
}

// An absence alert observes one full window from creation or reactivation before it can raise.
function absenceOutcome(count: number, windowSec: number, input: QueryEvaluatorInput) {
  const graceUntil = input.observingSince
    ? input.observingSince.getTime() + windowSec * 1000
    : undefined;
  if (graceUntil !== undefined && input.now.getTime() < graceUntil) {
    return {
      outcome: "not_met" as const,
      extra: { graceUntil: new Date(graceUntil).toISOString() },
    };
  }
  return { outcome: count === 0 ? ("met" as const) : ("not_met" as const), extra: undefined };
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
  const { outcome, extra } = absenceOutcome(count, quietWindowSec, input);
  return {
    kind: "stateful",
    outcome,
    facts: buildFacts(
      count,
      quietWindowSec,
      bucketSec,
      input.now,
      capability.unit,
      undefined,
      extra
    ),
  };
}

export const MAX_QUERY_GROUPS = 500;
export const OFFENDER_DETAIL_ROWS = 10;
export const CONTEXT_HORIZON_SEC = 86_400;

function querySignal(input: QueryEvaluatorInput): QuerySignal {
  const signal = input.params.querySignal;
  if (!signal) throw new Error(`${input.capabilityKey} has no query signal`);
  return signal;
}

export function sourceWindows(
  signal: QuerySignal,
  windowFor: (source: QuerySignal["sources"][number]) => { from: Date; to: Date }
): WindowCondition[] {
  return signal.sources.map((source) => ({
    table: getQuerySource(source.sourceId)?.table ?? source.sourceId,
    column: source.windowColumn,
    ...windowFor(source),
  }));
}

function matchWindows(input: QueryEvaluatorInput): WindowCondition[] {
  const signal = querySignal(input);
  const window = input.matchWindow;
  if (!window) throw new Error(`${input.capabilityKey} has no match window`);
  const context = {
    from: new Date(window.to.getTime() - CONTEXT_HORIZON_SEC * 1000),
    to: window.to,
  };
  return sourceWindows(signal, (source) =>
    source.sourceId === signal.rowId?.sourceId ? window : context
  );
}

function measureValue(row: Record<string, unknown> | undefined, measure: string): number | null {
  const raw = row?.[measure];
  if (raw === null || raw === undefined) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

async function evaluateCustomThreshold(
  capability: AlertCapability,
  input: QueryEvaluatorInput,
  runner: QueryRowRunner
): Promise<EvaluationResult> {
  const condition = input.condition;
  const { template, measure, groupBy = [] } = capability.binding;
  if (!template || !measure) throw new Error(`${capability.key} has no template or measure`);
  if (condition.kind !== "threshold" && condition.kind !== "absence") {
    throw new Error(`${capability.key} requires a threshold or absence condition`);
  }

  const windowSec = condition.kind === "absence" ? condition.quietWindowSec : condition.windowSec;
  const from = new Date(input.now.getTime() - windowSec * 1000);
  const rows = await runner(
    template,
    {
      organizationId: input.organizationId,
      projectId: input.projectId,
      environmentId: input.params.environmentId,
    },
    windowRange(input.now, windowSec),
    { windowConditions: sourceWindows(querySignal(input), () => ({ from, to: input.now })) }
  );
  const bucketSec = capability.minCadenceSec;
  const facts = (value: number | null, threshold?: number, extra?: Record<string, unknown>) =>
    buildFacts(value, windowSec, bucketSec, input.now, capability.unit, threshold, {
      measure,
      ...extra,
    });

  if (condition.kind === "absence") {
    const count = measureValue(rows[0], measure) ?? 0;
    const { outcome, extra } = absenceOutcome(count, windowSec, input);
    return { kind: "stateful", outcome, facts: facts(count, undefined, extra) };
  }

  if (!groupBy.length) {
    const value = measureValue(rows[0], measure);
    return {
      kind: "stateful",
      outcome: value !== null && compareThreshold(value, condition) ? "met" : "not_met",
      facts: facts(value, condition.value),
    };
  }

  if (rows.length > MAX_QUERY_GROUPS) {
    return {
      kind: "stateful",
      outcome: "unavailable",
      facts: facts(null, condition.value, {
        groupColumns: groupBy,
        groupCount: rows.length,
        unavailableReason: `The query returned more than ${MAX_QUERY_GROUPS} groups. Narrow it so fewer groups match.`,
        unavailableCode: "too_many_groups",
      }),
    };
  }

  const groups = rows.flatMap((row) => {
    const value = measureValue(row, measure);
    if (value === null) return [];
    const group = Object.fromEntries(groupBy.map((col) => [col, row[col] ?? null]));
    return [{ key: groupBy.map((col) => rowKeyPart(row[col])).join(", "), group, value }];
  });
  const offenders = groups
    .filter((g) => compareThreshold(g.value, condition))
    .sort((a, b) => (condition.operator === ">" ? b.value - a.value : a.value - b.value));
  const worst = groups.length ? worstOffender(groups, condition.operator) : undefined;

  return {
    kind: "stateful",
    outcome: offenders.length > 0 ? "met" : "not_met",
    facts: facts(worst?.value ?? null, condition.value, {
      groupColumns: groupBy,
      groupCount: groups.length,
      offenders: offenders.slice(0, OFFENDER_DETAIL_ROWS),
      offenderCount: offenders.length,
    }),
  };
}

export async function evaluateQueryCapability(
  input: QueryEvaluatorInput,
  runner: QueryRowRunner,
  config: QueryEvaluatorConfig = DEFAULT_QUERY_EVALUATOR_CONFIG
): Promise<QueryEvaluationResult> {
  const resolvedRunner = runner;
  const capability = input.capability ?? getCapability(input.capabilityKey);
  if (!capability) {
    throw new Error(`unknown alert capability: ${input.capabilityKey}`);
  }
  if (capability.binding.type !== "query") {
    throw new Error(`${input.capabilityKey} is not a query-bound capability`);
  }

  if (capability.binding.emit === "rows") {
    return evaluateRows(capability, input, resolvedRunner, config);
  }

  if (capability.binding.source === "custom") {
    return evaluateCustomThreshold(capability, input, resolvedRunner);
  }

  if (input.condition.kind === "state") {
    return capability.binding.signalTemplates
      ? evaluateLimitSignals(capability, input, resolvedRunner)
      : evaluateState(capability, input, resolvedRunner);
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
