import {
  getCapability,
  isScopeAllowed,
  notifierRefKey,
  notifierRefSchema,
  ScopeNotAllowedError,
  type AlertScopeType,
  type NotifierRef,
} from "@internal/alert-contracts";
import {
  Prisma,
  type Alert as AlertRow,
  type AlertDelivery as AlertDeliveryRow,
  type AlertEvent as AlertEventRow,
} from "@trigger.dev/database";
import {
  $transaction,
  boundedIn,
  type PrismaClientOrTransaction,
  type PrismaTransactionClient,
} from "~/db.server";
import {
  generateAlertDeliveryClaimId,
  generateAlertDeliveryId,
  generateAlertEventId,
  generateAlertId,
} from "./alertIds";

export type AlertLifecycle = "active" | "completed" | "expired" | "stopped";
export type AlertAttention = "clear" | "needs_attention";
type AlertObservedCondition = "unknown" | "met" | "not_met";
export type AlertEventType = "raised" | "recovered" | "resolved" | "expired" | "stopped";
type AlertDeliveryStatus = "pending" | "delivering" | "delivered" | "failed";

export type Alert = {
  id: string;
  organizationId: string;
  projectId: string;
  environmentId: string;
  capabilityKey: string;
  params: Record<string, unknown>;
  condition: Record<string, unknown>;
  query: string | null;
  expiresAt: Date | null;
  lifecycle: AlertLifecycle;
  attention: AlertAttention;
  observedCondition: AlertObservedCondition;
  observedConditionChangedAt: Date | null;
  pendingMetSince: Date | null;
  evaluatorState: Record<string, unknown> | null;
  evaluationLeaseId: string | null;
  evaluationLeaseUntil: Date | null;
  lastEvaluatedAt: Date | null;
  nextEvaluationAt: Date | null;
  notifiers: NotifierRef[];
  name: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  resolvedAt: Date | null;
  resolvedBy: string | null;
  stoppedAt: Date | null;
  stoppedBy: string | null;
  lastOccurrenceAt: Date | null;
  occurrencesSinceRaise: number;
  occurrencesTotal: number;
};

type AlertRequiredKeys =
  | "organizationId"
  | "projectId"
  | "environmentId"
  | "capabilityKey"
  | "params"
  | "condition"
  | "createdBy";

export type NewAlert = Pick<Alert, AlertRequiredKeys> & {
  [K in Exclude<keyof Alert, AlertRequiredKeys>]?: Alert[K] | null;
};

export type AlertEvent = {
  id: string;
  alertId: string;
  type: AlertEventType;
  at: Date;
  facts: Record<string, unknown>;
  actorId: string | null;
  sourceEventId: string | null;
};

export type NewAlertEvent = Pick<AlertEvent, "id" | "alertId" | "type"> & {
  at?: Date;
  facts?: Record<string, unknown>;
  actorId?: string | null;
  sourceEventId?: string | null;
};

export type AlertDelivery = {
  id: string;
  alertEventId: string;
  eventAt: Date;
  notifierId: string;
  notifier: NotifierRef;
  status: AlertDeliveryStatus;
  claimId: string | null;
  claimedAt: Date | null;
  deliveredAt: Date | null;
  failureReason: string | null;
  providerMetadata: Record<string, unknown> | null;
  attempts: number;
  firstAttemptAt: Date | null;
  createdAt: Date;
};

function toAlert(row: AlertRow): Alert {
  return {
    ...row,
    params: row.params as Record<string, unknown>,
    condition: row.condition as Record<string, unknown>,
    lifecycle: row.lifecycle as AlertLifecycle,
    attention: row.attention as AlertAttention,
    observedCondition: row.observedCondition as AlertObservedCondition,
    evaluatorState: (row.evaluatorState ?? null) as Record<string, unknown> | null,
    notifiers: row.notifiers as NotifierRef[],
    occurrencesTotal: Number(row.occurrencesTotal),
  };
}

function toAlertEvent(row: AlertEventRow): AlertEvent {
  return {
    ...row,
    type: row.type as AlertEventType,
    facts: row.facts as Record<string, unknown>,
  };
}

function toAlertDelivery(row: AlertDeliveryRow): AlertDelivery {
  return {
    ...row,
    notifier: row.notifier as NotifierRef,
    status: row.status as AlertDeliveryStatus,
    providerMetadata: (row.providerMetadata ?? null) as Record<string, unknown> | null,
  };
}

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function nullableJson(value: unknown) {
  if (value === undefined) return undefined;
  return value === null ? Prisma.DbNull : json(value);
}

function iso(date: Date) {
  return Prisma.sql`${date.toISOString()}::timestamptz`;
}

const OUTCOME_TRANSACTION_TIMEOUT_MS = 30_000;
const ACTION_TRANSACTION_TIMEOUT_MS = 15_000;

async function inTransaction<R>(
  db: PrismaClientOrTransaction,
  timeout: number,
  fn: (tx: PrismaTransactionClient) => Promise<R>
): Promise<R> {
  return (await $transaction(db, fn, { timeout })) as R;
}

export async function createAlert(
  db: PrismaClientOrTransaction,
  params: Omit<NewAlert, "id" | "createdAt" | "updatedAt"> & { id?: string; createdAt?: Date }
): Promise<Alert> {
  assertScopeAllowed(params.capabilityKey, params.params);
  const notifiers = params.notifiers?.map((n) => notifierRefSchema.parse(n));
  const id = params.id ?? generateAlertId();
  const row = await db.alert.create({
    data: {
      ...params,
      id,
      params: json(params.params),
      condition: json(params.condition),
      evaluatorState: nullableJson(params.evaluatorState),
      notifiers: notifiers ? json(notifiers) : undefined,
      lifecycle: params.lifecycle ?? undefined,
      attention: params.attention ?? undefined,
      observedCondition: params.observedCondition ?? undefined,
      occurrencesSinceRaise: params.occurrencesSinceRaise ?? undefined,
      occurrencesTotal: params.occurrencesTotal ?? undefined,
      createdAt: params.createdAt ?? undefined,
    },
  });
  return toAlert(row);
}

function assertScopeAllowed(capabilityKey: string, params: Record<string, unknown>) {
  const capability = getCapability(capabilityKey);
  const scopeType = (params.scope as { type?: unknown } | undefined)?.type;
  if (
    capability &&
    typeof scopeType === "string" &&
    !isScopeAllowed(capability, scopeType as AlertScopeType)
  ) {
    throw new ScopeNotAllowedError(capabilityKey, scopeType);
  }
}

export async function getAlert(
  db: PrismaClientOrTransaction,
  params: { id: string; projectId?: string; environmentId?: string }
): Promise<Alert | null> {
  const row = await db.alert.findFirst({
    where: {
      id: params.id,
      ...(params.projectId ? { projectId: params.projectId } : {}),
      ...(params.environmentId ? { environmentId: params.environmentId } : {}),
    },
  });
  return row ? toAlert(row) : null;
}

const LIST_ALERTS_DEFAULT_LIMIT = 200;
const LIST_ALERTS_MAX_LIMIT = 1000;

export async function listAlerts(
  db: PrismaClientOrTransaction,
  params: {
    environmentId?: string;
    projectId?: string;
    lifecycle?: AlertLifecycle;
    attention?: AlertAttention;
    statuses?: Array<"needs_attention" | "active" | "inactive">;
    limit?: number;
  }
): Promise<Alert[]> {
  const where: Prisma.AlertWhereInput = {};
  if (params.environmentId) where.environmentId = params.environmentId;
  if (params.projectId) where.projectId = params.projectId;
  if (params.lifecycle) where.lifecycle = params.lifecycle;
  if (params.attention) where.attention = params.attention;
  if (params.statuses && params.statuses.length > 0) {
    const byStatus: Record<string, Prisma.AlertWhereInput> = {
      needs_attention: { attention: "needs_attention" },
      active: { attention: "clear", lifecycle: "active" },
      inactive: { attention: "clear", lifecycle: { not: "active" } },
    };
    where.OR = params.statuses.map((s) => byStatus[s]!);
  }
  const cap = Math.max(
    0,
    Math.min(params.limit ?? LIST_ALERTS_DEFAULT_LIMIT, LIST_ALERTS_MAX_LIMIT)
  );
  const rows = await db.alert.findMany({
    where,
    orderBy: [{ attention: "desc" }, { createdAt: "desc" }],
    take: cap,
  });
  return rows.map(toAlert);
}

export async function updateAlertNotifiers(
  db: PrismaClientOrTransaction,
  params: { id: string; projectId: string; environmentId: string; notifiers: NotifierRef[] }
): Promise<Alert | null> {
  const rows = await db.alert.updateManyAndReturn({
    where: { id: params.id, projectId: params.projectId, environmentId: params.environmentId },
    data: {
      notifiers: json(params.notifiers.map((n) => notifierRefSchema.parse(n))),
      updatedAt: new Date(),
    },
  });
  return rows[0] ? toAlert(rows[0]) : null;
}

export async function updateAlertExpiry(
  db: PrismaClientOrTransaction,
  params: { id: string; projectId: string; environmentId: string; expiresAt: Date | null }
): Promise<Alert | null> {
  const rows = await db.alert.updateManyAndReturn({
    where: { id: params.id, projectId: params.projectId, environmentId: params.environmentId },
    data: { expiresAt: params.expiresAt, updatedAt: new Date() },
  });
  return rows[0] ? toAlert(rows[0]) : null;
}

export async function activateAlert(
  db: PrismaClientOrTransaction,
  params: {
    id: string;
    projectId: string;
    environmentId: string;
    now?: Date;
    expiresAt?: Date | null;
    notifiers?: NotifierRef[];
  }
): Promise<Alert | null> {
  const activatedAt = (params.now ?? new Date()).toISOString();
  const rows = await db.alert.updateManyAndReturn({
    where: {
      id: params.id,
      projectId: params.projectId,
      environmentId: params.environmentId,
      lifecycle: { in: ["stopped", "completed", "expired"] },
    },
    data: {
      ...(params.expiresAt !== undefined ? { expiresAt: params.expiresAt } : {}),
      ...(params.notifiers
        ? { notifiers: json(params.notifiers.map((n) => notifierRefSchema.parse(n))) }
        : {}),
      lifecycle: "active",
      attention: "clear",
      observedCondition: "unknown",
      pendingMetSince: null,
      evaluatorState: { checkpoint: activatedAt, activatedFloor: activatedAt },
      evaluationLeaseId: null,
      evaluationLeaseUntil: null,
      nextEvaluationAt: null,
      resolvedAt: null,
      resolvedBy: null,
      stoppedAt: null,
      stoppedBy: null,
      updatedAt: new Date(),
    },
  });
  return rows[0] ? toAlert(rows[0]) : null;
}

export async function claimAlertsForEvaluation(
  db: PrismaClientOrTransaction,
  params: { now: Date; leaseMs: number; limit: number }
): Promise<Array<Alert & { evaluationLeaseId: string }>> {
  const leaseId = generateAlertId();
  const leaseUntil = new Date(params.now.getTime() + params.leaseMs);
  const now = iso(params.now);
  const rows = await db.$queryRaw<AlertRow[]>`
    UPDATE "Alert"
    SET "evaluationLeaseId" = ${leaseId}, "evaluationLeaseUntil" = ${iso(leaseUntil)}
    WHERE "id" IN (
      SELECT "id" FROM "Alert"
      WHERE "lifecycle" = 'active'
        AND ("evaluationLeaseUntil" IS NULL OR "evaluationLeaseUntil" < ${now})
        AND ("nextEvaluationAt" IS NULL OR "nextEvaluationAt" <= ${now})
        AND ("expiresAt" IS NULL OR "expiresAt" > ${now})
      ORDER BY "nextEvaluationAt" ASC NULLS FIRST
      LIMIT ${params.limit}::int
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *`;
  return rows.map(toAlert) as Array<Alert & { evaluationLeaseId: string }>;
}

type AlertClaimState = Pick<
  Alert,
  "id" | "lifecycle" | "expiresAt" | "nextEvaluationAt" | "evaluationLeaseUntil"
>;

export type ClaimAlertForEvaluationResult =
  | { claimed: true; alert: Alert & { evaluationLeaseId: string } }
  | {
      claimed: false;
      reason: "missing" | "inactive" | "not_due" | "leased";
      alert?: AlertClaimState;
    };

export async function claimAlertForEvaluation(
  db: PrismaClientOrTransaction,
  params: { id: string; now: Date; leaseMs: number }
): Promise<ClaimAlertForEvaluationResult> {
  const leaseId = generateAlertId();
  const leaseUntil = new Date(params.now.getTime() + params.leaseMs);
  const now = iso(params.now);
  const rows = await db.$queryRaw<AlertRow[]>`
    UPDATE "Alert"
    SET "evaluationLeaseId" = ${leaseId}, "evaluationLeaseUntil" = ${iso(leaseUntil)}
    WHERE "id" = ${params.id}
      AND "lifecycle" = 'active'
      AND ("evaluationLeaseUntil" IS NULL OR "evaluationLeaseUntil" < ${now})
      AND ("nextEvaluationAt" IS NULL OR "nextEvaluationAt" <= ${now})
      AND ("expiresAt" IS NULL OR "expiresAt" > ${now})
    RETURNING *`;
  if (rows[0]) {
    return { claimed: true, alert: toAlert(rows[0]) as Alert & { evaluationLeaseId: string } };
  }

  const current = await db.alert.findFirst({
    where: { id: params.id },
    select: {
      id: true,
      lifecycle: true,
      expiresAt: true,
      nextEvaluationAt: true,
      evaluationLeaseUntil: true,
    },
  });
  if (!current) return { claimed: false, reason: "missing" };
  const alert: AlertClaimState = { ...current, lifecycle: current.lifecycle as AlertLifecycle };
  const nowMs = params.now.getTime();
  if (alert.lifecycle !== "active" || (alert.expiresAt && alert.expiresAt.getTime() <= nowMs)) {
    return { claimed: false, reason: "inactive", alert };
  }
  if (alert.nextEvaluationAt && alert.nextEvaluationAt.getTime() > nowMs) {
    return { claimed: false, reason: "not_due", alert };
  }
  return { claimed: false, reason: "leased", alert };
}

export async function releaseLeaseForRetry(
  db: PrismaClientOrTransaction,
  params: { alertId: string; leaseId: string; nextEvaluationAt: Date }
): Promise<boolean> {
  const { count } = await db.alert.updateMany({
    where: { id: params.alertId, evaluationLeaseId: params.leaseId },
    data: {
      nextEvaluationAt: params.nextEvaluationAt,
      evaluationLeaseId: null,
      evaluationLeaseUntil: null,
      updatedAt: new Date(),
    },
  });
  return count > 0;
}

export async function listActiveAlertsForReconcile(
  db: PrismaClientOrTransaction,
  params: { cursor?: string; limit: number }
): Promise<{
  alerts: Array<Pick<Alert, "id" | "nextEvaluationAt" | "evaluationLeaseUntil" | "updatedAt">>;
  nextCursor: string | null;
}> {
  const rows = await db.alert.findMany({
    where: { lifecycle: "active", ...(params.cursor ? { id: { gt: params.cursor } } : {}) },
    select: { id: true, nextEvaluationAt: true, evaluationLeaseUntil: true, updatedAt: true },
    orderBy: { id: "asc" },
    take: params.limit + 1,
  });
  const page = rows.slice(0, params.limit);
  const nextCursor = rows.length > params.limit ? page[page.length - 1]!.id : null;
  return { alerts: page, nextCursor };
}

export type ApplyEvaluationOutcomeParams = {
  alertId: string;
  leaseId: string;
  patch: Partial<
    Pick<
      Alert,
      | "attention"
      | "observedCondition"
      | "observedConditionChangedAt"
      | "pendingMetSince"
      | "evaluatorState"
      | "lifecycle"
      | "nextEvaluationAt"
    >
  >;
  events: Array<{
    type: AlertEventType;
    at?: Date;
    facts?: Record<string, unknown>;
    actorId?: string;
    sourceEventId?: string;
  }>;
  deliveries: Array<{
    alertEventIndex: number;
    notifier: NotifierRef;
  }>;
  occurrences?: Array<{ sourceEventId: string; rowTime: Date; expiresAt: Date }>;
  occurrenceCounters?: { add: number; latestAt: Date | null; resetSinceRaise: boolean };
};

function patchAssignments(patch: ApplyEvaluationOutcomeParams["patch"]): Prisma.Sql[] {
  const sets: Prisma.Sql[] = [];
  const text = (column: string, value: string | undefined) => {
    if (value !== undefined) sets.push(Prisma.sql`${Prisma.raw(`"${column}"`)} = ${value}`);
  };
  const time = (column: string, value: Date | null | undefined) => {
    if (value === undefined) return;
    sets.push(
      Prisma.sql`${Prisma.raw(`"${column}"`)} = ${value === null ? Prisma.sql`NULL` : iso(value)}`
    );
  };
  text("attention", patch.attention);
  text("observedCondition", patch.observedCondition);
  time("observedConditionChangedAt", patch.observedConditionChangedAt);
  time("pendingMetSince", patch.pendingMetSince);
  if (patch.evaluatorState !== undefined) {
    sets.push(
      patch.evaluatorState === null
        ? Prisma.sql`"evaluatorState" = NULL`
        : Prisma.sql`"evaluatorState" = ${JSON.stringify(patch.evaluatorState)}::jsonb`
    );
  }
  text("lifecycle", patch.lifecycle);
  time("nextEvaluationAt", patch.nextEvaluationAt);
  return sets;
}

function occurrenceCounterAssignments(
  counters: ApplyEvaluationOutcomeParams["occurrenceCounters"]
): Prisma.Sql[] {
  if (!counters || (counters.add === 0 && !counters.resetSinceRaise)) return [];
  const sets = [
    Prisma.sql`"occurrencesTotal" = "occurrencesTotal" + ${counters.add}::int`,
    counters.resetSinceRaise
      ? Prisma.sql`"occurrencesSinceRaise" = ${counters.add}::int`
      : Prisma.sql`"occurrencesSinceRaise" = "occurrencesSinceRaise" + ${counters.add}::int`,
  ];
  if (counters.add > 0) {
    const latest = counters.latestAt ? iso(counters.latestAt) : Prisma.sql`now()::timestamptz`;
    sets.push(Prisma.sql`"lastOccurrenceAt" = greatest("lastOccurrenceAt", ${latest})`);
  }
  return sets;
}

export async function listActiveSeenOccurrenceKeys(
  db: PrismaClientOrTransaction,
  params: { alertId: string; keys: string[]; now: Date }
): Promise<Set<string>> {
  if (params.keys.length === 0) return new Set();
  const rows = await db.alertOccurrenceSeen.findMany({
    where: {
      alertId: params.alertId,
      sourceEventId: { in: boundedIn(params.keys) },
      expiresAt: { gt: params.now },
    },
    select: { sourceEventId: true },
  });
  return new Set(rows.map((r) => r.sourceEventId));
}

export async function applyEvaluationOutcome(
  db: PrismaClientOrTransaction,
  params: ApplyEvaluationOutcomeParams
): Promise<{
  applied: boolean;
  events: AlertEvent[];
  deliveries: AlertDelivery[];
  alert: Alert | null;
}> {
  return inTransaction(db, OUTCOME_TRANSACTION_TIMEOUT_MS, async (tx) => {
    const sets = [
      ...patchAssignments(params.patch),
      ...occurrenceCounterAssignments(params.occurrenceCounters),
      Prisma.sql`"evaluationLeaseId" = NULL`,
      Prisma.sql`"evaluationLeaseUntil" = NULL`,
      Prisma.sql`"lastEvaluatedAt" = now()`,
      Prisma.sql`"updatedAt" = now()`,
    ];
    const updated = await tx.$queryRaw<AlertRow[]>`
      UPDATE "Alert" SET ${Prisma.join(sets, ", ")}
      WHERE "id" = ${params.alertId} AND "evaluationLeaseId" = ${params.leaseId}
      RETURNING *`;

    if (updated.length === 0) {
      return { applied: false, events: [], deliveries: [], alert: null };
    }

    const occurrences = new Map<string, { rowTime: Date; expiresAt: Date }>();
    for (const occ of params.occurrences ?? []) {
      if (!occurrences.has(occ.sourceEventId)) occurrences.set(occ.sourceEventId, occ);
    }
    const committed = new Set<string>();
    if (occurrences.size > 0) {
      const values = Array.from(
        occurrences,
        ([sourceEventId, occ]) =>
          Prisma.sql`(${params.alertId}, ${sourceEventId}, ${iso(occ.rowTime)}, ${iso(occ.expiresAt)})`
      );
      const rows = await tx.$queryRaw<Array<{ sourceEventId: string }>>`
        INSERT INTO "AlertOccurrenceSeen" ("alertId", "sourceEventId", "rowTime", "expiresAt")
        VALUES ${Prisma.join(values, ", ")}
        ON CONFLICT ("alertId", "sourceEventId") DO UPDATE SET
          "rowTime" = excluded."rowTime",
          "seenAt" = excluded."seenAt",
          "expiresAt" = excluded."expiresAt"
        WHERE "AlertOccurrenceSeen"."expiresAt" <= excluded."seenAt"
        RETURNING "sourceEventId"`;
      for (const row of rows) committed.add(row.sourceEventId);
    }
    if (committed.size !== occurrences.size) {
      throw new Error("alerts.seen_conflict");
    }

    const eventByOriginalIndex = new Map<number, AlertEvent>();
    for (let i = 0; i < params.events.length; i++) {
      const evt = params.events[i]!;
      const at = evt.at ? iso(evt.at) : Prisma.sql`now()`;
      const rows = await tx.$queryRaw<AlertEventRow[]>`
        INSERT INTO "AlertEvent" ("id", "alertId", "type", "at", "facts", "actorId", "sourceEventId")
        VALUES (${generateAlertEventId()}, ${params.alertId}, ${evt.type}, ${at}, ${JSON.stringify(
          evt.facts ?? {}
        )}::jsonb, ${evt.actorId ?? null}, ${evt.sourceEventId ?? null})
        RETURNING *`;
      eventByOriginalIndex.set(i, toAlertEvent(rows[0]!));
    }

    const insertedEvents = Array.from(eventByOriginalIndex.values());
    const insertedDeliveries: AlertDelivery[] = [];
    for (const del of params.deliveries) {
      const event = eventByOriginalIndex.get(del.alertEventIndex);
      if (!event) continue;
      const rows = await tx.$queryRaw<AlertDeliveryRow[]>`
        INSERT INTO "AlertDelivery" ("id", "alertEventId", "eventAt", "notifierId", "notifier")
        VALUES (${generateAlertDeliveryId()}, ${event.id}, ${iso(event.at)}, ${notifierRefKey(
          del.notifier
        )}, ${JSON.stringify(del.notifier)}::jsonb)
        ON CONFLICT DO NOTHING
        RETURNING *`;
      if (rows[0]) insertedDeliveries.push(toAlertDelivery(rows[0]));
    }

    return {
      applied: true,
      events: insertedEvents,
      deliveries: insertedDeliveries,
      alert: toAlert(updated[0]!),
    };
  });
}

export async function resolveAlert(
  db: PrismaClientOrTransaction,
  params: { id: string; actorId: string; now?: Date }
): Promise<{ alert: Alert; event: AlertEvent } | null> {
  return inTransaction(db, ACTION_TRANSACTION_TIMEOUT_MS, async (tx) => {
    const now = params.now ?? new Date();
    const updated = await tx.alert.updateManyAndReturn({
      where: { id: params.id, attention: "needs_attention" },
      data: {
        attention: "clear",
        resolvedAt: now,
        resolvedBy: params.actorId,
        evaluationLeaseId: null,
        evaluationLeaseUntil: null,
        updatedAt: new Date(),
      },
    });
    if (updated.length === 0) return null;

    const event = await tx.alertEvent.create({
      data: {
        id: generateAlertEventId(),
        alertId: params.id,
        type: "resolved",
        at: now,
        facts: {},
        actorId: params.actorId,
      },
    });
    return { alert: toAlert(updated[0]!), event: toAlertEvent(event) };
  });
}

export async function stopAlert(
  db: PrismaClientOrTransaction,
  params: { id: string; projectId: string; environmentId: string; actorId: string; now?: Date }
): Promise<{ alert: Alert; event: AlertEvent } | null> {
  return inTransaction(db, ACTION_TRANSACTION_TIMEOUT_MS, async (tx) => {
    const now = params.now ?? new Date();
    const updated = await tx.alert.updateManyAndReturn({
      where: {
        id: params.id,
        projectId: params.projectId,
        environmentId: params.environmentId,
        lifecycle: "active",
      },
      data: {
        lifecycle: "stopped",
        stoppedAt: now,
        stoppedBy: params.actorId,
        evaluationLeaseId: null,
        evaluationLeaseUntil: null,
        updatedAt: new Date(),
      },
    });
    if (updated.length === 0) return null;

    const event = await tx.alertEvent.create({
      data: {
        id: generateAlertEventId(),
        alertId: params.id,
        type: "stopped",
        at: now,
        facts: {},
        actorId: params.actorId,
      },
    });
    return { alert: toAlert(updated[0]!), event: toAlertEvent(event) };
  });
}

export async function deleteAlert(
  db: PrismaClientOrTransaction,
  params: { id: string; projectId: string; environmentId: string }
): Promise<Alert | null> {
  return inTransaction(db, ACTION_TRANSACTION_TIMEOUT_MS, async (tx) => {
    const deleted = await tx.$queryRaw<AlertRow[]>`
      DELETE FROM "Alert"
      WHERE "id" = ${params.id}
        AND "projectId" = ${params.projectId}
        AND "environmentId" = ${params.environmentId}
      RETURNING *`;
    if (deleted.length === 0) return null;

    await tx.$executeRaw`
      DELETE FROM "AlertDelivery"
      WHERE "alertEventId" IN (SELECT "id" FROM "AlertEvent" WHERE "alertId" = ${params.id})`;
    await tx.alertEvent.deleteMany({ where: { alertId: params.id } });
    await tx.alertOccurrenceSeen.deleteMany({ where: { alertId: params.id } });
    return toAlert(deleted[0]!);
  });
}

export async function deleteAlertIfNoEvents(
  db: PrismaClientOrTransaction,
  params: { id: string; projectId: string; environmentId: string }
): Promise<Alert | null> {
  return inTransaction(db, ACTION_TRANSACTION_TIMEOUT_MS, async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "Alert"
      WHERE "id" = ${params.id}
        AND "projectId" = ${params.projectId}
        AND "environmentId" = ${params.environmentId}
      FOR UPDATE`;
    if (locked.length === 0) return null;

    const event = await tx.alertEvent.findFirst({
      where: { alertId: params.id },
      select: { id: true },
    });
    if (event) return null;

    const deleted = await tx.$queryRaw<AlertRow[]>`
      DELETE FROM "Alert" WHERE "id" = ${params.id} RETURNING *`;
    await tx.alertOccurrenceSeen.deleteMany({ where: { alertId: params.id } });
    return deleted[0] ? toAlert(deleted[0]) : null;
  });
}

export const EXPIRE_ALERTS_BATCH = 200;

export async function expireAlerts(
  db: PrismaClientOrTransaction,
  now: Date,
  opts: { limit: number }
): Promise<Array<{ alert: Alert; event: AlertEvent }>> {
  return inTransaction(db, OUTCOME_TRANSACTION_TIMEOUT_MS, async (tx) => {
    const due = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "Alert"
      WHERE "lifecycle" = 'active' AND "expiresAt" <= ${iso(now)}
      ORDER BY "expiresAt" ASC
      LIMIT ${opts.limit}::int
      FOR UPDATE SKIP LOCKED`;
    if (due.length === 0) return [];

    const rows = await tx.$queryRaw<AlertRow[]>`
      UPDATE "Alert"
      SET "lifecycle" = 'expired',
        "attention" = 'clear',
        "evaluationLeaseId" = NULL,
        "evaluationLeaseUntil" = NULL,
        "updatedAt" = now()
      WHERE "lifecycle" = 'active' AND "id" IN (${Prisma.join(due.map((d) => d.id))})
      RETURNING *`;
    const updated = rows.map(toAlert);

    updated.sort((a, b) => (a.expiresAt?.getTime() ?? 0) - (b.expiresAt?.getTime() ?? 0));

    const results: Array<{ alert: Alert; event: AlertEvent }> = [];
    for (const alert of updated) {
      const event = await tx.alertEvent.create({
        data: {
          id: generateAlertEventId(),
          alertId: alert.id,
          type: "expired",
          at: now,
          facts: {},
        },
      });
      results.push({ alert, event: toAlertEvent(event) });
    }
    return results;
  });
}

export async function appendAlertEvent(
  db: PrismaClientOrTransaction,
  params: Omit<NewAlertEvent, "id"> & { id?: string }
): Promise<AlertEvent> {
  const row = await db.alertEvent.create({
    data: {
      ...params,
      id: params.id ?? generateAlertEventId(),
      facts: params.facts === undefined ? undefined : json(params.facts),
    },
  });
  return toAlertEvent(row);
}

export async function sweepExpiredOccurrenceSeen(
  db: PrismaClientOrTransaction,
  params: { now: Date; batch: number }
): Promise<number> {
  return db.$executeRaw`
    DELETE FROM "AlertOccurrenceSeen"
    WHERE ctid IN (
      SELECT ctid FROM "AlertOccurrenceSeen"
      WHERE "expiresAt" < ${iso(params.now)}
      LIMIT ${params.batch}::int
    )`;
}

export async function listAlertEvents(
  db: PrismaClientOrTransaction,
  alertId: string,
  params?: { limit?: number; before?: Date }
): Promise<AlertEvent[]> {
  const rows = await db.alertEvent.findMany({
    where: { alertId, ...(params?.before ? { at: { lt: params.before } } : {}) },
    orderBy: { at: "desc" },
    take: params?.limit ?? 50,
  });
  return rows.map(toAlertEvent);
}

export async function firstAlertEventAt(db: PrismaClientOrTransaction, alertId: string) {
  const row = await db.alertEvent.findFirst({
    where: { alertId },
    orderBy: { at: "asc" },
    select: { at: true },
  });
  return row?.at;
}

export const ALERT_EVENT_WINDOW_CAP = 1000;

export async function listAlertEventsInWindow(
  db: PrismaClientOrTransaction,
  alertId: string,
  params: { since: Date; until: Date; limit?: number }
): Promise<AlertEvent[]> {
  const rows = await db.alertEvent.findMany({
    where: {
      alertId,
      at: { gte: params.since, lt: new Date(params.until.getTime() + 1) },
    },
    orderBy: { at: "desc" },
    take: params.limit ?? ALERT_EVENT_WINDOW_CAP,
  });
  return rows.map(toAlertEvent).reverse();
}

export async function countAlertEventsByType(
  db: PrismaClientOrTransaction,
  params: { alertId: string; type: AlertEventType }
): Promise<number> {
  return db.alertEvent.count({ where: { alertId: params.alertId, type: params.type } });
}

export async function latestAlertEventBefore(
  db: PrismaClientOrTransaction,
  alertId: string,
  before: Date
): Promise<AlertEvent | undefined> {
  const row = await db.alertEvent.findFirst({
    where: { alertId, at: { lt: before } },
    orderBy: { at: "desc" },
  });
  return row ? toAlertEvent(row) : undefined;
}

function withinMillisecond(at: Date) {
  return { gte: at, lt: new Date(at.getTime() + 1) };
}

function withinMillisecondSql(column: string, at: Date) {
  const col = Prisma.raw(`"${column}"`);
  return Prisma.sql`${col} >= ${iso(at)} AND ${col} < ${iso(new Date(at.getTime() + 1))}`;
}

export async function getAlertEvent(
  db: PrismaClientOrTransaction,
  params: { id: string; at: Date }
): Promise<AlertEvent | null> {
  const row = await db.alertEvent.findFirst({
    where: { id: params.id, at: withinMillisecond(params.at) },
  });
  return row ? toAlertEvent(row) : null;
}

export type AlertDeliveryClaim = {
  delivery: AlertDelivery;
  claimId: string;
};

function claimableCondition(staleBefore: Date) {
  return Prisma.sql`("status" = 'pending' OR ("status" = 'delivering' AND coalesce("claimedAt", "createdAt") <= ${iso(
    staleBefore
  )}))`;
}

export async function claimDelivery(
  db: PrismaClientOrTransaction,
  params: {
    id: string;
    eventAt: Date;
    claimId?: string;
    staleBefore: Date;
    cap: DeliveryRetryCap;
  }
): Promise<AlertDeliveryClaim | null> {
  const claimId = params.claimId ?? generateAlertDeliveryClaimId();
  const rows = await db.$queryRaw<AlertDeliveryRow[]>`
    UPDATE "AlertDelivery"
    SET "status" = 'delivering',
      "claimId" = ${claimId},
      "claimedAt" = now(),
      "attempts" = "attempts" + 1,
      "firstAttemptAt" = coalesce("firstAttemptAt", now())
    WHERE "id" = ${params.id}
      AND ${withinMillisecondSql("eventAt", params.eventAt)}
      AND ${claimableCondition(params.staleBefore)}
      AND NOT ${exhaustedCondition(params.cap, new Date())}
    RETURNING *`;
  const delivery = rows[0];
  return delivery ? { delivery: toAlertDelivery(delivery), claimId } : null;
}

export async function failExhaustedDelivery(
  db: PrismaClientOrTransaction,
  params: {
    id: string;
    eventAt: Date;
    staleBefore: Date;
    cap: DeliveryRetryCap;
  }
): Promise<boolean> {
  const count = await db.$executeRaw`
    UPDATE "AlertDelivery"
    SET "status" = 'failed', "failureReason" = ${DELIVERY_RETRIES_EXHAUSTED}
    WHERE "id" = ${params.id}
      AND ${withinMillisecondSql("eventAt", params.eventAt)}
      AND ${claimableCondition(params.staleBefore)}
      AND ${exhaustedCondition(params.cap, new Date())}`;
  return count > 0;
}

export async function releaseDelivery(
  db: PrismaClientOrTransaction,
  params: { id: string; eventAt: Date; claimId: string; refundAttempt?: boolean }
): Promise<AlertDelivery | null> {
  const refund = params.refundAttempt
    ? Prisma.sql`, "attempts" = greatest("attempts" - 1, 0)`
    : Prisma.empty;
  const rows = await db.$queryRaw<AlertDeliveryRow[]>`
    UPDATE "AlertDelivery"
    SET "status" = 'pending', "claimId" = NULL, "claimedAt" = NULL${refund}
    WHERE "id" = ${params.id}
      AND ${withinMillisecondSql("eventAt", params.eventAt)}
      AND "claimId" = ${params.claimId}
      AND "status" = 'delivering'
    RETURNING *`;
  return rows[0] ? toAlertDelivery(rows[0]) : null;
}

export async function markDelivered(
  db: PrismaClientOrTransaction,
  params: {
    id: string;
    eventAt: Date;
    claimId: string;
    providerMetadata?: Record<string, unknown>;
  }
): Promise<AlertDelivery | null> {
  const metadata =
    params.providerMetadata !== undefined
      ? Prisma.sql`, "providerMetadata" = ${JSON.stringify(params.providerMetadata)}::jsonb`
      : Prisma.empty;
  const rows = await db.$queryRaw<AlertDeliveryRow[]>`
    UPDATE "AlertDelivery"
    SET "status" = 'delivered', "deliveredAt" = now()${metadata}
    WHERE "id" = ${params.id}
      AND ${withinMillisecondSql("eventAt", params.eventAt)}
      AND "claimId" = ${params.claimId}
      AND "status" = 'delivering'
    RETURNING *`;
  return rows[0] ? toAlertDelivery(rows[0]) : null;
}

export async function markDeliveryFailed(
  db: PrismaClientOrTransaction,
  params: { id: string; eventAt: Date; claimId: string; reason: string }
): Promise<AlertDelivery | null> {
  const rows = await db.$queryRaw<AlertDeliveryRow[]>`
    UPDATE "AlertDelivery"
    SET "status" = 'failed', "failureReason" = ${params.reason}
    WHERE "id" = ${params.id}
      AND ${withinMillisecondSql("eventAt", params.eventAt)}
      AND "claimId" = ${params.claimId}
      AND "status" = 'delivering'
    RETURNING *`;
  return rows[0] ? toAlertDelivery(rows[0]) : null;
}

export async function listPendingDeliveriesForEvent(
  db: PrismaClientOrTransaction,
  alertEventId: string,
  eventAt: Date
): Promise<AlertDelivery[]> {
  const rows = await db.alertDelivery.findMany({
    where: { alertEventId, eventAt: withinMillisecond(eventAt), status: "pending" },
  });
  return rows.map(toAlertDelivery);
}

export async function listClaimableDeliveriesForEvent(
  db: PrismaClientOrTransaction,
  alertEventId: string,
  eventAt: Date,
  staleBefore: Date
): Promise<AlertDelivery[]> {
  const rows = await db.$queryRaw<AlertDeliveryRow[]>`
    SELECT * FROM "AlertDelivery"
    WHERE "alertEventId" = ${alertEventId}
      AND ${withinMillisecondSql("eventAt", eventAt)}
      AND ${claimableCondition(staleBefore)}`;
  return rows.map(toAlertDelivery);
}

export const DELIVERY_RETRIES_EXHAUSTED = "retries_exhausted";

export type DeliveryRetryCap = { maxAttempts: number; maxAgeMs: number };

export function isDeliveryExhausted(
  delivery: Pick<AlertDelivery, "attempts" | "firstAttemptAt" | "createdAt">,
  cap: DeliveryRetryCap,
  now: Date
): boolean {
  const startedAt = delivery.firstAttemptAt ?? delivery.createdAt;
  return (
    delivery.attempts >= cap.maxAttempts || startedAt.getTime() <= now.getTime() - cap.maxAgeMs
  );
}

function exhaustedCondition(cap: DeliveryRetryCap, now: Date) {
  const startedBefore = new Date(now.getTime() - cap.maxAgeMs);
  return Prisma.sql`("attempts" >= ${cap.maxAttempts}::int OR coalesce("firstAttemptAt", "createdAt") <= ${iso(
    startedBefore
  )})`;
}

function staleDeliveryCondition(params: { olderThan: Date; staleClaimBefore: Date }) {
  const staleClaimBefore = iso(params.staleClaimBefore);
  return Prisma.sql`(
    ("status" = 'pending' AND "claimId" IS NULL AND "createdAt" < ${iso(params.olderThan)})
    OR (
      "status" = 'delivering'
      AND ("claimedAt" < ${staleClaimBefore} OR ("claimedAt" IS NULL AND "createdAt" < ${staleClaimBefore}))
    )
  )`;
}

export async function findStalePendingDeliveries(
  db: PrismaClientOrTransaction,
  params: {
    olderThan: Date;
    staleClaimBefore: Date;
    limit: number;
    cap: DeliveryRetryCap;
    now: Date;
  }
): Promise<AlertDelivery[]> {
  const rows = await db.$queryRaw<AlertDeliveryRow[]>`
    SELECT * FROM "AlertDelivery"
    WHERE ${staleDeliveryCondition(params)}
      AND NOT ${exhaustedCondition(params.cap, params.now)}
    ORDER BY "createdAt"
    LIMIT ${params.limit}::int`;
  return rows.map(toAlertDelivery);
}

export async function failExhaustedDeliveries(
  db: PrismaClientOrTransaction,
  params: { olderThan: Date; staleClaimBefore: Date; cap: DeliveryRetryCap; now: Date }
): Promise<number> {
  return db.$executeRaw`
    UPDATE "AlertDelivery"
    SET "status" = 'failed', "failureReason" = ${DELIVERY_RETRIES_EXHAUSTED}
    WHERE ${staleDeliveryCondition(params)}
      AND ${exhaustedCondition(params.cap, params.now)}`;
}

export type AlertEventTimes = {
  latest: Date | null;
  raised: Date | null;
  recovered: Date | null;
};

function alertIdArray(alertIds: string[]) {
  return Prisma.sql`ARRAY[${Prisma.join(alertIds)}]::text[]`;
}

export async function getLatestAlertEventTimes(
  db: PrismaClientOrTransaction,
  alertIds: string[]
): Promise<Map<string, AlertEventTimes>> {
  if (alertIds.length === 0) return new Map();

  const latestOf = (alias: string, type?: AlertEventType) => Prisma.sql`
    LEFT JOIN LATERAL (
      SELECT "at" FROM "AlertEvent"
      WHERE "alertId" = ids.id ${type ? Prisma.sql`AND "type" = ${type}` : Prisma.empty}
      ORDER BY "at" DESC LIMIT 1
    ) ${Prisma.raw(alias)} ON true`;

  const rows = await db.$queryRaw<
    Array<{ alert_id: string; latest: Date | null; raised: Date | null; recovered: Date | null }>
  >`
    SELECT ids.id AS alert_id, l.at AS latest, r.at AS raised, c.at AS recovered
    FROM unnest(${alertIdArray(alertIds)}) AS ids(id)
    ${latestOf("l")}
    ${latestOf("r", "raised")}
    ${latestOf("c", "recovered")}`;

  return new Map(
    rows.map((row) => [
      row.alert_id,
      { latest: row.latest ?? null, raised: row.raised ?? null, recovered: row.recovered ?? null },
    ])
  );
}

export type AlertHealthEvent = { type: string; at: Date; facts: Record<string, unknown> };

export async function getAlertHealthEvents(
  db: PrismaClientOrTransaction,
  alertIds: string[],
  since: Date
): Promise<Map<string, AlertHealthEvent[]>> {
  if (alertIds.length === 0) return new Map();

  const sinceAt = iso(since);
  const rows = await db.$queryRaw<
    Array<{ alert_id: string; type: string; at: Date; facts: Record<string, unknown> | null }>
  >`
    WITH ids AS (
      SELECT unnest(${alertIdArray(alertIds)}) AS id
    )
    SELECT ids.id AS alert_id, w.type, w.at, w.facts FROM ids
    JOIN LATERAL (
      SELECT "type" AS type, "at" AS at, "facts" AS facts
      FROM "AlertEvent"
      WHERE "alertId" = ids.id AND "at" >= ${sinceAt}
      ORDER BY "at" DESC LIMIT 1000
    ) w ON true
    UNION ALL
    SELECT ids.id AS alert_id, s.type, s.at, s.facts FROM ids
    JOIN LATERAL (
      SELECT "type" AS type, "at" AS at, "facts" AS facts
      FROM "AlertEvent"
      WHERE "alertId" = ids.id AND "at" < ${sinceAt}
      ORDER BY "at" DESC LIMIT 1
    ) s ON true`;

  const result = new Map<string, AlertHealthEvent[]>();
  for (const row of rows) {
    const list = result.get(row.alert_id) ?? [];
    list.push({ type: row.type, at: row.at, facts: row.facts ?? {} });
    result.set(row.alert_id, list);
  }
  return result;
}
