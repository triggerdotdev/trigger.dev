import { json ,type  LoaderFunctionArgs  } from "@remix-run/server-runtime";
import { type WhoAmIResponse } from '@trigger.dev/core/v3/schemas';
import { prisma } from "~/db.server";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import { authenticateApiRequestWithPersonalAccessToken } from "~/services/personalAccessToken.server";

export async function loader({ request }: LoaderFunctionArgs) {
  logger.info("whoami v2", { url: request.url });
  try {
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
      dashboardUrl: env.APP_ORIGIN,
    };
    return json(result);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Something went wrong";
    logger.error("Error in whoami v2", { error: errorMessage });
    return json({ error: errorMessage }, { status: 400 });
  }
}
