import { createCookieSessionStorage } from "@remix-run/node";
import { env } from "~/env.server";

// Canonical "1 year in seconds", using Gregorian calendar conversion
// (365.2425 * 86400) so it matches the labeled "1 year" dropdown option in
// SESSION_DURATION_OPTIONS exactly. This is the cookie's hard upper-bound
// lifetime; the actual per-session value is enforced server-side via
// `sessionIssuedAt` against the user's effective duration.
export const DEFAULT_SESSION_DURATION_SECONDS = 31_556_952;

export const sessionStorage = createCookieSessionStorage({
  cookie: {
    name: "__session",
    sameSite: "lax",
    path: "/",
    httpOnly: true,
    secrets: [env.SESSION_SECRET],
    secure: env.NODE_ENV === "production",
    maxAge: DEFAULT_SESSION_DURATION_SECONDS,
  },
});

export function getUserSession(request: Request) {
  return sessionStorage.getSession(request.headers.get("Cookie"));
}

export const { getSession, commitSession, destroySession } = sessionStorage;
