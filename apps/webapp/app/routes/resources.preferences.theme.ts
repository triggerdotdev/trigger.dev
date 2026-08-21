import { json, type ActionFunctionArgs } from "@remix-run/node";
import { updateThemePreference } from "~/services/dashboardPreferences.server";
import { requireUser } from "~/services/session.server";
import { ThemePreference } from "~/utils/themePreference";
import { cachedFlag } from "~/v3/featureFlags.server";

export async function action({ request }: ActionFunctionArgs) {
  const user = await requireUser(request);

  // Same gate as the account page: not writable while the flag is off.
  const showThemeSwitcher =
    user.admin || (await cachedFlag({ key: "hasThemeSwitcher", defaultValue: false }));
  if (!showThemeSwitcher) {
    return json({ success: false, error: "Not available" }, { status: 404 });
  }

  const formData = await request.formData();
  // Strict, not normalized: an unknown value must fail rather than reset.
  const theme = ThemePreference.safeParse(formData.get("theme"));
  if (!theme.success) {
    return json({ success: false, error: "Invalid theme" }, { status: 400 });
  }

  await updateThemePreference({ user, theme: theme.data });

  return json({ success: true });
}
