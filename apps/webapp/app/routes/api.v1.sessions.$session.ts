import { json } from "@remix-run/server-runtime";
import { type RetrieveSessionResponseBody, UpdateSessionRequestBody } from "@trigger.dev/core/v3";
import { Prisma } from "@trigger.dev/database";
import { z } from "zod";
import { $replica, prisma } from "~/db.server";
import {
  SessionTriggerConfigSchema,
  sessionPinsInEffect,
} from "~/services/realtime/sessionRunManager.server";
import {
  resolveSessionByIdOrExternalId,
  serializeSessionWithFriendlyRunId,
} from "~/services/realtime/sessions.server";
import {
  anyResource,
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
      // Multi-key: a session is addressable by both friendlyId and (when
      // set) externalId. A JWT scoped to either id grants access; type-
      // level `read:sessions` (no id) matches both elements; `read:all`
      // / `admin` bypass via the JWT ability's wildcard branches.
      resource: (session) =>
        session.externalId
          ? anyResource([
              { type: "sessions", id: session.friendlyId },
              { type: "sessions", id: session.externalId },
            ])
          : { type: "sessions", id: session.friendlyId },
    },
  },
  async ({ resource: session, authentication }) => {
    const body = await serializeSessionWithFriendlyRunId(session);
    // A pin below the skew protection threshold is ignored when runs start, so it reads as unset:
    // an agent that follows the pin would otherwise ask for a deployment it is never given.
    const stored = SessionTriggerConfigSchema.safeParse(session.triggerConfig);
    if (stored.success) {
      const inEffect = await sessionPinsInEffect(
        stored.data,
        authentication.environment,
        session.taskIdentifier
      );
      if (inEffect !== stored.data && body.triggerConfig) {
        body.triggerConfig = {
          ...body.triggerConfig,
          lockToVersion: inEffect.lockToVersion,
          externalDeploymentId: inEffect.externalDeploymentId,
        };
      }
    }
    return json<RetrieveSessionResponseBody>(body);
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

    // The externalId is the canonical addressing key once set: the S2
    // stream names, the waitpoint cache key, and the minted session PAT
    // scope all derive from it. Re-keying a session would orphan its
    // streams (the chat goes silent) and invalidate the PAT's scope, so
    // reject any change. Same-value PATCHes stay idempotent.
    if (body.externalId !== undefined && body.externalId !== existing.externalId) {
      return json(
        {
          error:
            "externalId cannot be changed after creation; close this session and create a new one with the desired externalId",
        },
        { status: 422 }
      );
    }

    try {
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

      return json<RetrieveSessionResponseBody>(await serializeSessionWithFriendlyRunId(updated));
    } catch (error) {
      // A duplicate externalId in the same environment violates the
      // `(runtimeEnvironmentId, externalId)` unique constraint. Surface that
      // as a 409 rather than a generic 500.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002" &&
        Array.isArray((error.meta as { target?: string[] })?.target) &&
        ((error.meta as { target?: string[] }).target ?? []).includes("externalId")
      ) {
        return json(
          { error: "A session with this externalId already exists in this environment" },
          { status: 409 }
        );
      }
      throw error;
    }
  }
);

export { action };
