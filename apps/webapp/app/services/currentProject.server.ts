import { type Session, createCookieSessionStorage } from "@remix-run/node";
import { env } from "~/env.server";

export const currentProjectSessionStorage = createCookieSessionStorage({
  cookie: {
    name: "__project", // use any name you want here
    sameSite: "lax", // this helps with CSRF
    path: "/", // remember to add this so the cookie will work in all routes
    httpOnly: true, // for security reasons, make this cookie http only
    secrets: [env.SESSION_SECRET],
    secure: env.NODE_ENV === "production", // enable this in prod only
    maxAge: 60 * 60 * 365, // 1 year
  },
});

function getCurrentProjectSession(request: Request) {
  return currentProjectSessionStorage.getSession(request.headers.get("Cookie"));
}

export function commitCurrentProjectSession(session: Session) {
  return currentProjectSessionStorage.commitSession(session);
}

export async function getCurrentProjectId(request: Request): Promise<string | undefined> {
  const session = await getCurrentProjectSession(request);
  return session.get("currentProjectId");
}

export async function setCurrentProjectId(id: string, request: Request) {
  const session = await getCurrentProjectSession(request);
  session.set("currentProjectId", id);
  return session;
}

export async function clearCurrentProjectId(request: Request) {
  const session = await getCurrentProjectSession(request);
  session.unset("currentProjectId");
  return session;
}
