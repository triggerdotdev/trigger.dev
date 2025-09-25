import type { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { getInviteFromToken } from "~/models/member.server";
import { redirectWithErrorMessage, redirectWithSuccessMessage } from "~/models/message.server";
import { getUser } from "~/services/session.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const user = await getUser(request);

  const url = new URL(request.url);
  const token = url.searchParams.get("token");

  if (!token) {
    return redirectWithErrorMessage(
      "/",
      request,
      "Invalid invite URL. Please ask the person who invited you to send another invite.",
      { ephemeral: false }
    );
  }

  if (!user) {
    return redirectWithSuccessMessage("/", request, "Please log in to accept the invite.", {
      ephemeral: false,
    });
  }

  const invite = await getInviteFromToken({ token });
  if (!invite) {
    return redirectWithErrorMessage(
      "/",
      request,
      "Invite not found. Please ask the person who invited you to send another invite.",
      { ephemeral: false }
    );
  }

  if (invite.email !== user.email) {
    return redirectWithErrorMessage(
      "/",
      request,
      `This invite is for ${invite.email}, but you are logged in as ${user.email}.`,
      { ephemeral: false }
    );
  }

  return redirectWithSuccessMessage("/", request, "Invite retrieved");
}
