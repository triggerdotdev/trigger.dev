import { redirect, type ActionFunctionArgs } from "@remix-run/server-runtime";
import { z } from "zod";
import { prisma } from "~/db.server";
import {
  commitSession as commitMessageSession,
  getSession as getMessageSession,
  setErrorMessage,
  setSuccessMessage,
} from "~/models/message.server";
import { requireUserId } from "~/services/session.server";
import {
  commitAuthenticatedSession,
  getAllowedSessionOptions,
  getEffectiveSessionDuration,
  isAllowedSessionDuration,
} from "~/services/sessionDuration.server";
import { getUserSession } from "~/services/sessionStorage.server";

const FormSchema = z.object({
  sessionDuration: z.coerce.number().int().positive(),
});

const REDIRECT_PATH = "/account/security";

async function redirectWithError(request: Request, message: string) {
  const messageSession = await getMessageSession(request.headers.get("cookie"));
  setErrorMessage(messageSession, message);
  return redirect(REDIRECT_PATH, {
    headers: { "Set-Cookie": await commitMessageSession(messageSession) },
  });
}

export async function action({ request }: ActionFunctionArgs) {
  const userId = await requireUserId(request);

  const formData = await request.formData();
  const parsed = FormSchema.safeParse(Object.fromEntries(formData));

  if (!parsed.success) {
    return redirectWithError(request, "Invalid session duration value.");
  }

  const { sessionDuration } = parsed.data;

  if (!isAllowedSessionDuration(sessionDuration)) {
    return redirectWithError(request, "Invalid session duration value.");
  }

  const { orgCapSeconds, durationSeconds } = await getEffectiveSessionDuration(userId);
  const allowed = getAllowedSessionOptions(orgCapSeconds, durationSeconds);
  if (!allowed.some((o) => o.value === sessionDuration)) {
    return redirectWithError(
      request,
      "Your organization's policy does not allow that session duration."
    );
  }

  await prisma.user.update({
    where: { id: userId },
    data: { sessionDuration },
  });

  // Re-issue the cookie with the new maxAge and reset issuedAt so the user
  // gets a fresh window matching their new selection right away.
  const authSession = await getUserSession(request);
  const authCookie = await commitAuthenticatedSession(authSession);

  const messageSession = await getMessageSession(request.headers.get("cookie"));
  setSuccessMessage(messageSession, "Session duration updated.");
  const messageCookie = await commitMessageSession(messageSession);

  const headers = new Headers();
  headers.append("Set-Cookie", authCookie);
  headers.append("Set-Cookie", messageCookie);

  return redirect(REDIRECT_PATH, { headers });
}
