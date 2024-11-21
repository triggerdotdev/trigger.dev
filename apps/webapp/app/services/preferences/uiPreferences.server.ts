import { createCookieSessionStorage } from "@remix-run/node";
import { env } from "~/env.server";

export const uiPreferencesStorage = createCookieSessionStorage({
  cookie: {
    name: "__ui_prefs",
    sameSite: "lax",
    path: "/",
    httpOnly: true,
    secrets: [env.SESSION_SECRET],
    secure: env.NODE_ENV === "production",
    maxAge: 60 * 60 * 24 * 365, // 1 year
  },
});

export function getUiPreferencesSession(request: Request) {
  return uiPreferencesStorage.getSession(request.headers.get("Cookie"));
}

export async function getUsefulLinksPreference(request: Request): Promise<boolean | undefined> {
  const session = await getUiPreferencesSession(request);
  return session.get("showUsefulLinks");
}

export async function setUsefulLinksPreference(show: boolean, request: Request) {
  const session = await getUiPreferencesSession(request);
  session.set("showUsefulLinks", show);
  return session;
}
