import { redirect, type LoaderFunctionArgs } from "@remix-run/node";
import { requireUser } from "~/services/session.server";
import { presignUserAvatarUrl, resolveUserAvatarObjectPath } from "~/services/userAvatar.server";

/**
 * Presigned URLs expire, so the stored avatarUrl points here and we sign on each request.
 */
export async function loader({ request, params }: LoaderFunctionArgs) {
  await requireUser(request);

  const { userId, filename } = params;
  const objectPath = userId && filename ? resolveUserAvatarObjectPath(userId, filename) : undefined;

  if (!objectPath) {
    throw new Response("Not found", { status: 404 });
  }

  return redirect(await presignUserAvatarUrl(objectPath));
}
