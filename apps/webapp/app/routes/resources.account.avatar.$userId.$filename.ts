import { redirect, type LoaderFunctionArgs } from "@remix-run/node";
import { requireUser } from "~/services/session.server";
import {
  presignUserAvatarUrl,
  readUserAvatarBytes,
  resolveUserAvatarObjectPath,
} from "~/services/userAvatar.server";
import { avatarContentTypeForFilename } from "~/utils/avatarLimits";

/** Content-hashed filename, so a hit never goes stale. */
const RAW_CACHE_CONTROL = "private, max-age=31536000, immutable";

/**
 * Presigned URLs expire, so the stored avatarUrl points here and we sign on each request.
 * `?raw` serves the bytes from this origin instead, so a canvas reading them stays untainted.
 */
export async function loader({ request, params }: LoaderFunctionArgs) {
  await requireUser(request);

  const { userId, filename } = params;
  const objectPath = userId && filename ? resolveUserAvatarObjectPath(userId, filename) : undefined;

  if (!objectPath || !filename) {
    throw new Response("Not found", { status: 404 });
  }

  if (!new URL(request.url).searchParams.has("raw")) {
    return redirect(await presignUserAvatarUrl(objectPath));
  }

  const contentType = avatarContentTypeForFilename(filename);
  const bytes = contentType ? await readUserAvatarBytes(objectPath) : undefined;

  if (!bytes || !contentType) {
    throw new Response("Not found", { status: 404 });
  }

  // Byte bodies are valid BodyInit at runtime; the ambient fetch types don't say so.
  return new Response(bytes as unknown as BodyInit, {
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(bytes.byteLength),
      "Cache-Control": RAW_CACHE_CONTROL,
      // User-supplied bytes on our own origin, which CSP 'self' trusts.
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": "inline",
    },
  });
}
