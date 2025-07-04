import type { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { authenticator } from "~/services/auth.server";
import { getRedirectTo } from "~/services/redirectTo.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const redirectTo = await getRedirectTo(request);

  await authenticator.authenticate("email-link", request, {
    successRedirect: redirectTo ?? "/",
    failureRedirect: "/login/magic",
  });
}
