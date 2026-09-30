import { json } from "@remix-run/node";
import type { ActionFunctionArgs } from "@remix-run/node";
import { getImpersonationState } from "~/services/impersonation.server";
import { requireUserId } from "~/services/session.server";
import { recordNotificationClicked } from "~/services/platformNotifications.server";

export async function action({ request, params }: ActionFunctionArgs) {
  const userId = await requireUserId(request);

  // Staff browsing a customer's dashboard mustn't mark the customer's notifications.
  if ((await getImpersonationState(request, userId)).isImpersonating) {
    return json({ success: true });
  }
  const notificationId = params.id;

  if (!notificationId) {
    return json({ success: false }, { status: 400 });
  }

  const recorded = await recordNotificationClicked({ notificationId, userId });
  if (!recorded) {
    return json({ success: false }, { status: 404 });
  }

  return json({ success: true });
}
