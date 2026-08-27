import { json, type ActionFunctionArgs } from "@remix-run/node";
import { updateUserAvatarUrl } from "~/models/user.server";
import { requireUser } from "~/services/session.server";
import {
  isAvatarUploadRejection,
  parseAvatarUpload,
  uploadUserAvatar,
} from "~/services/userAvatar.server";

export async function action({ request }: ActionFunctionArgs) {
  if (request.method.toUpperCase() !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  const user = await requireUser(request);

  const upload = await parseAvatarUpload(await request.formData());

  if (isAvatarUploadRejection(upload)) {
    return json({ error: upload.error }, { status: upload.status });
  }

  const { avatarUrl } = await uploadUserAvatar({ userId: user.id, ...upload });

  await updateUserAvatarUrl({ id: user.id, avatarUrl });

  return json({ avatarUrl });
}
