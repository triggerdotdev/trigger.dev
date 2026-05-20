import type { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { authenticateApiRequestWithPersonalAccessToken } from "~/services/personalAccessToken.server";
import { getNextCliNotification } from "~/services/platformNotifications.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const authenticationResult = await authenticateApiRequestWithPersonalAccessToken(request);

  if (!authenticationResult) {
    return json({ error: "Invalid or Missing Access Token" }, { status: 401 });
  }

  const url = new URL(request.url);
  const projectRef = url.searchParams.get("projectRef") ?? undefined;

  const notification = await getNextCliNotification({
    userId: authenticationResult.userId,
    projectRef,
  });

  return json({ notification });
}
