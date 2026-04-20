import { json } from "@remix-run/server-runtime";
import {
  CloseSessionRequestBody,
  type RetrieveSessionResponseBody,
} from "@trigger.dev/core/v3";
import { z } from "zod";
import { prisma } from "~/db.server";
import {
  resolveSessionByIdOrExternalId,
  serializeSession,
} from "~/services/realtime/sessions.server";
import { createActionApiRoute } from "~/services/routeBuilders/apiBuilder.server";

const ParamsSchema = z.object({
  session: z.string(),
});

const { action } = createActionApiRoute(
  {
    params: ParamsSchema,
    body: CloseSessionRequestBody,
    maxContentLength: 1024,
    method: "POST",
    allowJWT: true,
    corsStrategy: "all",
    authorization: {
      action: "admin",
      resource: (params) => ({ sessions: params.session }),
      superScopes: ["admin:sessions", "admin:all", "admin"],
    },
  },
  async ({ authentication, params, body }) => {
    const existing = await resolveSessionByIdOrExternalId(
      prisma,
      authentication.environment.id,
      params.session
    );

    if (!existing) {
      return json({ error: "Session not found" }, { status: 404 });
    }

    // Idempotent: if already closed, return the current row without clobbering
    // the original closedAt / closedReason.
    if (existing.closedAt) {
      return json<RetrieveSessionResponseBody>(serializeSession(existing));
    }

    const updated = await prisma.session.update({
      where: { id: existing.id },
      data: {
        closedAt: new Date(),
        closedReason: body.reason ?? null,
      },
    });

    return json<RetrieveSessionResponseBody>(serializeSession(updated));
  }
);

export { action };
