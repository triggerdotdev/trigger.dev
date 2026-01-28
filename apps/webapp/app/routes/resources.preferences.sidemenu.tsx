import { json, type ActionFunctionArgs } from "@remix-run/node";
import { z } from "zod";
import { updateSideMenuPreferences } from "~/services/dashboardPreferences.server";
import { requireUser } from "~/services/session.server";

// Transforms form data string "true"/"false" to boolean, or undefined if not present
const booleanFromFormData = z
  .enum(["true", "false"])
  .transform((val) => val === "true")
  .optional();

const RequestSchema = z.object({
  isCollapsed: booleanFromFormData,
  manageSectionCollapsed: booleanFromFormData,
});

export async function action({ request }: ActionFunctionArgs) {
  const user = await requireUser(request);

  const formData = await request.formData();
  const rawData = Object.fromEntries(formData);

  const result = RequestSchema.safeParse(rawData);
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
