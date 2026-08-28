import { json } from "@remix-run/node";
import { updateUserAvatarUrl } from "~/models/user.server";
import { getImpersonationState } from "~/services/impersonation.server";
import { dashboardAction } from "~/services/routeBuilders/dashboardBuilder";
import {
  deleteStaleUserAvatar,
  isAvatarUploadRejection,
  isAvatarUploadsEnabled,
  parseAvatarUpload,
  uploadUserAvatar,
} from "~/services/userAvatar.server";

/**
 * No authorization block: every catalogue resource is org- or project-scoped, and this
 * mutation is scoped to the session's own user.
 */
export const action = dashboardAction({}, async ({ request, user }) => {
  const method = request.method.toUpperCase();

  if (method !== "POST" && method !== "DELETE") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  // An install with no avatar store hides this UI entirely; a stray request still answers.
  if (!isAvatarUploadsEnabled()) {
    return json({ error: "Profile pictures are not available on this instance." }, { status: 400 });
  }

  // Read from the cookie: the builder's session user reports isImpersonating false.
  const { isImpersonating } = await getImpersonationState(request, user.id);

  if (isImpersonating) {
    return json(
      { error: "You can't change this while impersonating another user." },
      { status: 403 }
    );
  }

  if (method === "DELETE") {
    await updateUserAvatarUrl({ id: user.id, avatarUrl: null });

    await deleteStaleUserAvatar({ previousAvatarUrl: user.avatarUrl, userId: user.id });

    return json({ avatarUrl: null });
  }

  const upload = await parseAvatarUpload(await request.formData());

  if (isAvatarUploadRejection(upload)) {
    return json({ error: upload.error }, { status: upload.status });
  }

  const previousAvatarUrl = user.avatarUrl;

  const { avatarUrl, filename } = await uploadUserAvatar({ userId: user.id, ...upload });

  await updateUserAvatarUrl({ id: user.id, avatarUrl });

  await deleteStaleUserAvatar({ previousAvatarUrl, userId: user.id, filename });

  return json({ avatarUrl });
});
