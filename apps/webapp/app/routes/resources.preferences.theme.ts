import { json, type ActionFunctionArgs } from "@remix-run/node";
import { updateThemePreference } from "~/services/dashboardPreferences.server";
import { requireUser } from "~/services/session.server";
import { ThemePreference } from "~/utils/themePreference";
import { cachedFlag } from "~/v3/featureFlags.server";

export async function action({ request }: ActionFunctionArgs) {
  const user = await requireUser(request);

  // Same gate as the account page: while the flag is off, everyone stays on the
  // default theme, so a preference must not be writable from the menu either.
  const showThemeSwitcher =
    user.admin || (await cachedFlag({ key: "hasThemeSwitcher", defaultValue: false }));
  if (!showThemeSwitcher) {
    return json({ success: false, error: "Not available" }, { status: 404 });
  }

  const formData = await request.formData();
  // Parsed strictly rather than normalized: an unknown value should fail loudly
  // instead of silently resetting the user's theme to the default.
  const theme = ThemePreference.safeParse(formData.get("theme"));
  if (!theme.success) {
    return json({ success: false, error: "Invalid theme" }, { status: 400 });
  }

  await updateThemePreference({ user, theme: theme.data });

  return json({ success: true });
}
