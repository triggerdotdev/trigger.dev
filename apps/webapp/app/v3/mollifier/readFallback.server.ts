import type { MollifierBuffer } from "@trigger.dev/redis-worker";
import { RunId } from "@trigger.dev/core/v3/isomorphic";
import { logger } from "~/services/logger.server";
import { deserialiseMollifierSnapshot } from "./mollifierSnapshot.server";
import { getMollifierBuffer } from "./mollifierBuffer.server";

export type ReadFallbackInput = {
  runId: string;
  environmentId: string;
  organizationId: string;
};

export type SyntheticRun = {
  // Snapshot-derived TaskRun primary key. Used by ReplayTaskRunService
  // for logging and by callers passing this object where a TaskRun is
  // expected (cast). Derived deterministically from `friendlyId`.
  id: string;
  friendlyId: string;
  status: "QUEUED" | "FAILED" | "CANCELED";
  // Set when the customer cancelled the run via the dashboard or API
  // while it was buffered. The drainer's cancel bifurcation reads this
  // on next pop and writes a CANCELED PG row directly (skipping
  // materialisation). Reflected back into the UI by the synthesised
  // SpanRun so the run-detail page shows the cancelled state even before
  // the drainer materialises it.
  cancelledAt: Date | undefined;
  cancelReason: string | undefined;
  // Reschedule patch (`set_delay`) writes `delayUntil` into the snapshot.
  // Surfacing it on SyntheticRun lets the retrieve-run shape reflect the
  // pending delay before the drainer materialises the PG row.
  delayUntil: Date | undefined;
  taskIdentifier: string | undefined;
  createdAt: Date;

  payload: unknown;
  payloadType: string | undefined;
  metadata: unknown;
  metadataType: string | undefined;
  // Seed-metadata mirrors what `triggerTask.server.ts` writes into the
  // snapshot: the original metadataPacket data preserved separately from
  // any later customer mutations. ReplayTaskRunService uses these to
  // rebuild the replay's metadata.
  seedMetadata: string | undefined;
  seedMetadataType: string | undefined;

  idempotencyKey: string | undefined;
  // Surfaced for the cached-hit expiration check in IdempotencyKeyConcern.
  // The PG-resident path enforces this (clears key, allows new run when
  // expired). For buffered runs the snapshot carries the same field — we
  // expose it here so the cached-hit branch can apply the same check
  // rather than indefinitely returning the buffered run's id.
  idempotencyKeyExpiresAt: Date | undefined;
  idempotencyKeyOptions: string[] | undefined;
  isTest: boolean;
  depth: number;
  ttl: string | undefined;
  tags: string[];
  // Mirror of `tags` under the PG field name. ReplayTaskRunService reads
  // `existingTaskRun.runTags`; both names are kept here so a synthetic
  // run can be passed wherever the PG-shape `runTags` is expected.
  runTags: string[];
  lockedToVersion: string | undefined;
  resumeParentOnCompletion: boolean;
  parentTaskRunId: string | undefined;

  // Allocated at gate-accept time and embedded in the snapshot so the run's
  // trace is continuous from QUEUED-in-buffer through executing post-drain.
  traceId: string | undefined;
  spanId: string | undefined;
  parentSpanId: string | undefined;

  // Replay-relevant fields populated from the engine-trigger snapshot.
  // ReplayTaskRunService reads each of these from the existing TaskRun;
  // when the original lives in the buffer we synthesise them here.
  runtimeEnvironmentId: string | undefined;
  engine: "V2";
  workerQueue: string | undefined;
  queue: string | undefined;
  concurrencyKey: string | undefined;
  machinePreset: string | undefined;
  realtimeStreamsVersion: string | undefined;

  // Additional snapshot-sourced fields used when synthesising a SpanRun
  // for the dashboard's right-side details panel. All optional because
  // older snapshots may not carry them.
  maxAttempts: number | undefined;
  maxDurationInSeconds: number | undefined;
  replayedFromTaskRunFriendlyId: string | undefined;
  annotations: unknown;
  traceContext: unknown;
  scheduleId: string | undefined;
  batchId: string | undefined;
  parentTaskRunFriendlyId: string | undefined;
  rootTaskRunFriendlyId: string | undefined;

  error?: { code: string; message: string };
};

export type ReadFallbackDeps = {
  getBuffer?: () => MollifierBuffer | null;
};

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string") ? (value as string[]) : [];
}

function asDate(value: unknown): Date | undefined {
  const raw = asString(value);
  if (!raw) return undefined;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

// Snapshot ids are written by engine.trigger as INTERNAL ids (cuids); the
// SyntheticRun contract exposes friendlyIds. `RunId.toFriendlyId` is
// already used for the synthetic run's own id (line 155); reuse it for
// parent/root so consumers see the same shape as the PG path.
function internalRunIdToFriendlyId(internalId: string | undefined): string | undefined {
  if (!internalId) return undefined;
  return RunId.toFriendlyId(internalId);
}

export async function findRunByIdWithMollifierFallback(
  input: ReadFallbackInput,
  deps: ReadFallbackDeps = {},
): Promise<SyntheticRun | null> {
  const buffer = (deps.getBuffer ?? getMollifierBuffer)();
  if (!buffer) return null;

  try {
    const entry = await buffer.getEntry(input.runId);
    if (!entry) return null;

    if (entry.envId !== input.environmentId || entry.orgId !== input.organizationId) {
      logger.warn("mollifier read-fallback auth mismatch", {
        runId: input.runId,
        callerEnvId: input.environmentId,
        callerOrgId: input.organizationId,
      });
      return null;
    }

    const snapshot = deserialiseMollifierSnapshot(entry.payload);
    const idempotencyKeyOptionsRaw = snapshot.idempotencyKeyOptions;
    const idempotencyKeyOptions = Array.isArray(idempotencyKeyOptionsRaw)
      ? asStringArray(idempotencyKeyOptionsRaw)
      : undefined;

    const tags = asStringArray(snapshot.tags);
    const environment =
      snapshot.environment && typeof snapshot.environment === "object"
        ? (snapshot.environment as Record<string, unknown>)
        : undefined;

    const cancelledAt = asDate(snapshot.cancelledAt);
    const cancelReason = asString(snapshot.cancelReason);
    let status: SyntheticRun["status"] = "QUEUED";
    if (cancelledAt) {
      status = "CANCELED";
    } else if (entry.status === "FAILED") {
      status = "FAILED";
    }
    const delayUntil = asDate(snapshot.delayUntil);

    return {
      id: RunId.fromFriendlyId(entry.runId),
      friendlyId: entry.runId,
      status,
      cancelledAt,
      cancelReason,
      delayUntil,
      taskIdentifier: asString(snapshot.taskIdentifier),
      createdAt: entry.createdAt,

      payload: snapshot.payload,
      payloadType: asString(snapshot.payloadType),
      metadata: snapshot.metadata,
      metadataType: asString(snapshot.metadataType),
      seedMetadata: asString(snapshot.seedMetadata),
      seedMetadataType: asString(snapshot.seedMetadataType),

      idempotencyKey: asString(snapshot.idempotencyKey),
      idempotencyKeyExpiresAt: asDate(snapshot.idempotencyKeyExpiresAt),
      idempotencyKeyOptions,
      isTest: snapshot.isTest === true,
      depth: typeof snapshot.depth === "number" ? snapshot.depth : 0,
      ttl: asString(snapshot.ttl),
      tags,
      runTags: tags,
      lockedToVersion: asString(snapshot.taskVersion),
      resumeParentOnCompletion: snapshot.resumeParentOnCompletion === true,
      parentTaskRunId: asString(snapshot.parentTaskRunId),

      traceId: asString(snapshot.traceId),
      spanId: asString(snapshot.spanId),
      parentSpanId: asString(snapshot.parentSpanId),

      runtimeEnvironmentId:
        asString(environment?.id) ?? entry.envId,
      engine: "V2",
      workerQueue: asString(snapshot.workerQueue),
      queue: asString(snapshot.queue),
      concurrencyKey: asString(snapshot.concurrencyKey),
      machinePreset: asString(snapshot.machine),
      realtimeStreamsVersion: asString(snapshot.realtimeStreamsVersion),

      maxAttempts: typeof snapshot.maxAttempts === "number" ? snapshot.maxAttempts : undefined,
      maxDurationInSeconds:
        typeof snapshot.maxDurationInSeconds === "number"
          ? snapshot.maxDurationInSeconds
          : undefined,
      replayedFromTaskRunFriendlyId: asString(snapshot.replayedFromTaskRunFriendlyId),
      annotations: snapshot.annotations,
      traceContext: snapshot.traceContext,
      scheduleId: asString(snapshot.scheduleId),
      // The engine.trigger input embeds the batch as `{ id, index }` (see
      // triggerTask.server.ts #buildEngineTriggerInput), not as a flat
      // `batchId`. The nested `id` is the batch's internal cuid — the same
      // value PG stores in `TaskRun.batchId` — so callers reconstruct the
      // friendly id via `BatchId.toFriendlyId` exactly as the PG path does.
      batchId: asString((snapshot.batch as { id?: unknown } | undefined)?.id),
      // The snapshot only carries the INTERNAL parent/root ids
      // (`parentTaskRunId` / `rootTaskRunId` — what engine.trigger consumes),
      // not the friendlyIds the SyntheticRun contract expects. Convert
      // internal → friendly here so consumers don't have to special-case
      // the buffered path.
      parentTaskRunFriendlyId: internalRunIdToFriendlyId(
        asString(snapshot.parentTaskRunId)
      ),
      rootTaskRunFriendlyId: internalRunIdToFriendlyId(
        asString(snapshot.rootTaskRunId)
      ),

      error: entry.lastError,
    };
  } catch (err) {
    logger.error("mollifier read-fallback errored — fail-open to null", {
      runId: input.runId,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
