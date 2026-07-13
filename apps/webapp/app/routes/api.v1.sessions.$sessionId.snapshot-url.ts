import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { $replica } from "~/db.server";
import { chatSnapshotStorageKey } from "~/services/realtime/chatSnapshot.server";
import { resolveSessionByIdOrExternalId } from "~/services/realtime/sessions.server";
import {
  anyResource,
  createActionApiRoute,
  createLoaderApiRoute,
} from "~/services/routeBuilders/apiBuilder.server";
import { generatePresignedUrl } from "~/v3/objectStore.server";

const ParamsSchema = z.object({
  sessionId: z.string(),
});

const routeConfig = {
  params: ParamsSchema,
  allowJWT: true,
  corsStrategy: "all" as const,
  findResource: async (
    params: z.infer<typeof ParamsSchema>,
    auth: { environment: { id: string } }
  ) => resolveSessionByIdOrExternalId($replica, auth.environment.id, params.sessionId),
};

// Authorize against the union of the URL form, friendlyId, and externalId —
// same shape as the sibling session routes. Without an authorization block
// the route builder skips scope checks entirely, so any session-scoped JWT
// in the environment could presign URLs for any other session's snapshot.
function sessionResource(
  paramId: string,
  session: { friendlyId: string; externalId: string | null } | null | undefined
) {
  const ids = new Set<string>([paramId]);
  if (session) {
    ids.add(session.friendlyId);
    if (session.externalId) ids.add(session.externalId);
  }
  return anyResource([...ids].map((id) => ({ type: "sessions" as const, id })));
}

export const { action } = createActionApiRoute(
  {
    ...routeConfig,
    method: "PUT",
    authorization: {
      action: "write",
      resource: (params, _, __, ___, session) => sessionResource(params.sessionId, session),
    },
  },
  async ({ authentication, resource: session }) => {
    if (!session) {
      return json({ error: "Session not found" }, { status: 404 });
    }

    const signed = await generatePresignedUrl(
      authentication.environment.project.externalRef,
      authentication.environment.slug,
      chatSnapshotStorageKey(session),
      "PUT"
    );
    if (!signed.success) {
      return json({ error: `Failed to generate presigned URL: ${signed.error}` }, { status: 500 });
    }

    return json({ presignedUrl: signed.url });
  }
);

export const loader = createLoaderApiRoute(
  {
    ...routeConfig,
    authorization: {
      action: "read",
      resource: (session, params) => sessionResource(params.sessionId, session),
    },
  },
  async ({ authentication, resource: session }) => {
    if (!session) {
      return json({ error: "Session not found" }, { status: 404 });
    }

    const signed = await generatePresignedUrl(
      authentication.environment.project.externalRef,
      authentication.environment.slug,
      chatSnapshotStorageKey(session),
      "GET"
    );
    if (!signed.success) {
      return json({ error: `Failed to generate presigned URL: ${signed.error}` }, { status: 500 });
    }

    return json({ presignedUrl: signed.url });
  }
);
