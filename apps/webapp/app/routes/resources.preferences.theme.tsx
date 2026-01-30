import { json, type ActionFunctionArgs } from "@remix-run/node";
import { z } from "zod";
import { ThemePreference, updateThemePreference } from "~/services/dashboardPreferences.server";
import { requireUser } from "~/services/session.server";

const RequestSchema = z.object({
  theme: ThemePreference,
});

export async function action({ request }: ActionFunctionArgs) {
  const user = await requireUser(request);

  const formData = await request.formData();
  const rawData = Object.fromEntries(formData);

  const result = RequestSchema.safeParse(rawData);
  if (!result.success) {
    return json({ success: false, error: "Invalid request data" }, { status: 400 });
  }

  await updateThemePreference({
    user,
    theme: result.data.theme,
  });

  return json({ success: true });
}
