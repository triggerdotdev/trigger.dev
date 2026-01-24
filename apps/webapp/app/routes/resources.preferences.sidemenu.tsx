import { json, type ActionFunctionArgs } from "@remix-run/node";
import { z } from "zod";
import { updateSideMenuPreferences } from "~/services/dashboardPreferences.server";
import { requireUser } from "~/services/session.server";

const RequestSchema = z.object({
  isCollapsed: z.boolean().optional(),
  manageSectionCollapsed: z.boolean().optional(),
});

export async function action({ request }: ActionFunctionArgs) {
  const user = await requireUser(request);

  const formData = await request.formData();
  const rawData = Object.fromEntries(formData);

  // Parse booleans from form data strings
  const data = {
    isCollapsed:
      rawData.isCollapsed !== undefined ? rawData.isCollapsed === "true" : undefined,
    manageSectionCollapsed:
      rawData.manageSectionCollapsed !== undefined
        ? rawData.manageSectionCollapsed === "true"
        : undefined,
  };

  const result = RequestSchema.safeParse(data);
  if (!result.success) {
    return json({ success: false, error: "Invalid request data" }, { status: 400 });
  }

  await updateSideMenuPreferences({
    user,
    isCollapsed: result.data.isCollapsed,
    manageSectionCollapsed: result.data.manageSectionCollapsed,
  });

  return json({ success: true });
}
