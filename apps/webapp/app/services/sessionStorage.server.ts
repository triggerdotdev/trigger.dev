import { createCookieSessionStorage } from "@remix-run/node";
import { env } from "~/env.server";

// Hard ceiling for the cookie lifetime. The actual per-session value is set
// per-commit via commitSession(session, { maxAge }) in the auth/login flows
// and on every authenticated response, derived from the user's effective
// session duration (User.sessionDuration capped by Organization.maxSessionDuration).
export const SESSION_STORAGE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

export const sessionStorage = createCookieSessionStorage({
  cookie: {
    name: "__session",
    sameSite: "lax",
    path: "/",
    httpOnly: true,
    secrets: [env.SESSION_SECRET],
    secure: env.NODE_ENV === "production",
    maxAge: SESSION_STORAGE_MAX_AGE_SECONDS,
  },
});

export function getUserSession(request: Request) {
  return sessionStorage.getSession(request.headers.get("Cookie"));
}

export const { getSession, commitSession, destroySession } = sessionStorage;
