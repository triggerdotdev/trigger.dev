import { json } from "@remix-run/server-runtime";
import { CloseSessionRequestBody, type RetrieveSessionResponseBody } from "@trigger.dev/core/v3";
import { z } from "zod";
import { $replica } from "~/db.server";
import {
  resolveSessionByIdOrExternalId,
  serializeSessionWithFriendlyRunId,
} from "~/services/realtime/sessions.server";
import { closeSession } from "~/services/realtime/sessionWrites.server";
import { createActionApiRoute } from "~/services/routeBuilders/apiBuilder.server";

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

    const { session } = await closeSession({
      session: existing,
      environment: authentication.environment,
      paramSession: params.session,
      callingRunId: body.callingRunId,
      reason: body.reason,
    });
    if (!session) return json({ error: "Session not found" }, { status: 404 });
    return json<RetrieveSessionResponseBody>(await serializeSessionWithFriendlyRunId(session));
  }
);

export { action, loader };
