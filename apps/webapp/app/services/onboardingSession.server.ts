import { createCookieSessionStorage, Session } from "@remix-run/node";
import { env } from "~/env.server";

export const onboardingSessionStorage = createCookieSessionStorage({
  cookie: {
    name: "__onboarding", // use any name you want here
    sameSite: "lax", // this helps with CSRF
    path: "/", // remember to add this so the cookie will work in all routes
    httpOnly: true, // for security reasons, make this cookie http only
    secrets: [env.SESSION_SECRET],
    secure: env.NODE_ENV === "production", // enable this in prod only
    maxAge: 60 * 60 * 24, // 1 day
  },
});

export function getOnboardingSession(request: Request) {
  return onboardingSessionStorage.getSession(request.headers.get("Cookie"));
}

export function commitOnboardingSession(session: Session) {
  return onboardingSessionStorage.commitSession(session);
}

export async function getWorkflowDate(request: Request) {
  const session = await getOnboardingSession(request);

  const rawWorkflowDate = session.get("workflowDate");

  if (rawWorkflowDate) {
    return new Date(rawWorkflowDate);
  }
}

export async function setWorkflowDate(date: Date, request: Request) {
  const session = await getOnboardingSession(request);

  session.set("workflowDate", date.toISOString());

  return session;
}

export async function clearWorkflowDate(request: Request) {
  const session = await getOnboardingSession(request);

  session.unset("workflowDate");

  return session;
}
