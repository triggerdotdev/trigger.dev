import { json } from "@remix-run/server-runtime";
import {
  type RetrieveSessionResponseBody,
  UpdateSessionRequestBody,
} from "@trigger.dev/core/v3";
import { Prisma } from "@trigger.dev/database";
import { z } from "zod";
import { $replica, prisma } from "~/db.server";
import {
  resolveSessionByIdOrExternalId,
  serializeSession,
} from "~/services/realtime/sessions.server";
import {
  createActionApiRoute,
  createLoaderApiRoute,
} from "~/services/routeBuilders/apiBuilder.server";

const ParamsSchema = z.object({
  session: z.string(),
});

export const loader = createLoaderApiRoute(
  {
    params: ParamsSchema,
    allowJWT: true,
    corsStrategy: "all",
    findResource: async (params, auth) => {
      return resolveSessionByIdOrExternalId($replica, auth.environment.id, params.session);
    },
    authorization: {
      action: "read",
      resource: (session) => ({ sessions: [session.friendlyId, session.externalId ?? ""] }),
      superScopes: ["read:sessions", "read:all", "admin"],
    },
  },
  async ({ resource: session }) => {
    return json<RetrieveSessionResponseBody>(serializeSession(session));
  }
);

const { action } = createActionApiRoute(
  {
    params: ParamsSchema,
    body: UpdateSessionRequestBody,
    maxContentLength: 1024 * 32,
    method: "PATCH",
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

    const updated = await prisma.session.update({
      where: { id: existing.id },
      data: {
        ...(body.tags !== undefined ? { tags: body.tags } : {}),
        ...(body.metadata !== undefined
          ? {
              metadata:
                body.metadata === null
                  ? Prisma.JsonNull
                  : (body.metadata as Prisma.InputJsonValue),
            }
          : {}),
        ...(body.externalId !== undefined ? { externalId: body.externalId } : {}),
      },
    });

    return json<RetrieveSessionResponseBody>(serializeSession(updated));
  }
);

export { action };
