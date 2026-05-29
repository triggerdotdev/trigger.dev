import { json } from "@remix-run/node";
import type { ActionFunctionArgs } from "@remix-run/node";
import { requireUserId } from "~/services/session.server";
import { dismissNotification } from "~/services/platformNotifications.server";

export async function action({ request, params }: ActionFunctionArgs) {
  const userId = await requireUserId(request);
  const notificationId = params.id;

  if (!notificationId) {
    return json({ success: false }, { status: 400 });
  }

  await dismissNotification({ notificationId, userId });

  return json({ success: true });
}
