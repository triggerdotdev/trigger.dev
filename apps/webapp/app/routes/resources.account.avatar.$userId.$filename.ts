import { redirect } from "@remix-run/node";
import { z } from "zod";
import { dashboardLoader } from "~/services/routeBuilders/dashboardBuilder";
import {
  presignUserAvatarUrl,
  readUserAvatarBytes,
  resolveUserAvatarObjectPath,
} from "~/services/userAvatar.server";
import { avatarContentTypeForFilename } from "~/utils/avatarLimits";

/** Content-hashed filename, so a hit never goes stale. */
const RAW_CACHE_CONTROL = "private, max-age=31536000, immutable";

/** Both segments stay plain strings: an unusable value 404s below, it is not a params error. */
const ParamsSchema = z.object({
  userId: z.string(),
  filename: z.string(),
});

/**
 * Presigned URLs expire, so the stored avatarUrl points here and we sign on each request.
 * `?raw` serves the bytes from this origin instead, so a canvas reading them stays untainted.
 */
export const loader = dashboardLoader(
  { params: ParamsSchema },
  async ({ params: { userId, filename }, request }) => {
    const objectPath = resolveUserAvatarObjectPath(userId, filename);

    if (!objectPath) {
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
);
