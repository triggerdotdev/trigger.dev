import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirectWithErrorMessage, redirectWithSuccessMessage } from "~/models/message.server";
import { confirmEmailChange } from "~/services/emailChange.server";
import { getUserId } from "~/services/session.server";
import { accountPath } from "~/utils/pathBuilder";

/**
 * Target of the link emailed to a pending address. Works logged out: sending
 * the visitor through /login first would invite them to "log in" with the new
 * address, which would register it as a separate account.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  const token = new URL(request.url).searchParams.get("token") ?? "";
  const result = await confirmEmailChange(token);

  const sessionUserId = await getUserId(request);
  const destination = sessionUserId ? accountPath() : "/login";

  if (!result.ok) {
    return redirectWithErrorMessage(destination, request, result.error);
  }

  return redirectWithSuccessMessage(
    destination,
    request,
    sessionUserId === result.userId
      ? "Your email address has been updated."
      : `Your email address is now ${result.email}. Use it to log in.`
  );
}
