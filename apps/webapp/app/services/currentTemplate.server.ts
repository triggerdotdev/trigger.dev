import { createCookieSessionStorage, Session } from "@remix-run/node";
import { env } from "~/env.server";

export const currentTemplateSessionStorage = createCookieSessionStorage({
  cookie: {
    name: "__template", // use any name you want here
    sameSite: "lax", // this helps with CSRF
    path: "/", // remember to add this so the cookie will work in all routes
    httpOnly: true, // for security reasons, make this cookie http only
    secrets: [env.SESSION_SECRET],
    secure: env.NODE_ENV === "production", // enable this in prod only
    maxAge: 60 * 60 * 24, // 1 day
  },
});

export function getCurrentTemplateSession(request: Request) {
  return currentTemplateSessionStorage.getSession(
    request.headers.get("Cookie")
  );
}

export function commitCurrentTemplateSession(session: Session) {
  return currentTemplateSessionStorage.commitSession(session);
}

export async function getCurrentTemplate(
  request: Request
): Promise<string | undefined> {
  const session = await getCurrentTemplateSession(request);

  return session.get("currentTemplate");
}

export async function setCurrentTemplate(id: string, request: Request) {
  const session = await getCurrentTemplateSession(request);

  session.set("currentTemplate", id);

  return session;
}

export async function clearCurrentTemplate(request: Request) {
  const session = await getCurrentTemplateSession(request);

  session.unset("currentTemplate");

  return session;
}
