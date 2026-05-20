import type { ActionFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { $replica, prisma } from "~/db.server";
import { env } from "~/env.server";
import { authenticateApiRequest } from "~/services/apiAuth.server";
import { resolveSessionByIdOrExternalId } from "~/services/realtime/sessions.server";
import { createLoaderApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { generatePresignedUrl } from "~/v3/objectStore.server";

const ParamsSchema = z.object({
  sessionId: z.string(),
});

// Canonical key for new sessions, prefixed with the default protocol so
// PUT/GET resolve to the same store on multi-provider deployments.
function defaultSnapshotKey(sessionId: string): string {
  const path = `sessions/${sessionId}/snapshot.json`;
  const protocol = env.OBJECT_STORE_DEFAULT_PROTOCOL;
  return protocol ? `${protocol}://${path}` : path;
}

export async function action({ request, params }: ActionFunctionArgs) {
  if (request.method.toUpperCase() !== "PUT") {
    return { status: 405, body: "Method Not Allowed" };
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

  // Reuse the stored path on subsequent writes; persist on first write so
  // future default-protocol changes don't strand existing snapshots.
  const key = session.chatSnapshotStoragePath ?? defaultSnapshotKey(parsed.sessionId);

  const signed = await generatePresignedUrl(
    auth.environment.project.externalRef,
    auth.environment.slug,
    key,
    "PUT"
  );
  if (!signed.success) {
    return json({ error: `Failed to generate presigned URL: ${signed.error}` }, { status: 500 });
  }

  if (session.chatSnapshotStoragePath === null) {
    await prisma.session
      .updateMany({
        where: { id: session.id, chatSnapshotStoragePath: null },
        data: { chatSnapshotStoragePath: key },
      })
      .catch(() => {
        // Best-effort; concurrent writers may have already set it.
      });
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
  async ({ params, authentication, resource: session }) => {
    if (!session) {
      return json({ error: "Session not found" }, { status: 404 });
    }

    // Stored path wins; fall back to computed default for pre-column sessions.
    const key = session.chatSnapshotStoragePath ?? defaultSnapshotKey(params.sessionId);

    const signed = await generatePresignedUrl(
      authentication.environment.project.externalRef,
      authentication.environment.slug,
      key,
      "GET"
    );
    if (!signed.success) {
      return json({ error: `Failed to generate presigned URL: ${signed.error}` }, { status: 500 });
    }

    return json({ presignedUrl: signed.url });
  }
);
