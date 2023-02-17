import { createCookieSessionStorage, Session } from "@remix-run/node";
import { env } from "~/env.server";

export const currentOrgSessionStorage = createCookieSessionStorage({
  cookie: {
    name: "__organization", // use any name you want here
    sameSite: "lax", // this helps with CSRF
    path: "/", // remember to add this so the cookie will work in all routes
    httpOnly: true, // for security reasons, make this cookie http only
    secrets: [env.SESSION_SECRET],
    secure: env.NODE_ENV === "production", // enable this in prod only
    maxAge: 60 * 60 * 24, // 1 day
  },
});

export function getCurrentOrgSession(request: Request) {
  return currentOrgSessionStorage.getSession(request.headers.get("Cookie"));
}

export function commitCurrentOrgSession(session: Session) {
  return currentOrgSessionStorage.commitSession(session);
}

export async function getCurrentOrg(
  request: Request
): Promise<string | undefined> {
  const session = await getCurrentOrgSession(request);

  return session.get("currentOrg");
}

export async function setCurrentOrg(slug: string, request: Request) {
  const session = await getCurrentOrgSession(request);

  session.set("currentOrg", slug);

  return session;
}

export async function clearCurrentOrg(request: Request) {
  const session = await getCurrentOrgSession(request);

  session.unset("currentOrg");

  return session;
}
