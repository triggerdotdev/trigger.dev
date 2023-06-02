import type { LoaderArgs } from "@remix-run/server-runtime";
import { getInviteFromToken } from "~/models/member.server";
import {
  redirectWithErrorMessage,
  redirectWithSuccessMessage,
} from "~/models/message.server";
import { getUser } from "~/services/session.server";

export async function loader({ request }: LoaderArgs) {
  const user = await getUser(request);

  const url = new URL(request.url);
  const token = url.searchParams.get("token");

  if (!token) {
    return redirectWithErrorMessage(
      "/",
      request,
      "Invalid invite URL. Please ask the person who invited you to send another invite."
    );
  }

  const invite = await getInviteFromToken({ token });
  if (!invite) {
    return redirectWithErrorMessage(
      "/",
      request,
      "Invite not found. Please ask the person who invited you to send another invite."
    );
  }

  if (!user) {
    return redirectWithSuccessMessage(
      "/",
      request,
      "Please login to accept the invite."
    );
  }

  if (invite.email !== user.email) {
    return redirectWithErrorMessage(
      "/",
      request,
      `This invite is for ${invite.email}, but you are logged in as ${user.email}.`
    );
  }

  return redirectWithSuccessMessage("/", request, "Invite retrieved");
}
