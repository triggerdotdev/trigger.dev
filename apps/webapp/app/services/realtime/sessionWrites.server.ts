import { tryCatch } from "@trigger.dev/core/utils";
import type { UpdateSessionRequestBody } from "@trigger.dev/core/v3";
import { Prisma, type Session } from "@trigger.dev/database";
import { $replica, prisma } from "~/db.server";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { appendServerSessionRecord } from "~/services/realtime/sessionChannelAppend.server";
import { canonicalSessionAddressingKey } from "~/services/realtime/sessions.server";
import { runStore } from "~/v3/runStore.server";

/** The row changes a session update asks for; fields left undefined are kept. */
export function sessionUpdateData(body: UpdateSessionRequestBody) {
  return {
    ...(body.tags !== undefined ? { tags: body.tags } : {}),
    ...(body.metadata !== undefined
      ? {
          metadata:
            body.metadata === null ? Prisma.JsonNull : (body.metadata as Prisma.InputJsonValue),
        }
      : {}),
    ...(body.externalId !== undefined ? { externalId: body.externalId } : {}),
  };
}

/**
 * Closes the session once and tells its live run. `closed` is false when the
 * conditional update lost: the session was already closed or, with `revision`,
 * changed since that revision. `session` is the row afterwards, if it exists. `notified` says
 * whether the live run got the close record; undefined when no run was told.
 */
export async function closeSession({
  session,
  environment,
  paramSession,
  reason,
  callingRunId,
  revision,
}: {
  session: Session;
  environment: AuthenticatedEnvironment;
  paramSession: string;
  reason?: string;
  callingRunId?: string;
  revision?: Date;
}): Promise<{ closed: boolean; session: Session | null; notified?: boolean }> {
  // `closedAt: null` on the where clause makes the update conditional at
  // the DB level. Two concurrent closes race through the earlier read,
  // but only one can win this update — the loser hits `count === 0` and
  // falls back to reading the winning row. Closedness is write-once.
  const { count } = await prisma.session.updateMany({
    where: { id: session.id, closedAt: null, ...(revision ? { updatedAt: revision } : {}) },
    data: {
      closedAt: new Date(),
      closedReason: reason ?? null,
    },
  });

  if (count === 0) {
    return {
      closed: false,
      session: await prisma.session.findFirst({ where: { id: session.id } }),
    };
  }

  const updated = await prisma.session.findFirst({ where: { id: session.id } });
  if (!updated) return { closed: true, session: null };

  // Best effort in full: the row is closed and that is what the caller asked
  // for. A failure resolving the calling run or building the stream client
  // must not turn a successful close into a 500.
  const [notifyError, notified] = await tryCatch(
    notifyLiveRunOfClose({
      session: updated,
      environment,
      paramSession,
      callingRunId,
      reason,
    })
  );
  if (notifyError) {
    logger.error("Failed to notify the live run of a session close", {
      sessionId: updated.id,
      error: notifyError,
    });
  }

  return { closed: true, session: updated, notified: notifyError ? false : notified };
}

/**
 * Put a `trigger: "close"` record on the session's `.in` channel so a live run
 * leaves its loop now instead of sitting until its idle timeout. Appending also
 * completes the run's `.in` waitpoint, which is what wakes a suspended run.
 *
 * Skipped when the close came from the session's own run (`chat.close()`), which
 * is already exiting and would never consume the record. Best effort throughout:
 * the row is closed either way, and further appends are refused.
 */
async function notifyLiveRunOfClose({
  session,
  environment,
  paramSession,
  callingRunId,
  reason,
}: {
  session: Session;
  environment: AuthenticatedEnvironment;
  paramSession: string;
  callingRunId?: string;
  reason?: string;
}): Promise<boolean | undefined> {
  if (!session.currentRunId) {
    return;
  }

  if (callingRunId) {
    const callingRun = await runStore.findRun(
      { friendlyId: callingRunId, runtimeEnvironmentId: environment.id },
      { select: { id: true } },
      $replica
    );
    if (callingRun?.id === session.currentRunId) {
      return;
    }
  }

  const record = JSON.stringify({
    kind: "message",
    payload: {
      chatId: session.externalId ?? session.friendlyId,
      trigger: "close",
      ...(reason ? { closedReason: reason } : {}),
    },
  });

  return appendServerSessionRecord({
    environment,
    session,
    addressingKey: canonicalSessionAddressingKey(session, paramSession),
    io: "in",
    part: record,
  });
}
