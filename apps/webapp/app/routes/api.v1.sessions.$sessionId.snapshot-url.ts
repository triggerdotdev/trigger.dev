import type { ActionFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { $replica } from "~/db.server";
import { authenticateApiRequest } from "~/services/apiAuth.server";
import {
  chatSnapshotStoragePathForSession,
  resolveSessionByIdOrExternalId,
} from "~/services/realtime/sessions.server";
import { createLoaderApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { generatePresignedUrl } from "~/v3/objectStore.server";

const ParamsSchema = z.object({
  sessionId: z.string(),
});

// `chatSnapshotStoragePath` is stamped on every new Session at row creation
// (see api.v1.sessions.ts). The fallback handles sessions created before
// the column existed — read against the currently-configured default
// protocol and compute the same path the SDK uploaded under.
function snapshotKey(session: { friendlyId: string; chatSnapshotStoragePath: string | null }) {
  return session.chatSnapshotStoragePath ?? chatSnapshotStoragePathForSession(session.friendlyId);
}

export async function action({ request, params }: ActionFunctionArgs) {
  if (request.method.toUpperCase() !== "PUT") {
    return json({ error: "Method Not Allowed" }, { status: 405 });
  }

  const auth = await authenticateApiRequest(request);
  if (!auth) {
    return json({ error: "Invalid or Missing API key" }, { status: 401 });
  }

  const parsed = ParamsSchema.parse(params);
  const session = await resolveSessionByIdOrExternalId(
    $replica,
    auth.environment.id,
    parsed.sessionId
  );
  if (!session) {
    return json({ error: "Session not found" }, { status: 404 });
  }

  const signed = await generatePresignedUrl(
    auth.environment.project.externalRef,
    auth.environment.slug,
    snapshotKey(session),
    "PUT"
  );
  if (!signed.success) {
    return json({ error: `Failed to generate presigned URL: ${signed.error}` }, { status: 500 });
  }

  return json({ presignedUrl: signed.url });
}

export const loader = createLoaderApiRoute(
  {
    params: ParamsSchema,
    allowJWT: true,
    corsStrategy: "all",
    findResource: async (params, auth) =>
      resolveSessionByIdOrExternalId($replica, auth.environment.id, params.sessionId),
  },
  async ({ authentication, resource: session }) => {
    if (!session) {
      return json({ error: "Session not found" }, { status: 404 });
    }

    const signed = await generatePresignedUrl(
      authentication.environment.project.externalRef,
      authentication.environment.slug,
      snapshotKey(session),
      "GET"
    );
    if (!signed.success) {
      return json({ error: `Failed to generate presigned URL: ${signed.error}` }, { status: 500 });
    }

    return json({ presignedUrl: signed.url });
  }
);
