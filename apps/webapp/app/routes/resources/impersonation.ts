import { ActionArgs } from "@remix-run/server-runtime";
import { redirect } from "remix-typedjson";
import {
  clearImpersonationId,
  commitImpersonationSession,
} from "~/services/impersonation.server";

export async function action({ request }: ActionArgs) {
  const session = await clearImpersonationId(request);

  return redirect("/admin", {
    headers: {
      "Set-Cookie": await commitImpersonationSession(session),
    },
  });
}
