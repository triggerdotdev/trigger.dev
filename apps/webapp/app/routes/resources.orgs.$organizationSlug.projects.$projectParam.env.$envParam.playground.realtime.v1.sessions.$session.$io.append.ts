import { json, type ActionFunctionArgs } from "@remix-run/server-runtime";
import { tryCatch } from "@trigger.dev/core/utils";
import { nanoid } from "nanoid";
import { z } from "zod";
import { $replica } from "~/db.server";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { logger } from "~/services/logger.server";
import { S2RealtimeStreams } from "~/services/realtime/s2realtimeStreams.server";
import { ensureRunForSession } from "~/services/realtime/sessionRunManager.server";
import {
  canonicalSessionAddressingKey,
  resolveSessionByIdOrExternalId,
} from "~/services/realtime/sessions.server";
import { getRealtimeStreamInstance } from "~/services/realtime/v1StreamsGlobal.server";
import { drainSessionStreamWaitpoints } from "~/services/sessionStreamWaitpointCache.server";
import { requireUserId } from "~/services/session.server";
import { EnvironmentParamSchema } from "~/utils/pathBuilder";
import { engine } from "~/v3/runEngine.server";
import { ServiceValidationError } from "~/v3/services/common.server";

const ParamsSchema = z.object({
  session: z.string(),
  io: z.enum(["out", "in"]),
});

// S2 record body cap. Mirrors the public /realtime/v1/sessions/:s/:io/append
// route — keep it well under S2's 1 MiB per-record limit so JSON wrapping,
// string escaping, and any future per-record headers stay safe.
const MAX_APPEND_BODY_BYTES = 1024 * 512;

// POST: Append a single record to a Session channel from the dashboard
// playground. Mirrors the public `POST /realtime/v1/sessions/:session/:io/append`
// but authenticates via the dashboard session cookie instead of a
// session-scoped JWT.
export async function action({ request, params }: ActionFunctionArgs) {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);
  const { session: sessionParam, io } = ParamsSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) {
    return json({ ok: false, error: "Project not found" }, { status: 404 });
  }

  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) {
    return json({ ok: false, error: "Environment not found" }, { status: 404 });
  }

  const contentLength = request.headers.get("content-length");
  const contentLengthNum = contentLength ? parseInt(contentLength, 10) : NaN;
  if (Number.isNaN(contentLengthNum) || contentLengthNum > MAX_APPEND_BODY_BYTES) {
    return json({ ok: false, error: "Request body too large" }, { status: 413 });
  }

  const session = await resolveSessionByIdOrExternalId(
    $replica,
    environment.id,
    sessionParam
  );
  if (!session) {
    return json({ ok: false, error: "Session not found" }, { status: 404 });
  }

  if (session.closedAt) {
    return json(
      { ok: false, error: "Cannot append to a closed session" },
      { status: 400 }
    );
  }

  if (session.expiresAt && session.expiresAt.getTime() < Date.now()) {
    return json(
      { ok: false, error: "Cannot append to an expired session" },
      { status: 400 }
    );
  }

  const realtimeStream = getRealtimeStreamInstance(environment, "v2", { session });

  if (!(realtimeStream instanceof S2RealtimeStreams)) {
    return json(
      { ok: false, error: "Session channels require the S2 realtime backend" },
      { status: 501 }
    );
  }

  // Probe + ensure a live run before appending (mirrors public route).
  // Best-effort: failure here doesn't block the append — the record is
  // durable; the next append retries the ensure.
  const [ensureError] = await tryCatch(
    ensureRunForSession({
      session,
      environment,
      reason: "continuation",
    })
  );
  if (ensureError) {
    logger.error("Failed to ensureRunForSession on playground .in/append", {
      sessionId: session.id,
      externalId: session.externalId,
      error: ensureError,
    });
  }

  const addressingKey = canonicalSessionAddressingKey(session, sessionParam);

  const part = await request.text();
  const partId = request.headers.get("X-Part-Id") ?? nanoid(7);

  const [appendError] = await tryCatch(
    realtimeStream.appendPartToSessionStream(part, partId, addressingKey, io)
  );

  if (appendError) {
    if (appendError instanceof ServiceValidationError) {
      return json(
        { ok: false, error: appendError.message },
        { status: appendError.status ?? 422 }
      );
    }
    return json({ ok: false, error: appendError.message }, { status: 500 });
  }

  // Drain any waitpoints registered for this channel — same as the
  // public append. Best-effort; failure doesn't fail the append.
  const [drainError, waitpointIds] = await tryCatch(
    drainSessionStreamWaitpoints(addressingKey, io)
  );
  if (drainError) {
    logger.error("Failed to drain session stream waitpoints (playground)", {
      addressingKey,
      io,
      error: drainError,
    });
  } else if (waitpointIds && waitpointIds.length > 0) {
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
          logger.error("Failed to complete session stream waitpoint (playground)", {
            addressingKey,
            io,
            waitpointId,
            error: completeError,
          });
        }
      })
    );
  }

  return json({ ok: true }, { status: 200 });
}
