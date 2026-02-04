import { json, type ActionFunctionArgs } from "@remix-run/node";
import { z } from "zod";
import {
  SideMenuSectionIdSchema,
  type SideMenuSectionId,
} from "~/components/navigation/sideMenuTypes";
import { updateSideMenuPreferences } from "~/services/dashboardPreferences.server";
import { requireUser } from "~/services/session.server";

// Transforms form data string "true"/"false" to boolean, or undefined if not present
const booleanFromFormData = z
  .enum(["true", "false"])
  .transform((val) => val === "true")
  .optional();

const RequestSchema = z.object({
  isCollapsed: booleanFromFormData,
  sectionId: SideMenuSectionIdSchema.optional(),
  sectionCollapsed: booleanFromFormData,
});

export async function action({ request }: ActionFunctionArgs) {
  const user = await requireUser(request);

  const formData = await request.formData();
  const rawData = Object.fromEntries(formData);

  const result = RequestSchema.safeParse(rawData);
  if (!result.success) {
    return json({ success: false, error: "Invalid request data" }, { status: 400 });
  }

  // Build sectionCollapsed parameter if both sectionId and sectionCollapsed are provided
  const sectionCollapsed =
    result.data.sectionId !== undefined && result.data.sectionCollapsed !== undefined
      ? { sectionId: result.data.sectionId as SideMenuSectionId, collapsed: result.data.sectionCollapsed }
      : undefined;

  await updateSideMenuPreferences({
    user,
    isCollapsed: result.data.isCollapsed,
    sectionCollapsed,
  });

  return json({ success: true });
}
