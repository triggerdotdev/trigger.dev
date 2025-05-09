import { createCookieSessionStorage, type Session } from "@remix-run/node";
import { env } from "~/env.server";

export const impersonationSessionStorage = createCookieSessionStorage({
  cookie: {
    name: "__impersonate", // use any name you want here
    sameSite: "lax", // this helps with CSRF
    path: "/", // remember to add this so the cookie will work in all routes
    httpOnly: true, // for security reasons, make this cookie http only
    secrets: [env.SESSION_SECRET],
    secure: env.NODE_ENV === "production", // enable this in prod only
    maxAge: 60 * 60 * 24, // 1 day
  },
});

export function getImpersonationSession(request: Request) {
  return impersonationSessionStorage.getSession(request.headers.get("Cookie"));
}

export function commitImpersonationSession(session: Session) {
  return impersonationSessionStorage.commitSession(session);
}

export async function getImpersonationId(request: Request) {
  const session = await getImpersonationSession(request);

  return session.get("impersonatedUserId") as string | undefined;
}

export async function setImpersonationId(userId: string, request: Request) {
  const session = await getImpersonationSession(request);

  session.set("impersonatedUserId", userId);

  return session;
}

export async function clearImpersonationId(request: Request) {
  const session = await getImpersonationSession(request);

  session.unset("impersonatedUserId");

  return session;
}
