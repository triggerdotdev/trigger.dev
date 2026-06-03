import type { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { prisma } from "~/db.server";
import { authenticateApiRequest } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    // Next authenticate the request
    const authenticationResult = await authenticateApiRequest(request);

    if (!authenticationResult) {
      return json({ error: "Invalid or Missing API key" }, { status: 401 });
    }

    const environmentWithUser = await prisma.runtimeEnvironment.findUnique({
      select: {
        orgMember: {
          select: {
            userId: true,
          },
        },
      },
      where: {
        id: authenticationResult.environment.id,
      },
    });

    const result = {
      ...authenticationResult.environment,
      userId: environmentWithUser?.orgMember?.userId,
    };

    return json(result);
  } catch (error) {
    if (error instanceof Response) throw error;
    logger.error("Failed to load whoami", { error });
    return json({ error: "Internal Server Error" }, { status: 500 });
  }
}
