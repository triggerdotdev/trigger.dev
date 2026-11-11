import type { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { prisma } from "~/db.server";
import { authenticateApiRequest } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { isApiKeyInGraceWindow } from "~/services/apiKeyGraceWindow.server";

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    // Next authenticate the request
    const authenticationResult = await authenticateApiRequest(request);

    if (!authenticationResult) {
      return json({ error: "Invalid or Missing API key" }, { status: 401 });
    }

    // A rotated key still authenticates during its grace window; it must not
    // be usable to look up the environment it was rotated out of.
    if (await isApiKeyInGraceWindow(authenticationResult.apiKey)) {
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

    // Identity only: never return API key material from this endpoint.
    const environment = authenticationResult.environment;
    const result = {
      id: environment.id,
      slug: environment.slug,
      type: environment.type,
      shortcode: environment.shortcode,
      branchName: environment.branchName,
      paused: environment.paused,
      archivedAt: environment.archivedAt,
      createdAt: environment.createdAt,
      updatedAt: environment.updatedAt,
      project: {
        id: environment.project.id,
        slug: environment.project.slug,
        name: environment.project.name,
        externalRef: environment.project.externalRef,
      },
      organization: {
        id: environment.organization.id,
        slug: environment.organization.slug,
        title: environment.organization.title,
      },
      userId: environmentWithUser?.orgMember?.userId,
    };

    return json(result);
  } catch (error) {
    if (error instanceof Response) throw error;
    logger.error("Failed to load whoami", { error });
    return json({ error: "Internal Server Error" }, { status: 500 });
  }
}
