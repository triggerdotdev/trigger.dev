import type { MollifierBuffer } from "@trigger.dev/redis-worker";
import { logger } from "~/services/logger.server";
import { getMollifierBuffer } from "./mollifierBuffer.server";
import { deserialiseMollifierSnapshot } from "./mollifierSnapshot.server";

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
  error?: { code: string; message: string };
};

export type ReadFallbackDeps = {
  getBuffer?: () => MollifierBuffer | null;
};

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
    const taskIdentifier =
      typeof snapshot.taskIdentifier === "string" ? snapshot.taskIdentifier : undefined;

    return {
      friendlyId: entry.runId,
      status: entry.status === "FAILED" ? "FAILED" : "QUEUED",
      taskIdentifier,
      createdAt: entry.createdAt,
      payload: snapshot,
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
