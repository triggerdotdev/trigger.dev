import { json, type ActionFunctionArgs } from "@remix-run/node";
import { updateChatOpenModePreference } from "~/services/dashboardPreferences.server";
import { requireUser } from "~/services/session.server";
import { ChatOpenMode } from "~/utils/dashboardPreferences";

export async function action({ request }: ActionFunctionArgs) {
  const user = await requireUser(request);

  if (user.isImpersonating) {
    return json({ success: false, error: "Not available" }, { status: 403 });
  }

  const formData = await request.formData();
  // Strict, not normalized: an unknown value must fail rather than reset.
  const chatOpenMode = ChatOpenMode.safeParse(formData.get("chatOpenMode"));
  if (!chatOpenMode.success) {
    return json({ success: false, error: "Invalid mode" }, { status: 400 });
  }

  await updateChatOpenModePreference({ user, chatOpenMode: chatOpenMode.data });

  return json({ success: true });
}
