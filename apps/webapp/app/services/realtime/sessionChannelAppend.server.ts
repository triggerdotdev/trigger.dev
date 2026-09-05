import { tryCatch } from "@trigger.dev/core/utils";
import { nanoid } from "nanoid";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { S2RealtimeStreams } from "~/services/realtime/s2realtimeStreams.server";
import { getRealtimeStreamInstance } from "~/services/realtime/v1StreamsGlobal.server";
import { drainSessionStreamWaitpoints } from "~/services/sessionStreamWaitpointCache.server";
import { engine } from "~/v3/runEngine.server";

type SessionChannelIO = "out" | "in";

/**
 * Fire any run-scoped waitpoints registered against a session channel, so a
 * suspended run wakes on the record that just landed. Best effort: a failure
 * here must not fail the append, because the record is durable in S2 and the
 * SSE tail still delivers it. Waitpoints are keyed on the canonical addressing
 * key the agent registered with via `sessions.open(...).in.wait()`, so writers
 * and readers converge regardless of which URL form they used.
 */
export async function completeSessionStreamWaitpoints(
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
