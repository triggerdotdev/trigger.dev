import type { Session } from "@trigger.dev/database";
import { tryCatch } from "@trigger.dev/core/utils";
import { nanoid } from "nanoid";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { S2RealtimeStreams } from "~/services/realtime/s2realtimeStreams.server";
import {
  ensureRunForSession,
  SessionClosedError,
  type EnsureRunReason,
  type EnsureRunResult,
} from "~/services/realtime/sessionRunManager.server";
import { getRealtimeStreamInstance } from "~/services/realtime/v1StreamsGlobal.server";
import {
  claimSessionStreamPart,
  drainSessionStreamWaitpoints,
  releaseSessionStreamPart,
} from "~/services/sessionStreamWaitpointCache.server";
import { engine } from "~/v3/runEngine.server";
import { ServiceValidationError } from "~/v3/services/common.server";

type SessionChannelIO = "out" | "in";

/**
 * Fire any run-scoped waitpoints registered against a session channel, so a
 * suspended run wakes on the record that just landed. Best effort: a failure
 * here must not fail the append, because the record is durable in S2 and the
 * SSE tail still delivers it. Waitpoints are keyed on the canonical addressing
 * key the agent registered with via `sessions.open(...).in.wait()`, so writers
 * and readers converge regardless of which URL form they used.
 */
async function completeSessionStreamWaitpoints(
  environmentId: string,
  addressingKey: string,
  io: SessionChannelIO,
  part: string
): Promise<void> {
  const [drainError, waitpointIds] = await tryCatch(
    drainSessionStreamWaitpoints(environmentId, addressingKey, io)
  );

  if (drainError) {
    logger.error("Failed to drain session stream waitpoints", {
      addressingKey,
      io,
      error: drainError,
    });
    return;
  }

  if (!waitpointIds || waitpointIds.length === 0) {
    return;
  }

  await Promise.all(
    waitpointIds.map(async (waitpointId) => {
      const [completeError] = await tryCatch(
        engine.completeWaitpoint({
          id: waitpointId,
          output: {
            value: part,
            type: "application/json",
            isError: false,
          },
        })
      );
      if (completeError) {
        logger.error("Failed to complete session stream waitpoint", {
          addressingKey,
          io,
          waitpointId,
          error: completeError,
        });
      }
    })
  );
}

/**
 * Append one server-originated record to a session channel and wake anything
 * waiting on it. Unlike the client-facing append route there is no idempotency
 * claim: the server is the only writer of these records and the caller has
 * already made its own state change conditional.
 *
 * Returns false when the environment isn't on the S2 backend (session channels
 * don't exist there) or the append failed. Callers treat that as best effort.
 */
export async function appendServerSessionRecord({
  environment,
  session,
  addressingKey,
  io,
  part,
}: {
  environment: AuthenticatedEnvironment;
  session: { id: string; streamBasinName: string | null };
  addressingKey: string;
  io: SessionChannelIO;
  part: string;
}): Promise<boolean> {
  const realtimeStream = getRealtimeStreamInstance(environment, "v2", { session });

  if (!(realtimeStream instanceof S2RealtimeStreams)) {
    return false;
  }

  const [appendError] = await tryCatch(
    realtimeStream.appendPartToSessionStream(part, nanoid(7), addressingKey, io)
  );

  if (appendError) {
    logger.error("Failed to append server session record", {
      sessionId: session.id,
      addressingKey,
      io,
      error: appendError,
    });
    return false;
  }

  await completeSessionStreamWaitpoints(environment.id, addressingKey, io, part);
  return true;
}

type EnsureOutcome =
  | { ok: true; result: EnsureRunResult }
  /** `sessionClosed`: the run claim lost to a close, so there is no run to ensure. */
  | { ok: false; error: unknown; sessionClosed: boolean };

export type EnsureRunThenAppendResult =
  /** `seq` is undefined when another append already claimed `partId`. */
  | { ok: true; seq: number | undefined; ensure: EnsureOutcome }
  | { ok: false; kind: "unsupported_backend" }
  | { ok: false; kind: "rejected"; status: number; message: string; ensure: EnsureOutcome }
  | { ok: false; kind: "failed"; error: unknown; ensure: EnsureOutcome };

/**
 * Ensure the session has a live run, then append one record and wake its waiters. Outcomes are
 * returned, not thrown, so each caller picks its own policy.
 *
 * Ensure goes first: a revived run reads the record from the channel (continuations never carry
 * it in the payload), and a rejected append doesn't skip the ensure. A `partId` is claimed before
 * appending, so a retry appends nothing but still wakes waiters; a failed append releases it.
 */
export async function ensureRunThenAppend({
  session,
  environment,
  addressingKey,
  io,
  part,
  partId,
  reason,
}: {
  session: Pick<
    Session,
    | "id"
    | "friendlyId"
    | "taskIdentifier"
    | "triggerConfig"
    | "currentRunId"
    | "currentRunVersion"
    | "streamBasinName"
  >;
  environment: AuthenticatedEnvironment;
  addressingKey: string;
  io: SessionChannelIO;
  part: string;
  partId?: string;
  reason: EnsureRunReason;
}): Promise<EnsureRunThenAppendResult> {
  const realtimeStream = getRealtimeStreamInstance(environment, "v2", { session });

  if (!(realtimeStream instanceof S2RealtimeStreams)) {
    return { ok: false, kind: "unsupported_backend" };
  }

  const ensure = await ensureRun({ session, environment, reason });

  const wonClaim = partId
    ? await claimSessionStreamPart(environment.id, addressingKey, io, partId)
    : true;

  let seq: number | undefined;
  if (wonClaim) {
    const [appendError, appendedSeq] = await tryCatch(
      realtimeStream.appendPartToSessionStream(part, partId ?? nanoid(7), addressingKey, io)
    );

    if (appendError) {
      if (partId) {
        await releaseSessionStreamPart(environment.id, addressingKey, io, partId);
      }
      if (appendError instanceof ServiceValidationError) {
        return {
          ok: false,
          kind: "rejected",
          status: appendError.status ?? 422,
          message: appendError.message,
          ensure,
        };
      }
      return { ok: false, kind: "failed", error: appendError, ensure };
    }

    seq = appendedSeq ?? undefined;
  }

  await completeSessionStreamWaitpoints(environment.id, addressingKey, io, part);
  return { ok: true, seq, ensure };
}

async function ensureRun(
  params: Parameters<typeof ensureRunForSession>[0]
): Promise<EnsureOutcome> {
  const [error, result] = await tryCatch(ensureRunForSession(params));
  if (error) {
    return { ok: false, error, sessionClosed: error instanceof SessionClosedError };
  }
  return { ok: true, result };
}
