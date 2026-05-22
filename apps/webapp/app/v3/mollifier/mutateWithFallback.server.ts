import type {
  MollifierBuffer,
  MutateSnapshotResult,
  SnapshotPatch,
} from "@trigger.dev/redis-worker";
import type { TaskRun } from "@trigger.dev/database";
import { prisma, $replica } from "~/db.server";
import { logger } from "~/services/logger.server";
import { getMollifierBuffer } from "./mollifierBuffer.server";

// Wait/retry knobs per Q3 design. Exported for tests.
export const DEFAULT_SAFETY_NET_MS = 2_000;
export const DEFAULT_POLL_STEP_MS = 20;
export const DEFAULT_PG_TIMEOUT_MS = 50;

export type MutateWithFallbackInput<TResponse> = {
  runId: string;
  environmentId: string;
  organizationId: string;
  bufferPatch: SnapshotPatch;
  // Called when a PG row exists (either replica-hit or post-wait writer-hit).
  // Receives the full TaskRun shape and returns the customer-visible body.
  pgMutation: (pgRow: TaskRun) => Promise<TResponse>;
  // Called when the patch landed cleanly on the buffer snapshot. The
  // drainer will see the patched payload on its next pop.
  synthesisedResponse: () => TResponse | Promise<TResponse>;
  abortSignal?: AbortSignal;
  // Override defaults for tests.
  safetyNetMs?: number;
  pollStepMs?: number;
  pgTimeoutMs?: number;
  // Test injection.
  getBuffer?: () => MollifierBuffer | null;
  prismaWriter?: TaskRunReader;
  prismaReplica?: TaskRunReader;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

export type MutateWithFallbackOutcome<TResponse> =
  | { kind: "pg"; response: TResponse }
  | { kind: "snapshot"; response: TResponse }
  | { kind: "not_found" }
  | { kind: "timed_out" };

// PG-first → buffer mutateSnapshot → wait-and-bounce. Implements the Q3
// design (`_plans/2026-05-19-mollifier-mutation-race-design.md`). The
// caller decides how to translate the outcome into an HTTP response —
// this helper never throws Response objects so it remains route-agnostic
// and unit-testable in isolation.
export async function mutateWithFallback<TResponse>(
  input: MutateWithFallbackInput<TResponse>,
): Promise<MutateWithFallbackOutcome<TResponse>> {
  const replica = input.prismaReplica ?? $replica;
  const writer = input.prismaWriter ?? prisma;
  const buffer = (input.getBuffer ?? getMollifierBuffer)();
  const sleep = input.sleep ?? defaultSleep;
  const now = input.now ?? Date.now;

  // Path 1 — PG is already canonical.
  const replicaRow = await findRunInPg(replica, input.runId, input.environmentId);
  if (replicaRow) {
    const response = await input.pgMutation(replicaRow);
    return { kind: "pg", response };
  }

  if (!buffer) {
    // No buffer configured (mollifier disabled or boot-time error). PG
    // missed; nothing else to consult.
    return { kind: "not_found" };
  }

  // Path 2 — buffer snapshot mutation.
  const result: MutateSnapshotResult = await buffer.mutateSnapshot(
    input.runId,
    input.bufferPatch,
  );

  if (result === "applied_to_snapshot") {
    return { kind: "snapshot", response: await input.synthesisedResponse() };
  }

  if (result === "not_found") {
    // Disambiguate a genuine 404 from a replica-lag miss: ask the writer
    // directly. If the row just appeared post-drain we route through the
    // PG mutation path.
    const writerRow = await findRunInPg(writer, input.runId, input.environmentId);
    if (writerRow) {
      const response = await input.pgMutation(writerRow);
      return { kind: "pg", response };
    }
    return { kind: "not_found" };
  }

  // result === "busy" — entry is DRAINING / FAILED / materialised. Wait
  // for the drainer to terminate the entry into PG (success or
  // SYSTEM_FAILURE) and route through pgMutation.
  const safetyNetMs = input.safetyNetMs ?? DEFAULT_SAFETY_NET_MS;
  const pollStepMs = input.pollStepMs ?? DEFAULT_POLL_STEP_MS;
  const pgTimeoutMs = input.pgTimeoutMs ?? DEFAULT_PG_TIMEOUT_MS;
  const deadline = now() + safetyNetMs;

  while (now() < deadline) {
    if (input.abortSignal?.aborted) {
      return { kind: "timed_out" };
    }

    const row = await findRunInPgWithTimeout(
      writer,
      input.runId,
      input.environmentId,
      pgTimeoutMs,
    );
    if (row) {
      const response = await input.pgMutation(row);
      return { kind: "pg", response };
    }

    if (now() >= deadline) break;
    await sleep(pollStepMs);
  }

  logger.warn("mollifier mutate-with-fallback: drainer resolution timed out", {
    runId: input.runId,
    safetyNetMs,
  });
  return { kind: "timed_out" };
}

// Structural reader interface — accepts both the writer (`prisma`) and the
// replica (`$replica`), which differ slightly in their generated Prisma
// types but share the findFirst surface used here.
type TaskRunReader = {
  taskRun: {
    findFirst(args: {
      where: { friendlyId: string; runtimeEnvironmentId: string };
    }): Promise<TaskRun | null>;
  };
};

async function findRunInPg(
  client: TaskRunReader,
  friendlyId: string,
  environmentId: string,
): Promise<TaskRun | null> {
  return client.taskRun.findFirst({
    where: { friendlyId, runtimeEnvironmentId: environmentId },
  });
}

async function findRunInPgWithTimeout(
  client: TaskRunReader,
  friendlyId: string,
  environmentId: string,
  timeoutMs: number,
): Promise<TaskRun | null> {
  // One slow PG query shouldn't burn the whole safety-net budget.
  // Promise.race against a timer; on timeout we treat the poll as a miss
  // and the outer loop tries again on the next tick.
  const timeoutToken = Symbol("pg-timeout");
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<typeof timeoutToken>((resolve) => {
    timeoutHandle = setTimeout(() => resolve(timeoutToken), timeoutMs);
  });
  try {
    const winner = await Promise.race([
      findRunInPg(client, friendlyId, environmentId),
      timeoutPromise,
    ]);
    if (winner === timeoutToken) return null;
    return winner;
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
