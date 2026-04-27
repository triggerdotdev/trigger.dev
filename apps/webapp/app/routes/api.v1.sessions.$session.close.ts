import { json } from "@remix-run/server-runtime";
import {
  CloseSessionRequestBody,
  type RetrieveSessionResponseBody,
} from "@trigger.dev/core/v3";
import { z } from "zod";
import { $replica, prisma } from "~/db.server";
import {
  resolveSessionByIdOrExternalId,
  serializeSession,
} from "~/services/realtime/sessions.server";
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
      resource: (params) => ({ sessions: params.session }),
      superScopes: ["admin:sessions", "admin:all", "admin"],
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
      return json<RetrieveSessionResponseBody>(serializeSession(existing));
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
      return json<RetrieveSessionResponseBody>(serializeSession(final));
    }

    const updated = await prisma.session.findFirst({ where: { id: existing.id } });
    if (!updated) return json({ error: "Session not found" }, { status: 404 });
    return json<RetrieveSessionResponseBody>(serializeSession(updated));
  }
);

export { action, loader };
