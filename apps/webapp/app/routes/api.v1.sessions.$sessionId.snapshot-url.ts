import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { $replica } from "~/db.server";
import { chatSnapshotStoragePathForSession } from "~/services/realtime/chatSnapshot.server";
import { resolveSessionByIdOrExternalId } from "~/services/realtime/sessions.server";
import {
  createActionApiRoute,
  createLoaderApiRoute,
} from "~/services/routeBuilders/apiBuilder.server";
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

const routeConfig = {
  params: ParamsSchema,
  allowJWT: true,
  corsStrategy: "all" as const,
  findResource: async (params: z.infer<typeof ParamsSchema>, auth: { environment: { id: string } }) =>
    resolveSessionByIdOrExternalId($replica, auth.environment.id, params.sessionId),
};

export const { action } = createActionApiRoute(
  { ...routeConfig, method: "PUT" },
  async ({ authentication, resource: session }) => {
    if (!session) {
      return json({ error: "Session not found" }, { status: 404 });
    }

    const signed = await generatePresignedUrl(
      authentication.environment.project.externalRef,
      authentication.environment.slug,
      snapshotKey(session),
      "PUT"
    );
    if (!signed.success) {
      return json({ error: `Failed to generate presigned URL: ${signed.error}` }, { status: 500 });
    }

    return json({ presignedUrl: signed.url });
  }
);

export const loader = createLoaderApiRoute(routeConfig, async ({ authentication, resource: session }) => {
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
});
