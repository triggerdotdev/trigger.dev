import { type ActionFunctionArgs, json } from "@remix-run/server-runtime";
import { z } from "zod";
import {
  setTimezonePreference,
  uiPreferencesStorage,
} from "~/services/preferences/uiPreferences.server";
import { isValidTimeZone } from "~/utils/timezones.server";

const schema = z.object({
  timezone: z.string().min(1).max(100),
});

export async function action({ request }: ActionFunctionArgs) {
  let data: unknown;
  try {
    data = await request.json();
  } catch {
    return json({ success: false, error: "Invalid JSON" }, { status: 400 });
  }

  const result = schema.safeParse(data);

  if (!result.success) {
    return json({ success: false, error: "Invalid timezone" }, { status: 400 });
  }

  if (!isValidTimeZone(result.data.timezone)) {
    return json({ success: false, error: "Invalid timezone" }, { status: 400 });
  }

  const session = await setTimezonePreference(result.data.timezone, request);

  return json(
    { success: true },
    {
      headers: {
        "Set-Cookie": await uiPreferencesStorage.commitSession(session),
      },
    }
  );
}
