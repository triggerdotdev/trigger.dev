import { redirect, type ActionFunctionArgs } from "@remix-run/server-runtime";
import { z } from "zod";
import { prisma } from "~/db.server";
import {
  commitSession as commitMessageSession,
  getSession as getMessageSession,
  setErrorMessage,
  setSuccessMessage,
} from "~/models/message.server";
import { requireUser } from "~/services/session.server";
import {
  getAllowedSessionOptions,
  getEffectiveSessionDuration,
  isAllowedSessionDuration,
  shortenAuthenticatedSession,
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
  const user = await requireUser(request);
  if (user.isImpersonating) {
    return redirectWithError(request, "You can't change the session duration while impersonating.");
  }
  const userId = user.id;

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

  // A shorter duration applies to the current sessions now; a longer one from the next login.
  const authSession = await getUserSession(request);
  const authCookie = await shortenAuthenticatedSession(authSession, userId);

  const messageSession = await getMessageSession(request.headers.get("cookie"));
  setSuccessMessage(messageSession, "Session duration updated.");
  const messageCookie = await commitMessageSession(messageSession);

  const headers = new Headers();
  headers.append("Set-Cookie", authCookie);
  headers.append("Set-Cookie", messageCookie);

  return redirect(REDIRECT_PATH, { headers });
}
