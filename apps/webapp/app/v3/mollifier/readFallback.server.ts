import type { MollifierBuffer } from "@trigger.dev/redis-worker";
import { logger } from "~/services/logger.server";
import { deserialiseMollifierSnapshot } from "./mollifierSnapshot.server";
import { getMollifierBuffer } from "./mollifierBuffer.server";

export type ReadFallbackInput = {
  runId: string;
  environmentId: string;
  organizationId: string;
};

export type SyntheticRun = {
  friendlyId: string;
  status: "QUEUED" | "FAILED";
  taskIdentifier: string | undefined;
  createdAt: Date;

  payload: unknown;
  payloadType: string | undefined;
  metadata: unknown;
  metadataType: string | undefined;

  idempotencyKey: string | undefined;
  idempotencyKeyOptions: string[] | undefined;
  isTest: boolean;
  depth: number;
  ttl: string | undefined;
  tags: string[];
  lockedToVersion: string | undefined;
  resumeParentOnCompletion: boolean;
  parentTaskRunId: string | undefined;

  // Allocated at gate-accept time and embedded in the snapshot so the run's
  // trace is continuous from QUEUED-in-buffer through executing post-drain.
  traceId: string | undefined;
  spanId: string | undefined;
  parentSpanId: string | undefined;

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

    return {
      friendlyId: entry.runId,
      status: entry.status === "FAILED" ? "FAILED" : "QUEUED",
      taskIdentifier: asString(snapshot.taskIdentifier),
      createdAt: entry.createdAt,

      payload: snapshot.payload,
      payloadType: asString(snapshot.payloadType),
      metadata: snapshot.metadata,
      metadataType: asString(snapshot.metadataType),

      idempotencyKey: asString(snapshot.idempotencyKey),
      idempotencyKeyOptions,
      isTest: snapshot.isTest === true,
      depth: typeof snapshot.depth === "number" ? snapshot.depth : 0,
      ttl: asString(snapshot.ttl),
      tags: asStringArray(snapshot.tags),
      lockedToVersion: asString(snapshot.lockToVersion),
      resumeParentOnCompletion: snapshot.resumeParentOnCompletion === true,
      parentTaskRunId: asString(snapshot.parentTaskRunId),

      traceId: asString(snapshot.traceId),
      spanId: asString(snapshot.spanId),
      parentSpanId: asString(snapshot.parentSpanId),

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
