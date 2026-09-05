import { json } from "@remix-run/server-runtime";
import { tryCatch } from "@trigger.dev/core/utils";
import { CloseSessionRequestBody, type RetrieveSessionResponseBody } from "@trigger.dev/core/v3";
import type { Session } from "@trigger.dev/database";
import { z } from "zod";
import { $replica, prisma } from "~/db.server";
import { logger } from "~/services/logger.server";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { appendServerSessionRecord } from "~/services/realtime/sessionChannelAppend.server";
import {
  canonicalSessionAddressingKey,
  resolveSessionByIdOrExternalId,
  serializeSessionWithFriendlyRunId,
} from "~/services/realtime/sessions.server";
import { createActionApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { runStore } from "~/v3/runStore.server";

const ParamsSchema = z.object({
  session: z.string(),
});

const { action, loader } = createActionApiRoute(
  {
    params: ParamsSchema,
    body: CloseSessionRequestBody,
    maxContentLength: 1024,
    method: "POST",
    allowJWT: true,
    corsStrategy: "all",
    authorization: {
      action: "admin",
      resource: (params) => ({ type: "sessions", id: params.session }),
    },
  },
  async ({ authentication, params, body }) => {
    const existing = await resolveSessionByIdOrExternalId(
      $replica,
      authentication.environment.id,
      params.session
    );

    if (!existing) {
      return json({ error: "Session not found" }, { status: 404 });
    }

    // Idempotent: if already closed, return the current row without clobbering
    // the original closedAt / closedReason.
    if (existing.closedAt) {
      return json<RetrieveSessionResponseBody>(await serializeSessionWithFriendlyRunId(existing));
    }

    // `closedAt: null` on the where clause makes the update conditional at
    // the DB level. Two concurrent closes race through the earlier read,
    // but only one can win this update — the loser hits `count === 0` and
    // falls back to reading the winning row. Closedness is write-once.
    const { count } = await prisma.session.updateMany({
      where: { id: existing.id, closedAt: null },
      data: {
        closedAt: new Date(),
        closedReason: body.reason ?? null,
      },
    });

    if (count === 0) {
      const final = await prisma.session.findFirst({ where: { id: existing.id } });
      if (!final) return json({ error: "Session not found" }, { status: 404 });
      return json<RetrieveSessionResponseBody>(await serializeSessionWithFriendlyRunId(final));
    }

    const updated = await prisma.session.findFirst({ where: { id: existing.id } });
    if (!updated) return json({ error: "Session not found" }, { status: 404 });

    // Best effort in full: the row is closed and that is what the caller asked
    // for. A failure resolving the calling run or building the stream client
    // must not turn a successful close into a 500.
    const [notifyError] = await tryCatch(
      notifyLiveRunOfClose({
        session: updated,
        environment: authentication.environment,
        paramSession: params.session,
        callingRunId: body.callingRunId,
        reason: body.reason,
      })
    );
    if (notifyError) {
      logger.error("Failed to notify the live run of a session close", {
        sessionId: updated.id,
        error: notifyError,
      });
    }

    return json<RetrieveSessionResponseBody>(await serializeSessionWithFriendlyRunId(updated));
  }
);

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
}): Promise<void> {
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

  await appendServerSessionRecord({
    environment,
    session,
    addressingKey: canonicalSessionAddressingKey(session, paramSession),
    io: "in",
    part: record,
  });
}

export { action, loader };
