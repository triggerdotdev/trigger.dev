import { createCookieSessionStorage } from "@remix-run/node";
import { z } from "zod";
import { env } from "~/env.server";

const ONE_DAY = 60 * 60 * 24;

export const { commitSession, getSession } = createCookieSessionStorage({
  cookie: {
    name: "__redirectTo",
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secrets: [env.SESSION_SECRET],
    secure: env.NODE_ENV === "production",
    maxAge: ONE_DAY,
  },
});

export function getRedirectSession(request: Request) {
  return getSession(request.headers.get("Cookie"));
}

export async function setRedirectTo(request: Request, redirectTo: string) {
  const session = await getRedirectSession(request);

  if (session) {
    session.set("redirectTo", redirectTo);
  }

  return session;
}

export async function clearRedirectTo(request: Request) {
  const session = await getRedirectSession(request);

  if (session) {
    session.unset("redirectTo");
  }

  return session;
}

export async function getRedirectTo(
  request: Request
): Promise<string | undefined> {
  const session = await getRedirectSession(request);

  if (session) {
    return z.string().optional().parse(session.get("redirectTo"));
  }
}
