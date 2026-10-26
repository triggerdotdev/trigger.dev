import type { Alert } from "../storage/alertStore.server";
import {
  type AlertCapability,
  alertParamsSchema,
  conditionSchema,
  getCapability,
  occurrenceExpiresAt,
  type Occurrence,
  validateConditionParams,
} from "@internal/alert-contracts";
import type { BindingResult } from "./evaluateAlert.server";
import { queryResultToBindingResult } from "./evaluateAlert.server";
import {
  checkpointSince,
  clickhouseDateTimeLiteral,
  DEFAULT_CHECKPOINT_LOOKBACK_SEC,
  evaluateQueryCapability,
  forwardUntil,
  keysetAfter,
  type QueryRowRunner,
  type QueryEvaluatorConfig,
  type RowCursor,
} from "../evaluators/queryEvaluator.server";
import { executeQuery, type QueryConcurrencyLane } from "~/services/queryService.server";
import { getLimit } from "~/services/platform.v3.server";
import { logger } from "~/services/logger.server";
import { env } from "~/env.server";
import { z } from "zod";

export function createQueryRowRunner(
  concurrencyLimit?: number,
  options: { userAuthoredQuery?: boolean; lane?: QueryConcurrencyLane } = {}
): QueryRowRunner {
  return async (query, context, range, opts) => {
    const rowSchema = z.record(z.string(), z.unknown());
    const result = await executeQuery<typeof rowSchema>({
      name: "alerts.queryEvaluator",
      query,
      scope: "environment",
      organizationId: context.organizationId,
      projectId: context.projectId,
      environmentId: context.environmentId,
      from: range.from,
      to: range.to,
      customOrgConcurrencyLimit: concurrencyLimit,
      concurrency: options.lane ? { lane: options.lane } : undefined,
      userAuthoredQuery: options.userAuthoredQuery,
      skipTimeConstraint: opts?.fullRetention,
      windowConditions: opts?.windowConditions,
      querySettings: opts?.maxRows ? { maxRows: opts.maxRows } : undefined,
      // Zone-less DateTime output is read as UTC.
      clickhouseSettings: { session_timezone: "UTC" },
      history: { source: "API", skip: true },
    });

    if (!result.success) {
      throw result.error;
    }

    return result.result.rows;
  };
}

type BindingLogger = {
  error: (message: string, fields?: Record<string, unknown>) => void;
  warn: (message: string, fields?: Record<string, unknown>) => void;
};

export interface ProductionBindingDeps {
  queryRowRunner?: QueryRowRunner;
  queryConcurrency?: number;
  queryLane?: QueryConcurrencyLane;
  queryEvaluatorConfig?: QueryEvaluatorConfig;
  checkpointLookbackSec?: number;
  seenRetentionSec?: number;
  now?: () => Date;
  logger?: BindingLogger;
}

interface ResolvedDeps {
  runner: QueryRowRunner;
  queryEvaluatorConfig?: QueryEvaluatorConfig;
  checkpointLookbackSec: number;
  seenRetentionSec: number;
  now: () => Date;
  logger: BindingLogger;
}

export function createProductionEvaluateBinding(
  deps: ProductionBindingDeps
): (alert: Alert, capability: AlertCapability) => Promise<BindingResult> {
  const runner =
    deps.queryRowRunner ?? createQueryRowRunner(deps.queryConcurrency, { lane: deps.queryLane });
  const resolved: ResolvedDeps = {
    runner,
    queryEvaluatorConfig: deps.queryEvaluatorConfig,
    checkpointLookbackSec: deps.checkpointLookbackSec ?? DEFAULT_CHECKPOINT_LOOKBACK_SEC,
    seenRetentionSec: deps.seenRetentionSec ?? env.ALERT_SEEN_RETENTION_SEC,
    now: deps.now ?? (() => new Date()),
    logger: deps.logger ?? logger,
  };
  return async (alert, capability) => {
    const invalid = invalidConditionParams(alert, capability);
    if (invalid) {
      return {
        result: {
          kind: "stateful",
          outcome: "unavailable",
          facts: { unavailableReason: `invalid_params: ${invalid}` },
        },
      };
    }
    if (capability.binding.compositeOf) {
      return evaluateCompositeBinding(alert, capability, resolved);
    }
    return evaluateQueryBinding(alert, capability, resolved);
  };
}

function invalidConditionParams(alert: Alert, capability: AlertCapability): string | undefined {
  const condition = conditionSchema.safeParse(alert.condition);
  if (!condition.success) return condition.error.issues[0]?.message ?? "invalid condition";
  if (condition.data.kind !== "state" || !condition.data.params) return undefined;
  try {
    validateConditionParams(condition.data.params, capability.binding.params ?? []);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return undefined;
}

function mergeEffectiveParams(
  condition: Record<string, unknown>,
  declared: Array<{ key: string; default: number }> | undefined
): Record<string, number> {
  const conditionParams =
    typeof condition.params === "object" && condition.params !== null
      ? (condition.params as Record<string, number>)
      : {};
  const result: Record<string, number> = {};
  if (declared) {
    for (const p of declared) {
      result[p.key] = conditionParams[p.key] ?? p.default;
    }
  }
  return result;
}

function filterParamsForCapability(
  allParams: Record<string, number>,
  declared: Array<{ key: string }> | undefined
): Record<string, number> {
  if (!declared) return {};
  const result: Record<string, number> = {};
  for (const p of declared) {
    if (p.key in allParams) {
      result[p.key] = allParams[p.key]!;
    }
  }
  return result;
}

const ROW_TIME_COLUMNS = ["group_first_seen", "minute"];

function rowTimeColumns(capability: AlertCapability): string[] {
  const column = capability.binding.rowTimeColumn;
  return column ? [column] : ROW_TIME_COLUMNS;
}

function rowTime(
  row: Record<string, unknown> | undefined,
  timeColumns: string[]
): Date | undefined {
  const value = timeColumns.map((col) => row?.[col]).find((v) => typeof v === "string");
  if (typeof value !== "string") return undefined;
  const parsed = new Date(`${value.replace(" ", "T")}Z`);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function rowCursor(
  row: Record<string, unknown> | undefined,
  rowKey: string[],
  timeColumns: string[]
): RowCursor | undefined {
  const timeColumn = timeColumns.find((col) => typeof row?.[col] === "string");
  if (!row || !timeColumn) return undefined;
  const columns = [timeColumn, ...rowKey.filter((col) => col !== timeColumn)];
  return columns.map((col) => [col, String(row[col])]);
}

function storedCursor(
  alert: Alert,
  field: "cursor" | "lateCursor",
  rowKey: string[],
  timeColumns: string[]
): RowCursor | undefined {
  const stored = (alert.evaluatorState as Record<string, unknown> | null)?.[field];
  const allowed = new Set([...timeColumns, ...rowKey]);
  const valid =
    Array.isArray(stored) &&
    stored.length > 0 &&
    stored.every(
      (pair: unknown) =>
        Array.isArray(pair) &&
        pair.length === 2 &&
        typeof pair[0] === "string" &&
        allowed.has(pair[0]) &&
        typeof pair[1] === "string"
    );
  return valid ? (stored as RowCursor) : undefined;
}

function storedCheckpoint(alert: Alert): string | undefined {
  const stored = (alert.evaluatorState as Record<string, unknown> | null)?.checkpoint;
  if (typeof stored !== "string" || Number.isNaN(new Date(stored).getTime())) return undefined;
  return stored;
}

function storedLateWindow(alert: Alert): { since: Date; until: Date; replay: boolean } | undefined {
  const stored = (alert.evaluatorState as Record<string, unknown> | null)?.lateWindow as
    | { since?: unknown; until?: unknown; replay?: unknown }
    | undefined;
  if (typeof stored?.since !== "string" || typeof stored.until !== "string") return undefined;
  const since = new Date(stored.since);
  const until = new Date(stored.until);
  if (Number.isNaN(since.getTime()) || Number.isNaN(until.getTime())) return undefined;
  return { since, until, replay: stored.replay === true };
}

function storedLateResumeFrom(alert: Alert): Date | undefined {
  const stored = (alert.evaluatorState as Record<string, unknown> | null)?.lateResumeFrom;
  if (typeof stored !== "string" || Number.isNaN(new Date(stored).getTime())) return undefined;
  return new Date(stored);
}

function storedActivatedFloor(alert: Alert): string | undefined {
  const stored = (alert.evaluatorState as Record<string, unknown> | null)?.activatedFloor;
  if (typeof stored !== "string" || Number.isNaN(new Date(stored).getTime())) return undefined;
  return stored;
}

async function evaluateQueryBinding(
  alert: Alert,
  capability: AlertCapability,
  deps: ResolvedDeps
): Promise<BindingResult> {
  const params = alertParamsSchema.parse(alert.params);
  const condition = conditionSchema.parse(alert.condition);
  const now = deps.now();
  const checkpoint = storedCheckpoint(alert);
  const activatedFloor = storedActivatedFloor(alert);
  const usesCheckpoint = capability.binding.ctx?.includes("checkpoint") ?? false;
  const floor = capability.binding.fullRetention
    ? new Date(
        now.getTime() - (await getLimit(alert.organizationId, "queryPeriodDays", 30)) * 86_400_000
      )
    : undefined;
  const observingSince = activatedFloor
    ? new Date(Math.max(alert.createdAt.getTime(), Date.parse(activatedFloor)))
    : alert.createdAt;
  const lateSince = checkpointSince(
    checkpoint ? new Date(checkpoint) : undefined,
    observingSince,
    deps.checkpointLookbackSec,
    { now, seenRetentionSec: deps.seenRetentionSec, floor }
  );
  const forwardSince = checkpoint
    ? new Date(Math.max(lateSince.getTime(), Math.floor(Date.parse(checkpoint) / 60_000) * 60_000))
    : lateSince;
  const forwardEnd = forwardUntil(now);
  const rowKey = capability.binding.rowKey ?? [];
  const timeColumns = rowTimeColumns(capability);
  const savedWindow = storedCursor(alert, "lateCursor", rowKey, timeColumns)
    ? storedLateWindow(alert)
    : undefined;
  const lateMinSince = Math.max(
    now.getTime() - (deps.seenRetentionSec - deps.checkpointLookbackSec) * 1000,
    floor?.getTime() ?? 0
  );
  const resumeFrom = storedLateResumeFrom(alert);
  const lateRange = savedWindow
    ? {
        since: new Date(Math.max(savedWindow.since.getTime(), lateMinSince)),
        until: savedWindow.until,
      }
    : {
        since: resumeFrom
          ? new Date(Math.min(lateSince.getTime(), Math.max(resumeFrom.getTime(), lateMinSince)))
          : lateSince,
        until: forwardSince,
      };
  const matchWindow = {
    from: new Date(Math.min(lateRange.since.getTime(), forwardSince.getTime())),
    to: forwardEnd,
  };

  const evaluateRange = (since: Date, until: Date, after: RowCursor | undefined) =>
    evaluateQueryCapability(
      {
        capabilityKey: alert.capabilityKey,
        params,
        condition,
        organizationId: alert.organizationId,
        projectId: alert.projectId,
        now,
        capability,
        matchWindow,
        observingSince,
        ctx: usesCheckpoint
          ? {
              checkpoint: clickhouseDateTimeLiteral(since),
              until: clickhouseDateTimeLiteral(until),
              after: after ? keysetAfter(after) : "1 = 1",
            }
          : undefined,
      },
      deps.runner,
      deps.queryEvaluatorConfig
    );

  const forward = await evaluateRange(
    forwardSince,
    forwardEnd,
    storedCursor(alert, "cursor", rowKey, timeColumns)
  );
  const forwardRows = forward.kind === "occurrence" ? forward.occurrences : [];
  let result = forward;
  let lateCursor: RowCursor | undefined;
  let lateDrained = false;
  if (
    usesCheckpoint &&
    forward.kind === "occurrence" &&
    lateRange.since.getTime() < lateRange.until.getTime()
  ) {
    const late = await evaluateRange(
      lateRange.since,
      lateRange.until,
      storedCursor(alert, "lateCursor", rowKey, timeColumns)
    );
    if (late.kind === "occurrence" && late.facts.capped) {
      lateCursor = rowCursor(late.occurrences.at(-1)?.facts, rowKey, timeColumns);
    }
    lateDrained = late.kind === "occurrence" && !late.facts.capped;
    if (late.kind === "occurrence" && late.occurrences.length > 0) {
      if (late.facts.capped) {
        deps.logger.warn("alerts.evaluate.late_rows_capped", {
          alertId: alert.id,
          capabilityKey: alert.capabilityKey,
        });
      }
      result = {
        ...forward,
        outcome: "met",
        occurrences: [...late.occurrences, ...forwardRows],
      };
    }
  }

  // Accepted: a row arriving behind the cursor during a replay-window drain is not replayed again.
  const lateState = lateCursor
    ? {
        lateCursor,
        lateWindow: {
          since: lateRange.since.toISOString(),
          until: lateRange.until.toISOString(),
          replay: savedWindow ? savedWindow.replay : resumeFrom !== undefined,
        },
      }
    : savedWindow && lateDrained
      ? {
          lateResumeFrom: (savedWindow.replay
            ? savedWindow.until
            : savedWindow.since
          ).toISOString(),
        }
      : {};

  if (result.kind === "occurrence") {
    const occurrences: Occurrence[] = [];
    for (const raw of result.occurrences) {
      if (!raw.sourceEventId) {
        deps.logger.error("alerts.occurrence_source_event_id_missing", {
          alertId: alert.id,
          capabilityKey: alert.capabilityKey,
        });
        continue;
      }
      const time = rowTime(raw.facts, timeColumns);
      if (!time) {
        deps.logger.error("alerts.occurrence_row_time_missing", {
          alertId: alert.id,
          capabilityKey: alert.capabilityKey,
          rowKey: raw.sourceEventId,
        });
        continue;
      }
      occurrences.push({
        ...raw,
        sourceEventId: raw.sourceEventId,
        rowTime: time,
        expiresAt: occurrenceExpiresAt(time, deps.seenRetentionSec),
      });
    }
    const emitted = { ...result, occurrences };
    if (result.facts.capped) {
      deps.logger.warn("alerts.evaluate.rows_capped", {
        alertId: alert.id,
        capabilityKey: alert.capabilityKey,
      });
      const lastForward = forwardRows.at(-1)?.facts;
      const newest = rowTime(lastForward, timeColumns);
      const cursor = rowCursor(lastForward, rowKey, timeColumns);
      if (newest && cursor) {
        return {
          result: emitted,
          evaluatorStatePatch: {
            checkpoint: newest.toISOString(),
            cursor,
            ...lateState,
            activatedFloor,
          },
        };
      }
      return {
        result: emitted,
        evaluatorStatePatch: checkpoint ? { checkpoint, ...lateState, activatedFloor } : undefined,
      };
    }
    return {
      result: emitted,
      evaluatorStatePatch: { checkpoint: now.toISOString(), ...lateState, activatedFloor },
    };
  }

  return {
    ...queryResultToBindingResult({ status: result.outcome, facts: result.facts }),
    evaluatorStatePatch: activatedFloor ? { activatedFloor } : undefined,
  };
}

async function evaluateCompositeBinding(
  alert: Alert,
  capability: AlertCapability,
  deps: ResolvedDeps
): Promise<BindingResult> {
  const subKeys = capability.binding.compositeOf!;
  const condition = alert.condition as Record<string, unknown>;
  const allEffective = mergeEffectiveParams(condition, capability.binding.params);

  const components: Record<string, { outcome: string; effectiveParams: Record<string, number> }> =
    {};

  let anyMet = false;
  let anyUnavailable = false;

  for (const subKey of subKeys) {
    const subCap = getCapability(subKey);
    if (!subCap) continue;

    const subParams = filterParamsForCapability(allEffective, subCap.binding.params);
    const subAlert = {
      ...alert,
      capabilityKey: subKey,
      condition: { ...condition, params: subParams },
    } as Alert;

    let subResult: BindingResult;
    try {
      subResult = await evaluateQueryBinding(subAlert, subCap, deps);
    } catch (err) {
      if (
        (err as { __queryConcurrencyRejection?: unknown } | null)?.__queryConcurrencyRejection ===
        true
      ) {
        throw err;
      }
      const shortKey = subKey.replace(/^health\./, "");
      components[shortKey] = { outcome: "unavailable", effectiveParams: subParams };
      anyUnavailable = true;
      continue;
    }

    const outcome = subResult.result.kind === "stateful" ? subResult.result.outcome : "unavailable";
    const shortKey = subKey.replace(/^health\./, "");
    components[shortKey] = { outcome, effectiveParams: subParams };

    if (outcome === "met") anyMet = true;
    if (outcome === "unavailable") anyUnavailable = true;
  }

  if (anyUnavailable) {
    return {
      result: {
        kind: "stateful",
        outcome: "unavailable",
        facts: { components, unavailableReason: "sub_unavailable" },
      },
    };
  }

  return {
    result: {
      kind: "stateful",
      outcome: anyMet ? "met" : "not_met",
      facts: { components },
    },
  };
}
