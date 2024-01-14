import type { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { WhoAmIResponse } from "@trigger.dev/core";
import { prisma } from "~/db.server";
import { logger } from "~/services/logger.server";
import { authenticateApiRequestWithPersonalAccessToken } from "~/services/personalAccessToken.server";

export async function loader({ request }: LoaderFunctionArgs) {
  logger.info("whoami v2", { url: request.url });

  const authenticationResult = await authenticateApiRequestWithPersonalAccessToken(request);
  if (!authenticationResult) {
    return json({ error: "Invalid or Missing Access Token" }, { status: 401 });
  }

  const user = await prisma.user.findUnique({
    select: {
      email: true,
    },
    where: {
      id: authenticationResult.userId,
    },
  });

  if (!user) {
    return json({ error: "User not found" }, { status: 404 });
  }

  const result: WhoAmIResponse = {
    userId: authenticationResult.userId,
    email: user.email,
  };
  return json(result);
}
